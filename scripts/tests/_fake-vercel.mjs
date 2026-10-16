#!/usr/bin/env node
// _fake-vercel.mjs - A Vercel account held in a JSON object, for the recettes.
//
// Two faces over the same state: `fakeRest` answers like the REST API,
// `fakeCli` like the CLI (v59 output shapes, read on 2026-09-17, and the two
// v64 ones read on 2026-10-16: `--json` documented, a listing without --scope
// that asks for one instead of answering), with the traps the real ones set:
//   - a command without --scope acts on the CLI's `currentTeam`;
//   - an API call without teamId lands on the DEFAULT TEAM of a current
//     ("northstar") account, and a current account refuses its personal scope;
//   - `project rm` prompts for any name, existing or not, and a refused
//     prompt exits 0.
// Launched as a program (the `vercel` stand-in of test-vercel-projects.mjs),
// it plays the CLI on the state file named by FAKE_VERCEL_STATE, and records
// every call in it.

import { readFileSync, writeFileSync } from "node:fs";

export const GOOD_TOKEN = "jeton-de-recette";

// A cursor is the index of the first item of the page, plus one.
function page(list, limit, cursor) {
  const n = Number(cursor);
  const start = Number.isFinite(n) && n > 0 ? n - 1 : 0;
  const size = Math.max(1, Math.min(Number(limit) || 20, 100));
  const items = list.slice(start, start + size);
  const end = start + size;
  return { items, next: end < list.length ? end + 1 : null };
}

const isNorthstar = (state) => state.user.version === "northstar";
// Where a scope-less request lands: the default team of a current account,
// the personal account of an older one.
const implicitAccount = (state) => (isNorthstar(state) ? state.user.defaultTeamId : state.user.id);
const inAccount = (state, account) => state.projects.filter((p) => p.accountId === account);
const asRecord = (p) => ({ id: p.id, name: p.name, accountId: p.accountId });

