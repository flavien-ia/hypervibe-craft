#!/usr/bin/env node
// setup-2fa.mjs - Deterministic core for _setup-2fa-admin.
//
// Adds two-factor authentication (TOTP authenticator app) on top of an existing
// hypervibe admin-credentials auth:
//   - TOTP code verified after the password (otpauth, ±1 window)
//   - "trusted device" cookie: 2FA asked once / 24h per browser
//   - one-off backup codes (hashed in an env var, no DB needed)
//   - idle auto-logout component (mounted by Claude in the protected layout)
//
// SECURITY: the TOTP secret + plaintext backup codes are written to the user's
// Bitwarden vault (item <NAME>_2FA), NOT to the chat and NOT to a plaintext file.
// A QR png is written to <web>/.2fa-setup/ (gitignored) ONLY as a scanning aid;
// Claude tells the user to delete it after enrolling. If the vault is unavailable,
// the script falls back to a gitignored secrets.txt and flags it.
//
// Prereq: hypervibe admin auth + (ideally) an unlocked Bitwarden vault.
//
// Usage:
//   node setup-2fa.mjs --name <project-name> [--issuer <Label>] [--web-dir .]

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes, scryptSync } from "node:crypto";
import { render } from "./_render.mjs";
import { ensureToolsInPath } from "./_ensure-tools-path.mjs";
import { putItem } from "./vault/vault.mjs";
import { adminOnlyRefusal } from "./auth-modes.mjs";

ensureToolsInPath();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let name = "";
let issuer = "";
let webDir = ".";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--name" && args[i + 1]) name = args[++i];
  else if (a === "--issuer" && args[i + 1]) issuer = args[++i];
  else if (a === "--web-dir" && args[i + 1]) webDir = args[++i];
  else fail(`Unknown arg: ${a}`);
}
if (!name) fail("Usage: --name <project-name> is required");
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) fail(`--name must be kebab-case. Got: ${name}`);
if (!issuer) issuer = name.charAt(0).toUpperCase() + name.slice(1);
const COOKIE_NAME = `${name.replace(/[^a-z0-9_]/g, "_")}_2fa_trust`;
const VAULT_ITEM = `${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_2FA`;
const WEB_DIR = resolve(process.cwd(), webDir);

// ─── plumbing (mirrors setup-auth-admin.mjs) ──────────────────────────
const STEPS = ["preflight", "installDeps", "generateSecret", "generateBackupCodes", "writeCode", "storeSecrets", "pushEnvVars"];
const completed = [];
const warnings = [];
let current = null;
const state = { base32: null, otpauthUrl: null, backupCodes: [], backupHashes: [], qrPath: null, storedIn: null, needsRateLimit: false };

