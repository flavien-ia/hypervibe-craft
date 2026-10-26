#!/usr/bin/env node
// discover-resources.mjs - Phase 1 of /delete-project, all 17 scans in parallel.
//
// Usage:
//   node discover-resources.mjs --project <name> [--cloudflare-account-id <id>]
//
// Outputs a single JSON object to stdout with the full inventory of every
// piece of cloud infrastructure tied to the project, plus a list of detected
// third-party services (Sentry, PostHog, etc.) that the user needs to clean
// manually. The LLM consumes this JSON directly to build the Phase 2
// presentation + scope question.
//
// Design:
// - Every scan is fault-tolerant: a single failing API call (Render down,
//   Upstash CLI not installed, etc.) does NOT abort the discovery. The
//   corresponding section gets `{ error: "..." }` instead.
// - A service this machine has no account at (its key or file is not there),
//   and that nothing of the project points to, is not a failed scan: its
//   section gets `{ skipped: "..." }` (3.4.17, settleWithoutAccount).
// - No mutations are ever performed here - this script is pure read-only.
// - All scans run via Promise.all so total wall time = max(individual scan).

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSecret, sessionStatus } from "../vault/vault.mjs";
import { spawnSpec } from "../_spawn.mjs";
import { indexLinesFor } from "./_memory-index.mjs";
import { excludeShared, sharedIgnoredReason } from "./_shared-exclusion.mjs";
import { keepRules } from "./_keep-rules.mjs";
import { isSystemVar, isStripeVar, localGitState, projectPointers, readProjectFacts, readProviderKey, settleStripeWithoutKey, settleWithoutAccount } from "./_inventory-rules.mjs";
import { resolveNeonOrg, withOrg } from "../neon-org.mjs";
import { readLinkedProject, teamIdFromOrgId } from "../_vercel-auth.mjs";
import { vercelContext, listAllProjects, getProject, pickTargets } from "../_vercel-projects.mjs";
import { tokenMatches, tokenMatchCount, moreSpecificOwner, normalizeName } from "../_match.mjs";
import { manifestExistant } from "../manifest/locate.mjs";
import { matchOf, projectRepository } from "./_render-match.mjs";
import { cloudflareAll } from "./_cloudflare-pages.mjs";
import { githubRepositoryOf, sameRepository, settleGithubDeletion } from "./_github-repo.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, "..", "..");
const TEMPLATES_DIR = join(PLUGIN_ROOT, "templates", "delete-project");

// ─── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const PROJECT = arg("--project");
if (!PROJECT) {
  console.error("Usage: node discover-resources.mjs --project <name>");
  process.exit(1);
}
const PROJECT_LOWER = PROJECT.toLowerCase();
// Local project directory: passed by the skill (which detects it), else the
// current working directory. No hardcoded workspace root, so this works on any
// machine/OS (Mac, Windows, Linux).
const PROJECT_DIR = arg("--project-dir") || process.cwd();
let CF_ACCOUNT_ID = arg("--cloudflare-account-id") || process.env.CLOUDFLARE_ACCOUNT_ID || "";

// ─── env helpers ───────────────────────────────────────────────────────────
function readUserEnvSync(name) {
  const helper = join(PLUGIN_ROOT, "scripts", "_read-user-env.mjs");
  if (!existsSync(helper)) return process.env[name] || "";
  const r = spawnSync("node", [helper, name], { encoding: "utf8" });
  if (r.status !== 0) return process.env[name] || "";
  return (r.stdout || "").trim();
}
// Each key: the vault first, else this machine's environment. `absent` when the vault answered
// that it holds no such key and no variable holds one either: no account at that service on this
// machine (3.4.17, readProviderKey in _inventory-rules.mjs). A vault that is closed, or whose read
// failed, never makes a key absent.
const readEnvValue = (name) => readUserEnvSync(name) || process.env[name] || "";
const CLOUDFLARE_KEY = readProviderKey({ item: "CLOUDFLARE", field: "api_token", envNames: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"] }, { getSecret, readEnv: readEnvValue });
const NEON_KEY = readProviderKey({ item: "NEON", field: "api_key", envNames: ["NEON_API_KEY"] }, { getSecret, readEnv: readEnvValue });
// The vault first: `_setup-render` stores the key there (item RENDER, field
// api_key), and reading the env var alone reported "missing" to every user
// who had followed it, so their Render services were never inventoried.
const RENDER_KEY = readProviderKey({ item: "RENDER", field: "api_key", envNames: ["RENDER_API_KEY"] }, { getSecret, readEnv: readEnvValue });
const CLOUDFLARE_API_TOKEN = CLOUDFLARE_KEY.value;
const NEON_API_KEY = NEON_KEY.value;
const RENDER_API_KEY = RENDER_KEY.value;
/** Marks a section whose key is absent from this machine: settled at the end (settleWithoutAccount). */
const noAccountIf = (key) => (key.absent ? { noAccount: true } : {});
const STRIPE_SECRET_KEY = readUserEnvSync("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY || "";

// "NEON_API_KEY missing" read as "the key is not there" when the vault was
// merely locked or expired: the key exists, the vault is asleep (reported on
// 3.1.5). Say which of the two it is, and what to do.
const VAULT_STATUS = (() => { try { return sessionStatus(); } catch { return "unknown"; } })();
function missingKey(name) {
  if (VAULT_STATUS !== "unlocked") {
    return `${name} unavailable: the vault is ${VAULT_STATUS} (unlock it with _ensure-vault, then run the inventory again)`;
  }
  return `${name} missing`;
}

// An inventory is never built on a sleeping vault. With the vault locked or
// expired and no key anywhere else, every cloud section came back "unknown":
// ten seconds of scan, a scope nobody could validate, a second scan after the
// unlock (seen on 29/09/2026). Refused at once instead, with the vault's own
// exit codes (2 locked, 3 expired) and nothing written on the standard output.
// Someone who keeps their keys in environment variables has no vault to open:
// as soon as one key is readable that way, the scan runs as before, and each
// section that lacks its key says so.
if ((VAULT_STATUS === "locked" || VAULT_STATUS === "expired") && !CLOUDFLARE_API_TOKEN && !NEON_API_KEY && !RENDER_API_KEY) {
  console.error(
    `Refused: the vault is ${VAULT_STATUS}, and no provider key is readable without it. No inventory was written.\n` +
      "Unlock the vault (_ensure-vault), then run the inventory again.",
  );
  process.exit(VAULT_STATUS === "expired" ? 3 : 2);
}

// ─── shared HTTP helper ────────────────────────────────────────────────────
async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    return { __error: `HTTP ${res.status}`, body: await res.text().catch(() => "") };
  }
  return res.json();
}

function runCmd(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    // Never an argument array under `shell: true`: a path with a space is cut
    // in two (reported on 3.1.5). _spawn.mjs decides how each command runs.
    const spec = spawnSpec(cmd, args);
    const proc = spawn(spec.file, spec.args, { ...opts, shell: spec.shell });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
  });
}

