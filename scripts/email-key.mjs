#!/usr/bin/env node
// email-key.mjs - The project's own sending key (3.4.16), never the account's.
//
// Until 3.4.15 /add-email copied the key of the WHOLE email account (a Resend "Full Access" key,
// the Brevo account's key) into the .env and the hosting of every project: a .env shown on screen
// (a filmed training), a repository or a host that leaks, and the whole account was open (sending,
// domains, contacts), for every project at once (Jérôme Carfantan's mail of 21/10/2026). Now each
// project holds a key of its own, and the account's key stays in the vault, for the harness's
// gestures on the account itself (a sending domain and its records, the senders, the quotas, and
// at Resend the projects' keys):
//   - Resend: the key is made here by the API, with the account's key read in this process and
//     never shown, limited to sending, and to the project's sender domain once Resend has verified
//     it (resend-keys.mjs);
//   - Brevo: its API makes no key for an ordinary account (checked on 23/10/2026). The person makes
//     the project's key by hand in Brevo's console, named after the project, and types it in the
//     masked window, which puts it in the project only; `record` then checks it is not the
//     account's (compared in this process, never shown) and records it.
// The key is recorded in the project's manifest (kind email-key: its id at Resend, its name),
// where /rotate-secret and /delete-project find it to revoke it.
//
//   node email-key.mjs status --project-dir <dir>
//        what the project holds: its own key, the account's, another one, or none
//   node email-key.mjs mint   --project-dir <dir> --name <project> [--rotate | --replace]
//        Resend: the project's key made, written to .env and the hosting, recorded. --rotate: the
//        project holds its own key already, a new one replaces it (the older ones come back in
//        toRevoke, to revoke once the site runs with the new one); --replace: the project holds
//        the account's key (or another one), its own replaces it
//   node email-key.mjs record --project-dir <dir> --provider brevo --key-name <name>
//        Brevo: the key typed in the window is the project's own, recorded (never the account's)
//   node email-key.mjs revoke --project-dir <dir> --id <key id>
//        Resend: a key the project's manifest records as its own, revoked, read back gone, and
//        taken out of the manifest; any other key is refused
//
// One JSON line on stdout. Never a key, never part of one.
// Exit codes: 0 ok | 1 usage, or the provider refused | 2 vault locked | 3 vault session expired |
//   4 the account's key is not in the vault | 5 refused, the project's state does not allow it |
//   6 refused, a key this project does not record
//
// Recettes only: HYPERVIBE_RESEND_API, a fake Resend on the loopback; with it, and only then,
// HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY stands for the account's key (no vault is read).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dotenvLine } from "./_env-line.mjs";
import { envValue } from "./env-value.mjs";
import { createSendingKey, findDomain, isLoopback, revokeKey } from "./resend-keys.mjs";
import { getSecret } from "./vault/vault.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "manifest", "manifest.mjs");
const PUSH = join(HERE, "push-env-vars.mjs");

export const PROVIDERS = {
  resend: { item: "RESEND", field: "api_key", env: "RESEND_API_KEY", sender: "RESEND_FROM_EMAIL", display: "Resend", keysPage: "https://resend.com/api-keys" },
  brevo: { item: "BREVO", field: "api_key", env: "BREVO_API_KEY", sender: "BREVO_SENDER_EMAIL", display: "Brevo", keysPage: "https://app.brevo.com/settings/keys/api" },
};

class Stop extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/** The account's key, read in this process (the vault), or the recette's stand-in. */
export function accountKey(provider, env = process.env) {
  if (env.HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY && isLoopback(env.HYPERVIBE_RESEND_API)) return env.HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY;
  const p = PROVIDERS[provider];
  try {
    return getSecret(p.item, p.field);
  } catch (e) {
    if (e?.code === 2) throw new Stop(2, "The vault is locked: the account's key could not be read. Unlock it, then run this again.");
    if (e?.code === 3) throw new Stop(3, "The vault's session is over: the account's key could not be read. Unlock it, then run this again.");
    if (e?.code === 4 || e?.code === 5) throw new Stop(4, `The ${p.display} account's key is not in the vault (item ${p.item}, field ${p.field}): it is stored first, in the masked window.`);
    throw new Stop(1, `The vault could not be read (${e?.message ?? e}).`);
  }
}

/** The email-key entries the project's manifest records (identifiers only). */
export function recordedKeys(projectDir) {
  const r = spawnSync(process.execPath, [MANIFEST, "list", "--project-dir", projectDir, "--kind", "email-key"], { encoding: "utf8" });
  try {
    return JSON.parse(String(r.stdout).trim().split("\n").pop()).resources ?? [];
  } catch {
    return [];
  }
}

