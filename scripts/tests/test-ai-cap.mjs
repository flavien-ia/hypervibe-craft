#!/usr/bin/env node
// test-ai-cap.mjs - Recette of the cap of a project's AI key (Enterprise bench, 06/11/2026): the skills
// present it as a MONTHLY budget, but the key was created without `limit_reset`, and OpenRouter then
// never resets the counter: the key stopped for good at the first cap reached. Since then the key is
// created with `limit_reset: "monthly"` (or "daily" on request). OpenRouter is replaced by a fake
// fetch: no network, no key.
//
//   node scripts/tests/test-ai-cap.mjs

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { creerCleProjet } = await import(pathToFileURL(join(ROOT, "scripts", "ai", "openrouter.mjs")).href);

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 300)})`}`);
}

const envoyes = [];
globalThis.fetch = async (url, init) => {
  envoyes.push({ url: String(url), corps: JSON.parse(init?.body ?? "{}") });
  return new Response(JSON.stringify({ key: "sk-or-v1-essai", data: { hash: "h1" } }), { status: 200 });
};

await creerCleProjet({ cleGestion: "gestion-essai", nom: "projet-essai", plafondUsd: 10 });
const parDefaut = envoyes.at(-1)?.corps ?? {};
check("par défaut, le plafond se remet à zéro chaque mois (limit_reset monthly)", parDefaut.limit_reset === "monthly", JSON.stringify(parDefaut));
check("le plafond demandé part tel quel", parDefaut.limit === 10, JSON.stringify(parDefaut));

await creerCleProjet({ cleGestion: "gestion-essai", nom: "projet-essai", plafondUsd: 2, resetQuotidien: true });
const quotidien = envoyes.at(-1)?.corps ?? {};
check("sur demande, il se remet à zéro chaque jour (limit_reset daily)", quotidien.limit_reset === "daily", JSON.stringify(quotidien));

let refus = null;
try {
  await creerCleProjet({ cleGestion: "gestion-essai", nom: "projet-essai", plafondUsd: 0 });
} catch (e) {
  refus = e;
}
check("une clé sans plafond reste refusée, avant tout appel", refus !== null && envoyes.length === 2);

console.log(`\n${checks - failures}/${checks} verifications`);
process.exit(failures ? 1 : 0);
