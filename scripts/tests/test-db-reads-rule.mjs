#!/usr/bin/env node
// test-db-reads-rule.mjs - The project rule « Lectures en base », rewritten in 3.4.16 / 2.4.15 from
// what Bastien Detraz measured on a real account on a paid plan (mail of 22/10/2026):
//   - the costliest reads went through `findFirst` without columns (530 kB a row to check an
//     owner, 2.1 GB in three weeks): the rule names findFirst, findMany and .select();
//   - a page's `revalidate` protects nothing once its tree reads the request (the session, a CSP
//     nonce), and 600 s are woken at each expiry by a regular automated visitor (7 h awake a day
//     before it, 17 to 19 h after): the READ is cached (unstable_cache, or 'use cache' with
//     cacheTag in Next 16), an hour at least, invalidated by revalidateTag in the mutations;
//   - its reasons hold on the free plan (quotas) and on a paid one (the bill).
// The rest (polling, binaries, real time) is unchanged. A project that holds the 3.4.15 wording,
// untouched, gets the new one at its next sync; one the person edited keeps theirs.
//
//   node scripts/tests/test-db-reads-rule.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { CATALOG } = await import(pathToFileURL(join(ROOT, "scripts", "rules", "rules.mjs")).href);

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 400)})` : ""}`);
}

const rule = CATALOG.find((r) => r.id === "db-egress-reads");
const text = rule?.text ?? "";
const previous = rule?.previousTexts ?? [];
// The wording shipped until 3.4.15 / 2.4.14, as projects hold it.
const SHIPPED = previous[0] ?? "";

