#!/usr/bin/env node
// setup-auth-admin.mjs - Deterministic core for /add-auth in admin-credentials mode.
//
// Single hardcoded admin (login = ADMIN_USERNAME, password hash in env vars).
// No DB, no users table, no OAuth. Pure NextAuth + Credentials provider with a
// Drizzle-free authorize() callback.
//
// FRESH INSTALL ONLY: refuses if `src/server/auth.ts` already exists. The
// upgrade case (admin already exists, user wants to add user-credentials, or
// vice versa) is handled by Claude in the SKILL Step 0 - it reads the existing
// auth.ts and edits it contextually rather than re-running this script.
//
// Usage:
//   node setup-auth-admin.mjs --name <project-name> [--web-dir .]
//
// stdout layout:
//   - Live logs: ▸ <step>, ✅ <result>, ⚠️ <warning>
//   - Handoff banner at the end
//   - Last line on success: JSON Claude can parse:
//     {"success":true,"authMode":"admin","credentialsFile":"<path>","envVars":[...]}
//     The production password is NEVER in it (3.4.13): it is written, with the identifier and the
//     sign-in page, in a file of the person's downloads folder (admin-password.mjs), and only its
//     hash goes to the project. Displayed in the chat, it stayed in the conversation's history.
//
// Exit codes:
//   0 = success
//   1 = preflight failed (bad args, missing dep, auth.ts exists, in monorepo without --allow-monorepo)
//   2 = a step failed mid-pipeline; partial state on disk; handoff banner explains

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { render } from "./_render.mjs";
import { newAdminPassword, signinUrl, writeCredentialsFile } from "./admin-password.mjs";
import { ensureAdminMiddleware } from "./admin-gate.mjs";

import { ensureToolsInPath } from "./_ensure-tools-path.mjs";

// Prepend common CLI install dirs to process.env.PATH so subprocess invocations
// (pnpm, gh, vercel, git, node) find their binaries even if Claude Code
// inherited a stale PATH (typical when tools were just installed via /start).
ensureToolsInPath();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let name = "";
let webDir = ".";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--name" && args[i + 1]) name = args[++i];
  else if (a === "--web-dir" && args[i + 1]) webDir = args[++i];
  else fail(`Unknown arg: ${a}`);
}

