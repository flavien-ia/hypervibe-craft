#!/usr/bin/env node
// test-hooks.mjs - Recette of the Bash guardrail.
//
// A guardrail is only acquired once you have seen it do BOTH things. The half
// everyone forgets is the second one: a hook that blocks everything looks
// exactly like a hook that works, right up to the moment it blocks the commit
// message that merely mentions `git add -A`. So the "lets through" list below
// is longer than the "refuses" list, and it is the one to extend first when a
// pattern is added.
//
// Runs the real hook as a subprocess, feeding it the JSON Claude Code feeds it.
//
//   node hooks/test-hooks.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "guard-bash.mjs");

let failures = 0;
let checks = 0;
const timings = [];
// What the guardrail costs on its own, apart from starting Node: every eighth call is paired with a
// bare start of Node (an empty module, the same input and environment) right after it, under the
// same load. A busy machine slows both; only a guardrail that grew heavy widens the gap. Measured on
// 05/10/2026: a bare start took 110 to 190 ms on a Windows machine, the guardrail's own share about
// 15 ms, and a budget on the whole call failed whenever the machine was busy.
const gaps = [];
const bareStarts = [];
const BARE = join(mkdtempSync(join(tmpdir(), "hv-garde-nu-")), "nu.mjs");
writeFileSync(BARE, "");

function timed(file, input, env) {
  const started = process.hrtime.bigint();
  const out = execFileSync(process.execPath, [file], { input, encoding: "utf8", env });
  return { out, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

function call(payload, env = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const fullEnv = { ...process.env, HYPERVIBE_GUARD_ALLOW_DB_PUSH: "", ...env };
  const { out, ms } = timed(HOOK, input, fullEnv);
  timings.push(ms);
  if (timings.length % 8 === 0) {
    const bare = timed(BARE, input, fullEnv).ms;
    bareStarts.push(bare);
    gaps.push(ms - bare);
  }
  if (!out.trim()) return null;
  return JSON.parse(out).hookSpecificOutput;
}

function bash(command, env = {}) {
  return call({ tool_name: "Bash", tool_input: { command }, hook_event_name: "PreToolUse" }, env);
}

function expect(command, attendu, env = {}) {
  checks += 1;
  const r = bash(command, env);
  const obtenu = r?.permissionDecision ?? "pass";
  const ok = obtenu === attendu;
  if (!ok) failures += 1;
  const court = command.length > 58 ? command.slice(0, 55) + "..." : command;
  console.log(`${ok ? "OK  " : "FAIL"} ${attendu.padEnd(4)} ${court}${ok ? "" : `   (obtenu: ${obtenu})`}`);
  if (ok && attendu !== "pass" && !r.permissionDecisionReason?.includes("[Hypervibe]")) {
    failures += 1;
    console.log("     FAIL: la raison ne porte pas la marque du plugin");
  }
}

console.log("── Refus (aucun usage legitime, une alternative existe) ──");
expect("git add -A", "deny");
expect("git add .", "deny");
expect("git add --all", "deny");
expect("git add -u", "deny");
expect('git commit -am "wip"', "deny");
expect('git commit --all -m "wip"', "deny");
expect("git commit -a -m wip", "deny");
expect("cd src && git add -A && git commit -m ok", "deny");
expect('git -C "C:/DEV/hypervibe-harness" add -A', "deny");
expect("git -C src add .", "deny");
expect("git --no-pager -c user.name=x add -A", "deny");
expect('node scripts/neon/run-sql.mjs "DROP TABLE clients"', "deny");
expect('node run-sql.mjs "TRUNCATE hypervibe_order"', "deny");
expect('node run-sql.mjs "ALTER TABLE t DROP COLUMN email"', "deny");
expect("git push --no-verify", "deny");
expect("git push origin main --no-verify", "deny");
expect("git push --no-verify -u origin feat/x", "deny");
expect('git -C "C:/DEV/x" push --no-verify', "deny");

console.log("\n── Confirmation humaine (legitime, mais irreversible ou public) ──");
expect("git push", "ask");
expect("git push origin main", "ask");
expect("git push -u origin feat/x", "ask");

console.log("\n── La forge (gh) : publier, détruire, exposer, déplacer demandent ; lire et écrire passent ──");
expect("gh pr merge 12 --squash", "ask");
expect("gh pr merge --squash --delete-branch=false", "ask");
expect('GH_TOKEN=$(node vault.mjs get GITHUB org_pat) gh pr merge 3 --repo acme/site --squash', "ask");
expect("gh run rerun 123456 --repo acme/site", "ask");
expect("gh repo delete acme/site --yes", "ask");
expect("gh secret delete CRON_SECRET", "ask");
expect("gh secret remove HOST_TOKEN --repo acme/site", "ask");
expect("gh variable delete PROD_ALLOWLIST", "ask");
expect("gh repo edit acme/site --visibility public --accept-visibility-change-consequences", "ask");
expect("gh repo create site --public --source=. --push", "ask");
expect("gh api -X DELETE repos/acme/site/collaborators/bob", "ask");
expect("gh api --method DELETE orgs/acme/members/bob", "ask");
expect("gh api --method=delete orgs/acme/invitations/42", "ask");
expect("gh api -XDELETE repos/acme/site/git/refs/heads/collab/bob", "ask");
expect("gh api -X POST repos/moi/site/transfer -f new_owner=acme", "ask");
expect("gh pr create --base main --fill", "pass");
expect("gh pr view --json url", "pass");
expect("gh run list --workflow deploy.yml --limit 1", "pass");
expect("gh run watch 123 --exit-status", "pass");
expect("gh api user --jq .login", "pass");
expect("gh api --paginate repos/acme/site/collaborators", "pass");
expect("gh api -X POST orgs/acme/invitations -f email=a@b.fr", "pass");
expect("gh secret list", "pass");
expect("printf '%s' \"$V\" | gh secret set CRON_SECRET", "pass");
expect("gh repo create acme/site --private --add-readme", "pass");
expect("gh repo edit acme/site --visibility private", "pass");
expect("gh repo view acme/site --json url", "pass");
expect("gh workflow run cron-digest.yml", "pass");
// gh read as gh reads it (outside review, 3.4.8): the repository option before the verb, the
// method in every spelling, and the same gestures through the API.
expect("gh pr -R octo/demo merge 12", "ask");
expect("gh pr --repo octo/demo merge 12", "ask");
expect("gh pr --repo=octo/demo merge 12", "ask");
expect("gh -R octo/demo pr merge 12", "ask");
expect("gh run -R octo/demo rerun 1", "ask");
expect("gh secret -R octo/demo delete X", "ask");
expect("gh variable --repo octo/demo delete Y", "ask");
expect("gh api -X=DELETE repos/octo/demo/collaborators/bob", "ask");
expect("gh api -iX DELETE repos/octo/demo/collaborators/bob", "ask");
expect("gh api -iXDELETE repos/octo/demo/collaborators/bob", "ask");
expect('gh api -X "$METHODE" repos/octo/demo', "ask");
expect("gh api -X PATCH repos/octo/demo -f visibility=public", "ask");
expect("gh api -X PATCH repos/octo/demo -F private=false", "ask");
expect("gh api --method PATCH /repos/octo/demo --field visibility=public", "ask");
expect("gh api -X PATCH repos/octo/demo -f name=nouveau-nom", "ask");
expect("gh api -X POST user/repos -f name=x -f visibility=public", "ask");
// GitHub makes a repository public when the body says nothing (`private` defaults to false):
// a creation asks unless it says private (Bastien Detraz, 10/10/2026).
expect("gh api user/repos -f name=demo", "ask");
expect("gh api -X POST user/repos -f name=demo", "ask");
expect("gh api orgs/acme/repos -f name=demo", "ask");
expect("gh api user/repos --input corps.json", "ask");
expect("gh api user/repos -f name=demo -f visibility=private", "ask");
expect("gh api orgs/acme/repos -f name=demo -f visibility=public -F private=true", "ask");
expect("gh api user/repos -f name=demo -F private=false", "ask");
expect("gh api user/repos -f name=demo -F private=true", "pass");
expect("gh api orgs/acme/repos -f name=demo -f visibility=private", "pass");
expect("gh api orgs/acme/repos -f name=demo -f visibility=internal", "pass");
expect("gh api user/repos", "pass");
expect("gh api -X PUT repos/octo/demo/pulls/12/merge", "ask");
expect("gh api repos/octo/demo/merges -f base=main -f head=feature", "ask");
expect("gh api -X POST repos/octo/demo/actions/runs/42/rerun", "ask");
expect("gh api repos/octo/demo/actions/runs/42/rerun-failed-jobs -X POST", "ask");
expect("gh release delete v1.0 --yes", "ask");
expect("gh release -R octo/demo delete v1.0", "ask");
expect("gh release delete-asset v1.0 app.zip", "ask");
expect("gh repo rename nouveau-nom", "ask");
expect("gh repo -R octo/demo rename nouveau-nom", "ask");
expect("gh pr -R octo/demo view 12", "pass");
expect("gh pr list --search merge", "pass");
expect("gh pr view 12 --json mergeable", "pass");
expect("gh run -R octo/demo list", "pass");
expect("gh secret -R octo/demo list", "pass");
expect("gh api repos/octo/demo/pulls/12/merge", "pass");
expect("gh api -i repos/octo/demo", "pass");
expect("gh api -X PATCH repos/octo/demo -f description=x", "pass");
expect("gh api -X PATCH repos/octo/demo -f visibility=private", "pass");
expect("gh api -X GET search/repositories -f q=hypervibe", "pass");
expect("gh release list", "pass");
expect("gh release create v1.0 --notes x", "pass");
expect("grep -rn 'gh pr merge' skills/", "pass");
expect('echo "gh repo delete acme/site"', "pass");
expect('git -C "C:/DEV/hypervibe-harness" push origin main --follow-tags', "ask");
expect("git --no-pager -C x push", "ask");
expect("vercel --prod", "ask");
expect("vercel deploy --prod", "ask");
expect("vercel rollback", "ask");
expect("npx vercel --prod", "ask");
expect("pnpm dlx vercel --prod", "ask");
expect("npx -y vercel deploy --prod", "ask");
expect("cd apps/web && npx vercel --prod", "ask");
expect("wrangler deploy", "ask");
expect("npx wrangler deploy", "ask");
expect('(cd "$WORKER_DIR" && npx wrangler deploy 2>&1 | tail -3)', "ask");
expect("wrangler secret put CRON_SECRET", "ask");
expect("pnpm dlx wrangler versions deploy", "ask");
expect("pnpm db:push", "ask");
expect("npm run db:push", "ask");
expect("npx drizzle-kit push", "ask");
expect("node scripts/delete-project/execute-deletions.mjs --confirm demo", "ask");
expect('node run-sql.mjs "DELETE FROM sessions"', "ask");
expect('node run-sql.mjs "UPDATE users SET active = false"', "ask");
expect('node run-sql.mjs --destructif "DROP TABLE tmp_import"', "ask");
expect("git reset --hard", "ask");
expect("git checkout -- .", "ask");
expect("git restore .", "ask");
expect("git clean -fd", "ask");

console.log("\n── Laisse passer (le sens que personne ne teste) ──");
expect("git add src/a.ts src/b.ts", "pass");
expect("git add -p", "pass");
expect("git add docs/plan.md", "pass");
expect("git push --dry-run", "pass");
expect("git status --short", "pass");
expect("git commit -m 'feat: ok'", "pass");
expect('git commit -m "docs: expliquer pourquoi git add -A est refuse"', "pass");
expect('echo "git add -A"', "pass");
expect("grep -rn 'git push' docs/", "pass");
expect("pnpm db:studio", "pass");
expect("pnpm db:generate", "pass");
expect("pnpm lint && pnpm tsc --noEmit", "pass");
expect('node run-sql.mjs "SELECT count(*) FROM users"', "pass");
expect('node run-sql.mjs "DELETE FROM sessions WHERE expires_at < now()"', "pass");
expect('node run-sql.mjs "UPDATE users SET active = false WHERE id = 3"', "pass");
expect('node run-sql.mjs "INSERT INTO t (a) VALUES (1)"', "pass");
expect("HYPERVIBE_GUARD_ALLOW_PUSH=1 git push origin main", "pass");
expect("HYPERVIBE_GUARD_ALLOW_SWEEP=1 git add -A", "pass");
expect('HYPERVIBE_GUARD_ALLOW_SWEEP=1 git -C "C:/DEV/x" add -A', "pass");
expect('HYPERVIBE_GUARD_ALLOW_PUSH=1 git -C "C:/DEV/x" push origin main --follow-tags', "pass");
expect('git -C "C:/DEV/x" status --porcelain', "pass");
expect("git -C x add CHANGELOG.md .claude-plugin/plugin.json", "pass");
expect("git -C x ls-remote --tags origin v1", "pass");
// L'echappatoire du schema vient de l'environnement de la SESSION (pose par un
// humain avant de lancer Claude Code), jamais de la commande que tape le modele
// (revue externe, 3.1.4) : le prefixe ne suffit plus, la variable de session si.
expect("HYPERVIBE_GUARD_ALLOW_DB_PUSH=1 pnpm db:push", "ask");
expect("HYPERVIBE_GUARD_ALLOW_DB_PUSH=1 npx drizzle-kit push", "ask");
expect("pnpm db:push", "pass", { HYPERVIBE_GUARD_ALLOW_DB_PUSH: "1" });
expect("npx drizzle-kit push", "pass", { HYPERVIBE_GUARD_ALLOW_DB_PUSH: "1" });
expect("pnpm --filter web db:push", "pass", { HYPERVIBE_GUARD_ALLOW_DB_PUSH: "1" });
expect("git push origin main", "ask", { HYPERVIBE_GUARD_ALLOW_DB_PUSH: "1" });
expect("git add -A", "deny", { HYPERVIBE_GUARD_ALLOW_DB_PUSH: "1" });
expect("HYPERVIBE_GUARD_ALLOW_SWEEP=0 git add -A", "deny");
expect("HYPERVIBE_GUARD_ALLOW_PUSH=1 git add -A", "deny");
expect("HYPERVIBE_GUARD_ALLOW_DB_PUSH=0 pnpm db:push", "ask");
expect("HYPERVIBE_GUARD_ALLOW_PUSH=1 pnpm db:push", "ask");
expect("HYPERVIBE_GUARD_ALLOW_DB_PUSH=1 git push origin main", "ask");
expect("vercel ls", "pass");
expect("vercel env pull .env.check --environment=production", "pass");
expect("npx vercel env pull .env.check --environment=production", "pass");
expect("npx vercel ls", "pass");
expect("pnpm dlx create-t3-app@latest mon-app", "pass");
expect("npx drizzle-kit generate", "pass");
expect("wrangler whoami", "pass");
expect("npx wrangler tail", "pass");
expect("wrangler dev", "pass");
expect("wrangler secret list", "pass");
expect('grep -n "DROP|TRUNCATE" scripts/neon/run-sql.mjs', "pass");
expect("cat scripts/neon/run-sql.mjs | grep -c TRUNCATE", "pass");
expect('sed -n "1,30p" scripts/neon/run-sql.mjs', "pass");
expect("git restore src/app/page.tsx", "pass");
expect("git reset HEAD~1", "pass");

console.log("\n── Le refus ne nomme pas son propre contournement ──");
for (const cmd of ["git add -A", "git push origin main"]) {
  checks += 1;
  const r = bash(cmd);
  const ok = r !== null && !/HYPERVIBE_GUARD_ALLOW/.test(r.permissionDecisionReason ?? "");
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} la raison de « ${cmd} » ne cite pas le prefixe d'exception`);
}

console.log("\n── La tete de la commande ne cache rien (revue externe, 3.0.4) ──");
expect("sudo git add -A", "deny");
expect("sudo -u deploy -E git add -A", "deny");
expect("/usr/bin/git add -A", "deny");
expect("command git add -A", "deny");
expect("env FOO=1 git add -A", "deny");
expect("(git add -A && git commit -m x)", "deny");
expect("{ git add -A; }", "deny");
expect("if true; then git add -A; fi", "deny");
expect("git add -Av", "deny");
expect("git add -v -A", "deny");
expect('sh -c "git add -A"', "deny");
expect("bash -lc 'git add -A && git push origin main'", "deny");
expect('eval "git add -A"', "deny");
expect("\\git add -A", "deny");
expect('"git" add -A', "deny");
expect("time git push origin main", "ask");
expect("nice -n 10 git push origin main", "ask");
expect('bash -c "git push origin main"', "ask");
expect("while true; do git push origin main; done", "ask");
expect("./node_modules/.bin/vercel --prod", "ask");
expect("vercel deploy --target production", "ask");
expect("vercel deploy --target=production", "ask");
expect("npx wrangler@latest deploy", "ask");
expect("pnpm --filter web db:push", "ask");
expect("pnpm --filter=web run db:push", "ask");
expect("pnpm -r db:push", "ask");
expect("git checkout .", "ask");
expect("git clean --force", "ask");
expect("git clean -d -f", "ask");
expect('node run-sql.mjs --destructive "DROP TABLE tmp_import"', "ask");
expect('HYPERVIBE_GUARD_ALLOW_PUSH=1 bash -c "git push origin main"', "pass");
expect("HYPERVIBE_GUARD_ALLOW_SWEEP=1 sudo git add -A", "pass");
// ... et ce qui ressemble a ces formes sans en etre : le sens que personne ne teste.
expect("grep -n confirm scripts/delete-project/execute-deletions.mjs", "pass");
expect("cat scripts/delete-project/execute-deletions.mjs", "pass");
expect("vercel build --prod", "pass");
expect("npx wrangler deploy --dry-run", "pass");
expect("git clean -n", "pass");
expect("git checkout main", "pass");
expect("git checkout -- src/app.ts", "pass");
expect("git add -f .gitignore", "pass");
expect("sudo apt-get install -y git", "pass");
expect("command -v git", "pass");
expect("bash scripts/deploy.sh", "pass");
expect('sh -c "ls -la"', "pass");
expect('echo "(git add -A)"', "pass");
expect("time pnpm test", "pass");
expect("env | grep PATH", "pass");
expect("vercel env pull --environment=production", "pass");

console.log("\n── Monitor execute du shell comme Bash ──");
checks += 1;
{
  const r = call({ tool_name: "Monitor", tool_input: { command: "git push origin main" }, hook_event_name: "PreToolUse" });
  const ok = r?.permissionDecision === "ask";
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} Monitor: git push -> ask`);
}
checks += 1;
{
  const r = call({ tool_name: "Monitor", tool_input: { command: "tail -f app.log | grep --line-buffered ERROR" }, hook_event_name: "PreToolUse" });
  const ok = r === null;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} Monitor: une veille ordinaire passe`);
}

