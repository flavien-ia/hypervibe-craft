#!/usr/bin/env node
// Push environment variables to the local .env file AND to Vercel,
// targeting specific environments (production / preview / development).
//
// Usage:
//   node push-env-vars.mjs [--target=<env>[,<env>...]] KEY1=VALUE1 [KEY2=VALUE2 ...]
//   node push-env-vars.mjs [--target=...] --stdin      # KEY=VALUE lines on the standard input
//   node push-env-vars.mjs --remove KEY [KEY ...] [--target=...] [--no-local]
//   node push-env-vars.mjs --help
//
// An empty value is refused, and nothing is written: in a pipe, it is what a step that failed
// upstream sends. --allow-empty sets one on purpose.
//
// --stdin is for a value that is a secret whole (a database connection string): an
// argument can be read in the process list by anything running on the machine, the
// standard input cannot. Both forms can be mixed. To push again a value already in .env
// without it ever being typed or shown:
//   grep '^DATABASE_URL=' .env | node push-env-vars.mjs --stdin
// Each line on the standard input is read as the site's own loader reads a .env line
// (_env-line.mjs): KEY="abc" is abc, KEY=abc # note is abc. A raw value held by the shell goes
// through `printf '%s' "$VALUE" | node _env-line.mjs KEY` first, which quotes it when it has to;
// `printf 'KEY=%s\n'` straight is for a value the harness generated (hex, base64url). The local
// .env is written the same way: a value the site would read differently is quoted, and one no
// quoting can carry is refused before anything is written.
//
// --target options:
//   - omitted (default): writes to "production" + "preview" for sensitive vars,
//     or all three (incl. "development") for NEXT_PUBLIC_*. Existing entries in
//     other environments are NEVER touched.
//   - --target=preview              → writes only to preview (production untouched)
//   - --target=production           → writes only to production (preview untouched)
//   - --target=production,preview   → writes to those two envs
//   - --target=all                  → forces write to all three envs regardless of key prefix
//
// --no-local: the hosting only, the local .env left as it is.
//
// --remove KEY [KEY ...]: takes the variables OUT, names only, no value. Without --target, the
// line leaves the local .env (unless --no-local) and the variable leaves every environment of
// the hosting. With --target, only the named environments of the hosting lose it, and the local
// .env is left as it is. A variable that is not there counts as removed. It is the same tooled
// gesture as a push, for the day a variable must go: never `vercel env rm` by hand, one
// environment at a time.
//
// Non-destructive strategy: for each existing entry of the same key on Vercel,
//   * Full overlap with write targets → delete entirely (idempotent re-runs).
//   * No overlap                      → leave alone (preserves OTHER environments).
//   * Partial overlap                 → patch the entry to remove only the overlapping
//                                       targets, then create a new entry for write targets.
// This matters when pushing a different value to a single environment (e.g. a
// TEST tax rate to preview while keeping the LIVE tax rate in production).
//
// A hosting freezes its variables when a deployment is built: a value that replaces one the
// hosting already had, or a variable removed, only counts from the NEXT deployment. The last
// line says so when it applies.
//
// Exit codes:
//   0 = success (or partial success when Vercel isn't linked - local only)
//   1 = invalid args, or one or more Vercel pushes failed (details on stderr)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { loadAuthToken } from "./_vercel-auth.mjs";
import { vercelApiBase } from "./_vercel-projects.mjs";
import { dotenvExpands, dotenvLine, dotenvValue } from "./_env-line.mjs";

const USAGE = [
  "Usage:",
  "  node push-env-vars.mjs [--target=<env>[,<env>...]] [--no-local] [--allow-empty] KEY=VALUE [KEY=VALUE ...]",
  "  node push-env-vars.mjs [--target=...] [--no-local] --stdin        KEY=VALUE lines on the standard input",
  "  node push-env-vars.mjs --remove KEY [KEY ...] [--target=...] [--no-local]",
  "",
  "Options:",
  "  --target=<envs>   production, preview, development (comma-separated), or all.",
  "                    Default for a push: production + preview, plus development for NEXT_PUBLIC_*.",
  "                    Default for --remove: every environment, and the local .env.",
  "                    With --remove, naming environments leaves the local .env as it is.",
  "  --no-local        The hosting only: the local .env is left as it is.",
  "  --stdin           Read KEY=VALUE lines on the standard input (a secret never sits in an argument).",
  "  --allow-empty     Accept an empty value (refused otherwise).",
  "  --remove          Take the named variables out of the local .env and of the hosting.",
  "  --help, -h        This text.",
  "",
  "A value that replaces one the hosting already had, or a variable removed, counts from the next deployment.",
].join("\n");