// ─── 1. Vercel ─────────────────────────────────────────────────────────────
// Every project of the account, in every scope, all pages (_vercel-projects.mjs:
// REST first, the CLI with an explicit --scope when the token is refused).
// Each target is designated by its id AND its team: the deletion once ran on a
// bare name, in whatever team the CLI was set to, and missed a project living
// in the account's other team (2026-09-17). The folder's link wins over the
// name; several projects answering to the name are a choice for the user
// (`ambiguous`), never for this script.
let vercelCtx = null;
async function scanVercel() {
  try {
    vercelCtx = vercelContext();
    const link = readLinkedProject(PROJECT_DIR);
    const linkTeam = link ? teamIdFromOrgId(link.orgId) : null;
    const listing = await listAllProjects(vercelCtx, { extraTeamIds: linkTeam ? [linkTeam] : [] });
    if (!listing.ok) {
      return {
        found: false,
        names: [],
        projects: [],
        error: listing.reason,
        ...(link ? { linked: { ...link, status: "unknown" } } : {}),
        // No token anywhere on this machine (no VERCEL_TOKEN, no sign-in of the CLI): no account
        // here. A token that was refused is not that.
        ...(vercelCtx.token ? {} : { noAccount: true }),
      };
    }
    let linked = null;
    if (link) {
      const listed = listing.projects.find((p) => p.id === link.projectId);
      const probe = listed
        ? { status: "found", project: listed }
        : await getProject(vercelCtx, { id: link.projectId, teamId: linkTeam, personal: !linkTeam });
      linked = { ...link, status: probe.status, project: probe.project, reason: probe.reason };
    }
    const pick = pickTargets({ name: PROJECT_LOWER, linked, projects: listing.projects });
    const warnings = [...listing.errors, ...(listing.partialReason ? [listing.partialReason] : [])];
    return {
      found: pick.targets.length > 0,
      projects: pick.targets,
      ambiguous: pick.ambiguous,
      ...(pick.nameMismatch ? { nameMismatch: true } : {}),
      ...(pick.homonyms.length ? { homonyms: pick.homonyms } : {}),
      ...(linked
        ? {
            linked: {
              projectId: linked.projectId,
              orgId: linked.orgId,
              projectName: linked.projectName,
              status: linked.status,
              ...(linked.reason ? { reason: linked.reason } : {}),
            },
          }
        : {}),
      // Every project name of the account: the ownership pass reads them.
      names: [...new Set(listing.projects.map((p) => normalizeName(p.name)))],
      source: listing.via,
      ...(listing.partial ? { partial: true } : {}),
      ...(listing.restFallbackReason ? { restFallbackReason: listing.restFallbackReason } : {}),
      ...(warnings.length ? { warning: warnings.join(" | ") } : {}),
    };
  } catch (e) {
    return { found: false, names: [], projects: [], error: String(e) };
  }
}

// ─── 2. Neon (REST API, not MCP - script context) ──────────────────────────
async function scanNeon() {
  if (!NEON_API_KEY) return { found: false, error: missingKey("NEON_API_KEY"), ...noAccountIf(NEON_KEY) };
  try {
    // Neon scopes this search to ONE organisation and silently falls back to the
    // account's default. Searching the wrong one answers "nothing to delete", which
    // here means resources are left behind believing they were never there.
    const org = await resolveNeonOrg(NEON_API_KEY, (item, field) => {
      try { return getSecret(item, field) || ""; } catch { return ""; }
    });
    const url = withOrg(
      `https://console.neon.tech/api/v2/projects?search=${encodeURIComponent(PROJECT)}`,
      org.orgId,
    );
    const data = await httpJson(url, { headers: { Authorization: `Bearer ${NEON_API_KEY}` } });
    if (data.__error) return { found: false, error: data.__error };
    // allNames feeds the ownership post-pass: the ?search= response also
    // returns sibling projects (searching "street" returns "street-cool").
    const allNames = (data.projects || []).map((p) => p.name);
    const projects = (data.projects || []).filter((p) => tokenMatches(PROJECT_LOWER, p.name));
    if (projects.length === 0) return { found: false, allNames };
    return {
      found: true,
      allNames,
      projects: projects.map((p) => ({ id: p.id, name: p.name, region: p.region_id, createdAt: p.created_at })),
    };
  } catch (e) {
    return { found: false, error: String(e) };
  }
}

