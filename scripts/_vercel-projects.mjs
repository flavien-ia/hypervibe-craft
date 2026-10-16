#!/usr/bin/env node
// _vercel-projects.mjs - Find, list and delete Vercel projects in EVERY scope
// of the account (each team, and the personal scope of older accounts),
// whatever team the Vercel CLI happens to be set to.
//
// Why this file exists. A Vercel project name is unique inside one scope, not
// across an account, and the CLI acts on the scope it is set to. Seen on
// 2026-09-17, on an account with a Hobby team and a Pro team:
//   - /delete-project ran `vercel project rm <name>` with no scope. The project
//     lived in the Hobby team, the CLI pointed at the Pro one: "not found".
//     Had the Pro team held a project of the same name, that one would have
//     been deleted instead.
//   - `vercel project rm` asks for confirmation even for a project that does
//     not exist, and a refused prompt still exits 0: its exit code proves
//     nothing.
//   - /bootstrap's name guard read the CLI's current team only, first page only.
// Also measured that day: on current accounts (`version: "northstar"`), an API
// call without teamId answers for the DEFAULT TEAM, not for a personal scope.
// A project is therefore attributed to the account its own record names
// (`accountId`), never to the scope that happened to list it.
//
// What every caller gets from here:
//   - a project is designated by its id AND its scope, never by its name alone;
//   - the REST API first (the CLI's stored token, or VERCEL_TOKEN); when it is
//     refused (expired token) or unreachable, the CLI takes over, with an
//     explicit --scope on every call;
//   - a deletion is reported once the project is checked gone;
//   - when several projects answer to one name, nothing here picks one.
//
// The context (vercelContext) carries the fetch function and the CLI runner:
// the recette replaces both to replay a multi-team account without network.
//
// Not a CLI: this module only exports helpers.

import { runCliAsync } from "./_spawn.mjs";
import { loadAuthToken, readCliCurrentTeam } from "./_vercel-auth.mjs";
import { normalizeName } from "./_match.mjs";
import { extractJson } from "./vercel/plan.mjs";

const PAGE_LIMIT = 100;
const MAX_PAGES = 30;
const CLI_TIMEOUT_MS = 60000;

// ─── context ───────────────────────────────────────────────────────────────

// Loopback only: an environment variable must never be able to send the
// user's token to another host. The recette aims it at its fake API.
export function vercelApiBase(env = process.env) {
  const override = env.HYPERVIBE_VERCEL_API;
  if (override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override)) return override;
  return "https://api.vercel.com";
}

export function vercelContext({
  token = loadAuthToken(),
  fetchImpl = globalThis.fetch,
  cli = runCliAsync,
  apiBase = vercelApiBase(),
  currentTeam,
} = {}) {
  let team = currentTeam;
  let user;
  const ctx = {
    token,
    apiBase,
    fetch: fetchImpl,
    cli,
    // The team the CLI falls back on without --scope (null: personal scope).
    currentTeam() {
      if (team === undefined) team = readCliCurrentTeam();
      return team;
    },
    // { username, northstar }. The username is also the --scope of a personal
    // scope; `northstar` accounts have no personal scope at all.
    async user() {
      if (user !== undefined) return user;
      user = { username: null, northstar: false };
      if (ctx.token) {
        const r = await rest(ctx, "GET", "/v2/user");
        if (r.status === 200 && r.data?.user) {
          user = { username: r.data.user.username || null, northstar: r.data.user.version === "northstar" };
          return user;
        }
      }
      const w = await cliJson(ctx, ["whoami", "--json"]);
      if (w.ok) user = { username: w.data.username || null, northstar: false };
      return user;
    },
  };
  return ctx;
}

// ─── transport ─────────────────────────────────────────────────────────────