export function fakeRest(state, method, rawUrl, authorization) {
  const url = new URL(rawUrl);
  const q = url.searchParams;
  const teamId = q.get("teamId");
  state.calls.push({ via: "rest", method, path: url.pathname, teamId });
  if (!state.tokenValid || authorization !== `Bearer ${GOOD_TOKEN}`) {
    return { status: 401, body: { error: { code: "forbidden", message: "Not authorized" } } };
  }
  let account = implicitAccount(state);
  if (teamId) {
    if (!state.teams.some((t) => t.id === teamId)) {
      return { status: 403, body: { error: { code: "forbidden", message: "You don't have access to this team" } } };
    }
    account = teamId;
  }
  if (method === "GET" && url.pathname === "/v2/user") return { status: 200, body: { user: { ...state.user } } };
  if (method === "GET" && url.pathname === "/v2/teams") {
    const { items, next } = page(state.teams, q.get("limit"), q.get("until"));
    return { status: 200, body: { teams: items, pagination: { count: items.length, next } } };
  }
  if (method === "GET" && url.pathname === "/v9/projects") {
    const { items, next } = page(inAccount(state, account), q.get("limit"), q.get("until"));
    return { status: 200, body: { projects: items.map(asRecord), pagination: { count: items.length, next } } };
  }
  const m = url.pathname.match(/^\/v9\/projects\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const i = state.projects.findIndex((p) => p.id === id && p.accountId === account);
    if (i < 0) return { status: 404, body: { error: { code: "not_found", message: "Project not found" } } };
    if (method === "GET") return { status: 200, body: asRecord(state.projects[i]) };
    if (method === "DELETE") {
      state.projects.splice(i, 1);
      return { status: 204 };
    }
  }
  return { status: 400, body: { error: { message: `unexpected ${method} ${url.pathname}` } } };
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

export function fakeCli(state, args, input = "") {
  state.calls.push({ via: "cli", args: [...args], input });
  const out = (stdout, stderr = "", status = 0) => ({ status, stdout, stderr });
  const json = args.includes("--format") || args.includes("--json");
  // A CLI without JSON output names the first option it does not know.
  if (json && !state.cliJson) return out("", `Error: unknown or unexpected option: ${args.includes("--json") ? "--json" : "--format"}\n`, 2);
  // A CLI that has `--format json` but not yet `--json`.
  if (args.includes("--json") && state.cliJsonFlag === false) return out("", "Error: unknown or unexpected option: --json\n", 2);

  // What --scope, or its absence, designates.
  const scopeKey = flagValue(args, "--scope");
  const resolveScope = () => {
    if (!scopeKey) {
      const team = state.teams.find((t) => t.id === state.currentTeam);
      return team ? { account: team.id, label: team.slug } : { account: state.user.id, label: state.user.username };
    }
    const team = state.teams.find((t) => t.id === scopeKey || t.slug === scopeKey);
    if (team) return { account: team.id, label: team.slug };
    if (scopeKey === state.user.username) {
      if (isNorthstar(state)) return { error: "Error: You cannot set your Personal Account as the scope." };
      return { account: state.user.id, label: state.user.username };
    }
    return { error: "Error: The specified scope does not exist" };
  };

  const [a0, a1] = args;
  // CLI 64, non-interactive: a project command without --scope asks for one instead of acting,
  // and says so in JSON with a success exit code.
  if (state.scopeRequired && !scopeKey && (a0 === "project" || a0 === "projects")) {
    return out(JSON.stringify({ status: "action_required", reason: "missing_scope", message: "Use --scope to choose a team or your personal account." }, null, 2));
  }
  // An answer of another shape than a list, without any request for a choice.
  if (state.listWithoutProjects && (a0 === "project" || a0 === "projects") && (a1 === "ls" || a1 === "list")) {
    return out(JSON.stringify({ contextName: "equipe-gratuite" }, null, 2));
  }
  if (a0 === "whoami") {
    const team = state.teams.find((t) => t.id === state.currentTeam) || null;
    return json
      ? out(JSON.stringify({ team, username: state.user.username, email: null, name: null }, null, 2))
      : out(`${state.user.username}\n`);
  }
  if (a0 === "teams" && (a1 === "ls" || a1 === "list")) {
    const { items, next } = page(state.teams, flagValue(args, "--limit"), flagValue(args, "--next"));
    const teams = items.map((t) => ({ ...t, current: t.id === state.currentTeam }));
    return out(JSON.stringify({ teams, pagination: { count: items.length, next } }, null, 2));
  }
  if ((a0 === "project" || a0 === "projects") && (a1 === "ls" || a1 === "list")) {
    const s = resolveScope();
    if (s.error) return out("", `${s.error}\n`, 1);
    const { items, next } = page(inAccount(state, s.account), flagValue(args, "--limit") || 20, flagValue(args, "--next"));
    if (json) {
      const projects = items.map((p) => ({ id: p.id, name: p.name, updatedAt: 0 }));
      return out(JSON.stringify({ projects, pagination: { count: items.length, next }, contextName: s.label }, null, 2));
    }
    const rows = items.map((p) => `  ${p.name}   https://${p.name}.vercel.app   1d`).join("\n");
    const hint = next ? `\nTo display the next page, run \`vercel project ls --next ${next}\`\n` : "\n";
    return out("", `Vercel CLI 59.0.0\n> Projects found under ${s.label}\n\n  Project Name   Latest Production URL   Updated\n${rows}\n${hint}`);
  }
  if (a0 === "project" && (a1 === "rm" || a1 === "remove")) {
    const name = args[2];
    const prompt = `The project ${name} will be removed permanently.\n? Are you sure? (y/N) `;
    if (state.rmIgnoresInput || !/^y/i.test(input)) return out("> User abort\n", prompt);
    const s = resolveScope();
    if (s.error) return out("", `${prompt}\n${s.error}\n`, 1);
    const i = state.projects.findIndex((p) => p.name === name && p.accountId === s.account);
    if (i < 0) return out("", `${prompt}\nError: Project not found (404)\n`, 1);
    state.projects.splice(i, 1);
    return out(`> Success! Project ${name} removed [12ms]\n`, prompt);
  }
  return out("", `Error: unexpected command: vercel ${args.join(" ")}\n`, 2);
}

// Launched as the `vercel` stand-in: one call, on the state file.
// ─── Launched as a script, or imported ────────────────────────────────────────
// Node gives a module its real path and keeps in argv[1] the path as it was typed. Compared as
// they come, the two differ as soon as the plugin is reached through a symbolic link (macOS's
// temporary folder, a ~/.claude kept by a configuration repository): the script then did
// nothing and exited 0, "I could not" read as "nothing to report" (outside review, 3.3.9).
// Both are read to their real path. The same block in every script, held by
// scripts/tests/test-entry-point.mjs.
import { realpathSync as realPathOf } from "node:fs";
import { fileURLToPath as pathOfUrl } from "node:url";
function launchedDirectly() {
  try {
    if (!process.argv[1]) return false;
    const self = realPathOf(pathOfUrl(import.meta.url));
    const launched = realPathOf(process.argv[1]);
    return process.platform === "win32" ? self.toLowerCase() === launched.toLowerCase() : self === launched;
  } catch {
    return false;
  }
}

const invokedDirectly = launchedDirectly();
if (invokedDirectly) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const file = process.env.FAKE_VERCEL_STATE;
  const state = JSON.parse(readFileSync(file, "utf8"));
  const r = fakeCli(state, process.argv.slice(2), input);
  writeFileSync(file, JSON.stringify(state, null, 2));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.status;
}
