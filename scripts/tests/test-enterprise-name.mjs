#!/usr/bin/env node
// test-enterprise-name.mjs - « Hypervibe Team » s'appelle désormais « Hypervibe Enterprise »
// (3.4.19 / 2.5.0), et la demande était qu'il ne reste plus aucun « team » : ni dans les noms
// affichés, ni dans les noms techniques. Cette recette parcourt tout le harnais (les trois sont
// parcourus, chacun par sa copie de ce fichier, identique) et échoue sur toute occurrence de
// « team », casse ignorée, chemins compris, qui n'est pas dans la liste blanche ci-dessous.
//
// La liste blanche est courte, et chaque ligne dit pourquoi :
//   - les tiers, dont « team » est le mot à eux (l'équipe Vercel, le plan Teams de Bitwarden,
//     l'offre Team de GitHub, Turborepo, Drizzle) ;
//   - les lectures des anciens noms, voulues : la migration (un poste installé avant la 2.5.0
//     porte encore les anciens noms), la clé de licence d'avant, valable sans limite ;
//   - l'annonce du changement de nom, qui nomme l'ancienne offre pour dire la nouvelle.
// Dans les fichiers qui ne parlent que de l'équipe Vercel, nos anciens noms restent interdits.
//
//   node scripts/tests/test-enterprise-name.mjs
//   HV_NAME_ROOTS="<racine>;<racine>" node scripts/tests/test-enterprise-name.mjs   (d'autres racines)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOTS = (process.env.HV_NAME_ROOTS || ROOT).split(";").filter(Boolean);
const SKIP = new Set(["node_modules", ".git", "__pycache__"]);

// Le mot cherché, et nos anciens noms (interdits même dans un fichier de tiers).
const MOT = /team/i;
const NOTRE = /hypervibe-team|update-hypervibe-team|\/api\/team\b|team-(?:seat|license|heartbeat|admin-audit)\b|hvteam|hv-team|HV-TEAM|Hypervibe Teams?\b|\bteam[- ]mode\b|\bteam projects?\b/i;

// ─── La liste blanche ──────────────────────────────────────────────────────────
// Partout : les mots des tiers. Chaque motif est retiré de la ligne avant de chercher « team ».
const TIERS = [
  // L'équipe Vercel : les identifiants de son API et de nos scripts qui la résolvent.
  [/\b(?:team_?[Ii]ds?|teamName|teamSlug|teamQuery|teamSuffix|teamRes|teamNote|teamHint|teamForAction|teamSettled|readingTeam|withTeam|linkTeam|currentTeam|defaultTeamId|extraTeamIds|vercelTeams?|resolveVercelTeam(?:Id)?|resetVercelTeamCache|readCliCurrentTeam|VERCEL_TEAM\w*|HV_VERCEL_TEAM|FAKE_VERCEL_TEAM|team_[A-Za-z0-9_.]*|(?:test-)?vercel-team(?:\.mjs)?)\b|\/v2\/teams\b|\.teams\b|\bteams:|--team\b/g, "l'équipe Vercel (identifiants de son API et de vercel-team.mjs)"],
  [/ownerType: "team"|"team" for an organisation/g, "l'API de l'application GitHub de Vercel : un compte d'organisation y est de type team"],
  // Une ligne qui nomme Vercel : son « team » est l'équipe Vercel.
  [/^.*\bvercel\b.*$/gi, "une ligne qui nomme Vercel parle de l'équipe Vercel"],
  [/Bitwarden Teams|\b(?:plan|org|en) (?:\*\*)?Teams\b|\bTeams (?:plan|organization|subscription)\b/g, "le plan Teams de Bitwarden"],
  [/GitHub Team\b|Collaborators and teams/g, "l'offre Team de GitHub, et l'écran de ses collaborateurs"],
  [/TURBO_TEAM|orm\.drizzle\.team/g, "Turborepo et le site de Drizzle"],
];

