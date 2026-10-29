#!/usr/bin/env node
// test-repair-lint.mjs - The repair of a project made by /bootstrap before 3.4.5, where `pnpm
// lint` stops because pnpm 10+ no longer puts ESLint's plugins at the root (repair-lint.mjs):
//   - the diagnosis tells a project that needs it from one that does not, and never writes;
//   - the repair writes the block alone, keeps what the file already had, and reinstalls only
//     where node_modules exist, a failed reinstall said with its step;
//   - /update-hypervibe offers it on the current project, and runs it only on a yes;
//   - a project whose pnpm reads the block only in .npmrc (an older pnpm 10, 3.4.6) gets the same
//     patterns there, and only that one.
// No network, no pnpm: the reinstall is a stand-in that lays the plugin out where pnpm would, and
// pnpm's answer to `pnpm config get public-hoist-pattern` is played as it was read for real on
// 2026-10-06 (10.4.1 and 10.5.2: "undefined" with the block alone; 11.1.1: the list).
// The real repair was tried on a copy of a real project on 2026-10-05: lint passes after it, and
// the lockfile does not move by a byte; the .npmrc one on two real projects pinned to 10.4.1 and
// 10.5.2 on 2026-10-06, with the same result.
//
//   node scripts/tests/test-repair-lint.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { diagnose, repair } = await import(pathToFileURL(join(ROOT, "scripts", "repair-lint.mjs")).href);

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}

