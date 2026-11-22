#!/usr/bin/env node
// setup-agent.mjs - Deterministic core for _create-agent.
//
// Scaffolds an AI agent into a Turborepo monorepo as
// `apps/{agent-name}/`, ready to deploy on Render Background Worker.
//
// Pipeline (13 sub-steps, all run in parallel when possible):
//   1. preflight        - args, paths, Next.js detection, monorepo check
//   2. resolveModel     - pick the model from the live OpenRouter catalogue
//   3. ensureMonorepo   - convert to Turborepo if not already (delegates to caller)
//   4. scaffoldAgent    - copy templates/agent/* → apps/{name}/ with subst
//   4b. agentKey        - mint the agent's OWN capped OpenRouter key into its .env
//   5. patchSystemPrompt- inject the user's system prompt into loop.ts
//   6. patchAgentName   - set TEMPLATE_AGENT_NAME = "<slug>" in loop.ts and memory-kv.ts
//   7. patchTools       - remove tools the user opted out of
//   8. patchMemory      - comment out memory-kv import if user chose stateless
//   9. mergeSchema      - append schema-snippet.ts to main src/server/db/schema.ts
//  10. installDeps      - pnpm install (workspace-wide)
//  11. drizzlePush      - pnpm db:push to create the agent_* tables in Neon
//  12. handoff          - print structured JSON for Claude to consume
//
// Usage:
//   node setup-agent.mjs \
//     --name "newsletter-summarizer" \
//     --description "Summarize my RSS feeds every morning and send me a brief" \
//     --web-dir "apps/web" \
//     --trigger "cron"      # cron | continuous | manual
//     --memory "kv"          # none | kv (pgvector for v1.5)
//     --model "anthropic/claude-sonnet-5.5"  # optional: omit to auto-pick the
//                                 # top of the quality tier in the catalogue
//     --budget-usd 20             # optional: cap of the agent's own key
//
// Output: live logs on stderr, final JSON object on stdout last line.
//
// ─── Version pins in templates/agent/package.json ─────────────────────
// package.json cannot carry comments, so the reason for each deliberate pin
// and the condition that lifts it are recorded here. A pin without a written
// lifting condition is a bug; a pin that is commented and watched is a
// decision. The hypervibe-watch skill re-checks these every week.
//
//   (no model SDK)                   The worker talks to OpenRouter over plain
//                                    fetch, in ai.ts. No provider library to
//                                    pin, and no migration the day the model
//                                    changes: the model is a string.
//   node-cron          ^3.0.3        v4 changed the cron.schedule signature,
//                                    which entry.ts calls directly. Lift once
//                                    entry.ts is ported to the v4 signature.
//   typescript         ^5.6.0        TS7 is the Go port. Migrating the whole
//                                    T3 base is a separate project; lift when
//                                    that lands, not agent-side alone.
//   @types/node        ^24.0.0       Tracks the Node LTS the plugin targets.
//                                    Lift when the supported LTS moves.
//
// Exit codes:
//   0 - success
//   1 - preflight failed
//   2 - pipeline failed mid-way (handoff JSON has details)

import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readUserEnv } from "./_read-user-env.mjs";

import { ensureToolsInPath } from "./_ensure-tools-path.mjs";
import { checkBeforeForcePush } from "./neon/schema-drift.mjs";

// Prepend common CLI install dirs to process.env.PATH so subprocess invocations
// (pnpm, gh, vercel, git, node) find their binaries even if Claude Code
// inherited a stale PATH (typical when tools were just installed via /start).
ensureToolsInPath();

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, "../templates/agent");

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  name: "",
  description: "",
  webDir: "apps/web",
  trigger: "cron",
  memory: "kv",
  model: "", // empty = resolve from the live catalogue (see resolveModel)
  budgetUsd: 20, // spending cap of the agent's own OpenRouter key
  systemPrompt: "",
  // Who this agent may email, and which hosts it may write to. Empty means
  // "nothing goes out", which is the right default: an agent that reads the
  // open web, holds private data and can send anywhere is the exact shape an
  // indirect prompt injection needs. See templates/agent/tools/send-email.ts.
  mailAllowlist: "",
  fetchWriteHosts: "",
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = args[i + 1];
  switch (a) {
    case "--name": opts.name = next; i++; break;
    case "--description": opts.description = next; i++; break;
    case "--web-dir": opts.webDir = next; i++; break;
    case "--trigger": opts.trigger = next; i++; break;
    case "--memory": opts.memory = next; i++; break;
    case "--model": opts.model = next; i++; break;
    case "--budget-usd": opts.budgetUsd = Number(next); i++; break;
    case "--system-prompt": opts.systemPrompt = next; i++; break;
    case "--mail-allowlist": opts.mailAllowlist = next; i++; break;
    case "--fetch-write-hosts": opts.fetchWriteHosts = next; i++; break;
    default: fail(`Unknown arg: ${a}`);
  }
}

