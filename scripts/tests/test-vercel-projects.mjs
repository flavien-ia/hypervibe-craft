#!/usr/bin/env node
/**
 * Recette : trouver, lister et supprimer un projet Vercel dans la bonne équipe.
 *
 * Le 17/09/2026, /delete-project a lancé `vercel project rm <nom>` sans équipe :
 * le projet vivait dans l'équipe gratuite du compte, la CLI était réglée sur
 * l'équipe Pro, et la suppression aurait échoué (ou, avec un homonyme dans
 * l'équipe Pro, supprimé le mauvais projet). Le garde-fou de nom de /bootstrap
 * ne lisait que l'équipe courante, première page. Et `bootstrap-init` lisait
 * l'équipe courante et le jeton dans les fichiers d'avant la CLI v59, figés.
 *
 * Tout se joue sur un faux compte (_fake-vercel.mjs) : deux équipes, 154
 * projets, un homonyme, un jeton qui peut expirer, une CLI qui peut être
 * ancienne. Aucun accès réseau (le faux serveur écoute sur 127.0.0.1), aucun
 * vrai compte : la fausse CLI est placée en tête du PATH des processus lancés.
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteProject,
  getProject,
  listAllProjects,
  parseProjectTable,
  pickTargets,
  vercelApiBase,
  vercelContext,
} from "../_vercel-projects.mjs";
import { getCliDataDirCandidates, loadAuthToken, readCliCurrentTeam } from "../_vercel-auth.mjs";
import { fakeCli, fakeRest, GOOD_TOKEN } from "./_fake-vercel.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const ROOT = join(ICI, "..", "..");
const EXECUTE = join(ROOT, "scripts", "delete-project", "execute-deletions.mjs");
const FAKE_CLI = join(ICI, "_fake-vercel.mjs");

let echecs = 0;
let total = 0;
const verifier = (nom, condition, detail = "") => {
  total += 1;
  if (condition) console.log(`  ok   ${nom}`);
  else {
    echecs += 1;
    console.log(`  ECHEC ${nom}${detail ? ` : ${detail}` : ""}`);
  }
};
const egal = (nom, obtenu, attendu) =>
  verifier(nom, obtenu === attendu, `obtenu ${JSON.stringify(obtenu)}, attendu ${JSON.stringify(attendu)}`);
const lire = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ─── le faux compte ────────────────────────────────────────────────────────
function compte({ northstar = true, tokenValid = true, cliJson = true } = {}) {
  const projects = [
    { id: "prj_SITE", name: "site-vitrine", accountId: "team_PRO" },
    { id: "prj_HOMO_PRO", name: "atelier", accountId: "team_PRO" },
    { id: "prj_HOMO_FREE", name: "atelier", accountId: "team_FREE" },
    { id: "prj_SEUL_FREE", name: "atelier-recherche", accountId: "team_FREE" },
  ];
  // Assez de projets pour exiger deux pages de 100.
  for (let i = 0; i < 150; i++) projects.push({ id: `prj_R${i}`, name: `remplissage-${i}`, accountId: "team_PRO" });
  if (!northstar) projects.push({ id: "prj_PERSO", name: "perso", accountId: "user_1" });
  return {
    user: {
      id: "user_1",
      username: "alice",
      ...(northstar ? { version: "northstar", defaultTeamId: "team_PRO" } : {}),
    },
    currentTeam: "team_PRO",
    tokenValid,
    cliJson,
    rmIgnoresInput: false,
    teams: [
      { id: "team_PRO", slug: "equipe-pro", name: "Equipe Pro" },
      { id: "team_FREE", slug: "equipe-gratuite", name: "Equipe gratuite" },
    ],
    projects,
    calls: [],
  };
}

function contexte(state, { token = GOOD_TOKEN, currentTeam = state.currentTeam } = {}) {
  return vercelContext({
    token,
    apiBase: "http://api.recette.invalid",
    currentTeam,
    fetchImpl: async (url, opts = {}) => {
      const r = fakeRest(state, opts.method || "GET", url, opts.headers?.Authorization);
      return { status: r.status, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) };
    },
    cli: async (cmd, args, opts = {}) => fakeCli(state, args, opts.input || ""),
  });
}

const existe = (state, id) => state.projects.some((p) => p.id === id);
const appelsRm = (state) => state.calls.filter((c) => c.via === "cli" && c.args[0] === "project" && c.args[1] === "rm");

// ─── 1. Lister tout le compte ──────────────────────────────────────────────
console.log("\nLister tout le compte, par l'API");
{
  const state = compte();
  const r = await listAllProjects(contexte(state));
  egal("l'API répond", r.via, "rest");
  egal("les 154 projets, sur deux pages", r.projects.length, 154);
  const seul = r.projects.find((p) => p.id === "prj_SEUL_FREE");
  egal("un projet de l'équipe gratuite porte son équipe", seul?.teamId, "team_FREE");
  egal("et son nom court", seul?.teamSlug, "equipe-gratuite");
  egal("un projet de l'équipe Pro porte la sienne", r.projects.find((p) => p.id === "prj_SITE")?.teamId, "team_PRO");
  verifier("un compte actuel n'a pas de portée personnelle", r.scopes.every((s) => !s.personal));
  egal("aucune équipe en échec", r.partial, false);
}

console.log("\nLister un compte ancien (portée personnelle)");
{
  const state = compte({ northstar: false });
  const r = await listAllProjects(contexte(state));
  const perso = r.projects.find((p) => p.id === "prj_PERSO");
  egal("le projet personnel est trouvé", perso?.personal, true);
  egal("sans équipe", perso?.teamId, null);
  egal("avec le nom du compte comme portée", perso?.teamSlug, "alice");
  egal("chaque projet une seule fois", new Set(r.projects.map((p) => p.id)).size, r.projects.length);
}

console.log("\nLister quand le jeton est refusé : la CLI, équipe par équipe");
{
  const state = compte({ tokenValid: false });
  const r = await listAllProjects(contexte(state));
  egal("la CLI prend le relais", r.via, "cli");
  egal("les mêmes 154 projets", r.projects.length, 154);
  egal("rattachés à la bonne équipe", r.projects.find((p) => p.id === "prj_HOMO_FREE")?.teamId, "team_FREE");
  egal("le refus de la portée personnelle n'est pas une erreur", r.partial, false);
  const listes = state.calls.filter((c) => c.via === "cli" && c.args[1] === "ls" && c.args[0] === "project");
  verifier("chaque liste de projets nomme sa portée", listes.length > 0 && listes.every((c) => c.args.includes("--scope")));
  const json = state.calls.filter((c) => c.via === "cli" && (c.args.includes("--json") || c.args.includes("--format")));
  verifier("la CLI est lue par l'option que documente la 64 (--json)", json.length > 0 && json.every((c) => c.args.includes("--json") && !c.args.includes("--format")), json.map((c) => c.args.join(" ")).join(" | "));
}

console.log("\nUne CLI qui connaît --format json mais pas encore --json");
{
  const state = compte({ tokenValid: false });
  state.cliJsonFlag = false;
  const r = await listAllProjects(contexte(state));
  egal("elle répond quand même en JSON, équipe par équipe", r.via, "cli");
  egal("les mêmes 154 projets", r.projects.length, 154);
  verifier("redemandée une fois avec --format json", state.calls.some((c) => c.via === "cli" && c.args.includes("--format") && c.args.includes("json")));
}

console.log("\nLister avec une CLI ancienne, sans sortie JSON");
{
  const state = compte({ tokenValid: false, cliJson: false });
  const r = await listAllProjects(contexte(state));
  egal("repli sur le tableau", r.via, "cli-table");
  egal("signalé comme partiel", r.partial, true);
  verifier("la raison dit qu'une seule équipe a été lue", /only the team/.test(r.partialReason || ""), r.partialReason);
  verifier("les 152 projets de l'équipe courante, pages suivies", r.projects.length === 152, `${r.projects.length}`);
  verifier("rattachés à l'équipe courante, sans identifiant", r.projects.every((p) => p.teamId === "team_PRO" && p.id === null && p.legacy));
}

console.log("\nLecture du tableau de la CLI");
{
  const tableau = "Vercel CLI 59.0.0\n> Projects found under x\n\n  Project Name   Latest Production URL   Updated\n  mon-site   https://mon-site.vercel.app   1d\n  Autre_Site   https://a.vercel.app   2d\n\nTo display the next page, run `vercel project ls --next 17837`\n";
  const noms = parseProjectTable(tableau);
  verifier("les noms sont lus et normalisés", noms.includes("mon-site") && noms.includes("autre-site"), JSON.stringify(noms));
  verifier("la décoration est ignorée", !noms.includes("vercel") && !noms.includes("project") && !noms.includes("to"), JSON.stringify(noms));
}

// ─── 2. Choisir la cible ───────────────────────────────────────────────────
console.log("\nChoisir la cible");
{
  const state = compte();
  const { projects } = await listAllProjects(contexte(state));
  const seul = pickTargets({ name: "atelier-recherche", projects });
  egal("un nom unique : une cible", seul.targets.length, 1);
  egal("dans l'équipe gratuite, pas celle de la CLI", seul.targets[0]?.teamId, "team_FREE");
  egal("pas d'ambiguïté", seul.ambiguous, false);

  const homonymes = pickTargets({ name: "atelier", projects });
  egal("un nom présent dans deux équipes : deux candidats", homonymes.targets.length, 2);
  egal("c'est un choix pour l'utilisateur", homonymes.ambiguous, true);

  const lien = { projectId: "prj_HOMO_FREE", status: "found", project: projects.find((p) => p.id === "prj_HOMO_FREE") };
  const lie = pickTargets({ name: "atelier", linked: lien, projects });
  egal("le lien du dossier désigne LE projet", lie.targets.map((p) => p.id).join(), "prj_HOMO_FREE");
  egal("sans ambiguïté", lie.ambiguous, false);
  egal("l'homonyme de l'autre équipe est signalé, pas visé", lie.homonyms.map((p) => p.id).join(), "prj_HOMO_PRO");

  const renomme = pickTargets({ name: "ancien-nom", linked: lien, projects });
  egal("un projet renommé reste trouvé par le lien", renomme.targets[0]?.id, "prj_HOMO_FREE");
  egal("et le changement de nom est signalé", renomme.nameMismatch, true);

  const douteux = pickTargets({ name: "atelier-recherche", linked: { projectId: "prj_X", status: "unknown" }, projects });
  egal("lien invérifiable + un homonyme : on demande", douteux.ambiguous, true);

  const disparu = pickTargets({ name: "atelier-recherche", linked: { projectId: "prj_X", status: "missing" }, projects });
  egal("lien vers un projet disparu : le nom reprend la main", disparu.targets[0]?.id, "prj_SEUL_FREE");
  egal("marqué comme deviné par son nom", disparu.targets[0]?.via, "name");
}

// ─── 3. Supprimer ──────────────────────────────────────────────────────────
console.log("\nSupprimer par l'API, hors de l'équipe de la CLI");
{
  const state = compte();
  const ctx = contexte(state);
  const cible = { id: "prj_SEUL_FREE", name: "atelier-recherche", teamId: "team_FREE", teamSlug: "equipe-gratuite" };
  const r = await deleteProject(ctx, cible);
  egal("supprimé", r.status, "deleted");
  egal("et vérifié", r.verified, true);
  egal("disparu du compte", existe(state, "prj_SEUL_FREE"), false);
  const del = state.calls.find((c) => c.method === "DELETE");
  egal("la requête nomme l'équipe", del?.teamId, "team_FREE");
  egal("aucun appel à la CLI", state.calls.filter((c) => c.via === "cli").length, 0);

  const encore = await deleteProject(ctx, cible);
  egal("un projet déjà parti est dit absent", encore.status, "absent");
  const homonyme = await deleteProject(ctx, { id: "prj_HOMO_FREE", name: "atelier", teamId: "team_FREE" });
  egal("un homonyme se supprime par son identifiant", homonyme.status, "deleted");
  egal("son jumeau de l'équipe Pro est intact", existe(state, "prj_HOMO_PRO"), true);
}

console.log("\nSupprimer par la CLI quand le jeton est refusé");
{
  const state = compte({ tokenValid: false });
  const r = await deleteProject(contexte(state), { id: "prj_HOMO_FREE", name: "atelier", teamId: "team_FREE" });
  egal("supprimé par la CLI", r.via, "cli");
  egal("et vérifié", r.verified, true);
  egal("le bon projet est parti", existe(state, "prj_HOMO_FREE"), false);
  egal("l'homonyme de l'équipe courante est intact", existe(state, "prj_HOMO_PRO"), true);
  const rm = appelsRm(state);
  egal("une seule commande de suppression", rm.length, 1);
  verifier("elle nomme l'équipe", rm[0]?.args.join(" ") === "project rm atelier --scope team_FREE", rm[0]?.args.join(" "));
  egal("et répond oui à la confirmation", rm[0]?.input, "y\n");
}

console.log("\nUne confirmation refusée n'est pas une suppression");
{
  const state = compte({ tokenValid: false });
  state.rmIgnoresInput = true;
  const r = await deleteProject(contexte(state), { id: "prj_SEUL_FREE", name: "atelier-recherche", teamId: "team_FREE" });
  egal("échec annoncé malgré le code de sortie 0", r.status, "failed");
  egal("le projet est toujours là", existe(state, "prj_SEUL_FREE"), true);
}

console.log("\nUne CLI ancienne supprime par nom, avec l'équipe explicite");
{
  const state = compte({ tokenValid: false, cliJson: false });
  const ctx = contexte(state);
  const { projects } = await listAllProjects(ctx);
  const cible = projects.find((p) => p.name === "site-vitrine");
  const r = await deleteProject(ctx, cible);
  egal("supprimé", r.status, "deleted");
  egal("sans preuve possible, et c'est dit", r.verified, false);
  verifier("la commande nomme l'équipe courante lue à l'inventaire", appelsRm(state)[0]?.args.join(" ") === "project rm site-vitrine --scope team_PRO", appelsRm(state)[0]?.args.join(" "));
}

console.log("\nUn projet personnel, sans nom de compte, CLI réglée sur une équipe : refus");
{
  const state = compte({ tokenValid: false, northstar: false });
  state.user.username = "";
  const r = await deleteProject(contexte(state), { id: "prj_PERSO", name: "perso", teamId: null, personal: true });
  egal("rien n'est tenté", r.status, "failed");
  egal("aucune commande de suppression", appelsRm(state).length, 0);
  egal("le projet est intact", existe(state, "prj_PERSO"), true);
}

console.log("\nUne CLI qui demande une équipe au lieu de répondre (CLI 64, sans --scope)");
{
  // Un projet personnel, le nom du compte inconnu, la CLI réglée sur la portée personnelle : la
  // liste part sans --scope. La CLI 64 répond alors par une demande de choix, avec un code de
  // sortie de réussite. Lue comme une liste vide, elle disait le projet supprimé (veille, 16/10/2026).
  const state = compte({ tokenValid: false, northstar: false });
  state.user.username = "";
  state.scopeRequired = true;
  const ctx = contexte(state, { currentTeam: null });
  const etat = await getProject(ctx, { id: "prj_PERSO", teamId: null });
  egal("le projet n'est pas dit absent", etat.status, "unknown");
  verifier("la raison dit ce que la CLI a demandé", /asks for a choice[\s\S]*missing_scope/.test(etat.reason || ""), etat.reason);
  const r = await deleteProject(ctx, { id: "prj_PERSO", name: "perso", teamId: null, personal: true });
  verifier("la suppression ne se dit ni faite ni sans objet", r.status === "failed", JSON.stringify(r));
  egal("le projet est toujours là", existe(state, "prj_PERSO"), true);
}

console.log("\nUne réponse sans liste de projets n'est pas une équipe vide");
{
  const state = compte({ tokenValid: false });
  state.listWithoutProjects = true;
  const etat = await getProject(contexte(state), { id: "prj_SEUL_FREE", teamId: "team_FREE" });
  egal("le projet n'est pas dit absent", etat.status, "unknown");
  verifier("la raison dit qu'aucune liste n'est venue", /no project list/.test(etat.reason || ""), etat.reason);
}

console.log("\nÉtat d'un projet");
{
  const state = compte();
  egal("trouvé dans son équipe", (await getProject(contexte(state), { id: "prj_SEUL_FREE", teamId: "team_FREE" })).status, "found");
  egal("absent de l'autre", (await getProject(contexte(state), { id: "prj_SEUL_FREE", teamId: "team_PRO" })).status, "missing");
  const cli = compte({ tokenValid: false, cliJson: false });
  egal("une CLI sans JSON ne conclut jamais à l'absence", (await getProject(contexte(cli), { id: "prj_SEUL_FREE", teamId: "team_FREE" })).status, "unknown");
}

console.log("\nAdresse de l'API");
egal("l'adresse réelle par défaut", vercelApiBase({}), "https://api.vercel.com");
egal("une adresse locale est acceptée", vercelApiBase({ HYPERVIBE_VERCEL_API: "http://127.0.0.1:4321" }), "http://127.0.0.1:4321");
egal("une autre adresse est ignorée", vercelApiBase({ HYPERVIBE_VERCEL_API: "https://ailleurs.example.com" }), "https://api.vercel.com");

// ─── 4. Les fichiers de la CLI : le plus récent gagne ──────────────────────
const racine = mkdtempSync(join(tmpdir(), "hv vercel "));
const ENV_SAUVE = { APPDATA: process.env.APPDATA, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, VERCEL_TOKEN: process.env.VERCEL_TOKEN };
try {
  console.log("\nFichiers de la CLI : le plus récent gagne");
  const donnees = join(racine, "donnees");
  process.env.APPDATA = donnees;
  process.env.HOME = donnees;
  process.env.XDG_DATA_HOME = donnees;
  delete process.env.VERCEL_TOKEN;
  const [recent, ancien] = getCliDataDirCandidates();
  if (process.platform === "win32") verifier("le dossier xdg.data de la CLI v59 est lu", /xdg\.data/.test(recent), recent);
  const ecrire = (dir, fichier, contenu, ilYA) => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, fichier);
    writeFileSync(p, JSON.stringify(contenu));
    const t = new Date(Date.now() - ilYA * 1000);
    utimesSync(p, t, t);
  };
  ecrire(ancien, "config.json", { currentTeam: "team_ANCIENNE" }, 3600);
  ecrire(recent, "config.json", { currentTeam: "team_ACTUELLE" }, 10);
  egal("l'équipe courante vient du fichier le plus récent", readCliCurrentTeam(), "team_ACTUELLE");
  ecrire(recent, "config.json", {}, 5);
  egal("un fichier récent sans équipe l'emporte sur un ancien qui en nomme une", readCliCurrentTeam(), null);
  ecrire(ancien, "auth.json", { token: "jeton-fige" }, 3600);
  ecrire(recent, "auth.json", { token: "jeton-vivant" }, 10);
  egal("le jeton vient du fichier le plus récent", loadAuthToken(), "jeton-vivant");
  ecrire(recent, "auth.json", {}, 5);
  egal("un fichier récent sans jeton ne masque pas l'autre", loadAuthToken(), "jeton-fige");
} finally {
  for (const [k, v] of Object.entries(ENV_SAUVE)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ─── 5. execute-deletions.mjs, lancé pour de vrai ──────────────────────────
// Un faux serveur d'API sur 127.0.0.1 et une fausse CLI en tête du PATH.
const bin = join(racine, "bin");
mkdirSync(bin, { recursive: true });
if (process.platform === "win32") {
  writeFileSync(join(bin, "vercel.cmd"), `@echo off\r\n"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
} else {
  writeFileSync(join(bin, "vercel"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(bin, "vercel"), 0o755);
}
let etatServeur = compte();
const serveur = createServer((req, res) => {
  const r = fakeRest(etatServeur, req.method, `http://127.0.0.1${req.url}`, req.headers.authorization);
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(r.body === undefined ? "" : JSON.stringify(r.body));
});
await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
const API = `http://127.0.0.1:${serveur.address().port}`;
const etatCli = join(racine, "cli-state.json");
const cleChemin = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";

function lancer(inventaire, extra = []) {
  const fichier = join(racine, `inventaire-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fichier, JSON.stringify(inventaire));
  const env = {
    ...process.env,
    [cleChemin]: `${bin}${delimiter}${process.env[cleChemin] || ""}`,
    VERCEL_TOKEN: GOOD_TOKEN,
    HYPERVIBE_VERCEL_API: API,
    FAKE_VERCEL_STATE: etatCli,
    APPDATA: join(racine, "appdata"),
    XDG_DATA_HOME: join(racine, "appdata"),
  };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [EXECUTE, "--inventory", fichier, "--scope", '["vercel"]', ...extra], { env, cwd: racine });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => {
      let rapport = null;
      try {
        rapport = JSON.parse(stdout);
      } catch {
        /* reported by the checks */
      }
      resolve({ status, rapport, stderr });
    });
  });
}
const cible = (id, name, teamId, teamSlug, via = "name") => ({ id, name, teamId, teamSlug, teamName: teamSlug, personal: false, via });
const inventaire = (project, vercel) => ({ project, vercel: { found: true, names: [], ...vercel } });

