#!/usr/bin/env node
// build-snapshot.mjs - Build a complete snapshot ZIP of a Hypervibe project.
//
// Usage:
//   node build-snapshot.mjs --project <name> [--project-dir <path>] [--out <dir>]
//                           [--skip-storage] [--skip-memory] [--skip-db]
//
// Produces <out>/<project>-snapshot-<YYYYMMDD-HHMMSS>.zip containing:
//   code/      - git bundle (--all) + package.json + CLAUDE.md + working-changes.patch (if dirty)
//   db/        - schema.json + per-table data .json
//   env/       - .env files pulled from Vercel (production / preview / development)
//                + env/local/: the project's own .env files (the only source once
//                a project has left Vercel)
//   storage/   - R2 bucket contents (global + EU jurisdictions)
//   memory/    - Claude memory files for this project
//   config/    - Vercel project link, wrangler.toml, Stripe webhook metadata (no secrets)
//   MANIFEST.md - human-readable description + restore notes
//
// Final stdout = JSON report. Exit 0 on success, 1 on fatal error.

import { manifestExistant } from "../manifest/locate.mjs";
import { spawnSpec } from "../_spawn.mjs";
import { zipDirectory } from "../_zip.mjs";
import { tokenMatches } from "../_match.mjs";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
  cpSync, statSync, readdirSync, unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

