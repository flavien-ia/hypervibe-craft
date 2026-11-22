#!/usr/bin/env node
// email-key.mjs - The project's own sending key (3.4.16), never the account's.
//
// Until 3.4.15 /add-email copied the key of the WHOLE email account (a Resend "Full Access" key,
// the Brevo account's key) into the .env and the hosting of every project: a .env shown on screen
// (a filmed training), a repository or a host that leaks, and the whole account was open (sending,
// domains, contacts), for every project at once (Jérôme Carfantan's mail of 21/10/2026). Now each
// project holds a key of its own, and the account's key stays in the vault, for the harness's
// gestures on the account itself (a sending domain and its records, the senders, the quotas, and
// the projects' keys):
//   - Resend: the key is made here by the API, with the account's key read in this process and
//     never shown, limited to sending, and to the project's sender domain once Resend has verified
//     it (resend-keys.mjs);
//   - Brevo (3.4.34): the project's key is a sending application of the account (OAuth machine to
//     machine), made here by the API with the account's key, limited to `transactional.email:write`
//     (it opens neither the contacts, nor the campaigns, nor the account), its token tried before
//     it is filed; the project holds its client id and its secret (BREVO_CLIENT_ID,
//     BREVO_CLIENT_SECRET), never a key (brevo-apps.mjs). Until 3.4.33 the person made a key by
//     hand in Brevo's console, which opens the whole account (BREVO_API_KEY): such a project is
//     told so (`holds: "legacy"`) and moved to its own application without a break (the
//     application, the mail layer, a deployment, then `retire-legacy`). When Brevo's route refuses
//     to make the application (it is not in Brevo's published reference), exit 7: the key made by
//     hand of before (`record`), so that nothing blocks the person (decision D1 of 22/11/2026).
// The key is recorded in the project's manifest (kind email-key: its id at Resend or Brevo, its
// name), where /rotate-secret and /delete-project find it to revoke it.
//
//   node email-key.mjs status --project-dir <dir>
//        what the project holds: its own key, the account's, a Brevo key of the earlier kind
//        (legacy), another one, or none
//   node email-key.mjs mint   --project-dir <dir> --name <project> [--provider resend|brevo] [--rotate | --replace]
//        the project's key made (the provider read from the project, else --provider, else Resend), written to .env and the hosting, recorded. --rotate: the project
//        holds its own key already, a new one replaces it (the older ones come back in toRevoke,
//        to revoke once the site runs with the new one); --replace: the project holds the
//        account's key, a Brevo key of the earlier kind, or another one: its own comes beside it
//        (Resend: in its place; Brevo: under its own variables, the old one taken away later)
//   node email-key.mjs record --project-dir <dir> --provider brevo --key-name <name>
//        Brevo, the fallback (exit 7 of mint): the key a person made in Brevo's console and typed
//        in the window is the project's own, recorded (never the account's)
//   node email-key.mjs revoke --project-dir <dir> --id <key id>
//        a key or an application the project's manifest records as its own, revoked at Resend or
//        deleted at Brevo, read back gone, and taken out of the manifest; any other is refused
//   node email-key.mjs renew  --project-dir <dir> [--id <application id>]
//        Brevo, a secret that LEAKED: the application's secret renewed in place, the old one
//        refused at once, the new one written to .env and the hosting; deploy right away
//   node email-key.mjs retire-legacy --project-dir <dir>
//        Brevo: the key of the earlier kind (BREVO_API_KEY) taken out of .env and the hosting, once
//        the project holds its own application AND the site runs with it; then the key is deleted
//        by the person in Brevo's console (or, if it was the account's, renewed there)
//
// One JSON line on stdout. Never a key, a secret, a token, nor part of one.
// Exit codes: 0 ok | 1 usage, or the provider refused | 2 vault locked | 3 vault session expired |
//   4 the account's key is not in the vault | 5 refused, the project's state does not allow it |
//   6 refused, a key this project does not record | 7 Brevo's route did not make the application:
//   the project's key is made by a person in Brevo's console (`fallback: "dashboard-key"`)
//
// Recettes only: HYPERVIBE_RESEND_API and HYPERVIBE_BREVO_API, fakes on the loopback; with one of
// them, and only then, HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY stands for the account's key (no vault
// is read).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dotenvLine } from "./_env-line.mjs";
import { envValue } from "./env-value.mjs";
import { createSendingKey, findDomain, isLoopback, revokeKey } from "./resend-keys.mjs";
import { CLIENT_ID, CLIENT_SECRET, KEYS_PAGE, LEGACY_KEY, createSendingApp, deleteApp, isLoopback as isBrevoLoopback, renewSecret } from "./brevo-apps.mjs";
import { getSecret } from "./vault/vault.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "manifest", "manifest.mjs");
const PUSH = join(HERE, "push-env-vars.mjs");

