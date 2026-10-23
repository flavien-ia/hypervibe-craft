#!/usr/bin/env node
// manifest.mjs - The project resource manifest: `.hypervibe/resources.json`.
//
// WHY THIS FILE EXISTS
// --------------------
// Backups (/save-project) and deletion (/delete-project) used to rediscover a
// project's cloud resources by matching resource names against the project
// name. That is an inference, and it fails silently in both directions: a
// bucket named differently from the project is not found (a backup ships
// without a single file while reporting success), and a resource of ANOTHER
// project could match (a deletion sweeps up someone else's data - the strict
// token matching in `_match.mjs` exists to prevent exactly that).
//
// Yet at the moment a resource is CREATED, its identity is known with
// certainty. This manifest keeps that certainty instead of throwing it away:
// every `/add-*` skill records what it provisions, and save/delete read the
// manifest FIRST, falling back to name-matching only for what predates it.
//
// The manifest is the PRIMARY source, never the ONLY source: consumers must
// still scan the real accounts and surface the difference (declared but
// missing, present but undeclared). A declaration is not the reality.
//
// CONTENT RULES
// -------------
// - Identifiers only (ids, names, hosts, jurisdictions). NEVER secrets: no
//   tokens, keys, passwords, connection strings. The CLI refuses them.
// - Versioned with the code (do NOT gitignore `.hypervibe/`): the manifest
//   documents the project's infrastructure for humans too.
// - `shared: true` marks infrastructure used by several projects (e.g. the
//   `hypervibe-jobs` worker): consumers must NEVER delete a shared resource
//   when deleting one project. A project's own registration on that worker
//   (cron-job, db-backup) is not shared: `add` refuses the flag there, but for
//   the backup of a database the manifest itself declares shared.
//
// USAGE
// -----
//   node manifest.mjs add    --project-dir <dir> --kind <kind> --name <name>
//                            [--id <id>] [--field k=v ...] [--added-by <skill>]
//                            [--shared] [--note "<text>"]
//   node manifest.mjs remove --project-dir <dir> --kind <kind> (--name <n> | --id <id>)
//   node manifest.mjs list   --project-dir <dir> [--kind <kind>]
//   node manifest.mjs adopt  --project-dir <dir> [--write]
//
// `add` is an upsert (re-running updates the entry in place), so skills can
// call it unconditionally. Every command prints one JSON object on stdout.
//
// KINDS (aligned with the /delete-project scans)
// ----------------------------------------------
//   vercel-project, neon-project, r2-bucket, cf-worker, dns-zone,
//   render-service, stripe-webhook, upstash-db, cron-job, db-backup,
//   email-route, github-repo, ai-key, email-key (the project's own sending key: its id at
//   Resend, or the name a Brevo key was made under, never the key; 3.4.16)
// Unknown kinds are accepted (forward compatibility) but flagged in output.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { depotRacine, manifestExistant, emplacementCanonique } from "./locate.mjs";
import { sameResource } from "./same-resource.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const KNOWN_KINDS = [
  "vercel-project", "neon-project", "r2-bucket", "cf-worker", "dns-zone",
  "render-service", "stripe-webhook", "upstash-db", "cron-job", "db-backup",
  "email-route", "github-repo", "ai-key", "email-key",
];

// --- args ------------------------------------------------------------------
const args = process.argv.slice(2);
const command = args[0];
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
function flag(name) {
  return args.includes(name);
}
function fields() {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--field") {
      const raw = String(args[i + 1] || "");
      const eq = raw.indexOf("=");
      if (eq > 0) out[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
  }
  return out;
}

const PROJECT_DIR = resolve(arg("--project-dir") || process.cwd());
// The rule "one manifest per repository, at its root" is enforced HERE, not
// left to callers: aimed at `apps/web` of a monorepo, the manifest still
// lands (and is found) at the repo root. An existing manifest written at
// another depth keeps being used rather than splitting the brain.
const FILE = manifestExistant(PROJECT_DIR) ?? emplacementCanonique(PROJECT_DIR);
/** Repo root (identity files can live there too, e.g. a monorepo root .env). */
const RACINE = depotRacine(PROJECT_DIR) ?? PROJECT_DIR;

