#!/usr/bin/env node
// test-brevo-domain.mjs - Recette of scripts/brevo-domain.mjs (3.4.13): Brevo's records published with
// their own types (the DKIM in two CNAMEs, `dkim_record` null), never a second DMARC record and never
// a stricter policy, nothing overwritten, the sender created through the API, the account's DKIM key
// found on its other domains, and never a key in the output. Against fake Brevo, Cloudflare and DNS
// APIs on the loopback: no network, no vault.
//
//   node scripts/tests/test-brevo-domain.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "brevo-domain.mjs");
const { bases, readKey, recordsOf, dmarcAtNone, EXIT } = await import(pathToFileURL(SCRIPT).href);
// Assembled at run time: the recette's keys are no keys, and must not read as ones.
const BREVO_KEY = ["recette", "brevo", "cle"].join("-");
const CF_KEY = ["recette", "cloudflare", "jeton"].join("-");
const ACCOUNT_DKIM = `k=rsa;p=${"MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ".repeat(3)}AB`;

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 500)})`}`);
}

let st;
const brevoRecords = (o = {}) => ({
  dkim_record: null,
  dkim1Record: { type: "CNAME", value: "b1.example-fr.dkim.brevo.com", host_name: "brevo1._domainkey", status: false },
  dkim2Record: { type: "CNAME", value: "b2.example-fr.dkim.brevo.com", host_name: "brevo2._domainkey", status: false },
  brevo_code: { type: "TXT", value: "brevo-code:0123456789abcdef", host_name: "@", status: false },
  dmarc_record: { type: "TXT", value: "v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com", host_name: "_dmarc", status: false },
  ...o,
});
const world = (o = {}) => {
  st = {
    brevoDomains: {},
    others: [{ domain_name: "ancien.fr", authenticated: true }],
    doh: { "mail._domainkey.ancien.fr": ACCOUNT_DKIM },
    zone: [],
    senders: [],
    authenticateAfter: 1,
    authenticateCalls: 0,
    dmarcRequired: true,
    sent: [],
    calls: [],
    ...o,
  };
};
let nextId = 1;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const body = raw ? JSON.parse(raw) : null;
    const u = new URL(req.url, "http://x");
    st.calls.push(`${req.method} ${u.pathname}${u.search}`);
    // DNS over HTTPS
    if (u.pathname === "/dns-query") {
      const value = st.doh[u.searchParams.get("name")];
      return send(200, { Status: 0, Answer: value ? [{ name: u.searchParams.get("name"), type: 16, data: `"${value}"` }] : [] });
    }
    // Cloudflare
    if (u.pathname.startsWith("/client/v4/")) {
      if (req.headers.authorization !== `Bearer ${CF_KEY}`) return send(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
      if (req.method === "GET" && u.pathname === "/client/v4/zones") return send(200, { success: true, result: u.searchParams.get("name") === "example.fr" ? [{ id: "z1", name: "example.fr" }] : [] });
      if (u.pathname === "/client/v4/zones/z1/dns_records") {
        if (req.method === "GET") {
          const type = u.searchParams.get("type");
          const name = u.searchParams.get("name");
          return send(200, { success: true, result: st.zone.filter((r) => (!type || r.type === type) && (!name || r.name === name)) });
        }
        if (req.method === "POST") {
          if (st.zone.some((r) => r.type === body.type && r.name === body.name && r.content === body.content)) return send(400, { success: false, errors: [{ code: 81057, message: "Record already exists." }] });
          st.zone.push({ id: `r${nextId++}`, ...body });
          return send(200, { success: true, result: body });
        }
      }
      return send(404, { success: false, errors: [{ code: 7003, message: "Could not route" }] });
    }
    // Brevo
    if (req.headers["api-key"] !== BREVO_KEY) return send(401, { code: "unauthorized", message: "Key not found" });
    const m = u.pathname.match(/^\/v3\/senders\/domains\/([^/]+)(\/authenticate)?$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const d = st.brevoDomains[name];
      if (!d) return send(404, { code: "document_not_found", message: "Domain does not exist" });
      if (m[2] && req.method === "PUT") {
        st.authenticateCalls += 1;
        if (st.dmarcRequired && !st.zone.some((r) => r.name === `_dmarc.${name}`)) return send(400, { code: "invalid_parameter", message: "DMARC record is missing" });
        if (st.authenticateCalls >= st.authenticateAfter) d.authenticated = true;
        return send(200, { domain_name: name, message: d.authenticated ? "Domain has been authenticated" : "Records not found" });
      }
      return send(200, { domain: name, verified: d.authenticated, authenticated: d.authenticated, dns_records: d.records });
    }
    if (u.pathname === "/v3/senders/domains") {
      if (req.method === "POST") {
        st.brevoDomains[body.name] = { authenticated: false, records: brevoRecords(st.suggested ?? {}) };
        return send(201, { id: 1, domain_name: body.name, message: "Domain added" });
      }
      return send(200, { domains: [...Object.entries(st.brevoDomains).map(([domain_name, d]) => ({ domain_name, authenticated: d.authenticated })), ...st.others] });
    }
    if (u.pathname === "/v3/senders") {
      if (req.method === "POST") {
        st.senders.push({ id: st.senders.length + 1, name: body.name, email: body.email, active: true });
        return send(201, { id: st.senders.length });
      }
      return send(200, { senders: st.senders });
    }
    if (u.pathname === "/v3/smtp/email" && req.method === "POST") {
      if (st.refuseSend) return send(400, { code: "invalid_parameter", message: st.refuseSend });
      st.sent.push(body);
      return send(201, { messageId: "<test@smtp-relay.brevo.com>" });
    }
    return send(404, { code: "not_found", message: "Not found" });
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const API = `http://127.0.0.1:${server.address().port}`;
function run(args, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, HYPERVIBE_BREVO_API: API, HYPERVIBE_CLOUDFLARE_API: API, HYPERVIBE_DOH: API, BREVO_API_KEY: BREVO_KEY, CLOUDFLARE_API_TOKEN: CF_KEY, ...env },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(out.trim().split("\n").pop());
      } catch {}
      ok({ code, out, err, json });
    });
  });
}
const keyless = (r) => ![BREVO_KEY, CF_KEY, ACCOUNT_DKIM.slice(8, 40)].some((k) => `${r.out}${r.err}`.includes(k));
const at = (name, type) => st.zone.filter((r) => r.name === name && (!type || r.type === type));