console.log("── Ce que dit la règle ──");
check("la règle existe, sous son identifiant", Boolean(rule));
check("(1) jamais de findFirst, de findMany ni de .select() sans liste de colonnes, même pour un seul champ", /jamais de `findFirst`, de `findMany` ni de `\.select\(\)` sans liste de colonnes/.test(text) && /même pour vérifier un seul champ/.test(text));
check("... avec le cas mesuré (530 Ko par ligne, 2,1 Go en trois semaines)", /530 Ko/.test(text) && /2,1 Go/.test(text));
check("... et toujours une liste bornée", /borner une liste par un `limit`/.test(text));
check("(3) la lecture mise en cache, pas la page : unstable_cache, ou 'use cache' avec cacheTag, une heure au moins", /mettre en cache la LECTURE, pas la page/.test(text) && /`unstable_cache\(/.test(text) && /'use cache'/.test(text) && /cacheTag\(/.test(text) && /une heure au moins/.test(text) && /revalidate: 3600/.test(text));
check("... invalidée dans les mutations, avec l'API de Next 15 et celle de Next 16", /`revalidateTag\(tag\)` \(Next 15\)/.test(text) && /`revalidateTag\(tag, \{ expire: 0 \}\)` \(Next 16/.test(text) && /updateTag/.test(text) && /cacheComponents/.test(text));
check("... un revalidate de page ne protège rien quand l'arbre lit la requête (session, cookies, jeton CSP)", /`revalidate` de page ne protège rien dès que l'arbre de la page lit la requête/.test(text) && /cookies/.test(text) && /CSP/.test(text) && /rendue à chaque visite/.test(text));
check("... 600 s ne suffisent pas, avec la mesure (7 h, puis 17 à 19 h d'éveil par jour)", /600 s ne suffisent pas/.test(text) && /visiteur automatique régulier/.test(text) && /7 h d'éveil par jour/.test(text) && /17 à 19 h/.test(text));
check("plus jamais « revalidate >= 600 » comme remède", !/>= 600/.test(text));
check("la raison vaut pour le plan gratuit (5 Go, 100 h) et pour un plan payant (temps d'éveil, taille de calcul, facture)", /5 Go de trafic sortant et 100 h de calcul/.test(text) && /plan payant/.test(text) && /temps d'éveil multiplié par la taille de calcul fait la facture/.test(text));
{
  // What does not change: the polling, the binaries, the real time, word for word.
  const part = (from, to) => {
    const a = SHIPPED.indexOf(from);
    const b = to ? SHIPPED.indexOf(to, a) : SHIPPED.length;
    return a >= 0 && b > a ? SHIPPED.slice(a, b) : null;
  };
  const polling = part("(2) préférer", " ; (3)");
  const binaries = part("(4) ne jamais stocker", " Avant de proposer");
  const realtime = part("Avant de proposer", null);
  check("le polling, les binaires et le temps réel sont gardés mot pour mot", Boolean(polling && binaries && realtime) && text.includes(polling) && text.includes(binaries) && text.includes(realtime));
}
check("aucun tiret long dans la règle", ![String.fromCharCode(0x2013), String.fromCharCode(0x2014)].some((c) => text.includes(c)));

console.log("\n── Un projet qui porte l'ancienne formulation ──");
check("la formulation livrée jusqu'à la 3.4.15 est gardée pour être reconnue", /^Lectures en base : l'egress \(trafic sortant\) est le quota qui saute en premier/.test(SHIPPED) && /`revalidate` >= 600/.test(SHIPPED));
const CLI = join(ROOT, "scripts", "rules", "update-project-claude-md.mjs");
const boxes = [];
if (existsSync(CLI)) {
  const project = (lines) => {
    const dir = mkdtempSync(join(tmpdir(), "hv-lectures-"));
    boxes.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { next: "15.0.0", "drizzle-orm": "0.44.0" } }));
    writeFileSync(join(dir, "CLAUDE.md"), ["# demo", "", "## Conventions", "", "<!-- hypervibe:project-rules -->", "### Règles Hypervibe (projet)", "", ...lines, "<!-- /hypervibe:project-rules -->", "", "## Environment Variables", ""].join("\n"));
    return dir;
  };
  const sync = (dir) => JSON.parse(execFileSync(process.execPath, [CLI, "--dir", dir], { encoding: "utf8" }).trim().split("\n").pop());
  {
    const dir = project(["<!-- rule:db-egress-reads -->", `- ${SHIPPED}`]);
    const r = sync(dir);
    const after = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    check("intacte, elle est mise à jour à la synchronisation suivante", r.updated?.includes("db-egress-reads") && !r.keptEdited?.includes("db-egress-reads"), JSON.stringify(r));
    check("... le nouveau texte en place, l'ancien parti, une seule fois", after.includes(text) && !after.includes(SHIPPED) && (after.match(/rule:db-egress-reads/g) ?? []).length === 1);
  }
  {
    const dir = project(["<!-- rule:db-egress-reads -->", `- ${SHIPPED} Et ma précision à moi.`]);
    const r = sync(dir);
    check("retouchée par la personne, elle reste la sienne, mot pour mot", r.keptEdited?.includes("db-egress-reads") && readFileSync(join(dir, "CLAUDE.md"), "utf8").includes("Et ma précision à moi."), JSON.stringify(r));
  }
}

console.log("\n── Les copies de la règle dans les skills ──");
{
  const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null);
  const addDb = read("skills/add-db/SKILL.md");
  // Only the /add-db that describes the reading doctrine (the solo's, the collaborator's): the
  // administrator's provisions the database and says nothing of how the code reads it.
  if (addDb !== null && /(?:reading doctrine|doctrine de lecture)/.test(addDb)) check("/add-db ne promet plus « revalidate >= 600 » et dit la lecture mise en cache", !/`revalidate` >= 600/.test(addDb) && !/never goes below 600|ne descend jamais sous 600/.test(addDb) && /(?:read cached for an hour|lecture mise en cache une heure)/.test(addDb));
  for (const rel of ["skills/add-db/SKILL.md", "skills/install-project/SKILL.md"]) {
    const s = read(rel);
    if (s === null || !/- Cache :/.test(s)) continue;
    check(`${rel} : la puce « Cache » met la lecture en cache, la puce « Requêtes » nomme findFirst`, /- Cache : mettre en cache la lecture, pas la page/.test(s) && !/utilise \\`revalidate\\` >= 600/.test(s) && /jamais de \\`findFirst\\` ni de \\`findMany\\` sans \\`columns\\`/.test(s));
  }
  const optimize = read("skills/optimize/SKILL.md");
  if (optimize !== null) check("/optimize ne prend plus 600 s pour seuil, et cherche la page qui lit la requête", !/revalidate` (?:below|sous) 600/.test(optimize) && /(?:whose tree reads the request|dont l'arbre lit la requête)/.test(optimize));
}

for (const d of boxes) rmSync(d, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