// --- Args ---
const args = process.argv.slice(2);
function arg(name, def = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
function flag(name) {
  return args.includes(name);
}

const PROJECT = arg("--project");
const PROJECT_DIR = resolve(arg("--project-dir") || process.cwd());
// Default output: the user's Downloads folder when it exists, a Dropbox
// download folder when that is what the machine has, the home folder
// otherwise. The old default (Dropbox/Download only) was the author's own
// setup and did not exist on other machines (reported on 3.1.5).
function defaultOutDir() {
  for (const c of [join(homedir(), "Downloads"), join(homedir(), "Dropbox", "Download")]) {
    if (existsSync(c)) return c;
  }
  return homedir();
}
const OUT_DIR = resolve(arg("--out") || defaultOutDir());
const SKIP_STORAGE = flag("--skip-storage");
const SKIP_MEMORY = flag("--skip-memory");
const SKIP_DB = flag("--skip-db");
const SKIP_ENV = flag("--skip-env");

if (!PROJECT) {
  console.error("Usage: node build-snapshot.mjs --project <name> [--project-dir <path>] [--out <dir>] [--skip-storage] [--skip-memory] [--skip-db] [--skip-env]");
  process.exit(1);
}

if (!existsSync(PROJECT_DIR)) {
  console.error(`Project dir not found: ${PROJECT_DIR}`);
  process.exit(1);
}

const NOW = new Date();
const TS = `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, "0")}${String(NOW.getDate()).padStart(2, "0")}-${String(NOW.getHours()).padStart(2, "0")}${String(NOW.getMinutes()).padStart(2, "0")}${String(NOW.getSeconds()).padStart(2, "0")}`;
const SNAP_NAME = `${PROJECT}-snapshot-${TS}`;
const WORK_DIR = join(tmpdir(), `hypervibe-snapshot-${Date.now()}`);
const SNAP_DIR = join(WORK_DIR, SNAP_NAME);

mkdirSync(SNAP_DIR, { recursive: true });

const steps = {};
function logStep(name, status, extra = {}) {
  steps[name] = { status, ...extra };
  process.stderr.write(`[${name}] ${status}${extra.error ? " - " + extra.error : ""}\n`);
}

// The final status is READ from the steps, never assumed. A snapshot whose
// R2 download came back `partial`, or whose DB dump errored, still produces a
// zip: the run did not crash, so the catch block at the bottom never fires.
// Announcing `ok` there hands the caller a full-success flag for an archive
// with holes, which is the one thing a backup must never do (seen in prod on
// 2026-09-08: `[r2-download] partial` next to `"status": "ok"`).
// `skipped` is deliberate (--skip-* or nothing to back up) and stays `ok`.
function overallStatus() {
  const incomplete = Object.entries(steps)
    .filter(([, s]) => s.status === "partial" || s.status === "error")
    .map(([step, s]) => ({
      step,
      status: s.status,
      ...(s.error ? { error: s.error } : {}),
      ...(s.missingObjects ? { missingObjects: s.missingObjects } : {}),
    }));
  return { status: incomplete.length > 0 ? "partial" : "ok", incomplete };
}

// Never `shell: true` with an argument array: the shell cuts a path at its
// first space, and the plugin's own scripts (dump-db.mjs) failed on a Windows
// profile like C:\Users\First Last (reported on 3.1.5). _spawn.mjs decides.
function run(cmd, argv, opts = {}) {
  const spec = spawnSpec(cmd, argv);
  return spawnSync(spec.file, spec.args, { encoding: "utf8", ...opts, shell: spec.shell });
}

function dirSize(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const sub = join(p, entry.name);
    if (entry.isDirectory()) total += dirSize(sub);
    else { try { total += statSync(sub).size; } catch {} }
  }
  return total;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ============================================================
// Step 1: git bundle (code + history + working changes)
// ============================================================
function stepGitBundle() {
  const codeDir = join(SNAP_DIR, "code");
  mkdirSync(codeDir, { recursive: true });

  const gitCheck = run("git", ["-C", PROJECT_DIR, "rev-parse", "--is-inside-work-tree"]);
  if (gitCheck.status !== 0) {
    logStep("git-bundle", "skipped", { reason: "not a git repo" });
    return;
  }

  const bundlePath = join(codeDir, "repo.bundle");
  const r = run("git", ["-C", PROJECT_DIR, "bundle", "create", bundlePath, "--all"]);
  if (r.status !== 0) {
    logStep("git-bundle", "error", { error: (r.stderr || r.stdout || "").slice(0, 300) });
    return;
  }

  // Capture working changes (uncommitted + untracked) as a patch
  const status = run("git", ["-C", PROJECT_DIR, "status", "--porcelain"]);
  const dirty = (status.stdout || "").trim().length > 0;
  let untrackedInfo = null;
  if (dirty) {
    const diff = run("git", ["-C", PROJECT_DIR, "diff", "HEAD"]);
    writeFileSync(join(codeDir, "working-changes.patch"), diff.stdout || "");
    // Also list untracked files (since git diff doesn't include them)...
    const untracked = run("git", ["-C", PROJECT_DIR, "ls-files", "--others", "--exclude-standard"]);
    writeFileSync(join(codeDir, "untracked-files.txt"), untracked.stdout || "");
    // ...and COPY them: a list is not a backup. A document written next to
    // the code and never committed was one deletion away from being lost
    // (reported on 3.1.5). Ignored files are never listed by git, so this
    // drags neither node_modules nor .next along.
    const files = (untracked.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const copied = [];
    const skipped = [];
    for (const rel of files) {
      const src = join(PROJECT_DIR, rel);
      try {
        const st = statSync(src);
        if (!st.isFile()) continue;
        if (st.size > 50 * 1024 * 1024) { skipped.push({ file: rel, reason: `${humanSize(st.size)} > 50 MB` }); continue; }
        const dest = join(codeDir, "untracked", rel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest);
        copied.push(rel);
      } catch (e) {
        skipped.push({ file: rel, reason: String(e).slice(0, 120) });
      }
    }
    untrackedInfo = { copied: copied.length, ...(skipped.length ? { skipped } : {}) };
  }

  // Copy a few top-level reference files
  for (const f of ["package.json", "CLAUDE.md", "README.md", ".gitignore"]) {
    const src = join(PROJECT_DIR, f);
    if (existsSync(src)) {
      try { cpSync(src, join(codeDir, f)); } catch {}
    }
  }

  const bundleSize = statSync(bundlePath).size;
  logStep("git-bundle", "ok", { bundleBytes: bundleSize, dirty, ...(untrackedInfo ? { untracked: untrackedInfo } : {}) });
}

// ============================================================
// Step 2: env vars (vercel env pull × 3 environments)
// ============================================================
function stepEnvVars() {
  if (SKIP_ENV) { logStep("env-vars", "skipped", { reason: "--skip-env" }); return; }

  const envDir = join(SNAP_DIR, "env");
  mkdirSync(envDir, { recursive: true });

  // Vercel first (its three environments), when the CLI is there and the
  // project is linked. Then the local .env files, ALWAYS: a project already
  // removed from Vercel has nothing left there while its .env holds every
  // variable, and a snapshot that said "ok" without them was a trap
  // (reported on 3.1.5).
  const results = [];
  const vCheck = run("vercel", ["--version"]);
  const linkPath = join(PROJECT_DIR, ".vercel", "project.json");
  if (vCheck.status !== 0) {
    results.push({ source: "vercel", ok: false, error: "vercel CLI not installed" });
  } else if (!existsSync(linkPath)) {
    results.push({ source: "vercel", ok: false, error: "project not linked (.vercel/project.json missing)" });
  } else {
    for (const env of ["production", "preview", "development"]) {
      const outPath = join(envDir, `${env}.env`);
      if (existsSync(outPath)) { try { unlinkSync(outPath); } catch {} }
      const r = run("vercel", ["env", "pull", outPath, `--environment=${env}`, "--yes"], { cwd: PROJECT_DIR });
      if (r.status === 0 && existsSync(outPath)) {
        // A secret comes back as KEY="": Vercel never gives its value. Such a line is not a
        // variable of the backup, and copied as a .env it would set the secret empty. It
        // leaves the file, and its name is written at the top of it and in the report.
        const kept = [];
        const unreadable = [];
        for (const line of readFileSync(outPath, "utf8").split(/\r?\n/)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
          if (m && /^(""|'')?$/.test(m[2].trim())) unreadable.push(m[1]);
          else kept.push(line);
        }
        const note = unreadable.length
          ? [`# Not given back by the host (secrets it never returns): ${unreadable.join(", ")}`, "# Their value is where the project keeps them: env/local/ for this machine's, the vault or the service's dashboard for production's.", ""]
          : [];
        writeFileSync(outPath, [...note, ...kept].join("\n"), "utf8");
        const lines = kept.filter((l) => l.trim() && !l.startsWith("#")).length;
        results.push({ source: "vercel", env, ok: true, vars: lines, ...(unreadable.length ? { unreadable } : {}) });
      } else {
        results.push({ source: "vercel", env, ok: false, error: (r.stderr || r.stdout || "").slice(0, 200) });
      }
    }
  }

  const localDir = join(envDir, "local");
  for (const dir of [PROJECT_DIR, join(PROJECT_DIR, "apps", "web")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/^\.env(\..+)?$/.test(name) || name.endsWith(".example") || name.endsWith(".sample")) continue;
      const rel = relative(PROJECT_DIR, join(dir, name)).split("\\").join("/") || name;
      const dest = join(localDir, rel);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(dir, name), dest);
        const lines = readFileSync(dest, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length;
        results.push({ source: "local", file: rel, ok: true, vars: lines });
      } catch (e) {
        results.push({ source: "local", file: rel, ok: false, error: String(e).slice(0, 200) });
      }
    }
  }

  const anyOk = results.some((r) => r.ok);
  logStep("env-vars", anyOk ? "ok" : "error", {
    sources: results,
    ...(anyOk ? {} : { error: "no variables from Vercel nor from a local .env file" }),
  });
}