async function step(n, fn) { current = n; await fn(); completed.push(n); current = null; }
function log(m) { console.log(`\n▸ ${m}`); }
function ok(m) { console.log(`  ✅ ${m}`); }
function warn(m) { console.warn(`  ⚠️  ${m}`); warnings.push(m); }
function dumpHandoff() {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("setup-2fa handoff state");
  console.log("────────────────────────────────────────────────────────");
  console.log(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}`);
  if (current) console.log(`❌ Failed at: ${current}`);
  if (remaining.length) console.log(`⏸  Not attempted: ${remaining.join(", ")}`);
  if (warnings.length) { console.log(`\n⚠️  ${warnings.length} warning(s):`); for (const w of warnings) console.log(`   - ${w}`); }
  console.log("────────────────────────────────────────────────────────");
}
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  if (completed.length || current) dumpHandoff();
  // Exit 1 = clean refusal (nothing changed yet, e.g. preflight). Exit 2 = a
  // step completed before failure → partial state, resume carefully.
  process.exit(completed.length ? 2 : 1);
}
process.on("uncaughtException", (e) => {
  console.error(`\n❌ Unhandled exception: ${e.message}`);
  if (e.stack) console.error(e.stack);
  dumpHandoff();
  process.exit(2);
});
function run(cmd, cwd, opts = {}) {
  const res = spawnSync(cmd, { cwd, stdio: opts.capture ? "pipe" : "inherit", shell: true, encoding: "utf8" });
  if (res.status !== 0 && !opts.allowFail) fail(`Command failed (exit ${res.status}): ${cmd}`);
  return res;
}

function base32Encode(buf) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}
function hashCode(code) { const salt = randomBytes(16).toString("hex"); return `${salt}:${scryptSync(code, salt, 64).toString("hex")}`; }

// ─── steps ────────────────────────────────────────────────────────────
async function preflight() {
  log("Preflight");
  const pkgPath = join(WEB_DIR, "package.json");
  if (!existsSync(pkgPath)) fail(`No package.json at ${WEB_DIR}. Pass --web-dir.`);
  const deps = (() => { const p = JSON.parse(readFileSync(pkgPath, "utf8")); return { ...p.dependencies, ...p.devDependencies }; })();
  if (!deps.next) fail(`${WEB_DIR} isn't a Next.js project.`);
  const authPath = join(WEB_DIR, "src/server/auth.ts");
  if (!existsSync(authPath)) fail("src/server/auth.ts not found - run /add-auth (admin mode) first.");
  // writeCode REPLACES src/server/auth.ts with the admin-only 2FA version: only over the admin-only
  // file /add-auth writes. A combined sign-in (`// hypervibe:auth-modes admin, users`) passed the old
  // check (`admin\b`), and the rewrite removed the users' sign-in without a word (report of
  // 12/11/2026). Anything else is refused, the file left as it is.
  const refusal = adminOnlyRefusal(readFileSync(authPath, "utf8"));
  if (refusal) fail(refusal);
  if (!existsSync(join(WEB_DIR, "src/lib/password.ts"))) fail("src/lib/password.ts not found - expected from /add-auth admin mode.");
  if (existsSync(join(WEB_DIR, "src/lib/auth-2fa.ts"))) fail("src/lib/auth-2fa.ts already exists - 2FA seems already installed.");
  // loginAction and authorize() (auth.ts) import checkRateLimit from ~/lib/rate-limit. Bootstrap creates
  // it via setup-security; a standalone /add-auth doesn't. If absent, writeCode
  // drops a minimal in-memory limiter so the build doesn't break.
  state.needsRateLimit = !existsSync(join(WEB_DIR, "src/lib/rate-limit.ts"));
  if (state.needsRateLimit) warn("src/lib/rate-limit.ts missing - a minimal fallback will be created.");
  if (run("pnpm --version", WEB_DIR, { capture: true, allowFail: true }).status !== 0) fail("pnpm missing.");
  ok(`Web dir OK: ${WEB_DIR}`);
}

async function installDeps() {
  log("Installing otpauth + qrcode");
  run("pnpm add otpauth", WEB_DIR);
  run("pnpm add -D qrcode", WEB_DIR);
  ok("otpauth (runtime) + qrcode (setup-only) installed");
}

async function generateSecret() {
  log("Generating TOTP secret");
  state.base32 = base32Encode(randomBytes(20));
  const enc = encodeURIComponent(issuer);
  state.otpauthUrl = `otpauth://totp/${enc}:admin?secret=${state.base32}&issuer=${enc}&algorithm=SHA1&digits=6&period=30`;
  ok("Secret + otpauth URL ready");
}

