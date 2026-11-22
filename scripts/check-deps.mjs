#!/usr/bin/env node
// Check project dependencies (DB, email, auth, etc.) with robust heuristics.
//
// Usage:
//   node check-deps.mjs <check1> [<check2> ...] [--include-vercel]
//
// With --include-vercel : runs `vercel env pull` to fetch production env vars from Vercel
// and merges them into the local env map (Vercel values override local on conflict).
// Requires the Vercel CLI installed and the project linked (`.vercel/project.json` present).
// Slower (network call), so opt-in.
//
// Output:
//   JSON object on stdout, one key per check requested.
//   Exit code is always 0 - the result is in the JSON, not the exit code.
//
// Supported checks:
//   db           - is a real cloud DB wired up? (not a T3 placeholder / localhost default)
//   email        - is an email provider configured? (Resend or Brevo)
//   auth         - is NextAuth installed & configured? (detects admin vs users mode)
//   vercel       - is the project linked to Vercel? (.vercel/project.json present & valid)
//   github-repo  - is the project pushed to a GitHub remote?
//   i18n         - is next-intl installed? (for localized page generation)
//   stripe       - is Stripe configured? (STRIPE_SECRET_KEY non-placeholder)
//   storage      - is Cloudflare R2 configured? (R2_ACCOUNT_ID + R2_ACCESS_KEY_ID)
//   analytics    - is Google Analytics (GA4) configured? (NEXT_PUBLIC_GA_ID)
//   tests        - is the project equipped by /add-test? (vitest + docs/recette.md + checker)
//   cloudflare   - is the Cloudflare API token set and valid? (env var + live API verify)
//   dark-mode    - is next-themes installed AND ThemeProvider mounted in the root layout?
//
// Example:
//   node check-deps.mjs db email auth
//   → {"db":{"ok":true,...},"email":{"ok":false,...},"auth":{"ok":true,...}}

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { readUserEnv } from "./_read-user-env.mjs";

const args = process.argv.slice(2);
const checks = [];
let includeVercel = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--include-vercel") {
    includeVercel = true;
  } else if (args[i].startsWith("--")) {
    console.error(`Unknown flag: ${args[i]}`);
    process.exit(1);
  } else {
    checks.push(args[i]);
  }
}

if (checks.length === 0) {
  console.error("Usage: check-deps.mjs <check1> [<check2> ...] [--include-vercel]");
  console.error("Supported checks: db, email");
  process.exit(1);
}

// Read env files following Next.js precedence (lowest → highest priority):
//   .env  <  .env.development  <  .env.development.local  <  .env.local
// We merge them all so a var set in ANY file is detected. Higher-priority values win on conflict.
// (We scan dev-time files since skills typically run in a dev context, not prod.)
function parseEnvContent(content) {
  const vars = {};
  if (!content) return vars;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().startsWith("#") || !line.includes("=")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      let value = m[2];
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[m[1]] = value;
    }
  }
  return vars;
}

function readMergedEnv() {
  // Lower priority first - later ones override earlier ones
  const files = [".env", ".env.development", ".env.development.local", ".env.local"];
  let merged = {};
  for (const f of files) {
    const p = resolve(f);
    if (!existsSync(p)) continue;
    const parsed = parseEnvContent(readFileSync(p, "utf8"));
    merged = { ...merged, ...parsed };
  }
  return merged;
}

