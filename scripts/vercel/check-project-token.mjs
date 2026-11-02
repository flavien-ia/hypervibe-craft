#!/usr/bin/env node
// check-project-token.mjs - Is this Vercel key limited to ONE project, the linked one?
//
// Why this exists (3.4.22). /add-collab puts a Vercel key in the repository's secrets
// (VERCEL_TOKEN), for GitHub Actions to deploy. Anyone who can write to the repository can read
// that secret, by changing a workflow. Until 3.4.21 the key was an account-wide one: inviting a
// collaborator gave them every project of the owner's Vercel account, and their variables. The
// key must now be limited to the project (Vercel's dashboard: Create Token, scope the project
// alone; Vercel refuses to create a key from the CLI). This script checks it before it is posted.
//
//   printf '%s' "$KEY" | node check-project-token.mjs --project-dir <dir>
//
// The key is read on STANDARD INPUT only: never an argument (a command line is seen by every
// process of the machine, and lands in the conversation), never printed. The project is read in
// <dir>/.vercel/project.json (orgId, projectId).
//
// Measured on 2026-11-02 with a real project-limited key: GET /v9/projects/<id> answers 200, the
// project list holds that project alone, another project answers 404, /v2/user 404, and
// /v2/teams/<id> 403. Hence the checks, all read-only:
//   1. GET /v9/projects/<projectId>          200 with that id, or the key is refused ("invalide");
//   2. GET /v9/projects?limit=20             only that project, else "trop-large";
//   3. GET /v2/user                          anything but 200, else "trop-large" (an account key);
//   4. GET /v2/teams/<orgId> (a team only)   anything but 200, else "trop-large" (a team key, which
//      a team holding this project alone would not show in step 2).
// `teamId` is sent only when orgId is a team (`team_...`): an older account's personal project
// carries its user id as orgId, and the API takes no teamId for it (same rule as plan.mjs).
//
// Prints ONE JSON line: {ok, verdict, projectId, orgId, reason, ...}. Exit codes:
//   0 limitee      the key sees this project and nothing else: it may be posted
//   1 usage        no linked project, a key given as an argument, an unknown option
//   2 trop-large   the key sees more than this project: never posted
//   3 invalide     the key is refused on its own project (expired, mistyped, another project)
//   4 injoignable  Vercel did not answer: nothing could be checked
//   5 indeterminee an answer that proves nothing either way: not posted
//   6 absente      nothing on standard input: no request made
//
// Recettes only: HYPERVIBE_VERCEL_API aims the calls at a fake API on the loopback (the rule of
// _vercel-projects.mjs: an environment variable can never send the key to another host).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { vercelApiBase } from "../_vercel-projects.mjs";

const EXIT = { limitee: 0, usage: 1, "trop-large": 2, invalide: 3, injoignable: 4, indeterminee: 5, absente: 6 };
const TIMEOUT_MS = 15000;

function say(result) {
  process.stdout.write(JSON.stringify({ ok: result.verdict === "limitee", ...result }) + "\n");
  process.exitCode = EXIT[result.verdict] ?? 1;
}

function parseArgs(argv) {
  const out = { projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project-dir" && argv[i + 1]) out.projectDir = argv[++i];
    else if (/^--(?:token|key|api[-_]?token)\b/i.test(a)) return { error: "the key is read on standard input only, never as an argument" };
    // Never echoed: a key typed as an argument by mistake would be printed back.
    else return { error: "unknown argument (only --project-dir <dir>; the key goes on standard input)" };
  }
  return out;
}

function readLink(dir) {
  const file = join(dir, ".vercel", "project.json");
  if (!existsSync(file)) return null;
  try {
    const { orgId, projectId } = JSON.parse(readFileSync(file, "utf8"));
    return typeof orgId === "string" && orgId && typeof projectId === "string" && projectId ? { orgId, projectId } : null;
  } catch {
    return null;
  }
}

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => done(data));
    process.stdin.on("error", () => done(data));
  });
}

/** { status, data } - status 0 when nothing came back. The key travels in a header only. */
async function get(base, path, query, key) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString();
  try {
    const res = await fetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

const unreachable = (s) => s === 0 || s >= 500 || s === 429;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    say({ verdict: "usage", projectId: null, orgId: null, reason: args.error });
    return;
  }
  const dir = resolve(args.projectDir);
  const link = readLink(dir);
  if (!link) {
    say({ verdict: "usage", projectId: null, orgId: null, reason: `no linked Vercel project (.vercel/project.json) in ${dir}` });
    return;
  }
  const { orgId, projectId } = link;
  const key = (await readStdin()).trim();
  if (!key) {
    say({ verdict: "absente", projectId, orgId, reason: "nothing on standard input: no key was checked, nothing was sent" });
    return;
  }
  const base = vercelApiBase();
  const teamId = orgId.startsWith("team_") ? orgId : null;
  const scope = { teamId };

  // 1. Its own project.
  const own = await get(base, `/v9/projects/${encodeURIComponent(projectId)}`, scope, key);
  if (unreachable(own.status)) {
    say({ verdict: "injoignable", projectId, orgId, reason: `Vercel did not answer on the project (HTTP ${own.status || "none"})` });
    return;
  }
  if (own.status !== 200 || own.data?.id !== projectId) {
    say({ verdict: "invalide", projectId, orgId, reason: `the key is refused on its own project (HTTP ${own.status}): expired, mistyped, or limited to another project` });
    return;
  }

  // 2. What else it lists.
  const list = await get(base, "/v9/projects", { ...scope, limit: 20 }, key);
  if (unreachable(list.status)) {
    say({ verdict: "injoignable", projectId, orgId, reason: `Vercel did not answer on the project list (HTTP ${list.status || "none"})` });
    return;
  }
  if (list.status !== 200 || !Array.isArray(list.data?.projects)) {
    say({ verdict: "indeterminee", projectId, orgId, reason: `the project list could not be read (HTTP ${list.status}): nothing proves the key is limited` });
    return;
  }
  const others = list.data.projects.filter((p) => p && p.id !== projectId);
  if (others.length > 0 || list.data.pagination?.next) {
    say({
      verdict: "trop-large",
      projectId,
      orgId,
      reason: "the key sees other projects of the account",
      otherProjects: others.length,
      examples: others.slice(0, 5).map((p) => p.name).filter(Boolean),
    });
    return;
  }

  // 3. and 4. An account or team key that a single-project list would not betray.
  const user = await get(base, "/v2/user", {}, key);
  if (user.status === 200) {
    say({ verdict: "trop-large", projectId, orgId, reason: "the key reads the Vercel account itself (/v2/user): it is an account key" });
    return;
  }
  if (teamId) {
    const team = await get(base, `/v2/teams/${encodeURIComponent(teamId)}`, {}, key);
    if (team.status === 200) {
      say({ verdict: "trop-large", projectId, orgId, reason: "the key reads the whole team: it is a team key, not a project key" });
      return;
    }
    if (unreachable(team.status)) {
      say({ verdict: "injoignable", projectId, orgId, reason: `Vercel did not answer on the team (HTTP ${team.status || "none"})` });
      return;
    }
  }
  if (unreachable(user.status)) {
    say({ verdict: "injoignable", projectId, orgId, reason: `Vercel did not answer on the account (HTTP ${user.status || "none"})` });
    return;
  }
  say({ verdict: "limitee", projectId, orgId, reason: "the key sees this project and nothing else" });
}

await main();
