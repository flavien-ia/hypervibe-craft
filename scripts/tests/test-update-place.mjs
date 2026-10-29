#!/usr/bin/env node
// test-update-place.mjs - Recette of what an update says about where the plugin lives (3.4.21).
//
// The Desktop bench of 28-29/10/2026 found three things the update said wrongly on Claude Desktop
// 4.29, whose uploaded plugins live in a registry of its own (`...\rpm\...\plugin_<id>`):
//   - "the previous version is kept as a backup": Desktop deletes it a few minutes later (three
//     backups out of three);
//   - nothing said that Desktop's Plugins screen keeps showing the number of the upload;
//   - asked which version runs, Claude searched the disk and read a stale copy.
// Held here: scripts/plugin-place.mjs tells a marketplace folder from Desktop's registry; a real
// install (the real script, a real archive, in throwaway folders) says `backupKept` and `desktop`;
// the skill and its DOC pages no longer promise the backup there, ask for /reload-plugins, and
// answer "which version" from the loaded plugin.
//
//   node scripts/tests/test-update-place.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Tolerant on purpose: played on the code of 3.4.20 (no plugin-place.mjs), each defect must be
// seen by its own check, not hidden behind a crash.
const { placeDuPlugin } = existsSync(join(ROOT, "scripts", "plugin-place.mjs"))
  ? await import(pathToFileURL(join(ROOT, "scripts", "plugin-place.mjs")).href)
  : { placeDuPlugin: () => ({}) };
const { zipDirectory } = await import(pathToFileURL(join(ROOT, "scripts", "_zip.mjs")).href);

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 400)})`}`);
}
const lire = (rel) => readFileSync(join(ROOT, rel), "utf8");

console.log("── 1. Où vit le plugin ──");
{
  const mp = placeDuPlugin("C:/Users/x/.claude/plugins/marketplaces/local-desktop-app-uploads/hypervibe", "hypervibe");
  check("un dossier de marketplace : la sauvegarde tient", mp.place === "marketplace" && mp.backupKept === true && mp.desktop === false, JSON.stringify(mp));
  const rpm = placeDuPlugin("C:\\Users\\x\\AppData\\Local\\Packages\\Claude\\LocalCache\\Roaming\\Claude\\Claude-Data\\rpm\\a859f234\\c851960e\\plugin_01E2Fc5UoFNisCLPWJVHhihQ", "hypervibe");
  check("le registre de Claude Desktop (rpm, plugin_<id>) : pas de sauvegarde promise, Desktop dit", rpm.place === "desktop" && rpm.backupKept === false && rpm.desktop === true, JSON.stringify(rpm));
  const ailleurs = placeDuPlugin("/home/x/plugins/hypervibe", "hypervibe");
  check("ailleurs (hors marketplace) : pas de sauvegarde promise, pas Desktop", ailleurs.place === "hors_marketplace" && ailleurs.backupKept === false && ailleurs.desktop === false, JSON.stringify(ailleurs));
  const mauvaisNom = placeDuPlugin("/home/x/.claude/plugins/marketplaces/m/autre-nom", "hypervibe");
  check("un dossier de marketplace qui ne porte pas le nom du plugin : hors marketplace (la règle de la migration Enterprise)", mauvaisNom.backupKept === false);
}

console.log("\n── 2. Une vraie installation, dans des dossiers jetables ──");
const box = mkdtempSync(join(tmpdir(), "hv-update-place-"));
try {
  const home = join(box, "home");
  mkdirSync(home, { recursive: true });
  // The new version: a complete plugin (skills, scripts, templates, at least 50 files).
  const neuf = join(box, "neuf", "hypervibe");
  for (const d of ["skills/a", "scripts", "templates/t", ".claude-plugin"]) mkdirSync(join(neuf, d), { recursive: true });
  writeFileSync(join(neuf, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "hypervibe", version: "9.9.9" }));
  for (let i = 0; i < 60; i++) writeFileSync(join(neuf, i % 3 === 0 ? "skills/a" : i % 3 === 1 ? "scripts" : "templates/t", `f${i}.txt`), `fichier ${i}\n`);
  const zip = join(box, "neuf.zip");
  await zipDirectory(neuf, zip);
  const ancien = (dir) => {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "hypervibe", version: "1.0.0" }));
  };
  const installer = (dir) => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "update", "update-hypervibe.mjs"), "install", "--zip", zip, "--plugin-dir", dir], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      return { ok: false, brut: r.stdout + r.stderr };
    }
  };
  const marche = join(home, ".claude", "plugins", "marketplaces", "local-desktop-app-uploads", "hypervibe");
  ancien(marche);
  let r = installer(marche);
  check("dans un dossier de marketplace : installée, backupKept vrai, desktop faux", r.ok === true && r.version === "9.9.9" && r.backupKept === true && r.desktop === false && existsSync(r.backup), JSON.stringify(r));
  const desktop = join(box, "Claude-Data", "rpm", "a859f234", "c851960e", "plugin_01TESTdesktop");
  ancien(desktop);
  r = installer(desktop);
  check("dans le registre de Desktop : installée, backupKept faux, desktop vrai", r.ok === true && r.version === "9.9.9" && r.backupKept === false && r.desktop === true, JSON.stringify(r));
} finally {
  rmSync(box, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log("\n── 3. Les textes ──");
{
  const s = lire("skills/update-hypervibe/SKILL.md");
  const fin = s.slice(s.indexOf("## Step 4 - Wrap up"));
  check("la conclusion demande /reload-plugins, plus « close and reopen »", /type `\/reload-plugins`/.test(fin) && !/close and reopen Claude Code/.test(s));
  check("la sauvegarde n'est promise que si backupKept est vrai", /`backupKept: true` → add: \*"The previous version is kept as a backup/.test(fin) && /`backupKept: false` → \*\*never promise a backup\.\*\*/.test(fin));
  check("sur Desktop, une phrase dit que l'écran Plugins garde l'ancien numéro", /`desktop: true` → add one sentence: \*"Claude Desktop will keep showing the old number/.test(fin));
  check("« quelle version tourne ? » se répond par la version chargée, jamais en fouillant le disque", /## Which version is running\?/.test(s) && /never search the disk for a `plugin\.json`/.test(s) && /localVersion` and its `pluginDir`/.test(s));
  check("l'étape des hooks décrit LOCAL : rien écrit, rien accordé, jamais « résultat inattendu »", /`LOCAL` means this machine has no machine-wide git hooks/.test(s) && /nothing was written, nothing was trusted/.test(s));
  const en = lire("skills/update-hypervibe/DOC.md");
  const fr = lire("skills/update-hypervibe/DOC.fr.md");
  check("les pages DOC demandent /reload-plugins et ne promettent plus la sauvegarde sous Desktop", /type `\/reload-plugins`/.test(en) && /taper `\/reload-plugins`/.test(fr) && /except on Claude Desktop/.test(en) && /sauf sous Claude Desktop/.test(fr));
  check("les pages DOC disent comment savoir quelle version tourne", /which version is running\?/.test(en) && /quelle version tourne \?/.test(fr));
  check("la recette est branchée dans run-all.mjs", /test-update-place\.mjs/.test(lire("scripts/tests/run-all.mjs")));
}

console.log(`\n${checks - failures}/${checks} verifications`);
process.exitCode = failures ? 1 : 0;