// When --include-vercel is passed, pull production env from Vercel and merge on top of local env.
// Vercel values override local (they represent the "real" prod state).
function readVercelEnv() {
  if (!existsSync(resolve(".vercel/project.json"))) {
    return { ok: false, reason: ".vercel/project.json absent - projet non linké à Vercel", vars: {} };
  }
  // Outside the repository, on purpose: the plugin's .gitignore maintenance only
  // covers `.env` itself, and a production env file left behind in the working
  // tree (a killed process skips the finally below) would sit one `git add` away
  // from a commit. A file that never enters the tree needs no rule to protect it.
  const tmpFile = join(tmpdir(), `hypervibe-check-deps-${process.pid}.env`);
  try {
    // vercel env pull writes to the given path; a tmp file avoids clobbering user .env files
    execSync(`vercel env pull "${tmpFile}" --environment=production --yes`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (!existsSync(tmpFile)) {
      return { ok: false, reason: "vercel env pull a réussi mais pas de fichier généré", vars: {} };
    }
    // A secret comes back as KEY="": Vercel never gives its value. That empty string must not
    // hide the local value (a database set up locally was reported missing).
    const pulled = parseEnvContent(readFileSync(tmpFile, "utf8"));
    const vars = Object.fromEntries(Object.entries(pulled).filter(([, v]) => v !== ""));
    const unreadable = Object.keys(pulled).filter((k) => pulled[k] === "");
    return { ok: true, reason: "vars Vercel prod récupérées", vars, unreadable };
  } catch (e) {
    return { ok: false, reason: `vercel env pull a échoué: ${String(e.message || e).slice(0, 200)}`, vars: {} };
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
  }
}

const localEnv = readMergedEnv();
let env = localEnv;
let vercelEnvInfo = null;
if (includeVercel) {
  vercelEnvInfo = readVercelEnv();
  if (vercelEnvInfo.ok) {
    env = { ...localEnv, ...vercelEnvInfo.vars };
  }
  // If the pull failed, we silently fall back to local-only - the caller can still see vercelEnvInfo in the output.
}

// -----------------------------------------------------------------------------
// db check
// -----------------------------------------------------------------------------
function checkDb() {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === "") {
    return { ok: false, reason: "DATABASE_URL absent du .env" };
  }

  // Reject patterns that indicate a placeholder / local-only / default / non-cloud setup
  const disqualifyingPatterns = [
    { re: /@localhost:/i, label: "pointe sur localhost" },
    { re: /@127\.0\.0\.1:/i, label: "pointe sur 127.0.0.1" },
    { re: /placeholder/i, label: "contient le mot 'placeholder'" },
    { re: /\/\/postgres:postgres@/i, label: "utilise le duo postgres:postgres@ (default T3/Docker)" },
    { re: /YOUR_DB/i, label: "contient le marker 'YOUR_DB' d'un .env.example" },
    { re: /^file:/i, label: "pointe sur un fichier SQLite local (pas une DB cloud)" },
  ];

  for (const { re, label } of disqualifyingPatterns) {
    if (re.test(url)) {
      return { ok: false, reason: `DATABASE_URL ${label} → pas une vraie base cloud` };
    }
  }

  // Check a drizzle.config.ts (or .js) exists somewhere plausible
  const drizzleLocations = [
    "drizzle.config.ts",
    "drizzle.config.js",
    "apps/web/drizzle.config.ts",
    "apps/web/drizzle.config.js",
    "packages/db/drizzle.config.ts",
    "packages/db/drizzle.config.js",
  ];

  const foundDrizzle = drizzleLocations.find((p) => existsSync(resolve(p)));
  if (!foundDrizzle) {
    return { ok: false, reason: "DATABASE_URL a l'air vrai mais aucun drizzle.config.{ts,js} trouvé" };
  }

  // Extract host for a friendly reason line (everything after `@` up to the next `/` or `:`)
  const hostMatch = url.match(/@([^/:]+)/);
  const host = hostMatch ? hostMatch[1] : "inconnu";

  return {
    ok: true,
    reason: `DB cloud détectée (host: ${host}, config: ${foundDrizzle})`,
    host,
    drizzleConfig: foundDrizzle,
  };
}

