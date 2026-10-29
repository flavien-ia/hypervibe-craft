#!/usr/bin/env node
// git-identity.mjs - Who signs this machine's commits, checked without ever being shown.
//
// Every commit carries user.name and user.email in its header, and a push publishes that
// header. On 22/09/2026 a machine had an email address in user.name and, in user.email,
// what looked like a password: each commit would have carried it to GitHub, and the Enterprise
// licence had already sent it to the server. So nothing here ever prints a value, not even
// back to its owner: the check says what SHAPE each one has, and the fix writes what the
// person gave, once it is known to be an address.
//
//   node git-identity.mjs check [--effective] [--cwd <dir>]
//     {"ok":true,"scope":"global","name":"set|missing|email-like","email":"valid|missing|invalid","swapped":false,"fix":"none|name|email|both|swap"}
//   node git-identity.mjs set [--name <name>] [--email <address> | --email-from-name]
//     {"ok":true,"name":"set","email":"valid","swapped":false,"fix":"none"}   (shapes only)
//
// `--effective` reads what a commit made in --cwd would carry (the repository's own config
// wins); the default is the machine-wide identity (`git config --global`), the one /start
// sets. `--email-from-name` repairs the swap: the address found in user.name moves to
// user.email, and --name gives the real name.
//
// Exit codes: 0 done (a check that finds a problem is still 0: read `fix`), 2 usage,
// 3 git is not installed, 4 refused (nothing written, and the refused value never echoed).

import { spawnSync } from "node:child_process";

/** The shape of an email address: the one the Enterprise licence server and the organisation's
 *  dashboard accept. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isEmailShaped = (value) => EMAIL_SHAPE.test(String(value ?? "").trim());

function git(args, cwd) {
  return spawnSync("git", args, { encoding: "utf8", cwd, windowsHide: true });
}

/** The identity git uses, as values. Meant to be judged by shapeOf(), never printed. */
export function readIdentity({ effective = false, cwd = process.cwd() } = {}) {
  const scope = effective ? [] : ["--global"];
  const get = (key) => {
    const r = git(["config", ...scope, "--get", key], cwd);
    if (r.error) throw Object.assign(new Error("git is not installed"), { exitCode: 3 });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  return { name: get("user.name"), email: get("user.email") };
}

/** What each value looks like, and what to repair. Never a value in the answer. */
export function shapeOf({ name, email }) {
  const n = String(name ?? "").trim();
  const e = String(email ?? "").trim();
  const nameState = !n ? "missing" : isEmailShaped(n) ? "email-like" : "set";
  const emailState = !e ? "missing" : isEmailShaped(e) ? "valid" : "invalid";
  // An address in the name and anything else in the address: the two were swapped.
  const swapped = nameState === "email-like" && emailState !== "valid";
  let fix = "none";
  if (swapped) fix = "swap";
  else if (nameState !== "set" && emailState !== "valid") fix = "both";
  else if (emailState !== "valid") fix = "email";
  else if (nameState !== "set") fix = "name";
  return { name: nameState, email: emailState, swapped, fix };
}

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function answer(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exitCode = code;
}

function check(flags) {
  const identity = readIdentity({ effective: Boolean(flags.effective), cwd: typeof flags.cwd === "string" ? flags.cwd : process.cwd() });
  answer({ ok: true, scope: flags.effective ? "effective" : "global", ...shapeOf(identity) });
}

function set(flags) {
  const refuse = (reason) => answer({ ok: false, code: "refused", reason }, 4);
  const current = readIdentity();
  const writes = [];
  let name = null;
  if (flags.name !== undefined) {
    name = typeof flags.name === "string" ? flags.name.trim() : "";
    if (!name) return refuse("empty name");
    if (isEmailShaped(name)) return refuse("the name looks like an email address: give the person's name");
  }
  let email = null;
  if (flags["email-from-name"]) {
    if (!isEmailShaped(current.name)) return refuse("user.name holds no address to move");
    if (name === null) return refuse("--email-from-name needs --name, the real name that replaces the address");
    email = current.name.trim();
  } else if (flags.email !== undefined) {
    // Refused without being repeated: if a password was typed here by mistake, it must not
    // come back in the output.
    if (typeof flags.email !== "string" || !isEmailShaped(flags.email)) return refuse("not an email address (not written, not shown)");
    email = flags.email.trim();
  }
  if (name !== null) writes.push(["user.name", name]);
  if (email !== null) writes.push(["user.email", email]);
  if (!writes.length) return answer({ ok: false, code: "usage", reason: "set needs --name, --email or --email-from-name" }, 2);
  for (const [key, value] of writes) {
    const r = git(["config", "--global", key, value]);
    if (r.error) return answer({ ok: false, code: "git-missing" }, 3);
    if (r.status !== 0) return answer({ ok: false, code: "git-refused", key }, 1);
  }
  answer({ ok: true, written: writes.map(([key]) => key), ...shapeOf(readIdentity()) });
}

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

const isMain = launchedDirectly();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "check") check(parse(rest));
    else if (cmd === "set") set(parse(rest));
    else answer({ ok: false, code: "usage", reason: "git-identity.mjs <check|set>" }, 2);
  } catch (e) {
    answer({ ok: false, code: e.exitCode === 3 ? "git-missing" : "error" }, e.exitCode ?? 1);
  }
}
