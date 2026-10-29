#!/usr/bin/env node
// bootstrap-init.mjs - Deterministic early-phase bootstrap for a new T3 project.
//
// Runs all mechanical steps of /bootstrap without LLM involvement, from empty
// directory to first Vercel deploy.
//
// Sequence (all idempotency caveats below):
//   1. Preflight: required CLIs present + authenticated, cwd not inside a git repo.
//   2. npx create-t3-app@latest <name> --CI --noInstall --noGit ... then
//      pnpm install (we control the package manager and git entirely).
//      Right before that install, pnpm-workspace.yaml receives the security
//      overrides (PNPM_OVERRIDES in _pnpm-workspace.mjs), so the very first
//      lockfile already records them.
//   3. Bump drizzle-orm + drizzle-kit to latest (CVE-2025-XXXX, fixed in 0.45.2).
//   4. Cleanup T3 demo: delete src/server/api/routers/post.ts, strip postRouter
//      from root.ts, replace src/app/page.tsx with a minimal placeholder.
//   4b. Normalize lint scripts to the ESLint CLI: `next lint` is deprecated since
//      Next 15.5 and removed in Next 16. If the scaffolder emitted `next lint`,
//      rewrite to `eslint .` / `eslint . --fix`, and ensure a flat config +
//      eslint deps exist (no-op when the scaffolder already did the right thing).
//   5. Inject src/server/api/routers/healthcheck.ts + register in root.ts so
//      appRouter is never empty (avoids TS2314 at build time).
//   6. shadcn/ui init (via npx - pnpm dlx breaks with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND),
//      add base components, create src/components/ui/link-button.tsx
//      (wraps next/link with buttonVariants - shadcn v4 has no asChild).
//   7. Run setup-security.mjs (headers + remotePatterns + rate limiter + rateLimitedProcedure).
//   8. Run setup-seo.mjs (metadata + sitemap + robots + JSON-LD).
//   9. notFoundPage: write a polished src/app/not-found.tsx (server component, shadcn Button).
//  10. claudeMdCore: write the project's initial CLAUDE.md with the unconditional
//      T3-specific conventions. Addons (add-db, add-email, ...) extend it later
//      via _update-claude-md, and the bootstrap SKILL adds CDC-related lines after
//      the user-facing CDC step.
//  10b. vercelConfig: write vercel.json with `regions: ["fra1"]` so all
//      serverless functions run in Frankfurt (EU) rather than the default
//      iad1 (US East). Lower latency for EU visitors + EU data residency.
//  10b'. launchJsonConfig: write .claude/launch.json so the Claude Preview
//      MCP can launch `pnpm dev` instantly at the end of bootstrap (when the
//      user accepts the preview prompt). Without it, the MCP probes for
//      ~30s trying to find a runnable config → bad UX.
//  10c. privacyPolicy: write a data-driven RGPD privacy policy page
//      (src/app/politique-de-confidentialite/page.tsx) that renders from a
//      subprocessors registry (src/lib/subprocessors.ts). Seed the registry
//      with Vercel via update-privacy-policy.mjs. Each /add-* skill that
//      introduces a third-party data processor adds itself to the registry.
//  11. One commit capturing the whole scaffolded state.
//  12. gh repo create + push.
//  13. vercel link.
//  14. push-env-vars.mjs with DATABASE_URL placeholder (syntactically-valid postgres URL,
//      passes T3's z.string().url() Zod validation without making any real connection)
//      and NEXT_PUBLIC_APP_URL (real Vercel URL for prod+preview, localhost for dev).
//      Note: NextAuth is NOT scaffolded by T3 unless --nextAuth is passed (which we don't),
//      so AUTH_SECRET / AUTH_DISCORD_* placeholders are not needed. /add-auth handles them
//      later if the user opts into auth.
//  15. pnpm build locally. This is the gate before the real deploy.
//  16. If build OK → vercel --prod.
//      If build KO → exit non-zero with a clear message, Claude takes over to fix.
//  17. smokeTest: curl the deployed URL with retry, verify 200 + project name appears
//      in the rendered HTML. Catches "deploy succeeded but the live page is broken".
//      Uses the actual alias URL captured by deploy() - Vercel may suffix the bare
//      ${name}.vercel.app subdomain (henna, nine, …) if it's taken by another user.
//  18. fixAppUrl: if Vercel suffixed the alias, re-push NEXT_PUBLIC_APP_URL with the
//      real URL so the NEXT auto-deploy (triggered by step 19's empty commit + push)
//      bakes the correct value into the client bundle. The first deploy briefly serves
//      the wrong NEXT_PUBLIC_APP_URL but is overwritten ~50s later by the auto-deploy.
//  19. verifyAutoDeploy: empty commit + git push + check `vercel[bot]` picks up the
//      deployment via gh api. NON-BLOCKING - if the GH↔Vercel integration isn't wired,
//      adds a warning to the handoff banner so Claude can guide the user to fix it.
//
// After a successful run, control returns to the caller (typically Claude via
// /bootstrap) for the cahier-des-charges conversation, addon invocations (add-db,
// add-auth, ...), and the application build.
//
// Usage:
//   node bootstrap-init.mjs --name my-project \
//     --description "Short SEO description, ~150 chars" \
//     [--locale fr_FR] [--private|--public] [--skip-deploy]
//
// Run this from the directory WHERE the project folder should be created
// (e.g. C:/DEV or ~/dev). The script creates <cwd>/<name>/ and cd's into it.
//
// Idempotency: NOT idempotent. It's a one-shot from empty to deployed. If any
// step fails, the partial state is left on disk for inspection; fix the cause
// and either nuke the folder + retry, or have Claude continue from where it died.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, rmdirSync } from "node:fs";
import { resolve, dirname, join, basename, relative } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { readIdentity, shapeOf } from "./git-identity.mjs";
import { render } from "./_render.mjs";
import { ensureToolsInPath } from "./_ensure-tools-path.mjs";
import { buildRuleSets } from "./rules/rules.mjs";
import { PROJECT_BLOCK } from "./rules/blocks.mjs";
import { syncManagedBlock } from "./rules/managed-block.mjs";
import { NPMRC_PUBLIC_HOIST, PNPM_OVERRIDES, PNPM_PUBLIC_HOIST, addLines, pnpmReadsHoist, setWorkspaceBlock } from "./_pnpm-workspace.mjs";
import { parseDeployOutput } from "./vercel/parse-deploy-output.mjs";
import { loadAuthToken, readCliCurrentTeam } from "./_vercel-auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prepend common CLI install dirs to process.env.PATH so the preflight subprocess
// invocations (`pnpm`, `gh`, `vercel`, `git`, `node`) find their binaries even if
// the parent Claude Code session inherited a stale PATH (typical when /start has
// just installed tools but Claude was launched before the install).
ensureToolsInPath();

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let name = "";
let description = "";
let locale = "fr_FR";
let visibility = "private";
let skipDeploy = false;
// Stage/demo mode: skip the local `pnpm build` gate. The first deploy builds on
// Vercel's own servers anyway, and the local build is the only step that fetches
// the Google font (next/font) over the user's network: on a flaky venue or train
// connection it was measured at 17 minutes of retries (2026-09-10).
let skipLocalBuild = false;
// Vercel scope (team slug). Only needed on a multi-scope account when the
// automatic resolution in vercelLink() cannot settle it on its own.
let scopeArg = "";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--name" && args[i + 1]) name = args[++i];
  else if (a === "--description" && args[i + 1]) description = args[++i];
  else if (a === "--locale" && args[i + 1]) locale = args[++i];
  else if (a === "--private") visibility = "private";
  else if (a === "--public") visibility = "public";
  else if (a === "--skip-deploy") skipDeploy = true;
  else if (a === "--skip-local-build") skipLocalBuild = true;
  else if (a === "--scope" && args[i + 1]) scopeArg = args[++i];
  else fail(`Unknown arg: ${a}`);
}

