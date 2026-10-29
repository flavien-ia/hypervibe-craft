#!/usr/bin/env node
// check-name-collision.mjs - /bootstrap name guard.
//
// Before creating a project, verify the proposed name does not TOKEN-collide
// with an existing project on this account. A collision is exactly what forces
// /delete-project to fall back on its (imperfect) ownership heuristic later:
// deleting "street" would otherwise sweep up everything of "street-cool". We
// catch it at creation, where it is cheap to fix, and propose token-disjoint
// alternatives when the name can be auto-disambiguated.
//
// Existing names come from the same four sources as the /delete-project
// ownership pass, so the two skills agree on what "collides" means:
//   1. the shared-worker registry (~/.hypervibe-jobs/jobs.js): ping `project`
//      fields + snapshot target names,
//   2. sibling folders of the parent dir (where the project will be created),
//   3. the Neon project list (REST),
//   4. the Vercel project list, every team (REST, CLI fallback).
// Every source is fault-tolerant: a missing key or an absent CLI just drops
// that source (reported in `sources`), it never aborts the guard.
//
// Usage:
//   node check-name-collision.mjs --name <kebab> [--parent-dir <path>]
//
// Output: a single JSON object on stdout. A collision is NOT an error (exit 0):
// the caller decides what to do. Exit 1 only on a usage error (missing/invalid
// --name).
//
//   {
//     "proposed": "street",
//     "normalized": "street",
//     "status": "ok" | "exact" | "subset" | "superset" | "both",
//     "collisions": [ { "name": "street-cool", "relation": "proposed-is-subset-of" } ],
//     "suggestions": ["street-app", "street-web"],
//     "existingCount": 42,
//     "sources": { "registry": true, "siblings": true, "neon": true, "vercel": false },
//     "notes": [ ... ]
//   }
//
// Relations (from the proposed name's point of view):
//   exact                  -> a project with this exact name already exists.
//   proposed-is-subset-of  -> the name is a token inside a LONGER existing name
//                             (deleting it later is the dangerous direction ->
//                             auto-fixable by lengthening, suggestions given).
//   proposed-is-superset-of-> the name CONTAINS a shorter existing name as a
//                             token (cannot be auto-disambiguated by affixing;
//                             suggestions may be empty -> the caller warns).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readUserEnv } from "./_read-user-env.mjs";
import { tokenMatches, normalizeName } from "./_match.mjs";
import { getSecret } from "./vault/vault.mjs";
import { resolveNeonOrg, withOrg } from "./neon-org.mjs";
import { vercelContext, listAllProjects } from "./_vercel-projects.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const NAME = arg("--name");
const PARENT_DIR = arg("--parent-dir") || process.cwd();
if (!NAME) {
  console.error("Usage: node check-name-collision.mjs --name <kebab> [--parent-dir <path>]");
  process.exit(1);
}
// Same kebab constraint as bootstrap-init.mjs (2-50 chars), so a name that
// passes the guard is guaranteed creatable.
if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(NAME)) {
  console.error(`--name must be kebab-case (lowercase a-z, 0-9, -), 2-50 chars. Got: ${NAME}`);
  process.exit(1);
}
const P = normalizeName(NAME);

// ─── sources ─────────────────────────────────────────────────────────────
function fromRegistry() {
  const jobsPath = join(homedir(), ".hypervibe-jobs", "jobs.js");
  if (!existsSync(jobsPath)) return { names: [], ok: false };
  try {
    const raw = readFileSync(jobsPath, "utf8");
    const m = raw.match(/export default\s*([\s\S]*?);?\s*$/);
    if (!m) return { names: [], ok: false };
    const reg = JSON.parse(m[1]);
    const names = [];
    for (const j of reg.jobs || []) {
      if (j.kind === "ping" && j.project) names.push(j.project);
      if (j.kind === "snapshot") for (const t of j.targets || []) if (t.name) names.push(t.name);
    }
    return { names, ok: true };
  } catch {
    return { names: [], ok: false };
  }
}

function fromSiblings() {
  try {
    const names = [];
    for (const e of readdirSync(PARENT_DIR, { withFileTypes: true })) {
      if (names.length >= 500) break;
      if (e.isDirectory() && !e.name.startsWith(".")) names.push(e.name);
    }
    return { names, ok: true };
  } catch {
    return { names: [], ok: false };
  }
}

// Neon scopes /projects to ONE organisation. Reading it without saying which does not
// fail, it answers for the account's DEFAULT organisation - so an account whose projects
// live in an organisation it created got an empty list here, and this guard then
// announced "no collision" with full confidence. A guard that cannot see is worse than
// no guard, hence the note when the organisation cannot be decided.
async function fromNeon() {
  // The vault is the source of truth since the key migration; the legacy env var stays
  // as a fallback. Reading only the env var made this source silently unavailable on
  // any machine set up after that migration.
  const lireCoffre = (item, field) => {
    try { return getSecret(item, field) || ""; } catch { return ""; }
  };
  const key = lireCoffre("NEON", "api_key") || readUserEnv("NEON_API_KEY") || "";
  if (!key) return { names: [], ok: false };
  try {
    const org = await resolveNeonOrg(key, lireCoffre);
    const url = withOrg("https://console.neon.tech/api/v2/projects?limit=400", org.orgId);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return { names: [], ok: false };
    const data = await res.json();
    const note = org.source === "ambigu"
      ? `This Neon account belongs to several organisations (${org.orgs.map((o) => o.name).join(", ")}): only the default one was read, so a clash in another cannot be seen. Store the right organisation id in the vault (item NEON, field org_id) or re-run /start.`
      : null;
    return { names: (data.projects || []).map((p) => p.name).filter(Boolean), ok: true, note };
  } catch {
    return { names: [], ok: false };
  }
}

