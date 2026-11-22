// brevo-apps.mjs - A project's own sending application at Brevo (3.4.34 / 2.5.13): a private
// "machine to machine" application of the account (OAuth client_credentials), made by the API with
// the account's key, limited to `transactional.email:write`, whose client id and secret the project
// holds (BREVO_CLIENT_ID, BREVO_CLIENT_SECRET) in place of a key made by hand in Brevo's console,
// which opened the whole account. The account's key is read by the caller, in its own process, and
// handed here: it never reaches a command line nor the conversation, and nothing here prints a key,
// a secret or a token, nor puts one in an error.
//
// What this module knows of Brevo (the routes Brevo's own CLI calls, @getbrevo/cli 2.6.1, read on
// 21/11/2026, not its published reference; tried on a real account on 22/11/2026):
//   - POST /v3/app-store/apps {name, distribution_type: "private", app_type: "oauth.m2m",
//     auth: {type: "m2m", scopes}} -> 201 {app_id, name, version, distribution_type,
//     auth: {client_id, client_secret (64 characters), scopes}}; a name of 48 characters at most
//     (letters, digits, space, . _ -, accented letters), and names are NOT unique: an application
//     is known by its app_id only;
//   - GET /v3/app-store/apps[?type=m2m] and GET /v3/app-store/apps/{id} give the client_secret of
//     EVERY application, in clear, to the account's key: this module never hands one on (the
//     guardrail asks before any raw call to these routes);
//   - DELETE /v3/app-store/apps/{id} -> 204, then 404;
//   - POST /v3/app-store/apps/{id}/secret/rotate -> 200 {client_id, client_secret}: the old secret
//     is refused AT ONCE (no grace window, whatever Brevo's documentation says);
//   - POST /realms/partner/oauth/token (a form: grant_type=client_credentials, client_id,
//     client_secret, scope) -> {access_token, expires_in: 3600, scope}: no refresh token, and the
//     scope always named;
//   - a token already given keeps working for its hour after its application is deleted or its
//     secret renewed;
//   - the route may change without notice: an answer that is neither a refusal of the account's key
//     (401) nor a limit (429) is the route refusing (`fallback: true` on the error): the caller then
//     falls back on the key a person makes in Brevo's console, so that nothing blocks them
//     (Flavien's decision D1 of 22/11/2026).
//
// Recettes only: HYPERVIBE_BREVO_API, a fake Brevo on the loopback (any other address is ignored).

export const API = "https://api.brevo.com";
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;
/** The one scope a project's application holds, and asks its tokens for. */
export const SENDING_SCOPE = "transactional.email:write";
/** The variables a project files its application under (its .env, its hosting, its space). */
export const CLIENT_ID = "BREVO_CLIENT_ID";
export const CLIENT_SECRET = "BREVO_CLIENT_SECRET";
/** The variable of a key of the earlier kind: made by a person in Brevo's console, it may open the
 *  whole account. Also the name the account's own key goes by on the shared clock. */
export const LEGACY_KEY = "BREVO_API_KEY";
/** Where a person makes such a key, the fallback when the applications' route refuses. */
export const KEYS_PAGE = "https://app.brevo.com/settings/keys/api";

/** Whether an address is the loopback a recette's fake Brevo listens on. */
export const isLoopback = (url) => typeof url === "string" && LOOPBACK.test(url);
/** Where the calls go: Brevo, or a recette's fake on the loopback. */
export const apiBase = (env = process.env) => (isLoopback(env.HYPERVIBE_BREVO_API) ? env.HYPERVIBE_BREVO_API : API);

/** A refusal of Brevo in its own words (they never carry a key). `fallback`: the applications'
 *  route itself refused, not the account's key: the project's key is then made by a person. */