console.log("\n── L'accord de confiance et le worker partage demandent (revue externe, 3.1.6) ──");
expect("git config hypervibe.hooks true", "ask");
expect("git config --local hypervibe.hooks true", "ask");
expect("git -C C:/x config hypervibe.hooks true", "ask");
expect("git config --bool hypervibe.hooks true", "ask");
expect("git config set hypervibe.hooks true", "ask");
expect("node scripts/ensure-hooks-chain.mjs --trust", "ask");
expect('node "C:/Users/x y/scripts/shared-worker/ensure.mjs"', "ask");
expect("node scripts/shared-worker/worker-check.mjs", "ask");
expect("node scripts/shared-worker/ensure.mjs --force-redeploy", "ask");
expect("git config --local --bool --get hypervibe.hooks", "pass");
expect("git config --unset hypervibe.hooks", "pass");
expect("git config get hypervibe.hooks", "pass");
expect("git config user.email x@y.z", "pass");
expect("node scripts/ensure-hooks-chain.mjs", "pass");
expect("node scripts/shared-worker/ensure.mjs --dry-run", "pass");
expect("node scripts/shared-worker/worker-check.mjs --dry-run", "pass");
expect("node scripts/shared-worker/register.mjs --list", "pass");
expect("cat scripts/shared-worker/ensure.mjs", "pass");

console.log("\n── Les substitutions de commande sont depliees (revue externe, 3.1.8) ──");
expect("result=$(node scripts/shared-worker/ensure.mjs)", "ask");
expect("x=$(git push origin main)", "ask");
expect("ok=$(git config --local hypervibe.hooks true)", "ask");
expect("v=`git add -A`", "deny");
expect('echo "$(git add -A)"', "deny");
expect("FOO=$(cat version.txt) git push origin main", "ask");
expect("OUT=$(echo $(git push origin main))", "ask");
expect("cd scripts/shared-worker && node ensure.mjs", "ask");
expect("node --no-warnings scripts/shared-worker/ensure.mjs", "ask");
expect("git config HYPERVIBE.HOOKS true", "ask");
expect("git config --local hypervibe.hooks true # a retirer plus tard avec --unset", "ask");
expect("echo '$(git push origin main)'", "pass");
expect('git commit -m "the fix: x=\\$(git push origin main) is unfolded now"', "pass");
expect('git commit -m "and v=\\`git add -A\\` too"', "pass");
expect('echo "\\$(git add -A)"', "pass");
expect("v=$(date +%Y)", "pass");
expect('echo "$(git rev-parse HEAD)"', "pass");
expect("node ensure.mjs --dry-run", "pass");
expect("node scripts/ensure-hooks-chain.mjs", "pass");
expect("git config --local --get hypervibe.hooks # set with true later", "pass");
expect("git config --unset HYPERVIBE.HOOKS", "pass");