export const PROVIDERS = {
  resend: { item: "RESEND", field: "api_key", env: "RESEND_API_KEY", sender: "RESEND_FROM_EMAIL", display: "Resend", keysPage: "https://resend.com/api-keys" },
  // `env`: a key of the earlier kind (made by hand, or the account's); `app`: the variables of the
  // project's own sending application (3.4.34).
  brevo: { item: "BREVO", field: "api_key", env: LEGACY_KEY, app: [CLIENT_ID, CLIENT_SECRET], sender: "BREVO_SENDER_EMAIL", display: "Brevo", keysPage: KEYS_PAGE },
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
  if (env.HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY && (isLoopback(env.HYPERVIBE_RESEND_API) || isBrevoLoopback(env.HYPERVIBE_BREVO_API))) return env.HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY;
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

/** The project's provider, from the key it holds, else from its email package or its mail layer. */
function providerOf(projectDir) {
  if (envValue(projectDir, "RESEND_API_KEY")) return "resend";
  if (envValue(projectDir, CLIENT_ID) || envValue(projectDir, LEGACY_KEY)) return "brevo";
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.resend) return "resend";
    if (deps["@getbrevo/brevo"]) return "brevo";
  } catch {
    // no package.json: no provider from it
  }
  // Since 3.4.34 the Brevo mail layer needs no package: its own file says it.
  try {
    if (/api\.brevo\.com/.test(readFileSync(join(projectDir, "src", "server", "mail.ts"), "utf8"))) return "brevo";
  } catch {
    // no mail layer
  }
  return null;
}

/** A Brevo application recorded by this harness (its id at Brevo), as opposed to a key made by hand. */
const isApp = (r) => r.made === "api" && Boolean(r.id);

/**
 * What the project holds, compared with the account's key in this process: "own" (its own key,
 * recorded), "account" (the account's key itself), "legacy" (Brevo: a key of the earlier kind,
 * made by hand in Brevo's console, which may open the whole account), "other" (a key that is
 * neither, recorded nowhere: made by hand, or an account key renewed since), "none".
 * At Brevo, `legacyVariable` names the old key's variable when the project still holds one, and
 * `ownAlready` says whether its own application is already there beside it.
 * @returns {{provider: string|null, holds: string, recorded: object[]}}
 */
export function projectState(projectDir, { provider = providerOf(projectDir), env = process.env } = {}) {
  if (!provider) return { provider: null, holds: "none", recorded: [] };
  const recorded = recordedKeys(projectDir).filter((r) => (r.provider ?? "resend") === provider);
  if (provider === "brevo") {
    const apps = recorded.filter(isApp);
    const appHeld = Boolean(envValue(projectDir, CLIENT_ID) && envValue(projectDir, CLIENT_SECRET));
    const ownAlready = appHeld && apps.length > 0;
    const head = { provider, variables: [CLIENT_ID, CLIENT_SECRET], recorded, apps: apps.map((r) => r.id) };
    const legacy = envValue(projectDir, LEGACY_KEY);
    if (legacy) {
      const holds = legacy === accountKey("brevo", env) ? "account" : "legacy";
      return { ...head, holds, legacyVariable: LEGACY_KEY, ownAlready };
    }
    if (ownAlready) return { ...head, holds: "own" };
    return { ...head, holds: appHeld ? "other" : "none" };
  }
  const value = envValue(projectDir, PROVIDERS[provider].env);
  if (!value) return { provider, holds: "none", recorded };
  if (value === accountKey(provider, env)) return { provider, holds: "account", recorded };
  return { provider, holds: recorded.length ? "own" : "other", recorded };
}