// ─── 3. Cloudflare Workers ─────────────────────────────────────────────────
async function scanWorkers() {
  if (!CLOUDFLARE_API_TOKEN) return { found: false, error: missingKey("CLOUDFLARE_API_TOKEN"), ...noAccountIf(CLOUDFLARE_KEY) };
  try {
    const data = await httpJson(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts`,
      { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } },
    );
    if (data.__error) return { found: false, error: data.__error };
    const workers = (data.result || []).filter((s) => tokenMatches(PROJECT_LOWER, s.id));
    return { found: workers.length > 0, workers: workers.map((w) => ({ id: w.id, modifiedOn: w.modified_on })) };
  } catch (e) {
    return { found: false, error: String(e) };
  }
}

// ─── 4. Cloudflare R2 (global + EU) ────────────────────────────────────────
// REST API, NOT `wrangler r2 bucket list`. Wrangler reads the token from the
// process ENV, but since the vault migration the token only lives in the
// CLOUDFLARE_API_TOKEN JS constant above - it was never passed to the spawn, so
// every wrangler call failed with "In a non-interactive environment, it's
// necessary to set a CLOUDFLARE_API_TOKEN…". The old `if (code !== 0) continue`
// swallowed that failure and scanR2 reported "no bucket" for EVERY project,
// leaving buckets orphaned (and billed) after /delete-project. Failures are now
// reported in `error` so Phase 2 can show them instead of claiming an empty result.
// The rest of the script already talks to the REST API directly; this aligns R2 with it.
async function scanR2() {
  if (!CLOUDFLARE_API_TOKEN) return { found: false, buckets: [], error: missingKey("CLOUDFLARE_API_TOKEN"), ...noAccountIf(CLOUDFLARE_KEY) };
  if (!CF_ACCOUNT_ID) return { found: false, buckets: [], error: "Cloudflare account id could not be resolved" };
  const buckets = [];
  const errors = [];
  // Both jurisdictions are separate namespaces: the SAME bucket name can exist
  // in global AND in eu simultaneously, so each hit is tagged with its own.
  for (const jurisdiction of ["global", "eu"]) {
    const headers = { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` };
    if (jurisdiction === "eu") headers["cf-r2-jurisdiction"] = "eu";
    let cursor = null;
    let pages = 0;
    try {
      do {
        pages++;
        // per_page defaults to 20 on this endpoint - always ask for the max.
        const url =
          `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets?per_page=1000` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const data = await httpJson(url, { headers });
        if (data.__error) {
          errors.push(`${jurisdiction}: ${data.__error}${data.body ? ` - ${data.body.slice(0, 200)}` : ""}`);
          break;
        }
        if (data.success === false) {
          errors.push(`${jurisdiction}: ${(data.errors || []).map((e) => e.message).join("; ") || "API returned success:false"}`);
          break;
        }
        for (const b of data?.result?.buckets || []) {
          if (tokenMatches(PROJECT_LOWER, b.name)) {
            buckets.push({ name: b.name, jurisdiction, createdAt: b.creation_date || null });
          }
        }
        cursor = data?.result_info?.cursor || null;
      } while (cursor && pages < 20);
    } catch (e) {
      errors.push(`${jurisdiction}: ${String(e)}`);
    }
  }
  // How much is actually inside: Phase 2 must be able to say "543 files, 84 MB"
  // before the user validates their destruction. One extra call per matched bucket.
  await Promise.all(
    buckets.map(async (b) => {
      const headers = { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` };
      if (b.jurisdiction === "eu") headers["cf-r2-jurisdiction"] = "eu";
      const usage = await httpJson(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${encodeURIComponent(b.name)}/usage`,
        { headers },
      );
      if (usage.__error || usage.success === false) return;
      b.objectCount = Number(usage?.result?.objectCount ?? 0);
      b.sizeBytes = Number(usage?.result?.payloadSize ?? 0);
    }),
  );
  return {
    found: buckets.length > 0,
    buckets,
    ...(errors.length ? { error: errors.join(" | ") } : {}),
  };
}

// ─── 5. Cloudflare DNS (all zones) ─────────────────────────────────────────
// Every zone and every record, page after page (_cloudflare-pages.mjs); a zone whose records
// could not be read is said in `error`, never taken for a zone without the project's records.
const cloudflareJson = (url) => httpJson(url, { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } });

async function scanDns() {
  if (!CLOUDFLARE_API_TOKEN) return { found: false, error: missingKey("CLOUDFLARE_API_TOKEN"), ...noAccountIf(CLOUDFLARE_KEY) };
  try {
    const listed = await cloudflareAll("/zones", 50, cloudflareJson);
    if (listed.error) return { found: false, error: listed.error };
    const zones = listed.items;
    const allRecords = [];
    const unread = [];
    await Promise.all(
      zones.map(async (z) => {
        const recs = await cloudflareAll(`/zones/${z.id}/dns_records`, 100, cloudflareJson);
        if (recs.error) unread.push(`${z.name}: ${recs.error}`);
        for (const r of recs.items) {
          const nameMatches = tokenMatches(PROJECT_LOWER, r.name);
          const contentMatches = tokenMatches(PROJECT_LOWER, r.content || "");
          if (nameMatches || contentMatches) {
            allRecords.push({
              zoneId: z.id,
              zoneName: z.name,
              recordId: r.id,
              type: r.type,
              name: r.name,
              content: r.content,
            });
          }
        }
      }),
    );
    return { found: allRecords.length > 0, records: allRecords, zonesScanned: zones.length, ...(unread.length ? { error: `records not read in ${unread.join(" | ")}` } : {}) };
  } catch (e) {
    return { found: false, error: String(e) };
  }
}

// ─── 6. Scheduled Neon backups (unified hypervibe-jobs registry, with legacy
//        db-backup worker fallback) ─────────────────────────────────────────
// Unified: ~/.hypervibe-jobs/jobs.js holds a "neon-backups" job with a
// targets[] array. Legacy: ~/.db-backup-worker/wrangler.toml holds a
// BACKUP_TARGETS JSON env var. Both are reported with the same resource shape
// ({ isTarget, entry?, totalTargets?, error? }) plus a `source` field so
// downstream steps know which infrastructure holds the registration.
// Registry reader shared by the backup-targets scan (6) and the cron-pings
// scan (6b): ~/.hypervibe-jobs/jobs.js is a JS module whose default export is
// strict JSON.
function readUnifiedRegistry() {
  const jobsPath = join(homedir(), ".hypervibe-jobs", "jobs.js");
  if (!existsSync(jobsPath)) return { exists: false };
  try {
    const raw = readFileSync(jobsPath, "utf8");
    const m = raw.match(/export default\s*([\s\S]*?);?\s*$/);
    if (!m) return { exists: true, error: "jobs.js not parseable" };
    const registry = JSON.parse(m[1]);
    return { exists: true, jobs: Array.isArray(registry.jobs) ? registry.jobs : [] };
  } catch (e) {
    return { exists: true, error: String(e) };
  }
}

function readUnifiedBackupTargets() {
  const reg = readUnifiedRegistry();
  if (!reg.exists || reg.error) return reg;
  const job = reg.jobs.find((j) => j.name === "neon-backups");
  return { exists: true, targets: job && Array.isArray(job.targets) ? job.targets : [] };
}

function scanDbBackupLegacy() {
  const wranglerToml = join(homedir(), ".db-backup-worker", "wrangler.toml");
  if (!existsSync(wranglerToml)) return { isTarget: false, error: "wrangler.toml not found", source: "db-backup-worker" };
  try {
    const content = readFileSync(wranglerToml, "utf8");
    // Extract BACKUP_TARGETS JSON and find this project
    const targetsMatch = content.match(/BACKUP_TARGETS\s*=\s*'(\[[^']+\])'/);
    if (!targetsMatch) return { isTarget: false, error: "BACKUP_TARGETS not parseable", source: "db-backup-worker" };
    const targets = JSON.parse(targetsMatch[1]);
    const entry = targets.find((t) => t.name.toLowerCase() === PROJECT_LOWER);
    return entry
      ? { isTarget: true, entry, totalTargets: targets.length, source: "db-backup-worker" }
      : { isTarget: false, totalTargets: targets.length, source: "db-backup-worker" };
  } catch (e) {
    return { isTarget: false, error: String(e), source: "db-backup-worker" };
  }
}

