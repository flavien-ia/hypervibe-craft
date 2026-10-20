#!/usr/bin/env node
// test-dns-survey.mjs - Recette of scripts/dns-survey.mjs, the survey /add-domain runs before it
// hands a domain to its Cloudflare zone (3.4.11): the mail a domain receives is read, carried into
// the zone and read back before the switch, and a read that fails is never taken for "nothing
// there". Against a fake public resolver and a fake Cloudflare API, both on the loopback: no
// network, no vault.
//
//   node scripts/tests/test-dns-survey.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "dns-survey.mjs");
const { txtText, keyOf, asCloudflare, readKey, apiBase, resolvers, EXIT } = await import(pathToFileURL(SCRIPT).href);
const KEY = "jeton-cloudflare-de-recette";

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 500)})`}`);
}

// ── The world: a domain's current DNS, and its Cloudflare zone ─────────────────────
const TYPE = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const LONG_KEY = `v=DKIM1; k=rsa; p=${"A".repeat(300)}`;
let dns;
let zone;
let cfState;
function world({ records = {}, wildcard = null, servfail = [], zones = [{ id: "z1", name: "example.fr" }], refuse = {}, exists = [] } = {}) {
  dns = { records, wildcard, servfail };
  zone = [];
  cfState = { zones, refuse, exists, posts: [], auth: [] };
}
const GOOGLE = {
  "example.fr|MX": [[15, "1 aspmx.l.google.com."], [15, "5 alt1.aspmx.l.google.com."], [15, "5 alt2.aspmx.l.google.com."], [15, "10 alt3.aspmx.l.google.com."], [15, "10 alt4.aspmx.l.google.com."]],
  "example.fr|TXT": [[16, '"v=spf1 include:_spf.google.com ~all"'], [16, '"google-site-verification=abc123"']],
  "_dmarc.example.fr|TXT": [[16, '"v=DMARC1; p=none; rua=mailto:dmarc@example.fr"']],
  "google._domainkey.example.fr|TXT": [[16, `"${LONG_KEY.slice(0, 255)}" "${LONG_KEY.slice(255)}"`]],
  "blog.example.fr|A": [[5, "example.ghost.io."]],
  "autodiscover.example.fr|A": [[5, "autodiscover.outlook.com."]],
};

const doh = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const name = String(u.searchParams.get("name")).toLowerCase().replace(/\.$/, "");
  const type = u.searchParams.get("type");
  const send = (body) => {
    res.writeHead(200, { "content-type": "application/dns-json" });
    res.end(JSON.stringify(body));
  };
  if (dns.servfail.includes(`${name}|${type}`)) return send({ Status: 2 });
  const own = dns.records[`${name}|${type}`];
  if (own) return send({ Status: 0, Answer: own.map(([t, data]) => ({ name: `${name}.`, type: t, TTL: 300, data })) });
  // A CNAME answers every type at its name.
  const cname = dns.records[`${name}|A`]?.find(([t]) => t === 5);
  if (cname && type !== "A") return send({ Status: 0, Answer: [{ name: `${name}.`, type: 5, TTL: 300, data: cname[1] }] });
  if (dns.wildcard && name.endsWith(".example.fr") && (type === "A" || type === "AAAA")) {
    return send({ Status: 0, Answer: type === "A" ? [{ name: `${name}.`, type: 1, TTL: 300, data: dns.wildcard }] : [] });
  }
  return send({ Status: 3 });
});
const cf = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    cfState.auth.push(req.headers.authorization ?? "");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/client/v4/zones") return send(200, { success: true, result: cfState.zones.filter((z) => z.name === u.searchParams.get("name")) });
    const list = /^\/client\/v4\/zones\/z1\/dns_records$/.exec(u.pathname);
    if (list && req.method === "GET") {
      const per = Number(u.searchParams.get("per_page"));
      const page = Number(u.searchParams.get("page"));
      return send(200, { success: true, result: zone.slice((page - 1) * per, page * per), result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(zone.length / per)) } });
    }
    if (list && req.method === "POST") {
      const body = JSON.parse(raw);
      cfState.posts.push(body);
      if (cfState.refuse[body.name]) return send(400, { success: false, errors: [{ code: 9000, message: cfState.refuse[body.name] }] });
      if (cfState.exists.includes(body.name)) return send(400, { success: false, errors: [{ code: 81058, message: "An identical record already exists." }] });
      zone.push({ id: `r${zone.length + 1}`, ...body });
      return send(200, { success: true, result: { id: `r${zone.length}`, ...body } });
    }
    return send(404, { success: false, errors: [{ code: 7003, message: "Could not route" }] });
  });
});
await new Promise((ok) => doh.listen(0, "127.0.0.1", ok));
await new Promise((ok) => cf.listen(0, "127.0.0.1", ok));
const DOH = `http://127.0.0.1:${doh.address().port}`;
const API = `http://127.0.0.1:${cf.address().port}`;

