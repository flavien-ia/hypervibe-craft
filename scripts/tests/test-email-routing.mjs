#!/usr/bin/env node
// test-email-routing.mjs - Recette of scripts/email-routing.mjs (3.4.11): Email Routing is never
// enabled over a domain whose mail goes elsewhere, Cloudflare's answer is read, and the settings are
// read back. Against a fake Cloudflare API on the loopback: no network, no vault.
//
//   node scripts/tests/test-email-routing.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "email-routing.mjs");
const { isRoutingMx, readKey, apiBase, EXIT } = await import(pathToFileURL(SCRIPT).href);
const KEY = "jeton-cloudflare-de-recette";

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 400)})`}`);
}

let st;
const world = (o = {}) => {
  st = { zones: [{ id: "z1", name: "example.fr" }], mx: [], enabled: false, refuseEnable: null, refuseRight: false, settingsRight: false, stayOff: false, calls: [], ...o };
};
const server = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  st.calls.push(`${req.method} ${req.url}`);
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/client/v4/zones") return send(200, { success: true, result: st.zones.filter((z) => z.name === u.searchParams.get("name")) });
  if (req.method === "GET" && u.pathname === "/client/v4/zones/z1/dns_records") return send(200, { success: true, result: st.mx.map((content, i) => ({ id: `m${i}`, type: "MX", name: "example.fr", content, priority: 10 })) });
  if (req.method === "GET" && u.pathname === "/client/v4/zones/z1/email/routing" && st.settingsRight) return send(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
  if (req.method === "GET" && u.pathname === "/client/v4/zones/z1/email/routing") return send(200, { success: true, result: { enabled: st.enabled, status: st.enabled ? "ready" : "unconfigured", name: "example.fr" } });
  if (req.method === "POST" && u.pathname === "/client/v4/zones/z1/email/routing/enable") {
    if (st.refuseRight) return send(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    if (st.refuseEnable) return send(400, { success: false, errors: [{ code: 2007, message: st.refuseEnable }] });
    if (!st.stayOff) st.enabled = true;
    return send(200, { success: true, result: { enabled: st.enabled } });
  }
  return send(404, { success: false, errors: [{ code: 7003, message: "Could not route" }] });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const API = `http://127.0.0.1:${server.address().port}`;
function run(args, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HYPERVIBE_CLOUDFLARE_API: API, CLOUDFLARE_API_TOKEN: KEY, ...env }, windowsHide: true });
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
const enabled = () => st.calls.some((c) => c.startsWith("POST ") && c.includes("/email/routing/enable"));

