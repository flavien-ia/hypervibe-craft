#!/usr/bin/env node
// admin-gate.mjs - The gate of a project's admin space (3.4.17): the helper every page of
// admin/(protected)/ calls on its first line (src/server/require-admin.ts), and the first barrier in
// front of the whole space, a Next.js middleware (src/middleware.ts, or src/proxy.ts from Next.js 16).
//
// Why: Next.js renders a layout and its page at the same time. When the layout of admin/(protected)/
// redirected a visitor without a session, the page it had already rendered left in the body of the
// redirect (a 307 of several hundred kilobytes), readable with a plain `curl`: found on 26/10/2026 in
// production, on sites built with this harness, whose only check was that layout. So every page
// checks for itself, and the middleware sends a request without a session cookie to the sign-in page
// before anything is rendered. A first barrier, never the only one: a cookie is not a proof.
//
// A middleware the project already has (next-intl, routing by host name...) is NEVER replaced: the
// answer says so, and the skill merges by hand when that is safe, or tells the person what to add.
//
//   node admin-gate.mjs --web-dir <app folder> [--check]
//   last line: {"helper":"written|present|would-write","middleware":{"status":"written|present|existing|would-write","file":"src/middleware.ts","next":15}}
// --check writes nothing and says what it would do.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { render } from "./_render.mjs";

/** The marker of the middleware this file writes: a second run recognises its own file by it. */
export const GATE_MARKER = "hypervibe:admin-gate";

/** Where the helper lives, relative to the app folder. */
export const HELPER_FILE = "src/server/require-admin.ts";

/** Every file Next.js could read as the project's middleware: none of them is ever replaced. */
export const MIDDLEWARE_CANDIDATES = ["src/", ""].flatMap((base) =>
  ["middleware", "proxy"].flatMap((name) => ["ts", "js", "mjs", "mts", "tsx", "jsx"].map((ext) => `${base}${name}.${ext}`)),
);

/** The major version of Next.js the project runs: the installed one first (resolved the way Node
 *  resolves it, so a monorepo's hoisted copy counts), then the range of its package.json; null when
 *  neither says (a tag such as "latest", a workspace link, no package.json). */
export function nextMajor(webDir) {
  try {
    const req = createRequire(join(resolve(webDir), "package.json"));
    const version = JSON.parse(readFileSync(req.resolve("next/package.json"), "utf8")).version;
    const major = Number(String(version).split(".")[0]);
    if (Number.isInteger(major) && major > 0) return major;
  } catch {
    // Not installed (yet): the range says it.
  }
  try {
    const pkg = JSON.parse(readFileSync(join(webDir, "package.json"), "utf8"));
    const range = String({ ...pkg.devDependencies, ...pkg.dependencies }.next ?? "");
    const m = range.match(/^[\^~>=v\s]*(\d+)(?:\.|$)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** The file the middleware goes in: src/proxy.ts from Next.js 16 (the version that renamed it),
 *  src/middleware.ts otherwise, and when the version is unknown (Next.js 16 still reads that name). */
export function gateFileFor(major) {
  return Number.isInteger(major) && major >= 16 ? "src/proxy.ts" : "src/middleware.ts";
}

/** The middleware files the project already has. */
export function existingMiddleware(webDir) {
  return MIDDLEWARE_CANDIDATES.filter((rel) => existsSync(join(webDir, rel)));
}

/** The helper, written from the template when the project does not have it yet. */
export function ensureRequireAdmin(webDir, { check = false } = {}) {
  const dest = join(webDir, HELPER_FILE);
  if (existsSync(dest)) return "present";
  if (check) return "would-write";
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, render("auth/admin/require-admin.ts", {}));
  return "written";
}

/** The first barrier: written only when the project has no middleware at all. */
export function ensureAdminMiddleware(webDir, { check = false } = {}) {
  const next = nextMajor(webDir);
  const existing = existingMiddleware(webDir);
  if (existing.length) {
    const ours = existing.find((rel) => {
      try {
        return readFileSync(join(webDir, rel), "utf8").includes(GATE_MARKER);
      } catch {
        return false;
      }
    });
    return ours ? { status: "present", file: ours, next } : { status: "existing", file: existing[0], next };
  }
  const file = gateFileFor(next);
  if (check) return { status: "would-write", file, next };
  mkdirSync(dirname(join(webDir, file)), { recursive: true });
  writeFileSync(join(webDir, file), render("auth/admin/middleware.ts", {}));
  return { status: "written", file, next };
}

// ─── Launched as a script, or imported ────────────────────────────────────────
// Node gives a module its real path and keeps in argv[1] the path as it was typed. Compared as
// they come, the two differ as soon as the plugin is reached through a symbolic link (macOS's
// temporary folder, a ~/.claude kept by a configuration repository): the script then did
// nothing and exited 0, "I could not" read as "nothing to report" (outside review, 3.3.9).
// Both are read to their real path. The same block in every script, held by
// scripts/tests/test-entry-point.mjs.
import { realpathSync as realPathOf } from "node:fs";
import { fileURLToPath as pathOfUrl } from "node:url";
function launchedDirectly() {
  try {
    if (!process.argv[1]) return false;
    const self = realPathOf(pathOfUrl(import.meta.url));
    const launched = realPathOf(process.argv[1]);
    return process.platform === "win32" ? self.toLowerCase() === launched.toLowerCase() : self === launched;
  } catch {
    return false;
  }
}

if (launchedDirectly()) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--web-dir");
  const webDir = resolve(at >= 0 && args[at + 1] ? args[at + 1] : ".");
  const check = args.includes("--check");
  if (!existsSync(join(webDir, "package.json"))) {
    console.error(`No package.json in ${webDir}: pass --web-dir <app folder>.`);
    process.exit(1);
  }
  const helper = ensureRequireAdmin(webDir, { check });
  const middleware = ensureAdminMiddleware(webDir, { check });
  if (middleware.status === "existing") {
    console.log(`The project already has a middleware (${middleware.file}): left as it is. Merge the admin gate into it by hand when that is safe (templates/auth/admin/middleware.ts), or tell the person what to add.`);
  }
  console.log(JSON.stringify({ helper, middleware }));
}
