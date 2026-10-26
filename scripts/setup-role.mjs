#!/usr/bin/env node
// setup-role.mjs : Deterministic core for /add-role.
//
// Adds a roles system on top of /add-auth users:
//   - Postgres enum `user_role` with the requested role names
//   - `roles user_role[]` column on the existing `users` table (default = signup default)
//   - src/lib/roles.ts (constants + helpers: hasRole, getRoles)
//   - auth.ts patched to expose `roles` in JWT + session callbacks
//   - signup procedure patched to assign the default role to new accounts
//   - tRPC adminUsers router for the user management page
//   - /admin/(protected)/users/page.tsx admin page (single + multi-role mode)
//   - Idempotent re-runs (skips already-applied steps)
//
// FRESH INSTALL ONLY: refuses if `src/lib/roles.ts` already exists. The upgrade
// cases (add a role, remove a role, rename) are handled by Claude contextually
// in the SKILL Step 0 menu, with smaller targeted scripts when relevant.
//
// Usage:
//   node setup-role.mjs --config <path-to-json>
//
// Config file shape:
//   {
//     "webDir": "/abs/path/to/web",
//     "roles": ["member", "editor", "moderator"],
//     "roleLabels": { "member": "Membre", "editor": "Éditeur", "moderator": "Modérateur" },
//     "defaultRole": "member",
//     "backfillRole": "member",
//     "createAdminPage": true
//   }
//
// stdout layout:
//   - Live logs: ▸ <step>, ✅ <result>, ⚠️ <warning>
//   - Handoff banner at the end
//   - Last line on success: JSON Claude can parse:
//       {"success":true,"roles":[...],"defaultRole":"member","adminPage":true}

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./_render.mjs";
import { ensureAdminMiddleware, ensureRequireAdmin } from "./admin-gate.mjs";
import { ensureToolsInPath } from "./_ensure-tools-path.mjs";
import { checkBeforeForcePush } from "./neon/schema-drift.mjs";

ensureToolsInPath();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── state (hoisted: fail() can be called before STEPS run) ───────────
const STEPS = [
  "preflight",
  "patchSchema",
  "pushSchema",
  "backfillRoles",
  "writeRolesTs",
  "patchAuthTs",
  "patchSignupRouter",
  "writeAdminRouter",
  "registerAdminRouter",
  "writeAdminPage",
  "patchAdminSidebar",
  "tscCheck",
];
const completed = [];
const warnings = [];
let current = null;

// ─── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let configPath = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) configPath = args[++i];
  else fail(`Unknown arg: ${args[i]}`);
}
if (!configPath) fail("Usage: --config <path-to-json> is required");
if (!existsSync(configPath)) fail(`Config file not found: ${configPath}`);

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  fail(`Could not parse config JSON: ${e.message}`);
}

const WEB_DIR = resolve(config.webDir);
const ROLES = Array.isArray(config.roles) ? config.roles : [];
const ROLE_LABELS = config.roleLabels ?? {};
const DEFAULT_ROLE = config.defaultRole;
const BACKFILL_ROLE = config.backfillRole ?? DEFAULT_ROLE;
const CREATE_ADMIN_PAGE = config.createAdminPage !== false;

// Validate roles list
if (ROLES.length === 0) fail("config.roles must be a non-empty array");
for (const r of ROLES) {
  if (!/^[a-z][a-z0-9_-]*$/.test(r)) {
    fail(`Invalid role name "${r}". Must be kebab-case ASCII (a-z, 0-9, -, _).`);
  }
  if (["admin", "administrator", "root", "superuser", "superadmin"].includes(r)) {
    fail(
      `Role "${r}" is reserved (the global credentials admin from /add-auth uses this slot). ` +
        "Use something like `moderator`, `manager` or `superviseur` instead.",
    );
  }
}
if (!ROLES.includes(DEFAULT_ROLE)) {
  fail(`defaultRole "${DEFAULT_ROLE}" is not in the roles list.`);
}
if (!ROLES.includes(BACKFILL_ROLE)) {
  fail(`backfillRole "${BACKFILL_ROLE}" is not in the roles list.`);
}

