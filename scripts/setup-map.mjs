#!/usr/bin/env node
// setup-map.mjs - Scaffold MapLibre GL JS + react-map-gl into a Next.js project.
//
// Usage:
//   node setup-map.mjs --web-dir <path> [--layout embedded|mapfirst]
//   node setup-map.mjs --web-dir <path> --upgrade
//
// Layouts:
//   embedded  (default) - installs map.tsx + map-loader.tsx. Suitable for
//                          embedding a map as a section inside a content page
//                          (contact page, footer, "where we are" block, etc.).
//   mapfirst             - additionally installs map-shell.tsx, a generic
//                          layout chassis for map-first pages (the map IS the
//                          page). Provides viewport-minus-header lock, a
//                          desktop sidebar slot, and a mobile bottom-Sheet.
//
// --upgrade              moves a project whose map was scaffolded on MapLibre
//                          v5 (the ^5.24.0 pin, until 2026-09) to v6: bumps
//                          both packages, adds the worker wiring (step 3),
//                          points every file that imports react-map-gl or
//                          maplibre-gl at the worker module, and drops the
//                          stale v5 pin comment from map.tsx. Never touches
//                          markers, pages or styles. Safe to re-run.
//
// What it does (deterministic, no questions, no user input):
//   1. Install runtime deps: maplibre-gl + react-map-gl, pinned below
//      (react-map-gl re-exports its types - no @types package needed).
//   2. Copy template files:
//        <web-dir>/src/components/site/map.tsx              (not with --upgrade)
//        <web-dir>/src/components/site/map-loader.tsx       (not with --upgrade)
//        <web-dir>/src/components/site/map-shell.tsx        (only when --layout=mapfirst)
//        <web-dir>/src/components/site/maplibre-worker.ts   (always)
//        <web-dir>/scripts/copy-maplibre-worker.mjs         (always)
//   3. Wire the MapLibre v6 web worker: `predev` / `prebuild` / `prepreview`
//      hooks that copy it into public/maplibre/, a .gitignore entry for that
//      folder, and a first copy right away (maplibre-worker.ts says why).
//   4. Print a JSON handoff so Claude knows what was created + where.
//
// What it does NOT do (Claude handles afterwards):
//   - Wiring the components into a specific page (varies per use case).
//   - Defining the markers data (inline array, `src/lib/locations.ts`, DB…).
//   - Adding the SEO/a11y <noscript> fallback (page-specific).
//   - _update-claude-md + _update-privacy-policy invocations (Claude calls
//     these directly with project-specific phrasing).
//
// Refuses to run if src/components/site/map.tsx already exists, unless --upgrade.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureToolsInPath } from "./_ensure-tools-path.mjs";
import { isI18nSetUp } from "./_i18n-detect.mjs";
import { addCspPreset } from "./csp.mjs";

ensureToolsInPath();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Version pins ─────────────────────────────────────────────────────
// Both libraries are pinned on their tested major: the templates call their
// API directly.
//
// maplibre-gl: v6 line, never below 6.4.1. Every release up to 6.4.0,
//   including the whole v5 line (never patched), carries GHSA-jrc7-96c5-q579,
//   a critical XSS in the sanitizer that renders attribution strings. ^6.9.0
//   is the version tested end to end on 2026-09-10 (Next 15.5, Turbopack dev
//   and webpack build). v6 is ESM-only and needs its web worker served by the
//   app: see step 3.
// react-map-gl: never below 8.1.2, the first release that supports MapLibre
//   v6. 8.1.1 and older read `map.transform`, removed in v6, so every camera
//   event throws "Cannot read properties of undefined (reading 'center')".
//
// Raise either pin only after testing the new major in a real Next.js page:
// camera events (pan, zoom, fitBounds), GeoJSON layers, and the worker
// (vector tiles must render, `onLoad` must fire), in dev AND in a build.
//
// Kept literally so dependency scanners can read it (the recette
// scripts/tests/test-map-pins.mjs fails if it drifts from the constants):
//   `pnpm add maplibre-gl@^6.9.0 react-map-gl@^8.1.3`
const MAPLIBRE_SPEC = "maplibre-gl@^6.9.0";
const REACT_MAP_GL_SPEC = "react-map-gl@^8.1.3";

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let webDir = ".";
let layout = "embedded"; // embedded | mapfirst
let upgrade = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--web-dir" && args[i + 1]) webDir = args[++i];
  else if (a === "--layout" && args[i + 1]) layout = args[++i];
  else if (a === "--upgrade") upgrade = true;
  else {
    console.error(`Unknown arg: ${a}`);
    process.exit(1);
  }
}
webDir = resolve(webDir);

