#!/usr/bin/env node
// test-detect-projects-dir.mjs - Recette of scripts/detect-projects-dir.mjs, the folder /bootstrap
// creates a project in. Cases of the ticket of 30/09/2026 (an Enterprise collaborator on Windows 11): a
// path as Git Bash writes it, with spaces; a projects folder named freely, which held projects;
// a conventional folder that does not exist. Every profile is simulated (--home): nothing of the
// real Desktop is read.
//
//   node scripts/tests/test-detect-projects-dir.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "detect-projects-dir.mjs");
const { detect, fromGitBashPath } = await import(pathToFileURL(SCRIPT).href);
const WORK = mkdtempSync(join(tmpdir(), "hv detect "));
const WIN = process.platform === "win32";

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 500)})`}`);
}
/** A folder holding `n` projects (each a folder with a package.json). */
function projects(dir, n) {
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    mkdirSync(join(dir, `projet-${i}`), { recursive: true });
    writeFileSync(join(dir, `projet-${i}`, "package.json"), "{}\n");
  }
  return dir;
}
const profile = (name) => {
  const home = join(WORK, name, "home");
  mkdirSync(home, { recursive: true });
  return home;
};
/** The script as /bootstrap runs it, as its own process. */
function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // not JSON
  }
  return { code: r.status, json, err: r.stderr };
}
/** The Git Bash form of a Windows path (C:\a b\c -> /c/a b/c). */
const gitBash = (p) => `/${p[0].toLowerCase()}/${p.slice(3).split("\\").join("/")}`;
/** Never a folder that does not exist while an existing one holds projects. */
const neverAbsent = (out) => {
  const rec = out.candidates.find((c) => c.path.toLowerCase() === String(out.recommended).toLowerCase());
  return !out.candidates.some((c) => c.exists && c.projectCount > 0) || Boolean(rec?.exists);
};

try {
  // ── A path as Git Bash writes it ─────────────────────────────────────────────
  check("Git Bash's /c/... is a Windows path under Windows, spaces kept", fromGitBashPath("/c/DEV CLAUDE CODE/PRO", true) === "C:\\DEV CLAUDE CODE\\PRO");
  check("... /cygdrive/d/... too, and a disk's root alone", fromGitBashPath("/cygdrive/d/Projets/app", true) === "D:\\Projets\\app" && fromGitBashPath("/c", true) === "C:\\" && fromGitBashPath("/c/", true) === "C:\\");
  check("... a Windows path, a path that is not a drive, and any path elsewhere: unchanged", fromGitBashPath("C:\\DEV", true) === "C:\\DEV" && fromGitBashPath("/tmp/x", true) === "/tmp/x" && fromGitBashPath("/c/DEV", false) === "/c/DEV");

  // ── The ticket: a projects folder named freely, given as Git Bash writes it ───
  {
    const home = profile("ticket");
    const pro = projects(join(WORK, "ticket", "DEV CLAUDE CODE", "PRO"), 3);
    const args = ["--cwd", WIN ? gitBash(pro) : pro, "--home", home];
    const r = cli(args);
    check("the folder given as $(pwd) is read where it is, spaces and all (never C:\\c\\...)", r.code === 0 && r.json?.cwd.path.toLowerCase() === pro.toLowerCase(), JSON.stringify(r.json?.cwd));
    check("a projects folder named freely, which holds projects, is a candidate", r.json?.candidates.some((c) => c.path.toLowerCase() === pro.toLowerCase() && c.source === "cwd" && c.projectCount === 3), JSON.stringify(r.json?.candidates));
    check("... and it is the one recommended, never the conventional folder that does not exist", r.json?.recommended.toLowerCase() === pro.toLowerCase() && r.json.ambiguous === false && neverAbsent(r.json), JSON.stringify(r.json));
  }

  // ── Inside a project of that folder: its parent ───────────────────────────────
  {
    const home = profile("dedans");
    const pro = projects(join(WORK, "dedans", "Mes sites"), 2);
    const out = detect({ cwd: join(pro, "projet-1"), home });
    check("inside one of its projects: the parent folder is the candidate, and recommended", out.cwd.insideProject === true && out.recommended.toLowerCase() === pro.toLowerCase() && out.candidates.some((c) => c.source === "cwd-parent"), JSON.stringify(out));
  }

  // ── The conventional folder absent, nothing anywhere: the convention, to create ─
  {
    const home = profile("vide");
    const empty = join(WORK, "vide", "ailleurs");
    mkdirSync(empty, { recursive: true });
    const out = detect({ cwd: empty, home });
    const conv = out.candidates.find((c) => c.source === "convention");
    check("no folder holds a project: the convention is proposed, said as absent (to create)", out.recommended === conv?.path && conv.exists === false && !out.candidates.some((c) => c.source === "cwd"), JSON.stringify(out));
  }

  // ── A folder in the profile that holds projects, and the folder the user is in ─
  {
    const home = profile("deux");
    const desk = projects(join(home, "Desktop", "DEV"), 5);
    const pro = projects(join(WORK, "deux", "Clients"), 2);
    const out = detect({ cwd: pro, home });
    check("two folders hold projects: ambiguous (the skill asks), the hint is the folder the user is in", out.ambiguous === true && out.recommended.toLowerCase() === pro.toLowerCase() && out.candidates.some((c) => c.path.toLowerCase() === desk.toLowerCase()) && neverAbsent(out), JSON.stringify(out));
    const elsewhere = detect({ cwd: join(WORK, "deux"), home });
    check("... from a folder without projects, the one that holds them", elsewhere.recommended.toLowerCase() === desk.toLowerCase() && neverAbsent(elsewhere), JSON.stringify(elsewhere));
  }

  // ── Never the profile itself, never a disk's root ─────────────────────────────
  {
    const home = profile("profil");
    projects(home, 2);
    const out = detect({ cwd: home, home });
    check("the profile itself, even holding repositories, is not a projects folder", !out.candidates.some((c) => c.source === "cwd" || c.source === "cwd-parent"), JSON.stringify(out.candidates));
  }
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
