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
// Depuis la 3.4.17, une section dont le service n'a pas de compte sur ce poste (Upstash sans
// ~/.upstash.json, une clé que le coffre dit ne pas avoir, l'hébergeur sans aucun jeton, aucun
// worker de sauvegarde) se tait (`skipped`) quand rien du projet n'y pointe, et garde son erreur
// sinon : sans quoi la section 1.1 de la skill (un dossier sans rien dans le nuage) restait hors
// d'atteinte sur la plupart des postes. L'inventaire y est lancé pour de vrai, coffre verrouillé,
// avec une clé Render de recette à laquelle répond le faux réseau (_fake-net.mjs), une fausse
// commande `vercel` qui ne connaît aucun compte et une fausse `gh` : aucun service, aucun outil de
// fournisseur.
//
//   node scripts/tests/test-delete-vault.mjs

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

// ── Un poste sans compte (3.4.17) : une fausse `vercel` qui ne connaît aucun compte, une fausse
// `gh` connectée qui ne trouve aucun dépôt, en tête du PATH ; le faux réseau ne répond qu'à Render.
const FAUX_OUTIL = join(racine, "faux-outil.mjs");
writeFileSync(
  FAUX_OUTIL,
  [
    'import { appendFileSync, writeFileSync } from "node:fs";',
    "const [outil, ...args] = process.argv.slice(2);",
    "appendFileSync(process.env.FAKE_TOOLS_LOG, JSON.stringify({ outil, args }) + '\\n');",
    "if (outil === 'gh' && args[0] === 'api' && args[1] === 'user') { process.stdout.write('recette\\n'); process.exit(0); }",
    "if (outil === 'gh' && args[0] === 'repo' && args[1] === 'view') { process.stderr.write('GraphQL: Could not resolve to a Repository with the name ' + args[2] + '. (repository)\\n'); process.exit(1); }",
    // Les variables de la production, quand le scénario en donne : écrites là où `vercel env pull` écrit.
    "if (outil === 'vercel' && args[0] === 'env' && args[1] === 'pull' && process.env.FAKE_VERCEL_PULL) { writeFileSync(args[2], process.env.FAKE_VERCEL_PULL); process.exit(0); }",
    "if (outil === 'vercel') { process.stderr.write('Error: No existing credentials found. Please run `vercel login` or pass \"--token\"\\n'); process.exit(1); }",
    "process.stderr.write('unexpected: ' + outil + ' ' + args.join(' ') + '\\n'); process.exit(1);",
  ].join("\n"),
);
const BIN_OUTILS = join(racine, "bin");
mkdirSync(BIN_OUTILS, { recursive: true });
for (const outil of ["vercel", "gh"]) {
  if (process.platform === "win32") {
    writeFileSync(join(BIN_OUTILS, `${outil}.cmd`), `@echo off\r\n"${process.execPath}" "${FAUX_OUTIL}" ${outil} %*\r\n`);
  } else {
    writeFileSync(join(BIN_OUTILS, outil), `#!/bin/sh\nexec "${process.execPath}" "${FAUX_OUTIL}" ${outil} "$@"\n`);
    chmodSync(join(BIN_OUTILS, outil), 0o755);
  }
}
const CLE_CHEMIN = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
const FAUX_RESEAU = pathToFileURL(join(ICI, "_fake-net.mjs")).href;

/** L'environnement d'un poste qui n'a de compte chez aucun service, hors une clé Render de recette
 *  (sans elle, l'inventaire refuse d'entrée, coffre verrouillé). */