// -----------------------------------------------------------------------------
// email check
// -----------------------------------------------------------------------------
function checkEmail() {
  const placeholderPatterns = [
    /^$/,
    /placeholder/i,
    /^your[-_]?api[-_]?key/i,
    /^xxx+/i,
    /^re_your/i,
    /^xkeysib-your/i,
  ];

  function looksReal(value) {
    if (!value || value.trim() === "") return false;
    return !placeholderPatterns.some((re) => re.test(value));
  }

  const resend = env.RESEND_API_KEY;
  const brevo = env.BREVO_API_KEY;
  // Brevo since 3.4.34 / 2.5.13: the project's own sending application, its two variables together.
  // A key made by hand (BREVO_API_KEY) still counts: a project set up before, or the fallback.
  const brevoApp = looksReal(env.BREVO_CLIENT_ID) && looksReal(env.BREVO_CLIENT_SECRET);

  const resendReal = looksReal(resend);
  const brevoReal = looksReal(brevo);

  if (resendReal) {
    return { ok: true, provider: "resend", reason: "RESEND_API_KEY présente et non-placeholder" };
  }
  if (brevoApp) {
    return { ok: true, provider: "brevo", reason: "BREVO_CLIENT_ID et BREVO_CLIENT_SECRET présentes et non-placeholder" };
  }
  if (brevoReal) {
    return { ok: true, provider: "brevo", reason: "BREVO_API_KEY présente et non-placeholder" };
  }

  const reasons = [];
  if (!resend) reasons.push("RESEND_API_KEY absente");
  else if (!resendReal) reasons.push("RESEND_API_KEY ressemble à un placeholder");
  if (!brevo) reasons.push("ni BREVO_CLIENT_ID et BREVO_CLIENT_SECRET, ni BREVO_API_KEY");
  else if (!brevoReal) reasons.push("BREVO_API_KEY ressemble à un placeholder");

  return { ok: false, provider: null, reason: reasons.join(" ; ") };
}

// -----------------------------------------------------------------------------
// auth check
// -----------------------------------------------------------------------------
function checkAuth() {
  // Search a broad set of locations - projects use different conventions (T3, Next.js app router, better-auth, etc.)
  const basePaths = [
    "src/server/auth.ts",
    "src/server/auth/index.ts",
    "src/server/auth.config.ts",
    "src/lib/auth.ts",
    "src/lib/auth/index.ts",
    "src/auth.ts",
    "src/auth/index.ts",
    "src/app/auth.ts",
    "auth.ts",
    "auth.config.ts",
  ];
  // Also try each path prefixed with apps/web/ (monorepo case)
  const authLocations = [...basePaths, ...basePaths.map((p) => `apps/web/${p}`)];
  const authFile = authLocations.find((p) => existsSync(resolve(p)));
  if (!authFile) {
    return { ok: false, reason: "fichier auth.ts introuvable" };
  }

  // Accept AUTH_SECRET (NextAuth v5, hypervibe standard) or NEXTAUTH_SECRET (NextAuth v4 legacy)
  const secret = env.AUTH_SECRET || env.NEXTAUTH_SECRET;
  const secretVar = env.AUTH_SECRET ? "AUTH_SECRET" : env.NEXTAUTH_SECRET ? "NEXTAUTH_SECRET" : null;
  if (!secret || secret.trim() === "") {
    return { ok: false, reason: `${authFile} trouvé mais aucun secret auth dans l'env (AUTH_SECRET ou NEXTAUTH_SECRET)` };
  }
  if (/placeholder|your_/i.test(secret)) {
    return { ok: false, reason: `${authFile} trouvé mais ${secretVar} ressemble à un placeholder` };
  }

  // Infer mode from env: ADMIN_PASSWORD_HASH_* → admin mode, otherwise assume users mode
  const isAdmin = !!env.ADMIN_PASSWORD_HASH_DEV || !!env.ADMIN_PASSWORD_HASH_PROD;
  const mode = isAdmin ? "admin-credentials" : "user-credentials";

  return {
    ok: true,
    reason: `${authFile} + ${secretVar} configurés (mode détecté: ${mode})`,
    authFile,
    secretVar,
    mode,
  };
}

// -----------------------------------------------------------------------------
// vercel check
// -----------------------------------------------------------------------------
function checkVercel() {
  const path = resolve(".vercel/project.json");
  if (!existsSync(path)) {
    return { ok: false, reason: "projet pas linké à Vercel (.vercel/project.json absent)" };
  }
  try {
    const content = JSON.parse(readFileSync(path, "utf8"));
    if (!content.projectId || !content.orgId) {
      return { ok: false, reason: ".vercel/project.json présent mais incomplet (projectId/orgId manquants)" };
    }
    return {
      ok: true,
      reason: `projet linké à Vercel (projectId: ${content.projectId})`,
      projectId: content.projectId,
      orgId: content.orgId,
    };
  } catch (e) {
    return { ok: false, reason: `.vercel/project.json illisible: ${e.message}` };
  }
}