async function scanDbBackup() {
  const unified = readUnifiedBackupTargets();
  if (unified.exists && !unified.error) {
    const entry = unified.targets.find((t) => (t.name || "").toLowerCase() === PROJECT_LOWER);
    if (entry) return { isTarget: true, entry, totalTargets: unified.targets.length, source: "hypervibe-jobs" };
    // Not in the unified registry: still check the legacy worker (setups not
    // yet migrated may hold the registration there).
    const legacy = scanDbBackupLegacy();
    if (legacy.isTarget) return legacy;
    return { isTarget: false, totalTargets: unified.targets.length, source: "hypervibe-jobs" };
  }
  // Neither the shared worker's registry nor the legacy worker on this machine: no backup was set
  // up here (3.4.17), said as such and settled at the end (settleWithoutAccount). A registry that
  // is there but cannot be read is not that: its error stays.
  const legacy = scanDbBackupLegacy();
  const noLegacyWorker = !existsSync(join(homedir(), ".db-backup-worker", "wrangler.toml"));
  return !unified.exists && noLegacyWorker ? { ...legacy, noAccount: true } : legacy;
}

// ─── 6b. Scheduled cron pings (unified hypervibe-jobs registry) ─────────────
// Ping jobs registered by /add-cron live in the same registry and keep hitting
// <app-url>/api/cron/<task> after the app is gone. Match by the job's
// `project` field, NOT by its name: since 2026-07-05 registry names are
// composite (<project>-<task>). Older entries without a `project` field are
// caught via their per-project secret name (CRON_SECRET_<PROJECT>).
function scanCronPings() {
  const secretName = `CRON_SECRET_${PROJECT_LOWER.replace(/-/g, "_").toUpperCase()}`;
  const reg = readUnifiedRegistry();
  if (!reg.exists) return { found: false, source: "hypervibe-jobs" };
  if (reg.error) return { found: false, error: reg.error, source: "hypervibe-jobs" };
  const jobs = reg.jobs.filter(
    (j) =>
      j.kind === "ping" &&
      ((j.project || "").toLowerCase() === PROJECT_LOWER || j.secretName === secretName),
  );
  return {
    found: jobs.length > 0,
    jobs: jobs.map((j) => ({ name: j.name, cron: j.cron, url: j.url, secretName: j.secretName || null })),
    // Per-project worker secret, dropped by execute-deletions once no registry
    // job of the project remains.
    secretName,
    source: "hypervibe-jobs",
  };
}

