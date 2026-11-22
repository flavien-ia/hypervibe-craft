// fake-brevo.mjs - The part of Brevo's API v3 that scripts/email/providers/brevo/ uses, on the
// loopback, for the email recettes (HYPERVIBE_BREVO_API). It keeps what the real API keeps and
// answers the way it answers where it matters (documentation read on 14/10/2026):
//   - the key travels in an `api-key` header; a key the recette does not know is refused (401
//     unauthorized, "Key not found"), and so is a known key called from an address the account does
//     not recognise (`state.ipRefused`: Brevo closes its list of addresses on its own);
//   - a sending domain is read by its NAME, its records in an object of named entries
//     (`dns_records`: brevo_code, dkim_record, dmarc_record in the documentation; `dkimPair` gives
//     the two DKIM entries some accounts receive instead), each with host_name, type, value, status;
//     host names come as Brevo writes them ("" for the apex, "mail._domainkey." with its dot);
//   - a domain is created once (a second creation is refused), authenticated only once its records
//     are found (`recordsOk: false` refuses; `authenticateAfter: n` refuses the n first tries, the
//     zone still publishing), and only an authenticated domain's senders are valid;
//   - since 16/10/2026 (the corrective 3.4.13), `dkimPair` also carries `dkim_record: null`, as the
//     real API now answers; `dmarcPolicy` is the policy Brevo's DMARC suggests (none by default);
//     `emptyEntry` adds an entry without a value;
//   - a transactional message (POST /smtp/email) leaves only from an active sender: kept in
//     `state.sent`, answered with a messageId;
//   - the account tells its plan and what is left of it; `state.busy` answers 429;
//   - since 22/11/2026, a project's sending application, as the real API answered on the account
//     tried that day: POST /v3/app-store/apps makes one (names NOT unique, 48 characters at most),
//     GET /v3/app-store/apps[?type=m2m] and GET /v3/app-store/apps/{id} give every secret in clear,
//     DELETE answers 204 then 404, POST .../secret/rotate refuses the old secret at once;
//     POST /realms/partner/oauth/token (a form, outside /v3) gives a token of an hour for the scope
//     asked (every scope of the application when none is), and a known token sends by
//     `Authorization: Bearer` (a token of an application since deleted keeps working: Brevo's own
//     limit). `state.appStore` = {status, body} answers the applications' route with that instead
//     (the route changed); `state.appShape` = "no-secret" | "wide-scope" bends a creation's answer;
//     `state.tokenRefused` refuses every token; `state.expireTokens()` makes every token stale;
//     `state.tokenLife` is the expires_in a token is given with; `state.bearerRefused` refuses every
//     token at the send.
//
//   const b = await startFakeBrevo({ domains: [{ name: "monsite.fr", authenticated: true }] });
//   b.url            -> HYPERVIBE_BREVO_API
//   b.token          -> the account's key
//   b.state          -> {domains: Map<name, domain>, senders: Map<email, sender>, calls, busy, ipRefused}
//   await b.close()

import { createServer } from "node:http";

const recordsOf = (name, dkimPair, { dmarcPolicy = "none", emptyEntry = false } = {}) => ({
  brevo_code: { host_name: "", type: "TXT", value: `brevo-code:${name.length}e760f020e6d438149540cfc757e99b5a`, status: false },
  ...(dkimPair
    ? {
        dkim_record: null,
        dkim1Record: { host_name: "brevo1._domainkey", type: "CNAME", value: "b1.monsite-fr.dkim.brevo.com", status: false },
        dkim2Record: { host_name: "brevo2._domainkey", type: "CNAME", value: "b2.monsite-fr.dkim.brevo.com", status: false },
      }
    : { dkim_record: { host_name: "mail._domainkey.", type: "TXT", value: "k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDeMVIzrCa3T14JsNY0IRv5", status: false } }),
  dmarc_record: { host_name: "_dmarc", type: "TXT", value: `v=DMARC1; p=${dmarcPolicy}; rua=mailto:rua@dmarc.brevo.com`, status: false },
  ...(emptyEntry ? { spf_record: { host_name: "", type: "TXT", value: "", status: false } } : {}),
});