// -----------------------------------------------------------------------------
// github-repo check
// -----------------------------------------------------------------------------
function findGitConfigWalkUp() {
  // Walk up from cwd until we find .git/config or hit the filesystem root.
  // This is useful for monorepo sub-apps (e.g. books/apps/hyperarme) where .git lives at the monorepo root.
  let dir = resolve(".");
  while (true) {
    const candidate = join(dir, ".git", "config");
    if (existsSync(candidate)) return { path: candidate, root: dir };
    const parent = join(dir, "..");
    // Reached filesystem root when parent === dir (resolve stabilizes)
    const parentResolved = resolve(parent);
    if (parentResolved === dir) return null;
    dir = parentResolved;
  }
}

function checkGithubRepo() {
  const found = findGitConfigWalkUp();
  if (!found) {
    return { ok: false, reason: "pas un repo git (aucun .git/config trouvé en remontant l'arborescence)" };
  }
  const content = readFileSync(found.path, "utf8");
  // Match github.com URL: https://github.com/owner/repo(.git) OR git@github.com:owner/repo(.git)
  // Allow dots in repo name (e.g., `my-project.com`) - capture greedily then strip trailing `.git` if present.
  const match = content.match(/url\s*=\s*(?:https?:\/\/[^@\s]*@?|git@)github\.com[:/]([^/\s]+)\/([^\s]+?)\s*$/m);
  if (!match) {
    return { ok: false, reason: "repo git sans remote GitHub" };
  }
  const owner = match[1];
  let repo = match[2];
  // Strip trailing `.git` extension if present
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  // If .git was found by walking up, surface the root dir so callers can cd there if needed
  const walkedUp = found.root !== resolve(".");
  return {
    ok: true,
    reason: walkedUp
      ? `remote GitHub: ${owner}/${repo} (repo racine: ${found.root.replace(/\\/g, "/")})`
      : `remote GitHub: ${owner}/${repo}`,
    owner,
    repo,
    nameWithOwner: `${owner}/${repo}`,
    repoRoot: found.root.replace(/\\/g, "/"),
  };
}

// -----------------------------------------------------------------------------
// i18n check
// -----------------------------------------------------------------------------
function checkI18n() {
  const pkgLocations = ["package.json", "apps/web/package.json"];
  for (const p of pkgLocations) {
    const path = resolve(p);
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["next-intl"]) {
        // Try to find locales directory
        const messagesLocations = [
          "messages",
          "apps/web/messages",
          "src/messages",
          "apps/web/src/messages",
        ];
        const messagesDir = messagesLocations.find((m) => existsSync(resolve(m)));
        return {
          ok: true,
          reason: `next-intl installé (${p}${messagesDir ? `, messages: ${messagesDir}` : ""})`,
          packageJson: p,
          messagesDir: messagesDir ?? null,
        };
      }
    } catch {
      // ignore malformed package.json, try next location
    }
  }
  return { ok: false, reason: "next-intl pas installé" };
}

// -----------------------------------------------------------------------------
// stripe check
// -----------------------------------------------------------------------------
function checkStripe() {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || key.trim() === "") {
    return { ok: false, reason: "STRIPE_SECRET_KEY absente" };
  }
  if (/placeholder|your_/i.test(key)) {
    return { ok: false, reason: "STRIPE_SECRET_KEY ressemble à un placeholder" };
  }
  if (!key.startsWith("sk_")) {
    return { ok: false, reason: "STRIPE_SECRET_KEY n'a pas le préfixe Stripe attendu (sk_...)" };
  }
  const mode = key.startsWith("sk_test_") ? "test" : key.startsWith("sk_live_") ? "live" : "unknown";
  return { ok: true, reason: `Stripe configuré (mode: ${mode})`, mode };
}