// ─── Parse args ────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (rawArgs.length === 0) {
  console.error(
    "Usage: node push-env-vars.mjs [--target=<env>[,<env>...]] [--stdin] KEY=VALUE [KEY=VALUE ...]   (--help for everything)",
  );
  process.exit(1);
}

let readStdin = false;
// --no-local: the hosting only, the local .env left as it is. A live key must reach production
// without replacing the test key a developer's machine runs on (hosting inventory, 27/09/2026).
let noLocal = false;
let allowEmpty = false;
// --remove: every other bare word is then the NAME of a variable to take out.
const removeMode = rawArgs.includes("--remove");
const removeKeys = [];
const VALID_ENVS = ["production", "preview", "development"];
let explicitTargets = null; // null = smart per-key default
const pairs = [];

for (const arg of rawArgs) {
  if (arg === "--remove") continue;
  if (arg === "--stdin") {
    readStdin = true;
    continue;
  }
  if (arg === "--no-local") {
    noLocal = true;
    continue;
  }
  if (arg === "--allow-empty") {
    allowEmpty = true;
    continue;
  }
  if (arg.startsWith("--target=")) {
    const v = arg.slice("--target=".length);
    if (v === "all") {
      explicitTargets = [...VALID_ENVS];
      continue;
    }
    const envs = v.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = envs.filter((e) => !VALID_ENVS.includes(e));
    if (invalid.length || envs.length === 0) {
      console.error(
        `Invalid --target value: "${v}". Allowed: production, preview, development, all (comma-separated).`,
      );
      process.exit(1);
    }
    explicitTargets = envs;
    continue;
  }
  if (removeMode) {
    // Names only. A value here would be a push hidden in a removal: two different commands.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
      console.error(
        arg.includes("=")
          ? "Refused: --remove takes variable names, never KEY=VALUE. A removal and a push are two commands. Nothing was changed."
          : `Invalid variable name after --remove: ${arg}. Nothing was changed.`,
      );
      process.exit(1);
    }
    removeKeys.push(arg);
    continue;
  }
  const idx = arg.indexOf("=");
  if (idx <= 0) {
    console.error(`Invalid arg: ${arg} (expected KEY=VALUE with a non-empty key; --help says everything)`);
    process.exit(1);
  }
  pairs.push({ key: arg.slice(0, idx), value: arg.slice(idx + 1) });
}

if (removeMode && (readStdin || allowEmpty)) {
  console.error("Refused: --remove reads no value (--stdin and --allow-empty belong to a push). Nothing was changed.");
  process.exit(1);
}
if (removeMode && removeKeys.length === 0) {
  console.error("No variable name after --remove. Nothing was changed.");
  process.exit(1);
}

if (readStdin) {
  // One KEY=VALUE per line, its value read as the site's loader reads a .env line (quotes taken
  // off, a comment left out). A line that is not one is refused WITHOUT being echoed: it may be
  // half of a secret.
  const lines = readFileSync(0, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  for (const [n, line] of lines.entries()) {
    const idx = line.indexOf("=");
    if (idx <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, idx))) {
      console.error(`Invalid line ${n + 1} on the standard input (expected KEY=VALUE).`);
      process.exit(1);
    }
    // A `$name` the site's loader replaces with another variable's value: what the site reads
    // cannot be told from this line, and the text as it stands would give the hosting another
    // value than the site's own. Refused by its name, before anything is written (_env-line.mjs).
    if (dotenvExpands(line.slice(idx + 1))) {
      console.error(
        `Refused: ${line.slice(0, idx)}: its value holds a $ followed by a name, which the site's loader replaces with another variable's value. Nothing was written, neither the local .env nor the hosting. For a literal dollar, write \\$ in the .env line.`,
      );
      process.exit(1);
    }
    pairs.push({ key: line.slice(0, idx), value: dotenvValue(line.slice(idx + 1)) });
  }
}