// Every project of every Vercel team, all pages: the same listing as /delete-project
// (_vercel-projects.mjs), so that both skills see the same names. Reading
// `vercel projects ls` here saw the CLI's current team only, and its first
// page only (20 projects).
async function fromVercel() {
  try {
    const listing = await listAllProjects(vercelContext());
    if (!listing.ok) return { names: [], ok: false };
    return {
      names: listing.projects.map((p) => p.name),
      ok: true,
      note: listing.partial
        ? `Some Vercel teams could not be read (${listing.partialReason || listing.errors.join(", ")}): a clash there cannot be seen.`
        : null,
    };
  } catch {
    return { names: [], ok: false };
  }
}

// ─── suggestion generator ──────────────────────────────────────────────────
const AFFIXES = ["app", "web", "site", "hq", "studio", "pro", "io", "hub", "2", "3", "4"];

function isKebabLen(s) {
  return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(s);
}

// A candidate is a SAFE suggestion when its own future deletion cannot sweep a
// sibling, i.e. it is not a token-SUBSET of any existing name (the dangerous
// direction) and not an exact dupe. Being a token-SUPERSET of an existing name
// is allowed: that is the natural disambiguation for an exact clash
// ("cool-trattoria" -> "cool-trattoria-2"), and the /delete-project ownership
// pass already protects the longer name against the shorter one.
function isSafeSuggestion(cand, existing) {
  const c = normalizeName(cand);
  for (const e of existing) {
    if (!e) continue;
    if (c === e) return false;
    if (tokenMatches(c, e)) return false; // c is a subset of e -> dangerous
  }
  return true;
}

// Only meaningful for `exact` and `subset`. For `superset`/`both` the proposed
// name CONTAINS a shorter existing name as a token, which no affix can remove,
// so we return [] and let the caller warn + ask for a different name.
function buildSuggestions(existing) {
  const out = [];
  const seen = new Set();
  for (const affix of AFFIXES) {
    for (const cand of [`${P}-${affix}`, `${affix}-${P}`]) {
      if (seen.has(cand) || !isKebabLen(cand)) continue;
      seen.add(cand);
      if (isSafeSuggestion(cand, existing)) out.push(cand);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

// ─── orchestration ─────────────────────────────────────────────────────────
const registry = fromRegistry();
const siblings = fromSiblings();
const [vercel, neon] = await Promise.all([fromVercel(), fromNeon()]);

const sources = { registry: registry.ok, siblings: siblings.ok, neon: neon.ok, vercel: vercel.ok };
const notes = [];
if (!neon.ok) notes.push("Neon project list unavailable (key locked/absent): a Neon-only name clash cannot be seen.");
if (neon.note) notes.push(neon.note);
if (!vercel.ok) notes.push("Vercel project list unavailable (CLI not logged in?): a Vercel-only name clash cannot be seen.");
if (vercel.note) notes.push(vercel.note);

// Dedup the existing names (normalized).
const existing = [...new Set(
  [...registry.names, ...siblings.names, ...neon.names, ...vercel.names].map(normalizeName).filter(Boolean),
)];

// Classify every collision from the proposed name's point of view.
const collisions = [];
let hasExact = false, hasSubset = false, hasSuperset = false;
for (const e of existing) {
  if (e === P) {
    collisions.push({ name: e, relation: "exact" });
    hasExact = true;
  } else if (tokenMatches(P, e)) {
    // P appears as a whole token inside the longer name e.
    collisions.push({ name: e, relation: "proposed-is-subset-of" });
    hasSubset = true;
  } else if (tokenMatches(e, P)) {
    // The shorter existing name e appears as a token inside P.
    collisions.push({ name: e, relation: "proposed-is-superset-of" });
    hasSuperset = true;
  }
}

let status = "ok";
if (hasExact) status = "exact";
else if (hasSubset && hasSuperset) status = "both";
else if (hasSubset) status = "subset";
else if (hasSuperset) status = "superset";

// Auto-disambiguation is only possible when we can affix the name without
// leaving a contained sibling token: that is the exact and subset cases. For
// superset/both, the name wraps a shorter existing project name and must be
// changed by hand.
const suggestions = (status === "exact" || status === "subset") ? buildSuggestions(existing) : [];

console.log(JSON.stringify({
  proposed: NAME,
  normalized: P,
  status,
  collisions,
  suggestions,
  existingCount: existing.length,
  sources,
  notes,
}, null, 2));
