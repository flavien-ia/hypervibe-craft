#!/usr/bin/env node
// test-domain-mx.mjs - Recette of scripts/domain-mx.mjs (3.4.13): a domain whose mail servers are
// Email Routing's is said relayed, a domain with real mailboxes is not, and a DNS that cannot be read
// is never taken for "no relay". Against a stand-in resolver: no network.
//
//   node scripts/tests/test-domain-mx.mjs

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { isRoutingMx, mxOf, main, EXIT } = await import(pathToFileURL(join(ROOT, "scripts", "domain-mx.mjs")).href);

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}
const answers = (list) => async () => list;
const fails = (code) => async () => {
  throw Object.assign(new Error(code), { code });
};

check("les serveurs d'Email Routing reconnus, et seulement eux", isRoutingMx("route1.mx.cloudflare.net") && isRoutingMx("ROUTE3.mx.cloudflare.net.") && !isRoutingMx("aspmx.l.google.com") && !isRoutingMx("route1.mx.cloudflare.net.evil.example"));
let r = await mxOf("atelier.fr", answers([{ exchange: "route2.mx.cloudflare.net", priority: 20 }, { exchange: "route1.mx.cloudflare.net", priority: 10 }]));
check("un domaine dont le courrier passe par Email Routing : relayé, serveurs par priorité", r.ok && r.relayed === true && r.mx[0] === "route1.mx.cloudflare.net", JSON.stringify(r));
r = await mxOf("atelier.fr", answers([{ exchange: "aspmx.l.google.com", priority: 1 }]));
check("un domaine qui a de vraies boîtes : pas relayé", r.ok && r.relayed === false, JSON.stringify(r));
r = await mxOf("atelier.fr", fails("ENODATA"));
check("un domaine sans serveur de courrier : une lecture, pas relayé", r.ok && r.relayed === false && r.mx.length === 0, JSON.stringify(r));
r = await mxOf("atelier.fr", fails("ETIMEOUT"));
check("un DNS qui ne répond pas n'est jamais pris pour « pas de relais »", r.ok === false && /ETIMEOUT/.test(r.error ?? ""), JSON.stringify(r));
r = await main(["atelier.fr"], fails("ESERVFAIL"));
check("... et le script le dit en code 1", r.code === EXIT.UNREADABLE);
r = await main(["https://atelier.fr"]);
check("une adresse au lieu d'un domaine : usage, code 5", r.code === EXIT.USAGE);

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