function run(args, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, HYPERVIBE_DOH_URL: DOH, HYPERVIBE_CLOUDFLARE_API: API, CLOUDFLARE_API_TOKEN: KEY, ...env },
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
const noKey = (r) => !`${r.out}${r.err}`.includes(KEY);
const has = (list, type, name, pred = () => true) => (list ?? []).some((x) => x.type === type && x.name === name && pred(x));

try {
  // ── The pieces ──────────────────────────────────────────────────────────────────────
  check("a TXT in several quoted strings is one text (a long DKIM key)", txtText('"ab" "cd"') === "abcd" && txtText("v=spf1 -all") === "v=spf1 -all" && txtText('"a\\"b"') === 'a"b');
  check("a record compares the same whatever the trailing dot, the case or the quotes", keyOf({ type: "MX", name: "Example.fr.", priority: 10, content: "MX.Example.fr." }) === keyOf({ type: "MX", name: "example.fr", priority: 10, content: "mx.example.fr" }) && keyOf({ type: "TXT", name: "example.fr", content: '"v=spf1 -all"' }) === keyOf({ type: "TXT", name: "example.fr", content: "v=spf1 -all" }));
  const long = asCloudflare({ type: "TXT", name: "google._domainkey.example.fr", content: LONG_KEY });
  check("a TXT longer than 255 characters goes to Cloudflare in quoted strings of 255 at most", (long.content.match(/"[^"]*"/g) ?? []).length === 2 && (long.content.match(/"[^"]*"/g) ?? []).every((s) => s.length <= 257) && txtText(long.content) === LONG_KEY);
  check("a CNAME carried is never proxied, an MX keeps its priority", asCloudflare({ type: "CNAME", name: "blog.example.fr", content: "x.ghost.io" }).proxied === false && asCloudflare({ type: "MX", name: "example.fr", priority: 5, content: "mx" }).priority === 5);
  check("public DNS and Cloudflare are the real ones unless a recette's loopback is named", apiBase({}) === "https://api.cloudflare.com/client/v4" && apiBase({ HYPERVIBE_CLOUDFLARE_API: "https://evil.example" }) === "https://api.cloudflare.com/client/v4" && resolvers({ HYPERVIBE_DOH_URL: "https://evil.example" })[0] === "https://dns.google/resolve");
  {
    const asked = [];
    const vault = (r) => () => {
      asked.push(1);
      return r;
    };
    check("against Cloudflare, a key from the environment is ignored: the vault alone", readKey({ CLOUDFLARE_API_TOKEN: "x" }, "https://api.cloudflare.com/client/v4", vault({ status: 4, value: "" })).code === EXIT.NO_KEY && asked.length === 1);
    check("... a locked vault: exit 3, and a key in the vault is read", readKey({}, "https://api.cloudflare.com/client/v4", vault({ status: 2 })).code === EXIT.LOCKED && readKey({}, "https://api.cloudflare.com/client/v4", vault({ status: 0, value: "k" })).key === "k");
  }

  // ── A domain on Google Workspace, its zone just created (empty) ─────────────────────
  world({ records: { ...GOOGLE } });
  let r = await run(["example.fr"]);
  check("the survey alone: exit 2, the zone lacks the mail, nothing written", r.code === EXIT.MISSING && r.json?.receivesMail === true && cfState.posts.length === 0, r.out + r.err);
  const m = r.json?.missing ?? [];
  check("... the five MX, the SPF and the site verification, the DMARC, the DKIM key", m.filter((x) => x.type === "MX").length === 5 && has(m, "TXT", "example.fr", (x) => /^v=spf1/.test(x.content)) && has(m, "TXT", "example.fr", (x) => /google-site-verification/.test(x.content)) && has(m, "TXT", "_dmarc.example.fr") && has(m, "TXT", "google._domainkey.example.fr", (x) => x.content === LONG_KEY), JSON.stringify(m).slice(0, 300));
  check("... the blog's CNAME and the mail clients' autodiscover too, www never", has(m, "CNAME", "blog.example.fr") && has(m, "CNAME", "autodiscover.example.fr") && !m.some((x) => x.name === "www.example.fr"));
  check("... the DKIM selector found is named, no unknown key suspected", JSON.stringify(r.json?.dkimFound) === '["google"]' && r.json.dkimUnknown === false);
  check("... and no key printed", noKey(r));

  r = await run(["example.fr", "--copy"]);
  check("--copy: everything written, read back, exit 0", r.code === EXIT.OK && r.json?.ok === true && (r.json.missing ?? []).length === 0 && (r.json.copied ?? []).length === m.length && (r.json.failed ?? []).length === 0, r.out + r.err);
  check("... the MX with their priorities", [1, 5, 5, 10, 10].every((p, i) => zone.filter((x) => x.type === "MX").map((x) => x.priority).sort((a, b) => a - b)[i] === p));
  check("... the long DKIM key in two strings, the CNAME not proxied", zone.some((x) => x.name === "google._domainkey.example.fr" && (x.content.match(/"[^"]*"/g) ?? []).length === 2) && zone.find((x) => x.name === "blog.example.fr")?.proxied === false);
  check("... every call carried the key in its header, and none printed it", cfState.auth.every((a) => a === `Bearer ${KEY}`) && noKey(r));
  r = await run(["example.fr"]);
  check("run again: nothing lacking, exit 0", r.code === EXIT.OK && (r.json?.missing ?? []).length === 0, r.out);

  // ── What stops the switch ──────────────────────────────────────────────────────────
  world({ records: { ...GOOGLE }, servfail: ["_dmarc.example.fr|TXT"] });
  r = await run(["example.fr", "--copy"]);
  check("a name that could not be read: exit 1, nothing written, the name said", r.code === EXIT.UNREADABLE && cfState.posts.length === 0 && (r.json?.unread ?? []).includes("TXT _dmarc.example.fr"), r.out);

  world({ records: { ...GOOGLE }, refuse: { "_dmarc.example.fr": "Invalid TXT content" } });
  r = await run(["example.fr", "--copy"]);
  check("a write Cloudflare refuses: exit 2, its words said, the others written", r.code === EXIT.MISSING && (r.json?.failed ?? []).some((f) => f.record.name === "_dmarc.example.fr" && /Invalid TXT/.test(f.error)) && has(r.json?.missing, "TXT", "_dmarc.example.fr") && zone.filter((x) => x.type === "MX").length === 5, r.out);

  world({ records: { ...GOOGLE }, exists: ["_dmarc.example.fr"] });
  r = await run(["example.fr", "--copy"]);
  check("a record Cloudflare says already exists is not a failure, the read-back decides", (r.json?.failed ?? []).length === 0 && has(r.json?.missing, "TXT", "_dmarc.example.fr") && r.code === EXIT.MISSING, r.out);

  world({ records: { ...GOOGLE }, zones: [] });
  r = await run(["example.fr", "--copy"]);
  check("no zone of that name: exit 1, said, nothing written", r.code === EXIT.UNREADABLE && /No Cloudflare zone/.test(r.json?.error ?? "") && cfState.posts.length === 0, r.out);
  world({ records: { ...GOOGLE }, zones: [{ id: "z1", name: "example.fr" }, { id: "z2", name: "example.fr" }] });
  r = await run(["example.fr", "--copy"]);
  check("two zones of that name (two accounts): exit 1, never a guess", r.code === EXIT.UNREADABLE && /Several Cloudflare zones/.test(r.json?.error ?? "") && cfState.posts.length === 0, r.out);
  world({ records: { ...GOOGLE } });
  r = await run(["example.fr"], { CLOUDFLARE_API_TOKEN: "une-autre-cle" });
  check("a key Cloudflare refuses: exit 1, said", r.code === EXIT.UNREADABLE && /Authentication error/.test(r.json?.error ?? ""), r.out);

  // ── The domains that receive nothing, or answer everything ──────────────────────────
  world({ records: { "example.fr|MX": [[15, "0 ."]] } });
  r = await run(["example.fr", "--copy"]);
  check("a null MX (no mail accepted): not a mail server, nothing to carry, exit 0", r.code === EXIT.OK && r.json?.receivesMail === false && cfState.posts.length === 0, r.out);
  world({ records: { "example.fr|TXT": [[16, '"v=spf1 include:spf.brevo.com ~all"']] } });
  r = await run(["example.fr"]);
  check("a domain that sends (SPF) with no DKIM key under a known selector: dkimUnknown", r.json?.dkimUnknown === true && r.json.receivesMail === false, r.out);
  world({ records: { "shop.example.fr|A": [[5, "shops.myshopify.com."]] }, wildcard: "185.0.0.1" });
  r = await run(["example.fr"]);
  const names = r.json?.found?.names ?? [];
  check("a wildcard (registrar parking): said, the names it answers not carried, a name of its own kept", r.json?.wildcard === true && names.length === 1 && names[0].name === "shop.example.fr", JSON.stringify(names));

  // ── /add-domain runs it before the switch, and waits for it ───────────────────────
  {
    const { readFileSync } = await import("node:fs");
    const skill = readFileSync(join(HERE, "..", "..", "skills", "add-domain", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    const step6 = skill.search(/^## (?:Step|Étape) 6\b/m);
    const survey = skill.indexOf('node "$SURVEY" <domain>');
    const copy = skill.indexOf('node "$SURVEY" <domain> --copy');
    check("/add-domain surveys the domain, and copies, before its Step 6 (the switch)", step6 > 0 && survey > 0 && survey < step6 && copy > survey && copy < step6, `${survey} ${copy} ${step6}`);
    check("... and its Step 6 waits for an empty `missing`, or the user's explicit word", /\*\*(?:Never run Step 6 while `missing` is not empty|Ne jamais lancer l'Étape 6 tant que `missing` n'est pas vide)\*\*/.test(skill) && /\*\*(?:Only once Step 5\.d says the zone lacks nothing|Seulement une fois que l'Étape 5\.d dit qu'il ne manque rien à la zone)\*\*/.test(skill));
  }

  // ── What is never asked ───────────────────────────────────────────────────────────
  for (const [label, args] of [
    ["a domain with www and its scheme", ["https://www.example.fr"]],
    ["a domain in capitals", ["Example.FR"]],
    ["an option it does not know", ["example.fr", "--force"]],
  ]) {
    world({ records: { ...GOOGLE } });
    r = await run(args);
    check(`${label}: exit 5, nothing asked at Cloudflare`, r.code === EXIT.USAGE && cfState.auth.length === 0, r.out);
  }
  // ── One resolver's absence is not the name's (3.4.15) ─────────────────────────────────────
  // The two real resolvers, answered by a stand-in of fetch: nothing reaches the network.
  {
    const { survey } = await import(pathToFileURL(SCRIPT).href);
    const real = globalThis.fetch;
    const hosts = [];
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      hosts.push(u.host);
      const served = u.host === "cloudflare-dns.com" && u.searchParams.get("name") === "blog.example.fr" && u.searchParams.get("type") === "A";
      const body = served ? { Status: 0, Answer: [{ name: "blog.example.fr.", type: 1, TTL: 300, data: "192.0.2.10" }] } : { Status: 3 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/dns-json" } });
    };
    try {
      const open = { ...process.env };
      delete open.HYPERVIBE_DOH_URL;
      const s = await survey("example.fr", open);
      check("a record one resolver serves while the other still says the name absent: found, so carried before the switch (3.4.15: a cache answered NXDOMAIN minutes after the name was made)", s.ok && s.names.some((x) => x.name === "blog.example.fr" && x.content === "192.0.2.10") && hosts.includes("dns.google") && hosts.includes("cloudflare-dns.com"), JSON.stringify(s.names));
      check("... and an absence both resolvers say is an absence: nothing else found", s.mail.length === 0 && s.names.length === 1);
    } finally {
      globalThis.fetch = real;
    }
  }
} finally {
  doh.close();
  cf.close();
}

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