if (!removeMode && pairs.length === 0) {
  console.error("No KEY=VALUE pairs provided.");
  process.exit(1);
}

// An empty value is refused unless asked for (--allow-empty). In a pipe, a step that fails
// upstream still sends its line, empty: `KEY=` replaced a production key with nothing and the
// push ended on a success (outside review, 3.3.2: /rotate-secret with a mistyped format,
// /add-stripe without its file of live keys). Refused before anything is written, the local
// .env included.
const emptyKeys = pairs.filter((p) => p.value.trim() === "").map((p) => p.key);
if (emptyKeys.length && !allowEmpty) {
  console.error(
    `Refused: ${emptyKeys.join(", ")} would be set to an empty value. Nothing was written, neither the local .env nor the hosting.`,
  );
  console.error(
    "In a pipe, an empty value is what a step that failed upstream sends: check that step. To really set an empty value, pass --allow-empty.",
  );
  process.exit(1);
}

// A value written into the local .env must come back unchanged when the site reads it: one no
// quoting can carry is refused here, by its name, before anything is written anywhere.
if (!noLocal && !removeMode) {
  try {
    for (const { key, value } of pairs) dotenvLine(key, value);
  } catch (e) {
    console.error(`Refused: ${e.message} Nothing was written, neither the local .env nor the hosting.`);
    process.exit(1);
  }
}

// ─── Step 1 - Update .env (unless --no-local) ──────────────────────────
// A removal narrowed by --target names environments of the HOSTING: the local .env is not one
// of them, and losing its line for "take it out of preview" would break the machine in silence.
const keepLocal = noLocal || (removeMode && explicitTargets !== null);
if (noLocal) console.log("[env] --no-local: the local .env is left as it is");
else if (keepLocal) console.log("[env] --remove with --target: only the hosting's named environments, the local .env is left as it is");
const envPath = ".env";
const existingContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const lines = existingContent.split("\n");

// The keys whose line leaves the file: replaced by a push, or taken out by --remove.
const keysToReplace = new Set(removeMode ? removeKeys : pairs.map((p) => p.key));
const filtered = lines.filter((line) => {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!m) return true;
  return !keysToReplace.has(m[1]);
});
const removedLocally = lines.length - filtered.length;

while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
  filtered.pop();
}

for (const { key, value } of pairs) {
  filtered.push(dotenvLine(key, value));
}

if (removeMode) {
  // A removal never creates a .env, and never rewrites one it has nothing to take out of.
  if (!keepLocal && removedLocally > 0) {
    writeFileSync(envPath, filtered.join("\n") + "\n");
    console.log(`[env] Removed ${removedLocally} line${removedLocally > 1 ? "s" : ""} from ${envPath}`);
  } else if (!keepLocal) {
    console.log(`[env] Nothing to remove from ${envPath}`);
  }
} else if (!noLocal) {
  writeFileSync(envPath, filtered.join("\n") + "\n");
  console.log(`[env] Updated ${envPath} (${pairs.length} var${pairs.length > 1 ? "s" : ""})`);
}

const gitignorePath = ".gitignore";
const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
const alreadyIgnored = gitignore.split("\n").some((l) => l.trim() === ".env");
if (!removeMode && !noLocal && !alreadyIgnored) {
  const suffix = gitignore.length === 0 || gitignore.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, gitignore + suffix + ".env\n");
  console.log(`[env] Added .env to .gitignore`);
}