// ─── 7. Render services ────────────────────────────────────────────────────
async function scanRender() {
  if (!RENDER_API_KEY) return { found: false, error: missingKey("RENDER_API_KEY"), ...noAccountIf(RENDER_KEY) };
  try {
    // Every page: an account with more than 100 services hid the rest (cursor pagination).
    const all = [];
    let cursor = null;
    for (let page = 0; page < 50; page += 1) {
      const data = await httpJson(`https://api.render.com/v1/services?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
        headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
      });
      if (data.__error) return { found: false, error: data.__error };
      const items = Array.isArray(data) ? data : data.services || [];
      for (const d of items) all.push(d.service || d);
      cursor = items.length ? items[items.length - 1].cursor : null;
      if (!cursor || items.length < 100) break;
    }
    // By its name, or by the repository it is built from: an agent's service named after the
    // agent alone is still the project's (scripts/delete-project/_render-match.mjs).
    const repository = projectRepository(PROJECT_DIR);
    const services = [];
    for (const s of all) {
      const how = matchOf(s, { projectLower: PROJECT_LOWER, repository, tokenMatches });
      if (how) services.push({ id: s.id, name: s.name, type: s.type, suspended: s.suspended, ...(how === "repository" ? { foundVia: "repository" } : {}) });
    }
    return { found: services.length > 0, services };
  } catch (e) {
    return { found: false, error: String(e) };
  }
}

// ─── 8. Stripe webhooks + products ─────────────────────────────────────────
async function scanStripe() {
  if (!STRIPE_SECRET_KEY) return { found: false, error: "STRIPE_SECRET_KEY missing" };
  const auth = Buffer.from(`${STRIPE_SECRET_KEY}:`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };
  try {
    const [webhooksData, productsData] = await Promise.all([
      httpJson("https://api.stripe.com/v1/webhook_endpoints?limit=100", { headers }),
      httpJson("https://api.stripe.com/v1/products?limit=100", { headers }),
    ]);
    const webhooks = ((webhooksData.data) || []).filter((w) => tokenMatches(PROJECT_LOWER, w.url || ""));
    const products = ((productsData.data) || []).filter((p) => tokenMatches(PROJECT_LOWER, p.name || ""));
    return {
      webhooksFound: webhooks.length > 0,
      webhooks: webhooks.map((w) => ({ id: w.id, url: w.url, status: w.status })),
      productsFound: products.length > 0,
      products: products.map((p) => ({ id: p.id, name: p.name, active: p.active })),
    };
  } catch (e) {
    return { webhooksFound: false, productsFound: false, error: String(e) };
  }
}

// ─── 9. Upstash (read ~/.upstash.json for creds) ───────────────────────────
async function scanUpstash() {
  const credsPath = join(homedir(), ".upstash.json");
  // No Upstash account on this machine: said as such, and settled at the end (settleWithoutAccount).
  if (!existsSync(credsPath)) return { found: false, error: "~/.upstash.json missing", noAccount: true };
  try {
    const creds = JSON.parse(readFileSync(credsPath, "utf8"));
    if (!creds.email || !creds.apiKey) return { found: false, error: "invalid creds file" };
    const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString("base64");
    const data = await httpJson("https://api.upstash.com/v2/redis/databases", {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (data.__error) return { found: false, error: data.__error };
    const dbs = (Array.isArray(data) ? data : []).filter((d) => tokenMatches(PROJECT_LOWER, d.database_name || ""));
    return { found: dbs.length > 0, databases: dbs.map((d) => ({ id: d.database_id, name: d.database_name })) };
  } catch (e) {
    return { found: false, error: String(e) };
  }
}

// ─── 10. Cloudflare Email Routing ──────────────────────────────────────────
async function scanEmailRouting() {
  if (!CLOUDFLARE_API_TOKEN) return { found: false, error: missingKey("CLOUDFLARE_API_TOKEN"), ...noAccountIf(CLOUDFLARE_KEY) };
  try {
    const listed = await cloudflareAll("/zones", 50, cloudflareJson);
    if (listed.error) return { found: false, error: listed.error };
    const zones = listed.items;
    const rules = [];
    const unread = [];
    await Promise.all(
      zones.map(async (z) => {
        // Cloudflare serves these rules 50 at a time, whatever size is asked.
        const data = await cloudflareAll(`/zones/${z.id}/email/routing/rules`, 50, cloudflareJson);
        if (data.error) unread.push(`${z.name}: ${data.error}`);
        for (const r of data.items) {
          const matchersStr = JSON.stringify(r.matchers || []);
          const actionsStr = JSON.stringify(r.actions || []);
          if (
            tokenMatches(PROJECT_LOWER, r.name || "") ||
            tokenMatches(PROJECT_LOWER, matchersStr) ||
            tokenMatches(PROJECT_LOWER, actionsStr)
          ) {
            rules.push({
              zoneId: z.id,
              zoneName: z.name,
              // `tag` is what execute-deletions.mjs removes the rule by; Cloudflare documents it
              // as replaced by `id` (both carried on 14/10/2026), so `id` stands in when it goes.
              tag: r.tag ?? r.id,
              name: r.name,
              matchers: r.matchers,
              actions: r.actions,
              enabled: r.enabled,
            });
          }
        }
      }),
    );
    return { found: rules.length > 0, rules, ...(unread.length ? { error: `routing rules not read in ${unread.join(" | ")}` } : {}) };
  } catch (e) {
    return { found: false, error: String(e) };
  }
}

// ─── 11. Env vars scan (Vercel + local .env) + third-party detection ───────
// The names (never the values) of the variables the site's production gave: what points to a
// service, for the settling at the end (readProjectFacts).
const PULLED_VAR_NAMES = new Set();
async function scanEnvVars(localDirPath) {
  const knownVarsPath = join(TEMPLATES_DIR, "known-env-vars.json");
  const servicesPath = join(TEMPLATES_DIR, "third-party-services.json");
  const knownVars = JSON.parse(readFileSync(knownVarsPath, "utf8")).vars;
  const knownSet = new Set(knownVars);
  // The person's own shared accounts first (~/.hypervibe/delete-project-keep.json): their
  // choice to keep one wins over the generic entry of the same service.
  const servicesList = [...keepRules(), ...JSON.parse(readFileSync(servicesPath, "utf8")).services];

  // Try to pull env vars from Vercel (production scope)
  let envVarNames = new Set();
  const sources = [];
  if (localDirPath && existsSync(localDirPath)) {
    const tempPath = join(localDirPath, ".env.delete-check");
    try {
      const r = await runCmd("vercel", ["env", "pull", ".env.delete-check", "--environment=production", "--yes"], { cwd: localDirPath });
      if (r.code === 0 && existsSync(tempPath)) {
        const content = readFileSync(tempPath, "utf8");
        for (const line of content.split("\n")) {
          const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
          if (m) {
            envVarNames.add(m[1]);
            PULLED_VAR_NAMES.add(m[1]);
          }
        }
        sources.push("vercel-production");
        unlinkSync(tempPath); // ALWAYS delete the temp file (contains secrets)
      }
    } catch (e) {
      // Ignore - fall back to local .env only
      if (existsSync(tempPath)) {
        try { unlinkSync(tempPath); } catch {}
      }
    }
    // Also parse local .env if present (might have stuff Vercel doesn't)
    const localEnv = join(localDirPath, ".env");
    if (existsSync(localEnv)) {
      const content = readFileSync(localEnv, "utf8");
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
        if (m) envVarNames.add(m[1]);
      }
      sources.push("local-.env");
    }
  }

  // Variables the host and the build tools inject by themselves are never a
  // service the project is connected to: set aside before the diff, by prefix
  // (the rule is in _inventory-rules.mjs).
  // Diff with whitelist
  const allVars = [...envVarNames].filter((v) => !isSystemVar(v)).sort();
  const unknown = allVars.filter((v) => !knownSet.has(v));

  // Match unknown vars against third-party services lookup
  const thirdParty = [];
  const matched = new Set();
  for (const svc of servicesList) {
    const re = new RegExp(svc.pattern);
    for (const v of unknown) {
      if (re.test(v) && !matched.has(v)) {
        matched.add(v);
        thirdParty.push({ envVar: v, ...svc });
      }
    }
  }
  // Anything left in unknown that didn't match a known service pattern
  const trulyUnknown = unknown.filter((v) => !matched.has(v));

  return {
    sources,
    allVarsCount: allVars.length,
    hypervibeStackCount: allVars.filter((v) => knownSet.has(v)).length,
    thirdPartyDetected: thirdParty,
    unknownUnclassified: trulyUnknown,
    // Special signal: AUTH_GOOGLE_ID present = OAuth Google client to clean manually
    hasGoogleOAuth: envVarNames.has("AUTH_GOOGLE_ID"),
    hasGitHubOAuth: envVarNames.has("AUTH_GITHUB_ID"),
    // The project references Stripe: read by the Stripe section below, to tell
    // "no Stripe here" from "its webhooks could not be listed".
    hasStripe: [...envVarNames].some(isStripeVar),
  };
}

// ─── 12. Local dir + package.json deps ─────────────────────────────────────
function scanLocalDir() {
  const path = PROJECT_DIR;
  if (!existsSync(path)) return { exists: false, path };
  const pkgJsonPath = join(path, "package.json");
  let deps = [];
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      deps = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ];
    } catch {}
  }
  // Where its code stands in git: what a deletion of the folder would take with it (3.4.16).
  let git;
  try {
    git = localGitState(path, spawnSync);
  } catch (e) {
    git = { repo: null, error: String(e?.message ?? e) };
  }
  return { exists: true, path, dependencies: deps, git };
}

// ─── 13. Memory files (Claude project memory) ──────────────────────────────
function scanMemory() {
  // Scan every Claude project memory dir (~/.claude/projects/*/memory) instead
  // of assuming a fixed workspace slug, so this works on any machine/OS. Each
  // match stores its full path so execute-deletions acts without re-deriving it.
  const projectsRoot = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsRoot)) return { files: [], scanned: 0 };
  const matches = [];
  let scanned = 0;
  try {
    for (const slug of readdirSync(projectsRoot)) {
      const memDir = join(projectsRoot, slug, "memory");
      if (!existsSync(memDir)) continue;
      let mdFiles;
      try { mdFiles = readdirSync(memDir).filter((f) => f.endsWith(".md")); } catch { continue; }
      for (const f of mdFiles) {
        scanned++;
        let content = "";
        try { content = readFileSync(join(memDir, f), "utf8"); } catch { continue; }
        // Word-boundary matching with _ normalized to -, so the memory slug
        // convention (project_street_cool.md) matches the project street-cool
        // without "street" claiming it.
        const fileMatch = tokenMatches(PROJECT_LOWER, f);
        const contentMentions = tokenMatchCount(PROJECT_LOWER, content);
        if (fileMatch || contentMentions > 0) {
          matches.push({
            filename: f,
            dir: memDir,
            path: join(memDir, f),
            isProjectSpecific: fileMatch,
            mentionsCount: contentMentions,
          });
        }
      }
    }
  } catch (e) {
    return { files: [], error: String(e) };
  }
  return { files: matches, scanned };
}

// ─── 14. GitHub repo ───────────────────────────────────────────────────────
// The repository the project's folder pushes to, a read that failed said as such (_github-repo.mjs).
async function scanGitHub() {
  return githubRepositoryOf({ projectDir: PROJECT_DIR, project: PROJECT, run: runCmd });
}

// ─── orchestrator ──────────────────────────────────────────────────────────
const startedAt = Date.now();
const local = scanLocalDir();
const memory = scanMemory();
const cronJobs = scanCronPings(); // sync (local file read), no need for the Promise.all batch

// Cloudflare account id: provided via --cloudflare-account-id / CLOUDFLARE_ACCOUNT_ID,
// otherwise auto-detected from the API token (first account on the token).
async function resolveCfAccountId() {
  if (CF_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) return;
  const data = await httpJson("https://api.cloudflare.com/client/v4/accounts", {
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
  });
  const id = data?.result?.[0]?.id;
  if (id) CF_ACCOUNT_ID = id;
}
await resolveCfAccountId();

const [
  vercel,
  neon,
  workers,
  r2,
  dns,
  dbBackup,
  render,
  stripe,
  upstash,
  emailRouting,
  envVars,
  github,
] = await Promise.all([
  scanVercel(),
  scanNeon(),
  scanWorkers(),
  scanR2(),
  scanDns(),
  scanDbBackup(),
  scanRender(),
  scanStripe(),
  scanUpstash(),
  scanEmailRouting(),
  scanEnvVars(local.exists ? local.path : null),
  scanGitHub(),
]);

// ─── ownership post-pass (precision guard) ─────────────────────────────────
// Word-boundary matching alone still confuses sibling projects sharing a
// prefix: deleting "street" must not sweep up "street-cool-db". Build the set
// of OTHER known project names (shared-worker registry, sibling directories,
// Neon + Vercel project lists) and re-attribute every matched resource to the
// most specific owner. Claimed items move to a per-section `excluded` array
// (reported to the user, never deleted). The shared background workers are
// excluded by name whatever the project is called.
function collectSiblingDirs() {
  const out = [];
  try {
    const parent = dirname(PROJECT_DIR);
    if (!parent || parent === PROJECT_DIR) return out;
    for (const e of readdirSync(parent, { withFileTypes: true })) {
      if (out.length >= 300) break;
      if (!e.isDirectory()) continue;
      const n = normalizeName(e.name);
      if (n === PROJECT_LOWER || !/^[a-z0-9][a-z0-9-]*$/.test(n)) continue;
      out.push(n);
    }
  } catch {}
  return out;
}

function collectRegistryProjects() {
  const reg = readUnifiedRegistry();
  if (!reg.exists || reg.error) return [];
  const out = [];
  for (const j of reg.jobs) {
    if (j.kind === "ping" && j.project) out.push(j.project);
    if (j.kind === "snapshot") for (const t of j.targets || []) if (t.name) out.push(t.name);
  }
  return out;
}

function readSharedWorkerNames() {
  const names = new Set(["hypervibe-jobs", "db-backup", "db-backup-worker", "quota-monitor"]);
  for (const dir of [".hypervibe-jobs", ".db-backup-worker"]) {
    try {
      const toml = readFileSync(join(homedir(), dir, "wrangler.toml"), "utf8");
      const m = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (m) names.add(m[1].toLowerCase());
    } catch {}
  }
  return names;
}

const ownerCandidates = [...new Set(
  [...collectRegistryProjects(), ...collectSiblingDirs(), ...(neon.allNames || []), ...(vercel.names || [])]
    .map(normalizeName)
    .filter((n) => n && n !== PROJECT_LOWER),
)];

function partitionOwned(items, stringsOf) {
  const kept = [];
  const excluded = [];
  for (const it of items || []) {
    const matched = stringsOf(it).filter((s) => s && tokenMatches(PROJECT_LOWER, s));
    // Keep when at least one matching string is NOT claimed by a more
    // specific project (a resource genuinely derived from this project).
    const unclaimed = matched.length === 0 || matched.some((s) => !moreSpecificOwner(PROJECT_LOWER, s, ownerCandidates));
    if (unclaimed) {
      kept.push(it);
    } else {
      excluded.push({ ...it, excludedReason: `belongs to project "${moreSpecificOwner(PROJECT_LOWER, matched[0], ownerCandidates)}"` });
    }
  }
  return { kept, excluded };
}

function applyOwnership(section, listKey, stringsOf, foundKey = "found") {
  if (!section || !Array.isArray(section[listKey])) return;
  const { kept, excluded } = partitionOwned(section[listKey], stringsOf);
  section[listKey] = kept;
  if (excluded.length) section.excluded = [...(section.excluded || []), ...excluded];
  section[foundKey] = kept.length > 0;
}

// Shared background workers are NEVER part of a project inventory, even when
// the project name overlaps ("hypervibe" vs "hypervibe-jobs").
if (workers && Array.isArray(workers.workers)) {
  const shared = readSharedWorkerNames();
  const kept = [];
  for (const w of workers.workers) {
    if (shared.has((w.id || "").toLowerCase())) {
      workers.excluded = [...(workers.excluded || []), { ...w, excludedReason: "shared Hypervibe infrastructure (never deleted here)" }];
    } else {
      kept.push(w);
    }
  }
  workers.workers = kept;
  workers.found = kept.length > 0;
}

applyOwnership(neon, "projects", (p) => [p.name]);
applyOwnership(workers, "workers", (w) => [w.id]);
applyOwnership(r2, "buckets", (b) => [b.name]);
applyOwnership(dns, "records", (r) => [r.name, r.content]);
applyOwnership(emailRouting, "rules", (r) => [r.name, JSON.stringify(r.matchers || []), JSON.stringify(r.actions || [])]);
applyOwnership(render, "services", (s) => [s.name]);
applyOwnership(stripe, "webhooks", (w) => [w.url], "webhooksFound");
applyOwnership(stripe, "products", (p) => [p.name], "productsFound");
applyOwnership(upstash, "databases", (d) => [d.name]);

// Memory: a file whose name matches a MORE specific project is not ours.
if (memory && Array.isArray(memory.files)) {
  for (const f of memory.files) {
    const owner = f.isProjectSpecific ? moreSpecificOwner(PROJECT_LOWER, f.filename, ownerCandidates) : null;
    if (owner) {
      f.isProjectSpecific = false;
      f.note = `filename matches project "${owner}" better - left for review`;
    }
  }
  // The index lines the deletion will remove: those whose link points to a
  // file that will be deleted, and only those. Listed here so that the user
  // sees them before confirming, with everything else (outside review, 3.1.7).
  memory.indexLines = [];
  const byDir = new Map();
  for (const f of memory.files) {
    if (!f.isProjectSpecific || !f.dir) continue;
    if (!byDir.has(f.dir)) byDir.set(f.dir, []);
    byDir.get(f.dir).push(f.filename);
  }
  for (const [dir, names] of byDir) {
    const idx = join(dir, "MEMORY.md");
    if (!existsSync(idx)) continue;
    try {
      for (const line of indexLinesFor(readFileSync(idx, "utf8").split("\n"), names)) memory.indexLines.push({ dir, line });
    } catch {}
  }
}

// ─── Resource manifest reconciliation ──────────────────────────────────────
// `.hypervibe/resources.json` is written by the add-* skills at provisioning
// time: the DECLARED identities of what this project owns. The scans above
// filter by NAME similarity, so a declared resource named nothing like the
// project never even enters the inventory - it must be verified by its exact
// identifier and INJECTED. Conversely, a declared `shared` resource must
// never be offered for deletion, whatever its name matches.
async function existsHttp(url, headers) {
  try {
    const res = await fetch(url, { headers });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}
async function reconcileManifest() {
  let manifest = null;
  try {
    // Walk-up lookup, same rule as the writers: one manifest per repository,
    // at its root - being aimed one level below must not hide it.
    const fichier = manifestExistant(PROJECT_DIR);
    if (fichier) manifest = JSON.parse(readFileSync(fichier, "utf8"));
  } catch {
    /* unreadable: nothing declared */
  }
  if (!manifest || !Array.isArray(manifest.resources) || manifest.resources.length === 0) {
    return { found: false };
  }
  const out = {
    found: true,
    file: ".hypervibe/resources.json",
    // What each declared resource became: "seen-in-scan", "injected" (verified
    // by id and added to the inventory), "missing" (verified gone), "shared"
    // (excluded from deletion), "unverified" (no way to check - present the
    // declaration itself to the human).
    resources: [],
  };
  const mark = (arr, pred) => {
    const hit = (arr || []).find(pred);
    if (hit) {
      hit.declared = true;
      return true;
    }
    return false;
  };
  const cfHeaders = { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` };
  for (const r of manifest.resources) {
    const entry = { ...r };
    // A project's own registration on the shared clock marked shared by mistake stays in the
    // deletion (sharedIgnoredReason): the clock would otherwise keep working for a gone project.
    const ignored = sharedIgnoredReason(r, manifest.resources);
    if (ignored) entry.sharedIgnored = ignored;
    if (r.shared && !ignored) {
      entry.status = "shared";
      // A declared shared resource found by a name scan leaves the deletion
      // inventory, whatever its kind (only workers until 18/09/2026, five kinds
      // of thirteen until 3.2.6). Every section a sharing rule reads is handed
      // over: test-security-claims.mjs checks it against the rules themselves.
      excludeShared({ vercel, neon, workers, r2, dns, dbBackup, cronJobs, render, stripe, upstash, emailRouting, github }, r, { project: PROJECT_LOWER });
      out.resources.push(entry);
      continue;
    }
    let status = null;
    try {
      if (r.kind === "neon-project") {
        if (mark(neon && neon.projects, (p) => (r.id && p.id === r.id) || (r.name && p.name === r.name))) {
          status = "seen-in-scan";
        } else if (r.id && NEON_API_KEY) {
          const d = await httpJson(`https://console.neon.tech/api/v2/projects/${r.id}`, {
            headers: { Authorization: `Bearer ${NEON_API_KEY}` },
          });
          if (!d.__error && d.project) {
            (neon.projects ||= []).push({
              id: d.project.id,
              name: d.project.name,
              region: d.project.region_id,
              createdAt: d.project.created_at,
              declared: true,
              foundVia: "manifest",
            });
            neon.found = true;
            status = "injected";
          } else if (String(d.__error || "").includes("404")) {
            status = "missing";
          }
        }
      } else if (r.kind === "r2-bucket") {
        if (
          mark(
            r2 && r2.buckets,
            (b) =>
              b.name === r.name &&
              (b.jurisdiction || "global") === (r.jurisdiction === "eu" ? "eu" : "global"),
          )
        ) {
          status = "seen-in-scan";
        } else if (r.name && CLOUDFLARE_API_TOKEN && CF_ACCOUNT_ID) {
          const jur = r.jurisdiction === "eu" ? "eu" : "global";
          const h = jur === "eu" ? { ...cfHeaders, "cf-r2-jurisdiction": "eu" } : cfHeaders;
          const probe = await existsHttp(
            `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${encodeURIComponent(r.name)}`,
            h,
          );
          if (probe.ok) {
            (r2.buckets ||= []).push({ name: r.name, jurisdiction: jur, declared: true, foundVia: "manifest" });
            r2.found = true;
            status = "injected";
          } else if (probe.status === 404) {
            status = "missing";
          }
        }
      } else if (r.kind === "cf-worker") {
        if (mark(workers && workers.workers, (w) => (w.id || "").toLowerCase() === String(r.name || "").toLowerCase())) {
          status = "seen-in-scan";
        } else if (r.name && CLOUDFLARE_API_TOKEN && CF_ACCOUNT_ID) {
          const probe = await existsHttp(
            `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/services/${encodeURIComponent(r.name)}`,
            cfHeaders,
          );
          if (probe.ok) {
            (workers.workers ||= []).push({ id: r.name, declared: true, foundVia: "manifest" });
            workers.found = true;
            status = "injected";
          } else if (probe.status === 404) {
            status = "missing";
          }
        }
      } else if (r.kind === "render-service") {
        if (mark(render && render.services, (sv) => (r.id && sv.id === r.id) || (r.name && sv.name === r.name))) {
          status = "seen-in-scan";
        } else if (r.id && RENDER_API_KEY) {
          const d = await httpJson(`https://api.render.com/v1/services/${r.id}`, {
            headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
          });
          if (!d.__error && d.id) {
            (render.services ||= []).push({ id: d.id, name: d.name, type: d.type, declared: true, foundVia: "manifest" });
            render.found = true;
            status = "injected";
          } else if (String(d.__error || "").includes("404")) {
            status = "missing";
          }
        }
      } else if (r.kind === "stripe-webhook") {
        if (mark(stripe && stripe.webhooks, (w) => (r.id && w.id === r.id) || (r.name && w.url === r.name))) {
          status = "seen-in-scan";
        } else if (r.id && STRIPE_SECRET_KEY) {
          const d = await httpJson(`https://api.stripe.com/v1/webhook_endpoints/${r.id}`, {
            headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
          });
          if (!d.__error && d.id) {
            (stripe.webhooks ||= []).push({ id: d.id, url: d.url, declared: true, foundVia: "manifest" });
            stripe.webhooksFound = true;
            status = "injected";
          } else if (String(d.__error || "").includes("404")) {
            status = "missing";
          }
        }
      } else if (r.kind === "upstash-db") {
        if (mark(upstash && upstash.databases, (d) => (r.id && d.id === r.id) || (r.name && d.name === r.name))) {
          status = "seen-in-scan";
        }
      } else if (r.kind === "github-repo") {
        // The repository the folder pushes to, when the manifest names it: declared AND seen.
        if (sameRepository(github, r.name)) {
          github.declared = true;
          status = "seen-in-scan";
        }
      } else if (r.kind === "vercel-project") {
        // Declared by id and team: the identity that survives a folder without
        // its link (a fresh clone) and a monorepo whose apps are each linked.
        if (mark(vercel && vercel.projects, (p) => r.id && p.id === r.id)) {
          status = "seen-in-scan";
        } else if (r.id && vercelCtx && vercel && !vercel.error) {
          const teamId = teamIdFromOrgId(r.orgId);
          const probe = await getProject(vercelCtx, { id: r.id, teamId, personal: !teamId });
          if (probe.status === "found") {
            (vercel.projects ||= []).push({ ...probe.project, via: "manifest", declared: true, foundVia: "manifest" });
            vercel.found = true;
            status = "injected";
          } else if (probe.status === "missing") {
            status = "missing";
          }
        }
      }
    } catch (e) {
      entry.reconcileError = String(e);
    }
    entry.status = status || "unverified";
    out.resources.push(entry);
  }
  return out;
}
const manifestReport = await reconcileManifest();

// The repository /delete-project deletes itself: only the one /bootstrap created for this project
// and declared, which the folder pushes to; and whether gh has the right to, read now so that the
// person is asked before the execution (_github-repo.mjs).
await settleGithubDeletion(github, manifestReport?.resources ?? [], runCmd);

// What, in the project, points to each service: its variables (`.env`, `.env.local`, and the names
// the production gave), its packages, the files of a service, its manifest, in its folder and its
// workspaces (3.4.17, readProjectFacts in _inventory-rules.mjs). Read once, for the two rules below.
const manifestKinds = (manifestReport?.resources ?? []).map((r) => r.kind);
let projectFacts;
try {
  projectFacts = readProjectFacts(PROJECT_DIR, { pulledVarNames: [...PULLED_VAR_NAMES], manifestKinds });
} catch (e) {
  // Facts that could not be read are unknown: they point everywhere, and no section is settled.
  projectFacts = { varNames: [...PULLED_VAR_NAMES], dependencies: local.dependencies ?? [], manifestKinds, files: [], connections: [], unreadable: [`the project's folder (${String(e?.message ?? e).slice(0, 120)})`] };
}

// A project that has no Stripe is not a scan that failed: without a key, the
// section's `error` stays only when the project references Stripe (the rule,
// and why, in _inventory-rules.mjs).
if (stripe && !STRIPE_SECRET_KEY) {
  settleStripeWithoutKey(stripe, {
    hasStripeVar: envVars?.hasStripe === true || projectFacts.varNames.some(isStripeVar),
    dependencies: projectFacts.dependencies,
    manifestKinds,
  });
}

// A service this machine has no account at, that nothing of the project points to, is not a scan
// that failed either: the section is `skipped`, with its reason; the error stays as soon as
// something of the project points to the service (3.4.17; the rule, and why, in
// _inventory-rules.mjs). Without it, section 1.1 of the skill was out of reach on most machines.
settleWithoutAccount({ upstash, render, neon, vercel, workers, r2, dns, emailRouting, dbBackup }, projectPointers(projectFacts));

// Projects the manifest declares are this project's Vercel projects: a
// candidate found by its name alone is then a homonym (another team, a
// leftover), listed for the user and kept out of the deletion.
if (vercel && Array.isArray(vercel.projects) && vercel.projects.some((p) => p.declared)) {
  const trusted = (p) => p.declared || p.via !== "name";
  const guesses = vercel.projects.filter((p) => !trusted(p));
  if (guesses.length) vercel.homonyms = [...(vercel.homonyms || []), ...guesses];
  vercel.projects = vercel.projects.filter(trusted);
  vercel.ambiguous = false;
  vercel.found = vercel.projects.length > 0;
}

const elapsedMs = Date.now() - startedAt;

const report = {
  project: PROJECT,
  scannedAt: new Date().toISOString(),
  scanDurationMs: elapsedMs,
  cloudflareAccountId: CF_ACCOUNT_ID,
  // Sibling project names used for disambiguation; execute-deletions reuses
  // them when trimming MEMORY.md index lines.
  ownerCandidates,
  vercel,
  neon,
  workers,
  r2,
  dns,
  dbBackup,
  cronJobs,
  render,
  stripe,
  upstash,
  emailRouting,
  envVars,
  localDir: local,
  memory,
  github,
  manifest: manifestReport,
};

console.log(JSON.stringify(report, null, 2));
