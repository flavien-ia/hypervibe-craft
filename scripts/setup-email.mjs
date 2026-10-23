#!/usr/bin/env node
// setup-email.mjs - Deterministic core for /add-email (Resend OR Brevo).
//
// Both providers share the same overall flow (install SDK, write mail.ts, write
// contact tRPC router, register in root.ts, push env vars). Only the SDK names,
// escape function name, sendMail signature, and env vars differ. We unify them
// here behind a --provider flag so a single script handles both plugins.
//
// MONOREPO is NOT supported in this v1 - Claude is expected to handle that case
// manually following the SKILL.md.
//
// Usage:
//   Resend:
//     node setup-email.mjs --provider resend --name <project-name> [--web-dir .]
//
//   Brevo:
//     node setup-email.mjs --provider brevo --name <project-name> \
//       --brevo-sender <verified-email> [--brevo-sender-name <name>] [--web-dir .]
//
//   Either, when the need is not a contact form (password resets, notifications): add
//   --no-contact-router, and the contact router is neither written nor registered.
//   The contact router alone, for a project whose email was set up without it (the contact page
//   asks for it): --contact-router-only.
//
// Args:
//   --provider <resend|brevo>     required
//   --name <project-name>         required (used as the Brevo sender name default)
//   --web-dir <path>              default: cwd
//   --brevo-sender <email>        required if --provider brevo (an active sender at Brevo: /add-email
//                                 creates it through Brevo's API when the account has none)
//   --brevo-sender-name <name>    optional, default = project-name
//   --no-contact-router           skip the contact router and its registration in root.ts
//   --contact-router-only         write the contact router and register it, nothing else
//
// Prerequisites assumed by the script:
//   - The project's OWN sending key is in its .env and at its host (3.4.16): made by
//     email-key.mjs mint for Resend, typed in the masked window then recorded for Brevo (Step 2 of
//     the skill). This script reads it there, refuses the ACCOUNT's key (compared in this process
//     with the vault's item RESEND / BREVO, never shown), and never pushes it: the account's key
//     stays in the vault, for the gestures on the account itself (domains, senders, quotas, and at
//     Resend the projects' keys). No provider CLI is involved.
//   - The project has a working T3 scaffold (Next.js + tRPC + setup-security from /bootstrap,
//     because the contact router uses rateLimitedProcedure). Without rateLimitedProcedure, the
//     contact router is skipped with a warning (3.4.13): written anyway, it broke the build.
//
// stdout layout:
//   - Live logs: ▸ <step>, ✅ <result>, ⚠️ <warning>
//   - Handoff banner at the end (success OR failure)
//   - Last line on success: a single JSON object Claude can parse:
//       {"success": true, "provider": "resend|brevo", "envVars": [...keys pushed...]}
//
// Exit codes:
//   0 = success
//   1 = preflight failed (bad args, missing env, in monorepo)
//   2 = a step failed mid-pipeline; partial state on disk; handoff banner explains

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./_render.mjs";
import { envValue } from "./env-value.mjs";
import { contactRouterPlan, senderPlan } from "./email-sender.mjs";
import { accountKey } from "./email-key.mjs";

import { ensureToolsInPath } from "./_ensure-tools-path.mjs";

// Prepend common CLI install dirs to process.env.PATH so subprocess invocations
// (pnpm, gh, vercel, git, node) find their binaries even if Claude Code
// inherited a stale PATH (typical when tools were just installed via /start).
ensureToolsInPath();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let provider = "";
let name = "";
let webDir = ".";
let brevoSender = "";
let brevoSenderName = "";
let noContactRouter = false;
let contactRouterOnly = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--provider" && args[i + 1]) provider = args[++i];
  else if (a === "--name" && args[i + 1]) name = args[++i];
  else if (a === "--web-dir" && args[i + 1]) webDir = args[++i];
  else if (a === "--brevo-sender" && args[i + 1]) brevoSender = args[++i];
  else if (a === "--brevo-sender-name" && args[i + 1]) brevoSenderName = args[++i];
  else if (a === "--no-contact-router") noContactRouter = true;
  else if (a === "--contact-router-only") contactRouterOnly = true;
  else fail(`Unknown arg: ${a}`);
}