if (!name) fail("Usage: --name <project-name> is required (used for the API-keys label)");
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) {
  fail(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${name}`);
}

const WEB_DIR = resolve(process.cwd(), webDir);

// ─── helpers ──────────────────────────────────────────────────────────
const STEPS = [
  "preflight",
  "installNextAuth",
  "generateAuthSecret",
  "hashPasswords",
  "writePasswordTs",
  "writeAuthTs",
  "writeApiRoute",
  "writeAdminPages",
  "writeAdminGate",
  "pushEnvVars",
];
const completed = [];
const warnings = [];
let current = null;
const state = {
  authSecret: null,
  devHash: null,
  prodHash: null,
  credentialsFile: null,
  adminGate: null,
};

async function step(stepName, fn) {
  current = stepName;
  await fn();
  completed.push(stepName);
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

function dumpHandoff(success) {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("setup-auth-admin handoff state");
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
        `  - Web dir: ${WEB_DIR}\n` +
        "  - Each step in this script maps 1:1 to a section of _setup-auth-admin SKILL.md.\n",
    );
  }
  console.log("────────────────────────────────────────────────────────");
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  if (completed.length || current) dumpHandoff(false);
  process.exit(completed.length || current ? 2 : 1);
}

process.on("uncaughtException", (e) => {
  console.error(`\n❌ Unhandled exception: ${e.message}`);
  if (e.stack) console.error(e.stack);
  dumpHandoff(false);
  process.exit(2);
});

function run(cmd, cwd, opts = {}) {
  const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : cmd;
  const res = spawnSync(cmdStr, {
    cwd,
    stdio: opts.capture ? "pipe" : "inherit",
    shell: true,
    encoding: "utf8",
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

function capture(cmd, cwd) {
  return run(cmd, cwd, { capture: true, allowFail: true });
}

// ─── Step 1: preflight ────────────────────────────────────────────────
async function preflight() {
  log("Preflight");

  const pkgPath = join(WEB_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    fail(`No package.json at ${WEB_DIR}. Pass --web-dir <path-to-nextjs-app> if needed.`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) fail(`${WEB_DIR} doesn't depend on Next.js - add-auth requires a Next.js project.`);

  // Refuse if any auth.ts exists (fresh install only - upgrade is Claude's job).
  const authPath = join(WEB_DIR, "src/server/auth.ts");
  if (existsSync(authPath)) {
    fail(
      `${authPath} already exists. setup-auth-admin only handles fresh installs. ` +
        "If you want to ADD admin auth on top of an existing user-credentials setup, " +
        "Claude must edit the existing auth.ts contextually - see add-auth SKILL Step 0.",
    );
  }

  // Refuse if any of the admin pages we'll scaffold already exist (avoid clobbering
  // user customizations on a re-run).
  const pageCollisions = [
    "src/app/admin/signin/page.tsx",
    "src/app/admin/(protected)/layout.tsx",
    "src/app/admin/(protected)/page.tsx",
    "src/server/require-admin.ts",
  ];
  for (const rel of pageCollisions) {
    if (existsSync(join(WEB_DIR, rel))) {
      fail(
        `${rel} already exists. setup-auth-admin only handles fresh installs. ` +
          "Delete this file manually if you really mean to regenerate it, then re-run.",
      );
    }
  }

  // rate-limit.ts is created by setup-security.mjs in bootstrap. If absent (standalone
  // /add-auth), warn - the API route template imports from ~/lib/rate-limit and won't compile.
  const rateLimitPath = join(WEB_DIR, "src/lib/rate-limit.ts");
  if (!existsSync(rateLimitPath)) {
    warn(
      "src/lib/rate-limit.ts not found - bootstrap usually creates it via setup-security.mjs. " +
        "The generated src/app/api/auth/[...nextauth]/route.ts imports `checkRateLimit` from " +
        "~/lib/rate-limit, so the build will fail until you create that utility (see " +
        "scripts/setup-security.mjs for reference).",
    );
  }

  // pnpm available?
  const pnpm = capture("pnpm --version", WEB_DIR);
  if (pnpm.status !== 0) fail("pnpm CLI is missing or broken.");

  ok(`Web dir OK: ${WEB_DIR}`);
}

// ─── Step 2: install NextAuth ─────────────────────────────────────────
async function installNextAuth() {
  log("Installing next-auth@beta");
  run("pnpm add next-auth@beta", WEB_DIR);
  ok("next-auth installed");
}

// ─── Step 3: generate AUTH_SECRET ─────────────────────────────────────
async function generateAuthSecret() {
  log("Generating AUTH_SECRET (32 bytes base64url)");
  state.authSecret = randomBytes(32).toString("base64url");
  ok("AUTH_SECRET generated");
}

// ─── Step 4: hash dev + prod passwords ────────────────────────────────
async function hashPasswords() {
  log("Hashing admin passwords (dev + prod)");

  const hashScript = join(__dirname, "hash-password.mjs");
  if (!existsSync(hashScript)) fail(`Sibling script missing: ${hashScript}`);

  // Dev: fixed password "Admin1234!" piped via stdin
  const devRes = spawnSync("node", [hashScript], {
    cwd: WEB_DIR,
    input: "Admin1234!",
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (devRes.status !== 0) {
    if (devRes.stderr) process.stderr.write(devRes.stderr);
    fail(`hash-password.mjs (dev) failed with exit ${devRes.status}`);
  }
  state.devHash = devRes.stdout.trim();
  if (!/^[0-9a-f]+:[0-9a-f]+$/.test(state.devHash)) {
    fail(`Unexpected dev hash format: ${state.devHash.slice(0, 50)}`);
  }
  ok("Dev hash ready");

  // Prod: a generated password, written for the person in a file of their downloads folder, never
  // printed; only its hash is kept here. The file is written BEFORE anything is pushed: a password
  // nobody can read would lock the admin out.
  const { password, hash } = newAdminPassword();
  state.prodHash = hash;
  try {
    state.credentialsFile = writeCredentialsFile({ project: name, username: "admin", password, url: signinUrl(WEB_DIR) });
  } catch (e) {
    fail(`The production password's file could not be written in the downloads folder (${e.code ?? e.message}). Nothing was pushed.`);
  }
  ok(`Prod hash ready; the password is in ${state.credentialsFile}`);
}

// ─── Step 5: write src/lib/password.ts ────────────────────────────────
async function writePasswordTs() {
  log("Writing src/lib/password.ts");
  const dest = join(WEB_DIR, "src/lib/password.ts");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, render("auth/admin/password.ts", {}));
  ok("password.ts written");
}

// ─── Step 6: write src/server/auth.ts ─────────────────────────────────
async function writeAuthTs() {
  log("Writing src/server/auth.ts");
  const dest = join(WEB_DIR, "src/server/auth.ts");
  writeFileSync(dest, render("auth/admin/auth.ts", {}));
  ok("auth.ts written (mode: admin)");
}

// ─── Step 7: write API route with rate limiting ───────────────────────
async function writeApiRoute() {
  log("Writing src/app/api/auth/[...nextauth]/route.ts");
  const dest = join(WEB_DIR, "src/app/api/auth/[...nextauth]/route.ts");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, render("auth/admin/route.ts", {}));
  ok("NextAuth API route written");
}

// ─── Step 8: write admin pages (signin + protected route group) ───────
// Scaffolds a minimal but functional admin space using the route group pattern
// so the layout's check doesn't catch /admin/signin (which would cause an infinite
// redirect loop). Claude restyles afterwards based on the project's design.
// Every page of the group calls requireAdmin() on its first line (3.4.17): the
// layout's check alone let the page's content leave in the body of its redirect.
async function writeAdminPages() {
  log("Writing admin pages (signin + protected route group + requireAdmin)");

  const targets = [
    ["src/server/require-admin.ts", "auth/admin/require-admin.ts"],
    ["src/app/admin/signin/page.tsx", "auth/admin/pages/signin.tsx"],
    ["src/app/admin/(protected)/layout.tsx", "auth/admin/pages/protected-layout.tsx"],
    ["src/app/admin/(protected)/page.tsx", "auth/admin/pages/protected-page.tsx"],
  ];

  for (const [relDest, tplPath] of targets) {
    const dest = join(WEB_DIR, relDest);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, render(tplPath, {}));
  }
  ok("Pages written: /admin/signin (signin form), /admin (protected dashboard placeholder), src/server/require-admin.ts");
}