if (!name || !description) {
  fail(
    'Usage: node bootstrap-init.mjs --name NAME --description "DESC" ' +
      "[--locale fr_FR] [--private|--public] [--skip-deploy] [--skip-local-build] [--scope <vercel-scope>]",
  );
}
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) {
  fail(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${name}`);
}

const CWD = process.cwd();
const PROJECT_DIR = resolve(CWD, name);

// ─── helpers ──────────────────────────────────────────────────────────
// Step tracking - used to print a structured handoff if/when we fail, so a
// downstream agent (Claude Code) can pick up cleanly without re-reading the
// whole log. `STEPS` is the full ordered pipeline; `current` is what's running.
const STEPS = [
  "preflight",
  "scaffoldT3",
  "gitattributes",
  "bumpDrizzle",
  "cleanupDemo",
  "eslintCli",
  "healthcheck",
  "shadcn",
  "security",
  "seo",
  "notFoundPage",
  "claudeMdCore",
  "vercelConfig",
  "launchJsonConfig",
  "privacyPolicy",
  "commit",
  "ghRepo",
  "vercelLink",
  "gitConnect",
  "pushEnvVars",
  "localBuild",
  "deploy",
  "smokeTest",
  "fixAppUrl",
  "verifyAutoDeploy",
];
const completed = [];
const warnings = [];
let current = null;

async function step(name, fn) {
  current = name;
  await fn();
  completed.push(name);
  current = null;
}

function log(msg) {
  console.log(`\n▸ ${msg}`);
}
function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function warn(msg) {
  console.warn(`  ⚠️  ${msg}`);
  warnings.push(msg);
}
// Retract previously-emitted warning(s) when a later step proves they were a
// false alarm - e.g. `vercel git connect` errored cosmetically but the webhook
// is actually wired (verifyAutoDeploy sees vercel[bot] pick up the push).
// Returns the number of warnings removed.
function unwarn(prefix) {
  let removed = 0;
  for (let i = warnings.length - 1; i >= 0; i--) {
    if (warnings[i].startsWith(prefix)) {
      warnings.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

// Sanity check after a regex-based file modification. Prints a warning if the
// edit didn't actually take effect - typically because T3 changed the file
// structure since this script was written. Doesn't abort: the build gate at
// the end will catch any real breakage.
function expect(file, predicate, label) {
  try {
    const content = readFileSync(file, "utf8");
    if (!predicate(content)) {
      warn(`Sanity check failed in ${file}: ${label}. T3 scaffold may have drifted - verify manually after the run.`);
    }
  } catch (e) {
    warn(`Could not read ${file} for sanity check (${label}): ${e.message}`);
  }
}

function dumpHandoff(success) {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("Bootstrap-init handoff state");
  console.log("────────────────────────────────────────────────────────");
  console.log(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}`);
  if (current) console.log(`❌ Failed at: ${current}`);
  if (remaining.length) console.log(`⏸  Not attempted: ${remaining.join(", ")}`);
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s) during the run:`);
    for (const w of warnings) console.log(`   - ${w}`);
  }
  if (!success) {
    console.log(
      "\nFor the agent picking this up:\n" +
        `  - Project dir on disk: ${PROJECT_DIR}\n` +
        "  - The failure is above the handoff banner. Read the actual error there.\n" +
        "  - Re-run THIS script in a fresh dir if T3 itself failed,\n" +
        "    OR continue manually from the failing step using the SKILL.md as reference.\n" +
        "  - Each step in this script maps 1:1 to a section of the bootstrap SKILL.md.\n",
    );
  }
  console.log("────────────────────────────────────────────────────────");
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  dumpHandoff(false);
  process.exit(1);
}

// Catch unhandled exceptions so they ALSO produce the handoff banner.
process.on("uncaughtException", (e) => {
  console.error(`\n❌ Unhandled exception: ${e.message}`);
  if (e.stack) console.error(e.stack);
  dumpHandoff(false);
  process.exit(1);
});

// Build-approval flags - version-aware.
//
// pnpm 10: `pnpm.onlyBuiltDependencies` in package.json is honored. Passing
//   --config.dangerously-allow-all-builds=true alongside it causes
//   ERR_PNPM_CONFIG_CONFLICT_BUILT_DEPENDENCIES ("Cannot have both
//   neverBuiltDependencies and onlyBuiltDependencies") because pnpm 10
//   internally maps that flag to a neverBuiltDependencies override. No extra
//   CLI flags needed - the onlyBuiltDependencies list we write into package.json
//   (T3 already seeds it, we extend it) is sufficient.
//
// pnpm 11: `pnpm.onlyBuiltDependencies` is silently IGNORED. strictDepBuilds
//   defaults to true → any unapproved postinstall → ERR_PNPM_IGNORED_BUILDS.
//   CLI flags are the only reliable fix. Both flags are required:
//     --config.strict-dep-builds=false  → downgrade error to warning
//     --config.dangerously-allow-all-builds=true → actually run native builds
//   NPM_CONFIG_* env vars are NOT honored by pnpm 11 for these settings.
//
// PNPM_BUILD_FLAGS is set to the right value at the end of preflight(), once
// we know the actual pnpm major version.
let PNPM_BUILD_FLAGS = "";

function run(cmd, cwd, opts = {}) {
  const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : cmd;
  const res = spawnSync(cmdStr, {
    cwd,
    stdio: opts.capture ? "pipe" : "inherit",
    shell: true,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
  if (res.status !== 0 && !opts.allowFail) {
    if (opts.capture) {
      if (res.stdout) process.stderr.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
    }
    fail(`Command failed (exit ${res.status}): ${cmdStr}`);
  }
  return res;
}

/** The identity the first commit will carry, checked by shape, never shown (git-identity.mjs):
 *  a user.email that is not an address would go to GitHub with every commit. On 22/09/2026 a
 *  machine had an address in user.name and what looked like a password in user.email. */
function checkGitIdentity({ effective = false } = {}) {
  let shape;
  try {
    shape = shapeOf(readIdentity({ effective, cwd: CWD }));
  } catch {
    fail("git is not installed. Run /start.");
  }
  const where = effective ? "git config" : "git config --global";
  if (shape.swapped) {
    fail(
      `${where} user.name looks like an email address and user.email is not one: the two were probably swapped. ` +
        "The value is not shown here; if a password was typed into user.email by mistake, change that password. " +
        "Run /start, which repairs it, then retry.",
    );
  }
  if (shape.email === "invalid") {
    fail(
      `${where} user.email is not an email address (its value is not shown here; if a password was typed into it by mistake, change that password). ` +
        "Every commit carries it, and a push publishes it. Run /start, which repairs it, then retry.",
    );
  }
  if (shape.name === "missing" || shape.email === "missing") {
    fail(`${where} ${shape.name === "missing" ? "user.name" : "user.email"} is not set. Run /start, which sets it, then retry.`);
  }
}

function capture(cmd, cwd, opts = {}) {
  return run(cmd, cwd, { capture: true, allowFail: true, ...opts });
}

// ─── Step 1: preflight ────────────────────────────────────────────────
function preflight() {
  log("Preflight");

  if (existsSync(PROJECT_DIR)) {
    fail(`${PROJECT_DIR} already exists. Pick a different --name or remove it first.`);
  }

  const inRepo = capture("git rev-parse --is-inside-work-tree", CWD);
  if (inRepo.status === 0 && inRepo.stdout.trim() === "true") {
    fail(
      `${CWD} is inside a git repo. Run from a plain directory like C:/DEV or ~/dev so ` +
        `the new project gets its own repo.`,
    );
  }

  for (const tool of ["pnpm", "git", "gh", "vercel", "node", "npx"]) {
    const c = capture(`${tool} --version`, CWD);
    if (c.status !== 0) fail(`CLI missing or broken: ${tool}. Install it and retry.`);
  }

  // Check gh auth - robust against false negatives.
  //
  // `gh auth status` (no host) is flaky on Windows because:
  //   1. it queries ALL configured hosts (github.com + GHES + …) - a single
  //      broken host causes exit 1 even if github.com is fine
  //   2. concurrent access to the OS credential manager (VS Code's GH extension,
  //      another gh process, GitHub Desktop…) can transiently fail the keyring
  //      read for ~100-500 ms - gh exits 1 then but the token is valid
  //   3. some scope-warning code paths exit non-zero on stderr noise
  //
  // We do a 3-tier check: scoped status → retry → real API call. We only fail
  // if all three fail. This eliminates the "Token expired ❌ - wait, actually
  // it works" loop reported by users.
  let ghOk = capture("gh auth status -h github.com", CWD).status === 0;
  if (!ghOk) {
    // Brief pause to let any keyring race settle, then retry the scoped status.
    const start = Date.now();
    while (Date.now() - start < 800) {
      // busy-wait ~800ms (we don't have setTimeout in a sync script)
    }
    ghOk = capture("gh auth status -h github.com", CWD).status === 0;
  }
  if (!ghOk) {
    // Final fallback: try a real authenticated API call. If THIS works, the
    // token is genuinely valid and the status command was a false negative.
    ghOk = capture("gh api /user", CWD).status === 0;
    if (ghOk) {
      console.log("⚠️  gh auth status was flaky but `gh api /user` succeeds - continuing.");
    }
  }
  if (!ghOk) fail("gh is not authenticated. Run: gh auth login");

  const vc = capture("vercel whoami", CWD);
  if (vc.status !== 0) fail("vercel is not authenticated. Run: vercel login");

  checkGitIdentity();

  // Detect pnpm major version and set build flags accordingly (see comment above).
  // pnpm 11+ is required by the bootstrap for two reasons:
  //   - the final dependency audit (SKILL Étape 8a) runs `pnpm audit`, which only
  //     works on pnpm 11+; pnpm 10 hits the deprecated /audits/quick endpoint (410)
  //   - the CLI build flags below (strict-dep-builds / dangerously-allow-all-builds)
  //     exist on pnpm 11+.
  // If an older major is found, try a one-shot self-update (non-fatal).
  let pnpmVersion = capture("pnpm --version", CWD).stdout.trim();
  let pnpmMajor = parseInt(pnpmVersion.split(".")[0] ?? "0", 10);
  if (pnpmMajor < 11) {
    console.log(`  → pnpm ${pnpmVersion || "unknown"} (<11): updating to the latest…`);
    run("pnpm self-update", CWD, { allowFail: true });
    pnpmVersion = capture("pnpm --version", CWD).stdout.trim();
    pnpmMajor = parseInt(pnpmVersion.split(".")[0] ?? "0", 10);
    if (pnpmMajor >= 11) {
      console.log(`  → pnpm updated to ${pnpmVersion}`);
    } else {
      warn(
        `pnpm is ${pnpmVersion || "unknown"} (<11) and the auto-update didn't land. ` +
          "Update it manually (`pnpm self-update`, or `npm i -g pnpm@latest`) - " +
          "the final dependency audit (`pnpm audit`) needs pnpm 11+ to work.",
      );
    }
  }
  if (pnpmMajor >= 11) {
    PNPM_BUILD_FLAGS = "--config.strict-dep-builds=false --config.dangerously-allow-all-builds=true";
    console.log(`  → pnpm ${pnpmVersion} (≥11): using CLI build flags`);
  } else {
    PNPM_BUILD_FLAGS = "";
    console.log(`  → pnpm ${pnpmVersion} (<11): onlyBuiltDependencies in package.json is sufficient`);
  }

  ok("All prerequisites OK");
}