if (!provider || !["resend", "brevo"].includes(provider)) {
  fail("Usage: --provider <resend|brevo> is required");
}
if (!name) fail("--name <project-name> is required");
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) {
  fail(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${name}`);
}
const WEB_DIR = resolve(process.cwd(), webDir);

// The sender the project already has (set by an earlier setup, by the domain's own sub-skill, or
// by the organisation's administrator) is kept: a sender is pushed only where none is set
// (Hypervibe 3.4.11: a verified sender was replaced by Resend's test address, which only
// delivers to the account's owner, and Brevo's by the one typed here).
const senderInPlace = {
  RESEND_FROM_EMAIL: envValue(WEB_DIR, "RESEND_FROM_EMAIL"),
  BREVO_SENDER_EMAIL: envValue(WEB_DIR, "BREVO_SENDER_EMAIL"),
  BREVO_SENDER_NAME: envValue(WEB_DIR, "BREVO_SENDER_NAME"),
};
if (noContactRouter && contactRouterOnly) fail("--no-contact-router and --contact-router-only cannot go together.");
if (provider === "brevo" && !senderInPlace.BREVO_SENDER_EMAIL && !contactRouterOnly) {
  if (!brevoSender) fail("--brevo-sender <email> is required when --provider brevo and the project has no BREVO_SENDER_EMAIL yet");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(brevoSender)) {
    fail(`--brevo-sender must be a valid email. Got: ${brevoSender}`);
  }
}
if (provider === "brevo" && !brevoSenderName) brevoSenderName = name;

/** The sender variables to push: those the project lacks. The others are kept, and said. */
function senderPairs() {
  return senderPlan({ provider, inPlace: senderInPlace, brevoSender, brevoSenderName });
}

// Whether the contact router is written: decided once, from the flags and the project's tRPC.
const TRPC_PATH = join(WEB_DIR, "src/server/api/trpc.ts");
const ROUTER = contactRouterPlan({
  skip: noContactRouter,
  only: contactRouterOnly,
  trpc: existsSync(TRPC_PATH) ? readFileSync(TRPC_PATH, "utf8") : null,
});

// ─── helpers ──────────────────────────────────────────────────────────
const STEPS = contactRouterOnly
  ? ["preflight", "writeContactRouter", "registerRouter"]
  : [
      "preflight",
      "getApiKey",
      "installSdk",
      "writeMailTs",
      ...(ROUTER.write ? ["writeContactRouter", "registerRouter"] : []),
      "pushEnvVars",
    ];
const completed = [];
const warnings = [];
let current = null;
const state = {
  provider,
  apiKey: null, // captured in getApiKey, never logged in plain text
  envVarsPushed: [],
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
  console.log(`setup-email handoff state (provider: ${provider})`);
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
        "  - Each step in this script maps 1:1 to a section of add-email SKILL.md.\n",
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
  if (!deps.next) fail(`${WEB_DIR} doesn't depend on Next.js - add-email requires a Next.js project.`);
  if (!deps["@trpc/server"]) {
    fail(`${WEB_DIR} doesn't depend on @trpc/server - the contact router requires tRPC.`);
  }

  // The contact router uses rateLimitedProcedure (created by setup-security.mjs in /bootstrap):
  // without it, the router is not written (it would break the build), and that is said.
  if (!ROUTER.write) {
    if (contactRouterOnly) {
      fail(
        ROUTER.reason === "no-trpc"
          ? `${TRPC_PATH} not found - T3 may have moved its tRPC config: the contact router cannot be wired.`
          : "rateLimitedProcedure not found in src/server/api/trpc.ts: the contact router needs it for its " +
              "rate limiting. Run the security setup of /bootstrap first, then ask again.",
      );
    }
    if (ROUTER.reason === "no-rate-limit") {
      warn(
        "rateLimitedProcedure not found in src/server/api/trpc.ts: the contact router (which needs it) " +
          "was NOT written, so the build stays green. Everything else is set up. For a contact form " +
          "later: the security setup of /bootstrap, then /add-email's contact page.",
      );
    } else if (ROUTER.reason === "no-trpc") {
      warn(`${TRPC_PATH} not found - T3 may have moved its tRPC config: the contact router was not written.`);
    }
  }

  // Block accidental overwrites: refuse if mail.ts or contact router already exists.
  // Re-config flow is handled by Claude in SKILL Step 0 - by the time we're here, this
  // should be a fresh install. The contact router alone needs the mail utility it calls.
  const mailPath = join(WEB_DIR, "src/server/mail.ts");
  if (contactRouterOnly) {
    if (!existsSync(mailPath)) fail(`${mailPath} not found: the contact router sends through it. Run /add-email first.`);
  } else if (existsSync(mailPath)) {
    fail(
      `${mailPath} already exists. If you meant to re-configure email, use the /add-email ` +
        "re-configuration menu (Step 0 of the SKILL). To force a fresh install, delete the " +
        "file manually first.",
    );
  }
  const contactRouterPath = join(WEB_DIR, "src/server/api/routers/contact.ts");
  if (ROUTER.write && existsSync(contactRouterPath)) {
    if (contactRouterOnly) {
      ok("The contact router is already there (no-op)");
    } else {
      fail(
        `${contactRouterPath} already exists. If you meant to re-configure email, use the ` +
          "/add-email re-configuration menu. To force a fresh install, delete the file manually first.",
      );
    }
  }

  // pnpm available? (The contact router alone installs nothing.)
  if (!contactRouterOnly) {
    const pnpm = capture("pnpm --version", WEB_DIR);
    if (pnpm.status !== 0) fail("pnpm CLI is missing or broken.");
  }

  ok(`Web dir OK: ${WEB_DIR}`);
}

// ─── Step 2: the project's own key ────────────────────────────────────
async function getApiKey() {
  // The project's OWN sending key (3.4.16), already in its .env and at its host: made by
  // email-key.mjs mint (Resend) or typed in the masked window then recorded (Brevo), at Step 2 of
  // the skill. Never the account's key: until 3.4.15 this step read the account's key in the vault
  // and pushed it into every project, which opened the whole account to anyone who saw one .env.
  const item = provider === "resend" ? "RESEND" : "BREVO";
  const service = provider === "resend" ? "Resend" : "Brevo";
  const envVar = provider === "resend" ? "RESEND_API_KEY" : "BREVO_API_KEY";

  log(`Reading the project's own ${envVar}`);
  const value = envValue(WEB_DIR, envVar);
  if (!value) {
    fail(
      provider === "resend"
        ? "The project holds no RESEND_API_KEY of its own yet. Make it first (Step 2 of the skill):\n" +
            "  node scripts/email-key.mjs mint --project-dir <web dir> --name <project>\n" +
            "then re-run this script."
        : "The project holds no BREVO_API_KEY of its own yet (Step 2 of the skill): make it in Brevo's console, named\n" +
            "after the project, type it in the masked window (launch.mjs collect-env), record it\n" +
            "(node scripts/email-key.mjs record), then re-run this script.",
    );
  }
  // Compared with the account's key (the vault's item RESEND / BREVO) in this process, never shown.
  let account = null;
  try {
    account = accountKey(provider);
  } catch (e) {
    if (e.code === 2 || e.code === 3) {
      fail(
        `Vault locked / session expired: the project's key cannot be checked against the ${service} account's (item ${item}).\n` +
          `The skill unlocks it first: node scripts/vault/launch.mjs unlock, then re-run this script.`,
      );
    }
    // 4: no account key in the vault, nothing to compare with.
  }
  if (account && value === account) {
    fail(
      `This project holds the ${service} ACCOUNT's key: a project never holds it (it opens the whole account).\n` +
        `Give the project its own key first (Step 2 of the skill), then re-run this script.`,
    );
  }
  state.apiKey = value;
  ok(`The project's own ${envVar} is in place`);
}

// ─── Step 3: install SDK ──────────────────────────────────────────────
async function installSdk() {
  if (provider === "resend") {
    log("Installing resend");
    run("pnpm add resend", WEB_DIR);
    ok("resend installed");
  } else {
    log("Installing @getbrevo/brevo");
    run("pnpm add @getbrevo/brevo", WEB_DIR);
    ok("@getbrevo/brevo installed");
  }
}

// ─── Step 4: write src/server/mail.ts ─────────────────────────────────
async function writeMailTs() {
  log("Writing src/server/mail.ts");
  const dest = join(WEB_DIR, "src/server/mail.ts");
  // Templates: templates/email/<provider>/mail.ts (no vars to substitute).
  writeFileSync(dest, render(`email/${provider}/mail.ts`, {}));
  ok(`${dest} written`);
}

// ─── Step 5: write contact tRPC router ────────────────────────────────
async function writeContactRouter() {
  log("Writing src/server/api/routers/contact.ts");
  const dest = join(WEB_DIR, "src/server/api/routers/contact.ts");
  if (contactRouterOnly && existsSync(dest)) {
    ok(`${dest} kept as it is`);
    return;
  }
  // Templates: templates/email/<provider>/contact-router.ts (no vars).
  writeFileSync(dest, render(`email/${provider}/contact-router.ts`, {}));
  ok(`${dest} written`);
}

// ─── Step 6: register contactRouter in root.ts ────────────────────────
async function registerRouter() {
  log("Registering contactRouter in src/server/api/root.ts");
  const rootPath = join(WEB_DIR, "src/server/api/root.ts");
  if (!existsSync(rootPath)) {
    fail(`${rootPath} not found - T3 may have moved the appRouter. Register contactRouter manually.`);
  }
  let root = readFileSync(rootPath, "utf8");

  if (root.includes("contactRouter")) {
    ok("contactRouter already registered (no-op)");
    return;
  }

  const importLine = `import { contactRouter } from "~/server/api/routers/contact";\n`;
  const lastImport = root.match(/^((?:import[^;]+;[\r\n]+)+)/);
  if (lastImport) {
    root = root.replace(lastImport[0], lastImport[0] + importLine);
  } else {
    root = importLine + root;
  }

  // Inject `contact: contactRouter,` inside createTRPCRouter({ ... }).
  // We insert right after the opening brace, on a new line, with consistent indentation.
  const replaced = root.replace(
    /createTRPCRouter\(\s*\{/,
    `createTRPCRouter({\n  contact: contactRouter,`,
  );
  if (replaced === root) {
    fail(
      "Could not find createTRPCRouter({ ... }) in root.ts. " +
        "Register contactRouter manually: add `contact: contactRouter,` inside the router object.",
    );
  }
  writeFileSync(rootPath, replaced);
  ok("contactRouter registered");
}

// ─── Step 7: push env vars ────────────────────────────────────────────
async function pushEnvVars() {
  log("Pushing env vars to .env and Vercel");
  const helper = join(__dirname, "push-env-vars.mjs");
  if (!existsSync(helper)) fail(`Sibling script missing: ${helper}`);

  const { kept, pushed } = senderPairs();
  // The key itself is not pushed here: the project's own key reached .env and the hosting when it
  // was made (Step 2 of the skill). Only the sender's variables the project lacks.
  const kvs = pushed;
  state.envVarsPushed = kvs.map((kv) => kv.slice(0, kv.indexOf("=")));
  state.senderKept = kept;
  if (kept.length) ok(`Sender already set for the project, kept: ${kept.join(", ")}`);
  if (!kvs.length) return;

  // On the helper's standard input, never as arguments: an argument can be read in the process
  // list by anything running on the machine (3.3.4). The helper writes .env first, so a push that
  // failed can be run again from it without the values being typed or shown.
  const res = spawnSync("node", [helper, "--stdin"], {
    cwd: WEB_DIR,
    input: kvs.join("\n") + "\n",
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });
  if (res.status !== 0) {
    fail(
      "push-env-vars.mjs failed. SDK is installed and code is in place, only the env vars didn't land. Push them again from .env, without showing them: " +
        `grep -E '^(${state.envVarsPushed.join("|")})=' .env | node ${helper} --stdin`,
    );
  }
  ok(`Env vars pushed: ${state.envVarsPushed.join(", ")}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
if (contactRouterOnly) {
  await step("writeContactRouter", writeContactRouter);
  await step("registerRouter", registerRouter);
  dumpHandoff(true);
  console.log(`\n🎉 Contact router in place (${provider}): src/server/api/routers/contact.ts, registered as \`contact\` in root.ts.`);
  console.log(JSON.stringify({ success: true, provider, contactRouter: "written" }));
  process.exit(0);
}
await step("getApiKey", getApiKey);
await step("installSdk", installSdk);
await step("writeMailTs", writeMailTs);
if (ROUTER.write) {
  await step("writeContactRouter", writeContactRouter);
  await step("registerRouter", registerRouter);
}
await step("pushEnvVars", pushEnvVars);

dumpHandoff(true);

console.log(`
🎉 setup-email complete (${provider}).

   Provider:      ${provider}
   mail.ts:       src/server/mail.ts
   Contact route: ${ROUTER.write ? "src/server/api/routers/contact.ts (registered as `contact` in root.ts)" : `not written (${ROUTER.reason === "asked" ? "not asked for" : "the project's tRPC has no rateLimitedProcedure"})`}
   Env vars:      ${state.envVarsPushed.join(", ")}

Next: Claude takes over for the CLAUDE.md update (via _update-claude-md), the optional
domain-config flow (Resend) or sender-verification reminder (Brevo), the optional
contact-page creation (via _create-contact-page), and the user-facing summary.
`);

// Last line: structured JSON for Claude to parse.
console.log(
  JSON.stringify({
    success: true,
    provider,
    envVars: state.envVarsPushed,
    contactRouter: ROUTER.write ? "written" : `skipped:${ROUTER.reason}`,
  }),
);
