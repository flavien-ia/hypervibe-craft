#!/usr/bin/env node
// test-delete-vault.mjs - /delete-project et l'état du coffre : jamais une suppression à moitié,
// et un inventaire qui ne dit que ce qui est.
//
// Jusqu'à la 3.3.10, un coffre expiré entre la validation du périmètre et l'exécution laissait
// supprimer ce qui ne demande aucune clé (le site chez son hébergeur), puis échouait sur le reste
// derrière « NEON_API_KEY missing ». Les deux scripts refusent désormais d'entrée, avec les codes
// du coffre (2 verrouillé, 3 expiré).
//
// Les scripts sont lancés pour de vrai, avec un dossier personnel de recette (le coffre y est
// verrouillé : aucune session ; ou expiré : une session de treize heures), un faux hébergeur sur
// 127.0.0.1 et aucune clé dans l'environnement. Aucun réseau au-delà, aucun compte, aucun coffre.
// Sur une machine où une clé de fournisseur est lisible hors du coffre, les lancements sont
// sautés (et dits) : un script qui trouverait une clé irait jusqu'au fournisseur.
//
// Depuis la 3.4.16, la première lecture qui trouve la session expirée la verrouille pour de vrai
// (`bw lock`, puis son fichier retiré, scripts/vault/session.mjs) : la suivante trouve un coffre
// verrouillé, d'où le code 2 ou 3 selon l'ordre des lectures. `bw` y est joué par un faux
// (HYPERVIBE_BW_STANDIN) : une recette ne lance jamais l'outil du coffre.
//
//   node scripts/tests/test-delete-vault.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeRest, GOOD_TOKEN } from "./_fake-vercel.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const ROOT = join(ICI, "..", "..");
const EXECUTE = join(ROOT, "scripts", "delete-project", "execute-deletions.mjs");
const DISCOVER = join(ROOT, "scripts", "delete-project", "discover-resources.mjs");
const READ_ENV = join(ROOT, "scripts", "_read-user-env.mjs");
const { isSystemVar, isStripeVar, settleStripeWithoutKey } = await import(
  pathToFileURL(join(ROOT, "scripts", "delete-project", "_inventory-rules.mjs")).href
);

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 600)})`}`);
}

