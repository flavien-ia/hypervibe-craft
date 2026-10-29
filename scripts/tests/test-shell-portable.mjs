#!/usr/bin/env node
// test-shell-portable.mjs - A command a script runs through a shell must work in Windows' shell too.
// `VAR=1 command` is a POSIX prefix that Windows' shell does not know: the collaborator's bootstrap
// stopped at its second step on it at the trial of 30/09/2026 (and in the published 2.3.7). A
// variable goes in the child's environment (`env: { ...process.env, VAR: "1" }`), never before the
// command.
//
//   node scripts/tests/test-shell-portable.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
/** A call that hands a command line to a shell (or names a program), the line opening on a
 *  variable to set: `run` and `capture` are the harness's own helpers around spawnSync. */
const PREFIXED = /\b(?:run|capture|exec|execSync|spawn|spawnSync)\(\s*["'`][A-Z][A-Z0-9_]*=/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "tests") continue;
      walk(full, out);
    } else if (name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 500)})`}`);
}

const hits = [];
for (const file of walk(SCRIPTS)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(PREFIXED)) {
    const line = text.slice(0, m.index).split("\n").length;
    hits.push(`${relative(SCRIPTS, file).split("\\").join("/")}:${line}`);
  }
}
check("no command run through a shell opens on a POSIX variable prefix (Windows' shell does not know it)", hits.length === 0, hits.join(", "));
const sample = 'run("HYPERVIBE_GUARD_ALLOW_SWEEP=1 git add -A", PROJECT_DIR);';
check("... the check sees the case of 30/09/2026", [...sample.matchAll(PREFIXED)].length === 1);
check("... and its variants (single quotes, execSync)", [..."execSync('NODE_ENV=production pnpm build');".matchAll(PREFIXED)].length === 1);
check("... and not a variable given in the environment", [...'run("git add -A", PROJECT_DIR, { env: { ...process.env, HYPERVIBE_GUARD_ALLOW_SWEEP: "1" } });'.matchAll(PREFIXED)].length === 0);

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