const base = mkdtempSync(join(tmpdir(), "hv-repair-lint-"));
let n = 0;
/** A project as /bootstrap left it: package.json, lockfile, pnpm-workspace.yaml, node_modules. */
function projet({ eslintNext = true, lock = true, ws = 'overrides:\n  postcss: "^8.5.23"\n', modules = true, plugin = false } = {}) {
  const dir = join(base, `p${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "atelier", private: true, devDependencies: eslintNext ? { eslint: "^9", "eslint-config-next": "^15" } : { eslint: "^9" } }));
  if (lock) writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  if (ws !== null) writeFileSync(join(dir, "pnpm-workspace.yaml"), ws);
  if (modules) mkdirSync(join(dir, "node_modules"), { recursive: true });
  if (plugin) poserGreffon(dir);
  return dir;
}
function poserGreffon(dir) {
  const p = join(dir, "node_modules", "eslint-plugin-react-hooks");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "package.json"), JSON.stringify({ name: "eslint-plugin-react-hooks", version: "5.0.0", main: "index.js" }));
  writeFileSync(join(p, "index.js"), "module.exports = {};\n");
}
const ws = (dir) => readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
const npmrcOf = (dir) => (existsSync(join(dir, ".npmrc")) ? readFileSync(join(dir, ".npmrc"), "utf8") : null);
// pnpm, asked whether it reads the block: an older pnpm 10 does not, pnpm 11 does, and a pnpm that
// cannot be asked fails. `asked` counts the questions.
let asked = 0;
const ancien = { ask: () => ((asked += 1), { status: 0, stdout: "undefined\n" }) };
const recent = { ask: () => ((asked += 1), { status: 0, stdout: '[ "*eslint*", "*prettier*" ]\n' }) };
const muet = { ask: () => ((asked += 1), { status: 1, stdout: "", stderr: "pnpm: command not found" }) };
const reinstaller = (calls) => (cmd, cwd) => {
  calls?.push(cmd);
  poserGreffon(cwd);
  return { status: 0, stdout: "Done", stderr: "" };
};

try {
  console.log("── Le diagnostic, qui n'écrit rien ──");
  {
    const d = projet();
    const avant = ws(d);
    const r = diagnose(d, recent);
    check("un projet sans le bloc, les greffons hors de portée : à réparer", r.needed === true && r.block === "absent" && r.reachable === false, JSON.stringify(r));
    check("... et rien n'a été écrit", ws(d) === avant);
    check("le projet du 05/10 qui marche encore (remontée d'une ancienne installation) : à réparer quand même, la prochaine réinstallation la perdrait", diagnose(projet({ plugin: true }), recent).needed === true);
    check("un projet sans la configuration ESLint de Next : rien à faire", diagnose(projet({ eslintNext: false })).reason === "no-next-eslint");
    check("un projet qui n'est pas géré par pnpm : rien à faire", diagnose(projet({ lock: false, ws: null })).reason === "not-pnpm");
    check("un dossier sans package.json : rien à faire", diagnose(base).reason === "not-a-project");
    const ok = projet({ ws: 'publicHoistPattern:\n  - "*eslint*"\n  - "*prettier*"\n', plugin: true });
    check("le bloc posé, lu par le pnpm du projet, les greffons à portée : déjà en ordre", diagnose(ok, recent).needed === false && diagnose(ok, recent).reason === "already");
    const reinst = projet({ ws: 'publicHoistPattern:\n  - "*eslint*"\n  - "*prettier*"\n' });
    check("le bloc posé mais node_modules d'avant : une réinstallation suffit", diagnose(reinst, recent).needed === true && diagnose(reinst, recent).reason === "reinstall-needed");
  }

  console.log("\n── La réparation ──");
  {
    const d = projet({ ws: 'overrides:\n  postcss: "^8.5.23"\npublicHoistPattern:\n  - "*types*"\n' });
    const appels = [];
    const r = repair(d, { run: reinstaller(appels), ...recent });
    check("le bloc est écrit, les motifs déjà là gardés", /publicHoistPattern:\n {2}- "\*types\*"\n {2}- "\*eslint\*"\n {2}- "\*prettier\*"/.test(ws(d)), ws(d));
    check("... les autres blocs du fichier aussi", ws(d).includes('overrides:\n  postcss: "^8.5.23"'));
    check("une réinstallation, et rien d'autre", JSON.stringify(appels) === JSON.stringify(["pnpm install"]), JSON.stringify(appels));
    check("le résultat dit réparé, et le seul fichier à enregistrer", r.repaired === true && r.reinstalled === true && JSON.stringify(r.commit) === JSON.stringify(["pnpm-workspace.yaml"]), JSON.stringify(r));
    const sansModules = projet({ modules: false });
    let lance = false;
    const s = repair(sansModules, { run: () => { lance = true; return { status: 0 }; }, ...recent });
    check("sans node_modules : le bloc seul, aucune installation lancée à la place de la personne", !lance && s.written === true && s.reinstalled === false && /next pnpm install/.test(s.note ?? ""), JSON.stringify(s));
    const rate = projet();
    const e = repair(rate, { run: () => ({ status: 1, stdout: "", stderr: "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"" }), ...recent });
    check("une réinstallation qui échoue est dite, avec son étape et ses mots, jamais prise pour réparée", e.ok === false && e.step === "install" && /OUTDATED_LOCKFILE/.test(e.detail) && e.repaired === undefined, JSON.stringify(e));
    const deja = projet({ ws: 'publicHoistPattern:\n  - "*eslint*"\n  - "*prettier*"\n', plugin: true });
    let touche = false;
    const x = repair(deja, { run: () => { touche = true; return { status: 0 }; }, ...recent });
    check("un projet déjà en ordre n'est pas touché", !touche && x.written === false && x.needed === false);
    check("... ni son .npmrc, quand son pnpm lit le bloc (pnpm 11)", npmrcOf(deja) === null && npmrcOf(d) === null);
  }

  console.log("\n── Un ancien pnpm 10, qui ne lit le bloc que dans .npmrc (3.4.6) ──");
  {
    // The case of 06/10/2026: the block written by 3.4.5, the plugins still out of reach, a pnpm
    // pinned to 10.4.1 or 10.5.2.
    const vu = projet({ ws: 'publicHoistPattern:\n  - "*eslint*"\n  - "*prettier*"\n' });
    writeFileSync(join(vu, ".npmrc"), "strict-dep-builds=false\r\n");
    const dv = diagnose(vu, ancien);
    check("le bloc posé, un pnpm qui ne le lit pas : à réparer, et la raison le dit", dv.needed === true && dv.reason === "npmrc-missing" && dv.npmrc === "absent", JSON.stringify(dv));
    const appels = [];
    const rv = repair(vu, { run: reinstaller(appels), ...ancien });
    check("les deux motifs ajoutés à .npmrc, ses autres lignes et ses fins de ligne gardées", npmrcOf(vu) === "strict-dep-builds=false\r\npublic-hoist-pattern[]=*eslint*\r\npublic-hoist-pattern[]=*prettier*\r\n", JSON.stringify(npmrcOf(vu)));
    check("... une réinstallation, puis réparé, et seul .npmrc à enregistrer", rv.repaired === true && JSON.stringify(appels) === JSON.stringify(["pnpm install"]) && JSON.stringify(rv.commit) === JSON.stringify([".npmrc"]), JSON.stringify(rv));
    const neuf = projet();
    const rn = repair(neuf, { run: reinstaller(), ...ancien });
    check("un projet sans le bloc, sous un ancien pnpm 10 : le bloc ET .npmrc, les deux à enregistrer", rn.repaired === true && JSON.stringify(rn.commit) === JSON.stringify(["pnpm-workspace.yaml", ".npmrc"]) && npmrcOf(neuf) === "public-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=*prettier*\n", JSON.stringify(rn));
    const aveugle = projet();
    const ra = repair(aveugle, { run: reinstaller(), ...muet });
    check("un pnpm qu'on ne peut pas interroger : les deux endroits, par prudence (chaque version ignore l'autre)", ra.repaired === true && JSON.stringify(ra.commit) === JSON.stringify(["pnpm-workspace.yaml", ".npmrc"]), JSON.stringify(ra));
    const fini = projet({ ws: 'publicHoistPattern:\n  - "*eslint*"\n  - "*prettier*"\n', plugin: true });
    writeFileSync(join(fini, ".npmrc"), "public-hoist-pattern[]=*eslint*\npublic-hoist-pattern[]=*prettier*\n");
    asked = 0;
    const df = diagnose(fini, ancien);
    check("le bloc et .npmrc en place, les greffons à portée : en ordre, sans même interroger pnpm", df.needed === false && df.reason === "already" && asked === 0, JSON.stringify(df));
    asked = 0;
    diagnose(projet(), ancien);
    check("... ni pour un projet sans le bloc (la réponse ne changerait rien au diagnostic)", asked === 0);
    const cache = projet({ ws: 'publicHoistPattern:\n  - "*eslint*"\n  - "*prettier*"\n', plugin: true });
    const dc = diagnose(cache, ancien);
    check("des greffons à portée grâce à une ancienne installation, sous un pnpm qui ne lit pas le bloc : à réparer quand même", dc.needed === true && dc.reason === "npmrc-missing", JSON.stringify(dc));
  }

  console.log("\n── La réinstallation est figée ──");
  {
    const src = readFileSync(join(ROOT, "scripts", "repair-lint.mjs"), "utf8");
    check("pnpm install lancé en CI : une installation figée, qui refuse de réécrire le fichier de verrou", /CI: "true"/.test(src) && /run\("pnpm install", dir\)/.test(src));
  }

  console.log("\n── Proposée par la mise à jour, lancée sur un oui ──");
  {
    const files = ["skills/update-hypervibe/SKILL.md", "skills/update-hypervibe-enterprise/SKILL.md"].map((f) => join(ROOT, f)).filter(existsSync);
    // The repair's own step, up to the next heading: another step's "only if the user agrees" is
    // not this one's.
    const step = files
      .map((f) => readFileSync(f, "utf8"))
      .map((t) => {
        const at = t.search(/^## (Step 3e - Repair the code check|Réparer la vérification de code)/m);
        if (at < 0) return "";
        const next = t.slice(at + 3).search(/^## /m);
        return next < 0 ? t.slice(at) : t.slice(at, at + 3 + next);
      })
      .join("\n");
    check("la mise à jour diagnostique le projet courant", /repair-lint\.mjs" --project-dir "<[^"]+>"\n/.test(step), files.join(", "));
    check("... et ne répare qu'après l'accord de la personne", /(only if the user agrees|seulement après son accord)[^\n]*\n\n```bash\n[^`]*repair-lint\.mjs" --project-dir "<[^"]+>" --write/.test(step));
    check("... dit quand .npmrc porte le réglage, et fait enregistrer ce que liste `commit`", /`\.npmrc` (when the project's version of pnpm reads it only there|quand la version de pnpm du projet ne le lit que là)/.test(step) && /`commit`/.test(step) && !/(the one file to commit|le seul fichier à enregistrer)/.test(step));
    check("... et dit une réparation qui n'a pas suffi, sans rien tenter de plus", /`repaired: false`/.test(step));
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