const REPO_ROOT = process.cwd();
const AGENT_DIR = join(REPO_ROOT, "apps", opts.name);

// ─── handoff state ────────────────────────────────────────────────────
const STEPS = [
  "preflight", "resolveModel", "ensureMonorepo", "scaffoldAgent", "agentKey",
  "patchSystemPrompt", "patchAgentName", "patchTools", "patchMemory",
  "mergeSchema", "installDeps", "drizzlePush", "handoff",
];
const completed = [];
const warnings = [];
const state = {
  agentKeyHash: null,
  agentKeyCapUsd: null,
  agentKeyRecorded: false,
  monorepoConverted: false,
  schemaPatched: false,
};
let current = null;

async function step(name, fn) {
  current = name;
  log(name);
  await fn();
  completed.push(name);
  current = null;
}
function log(msg) { process.stderr.write(`\n▸ ${msg}\n`); }
function ok(msg) { process.stderr.write(`  ✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`  ⚠️  ${msg}\n`); warnings.push(msg); }
// Stop the process with an exact exit code, even right after a network call.
// On Windows, process.exit() called within a few ms of the last HTTPS response crashes
// Node (libuv assertion "UV_HANDLE_CLOSING") and the process reports 127 - the caller then
// cannot tell 2 (partial, resume possible) from 1 (nothing done). Measured 2026-08-04:
// systematic under 10 ms, never above 50 ms. The pause below is SYNCHRONOUS on purpose:
// fail() must never return to its caller, so we cannot wait through the event loop.
// It only ever runs on a failure path.
function exitNow(code) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  process.exit(code);
}
function fail(msg) {
  process.stderr.write(`\n❌ ${msg}\n`);
  if (completed.length || current) dumpHandoff(false, msg);
  exitNow(completed.length || current ? 2 : 1);
}
function dumpHandoff(success, errMsg) {
  const remaining = STEPS.filter(s => !completed.includes(s) && s !== current);
  process.stderr.write(`\n────────────────────────────────────────────────────────\n`);
  process.stderr.write(`setup-agent handoff state\n`);
  process.stderr.write(`────────────────────────────────────────────────────────\n`);
  process.stderr.write(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}\n`);
  if (current) process.stderr.write(`❌ Failed at: ${current}\n`);
  if (remaining.length) process.stderr.write(`⏸  Not attempted: ${remaining.join(", ")}\n`);
  if (warnings.length) {
    process.stderr.write(`\n⚠️  ${warnings.length} warning(s):\n`);
    for (const w of warnings) process.stderr.write(`   - ${w}\n`);
  }
}

process.on("uncaughtException", (e) => {
  process.stderr.write(`\n❌ Uncaught: ${e.message}\n`);
  if (e.stack) process.stderr.write(e.stack + "\n");
  dumpHandoff(false, e.message);
  exitNow(2);
});

function run(cmd, cwd, capture = false) {
  const res = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (res.status !== 0 && !capture) fail(`Command failed: ${cmd}`);
  return res;
}

