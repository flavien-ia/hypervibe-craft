#!/usr/bin/env node
// test-delete-cloudflare-pages.mjs - /delete-project reads every page of the Cloudflare lists it
// looks through: the zones, each zone's records, each zone's routing rules.
//
// Before 3.4.12 it read one page of each: 50 zones, 200 records a zone, and routing rules asked
// 200 at a time, which Cloudflare cuts to 50 in silence without giving a number of pages (read on
// a real account on 14/10/2026). The project's records and rules beyond those pages were left
// behind, and a zone that could not be read passed for an empty one. The lists here are served the
// way that account served them. No network: the reader is handed in, and the inventory script is
// read for what it calls.
//
//   node scripts/tests/test-delete-cloudflare-pages.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { cloudflareAll } = await import(pathToFileURL(join(ROOT, "scripts", "delete-project", "_cloudflare-pages.mjs")).href);

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? ` (${String(detail).slice(0, 300)})` : ""}`);
}

/** A list served as Cloudflare serves it: `max` items a page at most, whatever is asked; with or
 *  without a number of pages; `fail` answers a given page with an HTTP error or a refusal. */
function served(n, { max = 50, totalPages = false, info = true, fail = null } = {}) {
  const asked = [];
  const items = Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
  const getJson = async (url) => {
    const u = new URL(url);
    const per = Math.min(Number(u.searchParams.get("per_page")) || max, max);
    const page = Number(u.searchParams.get("page")) || 1;
    asked.push({ per: Number(u.searchParams.get("per_page")), page, host: u.host, path: u.pathname });
    if (fail?.page === page) return fail.answer;
    const slice = items.slice((page - 1) * per, page * per);
    const resultInfo = { page, per_page: per, count: slice.length, total_count: n, ...(totalPages ? { total_pages: Math.max(1, Math.ceil(n / per)) } : {}) };
    return { success: true, errors: [], result: slice, ...(info ? { result_info: resultInfo } : {}) };
  };
  return { getJson, asked };
}

console.log("── Chaque page, comme Cloudflare les sert ──");
{
  const s = served(60);
  const r = await cloudflareAll("/zones/z1/email/routing/rules", 50, s.getJson);
  check("60 routing rules served 50 a page, a total and no number of pages: all 60 read", r.items.length === 60 && !r.error && s.asked.length === 2, JSON.stringify(s.asked));
  check("... never more than 50 asked, at the real API's address", s.asked.every((a) => a.per === 50 && a.host === "api.cloudflare.com" && a.path === "/client/v4/zones/z1/email/routing/rules"));
}
{
  const s = served(60);
  const r = await cloudflareAll("/zones/z1/email/routing/rules", 200, s.getJson);
  check("asked 200 and cut to 50 in silence (what the published inventory asked): still all 60, by the size served", r.items.length === 60 && !r.error, JSON.stringify(s.asked));
}
{
  const s = served(230, { max: 5000, totalPages: true });
  const r = await cloudflareAll("/zones/z1/dns_records", 100, s.getJson);
  check("230 DNS records, 100 a page, the number of pages given: all 230 in three pages", r.items.length === 230 && s.asked.length === 3 && !r.error, JSON.stringify(s.asked));
}
{
  const s = served(120, { info: false });
  const r = await cloudflareAll("/zones", 50, s.getJson);
  check("no page information at all: a full page asks for the next one, a short one ends the list", r.items.length === 120 && s.asked.length === 3 && !r.error, JSON.stringify(s.asked));
  const t = served(50, { info: false });
  const r2 = await cloudflareAll("/zones", 50, t.getJson);
  check("... exactly one full page: the next one asked, found empty, the list ends there", r2.items.length === 50 && t.asked.length === 2 && !r2.error);
  const u = served(0);
  const r3 = await cloudflareAll("/zones", 50, u.getJson);
  check("an empty list: nothing, said complete after one call", r3.items.length === 0 && u.asked.length === 1 && !r3.error);
}

console.log("── Une page qui échoue fait échouer la lecture ──");
{
  const s = served(120, { fail: { page: 2, answer: { __error: "HTTP 500", body: "" } } });
  const r = await cloudflareAll("/zones/z1/email/routing/rules", 50, s.getJson);
  check("an HTTP error on the second page: said, the first page kept but never taken for the whole list", r.error === "HTTP 500" && r.items.length === 50);
  const t = served(10, { fail: { page: 1, answer: { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null } } });
  const r2 = await cloudflareAll("/zones", 50, t.getJson);
  check("an answer whose body says success: false (HTTP 200): a failure in Cloudflare's words, never an empty list", r2.error === "Authentication error" && r2.items.length === 0);
}

console.log("── L'inventaire s'en sert pour les zones, leurs enregistrements, leurs règles ──");
{
  const src = readFileSync(join(ROOT, "scripts", "delete-project", "discover-resources.mjs"), "utf8");
  const body = (name) => {
    const at = src.indexOf(`async function ${name}(`);
    return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
  };
  const dns = body("scanDns");
  const routing = body("scanEmailRouting");
  check("no list of the Cloudflare scans is read in one page any more", !/per_page=\d+/.test(dns) && !/per_page=\d+/.test(routing) && /cloudflareAll\("\/zones", 50,/.test(dns) && /cloudflareAll\("\/zones", 50,/.test(routing));
  check("... each zone's records and routing rules, every page (the rules at 50, as Cloudflare serves them)", /cloudflareAll\(`\/zones\/\$\{z\.id\}\/dns_records`/.test(dns) && /cloudflareAll\(`\/zones\/\$\{z\.id\}\/email\/routing\/rules`, 50,/.test(routing));
  check("... a zone whose records or rules could not be read is said in `error` (the skill reads it as unknown), never passed over", /if \(recs\.error\) unread\.push\(/.test(dns) && /\.\.\.\(unread\.length \? \{ error: `records not read in/.test(dns) && /if \(data\.error\) unread\.push\(/.test(routing) && /\.\.\.\(unread\.length \? \{ error: `routing rules not read in/.test(routing));
  check("... a routing rule kept with its identifier when Cloudflare no longer sends `tag`", /tag: r\.tag \?\? r\.id/.test(routing));
}

console.log("── Une zone que la clé n'a pas le droit de lire n'est pas une analyse en échec (banc du 04/11/2026) ──");
{
  const src = readFileSync(join(ROOT, "scripts", "delete-project", "discover-resources.mjs"), "utf8");
  const body = (name) => {
    const at = src.indexOf(`async function ${name}(`);
    return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
  };
  const dns = body("scanDns");
  const routing = body("scanEmailRouting");
  const m = /const refusedRead = \(error\) => (\/.+\/)\.test/.exec(src);
  const refused = m ? new Function(`return ${m[1]}`)() : null;
  check("a refusal is an HTTP 403, and only that", !!refused && refused.test("HTTP 403") && !refused.test("HTTP 404") && !refused.test("HTTP 500") && !refused.test("API returned success:false"), m?.[1]);
  check("... a refused zone the manifest does not record goes to outOfReach, not to the errors", /refusedRead\(recs\.error\) && !recorded\.has\(/.test(dns) && /outOfReach\.add\(z\.name\)/.test(dns) && /refusedRead\(data\.error\) && !recorded\.has\(/.test(routing) && /outOfReach\.add\(z\.name\)/.test(routing));
  check("... both scans say it, in one line", /\.\.\.outOfReachNote\(outOfReach\)/.test(dns) && /\.\.\.outOfReachNote\(outOfReach\)/.test(routing));
  check("... the recorded zones come from the manifest's dns-zone and email-route", /r\?\.kind === "dns-zone" \? r\.name : r\?\.kind === "email-route"/.test(src));
  const skill = readFileSync(join(ROOT, "skills", "delete-project", "SKILL.md"), "utf8");
  check("... and the skill tells it apart from a failed scan", /`dns\.outOfReach`[^\n]*is not one/.test(skill) && /never ask what to do about it/.test(skill));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