// ─── Step 2 - Check if Vercel is linked ────────────────────────────────
const vercelProjectPath = ".vercel/project.json";
if (!existsSync(vercelProjectPath)) {
  console.log("[vercel] Project not linked (no .vercel/project.json). Skipping Vercel push.");
  if (keepLocal) {
    // Nothing was written anywhere: never a success.
    console.error(
      `Nothing ${removeMode ? "removed" : "written"}: the local .env is left as it is (${noLocal ? "--no-local" : "--remove with --target"}), and this folder is not linked to its hosting.`,
    );
    process.exit(1);
  }
  if (removeMode && removedLocally === 0) console.log(`ℹ️ Nothing removed: ${removeKeys.join(", ")} ${removeKeys.length > 1 ? "are" : "is"} not in the local .env, and this folder is not linked to a hosting.`);
  else if (removeMode) console.log(`✅ Removed ${removeKeys.length} env var${removeKeys.length > 1 ? "s" : ""} from the local .env only.`);
  else console.log(`✅ Pushed ${pairs.length} env var${pairs.length > 1 ? "s" : ""} to local .env only.`);
  process.exit(0);
}

const project = JSON.parse(readFileSync(vercelProjectPath, "utf8"));
const projectId = project.projectId;
const orgId = project.orgId; // Vercel team ID (null for personal accounts)

// ─── Step 3 - Try to load CLI auth token (for REST API) ────────────────
// Resolution lives in _vercel-auth.mjs, shared with scripts/vercel/check-deploy.mjs.
const token = loadAuthToken({ onWarn: (m) => console.log(`[vercel] ${m}`) });
// The real address, or the loopback one a recette aims at its fake API (nothing else is accepted).
const API = vercelApiBase();

// Vercel rejects "development" as a target for sensitive vars (local dev reads
// .env instead). So sensitive vars go to production + preview only by default;
// NEXT_PUBLIC_* and explicit --target overrides may include "development".
function targetsFor(key) {
  if (explicitTargets) return [...explicitTargets];
  return key.startsWith("NEXT_PUBLIC_") ? [...VALID_ENVS] : ["production", "preview"];
}
// A removal means everywhere, unless --target names some environments.
const removeTargets = () => (explicitTargets ? [...explicitTargets] : [...VALID_ENVS]);