export class BrevoAppError extends Error {
  constructor(step, status, json, { fallback = false, keyId = null } = {}) {
    const said = String(json?.message ?? json?.error_description ?? json?.error ?? (status ? `HTTP ${status}` : "an answer of an unexpected shape")).replace(/\.$/, "");
    let message;
    if (status === 401 && /unrecogni[sz]ed IP|IP address/i.test(said)) {
      message = `Brevo refused a call from an address it does not know yet (${step}): the account blocks unknown addresses. Brevo has mailed the account's owner to confirm it, or it can be authorised in Brevo's security settings (Authorized IPs); then retry.`;
    } else if (status === 401) {
      message = `Brevo refused the account's key (${step}): ${said}. Either it is wrong, or Brevo deactivated it (after 90 days without a call), or it was deleted: make a new one, and store it in the vault.`;
    } else if (status === 429) {
      message = `Brevo limits the calls (${step}): ${said}. Wait a moment, then retry.`;
    } else if (fallback) {
      message = `Brevo did not make the project's sending application (${step}: ${said}). Its route is not in Brevo's published reference and may have changed: the project's key is then made by a person, in Brevo's console.`;
    } else {
      message = `Brevo refused (${step}): ${said}.`;
    }
    super(message);
    this.step = step;
    this.status = status;
    this.apiCode = json?.code ?? null;
    this.fallback = fallback;
    if (keyId) this.keyId = keyId;
  }
}