// ─── Step 2: scaffold T3 ──────────────────────────────────────────────
// We go through `npx create-t3-app` rather than `pnpm create t3-app` because
// pnpm 10 is strict: `pnpm create/dlx/exec` errors out with
// ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND when cwd has no package.json - which
// is always the case right before scaffolding a brand-new project.
// npx has no such constraint. After scaffold, we wipe the npm-generated
// lockfile + node_modules and re-install with pnpm so the rest of the
// pipeline (shadcn, drizzle, etc.) runs on a clean pnpm install.
function scaffoldT3() {
  // We pass `--noInstall --noGit` to create-t3-app so it just writes the files:
  // no `npm install` (we'll do pnpm install ourselves), no `git init + git add`
  // (we'll init git ourselves with .gitattributes already in place). This
  // avoids the fragile npm→pnpm conversion + git index reconciliation dance
  // that previously lived in scaffoldT3 + gitattributes.
  log("Scaffolding T3 app via npx (--noInstall --noGit)");
  run(
    `npx --yes create-t3-app@latest ${name} --CI --noInstall --noGit --tailwind --trpc --drizzle --appRouter --eslint --dbProvider postgres`,
    CWD,
  );
  if (!existsSync(PROJECT_DIR)) fail("T3 scaffold did not create the expected directory.");

  // Patch package.json to make pnpm happy from the start:
  //   1. Strip `"packageManager": "npm@..."` so pnpm refuses to use npm.
  //   2. Whitelist all packages with native build scripts in `pnpm.onlyBuiltDependencies`
  //      (pnpm ≤10 mechanism - kept for backwards compat). pnpm treats ignored builds as
  //      a HARD ERROR (ERR_PNPM_IGNORED_BUILDS). We include the full T3-stack set:
  //      sharp (image), esbuild (transpiler), @tailwindcss/oxide (Tailwind 4 native),
  //      @swc/core (Next.js), @parcel/watcher (file watching), plus common transitive deps.
  log("Patching package.json for pnpm (strip packageManager, whitelist native-build deps)");
  const pkgPath = join(PROJECT_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.packageManager && pkg.packageManager.startsWith("npm")) {
    delete pkg.packageManager;
  }
  pkg.pnpm ??= {};
  const existing = new Set(pkg.pnpm.onlyBuiltDependencies ?? []);
  const NATIVE_BUILD_DEPS = [
    "sharp",
    "esbuild",
    "@tailwindcss/oxide",
    "@swc/core",
    "@parcel/watcher",
    "bufferutil",
    "utf-8-validate",
    "better-sqlite3",
    "core-js",
    "core-js-pure",
  ];
  for (const dep of NATIVE_BUILD_DEPS) existing.add(dep);
  pkg.pnpm.onlyBuiltDependencies = [...existing].sort();
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // pnpm 11 changed the build-script approval mechanism in two breaking ways:
  //   a) `pnpm.onlyBuiltDependencies` in package.json is silently IGNORED
  //      (replaced by `allowBuilds:` in pnpm-workspace.yaml).
  //   b) `strictDepBuilds` defaults to `true`, so any unapproved postinstall
  //      script → ERR_PNPM_IGNORED_BUILDS → exit 1.
  // The pnpm-workspace.yaml with allowBuilds entries is generated BY `pnpm install`
  // itself (not by `create-t3-app --noInstall`), so we can't pre-patch it.
  // PNPM_BUILD_FLAGS is already set by preflight() based on pnpm major version.
  // pnpm ≥11: CLI flags needed (onlyBuiltDependencies ignored). pnpm ≤10: empty
  // (onlyBuiltDependencies in package.json is sufficient; the CLI flags would
  // conflict with it and cause ERR_PNPM_CONFIG_CONFLICT_BUILT_DEPENDENCIES).
  // Security overrides go into pnpm-workspace.yaml BEFORE the first install,
  // so the very first lockfile records them. Never into package.json: Vercel's
  // pnpm 10 would then stop on ERR_PNPM_LOCKFILE_CONFIG_MISMATCH (see
  // PNPM_OVERRIDES in _pnpm-workspace.mjs).
  setWorkspaceBlock(join(PROJECT_DIR, "pnpm-workspace.yaml"), "overrides", PNPM_OVERRIDES);
  // ESLint's plugins reachable from the project's root, or `pnpm lint` stops on "couldn't find
  // the plugin" (PNPM_PUBLIC_HOIST in _pnpm-workspace.mjs). Before the first install, which lays
  // out node_modules accordingly.
  setWorkspaceBlock(join(PROJECT_DIR, "pnpm-workspace.yaml"), "publicHoistPattern", PNPM_PUBLIC_HOIST);
  // An older pnpm 10 reads it only in .npmrc (10.4.1 and 10.5.2, tried on 2026-10-06): pnpm itself
  // is asked, in the project, and the same patterns go to .npmrc where it does not read the block.
  const npmrcHoist = pnpmReadsHoist(PROJECT_DIR) !== true;
  if (npmrcHoist) addLines(join(PROJECT_DIR, ".npmrc"), NPMRC_PUBLIC_HOIST);
  const installLabel = PNPM_BUILD_FLAGS ? `with flags: ${PNPM_BUILD_FLAGS}` : "no extra flags (pnpm ≤10, onlyBuiltDependencies in package.json)";
  log(`Installing with pnpm (${installLabel})`);
  run(`pnpm install${PNPM_BUILD_FLAGS ? ` ${PNPM_BUILD_FLAGS}` : ""}`, PROJECT_DIR);

  // Write a project-local `.npmrc` so the USER's future `pnpm install` /
  // `pnpm add` commands (run without our CLI flags) don't fail. The
  // `strict-dep-builds=false` setting IS honored via .npmrc on pnpm 11 (it
  // downgrades ignored-builds from error to warning). `dangerously-allow-all-builds`
  // is NOT honored via .npmrc on pnpm 11 (empirically tested) but
  // `strict-dep-builds=false` alone is enough to prevent install failure.
  const npmrcPath = join(PROJECT_DIR, ".npmrc");
  writeFileSync(
    npmrcPath,
    "# pnpm 11 defaulted strictDepBuilds to true, which fails install when any\n" +
      "# postinstall script is unapproved. Setting this to false downgrades it to\n" +
      "# a warning so `pnpm add foo` won't break in the middle of development.\n" +
      "strict-dep-builds=false\n",
  );
  // The writer above replaces the file: the hoisting lines go back where they were needed.
  if (npmrcHoist) addLines(npmrcPath, NPMRC_PUBLIC_HOIST);

  // Normalize any pnpm-workspace.yaml that pnpm install may have generated
  // (replace placeholder `set this to true or false` with `true`).
  const wsPath = join(PROJECT_DIR, "pnpm-workspace.yaml");
  if (existsSync(wsPath)) {
    const ws = readFileSync(wsPath, "utf8");
    const fixed = ws.replace(/:\s*set this to true or false/g, ": true");
    if (fixed !== ws) {
      writeFileSync(wsPath, fixed);
      console.log("  → Normalized pnpm-workspace.yaml allowBuilds (placeholders → true)");
    }
  }

  ok(`T3 scaffold written to ${PROJECT_DIR} (pnpm-managed, native builds approved)`);
}

// ─── Step 2.5: init git with .gitattributes already in place ─────────
// Since scaffoldT3 uses --noGit, we control git init entirely. We write
// .gitattributes FIRST (so its rules apply to the very first `git add`),
// then init git, then stage everything. Zero reconciliation, zero friction.
function gitattributes() {
  log("Writing .gitattributes");
  const content = [
    "# Normalize line endings across OSes - force LF everywhere except Windows scripts.",
    "* text=auto eol=lf",
    "*.{cmd,bat,ps1} text eol=crlf",
    "",
  ].join("\n");
  writeFileSync(join(PROJECT_DIR, ".gitattributes"), content);

  log("git init + initial stage (attrs applied from the start)");
  run("git init -b main", PROJECT_DIR);
  run("git add -A", PROJECT_DIR);
  ok("Git repo initialized with .gitattributes in effect");
}

// ─── Step 3: bump drizzle ─────────────────────────────────────────────
function bumpDrizzle() {
  log("Bumping drizzle-orm + drizzle-kit (SQL injection patch)");
  run(`pnpm add drizzle-orm@latest ${PNPM_BUILD_FLAGS}`, PROJECT_DIR);
  run(`pnpm add -D drizzle-kit@latest ${PNPM_BUILD_FLAGS}`, PROJECT_DIR);
  ok("drizzle upgraded");
}