// ─── helpers ──────────────────────────────────────────────────────────
async function step(name, fn) {
  current = name;
  await fn();
  completed.push(name);
  current = null;
}

function log(msg) { console.log(`\n▸ ${msg}`); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.warn(`  ⚠️  ${msg}`); warnings.push(msg); }

function dumpHandoff(success) {
  const remaining = STEPS.filter((s) => !completed.includes(s) && s !== current);
  console.log("\n────────────────────────────────────────────────────────");
  console.log("setup-role handoff state");
  console.log("────────────────────────────────────────────────────────");
  console.log(`✅ Completed (${completed.length}/${STEPS.length}): ${completed.join(", ") || "none"}`);
  if (current) console.log(`❌ Failed at: ${current}`);
  if (remaining.length) console.log(`⏸  Not attempted: ${remaining.join(", ")}`);
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s) during the run:`);
    for (const w of warnings) console.log(`   - ${w}`);
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
    cwd, stdio: opts.capture ? "pipe" : "inherit", shell: true, encoding: "utf8",
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
function capture(cmd, cwd) { return run(cmd, cwd, { capture: true, allowFail: true }); }

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function ensureImport(content, module, names, typeOnly = false) {
  const reExisting = new RegExp(
    `import\\s+${typeOnly ? "type\\s+" : ""}\\{([^}]*)\\}\\s+from\\s+["']${escapeRe(module)}["'];?`,
  );
  const match = content.match(reExisting);
  if (match) {
    const existing = match[1].split(",").map((s) => s.trim()).filter(Boolean);
    const existingSet = new Set(existing);
    const toAdd = names.filter((n) => !existingSet.has(n));
    if (toAdd.length === 0) return content;
    const merged = [...existing, ...toAdd].sort();
    const newImport = `import ${typeOnly ? "type " : ""}{ ${merged.join(", ")} } from "${module}";`;
    return content.replace(reExisting, newImport);
  }
  const newImport = `import ${typeOnly ? "type " : ""}{ ${names.join(", ")} } from "${module}";`;
  const lastImport = content.match(/^((?:import[^;]+;[\r\n]+)+)/);
  if (lastImport) {
    return content.replace(lastImport[0], lastImport[0] + newImport + "\n");
  }
  return newImport + "\n" + content;
}

