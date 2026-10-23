#!/usr/bin/env node
// vault.mjs - Cross-OS, NON-INTERACTIVE access to the Bitwarden vault for Hypervibe.
//
// This is the workhorse called by every skill that needs to READ a secret.
// It never prompts (no interactivity): it reads the session token written by the
// interactive `unlock` step, checks its age (6 hours, TTL_SECONDS of session.mjs), sets
// BW_SESSION, and shells out to `bw`. A session found over is locked for real on the way
// (`bw lock`, then its file removed): session.mjs.
//
// The interactive operations (login / unlock / add) live in launch.mjs +
// interactive.mjs - because they need a real terminal window for masked input
// (Claude's tool I/O can't take a typed master password).
//
// SESSION FILE
// ------------
// ~/.hypervibe/bw-session  (format: "<unix_timestamp>\n<bw_session_token>")
// Lives outside the plugin dir so it survives plugin updates. Written by unlock.
//
// SUBCOMMANDS
// -----------
//   node vault.mjs get <ITEM> [FIELD]   -> prints field value (default field: "value")
//   node vault.mjs delete <ITEM>        -> permanently deletes an item
//   node vault.mjs status               -> prints "unlocked" | "locked" | "expired"
//   node vault.mjs account              -> {"signedIn": true|false, "account": ..., "server": ...}:
//                                          is an account connected on this machine? (unlocks nothing)
//
// EXIT CODES (mirror the perso bw-get convention, relied on by the auto-unlock pattern)
//   0 ok | 2 vault locked (no session) | 3 session expired (>6h, locked on the way) | 4 item not found
//   5 field not found | 1 other error
//
// MODULE USAGE
//   import { getSecret } from "./vault.mjs";
//   const v = getSecret("CLOUDFLARE", "api_token"); // string  (throws {code} on failure)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { useBwHome } from "./bw-home.mjs";
import { TTL_HOURS, isExpired, lockOutcome, lockSession, readSessionFile, sessionFile } from "./session.mjs";

const SESSION_FILE = sessionFile();

// `bw` command - resolved by PROBING ABSOLUTE LOCATIONS FIRST, then PATH. This must be
// PATH-independent: the launched terminal window (and Claude's tool shell) often do NOT have
// ~/.hypervibe/bin on PATH, and on Windows a missing `bw` returns a non-zero STATUS (not ENOENT,
// because shell:true), so an ENOENT-based fallback never fires. The old approach therefore got
// EMPTY `bw status` output → parsed as {} → "Not logged in" loop, even when the user WAS logged
// in (bug confirmed 2026-05-31). We instead pick the first absolute bw that exists, including the
// platform-correct extension (bw.exe on Windows), and only fall back to bare "bw" on PATH.
const IS_WIN_VAULT = platform() === "win32";
const BW_EXE = IS_WIN_VAULT ? "bw.exe" : "bw";
let BW_CMD = null;
function resolveBwCmd() {
  if (BW_CMD) return BW_CMD;
  const candidates = [
    join(homedir(), ".hypervibe", "bin", BW_EXE),
    join(homedir(), "bin", BW_EXE),
    "/opt/homebrew/bin/bw",
    "/usr/local/bin/bw",
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) { BW_CMD = cand; return BW_CMD; }
  }
  BW_CMD = "bw"; // last resort: rely on PATH
  return BW_CMD;
}

/** Run the `bw` CLI with args. Returns { status, stdout, stderr }. Optional stdin `input`. */
function runBw(args, sessionToken, input) {
  // BW_NOINTERACTION guarantees bw never blocks on an interactive prompt (e.g. a stale token
  // would otherwise make some commands ask for the master password and hang a non-TTY caller).
  // On Windows every bw of this plugin uses ONE sign-in folder, outside the AppData that Claude
  // Desktop's package virtualises: otherwise a program started outside Claude sees no account.
  useBwHome();
  const env = { ...process.env, BW_NOINTERACTION: "true" };
  if (sessionToken) env.BW_SESSION = sessionToken;
  const cmd = resolveBwCmd();
  // shell:true only needed when invoking the bare "bw" name on Windows; an absolute path
  // runs fine without a shell (and avoids the shell-args deprecation warning).
  const useShell = IS_WIN_VAULT && cmd === "bw";
  // timeout is a final safety net: no vault status/read call should ever hang the caller.
  const opts = { encoding: "utf8", env, input, shell: useShell, windowsHide: true, timeout: 20000 };
  const res = spawnSync(cmd, args, opts);
  return {
    status: res.status,
    stdout: (res.stdout || "").toString(),
    stderr: (res.stderr || "").toString(),
  };
}