// ─── Step 1 - preflight ──────────────────────────────────────────────
async function preflight() {
  if (!opts.name || !/^[a-z][a-z0-9-]{1,40}$/.test(opts.name)) {
    fail(`--name must be kebab-case, 2-41 chars (got: "${opts.name}")`);
  }
  if (!["cron", "continuous", "manual"].includes(opts.trigger)) {
    fail(`--trigger must be cron|continuous|manual (got: "${opts.trigger}")`);
  }
  if (!["none", "kv", "pgvector"].includes(opts.memory)) {
    fail(`--memory must be none|kv|pgvector (got: "${opts.memory}")`);
  }
  if (existsSync(AGENT_DIR)) {
    fail(`apps/${opts.name}/ already exists. Pick a different --name or remove it first.`);
  }
  // Check templates dir
  if (!existsSync(TEMPLATE_DIR)) fail(`Templates not found at ${TEMPLATE_DIR}`);
  // Check web app exists (Next.js)
  const webPkg = join(REPO_ROOT, opts.webDir, "package.json");
  if (!existsSync(webPkg)) fail(`No package.json at ${opts.webDir}/. Pass --web-dir if your Next.js app is elsewhere.`);
  ok(`agent will be scaffolded at: apps/${opts.name}/`);
  ok(`web app detected at: ${opts.webDir}/`);
}

// ─── Step 2 - agentKey (a capped key of its own) ─────────────────────
// The agent gets its OWN OpenRouter key, separate from the app's, for one
// reason: an agent that runs away must not starve the features users are
// looking at, and two budgets read separately are two budgets you can reason
// about. The value never crosses this process - ai-setup writes it into the
// agent's own .env itself (no Vercel project there, so it stays local), and
// the SKILL tells the user to copy it into Render from that file.
async function agentKey() {
  const setup = join(__dirname, "ai", "ai-setup.mjs");
  const res = spawnSync(
    "node",
    [
      setup,
      "cle",
      "--nom", `${opts.name}-agent`,
      "--plafond", String(opts.budgetUsd || 20),
      "--projet", AGENT_DIR,
    ],
    { encoding: "utf8" },
  );
  let out = {};
  try {
    out = JSON.parse(res.stdout || "{}");
  } catch {
    /* handled below */
  }
  if (res.status === 2 && out.raison === "coffre-verrouille") {
    fail(`Vault locked. The _create-agent SKILL must follow _ensure-vault, then re-run this script.`);
  }
  if (res.status === 2 && out.raison === "cle-absente") {
    fail(`No OpenRouter management key. The _create-agent SKILL must follow _ensure-ai (one-time setup), then re-run this script.`);
  }
  if (res.status !== 0 || out.ok === false) {
    fail(`Could not create the agent key: ${out.message || res.stderr || `exit ${res.status}`}`);
  }
  state.agentKeyHash = out.hash ?? null;
  state.agentKeyCapUsd = out.plafondUsd ?? null;
  ok(`agent key created and capped at ${out.plafondUsd} $ (written to ${relative(REPO_ROOT, AGENT_DIR)}/.env)`);
  state.agentKeyRecorded = recordAgentKey(state.agentKeyHash);
}

/** The agent's key enters the project's manifest at once, as the site's key does: /delete-project
 *  revokes every ai-key the manifest holds. Unrecorded, the agent's key outlived its project,
 *  capped but watched by nobody (lot 6 bis, 05/10/2026). The hash is an identifier, never the key. */