try {
  console.log("\nexecute-deletions.mjs : un projet hors de l'équipe de la CLI");
  writeFileSync(etatCli, JSON.stringify(compte()));
  {
    const r = await lancer(
      inventaire("atelier-recherche", { projects: [cible("prj_SEUL_FREE", "atelier-recherche", "team_FREE", "equipe-gratuite")], ambiguous: false }),
      ["--confirm", "atelier-recherche"],
    );
    egal("le script se termine", r.status, 0);
    const res = r.rapport?.deleted?.vercel?.results?.[0];
    egal("rapport : supprimé", res?.status, "deleted");
    egal("rapport : vérifié", res?.verified, true);
    egal("rapport : l'équipe est nommée", res?.team, "equipe-gratuite");
    egal("le projet a quitté le compte", existe(etatServeur, "prj_SEUL_FREE"), false);
    egal("la fausse CLI n'a pas servi", JSON.parse(readFileSync(etatCli, "utf8")).calls.length, 0);
  }

  console.log("\nexecute-deletions.mjs : deux homonymes, personne n'a choisi");
  etatServeur = compte();
  {
    const homonymes = [cible("prj_HOMO_PRO", "atelier", "team_PRO", "equipe-pro"), cible("prj_HOMO_FREE", "atelier", "team_FREE", "equipe-gratuite")];
    const r = await lancer(inventaire("atelier", { projects: homonymes, ambiguous: true }), ["--confirm", "atelier"]);
    egal("refus, en attente d'un choix", r.rapport?.failed?.vercel?.needsChoice, true);
    egal("les deux candidats sont proposés", r.rapport?.failed?.vercel?.choices?.length, 2);
    egal("aucune suppression envoyée", etatServeur.calls.filter((c) => c.method === "DELETE").length, 0);

    const choisi = await lancer(inventaire("atelier", { projects: homonymes, ambiguous: true }), ["--confirm", "atelier", "--vercel-project", "prj_HOMO_FREE"]);
    egal("avec un choix : le projet choisi est supprimé", choisi.rapport?.deleted?.vercel?.results?.map((x) => x.id).join(), "prj_HOMO_FREE");
    egal("l'autre reste", existe(etatServeur, "prj_HOMO_PRO"), true);

    const inconnu = await lancer(inventaire("atelier", { projects: homonymes, ambiguous: true }), ["--confirm", "atelier", "--vercel-project", "prj_AILLEURS"]);
    verifier("un choix hors inventaire est refusé", /does not list/.test(inconnu.rapport?.failed?.vercel?.error || ""), inconnu.rapport?.failed?.vercel?.error);
  }

  console.log("\nexecute-deletions.mjs : un projet lié passe, l'homonyme deviné attend");
  etatServeur = compte();
  {
    const r = await lancer(
      inventaire("atelier", {
        projects: [cible("prj_HOMO_FREE", "atelier", "team_FREE", "equipe-gratuite", "link"), cible("prj_HOMO_PRO", "atelier", "team_PRO", "equipe-pro")],
        ambiguous: true,
      }),
      ["--confirm", "atelier", "--vercel-project", "prj_HOMO_FREE"],
    );
    egal("seul le projet lié est supprimé", r.rapport?.deleted?.vercel?.results?.map((x) => x.id).join(), "prj_HOMO_FREE");
    egal("le deviné non choisi reste", existe(etatServeur, "prj_HOMO_PRO"), true);
  }

  console.log("\nexecute-deletions.mjs : un inventaire d'une ancienne version");
  etatServeur = compte();
  {
    const r = await lancer({ project: "atelier-recherche", vercel: { found: true, names: ["atelier-recherche"], source: "rest" } }, ["--confirm", "atelier-recherche"]);
    verifier("refus : relancer l'inventaire", /run the inventory again/.test(r.rapport?.failed?.vercel?.error || ""), r.rapport?.failed?.vercel?.error);
    egal("rien n'est supprimé", etatServeur.calls.filter((c) => c.method === "DELETE").length, 0);
  }

  console.log("\nexecute-deletions.mjs : jeton refusé, la vraie commande passe par la CLI");
  etatServeur = compte({ tokenValid: false });
  writeFileSync(etatCli, JSON.stringify(compte({ tokenValid: false })));
  {
    const r = await lancer(
      inventaire("atelier", { projects: [cible("prj_HOMO_FREE", "atelier", "team_FREE", "equipe-gratuite", "link")], ambiguous: false }),
      ["--confirm", "atelier"],
    );
    const res = r.rapport?.deleted?.vercel?.results?.[0];
    egal("supprimé par la CLI", res?.via, "cli");
    egal("et vérifié", res?.verified, true);
    const etat = JSON.parse(readFileSync(etatCli, "utf8"));
    egal("le bon projet est parti", etat.projects.some((p) => p.id === "prj_HOMO_FREE"), false);
    egal("l'homonyme de l'équipe courante est intact", etat.projects.some((p) => p.id === "prj_HOMO_PRO"), true);
    const rm = etat.calls.filter((c) => c.args[0] === "project" && c.args[1] === "rm");
    verifier("la commande nomme l'équipe", rm.length === 1 && rm[0].args.join(" ") === "project rm atelier --scope team_FREE", JSON.stringify(rm.map((c) => c.args)));
    egal("la confirmation a reçu oui", rm[0]?.input, "y\n");
  }
} finally {
  serveur.close();
  rmSync(racine, { recursive: true, force: true });
}