function fail(reason, extra = {}) {
  console.log(JSON.stringify({ ok: false, reason, ...extra }));
  process.exit(1);
}

// --- secret guard ----------------------------------------------------------
// The manifest holds identifiers, never credentials. Refuse loudly rather
// than letting a secret slip into a file that is committed to git.
const SECRET_FIELD_RE = /secret|password|passwd|token|credential|api.?key|private/i;
const SECRET_VALUE_RES = [
  /^(sk|rk|pk)[-_](live|test|proj|svcacct|admin)[-_]?[A-Za-z0-9]{8,}/, // Stripe/OpenAI-style keys
  /^sk-[A-Za-z0-9_-]{16,}/,
  /^whsec_/,
  /^re_[A-Za-z0-9_]{16,}/,
  /^xkeysib-/,
  /^tsk_[A-Za-z0-9]{8,}/,
  /^AIza[A-Za-z0-9_-]{20,}/,
  /^ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}/,
  /^(postgres(ql)?|mysql|redis|rediss|amqp):\/\/[^\s]*:[^\s]*@/,
  /-----BEGIN [A-Z ]*KEY-----/,
  /^AKIA[A-Z0-9]{12,}/,
];
function assertNoSecret(key, value) {
  if (SECRET_FIELD_RE.test(key)) {
    fail(`field name "${key}" looks like a credential - the manifest stores identifiers only`);
  }
  const v = String(value);
  for (const re of SECRET_VALUE_RES) {
    if (re.test(v)) {
      fail(`value of "${key}" looks like a secret - the manifest stores identifiers only`);
    }
  }
}

