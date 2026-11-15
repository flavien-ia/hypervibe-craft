#!/usr/bin/env node
// test-image-placeholders.mjs - The placeholder images of a fresh project come out of the image
// optimizer (hypervibe-learn of 13/11/2026, the corrective 3.4.31 / 2.5.10). setup-security.mjs
// announced images.remotePatterns and wrote none: next/image then answered 400 for every
// placeholder the rules prescribe (Lorem Picsum, Unsplash). Held here: setup-security.mjs, run on a
// fresh T3 next.config.js, writes the three hosts, once; a project patched by an earlier version
// (headers already there) gets them too; and an `images` key the project already has is never
// touched.
//
//   node scripts/tests/test-image-placeholders.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECURITY = join(ROOT, "scripts", "setup-security.mjs");

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 500)})`}`);
}

// The next.config.js create-t3-app writes.
const T3 = `/**
 * Run \`build\` or \`dev\` with \`SKIP_ENV_VALIDATION\` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {};

export default config;
`;
const HOSTS = ["picsum.photos", "fastly.picsum.photos", "images.unsplash.com"];

/** Runs setup-security.mjs in a fresh folder holding that next.config.js; returns the file after. */
function patched(source, times = 1) {
  const dir = mkdtempSync(join(tmpdir(), "hv-images-"));
  try {
    writeFileSync(join(dir, "next.config.js"), source);
    for (let i = 0; i < times; i++) execFileSync(process.execPath, [SECURITY], { cwd: dir, stdio: "pipe" });
    return readFileSync(join(dir, "next.config.js"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** The config object the file exports, evaluated (its imports dropped). */
async function evaluated(source) {
  const body = source.replace(/^import .*$/gm, "");
  const url = `data:text/javascript;base64,${Buffer.from(body).toString("base64")}`;
  return (await import(url)).default;
}

console.log("── setup-security.mjs : les hôtes des images d'exemple ──");
const once = patched(T3);
let cfg = null;
try {
  cfg = await evaluated(once);
} catch (e) {
  check("le next.config.js patché reste un module valide", false, e.message);
}
const hosts = (cfg?.images?.remotePatterns ?? []).map((p) => `${p.protocol}://${p.hostname}`);
check("un next.config.js T3 neuf, patché, liste les trois hôtes en https", HOSTS.every((h) => hosts.includes(`https://${h}`)) && hosts.length === 3, hosts.join(", "));
check("... à côté des en-têtes de sécurité, poweredByHeader et reactStrictMode", cfg?.poweredByHeader === false && cfg?.reactStrictMode === true && typeof cfg?.headers === "function");
check("... et l'objet vide se referme sur sa ligne", /\n {2}\},\n\};\n/.test(once), once);
const twice = patched(T3, 2);
check("relancé, le script ne change plus rien (une seule clé images)", twice === once && (twice.match(/\bimages\s*:/g) ?? []).length === 1);

const own = T3.replace("const config = {};", "const config = {\n  images: { unoptimized: true },\n};");
const kept = patched(own);
check("une clé images du projet n'est jamais touchée", /images: \{ unoptimized: true \}/.test(kept) && !/picsum/.test(kept) && (kept.match(/\bimages\s*:/g) ?? []).length === 1, kept);
const earlier = patched(T3).replace(/ {2}images: \{[\s\S]*?\n {2}\},\n/, "");
check("(témoin) un projet patché par une version d'avant, en-têtes déjà là et sans images", /X-Content-Type-Options/.test(earlier) && !/\bimages\s*:/.test(earlier));
const caught = patched(earlier);
check("... reçoit les hôtes à son tour, sans second bloc d'en-têtes", HOSTS.every((h) => caught.includes(`hostname: "${h}"`)) && (caught.match(/X-Content-Type-Options/g) ?? []).length === 1, caught);

console.log(`\n${checks - failures}/${checks} checks`);
if (failures) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
