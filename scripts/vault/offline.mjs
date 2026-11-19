// offline.mjs - Telling "no internet" from "wrong master password", in the vault's window.
//
// On 18/11/2026, without a connection, Flavien typed his RIGHT master password three times and the
// window answered "Master password incorrect" three times: it read an empty answer of `bw unlock` as
// a typo, whatever the cause, and burnt the three tries on a network that was down. Now the window
// asks the server first (a short request, bounded in time) and says that internet is needed,
// without asking for anything; and after a failed `bw` it reads what bw said, then asks the server
// again: a network that failed never counts as a try, and never shows as a wrong password.
//
// What bw REALLY prints when its server cannot be reached (bw 2026.4.2, captured on 18/11/2026 in a
// throwaway data folder, fixtures in scripts/tests/fixtures/bw-offline.json): EVERY command, even
// `bw status` that then succeeds, first writes on stderr
//   Unable to fetch ServerConfig from https://vault.invalid/api FetchError: request to
//   https://vault.invalid/api/config failed, reason: getaddrinfo ENOTFOUND vault.invalid
// (ECONNREFUSED for a closed port, ETIMEDOUT for a network that does not answer), and a login ends
// on "FetchError: request to .../identity/accounts/prelogin/password failed, reason: ...". A
// refused password at sign-in ends on "Invalid master password. Confirm your email is correct and
// your account was created on vault.bitwarden.eu.". What `bw unlock` prints offline for a signed-in
// account could not be captured without a real account: whatever it prints, a server that does not
// answer right after the failure makes it a network failure, which is why the window asks again.
//
// The exit code of a window closed for want of a network is OFFLINE_EXIT, distinct from every other
// one (1 a failure, 130 Ctrl+C, and 2 to 5, the codes of vault.mjs): launch.mjs passes it through,
// and the skills then wait for the person to be connected again instead of reopening the window.

import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** The window's exit code when the vault's server cannot be reached. */
export const OFFLINE_EXIT = 8;
/** How long the server is given to answer, in milliseconds: a few seconds, never a long wait. */
export const PROBE_TIMEOUT_MS = 5000;
/** The server of a machine that says nothing else (the EU cloud, the plugin's default). */
export const DEFAULT_SERVER = "https://vault.bitwarden.eu";

const CLOUD = { US: "https://vault.bitwarden.com", EU: "https://vault.bitwarden.eu" };

/** bw's data folder: the one bw-home.mjs points every bw at (BITWARDENCLI_APPDATA_DIR), else bw's
 *  own one on this system. */
export function bwDataDir({ env = process.env, os = platform(), home = homedir() } = {}) {
  if (env.BITWARDENCLI_APPDATA_DIR) return env.BITWARDENCLI_APPDATA_DIR;
  if (os === "win32") return env.APPDATA ? join(env.APPDATA, "Bitwarden CLI") : null;
  if (os === "darwin") return join(home, "Library", "Application Support", "Bitwarden CLI");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Bitwarden CLI");
}

/** The address of one environment record of bw's data.json: a cloud region, or a server's own. */
function addressOf(record) {
  if (!record || typeof record !== "object") return null;
  const region = String(record.region ?? "").toUpperCase();
  if (CLOUD[region]) return CLOUD[region];
  const urls = record.urls ?? {};
  for (const url of [urls.base, urls.webVault, urls.api, urls.identity]) {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url.replace(/\/+$/, "");
  }
  return null;
}

/** The server bw is set to, read in its data.json (the signed-in account's environment first,
 *  then the machine's one), without running bw: offline, every bw command first waits for the
 *  server. The plugin's default when nothing can be read. Reads no secret: only addresses. */
export function configuredServer({ dir = bwDataDir(), read = (file) => readFileSync(file, "utf8") } = {}) {
  if (!dir) return DEFAULT_SERVER;
  let data;
  try {
    data = JSON.parse(read(join(dir, "data.json")));
  } catch {
    return DEFAULT_SERVER;
  }
  const active = data?.global_account_activeAccountId;
  const candidates = [];
  if (typeof active === "string") candidates.push(data[`user_${active}_environment_environment`]);
  for (const [key, value] of Object.entries(data ?? {})) {
    if (/^user_.+_environment_environment$/.test(key)) candidates.push(value);
  }
  candidates.push(data?.global_environment_environment);
  for (const record of candidates) {
    const address = addressOf(record);
    if (address) return address;
  }
  return DEFAULT_SERVER;
}

/** The causes that say the network itself failed: the name not found, nobody answering, the
 *  connection cut. Anything else (a certificate refused, an answer of any status) says there is a
 *  network, and the window leaves the verdict to bw. */
const NETWORK_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "ENETUNREACH",
  "EHOSTUNREACH", "ENETDOWN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT",
]);