// --- load / save -----------------------------------------------------------
function load() {
  if (!existsSync(FILE)) return null;
  try {
    const m = JSON.parse(readFileSync(FILE, "utf8"));
    if (!Array.isArray(m.resources)) m.resources = [];
    return m;
  } catch (e) {
    fail(`could not parse ${FILE}: ${e.message} - fix or delete the file first`, { file: FILE });
  }
}
function projectNameFromPackageJson() {
  for (const base of [RACINE, PROJECT_DIR]) {
    try {
      const nom = JSON.parse(readFileSync(join(base, "package.json"), "utf8")).name;
      if (nom) return nom;
    } catch {
      /* try the next one */
    }
  }
  return null;
}
function save(manifest) {
  manifest.updatedAt = new Date().toISOString();
  // Stable order: one resource added should produce a one-line git diff, not
  // a reshuffle of the whole file.
  manifest.resources.sort(
    (a, b) =>
      String(a.kind).localeCompare(String(b.kind)) ||
      String(a.id ?? a.name ?? "").localeCompare(String(b.id ?? b.name ?? "")),
  );
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
function emptyManifest() {
  return {
    version: 1,
    project: projectNameFromPackageJson(),
    about:
      "Cloud resources this project owns, recorded when they are created. " +
      "Read by /save-project and /delete-project. Identifiers only - never secrets.",
    updatedAt: null,
    resources: [],
  };
}

// Identity of a resource inside the manifest: kind + id when both sides have one, kind + name
// (+ jurisdiction for R2) otherwise, and the host when nothing else is known: see
// same-resource.mjs.

// A project's own registration on the shared clock is never shared, even though the clock is: a
// scheduled task calls this project's own route, and a backup is this project's database's, shared
// only when the manifest declares that database shared. Marked shared (the flag followed the
// clock's), the deletion of the project left them in place, and the clock kept backing up a
// deleted database (a user's migration, 29/09/2026).
function neverSharedReason(kind, manifest) {
  if (kind === "cron-job") {
    return "--shared does not apply to a cron-job: the task calls this project's own route, and leaves with it. The shared clock itself is declared once, as cf-worker hypervibe-jobs --shared.";
  }
  if (kind === "db-backup" && !manifest.resources.some((r) => r.kind === "neon-project" && r.shared)) {
    return "--shared does not apply to this db-backup: the backup is this project's database's, which the manifest does not declare shared (neon-project --shared). Marked shared, deleting the project would leave the clock backing up a deleted database.";
  }
  return null;
}

// --- add -------------------------------------------------------------------
function cmdAdd() {
  const kind = arg("--kind");
  const name = arg("--name");
  const id = arg("--id");
  if (!kind || (!name && !id)) fail("add needs --kind and --name (or --id)");
  const extra = fields();
  for (const [k, v] of Object.entries(extra)) assertNoSecret(k, v);
  if (name) assertNoSecret("name", name);
  if (id) assertNoSecret("id", id);

  // A project's own registration on the shared clock is never shared (neverSharedReason): refused
  // here, and a flag written before 3.3.9 is dropped at the entry's next write, below.
  const manifest = load() || emptyManifest();
  const neverShared = neverSharedReason(kind, manifest);
  if (neverShared && flag("--shared")) fail(neverShared);

  const entry = {
    kind,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...extra,
    ...(flag("--shared") ? { shared: true } : {}),
    ...(arg("--note") ? { note: arg("--note") } : {}),
    addedBy: arg("--added-by") || "manual",
    addedAt: new Date().toISOString().slice(0, 10),
  };

  const existing = manifest.resources.findIndex((r) => sameResource(r, entry));
  let action;
  let stored;
  if (existing >= 0) {
    const before = manifest.resources[existing];
    // Update in place but keep the original provenance: who first created the
    // resource is history, not something a re-run should rewrite.
    stored = { ...before, ...entry, addedBy: before.addedBy, addedAt: before.addedAt };
    // Such a registration marked shared before 3.3.9 loses the flag here.
    if (neverShared) delete stored.shared;
    action = JSON.stringify(stored) === JSON.stringify(before) ? "unchanged" : "updated";
    manifest.resources[existing] = stored;
  } else {
    manifest.resources.push(entry);
    stored = entry;
    action = "added";
  }
  if (action !== "unchanged") save(manifest);
  console.log(
    JSON.stringify({
      ok: true,
      action,
      resource: stored,
      file: FILE,
      ...(KNOWN_KINDS.includes(kind) ? {} : { warning: `unknown kind "${kind}" (accepted, but check for a typo)` }),
    }),
  );
}

// --- remove ----------------------------------------------------------------
function cmdRemove() {
  const kind = arg("--kind");
  const name = arg("--name");
  const id = arg("--id");
  if (!kind || (!name && !id)) fail("remove needs --kind and --name (or --id)");
  const manifest = load();
  if (!manifest) fail("no manifest file", { file: FILE });
  const probe = {
    kind,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(arg("--jurisdiction") ? { jurisdiction: arg("--jurisdiction") } : {}),
  };
  const before = manifest.resources.length;
  manifest.resources = manifest.resources.filter((r) => !sameResource(r, probe));
  if (manifest.resources.length === before) {
    fail("resource not found in manifest", { file: FILE });
  }
  save(manifest);
  console.log(
    JSON.stringify({ ok: true, action: "removed", removed: before - manifest.resources.length, file: FILE }),
  );
}

// --- list ------------------------------------------------------------------
function cmdList() {
  const manifest = load();
  if (!manifest) {
    console.log(JSON.stringify({ ok: true, exists: false, file: FILE, resources: [] }));
    return;
  }
  const kind = arg("--kind");
  const resources = kind ? manifest.resources.filter((r) => r.kind === kind) : manifest.resources;
  console.log(
    JSON.stringify({ ok: true, exists: true, file: FILE, project: manifest.project, resources }),
  );
}

// --- adopt -----------------------------------------------------------------
// Deterministic adoption for projects that predate the manifest: derive
// resources from the project's OWN identifiers (env vars, .vercel link,
// wrangler.toml, git remote) - never from name similarity. Name-based
// discovery stays where it belongs: in /delete-project's scans, presented to
// a human for validation.
function readEnvFile(file, base = PROJECT_DIR) {
  const out = {};
  try {
    for (const line of readFileSync(join(base, file), "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* absent */
  }
  return out;
}

async function neonProjectByHost(host) {
  // The connection host pins the project with certainty - resolve id + name
  // through the API when a key is available, by checking each project's
  // endpoints. One-time cost, adoption only.
  //
  // Neon's project list is organisation-scoped and says nothing when the scope is missing: a
  // personal key without `org_id` answers for the account's default organisation only, so a
  // project living in any other organisation was never found, and the message blamed a missing
  // key (a user's eight projects, 29/09/2026). Every organisation the key belongs to is searched:
  // this lookup only reads, and the host designates one project whatever the organisation.
  let apiKey = "";
  let vaultGet = () => "";
  try {
    const { getSecret } = await import("../vault/vault.mjs");
    vaultGet = (item, field) => {
      try {
        return getSecret(item, field) || "";
      } catch {
        return "";
      }
    };
    apiKey = vaultGet("NEON", "api_key");
  } catch {
    /* vault unavailable */
  }
  if (!apiKey) {
    const r = spawnSync("node", [join(__dirname, "..", "_read-user-env.mjs"), "NEON_API_KEY"], {
      encoding: "utf8",
    });
    apiKey = (r.stdout || "").trim();
  }
  if (!apiKey) return { reason: "no-key" };
  // Pooled connection strings carry a `-pooler` infix that the endpoints API
  // does not: `ep-x-pooler.c-2...` and `ep-x.c-2...` are the same endpoint.
  const cible = host.replace("-pooler.", ".");
  const headers = { Authorization: `Bearer ${apiKey}` };
  // The key's own scope first (its organisation, for an organisation key), then every
  // organisation it belongs to.
  const scopes = [null];
  try {
    const { resolveNeonOrg } = await import("../neon-org.mjs");
    const org = await resolveNeonOrg(apiKey, vaultGet);
    for (const id of [org.orgId, ...(org.orgs || []).map((o) => o.id)]) {
      if (id && !scopes.includes(id)) scopes.push(id);
    }
  } catch {
    /* no organisation helper here, or Neon unreachable: the key's own scope only */
  }
  let read = 0;
  for (const orgId of scopes) {
    let projects;
    try {
      const res = await fetch(
        `https://console.neon.tech/api/v2/projects?limit=400${orgId ? `&org_id=${encodeURIComponent(orgId)}` : ""}`,
        { headers },
      );
      if (!res.ok) continue;
      projects = (await res.json()).projects || [];
      read += 1;
    } catch {
      continue;
    }
    const checks = await Promise.all(
      projects.map(async (p) => {
        try {
          const eps = await (
            await fetch(`https://console.neon.tech/api/v2/projects/${p.id}/endpoints`, { headers })
          ).json();
          const hosts = (eps.endpoints || []).map((e) => e.host);
          return hosts.includes(cible) ? { id: p.id, name: p.name } : null;
        } catch {
          return null;
        }
      }),
    );
    const found = checks.find(Boolean);
    if (found) return found;
  }
  return read ? { reason: "not-found", scopes: read } : { reason: "unreachable" };
}

async function cmdAdopt() {
  const found = [];
  // Root first, aimed folder second: in a monorepo, `apps/web` values are the
  // more specific ones and win over the repo root's.
  const env = {
    ...readEnvFile(".env", RACINE),
    ...readEnvFile(".env.local", RACINE),
    ...readEnvFile(".env"),
    ...readEnvFile(".env.local"),
  };

  // Vercel: the link file carries the exact ids. Linked from the aimed
  // folder or from the repo root, both are seen.
  try {
    const lienVercel = [PROJECT_DIR, RACINE]
      .map((b) => join(b, ".vercel", "project.json"))
      .find(existsSync);
    const link = JSON.parse(readFileSync(lienVercel, "utf8"));
    if (link.projectId) {
      found.push({
        resource: {
          kind: "vercel-project",
          id: link.projectId,
          ...(link.orgId ? { orgId: link.orgId } : {}),
        },
        source: ".vercel/project.json",
      });
    }
  } catch {
    /* not linked */
  }

  // Neon: the DATABASE_URL host pins the project. Resolve id+name via API
  // when possible; otherwise record the host alone (still an identifier).
  const dbUrl = env.DATABASE_URL || env.POSTGRES_URL || "";
  const hostMatch = /@([a-z0-9.-]+\.neon\.tech)\b/.exec(dbUrl);
  if (hostMatch) {
    const resolved = await neonProjectByHost(hostMatch[1]);
    const why = {
      "no-key": "no Neon API key",
      collaborator: "a collaborator's harness never reads a database key: the administrator's resolves it",
      unreachable: "the Neon API could not be read",
      "not-found": `no project of this Neon key has this host (${resolved?.scopes ?? 0} organisation scope(s) searched)`,
    };
    found.push({
      resource: {
        kind: "neon-project",
        ...(resolved?.id ? { id: resolved.id, name: resolved.name } : {}),
        host: hostMatch[1],
      },
      source: resolved?.id
        ? "DATABASE_URL host, resolved via Neon API"
        : `DATABASE_URL host (id unresolved: ${why[resolved?.reason] ?? "unknown"})`,
    });
  }

  // R2: bucket name + jurisdiction are spelled out by the env.
  if (env.R2_BUCKET_NAME) {
    const jurisdiction = /\.eu\.r2\.cloudflarestorage\.com/.test(env.R2_ENDPOINT || "")
      ? "eu"
      : "default";
    found.push({
      resource: { kind: "r2-bucket", name: env.R2_BUCKET_NAME, jurisdiction },
      source: "R2_BUCKET_NAME / R2_ENDPOINT",
    });
  }

  // Upstash: the REST host identifies the database.
  const upstash = /https?:\/\/([a-z0-9-]+\.upstash\.io)/.exec(env.UPSTASH_REDIS_REST_URL || "");
  if (upstash) {
    found.push({ resource: { kind: "upstash-db", name: upstash[1] }, source: "UPSTASH_REDIS_REST_URL" });
  }

  // Dedicated worker: wrangler.toml names it (aimed folder or repo root).
  try {
    const tomlPath = [PROJECT_DIR, RACINE]
      .map((b) => join(b, "wrangler.toml"))
      .find(existsSync);
    const toml = readFileSync(tomlPath, "utf8");
    const m = /^\s*name\s*=\s*"([^"]+)"/m.exec(toml);
    if (m) found.push({ resource: { kind: "cf-worker", name: m[1] }, source: "wrangler.toml" });
  } catch {
    /* none */
  }

  // GitHub: the origin remote.
  const remote = spawnSync("git", ["-C", PROJECT_DIR, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  });
  const gh = /github\.com[:/]([^/]+\/[^/.\s]+)/.exec((remote.stdout || "").trim());
  if (gh) found.push({ resource: { kind: "github-repo", name: gh[1] }, source: "git remote origin" });

  // Custom domain: the public app URL names the zone. Naive apex (last two
  // labels) - fine for .fr/.com/.io; a co.uk-style TLD needs a manual fix.
  const appUrl = env.NEXT_PUBLIC_APP_URL || env.APP_URL || "";
  try {
    const host = new URL(appUrl).hostname;
    if (host && !/\.vercel\.app$|localhost/.test(host)) {
      const apex = host.split(".").slice(-2).join(".");
      found.push({ resource: { kind: "dns-zone", name: apex }, source: "NEXT_PUBLIC_APP_URL" });
    }
  } catch {
    /* no usable URL */
  }

  const write = flag("--write");
  if (write && found.length) {
    const manifest = load() || emptyManifest();
    let added = 0;
    for (const f of found) {
      const entry = { ...f.resource, addedBy: "adopt", addedAt: new Date().toISOString().slice(0, 10) };
      const i = manifest.resources.findIndex((r) => sameResource(r, entry));
      if (i >= 0) {
        manifest.resources[i] = {
          ...manifest.resources[i],
          ...entry,
          addedBy: manifest.resources[i].addedBy,
          addedAt: manifest.resources[i].addedAt,
        };
      } else {
        manifest.resources.push(entry);
        added++;
      }
    }
    save(manifest);
    console.log(JSON.stringify({ ok: true, action: "adopted", found, added, file: FILE }));
    return;
  }
  console.log(
    JSON.stringify({ ok: true, action: "dry-run", found, file: FILE, hint: "re-run with --write to record" }),
  );
}

// --- dispatch --------------------------------------------------------------
if (command === "add") cmdAdd();
else if (command === "remove") cmdRemove();
else if (command === "list") cmdList();
else if (command === "adopt") await cmdAdopt();
else fail("usage: manifest.mjs <add|remove|list|adopt> --project-dir <dir> ...");