console.log("\n── Un drapeau qui epargne la question est lu comme la commande le lit (3.3.10) ──");
// A dry run passes; a flag the command does not read as a dry run spares nothing. Four of the
// lines below were real pushes that asked nothing (tried on a throwaway repository, git 2.53):
// the flag switched off after it, taken as the value of --repo, or part of a branch's name.
expect("git push --dry-run origin main", "pass");
expect("git push origin main --dry-run", "pass");
expect("git push --force --dry-run", "pass");
expect("git push -u origin feature --dry-run", "pass");
expect('git push "--dry-run" origin main', "pass");
expect("git push --dry-run origin main 2>&1", "pass");
expect("git push --dry-run --no-dry-run origin main", "ask");
expect("git push --dry-run --no-dry origin main", "ask");
expect("git push --no-dry-run --dry-run origin main", "ask");
expect("git push --repo --dry-run origin main", "ask");
expect("git push --receive-pack --dry-run origin main", "ask");
expect("git push -o --dry-run origin main", "ask");
expect("git push origin main main:x--dry-run", "ask");
expect('git push -o "x --dry-run y" origin main', "ask");
expect("git push origin main -- --dry-run", "ask");
expect("git push origin -- main --dry-run", "ask");
expect("git push origin main > --dry-run", "ask");
expect("git push $EXTRA --dry-run origin main", "ask");
expect("git push --dry-run$(echo x) origin main", "ask");
expect("git push $(cat options.txt) --dry-run origin main", "ask");
// Skipping the pre-push hook is refused under every spelling git takes, and when the hooks'
// folder is changed for the one command.
expect("git push --no-veri origin main", "deny");
expect("git push --no-verif origin main", "deny");
expect("git -c core.hooksPath=/dev/null push origin main", "deny");
expect('git -c "core.hookspath=/tmp/none" push origin main', "deny");
expect("git -c core.hooksPath=/dev/null status", "pass");
expect("git config --global core.hooksPath ~/.hypervibe/hooks", "pass");
// git config: a read or a removal is one git reads as such.
expect("git config --comment --unset hypervibe.hooks true", "ask");
expect('git config --comment "a --unset b" hypervibe.hooks true', "ask");
expect("git config --comment get hypervibe.hooks true", "ask");
expect("git config > --get hypervibe.hooks true", "ask");
expect("git config $(echo --comment) --unset hypervibe.hooks true", "ask");
expect("git config --comment note --unset hypervibe.hooks", "pass");
expect("git config --local --bool --get hypervibe.hooks", "pass");
expect("git config get --default false hypervibe.hooks", "pass");
expect("git config --comment --unset user.email hunter2", "deny");
expect("git config --unset user.email", "pass");
// wrangler: a dry run is `--dry-run` once, with no value, before any `--`.
expect("wrangler deploy --dry-run", "pass");
expect("npx wrangler@latest deploy --dry-run", "pass");
expect("wrangler deploy --name x --dry-run", "pass");
expect("wrangler deploy --dry-run=false", "ask");
expect("wrangler deploy --dry-run false", "ask");
expect("wrangler deploy --dry-run --no-dry-run", "ask");
expect("wrangler deploy --dryRun=false --dry-run", "ask");
expect("wrangler deploy -- --dry-run", "ask");
expect('wrangler deploy --message "x --dry-run y"', "ask");
expect("wrangler deploy --dry-run$(echo x)", "ask");
expect("wrangler deploy $EXTRA --dry-run", "ask");
// The clock's own scripts: a flag counts when the script reads it as set, by the reading of
// their own parser (`--name value`, `--name=value`, the last one given wins, an empty value is
// not set). Looked for in the text, it spared the question for a real run.
expect("node scripts/shared-worker/ensure.mjs --dry-run", "pass");
expect('node scripts/shared-worker/ensure.mjs "--dry-run"', "pass");
expect("node scripts/shared-worker/ensure.mjs --no-deploy", "pass");
expect("node scripts/shared-worker/ensure.mjs --dir /tmp/x --dry-run", "pass");
expect("node scripts/shared-worker/ensure.mjs --dry-run 2>&1", "pass");
expect('node scripts/shared-worker/ensure.mjs --dry-run ""', "ask");
expect("node scripts/shared-worker/ensure.mjs --dry-run --dry-run=", "ask");
expect("node scripts/shared-worker/ensure.mjs --dry-run=", "ask");
expect('node scripts/shared-worker/ensure.mjs --dir "x --dry-run y"', "ask");
expect("node scripts/shared-worker/ensure.mjs --dry-running", "ask");
expect("node scripts/shared-worker/ensure.mjs --dry-run$(echo x)", "ask");
expect("node scripts/shared-worker/ensure.mjs $EXTRA --dry-run", "ask");
expect("node scripts/shared-worker/ensure.mjs > --dry-run", "ask");
expect("node scripts/shared-worker/worker-check.mjs --no-deploy", "pass");
expect("node scripts/shared-worker/worker-check.mjs --no-deploy --no-deploy=", "ask");
// register.mjs and migrate-live.mjs read no --dry-run: until 3.3.10 it spared the question
// all the same, and the registration went out. --list only lists, whatever else is given;
// --no-deploy sends nothing, except with --rotate-secret, which writes the secret anyway.
expect("node scripts/shared-worker/register.mjs --kind ping --task-name t --cron '0 8 * * *' --app-url https://x.test --project-name p", "ask");
expect("node scripts/shared-worker/register.mjs --kind ping --task-name t --cron '0 8 * * *' --app-url https://x.test --project-name p --dry-run", "ask");
expect("node scripts/shared-worker/register.mjs --kind ping --task-name t --cron '0 8 * * *' --app-url https://x.test --project-name p --no-deploy", "pass");
expect("node scripts/shared-worker/register.mjs --list --kind ping --task-name t", "pass");
expect("node scripts/shared-worker/register.mjs --list= --kind ping --task-name t", "ask");
expect('node scripts/shared-worker/register.mjs --kind ping --task-name "x --list"', "ask");
expect('node scripts/shared-worker/register.mjs --kind ping --task-name "x --no-deploy"', "ask");
expect("node scripts/shared-worker/register.mjs --kind ping --no-deploy --no-deploy=", "ask");
expect('node scripts/shared-worker/register.mjs --kind ping --no-deploy ""', "ask");
expect("node scripts/shared-worker/register.mjs --kind ping --no-deploy$(echo x)", "ask");
expect("node scripts/shared-worker/register.mjs --kind ping $EXTRA --no-deploy", "ask");
expect("node scripts/shared-worker/register.mjs --rotate-secret --project-name p --no-deploy", "ask");
expect("node scripts/shared-worker/register.mjs --rotate-secret --project-name p --dry-run", "ask");
expect("node scripts/shared-worker/register.mjs --list --rotate-secret --project-name p", "pass");
expect("node scripts/shared-worker/register.mjs --remove --name j", "ask");
expect("node scripts/shared-worker/migrate-live.mjs", "ask");
expect("node scripts/shared-worker/migrate-live.mjs --dry-run", "ask");
expect("node scripts/shared-worker/migrate-live.mjs --no-deploy=", "ask");
expect("node scripts/delete-project/db-backup-remove-target.mjs --project p --dry-run", "ask");
expect("node scripts/delete-project/db-backup-remove-target.mjs --project p --no-deploy", "ask");
expect("node scripts/delete-project/db-backup-remove-target.mjs --project p --list", "ask");
// A removal with --no-deploy changes the registry on this machine and sends nothing: it wins over
// --rotate-secret, as register.mjs reads its modes.
expect("node scripts/shared-worker/register.mjs --remove --name j --rotate-secret --no-deploy", "pass");
// A flag nothing reads spares nothing.
expect("node scripts/shared-worker/register.mjs --kind ping --task-name t --decommission-confirme", "ask");
expect("node scripts/shared-worker/register.mjs --remove --name j --decommission-confirme", "ask");
expect("node scripts/delete-project/db-backup-remove-target.mjs --project p --decommission-confirme", "ask");
expect("node scripts/shared-worker/ensure.mjs --decommission-confirme", "ask");

console.log("\n── Un mot est lu comme le shell le remet, une option comme git la lit (3.3.10) ──");
// The rules name a command's words. Typed otherwise than bare, abbreviated the way git allows, or
// placed further along the line, each of these ran with no question, or past a refusal (the
// abbreviations and the positions tried on a throwaway repository, git 2.53).
expect('git "push" origin main', "ask");
expect("git 'push' origin main", "ask");
expect('git pu"sh" origin main', "ask");
expect("git \\push origin main", "ask");
expect("git $'push' origin main", "ask");
expect("git $'\\x70ush' origin main", "ask");
expect('git $"push" origin main', "ask");
expect('git add "-A"', "deny");
expect("git add '-A'", "deny");
expect("git add \\-A", "deny");
expect('git add "--all"', "deny");
expect("git add $'-A'", "deny");
expect("git add --al", "deny");
expect("git add --a", "deny");
expect("git add --upd", "deny");
expect("git add src --all", "deny");
expect('git commit "-a" -m x', "deny");
expect("git commit '--all' -m x", "deny");
expect("git commit -m x -a", "deny");
expect('git commit -m "un message" --all', "deny");
expect("git commit -sam x", "deny");
expect("git commit --amend --no-edit -a", "deny");
expect("git commit --fixup HEAD -a", "deny");
expect("git commit -mwip -a", "deny");
expect('git reset "--hard"', "ask");
expect("git reset --har", "ask");
expect("git reset --h", "ask");
expect("git reset HEAD~1 --hard", "ask");
expect("git reset -q --hard", "ask");
expect("git reset --me", "ask");
expect('git clean "-f"', "ask");
expect("git clean --forc", "ask");
expect("git clean . -f", "ask");
expect("git clean -d -x --f", "ask");
expect('git checkout -- "."', "ask");
expect("git checkout HEAD -- .", "ask");
expect('git restore "."', "ask");
expect("git restore -SW .", "ask");
expect("git restore --source=HEAD~1 './'", "ask");
expect('vercel "--prod"', "ask");
expect('pnpm "db:push"', "ask");
expect('git config "hypervibe.hooks" "true"', "ask");
// What must keep passing: a value is not an option, a message is not a command, and a path
// after `--` is a path.
expect('git commit -m "-a"', "pass");
expect("git commit -m '--all'", "pass");
expect("git commit -m -a", "pass");
expect('git commit -m "fix: the -a flag" src/a.ts', "pass");
expect("git commit -ma", "pass");
expect("git commit -Sabcdef -m x", "pass");
expect("git commit -uall -m x", "pass");
expect("git commit --message --all", "pass");
expect("git commit -F msg.txt -- -a", "pass");
expect("git commit -m x -- -a", "pass");
expect('git commit -m "push"', "pass");
expect('git add "src/a.ts" "src/b.ts"', "pass");
expect("git add -- -A", "pass");
expect('git add "-A file.txt"', "pass");
expect("git add --chmod=+x scripts/run.sh", "pass");
expect("git reset --soft HEAD~1", "pass");
expect("git reset HEAD src/a.ts", "pass");
expect("git reset -- --hard", "pass");
expect("git reset --mixed HEAD~1", "pass");
expect("git clean -n", "pass");
expect("git clean --dry-run", "pass");
expect("git checkout main", "pass");
expect('git checkout -b "feature/x"', "pass");
expect("git checkout -- src/a.ts", "pass");
expect("git checkout .gitignore", "pass");
expect("git restore src/a.ts", "pass");
expect('echo "push"', "pass");
expect("echo 'git push'", "pass");
expect("echo $'git push'", "pass");
expect("git log --all", "pass");
expect("git stash push -m x", "pass");
expect('wrangler "deploy"', "ask");
expect("wrangler 'secret' put X", "ask");

console.log("\n── Le chemin d'un script range dans une variable est lu a travers elle (3.3.10) ──");
// The rules on the plugin's scripts name the script a runtime launches. A path kept in a
// variable the command line itself sets hid it from every one of them: none of these asked.
const REGISTER_VAR = 'REGISTER="C:/Users/x y/plugin/scripts/shared-worker/register.mjs"';
expect(`${REGISTER_VAR}\nnode "$REGISTER" --kind ping --task-name t`, "ask");
expect(`${REGISTER_VAR}\nnode "$REGISTER" --list`, "pass");
expect(`${REGISTER_VAR}\nnode "$REGISTER" --kind ping --task-name t --no-deploy`, "pass");
expect(`${REGISTER_VAR}; node "$REGISTER" --remove --name j`, "ask");
expect(`${REGISTER_VAR} && node "\${REGISTER}" --kind quota --recipient a@b.test`, "ask");
expect(`${REGISTER_VAR}\nnode $REGISTER --kind ping`, "ask");
expect(`${REGISTER_VAR}\nresult=$(node "$REGISTER" --kind ping --task-name t)\necho "$result"`, "ask");
expect(`${REGISTER_VAR}\nlist=$(node "$REGISTER" --list)\necho "$list"`, "pass");
expect(`export ${REGISTER_VAR}\nnode "$REGISTER" --kind ping`, "ask");
expect('PLUGIN_DIR="C:/p/plugin"\nENSURE="$PLUGIN_DIR/scripts/shared-worker/ensure.mjs"\nnode "$ENSURE"', "ask");
expect('PLUGIN_DIR="C:/p/plugin"\nENSURE="$PLUGIN_DIR/scripts/shared-worker/ensure.mjs"\nnode "$ENSURE" --dry-run', "pass");
expect('X=register.mjs\ncd scripts/shared-worker && node "$X" --kind ping', "ask");
// Which value holds when the script runs depends on what ran: every value a name was given is
// read, and one that asks is enough.
expect(`${REGISTER_VAR}\nfalse && REGISTER=/tmp/autre.mjs\nnode "$REGISTER" --kind ping`, "ask");
expect(`REGISTER=/tmp/autre.mjs\n${REGISTER_VAR}\nnode "$REGISTER" --kind ping`, "ask");
// A prefix sets nothing for the words of its own command, which the shell expands first: the
// variable read is the one set before.
expect(`${REGISTER_VAR}\nREGISTER=/tmp/autre.mjs node "$REGISTER" --kind ping`, "ask");
// A dry run read through the variable still needs to be one: next to a substitution it is not.
expect('ENSURE="C:/p/scripts/shared-worker/ensure.mjs"\nnode "$ENSURE" --dry-run$(echo x)', "ask");
// What must keep passing: another script in a variable, a `$` between single quotes (a name,
// not a variable), a variable the line does not set, a variable whose value a command printed.
expect('X="C:/p/outils/planning/register.mjs"\nnode "$X" --kind ping', "pass");
expect("X=/tmp/rapport.mjs\nnode \"$X\" --kind ping", "pass");
expect(`${REGISTER_VAR}\nnode '$REGISTER' --kind ping`, "pass");
expect('node "$REGISTER" --kind ping', "pass");
expect('REGISTER=$(node resolve.mjs)\nnode "$REGISTER" --kind ping', "pass");
expect(`${REGISTER_VAR}\necho "$REGISTER --kind ping"`, "pass");
expect(`${REGISTER_VAR}\ncat "$REGISTER"`, "pass");
// `bun run` and `deno run` launch the script after `run`.
expect("bun run scripts/shared-worker/register.mjs --kind ping", "ask");
expect("deno run -A scripts/shared-worker/ensure.mjs", "ask");
expect("bun run scripts/shared-worker/register.mjs --list", "pass");
expect('S="C:/p/scripts/delete-project/execute-deletions.mjs"\nnode "$S" --project p', "ask");
expect('B="C:/p/scripts/delete-project/db-backup-remove-target.mjs"\nnode "$B" --project p', "ask");

