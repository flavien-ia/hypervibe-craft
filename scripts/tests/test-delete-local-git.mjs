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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  console.log("\n── Ce que dit la skill ──");
  {
    const skill = readFileSync(join(ROOT, "skills", "delete-project", "SKILL.md"), "utf8");
    check("un parcours pour un inventaire cloud vide", /### 1\.1 An empty cloud inventory/.test(skill));
    check("... qui lit l'état git du dossier (localDir.git)", /localDir\.git/.test(skill) && /unpushed/.test(skill) && /uncommitted/.test(skill));
    check("... rend un verdict, « supprimable sans perte » ou « code perdu si supprimé »", /deletable without loss/.test(skill) && /code lost if deleted/.test(skill));
    check("... propose /save-project avant, et cherche les références dans la mémoire et les skills", /\/save-project/.test(skill.slice(skill.indexOf("### 1.1 An empty cloud inventory"))) && /memory\.files/.test(skill) && /~\/\.claude\/skills/.test(skill));
    check("... et donne le chemin à supprimer à la main, sans jamais le supprimer", /Explorer/.test(skill.slice(skill.indexOf("### 1.1 An empty cloud inventory"), skill.indexOf("## Phase 2"))) && /never delete the folder/i.test(skill));
    const docEn = readFileSync(join(ROOT, "skills", "delete-project", "DOC.md"), "utf8");
    const docFr = readFileSync(join(ROOT, "skills", "delete-project", "DOC.fr.md"), "utf8");
    check("les deux pages le disent", /without any cloud infrastructure/.test(docEn) && /sans aucune infrastructure/.test(docFr));
  }
} finally {
  rmSync(racine, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