// -----------------------------------------------------------------------------
// storage (Cloudflare R2) check
// -----------------------------------------------------------------------------
function checkStorage() {
  const accountId = env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  const endpoint = env.R2_ENDPOINT;

  const missing = [];
  if (!accountId || accountId.trim() === "") missing.push("R2_ACCOUNT_ID");
  if (!accessKey || accessKey.trim() === "") missing.push("R2_ACCESS_KEY_ID");
  if (!secretKey || secretKey.trim() === "") missing.push("R2_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    return { ok: false, reason: `absent(e)s: ${missing.join(", ")}` };
  }

  const values = [accountId, accessKey, secretKey];
  if (values.some((v) => /placeholder|your_/i.test(v))) {
    return { ok: false, reason: "une des vars R2 ressemble à un placeholder" };
  }

  // Detect jurisdiction from endpoint format:
  //   EU jurisdiction: https://<account>.eu.r2.cloudflarestorage.com
  //   Default:         https://<account>.r2.cloudflarestorage.com
  // Projects created or migrated to EU jurisdiction must use the .eu. endpoint.
  // If R2_ENDPOINT is missing OR doesn't include .eu., flag it as a soft warning
  // (still ok:true so existing setups don't break, but the consumer skill can
  // surface a migration suggestion to the user).
  const isEu = typeof endpoint === "string" && /\.eu\.r2\.cloudflarestorage\.com/i.test(endpoint);
  const jurisdictionWarning = !endpoint
    ? "R2_ENDPOINT absent - impossible de vérifier la juridiction"
    : !isEu
    ? "R2_ENDPOINT ne contient pas '.eu.' - le bucket est probablement en juridiction par défaut (non-RGPD strict). Migration vers juridiction EU recommandée."
    : null;

  return {
    ok: true,
    reason: "R2 (Cloudflare storage) configuré",
    bucket: env.R2_BUCKET_NAME ?? null,
    publicUrl: env.R2_PUBLIC_URL ?? null,
    jurisdiction: isEu ? "eu" : (endpoint ? "default" : "unknown"),
    jurisdictionWarning,
  };
}