console.log("\n── La table OpenCode : pas plus large que le garde-fou, la ou un motif peut le dire (3.3.10) ──");
{
  // OpenCode cannot run this hook: its questions are a table of globs (opencode.permission.json),
  // and it applies the LAST matching rule. A glob reads text: a flag that spares a question is
  // written where a glob can tell it is that flag (right after `git push`, or as the last word of
  // a command of the plugin's scripts), and anywhere else the question is asked. Until 3.3.10 the
  // table let `--dry-run` through wherever it stood, and on scripts that do not read it.
  const { decide } = await import(pathToFileURL(join(dirname(HOOK), "rules.mjs")).href);
  const bash = JSON.parse(readFileSync(join(dirname(HOOK), "opencode.permission.json"), "utf8")).permission?.bash ?? {};
  // OpenCode's own matching, read in its source (packages/core/src/util/wildcard.ts, 16/10/2026):
  // backslashes read as slashes, `*` for anything INCLUDING a line break (the `s` flag), `?` for one
  // character, and a final " *" made optional. Until 3.4.13 this model let `*` stop at a line
  // break, stricter than OpenCode: a rule that asks across two lines read as passing here.
  const asGlob = (g) => {
    let escaped = g.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
    return new RegExp(`^${escaped}$`, "s");
  };
  const openCodeSays = (command) => {
    let said = "allow";
    const input = command.replaceAll("\\", "/");
    for (const [glob, verdict] of Object.entries(bash)) if (asGlob(glob).test(input)) said = verdict;
    return said;
  };
  const hookSays = (command) => (decide(command) === null ? "allow" : "ask");
  const costumes = [
    ["git push --dry-run origin main", "allow"],
    ["git push --dry-run --no-dry-run origin main", "ask"],
    ["git push --dry-run --no-dry origin main", "ask"],
    ["git push --repo --dry-run origin main", "ask"],
    ["git push origin main main:x--dry-run", "ask"],
    ['git push -o "x --dry-run y" origin main', "ask"],
    ["git push --dry-run $EXTRA origin main", "ask"],
    ["git push --dry-run `cat options.txt` origin main", "ask"],
    ["wrangler deploy --dry-run", "allow"],
    ["npx wrangler@latest deploy --dry-run", "allow"],
    ["wrangler deploy --dry-run=false", "ask"],
    ["wrangler deploy --dry-run false", "ask"],
    ["wrangler deploy -- --dry-run", "ask"],
    ["wrangler deploy --message x\\ --dry-run", "ask"],
    ['node "C:/p/scripts/shared-worker/ensure.mjs" --dry-run', "allow"],
    ["node scripts/shared-worker/worker-check.mjs --dry-run", "allow"],
    ["node scripts/shared-worker/ensure.mjs --no-deploy", "allow"],
    ['node scripts/shared-worker/ensure.mjs --dry-run ""', "ask"],
    ["node scripts/shared-worker/ensure.mjs --dry-run --dry-run=", "ask"],
    ['node scripts/shared-worker/ensure.mjs --dir "x --dry-run"', "ask"],
    ["node scripts/shared-worker/ensure.mjs --dir x\\ --dry-run", "ask"],
    ["node scripts/shared-worker/register.mjs --list", "allow"],
    ["node scripts/shared-worker/register.mjs --kind ping --task-name t --no-deploy", "allow"],
    ["node scripts/shared-worker/register.mjs --kind ping --task-name t --dry-run", "ask"],
    ["node scripts/shared-worker/register.mjs --kind ping --task-name t --decommission-confirme", "ask"],
    ["node scripts/shared-worker/register.mjs --rotate-secret --project-name p --no-deploy", "ask"],
    ['node scripts/shared-worker/register.mjs --kind ping --task-name "x --list"', "ask"],
    ["node scripts/shared-worker/register.mjs --kind ping --task-name x\\ --list", "ask"],
    ["node scripts/shared-worker/migrate-live.mjs --no-deploy", "allow"],
    ["node scripts/shared-worker/migrate-live.mjs --dry-run", "ask"],
    ["node scripts/delete-project/db-backup-remove-target.mjs --project p", "ask"],
    ["node scripts/delete-project/db-backup-remove-target.mjs --project p --dry-run", "ask"],
  ];
  const fooled = costumes.filter(([command, expected]) => openCodeSays(command) !== expected || hookSays(command) !== expected).map(([command]) => command);
  checks += 1;
  if (fooled.length) failures += 1;
  console.log(`${fooled.length ? "FAIL" : "OK  "} la table OpenCode ne prend pas pour un essai a blanc ce qui n'en est pas un, et repond comme le garde-fou${fooled.length ? ` : ${fooled.join(" | ")}` : ""}`);

  // A word typed otherwise than bare, an option abbreviated or placed further along the line: the
  // table asks where a glob can tell, and what it lets through is what the hook lets through.
  const dressed = [
    ['git "push" origin main', "ask"],
    ["git 'push' origin main", "ask"],
    ["git \\push origin main", "ask"],
    ["git reset HEAD~1 --hard", "ask"],
    ["git reset -q --hard", "ask"],
    ["git reset --har", "ask"],
    ['git reset "--hard"', "ask"],
    ["git reset --me", "ask"],
    ["git clean . -f", "ask"],
    ["git clean --forc", "ask"],
    ["git clean -d -x --f", "ask"],
    ["git checkout HEAD -- .", "ask"],
    ['git checkout -- "."', "ask"],
    ["git restore -SW .", "ask"],
    ['git restore "."', "ask"],
    ["git reset --soft HEAD~1", "allow"],
    ["git reset HEAD src/a.ts", "allow"],
    ["git reset --mixed HEAD~1", "allow"],
    ["git clean -n", "allow"],
    ["git checkout main", "allow"],
    ["git checkout -- src/a.ts", "allow"],
    ["git restore src/a.ts", "allow"],
  ];
  // The forge's command line (lot 7 inventory, 06/10/2026): what publishes, destroys, exposes or
  // moves asks in both, and the reads and writes beside it pass in both.
  dressed.push(
    ["gh pr merge 3 --squash", "ask"],
    ["gh run rerun 42", "ask"],
    ["gh repo delete acme/site --yes", "ask"],
    ["gh secret delete CRON_SECRET", "ask"],
    ["gh api -X DELETE repos/acme/site/collaborators/bob", "ask"],
    ["gh api --method DELETE orgs/acme/members/bob", "ask"],
    ["gh repo edit acme/site --visibility public", "ask"],
    ["gh api -X POST repos/moi/site/transfer -f new_owner=acme", "ask"],
    ["gh pr view 3", "allow"],
    ["gh api user --jq .login", "allow"],
    ["gh secret list", "allow"],
    ["gh repo edit acme/site --visibility private", "allow"],
    // The forms the guard reads as gh reads them since 3.4.9: the table asks them too.
    ["gh pr -R octo/demo merge 12", "ask"],
    ["gh pr --repo octo/demo merge 12", "ask"],
    ["gh run -R octo/demo rerun 1", "ask"],
    ["gh secret -R octo/demo delete X", "ask"],
    ["gh variable --repo octo/demo delete Y", "ask"],
    ["gh api -X=DELETE repos/octo/demo/collaborators/bob", "ask"],
    ["gh api -iX DELETE repos/octo/demo/collaborators/bob", "ask"],
    ["gh api -X PATCH repos/octo/demo -f visibility=public", "ask"],
    ["gh api -X PATCH repos/octo/demo -F private=false", "ask"],
    ["gh api -X PUT repos/octo/demo/pulls/12/merge", "ask"],
    ["gh api -X POST repos/octo/demo/merges -f base=main -f head=x", "ask"],
    ["gh api -X POST repos/octo/demo/actions/runs/42/rerun", "ask"],
    ["gh release delete v1.0 --yes", "ask"],
    ["gh repo rename nouveau-nom", "ask"],
    ["gh pr -R octo/demo view 12", "allow"],
    ["gh run -R octo/demo list", "allow"],
    ["gh api -X PATCH repos/octo/demo -f description=x", "allow"],
    ["gh release list", "allow"],
  );
  // A repository created through the API is public unless the body says otherwise (3.4.10, found
  // by Bastien Detraz): the creations ask in both, and the bare read of the list passes in both.
  dressed.push(
    ["gh api user/repos -f name=demo", "ask"],
    ["gh api -X POST user/repos -f name=demo", "ask"],
    ["gh api -X POST /user/repos", "ask"],
    ["gh api orgs/acme/repos -f name=demo", "ask"],
    ["gh api user/repos --input corps.json", "ask"],
    ['gh api "user/repos" -f name=demo', "ask"],
    ["gh api -f name=demo orgs/my-org/repos", "ask"],
    ["gh api user/repos", "allow"],
    ["gh api orgs/my-org/repos", "allow"],
  );
  const undressed = dressed.filter(([command, expected]) => openCodeSays(command) !== expected || hookSays(command) !== expected).map(([command]) => command);
  checks += 1;
  if (undressed.length) failures += 1;
  console.log(`${undressed.length ? "FAIL" : "OK  "} la table OpenCode lit un mot habille et une option abregee ou deplacee comme le garde-fou${undressed.length ? ` : ${undressed.join(" | ")}` : ""}`);

  // Where a glob cannot tell, the table asks more, never less: `private=true` could be written
  // inside another field's value, so a private creation asks in OpenCode, where the hook lets it by.
  const privees = ["gh api user/repos -f name=demo -F private=true", "gh api orgs/acme/repos -f name=demo -f visibility=private"];
  const laissees = privees.filter((command) => openCodeSays(command) !== "ask");
  checks += 1;
  if (laissees.length) failures += 1;
  console.log(`${laissees.length ? "FAIL" : "OK  "} la table OpenCode demande aussi une creation privee, faute de pouvoir lire le champ${laissees.length ? ` : ${laissees.join(" | ")}` : ""}`);

  // Un changement chez un registraire (3.4.11, revue externe de la 3.4.10) : la table demande comme
  // le garde-fou. Elle ne sait pas lire ce que chaque registraire appelle une lecture (Porkbun lit
  // par POST, Namecheap ecrit par GET) : elle demande pour tout appel a un registraire, et pour
  // tout appel du script OVH du plugin, lectures comprises. Plus que le garde-fou, jamais moins.
  const registraires = [
    `curl -s -X PUT "https://api.lws.net/v1/domain/example.fr/dns" -d '{"ns1":"a"}'`,
    `curl -s -X PUT "https://developers.hostinger.com/api/domains/v1/portfolio/example.fr/nameservers" -d '{}'`,
    `curl -s -X PUT "https://api.gandi.net/v5/domain/domains/example.fr/nameservers" -d '{}'`,
    `curl -s -X POST "https://api.porkbun.com/api/json/v3/domain/updateNs/example.fr" --data @-`,
    `curl -s -X POST "https://eu.api.ovh.com/1.0/domain/example.fr/nameServers/update" --data @-`,
    `curl -s -G "https://api.namecheap.com/xml.response" --data-urlencode "Command=namecheap.domains.dns.setCustom"`,
    `node "C:/p/scripts/registrar-ovh.mjs" set-nameservers example.fr a.ns.cloudflare.com b.ns.cloudflare.com`,
  ];
  const ecarts = registraires.filter((command) => openCodeSays(command) !== "ask" || hookSays(command) !== "ask");
  checks += 1;
  if (ecarts.length) failures += 1;
  console.log(`${ecarts.length ? "FAIL" : "OK  "} la table OpenCode demande un changement chez un registraire, comme le garde-fou${ecarts.length ? ` : ${ecarts.join(" | ")}` : ""}`);
  const lectures = [
    `curl -s "https://api.lws.net/v1/domain/example.fr"`,
    `curl -s -X POST "https://api.porkbun.com/api/json/v3/ping" --data @-`,
    `curl -s -G "https://api.namecheap.com/xml.response" --data-urlencode "Command=namecheap.domains.getList"`,
    `node "C:/p/scripts/registrar-ovh.mjs" check`,
  ];
  const plus = lectures.filter((command) => openCodeSays(command) !== "ask" || hookSays(command) !== "allow");
  checks += 1;
  if (plus.length) failures += 1;
  console.log(`${plus.length ? "FAIL" : "OK  "} chez OpenCode, une lecture chez un registraire demande aussi, ou le garde-fou la laisse passer${plus.length ? ` : ${plus.join(" | ")}` : ""}`);

  // Une adresse d'API posee dans une variable plus tot sur la ligne (revue externe de la 3.4.11) :
  // l'hote vient alors AVANT curl dans le texte. La table le dit par des motifs dans cet ordre-la,
  // et demande comme le garde-fou.
  const variables = [
    'CF="https://api.cloudflare.com/client/v4"; curl -s -X DELETE "$CF/zones/z/dns_records/r"',
    'CF="https://api.cloudflare.com/client/v4"\ncurl -s -X DELETE "$CF/zones/z/dns_records/r"',
    "CF=https://api.cloudflare.com/client/v4; curl -s -X PUT \"$CF/zones/z/dns_records/r\" -d '{}'",
    'N="https://console.neon.tech/api/v2"; curl -s -X DELETE "$N/projects/p/branches/b"',
    'V=https://api.vercel.com; curl -s -X DELETE "$V/v9/projects/prj_1"',
    "G=\"https://api.gandi.net/v5\"; curl -s -X PUT \"$G/domain/domains/example.fr/nameservers\" -d '{}'",
    'PB="https://api.porkbun.com/api/json/v3"; curl -s -X POST "$PB/domain/updateNs/example.fr" --data @-',
  ];
  const passees = variables.filter((command) => openCodeSays(command) !== "ask" || hookSays(command) !== "ask");
  checks += 1;
  if (passees.length) failures += 1;
  console.log(`${passees.length ? "FAIL" : "OK  "} la table OpenCode demande aussi quand l'adresse d'une API est posee dans une variable${passees.length ? ` : ${passees.join(" | ")}` : ""}`);
}