/** True if a failed bw result indicates the session is not accepted (locked / re-auth needed). */
function isAuthFailure(res) {
  const s = ((res.stderr || "") + (res.stdout || "")).toLowerCase();
  return /master password|not logged in|vault is locked|mac failed|invalid|unauthorized|session key/.test(s);
}

/** Read + validate the session file. Returns { token } or throws { code }. A session found over
 *  is locked for real before the code 3 (session.mjs): a lock that fails is said in the message,
 *  never thrown. */
function readSession() {
  if (!existsSync(SESSION_FILE)) {
    const e = new Error("Vault locked (no session). Run unlock.");
    e.code = 2;
    throw e;
  }
  const session = readSessionFile(SESSION_FILE);
  if (!session) {
    const e = new Error("Session file malformed. Run unlock.");
    e.code = 2;
    throw e;
  }
  if (isExpired(session.ts)) {
    const locked = lockSession({ at: session.ts, file: SESSION_FILE });
    const e = new Error(`Session expired (>${TTL_HOURS}h): ${lockOutcome(locked)}. Run unlock.`);
    e.code = 3;
    throw e;
  }
  return { token: session.token };
}

/**
 * Read a field from a vault item. Returns the value as a string.
 * Throws an Error with `.code` (2/3/4/5/1) on failure.
 */
export function getSecret(itemName, field = "value") {
  if (!/^[A-Za-z0-9_]+$/.test(itemName)) {
    const e = new Error(`Invalid item name: ${itemName}`);
    e.code = 1;
    throw e;
  }
  const { token } = readSession();
  // Resolve by EXACT name via list+filter. bw's fuzzy `get item <name>` returns a WRONG item
  // when the requested name is a substring/prefix of another item's name (e.g. asking for
  // OPENAI when only OPENAI_ADMIN exists) -> it silently hands back the wrong secret. We list
  // and match on name equality instead. (Same root cause as the old `deleteSecret` bug.)
  const res = runBw(["list", "items", "--search", itemName], token);
  if (res.status !== 0) {
    // Distinguish "session no longer accepted by bw" (re-unlock, code 3) from other failures.
    // A confirmatory `unlock --check` tells us whether the session is actually usable; the error
    // wording isn't stable across bw versions, so we don't rely on regex alone.
    const sessionUsable = runBw(["unlock", "--check", "--nointeraction"], token).status === 0;
    if (isAuthFailure(res) || !sessionUsable) {
      const e = new Error("Session no longer valid (run unlock).");
      e.code = 3;
      throw e;
    }
    const e = new Error(`Could not query vault for '${itemName}'`);
    e.code = 1;
    throw e;
  }
  let candidates;
  try {
    candidates = JSON.parse(res.stdout || "[]");
  } catch {
    const e = new Error("Could not parse bw items JSON");
    e.code = 1;
    throw e;
  }
  // list succeeded -> the session is usable, so a missing exact match means the item is
  // genuinely absent (code 4), not an auth problem. A false "absent" would make a skill offer
  // to ADD a key that already exists, hence we only conclude this when the query itself worked.
  const item = candidates.find((i) => i.name === itemName);
  if (!item) {
    const e = new Error(`Item '${itemName}' not found in vault`);
    e.code = 4;
    throw e;
  }
  const fields = Array.isArray(item.fields) ? item.fields : [];
  const match = fields.find((f) => f.name === field);
  if (!match) {
    const available = fields.map((f) => f.name).join(", ") || "(none)";
    const e = new Error(`Field '${field}' not found on '${itemName}'. Available: ${available}`);
    e.code = 5;
    throw e;
  }
  return match.value;
}