// ─── 6. Les appelants passent par le module ────────────────────────────────
console.log("\nLes appelants passent par le module");
{
  const exec = lire("scripts/delete-project/execute-deletions.mjs");
  verifier("execute-deletions supprime par deleteProject, sans `echo y |`", /deleteProject\(/.test(exec) && !/echo y/.test(exec));
  const inv = lire("scripts/delete-project/discover-resources.mjs");
  verifier("l'inventaire liste par listAllProjects et choisit par pickTargets", /listAllProjects\(/.test(inv) && /pickTargets\(/.test(inv));
  const garde = lire("scripts/check-name-collision.mjs");
  verifier("le garde-fou de nom lit toutes les équipes", /listAllProjects\(/.test(garde) && !/vercel projects ls"/.test(garde));
  const quotas = lire("scripts/quotas-fetch.mjs");
  verifier("/quotas lit le jeton par _vercel-auth.mjs, plus par un lecteur à lui", /loadAuthToken\(\)/.test(quotas) && !/com\.vercel\.cli/.test(quotas));
  const boot = lire("scripts/bootstrap-init.mjs");
  verifier(
    "bootstrap-init lit l'équipe et le jeton par _vercel-auth.mjs",
    /readCliCurrentTeam\(\)/.test(boot) && /loadAuthToken\(\)/.test(boot) && !/function vercelConfigCandidates/.test(boot) && !/"com\.vercel\.cli", "Data", "auth\.json"/.test(boot),
  );
}

console.log(`\n${total - echecs}/${total} vérifications passent`);
process.exit(echecs ? 1 : 0);