/** The project's provider, from the key it holds, else from its email package. */
function providerOf(projectDir) {
  if (envValue(projectDir, "RESEND_API_KEY")) return "resend";
  if (envValue(projectDir, "BREVO_API_KEY")) return "brevo";
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.resend) return "resend";
    if (deps["@getbrevo/brevo"]) return "brevo";
  } catch {
    // no package.json: no provider
  }
  return null;
}

/**
 * What the project holds, compared with the account's key in this process: "own" (its own key,
 * recorded), "account" (the account's key itself), "other" (a key that is neither, recorded
 * nowhere: made by hand, or an account key renewed since), "none".
 * @returns {{provider: string|null, holds: string, recorded: object[]}}
 */
export function projectState(projectDir, { provider = providerOf(projectDir), env = process.env } = {}) {
  if (!provider) return { provider: null, holds: "none", recorded: [] };
  const value = envValue(projectDir, PROVIDERS[provider].env);
  const recorded = recordedKeys(projectDir).filter((r) => (r.provider ?? "resend") === provider);
  if (!value) return { provider, holds: "none", recorded };
  if (value === accountKey(provider, env)) return { provider, holds: "account", recorded };
  return { provider, holds: recorded.length ? "own" : "other", recorded };
}

/** A value written to the project's .env and its hosting, on the helper's standard input. */
function pushToProject(projectDir, name, value) {
  const r = spawnSync(process.execPath, [PUSH, "--stdin"], { cwd: projectDir, encoding: "utf8", input: `${dotenvLine(name, value)}\n` });
  const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const local = envValue(projectDir, name) === value;
  const hosted = r.status === 0 && /Pushed .* to Vercel|\[vercel\] Pushing to Vercel/i.test(said) && !/Skipping Vercel push/i.test(said);
  return { local, hosting: hosted ? "written" : r.status === 0 ? "local only" : "not written" };
}

function manifest(args) {
  const r = spawnSync(process.execPath, [MANIFEST, ...args], { encoding: "utf8" });
  try {
    const out = JSON.parse(String(r.stdout).trim().split("\n").pop());
    return out.ok ? "recorded" : `not recorded (${out.reason})`;
  } catch {
    return `not recorded (exit ${r.status})`;
  }
}

