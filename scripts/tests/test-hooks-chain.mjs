#!/usr/bin/env node
// test-hooks-chain.mjs - Recette of the git hooks chain: a clone never runs
// the hooks it arrived with.
//
// `.hooks/*` files are versioned, so they arrive with a clone, and git does not
// version its own hooks precisely so that cloning can never execute code. The
// chain block that hands over to a repository's `.hooks/pre-commit` therefore
// runs only in a checkout that opted in through its LOCAL git config, which a
// clone never carries. This recette does what an outside reader did on 3.1.4
// to find the hole, and asserts the opposite outcome: a throwaway repository
// whose `.hooks/pre-commit` writes a witness file, committed with the real
// chain block installed as `core.hooksPath` (passed per command, no global
// config touched). Without the opt-in the witness must NOT appear; with it, it
// must. Then the refresh: an old, ungated block is replaced in place.
//
//   node scripts/tests/test-hooks-chain.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { chainBlock, refreshChainBlocks, TRUST_KEY } = await import(
  pathToFileURL(join(ROOT, "scripts", "ensure-hooks-chain.mjs")).href
);

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const git = (dir, args, extra = {}) =>
  spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", ...extra });

// A hook git will run: on macOS and Linux git IGNORES, silently, a hook that is not executable
// (only a hint on stderr). Written without the bit, nothing ran, and the checks of the safe
// direction below passed on nothing (outside review, 3.2.4, on a Mac).
function writeHook(file, content) {
  writeFileSync(file, content, { mode: 0o755 });
  chmodSync(file, 0o755);
}
const announces = (run) => /ships a \.hooks\/pre-commit/.test(run.stderr);
const readdirSafe = (d) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};

// A throwaway "hooks directory" holding the real pre-commit chain block, as
// setup-gitleaks-global.mjs would write it (minus the scan, which needs the
// binary and is not what is under test).
const base = mkdtempSync(join(tmpdir(), "hypervibe-chain-"));
const hooksDir = join(base, "global-hooks");
mkdirSync(hooksDir);
writeHook(join(hooksDir, "pre-commit"), `#!/usr/bin/env sh\n${chainBlock("pre-commit")}exit 0\n`);
const hooksPathPosix = hooksDir.replace(/\\/g, "/");

// The "cloned" repository: its versioned .hooks/pre-commit writes a witness.
const repo = join(base, "clone");
mkdirSync(join(repo, ".hooks"), { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "recette@example.test"]);
git(repo, ["config", "user.name", "recette"]);
writeFileSync(join(repo, ".hooks", "pre-commit"), '#!/bin/sh\necho executed > "$(git rev-parse --show-toplevel)/WITNESS"\n');
writeFileSync(join(repo, "a.txt"), "a\n");
git(repo, ["add", "a.txt", ".hooks/pre-commit"]);
const witness = join(repo, "WITNESS");

// 1. Without the opt-in: the hook is announced, not run.
const first = git(repo, ["-c", `core.hooksPath=${hooksPathPosix}`, "commit", "-q", "-m", "first"]);
// The safe direction is only proven if the block RAN: without its notice, the absent witness
// would mean nothing (a hook git ignored would give exactly that).
check("le hook global a bien tourne (son annonce est la), sinon rien de ce qui suit ne prouve quoi que ce soit", announces(first), first.stderr.slice(0, 200));
check("un clone ne voit pas ses hooks versionnes executes (sans opt-in local)", first.status === 0 && announces(first) && !existsSync(witness), `exit ${first.status}`);
check("le hook annonce ce que le depot transporte, sur stderr, sans dicter la commande de l'accord", announces(first) && /a person decides/.test(first.stderr) && !/hypervibe\.hooks true/.test(first.stderr));

// 2. The opt-in is local config, and it is never cloned.
git(repo, ["config", "--local", TRUST_KEY, "true"]);
writeFileSync(join(repo, "b.txt"), "b\n");
git(repo, ["add", "b.txt"]);
const second = git(repo, ["-c", `core.hooksPath=${hooksPathPosix}`, "commit", "-q", "-m", "second"]);
check("avec l'opt-in local, le .hooks/pre-commit du depot s'execute", second.status === 0 && existsSync(witness) && /executed/.test(readFileSync(witness, "utf8")), `exit ${second.status}`);
const clone = join(base, "clone-of-clone");
git(base, ["clone", "-q", repo, clone]);
const cloned = git(clone, ["config", "--local", "--bool", "--get", TRUST_KEY]);
check("un clone du depot n'herite pas de l'opt-in (config locale, jamais clonee)", cloned.status !== 0 || cloned.stdout.trim() !== "true");
check("le clone transporte pourtant le hook versionne", existsSync(join(clone, ".hooks", "pre-commit")));