// { status, data } - status 0 when no answer came back at all.
async function rest(ctx, method, path, query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  try {
    const res = await ctx.fetch(`${ctx.apiBase}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: { Authorization: `Bearer ${ctx.token}` },
    });
    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: { message: String(e) } } };
  }
}

// A refused token (expired, revoked) or no answer: the CLI, which owns the
// login and refreshes it, may still get through.
const cliMayHelp = (status) => status === 0 || status === 401 || status === 403;

function apiError(r) {
  const message = r.data?.error?.message;
  return `HTTP ${r.status}${message ? ` (${message})` : ""}`;
}

function lastLines(text, n = 3) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" / ")
    .slice(0, 300);
}

// The CLI prints its JSON on stdout, possibly after a notice line. `--json` is the option CLI 64
// documents (`--format json` lives on there as a hidden alias, and CLI 59 takes both): a CLI that
// refuses it is asked once more with `--format json`. An answer that asks for a choice instead of
// giving one (CLI 64, non-interactive, without --scope: {"status":"action_required","reason":
// "missing_scope"}) is a failure that says so: read as an empty list, it made a project that is
// still there look deleted (hypervibe-watch, 16/10/2026).
const refusesJsonFlag = (r) => r.status !== 0 && /unknown or unexpected option:?\s*--json\b/i.test(`${r.stdout || ""}\n${r.stderr || ""}`);

async function cliJson(ctx, args) {
  let r = await ctx.cli("vercel", args, { input: "", timeout: CLI_TIMEOUT_MS });
  const at = args.indexOf("--json");
  if (at >= 0 && refusesJsonFlag(r)) {
    r = await ctx.cli("vercel", [...args.slice(0, at), "--format", "json", ...args.slice(at + 1)], { input: "", timeout: CLI_TIMEOUT_MS });
  }
  const output = `${r.stdout || ""}\n${r.stderr || ""}`;
  const data = r.status === 0 ? extractJson(r.stdout) : null;
  if (data && typeof data === "object" && data.status === "action_required") {
    const why = [data.reason, data.message].filter(Boolean).join(": ") || "action_required";
    return { ok: false, data: null, output: `the CLI asks for a choice it cannot be given here (${why})` };
  }
  return { ok: data !== null && typeof data === "object", data, output };
}

// ─── scopes ────────────────────────────────────────────────────────────────
// A scope: { teamId (null for a personal scope), slug, name, personal }. For
// the CLI, a team is passed by id (accepted by --scope, and never stale), a
// personal scope by the username.

const teamScope = (t) => ({ teamId: t.id, slug: t.slug || null, name: t.name || t.slug || null, personal: false });
const personalScope = (username) => ({ teamId: null, slug: username || null, name: username || null, personal: true });
const scopeLabel = (s) => (s.personal ? "personal scope" : s.slug || s.teamId);

function describe(project, scope) {
  return {
    id: project.id ?? null,
    name: project.name,
    teamId: scope.teamId,
    teamSlug: scope.slug,
    teamName: scope.name,
    personal: scope.personal,
  };
}

// The account a REST project record names, whatever scope listed it.
function ownerScope(record, queried, teamsById, username) {
  const account = record.accountId;
  if (typeof account !== "string" || !account) return queried;
  if (account.startsWith("team_")) return teamsById.get(account) || teamScope({ id: account });
  return personalScope(username);
}

function scopeOfTarget(target, username) {
  return target.teamId
    ? teamScope({ id: target.teamId, slug: target.teamSlug, name: target.teamName })
    : personalScope(target.teamSlug || username);
}

async function scopesRest(ctx, extraTeamIds) {
  const teams = new Map();
  let until = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await rest(ctx, "GET", "/v2/teams", { limit: PAGE_LIMIT, until });
    if (r.status !== 200 || !r.data) return { ok: false, reason: `teams: ${apiError(r)}` };
    for (const t of r.data.teams || []) if (t.id) teams.set(t.id, teamScope(t));
    const next = r.data.pagination?.next;
    if (!next || next === until) break;
    until = next;
  }
  for (const id of extraTeamIds) if (id && !teams.has(id)) teams.set(id, teamScope({ id }));
  const user = await ctx.user();
  const scopes = [...teams.values()];
  if (!user.northstar) scopes.unshift(personalScope(user.username));
  return { ok: true, scopes, teams, username: user.username };
}

async function scopesCli(ctx, extraTeamIds) {
  const teams = new Map();
  let next = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ["teams", "ls", "--json", "--limit", String(PAGE_LIMIT)];
    if (next) args.push("--next", String(next));
    const r = await cliJson(ctx, args);
    // Only a list counts: any other answer is a failure that says what came instead.
    if (!r.ok || !Array.isArray(r.data.teams)) {
      const why = r.ok ? `no team list in the answer: ${lastLines(JSON.stringify(r.data))}` : lastLines(r.output);
      if (page === 0) return { ok: false, reason: `vercel teams ls: ${why}` };
      break;
    }
    for (const t of r.data.teams) if (t.id) teams.set(t.id, teamScope(t));
    const n = r.data.pagination?.next;
    if (!n || n === next) break;
    next = n;
  }
  for (const id of extraTeamIds) if (id && !teams.has(id)) teams.set(id, teamScope({ id }));
  const scopes = [...teams.values()];
  // A current account refuses its personal scope ("You cannot set your
  // Personal Account as the scope"): that refusal is not an error, see collect().
  const { username } = await ctx.user();
  if (username) scopes.unshift(personalScope(username));
  return { ok: true, scopes };
}

// ─── listings ──────────────────────────────────────────────────────────────

async function projectsRest(ctx, scope, teams, username) {
  const projects = [];
  let until = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await rest(ctx, "GET", "/v9/projects", { limit: PAGE_LIMIT, teamId: scope.teamId, until });
    if (r.status !== 200 || !r.data) return { ok: false, reason: apiError(r), projects };
    for (const p of r.data.projects || []) {
      if (p.id && p.name) projects.push(describe(p, ownerScope(p, scope, teams, username)));
    }
    const next = r.data.pagination?.next;
    if (!next || next === until) break;
    until = next;
  }
  return { ok: true, projects };
}

// `scopeArg` null lists the scope the CLI is set to: only callers that checked
// that this is the scope they mean may pass it.
async function projectsCli(ctx, scope, scopeArg = scope.teamId || scope.slug) {
  const projects = [];
  let next = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ["project", "ls", "--json", "--limit", String(PAGE_LIMIT)];
    if (scopeArg) args.push("--scope", scopeArg);
    if (next) args.push("--next", String(next));
    const r = await cliJson(ctx, args);
    if (!r.ok) return { ok: false, reason: lastLines(r.output), projects };
    // Only a list counts: an answer without one is not an empty scope, and an empty scope here is
    // what tells a deletion that its project is gone.
    if (!Array.isArray(r.data.projects)) return { ok: false, reason: `no project list in the answer: ${lastLines(JSON.stringify(r.data))}`, projects };
    for (const p of r.data.projects) if (p.id && p.name) projects.push(describe(p, scope));
    const n = r.data.pagination?.next;
    if (!n || n === next) break;
    next = n;
  }
  return { ok: true, projects };
}

// CLIs without JSON output print a table, and only for the scope they are set
// to. The first column is read as project names; the noise set drops the
// decoration around it ("To display the next page..." once read as a project
// named "to").
const TABLE_NOISE = new Set(["vercel", "project", "projects", "name", "latest", "production", "preview", "https", "http", "error", "warn", "updated", "update", "age", "url", "source", "node", "fetching", "retrieving", "deployments", "deployment", "found", "no", "to"]);

export function parseProjectTable(text) {
  const names = [];
  for (const line of String(text || "").split("\n")) {
    if (names.length >= 500) break;
    const tok = normalizeName(line.trim().split(/\s+/)[0] || "");
    if (!tok || tok.length < 2) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tok) || /^[0-9]+$/.test(tok) || TABLE_NOISE.has(tok)) continue;
    if (!names.includes(tok)) names.push(tok);
  }
  return names;
}

async function projectsCliTable(ctx, scopeArg) {
  const names = [];
  let next = null;
  for (let page = 0; page < 25; page++) {
    const args = ["projects", "ls"];
    if (scopeArg) args.push("--scope", scopeArg);
    if (next) args.push("--next", next);
    const r = await ctx.cli("vercel", args, { input: "", timeout: CLI_TIMEOUT_MS });
    // The table goes to STDERR: both streams are read.
    const text = `${r.stdout || ""}\n${r.stderr || ""}`;
    if (r.status !== 0) {
      if (page === 0) return { ok: false, reason: lastLines(text) };
      break;
    }
    for (const n of parseProjectTable(text)) if (!names.includes(n)) names.push(n);
    // "To display the next page, run `vercel project ls --next 1783722597337`"
    const m = text.match(/--next\s+(\d+)/);
    if (!m || m[1] === next) break;
    next = m[1];
  }
  return { ok: true, names };
}

// One project per id. A personal scope may not exist (current accounts): a
// refusal there is not an error. `readable` is false when no scope at all
// could be read, which sends the caller to its next way of listing.
function collect(scopes, lists) {
  const byId = new Map();
  const errors = [];
  let readable = false;
  lists.forEach((r, i) => {
    for (const p of r.projects) if (!byId.has(p.id)) byId.set(p.id, p);
    if (r.ok) readable = true;
    else if (!scopes[i].personal) errors.push(`${scopeLabel(scopes[i])}: ${r.reason}`);
  });
  return { readable, projects: [...byId.values()], scopes, errors, partial: errors.length > 0 };
}

// Every project of the account, each with its own scope.
//   { ok, via: "rest" | "cli" | "cli-table", projects, scopes, errors, partial,
//     partialReason?, restFallbackReason?, reason? }
// `partial`: some team could not be read, so absence from `projects` proves
// nothing for it. `extraTeamIds` adds teams the listing may not show (the
// team of a linked folder).
export async function listAllProjects(ctx, { extraTeamIds = [] } = {}) {
  const tried = [];
  if (ctx.token) {
    const s = await scopesRest(ctx, extraTeamIds);
    if (s.ok) {
      const lists = await Promise.all(s.scopes.map((scope) => projectsRest(ctx, scope, s.teams, s.username)));
      const out = collect(s.scopes, lists);
      if (out.readable) return { ok: true, via: "rest", ...out };
      tried.push(`REST: ${out.errors.join(", ")}`);
    } else {
      tried.push(`REST: ${s.reason}`);
    }
  } else {
    tried.push("REST: no Vercel token (run `vercel login`)");
  }

  const c = await scopesCli(ctx, extraTeamIds);
  if (c.ok) {
    const lists = [];
    for (const scope of c.scopes) lists.push(await projectsCli(ctx, scope));
    const out = collect(c.scopes, lists);
    if (out.readable) return { ok: true, via: "cli", ...out, restFallbackReason: tried.join(" | ") };
    tried.push(`CLI: ${out.errors.join(", ")}`);
  } else {
    tried.push(`CLI: ${c.reason}`);
  }

  // Last resort, a CLI without JSON output: the table of the scope it is set to.
  const team = ctx.currentTeam();
  const t = await projectsCliTable(ctx, team);
  if (t.ok) {
    const scope = team ? teamScope({ id: team }) : personalScope(null);
    return {
      ok: true,
      via: "cli-table",
      projects: t.names.map((name) => ({ ...describe({ id: null, name }, scope), legacy: true })),
      scopes: [scope],
      errors: [],
      partial: true,
      partialReason: "this Vercel CLI cannot list in JSON: only the team it is set to was read (updating the CLI shows every team)",
      restFallbackReason: tried.join(" | "),
    };
  }
  tried.push(`CLI table: ${t.reason}`);
  return { ok: false, reason: tried.join(" | ") };
}

// ─── one project ───────────────────────────────────────────────────────────

// How the CLI reaches a target's scope: { ok, arg } (arg null = no --scope).
async function scopeForCli(ctx, target) {
  if (target.teamId) return { ok: true, arg: target.teamId };
  const username = target.teamSlug || (await ctx.user()).username;
  if (username) return { ok: true, arg: username };
  // Without a username, a bare command reaches the personal scope only when
  // the CLI is set to it. Set to a team, it would aim at that team.
  if (ctx.currentTeam() === null) return { ok: true, arg: null };
  return { ok: false, reason: "personal project, but the Vercel CLI is set to a team and the account name is unknown" };
}

// Is this project (by id, in its scope) still there?
//   { status: "found", project } | { status: "missing" } | { status: "unknown", reason }
// Only a JSON answer counts: a table that fails to parse would read as
// "missing", and "missing" makes callers stop.
export async function getProject(ctx, target) {
  if (!target.id) return { status: "unknown", reason: "no project id" };
  if (ctx.token) {
    const r = await rest(ctx, "GET", `/v9/projects/${encodeURIComponent(target.id)}`, { teamId: target.teamId });
    if (r.status === 200 && r.data?.id) {
      const { username } = await ctx.user();
      const known = scopeOfTarget(target, username);
      const teams = new Map(known.teamId ? [[known.teamId, known]] : []);
      return { status: "found", via: "rest", project: describe(r.data, ownerScope(r.data, known, teams, username)) };
    }
    if (r.status === 404) return { status: "missing", via: "rest" };
    if (!cliMayHelp(r.status)) return { status: "unknown", reason: apiError(r) };
  }
  const scope = await scopeForCli(ctx, target);
  if (!scope.ok) return { status: "unknown", reason: scope.reason };
  const listed = await projectsCli(ctx, scopeOfTarget(target, scope.arg), scope.arg);
  if (!listed.ok) return { status: "unknown", reason: `vercel project ls: ${listed.reason}` };
  const hit = listed.projects.find((p) => p.id === target.id);
  return hit ? { status: "found", via: "cli", project: hit } : { status: "missing", via: "cli" };
}

async function verifyGone(ctx, target, via) {
  const check = await getProject(ctx, target);
  if (check.status === "missing") return { status: "deleted", via, verified: true };
  if (check.status === "found") {
    return { status: "failed", via, verified: false, error: "the project is still there after the deletion" };
  }
  return { status: "deleted", via, verified: false, note: `deletion accepted, but it could not be checked: ${check.reason}` };
}

async function deleteWithCli(ctx, target) {
  const scope = await scopeForCli(ctx, target);
  if (!scope.ok) return { status: "failed", via: "cli", error: `${scope.reason}: nothing was deleted` };
  // The CLI deletes by name: read it again from the id, so that a project
  // renamed since the inventory never hands its old name to a newcomer.
  let name = target.name;
  const current = await getProject(ctx, target);
  if (current.status === "missing") return { status: "absent", via: "cli", verified: true };
  if (current.status === "found") name = current.project.name;
  // "unknown" (a CLI that cannot list in JSON): the recorded name with an
  // explicit scope still designates one project, names being unique per scope.
  const args = ["project", "rm", name];
  if (scope.arg) args.push("--scope", scope.arg);
  const r = await ctx.cli("vercel", args, { input: "y\n", timeout: 120000 });
  const output = `${r.stdout || ""}\n${r.stderr || ""}`;
  // The prompt comes even for a project that does not exist, and a refusal
  // exits 0: only the success line counts, then the check.
  if (r.status !== 0 || !/success/i.test(output)) {
    return { status: "failed", via: "cli", error: lastLines(output) || `exit ${r.status}` };
  }
  if (!target.id) return { status: "deleted", via: "cli", verified: false, note: "no project id to check against" };
  return verifyGone(ctx, target, "cli");
}

// Deletes ONE project designated by its id and scope (`teamId`, null for a
// personal scope). A legacy target (no id, read from an old CLI's table) is
// deleted by name, with its scope made explicit.
//   { status: "deleted" | "absent" | "failed", via, verified, error?, note? }
export async function deleteProject(ctx, target) {
  if (target.id && ctx.token) {
    const r = await rest(ctx, "DELETE", `/v9/projects/${encodeURIComponent(target.id)}`, { teamId: target.teamId });
    if (r.status === 404) return { status: "absent", via: "rest", verified: true };
    if (r.status >= 200 && r.status < 300) return verifyGone(ctx, target, "rest");
    if (!cliMayHelp(r.status)) return { status: "failed", via: "rest", error: apiError(r) };
  }
  return deleteWithCli(ctx, target);
}

// ─── which project a deletion aims at ──────────────────────────────────────

// `linked`: the folder's link, checked ({ projectId, status: "found" |
// "missing" | "unknown", project? }). `projects`: every project of the account.
// The link, when it resolves, designates THE project, whatever its name.
// Otherwise the exact name designates candidates: several of them, or one
// while the link could not be checked (so it may point elsewhere), is a
// choice for the user.
//   { targets, ambiguous, nameMismatch, homonyms }
export function pickTargets({ name, linked = null, projects = [] }) {
  const wanted = normalizeName(name);
  const sameName = projects.filter((p) => normalizeName(p.name) === wanted);
  if (linked && linked.status === "found" && linked.project) {
    const target = { ...linked.project, via: "link" };
    return {
      targets: [target],
      ambiguous: false,
      nameMismatch: normalizeName(target.name) !== wanted,
      homonyms: sameName.filter((p) => p.id !== target.id),
    };
  }
  return {
    targets: sameName.map((p) => ({ ...p, via: "name" })),
    ambiguous: sameName.length > 1 || (linked?.status === "unknown" && sameName.length > 0),
    nameMismatch: false,
    homonyms: [],
  };
}