// -----------------------------------------------------------------------------
// cloudflare check - multi-source detection
//
// Cloudflare access on this machine can come from THREE places:
//   1. CLOUDFLARE_API_TOKEN / CF_API_TOKEN env var in the current process
//   2. Same var, set via setx (Windows) or shell rc (Mac/Linux) but not loaded
//      into Claude Code's bash subshells (classic macOS launchd issue)
//   3. Wrangler OAuth session (via `wrangler login`, no env var involved)
//
// We probe all three. The check passes if ANY of them works. If multiple are
// present, we surface a warning when they belong to DIFFERENT Cloudflare
// accounts (the case that bit Abdel: old wrangler login on account A, fresh
// `/start` token on account B → operations went to A while we thought they'd
// go to B).
// -----------------------------------------------------------------------------
async function checkCloudflare() {
  // Source 1+2: env var (current shell first, then User scope via helper)
  let envToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  let envVarName = process.env.CLOUDFLARE_API_TOKEN
    ? "CLOUDFLARE_API_TOKEN"
    : process.env.CF_API_TOKEN
      ? "CF_API_TOKEN"
      : null;
  let envSource = envToken ? "process.env" : null;

  if (!envToken) {
    // Try User-scope persistent storage (registry on Windows, ~/.zshrc on Mac, ~/.bashrc on Linux).
    const fromUser =
      readUserEnv("CLOUDFLARE_API_TOKEN") || readUserEnv("CF_API_TOKEN");
    if (fromUser) {
      envToken = fromUser;
      envVarName = readUserEnv("CLOUDFLARE_API_TOKEN")
        ? "CLOUDFLARE_API_TOKEN"
        : "CF_API_TOKEN";
      envSource = "user-scope";
    }
  }

  // Validate the env token if we have one (live API call)
  let envAccountId = null;
  let envValid = false;
  let envReason = null;
  if (envToken && envToken.trim() !== "" && !/placeholder|your_/i.test(envToken)) {
    // The token goes in a request of this process, never on a command line, where anything
    // running on the machine can read it (SECURITY.md; until 3.3.5 it went to curl as an argument).
    const cf = async (path) => {
      const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${envToken}` }, signal: AbortSignal.timeout(10000) });
      return res.json();
    };
    try {
      const parsed = await cf("/user/tokens/verify");
      if (parsed.success === true && parsed.result?.status === "active") {
        envValid = true;
        // Get account ID from a separate call (token verify doesn't return it).
        try {
          const accParsed = await cf("/accounts?per_page=1");
          envAccountId = accParsed.result?.[0]?.id ?? null;
        } catch {/* non-fatal */}
      } else {
        envReason = `token Cloudflare rejeté par l'API (status: ${parsed.result?.status ?? "inconnu"})`;
      }
    } catch (e) {
      envReason = `validation API Cloudflare impossible: ${String(e.message || e).slice(0, 100)}`;
    }
  } else if (envToken && /placeholder|your_/i.test(envToken)) {
    envReason = `${envVarName} ressemble à un placeholder`;
  }

  // Source 3: Wrangler OAuth (works without env var)
  let wranglerOk = false;
  let wranglerAccountId = null;
  let wranglerEmail = null;
  try {
    const out = execSync("wrangler whoami", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    if (out && /You are logged in|Account Name/i.test(out)) {
      wranglerOk = true;
      const accMatch = out.match(/\b([0-9a-f]{32})\b/);
      wranglerAccountId = accMatch?.[1] ?? null;
      const emailMatch = out.match(/with the email\s+([^\s]+)/);
      wranglerEmail = emailMatch?.[1] ?? null;
    }
  } catch {
    // wrangler not installed or not logged in - non-fatal, env var path may still work
  }

  // Synthesize result
  if (envValid && wranglerOk) {
    if (envAccountId && wranglerAccountId && envAccountId !== wranglerAccountId) {
      // Account mismatch - return ok:true (both work) but flag the divergence.
      // Skills consuming this should warn the user before doing destructive ops.
      return {
        ok: true,
        reason: `token Cloudflare ET wrangler OAuth présents MAIS comptes différents (env: ${envAccountId}, oauth: ${wranglerAccountId})`,
        varName: envVarName,
        source: envSource,
        accountMismatch: true,
        envAccountId,
        wranglerAccountId,
        wranglerEmail,
      };
    }
    return {
      ok: true,
      reason: `Cloudflare OK : token (${envSource}, ${envVarName}) + wrangler OAuth (${wranglerEmail ?? "unknown email"})`,
      varName: envVarName,
      source: envSource,
      accountMismatch: false,
      envAccountId,
      wranglerAccountId,
      wranglerEmail,
    };
  }

  if (envValid) {
    return {
      ok: true,
      reason: `Cloudflare OK via env var (${envSource}, ${envVarName})${envSource === "user-scope" ? " - pense à \"export CLOUDFLARE_API_TOKEN=$(...)\" au début des skills wrangler pour les sessions bash" : ""}`,
      varName: envVarName,
      source: envSource,
    };
  }

  if (wranglerOk) {
    return {
      ok: true,
      reason: `Cloudflare OK via wrangler OAuth (${wranglerEmail ?? "unknown email"}) - aucun token env var trouvé`,
      source: "oauth",
      wranglerAccountId,
      wranglerEmail,
    };
  }

  // Nothing works
  if (envToken && envReason) {
    return { ok: false, reason: `${envReason} - lance /start pour regénérer` };
  }
  return {
    ok: false,
    reason:
      "aucun accès Cloudflare détecté : ni token env var (CLOUDFLARE_API_TOKEN), ni wrangler OAuth (`wrangler whoami`). Lance /start pour configurer.",
  };
}