// L'annonce du changement de nom : elle nomme l'ancienne offre pour dire la nouvelle. Retirée avant
// tout le reste (sinon l'ancien nom qu'elle porte serait pris pour un oubli).
const ANNONCE = /Hypervibe Team (?:s'appelle|s’appelle|is now called)/g;

// Les fichiers qui ne parlent que de l'équipe Vercel : « team » y est le mot de Vercel.
const FICHIERS_VERCEL = new Set([
  "scripts/vercel-team.mjs",
  "scripts/tests/test-vercel-team.mjs",
  "scripts/_vercel-projects.mjs",
  "scripts/tests/test-vercel-projects.mjs",
  "scripts/tests/_fake-vercel.mjs",
  "scripts/_vercel-auth.mjs",
  "scripts/tests/test-vercel-auth.mjs",
  "scripts/vercel-plan.mjs",
  "scripts/vercel/plan.mjs",
  "scripts/tests/test-vercel-plan.mjs",
  "scripts/delete-project/discover-resources.mjs",
  "scripts/delete-project/execute-deletions.mjs",
  "skills/delete-project/SKILL.md",
]);

// Les lectures des anciens noms, fichier par fichier.
const ANCIENS = [
  ["scripts/license/enterprise-migration.mjs", null, "le seul module qui nomme les anciens noms : la migration d'un poste installé avant la 2.5.0"],
  ["scripts/tests/test-enterprise-migration.mjs", null, "la recette de la migration pose un poste d'avant la 2.5.0"],
  ["scripts/tests/test-enterprise-name.mjs", null, "cette recette nomme ce qu'elle cherche"],
  ["scripts/license/ask-key.mjs", /HV-\(ENT\|TEAM\)|"team-(?:seat|license)\.json"/g, "la clé de licence d'avant, valable sans limite, et le siège d'avant, repris"],
  ["scripts/tests/test-ask-key.mjs", /HV-TEAM\b[-A-Z0-9]*|team-(?:seat|license)\.json/g, "la clé et le siège d'avant, que la fenêtre accepte encore"],
  ["scripts/tests/test-enterprise-texts.mjs", null, "la recette des textes pose ceux qu'écrivaient les versions d'avant la 2.5.0"],
  ["skills/start/SKILL.md", /'hypervibe-team-admin'/g, "le plugin administrateur d'un poste pas encore mis à jour"],
];

// ─── Le parcours ───────────────────────────────────────────────────────────────
let checks = 0;
const failures = [];
function walk(root, dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out.push(relative(root, p).replace(/\\/g, "/"));
  }
  return out;
}

/** Ce que la liste blanche laisse d'une ligne, et si un ancien nom à nous y reste. */
export function examiner(rel, line) {
  const ancien = ANCIENS.find(([f]) => f === rel);
  if (ancien && ancien[1] === null) return { ok: true };
  let reste = line.replace(ANNONCE, "");
  if (ancien) reste = reste.replace(ancien[1], "");
  if (NOTRE.test(reste)) return { ok: false, why: "un ancien nom de l'offre" };
  if (FICHIERS_VERCEL.has(rel)) return { ok: true };
  for (const [re] of TIERS) reste = reste.replace(re, "");
  return MOT.test(reste) ? { ok: false, why: "team" } : { ok: true };
}

for (const root of ROOTS) {
  for (const rel of walk(root, root, [])) {
    checks += 1;
    if (MOT.test(rel) && !FICHIERS_VERCEL.has(rel) && !ANCIENS.some(([f, m]) => f === rel && m === null)) {
      failures.push(`${root}: ${rel} (chemin)`);
    }
    const raw = readFileSync(join(root, rel));
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) continue; // un binaire n'a pas de texte
    text.split(/\r?\n/).forEach((line, i) => {
      if (!MOT.test(line)) return;
      const r = examiner(rel, line);
      if (!r.ok) failures.push(`${root}: ${rel}:${i + 1} (${r.why}) ${line.trim().slice(0, 160)}`);
    });
  }
}

for (const f of failures.slice(0, 200)) console.log(`FAIL ${f}`);
if (failures.length > 200) console.log(`... et ${failures.length - 200} de plus`);
console.log(`${failures.length ? "FAIL" : "OK  "} aucun « team » hors de la liste blanche (${checks} fichiers parcourus, ${failures.length} occurrence(s))`);
process.exitCode = failures.length ? 1 : 0;