function recordAgentKey(hash) {
  if (!hash) {
    warn("The agent's key came back without an identifier: it cannot be recorded, so revoke it by hand on openrouter.ai/settings/keys when the project is deleted.");
    return false;
  }
  const r = spawnSync(
    process.execPath,
    [
      join(__dirname, "manifest", "manifest.mjs"), "add",
      "--project-dir", REPO_ROOT,
      "--kind", "ai-key",
      "--name", `${opts.name}-agent`,
      "--field", "provider=openrouter",
      "--field", `hash=${hash}`,
      "--added-by", "_create-agent",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (r.status === 0) {
    ok("agent key recorded in the project's manifest: it will be revoked with the project");
    return true;
  }
  warn(`The agent's key could not be recorded in the project's manifest (${(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 160)}): record it with _track-resource (kind ai-key, field hash), or /delete-project will not revoke it.`);
  return false;
}

// ─── Step 2b - resolveModel (never hardcode a model generation) ──────
// A model id baked into this script goes stale every time a provider ships a
// generation, and scaffolds agents on a previous one without anyone noticing.
// The OpenRouter catalogue is the authoritative list, and it is read live at
// scaffold time. --model always wins; a network failure falls back.
const MODEL_FALLBACK = "anthropic/claude-sonnet-5.5";

async function resolveModel() {
  if (opts.model) {
    ok(`model: ${opts.model} (forced via --model)`);
    return;
  }
  try {
    const setup = join(__dirname, "ai", "ai-setup.mjs");
    // An agent reasons and calls tools over several turns: the quality tier is
    // the right default here, where a one-shot classification would not need it.
    const res = spawnSync(
      "node",
      [setup, "modeles", "--gamme", "qualite", "--limite", "1"],
      { encoding: "utf8" },
    );
    if (res.status !== 0) throw new Error(`exit ${res.status}`);
    const body = JSON.parse(res.stdout || "{}");
    const best = (body.modeles || [])[0];
    if (!best?.id) throw new Error("empty catalogue");
    opts.model = best.id;
    ok(`model: ${best.id} (top of the quality tier in the live catalogue)`);
  } catch (e) {
    opts.model = MODEL_FALLBACK;
    warn(`Could not read the model catalogue (${e.message}) - falling back to ${MODEL_FALLBACK}.`);
  }
}

// ─── Step 3 - ensureMonorepo ─────────────────────────────────────────
async function ensureMonorepo() {
  // Detect: workspace defined in pnpm-workspace.yaml AND apps/web exists?
  const wsFile = join(REPO_ROOT, "pnpm-workspace.yaml");
  const isMonorepo = existsSync(wsFile) && existsSync(join(REPO_ROOT, "apps", "web"));
  if (isMonorepo) {
    ok("Monorepo detected - apps/web/ ready");
    return;
  }
  // Not a monorepo. We can't convert from inside this script (the
  // _convert-to-turborepo SKILL is interactive). Bail with a clear status.
  fail(`Project is not yet a Turborepo monorepo. The _create-agent SKILL must invoke _convert-to-turborepo before re-running this script.`);
}

// ─── Step 4 - scaffoldAgent ──────────────────────────────────────────
async function scaffoldAgent() {
  mkdirSync(AGENT_DIR, { recursive: true });
  copyDirRecursive(TEMPLATE_DIR, AGENT_DIR, [
    // Don't copy the schema-snippet to apps/agent - it goes to the main schema (Step 9).
    "schema-snippet.ts",
    // Pages template: belongs to /add-agent-dashboard, not here.
    "pages",
  ]);

  // Variable substitution on text files
  const vars = {
    AGENT_NAME: opts.name,
    PROJECT_NAME: detectProjectName(),
    RENDER_SERVICE_NAME: renderServiceName(),
  };
  walkAndSubstitute(AGENT_DIR, vars);
  ok(`Scaffolded ${countFiles(AGENT_DIR)} files into apps/${opts.name}/`);
}

function copyDirRecursive(src, dst, exclude = []) {
  for (const entry of readdirSync(src)) {
    if (exclude.includes(entry)) continue;
    const sp = join(src, entry);
    const dp = join(dst, entry);
    if (statSync(sp).isDirectory()) {
      mkdirSync(dp, { recursive: true });
      copyDirRecursive(sp, dp, []);
    } else {
      copyFileSync(sp, dp);
    }
  }
}

function walkAndSubstitute(dir, vars) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { walkAndSubstitute(p, vars); continue; }
    if (!/\.(ts|tsx|js|json|yaml|yml|md|env)$/i.test(entry)) continue;
    let content = readFileSync(p, "utf8");
    let changed = false;
    for (const [k, v] of Object.entries(vars)) {
      const re = new RegExp(`\\{\\{${k}\\}\\}`, "g");
      if (re.test(content)) { content = content.replace(re, v); changed = true; }
    }
    if (changed) writeFileSync(p, content, "utf8");
  }
}

function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