/** Permanently delete a vault item by name. Throws { code } on failure. */
export function deleteSecret(itemName) {
  if (!/^[A-Za-z0-9_]+$/.test(itemName)) {
    const e = new Error(`Invalid item name: ${itemName}`);
    e.code = 1;
    throw e;
  }
  const { token } = readSession();
  // Resolve by EXACT name. `bw get item <name>` does a fuzzy search and fails with
  // "More than one result found" when the name is a PREFIX of another item's name
  // (e.g. OPENAI vs OPENAI_ADMIN) -> it would wrongly report "not found" and never delete.
  // We list + filter on exact name instead. A `sync` first avoids acting on a stale cache.
  runBw(["sync", "--quiet"], token);
  const listed = runBw(["list", "items", "--search", itemName], token);
  if (listed.status !== 0) {
    if (isAuthFailure(listed)) { const e = new Error("Session no longer valid. Run unlock."); e.code = 3; throw e; }
    const e = new Error(`Failed to query vault for '${itemName}'`); e.code = 1; throw e;
  }
  const matches = JSON.parse(listed.stdout || "[]").filter((i) => i.name === itemName);
  if (matches.length === 0) {
    const e = new Error(`Item '${itemName}' not found`);
    e.code = 4;
    throw e;
  }
  if (matches.length > 1) {
    const e = new Error(`Ambiguous: ${matches.length} items named '${itemName}'`);
    e.code = 1;
    throw e;
  }
  const id = matches[0].id;
  const del = runBw(["delete", "item", id, "--permanent"], token);
  if (del.status !== 0) {
    const e = new Error(`Failed to delete '${itemName}'`);
    e.code = 1;
    throw e;
  }
}

/** Create or update an item NON-interactively (value supplied programmatically, not prompted).
 *  Used when the value comes from a file (e.g. a downloaded service-account JSON), not a keystroke.
 *  fields: [{ name, value, type: "secret"|"text" }]. Returns "created" | "updated". Throws { code }. */
export function putItem(name, fields, { service, folder = "Global", allowEmpty = false } = {}) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) { const e = new Error(`Invalid item name: ${name}`); e.code = 1; throw e; }
  // An empty value is refused, before the vault is even opened: the vault is the source of truth
  // of the global keys, the ones the next projects copy, and fields are merged, so an empty value
  // would replace the real one without a word. In a pipe it is what a step that failed upstream
  // sends (outside review, 3.3.4, the family of push-env-vars.mjs's refusal). allowEmpty: on
  // purpose.
  const empty = (fields ?? []).filter((f) => !String(f?.value ?? "").trim()).map((f) => f?.name);
  if (empty.length && !allowEmpty) {
    const e = new Error(`Refused: ${empty.join(", ")} of ${name} would be set to an empty value. Nothing was written to the vault.`);
    e.code = 1;
    throw e;
  }
  const { token } = readSession();
  runBw(["sync", "--quiet"], token);
  const folders = JSON.parse(runBw(["list", "folders"], token).stdout || "[]");
  let folderObj = folders.find((f) => f.name === folder);
  if (!folderObj) {
    const enc = runBw(["encode"], token, JSON.stringify({ name: folder })).stdout;
    folderObj = JSON.parse(runBw(["create", "folder"], token, enc).stdout || "null");
    if (!folderObj || !folderObj.id) { const e = new Error(`Failed to create vault folder: ${folder}`); e.code = 1; throw e; }
  }
  const folderId = folderObj.id;
  const search = JSON.parse(runBw(["list", "items", "--search", name], token).stdout || "[]");
  const existing = search.find((i) => i.name === name && i.folderId === folderId);

  // FUSION des champs, jamais remplacement. Un item du coffre peut porter des champs qu'on ne
  // réécrit pas ici : posés par une autre skill, ou à la main. Remplacer le tableau `fields`
  // ferait DISPARAÎTRE ces clés-là sans que personne ne le voie. Cas réel : un item portant
  // une clé publique et une clé secrète, dont une skill ne réécrit qu'une seule, l'autre
  // disparaissait sans un mot. Les champs fournis ici gagnent sur leurs homonymes.
  const nouveaux = fields.map((f) => ({ name: f.name, value: f.value, type: f.type === "text" ? 0 : 1, linkedId: null }));
  const parNom = new Map((Array.isArray(existing?.fields) ? existing.fields : []).map((f) => [f.name, f]));
  for (const f of nouveaux) parNom.set(f.name, f);

  const payload = {
    organizationId: null, folderId, type: 2, name,
    notes: service ? `Service: ${service}` : (existing?.notes ?? null),
    favorite: false,
    fields: [...parNom.values()],
    secureNote: { type: 0 }, login: null, card: null, identity: null, reprompt: 0,
  };
  const enc = runBw(["encode"], token, JSON.stringify(payload)).stdout;
  const res = existing
    ? runBw(["edit", "item", existing.id], token, enc)
    : runBw(["create", "item"], token, enc);
  if (res.status !== 0) { const e = new Error(`Failed to store '${name}'`); e.code = 1; throw e; }
  return existing ? "updated" : "created";
}

