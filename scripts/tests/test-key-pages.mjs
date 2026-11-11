#!/usr/bin/env node
// test-key-pages.mjs - Where a person goes to fetch a key (3.4.29 / 2.5.8):
//   - the browser receives the page's whole address: on Windows it never goes through cmd, which
//     reads an address as a command line and cuts it at its first "&" (seen on 11/11/2026, with
//     the address of Cloudflare's pre-filled token page);
//   - the window that waits for a key says, in the person's language, to send a screenshot when
//     the page does not look like what Claude described (people got stuck there, November 2026),
//     and only that window: not the one that signs in or unlocks the vault;
//   - /_collect-secret says it every time it opens a page for a key.
//
//   node scripts/tests/test-key-pages.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => (existsSync(join(ROOT, ...p)) ? readFileSync(join(ROOT, ...p), "utf8") : "");

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}

console.log("── L'adresse arrive entière dans le navigateur ──");
const open = read("scripts", "open-url.mjs");
const win = open.slice(open.indexOf('p === "win32"'), open.indexOf("} else {", open.indexOf('p === "win32"')));
check("sous Windows, l'adresse va au navigateur par url.dll, sans ligne de commande entre les deux", /cmd = "rundll32\.exe";\s*args = \["url\.dll,FileProtocolHandler", url\];/.test(win), win.slice(0, 200));
check("... et jamais par cmd, qui la couperait à son premier « & »", !/["']cmd["']/.test(win) && !/["']start["']/.test(win));
check("aucun lancement direct, l'adresse reste un argument (shell: false)", /shell: false/.test(open));

console.log("\n── La capture d'écran, au moment où l'on bloque ──");
const { makeT } = await import(pathToFileURL(join(ROOT, "scripts", "vault", "i18n.mjs")).href);
for (const lang of ["en", "fr"]) {
  const s = makeT(lang)("stuckOnPage");
  check(`la fenêtre le dit en ${lang} : une capture d'écran, collée dans Claude`, typeof s === "string" && s !== "stuckOnPage" && (lang === "en" ? /screenshot/i.test(s) && /Claude/.test(s) : /capture/i.test(s) && !/[^\x00-\x7f]/.test(s) && /Claude/.test(s)), s);
}
const inter = read("scripts", "vault", "interactive.mjs");
check("... seulement dans la fenêtre qui attend une clé (add, collect-env), jamais à la connexion ni au déverrouillage", /if \(cmd === "add" \|\| cmd === "collect-env"\) console\.log\(t\("stuckOnPage"\)\);/.test(inter) && (inter.match(/stuckOnPage/g) ?? []).length === 1);
const cs = read("skills", "_collect-secret", "SKILL.md");
check("/_collect-secret l'annonce à chaque page ouverte pour une clé", /If this page does not look like what I describe, take a screenshot and paste it here/.test(cs) && /every time a page is opened for a key/.test(cs));

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
