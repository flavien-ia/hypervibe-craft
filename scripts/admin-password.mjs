#!/usr/bin/env node
// admin-password.mjs - The admin's production password, never in the conversation (3.4.13). It used
// to come back in a script's JSON and to be displayed in the chat for the person to copy: written into
// the conversation's history, and kept in what the agent remembers of it. Now the password is written
// in a file of the person's downloads folder (sign-in page, identifier, password), only its hash goes
// to the project, and the scripts return nothing but the file's path.
//
//   node admin-password.mjs rotate --project-dir <dir> [--username <name>]
//        a new password: its file written, then ADMIN_PASSWORD_HASH_PROD pushed (the local .env and
//        the hosting's production and preview). The new password works once the site is deployed
//        again. {ok, file, pushed: ["ADMIN_PASSWORD_HASH_PROD"]}
//
// Imported by setup-auth-admin.mjs (newAdminPassword, writeCredentialsFile, signinUrl).
// Exit codes: 0 done, 1 a step failed (its words in `error`; nothing pushed when the file could not
// be written), 5 usage. One JSON object on stdout, never the password nor its hash.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadsDir } from "./downloads-dir.mjs";
import { envValue } from "./env-value.mjs";
import { generatePassword, hashPassword } from "./hash-password.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXIT = { OK: 0, FAILED: 1, USAGE: 5 };

/** A new production password and its hash (24 letters and digits, scrypt). */
export function newAdminPassword() {
  const password = generatePassword({ length: 24, format: "alphanumeric" });
  return { password, hash: hashPassword(password) };
}

/** The sign-in page in production, when the project knows its public address (never localhost). */
export function signinUrl(projectDir) {
  for (const key of ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SITE_URL"]) {
    const url = envValue(projectDir, key);
    if (url && /^https:\/\//i.test(url) && !/localhost|127\.0\.0\.1/i.test(url)) return `${url.replace(/\/+$/, "")}/admin/signin`;
  }
  return null;
}

/** The project's name for the file's name: its package.json, else its folder. */
function projectName(projectDir) {
  try {
    const name = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")).name;
    if (typeof name === "string" && /^[A-Za-z0-9@/_.-]+$/.test(name)) return name.replace(/^@[^/]+\//, "");
  } catch {}
  return basename(resolve(projectDir));
}

/** Writes the file and returns its path; a name already taken gets a number, nothing is overwritten. */
export function writeCredentialsFile({ dir = downloadsDir(), project, username, password, url, now = new Date() }) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const base = `${String(project).replace(/[^A-Za-z0-9_-]+/g, "-")}-admin-${stamp}`;
  let file = join(dir, `${base}.txt`);
  for (let n = 2; existsSync(file); n += 1) file = join(dir, `${base}-${n}.txt`);
  const text = [
    `${project} - admin access (production) / accès administrateur (production)`,
    "",
    `Sign-in page / Page de connexion : ${url ?? "/admin/signin on your site / sur votre site"}`,
    `Username / Identifiant : ${username}`,
    `Password / Mot de passe : ${password}`,
    "",
    "Store this password in your password manager, then delete this file.",
    "Rangez ce mot de passe dans votre gestionnaire de mots de passe, puis supprimez ce fichier.",
    "",
  ].join("\n");
  writeFileSync(file, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
  return file;
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv, { dir, push } = {}) {
  const [verb] = argv;
  const projectDir = option(argv, "--project-dir");
  if (verb !== "rotate" || !projectDir || !existsSync(join(projectDir, "package.json"))) {
    return { code: EXIT.USAGE, out: { ok: false, error: "Usage: admin-password.mjs rotate --project-dir <the project's folder> [--username <name>]" } };
  }
  const username = option(argv, "--username") ?? envValue(projectDir, "ADMIN_USERNAME") ?? "admin";
  const { password, hash } = newAdminPassword();
  let file;
  try {
    file = writeCredentialsFile({ dir: dir ?? downloadsDir(), project: projectName(projectDir), username, password, url: signinUrl(projectDir) });
  } catch (e) {
    return { code: EXIT.FAILED, out: { ok: false, error: `The file could not be written (${e.code ?? e.message}): nothing was changed, the current password still works.` } };
  }
  const pushed = (push ?? pushHash)(projectDir, hash);
  if (!pushed.ok) {
    return { code: EXIT.FAILED, out: { ok: false, file, error: `The new hash could not be pushed: the file's password does not work yet. Push it again from .env, without showing it: grep '^ADMIN_PASSWORD_HASH_PROD=' .env | node "${join(HERE, "push-env-vars.mjs")}" --stdin` } };
  }
  return { code: EXIT.OK, out: { ok: true, file, pushed: ["ADMIN_PASSWORD_HASH_PROD"] } };
}

/** The hash goes to the local .env and the hosting on push-env-vars' standard input, never as an argument. */
function pushHash(projectDir, hash) {
  const r = spawnSync(process.execPath, [join(HERE, "push-env-vars.mjs"), "--stdin"], { cwd: projectDir, input: `ADMIN_PASSWORD_HASH_PROD=${hash}\n`, stdio: ["pipe", "ignore", "pipe"], encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0 };
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
if (launchedDirectly()) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