/** One call with the account's key: {status, json}. A network failure throws, never "nothing there". */
async function call(key, method, path, body, { base = apiBase(), fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${base}/v3${path}`, {
      method,
      headers: { "api-key": key, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Brevo did not answer (${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e}): nothing can be concluded.`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** A refusal at the applications' route: the account's key (401) or a limit (429) said as such,
 *  anything else is the route refusing (the fallback). */
const routeError = (step, r, keyId = null) => new BrevoAppError(step, r.status, r.json, { fallback: r.status !== 401 && r.status !== 429, keyId });

/** The name Brevo accepts for an application, from the project's: its letters, digits, spaces and
 *  `. _ -` (accented letters kept), 48 characters at most. */
export function applicationName(label) {
  const kept = String(label ?? "").normalize("NFC").replace(/[^\p{L}\p{N} ._-]+/gu, "-").replace(/-{2,}/g, "-").replace(/^[-. ]+|[-. ]+$/g, "");
  return kept.slice(0, 48).replace(/[-. ]+$/, "") || "hypervibe-project";
}

/** A token for the application, its scope named: {scope, expiresIn}, or null when Brevo refuses the
 *  client. The token itself never leaves this function: it only proves the application works. */
async function tokenFor(clientId, clientSecret, { base = apiBase(), fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${base}/realms/partner/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: SENDING_SCOPE }).toString(),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Brevo did not answer for a token (${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e}): nothing can be concluded.`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status !== 200 || typeof json?.access_token !== "string" || !json.access_token) return null;
  return { scope: String(json.scope ?? "").trim(), expiresIn: Number(json.expires_in) || null };
}

/** Whether a client works and holds the sending scope alone: a token asked twice at most (an
 *  application just made may take a moment to answer). */
async function provenSending(clientId, clientSecret, opts = {}) {
  const pause = opts.pause ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  for (let i = 0; i < 2; i += 1) {
    const t = await tokenFor(clientId, clientSecret, opts);
    if (t) return t.scope === SENDING_SCOPE ? { ok: true } : { ok: false, why: `its token carries "${t.scope}", not "${SENDING_SCOPE}" alone` };
    if (i === 0) await pause(1500);
  }
  return { ok: false, why: "Brevo refused it a token" };
}

/**
 * The project's sending application, made with the account's key: limited to sending, its form and
 * its scope checked, a token tried before the credentials leave this function. The secret goes to
 * the caller's process only, which files it where the project keeps it. An application made all the
 * same but that does not prove itself comes back in the error's `keyId`, for the caller to delete.
 * @returns {Promise<{id: string, name: string, clientId: string, clientSecret: string}>}
 */
export async function createSendingApp(key, { name }, opts = {}) {
  const label = applicationName(name);
  const r = await call(key, "POST", "/app-store/apps", { name: label, distribution_type: "private", app_type: "oauth.m2m", auth: { type: "m2m", scopes: [SENDING_SCOPE] } }, opts);
  const id = typeof r.json?.app_id === "string" && r.json.app_id ? r.json.app_id : null;
  if (r.status !== 201 && r.status !== 200) throw routeError("create the application", r, id);
  const auth = r.json?.auth ?? {};
  const clientId = String(auth.client_id ?? r.json?.client_id ?? "");
  const clientSecret = String(auth.client_secret ?? r.json?.client_secret ?? "");
  const scopes = Array.isArray(auth.scopes ?? r.json?.scopes) ? (auth.scopes ?? r.json.scopes) : null;
  if (!id) throw new BrevoAppError("create the application", 0, { message: "no app_id in Brevo's answer" }, { fallback: true });
  if (!clientId || clientSecret.length < 32) throw new BrevoAppError("create the application", 0, { message: "no client id or secret in Brevo's answer" }, { fallback: true, keyId: id });
  if (scopes && (scopes.length !== 1 || scopes[0] !== SENDING_SCOPE)) {
    throw new BrevoAppError("create the application", 0, { message: `the application holds ${JSON.stringify(scopes)}, not "${SENDING_SCOPE}" alone` }, { fallback: true, keyId: id });
  }
  const proof = await provenSending(clientId, clientSecret, opts);
  if (!proof.ok) throw new BrevoAppError("token", 0, { message: proof.why }, { fallback: true, keyId: id });
  return { id, name: String(r.json?.name ?? label), clientId, clientSecret };
}

/** The account's machine-to-machine applications: ids, names and limits, NEVER a secret (Brevo's
 *  list gives every one in clear: only the fields below leave this function). */
export async function listApps(key, opts = {}) {
  const r = await call(key, "GET", "/app-store/apps?type=m2m", undefined, opts);
  if (r.status !== 200 || !Array.isArray(r.json)) throw routeError("list the applications", r);
  return r.json
    .filter((a) => a && typeof a.app_id === "string")
    .map((a) => {
      const scopes = Array.isArray(a.scopes) ? a.scopes.map(String) : [];
      return { id: a.app_id, name: a.name ?? null, sending: scopes.length === 1 && scopes[0] === SENDING_SCOPE, scopes };
    });
}

/** One application deleted, then read back gone (its own read answers 404). A token it gave keeps
 *  working for its hour: said in `lingering`. */
export async function deleteApp(key, id, opts = {}) {
  const path = `/app-store/apps/${encodeURIComponent(String(id))}`;
  const d = await call(key, "DELETE", path, undefined, opts);
  if (d.status !== 204 && d.status !== 200 && d.status !== 404) throw routeError("delete the application", d);
  const g = await call(key, "GET", path, undefined, opts);
  if (g.status === 200) throw new Error(`Brevo still shows the application ${id} after its deletion: it may still send. Retry, or delete it in Brevo's console.`);
  if (g.status !== 404) throw routeError("read the application back", g);
  return { revoked: true, ...(d.status === 404 ? { wasGone: true } : {}), lingering: "a token the application gave keeps working until it expires, an hour at most" };
}

/** The application's secret renewed in place, for a secret that leaked: the old one is refused at
 *  once (no grace window), the new one tried before it leaves this function. */
export async function renewSecret(key, id, opts = {}) {
  const r = await call(key, "POST", `/app-store/apps/${encodeURIComponent(String(id))}/secret/rotate`, undefined, opts);
  if (r.status !== 200 && r.status !== 201) throw routeError("renew the secret", r);
  const clientId = String(r.json?.client_id ?? r.json?.auth?.client_id ?? "");
  const clientSecret = String(r.json?.client_secret ?? r.json?.auth?.client_secret ?? "");
  if (!clientId || clientSecret.length < 32) throw new Error(`Brevo renewed the secret of the application ${id} but gave it back in a shape this harness does not read: the old secret is refused already. Renew it again.`);
  const proof = await provenSending(clientId, clientSecret, opts);
  if (!proof.ok) throw new Error(`Brevo renewed the secret of the application ${id}, but the new one does not work (${proof.why}): the old one is refused already. Renew it again, or give the project a new application.`);
  return { id: String(id), clientId, clientSecret };
}