/** The project's sender domain, when it is not the provider's test address. */
function senderDomain(projectDir, provider) {
  const sender = envValue(projectDir, PROVIDERS[provider].sender) ?? "";
  const at = sender.lastIndexOf("@");
  const domain = at > 0 ? sender.slice(at + 1).trim().toLowerCase() : "";
  return domain && domain !== "resend.dev" ? domain : null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Resend: the project's key made, written, recorded. */
export async function mint({ projectDir, name, rotate = false, replace = false, env = process.env, resend = {} }) {
  if (!name) throw new Stop(1, "mint needs --name <project>.");
  const provider = providerOf(projectDir) ?? "resend";
  if (provider !== "resend") throw new Stop(5, "Brevo makes no key through its API: the project's key is made by hand in Brevo's console, typed in the masked window, then `record`.");
  const key = accountKey("resend", env);
  const state = projectState(projectDir, { provider: "resend", env });
  if (state.holds === "own" && !rotate) throw new Stop(5, "The project holds its own sending key already (its manifest records it): --rotate makes a new one.", { holds: state.holds });
  if ((state.holds === "account" || state.holds === "other") && !replace) {
    throw new Stop(5, state.holds === "account" ? "The project holds the ACCOUNT's key: --replace gives it its own." : "The project holds a key this harness did not make (by hand, or an account key renewed since): --replace gives it its own.", { holds: state.holds });
  }
  if (rotate && state.holds !== "own") throw new Stop(5, "--rotate renews a key of the project's own, and it holds none.", { holds: state.holds });
  const domain = senderDomain(projectDir, "resend");
  const found = domain ? await findDomain(key, domain, resend) : null;
  const verified = found?.status === "verified" ? found : null;
  let made;
  try {
    made = await createSendingKey(key, { name: `${String(name).slice(0, 39)} ${today()}`, domainId: verified?.id ?? null }, resend);
  } catch (e) {
    // Made, then not read back: the key exists at Resend, unknown to anyone. Taken back at once.
    if (e?.keyId) await revokeKey(key, e.keyId, resend).catch(() => null);
    throw e;
  }
  const written = pushToProject(projectDir, "RESEND_API_KEY", made.token);
  if (!written.local) {
    // In no file and at no host: a key nobody holds would open sending to no one's knowledge.
    await revokeKey(key, made.id, resend).catch(() => null);
    throw new Stop(1, `The key made at Resend could not be written to the project's .env: it was revoked at once. Nothing changed.`);
  }
  const recorded = manifest(["add", "--project-dir", projectDir, "--kind", "email-key", "--id", made.id, "--name", made.name, "--field", "provider=resend", ...(verified ? ["--field", `domain=${verified.name}`] : []), "--added-by", "add-email"]);
  return {
    ok: true,
    status: rotate ? "rotated" : replace ? "replaced" : "created",
    provider: "resend",
    key: { id: made.id, name: made.name, sending: true, domain: verified?.name ?? null },
    ...(domain && !verified ? { domainNote: `${domain} is not verified at Resend yet: the key can send from the account's other domains too, until it is made again once the domain is verified (--rotate).` } : {}),
    hosting: written.hosting,
    manifest: recorded,
    ...(rotate ? { toRevoke: state.recorded.map((r) => r.id).filter(Boolean), revokeWhen: "once the site runs with the new key (a deployment followed to its end): revoke, for each id of toRevoke" } : {}),
    ...(replace && state.holds === "account" ? { accountKey: "still valid at Resend: renew it there once every project holds its own key" } : {}),
  };
}

/** Brevo: the key typed in the window is the project's own, recorded. */
export function record({ projectDir, keyName, env = process.env }) {
  if (!keyName) throw new Stop(1, "record needs --key-name <the name given to the key in Brevo's console>.");
  const value = envValue(projectDir, "BREVO_API_KEY");
  if (!value) throw new Stop(5, "The project holds no BREVO_API_KEY: the key made in Brevo's console is typed in the masked window first.");
  if (value === accountKey("brevo", env)) {
    throw new Stop(5, "This is the Brevo ACCOUNT's key: a project never holds it. Make a key of the project's own in Brevo's console, named after the project, type it in the window, then record it.", { holds: "account" });
  }
  const recorded = manifest(["add", "--project-dir", projectDir, "--kind", "email-key", "--name", keyName, "--field", "provider=brevo", "--field", "made=by-hand", "--added-by", "add-email"]);
  return { ok: true, provider: "brevo", key: { name: keyName }, manifest: recorded };
}

/** Resend: a key the project records as its own, revoked and read back gone. */
export async function revoke({ projectDir, id, env = process.env, resend = {} }) {
  if (!id) throw new Stop(1, "revoke needs --id <key id>.");
  const entry = recordedKeys(projectDir).find((r) => r.id === id && (r.provider ?? "resend") === "resend");
  if (!entry) throw new Stop(6, `The key ${id} is not one this project's manifest records as its own: it is not revoked here (another project's key, or the account's, is never touched).`);
  const key = accountKey("resend", env);
  const r = await revokeKey(key, id, resend);
  const removed = manifest(["remove", "--project-dir", projectDir, "--kind", "email-key", "--id", id]);
  return { ok: true, provider: "resend", id, revoked: true, ...(r.wasGone ? { wasGone: true } : {}), manifest: removed === "recorded" ? "removed" : removed.replace("recorded", "removed") };
}

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

if (launchedDirectly()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : null;
  };
  const projectDir = resolve(opt("project-dir") ?? process.cwd());
  try {
    if (!existsSync(projectDir)) throw new Stop(1, `No such folder: ${projectDir}`);
    let out;
    if (cmd === "status") out = { ok: true, ...projectState(projectDir) };
    else if (cmd === "mint") out = await mint({ projectDir, name: opt("name"), rotate: rest.includes("--rotate"), replace: rest.includes("--replace") });
    else if (cmd === "record") {
      if ((opt("provider") ?? "brevo") !== "brevo") throw new Stop(1, "record is for Brevo's keys, made by hand: a Resend key is made by mint.");
      out = record({ projectDir, keyName: opt("key-name") });
    } else if (cmd === "revoke") out = await revoke({ projectDir, id: opt("id") });
    else throw new Stop(1, "Usage: email-key.mjs <status|mint|record|revoke> --project-dir <dir> [...]");
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e?.message ?? String(e), ...(e?.holds ? { holds: e.holds } : {}) })}\n`);
    process.exit(Number.isInteger(e?.code) && e.code > 0 && e.code < 10 ? e.code : 1);
  }
}