// ─── Step 1: preflight ────────────────────────────────────────────────
async function preflight() {
  log("Preflight");

  const pkgPath = join(WEB_DIR, "package.json");
  if (!existsSync(pkgPath)) fail(`No package.json at ${WEB_DIR}.`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) fail(`${WEB_DIR} is not a Next.js project.`);
  if (!deps["drizzle-orm"]) fail("drizzle-orm missing : run /add-db first.");
  if (!deps["next-auth"]) fail("next-auth missing : run /add-auth (users mode) first.");

  // Refuse if roles.ts already exists (fresh install only).
  const rolesPath = join(WEB_DIR, "src/lib/roles.ts");
  if (existsSync(rolesPath)) {
    fail(
      `${rolesPath} already exists. setup-role only handles fresh installs. ` +
        "For incremental changes (add/remove/rename a role), Claude does the patch " +
        "contextually : see /add-role SKILL Step 0.",
    );
  }

  // auth.ts must exist + must be users-mode (or admin+users) : admin-only mode has no DB users
  const authPath = join(WEB_DIR, "src/server/auth.ts");
  if (!existsSync(authPath)) fail("src/server/auth.ts not found : run /add-auth first.");
  const auth = readFileSync(authPath, "utf8");
  const markerMatch = auth.match(/^\/\/\s*hypervibe:auth-modes\s+(.+)$/m);
  if (!markerMatch) {
    fail(
      "auth.ts has no `// hypervibe:auth-modes` marker. /add-role requires the users mode of /add-auth. " +
        "Run /add-auth first.",
    );
  }
  const modes = markerMatch[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!modes.includes("users")) {
    fail(
      `auth.ts is in mode "${modes.join(",")}" but /add-role requires "users" mode. ` +
        "Run /add-auth and choose the users mode first (admin + users coexists too).",
    );
  }

  // Schema must exist with users table
  const schemaPath = join(WEB_DIR, "src/server/db/schema.ts");
  if (!existsSync(schemaPath)) fail("src/server/db/schema.ts not found.");
  const schema = readFileSync(schemaPath, "utf8");
  if (!/export const users\s*=\s*createTable\("user"/.test(schema)) {
    fail("Could not find `users` table in schema.ts. /add-role requires the table created by /add-auth users.");
  }

  // tRPC root
  if (!existsSync(join(WEB_DIR, "src/server/api/root.ts"))) {
    fail("src/server/api/root.ts not found.");
  }

  // pnpm
  if (capture("pnpm --version", WEB_DIR).status !== 0) fail("pnpm CLI is missing.");

  ok(`Web dir OK: ${WEB_DIR}`);
  ok(`Auth modes detected: ${modes.join(", ")}`);
}

// ─── Step 2: patch schema.ts ──────────────────────────────────────────
async function patchSchema() {
  log("Patching src/server/db/schema.ts (add pgEnum + roles[] column)");

  const schemaPath = join(WEB_DIR, "src/server/db/schema.ts");
  let schema = readFileSync(schemaPath, "utf8");

  schema = ensureImport(schema, "drizzle-orm/pg-core", ["pgEnum"]);
  schema = ensureImport(schema, "drizzle-orm", ["sql"]);

  // 1. Inject pgEnum declaration (idempotent)
  if (!/export const userRoleEnum\s*=\s*pgEnum\(/.test(schema)) {
    const enumDecl = `\nexport const userRoleEnum = pgEnum("user_role", [${ROLES.map((r) => `"${r}"`).join(", ")}] as const);\n`;
    // Insert just before the users table declaration
    const usersDecl = schema.match(/export const users\s*=\s*createTable\("user"/);
    if (usersDecl) {
      schema = schema.slice(0, usersDecl.index) + enumDecl + schema.slice(usersDecl.index);
    } else {
      schema = schema.trimEnd() + enumDecl;
    }
  } else {
    warn("userRoleEnum already declared in schema.ts : leaving as-is. Manually verify the role list matches.");
  }

  // 2. Inject `roles` column into the users table (idempotent).
  // We can't use a single regex because the createTable body contains nested
  // object literals (e.g. `timestamp("x", { mode: "date" })`, `references(() => x, { onDelete })`).
  // Walk the braces manually to find the outer matching `}`.
  if (/roles:\s*userRoleEnum\(/.test(schema)) {
    warn("`roles` column already on users table : leaving as-is.");
  } else {
    const headerRe = /export const users\s*=\s*createTable\("user",\s*\{/;
    const headerMatch = schema.match(headerRe);
    if (!headerMatch) {
      fail("Could not locate `export const users = createTable(\"user\", {` in schema.ts.");
    }
    const openBraceIdx = headerMatch.index + headerMatch[0].length - 1; // points at the `{`
    let depth = 1;
    let i = openBraceIdx + 1;
    while (i < schema.length && depth > 0) {
      const c = schema[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    if (depth !== 0) {
      fail("Could not find the matching `}` of the users createTable body (unbalanced braces?).");
    }
    const closeBraceIdx = i - 1;
    const before = schema.slice(0, closeBraceIdx);
    const after = schema.slice(closeBraceIdx); // starts with `}`
    // Ensure trailing comma on the last existing field before injecting
    const beforeTrimmed = before.replace(/\s+$/, "");
    const sep = beforeTrimmed.endsWith(",") ? "\n" : ",\n";
    const newCol = `  roles: userRoleEnum("roles").array().notNull().default(sql\`'{${DEFAULT_ROLE}}'::user_role[]\`),`;
    schema = beforeTrimmed + sep + newCol + "\n" + after;
  }

  writeFileSync(schemaPath, schema);
  ok("Schema patched (enum + roles[] column)");
}

// ─── Step 3: drizzle-kit push ─────────────────────────────────────────
async function pushSchema() {
  log("Pushing schema with drizzle-kit");
  // Roles land on a users table that holds real accounts: say what the push
  // would destroy before letting --force through (scripts/neon/schema-drift.mjs).
  const drift = await checkBeforeForcePush({ dir: WEB_DIR });
  if (drift.status !== "safe") console.log(drift.text);
  if (drift.block) {
    fail(
      "Schema patched on disk but NOT pushed: the live database holds data that schema.ts does not declare " +
        "(listed above), and the push would delete it. Show the list to the user, declare those tables/columns " +
        "in schema.ts or get an explicit go to drop them, then retry: `cd " + WEB_DIR + " && npx drizzle-kit push`",
    );
  }
  const probe = capture("npx drizzle-kit push --help", WEB_DIR);
  const supportsForce = drift.allowForce && probe.stdout?.includes("--force");
  const cmd = supportsForce ? "npx drizzle-kit push --force" : "npx drizzle-kit push";
  run(cmd, WEB_DIR);
  ok("Schema pushed to DB");
}

// ─── Step 4: backfill existing users ──────────────────────────────────
async function backfillRoles() {
  log(`Backfilling existing users with role "${BACKFILL_ROLE}"`);
  // The schema default already handles new rows. For existing rows that may have
  // an empty/null roles array, force them to the backfill role.
  // We do it via a tiny inline Node script using the project's `db` export so we
  // don't have to re-implement the DATABASE_URL resolution.
  const script = `
import { sql } from "drizzle-orm";
import { db } from "~/server/db";
const out = await db.execute(sql\`
  UPDATE "user" SET roles = ARRAY['${BACKFILL_ROLE}']::user_role[]
  WHERE roles IS NULL OR cardinality(roles) = 0
\`);
console.log(JSON.stringify({ rowsAffected: out.rowsAffected ?? out.rowCount ?? null }));
`.trim();
  const tmpFile = join(WEB_DIR, ".hypervibe-backfill-roles.mts");
  writeFileSync(tmpFile, script);
  try {
    const res = capture(`npx tsx "${tmpFile}"`, WEB_DIR);
    if (res.status !== 0) {
      warn(
        "Backfill UPDATE failed via tsx. New signups will use the default, " +
          "but pre-existing users may have an empty roles array. " +
          "You can rerun the UPDATE manually:\n" +
          `   UPDATE "user" SET roles = ARRAY['${BACKFILL_ROLE}']::user_role[] WHERE roles IS NULL OR cardinality(roles) = 0;`,
      );
    } else {
      ok(`Backfill done (${(res.stdout || "").trim()})`);
    }
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
}

// ─── Step 5: write src/lib/roles.ts ───────────────────────────────────
async function writeRolesTs() {
  log("Writing src/lib/roles.ts");
  const dest = join(WEB_DIR, "src/lib/roles.ts");
  mkdirSync(dirname(dest), { recursive: true });
  const labelEntries = ROLES
    .map((r) => `  ${JSON.stringify(r)}: ${JSON.stringify(ROLE_LABELS[r] ?? capitalize(r))},`)
    .join("\n");
  writeFileSync(
    dest,
    render("role/roles.ts", {
      ROLES_CSV: ROLES.join(", "),
      ROLES_TUPLE: ROLES.map((r) => `"${r}"`).join(", "),
      DEFAULT_ROLE: DEFAULT_ROLE,
      ROLE_LABELS_ENTRIES: labelEntries,
    }),
  );
  ok("roles.ts written");
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Step 6: patch auth.ts (expose roles in JWT + session) ────────────
async function patchAuthTs() {
  log("Patching src/server/auth.ts (expose roles in JWT + session)");
  const authPath = join(WEB_DIR, "src/server/auth.ts");
  let auth = readFileSync(authPath, "utf8");

  // 1. Update the Session module augmentation to include roles
  if (/roles:\s*string\[\]/.test(auth)) {
    warn("auth.ts already exposes roles in the Session type : skipping module augmentation patch.");
  } else {
    auth = auth.replace(
      /interface Session extends DefaultSession\s*\{\s*user:\s*\{([^}]*)\}/,
      (match, userBody) => {
        const trimmed = userBody.trimEnd();
        const sep = trimmed.endsWith(";") || trimmed.endsWith(",") ? "\n      " : ";\n      ";
        return `interface Session extends DefaultSession {\n    user: {${trimmed}${sep}roles: string[];\n    }`;
      },
    );
  }

  // 2. Include roles in the authorize() return (find the users-mode path)
  // The users-mode authorize returns an object with id/email/name/image : we add roles.
  if (/return\s*\{\s*id:\s*user\.id,/.test(auth) && !/roles:\s*user\.roles/.test(auth)) {
    auth = auth.replace(
      /return\s*\{\s*id:\s*user\.id,([\s\S]*?)\};/,
      (match, body) => {
        if (/roles:\s*user\.roles/.test(body)) return match;
        const trimmedBody = body.trimEnd();
        return `return {\n          id: user.id,${trimmedBody}\n          roles: user.roles ?? [],\n        };`;
      },
    );
  }

  // 3. jwt callback: persist roles
  if (!/token\.roles\s*=/.test(auth)) {
    auth = auth.replace(
      /jwt\(\{\s*token,\s*user\s*\}\)\s*\{([\s\S]*?)return token;\s*\}/,
      (match, body) => {
        if (/token\.roles\s*=/.test(body)) return match;
        return `jwt({ token, user }) {${body.trimEnd()}\n      if (user) token.roles = (user as { roles?: string[] }).roles ?? [];\n      return token;\n    }`;
      },
    );
  }

  // 4. session callback: expose roles to session.user
  if (!/session\.user\.roles\s*=/.test(auth)) {
    auth = auth.replace(
      /session\(\{\s*session,\s*token\s*\}\)\s*\{([\s\S]*?)return session;\s*\}/,
      (match, body) => {
        if (/session\.user\.roles\s*=/.test(body)) return match;
        return `session({ session, token }) {${body.trimEnd()}\n      if (session.user) session.user.roles = (token.roles as string[]) ?? [];\n      return session;\n    }`;
      },
    );
  }

  writeFileSync(authPath, auth);
  ok("auth.ts patched (Session.user.roles + JWT + session callbacks)");
}

// ─── Step 7: patch signup router to assign default role ───────────────
async function patchSignupRouter() {
  log("Patching signup procedure to assign the default role to new users");
  const routerPath = join(WEB_DIR, "src/server/api/routers/auth.ts");
  if (!existsSync(routerPath)) {
    warn("src/server/api/routers/auth.ts not found : skip signup patch. New users will rely on DB default.");
    return;
  }
  let router = readFileSync(routerPath, "utf8");

  // The auth-router template uses `db.insert(users).values({...})` in the signup procedure.
  // We inject `roles: ['<DEFAULT_ROLE>']` into the values object if not already present.
  const insertRe = /db\.insert\(users\)\.values\(\{([\s\S]*?)\}\)/;
  const m = router.match(insertRe);
  if (!m) {
    warn("Could not find `db.insert(users).values({...})` in auth.ts router. Signup will use DB default for roles.");
    return;
  }
  if (/roles:\s*\[/.test(m[1])) {
    ok("Signup router already assigns roles : skip.");
    return;
  }
  const trimmed = m[1].trimEnd();
  const sep = trimmed.endsWith(",") ? "\n" : ",\n";
  const injected = `${trimmed}${sep}        roles: [${JSON.stringify(DEFAULT_ROLE)}],\n      `;
  router = router.replace(insertRe, `db.insert(users).values({${injected}})`);
  writeFileSync(routerPath, router);
  ok("Signup procedure now assigns the default role to new users");
}

// ─── Step 8: write tRPC adminUsers router ─────────────────────────────
async function writeAdminRouter() {
  if (!CREATE_ADMIN_PAGE) {
    ok("Admin page skipped (createAdminPage=false) : no router to write");
    return;
  }
  log("Writing src/server/api/routers/admin-users.ts");
  const dest = join(WEB_DIR, "src/server/api/routers/admin-users.ts");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, render("role/admin-router.ts", {}));
  ok("admin-users router written");
}

// ─── Step 9: register adminUsers router in root.ts ────────────────────
async function registerAdminRouter() {
  if (!CREATE_ADMIN_PAGE) {
    ok("Admin router registration skipped");
    return;
  }
  log("Registering adminUsers router in src/server/api/root.ts");
  const rootPath = join(WEB_DIR, "src/server/api/root.ts");
  let root = readFileSync(rootPath, "utf8");
  if (root.includes("adminUsersRouter")) {
    ok("adminUsers router already registered");
    return;
  }
  const importLine = `import { adminUsersRouter } from "~/server/api/routers/admin-users";\n`;
  const lastImport = root.match(/^((?:import[^;]+;[\r\n]+)+)/);
  if (lastImport) {
    root = root.replace(lastImport[0], lastImport[0] + importLine);
  } else {
    root = importLine + root;
  }
  const replaced = root.replace(
    /createTRPCRouter\(\s*\{/,
    `createTRPCRouter({\n  adminUsers: adminUsersRouter,`,
  );
  if (replaced === root) {
    fail("Could not find createTRPCRouter({...}) in root.ts. Register adminUsersRouter manually.");
  }
  writeFileSync(rootPath, replaced);
  ok("adminUsers router registered");
}

// ─── Step 10: write admin page ────────────────────────────────────────
async function writeAdminPage() {
  if (!CREATE_ADMIN_PAGE) {
    ok("Admin page skipped");
    return;
  }
  log("Writing src/app/admin/(protected)/users/page.tsx");
  // Detect the right path: with i18n, app is under [locale]
  const candidates = [
    "src/app/admin/(protected)/users/page.tsx",
    "src/app/[locale]/admin/(protected)/users/page.tsx",
  ];
  let chosenDest = null;
  for (const rel of candidates) {
    const adminDir = join(WEB_DIR, rel.replace(/\/users\/page\.tsx$/, ""));
    if (existsSync(adminDir)) {
      chosenDest = join(WEB_DIR, rel);
      break;
    }
  }
  if (!chosenDest) {
    // Default to no-locale path, create the parent dir
    chosenDest = join(WEB_DIR, candidates[0]);
    warn(
      "Could not find an existing admin/(protected)/ directory. Creating the page at " +
        candidates[0] + ". If your project uses i18n, move it under [locale]/ manually.",
    );
  }
  mkdirSync(dirname(chosenDest), { recursive: true });
  // A server page that calls requireAdmin() on its first line, and the interactive table beside it
  // (3.4.17): the layout's check alone let the page's content leave in the body of its redirect.
  writeFileSync(chosenDest, render("role/pages/users-page.tsx", {}));
  writeFileSync(join(dirname(chosenDest), "users-table.tsx"), render("role/pages/users-table.tsx", {}));
  ok(`Admin page written: ${chosenDest.replace(WEB_DIR + "/", "")} (+ users-table.tsx)`);
  // The helper the page imports, for a project whose admin space predates it; and the first barrier
  // in front of the admin space, never written over a middleware the project already has.
  if (ensureRequireAdmin(WEB_DIR) === "written") ok("src/server/require-admin.ts written (the check every admin page calls first)");
  const gate = ensureAdminMiddleware(WEB_DIR);
  if (gate.status === "written") ok(`Middleware written: ${gate.file}`);
  else if (gate.status === "existing") {
    warn(
      `The project already has a middleware (${gate.file}): left as it is, without the admin gate. ` +
        "Merge templates/auth/admin/middleware.ts into it by hand when that is safe, or tell the person what to add. " +
        "The page stays protected by requireAdmin() either way.",
    );
  }
}

// ─── Step 11: best-effort patch of the admin sidebar ──────────────────
async function patchAdminSidebar() {
  if (!CREATE_ADMIN_PAGE) {
    ok("Admin sidebar patch skipped");
    return;
  }
  log("Best-effort: adding 'Utilisateurs' link to the admin sidebar (if any)");
  // Look for a sidebar/menu component under admin/
  const candidates = [
    "src/components/admin/sidebar.tsx",
    "src/components/admin/admin-sidebar.tsx",
    "src/components/admin/menu.tsx",
    "src/app/admin/(protected)/_sidebar.tsx",
    "src/app/admin/(protected)/sidebar.tsx",
  ];
  let found = null;
  for (const rel of candidates) {
    if (existsSync(join(WEB_DIR, rel))) { found = rel; break; }
  }
  if (!found) {
    warn(
      "No admin sidebar file found at common paths. Add a link to /admin/users yourself, " +
        "or ask Claude: \"ajoute un lien Utilisateurs dans la sidebar de l'admin\".",
    );
    return;
  }
  let sidebar = readFileSync(join(WEB_DIR, found), "utf8");
  if (sidebar.includes("/admin/users")) {
    ok("Sidebar already links to /admin/users : skipping");
    return;
  }
  warn(
    `Sidebar at ${found} doesn't link to /admin/users yet. The script intentionally ` +
      "doesn't patch it (too risky to clobber). Ask Claude to add the link.",
  );
}

// ─── Step 12: tsc check ───────────────────────────────────────────────
async function tscCheck() {
  log("Running pnpm tsc --noEmit (sanity check)");
  const res = capture("pnpm tsc --noEmit", WEB_DIR);
  if (res.status !== 0) {
    if (res.stdout) console.log(res.stdout);
    if (res.stderr) console.log(res.stderr);
    warn(
      "tsc reported errors. The roles system is in place but the project doesn't compile cleanly. " +
        "Common causes: a pre-existing TS error unrelated to /add-role, or a custom auth.ts shape " +
        "our patch didn't fully cover. Ask Claude to investigate the tsc output.",
    );
  } else {
    ok("Type check passed");
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────
await step("preflight", preflight);
await step("patchSchema", patchSchema);
await step("pushSchema", pushSchema);
await step("backfillRoles", backfillRoles);
await step("writeRolesTs", writeRolesTs);
await step("patchAuthTs", patchAuthTs);
await step("patchSignupRouter", patchSignupRouter);
await step("writeAdminRouter", writeAdminRouter);
await step("registerAdminRouter", registerAdminRouter);
await step("writeAdminPage", writeAdminPage);
await step("patchAdminSidebar", patchAdminSidebar);
await step("tscCheck", tscCheck);

dumpHandoff(true);

console.log(`
🎉 setup-role complete.

   Roles available:   ${ROLES.join(", ")}
   Default at signup: ${DEFAULT_ROLE}
   Backfilled to:     ${BACKFILL_ROLE} (only rows with empty/NULL roles)
   Helpers:           src/lib/roles.ts (ROLES, ROLE_LABELS, hasRole, getRoles)
   Admin page:        ${CREATE_ADMIN_PAGE ? "/admin/users (a server page that calls requireAdmin() first, its table in users-table.tsx)" : "skipped"}
   Marker:            // hypervibe:roles ${ROLES.join(", ")} (in src/lib/roles.ts)

Next: Claude takes over for the CLAUDE.md update (via _update-claude-md), the user-facing
summary, and (optionally) integrating the "Utilisateurs" link in the admin sidebar if
the script couldn't find a known sidebar file to patch.
`);

console.log(
  JSON.stringify({
    success: true,
    roles: ROLES,
    defaultRole: DEFAULT_ROLE,
    backfillRole: BACKFILL_ROLE,
    adminPage: CREATE_ADMIN_PAGE,
  }),
);