if (!["embedded", "mapfirst"].includes(layout)) {
  console.error(`❌ --layout must be "embedded" or "mapfirst" (got "${layout}").`);
  process.exit(1);
}

const pkgPath = join(webDir, "package.json");
if (!existsSync(pkgPath)) {
  console.error(`❌ No package.json found at ${webDir}. Pass --web-dir <path>.`);
  process.exit(1);
}

const componentsDir = join(webDir, "src", "components", "site");
const mapFile = join(componentsDir, "map.tsx");
const loaderFile = join(componentsDir, "map-loader.tsx");
const shellFile = join(componentsDir, "map-shell.tsx");
const workerModuleFile = join(componentsDir, "maplibre-worker.ts");
const copyScriptFile = join(webDir, "scripts", "copy-maplibre-worker.mjs");
const templatesDir = resolve(__dirname, "..", "templates", "map");
const rel = (p) => relative(webDir, p).replace(/\\/g, "/");

if (upgrade) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps["maplibre-gl"] && !deps["react-map-gl"]) {
    console.error(
      "❌ --upgrade: this project has no maplibre-gl / react-map-gl dependency, nothing to upgrade. Run without --upgrade to scaffold a map.",
    );
    process.exit(1);
  }
} else if (existsSync(mapFile)) {
  console.error(
    `❌ ${mapFile} already exists - /add-map has already run here. Pass --upgrade to move an existing map to MapLibre v6, or delete the file first to re-scaffold.`,
  );
  process.exit(1);
}

const warnings = [];
const actions = [];