/** Returns "unlocked" | "locked" | "expired". Probes bw with the stored token so it reflects
 *  whether the vault is ACTUALLY usable, not just the file timestamp (a token can be revoked /
 *  rejected before its 6 hours are over). We use `unlock --check`, which validates the token against the
 *  unlocked session and returns non-zero ("Vault is locked.") when it is NOT genuinely usable.
 *  Hardened with --nointeraction (+ BW_NOINTERACTION) so a stale token can NEVER make bw hang on
 *  an interactive master-password prompt - it fails fast as "expired" instead.
 *  NB: `bw sync` is deliberately NOT used here - it returns 0 even on an invalid token (it only
 *  pulls public data), so it would falsely report "unlocked".
 *  IMPORTANT: this is the ONLY authoritative "is the vault open?" signal. Do NOT use the bare
 *  `bw status` (no token) to decide - it ALWAYS reports "locked" because the bw daemon holds no
 *  persistent unlocked session of its own; only this Hypervibe token unlocks it. */
export function sessionStatus() {
  let token;
  try {
    token = readSession().token;
  } catch (e) {
    return e.code === 3 ? "expired" : "locked";
  }
  const r = runBw(["unlock", "--check", "--nointeraction"], token);
  if (r.status === 0) return "unlocked";
  // Token present but rejected by bw → expired/revoked rather than "never logged in".
  return "expired";
}

/** Which account is signed in on this machine, without unlocking anything: {signedIn, account,
 *  server}. It tells "never set up here" from "set up, closed for the day". Skills ask this, never
 *  `bw status` themselves: on Windows a bare `bw` reads another folder than the plugin's (bw-home.mjs)
 *  and would call a connected machine "unauthenticated". */
export function accountStatus() {
  let s = null;
  try {
    s = JSON.parse(runBw(["status"]).stdout.trim() || "null");
  } catch {
    s = null;
  }
  if (!s || !s.status || s.status === "unauthenticated") return { signedIn: false, account: null, server: s?.serverUrl ?? null };
  return { signedIn: true, account: s.userEmail ?? null, server: s.serverUrl ?? null };
}

// ─── CLI entry point ──────────────────────────────────────────────────
// ─── Launched as a script, or imported ────────────────────────────────────────
// Node gives a module its real path and keeps in argv[1] the path as it was typed. Compared as
// they come, the two differ as soon as the plugin is reached through a symbolic link (macOS's
// temporary folder, a ~/.claude kept by a configuration repository): the script then did
// nothing and exited 0, "I could not" read as "nothing to report" (outside review, 3.3.9).
// Both are read to their real path. The same block in every script, held by
// scripts/tests/test-entry-point.mjs.
import { realpathSync as realPathOf } from "node:fs";
import { fileURLToPath as pathOfUrl } from "node:url";
function launchedDirectly() {
  try {
    if (!process.argv[1]) return false;
    const self = realPathOf(pathOfUrl(import.meta.url));
    const launched = realPathOf(process.argv[1]);
    return process.platform === "win32" ? self.toLowerCase() === launched.toLowerCase() : self === launched;
  } catch {
    return false;
  }
}

const isMain = launchedDirectly();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "get") {
      const [item, field] = rest;
      if (!item) {
        console.error("Usage: vault.mjs get <ITEM> [FIELD]");
        process.exit(1);
      }
      process.stdout.write(getSecret(item, field || "value"));
      process.exit(0);
    } else if (cmd === "delete") {
      const [item] = rest;
      if (!item) {
        console.error("Usage: vault.mjs delete <ITEM>");
        process.exit(1);
      }
      deleteSecret(item);
      process.stdout.write(`Deleted '${item}'.`);
      process.exit(0);
    } else if (cmd === "status") {
      process.stdout.write(sessionStatus());
      process.exit(0);
    } else if (cmd === "account") {
      process.stdout.write(JSON.stringify(accountStatus()));
      process.exit(0);
    } else {
      console.error("Usage: vault.mjs <get|delete|status|account> ...");
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write((e.message || String(e)) + "\n");
    process.exit(e.code || 1);
  }
}