// ─── Step 8b: the first barrier, a middleware (3.4.17) ────────────────
// src/middleware.ts (src/proxy.ts from Next.js 16) sends a request for an admin
// page without a session cookie to the sign-in page before anything renders. A
// first barrier, never the only one. A middleware the project already has is never
// replaced: the warning names it, and Claude merges by hand or tells the person.
async function writeAdminGate() {
  log("Writing the admin gate's middleware (never over an existing one)");
  state.adminGate = ensureAdminMiddleware(WEB_DIR);
  const { status, file, next } = state.adminGate;
  if (status === "written") ok(`Middleware written: ${file} (Next.js ${next ?? "version unknown"})`);
  else if (status === "present") ok(`Admin gate already in place: ${file}`);
  else {
    warn(
      `The project already has a middleware (${file}): left as it is. The admin gate is not in it yet: ` +
        "merge templates/auth/admin/middleware.ts into it by hand when that is safe, or tell the person what to add. " +
        "The pages stay protected by requireAdmin() either way.",
    );
  }
}

// ─── Step 9: push env vars ────────────────────────────────────────────
async function pushEnvVars() {
  log("Pushing AUTH_SECRET + ADMIN_USERNAME + ADMIN_PASSWORD_HASH_DEV + ADMIN_PASSWORD_HASH_PROD");
  const helper = join(__dirname, "push-env-vars.mjs");
  if (!existsSync(helper)) fail(`Sibling script missing: ${helper}`);

  const kvs = [
    `AUTH_SECRET=${state.authSecret}`,
    `ADMIN_USERNAME=admin`,
    `ADMIN_PASSWORD_HASH_DEV=${state.devHash}`,
    `ADMIN_PASSWORD_HASH_PROD=${state.prodHash}`,
  ];

  // ADMIN_PASSWORD_HASH_DEV must reach development (we want the dev login working
  // locally too); --target=all forces all 3 environments regardless of NEXT_PUBLIC_ prefix.
  // On the helper's standard input, never as arguments: an argument can be read in the process
  // list by anything running on the machine (3.3.4). The helper writes .env first, so a push that
  // failed can be run again from it without the values being typed or shown.
  const res = spawnSync("node", [helper, "--target=all", "--stdin"], {
    cwd: WEB_DIR,
    input: kvs.join("\n") + "\n",
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });
  if (res.status !== 0) {
    fail(
      "push-env-vars.mjs failed. The code is in place but env vars didn't land. Push them again from .env, without showing them: " +
        "grep -E '^(AUTH_SECRET|ADMIN_USERNAME|ADMIN_PASSWORD_HASH_DEV|ADMIN_PASSWORD_HASH_PROD)=' .env | node " + helper + " --target=all --stdin",
    );
  }
  ok("Env vars pushed");
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("installNextAuth", installNextAuth);
await step("generateAuthSecret", generateAuthSecret);
await step("hashPasswords", hashPasswords);
await step("writePasswordTs", writePasswordTs);
await step("writeAuthTs", writeAuthTs);
await step("writeApiRoute", writeApiRoute);
await step("writeAdminPages", writeAdminPages);
await step("writeAdminGate", writeAdminGate);
await step("pushEnvVars", pushEnvVars);

dumpHandoff(true);

console.log(`
🎉 setup-auth-admin complete.

   Mode:           admin (single hardcoded admin via env vars, no DB)
   auth.ts:        src/server/auth.ts
   password.ts:    src/lib/password.ts
   API route:      src/app/api/auth/[...nextauth]/route.ts (with rate limiting)
   Pages:          /admin/signin (signin form) + /admin (protected dashboard placeholder)
                   Route group (protected) isolates the gate from the signin page (no redirect loop)
                   Every page of the group starts with await requireAdmin() (src/server/require-admin.ts)
   Middleware:     ${state.adminGate?.status === "existing" ? `none added, the project already has ${state.adminGate.file}` : state.adminGate?.file ?? "none"}
   Env vars:       AUTH_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH_DEV, ADMIN_PASSWORD_HASH_PROD

Dev login:    admin / Admin1234!
Prod login:   admin / the password written in ${state.credentialsFile}

Next: Claude takes over for the CLAUDE.md update (via _update-claude-md) and the user-facing
summary, which gives the file's path: never the password itself.
`);

// Last line: structured JSON. It carries the file's path, never the password.
console.log(
  JSON.stringify({
    success: true,
    authMode: "admin",
    credentialsFile: state.credentialsFile,
    adminGate: state.adminGate,
    envVars: ["AUTH_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD_HASH_DEV", "ADMIN_PASSWORD_HASH_PROD"],
  }),
);