// ─── Step 4: cleanup demo ─────────────────────────────────────────────
function cleanupDemo() {
  log("Cleaning up T3 demo files");

  const postRouter = join(PROJECT_DIR, "src/server/api/routers/post.ts");
  if (existsSync(postRouter)) rmSync(postRouter);

  // T3 scaffolds a React component src/app/_components/post.tsx that imports
  // api.post - if left behind, `next build` fails type-check even though the
  // file isn't rendered (the _ prefix only blocks routing, not compilation).
  const postComponent = join(PROJECT_DIR, "src/app/_components/post.tsx");
  if (existsSync(postComponent)) rmSync(postComponent);
  const componentsDir = join(PROJECT_DIR, "src/app/_components");
  if (existsSync(componentsDir) && readdirSync(componentsDir).length === 0) {
    rmdirSync(componentsDir);
  }

  const rootPath = join(PROJECT_DIR, "src/server/api/root.ts");
  if (existsSync(rootPath)) {
    let root = readFileSync(rootPath, "utf8");
    root = root.replace(
      /import\s+\{\s*postRouter\s*\}\s+from\s+["']~\/server\/api\/routers\/post["'];?\s*\r?\n/g,
      "",
    );
    root = root.replace(/\s*post:\s*postRouter,?\s*\r?\n/g, "\n");
    writeFileSync(rootPath, root);
    // If T3 ever renames `postRouter` (e.g. to `demoRouter`), the regexes above
    // silently miss and root.ts keeps a broken import → build failure later.
    // Catch that drift here so the handoff banner flags it.
    expect(
      rootPath,
      (c) => !c.includes("postRouter"),
      "postRouter should be fully stripped from root.ts",
    );
  } else {
    warn(`${rootPath} not found - T3 may have moved the appRouter. Verify manually.`);
  }

  // Replace the T3 demo homepage with a minimal placeholder (template).
  const pagePath = join(PROJECT_DIR, "src/app/page.tsx");
  if (!existsSync(pagePath)) {
    warn(`${pagePath} not found - T3 may have moved the homepage. Skipping placeholder.`);
  } else {
    writeFileSync(pagePath, render("bootstrap/home-page.tsx", { PROJECT_NAME: name }));
  }

  // Remove .env.example. It duplicates what's in src/env.js (zod schema = source
  // of truth) and the CLAUDE.md "Variables d'env requises" section, and drifts
  // out of sync the moment addons add new vars. We don't maintain it - we delete it.
  const envExample = join(PROJECT_DIR, ".env.example");
  if (existsSync(envExample)) rmSync(envExample);

  // Reset src/server/db/schema.ts to a bare-bones helper-only file. T3 scaffolds
  // a demo `posts` table that setup-db.mjs would otherwise push to Neon. Later,
  // when Claude (or the user) replaces that table with the real app schema,
  // drizzle-kit detects "table dropped + table added" and triggers a TTY
  // interactive prompt ("is `contacts` a rename of `posts`?") - which crashes
  // in Claude Code's non-TTY environment. By clearing schema.ts here, the
  // initial setup-db push creates zero tables, and subsequent pushes only see
  // additions (no rename detection ever fires).
  const schemaPath = join(PROJECT_DIR, "src/server/db/schema.ts");
  if (existsSync(schemaPath)) {
    // String-concat to avoid escaping nested template literals: the script's
    // `name` is the project name (e.g. "crm-perso"), and the literal `${name}`
    // in the output is the runtime callback param (the table name).
    const schemaSrc =
      'import { pgTableCreator } from "drizzle-orm/pg-core";\n\n' +
      "/**\n" +
      " * Multi-project schema prefix - every table name is automatically prefixed\n" +
      " * with the project name to allow sharing a Neon DB across projects.\n" +
      " * @see https://orm.drizzle.team/docs/goodies#multi-project-schema\n" +
      " */\n" +
      "export const createTable = pgTableCreator((name) => `" + name + "_${name}`);\n";
    writeFileSync(schemaPath, schemaSrc);
  } else {
    warn(`${schemaPath} not found - T3 may have moved the schema file. Skipping reset.`);
  }

  ok("Demo router + component + homepage + .env.example removed, schema.ts reset to empty");
}

// ─── Step 4b: lint scripts → ESLint CLI ───────────────────────────────
// `next lint` is deprecated since Next 15.5 and removed in Next 16, and in
// Next 16 `next build` no longer runs ESLint either - the standalone lint
// script becomes the only lint gate, so it must work. create-next-app ≥15.5
// already emits `eslint`, but create-t3-app may still emit `next lint`.
function eslintCli() {
  log("Normalizing lint scripts to the ESLint CLI (next lint is deprecated)");

  const pkgPath = join(PROJECT_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  let migrated = 0;
  for (const [key, val] of Object.entries(pkg.scripts ?? {})) {
    if (typeof val === "string" && val.includes("next lint")) {
      pkg.scripts[key] = val
        .replace(/next lint --fix/g, "eslint . --fix")
        .replace(/next lint/g, "eslint .");
      migrated++;
    }
  }
  if (migrated > 0) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // The ESLint CLI needs an explicit flat config - unlike `next lint`, it has
  // no implicit Next.js default. Scaffolders normally generate one; this only
  // fires if a future scaffolder version stops doing so.
  const hasFlatConfig = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"]
    .some((f) => existsSync(join(PROJECT_DIR, f)));
  if (!hasFlatConfig) {
    writeFileSync(
      join(PROJECT_DIR, "eslint.config.mjs"),
      [
        'import { dirname } from "path";',
        'import { fileURLToPath } from "url";',
        'import { FlatCompat } from "@eslint/eslintrc";',
        "",
        "const __filename = fileURLToPath(import.meta.url);",
        "const __dirname = dirname(__filename);",
        "",
        "const compat = new FlatCompat({",
        "  baseDirectory: __dirname,",
        "});",
        "",
        "const eslintConfig = [",
        '  ...compat.extends("next/core-web-vitals"),',
        "  {",
        "    ignores: [",
        '      "node_modules/**",',
        '      ".next/**",',
        '      "out/**",',
        '      "build/**",',
        '      "next-env.d.ts",',
        "    ],",
        "  },",
        "];",
        "",
        "export default eslintConfig;",
        "",
      ].join("\n"),
    );
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const missing = ["eslint", "eslint-config-next", "@eslint/eslintrc"].filter((d) => !allDeps[d]);
    if (missing.length > 0) {
      run(`pnpm add -D ${missing.join(" ")} ${PNPM_BUILD_FLAGS}`, PROJECT_DIR);
    }
    warn("No flat ESLint config found - wrote eslint.config.mjs (next/core-web-vitals). Verify the scaffolder output.");
  } else {
    // The scaffolder shipped a flat config (T3 ships eslint.config.js with
    // `ignores: ['.next']`). Ensure `next-env.d.ts` is also ignored: Next
    // regenerates that file with a `/// <reference ... />` line that the
    // @typescript-eslint/triple-slash-reference rule flags as an ERROR, so
    // `eslint .` (and our `pnpm lint` convention) fails on a file nobody edits.
    const cfgFile = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"]
      .map((f) => join(PROJECT_DIR, f))
      .find((p) => existsSync(p));
    if (cfgFile) {
      const cfg = readFileSync(cfgFile, "utf8");
      if (!cfg.includes("next-env.d.ts")) {
        // Inject into the first `ignores: [ ... ]` array (the global ignores).
        const patched = cfg.replace(/ignores:\s*\[([^\]]*)\]/, (_m, inner) => {
          const trimmed = inner.trim().replace(/,\s*$/, "");
          return `ignores: [${trimmed ? trimmed + ", " : ""}'next-env.d.ts']`;
        });
        if (patched !== cfg) {
          writeFileSync(cfgFile, patched);
          ok("Added 'next-env.d.ts' to the ESLint ignores (auto-generated file)");
        } else {
          warn(
            "Could not auto-add 'next-env.d.ts' to the ESLint ignores array - " +
              "no `ignores: [...]` found to patch. Add it manually so `pnpm lint` " +
              "doesn't error on the generated file.",
          );
        }
      }
    }
  }

  ok(
    migrated > 0
      ? `${migrated} script(s) migrated from next lint to the ESLint CLI`
      : "lint scripts already on the ESLint CLI - nothing to do",
  );
}

// ─── Step 5: healthcheck router ───────────────────────────────────────
function healthcheck() {
  log("Injecting healthcheck router");

  const routerDir = join(PROJECT_DIR, "src/server/api/routers");
  mkdirSync(routerDir, { recursive: true });

  writeFileSync(
    join(routerDir, "healthcheck.ts"),
    `import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

export const healthcheckRouter = createTRPCRouter({
  ping: publicProcedure.query(() => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  })),
});
`,
  );

  const rootPath = join(PROJECT_DIR, "src/server/api/root.ts");
  let root = readFileSync(rootPath, "utf8");

  if (!root.includes("healthcheckRouter")) {
    const importLine = `import { healthcheckRouter } from "~/server/api/routers/healthcheck";\n`;
    const lastImport = root.match(/^((?:import[^;]+;[\r\n]+)+)/);
    if (lastImport) {
      root = root.replace(lastImport[0], lastImport[0] + importLine);
    } else {
      root = importLine + root;
    }
    root = root.replace(
      /createTRPCRouter\(\s*\{/,
      `createTRPCRouter({\n  healthcheck: healthcheckRouter,`,
    );
    writeFileSync(rootPath, root);
  }

  // T3 ships a JSDoc block at the bottom of root.ts that references
  // `trpc.post.all()` - a method we just removed along with the demo router.
  // Strip the misleading example so new Claude sessions don't start from broken docs.
  {
    let updated = readFileSync(rootPath, "utf8");
    updated = updated.replace(
      /\/\*\*\n(?:\s*\*.*\n)*?\s*\*\s*const res = await trpc\.post\.all\(\);[\s\S]*?\*\/\n/,
      "/**\n * Create a server-side caller for the tRPC API.\n */\n",
    );
    writeFileSync(rootPath, updated);
  }

  ok("Healthcheck wired into appRouter + stale JSDoc stripped");
}

// ─── Step 6: shadcn + LinkButton ──────────────────────────────────────
// Run an `npx shadcn` command. shadcn invokes `pnpm add` internally to install
// the packages it needs; on pnpm 11 this can hit ERR_PNPM_IGNORED_BUILDS if a
// new transitive dep brings a postinstall script (e.g. msw via @base-ui/react).
// The error creates a `pnpm-workspace.yaml` with placeholder values. We
// normalize the file (placeholders → true) and retry once. The retry succeeds
// because pnpm 11 reads the explicit `allowBuilds:` entries.
function runShadcn(cmd) {
  const result = capture(cmd, PROJECT_DIR);
  // Surface output regardless of exit (matches `inherit` stdio semantics).
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) return;

  const wsPath = join(PROJECT_DIR, "pnpm-workspace.yaml");
  if (!existsSync(wsPath)) fail(`Command failed (exit ${result.status}): ${cmd}`);
  const ws = readFileSync(wsPath, "utf8");
  const fixed = ws.replace(/:\s*set this to true or false/g, ": true");
  if (fixed === ws) fail(`Command failed (exit ${result.status}): ${cmd}`);
  writeFileSync(wsPath, fixed);
  console.log("  → Normalized pnpm-workspace.yaml (placeholders → true), retrying shadcn");
  run(cmd, PROJECT_DIR);
}

function shadcn() {
  log("Installing shadcn/ui");

  // Pre-create pnpm-workspace.yaml with known build-script-using packages
  // approved. This prevents shadcn's internal `pnpm add` (which pulls in msw via
  // @base-ui/react transitive deps) from creating a placeholder yaml + exiting
  // 1 on its FIRST run. If we let that happen, the retry can write the
  // components but skips `src/lib/utils.ts` (because shadcn init treats
  // components.json already existing as a "do you want to overwrite?" prompt
  // that --yes does not auto-accept).
  const wsPath = join(PROJECT_DIR, "pnpm-workspace.yaml");
  // unrs-resolver is a transitive native dep of eslint-config-next (via
  // eslint-plugin-import-x → @rspack/binding-resolver). It MUST be approved or
  // any future `pnpm install` (e.g. when the user adds a package) exits with
  // ERR_PNPM_IGNORED_BUILDS even when `strict-dep-builds=false` is in .npmrc.
  const knownBuildPkgs = ["msw", "sharp", "esbuild", "@tailwindcss/oxide", "@swc/core", "@parcel/watcher", "unrs-resolver"];
  // Only the allowBuilds block is rewritten. The overrides block written
  // before the first install must survive: dropping it here would make the
  // next `pnpm add` quietly write a lockfile without the security floors.
  if (setWorkspaceBlock(wsPath, "allowBuilds", Object.fromEntries(knownBuildPkgs.map((p) => [p, true])))) {
    console.log("  → Pre-wrote pnpm-workspace.yaml with known build-script packages approved");
  }

  // npx is required - pnpm dlx fails with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND
  // because shadcn's CLI probes its cwd via the package-manager context and
  // pnpm's dlx sandbox confuses that detection.
  runShadcn("npx shadcn@latest init --defaults --yes");

  // Belt-and-suspenders: write src/lib/utils.ts if shadcn didn't (can happen if
  // init was retried after components.json existed and the overwrite prompt
  // blocked even with --yes). The standard shadcn utils.ts is stable.
  const utilsPath = join(PROJECT_DIR, "src/lib/utils.ts");
  if (!existsSync(utilsPath)) {
    writeFileSync(
      utilsPath,
      `import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs));\n}\n`,
    );
    console.log("  → Wrote missing src/lib/utils.ts fallback");
  }

  log("Adding base components");
  runShadcn(
    "npx shadcn@latest add button card input label dialog sheet dropdown-menu select separator badge sonner --yes",
  );

  log("Writing LinkButton (shadcn v4 has no asChild)");
  writeFileSync(
    join(PROJECT_DIR, "src/components/ui/link-button.tsx"),
    `import Link, { type LinkProps } from "next/link";
import { type VariantProps } from "class-variance-authority";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type LinkButtonProps = LinkProps &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    children: React.ReactNode;
  };

export function LinkButton({ className, variant, size, ...props }: LinkButtonProps) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
`,
  );

  // shadcn v4 init injects a `@theme inline { --font-sans: var(--font-sans); }`
  // block into globals.css that clobbers T3's Geist wiring (`@theme { --font-sans:
  // var(--font-geist-sans), ... }`). The self-referential declaration makes
  // `var(--font-sans)` resolve to itself → browser falls back to Times New Roman.
  // Fix: drop that one line. The outer @theme block then becomes the source of
  // truth for --font-sans.
  log("Patching globals.css (Geist clobber fix)");
  const globalsPath = join(PROJECT_DIR, "src/styles/globals.css");
  if (existsSync(globalsPath)) {
    const before = readFileSync(globalsPath, "utf8");
    const after = before.replace(/^\s*--font-sans:\s*var\(--font-sans\)\s*;\s*\r?\n/m, "");
    if (before !== after) {
      writeFileSync(globalsPath, after);
      ok("Stripped self-referential --font-sans from globals.css");
    } else {
      warn(
        "globals.css did not contain the expected `--font-sans: var(--font-sans);` line - " +
          "shadcn may have changed its output. If fonts render as Times New Roman, inspect " +
          "globals.css manually and ensure --font-sans resolves to var(--font-geist-sans).",
      );
    }
  } else {
    warn(`${globalsPath} not found - cannot patch Geist wiring.`);
  }

  ok("shadcn + LinkButton + Geist fix ready");
}

// ─── Step 7 + 8: sibling scripts ──────────────────────────────────────
function runSibling(script, extraArgs = []) {
  const p = join(__dirname, script);
  if (!existsSync(p)) fail(`Sibling script missing: ${p}`);
  run(["node", `"${p}"`, ...extraArgs].join(" "), PROJECT_DIR);
}

function security() {
  log("Applying security hardening");
  runSibling("setup-security.mjs");
  ok("Security done");
}

function seo() {
  log("Applying base SEO");
  // Quote args that may contain spaces / special chars. Node's cmdline parsing
  // on Windows keeps these as single argv entries when wrapped in double quotes.
  runSibling("setup-seo.mjs", [
    "--name",
    `"${name.replace(/"/g, '\\"')}"`,
    "--description",
    `"${description.replace(/"/g, '\\"')}"`,
    "--locale",
    locale,
  ]);
  ok("SEO done");
}

// ─── Step 9: 404 page ─────────────────────────────────────────────────
// Polished server-component 404 with the shadcn Button. Generated as part of
// the initial scaffold so every project ships with one out of the box. If
// /add-i18n is invoked later, that addon moves this file under [locale]/ and
// rewires it to use translations.
function notFoundPage() {
  log("Writing src/app/not-found.tsx");
  // Template: templates/not-found/plain.tsx (no vars to substitute - purely static).
  // Uses LinkButton (created in shadcn()) because shadcn v4 has no asChild on Button.
  // The i18n variant lives at templates/not-found/i18n.tsx and is swapped in by
  // /add-i18n via _i18n-upgrade.mjs when the feature manifest is detected.
  writeFileSync(join(PROJECT_DIR, "src/app/not-found.tsx"), render("not-found/plain.tsx", {}));
  ok("404 page written");
}

// ─── Step 10: CLAUDE.md core ──────────────────────────────────────────
// Writes the project's initial CLAUDE.md: the unconditional T3 conventions from
// the template, then the managed block of Hypervibe project rules (TypeScript,
// JSX, responsive, slugs, database reads, pre-production audit).
//
// Those rules used to sit in the user's global ~/.claude/CLAUDE.md, which is
// read at the start of EVERY session in EVERY folder: a rule about Neon egress
// was being loaded to write a slide deck. They belong here, next to the code
// they govern, and they travel with the repository to whoever clones it. The
// global block now holds only what is true everywhere.
//
// Addons (add-db, add-email, ...) keep extending this file through
// _update-claude-md; their free-form lines live outside the managed block and
// are never touched by it.
function claudeMdCore() {
  log("Writing CLAUDE.md (project-level core)");
  // Template: templates/bootstrap/claude-md-core.md
  // Substitutes PROJECT_NAME and DESCRIPTION. Conventions are static.
  writeFileSync(
    join(PROJECT_DIR, "CLAUDE.md"),
    render("bootstrap/claude-md-core.md", {
      PROJECT_NAME: name,
      DESCRIPTION: description,
    }),
  );
  // A T3 scaffold always ships Drizzle and is wired to Neon by /add-db, so the
  // database rule applies from the start.
  const rapport = syncManagedBlock({
    file: join(PROJECT_DIR, "CLAUDE.md"),
    ...PROJECT_BLOCK,
    ...buildRuleSets("project", new Set(["--with-neon"])),
  });
  ok(`CLAUDE.md core written (+ ${rapport.added.length} project rules)`);
}

// ─── Step 10b: vercel.json (region pinning) ───────────────────────────
// Pin serverless function execution to Frankfurt (fra1). Default Vercel region
// is iad1 (US East Virginia), which adds ~80ms latency for EU visitors and
// keeps data processing in the US. fra1 is the only Vercel region in the EU
// proper (cdg1 doesn't exist on Vercel - it's a Cloudflare/CloudFront PoP).
// Edge Functions, middleware and the static CDN are unaffected by this - they
// still run on the global edge network closest to the visitor.
function vercelConfig() {
  log("Writing vercel.json (regions: fra1)");
  writeFileSync(
    join(PROJECT_DIR, "vercel.json"),
    JSON.stringify({ regions: ["fra1"] }, null, 2) + "\n",
  );
  ok("vercel.json written");
}

// ─── workspace-root/.claude/launch.json (Claude Preview MCP) ─────────
// Pre-registers this project in the Claude Preview MCP launch config so
// the "Tu veux que je lance l'aperçu ?" prompt at the end of bootstrap
// works immediately, without the MCP probing for ~30s.
//
// ⚠️ CRITICAL: the MCP reads launch.json from the WORKSPACE ROOT (where
// Claude Code was launched), NOT from the individual project subfolder.
// On the user's machine, projects live in C:\DEV\<name>\ and Claude Code
// is launched from C:\DEV\ → the canonical launch.json is at
// C:\DEV\.claude\launch.json (not C:\DEV\<name>\.claude\launch.json,
// which would be invisible to the MCP).
//
// This function:
//   1. Resolves the workspace root by walking UP from PROJECT_DIR looking
//      for an existing .claude/launch.json. If found, that's the workspace.
//      If not, fall back to dirname(PROJECT_DIR) and create one there.
//   2. Reads the existing config (or initializes a new one).
//   3. Adds/updates an entry for this project, using:
//        - cwd: relative path from workspace root (required by recent MCP)
//        - runtimeExecutable: "cmd" on Windows (+ /c pnpm dev), "pnpm" elsewhere
//        - autoPort: true (graceful fallback if 3000 is busy)
//   4. Preserves all other projects' entries (append-only behavior).
function launchJsonConfig() {
  // Walk up from PROJECT_DIR looking for an existing workspace launch.json
  let workspaceRoot = dirname(PROJECT_DIR);
  let probe = workspaceRoot;
  const home = homedir();
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(probe, ".claude", "launch.json");
    if (existsSync(candidate)) {
      workspaceRoot = probe;
      break;
    }
    if (probe === home || dirname(probe) === probe) break; // hit home or fs root
    probe = dirname(probe);
  }

  const launchPath = join(workspaceRoot, ".claude", "launch.json");
  const projectName = basename(PROJECT_DIR);
  const cwdRelative = relative(workspaceRoot, PROJECT_DIR).split("\\").join("/");

  log(`Registering project in ${launchPath} (cwd: ${cwdRelative})`);

  // Read existing or initialize
  let config = { version: "0.0.1", configurations: [] };
  if (existsSync(launchPath)) {
    try {
      const parsed = JSON.parse(readFileSync(launchPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        config = {
          version: parsed.version || "0.0.1",
          configurations: Array.isArray(parsed.configurations) ? parsed.configurations : [],
        };
      }
    } catch (e) {
      warn(`Existing launch.json is corrupted (${e.message}). Backing up to launch.json.bak and starting fresh.`);
      writeFileSync(launchPath + ".bak", readFileSync(launchPath, "utf8"));
    }
  } else {
    mkdirSync(dirname(launchPath), { recursive: true });
  }

  // Build the entry for this project (platform-aware runtime)
  const isWindows = platform() === "win32";
  const entry = {
    name: projectName,
    runtimeExecutable: isWindows ? "cmd" : "pnpm",
    runtimeArgs: isWindows ? ["/c", "pnpm dev"] : ["dev"],
    cwd: cwdRelative,
    port: 3000,
    autoPort: true,
  };

  // Replace existing entry with the same name, OR append
  const idx = config.configurations.findIndex((c) => c.name === projectName);
  if (idx >= 0) {
    config.configurations[idx] = entry;
  } else {
    config.configurations.push(entry);
  }

  writeFileSync(launchPath, JSON.stringify(config, null, 2) + "\n");
  ok(`Project '${projectName}' registered in workspace launch.json`);

  // Also write a project-local launch.json so the preview works when the
  // user launches Claude Code directly from the project dir (instead of
  // from the workspace root). The two files never conflict - the MCP only
  // reads one based on where Claude Code was started.
  //
  // Project-local entry uses cwd: "." since the workspace root IS the
  // project itself in that case.
  const projectLocalPath = join(PROJECT_DIR, ".claude", "launch.json");
  mkdirSync(dirname(projectLocalPath), { recursive: true });
  const projectLocalConfig = {
    version: "0.0.1",
    configurations: [
      {
        name: projectName,
        runtimeExecutable: isWindows ? "cmd" : "pnpm",
        runtimeArgs: isWindows ? ["/c", "pnpm dev"] : ["dev"],
        cwd: ".",
        port: 3000,
        autoPort: true,
      },
    ],
  };
  writeFileSync(projectLocalPath, JSON.stringify(projectLocalConfig, null, 2) + "\n");
  ok(`Project-local launch.json also written (for direct project launches)`);
}

// ─── Step 10c: privacy policy page + seed subprocessors registry ──────
// Writes a data-driven privacy policy page that renders from
// src/lib/subprocessors.ts. Then seeds that registry with Vercel - the
// hosting provider, always present. As /add-* skills introduce new
// third-party data processors, each one calls _update-privacy-policy to
// add itself to the registry. The page picks up changes automatically,
// no template re-rendering needed.
//
// If /add-i18n is invoked later, the page must be moved under [locale]/
// alongside page/layout/not-found (add-i18n's SKILL.md handles this).
function privacyPolicy() {
  log("Writing privacy policy page + seeding subprocessors registry");

  const pageDir = join(PROJECT_DIR, "src/app/politique-de-confidentialite");
  mkdirSync(pageDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(pageDir, "page.tsx"),
    render("privacy-policy/plain.tsx", {
      PROJECT_NAME: name,
      LAST_UPDATED: today,
    }),
  );

  // Seed the registry with Vercel. This sibling call also creates
  // src/lib/subprocessors.json and the typed TS wrapper.
  runSibling("update-privacy-policy.mjs", ["--add", "vercel"]);

  ok("Privacy policy page + Vercel subprocessor written");
}

// ─── Step 11: initial commit ──────────────────────────────────────────
function commit() {
  log("Creating initial commit");
  run("git add -A", PROJECT_DIR);
  // If there's nothing to commit (T3's initial commit already captured everything,
  // unlikely given we changed a lot), git commit exits 1. Allow that.
  const res = capture("git diff --cached --quiet", PROJECT_DIR);
  if (res.status === 0) {
    ok("Nothing to commit (already clean)");
    return;
  }
  run(
    ["git", "commit", "-m", '"chore: initial scaffold + security + SEO"'].join(" "),
    PROJECT_DIR,
  );
  ok("Commit done");
}

// ─── Step 10: gh repo create + push ───────────────────────────────────
function ghRepo() {
  log(`Creating GitHub repo (${visibility})`);
  run(
    `gh repo create ${name} --${visibility} --source=. --remote=origin --push`,
    PROJECT_DIR,
  );
  ok("GitHub repo created + initial push");
}

// ─── Step 11: vercel link ─────────────────────────────────────────────
// This is the ONLY scope-sensitive Vercel call in the script: every later one
// (push-env-vars, check-deploy, pull-env-vars) reads the .vercel/project.json
// written here, so they inherit the resolved scope for free.
//
// On a single-scope account the bare call works and none of the recovery below
// runs. On a multi-scope account (personal + one or more Vercel teams) the CLI refuses
// to pick one in non-interactive mode - a deliberate safety, not a bug - and
// since v59 it then dies on a libuv assertion (exit 3221226505 on Windows)
// right after printing a machine-readable diagnostic:
//   { "status": "action_required", "reason": "missing_scope", "choices": [...] }
// We parse that diagnostic and retry with an explicit --scope.
//
// The asymmetry that makes this solvable without asking: `vercel projects ls`
// DOES resolve a scope on its own (the CLI's stored currentTeam); only the
// write refuses to assume it. The answer is already on disk.
//
// Resolution order, most explicit first:
//   1. --scope passed by the caller (the SKILL, after asking the user)
//   2. the CLI's own currentTeam - what a read command would have used
//   3. the orgId shared by the sibling projects sitting next to this one
// If none of those matches a choice we do NOT guess: picking between a personal
// account and a company Vercel team is the user's call, so we exit with a structured
// VERCEL_SCOPE_AMBIGUOUS message the SKILL turns into a plain question.

// The CLI's current Vercel team comes from readCliCurrentTeam (_vercel-auth.mjs),
// which also knows the xdg.data folder of CLI v59 and keeps the freshest
// config file: reading the pre-v59 file first returned a Vercel team the CLI had
// since left (seen on 2026-09-17, a file untouched for a month).

/** orgId shared by the already-linked projects sitting next to this one, if unanimous. */
function siblingOrgId() {
  let entries;
  try {
    entries = readdirSync(CWD, { withFileTypes: true });
  } catch {
    return null;
  }
  const counts = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === name) continue;
    const linkFile = join(CWD, entry.name, ".vercel", "project.json");
    if (!existsSync(linkFile)) continue;
    try {
      const orgId = JSON.parse(readFileSync(linkFile, "utf8")).orgId;
      if (orgId) counts.set(orgId, (counts.get(orgId) ?? 0) + 1);
    } catch {/* an unreadable sibling proves nothing */}
  }
  // A dominant majority is a real signal (a user who keeps one project in a
  // side scope has not changed where the rest of their work lives), but a split
  // neighbourhood is exactly the ambiguity to hand back rather than settle here.
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total < 3) return counts.size === 1 ? [...counts.keys()][0] : null;
  const [topId, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return topCount / total >= 0.8 ? topId : null;
}

