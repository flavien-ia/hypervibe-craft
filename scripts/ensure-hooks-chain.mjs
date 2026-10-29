#!/usr/bin/env node
// ensure-hooks-chain.mjs - The machine-wide git hooks that hand over to each
// repository's own hooks, and the local opt-in without which they never do.
//
// Hypervibe sets `core.hooksPath` globally (~/.git-hooks, for the gitleaks
// scan). A global hooks path makes every repository's `.git/hooks/` inert, so
// a project can no longer install a hook of its own: the `.hooks/pre-push`
// that /add-test commits (tests + recette before every push) would never run.
//
// This script writes the two chain hooks that solve it, idempotently:
//
//   ~/.git-hooks/pre-push    runs <repo>/.hooks/pre-push when the repo has one
//   ~/.git-hooks/pre-commit  is written by setup-gitleaks-global.mjs, which
//                            carries the same chain block (see chainBlock)
//
// and, when no global hooks path is configured at all (the gitleaks setup was
// declined), falls back to the current repository's `.git/hooks/pre-push`, but
// ONLY with `--trust` (/add-test). Without it, that machine has nothing to
// close: the script writes nothing, trusts nothing, and answers LOCAL.
// Up to 3.4.20 / 2.4.19, the plain call of the updates wrote the hook into the
// current repository AND opted it in, without anyone deciding (Desktop bench of
// 28/10/2026, constat 6): run from a clone that ships a .hooks/pre-push, the
// next push ran it.
//
// THE OPT-IN. `.hooks/*` files are versioned: they arrive with a clone. Git
// does not version its own hooks precisely so that cloning a repository can
// never execute code, and a chain that ran any repository's `.hooks/` reopened
// that door on every machine set up by /start (outside review, 3.1.4: a
// cloned `.hooks/pre-commit` ran at the first commit, before the secret scan,
// with no execute bit needed since `sh` launches it). So the hand-over happens
// only in a checkout whose LOCAL git config says `hypervibe.hooks = true`:
// local config is never cloned, and the value is set by an explicit act in
// that checkout (/add-test, `--trust` here, or the one-line
// `git config hypervibe.hooks true`). A clone that ships hooks is announced
// on stderr at the first commit or push, never run. The notice does not spell
// the opt-in command out: that text reaches the model in the output of its
// commit, and a person must be the one deciding (the guardrail asks before
// any write of hypervibe.hooks, outside review 3.1.6).
//
// The refresh: a global hook written by an earlier version carries the ungated
// block. Every run replaces it in place, in both hooks, so that /start,
// /add-test and /update-hypervibe all close the door on an existing machine.
//
//   node scripts/ensure-hooks-chain.mjs            prints OK / INSTALLED / REFRESHED / LOCAL / FOREIGN
//                                                  (LOCAL: no global hooks path, nothing written)
//   node scripts/ensure-hooks-chain.mjs --trust    also opts the current repository in (TRUSTED);
//                                                  without a global hooks path, writes the chain
//                                                  into this repository's hooks (LOCAL TRUSTED)
//
// Exported for setup-gitleaks-global.mjs, which calls it at every /start.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const IS_WIN = process.platform === "win32";
export const HOOK_DIR = join(homedir(), ".git-hooks");
export const PRE_PUSH_MARKER = "# hypervibe-managed pre-push chain";
/** The local, never-cloned git config key that lets a checkout's hooks run. */
export const TRUST_KEY = "hypervibe.hooks";

/** The block shared by pre-commit and pre-push: hand over to the repo's own
 *  hook, in a checkout that opted in. */
export function chainBlock(hook) {
  return `# --- chain to the repository's own hook -------------------------------------
# A repository may commit a .hooks/${hook} of its own, and it runs here, but only
# in a checkout that opted in: \`git config ${TRUST_KEY} true\`, a LOCAL value a
# clone never carries. Git does not version its hooks precisely so that cloning
# can never execute code; running any repository's versioned hooks would reopen
# that door (outside review, 3.1.4). Placed BEFORE anything optional (like the
# gitleaks scan) on purpose: a repository's own checks must never depend on a
# third-party tool being installed.
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$TOPLEVEL" ] && [ -f "$TOPLEVEL/.hooks/${hook}" ]; then
  if [ "$(git config --local --bool --get ${TRUST_KEY} 2>/dev/null)" = "true" ]; then
    sh "$TOPLEVEL/.hooks/${hook}" "$@" || exit 1
  else
    echo "[hypervibe] this repository ships a .hooks/${hook}; not run on this clone. Running it means trusting code that arrived with the clone: a person decides that, per checkout (README, Guardrails)." 1>&2
  fi
fi
# -----------------------------------------------------------------------------
`;
}