// 3. A failing hook still blocks the commit in a trusted checkout (the chain
//    keeps its purpose: the recette refuses a bad push).
writeFileSync(join(repo, ".hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
writeFileSync(join(repo, "c.txt"), "c\n");
git(repo, ["add", "c.txt", ".hooks/pre-commit"]);
const third = git(repo, ["-c", `core.hooksPath=${hooksPathPosix}`, "commit", "-q", "-m", "third"]);
check("dans un depot de confiance, un hook qui echoue bloque toujours le commit", third.status !== 0);

// 4. The refresh: an old ungated block (English or the French variant) is
//    replaced in place, the rest of the file untouched.
const oldDir = join(base, "old-hooks");
mkdirSync(oldDir);
const oldEnglish = `#!/usr/bin/env sh
# hypervibe-managed gitleaks pre-commit
# --- chain to the repository's own hook -------------------------------------
# Any repository may commit a .hooks/pre-commit of its own: it runs here.
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$TOPLEVEL" ] && [ -f "$TOPLEVEL/.hooks/pre-commit" ]; then
  sh "$TOPLEVEL/.hooks/pre-commit" "$@" || exit 1
fi
# -----------------------------------------------------------------------------
GITLEAKS="/somewhere/gitleaks"
exit 0
`;
const oldFrench = `#!/usr/bin/env sh
# hypervibe-managed pre-push chain
# --- chainage des hooks propres a chaque depot (pose par spinoza P4) ---------
# Convention generique : tout depot peut committer son propre .hooks/pre-push,
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$TOPLEVEL" ] && [ -f "$TOPLEVEL/.hooks/pre-push" ]; then
  sh "$TOPLEVEL/.hooks/pre-push" || exit 1
fi
# -----------------------------------------------------------------------------
exit 0
`;
writeHook(join(oldDir, "pre-commit"), oldEnglish);
writeHook(join(oldDir, "pre-push"), oldFrench);
const refreshed = refreshChainBlocks(oldDir);
const newCommit = readFileSync(join(oldDir, "pre-commit"), "utf8");
const newPush = readFileSync(join(oldDir, "pre-push"), "utf8");
check("le rafraichissement remplace les deux anciens blocs", refreshed.length === 2, refreshed.join(", "));
check(
  "le bloc rafraichi porte l'opt-in, et le reste du hook est intact",
  newCommit.includes(`--get ${TRUST_KEY}`) && newCommit.includes('GITLEAKS="/somewhere/gitleaks"') && newCommit.includes("# hypervibe-managed gitleaks pre-commit") &&
    newPush.includes(`--get ${TRUST_KEY}`) && !/pose par spinoza/.test(newPush),
);
check("un second passage ne change plus rien", refreshChainBlocks(oldDir).length === 0);

// 5. The refreshed old hook behaves like the new one: announced, not run.
const repo2 = join(base, "clone2");
mkdirSync(join(repo2, ".hooks"), { recursive: true });
git(repo2, ["init", "-q", "-b", "main"]);
git(repo2, ["config", "user.email", "recette@example.test"]);
git(repo2, ["config", "user.name", "recette"]);
writeFileSync(join(repo2, ".hooks", "pre-commit"), '#!/bin/sh\necho executed > "$(git rev-parse --show-toplevel)/WITNESS"\n');
writeFileSync(join(repo2, "a.txt"), "a\n");
git(repo2, ["add", "a.txt", ".hooks/pre-commit"]);
const fourth = git(repo2, ["-c", `core.hooksPath=${oldDir.replace(/\\/g, "/")}`, "commit", "-q", "-m", "first"]);
check("le hook rafraichi n'execute pas non plus un clone non approuve", fourth.status === 0 && announces(fourth) && !existsSync(join(repo2, "WITNESS")), `exit ${fourth.status}`);

// 6. A machine WITHOUT global hooks (the secret scan never installed), as the updates call the
//    script: plainly, from whatever folder the conversation is in. Up to 3.4.20 / 2.4.19 that call
//    wrote the chain into the current repository AND opted it in (hypervibe.hooks = true), with no
//    one deciding (Desktop bench, 28/10/2026, constat 6). The real script, as a child process,
//    with a global git config that is an empty file and a home of its own: the machine's own
//    configuration and ~/.git-hooks are never read nor touched.
const SCRIPT = join(ROOT, "scripts", "ensure-hooks-chain.mjs");
const noGlobal = join(base, "home-sans-hooks");
mkdirSync(noGlobal, { recursive: true });
const emptyGlobal = join(noGlobal, "gitconfig-vide");
writeFileSync(emptyGlobal, "");
const isolated = { ...process.env, HOME: noGlobal, USERPROFILE: noGlobal, GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1" };
const runChain = (cwd, args = []) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: isolated });
const ours = (file) => existsSync(file) && readFileSync(file, "utf8").includes("# hypervibe-managed pre-push chain");
const trusted = (dir) => git(dir, ["config", "--local", "--bool", "--get", TRUST_KEY], { env: isolated }).stdout.trim() === "true";

const repo3 = join(base, "depot-sans-hooks-globaux");
mkdirSync(join(repo3, ".hooks"), { recursive: true });
git(repo3, ["init", "-q", "-b", "main"], { env: isolated });
git(repo3, ["config", "user.email", "recette@example.test"], { env: isolated });
git(repo3, ["config", "user.name", "recette"], { env: isolated });
writeFileSync(join(repo3, ".hooks", "pre-push"), "#!/bin/sh\nexit 0\n");
writeFileSync(join(repo3, "a.txt"), "a\n");
git(repo3, ["add", "a.txt", ".hooks/pre-push"], { env: isolated });
git(repo3, ["commit", "-q", "-m", "premier"], { env: isolated });
const plain = runChain(repo3);
check("sans hooks globaux, l'appel des mises a jour repond LOCAL", plain.status === 0 && plain.stdout.trim() === "LOCAL", `${plain.status} ${plain.stdout}${plain.stderr}`);
check("... et n'accorde AUCUNE confiance au depot courant (hypervibe.hooks reste absent)", !trusted(repo3));
check("... et n'ecrit rien dans ses hooks", !ours(join(repo3, ".git", "hooks", "pre-push")));
check("... ni dans le dossier des hooks globaux du poste", !existsSync(join(noGlobal, ".git-hooks")));
const withTrust = runChain(repo3, ["--trust"]);
check("avec --trust (/add-test), sans hooks globaux : LOCAL TRUSTED", withTrust.status === 0 && withTrust.stdout.trim() === "LOCAL TRUSTED", `${withTrust.status} ${withTrust.stdout}${withTrust.stderr}`);
check("... la chaine est posee dans les hooks du depot, et l'accord est pose", ours(join(repo3, ".git", "hooks", "pre-push")) && trusted(repo3));

// 7. Where git really reads the hooks: a linked worktree and a subfolder. `rev-parse --git-dir`
//    answers an absolute path there, and joining it behind the folder gave a path that does not
//    exist (point 4 of the security corrective's open questions).
const repo4 = join(base, "depot-principal");
mkdirSync(join(repo4, "sous", "dossier"), { recursive: true });
git(repo4, ["init", "-q", "-b", "main"], { env: isolated });
git(repo4, ["config", "user.email", "recette@example.test"], { env: isolated });
git(repo4, ["config", "user.name", "recette"], { env: isolated });
writeFileSync(join(repo4, "sous", "dossier", "a.txt"), "a\n");
git(repo4, ["add", "."], { env: isolated });
git(repo4, ["commit", "-q", "-m", "premier"], { env: isolated });
const fromSub = runChain(join(repo4, "sous", "dossier"), ["--trust"]);
check("depuis un sous-dossier, --trust pose la chaine dans les hooks du depot", fromSub.status === 0 && /^LOCAL TRUSTED$/.test(fromSub.stdout.trim()) && ours(join(repo4, ".git", "hooks", "pre-push")), `${fromSub.status} ${fromSub.stdout}${fromSub.stderr}`);
check("... et nulle part sous le sous-dossier", !existsSync(join(repo4, "sous", "dossier", ".git")) && !readdirSafe(join(repo4, "sous", "dossier")).some((n) => n !== "a.txt"));
const repo5 = join(base, "depot-copie-liee");
mkdirSync(repo5, { recursive: true });
git(repo5, ["init", "-q", "-b", "main"], { env: isolated });
git(repo5, ["config", "user.email", "recette@example.test"], { env: isolated });
git(repo5, ["config", "user.name", "recette"], { env: isolated });
writeFileSync(join(repo5, "a.txt"), "a\n");
git(repo5, ["add", "a.txt"], { env: isolated });
git(repo5, ["commit", "-q", "-m", "premier"], { env: isolated });
const wt = join(base, "copie-liee");
git(repo5, ["worktree", "add", "-q", "-b", "travail", wt], { env: isolated });
const fromWt = runChain(wt, ["--trust"]);
check("depuis une copie liee (git worktree), --trust repond LOCAL TRUSTED", fromWt.status === 0 && fromWt.stdout.trim() === "LOCAL TRUSTED", `${fromWt.status} ${fromWt.stdout}${fromWt.stderr}`);
check("... et la chaine est la ou git lit les hooks de la copie (le dossier commun)", ours(join(repo5, ".git", "hooks", "pre-push")));
check("... rien d'ecrit sous la copie elle-meme", readdirSafe(wt).every((n) => n === "a.txt" || n === ".git"));

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