/** Pull the first balanced JSON object out of mixed CLI output. */
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function vercelLink() {
  log("Linking Vercel project");
  // --yes accepts the "link or create" prompt; --project pins the name.
  const base = "vercel link --yes --project " + name;

  // A caller-supplied scope is a decision already made: use it, no probing.
  if (scopeArg) {
    log("  using the scope passed by the caller: " + scopeArg);
    run(base + " --scope " + scopeArg, PROJECT_DIR);
    ok("Vercel linked (scope " + scopeArg + ")");
    return;
  }

  const first = capture(base, PROJECT_DIR);
  if (first.status === 0) {
    ok("Vercel linked");
    return;
  }

  const output = (first.stdout || "") + "\n" + (first.stderr || "");
  const diagnostic = extractJsonObject(output);
  const choices = Array.isArray(diagnostic?.choices) ? diagnostic.choices : [];

  if (diagnostic?.reason !== "missing_scope" || choices.length === 0) {
    // Not the ambiguity we know how to repair: surface the real error as before.
    process.stderr.write(output);
    fail("Command failed (exit " + first.status + "): " + base);
  }

  const labels = choices.map((c) => c.name).join(", ");
  log("  several Vercel scopes available (" + labels + "), resolving");

  const currentTeam = readCliCurrentTeam();
  const wanted = currentTeam ?? siblingOrgId();
  const picked = wanted ? choices.find((c) => c.id === wanted) : null;

  if (!picked) {
    fail(
      "VERCEL_SCOPE_AMBIGUOUS: this Vercel account has several scopes (" +
        labels +
        ") and none of them could be resolved automatically. Re-run this script " +
        "with --scope <name> once the user has picked one. Available: " +
        choices.map((c) => c.name + " (" + c.id + ")").join(", "),
    );
  }

  const source = currentTeam === picked.id ? "the Vercel CLI default" : "the neighbouring projects";
  log("  scope resolved from " + source + ": " + picked.name);
  run(base + " --scope " + picked.name, PROJECT_DIR);
  ok("Vercel linked (scope " + picked.name + ")");
}