export function prePushHook() {
  return `#!/usr/bin/env sh
${PRE_PUSH_MARKER}
# Auto-installed by Hypervibe. Runs the repository's own .hooks/pre-push (tests
# and recette before publishing, when /add-test equipped the project), in a
# checkout that opted in.
# Uninstall: rm "$0"

${chainBlock("pre-push")}
exit 0
`;
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function writeIfNeeded(path, content) {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === content) return "OK";
    if (!current.includes(PRE_PUSH_MARKER)) return "FOREIGN";
  }
  writeFileSync(path, content);
  if (!IS_WIN) chmodSync(path, 0o755);
  return "INSTALLED";
}

/** Replaces, in place, a chain block written by an earlier version (ungated,
 *  or the French variant some machines carry) with the gated one. Returns the
 *  hooks that were refreshed. Anything else in the file is left untouched. */
export function refreshChainBlocks(hookDir = HOOK_DIR) {
  const refreshed = [];
  for (const hook of ["pre-commit", "pre-push"]) {
    const path = join(hookDir, hook);
    if (!existsSync(path)) continue;
    const current = readFileSync(path, "utf8");
    if (current.includes(`--get ${TRUST_KEY}`)) continue;
    const start = current.search(/^# --- chain(?:age)? .*$/m);
    if (start < 0) continue;
    const endRe = /^# -{20,}\r?\n/m;
    endRe.lastIndex = 0;
    const rest = current.slice(start);
    const m = endRe.exec(rest);
    if (!m) continue;
    const next = current.slice(0, start) + chainBlock(hook) + rest.slice(m.index + m[0].length);
    writeFileSync(path, next);
    refreshed.push(hook);
  }
  return refreshed;
}

/** Opts a checkout in: its versioned hooks may run on this machine. Local
 *  config only, never cloned. */
export function trustRepo(repoDir = process.cwd()) {
  const gitDir = run(`git -C "${repoDir}" rev-parse --git-dir`);
  if (!gitDir) return "NOT_A_REPO";
  try {
    execSync(`git -C "${repoDir}" config --local ${TRUST_KEY} true`, { stdio: "ignore" });
    return "TRUSTED";
  } catch {
    return "ERROR";
  }
}

export function isTrusted(repoDir = process.cwd()) {
  return run(`git -C "${repoDir}" config --local --bool --get ${TRUST_KEY}`) === "true";
}

/**
 * @returns {"OK"|"INSTALLED"|"REFRESHED"|"LOCAL"|"FOREIGN"}
 *   OK        the global chain hook is already in place
 *   INSTALLED it was written (or refreshed) this run
 *   REFRESHED an older, ungated chain block was replaced in place
 *   LOCAL     no global hooks path. Without `trust`: nothing written, nothing
 *             trusted, the machine has nothing to close. With `trust`: the chain
 *             is written into the current repository's hooks and it opts in.
 *   FOREIGN   a pre-push that is not ours exists; left untouched
 */
export function ensureHooksChain({ repoDir = process.cwd(), trust = false } = {}) {
  const hooksPath = run("git config --global --get core.hooksPath");
  if (hooksPath) {
    if (!existsSync(HOOK_DIR)) mkdirSync(HOOK_DIR, { recursive: true });
    const refreshed = refreshChainBlocks(HOOK_DIR);
    const state = writeIfNeeded(join(HOOK_DIR, "pre-push"), prePushHook());
    if (trust) trustRepo(repoDir);
    return state === "OK" && refreshed.length > 0 ? "REFRESHED" : state;
  }
  // No global hooks path. Only an explicit act in this checkout (--trust, from
  // /add-test) writes into its hooks and opts it in: the updates call this
  // script plainly, and must never decide trust for the person.
  if (!trust) return "LOCAL";
  // `--git-path hooks` names the folder git really reads: in a linked worktree
  // the hooks live in the common directory, and from a subfolder git answers an
  // absolute path. Joining `--git-dir` behind repoDir broke both (outside review).
  const hooksRel = run(`git -C "${repoDir}" rev-parse --git-path hooks`);
  if (!hooksRel) return "OK";
  const localHooks = resolve(repoDir, hooksRel);
  if (!existsSync(localHooks)) mkdirSync(localHooks, { recursive: true });
  const state = writeIfNeeded(join(localHooks, "pre-push"), prePushHook());
  if (state !== "FOREIGN") trustRepo(repoDir);
  return state === "FOREIGN" ? "FOREIGN" : "LOCAL";
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
  const trust = process.argv.includes("--trust");
  const state = ensureHooksChain({ trust });
  console.log(trust && state !== "FOREIGN" ? `${state} TRUSTED` : state);
}
