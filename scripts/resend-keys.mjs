// resend-keys.mjs - A project's own sending key at Resend (3.4.16 / 2.4.15): made by the API with
// the account's key, limited to sending (and to the project's domain once Resend has verified it),
// listed, and revoked. The account's key is read by the caller, in its own process, and handed
// here: it never reaches a command line nor the conversation, and nothing here prints a key or puts
// one in an error.
//
// What this module knows of Resend (its API reference, read on 23/10/2026):
//   - POST /api-keys {name (50 characters at most), permission: "sending_access", domain_id}
//     answers {id, token}: the token is in that answer and nowhere else, ever;
//   - GET /api-keys answers {data: [{id, name, created_at, last_used_at}]}, in pages when `limit`
//     is given (`has_more`, `after`): never a key's permission, never its token;
//   - DELETE /api-keys/{id};
//   - GET /domains answers {data: [{id, name, status}]}: a key limited to a domain needs its id;
//   - a key limited to sending is refused everything else (401 `restricted_api_key`).
//
// Recettes only: HYPERVIBE_RESEND_API, a fake Resend on the loopback (any other address is
// ignored).

export const API = "https://api.resend.com";
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;
const PAGE = 100;

/** Whether an address is the loopback a recette's fake Resend listens on. */
export const isLoopback = (url) => typeof url === "string" && LOOPBACK.test(url);
/** Where the calls go: Resend, or a recette's fake on the loopback. */
export const apiBase = (env = process.env) => (isLoopback(env.HYPERVIBE_RESEND_API) ? env.HYPERVIBE_RESEND_API : API);

/** A refusal of Resend in its own words (they never carry a key). */
export class ResendError extends Error {
  constructor(step, status, json) {
    const name = String(json?.name ?? "");
    const said = String(json?.message ?? `HTTP ${status}`).replace(/\.$/, "");
    super(
      name === "restricted_api_key"
        ? `Resend refused (${step}): the key read here can only send. The account's key, with full access, is the one that manages keys and domains.`
        : `Resend refused (${step}): ${said}.`,
    );
    this.step = step;
    this.status = status;
    this.apiCode = name || null;
  }
}

/** One call: {status, json}. A network failure throws, never "nothing there". */
async function call(key, method, path, body, { base = apiBase(), fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Resend did not answer (${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e}): nothing can be concluded.`);
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

/** Every element of a list Resend may serve in pages. */
async function listAll(key, path, step, opts) {
  const out = [];
  let after = null;
  for (let page = 0; page < 1000; page += 1) {
    const r = await call(key, "GET", `${path}?limit=${PAGE}${after ? `&after=${encodeURIComponent(after)}` : ""}`, undefined, opts);
    if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new ResendError(step, r.status, r.json);
    out.push(...r.json.data);
    if (!r.json.has_more || !r.json.data.length) return out;
    after = r.json.data[r.json.data.length - 1].id;
  }
  throw new Error(`Resend kept announcing more pages (${step}): the list was not read to its end.`);
}

/** The account's keys: {id, name, createdAt, lastUsedAt}, never a token. */
export async function listKeys(key, opts = {}) {
  return (await listAll(key, "/api-keys", "list keys", opts)).map((k) => ({ id: k.id, name: k.name, createdAt: k.created_at ?? null, lastUsedAt: k.last_used_at ?? null }));
}

/** A sending domain of the account: {id, name, status}, or null after a read that worked. */
export async function findDomain(key, name, opts = {}) {
  const wanted = String(name ?? "").toLowerCase().replace(/\.$/, "");
  const found = (await listAll(key, "/domains", "list domains", opts)).find((d) => String(d.name ?? "").toLowerCase() === wanted);
  return found ? { id: found.id, name: wanted, status: String(found.status ?? "unknown") } : null;
}

/**
 * A key that can only send (and only from `domainId`'s domain when one is given). Its value comes
 * back to the caller, who puts it where the project keeps it: never on a command line, never
 * printed. Read back in the account's list before it is said made.
 * @returns {Promise<{id: string, name: string, token: string}>}
 */
export async function createSendingKey(key, { name, domainId = null }, opts = {}) {
  const label = String(name ?? "").trim().slice(0, 50);
  if (!label) throw new Error("A project's key needs a name.");
  const r = await call(key, "POST", "/api-keys", { name: label, permission: "sending_access", ...(domainId ? { domain_id: domainId } : {}) }, opts);
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id || !r.json?.token) throw new ResendError("create a key", r.status, r.json);
  let listed;
  try {
    listed = (await listKeys(key, opts)).find((k) => k.id === r.json.id);
  } catch (e) {
    throw Object.assign(new Error(`Resend made the key ${r.json.id}, but it could not be read back (${e?.message ?? e}).`), { keyId: r.json.id });
  }
  if (!listed) throw Object.assign(new Error(`Resend answered with the key ${r.json.id}, but does not list it when read back.`), { keyId: r.json.id });
  return { id: r.json.id, name: listed.name ?? label, token: r.json.token };
}

/** Revoked, then read back gone. A key already gone is said so, once the list was read. */
export async function revokeKey(key, id, opts = {}) {
  const r = await call(key, "DELETE", `/api-keys/${encodeURIComponent(id)}`, undefined, opts);
  if (r.status !== 200 && r.status !== 204 && r.status !== 404) throw new ResendError("revoke a key", r.status, r.json);
  const still = (await listKeys(key, opts)).some((k) => k.id === id);
  if (still) throw new Error(`Resend still lists the key ${id} after revoking it: it is not revoked.`);
  return { revoked: true, ...(r.status === 404 ? { wasGone: true } : {}) };
}