// ─── Step 4a - REST API path ───────────────────────────────────────────
// Returns how many entries of the key the hosting ALREADY had in the write targets: what a push
// replaces (so the new value only counts from the next deployment), and what a removal takes out.
async function cleanupConflictsViaApi(key, writeTargets) {
  const teamQuery = orgId ? `?teamId=${orgId}` : "";
  const listRes = await fetch(
    `${API}/v10/projects/${projectId}/env${teamQuery}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listRes.ok) {
    throw new Error(`list env failed: HTTP ${listRes.status} ${await listRes.text()}`);
  }
  const data = await listRes.json();
  const matches = (data.envs || []).filter((e) => e.key === key);
  const writeSet = new Set(writeTargets);
  let touched = 0;

  for (const entry of matches) {
    const entryTargets = entry.target || [];
    const overlap = entryTargets.filter((t) => writeSet.has(t));

    if (overlap.length === 0) {
      // No conflict → leave alone (this preserves entries in other envs).
      continue;
    }
    touched += 1;

    if (overlap.length === entryTargets.length) {
      // Full overlap → delete entirely (idempotent re-run).
      const delUrl = `${API}/v9/projects/${projectId}/env/${entry.id}${teamQuery}`;
      const res = await fetch(delUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `delete env ${entry.id} failed: HTTP ${res.status} ${await res.text()}`,
        );
      }
      continue;
    }

    // Partial overlap → patch the entry to keep only the non-overlapping targets.
    const remainingTargets = entryTargets.filter((t) => !writeSet.has(t));
    const patchUrl = `${API}/v9/projects/${projectId}/env/${entry.id}${teamQuery}`;
    const res = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ target: remainingTargets }),
    });
    if (!res.ok) {
      throw new Error(
        `patch env ${entry.id} failed: HTTP ${res.status} ${await res.text()}`,
      );
    }
  }
  return touched;
}

// NEXT_PUBLIC_* vars are embedded in the client bundle by design, so
// marking them "sensitive" adds no real protection and blocks dashboard
// debugging. Everything else defaults to "sensitive" (opaque, unreadable
// after write) - matches Vercel's post-April-2026 hardening guidance.
function envType(key) {
  return key.startsWith("NEXT_PUBLIC_") ? "encrypted" : "sensitive";
}

async function addViaApi(key, value, writeTargets) {
  const teamQuery = orgId ? `?teamId=${orgId}` : "";
  const baseType = envType(key); // "sensitive" or "encrypted"

  // Vercel rejects type=sensitive for target=development with HTTP 400
  // ("You cannot set a Sensitive Environment Variable's target to development.").
  // When the caller asks for development on a would-be-sensitive var, split:
  //   - production/preview keep type=sensitive (opaque in dashboard)
  //   - development falls back to type=encrypted (visible in dashboard, but local
  //     dev reads .env anyway - Vercel's "development" target is only used by
  //     `vercel dev`, which is rare).
  const groups =
    baseType === "sensitive" && writeTargets.includes("development")
      ? [
          { targets: writeTargets.filter((t) => t !== "development"), type: "sensitive" },
          { targets: ["development"], type: "encrypted" },
        ].filter((g) => g.targets.length > 0)
      : [{ targets: writeTargets, type: baseType }];

  for (const { targets, type } of groups) {
    const res = await fetch(
      `${API}/v10/projects/${projectId}/env${teamQuery}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key,
          value,
          type,
          target: targets,
          gitBranch: null, // null = all preview branches
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${await res.text()}`);
    }
  }
}

async function pushViaApi(key, value, writeTargets) {
  const replaced = await cleanupConflictsViaApi(key, writeTargets);
  await addViaApi(key, value, writeTargets);
  return replaced > 0;
}

// ─── Retry helper for transient REST API errors ───────────────────────
//
// The Vercel API can return transient errors when:
//   - The project was just linked (404 - index not propagated yet)
//   - We hit rate limit (429)
//   - Their infra is having a momentary issue (502, 503, 504, 408)
//   - Network blip (ETIMEDOUT, ECONNRESET, …)
//
// Earlier the script gave up on the first REST error and fell back to the CLI,
// which often had the same transient issue (the CLI hits the same API). The
// retry loop with exponential backoff covers ~14s of total wait, which is
// enough for most fresh-project cases. If after 4 attempts it still fails, we
// fall back to CLI as the last resort.
const RETRY_BACKOFFS_MS = [0, 2000, 4000, 8000]; // attempt 1 immediate, then 2s/4s/8s

function isTransientError(err) {
  const msg = err?.message || "";
  if (/HTTP (404|408|429|502|503|504)/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed|network/i.test(msg))
    return true;
  return false;
}

/** Runs `fn` with the retries above, and returns what it returned. */
async function withRetry(fn, label) {
  let lastErr = null;
  for (let i = 0; i < RETRY_BACKOFFS_MS.length; i++) {
    if (RETRY_BACKOFFS_MS[i] > 0) {
      console.log(
        `[vercel] ${label}: retry ${i + 1}/${RETRY_BACKOFFS_MS.length} after ${RETRY_BACKOFFS_MS[i] / 1000}s…`,
      );
      await new Promise((r) => setTimeout(r, RETRY_BACKOFFS_MS[i]));
    }
    try {
      const result = await fn();
      if (i > 0) console.log(`[vercel] ${label}: succeeded on attempt ${i + 1}.`);
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err)) {
        // Non-retryable error (auth, bad request, …) - bail immediately.
        throw err;
      }
      const isLast = i === RETRY_BACKOFFS_MS.length - 1;
      console.log(
        `[vercel] ${label}: attempt ${i + 1}/${RETRY_BACKOFFS_MS.length} failed - ${err.message.slice(0, 120)}.${
          isLast ? " Giving up on REST API." : ""
        }`,
      );
    }
  }
  throw lastErr;
}

// Strip the Vercel CLI's `<claude-code-hint v="..." />` marker from captured
// output. Vercel prepends this marker on stderr in non-TTY contexts (subprocess
// captures); it's not a real error - but it pollutes our error messages when
// something else fails. Cosmetic cleanup.
function stripCliNoise(s) {
  return s
    .replace(/<claude-code-hint[^>]*\/>/g, "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\n\s*\n/g, "\n");
}

// ─── Step 4b - CLI fallback path ───────────────────────────────────────
// Note: we don't shell-escape values anymore - they're piped via stdin to
// `vercel env add` (which expects stdin since v48 dropped the `--value` flag).
// Only the env name needs shell-arg escaping.

function escapeArg(s) {
  if (platform() === "win32") return `"${s.replace(/"/g, '""')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function runVercel(cmdStr, stdinValue = null) {
  return new Promise((resolve) => {
    const child = spawn(cmdStr, {
      stdio: [stdinValue !== null ? "pipe" : "ignore", "pipe", "pipe"],
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
    if (stdinValue !== null) {
      child.stdin.write(stdinValue);
      child.stdin.end();
    }
  });
}

async function pushViaCli(key, value, writeTargets) {
  const k = escapeArg(key);
  // `--value` was removed/deprecated in Vercel CLI ~48 (seen with CLI 48.12.1
  // returning "Error: unknown or unexpected option: --value"). The canonical
  // way is to pipe the value via stdin (no shell escaping needed).
  const isPublic = key.startsWith("NEXT_PUBLIC_");
  let replaced = false;
  // Only touch the write-target environments. `vercel env rm` is a no-op if
  // the var doesn't exist, so we don't gate on existence.
  for (const env of writeTargets) {
    const rm = await runVercel(`vercel env rm ${k} ${env} --yes`);
    if (rm.code === 0) replaced = true;
    // For preview, the CLI has a quirk: it prompts for a git branch even with
    // a value piped in. Passing `""` as the 3rd positional arg means
    // "all preview branches".
    const branchArg = env === "preview" ? ' ""' : "";
    // Vercel rejects --sensitive on the development target (same restriction as
    // the REST API). For development, push as plain (encrypted) regardless of
    // the key's NEXT_PUBLIC prefix.
    const sensitiveFlag = !isPublic && env !== "development" ? " --sensitive" : "";
    const result = await runVercel(
      `vercel env add ${k} ${env}${branchArg}${sensitiveFlag}`,
      value,
    );
    if (result.code !== 0) {
      // Strip the Vercel CLI's `<claude-code-hint .../>` marker from output -
      // it's emitted on stderr in non-TTY contexts and is not part of the actual error.
      const detail = stripCliNoise(result.stderr || result.stdout || "") || `exit ${result.code}`;
      throw new Error(`vercel env add ${key} ${env}: ${detail}`);
    }
  }
  return replaced;
}

// A removal by the CLI: the same `vercel env rm` the push runs before it writes, one
// environment at a time. "Not found" is a variable that is already out: a success.
async function removeViaCli(key, targets) {
  const k = escapeArg(key);
  let removed = 0;
  for (const env of targets) {
    const rm = await runVercel(`vercel env rm ${k} ${env} --yes`);
    if (rm.code === 0) {
      removed += 1;
      continue;
    }
    const detail = stripCliNoise(rm.stderr || rm.stdout || "") || `exit ${rm.code}`;
    // The CLI's own words for a variable that is not there ("Environment Variable was not
    // found."). Nothing wider: "Project not found" is a failure, never a variable already out.
    if (/environment variable\b[^\n]*\bwas not found/i.test(detail)) continue;
    throw new Error(`vercel env rm ${key} ${env}: ${detail}`);
  }
  return removed;
}

// ─── Step 5 - Execute ──────────────────────────────────────────────────
const method = token ? "REST API" : "CLI fallback";
const results = [];
// What the hosting already had: a value replaced, or a variable removed. It only counts from
// the next deployment, and the last line says so.
const alreadyThere = new Set();
const failed = (key, targets, error) => {
  for (const env of targets) results.push({ key, env, ok: false, error });
};

if (removeMode) {
  console.log(`[vercel] Removing from Vercel via ${method}.`);
  for (const key of removeKeys) {
    const targets = removeTargets();
    let removed = null;
    try {
      removed = token ? await withRetry(() => cleanupConflictsViaApi(key, targets), key) : await removeViaCli(key, targets);
    } catch (err) {
      if (token) {
        console.log(`[vercel] REST API gave up for ${key} (${err.message.slice(0, 120)}). Falling back to CLI…`);
        try {
          removed = await removeViaCli(key, targets);
        } catch (cliErr) {
          failed(key, targets, cliErr.message);
        }
      } else {
        failed(key, targets, err.message);
      }
    }
    if (removed === null) continue;
    if (removed > 0) alreadyThere.add(key);
    for (const env of targets) results.push({ key, env, ok: true, absent: removed === 0 });
  }
} else {
  console.log(`[vercel] Pushing to Vercel via ${method}.`);
  for (const { key, value } of pairs) {
    const writeTargets = targetsFor(key);
    try {
      // REST API with retry-on-transient (covers fresh-project 404, 429 rate limits,
      // 502/503/504, network blips). ~14s total wait spread over 4 attempts.
      const replaced = token ? await withRetry(() => pushViaApi(key, value, writeTargets), key) : await pushViaCli(key, value, writeTargets);
      if (replaced) alreadyThere.add(key);
      for (const env of writeTargets) results.push({ key, env, ok: true });
    } catch (err) {
      // REST API exhausted retries (or non-transient error). Last-resort CLI fallback.
      if (token) {
        console.log(`[vercel] REST API gave up for ${key} (${err.message.slice(0, 120)}). Falling back to CLI…`);
        try {
          if (await pushViaCli(key, value, writeTargets)) alreadyThere.add(key);
          for (const env of writeTargets) results.push({ key, env, ok: true });
        } catch (cliErr) {
          failed(key, writeTargets, cliErr.message);
        }
      } else {
        failed(key, writeTargets, err.message);
      }
    }
  }
}

// ─── Step 6 - Report ───────────────────────────────────────────────────
console.log("");
const reported = removeMode ? removeKeys.map((key) => ({ key, targets: removeTargets() })) : pairs.map(({ key }) => ({ key, targets: targetsFor(key) }));
for (const { key, targets } of reported) {
  const statuses = targets
    .map((env) => {
      const r = results.find((x) => x.key === key && x.env === env);
      return r?.ok ? `${env}:✅` : `${env}:❌`;
    })
    .join("  ");
  const absent = removeMode && results.some((x) => x.key === key && x.ok && x.absent) ? "  (was not there)" : "";
  console.log(`  ${key}  ${statuses}${absent}`);
}

const failures = results.filter((r) => !r.ok);
if (failures.length > 0) {
  console.error("");
  console.error("Failures:");
  const seen = new Set();
  for (const f of failures) {
    const sig = `${f.key}|${f.error}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    console.error(`  ${f.key}: ${f.error}`);
  }
  // Never process.exit() right after a network call (it can abort Node on Windows): the code
  // is set, and the process ends by itself.
  process.exitCode = 1;
} else {
  console.log("");
  const targetSummary = explicitTargets
    ? explicitTargets.join(", ")
    : removeMode
      ? "every environment"
      : "smart per-key (production + preview, dev for NEXT_PUBLIC_*)";
  if (removeMode) {
    console.log(`✅ Removed ${removeKeys.length} env var${removeKeys.length > 1 ? "s" : ""} from ${keepLocal ? "" : ".env + "}Vercel (${targetSummary}).`);
  } else {
    console.log(`✅ Pushed ${pairs.length} env var${pairs.length > 1 ? "s" : ""} to ${noLocal ? "" : ".env + "}Vercel (${targetSummary}).`);
  }
  if (alreadyThere.size > 0) {
    console.log(
      removeMode
        ? `ℹ️ ${[...alreadyThere].join(", ")}: removed at the hosting. The deployment that is online keeps ${alreadyThere.size > 1 ? "them" : "it"} until the NEXT deployment.`
        : `ℹ️ ${[...alreadyThere].join(", ")}: the hosting already had a value. The new one is taken into account at the NEXT deployment; the one online keeps the old value until then.`,
    );
  }
}
