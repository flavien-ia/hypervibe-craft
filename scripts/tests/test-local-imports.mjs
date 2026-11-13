#!/usr/bin/env node
// test-local-imports.mjs - Every script of the plugin imports only files the plugin ships (3.4.30 /
// 2.5.9). The administrator's setup-oauth-button.mjs imported _i18n-detect.mjs, which that harness
// did not ship: the script died on loading, and /add-google-auth and /add-github-auth with it,
// without any recette noticing (found on 13/11/2026). Static imports only: a dynamic import may be
// lazy on purpose, and is the reader's to guard.
//
//   node scripts/tests/test-local-imports.mjs

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}

/** Every .mjs of a folder, its recettes left out (a recette's fixtures may name files on purpose). */
function scripts(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (["node_modules", "tests", ".git"].includes(name)) continue;
      scripts(full, out);
    } else if (name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const files = [...scripts(join(ROOT, "scripts")), ...(existsSync(join(ROOT, "hooks")) ? scripts(join(ROOT, "hooks")) : [])];
const STATIC = /^\s*(?:import|export)\s[^;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gm;
const missing = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(STATIC)) {
    const spec = m[1] ?? m[2];
    // A script of the plugin names the file it imports, extension included (Node requires it):
    // an import without one is code a script WRITES into a project (setup-i18n.mjs), not its own.
    if (!/\.(?:mjs|cjs|js|json)$/.test(spec)) continue;
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) missing.push(`${relative(ROOT, file).replace(/\\/g, "/")} -> ${spec}`);
  }
}
check(`les ${files.length} scripts du plugin n'importent que des fichiers livrés`, missing.length === 0, missing.join(" ; "));
check("la recette lit bien des scripts", files.length > 20);

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