try {
  check("Email Routing's own servers are told apart from a provider's", isRoutingMx("route1.mx.cloudflare.net") && isRoutingMx("ROUTE3.mx.cloudflare.net.") && !isRoutingMx("aspmx.l.google.com") && !isRoutingMx("route1.mx.cloudflare.net.evil.example"));
  check("Cloudflare is the real one unless a recette's loopback is named", apiBase({}) === "https://api.cloudflare.com/client/v4" && apiBase({ HYPERVIBE_CLOUDFLARE_API: "https://evil.example" }) === "https://api.cloudflare.com/client/v4");
  check("against Cloudflare, a key from the environment is ignored: the vault alone", readKey({ CLOUDFLARE_API_TOKEN: "x" }, "https://api.cloudflare.com/client/v4", () => ({ status: 4, value: "" })).code === EXIT.NO_KEY);

  world({ mx: ["aspmx.l.google.com", "alt1.aspmx.l.google.com"] });
  let r = await run(["enable", "example.fr"]);
  check("a domain on Google Workspace: refused, exit 2, its mail servers named, nothing enabled", r.code === EXIT.ELSEWHERE && (r.json?.foreignMx ?? []).includes("aspmx.l.google.com") && !enabled(), r.out);
  check("... and never a key printed", !`${r.out}${r.err}`.includes(KEY));

  world({ mx: [] });
  r = await run(["enable", "example.fr"]);
  check("no mail server yet: enabled, then read back as enabled", r.code === EXIT.OK && r.json?.enabled === true && r.json.already === false && enabled() && st.calls.filter((c) => c.includes("/email/routing") && c.startsWith("GET")).length === 2, r.out);

  world({ mx: ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"], enabled: true });
  r = await run(["enable", "example.fr"]);
  check("already enabled with its own servers: nothing sent, said", r.code === EXIT.OK && r.json?.already === true && !enabled(), r.out);

  world({ mx: [], refuseEnable: "Missing permission" });
  r = await run(["enable", "example.fr"]);
  check("Cloudflare refuses: its words, exit 1", r.code === EXIT.UNREADABLE && /Missing permission/.test(r.json?.error ?? ""), r.out);

  world({ mx: [], refuseRight: true });
  r = await run(["enable", "example.fr"]);
  check("Cloudflare refuses for lack of a right: exit 1, and the right named (Zone · Zone Settings · Edit, 3.4.31)", r.code === EXIT.UNREADABLE && r.json?.missingRight === "Zone · Zone Settings · Edit" && /lacks the right "Zone · Zone Settings · Edit"/.test(r.json?.error ?? ""), r.out);
  world({ mx: [], refuseEnable: "Missing permission" });
  r = await run(["enable", "example.fr"]);
  check("... a refusal for another reason does not name it", r.code === EXIT.UNREADABLE && !r.json?.missingRight && !/Zone Settings/.test(r.json?.error ?? ""), r.out);
  world({ mx: [], settingsRight: true });
  r = await run(["status", "example.fr"]);
  check("... nor does reading the settings without that right go unnamed", r.code === EXIT.UNREADABLE && r.json?.missingRight === "Zone · Zone Settings · Edit", r.out);

  world({ mx: [], stayOff: true });
  r = await run(["enable", "example.fr"]);
  check("Cloudflare answers but the settings do not read back enabled: exit 1, never announced", r.code === EXIT.UNREADABLE && r.json?.ok === false && r.json.enabled === false, r.out);

  world({ mx: ["mx1.mail.ovh.net"] });
  r = await run(["status", "example.fr"]);
  check("status reads, changes nothing", r.code === EXIT.OK && r.json?.enabled === false && JSON.stringify(r.json.foreignMx) === '["mx1.mail.ovh.net"]' && !enabled(), r.out);

  world({ zones: [] });
  r = await run(["enable", "example.fr"]);
  check("no zone: exit 1, said, nothing enabled", r.code === EXIT.UNREADABLE && /No Cloudflare zone/.test(r.json?.error ?? "") && !enabled(), r.out);
  world({ zones: [{ id: "z1", name: "example.fr" }, { id: "z2", name: "example.fr" }] });
  r = await run(["enable", "example.fr"]);
  check("two zones of that name: exit 1, never a guess", r.code === EXIT.UNREADABLE && /Several/.test(r.json?.error ?? "") && !enabled(), r.out);

  {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const skills = join(HERE, "..", "..", "skills");
    const skill = readFileSync(join(skills, "new-email-address", "SKILL.md"), "utf8");
    check("/new-email-address enables Email Routing through the script, and stops on a domain whose mail goes elsewhere", skill.includes('node "$ROUTING" enable <domain>') && /\*\*(?:Stop here|S'arrêter là)\*\*/.test(skill));
    const raw = [];
    const visit = (dir) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) visit(p);
        else if (/^SKILL.*\.md$/.test(n) && /email\/routing\/enable/.test(readFileSync(p, "utf8"))) raw.push(p);
      }
    };
    visit(skills);
    check("no skill enables Email Routing by a bare call any more", raw.length === 0, raw.join(", "));
  }

  world();
  r = await run(["enable", "https://example.fr"]);
  check("a domain with its scheme: exit 5, nothing asked", r.code === EXIT.USAGE && st.calls.length === 0, r.out);
} finally {
  server.close();
}

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
