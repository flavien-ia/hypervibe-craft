#!/usr/bin/env node
// test-workflow-actions.mjs - Recette: the workflows the harness writes use each action on a Node
// that GitHub still runs. GitHub deprecated Node 20 for actions and forces them onto Node 24, with
// a warning on every run (seen on a real run, 28/09/2026). For the actions the harness writes, the
// first major on Node 24, read in their action.yml (`using: node24`): checkout and setup-node v5,
// upload-artifact v6, github-script v8. An action not listed here is not judged.
//
//   node scripts/tests/test-workflow-actions.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIRST_ON_NODE_24 = { "actions/checkout": 5, "actions/setup-node": 5, "actions/upload-artifact": 6, "actions/github-script": 8 };

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ya?ml|md|mjs|json)$/.test(name)) files.push(p);
  }
}
for (const top of ["templates", "skills", "scripts"]) {
  try {
    walk(join(ROOT, top));
  } catch {
    // a harness without this folder
  }
}

/** The setup-node steps of a text that do not turn its automatic cache off. setup-node v5 turns a
 *  cache on by itself when package.json declares a package manager, and looks for that package
 *  manager before anything installed it: the run stops there (trial of 30/09/2026). The harness
 *  pins pnpm in package.json for a host that builds an image, and a project may declare it itself. */
export function setupNodeWithCache(text) {
  const lines = text.split(/\r?\n/);
  const indentOf = (l) => /^ */.exec(l)[0].length;
  const missing = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^( *)(?:- )?uses:\s*actions\/setup-node@/.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > m[1].length)) end += 1;
    if (!lines.slice(i + 1, end).some((l) => /^\s*package-manager-cache:\s*false\s*$/.test(l))) missing.push(i + 1);
  }
  return missing;
}

const older = [];
const cached = [];
let read = 0;
let setupNodeSteps = 0;
for (const f of files) {
  const rel = relative(ROOT, f).split("\\").join("/");
  if (rel.startsWith("scripts/tests/")) continue; // the recettes' fixtures
  read += 1;
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/uses:\s*(actions\/[A-Za-z0-9_-]+)@v(\d+)/g)) {
    const first = FIRST_ON_NODE_24[m[1]];
    if (first && Number(m[2]) < first) older.push(`${rel}: ${m[1]}@v${m[2]}`);
    if (m[1] === "actions/setup-node") setupNodeSteps += 1;
  }
  for (const line of setupNodeWithCache(text)) cached.push(`${rel}:${line}`);
}

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}
check("every action the harness writes into a workflow runs on Node 24", older.length === 0, older.join(" | "));
check("... and the files that carry workflows were read", read > 10, String(read));
check("every setup-node step turns its automatic cache off (a declared pnpm would stop the run)", cached.length === 0, cached.join(" | "));
check("... on steps really read", setupNodeSteps > 0, String(setupNodeSteps));
const witness = ["      - uses: actions/setup-node@v5", "        with:", "          node-version: 22", "", "      - name: next"].join("\n");
check("... the check sees a step that leaves the cache on", setupNodeWithCache(witness).length === 1);
check(
  "... and not one that turns it off, nor the next step's settings",
  setupNodeWithCache(witness.replace("node-version: 22", "node-version: 22\n          package-manager-cache: false")).length === 0 &&
    setupNodeWithCache(`${witness}\n        with:\n          package-manager-cache: false`).length === 1,
);
console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