async function generateBackupCodes() {
  log("Generating backup codes (8)");
  for (let i = 0; i < 8; i++) {
    const hex = randomBytes(4).toString("hex").toUpperCase();
    const code = `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
    state.backupCodes.push(code);
    state.backupHashes.push(hashCode(code));
  }
  ok("8 backup codes generated + hashed");
}

async function writeCode() {
  log("Writing 2FA code (auth.ts, lib, signin, idle-timeout)");
  const writes = [
    ["src/server/auth.ts", "2fa/auth.ts", {}],
    ["src/lib/auth-2fa.ts", "2fa/auth-2fa.ts", { COOKIE_NAME, ISSUER: issuer }],
    ["src/lib/auth-backup-codes.ts", "2fa/auth-backup-codes.ts", {}],
    ["src/app/admin/signin/actions.ts", "2fa/signin-actions.ts", {}],
    ["src/app/admin/signin/page.tsx", "2fa/signin-page.tsx", {}],
    ["src/components/dashboard/idle-timeout.tsx", "2fa/idle-timeout.tsx", {}],
  ];
  for (const [relDest, tpl, vars] of writes) {
    const dest = join(WEB_DIR, relDest);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, render(tpl, vars));
  }
  // Fallback rate limiter when the project lacks one (standalone /add-auth):
  // loginAction and authorize() won't compile without ~/lib/rate-limit.
  if (state.needsRateLimit) {
    const rl = join(WEB_DIR, "src/lib/rate-limit.ts");
    mkdirSync(dirname(rl), { recursive: true });
    writeFileSync(rl, render("2fa/rate-limit.ts", {}));
    ok("src/lib/rate-limit.ts created (fallback - was missing)");
  }
  ok("Code written");
}

async function storeSecrets() {
  log("Storing secret + backup codes in Bitwarden + writing QR (scan aid)");
  // QR png in a gitignored folder (a scanning convenience - deleted after setup).
  const dir = join(WEB_DIR, ".2fa-setup");
  mkdirSync(dir, { recursive: true });
  const QRCode = createRequire(join(WEB_DIR, "package.json"))("qrcode");
  state.qrPath = join(dir, "qrcode.png");
  await QRCode.toFile(state.qrPath, state.otpauthUrl, { width: 400, margin: 2 });
  const giPath = join(WEB_DIR, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  if (!gi.split(/\r?\n/).some((l) => l.trim() === ".2fa-setup/")) {
    appendFileSync(giPath, `${gi.endsWith("\n") || gi === "" ? "" : "\n"}.2fa-setup/\n`);
  }

  // Primary store: Bitwarden vault (encrypted, never in chat / plaintext on disk).
  try {
    const action = putItem(
      VAULT_ITEM,
      [
        { name: "totp_secret", value: state.base32, type: "secret" },
        { name: "otpauth_url", value: state.otpauthUrl, type: "secret" },
        { name: "backup_codes", value: state.backupCodes.join(" "), type: "secret" },
      ],
      { service: `${issuer} 2FA admin`, folder: "Global" },
    );
    state.storedIn = "vault";
    ok(`Secret + backup codes ${action} in Bitwarden item ${VAULT_ITEM}`);
  } catch (e) {
    // Fallback: gitignored secrets.txt (vault locked / unavailable).
    const secretsPath = join(dir, "secrets.txt");
    writeFileSync(
      secretsPath,
      [
        `${issuer} - 2FA admin`,
        `Cle TOTP : ${state.base32}`,
        `URL      : ${state.otpauthUrl}`,
        "",
        "Codes de secours :",
        ...state.backupCodes.map((c, i) => `  ${i + 1}. ${c}`),
        "",
        "Sauvegarde-les puis SUPPRIME le dossier .2fa-setup/.",
        "",
      ].join("\n"),
      "utf8",
    );
    state.storedIn = "file";
    warn(`Bitwarden indisponible (${e.message}). Repli : secrets écrits dans ${secretsPath} (gitignoré).`);
  }
}

async function pushEnvVars() {
  log("Pushing ADMIN_TOTP_SECRET + ADMIN_2FA_BACKUP_HASHES");
  const helper = join(__dirname, "push-env-vars.mjs");
  if (!existsSync(helper)) fail(`Sibling script missing: ${helper}`);
  const kvs = [`ADMIN_TOTP_SECRET=${state.base32}`, `ADMIN_2FA_BACKUP_HASHES=${JSON.stringify(state.backupHashes)}`];
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
      "push-env-vars.mjs failed. Code is in place but env vars didn't land. Push them again from .env, without showing them: " +
        "grep -E '^(ADMIN_TOTP_SECRET|ADMIN_2FA_BACKUP_HASHES)=' .env | node " + helper + " --target=all --stdin",
    );
  }
  ok("Env vars pushed");
}

// ─── main ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("installDeps", installDeps);
await step("generateSecret", generateSecret);
await step("generateBackupCodes", generateBackupCodes);
await step("writeCode", writeCode);
await step("storeSecrets", storeSecrets);
await step("pushEnvVars", pushEnvVars);

dumpHandoff();
console.log(`
🎉 setup-2fa complete.

   TOTP issuer:    ${issuer} (label: admin)
   Trusted device: 24h cookie (${COOKIE_NAME})
   Secrets stored: ${state.storedIn === "vault" ? `Bitwarden item ${VAULT_ITEM}` : `file ${state.qrPath ? dirname(state.qrPath) : ".2fa-setup"}/secrets.txt`}
   QR (scan aid):  ${state.qrPath}

Next: Claude mounts <IdleTimeout/> in the admin protected layout, updates
CLAUDE.md, then tells the user where to find the secret + codes (vault or file)
and to delete the .2fa-setup/ folder after enrolling. No secret in this output.
`);
console.log(
  JSON.stringify({
    success: true,
    issuer,
    storedIn: state.storedIn,
    vaultItem: state.storedIn === "vault" ? VAULT_ITEM : null,
    qrPath: state.qrPath,
    envVars: ["ADMIN_TOTP_SECRET", "ADMIN_2FA_BACKUP_HASHES"],
  }),
);