console.log("\n── Robustesse (fail-open) ──");
checks += 1;
{
  const r = call({ tool_name: "Edit", tool_input: { file_path: "a.ts" } });
  const ok = r === null;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} un outil autre que Bash n'est pas concerne`);
}
checks += 1;
{
  const r = call("ceci n'est pas du JSON");
  const ok = r === null;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} stdin invalide -> laisse passer (fail-open)`);
}
checks += 1;
{
  const r = call({ tool_name: "Bash", tool_input: {} });
  const ok = r === null;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} commande absente -> laisse passer`);
}

// Revue externe de la 3.1.9 : ce que la lecture de la ligne de commande manquait.
// Le corps d'un heredoc est du texte (un message de commit qui cite `git add -A` n'est
// pas un balayage), une apostrophe entre guillemets doubles ne cache plus ce qui suit,
// les substitutions de processus sont jugees, et la regle 9 ne vise plus le ensure.mjs
// de n'importe quel projet.
expect("git commit -m \"$(cat <<'EOF'\nfix: garde-fou\n\ngit add -A reste refuse.\nEOF\n)\"", "pass");
expect("git commit -m \"$(cat <<'EOF'\nfix: garde-fou\n\ngit push origin main demande toujours.\nEOF\n)\"", "pass");
expect("git commit -m \"$(cat <<'EOF'\nfix(hooks): 1) le corps a des parentheses\nEOF\n)\"", "pass");
expect("git commit -m \"$(cat <<'EOF'\nfix(hooks): 1) le corps a des parentheses\nEOF\n)\" && git push origin main", "ask");
expect("cat <<'EOF' > notes.md\ngit add -A reste refuse.\nEOF", "pass");
expect("cat <<EOF > notes.md\n$(git push origin main)\nEOF", "ask");
expect("cat <<'EOF' > notes.md\n$(git push origin main)\nEOF", "pass");
expect("cat <<'EOF' > notes.md\nhello\nEOF\ngit push origin main", "ask");
expect("echo \"<<EOF\"\ngit push origin main\nEOF", "ask");
expect("cat <<< \"git add -A\"", "pass");
expect("cat <<-EOF\n\tgit add -A\n\tEOF", "pass");
expect("cat <<'EOF' > notes.md && git push origin main\nhello\nEOF", "ask");
expect("cat <<'EOF'\ngit add -A", "pass");
expect("echo \"l'accord $(git config hypervibe.hooks true)\"", "ask");
expect("msg=\"c'est parti $(git push origin main)\"", "ask");
expect("echo \"don't\" $(git push origin main)", "ask");
expect("echo 'it $(git push origin main)'", "pass");
expect("echo 'say \"hi' && git push origin main", "ask");
expect("x=$(echo \")\") && git push origin main", "ask");
expect("diff <(git push origin main) /dev/null", "ask");
expect("cat x | tee >(git add -A)", "deny");
expect("echo \"<(git push origin main)\"", "pass");
expect("cat < in.txt > out.txt", "pass");
expect("node ensure.mjs", "ask");
expect("node ./ensure.mjs", "ask");
expect("node scripts/setup/ensure.mjs", "pass");
expect("node autre-projet/worker-check.mjs", "pass");

// Rule 9 bis (3.3.9): the plugin's other scripts that redeploy the shared clock ask as well,
// in the forms the skills write; what deploys nothing stays free.
expect('node "C:/p/scripts/shared-worker/register.mjs" --kind ping --task-name t --cron "0 * * * *" --app-url https://a.test --project-name p --put-secrets', "ask");
expect('result=$(CRON_SECRET_VALUE="$X" node scripts/shared-worker/register.mjs --kind snapshot --target-name p)', "ask");
expect('CRON_SECRET_VALUE="$NEW" node scripts/shared-worker/register.mjs --rotate-secret --project-name p', "ask");
expect("node scripts/shared-worker/migrate-live.mjs --put-secrets", "ask");
expect("node scripts/delete-project/db-backup-remove-target.mjs --project p", "ask");
expect("cd scripts/shared-worker && node register.mjs --kind quota --recipient a@b.test", "ask");
expect("node scripts/shared-worker/register.mjs --list", "pass");
expect("node scripts/shared-worker/register.mjs --kind ping --no-deploy", "pass");
expect("node scripts/shared-worker/migrate-live.mjs --no-deploy", "pass");
expect("node autre-projet/scripts/register.mjs --kind ping", "pass");

// ... et la meme famille, trouvee en corrigeant : un commentaire qui contient une
// apostrophe, une commande envoyee en arriere-plan, un calcul qui contient `<<`, une
// ligne continuee par une barre oblique inverse.
expect("# don't\ngit push origin main", "ask");
expect("git status # git add -A", "pass");
expect("sleep 1 & git push origin main", "ask");
expect("node x.mjs > out.log 2>&1", "pass");
expect("node x.mjs &> out.log", "pass");
expect("echo ok >| out.txt", "pass");
expect("(( x = 1 << 2 ))\ngit push origin main", "ask");
expect("git push \\\n  origin main", "ask");

console.log("\n── Les deux gardes du SQL destructeur disent la meme chose (correctif du 20/09/2026) ──");
// Avant : le script connaissait DROP INDEX / VIEW / TYPE, pas cette regle. Refuse par le
// script, relance avec --destructif comme son message y invite, et plus personne n'etait
// interroge. Meme trou pour tout objet qu'aucune des deux listes ne nommait.
expect('node run-sql.mjs "DROP TYPE humeur"', "deny");
expect('node run-sql.mjs "DROP INDEX idx_clients_email"', "deny");
expect('node run-sql.mjs "DROP FUNCTION purge()"', "deny");
expect('node run-sql.mjs "DROP MATERIALIZED VIEW mv_ventes"', "deny");
expect('node run-sql.mjs "DROP POLICY lecture ON clients"', "deny");
expect('node run-sql.mjs --destructif "DROP TYPE humeur"', "ask");
// Avec le drapeau, une personne confirme TOUJOURS, meme quand la regle ne voit rien du SQL :
// une variable, un fichier, un bloc DO ne lui montrent rien, et "rien vu" n'est pas "rien a demander".
expect('node run-sql.mjs --destructif "$SQL"', "ask");
expect('node run-sql.mjs --destructif "SELECT 1"', "ask");
expect("node run-sql.mjs --destructif \"DO \\$\\$ BEGIN EXECUTE 'DROP TABLE clients'; END \\$\\$\"", "ask");
// Un WHERE qui ne borne rien vaut une absence de WHERE.
expect('node run-sql.mjs "DELETE FROM sessions WHERE true"', "ask");
expect('node run-sql.mjs "UPDATE users SET active = false WHERE 1=1"', "ask");
// ... et ce qui y ressemble sans en etre.
expect('node run-sql.mjs "SELECT dropped_at FROM imports"', "pass");
expect('node run-sql.mjs "DELETE FROM sessions WHERE truc = 1"', "pass");
expect('node run-sql.mjs "UPDATE users SET active = false WHERE true_flag = 1"', "pass");

// Un appel nu a l'API du fournisseur de base qui detruit ou modifie demande une confirmation
// (le nettoyage sur copie de /clean supprime sa copie ainsi) ; lire et creer passent.
expect('curl -sf -X DELETE -H "Authorization: Bearer $K" https://console.neon.tech/api/v2/projects/p/branches/b', "ask");
expect('curl -s --request PATCH https://console.neon.tech/api/v2/projects/p -d "{}"', "ask");
expect('curl -s -H "Authorization: Bearer $K" https://console.neon.tech/api/v2/projects', "pass");
expect('curl -s -X POST https://console.neon.tech/api/v2/projects/p/branches -d "{}"', "pass");
expect("curl -s -X DELETE https://api.exemple.fr/v1/choses/3", "pass");

{
  // Parite : la meme instruction, vue par le script et par la regle. Les deux listes ont
  // deja diverge une fois ; ce controle casse le jour ou l'une bouge sans l'autre.
  const { statementsDestructrices } = await import(
    pathToFileURL(join(dirname(HOOK), "..", "scripts", "neon", "run-sql.mjs")).href
  );
  const instructions = [
    "DROP TABLE clients", "DROP TYPE humeur", "DROP INDEX i", "DROP VIEW v", "DROP MATERIALIZED VIEW mv",
    "DROP FUNCTION f()", "DROP TRIGGER t ON c", "DROP POLICY p ON c", "DROP SEQUENCE s", "DROP EXTENSION vector",
    "DROP SCHEMA public CASCADE", "TRUNCATE t", "ALTER TABLE t DROP COLUMN c", "ALTER TABLE t DROP CONSTRAINT k",
    "DELETE FROM t", "DELETE FROM t WHERE true", "UPDATE t SET a = 1", "UPDATE t SET a = 1 WHERE 1=1",
    "SELECT 1", "DELETE FROM t WHERE id = 3", "UPDATE t SET a = 1 WHERE id = 3", "INSERT INTO t (a) VALUES (1)",
    "CREATE INDEX i ON t (a)", "CREATE TABLE t (id int)", "SELECT dropped_at FROM imports",
    // La ou les deux gardes pouvaient se separer : un mot-cle dans une chaine (revue externe, 3.2.5).
    "INSERT INTO log (msg) VALUES ('DROP TABLE users')", "INSERT INTO log (msg) VALUES ('TRUNCATE users')",
    "SELECT 'DROP TABLE users' AS exemple", "SELECT * FROM users WHERE note LIKE '%DROP TABLE%'",
    "UPDATE doc SET corps = 'DELETE FROM users' WHERE id = 1", "DELETE FROM t WHERE note = 'x'",
    "INSERT INTO t (a, b) VALUES (1, 2) ON CONFLICT (a) DO UPDATE SET b = 2",
  ];
  const ecarts = instructions.filter((sql) => {
    const script = statementsDestructrices(sql).length > 0;
    const regle = (bash(`node run-sql.mjs "${sql}"`)?.permissionDecision ?? "pass") !== "pass";
    return script !== regle;
  });
  checks += 1;
  if (ecarts.length) failures += 1;
  console.log(
    `${ecarts.length ? "FAIL" : "OK  "} parite script / regle sur ${instructions.length} instructions${ecarts.length ? ` : ${ecarts.join(" | ")}` : ""}`,
  );
}

console.log("\n── Un shell qui lit son script ailleurs que dans un -c (revue externe, 3.2.4) ──");
// Le corps d'un heredoc est une donnee pour toute commande, sauf pour un shell qui le lit :
// c'est alors son script. Meme chose pour un here-string, un tube, un <(...).
expect("bash <<'EOF'\ngit push origin main\nEOF\n", "ask");
expect("sh <<'SH'\ngit add -A\nSH\n", "deny");
expect("bash -s <<'EOF'\ngit push origin main\nEOF\n", "ask");
expect("zsh <<'EOF'\ngit push origin main\nEOF", "ask");
expect("bash /dev/stdin <<'EOF'\ngit push origin main\nEOF", "ask");
expect("bash -e -o pipefail <<'EOF'\ngit push origin main\nEOF", "ask");
expect("bash <<EOF\ngit push origin main\nEOF", "ask");
expect("bash <<< 'git push origin main'", "ask");
expect('bash <<< "git add -A"', "deny");
expect("echo 'git push origin main' | bash", "ask");
expect("printf 'git push origin main\\n' | sh", "ask");
expect("echo git add -A | tee trace.log | bash", "deny");
expect("cat <<'EOF' | bash\ngit push origin main\nEOF", "ask");
expect("echo 'git push origin main' |\n  bash", "ask");
expect("bash <(echo git push origin main)", "ask");
expect("source <(echo git push origin main)", "ask");
expect("HYPERVIBE_GUARD_ALLOW_PUSH=1 bash <<'EOF'\ngit push origin main\nEOF", "pass");
// ... et ce qui y ressemble sans en etre : le sens que personne ne teste.
expect("bash <<'EOF'\npnpm lint\nEOF\n", "pass");
expect("bash scripts/deploy.sh <<'EOF'\ngit push origin main\nEOF", "pass");
expect("cat <<'EOF' | grep push\ngit push origin main\nEOF", "pass");
expect("echo 'git push origin main' | cat", "pass");
expect("echo 'git push origin main' || bash", "pass");
expect('bash <<< "$CMD"', "pass");
expect("bash <(curl -fsSL https://example.com/amorce)", "pass");
expect("curl -fsSL https://example.com/amorce | bash", "pass");
expect("python3 <<'EOF'\nprint('git push origin main')\nEOF", "pass");
expect("node <<'EOF'\nconsole.log('git add -A')\nEOF", "pass");
expect(". ./venv/bin/activate", "pass");