// ─── Step 11b: vercel git connect (auto-deploy wiring) ────────────────
// `vercel link` only binds the LOCAL FOLDER to the Vercel project - it does NOT
// connect the GitHub repository. Without an explicit connection, auto-deploy
// relies on Vercel's implicit auto-link at deploy time, which only works when
// the user's Vercel GitHub App is installed AND covers this brand-new repo.
// Most first-time users either have no app at all (email signup, or "logged in
// with GitHub" which is OAuth, not the integration app) or installed it with
// "Only select repositories" - both break the implicit link. Connecting
// explicitly here surfaces the problem in seconds instead of after a 90s poll
// at the very end, and verifyAutoDeploy() then merely confirms the webhook.
let gitConnectOk = false;

function gitConnect() {
  log("Connecting GitHub repo to Vercel project (auto-deploy)");
  const res = capture("vercel git connect --yes", PROJECT_DIR);
  const out = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  if (out) console.log(out.split("\n").map((l) => `  ${l}`).join("\n"));
  if (res.status === 0) {
    gitConnectOk = true;
    ok("Git repository connected - pushes will auto-deploy");
    return;
  }
  // Non-fatal: the first deploy goes through `vercel --prod` anyway. Claude
  // handles the GitHub-App installation with the user at SKILL Étape 3, then
  // re-runs `vercel git connect --yes`.
  warn(
    "GH_VERCEL_CONNECT_FAILED: `vercel git connect` could not attach the GitHub repo " +
      "to the Vercel project. Typical causes: Vercel's GitHub App is not installed on the " +
      "user's GitHub account, or it is restricted to selected repositories that do not " +
      "include this brand-new repo. The bootstrap continues (first deploy is CLI-direct), " +
      "but future `git push` will NOT auto-deploy until this is fixed. Claude: follow the " +
      "GH_VERCEL_INTEGRATION_MISSING procedure in the bootstrap SKILL (Étape 3), then " +
      "re-run `vercel git connect --yes` in the project directory.",
  );
}