// -----------------------------------------------------------------------------
// analytics (GA4) check
// -----------------------------------------------------------------------------
function checkAnalytics() {
  // Check both common variable names: NEXT_PUBLIC_GA_MEASUREMENT_ID (official Google convention)
  // and NEXT_PUBLIC_GA_ID (shorter shorthand).
  const gaId = env.NEXT_PUBLIC_GA_MEASUREMENT_ID || env.NEXT_PUBLIC_GA_ID;
  const varName = env.NEXT_PUBLIC_GA_MEASUREMENT_ID ? "NEXT_PUBLIC_GA_MEASUREMENT_ID" : "NEXT_PUBLIC_GA_ID";

  if (!gaId || gaId.trim() === "") {
    return { ok: false, reason: "NEXT_PUBLIC_GA_MEASUREMENT_ID (ou NEXT_PUBLIC_GA_ID) absente" };
  }
  if (/placeholder|your_/i.test(gaId)) {
    return { ok: false, reason: `${varName} ressemble à un placeholder` };
  }
  if (!gaId.startsWith("G-")) {
    return { ok: false, reason: `${varName} ne ressemble pas à un vrai ID GA4 (attendu : G-XXXXX...)` };
  }
  return { ok: true, reason: `GA4 configuré (${gaId})`, gaId, varName };
}

// -----------------------------------------------------------------------------
// dark-mode check - is next-themes installed AND wired up in the root layout?
// -----------------------------------------------------------------------------
function checkDarkMode() {
  const pkgLocations = ["package.json", "apps/web/package.json"];
  let pkgFound = null;
  let nextThemesInstalled = false;
  for (const p of pkgLocations) {
    const path = resolve(p);
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["next-themes"]) {
        nextThemesInstalled = true;
        pkgFound = p;
        break;
      }
    } catch {
      // ignore malformed package.json
    }
  }

  if (!nextThemesInstalled) {
    return { ok: false, reason: "next-themes pas installé" };
  }

  // Check that ThemeProvider is actually mounted in a root layout.
  // Without this, the package is installed but inert.
  const layoutLocations = [
    "src/app/layout.tsx",
    "app/layout.tsx",
    "apps/web/src/app/layout.tsx",
    "apps/web/app/layout.tsx",
    // i18n layouts (next-intl with [locale] segment)
    "src/app/[locale]/layout.tsx",
    "app/[locale]/layout.tsx",
    "apps/web/src/app/[locale]/layout.tsx",
    "apps/web/app/[locale]/layout.tsx",
  ];

  let providerMounted = false;
  let layoutFile = null;
  for (const loc of layoutLocations) {
    const lp = resolve(loc);
    if (!existsSync(lp)) continue;
    const c = readFileSync(lp, "utf8");
    if (c.includes("next-themes") || /ThemeProvider/.test(c)) {
      providerMounted = true;
      layoutFile = loc;
      break;
    }
  }

  // Detect Tailwind v4 dark variant in globals.css (best-effort, not blocking)
  const cssLocations = [
    "src/app/globals.css",
    "src/styles/globals.css",
    "app/globals.css",
    "apps/web/src/app/globals.css",
    "apps/web/src/styles/globals.css",
    "apps/web/app/globals.css",
  ];
  let darkVariantConfigured = false;
  let cssFile = null;
  for (const loc of cssLocations) {
    const cp = resolve(loc);
    if (!existsSync(cp)) continue;
    const c = readFileSync(cp, "utf8");
    cssFile = loc;
    if (/@custom-variant\s+dark/.test(c)) {
      darkVariantConfigured = true;
    }
    break;
  }

  if (!providerMounted) {
    return {
      ok: false,
      reason: `next-themes installé (${pkgFound}) mais ThemeProvider absent du root layout - installation incomplète`,
      packageJson: pkgFound,
      cssFile,
      darkVariantConfigured,
    };
  }

  return {
    ok: true,
    reason: `next-themes installé + ThemeProvider monté dans ${layoutFile}${darkVariantConfigured ? "" : " (⚠️ @custom-variant dark absent du CSS)"}`,
    packageJson: pkgFound,
    layoutFile,
    cssFile,
    darkVariantConfigured,
  };
}

