#!/usr/bin/env node
// test-delete-local-git.mjs - /delete-project says whether a folder's code would be lost (3.4.16,
// passe hypervibe-learn du 23/10/2026).
//
// A folder without any cloud infrastructure (an old project, a mock-up) is deleted by hand, and its
// code goes with it unless it lives elsewhere. The same check had been improvised twice, once where
// the code would have been lost. What must hold:
//   1. the inventory's local section says where the code stands in git: a repository or not, what
//      is not committed, what is committed but on no remote, the folder being only part of a
//      larger repository; a figure git could not give is null, never 0;
//   2. the skill has a path for an empty cloud inventory: the verdict ("deletable without loss" or
//      "code lost if deleted"), /save-project offered first, references looked for in the memory
//      and the skills, and the folder given to delete by hand, never deleted by the skill.
// Real repositories in a temporary folder (a bare one stands for the remote): nothing leaves the
// machine, and no hook of the machine runs (core.hooksPath points to an empty folder).
//
//   node scripts/tests/test-delete-local-git.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { localGitState } = await import(pathToFileURL(join(ROOT, "scripts", "delete-project", "_inventory-rules.mjs")).href);

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 500)})` : ""}`);
}

const racine = mkdtempSync(join(tmpdir(), "hv-delete-git-"));
const sansCrochets = join(racine, "sans-crochets");
const g = (cwd, ...args) =>
  execFileSync("git", ["-c", `core.hooksPath=${sansCrochets}`, "-c", "commit.gpgsign=false", "-c", "user.name=Recette", "-c", "user.email=recette@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const depot = (nom, fichiers = ["a.txt"]) => {
  const dir = join(racine, nom);
  g(racine, "init", "-q", dir);
  g(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const f of fichiers) {
    writeFileSync(join(dir, f), `${f}\n`);
    g(dir, "add", f);
    g(dir, "commit", "-q", "--no-verify", "-m", `Ajout de ${f}`);
  }
  return dir;
};

try {
  console.log("── Où en est le code d'un dossier ──");
  {
    const vide = join(racine, "maquette");
    mkdirSync(vide);
    writeFileSync(join(vide, "index.html"), "<p>maquette</p>\n");
    check("un dossier sans dépôt : repo false", localGitState(vide, spawnSync).repo === false, JSON.stringify(localGitState(vide, spawnSync)));

    const seul = depot("seul", ["a.txt", "b.txt"]);
    const s = localGitState(seul, spawnSync);
    check("un dépôt sans distant : ses deux commits ne sont nulle part ailleurs", s.repo === true && s.unpushed === 2 && s.remotes.length === 0 && s.upstream === null && s.uncommitted === 0, JSON.stringify(s));

    const pousse = depot("pousse");
    g(racine, "clone", "-q", "--bare", pousse, join(racine, "distant.git"));
    g(pousse, "remote", "add", "origin", join(racine, "distant.git"));
    g(pousse, "fetch", "-q", "origin");
    g(pousse, "branch", "-q", "--set-upstream-to=origin/main", "main");
    const p = localGitState(pousse, spawnSync);
    check("un dépôt propre et poussé : rien ne serait perdu", p.repo === true && p.unpushed === 0 && p.uncommitted === 0 && p.upstream === "origin/main" && p.remotes.includes("origin") && p.insideLarger === false, JSON.stringify(p));

    writeFileSync(join(pousse, "nouveau.txt"), "pas encore commité\n");
    writeFileSync(join(pousse, "a.txt"), "modifié\n");
    const m = localGitState(pousse, spawnSync);
    check("des fichiers modifiés ou nouveaux sont comptés", m.uncommitted === 2 && m.unpushed === 0, JSON.stringify(m));

    g(pousse, "add", "nouveau.txt");
    g(pousse, "commit", "-q", "--no-verify", "-m", "Commit jamais poussé");
    g(pousse, "checkout", "-q", "-b", "essai");
    writeFileSync(join(pousse, "essai.txt"), "branche locale\n");
    g(pousse, "add", "essai.txt");
    g(pousse, "commit", "-q", "--no-verify", "-m", "Commit d'une branche locale");
    const u = localGitState(pousse, spawnSync);
    check("les commits jamais poussés de TOUTES les branches locales sont comptés (2)", u.unpushed === 2, JSON.stringify(u));

    const sous = join(seul, "sous-dossier");
    mkdirSync(sous);
    const i = localGitState(sous, spawnSync);
    check("un dossier qui n'est qu'une partie d'un dépôt plus grand le dit", i.repo === true && i.insideLarger === true && i.root.replace(/\\/g, "/").toLowerCase().endsWith("/seul"), JSON.stringify(i));

    const enPanne = localGitState(seul, (cmd, args) => (args.includes("rev-parse") && args.includes("--show-toplevel") ? { status: 0, stdout: seul } : { status: 128, stdout: "" }));
    check("un chiffre que git ne donne pas reste null, jamais 0", enPanne.repo === true && enPanne.uncommitted === null && enPanne.unpushed === null, JSON.stringify(enPanne));
  }

  console.log("\n── Ce que le distant tient vraiment (retours de Bastien Detraz, 3.4.17) ──");
  {
    // The verdict "deletable without loss", as section 1.1 of the skill gives it from the fields the
    // inventory has (those of 3.4.16 alone, on the code before this release).
    const sansPerte = (s) => s.repo === true && s.uncommitted === 0 && s.unpushed === 0 && (s.stashed ?? 0) === 0 && (s.submodules ?? 0) === 0 && s.remotes.length > 0 && (s.remotesAnswered === undefined || s.remotesAnswered.length > 0);
    const fw = (p) => p.replace(/\\/g, "/");
    const avecDistant = (nom, fichiers) => {
      const dir = depot(nom, fichiers);
      const nu = join(racine, `${nom}.git`);
      g(racine, "clone", "-q", "--bare", dir, nu);
      g(dir, "remote", "add", "origin", nu);
      g(dir, "fetch", "-q", "origin");
      g(dir, "branch", "-q", "--set-upstream-to=origin/main", "main");
      return { dir, nu };
    };
    const touche = (f) => {
      const d = new Date(Date.now() + 60_000);
      utimesSync(f, d, d);
    };

    const temoin = avecDistant("temoin");
    const t = localGitState(temoin.dir, spawnSync);
    check("le témoin, tout poussé, son distant présent : supprimable sans perte", sansPerte(t) && (t.remotesAnswered ?? []).includes("origin") && t.stashed === 0 && t.remoteAhead === false, JSON.stringify(t));

    const supprime = avecDistant("distant-supprime");
    rmSync(supprime.nu, { recursive: true, force: true });
    const d = localGitState(supprime.dir, spawnSync);
    check("le dépôt distant supprimé : personne n'a répondu, jamais « sans perte »", !sansPerte(d) && d.unpushed === null && (d.remotesSilent ?? []).includes("origin"), JSON.stringify(d));

    const remise = avecDistant("remise");
    writeFileSync(join(remise.dir, "a.txt"), "travail mis de côté\n");
    g(remise.dir, "stash", "push", "-q", "-m", "de côté");
    const r = localGitState(remise.dir, spawnSync);
    check("du travail mis de côté par git stash : compté, jamais « sans perte »", !sansPerte(r) && r.stashed === 1 && r.uncommitted === 0, JSON.stringify(r));

    const etiquette = avecDistant("etiquette");
    writeFileSync(join(etiquette.dir, "b.txt"), "b\n");
    g(etiquette.dir, "add", "b.txt");
    g(etiquette.dir, "commit", "-q", "--no-verify", "-m", "Seulement sur une étiquette");
    g(etiquette.dir, "tag", "v-locale");
    g(etiquette.dir, "reset", "-q", "--hard", "HEAD~1");
    const e = localGitState(etiquette.dir, spawnSync);
    check("un commit que seule une étiquette locale porte : compté, jamais « sans perte »", !sansPerte(e) && e.unpushed === 1, JSON.stringify(e));

    const detache = avecDistant("detache");
    g(detache.dir, "checkout", "-q", "--detach");
    writeFileSync(join(detache.dir, "c.txt"), "c\n");
    g(detache.dir, "add", "c.txt");
    g(detache.dir, "commit", "-q", "--no-verify", "-m", "Sur une tête détachée");
    const h = localGitState(detache.dir, spawnSync);
    check("un commit sur une tête détachée, sur aucune branche : compté, jamais « sans perte »", !sansPerte(h) && h.unpushed === 1, JSON.stringify(h));

    const sous = avecDistant("sous-module");
    const tete = g(sous.dir, "rev-parse", "HEAD").trim();
    g(sous.dir, "update-index", "--add", "--cacheinfo", `160000,${tete},vendor/lib`);
    g(sous.dir, "commit", "-q", "--no-verify", "-m", "Un sous-module");
    g(sous.dir, "push", "-q", "origin", "main");
    const sm = localGitState(sous.dir, spawnSync);
    check("un sous-module, jamais regardé dedans : nommé, jamais « sans perte »", !sansPerte(sm) && sm.submodules === 1 && sm.unpushed === 0, JSON.stringify(sm));

    const avance = avecDistant("en-avance");
    const autre = join(racine, "autre-poste");
    g(racine, "clone", "-q", avance.nu, autre);
    writeFileSync(join(autre, "d.txt"), "d\n");
    g(autre, "add", "d.txt");
    g(autre, "commit", "-q", "--no-verify", "-m", "Poussé d'un autre poste");
    g(autre, "push", "-q", "origin", "main");
    const av = localGitState(avance.dir, spawnSync);
    check("un distant qui a des commits que cette copie n'a jamais récupérés : remoteAhead le dit, jamais « sans perte »", av.remoteAhead === true && !sansPerte(av), JSON.stringify(av));

    // Witnesses: each program would write a file. None may ever run.
    const temoins = join(racine, "temoins");
    mkdirSync(temoins);
    const piege = avecDistant("piege");
    writeFileSync(join(piege.dir, ".gitattributes"), "*.txt filter=temoin\n");
    g(piege.dir, "add", ".gitattributes");
    g(piege.dir, "commit", "-q", "--no-verify", "-m", "Attributs");
    g(piege.dir, "push", "-q", "origin", "main");
    g(piege.dir, "config", "core.fsmonitor", `echo fsmonitor > "${fw(join(temoins, "fsmonitor"))}"; false`);
    g(piege.dir, "config", "filter.temoin.clean", `sh -c 'echo clean > "${fw(join(temoins, "clean"))}"; cat'`);
    g(piege.dir, "config", "filter.temoin.process", `sh -c 'echo process > "${fw(join(temoins, "process"))}"'`);
    touche(join(piege.dir, "a.txt"));
    const p = localGitState(piege.dir, spawnSync);
    check("un core.fsmonitor de la configuration du dossier n'est jamais lancé", !existsSync(join(temoins, "fsmonitor")), JSON.stringify(p));
    check("... ni les filtres qu'elle définit (un dossier copié : git relirait chaque fichier)", !existsSync(join(temoins, "clean")) && !existsSync(join(temoins, "process")));
    check("... et l'inventaire répond quand même, sans perte puisque tout est poussé", sansPerte(p), JSON.stringify(p));

    const aide = depot("aide-transport");
    g(aide, "remote", "add", "origin", `ext::sh -c touch% ${fw(join(temoins, "ext"))}`);
    // A global configuration that would allow `ext::` (git refuses it by default): only the
    // inventory's own refusal stands between the remote and the command it names.
    const globale = join(racine, "globale.gitconfig");
    writeFileSync(globale, '[protocol "ext"]\n\tallow = always\n');
    const avant = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globale;
    let x;
    try {
      x = localGitState(aide, spawnSync);
    } finally {
      if (avant === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = avant;
    }
    check("un distant écrit avec la syntaxe d'un assistant (ext::, qui lance une commande) n'est jamais interrogé", !existsSync(join(temoins, "ext")) && (x.remotesSilent ?? []).includes("origin") && !sansPerte(x), JSON.stringify(x));

    const source = readFileSync(join(ROOT, "scripts", "delete-project", "_inventory-rules.mjs"), "utf8");
    const corps = source.slice(source.indexOf("export function localGitState"), source.indexOf("export function settleStripeWithoutKey"));
    const appels = [...corps.matchAll(/git\(\[([^\]]*)\]/g)].map((m) => m[1]);
    check("dans le source : aucun git status nu, chaque appel avec le moniteur coupé, sans crochets ni verrou", /"status", "--porcelain", "--ignore-submodules=all"/.test(corps) && /"core\.fsmonitor=false"/.test(corps) && /"--no-optional-locks"/.test(corps) && /core\.hooksPath=\$\{neutre\}/.test(corps));
    check("... chaque lecture d'historique sans signature, et les distants interrogés hors du dépôt, l'adresse par l'environnement", appels.filter((a) => /"log"/.test(a)).every((a) => /"--no-show-signature"/.test(a)) && /GIT_CONFIG_VALUE_0: address/.test(corps) && /cwd: neutre/.test(corps) && /GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh"/.test(corps) && /GIT_TERMINAL_PROMPT: "0"/.test(corps));
  }

  console.log("\n── Ce que dit la skill ──");
  {
    const skill = readFileSync(join(ROOT, "skills", "delete-project", "SKILL.md"), "utf8");
    check("un parcours pour un inventaire cloud vide", /### 1\.1 An empty cloud inventory/.test(skill));
    check("... qui lit l'état git du dossier (localDir.git)", /localDir\.git/.test(skill) && /unpushed/.test(skill) && /uncommitted/.test(skill));
    check("... rend un verdict, « supprimable sans perte » ou « code perdu si supprimé »", /deletable without loss/.test(skill) && /code lost if deleted/.test(skill));
    check("... interroge les distants eux-mêmes (remotesAnswered, remotesSilent), jamais ce que la copie en croit", /`git ls-remote`/.test(skill) && /`remotesAnswered`/.test(skill) && /`remotesSilent`/.test(skill));
    check("... compte la remise (git stash), les sous-modules, et dit remoteAhead", /`stashed` above 0/.test(skill) && /`submodules` above 0/.test(skill) && /`remoteAhead: true`/.test(skill));
    check("... rend « inconnu » quand aucun distant n'a répondu, jamais « sans perte »", /\*\*Unknown\*\*/.test(skill) && /"Unknown: /.test(skill));
    check("... propose /save-project avant, et cherche les références dans la mémoire et les skills", /\/save-project/.test(skill.slice(skill.indexOf("### 1.1 An empty cloud inventory"))) && /memory\.files/.test(skill) && /~\/\.claude\/skills/.test(skill));
    check("... et donne le chemin à supprimer à la main, sans jamais le supprimer", /Explorer/.test(skill.slice(skill.indexOf("### 1.1 An empty cloud inventory"), skill.indexOf("## Phase 2"))) && /never delete the folder/i.test(skill));
    const docEn = readFileSync(join(ROOT, "skills", "delete-project", "DOC.md"), "utf8");
    const docFr = readFileSync(join(ROOT, "skills", "delete-project", "DOC.fr.md"), "utf8");
    check("les deux pages le disent", /without any cloud infrastructure/.test(docEn) && /sans aucune infrastructure/.test(docFr));
    check("... y compris quand il ne peut pas le savoir (le dépôt en ligne ne répond plus)", /cannot tell \(the online repository no longer answers\)/.test(docEn) && /ne peut pas le savoir \(le dépôt en ligne ne répond plus\)/.test(docFr));
  }
} finally {
  rmSync(racine, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