function isNetworkError(e) {
  if (!e) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  for (let cause = e, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (NETWORK_CODES.has(cause.code) || NETWORK_CODES.has(cause.errno)) return true;
    if (Array.isArray(cause.errors) && cause.errors.some((inner) => NETWORK_CODES.has(inner?.code))) return true;
  }
  return false;
}

/** Whether a proxy is set for this process: Node's fetch does not go through it, bw does. The probe
 *  then says nothing, and only what bw answers decides. */
const proxied = (env) => ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((name) => env[name]);

/**
 * Whether the server answers: any answer at all, whatever its status, means the network is there.
 * False only when the network failed (name not found, refused, cut, no answer within `timeoutMs`).
 * `fetchImpl`: recettes only.
 */
export async function serverAnswers(url = DEFAULT_SERVER, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (proxied(env) || typeof fetchImpl !== "function") return true;
  // A timer of our own, which keeps the process alive and bounds the wait even for a request that
  // would ignore its signal (AbortSignal.timeout does neither).
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = Object.assign(new Error(`no answer within ${timeoutMs} ms`), { name: "TimeoutError" });
      controller.abort(e);
      reject(e);
    }, timeoutMs);
  });
  try {
    await Promise.race([fetchImpl(url, { method: "HEAD", redirect: "manual", signal: controller.signal }), deadline]);
    return true;
  } catch (e) {
    return !isNetworkError(e);
  } finally {
    clearTimeout(timer);
  }
}

/** What bw writes when it could not reach its server (the shapes captured above). */
const NETWORK_TEXT = /fetch ?failed|FetchError|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up/i;
/** What bw writes when nobody is signed in: neither a network nor a password. */
const SIGNED_OUT_TEXT = /you are not logged in|not logged in|no active account/i;

/**
 * What a failed bw run says: "network" (it could not reach its server), "signed-out" (no account
 * here) or "password" (the master password was refused; also the reading of an answer bw words in
 * its own way, as before: the server is asked again right after, see failureKind).
 */
export function classifyBwFailure(res = {}) {
  const text = `${res.stderr ?? ""}\n${res.stdout ?? ""}\n${res.error ? String(res.error) : ""}`;
  if (NETWORK_TEXT.test(text)) return "network";
  if (SIGNED_OUT_TEXT.test(text)) return "signed-out";
  return "password";
}

/** The kind of a failed bw run, the server asked again when the text alone does not say network:
 *  a server that does not answer right after a failure makes it a network failure, whatever bw
 *  wrote. `probe`: recettes only. */
export async function failureKind(res, { server = DEFAULT_SERVER, probe = serverAnswers } = {}) {
  const kind = classifyBwFailure(res);
  if (kind === "network") return kind;
  return (await probe(server)) ? kind : "network";
}

/** Throws the offline error, saying `message`, when the server does not answer. Called before the
 *  window asks for anything. `probe`: recettes only. */
export async function requireServer(server, message, { probe = serverAnswers } = {}) {
  if (!(await probe(server))) throw offlineError(message);
}

/**
 * The window's tries at a password, the network told apart. `ask(attempt)` asks and resolves to what
 * was typed; `run(answer)` runs bw and resolves to {ok: true, value} or {ok: false, res}; a failure is
 * read by failureKind (bw's text, then the server asked again). A network failure throws the offline
 * error at once, the try not counted; no account here throws `signedOut`; a refused password calls
 * `onRefused(attempt)` before the next try. Resolves to the first success's value, or to undefined
 * once `max` tries were refused (the caller says so). `probe`: recettes only.
 */
export async function tryAttempts({ max, ask, run, server, offline, signedOut, onRefused = () => {}, probe = serverAnswers }) {
  for (let attempt = 1; attempt <= max; attempt++) {
    const out = await run(await ask(attempt));
    if (out?.ok) return out.value;
    const kind = await failureKind(out?.res ?? {}, { server, probe });
    if (kind === "network") throw offlineError(offline);
    if (kind === "signed-out" && signedOut) throw new Error(signedOut);
    if (attempt < max) onRefused(attempt);
  }
  return undefined;
}

/** The error a window throws when the network is missing: its exit code is OFFLINE_EXIT. */
export function offlineError(message) {
  return Object.assign(new Error(message), { offline: true });
}

/** The exit code of a window that failed with `e`. */
export const exitCodeOf = (e) => (e?.offline ? OFFLINE_EXIT : 1);

/** What launch.mjs says to Claude when the window closed for want of a network (read by Claude,
 *  not by the person: in English, like every diagnostic of the vault's scripts). */
export const OFFLINE_NOTE = `[vault] exit ${OFFLINE_EXIT}: no internet connection, the vault's server did not answer. The master password was not refused. Tell the person in one sentence that internet is needed to open the vault, then wait until they say they are connected again. Do not reopen the window on your own, and never speak of a wrong password.`;