// ============================================================
// Step 3: DB dump
// ============================================================
function stepDbDump() {
  if (SKIP_DB) { logStep("db-dump", "skipped", { reason: "--skip-db" }); return; }

  const dbDir = join(SNAP_DIR, "db");
  mkdirSync(dbDir, { recursive: true });

  // Find DATABASE_URL: prefer .env, fall back to env file we just pulled
  let connString = null;
  for (const envFile of [".env.local", ".env", "env/production.env"]) {
    const p = envFile.startsWith("env/") ? join(SNAP_DIR, envFile) : join(PROJECT_DIR, envFile);
    if (existsSync(p)) {
      const content = readFileSync(p, "utf8");
      const m = content.match(/^DATABASE_URL\s*=\s*"?(postgres[^"\r\n]+)"?/m);
      if (m) { connString = m[1].replace(/["']$/, ""); break; }
    }
  }
  if (!connString) {
    logStep("db-dump", "skipped", { reason: "DATABASE_URL not found in .env / .env.local / env/production.env" });
    return;
  }

  // The connection string reaches the child through its environment, never its arguments:
  // a process list is readable by anything running on the machine.
  const r = run(
    "node",
    [join(SCRIPT_DIR, "dump-db.mjs"), "--out-dir", dbDir, "--project-dir", PROJECT_DIR],
    { env: { ...process.env, DUMP_DB_CONN: connString } },
  );
  let payload = {};
  try {
    const lastLine = (r.stdout || "").trim().split("\n").pop();
    payload = JSON.parse(lastLine);
  } catch {
    payload = { status: "error", reason: "could not parse dump-db output" };
  }
  if (r.status !== 0 || payload.status === "error") {
    logStep("db-dump", "error", { error: payload.reason || (r.stderr || "").slice(0, 200) });
    return;
  }
  // A database that holds no table yet (its /add-db created it and nothing else) has nothing to
  // back up: a deliberate skip, which the run reports as such. The export tells it from tables its
  // role cannot see by the catalog (dump-db.mjs, emptyDatabase), never by the count alone.
  if ((payload.tableCount ?? 0) === 0 && payload.emptyDatabase === true) {
    logStep("db-dump", "skipped", { reason: "the database is reachable and holds no table yet: nothing to back up" });
    return;
  }
  // Loud failure: a DATABASE_URL was found, so finding no table means the dump
  // silently produced nothing. Never report that as a success.
  if ((payload.tableCount ?? 0) === 0) {
    logStep("db-dump", "error", {
      error: "database reachable but 0 table found - the snapshot would contain no data",
    });
    return;
  }
  // "partial" = some tables could not be read. Say it here, or the report calls a backup
  // with holes a success (same rule as the storage download below).
  if (payload.status === "partial") {
    logStep("db-dump", "partial", {
      driver: payload.driver,
      tableCount: payload.tableCount,
      totalRows: payload.totalRows,
      failedTables: payload.failedTables,
      error: payload.reason,
    });
    return;
  }
  logStep("db-dump", "ok", { driver: payload.driver, tableCount: payload.tableCount, totalRows: payload.totalRows });
}

// ============================================================
// Step 4: R2 download
// ============================================================
function stepR2Download() {
  if (SKIP_STORAGE) { logStep("r2-download", "skipped", { reason: "--skip-storage" }); return; }

  // No wrangler pre-check: download-r2 works from the .env R2 credentials via
  // the S3 API and only falls back to wrangler, so requiring the CLI here would
  // wrongly skip projects that have R2 but no wrangler.
  const storageDir = join(SNAP_DIR, "storage");
  mkdirSync(storageDir, { recursive: true });
  const r = run("node", [
    join(SCRIPT_DIR, "download-r2.mjs"),
    "--project", PROJECT,
    "--out-dir", storageDir,
    "--project-dir", PROJECT_DIR,
  ]);
  let payload = {};
  try {
    const lastLine = (r.stdout || "").trim().split("\n").pop();
    payload = JSON.parse(lastLine);
  } catch {
    payload = { status: "error", reason: "could not parse download-r2 output" };
  }
  // "skipped" = this project genuinely has no R2 storage configured.
  if (payload.status === "skipped") {
    logStep("r2-download", "skipped", { reason: payload.reason });
    return;
  }
  if (r.status !== 0 || payload.status === "error") {
    logStep("r2-download", "error", { error: payload.reason || (r.stderr || "").slice(0, 200) });
    return;
  }
  // « partial » = des objets manquent. Le dire ici, sinon le compte rendu
  // final annonce un succes complet pour une archive trouee.
  logStep("r2-download", payload.status === "partial" ? "partial" : "ok", {
    mode: payload.mode,
    bucketsScanned: payload.bucketsScanned,
    totalObjects: payload.totalObjects,
    totalSize: humanSize(payload.totalBytes || 0),
    ...(payload.status === "partial"
      ? {
          missingObjects: payload.missingObjects,
          missingList: "storage/_MANQUANTS.txt",
        }
      : {}),
  });
}

// ============================================================
// Step 5: Memory files
// ============================================================
function stepMemory() {
  if (SKIP_MEMORY) { logStep("memory", "skipped", { reason: "--skip-memory" }); return; }

  const memoryDir = join(SNAP_DIR, "memory");
  mkdirSync(memoryDir, { recursive: true });

  const claudeProjects = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjects)) {
    logStep("memory", "skipped", { reason: "~/.claude/projects not found" });
    return;
  }

  // Claude Code convention: ~/.claude/projects/<encoded-path>/ where the
  // absolute project path has its separators (/, \, :) AND dots replaced by
  // dashes. E.g. "C:\Code\my-project" -> "C--Code-my-project".
  // We normalize both sides the same way so a project like "my-project"
  // matches the encoded dir "C--Code-my-project".
  const normalize = (s) => s.toLowerCase().replace(/[.\\/:]/g, "-");
  const needle = normalize(PROJECT);

  // Note: modern Claude Code stores transcripts (.jsonl) and session metadata
  // directly in the project dir - not in a legacy "memory/" subdir. We copy
  // the whole project dir to capture everything that's there (transcripts,
  // memory files if they exist, session indexes, etc.).
  const dirs = readdirSync(claudeProjects);
  const matches = [];
  for (const d of dirs) {
    if (normalize(d).includes(needle)) {
      matches.push({ projectDir: d, srcDir: join(claudeProjects, d) });
    }
  }
  for (const m of matches) {
    const dest = join(memoryDir, m.projectDir);
    try { cpSync(m.srcDir, dest, { recursive: true }); } catch (e) {
      logStep("memory", "error", { error: e.message });
      return;
    }
  }

  // Also the memory files of OTHER Claude project dirs that mention this
  // project by name: a session opened on the parent folder (C:\dev) keeps
  // its memory there, and a snapshot that only looked at the project's own
  // dir missed it (reported on 3.1.5). Word-boundary match, the same rule
  // as the deletion inventory.
  const mentions = [];
  for (const d of dirs) {
    if (matches.some((m) => m.projectDir === d)) continue;
    const memDir = join(claudeProjects, d, "memory");
    if (!existsSync(memDir)) continue;
    let names = [];
    try { names = readdirSync(memDir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith(".md")) continue;
      const src = join(memDir, f);
      let text = "";
      try { text = readFileSync(src, "utf8"); } catch { continue; }
      if (!tokenMatches(PROJECT, f) && !tokenMatches(PROJECT, text)) continue;
      const dest = join(memoryDir, "_mentions", d, f);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest);
        mentions.push(`${d}/${f}`);
      } catch {}
    }
  }

  if (matches.length === 0 && mentions.length === 0) {
    logStep("memory", "skipped", { reason: `no Claude project dir matching "${needle}", and no memory file elsewhere mentions "${PROJECT}"` });
    return;
  }
  logStep("memory", "ok", { matchedDirs: matches.length, mentions: mentions.length, ...(mentions.length ? { mentionFiles: mentions } : {}) });
}