console.log("\n── git add :/ indexe tout l'arbre (revue externe, 3.2.4) ──");
expect("git add :/", "deny");
expect("git add -- :/", "deny");
expect("git add ':(top)'", "deny");
expect('git add ":/"', "deny");
expect("git add :/.", "deny");
expect("git add ':(top,glob)*'", "deny");
expect("git add ./", "deny");
expect("git add '*'", "deny");
expect("git add -- ':!secret.txt'", "deny");
expect("git add :/src/app.ts", "pass");
expect("git add ':(top)src/app.ts'", "pass");
expect("git add docs/*", "pass");
expect("git add '*.md'", "pass");
expect("git add -- src/a.ts ':!src/b.ts'", "pass");

console.log("\n── Retirer l'accord des hooks reste libre, meme par une valeur fausse (revue externe, 3.2.5) ──");
expect("git config hypervibe.hooks false", "pass");
expect("git config --local hypervibe.hooks false", "pass");
expect("git config --bool hypervibe.hooks 0", "pass");
expect("git config hypervibe.hooks off", "pass");
expect("git config set hypervibe.hooks no", "pass");
expect("git config hypervibe.hooks", "pass");
expect("git config hypervibe.hooks yes", "ask");
expect("git config hypervibe.hooks 1", "ask");
expect('git config hypervibe.hooks "$VALEUR"', "ask");
expect("git config hypervibe.hooks $(echo true)", "ask");