try {
  check("the real APIs unless a recette's loopback is named", bases({}).brevo === "https://api.brevo.com/v3" && bases({ HYPERVIBE_BREVO_API: "https://evil.example" }).brevo === "https://api.brevo.com/v3" && bases({ HYPERVIBE_CLOUDFLARE_API: "http://127.0.0.1:9" }).cloudflare === "http://127.0.0.1:9/client/v4");
  check("against the real APIs, a key from the environment is ignored: the vault alone", readKey("brevo", { BREVO_API_KEY: "x" }, bases({}), () => ({ status: 4, value: "" })).code === EXIT.NO_KEY && readKey("cloudflare", { CLOUDFLARE_API_TOKEN: "x" }, bases({}), () => ({ status: 2, value: "" })).code === EXIT.LOCKED);
  const recs = recordsOf("example.fr", brevoRecords());
  check("Brevo's records read with their own types, dkim_record null left out", recs.length === 4 && recs.filter((r) => r.type === "CNAME").length === 2 && !recs.some((r) => r.key === "dkim_record"), JSON.stringify(recs));
  check("each name written out in full (the root as the domain itself)", recs.some((r) => r.name === "brevo1._domainkey.example.fr") && recs.some((r) => r.key === "brevo_code" && r.name === "example.fr") && recs.some((r) => r.name === "_dmarc.example.fr"));
  check("a DMARC record this script writes stays at p=none", dmarcAtNone("v=DMARC1; p=quarantine; rua=mailto:x@y") === "v=DMARC1; p=none; rua=mailto:x@y" && dmarcAtNone("v=DMARC1; p=reject") === "v=DMARC1; p=none");

  world();
  let r = await run(["records", "example.fr"]);
  check("a domain Brevo does not have yet: created, then read", r.code === EXIT.OK && r.json?.created === true && r.json.records?.length === 4 && st.calls.some((c) => c === "POST /v3/senders/domains"), r.out);

  world({ suggested: { dkim_record: { type: "TXT", value: ACCOUNT_DKIM, host_name: "mail._domainkey" } } });
  r = await run(["records", "example.fr"]);
  check("an older account's dkim_record is kept, and its key is not printed", r.code === EXIT.OK && r.json?.records?.some((x) => x.key === "dkim_record" && /not shown/.test(x.value)) && keyless(r), r.out);

  world({ suggested: { dmarc_record: { type: "TXT", value: "v=DMARC1; p=quarantine", host_name: "_dmarc" } } });
  r = await run(["publish", "example.fr"]);
  check("an empty zone: the four records written, each with its type", r.code === EXIT.OK && at("brevo1._domainkey.example.fr", "CNAME").length === 1 && at("brevo2._domainkey.example.fr", "CNAME").length === 1 && at("example.fr", "TXT").length === 1 && at("_dmarc.example.fr", "TXT").length === 1, r.out);
  check("... never proxied", st.zone.every((x) => x.proxied === false));
  check("... the DKIM CNAMEs point where Brevo said, never at a name built here", at("brevo1._domainkey.example.fr")[0]?.content === "b1.example-fr.dkim.brevo.com");
  check("... and the DMARC record is written at p=none, even when Brevo suggests a stricter policy", /p=none/.test(at("_dmarc.example.fr")[0]?.content ?? "") && !/quarantine/.test(at("_dmarc.example.fr")[0]?.content ?? ""));
  const again = await run(["publish", "example.fr"]);
  check("run again: everything kept, nothing doubled", again.code === EXIT.OK && again.json?.written?.length === 0 && st.zone.length === 4, again.out);

  world({ zone: [{ id: "x", type: "TXT", name: "_dmarc.example.fr", content: "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.fr" }] });
  r = await run(["publish", "example.fr"]);
  check("a DMARC record already there: kept as it is, no second one, its policy untouched", r.code === EXIT.OK && at("_dmarc.example.fr").length === 1 && /quarantine/.test(at("_dmarc.example.fr")[0].content) && r.json?.kept?.some((k) => k.key === "dmarc_record"), r.out);

  world({ zone: [{ id: "x", type: "CNAME", name: "brevo1._domainkey.example.fr", content: "ailleurs.example.net" }] });
  r = await run(["publish", "example.fr"]);
  check("another value under a DKIM name: said, never overwritten, exit 1", r.code === EXIT.FAILED && r.json?.conflicts?.some((c) => c.name === "brevo1._domainkey.example.fr") && at("brevo1._domainkey.example.fr")[0].content === "ailleurs.example.net" && !st.calls.some((c) => c.startsWith("PUT ") || c.startsWith("PATCH ") || c.startsWith("DELETE ")), r.out);

  world({ zone: [{ id: "x", type: "TXT", name: "brevo2._domainkey.example.fr", content: "v=DKIM1; p=autre" }] });
  r = await run(["publish", "example.fr"]);
  check("a CNAME where a TXT already stands: said, not forced", r.code === EXIT.FAILED && r.json?.conflicts?.some((c) => c.name === "brevo2._domainkey.example.fr") && at("brevo2._domainkey.example.fr", "CNAME").length === 0, r.out);

  world({ authenticateAfter: 2 });
  await run(["records", "example.fr"]);
  r = await run(["authenticate", "example.fr"]);
  check("no DMARC record: Brevo's refusal is reported, the domain is not said authenticated", r.code === EXIT.FAILED && r.json?.authenticated === false && /DMARC/.test(r.json?.error ?? ""), r.out);
  await run(["publish", "example.fr"]);
  st.authenticateCalls = 0;
  r = await run(["authenticate", "example.fr"]);
  check("the records published: authenticated, read back at Brevo, at the second attempt", r.code === EXIT.OK && r.json?.authenticated === true && r.json.attempts === 2, r.out);

  world();
  r = await run(["sender", "contact@example.fr", "--name", "Example"]);
  check("a sender the account does not have: created through the API, its state read back", r.code === EXIT.OK && r.json?.created === true && r.json.active === true && st.senders.length === 1, r.out);
  r = await run(["sender", "contact@example.fr"]);
  check("... and never created twice", r.code === EXIT.OK && r.json?.created === false && st.senders.length === 1, r.out);

  r = await run(["test", "example.fr", "--from", "contact@example.fr", "--to", "moi@example.net"]);
  check("a test message: sent from the sender, its subject carries the code to find it", r.code === EXIT.OK && st.sent.length === 1 && st.sent[0].sender.email === "contact@example.fr" && st.sent[0].subject.includes(r.json?.code ?? "?"), r.out);
  world({ refuseSend: "sender not valid" });
  r = await run(["test", "example.fr", "--from", "contact@example.fr", "--to", "moi@example.net"]);
  check("a refused test message: Brevo's words, exit 1", r.code === EXIT.FAILED && /sender not valid/.test(r.json?.error ?? ""), r.out);

  world();
  r = await run(["account-key", "example.fr"]);
  check("the account's DKIM key found on another authenticated domain, not printed", r.code === EXIT.OK && r.json?.found === true && r.json.from === "ancien.fr" && r.json.written === false && keyless(r), r.out);
  r = await run(["account-key", "example.fr", "--publish"]);
  check("... published as mail._domainkey, still not printed", r.code === EXIT.OK && r.json?.written === true && at("mail._domainkey.example.fr", "TXT")[0]?.content === ACCOUNT_DKIM && keyless(r), r.out);
  world({ zone: [{ id: "x", type: "TXT", name: "mail._domainkey.example.fr", content: "k=rsa;p=autre" }] });
  r = await run(["account-key", "example.fr", "--publish"]);
  check("another key already under mail._domainkey: refused, nothing overwritten", r.code === EXIT.FAILED && at("mail._domainkey.example.fr").length === 1 && at("mail._domainkey.example.fr")[0].content === "k=rsa;p=autre", r.out);
  world({ doh: {} });
  r = await run(["account-key", "example.fr", "--publish"]);
  check("no other domain shows the key: said, nothing written", r.code === EXIT.OK && r.json?.found === false && st.zone.length === 0, r.out);

  r = await run(["records", "pas un domaine"]);
  check("a bad domain: usage, exit 5", r.code === EXIT.USAGE);
  r = await run(["publish", "example.fr"], { BREVO_API_KEY: "" });
  check("no Brevo key: said, exit 4", r.code === EXIT.NO_KEY);
} finally {
  server.close();
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.log(`${failures} ECHEC(S)`);
  process.exitCode = 1;
}