// ============================================================
// Step 6: Configs (Vercel project, wrangler.toml, Stripe webhooks metadata)
// ============================================================
function stepConfigs() {
  const configDir = join(SNAP_DIR, "config");
  mkdirSync(configDir, { recursive: true });
  const captured = {};

  // Resource manifest: the declared identities of everything the project owns
  // in the cloud. Already inside the git bundle, but a restore starts by
  // reading config/ - it belongs here in the clear.
  const manifestFile = manifestExistant(PROJECT_DIR);
  if (manifestFile && existsSync(manifestFile)) {
    cpSync(manifestFile, join(configDir, "resources.json"));
    captured.resourceManifest = true;
  }

  // Vercel project link
  const vercelLink = join(PROJECT_DIR, ".vercel", "project.json");
  if (existsSync(vercelLink)) {
    cpSync(vercelLink, join(configDir, "vercel-project.json"));
    captured.vercelLink = true;
  }

  // wrangler.toml at root or apps/worker
  for (const candidate of ["wrangler.toml", "apps/worker/wrangler.toml", "wrangler.jsonc"]) {
    const src = join(PROJECT_DIR, candidate);
    if (existsSync(src)) {
      const destName = candidate.replace(/\//g, "_");
      cpSync(src, join(configDir, destName));
      captured.wrangler = (captured.wrangler || []).concat(candidate);
    }
  }

  // render.yaml if present
  const renderYaml = join(PROJECT_DIR, "render.yaml");
  if (existsSync(renderYaml)) {
    cpSync(renderYaml, join(configDir, "render.yaml"));
    captured.render = true;
  }

  // Stripe webhooks (URLs + events only - NO secrets)
  const stripeCheck = run("stripe", ["--version"]);
  if (stripeCheck.status === 0) {
    const r = run("stripe", ["webhook_endpoints", "list", "--limit", "100"]);
    if (r.status === 0) {
      // The CLI outputs JSON when stdout is piped
      try {
        const out = r.stdout || "";
        // Some versions wrap output. Try parse line by line if not direct JSON.
        let endpoints = [];
        try {
          const parsed = JSON.parse(out);
          endpoints = parsed.data || parsed;
        } catch {
          // ignore
        }
        const sanitized = (Array.isArray(endpoints) ? endpoints : []).map(e => ({
          id: e.id,
          url: e.url,
          enabled_events: e.enabled_events,
          status: e.status,
          description: e.description,
          metadata: e.metadata,
        }));
        writeFileSync(join(configDir, "stripe-webhooks.json"), JSON.stringify(sanitized, null, 2));
        captured.stripeWebhooks = sanitized.length;
      } catch {}
    }
  }

  logStep("configs", "ok", captured);
}

// ============================================================
// Step 7: Write MANIFEST.md
// ============================================================
function writeManifest() {
  const sizes = {};
  for (const sub of ["code", "db", "env", "storage", "memory", "config"]) {
    sizes[sub] = humanSize(dirSize(join(SNAP_DIR, sub)));
  }

  const md = `# Snapshot - ${PROJECT}

**Date** : ${new Date().toISOString()}
**Source** : ${PROJECT_DIR}
**Outil** : Hypervibe / save-project

## Contenu

| Sous-dossier | Taille | Description |
|---|---|---|
| \`code/\` | ${sizes.code} | Git bundle complet (tout l'historique) + package.json + working-changes.patch si modifs non commitées + \`untracked/\` (les fichiers non suivis par git, copiés) |
| \`db/\` | ${sizes.db} | Schema (\`schema.json\`) + données JSON par table |
| \`env/\` | ${sizes.env} | Variables d'environnement pullées depuis Vercel (production / preview / development) et copie des fichiers \`.env\` locaux du projet (\`local/\`) |
| \`storage/\` | ${sizes.storage} | Contenu des buckets Cloudflare R2 (global + EU si présents) |
| \`memory/\` | ${sizes.memory} | Fichiers mémoire Claude du projet, et ceux d'autres dossiers Claude qui le mentionnent (\`_mentions/\`) |
| \`config/\` | ${sizes.config} | Snapshots Vercel/Wrangler/Render/Stripe (les webhook secrets NE sont PAS inclus) |

## Rapport d'exécution

\`\`\`json
${JSON.stringify(steps, null, 2)}
\`\`\`

## ⚠️ Sécurité

Ce snapshot contient des **secrets en clair** (clés API dans les fichiers \`env/*.env\`).
À traiter comme un fichier sensible :
- Pas de partage sur un canal non chiffré
- Pas de stockage sur un service public
- À déchiffrer / supprimer dès qu'il n'est plus utile

## Restauration

La restauration n'est pas automatisée. Pour reconstruire le projet manuellement :

1. **Code** : \`git clone code/repo.bundle <new-dir>\` puis \`pnpm install\`. Si \`working-changes.patch\` est présent, \`cd <new-dir> && git apply ../code/working-changes.patch\`.
2. **Variables d'env** : \`cp env/production.env <new-dir>/.env\` (ou \`env/local/.env\` si Vercel n'a rien rendu). ⚠️ Vercel ne rend jamais la valeur d'un secret : leurs noms sont en tête de chaque \`env/<environnement>.env\`, sans valeur. Celle du poste est dans \`env/local/\`, celle de production là où le projet la garde (coffre, tableau de bord du service). Pour Vercel : la skill \`/_push-env-vars\` d'Hypervibe.
3. **DB** : créer une nouvelle base Neon, puis demander à Claude Code de générer un script de restauration qui lit \`db/schema.json\` et insère depuis les fichiers \`*.json\`.
4. **R2** : recréer les buckets via \`wrangler r2 bucket create\`, puis \`wrangler r2 object put\` pour chaque fichier de \`storage/\`.
5. **Webhooks Stripe** : recréer chaque webhook depuis \`config/stripe-webhooks.json\` via le dashboard Stripe (les secrets \`whsec_...\` sont nécessairement régénérés à la création).

En cas de doute, ouvrir Claude Code dans le dossier du snapshot et demander :
> *"Voici un snapshot Hypervibe d'un projet à restaurer. Lis le MANIFEST.md et guide-moi pas à pas."*
`;

  writeFileSync(join(SNAP_DIR, "MANIFEST.md"), md);
}

// ============================================================
// Step 8: Zip
// ============================================================
async function buildZip() {
  mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = join(OUT_DIR, `${SNAP_NAME}.zip`);
  // Plain Node (scripts/_zip.mjs): no python, no tar. On many Windows machines
  // `python` is only the Microsoft Store stub, and the snapshot used to fail
  // at this very last step (reported on 3.1.5).
  const info = await zipDirectory(SNAP_DIR, zipPath);
  return { zipPath, size: info.bytes, entries: info.entries };
}

// ============================================================
// Main
// ============================================================
try {
  stepGitBundle();
  stepEnvVars();
  stepDbDump();
  stepR2Download();
  stepMemory();
  stepConfigs();
  writeManifest();

  const zipInfo = await buildZip();

  // Cleanup work dir
  try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}

  const { status, incomplete } = overallStatus();

  console.log(JSON.stringify({
    status,
    project: PROJECT,
    zipPath: zipInfo.zipPath,
    zipSize: humanSize(zipInfo.size),
    timestamp: TS,
    ...(incomplete.length > 0 ? { incompleteSteps: incomplete } : {}),
    steps,
  }, null, 2));
} catch (e) {
  console.error(JSON.stringify({
    status: "error",
    reason: e.message,
    workDir: WORK_DIR,
    steps,
  }, null, 2));
  process.exit(1);
}