const racine = mkdtempSync(join(tmpdir(), "hv-delete-vault-"));
const CLES = ["NEON_API_KEY", "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "RENDER_API_KEY", "STRIPE_SECRET_KEY"];

// ── le faux hébergeur : un compte, un site ──
const compte = () => ({
  user: { id: "user_1", username: "alice", version: "northstar", defaultTeamId: "team_PRO" },
  currentTeam: "team_PRO",
  tokenValid: true,
  cliJson: true,
  rmIgnoresInput: false,
  teams: [{ id: "team_PRO", slug: "equipe-pro", name: "Equipe Pro" }],
  projects: [{ id: "prj_SITE", name: "recette-coffre", accountId: "team_PRO" }],
  calls: [],
});
let etat = compte();
const serveur = createServer((req, res) => {
  const r = fakeRest(etat, req.method, `http://127.0.0.1${req.url}`, req.headers.authorization);
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(r.body === undefined ? "" : JSON.stringify(r.body));
});
await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
const API = `http://127.0.0.1:${serveur.address().port}`;

/** Un dossier personnel de recette. `coffre` : "verrouille" (aucune session) ou "expire". */
function maison(coffre) {
  const dir = mkdtempSync(join(racine, "maison-"));
  if (coffre === "expire") {
    mkdirSync(join(dir, ".hypervibe"), { recursive: true });
    const ilYaTreizeHeures = Math.floor(Date.now() / 1000) - 13 * 3600;
    writeFileSync(join(dir, ".hypervibe", "bw-session"), `${ilYaTreizeHeures}\nsession-de-recette\n`);
  }
  return dir;
}

// Le faux `bw` : il note ce qu'il reçoit (la session de recette dans son environnement, ou non).
const FAUX_BW = join(racine, "faux-bw.mjs");
writeFileSync(
  FAUX_BW,
  'import { appendFileSync } from "node:fs";\n' +
    "appendFileSync(process.env.FAKE_BW_LOG, JSON.stringify({ argv: process.argv.slice(2), session: process.env.BW_SESSION === 'session-de-recette' }) + '\\n');\n" +
    "process.stdout.write('Your vault is locked.\\n');\n",
);
const appelsBw = (dossier) => {
  const log = join(dossier, "faux-bw.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

function environnement(dossier) {
  const env = { ...process.env, HOME: dossier, USERPROFILE: dossier, APPDATA: join(dossier, "appdata"), XDG_DATA_HOME: join(dossier, "appdata"), VERCEL_TOKEN: GOOD_TOKEN, HYPERVIBE_VERCEL_API: API, HYPERVIBE_BW_STANDIN: FAUX_BW, FAKE_BW_LOG: join(dossier, "faux-bw.log") };
  for (const k of CLES) delete env[k];
  return env;
}

function lancer(script, args, coffre) {
  const dossier = maison(coffre);
  const env = environnement(dossier);
  return new Promise((fini) => {
    const p = spawn(process.execPath, [script, ...args], { env, cwd: racine });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => {
      let rapport = null;
      try {
        rapport = JSON.parse(stdout);
      } catch {
        /* dit par les contrôles */
      }
      fini({ code, stdout, stderr, rapport, dossier });
    });
  });
}

function executer(inventaire, perimetre, coffre) {
  const fichier = join(racine, `inventaire-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fichier, JSON.stringify(inventaire));
  etat = compte();
  return lancer(EXECUTE, ["--inventory", fichier, "--scope", JSON.stringify(perimetre), "--confirm", inventaire.project], coffre);
}

const site = { found: true, names: [], ambiguous: false, projects: [{ id: "prj_SITE", name: "recette-coffre", teamId: "team_PRO", teamSlug: "equipe-pro", teamName: "equipe-pro", personal: false, via: "link" }] };
const base = { found: true, projects: [{ id: "recette-inexistant", name: "recette-coffre" }] };
const siteLa = () => etat.projects.some((p) => p.id === "prj_SITE");
const suppressions = () => etat.calls.filter((c) => c.method === "DELETE").length;
const dit = (r) => `code ${r.code} | ${r.stderr.slice(-300)} | ${r.stdout.slice(0, 200)}`;

try {
  // Aucune clé de fournisseur ne doit être lisible hors du coffre : sinon un script irait
  // jusqu'au fournisseur, ce qu'une recette ne fait jamais.
  const lisibles = CLES.filter((nom) => {
    const r = spawnSync(process.execPath, [READ_ENV, nom], { env: environnement(maison("verrouille")), encoding: "utf8" });
    return r.status === 0 && (r.stdout || "").trim() !== "";
  });

  if (lisibles.length > 0) {
    console.log(`skip les scripts ne sont pas lancés : ${lisibles.join(", ")} est lisible hors du coffre sur cette machine`);
  } else {
    console.log("── L'exécution, coffre fermé ──");
    let r = await executer({ project: "recette-coffre", vercel: site, neon: base }, ["vercel", "neon"], "verrouille");
    check("coffre verrouillé, une base à supprimer : refus, code 2", r.code === 2, dit(r));
    check("... qui dit le coffre, ce qui attend sa clé, et que rien n'est supprimé", /verrouille/.test(r.stderr) && /neon/.test(r.stderr) && /NEON/.test(r.stderr) && /RIEN n'est supprime/.test(r.stderr), r.stderr);
    check("... le site est toujours chez son hébergeur, aucune suppression ne lui a été demandée", siteLa() && suppressions() === 0, JSON.stringify(etat.calls));
    check("... et aucun compte rendu n'est écrit (rien n'a tourné)", r.stdout.trim() === "", r.stdout.slice(0, 200));

    r = await executer({ project: "recette-coffre", vercel: site, neon: base }, ["vercel", "neon"], "expire");
    check("coffre expiré : refus (code 3, ou 2 une fois la session verrouillée par la première lecture), le site intact", (r.code === 3 || r.code === 2) && /expire|verrouille/.test(r.stderr) && siteLa() && suppressions() === 0, dit(r));
    const verrou = appelsBw(r.dossier);
    check("... et la session expirée a été verrouillée pour de vrai : bw lock, sa session dans l'environnement, son fichier retiré", verrou.length >= 1 && verrou.every((c) => c.argv.join(" ") === "lock" && c.session) && !existsSync(join(r.dossier, ".hypervibe", "bw-session")), JSON.stringify(verrou));

    r = await executer({ project: "recette-coffre", vercel: site, neon: base }, ["all"], "verrouille");
    check("périmètre « tout » : même refus", r.code === 2 && siteLa(), dit(r));

    console.log("\n── Ce qui ne demande aucune clé passe, coffre fermé ──");
    r = await executer({ project: "recette-coffre", vercel: site, neon: base }, ["vercel"], "verrouille");
    check("périmètre limité au site : il est supprimé, code 0 (la base n'est pas dans le périmètre)", r.code === 0 && !siteLa() && r.rapport?.deleted?.vercel?.results?.[0]?.status === "deleted", dit(r));

    r = await executer({ project: "recette-coffre", vercel: site, neon: { found: false } }, ["vercel", "neon"], "verrouille");
    check("un projet qui n'a qu'un site : supprimé, code 0 (rien n'attend de clé)", r.code === 0 && !siteLa(), dit(r));

    console.log("\n── L'inventaire, coffre fermé ──");
    const projet = mkdtempSync(join(racine, "projet-"));
    r = await lancer(DISCOVER, ["--project", "recette-coffre", "--project-dir", projet], "verrouille");
    check("coffre verrouillé, aucune clé ailleurs : refus d'entrée, code 2, rien sur la sortie standard", r.code === 2 && r.stdout.trim() === "" && /vault is locked/.test(r.stderr), dit(r));
    r = await lancer(DISCOVER, ["--project", "recette-coffre", "--project-dir", projet], "expire");
    check("coffre expiré : refus d'entrée (code 3, ou 2 une fois la session verrouillée par la première lecture), rien sur la sortie standard", (r.code === 3 || r.code === 2) && r.stdout.trim() === "" && /vault is (?:expired|locked)/.test(r.stderr), dit(r));
    check("... et la session expirée a été verrouillée pour de vrai, son fichier retiré", appelsBw(r.dossier).some((c) => c.argv.join(" ") === "lock" && c.session) && !existsSync(join(r.dossier, ".hypervibe", "bw-session")), JSON.stringify(appelsBw(r.dossier)));

    console.log("\n── La mémoire : ce qui est gardé n'est pas dit supprimé ──");
    const memoire = mkdtempSync(join(racine, "memoire-"));
    writeFileSync(join(memoire, "notes.md"), "une note qui cite recette-coffre en passant\n");
    writeFileSync(join(memoire, "project_recette-coffre.md"), "la fiche du projet\n");
    const cite = { dir: memoire, filename: "notes.md", path: join(memoire, "notes.md"), isProjectSpecific: false };
    const fiche = { dir: memoire, filename: "project_recette-coffre.md", path: join(memoire, "project_recette-coffre.md"), isProjectSpecific: true };
    r = await executer({ project: "recette-coffre", memory: { files: [cite] } }, ["memory"], "verrouille");
    const gardee = r.rapport?.skipped?.memory;
    check("un fichier qui cite le projet sans lui appartenir : gardé, et la catégorie est « skipped », pas « deleted »", r.code === 0 && gardee?.status === "skipped" && /1 file\(s\) mention the project and were kept for review/.test(gardee?.reason || "") && !r.rapport?.deleted?.memory && existsSync(cite.path), dit(r));
    check("... le compte rendu garde la liste de ce qui est à relire", gardee?.results?.[0]?.status === "kept", JSON.stringify(gardee));
    r = await executer({ project: "recette-coffre", memory: { files: [cite, fiche] } }, ["memory"], "verrouille");
    check("la fiche du projet, elle, part : la catégorie est « deleted », la note reste", r.rapport?.deleted?.memory?.status === "deleted" && !existsSync(fiche.path) && existsSync(cite.path), dit(r));
  }

  console.log("\n── Les règles de l'inventaire ──");
  check("les variables que l'hébergeur et l'outillage posent d'eux-mêmes sont mises de côté", ["VERCEL_GIT_COMMIT_SHA", "VERCEL_OIDC_TOKEN", "VERCEL_URL", "TURBO_TEAM", "NX_DAEMON"].every(isSystemVar));
  check("... pas un compte (NX_CLOUD_*), ni une variable du projet qui leur ressemble", !["NX_CLOUD_ACCESS_TOKEN", "DATABASE_URL", "MY_VERCEL_TOKEN", "NEXT_PUBLIC_VERCEL_URL", "TURBOPACK"].some(isSystemVar));
  check("une variable Stripe est reconnue, publique ou non", ["STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"].every(isStripeVar) && !isStripeVar("MY_STRIPE_KEY"));

  let stripe = { found: false, error: "STRIPE_SECRET_KEY missing" };
  check("sans clé, un projet qui ne cite Stripe nulle part : « skipped », plus d'erreur", settleStripeWithoutKey(stripe, { hasStripeVar: false, dependencies: ["next"], manifestKinds: ["vercel-project"] }) === true && stripe.skipped === "project has no Stripe" && !("error" in stripe) && stripe.found === false && stripe.webhooksFound === false, JSON.stringify(stripe));
  for (const [nom, contexte] of [
    ["une de ses variables", { hasStripeVar: true }],
    ["le paquet", { dependencies: ["next", "stripe"] }],
    ["un webhook qu'il déclare", { manifestKinds: ["stripe-webhook"] }],
  ]) {
    stripe = { found: false, error: "STRIPE_SECRET_KEY missing" };
    check(`sans clé, un projet qui cite Stripe (${nom}) : l'erreur reste, ses webhooks n'ont pas pu être listés`, settleStripeWithoutKey(stripe, contexte) === false && stripe.error === "STRIPE_SECRET_KEY missing" && !("skipped" in stripe), JSON.stringify(stripe));
  }

  console.log("\n── Ce que disent les scripts et la skill ──");
  const exec = readFileSync(EXECUTE, "utf8");
  check("l'exécution décide du coffre avant la première suppression", exec.indexOf("const unread = KEYED") > 0 && exec.indexOf("const unread = KEYED") < exec.indexOf("const parallelTasks"));
  const disc = readFileSync(DISCOVER, "utf8");
  check("l'inventaire refuse avant le premier balayage, et passe par les règles tenues ici", disc.includes('from "./_inventory-rules.mjs"') && disc.indexOf("No inventory was written") > 0 && disc.indexOf("No inventory was written") < disc.indexOf("async function scanStripe"));
  const skill = readFileSync(join(ROOT, "skills", "delete-project", "SKILL.md"), "utf8");
  check("la skill rouvre le coffre avant l'exécution, et lit le code de sortie", /Open the vault again first/.test(skill) && /CODE=\$\?/.test(skill));
  check("... l'inventaire n'est retiré que sur un code 0", /if \[ "\$CODE" = "0" \]; then rm -f "\$INV" "\$REPORT"/.test(skill));
  check("... et les codes 2, 3 et 7 y sont dits", /\*\*`2` or `3`\*\*/.test(skill) && /\*\*`7`\*\*/.test(skill));
} finally {
  serveur.closeAllConnections?.();
  await new Promise((ok) => serveur.close(() => ok()));
  try {
    rmSync(racine, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    // Un script lancé plus haut tient encore le dossier (il n'a pas refusé d'entrée et balaie
    // encore) : le dire plutôt que de masquer le compte des contrôles derrière ce nettoyage.
    console.log(`note : le dossier de recette n'a pas pu être retiré (${e.code}) : ${racine}`);
  }
}

console.log(`\n${checks - failures}/${checks} verifications`);
process.exitCode = failures ? 1 : 0;