function environnementSansCompte(dossier) {
  const env = environnement(dossier);
  delete env.VERCEL_TOKEN;
  delete env.HYPERVIBE_VERCEL_API;
  return {
    ...env,
    [CLE_CHEMIN]: `${BIN_OUTILS}${delimiter}${process.env[CLE_CHEMIN] || ""}`,
    LOCALAPPDATA: join(dossier, "localappdata"),
    XDG_CONFIG_HOME: join(dossier, "config"),
    RENDER_API_KEY: "cle-render-de-recette",
    FAKE_TOOLS_LOG: join(dossier, "outils.log"),
    HV_RECETTE_NET: JSON.stringify([["https://api.render.com/v1/services", { status: 200, body: [] }]]),
    HV_RECETTE_NET_LOG: join(dossier, "reseau.log"),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${FAUX_RESEAU}`].filter(Boolean).join(" "),
  };
}

/** Un dossier de projet de recette, dépôt git à lui : la recherche du manifeste s'arrête à sa racine. */
function projetDeRecette(nom, fichiers) {
  const dir = mkdtempSync(join(racine, `projet-${nom}-`));
  spawnSync("git", ["init", "-q", dir], { windowsHide: true });
  for (const [rel, contenu] of Object.entries(fichiers)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), contenu);
  }
  return dir;
}

/** L'inventaire lancé pour de vrai sur un poste sans compte, coffre verrouillé. `pull` : les
 *  variables que la fausse `vercel env pull` donne de la production (aucune par défaut). */
function inventaireSansCompte(projet, nom, { pull = "" } = {}) {
  const dossier = maison("verrouille");
  const env = { ...environnementSansCompte(dossier), ...(pull ? { FAKE_VERCEL_PULL: pull } : {}) };
  return new Promise((fini) => {
    const p = spawn(process.execPath, [DISCOVER, "--project", nom, "--project-dir", projet], { env, cwd: racine });
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
      const lignes = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
      fini({ code, stdout, stderr, rapport, outils: lignes(join(dossier, "outils.log")), reseau: lignes(join(dossier, "reseau.log")) });
    });
  });
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

    console.log("\n── Un poste sans compte chez ces services : la section se tait si rien du projet n'y pointe (3.4.17) ──");
    const vide = projetDeRecette("vide", {
      ".env": 'DATABASE_URL="postgresql://postgres:password@localhost:5432/recette-vide"\nAUTH_SECRET=x\n',
      "package.json": JSON.stringify({ name: "recette-vide", dependencies: { next: "15.0.0", "drizzle-orm": "0.36.0", postgres: "3.4.0" } }),
    });
    let inv = await inventaireSansCompte(vide, "recette-vide");
    const s = inv.rapport ?? {};
    const sans = (section, cle) => !(cle in (section ?? {}));
    check("un dossier sans rien, un poste sans compte Upstash : la section se tait (skipped), plus d'erreur", inv.code === 0 && /no Upstash account/.test(s.upstash?.skipped ?? "") && sans(s.upstash, "error") && s.upstash?.found === false, dit(inv));
    check("... sans aucune connexion chez l'hébergeur (aucun jeton, sa commande ne connaît aucun compte) : de même", /no Vercel sign-in/.test(s.vercel?.skipped ?? "") && sans(s.vercel, "error") && s.vercel?.found === false && inv.outils.some((o) => o.outil === "vercel"), JSON.stringify({ vercel: s.vercel, outils: inv.outils }));
    check("... sans aucun worker de sauvegarde sur ce poste : de même", /no backup worker/.test(s.dbBackup?.skipped ?? "") && s.dbBackup?.isTarget === false && sans(s.dbBackup, "error"), JSON.stringify(s.dbBackup));
    check("... Stripe se tait comme avant (rien du projet n'y pointe)", s.stripe?.skipped === "project has no Stripe", JSON.stringify(s.stripe));
    check("... la section Render, sa clé lue dans l'environnement, balaie normalement (seul le faux réseau a répondu)", s.render?.found === false && sans(s.render, "error") && sans(s.render, "skipped") && inv.reseau.length > 0 && inv.reseau.every((q) => q.url.startsWith("https://api.render.com/")), JSON.stringify({ render: s.render, reseau: inv.reseau }));
    const cloud = ["neon", "workers", "r2", "dns", "emailRouting"];
    check("... un coffre verrouillé n'est jamais « pas de compte » : la base et les quatre sections de Cloudflare gardent leur erreur", cloud.every((k) => /vault is locked/.test(s[k]?.error ?? "") && sans(s[k], "skipped")), JSON.stringify(cloud.map((k) => s[k])));
    check("... et la marque interne n'atteint jamais l'inventaire", inv.stdout.length > 0 && !/noAccount/.test(inv.stdout));

    const pointe = projetDeRecette("pointe", {
      "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { next: "15.0.0", stripe: "17.0.0" } }),
      "apps/web/.vercel/project.json": JSON.stringify({ projectId: "prj_recette", orgId: "team_recette" }),
      ".hypervibe/resources.json": JSON.stringify({ resources: [{ kind: "db-backup", name: "recette-pointe" }] }),
    });
    inv = await inventaireSansCompte(pointe, "recette-pointe", { pull: "UPSTASH_REDIS_REST_URL=https://recette.upstash.io\n" });
    const p = inv.rapport ?? {};
    check("le projet pointe vers Upstash (une variable de sa production, son nom seul lu) : l'erreur reste", inv.code === 0 && p.upstash?.error === "~/.upstash.json missing" && sans(p.upstash, "skipped") && (p.envVars?.sources ?? []).includes("vercel-production"), dit(inv));
    check("... et le fichier tiré de la production est retiré", !existsSync(join(pointe, ".env.delete-check")));
    check("... vers l'hébergeur (le dossier lié de son espace de travail) : l'erreur reste", typeof p.vercel?.error === "string" && sans(p.vercel, "skipped"), JSON.stringify(p.vercel));
    check("... vers une sauvegarde que son manifeste inscrit : l'erreur reste", typeof p.dbBackup?.error === "string" && sans(p.dbBackup, "skipped"), JSON.stringify(p.dbBackup));
    check("... vers Stripe, dans son espace de travail : l'erreur reste, ses webhooks n'ont pas pu être listés", p.stripe?.error === "STRIPE_SECRET_KEY missing" && sans(p.stripe, "skipped"), JSON.stringify(p.stripe));
    check("... et la marque interne n'atteint jamais l'inventaire", inv.stdout.length > 0 && !/noAccount/.test(inv.stdout));
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

  console.log("\n── Pas de compte sur ce poste, rien du projet n'y pointe : les règles (3.4.17) ──");
  const regles = await import(pathToFileURL(join(ROOT, "scripts", "delete-project", "_inventory-rules.mjs")).href);
  const reglesLa = ["readProviderKey", "projectPointers", "readProjectFacts", "settleWithoutAccount", "localConnection"].every((f) => typeof regles[f] === "function");
  check("les règles existent : la lecture d'une clé, ce qui pointe vers un service, la section qui se tait", reglesLa);
  if (reglesLa) {
    const { readProviderKey, projectPointers, readProjectFacts, settleWithoutAccount, localConnection } = regles;

    // La lecture d'une clé, et ce que veut dire son absence.
    const leve = (code) => () => {
      throw Object.assign(new Error(`code ${code}`), code === undefined ? {} : { code });
    };
    const lus = [];
    const env = (valeurs) => (nom) => {
      lus.push(nom);
      return valeurs[nom] ?? "";
    };
    const cle = { item: "SERVICE", field: "api_key", envNames: ["SERVICE_API_KEY", "SERVICE_TOKEN"] };
    let k = readProviderKey(cle, { getSecret: () => "valeur-du-coffre", readEnv: env({}) });
    check("une clé que le coffre donne : elle est lue là, jamais dans l'environnement", k.value === "valeur-du-coffre" && k.absent === false && lus.length === 0, JSON.stringify(k));
    for (const code of [4, 5]) {
      k = readProviderKey(cle, { getSecret: leve(code), readEnv: env({}) });
      check(`le coffre répond qu'il ne l'a pas (code ${code}), aucune variable non plus : clé absente, pas de compte ici`, k.value === "" && k.absent === true, JSON.stringify(k));
    }
    k = readProviderKey(cle, { getSecret: () => "", readEnv: env({}) });
    check("... un champ vide au coffre, aucune variable : absente aussi", k.value === "" && k.absent === true, JSON.stringify(k));
    k = readProviderKey(cle, { getSecret: leve(4), readEnv: env({ SERVICE_TOKEN: "valeur-de-l-environnement" }) });
    check("... mais une variable qui la tient la donne (la seconde nommée, la première vide)", k.value === "valeur-de-l-environnement" && k.absent === false, JSON.stringify(k));
    for (const [code, quoi] of [[2, "un coffre verrouillé (2)"], [3, "un coffre expiré (3)"], [1, "une lecture du coffre ratée (1)"], [undefined, "une erreur sans code"]]) {
      k = readProviderKey(cle, { getSecret: leve(code), readEnv: env({}) });
      check(`${quoi} ne rend jamais une clé absente : elle y est peut-être`, k.value === "" && k.absent === false, JSON.stringify(k));
    }

    // Ce qui pointe vers chaque service.
    const rien = projectPointers({});
    check("un projet sans rien : rien ne pointe vers aucun service", ["upstash", "render", "neon", "vercel", "cloudflare", "backup"].every((x) => Array.isArray(rien[x]) && rien[x].length === 0), JSON.stringify(rien));
    const t3 = projectPointers({ varNames: ["DATABASE_URL", "AUTH_SECRET", "NODE_ENV"], dependencies: ["next", "react", "drizzle-orm", "postgres", "@trpc/server"], connections: [{ name: "DATABASE_URL", where: "local" }] });
    check("... ni l'échafaudage d'une application, sa base sur ce poste (des paquets communs, une connexion vers localhost)", Object.values(t3).every((w) => w.length === 0), JSON.stringify(t3));
    for (const [service, quoi, faits] of [
      ["upstash", "une variable", { varNames: ["UPSTASH_REDIS_REST_URL"] }],
      ["upstash", "une variable du magasin KV", { varNames: ["KV_REST_API_TOKEN"] }],
      ["upstash", "un de ses paquets", { dependencies: ["@upstash/ratelimit"] }],
      ["upstash", "le magasin KV de l'hébergeur", { dependencies: ["@vercel/kv"] }],
      ["upstash", "une base que le manifeste inscrit", { manifestKinds: ["upstash-db"] }],
      ["render", "une variable", { varNames: ["RENDER_API_KEY"] }],
      ["render", "son fichier", { files: ["render.yaml"] }],
      ["render", "un service que le manifeste inscrit", { manifestKinds: ["render-service"] }],
      ["neon", "une variable", { varNames: ["NEON_API_KEY"] }],
      ["neon", "son paquet", { dependencies: ["@neondatabase/serverless"] }],
      ["neon", "une base que le manifeste inscrit", { manifestKinds: ["neon-project"] }],
      ["neon", "une connexion vers une base en ligne", { connections: [{ name: "DATABASE_URL", where: "cloud" }] }],
      ["neon", "une connexion de la production, dont la valeur n'est pas lue", { connections: [{ name: "DATABASE_URL", where: "unknown" }] }],
      ["vercel", "le dossier lié", { files: [".vercel/project.json"] }],
      ["vercel", "le dossier lié d'un espace de travail", { files: ["apps/web/.vercel/project.json"] }],
      ["vercel", "son fichier de réglages", { files: ["vercel.json"] }],
      ["vercel", "un de ses paquets", { dependencies: ["@vercel/analytics"] }],
      ["vercel", "un site que le manifeste inscrit", { manifestKinds: ["vercel-project"] }],
      ["cloudflare", "une variable du stockage", { varNames: ["R2_BUCKET_NAME"] }],
      ["cloudflare", "l'identifiant du compte", { varNames: ["CLOUDFLARE_ACCOUNT_ID"] }],
      ["cloudflare", "son outil", { dependencies: ["wrangler"] }],
      ["cloudflare", "le fichier d'un Worker", { files: ["wrangler.toml"] }],
      ["cloudflare", "un compartiment que le manifeste inscrit", { manifestKinds: ["r2-bucket"] }],
      ["cloudflare", "une zone que le manifeste inscrit", { manifestKinds: ["dns-zone"] }],
      ["backup", "une sauvegarde que le manifeste inscrit", { manifestKinds: ["db-backup"] }],
    ]) {
      const w = projectPointers(faits);
      check(`${service} : ${quoi} y pointe`, w[service].length === 1, JSON.stringify(w[service]));
    }
    const illisible = projectPointers({ unreadable: ["apps/web/package.json"] });
    check("un fichier du projet illisible pointe partout : ce qu'il dit est inconnu", Object.values(illisible).every((w) => w.length === 1), JSON.stringify(illisible));
    check("une connexion vers ce poste, ou un gabarit, ne lie le projet à aucune base en ligne", ["postgresql://postgres:password@localhost:5432/app", "postgres://u:p@127.0.0.1:5432/db", "", "localhost", "file:./dev.db", "postgresql://<user>:<password>@<host>/<db>", "postgresql://user:password@placeholder:5432/db"].every((v) => localConnection(v)));
    check("... une base en ligne, si, même nommée comme un gabarit en minuscules", !["postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/app?sslmode=require", "postgresql://u:p@db.abcd.supabase.co:5432/postgres", "postgresql://u:p@ep-x.neon.tech/your_app"].some((v) => localConnection(v)) && localConnection("postgresql://YOUR_USER:YOUR_PASSWORD@YOUR_HOST/db"));

    // La section qui se tait, ou qui garde son erreur.
    const sansCompte = () => ({
      upstash: { found: false, error: "~/.upstash.json missing", noAccount: true },
      render: { found: false, error: "RENDER_API_KEY missing", noAccount: true },
      neon: { found: false, error: "NEON_API_KEY missing", noAccount: true },
      vercel: { found: false, names: [], projects: [], error: "REST: no Vercel token (run `vercel login`)", noAccount: true },
      workers: { found: false, error: "CLOUDFLARE_API_TOKEN missing", noAccount: true },
      r2: { found: false, buckets: [], error: "CLOUDFLARE_API_TOKEN missing", noAccount: true },
      dns: { found: false, error: "CLOUDFLARE_API_TOKEN missing", noAccount: true },
      emailRouting: { found: false, error: "CLOUDFLARE_API_TOKEN missing", noAccount: true },
      dbBackup: { isTarget: false, error: "wrangler.toml not found", source: "db-backup-worker", noAccount: true },
    });
    let sections = sansCompte();
    let tues = settleWithoutAccount(sections, projectPointers({}));
    check("aucun compte sur ce poste, un projet qui ne pointe nulle part : les neuf sections se taisent, chacune avec sa raison", tues.length === 9 && Object.values(sections).every((x) => typeof x.skipped === "string" && x.skipped !== "" && !("error" in x) && !("noAccount" in x)) && sections.dbBackup.isTarget === false && sections.vercel.found === false, JSON.stringify(sections));
    sections = sansCompte();
    tues = settleWithoutAccount(sections, projectPointers({ dependencies: ["@upstash/redis"], files: ["wrangler.toml"] }));
    check("le projet pointe vers Upstash et Cloudflare : ces cinq sections gardent leur erreur, les quatre autres se taisent", tues.join() === "render,neon,vercel,dbBackup" && sections.upstash.error === "~/.upstash.json missing" && ["workers", "r2", "dns", "emailRouting"].every((n) => sections[n].error && !("skipped" in sections[n])) && !Object.values(sections).some((x) => "noAccount" in x), JSON.stringify({ tues, sections }));
    const lue = { upstash: { found: false, error: "HTTP 500" }, neon: { found: false, error: "NEON_API_KEY unavailable: the vault is locked (unlock it with _ensure-vault, then run the inventory again)" } };
    tues = settleWithoutAccount(lue, projectPointers({}));
    check("une lecture ratée, un coffre fermé (jamais marqués « pas de compte ») restent des erreurs, même sans rien du projet", tues.length === 0 && lue.upstash.error === "HTTP 500" && /vault is locked/.test(lue.neon.error) && !("skipped" in lue.upstash), JSON.stringify(lue));
    check("... et une section absente de l'inventaire ne gêne pas", settleWithoutAccount({}, projectPointers({})).length === 0);

    // Les faits, lus dans le dossier du projet et ses espaces de travail.
    const faits = mkdtempSync(join(racine, "faits-"));
    const ecrire = (rel, contenu) => {
      mkdirSync(dirname(join(faits, rel)), { recursive: true });
      writeFileSync(join(faits, rel), contenu);
    };
    ecrire(".env", 'DATABASE_URL="postgresql://postgres:password@localhost:5432/app"\nAUTH_SECRET=valeur-secrete-de-recette\n');
    ecrire(".env.local", "export UPSTASH_REDIS_REST_TOKEN='valeur-secrete-de-recette'\n");
    ecrire("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    ecrire("apps/web/package.json", JSON.stringify({ devDependencies: { "@neondatabase/serverless": "0.10.0" } }));
    ecrire("apps/web/.env", "DATABASE_URL=postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/app\n");
    ecrire("apps/web/.vercel/project.json", "{}");
    ecrire("packages/casse/package.json", "{ pas du json");
    const f = readProjectFacts(faits, { pulledVarNames: ["POSTGRES_URL"], manifestKinds: ["upstash-db", "upstash-db"] });
    check("les faits : les noms des variables de .env et .env.local (export compris), et ceux de la production", ["DATABASE_URL", "AUTH_SECRET", "UPSTASH_REDIS_REST_TOKEN", "POSTGRES_URL"].every((v) => f.varNames.includes(v)), JSON.stringify(f.varNames));
    check("... chaque connexion dite sur ce poste, en ligne ou inconnue (la production), jamais sa valeur", JSON.stringify(f.connections) === JSON.stringify([{ name: "POSTGRES_URL", where: "unknown" }, { name: "DATABASE_URL", where: "local" }, { name: "DATABASE_URL", where: "cloud" }]) && !JSON.stringify(f).includes("valeur-secrete-de-recette") && !JSON.stringify(f).includes("ep-x."), JSON.stringify(f.connections));
    check("... les paquets et les fichiers des espaces de travail (apps/*, packages/*)", f.dependencies.includes("next") && f.dependencies.includes("@neondatabase/serverless") && f.files.includes("apps/web/.vercel/project.json"), JSON.stringify(f));
    check("... un fichier illisible dit comme tel, les entrées du manifeste une fois chacune", JSON.stringify(f.unreadable) === JSON.stringify(["packages/casse/package.json"]) && JSON.stringify(f.manifestKinds) === JSON.stringify(["upstash-db"]), JSON.stringify(f));
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

  // 3.4.17 : la base, Render et les quatre sections de Cloudflare ne peuvent être jouées « clé
  // absente » de bout en bout (il faudrait un coffre ouvert qui réponde, et une recette ne lance
  // jamais son outil) : leur branchement se lit dans le source ; Upstash, l'hébergeur et les
  // sauvegardes sont joués plus haut.
  check("l'inventaire lit ses trois clés par readProviderKey, plus par une lecture qui ne sait pas dire « absente »", (disc.match(/readProviderKey\(\{ item: "(?:CLOUDFLARE|NEON|RENDER)"/g) ?? []).length === 3 && !/try \{ return getSecret\("(?:CLOUDFLARE|NEON|RENDER)"/.test(disc));
  check("... marque « pas de compte ici » la base, Render et les quatre sections de Cloudflare sur une clé absente", (disc.match(/\.\.\.noAccountIf\(CLOUDFLARE_KEY\)/g) ?? []).length === 4 && (disc.match(/\.\.\.noAccountIf\(NEON_KEY\)/g) ?? []).length === 1 && (disc.match(/\.\.\.noAccountIf\(RENDER_KEY\)/g) ?? []).length === 1 && /const noAccountIf = \(key\) => \(key\.absent \? \{ noAccount: true \} : \{\}\);/.test(disc));
  check("... Upstash sans son fichier, l'hébergeur sans aucun jeton, les sauvegardes sans aucun worker", /error: "~\/\.upstash\.json missing", noAccount: true \}/.test(disc) && /\.\.\.\(vercelCtx\.token \? \{\} : \{ noAccount: true \}\)/.test(disc) && /!unified\.exists && noLegacyWorker \? \{ \.\.\.legacy, noAccount: true \}/.test(disc));
  check("... et règle les neuf sections, après le manifeste, sur ce qui pointe vers chaque service", /settleWithoutAccount\(\{ upstash, render, neon, vercel, workers, r2, dns, emailRouting, dbBackup \}, projectPointers\(projectFacts\)\)/.test(disc) && disc.indexOf("settleWithoutAccount({") > disc.indexOf("const manifestReport = await reconcileManifest();"));
  const section11 = skill.slice(skill.indexOf("### 1.1 An empty cloud inventory"), skill.indexOf("## Phase 2"));
  check("la skill : un inventaire vide dans le nuage compte les sections qui se taisent, et nomme les services qui n'ont pas été regardés", /A section with `skipped` counts as one that found nothing/.test(section11) && /no account/.test(section11) && /not looked at/.test(section11));
  const section23b = skill.slice(skill.indexOf("### 2.3b"), skill.indexOf("### 2.4"));
  check("... la section des balayages qui n'ont pas pu tourner ne dit rien d'une section qui se tait, et garde celles où le projet pointe", /`skipped`/.test(section23b) && /no account at that service/.test(section23b) && /keeps its `error`/.test(section23b));
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