// ─── 1. Install deps ─────────────────────────────────────────────────
// Both ranges are written into package.json, then `pnpm install` resolves
// them: no `^` goes through a shell or through `pnpm add`, which both lost it
// (checked on 2026-09-10).
//   - On Windows the shell is cmd.exe, where a bare `^` is an escape
//     character: `maplibre-gl@^5.24.0`, passed as an unquoted argument,
//     reached pnpm as `maplibre-gl@5.24.0` and landed as an exact version.
//   - `pnpm add` keeps an exact pin exact when it moves it to a new version:
//     over that `5.24.0`, `pnpm add maplibre-gl@^6.9.0` writes `6.9.0`.
// An exact version never receives a patch release, security fixes included.
console.log(`▸ Installing ${MAPLIBRE_SPEC} + ${REACT_MAP_GL_SPEC}`);
const manifest = JSON.parse(readFileSync(pkgPath, "utf8"));
manifest.dependencies ??= {};
for (const spec of [MAPLIBRE_SPEC, REACT_MAP_GL_SPEC]) {
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at);
  if (manifest.devDependencies?.[name]) delete manifest.devDependencies[name];
  manifest.dependencies[name] = spec.slice(at + 1);
}
// Same order as pnpm writes it (plain code-point sort), so the diff stays small.
manifest.dependencies = Object.fromEntries(
  Object.entries(manifest.dependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + "\n");
const install = spawnSync("pnpm install", { cwd: webDir, stdio: "inherit", shell: true });
if (install.status !== 0) {
  console.error(`❌ pnpm install failed (exit ${install.status})`);
  process.exit(1);
}
actions.push(`✓ Installed ${MAPLIBRE_SPEC} + ${REACT_MAP_GL_SPEC}`);

// ─── 2. Copy template files ──────────────────────────────────────────
mkdirSync(componentsDir, { recursive: true });

if (!upgrade) {
  const srcMap = join(templatesDir, "map.tsx");
  const i18nActive = isI18nSetUp(webDir);
  const srcLoader = join(templatesDir, i18nActive ? "map-loader.i18n.tsx" : "map-loader.tsx");
  const srcShell = join(templatesDir, "map-shell.tsx");

  if (!existsSync(srcMap) || !existsSync(srcLoader)) {
    console.error(`❌ Template files missing in ${templatesDir} - the plugin install may be broken.`);
    process.exit(1);
  }

  copyFileSync(srcMap, mapFile);
  copyFileSync(srcLoader, loaderFile);
  actions.push(`✓ ${rel(mapFile)}`);
  actions.push(`✓ ${rel(loaderFile)}${i18nActive ? " (i18n variant)" : ""}`);

  // If i18n is active, merge the map feature's messages into each locale.
  if (i18nActive) {
    const mergeScript = join(__dirname, "_i18n-merge-messages.mjs");
    if (existsSync(mergeScript)) {
      const res = spawnSync("node", [mergeScript, "--web-dir", webDir, "--feature", "map"], {
        stdio: "pipe",
        encoding: "utf8",
      });
      if (res.status === 0) {
        actions.push("✓ messages merged for feature 'map'");
      } else {
        warnings.push(`MESSAGES_MERGE_FAILED: ${(res.stderr || res.stdout || "").trim()}`);
      }
    } else {
      warnings.push(
        "MERGE_SCRIPT_MISSING: _i18n-merge-messages.mjs not found - map keys not merged into messages/*.json",
      );
    }
  }

  if (layout === "mapfirst") {
    if (!existsSync(srcShell)) {
      console.error(`❌ map-shell.tsx template missing in ${templatesDir} - the plugin install may be broken.`);
      process.exit(1);
    }
    copyFileSync(srcShell, shellFile);
    actions.push(`✓ ${rel(shellFile)}`);

    // Sanity check: shadcn Sheet must be present for MapShell to compile.
    const sheetFile = join(webDir, "src", "components", "ui", "sheet.tsx");
    if (!existsSync(sheetFile)) {
      warnings.push(
        "SHEET_MISSING: src/components/ui/sheet.tsx not found. MapShell uses shadcn/ui Sheet - run `npx shadcn@latest add sheet` before importing MapShell.",
      );
    }
  }
}

// Plugin-owned helpers: written when absent, left alone (with a warning) when
// the project already holds a different version of them.
function installOwned(name, dest) {
  const src = join(templatesDir, name);
  if (!existsSync(src)) {
    console.error(`❌ Template ${name} missing in ${templatesDir} - the plugin install may be broken.`);
    process.exit(1);
  }
  const want = readFileSync(src, "utf8");
  if (existsSync(dest)) {
    const have = readFileSync(dest, "utf8");
    if (have.replace(/\r\n/g, "\n") !== want.replace(/\r\n/g, "\n")) {
      warnings.push(`KEPT_EXISTING: ${rel(dest)} differs from the plugin's templates/map/${name} and was left as is.`);
    }
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, want);
  actions.push(`✓ ${rel(dest)}`);
}
installOwned("maplibre-worker.ts", workerModuleFile);
installOwned("copy-maplibre-worker.mjs", copyScriptFile);

// ─── 3. Worker wiring ────────────────────────────────────────────────
// MapLibre v6 must be told where its web worker lives, and under Next.js the
// file has to be served from public/: neither Turbopack nor webpack emits the
// worker's `maplibre-gl-shared.mjs` sibling. The copy runs before every
// script that starts Next, so it always matches the installed version.
// `prebuild` is what Vercel triggers through `pnpm run build` (pre hooks
// checked on pnpm 10.28, 11.1 and 12.3 on 2026-09-10). `postinstall` would not
// do: package managers skip it when an install has nothing to do.
const HOOK = "node ./scripts/copy-maplibre-worker.mjs";
const HOOKED_SCRIPTS = ["dev", "build", "preview"];
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const scripts = pkg.scripts ?? {};
const nextScripts = {};
const hooks = [];
for (const name of Object.keys(scripts)) {
  const target = name.startsWith("pre") ? name.slice(3) : null;
  if (target && HOOKED_SCRIPTS.includes(target) && scripts[target] !== undefined) continue; // re-emitted before its script
  if (HOOKED_SCRIPTS.includes(name)) {
    const pre = `pre${name}`;
    const current = scripts[pre];
    const value =
      current === undefined ? HOOK : current.includes("copy-maplibre-worker") ? current : `${current} && ${HOOK}`;
    if (value !== current) hooks.push(pre);
    nextScripts[pre] = value;
  }
  nextScripts[name] = scripts[name];
}
if (!HOOKED_SCRIPTS.some((name) => scripts[name] !== undefined)) {
  warnings.push(
    `NO_NEXT_SCRIPTS: ${rel(pkgPath)} has no dev/build/preview script - add \`${HOOK}\` as the pre hook of whatever script starts Next.`,
  );
} else if (hooks.length) {
  pkg.scripts = nextScripts;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  actions.push(`✓ package.json: ${hooks.join(", ")} copy the MapLibre worker`);
}

const gitignorePath = join(webDir, ".gitignore");
const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
if (!/^\/?public\/maplibre\/?[ \t]*\r?$/m.test(gitignore)) {
  const block = "# MapLibre worker, recopié depuis node_modules par scripts/copy-maplibre-worker.mjs\n/public/maplibre/\n";
  writeFileSync(gitignorePath, gitignore ? `${gitignore.replace(/\s*$/, "")}\n\n${block}` : block);
  actions.push("✓ .gitignore: /public/maplibre/");
}

const firstCopy = spawnSync(process.execPath, [copyScriptFile], { cwd: webDir, encoding: "utf8" });
if (firstCopy.status === 0) actions.push("✓ MapLibre worker copied to public/maplibre/");
else warnings.push(`WORKER_COPY_FAILED: ${(firstCopy.stderr || firstCopy.stdout || "").trim()}`);

// ─── 4. Upgrade: point the existing map code at the worker module ───
const upgraded = [];
const toReview = [];
if (upgrade) {
  const WORKER_NOTE = "// Worker MapLibre (v6) : voir src/components/site/maplibre-worker.ts.\n";
  const OLD_PIN_COMMENT =
    /\r?\n\/\/\r?\n\/\/ ⚠️ `maplibre-gl` est épinglé en \^5\.24\.0[\s\S]*?annoncera le support de MapLibre v6\.(?=\r?\n)/;
  const STALE = /épingl|5\.24|map\.transform|supporte pas encore MapLibre v6/;
  // A value import (not `import type`) from either library: the file builds maps.
  const usesMaplibre = (src) =>
    /import\s+(?!type\s)[^;]*?\bfrom\s+["'](?:react-map-gl|maplibre-gl)(?:\/[^"']*)?["']/.test(src);
  const addWorkerImport = (src, specifier) => {
    if (/["'][^"']*maplibre-worker["']/.test(src)) return src;
    const line = `${WORKER_NOTE}import "${specifier}";`;
    const css = /^import\s+["']maplibre-gl\/dist\/maplibre-gl\.css["'];?[ \t]*\r?$/m;
    if (css.test(src)) return src.replace(css, (m) => `${line}\n${m}`);
    const directive = /^["']use client["'];?[ \t]*\r?$/m;
    if (directive.test(src)) return src.replace(directive, (m) => `${m}\n\n${line}`);
    return `${line}\n${src}`;
  };
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      const p = join(dir, entry.name);
      if (entry.isDirectory()) return walk(p);
      return /\.(tsx?|jsx?)$/.test(entry.name) ? [p] : [];
    });

  const srcDir = join(webDir, "src");
  for (const file of existsSync(srcDir) ? walk(srcDir) : []) {
    if (file === workerModuleFile) continue;
    const before = readFileSync(file, "utf8");
    if (!usesMaplibre(before)) continue;
    let after = file === mapFile ? before.replace(OLD_PIN_COMMENT, "") : before;
    after = addWorkerImport(after, file === mapFile ? "./maplibre-worker" : "~/components/site/maplibre-worker");
    if (after !== before) {
      writeFileSync(file, after);
      upgraded.push(rel(file));
    }
    if (STALE.test(after)) toReview.push(rel(file));
  }
  if (upgraded.length) actions.push(`✓ worker import added to: ${upgraded.join(", ")}`);
  if (toReview.length) {
    warnings.push(
      `REVIEW_MAP_COMMENTS: ${toReview.join(", ")} still mention the old v5 pin or map.transform - reword those comments by hand.`,
    );
  }
}

// ─── 4b. Content-Security-Policy: the tiles' host ───────────────────
// The visitor's browser fetches the style, tiles, sprites and fonts from OpenFreeMap: its host goes
// into the reported part of the site's policy (scripts/csp.mjs keeps the list, preset
// "openfreemap"). A policy of the person's own is never touched: what to add by hand is said.
{
  const csp = addCspPreset(webDir, "openfreemap");
  if (csp.state === "written" || csp.state === "current") actions.push(`✓ ${csp.file}: the Content-Security-Policy lets the map's tiles through`);
  else warnings.push(`CSP_REVIEW: ${csp.reason ?? csp.state}`);
}

// ─── 5. Handoff JSON ─────────────────────────────────────────────────
if (upgrade) {
  console.log(`
✅ Map upgraded to MapLibre v6 (${MAPLIBRE_SPEC}, ${REACT_MAP_GL_SPEC}).

   Worker     : public/maplibre/ (copied by scripts/copy-maplibre-worker.mjs
                before dev, build and preview; folder ignored by git)
   Module     : src/components/site/maplibre-worker.ts (setWorkerUrl)

Next (Claude handles):
  - Review the files listed under REVIEW_MAP_COMMENTS, if any.
  - Restart the dev server after clearing .next (Turbopack caches the old
    module resolution), then check that the map shows streets and labels.
`);
} else {
  console.log(`
✅ Map scaffolding done (layout: ${layout}).

   Component  : src/components/site/map.tsx        (client-only MapView)
   Loader     : src/components/site/map-loader.tsx (SSR-safe MapLoader)${
     layout === "mapfirst" ? `\n   Shell      : src/components/site/map-shell.tsx  (map-first layout chassis)` : ""
   }
   Worker     : src/components/site/maplibre-worker.ts + public/maplibre/

Built-in :
  • ResizeObserver on the map container + onLoad resize() so tiles never
    look stretched/blurry when the parent layout settles after first paint.
  • fitToMarkers (default true) auto-frames the camera to all markers on
    load and on markers change (e.g. when filters apply).
  • scrollZoom defaults to false (won't hijack page scroll on content pages).
    Pass scrollZoom={true} explicitly for map-first usage.
  • MapLibre v6 web worker served from public/maplibre/, copied from
    node_modules before dev, build and preview (folder ignored by git).
    Any other component that renders a map must first
    \`import "~/components/site/maplibre-worker"\`.

Tile provider : OpenFreeMap (free, no API key, no cookies, EU servers).
                Style URL centralised at the top of map.tsx - swap in 1 line
                if OpenFreeMap ever goes down. Fallbacks documented in the
                file's header comment.

Next (Claude handles):
  - Wire <MapLoader markers={...} /> into the target page (server component).
  - For map-first pages: wrap with <MapShell map={…} sidebar={…} />.
  - Define markers data (inline array, src/lib/locations.ts, or a DB table).
  - Add <noscript> fallback list with addresses + Google Maps deeplinks for
    SEO and accessibility.
  - Add an entry "OpenFreeMap" to src/lib/subprocessors.json (data processor
    for visitor IP at tile load - EU servers, no cookies, donation-funded).
  - Update CLAUDE.md with a note pointing to map-loader.tsx + the fallback
    style URLs in map.tsx's header.
`);
}

// Last line = parseable JSON for orchestration (mirrors setup-db.mjs style)
console.log(
  JSON.stringify({
    success: true,
    mode: upgrade ? "upgrade" : "scaffold",
    layout: upgrade ? null : layout,
    versions: { maplibre: MAPLIBRE_SPEC, reactMapGl: REACT_MAP_GL_SPEC },
    mapFile: rel(mapFile),
    loaderFile: rel(loaderFile),
    shellFile: !upgrade && layout === "mapfirst" ? rel(shellFile) : null,
    workerModule: rel(workerModuleFile),
    workerScript: rel(copyScriptFile),
    hooks,
    upgraded,
    actions,
    warnings,
  }),
);