/** Values written to the project's .env and its hosting, on the helper's standard input, in one
 *  call: a key of several variables (a Brevo application) is filed whole. */
function pushToProject(projectDir, values) {
  const pairs = Object.entries(values);
  const r = spawnSync(process.execPath, [PUSH, "--stdin"], { cwd: projectDir, encoding: "utf8", input: `${pairs.map(([n, v]) => dotenvLine(n, v)).join("\n")}\n` });
  const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const local = pairs.every(([n, v]) => envValue(projectDir, n) === v);
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

/** The project's key made, written, recorded: Resend's key, or Brevo's sending application. */
export async function mint({ projectDir, name, provider: wanted = null, rotate = false, replace = false, env = process.env, resend = {}, brevo = {} }) {
  if (!name) throw new Stop(1, "mint needs --name <project>.");
  if (rotate && replace) throw new Stop(1, "--rotate or --replace, not both.");
  if (wanted && !PROVIDERS[wanted]) throw new Stop(1, "--provider resend|brevo.");
  // A project that holds nothing yet says nothing of its provider: the skill names it.
  const provider = wanted ?? providerOf(projectDir) ?? "resend";
  if (provider === "brevo") return mintBrevo({ projectDir, name, rotate, replace, env, brevo });
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
  const written = pushToProject(projectDir, { RESEND_API_KEY: made.token });
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

/** Brevo: the project's sending application made with the account's key, its two variables written
 *  to .env and the hosting in one call, recorded by its id. A key of the earlier kind stays where it
 *  is: the site keeps sending with it until it is deployed with the application (retire-legacy). */
async function mintBrevo({ projectDir, name, rotate, replace, env, brevo }) {
  const state = projectState(projectDir, { provider: "brevo", env });
  if (state.holds === "own" && !rotate) throw new Stop(5, "The project holds its own sending application already (its manifest records it): --rotate makes a new one.", { holds: state.holds });
  if (rotate && state.holds !== "own") throw new Stop(5, "--rotate renews the project's own application, and it holds none.", { holds: state.holds });
  if ((state.holds === "account" || state.holds === "legacy" || state.holds === "other") && !replace) {
    const why = {
      account: "The project holds the Brevo ACCOUNT's key: --replace gives it its own sending application.",
      legacy: "The project holds a Brevo key of the earlier kind (BREVO_API_KEY, made by hand, which may open the whole account): --replace gives it its own sending application beside it.",
      other: "The project holds Brevo credentials this harness did not make: --replace gives it its own sending application.",
    }[state.holds];
    throw new Stop(5, why, { holds: state.holds });
  }
  if (replace && state.ownAlready) {
    throw new Stop(5, "The project holds its own sending application already, beside the key of the earlier kind: nothing to make. Deploy the site, then take the old key away (retire-legacy).", { holds: state.holds, ownAlready: true });
  }
  const key = accountKey("brevo", env);
  let made;
  try {
    made = await createSendingApp(key, { name: `${String(name).slice(0, 37)} ${today()}` }, brevo);
  } catch (e) {
    // Made all the same, then not proved: an application nobody holds is deleted at once.
    let deleted = null;
    if (e?.keyId) deleted = await deleteApp(key, e.keyId, brevo).then(() => true, () => false);
    const extra = { ...(e?.keyId ? { keyId: e.keyId, deleted } : {}), ...(state.holds !== "none" ? { holds: state.holds } : {}) };
    if (e?.fallback) throw new Stop(7, e.message, { ...extra, fallback: "dashboard-key", procedure: KEYS_PAGE });
    throw new Stop(1, e?.message ?? String(e), extra);
  }
  const written = pushToProject(projectDir, { [CLIENT_ID]: made.clientId, [CLIENT_SECRET]: made.clientSecret });
  if (!written.local) {
    await deleteApp(key, made.id, brevo).catch(() => null);
    throw new Stop(1, "The application made at Brevo could not be written to the project's .env: it was deleted at once. Nothing changed.");
  }
  const recorded = manifest(["add", "--project-dir", projectDir, "--kind", "email-key", "--id", made.id, "--name", made.name, "--field", "provider=brevo", "--field", "made=api", "--added-by", "add-email"]);
  return {
    ok: true,
    status: rotate ? "rotated" : replace ? "replaced" : "created",
    provider: "brevo",
    key: { id: made.id, name: made.name, sending: true, variables: [CLIENT_ID, CLIENT_SECRET] },
    hosting: written.hosting,
    manifest: recorded,
    ...(rotate ? { toRevoke: state.apps, revokeWhen: "once the site runs with the new application (a deployment followed to its end): revoke, for each id of toRevoke" } : {}),
    ...(state.legacyVariable ? { legacyVariable: state.legacyVariable, retireWhen: "once the site runs with the application (a deployment followed to its end): retire-legacy, then the old key deleted in Brevo's console" } : {}),
    ...(state.holds === "account" ? { accountKey: "still valid at Brevo: renew it there once every project holds its own application" } : {}),
  };
}

/** Brevo, the fallback: the key typed in the window is the project's own, recorded. */
export function record({ projectDir, keyName, env = process.env }) {
  if (!keyName) throw new Stop(1, "record needs --key-name <the name given to the key in Brevo's console>.");
  const value = envValue(projectDir, LEGACY_KEY);
  if (!value) throw new Stop(5, "The project holds no BREVO_API_KEY: the key made in Brevo's console is typed in the masked window first.");
  if (value === accountKey("brevo", env)) {
    throw new Stop(5, "This is the Brevo ACCOUNT's key: a project never holds it. Make a key of the project's own in Brevo's console, named after the project, type it in the window, then record it.", { holds: "account" });
  }
  const recorded = manifest(["add", "--project-dir", projectDir, "--kind", "email-key", "--name", keyName, "--field", "provider=brevo", "--field", "made=by-hand", "--added-by", "add-email"]);
  return { ok: true, provider: "brevo", key: { name: keyName }, manifest: recorded };
}

/** A key the project records as its own, revoked at Resend or deleted at Brevo, and read back gone. */
export async function revoke({ projectDir, id, env = process.env, resend = {}, brevo = {} }) {
  if (!id) throw new Stop(1, "revoke needs --id <key id>.");
  const entry = recordedKeys(projectDir).find((r) => r.id === id && ((r.provider ?? "resend") === "resend" || isApp(r)));
  if (!entry) throw new Stop(6, `The key ${id} is not one this project's manifest records as its own: it is not revoked here (another project's key, or the account's, is never touched).`);
  const provider = entry.provider ?? "resend";
  const key = accountKey(provider, env);
  let r;
  try {
    r = provider === "brevo" ? await deleteApp(key, id, brevo) : await revokeKey(key, id, resend);
  } catch (e) {
    throw new Stop(1, e?.message ?? String(e));
  }
  const removed = manifest(["remove", "--project-dir", projectDir, "--kind", "email-key", "--id", id]);
  return { ok: true, provider, id, revoked: true, ...(r.wasGone ? { wasGone: true } : {}), ...(r.lingering ? { lingering: r.lingering } : {}), manifest: removed === "recorded" ? "removed" : removed.replace("recorded", "removed") };
}

/** Brevo, a secret that leaked: renewed in place at Brevo (the old one refused at once), the new
 *  one written to .env and the hosting. The site is to be deployed right away. */
export async function renew({ projectDir, id = null, env = process.env, brevo = {} }) {
  const state = projectState(projectDir, { provider: "brevo", env });
  if (!state.apps.length || !envValue(projectDir, CLIENT_ID)) throw new Stop(5, "The project holds no sending application of its own at Brevo: nothing to renew in place.", { holds: state.holds });
  if (id && !state.apps.includes(id)) throw new Stop(6, `The application ${id} is not one this project's manifest records as its own: its secret is not renewed here.`);
  if (!id && state.apps.length > 1) throw new Stop(1, `The project's manifest records ${state.apps.length} applications (a rotation not finished): name the one the site uses, --id <id>.`, { apps: state.apps });
  const appId = id ?? state.apps[0];
  const key = accountKey("brevo", env);
  let renewed;
  try {
    renewed = await renewSecret(key, appId, brevo);
  } catch (e) {
    throw new Stop(1, e?.message ?? String(e));
  }
  const written = pushToProject(projectDir, { [CLIENT_ID]: renewed.clientId, [CLIENT_SECRET]: renewed.clientSecret });
  if (!written.local) {
    throw new Stop(1, `Brevo renewed the secret of ${appId}, but the project's .env could not be written: the old secret is refused already, and the site cannot send until it holds the new one. Fix the .env, then run renew again.`);
  }
  return {
    ok: true,
    status: "renewed",
    provider: "brevo",
    key: { id: appId, variables: [CLIENT_ID, CLIENT_SECRET] },
    hosting: written.hosting,
    deploy: "now: the live site keeps the token it holds, an hour at most, and cannot ask for another one with the old secret",
  };
}

/** Brevo: the key of the earlier kind taken out of .env and the hosting, once the project holds its
 *  own application AND the site runs with it. The key itself is then deleted by the person in
 *  Brevo's console (or, if it was the account's, renewed there): Brevo's API cannot list keys. */
export function retireLegacy({ projectDir, env = process.env }) {
  const state = projectState(projectDir, { provider: "brevo", env });
  if (!state.legacyVariable) return { ok: true, status: "none", provider: "brevo", holds: state.holds };
  if (!state.ownAlready) throw new Stop(5, "The project does not hold its own sending application yet: mint --replace first, then a deployment followed to its end. Nothing was taken away.", { holds: state.holds });
  const r = spawnSync(process.execPath, [PUSH, "--remove", LEGACY_KEY], { cwd: projectDir, encoding: "utf8" });
  const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const local = !envValue(projectDir, LEGACY_KEY);
  if (r.status !== 0 && !local) throw new Stop(1, `${LEGACY_KEY} could not be taken out of the project (${said.trim().split("\n").pop()}).`);
  const hosting = r.status !== 0 ? "not removed" : /Skipping Vercel push|local \.env only/i.test(said) ? "local only" : "removed";
  const byHand = state.recorded.filter((k) => k.made === "by-hand" && k.name);
  for (const k of byHand) manifest(["remove", "--project-dir", projectDir, "--kind", "email-key", "--name", k.name]);
  return {
    ok: true,
    status: "retired",
    provider: "brevo",
    variable: LEGACY_KEY,
    local: local ? "removed" : "still there",
    hosting,
    ...(state.holds === "account"
      ? { accountKey: "the project held the Brevo ACCOUNT's key: renew it in Brevo's console once every project holds its own application, then store the new one in the vault" }
      : { toDeleteByHand: byHand.length ? byHand.map((k) => k.name) : ["the key made for this project (its name is the project's, or close to it)"], keysPage: KEYS_PAGE }),
  };
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
    else if (cmd === "mint") out = await mint({ projectDir, name: opt("name"), provider: opt("provider"), rotate: rest.includes("--rotate"), replace: rest.includes("--replace") });
    else if (cmd === "record") {
      if ((opt("provider") ?? "brevo") !== "brevo") throw new Stop(1, "record is for Brevo's keys, made by hand: a Resend key is made by mint.");
      out = record({ projectDir, keyName: opt("key-name") });
    } else if (cmd === "revoke") out = await revoke({ projectDir, id: opt("id") });
    else if (cmd === "renew") out = await renew({ projectDir, id: opt("id") });
    else if (cmd === "retire-legacy") out = retireLegacy({ projectDir });
    else throw new Stop(1, "Usage: email-key.mjs <status|mint|record|revoke|renew|retire-legacy> --project-dir <dir> [...]");
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  } catch (e) {
    const extra = {};
    for (const k of ["holds", "ownAlready", "fallback", "procedure", "keyId", "deleted", "apps"]) if (e?.[k] !== undefined) extra[k] = e[k];
    process.stdout.write(`${JSON.stringify({ ok: false, error: e?.message ?? String(e), ...extra })}\n`);
    process.exit(Number.isInteger(e?.code) && e.code > 0 && e.code < 10 ? e.code : 1);
  }
}