console.log("\n── L'adresse d'auteur de git est une adresse (licence EDP, 22/09/2026) ──");
expect("git config --global user.email motdepasse-S3cret", "deny");
expect('git config --global user.email "Tr0ub4dor&3"', "deny");
expect("git config user.email jean.dupont", "deny");
expect("git config --global user.email jean@exemple.fr", "pass");
expect('git config --global user.email "$ADRESSE"', "pass");
expect("git config --global --get user.email", "pass");
expect("git config --global user.email", "pass");
expect("git config --global --unset user.email", "pass");
expect('git config --global user.name "Jean Dupont"', "pass");
{
  checks += 1;
  const r = bash("git config --global user.email motdepasse-S3cret");
  const ok = r?.permissionDecision === "deny" && !/motdepasse-S3cret/.test(r.permissionDecisionReason ?? "");
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} le refus ne repete jamais la valeur ecartee`);
}

console.log("\n── Les appels destructeurs aux API que le plugin pilote demandent (revue externe, 3.2.5) ──");
expect('curl -s -X DELETE -H "Authorization: Bearer $VT" https://api.vercel.com/v9/projects/prj_1', "ask");
expect('curl -s -X DELETE -H "Authorization: Bearer $CFTOK" "https://api.cloudflare.com/client/v4/zones/z/dns_records/r"', "ask");
expect("curl -sS --request PATCH https://api.vercel.com/v9/projects/prj_1 -d '{}'", "ask");
expect("curl -s -XDELETE https://api.upstash.com/v2/redis/database/db1", "ask");
expect("curl -s -X PUT https://api.cloudflare.com/client/v4/zones/z/dns_records/r -d '{}'", "ask");
expect('curl -sf -X DELETE -H "Authorization: Bearer $K" https://console.neon.tech/api/v2/projects/p/branches/b', "ask");
expect('echo "$RECORDS" | node -e "x" | while read RID; do\n  curl -s -X DELETE -H "Authorization: Bearer $T" \\\n    "https://api.cloudflare.com/client/v4/zones/$Z/dns_records/$RID"\ndone', "ask");
expect("curl -s https://api.vercel.com/v9/projects", "pass");
expect("curl -s -X POST https://api.cloudflare.com/client/v4/zones/z/dns_records -d '{}'", "pass");
expect('curl -s -X PUT "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexemple.fr" -H "Authorization: Bearer $TOK"', "pass");
expect("curl -s -X PUT https://api.brevo.com/v3/senders/domains/exemple.fr/authenticate", "pass");
expect("curl -s -X DELETE https://api.exemple.fr/v1/choses/3", "pass");
expect("curl -s -X DELETE https://api.vercel.com.exemple.fr/v9/projects/x", "pass");
// La forme des skills depuis 3.3.7 : la cle arrive a curl sur son entree standard. La methode et
// l'adresse restent lues, et ce qui voyage dans cette configuration l'est aussi (revue externe, 3.3.6).
expect(`printf 'header = "Authorization: Bearer %s"\\n' "$K" | curl -sf --config - -X DELETE https://console.neon.tech/api/v2/projects/p/branches/b`, "ask");
expect(`CFTOK=$(node vault.mjs get CLOUDFLARE api_token) && printf 'header = "Authorization: Bearer %s"\\n' "$CFTOK" | curl -s --config - -X DELETE \\\n  "https://api.cloudflare.com/client/v4/zones/$Z/dns_records/$RID"`, "ask");
expect(`printf 'header = "Authorization: Bearer %s"\\n' "$K" | curl -s --config - https://console.neon.tech/api/v2/projects`, "pass");
expect(`printf 'header = "Authorization: Bearer %s"\\n' "$TOK" | curl -s --config - -X PUT "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexemple.fr"`, "pass");
expect(`printf 'request = "DELETE"\\n' | curl -s --config - https://api.vercel.com/v9/projects/prj_1`, "ask");
expect(`printf 'header = "Authorization: Bearer %s"\\nurl = "https://api.vercel.com/v9/projects/prj_1"\\nrequest = "DELETE"\\n' "$VT" | curl -s -K -`, "ask");
expect(`printf 'request = "%s"\\n' DELETE | curl --config - https://api.vercel.com/v9/projects/prj_1`, "ask");
expect(`echo '-X DELETE' | curl -s -K - https://api.vercel.com/v9/projects/prj_1`, "ask");
expect("curl -s --config - https://api.vercel.com/v9/projects/prj_1 <<'EOF'\nrequest: DELETE\nEOF", "ask");
expect(`curl -s -K - https://api.vercel.com/v9/projects/prj_1 <<< 'request = "DELETE"'`, "ask");
expect(`printf 'header = "Authorization: Bearer %s"\\n' "$VT" | curl -s --config - -X POST https://api.vercel.com/v10/projects`, "pass");
// Les options groupees, lues comme curl les lit.
expect("curl -sX DELETE https://api.vercel.com/v9/projects/prj_1", "ask");
expect("curl -sXDELETE https://api.vercel.com/v9/projects/prj_1", "ask");
expect("curl -fsSX PATCH https://api.vercel.com/v9/projects/prj_1 -d '{}'", "ask");
expect("curl --request=DELETE https://api.vercel.com/v9/projects/prj_1", "ask");
expect("curl -sH 'Accept: application/json' https://api.vercel.com/v9/projects", "pass");
// Une configuration lue dans un fichier ne l'est pas, comme un script : la frontiere est choisie.
expect("curl -s -K ./requete.cfg https://api.vercel.com/v9/projects/prj_1", "pass");
{
  // La regle couvre toutes les API de gestion que les scripts de ce harnais appellent : un
  // fournisseur ajoute a un script sans l'etre a la regle casse cette verification, au lieu de
  // rester hors de sa vue (la regle ne se rouvre plus fournisseur par fournisseur).
  const { MANAGED_API_HOSTS } = await import(pathToFileURL(join(dirname(HOOK), "rules.mjs")).href);
  const hosts = new Set();
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "tests") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.(?:mjs|js)$/.test(name)) {
        for (const m of readFileSync(full, "utf8").matchAll(/https:\/\/((?:api|console)\.[a-z0-9.-]+\.[a-z]{2,}|www\.googleapis\.com)/g)) hosts.add(m[1]);
      }
    }
  };
  visit(join(dirname(HOOK), "..", "scripts"));
  const missing = [...hosts].filter((h) => !MANAGED_API_HOSTS.includes(h));
  checks += 1;
  const ok = hosts.size > 0 && missing.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} la regle couvre les ${hosts.size} API de gestion appelees par les scripts${missing.length ? ` : manquent ${missing.join(", ")}` : ""}`);
}

console.log("\n── Un changement chez un registraire demande, comme une reecriture chez Cloudflare (revue externe, 3.4.10) ──");
// Les serveurs de noms d'un domaine deplacent tout le domaine, son site et son courrier : ces
// appels passaient sans question, parce que la verification ci-dessus ne lisait que scripts/ et
// que les registraires sont appeles depuis les skills. Les formes exactes des skills LWS et
// Hostinger, et une forme representative des quatre autres (la reproduction de l'auditeur).
{
  const LWS = `printf 'header = "X-Auth-Login: %s"\\nheader = "X-Auth-Pass: %s"\\n' "$LWS_LOGIN" "$LWS_KEY" | `;
  expect(`${LWS}curl -s --config - -o "$LNS" -w "%{http_code}" -X PUT -H "Accept: application/json" -H "Content-Type: application/json" "https://api.lws.net/v1/domain/example.fr/dns" -d '{"ns1":"a.ns.cloudflare.com","ns2":"b.ns.cloudflare.com","ns3":"a.ns.cloudflare.com","ns4":"b.ns.cloudflare.com"}'`, "ask");
  expect(`printf 'header = "Authorization: Bearer %s"\\n' "$TOK" | curl -s --config - -o "$HNS" -w "%{http_code}" -X PUT -H "Content-Type: application/json" "https://developers.hostinger.com/api/domains/v1/portfolio/example.fr/nameservers" -d '{"ns1":"a.ns.cloudflare.com","ns2":"b.ns.cloudflare.com"}'`, "ask");
  expect(`printf 'header = "Authorization: Bearer %s"\\n' "$GANDI" | curl -s --config - -X PUT -H "Content-Type: application/json" "https://api.gandi.net/v5/domain/domains/example.fr/nameservers" -d '{"nameservers":["a.ns.cloudflare.com","b.ns.cloudflare.com"]}'`, "ask");
  expect(`curl -s -X POST "https://api.porkbun.com/api/json/v3/domain/updateNs/example.fr" --data @-`, "ask");
  expect(`curl -s -X POST "https://eu.api.ovh.com/1.0/domain/example.fr/nameServers/update" -H "Content-Type: application/json" --data @-`, "ask");
  expect(`curl -s -G "https://api.namecheap.com/xml.response" --data-urlencode "Command=namecheap.domains.dns.setCustom" --data-urlencode "Nameservers=a.ns.cloudflare.com,b.ns.cloudflare.com"`, "ask");
  // La methode que les options font : des donnees envoient un POST, sauf -G ; une methode que la
  // ligne ne montre pas demande ; une configuration lue sur l'entree standard est lue.
  expect(`curl -s "https://api.gandi.net/v5/livedns/domains/example.fr/records" -d '{"rrset_name":"www"}'`, "ask");
  expect(`curl -s -X "$M" "https://api.gandi.net/v5/domain/domains/example.fr/nameservers"`, "ask");
  expect(`printf 'request = "PUT"\\n' | curl -s --config - "https://api.lws.net/v1/domain/example.fr/dns"`, "ask");
  expect(`curl -s -X POST "https://api.porkbun.com/api/json/v3/dns/delete/example.fr/123" --data @-`, "ask");
  expect(`curl -s -X POST "https://api.porkbun.com/api/json/v3/$EP" --data @-`, "ask");
  expect(`curl -s -G "https://api.namecheap.com/xml.response" --data-urlencode "Command=$CMD"`, "ask");
  // Le script OVH du plugin signe ses appels dans son propre processus : set-nameservers deplace
  // le domaine, check et nameservers lisent.
  expect(`node "$PLUGIN_DIR/scripts/registrar-ovh.mjs" set-nameservers example.fr a.ns.cloudflare.com b.ns.cloudflare.com`, "ask");
  expect(`node scripts/registrar-ovh.mjs "$VERB" example.fr`, "ask");
  expect(`X="/p/scripts/registrar-ovh.mjs"\nnode "$X" set-nameservers example.fr a b`, "ask");
  // Les lectures passent, telles que chaque registraire les dit : Porkbun lit par POST, Namecheap
  // ecrit par GET.
  expect(`printf 'header = "Authorization: Bearer %s"\\n' "$GANDI" | curl -s --config - "https://api.gandi.net/v5/organization/user-info"`, "pass");
  expect(`${LWS}curl -s --config - -H "Accept: application/json" "https://api.lws.net/v1/domain/example.fr"`, "pass");
  expect(`printf 'header = "Authorization: Bearer %s"\\n' "$TOK" | curl -s --config - "https://developers.hostinger.com/api/domains/v1/portfolio/example.fr"`, "pass");
  expect(`curl -s -X POST "https://api.porkbun.com/api/json/v3/ping" --data @-`, "pass");
  expect(`curl -s -X POST "https://api.porkbun.com/api/json/v3/domain/getNs/example.fr" --data @-`, "pass");
  expect(`curl -s -G "https://api.namecheap.com/xml.response" --data-urlencode "Command=namecheap.domains.dns.getList"`, "pass");
  expect(`curl -s https://eu.api.ovh.com/1.0/auth/time`, "pass");
  expect(`curl -s -G "https://api.gandi.net/v5/domain/domains" -d "per_page=100"`, "pass");
  expect(`node "$PLUGIN_DIR/scripts/registrar-ovh.mjs" check`, "pass");
  expect(`node scripts/registrar-ovh.mjs nameservers example.fr`, "pass");
  expect(`curl -s -X PUT "https://api.lws.net.example.com/x"`, "pass");
}
{
  // Chaque hote que les skills appellent par curl est classe : gere (la regle 5b), registraire
  // (5c), ou dans cette liste, avec ce qu'il fait. Un hote nouveau dans une skill casse cette
  // verification au lieu de rester hors de la vue de la regle. Seule la commande curl est lue,
  // jusqu'a la fin de la commande : un lien de prose sur la meme ligne n'en fait pas partie.
  const { MANAGED_API_HOSTS, REGISTRAR_APIS } = await import(pathToFileURL(join(dirname(HOOK), "rules.mjs")).href);
  const NOT_MANAGED = {
    "api.anthropic.com": "/rotate-secret lit la liste des modeles avec une cle neuve, pour la verifier",
    "api.openai.com": "/rotate-secret lit la liste des modeles avec une cle neuve, pour la verifier",
    "api.indexnow.org": "previent les moteurs de recherche qu'une page a change : rien a perdre",
    "api.ipify.org": "lit l'adresse publique de cet ordinateur (LWS la demande)",
    "nominatim.openstreetmap.org": "change une adresse en coordonnees (/add-map) : une lecture",
    "hypervibe.fr": "nomme dans l'en-tete User-Agent de /add-map, jamais appele",
    "packages.stripe.dev": "telecharge la cle de signature de la ligne de commande Stripe (Linux)",
    "raw.githubusercontent.com": "telecharge l'installeur de Homebrew (macOS)",
    "searchconsole.googleapis.com": "inspection d'une adresse dans Search Console : une lecture par POST",
  };
  const known = new Set([...MANAGED_API_HOSTS, ...REGISTRAR_APIS.map((r) => r.host)]);
  const BS = String.fromCharCode(92);
  const hosts = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (/^SKILL.*\.md$/.test(name)) {
        const text = readFileSync(full, "utf8").replace(/\r\n/g, "\n").split(`${BS}\n`).join(" ");
        for (const line of text.split("\n")) {
          for (const call of line.matchAll(/(?:^|[\s|;&(`$])curl\s+([^`]*?)(?=`|\s\|\s|;|\s&&\s|\s\|\|\s|$)/g)) {
            for (const m of call[1].matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.set(m[1].toLowerCase(), name === "SKILL.md" ? join(dir).split(/[\\/]/).pop() : name);
          }
        }
      }
    }
  };
  visit(join(dirname(HOOK), "..", "skills"));
  const unclassified = [...hosts.keys()].filter((h) => !known.has(h) && !NOT_MANAGED[h]).sort();
  const stale = Object.keys(NOT_MANAGED).filter((h) => !hosts.has(h));
  checks += 1;
  const ok = hosts.size > 0 && unclassified.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} les ${hosts.size} hotes que les skills appellent par curl sont tous classes${unclassified.length ? ` : non classes ${unclassified.map((h) => `${h} (${hosts.get(h)})`).join(", ")}` : ""}`);
  checks += 1;
  if (stale.length) failures += 1;
  console.log(`${stale.length ? "FAIL" : "OK  "} la liste des hotes non geres ne garde que des hotes appeles${stale.length ? ` : plus appeles ${stale.join(", ")}` : ""}`);
  checks += 1;
  // Les cinq registraires que les skills appellent encore par curl (OVH passe par le script du
  // plugin depuis la 3.4.11, IONOS et Infomaniak ne demandent plus de cle).
  const attendus = ["api.lws.net", "developers.hostinger.com", "api.gandi.net", "api.porkbun.com", "api.namecheap.com"];
  const absents = attendus.filter((h) => !hosts.has(h));
  if (absents.length) failures += 1;
  console.log(`${absents.length ? "FAIL" : "OK  "} la lecture des skills trouve les cinq registraires appeles par curl${absents.length ? ` : manquent ${absents.join(", ")}` : ""}`);
}

console.log("\n── Une adresse d'API posee dans une variable est lue a travers elle (revue externe de la 3.4.11) ──");
// La forme qu'un modele tape pour raccourcir une longue adresse. Aucune skill ne l'ecrit, mais elle
// passait les regles 5b et 5c, qui ne lisaient que la ligne de curl telle qu'elle est tapee : chez
// Cloudflare, Neon, Vercel, Gandi, et pour updateNs chez Porkbun, sur une ligne comme sur deux.
expect('CF="https://api.cloudflare.com/client/v4"; curl -s -X DELETE "$CF/zones/z/dns_records/r"', "ask");
expect('CF="https://api.cloudflare.com/client/v4"\ncurl -s -X DELETE "$CF/zones/z/dns_records/r"', "ask");
expect("export CF=https://api.cloudflare.com/client/v4 && curl -s -X PUT \"$CF/zones/z/dns_records/r\" -d '{}'", "ask");
expect('N="https://console.neon.tech/api/v2"; curl -s -X DELETE "$N/projects/p/branches/b"', "ask");
expect('V=https://api.vercel.com; curl -s -X DELETE "$V/v9/projects/prj_1"', "ask");
expect('B="https://api.cloudflare.com"; Z="$B/client/v4/zones"; curl -s -X DELETE "$Z/z/dns_records/r"', "ask");
expect("G=\"https://api.gandi.net/v5\"; curl -s -X PUT \"$G/domain/domains/example.fr/nameservers\" -d '{}'", "ask");
expect('PB="https://api.porkbun.com/api/json/v3"; curl -s -X POST "$PB/domain/updateNs/example.fr" --data @-', "ask");
expect('PB="https://api.porkbun.com/api/json/v3"\ncurl -s -X POST "$PB/domain/updateNs/example.fr" --data @-', "ask");
expect(`CF="https://api.cloudflare.com/client/v4"; printf 'header = "Authorization: Bearer %s"\\n' "$T" | curl -s --config - -X DELETE "$CF/zones/z/dns_records/r"`, "ask");
// Les lectures et les creations passent toujours, et une variable sans rapport ne change rien.
expect('CF="https://api.cloudflare.com/client/v4"; curl -s "$CF/zones?name=example.fr"', "pass");
expect("CF=\"https://api.cloudflare.com/client/v4\"; curl -s -X POST \"$CF/zones/z/dns_records\" -d '{}'", "pass");
expect('PB="https://api.porkbun.com/api/json/v3"; curl -s -X POST "$PB/ping" --data @-', "pass");
expect('X="https://api.exemple.fr"; curl -s -X DELETE "$X/v1/choses/3"', "pass");

console.log("\n── Une fonction ecrite sur une ligne, une configuration de curl batie sur une variable (revue externe de la 3.4.13) ──");
// Le corps d'une fonction ecrite sur une ligne passait toutes les regles : son en-tete (`f()`,
// `function f`) etait lu comme la commande. Il est lu desormais comme un bloc, appelee ou non,
// comme l'etait deja celui d'une fonction ecrite sur plusieurs lignes, dont les lignes sont des
// segments a part.
expect("f() { git push --force origin main; }; f", "ask");
expect("function f { git push --force origin main; }; f", "ask");
expect("function f() { git push --force origin main; }; f", "ask");
expect("f() ( git push --force origin main ); f", "ask");
expect("f() { git push --force origin main && true; } && f", "ask");
expect("f () { git push --force origin main; }", "ask");
expect("f(){ git push --force origin main;}; f", "ask");
expect("f() while git push --force origin main; do :; done", "ask");
expect("() { git push --force origin main; }", "ask");
expect("function { git push --force origin main; }", "ask");
expect("f() {\n  git push --force origin main\n}\nf", "ask");
expect("f() { git add -A; }; f", "deny");
expect("function f { git add -A; }", "deny");
expect('f() { curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1"; }; f', "ask");
// Ce qui y ressemble sans en etre passe toujours.
expect("f() { git status; }; f", "pass");
expect("function f { echo ok; }; f", "pass");
expect("functions_list --all", "pass");
expect("arr=(a b); echo ${arr[0]}", "pass");
expect("echo 'f() { git push; }'", "pass");
// L'adresse batie sur une variable dans la configuration que curl lit sur son entree standard :
// le shell remplace la variable dans les guillemets de l'echo, les arguments du printf et le corps
// d'un heredoc avant que curl lise la configuration.
expect('CF=https://api.cloudflare.com/client/v4; echo "url = \\"$CF/zones/z/dns_records/r\\"" | curl -s -X DELETE -K -', "ask");
expect(`CF="https://api.cloudflare.com/client/v4"; printf 'url = "%s/zones/z/dns_records/r"\\n' "$CF" | curl -s -X DELETE --config -`, "ask");
expect('CF=https://api.cloudflare.com/client/v4\ncurl -s -K - <<EOF\nrequest = "DELETE"\nurl = "$CF/zones/z/dns_records/r"\nEOF', "ask");
expect('PB="https://api.porkbun.com/api/json/v3"; echo "url = \\"$PB/domain/updateNs/example.fr\\"" | curl -s -X POST -K - --data @-', "ask");
// Une lecture passe toujours, et une variable sans rapport ne change rien.
expect('CF=https://api.cloudflare.com/client/v4; echo "url = \\"$CF/zones?name=example.fr\\"" | curl -s -K -', "pass");
expect('X=https://api.exemple.fr; echo "url = \\"$X/v1/choses/3\\"" | curl -s -X DELETE -K -', "pass");
// La position d'une expression partagee ne passe plus d'une lecture a l'autre : un long mot lu plus
// tot sur la ligne a travers la meme variable faisait sauter le $CF de la configuration (revue
// externe de la 3.4.14), chez Cloudflare, pour updateNs chez Porkbun et sous la forme heredoc.
expect(`CF=https://api.cloudflare.com/client/v4; L="${"x".repeat(40)}$CF"; echo "url = \\"$CF/zones/z/dns_records/r\\"" | curl -s -X DELETE -K -`, "ask");
expect(`PB="https://api.porkbun.com/api/json/v3"; L="${"x".repeat(40)}$PB"; echo "url = \\"$PB/domain/updateNs/example.fr\\"" | curl -s -X POST -K - --data @-`, "ask");
expect(`CF=https://api.cloudflare.com/client/v4; L="${"x".repeat(40)}$CF"\ncurl -s -K - <<EOF\nrequest = "DELETE"\nurl = "$CF/zones/z/dns_records/r"\nEOF`, "ask");
{
  // Dans un meme processus, comme la recette enchaine ses cas : un jugement ne laisse rien au suivant,
  // qu'il ait lu un long mot bati sur une variable ou une here-string (la forme de la revue externe
  // de la 3.4.14 : apres une seule here-string, le Porkbun ci-dessous passait).
  const { decide } = await import(pathToFileURL(join(dirname(HOOK), "rules.mjs")).href);
  const avants = [
    [`X=abc; Y="${"a".repeat(40)}$X"`, "un long mot"],
    [`L=${"y".repeat(60)}; grep -c x <<< "$L"`, "une here-string"],
  ];
  for (const [avant, quoi] of avants) {
    decide(avant);
    const apres = decide('PB="https://api.porkbun.com/api/json/v3"; echo "url = \\"$PB/domain/updateNs/example.fr\\"" | curl -s -X POST -K - --data @-');
    checks += 1;
    const ok = apres?.decision === "ask";
    if (!ok) failures += 1;
    console.log(`${ok ? "OK  " : "FAIL"} ask  un jugement ne laisse rien au suivant dans le meme processus, apres ${quoi} (revue externe de la 3.4.14)${ok ? "" : `   (obtenu: ${apres?.decision ?? "pass"})`}`);
  }
}
// Un mot de commande pose dans une variable de la ligne est lu comme le shell l'ecrit : la
// sous-commande, la commande, la ligne entiere (decoupee en mots), une option (revue externe de la
// 3.4.14). Une commande sans danger passe toujours.
expect("X=push; git $X --force origin main", "ask");
expect("G=git; $G push --force origin main", "ask");
expect('C="git push --force origin main"; $C', "ask");
expect("A=-A; git add $A", "deny");
expect('A="-A"; git add "$A"', "deny");
// Une variable seule et sans guillemets est decoupee en mots, comme le fait le shell : sa valeur
// peut porter la sous-commande et ses options a la fois.
expect('C="add -A"; git $C', "deny");
expect('P="push --force"; git $P origin main', "ask");
expect("X=status; git $X", "pass");
expect("G=git; $G status", "pass");
expect('F=README.md; git add "$F"', "pass");
// Un heredoc au delimiteur protege n'est pas developpe par le shell : son corps n'est plus lu a
// travers les variables de la ligne (une question de trop, revue externe de la 3.4.14). Le meme
// heredoc non protege demande toujours.
expect('CF=https://api.cloudflare.com/client/v4\ncurl -s -K - <<\'EOF\'\nrequest = "DELETE"\nurl = "$CF/zones/z/dns_records/r"\nEOF', "pass");
expect('CF=https://api.cloudflare.com/client/v4\ncurl -s -K - <<"EOF"\nrequest = "DELETE"\nurl = "$CF/zones/z/dns_records/r"\nEOF', "pass");
// La regle des registraires lit de meme une configuration nourrie par un heredoc : protege, rien
// n'y est lu a travers les variables ; non protege, le shell y ecrit $PB et la question tombe.
expect('PB="https://api.porkbun.com/api/json/v3"\ncurl -s -X POST -K - <<\'EOF\'\nurl = "$PB/domain/updateNs/example.fr"\nEOF', "pass");
expect('PB="https://api.porkbun.com/api/json/v3"\ncurl -s -X POST -K - <<EOF\nurl = "$PB/domain/updateNs/example.fr"\nEOF', "ask");
// Une here-string est developpee par le shell : la configuration qu'elle porte est lue a travers
// les variables de la ligne.
expect('CF=https://api.cloudflare.com/client/v4; curl -s -X DELETE -K - <<< "url = \\"$CF/zones/z/dns_records/r\\""', "ask");

console.log("\n── Les deux gardes SQL lisent la meme chose, chaines comprises (revue externe, 3.2.5) ──");
// La regle lit desormais la garde de run-sql.mjs dans le meme fichier : un mot-cle cite dans une
// chaine ne refuse plus rien, et un refus n'enseigne plus le drapeau --destructif pour rien.
expect("node run-sql.mjs \"INSERT INTO log (msg) VALUES ('DROP TABLE users')\"", "pass");
expect("node run-sql.mjs \"INSERT INTO log (msg) VALUES ('TRUNCATE users')\"", "pass");
expect("node run-sql.mjs \"SELECT 'DROP TABLE users' AS exemple\"", "pass");
expect("node run-sql.mjs \"SELECT * FROM users WHERE note LIKE '%DROP TABLE%'\"", "pass");
expect("node run-sql.mjs \"UPDATE doc SET corps = 'DELETE FROM users' WHERE id = 1\"", "pass");
expect("node run-sql.mjs \"DO \\$\\$ BEGIN EXECUTE 'DROP TABLE clients'; END \\$\\$\"", "deny");
expect('node run-sql.mjs --conn "$URL" "DROP TABLE clients"', "deny");

console.log("\n── xargs, et la frontiere de la commande fabriquee (revue externe, 3.2.6) ──");
expect("echo 'git push origin main' | xargs -I{} bash -c '{}'", "ask");
expect("echo 'git add -A' | xargs -I % sh -c '%'", "deny");
expect("echo main | xargs git push origin", "ask");
expect("xargs git push < branches.txt", "ask");
expect("xargs -0 -n1 git push origin", "ask");
// ... et ce qui y ressemble sans en etre.
expect("printf 'a.ts\\nb.ts\\n' | xargs git add", "pass");
expect("git diff --name-only | xargs git add", "pass");
expect("echo 'git push' | xargs -I{} echo {}", "pass");
expect("find src -name '*.ts' | xargs grep -l TODO", "pass");
// La frontiere choisie : ce que la substitution IMPRIME n'existe qu'a l'execution.
expect('bash <<< "$(echo git push origin main)"', "pass");

console.log("\n── xargs de macOS et autres lanceurs (revue externe, 3.3.1) ──");
expect("echo push origin main | xargs -J % git %", "ask");
expect("printf 'git push origin main' | xargs -0 -J % bash -c %", "ask");
expect("echo 'push origin main' | xargs -R 1 -I % git %", "ask");
expect("echo 'git push origin main' | xargs -S 1024 -I{} bash -c '{}'", "ask");
expect("find . -maxdepth 0 -exec git push origin main \\;", "ask");
expect("find . -maxdepth 0 -execdir git add -A \\;", "deny");
expect("find . -name x -ok git push origin main ';'", "ask");
expect("caffeinate -i git push origin main", "ask");
expect("stdbuf -oL git push origin main", "ask");
expect("timeout 60 git push origin main", "ask");
expect("timeout -k 5 60 git add -A", "deny");
// ... et ce qui y ressemble sans en etre.
expect("find src -name '*.ts' -exec grep -l TODO {} \\;", "pass");
expect("find . -name '*.log' -delete", "pass");
expect("timeout 60 pnpm test", "pass");
expect("stdbuf -oL pnpm dev", "pass");
expect("caffeinate -i pnpm build", "pass");
expect("echo a.ts | xargs -J % git add %", "pass");

console.log("\n── Accolades et options des lanceurs lues comme getopt (revue externe, 3.3.2) ──");
// Un {} colle a son mot n'est pas la fin d'un bloc { ...; } : lu ainsi, xargs recevait `git add {`.
expect("echo . | xargs -I{} git add {}", "deny");
expect("echo 'git push origin main' | xargs -I{} sh -c {}", "ask");
// Les options longues prennent leur valeur apres = OU dans le mot suivant, et un prefixe sans
// ambiguite vaut l'option entiere (getopt_long).
expect("timeout --signal KILL 60 git push origin main", "ask");
expect("timeout --kill-after 5 60 git add -A", "deny");
expect("timeout --sig KILL 60 git push origin main", "ask");
expect("timeout -vk 5 60 git push origin main", "ask");
expect("stdbuf --output L git push origin main", "ask");
expect("stdbuf --out L git push origin main", "ask");
expect("nice --adjustment 5 git push origin main", "ask");
expect("nice -n5 git push origin main", "ask");
expect("sudo --user root git push origin main", "ask");
expect("sudo -p '' git push origin main", "ask");
expect("sudo -iu root git add -A", "deny");
expect("env -C /tmp git push origin main", "ask");
expect("env --unset HOME git push origin main", "ask");
expect("exec -a nom git push origin main", "ask");
expect("setsid git push origin main", "ask");
// env -S : la valeur de l'option EST la commande.
expect("env -S 'git push origin main'", "ask");
expect("env --split-string='git push' origin main", "ask");
// Les blocs restent lus comme des blocs.
expect("{ git add -A;}", "deny");
expect("{ (git add -A); }", "deny");
// ... et ce qui y ressemble sans en etre.
expect("echo a.ts | xargs -I{} git add {}", "pass");
expect("timeout --signal KILL 60 pnpm test", "pass");
expect("stdbuf --output L pnpm dev", "pass");
expect("nice --adjustment 5 pnpm build", "pass");
expect("sudo --user root ls", "pass");
expect("env -S 'pnpm test'", "pass");
expect("echo ${HOME}", "pass");

console.log("\n── Accolades depliees comme le shell, lanceurs de macOS (revue externe, 3.3.4) ──");
// Le mot refuse n'apparait pas tel quel : le shell deplie les accolades avant de lancer.
expect("git add {.,.}", "deny");
expect("git add -{A,A}", "deny");
expect("git add {src,.}", "deny");
expect("git add {.,}", "deny");
expect("git add -{A..A}", "deny");
expect("{git,} add .", "deny");
expect("git add {a,{b,.}}", "deny");
expect("xcrun git add {.,.}", "deny");
expect("arch -arm64 git push origin main", "ask");
expect("arch -x86_64 git push origin main", "ask");
expect("arch -arch arm64 git push origin main", "ask");
expect("arch -e FOO=1 -arm64 git push origin main", "ask");
expect("arch -arm64 git add -A", "deny");
expect("xcrun git push origin main", "ask");
expect("xcrun --sdk macosx git push origin main", "ask");
expect("xcrun -sdk macosx git push origin main", "ask");
expect("xcrun -r git push origin main", "ask");
// ... et ce qui y ressemble sans en etre.
expect("git add src/{a,b}.ts", "pass");
expect("git add '{.,.}'", "pass");
expect('git add "{.,.}"', "pass");
expect("cp file.{js,ts} dir/", "pass");
expect("echo ${HOME} {a,b}", "pass");
expect("find . -name '*.ts' -exec grep -l foo {} \\;", "pass");
expect("xcrun --find clang", "pass");
expect("xcrun --show-sdk-path", "pass");
expect("arch -arm64 git --version", "pass");

console.log("\n── Accolades au-dela de la limite, trois lanceurs de macOS (revue externe, 3.3.5) ──");
// Un doublon ne change rien aux regles : chaque mot n'est garde qu'une fois pendant l'expansion.
expect(`git add .${"{,}".repeat(13)}`, "deny");
expect(`git add {.,.}${"{,}".repeat(12)}`, "deny");
expect(`git add .${"{,}".repeat(70)}`, "deny");
expect(`git add -{A,A}${"{,}".repeat(13)}`, "deny");
// Au-dela de ce que le garde-fou lit, il demande : ne pas pouvoir deplier n'est pas « rien ».
expect(`git add x${"{a,b}".repeat(13)}`, "ask");
expect(`git add .${"{,}".repeat(300)}`, "ask");
expect(`echo ${"{a,b}".repeat(13)}`, "ask");
expect("taskpolicy -b git push origin main", "ask");
expect("taskpolicy -c utility -t 2 git push origin main", "ask");
expect("sandbox-exec -n no-network git push origin main", "ask");
expect("sandbox-exec -f /tmp/profil.sb -D HOME=/tmp git push origin main", "ask");
expect("script -q /dev/null git push origin main", "ask");
expect("script -q -c 'git push origin main' /dev/null", "ask");
expect("/usr/bin/script -q /dev/null git add -A", "deny");
expect("sudo taskpolicy -b git add -A", "deny");
// ... et ce qui y ressemble sans en etre.
expect("script -q /dev/null pnpm test", "pass");
expect("script -q session.log", "pass");
expect("taskpolicy -b pnpm build", "pass");
expect("taskpolicy -b -p 1234", "pass");
expect("sandbox-exec -n no-network pnpm test", "pass");
expect("for i in {1..5000}; do echo $i; done", "pass");
expect(`echo ${"{a,b}".repeat(3)}`, "pass");
expect("cp a.{js,ts} dir/", "pass");

console.log("\n── Un dossier hooks/ recopie seul garde ses regles (revue externe, 3.2.6) ──");
{
  const { spawnSync } = await import("node:child_process");
  const { copyFileSync, mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const seul = mkdtempSync(join(tmpdir(), "hv-hooks-seuls-"));
  mkdirSync(join(seul, "hooks"));
  for (const f of ["guard-bash.mjs", "rules.mjs"]) copyFileSync(join(dirname(HOOK), f), join(seul, "hooks", f));
  const r = spawnSync(process.execPath, [join(seul, "hooks", "guard-bash.mjs")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git add -A" }, hook_event_name: "PreToolUse" }),
    encoding: "utf8",
  });
  rmSync(seul, { recursive: true, force: true });
  let decision = "pass";
  try {
    decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  } catch {
    /* rien sur stdout */
  }
  checks += 1;
  const ok = r.status === 0 && decision === "deny" && !/node:internal/.test(r.stderr);
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} hooks/ seul : exit ${r.status}, decision ${decision}${ok ? "" : `, stderr ${r.stderr.trim().split("\n")[0]}`}`);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const own = median(gaps);
checks += 1;
// The guardrail's own share of a call, whatever the machine and its load: under 75 ms. A guardrail
// that reads the network, waits, or loads a heavy module goes well above it.
const rapide = gaps.length >= 20 && own < 75;
if (!rapide) failures += 1;
console.log(
  `${rapide ? "OK  " : "FAIL"} cout propre du garde-fou : ${own.toFixed(0)} ms median par appel (budget 75 ms ; appel complet ${median(timings).toFixed(0)} ms, demarrage nu de Node ${median(bareStarts).toFixed(0)} ms, ${gaps.length} paires)`,
);
rmSync(dirname(BARE), { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
