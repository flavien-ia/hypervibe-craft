#!/usr/bin/env node
// guard-bash.mjs - PreToolUse hook: reads the shell command Claude is about to
// run and either lets it through, asks the user, or refuses it with the
// correct alternative.
//
// Two tools run a shell: Bash, and Monitor (a background watcher whose
// `command` is a shell script too). A guard that only watched Bash left the
// other door open (outside review, 3.0.4): hooks.json matches both, and this
// file accepts both. Same input field, same decision.
//
// Contract (Claude Code):
//   stdin  {"tool_name":"Bash"|"Monitor","tool_input":{"command":"..."},...}
//   stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//           "permissionDecision":"deny"|"ask","permissionDecisionReason":"..."}}
//   exit 0 with no output = no decision, the normal permission flow applies.
//
// FAIL-OPEN, on purpose. This runs before EVERY Bash call: a crash here would
// wedge the whole session. It is a seatbelt, not an airlock. Anything
// unexpected leaves through exit 0 with a line on stderr, and the guard that
// really cannot be bypassed lives in the scripts themselves (run-sql.mjs,
// execute-deletions.mjs), which is also what protects hosts that have no hooks
// at all, Codex included.
//
// The rules are loaded INSIDE the safety net, never by a static import: a
// static import is resolved before any line of this file runs, so a missing
// neighbour (a hooks/ folder copied alone, an interrupted install, a synced
// folder that prunes) let every command through behind a Node stack trace
// instead of this file's own line (outside review, 3.2.6).

import { execFileSync } from "node:child_process";

/** The tools whose `command` is executed by a shell. */
const SHELL_TOOLS = new Set(["Bash", "Monitor"]);

// ─── The commits a push sends (3.4.16 / 2.4.15) ───────────────────────────────
// On 21/10/2026, a "yes, push" given for one commit also sent two commits that another session
// had made in the same repository. When the push rule asks, its question now names the commits
// that leave: `git log --oneline @{u}..HEAD`, in the session's folder (the hook's `cwd`) or the
// one the command names with -C. Only for a push this file reads whole: one command,
// `git [-C <dir>] push`, flags that change nothing of what leaves, and as words either the remote
// of its upstream alone, or a remote and a branch written plainly (`git push origin main`, the
// most common form: `<remote>/<branch>..<branch>`, when the remote's reference exists). Any other
// refspec, a missing upstream or remote reference, an error or two seconds of git: the question
// stays as it was, silent, since a wrong list would be worse than none. The decision itself never
// depends on this: rules.mjs stays pure, and git runs only on a push's question.

/** Flags of `git push` that leave the commits it sends as they are. */
const PUSH_FLAGS = new Set([
  "-f", "--force", "--force-with-lease", "--force-if-includes", "-u", "--set-upstream",
  "-v", "--verbose", "-q", "--quiet", "--atomic", "--no-atomic", "--follow-tags",
  "--no-follow-tags", "--progress", "--no-progress", "--thin", "--no-thin", "--signed",
  "--no-signed", "-4", "-6", "--ipv4", "--ipv6",
]);

/** A command line split into words as the shell would, for plain lines only: null when it holds
 *  what this reading does not follow (an operator, a redirection, a variable, a substitution, a
 *  backslash outside double quotes, an unbalanced quote). */
function plainWords(line) {
  if (/[;&|<>`\r\n]|\$/.test(line)) return null;
  const words = [];
  let word = "";
  let started = false;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) word += line[(i += 1)];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\") {
      return null;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** {dir, remote} of a push read whole, or null. */
function plainPush(command) {
  const words = plainWords(String(command ?? "").trim());
  if (!words || words[0] !== "git") return null;
  let i = 1;
  let dir = null;
  while (i < words.length && words[i] !== "push") {
    if (words[i] === "-C" && dir === null && i + 1 < words.length) {
      dir = words[i + 1];
      i += 2;
      continue;
    }
    return null;
  }
  if (words[i] !== "push") return null;
  const operands = [];
  for (const w of words.slice(i + 1)) {
    if (w.startsWith("-")) {
      if (!PUSH_FLAGS.has(w.split("=")[0])) return null;
      continue;
    }
    operands.push(w);
  }
  if (operands.length > 2) return null;
  // `git push <remote> <branch>`, both written plainly; any other refspec keeps the question.
  if (operands.length === 2 && !(PLAIN_REMOTE.test(operands[0]) && PLAIN_BRANCH.test(operands[1]))) return null;
  return { dir, remote: operands[0] ?? null, branch: operands[1] ?? null };
}

/** A remote's name and a branch's name, written plainly: no refspec syntax (`:`, `+`, `^`, `~`,
 *  `..`, a trailing `/` or `.`). */
const PLAIN_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAIN_BRANCH = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._\/-]*(?<![./])$/;

/** A commit's line as it may be shown: no control character, not longer than 90 characters. */
function shown(line) {
  const flat = line.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat;
}

/** The sentence added to a push's question, or null. Never throws. */
function outgoingCommits(command, cwd) {
  try {
    const push = plainPush(command);
    if (!push) return null;
    const git = (args) =>
      execFileSync("git", [...(push.dir ? ["-C", push.dir] : []), ...args], {
        cwd: typeof cwd === "string" && cwd ? cwd : undefined,
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    let range;
    if (push.branch) {
      // That branch beyond its copy at the remote, both read as references (a tag of the same name
      // never stands in); a branch the remote does not have yet keeps the question as it was.
      const theirs = `refs/remotes/${push.remote}/${push.branch}`;
      const ours = `refs/heads/${push.branch}`;
      git(["rev-parse", "--verify", "--quiet", theirs]);
      git(["rev-parse", "--verify", "--quiet", ours]);
      range = { arg: `${theirs}..${ours}`, said: `${push.remote}/${push.branch}..${push.branch}` };
    } else {
      if (push.remote) {
        const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
        if (!upstream.startsWith(`${push.remote}/`)) return null;
      }
      range = { arg: "@{u}..HEAD", said: "@{u}..HEAD" };
    }
    const lines = git(["log", "--oneline", "--no-decorate", "--no-color", "--no-show-signature", range.arg])
      .split(/\r?\n/)
      .map(shown)
      .filter(Boolean);
    if (!lines.length) return null;
    const more = lines.length > 10 ? `; and ${lines.length - 10} more` : "";
    const count = lines.length === 1 ? "1 commit leaves" : `${lines.length} commits leave`;
    return `${count} with it (git log ${range.said}, subjects as written in the repository): ${lines.slice(0, 10).join("; ")}${more}.`;
  } catch {
    return null;
  }
}

function read() {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

try {
  const raw = await read();
  const payload = JSON.parse(raw);
  if (!SHELL_TOOLS.has(payload?.tool_name)) process.exit(0);

  const { decide, PUSH_REASON } = await import("./rules.mjs");
  const command = payload?.tool_input?.command ?? "";
  const verdict = decide(command);
  if (!verdict) process.exit(0);

  // A push's question names the commits that leave, when this file can read them for sure.
  const outgoing = verdict.decision === "ask" && PUSH_REASON && verdict.reason === PUSH_REASON ? outgoingCommits(command, payload?.cwd) : null;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: `[Hypervibe] ${verdict.reason}${outgoing ? ` ${outgoing}` : ""}`,
      },
    }),
  );
  process.exit(0);
} catch (e) {
  process.stderr.write(
    `[Hypervibe] guard-bash could not run, letting the command through: ${
      e instanceof Error ? e.message : String(e)
    }\n`,
  );
  process.exit(0);
}