// ─── Step 14: push placeholder env vars ───────────────────────────────
function pushEnvVars() {
  log("Generating env vars + pushing to .env and Vercel");
  // T3 with `--trpc --drizzle --appRouter --dbProvider postgres` (no --nextAuth)
  // only requires DATABASE_URL in src/env.js. NextAuth-related vars (AUTH_SECRET,
  // AUTH_DISCORD_*) are not scaffolded - /add-auth pushes real ones later when the
  // user opts into auth. Keeping the placeholder set minimal:
  //   - DATABASE_URL: syntactically-valid postgres URL so Drizzle's z.string().url()
  //     validation passes at build time without ever opening a connection.
  //   - NEXT_PUBLIC_APP_URL: the real Vercel URL for prod+preview (so SEO metadata,
  //     sitemap, JSON-LD all resolve to the live domain on first deploy), and
  //     localhost:3000 for dev. The default Vercel project URL is deterministic
  //     (https://<name>.vercel.app) right after `vercel link`, so we can push it
  //     here BEFORE the first deploy.
  const dbPlaceholder = "postgresql://placeholder:placeholder@localhost:5432/placeholder";
  const vercelUrl = `https://${name}.vercel.app`;
  const localUrl = "http://localhost:3000";

  // DATABASE_URL: no NEXT_PUBLIC_ prefix → push-env-vars defaults to production+preview
  // (dev untouched, replaced later by /add-db with the real Neon connection).
  runSibling("push-env-vars.mjs", [`"DATABASE_URL=${dbPlaceholder}"`]);

  // NEXT_PUBLIC_APP_URL: different value per environment. Two calls - one for
  // production+preview (real Vercel URL), one for development (localhost).
  // push-env-vars uses --target=<env>[,<env>...] for explicit targeting, and is
  // idempotent across re-runs.
  runSibling("push-env-vars.mjs", [
    "--target=production,preview",
    `"NEXT_PUBLIC_APP_URL=${vercelUrl}"`,
  ]);
  runSibling("push-env-vars.mjs", [
    "--target=development",
    `"NEXT_PUBLIC_APP_URL=${localUrl}"`,
  ]);

  ok("Env vars written locally + pushed to Vercel (DATABASE_URL + NEXT_PUBLIC_APP_URL)");
}

// ─── Step 13: local build (gate) ──────────────────────────────────────
function localBuild() {
  if (skipLocalBuild) {
    log("Local build skipped (--skip-local-build): Vercel builds the first deploy remotely");
    return;
  }
  log("Local build (pnpm build) - gate before deploy");
  const res = run("pnpm build", PROJECT_DIR, { allowFail: true });
  if (res.status !== 0) {
    console.error(
      "\n❌ Local build failed. Read the error above.\n" +
        "   The partial state is on disk at:\n" +
        `     ${PROJECT_DIR}\n` +
        "   Vercel deploy NOT attempted. Fix the issue, then either re-run this script\n" +
        "   in a fresh directory, or let Claude take over from here manually.\n",
    );
    process.exit(1);
  }
  ok("Local build passed");
}

// ─── Step 16: vercel --prod ───────────────────────────────────────────
// Capture stdout so we can extract the actual alias URL - Vercel often
// suffixes the alias (crm-perso-henna.vercel.app, crm-perso-nine.vercel.app)
// when the bare ${name}.vercel.app subdomain is already taken by another user.
// Constructing `https://${name}.vercel.app` would hit someone else's project.
let deployedUrl = null;

function deploy() {
  if (skipDeploy) {
    log("--skip-deploy was passed; stopping before vercel --prod.");
    return;
  }
  log("Deploying to Vercel production");
  const res = capture("vercel --prod --yes", PROJECT_DIR);
  // Tee output to our log for debugging (we lose live streaming during the
  // deploy itself - ~45-90s - but the Monitor doesn't watch Vercel CLI lines
  // anyway, only our own ▸ step markers).
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    fail(`vercel --prod failed (exit ${res.status})`);
  }

  // Alias first: it is the stable production URL, while the unique deployment
  // URL may sit behind Vercel's deployment protection. CLI 59 prints both
  // without a colon and after ANSI codes; parseDeployOutput reads every form.
  const { aliasUrl, productionUrl } = parseDeployOutput((res.stdout || "") + (res.stderr || ""));
  deployedUrl = aliasUrl ?? productionUrl ?? null;

  if (deployedUrl) {
    ok(`Deployed to production: ${deployedUrl}`);
  } else {
    warn(
      `Could not parse deploy URL from vercel output. Smoke test will fall back to https://${name}.vercel.app (likely wrong).`,
    );
    ok("Deployed to production");
  }
}