// -----------------------------------------------------------------------------
// tests check - is the project equipped by /add-test? Three things must exist
// together: vitest in the dev dependencies, the cahier de recette, and the
// checker script. One without the others is a half-installation, reported as
// such so the skill knows what to complete.
// -----------------------------------------------------------------------------
function checkTests() {
  const webDirs = [".", "apps/web"];
  for (const dir of webDirs) {
    const pkgPath = resolve(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    let vitest = false;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      vitest = Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.vitest);
    } catch {
      // ignore malformed package.json
    }
    const recette = existsSync(resolve(dir, "docs/recette.md"));
    const checker = existsSync(resolve(dir, "scripts/check-recette.mjs"));
    const hook = existsSync(resolve(".hooks/pre-push"));
    // The hook only runs in a checkout that opted in (local git config, never
    // cloned): a clone with the recette but without the opt-in is complete for
    // git and inert for the guard. Say so; never opt in on the user's behalf.
    let trusted = true;
    if (hook) {
      try {
        trusted =
          execSync("git config --local --bool --get hypervibe.hooks", {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim() === "true";
      } catch {
        trusted = false;
      }
    }
    if (!vitest && !recette && !checker) continue;
    const manque = [
      !vitest && "vitest",
      !recette && "docs/recette.md",
      !checker && "scripts/check-recette.mjs",
      !hook && ".hooks/pre-push",
      hook && !trusted && "accord des hooks sur ce clone (une personne l'active, voir /add-test)",
    ].filter(Boolean);
    if (manque.length > 0) {
      return { ok: false, reason: `installation incomplète (manque : ${manque.join(", ")})`, webDir: dir, manque };
    }
    return { ok: true, reason: `tests et cahier de recette en place (${dir})`, webDir: dir };
  }
  return { ok: false, reason: "pas de tests (vitest absent, pas de docs/recette.md)" };
}

// -----------------------------------------------------------------------------
// dispatch
// -----------------------------------------------------------------------------
const dispatchers = {
  db: checkDb,
  email: checkEmail,
  auth: checkAuth,
  vercel: checkVercel,
  "github-repo": checkGithubRepo,
  i18n: checkI18n,
  stripe: checkStripe,
  storage: checkStorage,
  analytics: checkAnalytics,
  cloudflare: checkCloudflare,
  "dark-mode": checkDarkMode,
  tests: checkTests,
};

const result = {};
for (const check of checks) {
  const fn = dispatchers[check];
  if (fn) {
    result[check] = await fn();
  } else {
    result[check] = { ok: false, reason: `check inconnu: ${check} (supportés: ${Object.keys(dispatchers).join(", ")})` };
  }
}

// When Vercel was requested, surface info about the pull so callers know whether values came from local only or local+vercel.
// IMPORTANT: don't leak secret values - only expose KEYS (var names) that were pulled from Vercel.
if (includeVercel) {
  const pullSummary = vercelEnvInfo
    ? { ok: vercelEnvInfo.ok, reason: vercelEnvInfo.reason, keys: Object.keys(vercelEnvInfo.vars || {}), unreadable: vercelEnvInfo.unreadable || [] }
    : null;
  result._meta = {
    sources: vercelEnvInfo?.ok ? ["local", "vercel-production"] : ["local"],
    vercelPull: pullSummary,
  };
}

// The shared clock deployed from this machine keeps the code of the day it was
// last deployed, and a plugin installed by hand (an upload in Claude Desktop)
// never brings it in step: a user found his worker three weeks behind, by
// chance (reported on 3.1.7). Local comparison, no network, no deploy: a line
// worth saying in every skill that runs this check.
{
  const deployedWorker = join(homedir(), ".hypervibe-jobs", "worker.js");
  const latestWorker = join(dirname(fileURLToPath(import.meta.url)), "shared-worker", "worker.js");
  if (existsSync(deployedWorker) && existsSync(latestWorker)) {
    try {
      const stale = readFileSync(deployedWorker, "utf8") !== readFileSync(latestWorker, "utf8");
      result._meta = {
        ...(result._meta || {}),
        sharedWorker: stale
          ? { stale: true, hint: "the shared clock runs an older plugin version (a manual install never updates it): /update-hypervibe or /quotas brings it in step, and asks before redeploying" }
          : { stale: false },
      };
    } catch {}
  }
}

process.stdout.write(JSON.stringify(result));