function detectProjectName() {
  try {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return (root.name ?? "project").replace(/^@/, "").replace(/\//g, "-");
  } catch { return "project"; }
}

/** The agent's Render service carries the project's name, then the agent's: an agent's service
 *  named after the agent alone was invisible to /delete-project, which looks for the project's
 *  name, and kept running (and billing) after the project was gone (lot 6 bis, 05/10/2026). The
 *  root package.json of a converted project is "<project>-monorepo": the suffix is not the name. */
function renderServiceName() {
  const project = detectProjectName().replace(/-monorepo$/, "");
  return project === opts.name ? opts.name : `${project}-${opts.name}`;
}

// ─── Step 5 - patchSystemPrompt ──────────────────────────────────────
async function patchSystemPrompt() {
  if (!opts.systemPrompt) {
    warn("No --system-prompt provided - keeping the placeholder. Edit apps/" + opts.name + "/loop.ts later.");
    return;
  }
  const p = join(AGENT_DIR, "loop.ts");
  let content = readFileSync(p, "utf8");
  // Replace the multi-line template literal
  const escaped = opts.systemPrompt.replace(/`/g, "\\`").replace(/\$/g, "\\$");
  const re = /const TEMPLATE_SYSTEM_PROMPT = `[\s\S]*?`;/;
  if (!re.test(content)) fail("Could not locate TEMPLATE_SYSTEM_PROMPT in loop.ts");
  content = content.replace(re, `const TEMPLATE_SYSTEM_PROMPT = \`${escaped}\`;`);
  writeFileSync(p, content, "utf8");
  ok("System prompt injected into loop.ts");
}

// ─── Step 6 - patchAgentName ─────────────────────────────────────────
async function patchAgentName() {
  for (const file of ["loop.ts", "memory-kv.ts"]) {
    const p = join(AGENT_DIR, file);
    if (!existsSync(p)) continue;
    let content = readFileSync(p, "utf8");
    // Match TEMPLATE_AGENT_NAME = "..." or AGENT_NAME = "..."
    content = content
      .replace(/const TEMPLATE_AGENT_NAME = "[^"]*";/, `const TEMPLATE_AGENT_NAME = "${opts.name}";`)
      .replace(/const AGENT_NAME = "[^"]*";/, `const AGENT_NAME = "${opts.name}";`);
    writeFileSync(p, content, "utf8");
  }
  ok(`Agent slug "${opts.name}" set in loop.ts and memory-kv.ts`);
}

// ─── Step 6b - patchModel ────────────────────────────────────────────
// Without this the generated agent silently keeps the template's model while
// the handoff JSON reports the resolved one.
async function patchModel() {
  // The model lives in ai.ts, the worker's single door to the provider.
  const p = join(AGENT_DIR, "ai.ts");
  if (!existsSync(p)) {
    warn("ai.ts not found - model not patched");
    return;
  }
  const before = readFileSync(p, "utf8");
  const after = before.replace(
    /export const MODELE_AGENT = "[^"]*";/,
    `export const MODELE_AGENT = "${opts.model}";`,
  );
  if (after === before) {
    warn(`Could not find MODELE_AGENT in ai.ts - the agent may run on the template default instead of ${opts.model}`);
    return;
  }
  writeFileSync(p, after, "utf8");
  ok(`Model "${opts.model}" set in ai.ts`);
}

// ─── Step 7 - patchTools: keep the 3 default tools, and fence the two ─
// that let data out.
//
// The agent gets http_fetch (reads untrusted content), db_query (holds private
// data) and send_email (a way out). Those three together are what makes an
// indirect prompt injection worth attempting: a poisoned page tells the agent
// to mail the customer table somewhere. The system prompt asks it not to; these
// two lists mean it cannot.
//
// Written into render.yaml so they are visible where the agent is operated,
// and editable there without a redeploy of the scaffold.
async function patchTools() {
  const p = join(AGENT_DIR, "render.yaml");
  if (!existsSync(p)) {
    warn("render.yaml not found - allowlists not written; set AGENT_MAIL_ALLOWLIST and AGENT_FETCH_WRITE_HOSTS in the Render dashboard");
    return;
  }
  const before = readFileSync(p, "utf8");
  const bloc = [
    "      - key: AGENT_MAIL_ALLOWLIST",
    `        value: ${JSON.stringify(opts.mailAllowlist)}`,
    "      - key: AGENT_FETCH_WRITE_HOSTS",
    `        value: ${JSON.stringify(opts.fetchWriteHosts)}`,
  ].join("\n");
  if (before.includes("AGENT_MAIL_ALLOWLIST")) {
    ok("Allowlists already present in render.yaml");
  } else {
    const anchor = "    envVars:\n";
    if (!before.includes(anchor)) {
      warn("envVars block not found in render.yaml - set the two allowlists in the Render dashboard");
      return;
    }
    writeFileSync(p, before.replace(anchor, anchor + bloc + "\n"), "utf8");
  }
  ok(
    `Tools: http_fetch, send_email, db_query. Mail allowlist: ${
      opts.mailAllowlist || "(empty: sends nothing until set)"
    }. Write hosts: ${opts.fetchWriteHosts || "(empty: read-only)"}`,
  );
}

// ─── Step 8 - patchMemory ────────────────────────────────────────────
async function patchMemory() {
  const kvPath = join(AGENT_DIR, "memory-kv.ts");
  const vecPath = join(AGENT_DIR, "memory-pgvector.ts");

  if (opts.memory === "kv") {
    // Keep memory-kv.ts (already scaffolded), clear memory-pgvector.ts
    if (existsSync(vecPath)) {
      writeFileSync(vecPath, "// Vector memory not selected at scaffold time - use memory-kv instead, or re-run _create-agent with --memory pgvector.\nexport {};\n");
    }
    ok("Memory mode: KV (Postgres table agent_memory_kv)");
    return;
  }

  if (opts.memory === "pgvector") {
    // Vector memory uses Cloudflare Workers AI (model bge-large-en-v1.5, 1024
    // dims). We need:
    //   - CLOUDFLARE_API_TOKEN with the "Workers AI:Read" scope (validated below)
    //   - CLOUDFLARE_ACCOUNT_ID (extracted from the token via /accounts API)
    const cfToken = readUserEnv("CLOUDFLARE_API_TOKEN");
    if (!cfToken) {
      fail(`CLOUDFLARE_API_TOKEN missing. Vector memory uses Cloudflare Workers AI for embeddings, which needs this token (already configured by /start for most users - re-run /start if you skipped Cloudflare).`);
    }
    state.cfToken = cfToken;

    // The token goes in a request of this process, never on a command line (SECURITY.md; until
    // 3.3.5 it went to curl through a shell, readable by anything running on the machine).
    const cf = async (path, body) => {
      try {
        const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
          method: body ? "POST" : "GET",
          headers: { Authorization: `Bearer ${cfToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30000),
        });
        const text = await res.text();
        try {
          return { json: JSON.parse(text), text };
        } catch {
          return { json: null, text };
        }
      } catch (e) {
        return { json: null, text: String(e?.message || e) };
      }
    };

    // Resolve account ID
    log("Resolving Cloudflare account ID");
    const accountId = (await cf("/accounts")).json?.result?.[0]?.id ?? null;
    if (!accountId) {
      fail(`Could not resolve Cloudflare account ID from the token. Either the token is invalid or it lacks access to /accounts. Re-create at https://dash.cloudflare.com/profile/api-tokens with the scopes from /start checklist + add 'Workers AI:Read'.`);
    }
    state.cfAccountId = accountId;
    ok(`Cloudflare account ID resolved: ${accountId.slice(0, 8)}...`);

    // Smoke test: try a tiny embedding to confirm the token has Workers AI scope
    log("Verifying Workers AI scope on the token");
    const smoke = await cf(`/accounts/${accountId}/ai/run/@cf/baai/bge-large-en-v1.5`, { text: "test" });
    const smokeOk = !!smoke.json?.success && Array.isArray(smoke.json?.result?.data);
    if (!smokeOk) {
      fail(`Cloudflare Workers AI smoke test failed. Your token probably lacks the 'Workers AI:Read' scope. Regenerate at https://dash.cloudflare.com/profile/api-tokens and ADD that scope. Raw response: ${(smoke.text || "").slice(0, 300)}`);
    }
    ok("Workers AI scope confirmed on the token");

    // Run raw SQL: enable extension + create table + indexes
    const webPath = join(REPO_ROOT, opts.webDir);
    log("Enabling pgvector extension + creating agent_memory_vector table");
    const ddlScript = `import { neon } from "@neondatabase/serverless";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL not set");
const sql = neon(databaseUrl);
await sql\`CREATE EXTENSION IF NOT EXISTS vector\`;
await sql\`CREATE TABLE IF NOT EXISTS agent_memory_vector (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
)\`;
await sql\`CREATE INDEX IF NOT EXISTS agent_memory_vector_agent_idx ON agent_memory_vector(agent_name)\`;
await sql\`CREATE INDEX IF NOT EXISTS agent_memory_vector_embedding_idx ON agent_memory_vector USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)\`;
console.log("OK pgvector + agent_memory_vector ready");
`;
    const tmpScript = join(webPath, "_pgvector_init.mjs");
    writeFileSync(tmpScript, ddlScript);
    try {
      const r = run(`node _pgvector_init.mjs`, webPath, true);
      if (r.status !== 0) {
        warn(`pgvector init failed (exit ${r.status}). You may need to run the SQL manually. stderr: ${(r.stderr ?? "").slice(0, 300)}`);
      } else {
        ok("pgvector enabled + agent_memory_vector table created");
      }
    } finally {
      try { writeFileSync(tmpScript, ""); } catch {}
      try { rmSync(tmpScript, { force: true }); } catch {}
    }

    // Disable the kv module so nothing imports it
    if (existsSync(kvPath)) {
      writeFileSync(kvPath, "// Vector memory selected at scaffold time - use memory-pgvector instead.\nexport {};\n");
    }
    ok("Memory mode: vector (Cloudflare Workers AI embeddings + pgvector)");
    return;
  }

  // none → stateless
  if (existsSync(kvPath)) {
    writeFileSync(kvPath, "// Memory disabled at scaffold time - agent runs stateless.\nexport {};\n");
  }
  if (existsSync(vecPath)) {
    writeFileSync(vecPath, "// Memory disabled at scaffold time - agent runs stateless.\nexport {};\n");
  }
  ok("Memory mode: stateless");
}

// ─── Step 9 - mergeSchema ────────────────────────────────────────────
async function mergeSchema() {
  const mainSchema = join(REPO_ROOT, opts.webDir, "src/server/db/schema.ts");
  if (!existsSync(mainSchema)) {
    warn(`No main schema at ${mainSchema} - agent tables NOT added to the main app. The agent worker has its own schema.ts copy and will work, but the Next.js app won't have direct Drizzle access to agent_* tables.`);
    return;
  }
  const snippet = readFileSync(join(TEMPLATE_DIR, "schema-snippet.ts"), "utf8");
  const main = readFileSync(mainSchema, "utf8");
  // Idempotent: skip if already present
  if (main.includes("agent_invocations")) {
    ok("Agent tables already present in main schema - skipping");
    return;
  }
  // Append at end with a clear marker
  const marker = `\n\n// ─── Agent tables (added by _create-agent on ${new Date().toISOString().slice(0, 10)}) ───\n`;
  // Strip the snippet's imports - the main schema usually has its own
  const body = snippet
    .replace(/^[\s\S]*?(?=export const agentInvocations)/, "")  // strip header
    .trim();
  writeFileSync(mainSchema, main.trimEnd() + marker + body + "\n", "utf8");
  state.schemaPatched = true;
  ok("Agent tables appended to main schema");
}

// ─── Step 10 - installDeps ───────────────────────────────────────────
async function installDeps() {
  log("Running pnpm install (workspace) - this can take 30-60 s");
  run("pnpm install", REPO_ROOT);
  ok("Dependencies installed");
}

// ─── Step 11 - drizzlePush ───────────────────────────────────────────
async function drizzlePush() {
  if (!state.schemaPatched) {
    warn("Schema not patched - skipping drizzle push (run pnpm db:push manually if you wired it up).");
    return;
  }
  // The agent tables join an existing, populated database: say what the push
  // would destroy before running it (scripts/neon/schema-drift.mjs).
  const drift = await checkBeforeForcePush({ dir: join(REPO_ROOT, opts.webDir) });
  if (drift.status !== "safe") process.stderr.write(drift.text + "\n");
  if (drift.block) {
    warn(`Schema NOT pushed: the push would delete data the schema does not declare (listed above). Show it to the user, fix schema.ts, then run pnpm db:push from ${opts.webDir}.`);
    return;
  }
  log("Running pnpm db:push to create agent tables in Neon");
  // From the web app dir (where drizzle.config is)
  const r = run("pnpm db:push", join(REPO_ROOT, opts.webDir), true);
  if (r.status !== 0) {
    warn(`db:push failed (exit ${r.status}). Run manually from ${opts.webDir}.`);
    if (r.stderr) process.stderr.write(r.stderr.slice(0, 500) + "\n");
  } else {
    ok("Agent tables created in Neon");
  }
}

// ─── Step 12 - handoff ───────────────────────────────────────────────
async function handoff() {
  ok("Pipeline complete. Returning structured handoff to Claude.");
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("resolveModel", resolveModel);
await step("ensureMonorepo", ensureMonorepo);
await step("scaffoldAgent", scaffoldAgent);
// The key is minted AFTER the scaffold: it is written into the agent folder,
// which does not exist before.
await step("agentKey", agentKey);
await step("patchSystemPrompt", patchSystemPrompt);
await step("patchAgentName", patchAgentName);
await step("patchModel", patchModel);
await step("patchTools", patchTools);
await step("patchMemory", patchMemory);
await step("mergeSchema", mergeSchema);
await step("installDeps", installDeps);
await step("drizzlePush", drizzlePush);
await step("handoff", handoff);

dumpHandoff(true);

// Final JSON on stdout (Claude parses this for the user-facing summary)
process.stdout.write(JSON.stringify({
  success: true,
  agentName: opts.name,
  agentDir: relative(REPO_ROOT, AGENT_DIR),
  trigger: opts.trigger,
  memory: opts.memory,
  model: opts.model,
  schemaPatched: state.schemaPatched,
  // The name the Blueprint gives the service, and whether the agent's key is in the manifest.
  renderServiceName: renderServiceName(),
  agentKeyRecorded: state.agentKeyRecorded,
  warnings,
  nextSteps: {
    // By name: the Bash guardrail refuses a sweeping `git add .`. The root
    // files vary (lockfile, workspace, package.json): the skill reads
    // `git status --short` and completes the list.
    commit: `git add apps/${opts.name} <modified root files from git status> && git commit -m "feat(agent): scaffold ${opts.name} agent"`,
    push: "git push",
    renderSetup: [
      "Go to https://dashboard.render.com/blueprints",
      "Click 'New Blueprint Instance'",
      "Select your GitHub repo",
      "Render automatically detects apps/" + opts.name + "/render.yaml",
      "Fill in the env vars listed below",
      "Click 'Apply'",
    ],
    // Once the Blueprint is applied, _create-agent records the service in the project's manifest
    // (scripts/render/service.mjs find --record), so that /delete-project finds it by its
    // identifier and deletes it with the project.
    recordService: `once the Blueprint is applied: record the service ${renderServiceName()} in the project's manifest`,
    envVarsToSet: [
      `OPENROUTER_API_KEY (the agent's own capped key, already created and capped at ${state.agentKeyCapUsd} $; copy the value from apps/${opts.name}/.env)`,
      `AGENT_MAIL_ALLOWLIST (who this agent may email: addresses or @domains, comma separated${opts.mailAllowlist ? `; set to ${opts.mailAllowlist}` : "; EMPTY, so it cannot send anything yet"})`,
      `AGENT_FETCH_WRITE_HOSTS (hosts it may POST/PUT to${opts.fetchWriteHosts ? `; set to ${opts.fetchWriteHosts}` : "; empty, so it only reads"})`,
      "DATABASE_URL (from your web .env)",
      "BREVO_CLIENT_ID + BREVO_CLIENT_SECRET + BREVO_SENDER_EMAIL + BREVO_SENDER_NAME (or BREVO_API_KEY for a project that still holds a key made by hand, or RESEND_API_KEY)",
      "ADMIN_EMAIL (for agent error emails)",
      "AGENT_DAILY_BUDGET_USD (default 5)",
      "AGENT_MONTHLY_BUDGET_USD (default 50)",
      opts.trigger === "cron" ? "AGENT_CRON_SCHEDULE (e.g.: '0 7 * * *' for 7am every morning)" : null,
      opts.trigger === "cron" ? "AGENT_CRON_PROMPT (the prompt sent to the agent at each cron tick)" : null,
      opts.memory === "pgvector" ? "CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (for embeddings via Cloudflare Workers AI; nothing copies them for you)" : null,
    ].filter(Boolean),
  },
}) + "\n");