// ─── Step 17: smoke test the live deployment ──────────────────────────
// Curl the deployed URL with retry (Vercel can take 30-90s to serve the first
// deploy from a fresh project), check HTTP 200 and that the project name
// appears in the rendered HTML - proves the page rendered our code, not a
// Vercel default landing.
async function smokeTest() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping smoke test too.");
    return;
  }
  const url = deployedUrl ?? `https://${name}.vercel.app`;
  log(`Smoke-testing ${url}`);

  const MAX_ATTEMPTS = 8;
  const DELAY_MS = 8000;
  let lastStatus = null;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      lastStatus = res.status;
      if (res.status === 200) {
        lastBody = await res.text();
        if (lastBody.includes(name)) {
          ok(`HTTP 200 + project name "${name}" present in HTML (attempt ${attempt}/${MAX_ATTEMPTS})`);
          return;
        }
        lastStatus = `200 but body missing "${name}" (likely Vercel propagation page)`;
      }
    } catch (e) {
      lastStatus = `network error: ${e.message}`;
    }

    if (attempt < MAX_ATTEMPTS) {
      log(`  attempt ${attempt}/${MAX_ATTEMPTS}: ${lastStatus} - waiting ${DELAY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  // Never converged - non-blocking warn, the deploy itself succeeded.
  warn(
    `Smoke test inconclusive after ${MAX_ATTEMPTS} attempts: last status was ${lastStatus}. ` +
      `The deploy command succeeded but ${url} isn't serving the expected content. ` +
      "Claude should investigate (DNS propagation, build error post-deploy, wrong project URL).",
  );
}

// ─── Step 18: fix NEXT_PUBLIC_APP_URL if Vercel suffixed the alias ────
// pushEnvVars (step 12) pushed `https://${name}.vercel.app` as best-guess,
// but Vercel often suffixes when the bare subdomain is taken (henna, nine, …).
// If so, re-push the corrected URL - verifyAutoDeploy's empty commit + push
// will then trigger a 2nd auto-deploy that bakes the right value into the
// client bundle (NEXT_PUBLIC_* is bundled at build time, so the 1st deploy
// has the wrong value briefly, but the 2nd build picks up the correction).
function fixAppUrl() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping NEXT_PUBLIC_APP_URL fixup.");
    return;
  }
  const bestGuess = `https://${name}.vercel.app`;
  if (!deployedUrl || deployedUrl === bestGuess) {
    log(`NEXT_PUBLIC_APP_URL already matches deployed URL (${bestGuess}) - no fix needed`);
    return;
  }
  log(`Correcting NEXT_PUBLIC_APP_URL: ${bestGuess} → ${deployedUrl}`);
  runSibling("push-env-vars.mjs", [
    "--target=production,preview",
    `"NEXT_PUBLIC_APP_URL=${deployedUrl}"`,
  ]);
  ok(`NEXT_PUBLIC_APP_URL corrected to ${deployedUrl} (will be baked into next build)`);
}

// ─── Step 19: verify GitHub↔Vercel auto-deploy integration ────────────
// Push an empty commit and check whether vercel[bot] picks it up via the
// GitHub deployments API. If not, the GitHub↔Vercel integration is missing
// and the user will need to authorize it in their Vercel account. Non-blocking
// - adds a structured warning to the handoff banner so Claude can guide the
// user through the manual fix.
async function verifyAutoDeploy() {
  if (skipDeploy) {
    log("--skip-deploy was passed; skipping auto-deploy verification.");
    return;
  }
  log("Verifying GitHub↔Vercel auto-deploy integration");

  // Empty commit + push to trigger the integration (if connected).
  run(
    ["git", "commit", "--allow-empty", "-m", '"chore: verify auto-deploy"'].join(" "),
    PROJECT_DIR,
  );
  run("git push", PROJECT_DIR);

  // Resolve owner/repo from origin URL.
  const remote = capture("git remote get-url origin", PROJECT_DIR).stdout?.trim() || "";
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) {
    warn(
      "Could not parse GitHub owner/repo from origin remote. Skipping vercel[bot] check; " +
        "Claude should verify auto-deploy is wired in the final summary.",
    );
    return;
  }
  const [, owner, repo] = m;

  // Vercel's webhook → GitHub deployment registration can take 30-120s on the FIRST
  // push to a freshly-linked project (cold start, GitHub App propagation, Vercel
  // build queue under load). Earlier versions waited only 12s, then 30/90s, and still
  // emitted false-positive warnings when the user re-ran the same check 1-2 minutes
  // later (without changing anything) and it succeeded. Now: poll up to ~120s total -
  // exit on the first success.
  // Even when gitConnect() reported failure, the implicit auto-link often works anyway
  // (connect can error for a cosmetic/API reason while the webhook is fine). So we no
  // longer cut that branch down to a short net - we give it a real ~90s window before
  // declaring the integration broken, which is what eliminated the observed false
  // positive (webhook landed at ~30-120s, past the old 30s cutoff).
  const MAX_ATTEMPTS = gitConnectOk ? 12 : 9;
  const DELAY_MS = 10000;
  // per_page=10 to be safe in case there are stale deployments ahead in the list.
  const cmd = `gh api "repos/${owner}/${repo}/deployments?per_page=10" --jq "[.[] | .creator.login]"`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`  attempt ${attempt}/${MAX_ATTEMPTS}: waiting ${DELAY_MS / 1000}s for vercel[bot]`);
    await new Promise((r) => setTimeout(r, DELAY_MS));

    const res = capture(cmd, PROJECT_DIR);
    const creators = res.stdout?.trim() || "";

    if (creators.includes("vercel[bot]")) {
      ok(
        `vercel[bot] picked up the push - GitHub↔Vercel auto-deploy is wired ` +
          `(detected after ~${attempt * (DELAY_MS / 1000)}s)`,
      );
      // The webhook is proven working, so any earlier `vercel git connect`
      // failure was cosmetic (API/CLI hiccup). Retract its warning so the
      // handoff banner doesn't scare the user with a contradicted alarm.
      if (unwarn("GH_VERCEL_CONNECT_FAILED") > 0) {
        ok(
          "Earlier `vercel git connect` warning retracted - auto-deploy is " +
            "proven working, the connect error was cosmetic.",
        );
      }
      return;
    }
  }

  // No vercel[bot] in the last 10 deployments after ~90s.
  warn(
    "GH_VERCEL_INTEGRATION_MISSING: a `git push` did not trigger a Vercel deployment " +
      `within ~${(MAX_ATTEMPTS * DELAY_MS) / 1000}s (no vercel[bot] in the last 10 deployments on GitHub). ` +
      "The first deploy via `vercel --prod` succeeded, but future pushes won't auto-deploy " +
      "until the user authorizes Vercel's GitHub app at https://vercel.com/integrations/github. " +
      "Claude should walk the user through this in the bootstrap SKILL flow. " +
      "Note: false positives are possible if the webhook is just slow - Claude's retry in Step 3 " +
      "should poll for another ~90s before declaring the integration broken.",
  );
}

// ─── Detect actual GitHub user + Vercel scope for the final summary ───
async function detectIdentities() {
  const ghUser = capture("gh api user --jq .login", PROJECT_DIR).stdout?.trim() || "<your-gh-user>";
  // The Vercel CLI doesn't expose teams as JSON, so we hit the REST API directly
  // using the CLI's stored auth token (same approach as push-env-vars.mjs).
  let vercelScope = "<your-vercel-scope>";
  try {
    const projectJson = JSON.parse(
      readFileSync(join(PROJECT_DIR, ".vercel/project.json"), "utf8"),
    );
    const orgId = projectJson.orgId;
    if (orgId?.startsWith("team_")) {
      // Same token reader as every other script: the freshest auth file, the
      // xdg.data folder of CLI v59 included. The first file found used to be
      // the pre-v59 one, frozen with a dead token.
      const token = loadAuthToken();
      if (!token) throw new Error("Vercel auth file not found in any known location.");
      const res = await fetch("https://api.vercel.com/v2/teams", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const t = (data.teams || []).find((x) => x.id === orgId);
        if (t?.slug) vercelScope = t.slug;
      }
    } else {
      const who = capture("vercel whoami", PROJECT_DIR).stdout?.trim();
      if (who) vercelScope = who;
    }
  } catch {/* keep placeholder - the run still succeeded, only the URL hint is approximate */}
  return { ghUser, vercelScope };
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("scaffoldT3", scaffoldT3);
await step("gitattributes", gitattributes);
await step("bumpDrizzle", bumpDrizzle);
await step("cleanupDemo", cleanupDemo);
await step("eslintCli", eslintCli);
await step("healthcheck", healthcheck);
await step("shadcn", shadcn);
await step("security", security);
await step("seo", seo);
await step("notFoundPage", notFoundPage);
await step("claudeMdCore", claudeMdCore);
await step("vercelConfig", vercelConfig);
await step("launchJsonConfig", launchJsonConfig);
await step("privacyPolicy", privacyPolicy);
await step("commit", commit);
await step("ghRepo", ghRepo);
await step("vercelLink", vercelLink);
await step("gitConnect", gitConnect);
await step("pushEnvVars", pushEnvVars);
await step("localBuild", localBuild);
await step("deploy", deploy);
await step("smokeTest", smokeTest);
await step("fixAppUrl", fixAppUrl);
await step("verifyAutoDeploy", verifyAutoDeploy);

const { ghUser, vercelScope } = await detectIdentities();

console.log(`
🎉 bootstrap-init complete.

   Project:  ${PROJECT_DIR}
   GitHub:   https://github.com/${ghUser}/${name}
   Vercel:   https://vercel.com/${vercelScope}/${name}
   Live:     ${deployedUrl ?? `https://${name}.vercel.app (UNRESOLVED - deploy URL was not captured)`}

Next: Claude takes over for the cahier-des-charges step, addon invocations
(add-db to replace the DATABASE_URL placeholder, add-auth, add-email,
add-stripe, ...), the application build, and the legal pages.
`);

dumpHandoff(true);