export async function startFakeBrevo({ token = "xkeysib-cle-du-compte-de-recette", domains = [], senders = [], account = { email: "compte@recette.test", companyName: "Recette", plan: [{ type: "free", credits: 287, creditsType: "sendLimit" }] }, dkimPair = false } = {}) {
  let n = 0;
  const state = { domains: new Map(), senders: new Map(), calls: [], sent: [], busy: false, ipRefused: false, notFoundOnRead: null, account, sentToday: 12, apps: new Map(), tokens: new Map(), appStore: null, appShape: null, tokenRefused: false, tokenCalls: [], tokenLife: 3600, bearerRefused: false };
  const hex = (len) => Array.from({ length: len }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  state.expireTokens = () => {
    for (const t of state.tokens.values()) t.expiresAt = 0;
  };
  const addDomain = (d) => {
    const name = d.name.toLowerCase();
    const authenticated = d.authenticated === true;
    const dns = recordsOf(name, d.dkimPair ?? dkimPair, { dmarcPolicy: d.dmarcPolicy, emptyEntry: d.emptyEntry });
    // hostAt: the code's host written "@", as Brevo's creation answer shows it, instead of "".
    if (d.hostAt) dns.brevo_code.host_name = "@";
    // rootRelative: the names written against the registered domain (the last two labels here), as
    // a sender may do for a subdomain (lot 8, step 8l): `brevo1._domainkey.lettre` for
    // lettre.monsite.fr, `lettre` for the code at the subdomain itself.
    if (d.rootRelative) {
      const sub = name.split(".").slice(0, -2).join(".");
      for (const r of Object.values(dns)) if (r) r.host_name = r.host_name ? `${r.host_name.replace(/\.$/, "")}.${sub}` : sub;
    }
    if (authenticated) for (const r of Object.values(dns)) if (r) r.status = true;
    state.domains.set(name, { id: d.id ?? (n += 1), name, authenticated, verified: authenticated, recordsOk: d.recordsOk ?? true, failsLeft: d.authenticateAfter ?? 0, dns_records: dns });
  };
  for (const d of domains) addDomain(d);
  for (const s of senders) state.senders.set(s.email, { id: (n += 1), name: s.name ?? "Recette", email: s.email, active: s.active ?? true, ips: [] });

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(obj === undefined ? "" : JSON.stringify(obj));
      };
      const error = (status, code, message) => send(status, { code, message });

      // ── A token for an application (outside /v3, a form) ──
      if (url.pathname === "/realms/partner/oauth/token" && req.method === "POST") {
        const form = new URLSearchParams(raw);
        state.tokenCalls.push({ clientId: form.get("client_id"), scope: form.get("scope"), grant: form.get("grant_type") });
        if (state.busy) return error(429, "too_many_requests", "The expected rate limit is exceeded.");
        const app = [...state.apps.values()].find((a) => a.client_id === form.get("client_id"));
        if (state.tokenRefused || form.get("grant_type") !== "client_credentials" || !app || app.client_secret !== form.get("client_secret")) {
          return send(401, { error: "invalid_client", error_description: "Client authentication failed" });
        }
        const asked = form.get("scope") ? form.get("scope").split(" ") : app.scopes;
        if (asked.some((s) => !app.scopes.includes(s))) return send(400, { error: "invalid_scope", error_description: "scope not granted" });
        const access = `tok-${hex(24)}`;
        state.tokens.set(access, { clientId: app.client_id, scope: asked, expiresAt: Date.now() + 3600_000 });
        return send(200, { access_token: access, expires_in: state.tokenLife, scope: asked.join(" "), token_type: "Bearer" });
      }

      const path = url.pathname.replace(/^\/v3/, "");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = "unreadable";
      }
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;
      state.calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, key: req.headers["api-key"] ? "..." : "", bearer: bearer ? "..." : "" });

      if (state.busy) return error(429, "too_many_requests", "The expected rate limit is exceeded.");
      // A token of an application: it sends, and nothing else (403 "required scope not present").
      if (bearer && !req.headers["api-key"]) {
        const t = state.tokens.get(bearer);
        if (state.bearerRefused || !t || t.expiresAt <= Date.now()) return error(401, "unauthorized", "token is invalid or expired");
        if (!(path === "/smtp/email" && req.method === "POST")) return error(403, "permission_denied", "required scope not present");
        if (!t.scope.includes("transactional.email:write")) return error(403, "permission_denied", "required scope not present");
      } else if (req.headers["api-key"] !== token) return error(401, "unauthorized", "Key not found");
      if (state.ipRefused) return error(401, "unauthorized", "We have detected you are using an unrecognised IP address 203.0.113.9. If you performed this action make sure to add the new IP address in this link: https://app.brevo.com/security/authorised_ips");
      if (body === "unreadable") return error(400, "bad_request", "Invalid JSON");

      if (path === "/account" && req.method === "GET") return send(200, { ...state.account, firstName: "Recette", lastName: "Compte" });
      // What was sent over a range of days (the quotas read today's).
      if (path === "/smtp/statistics/aggregatedReport" && req.method === "GET") {
        if (!url.searchParams.get("startDate") || !url.searchParams.get("endDate")) return error(400, "missing_parameter", "startDate and endDate are required");
        return send(200, { range: `${url.searchParams.get("startDate")}|${url.searchParams.get("endDate")}`, requests: state.sentToday, delivered: state.sentToday });
      }

      // ── A project's sending application (the route Brevo's CLI calls) ──
      if (path === "/app-store/apps" || path.startsWith("/app-store/apps/")) {
        if (state.appStore) return send(state.appStore.status, state.appStore.body);
        const listed = (a) => ({ app_id: a.app_id, client_id: a.client_id, client_secret: a.client_secret, domain: "", grant_types: ["client_credentials"], name: a.name, owner_user_id: 7, public: false, redirect_uris: [], scopes: a.scopes, logo_uri: "", distribution_type: "private", version: "1.0.0" });
        if (path === "/app-store/apps" && req.method === "POST") {
          const name = String(body?.name ?? "");
          if (!name || name.length > 48 || !/^[\p{L}\p{N} ._-]+$/u.test(name)) return send(400, { error: "please provide a valid app name", code: "invalid_parameter" });
          if (body?.app_type !== "oauth.m2m" || body?.auth?.type !== "m2m" || !Array.isArray(body?.auth?.scopes)) return send(400, { error: "invalid app", code: "invalid_parameter" });
          const scopes = state.appShape === "wide-scope" ? [...body.auth.scopes, "contacts:read"] : body.auth.scopes;
          const a = { app_id: `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`, name, client_id: hex(32), client_secret: hex(64), scopes };
          state.apps.set(a.app_id, a);
          return send(201, { app_id: a.app_id, name, version: "1.0.0", distribution_type: "private", auth: { client_id: a.client_id, ...(state.appShape === "no-secret" ? {} : { client_secret: a.client_secret }), scopes } });
        }
        if (path === "/app-store/apps" && req.method === "GET") return send(200, [...state.apps.values()].map(listed));
        const am = path.match(/^\/app-store\/apps\/([^/]+)(\/secret\/rotate)?$/);
        if (am) {
          const a = state.apps.get(decodeURIComponent(am[1]));
          if (!a) return send(404, { error: "id not found", code: "not_found" });
          if (am[2] && req.method === "POST") {
            a.client_secret = hex(64);
            return send(200, { client_id: a.client_id, client_secret: a.client_secret });
          }
          if (!am[2] && req.method === "GET") return send(200, listed(a));
          if (!am[2] && req.method === "DELETE") {
            state.apps.delete(a.app_id);
            return send(204);
          }
        }
        return send(404, { error: "not found", code: "not_found" });
      }

      // ── Sending domains ──
      if (path === "/senders/domains" && req.method === "GET") {
        return send(200, { domains: [...state.domains.values()].map((d) => ({ id: d.id, domain_name: d.name, authenticated: d.authenticated, verified: d.verified, ip: null })) });
      }
      if (path === "/senders/domains" && req.method === "POST") {
        const name = String(body?.name ?? "").toLowerCase();
        if (!name) return error(400, "missing_parameter", "name is missing");
        if (state.domains.has(name)) return error(400, "duplicate_parameter", "Domain already exists");
        addDomain({ name });
        const d = state.domains.get(name);
        return send(201, { id: d.id, domain_name: name, message: "Domain added successfully. To authenticate it, add following DNS records", dns_records: d.dns_records });
      }
      const dm = path.match(/^\/senders\/domains\/([^/]+)(\/authenticate)?$/);
      if (dm) {
        const d = state.domains.get(decodeURIComponent(dm[1]).toLowerCase());
        // state.notFoundOnRead: a domain the list shows, whose own read answers 404 all the same.
        if (!d || (!dm[2] && state.notFoundOnRead === d.name)) return error(404, "document_not_found", "Domain does not exist");
        if (dm[2] && req.method === "PUT") {
          if (!d.recordsOk) return error(400, "invalid_parameter", "Unable to authenticate the domain: records not found");
          if (d.failsLeft > 0) {
            d.failsLeft -= 1;
            return error(400, "invalid_parameter", "Unable to authenticate the domain: records not found");
          }
          d.authenticated = true;
          d.verified = true;
          for (const r of Object.values(d.dns_records)) if (r) r.status = true;
          return send(200, { domain_name: d.name, message: "Domain has been authenticated successfully." });
        }
        if (!dm[2] && req.method === "GET") return send(200, { domain: d.name, verified: d.verified, authenticated: d.authenticated, dns_records: d.dns_records });
        if (!dm[2] && req.method === "DELETE") {
          state.domains.delete(d.name);
          return send(204);
        }
      }

      // ── Senders ──
      if (path === "/senders" && req.method === "GET") return send(200, { senders: [...state.senders.values()] });
      if (path === "/senders" && req.method === "POST") {
        const email = String(body?.email ?? "").toLowerCase();
        if (!email || !body?.name) return error(400, "missing_parameter", "name and email are required");
        if (state.senders.has(email)) return error(400, "duplicate_parameter", "Sender already exists");
        const domain = state.domains.get(email.split("@")[1] ?? "");
        state.senders.set(email, { id: (n += 1), name: body.name, email, active: Boolean(domain?.authenticated), ips: [] });
        return send(201, { id: n, spfError: false, dkimError: false });
      }

      // ── A transactional message: only from an active sender ──
      if (path === "/smtp/email" && req.method === "POST") {
        const from = String(body?.sender?.email ?? "").toLowerCase();
        const to = (body?.to ?? []).map((t) => t?.email).filter(Boolean);
        if (!from || !to.length || !body?.subject || !(body?.textContent || body?.htmlContent)) return error(400, "missing_parameter", "sender, to, subject and content are required");
        if (!state.senders.get(from)?.active) return error(400, "invalid_parameter", "Sender is not valid");
        state.sent.push({ from, to, subject: body.subject, text: body.textContent ?? null });
        return send(201, { messageId: `<${Date.now()}.${state.sent.length}@smtp-relay.mailin.fr>` });
      }
      return error(404, "not_found", "Not found");
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    state,
    close: () => new Promise((ok) => server.close(ok)),
  };
}
