---
name: _setup-github-deploy
description: Internal helper invoked by /add-collab. Sets up GitHub Actions to deploy a Vercel-linked project, replacing Vercel's native Git integration. Configures Vercel token, GitHub secrets, the deploy workflow file, updates CLAUDE.md, and tells the user to suspend Vercel's native integration. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Setup GitHub Deploy - Internal helper

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You configure GitHub Actions to deploy a Vercel-linked project so that any GitHub collaborator can trigger deployments without a Vercel account.

This is a one-time setup per project. Once done, `/add-collab` will skip directly to collaborator management.

The caller (`/add-collab`) has already verified that the setup is missing - do not re-check, go straight to Step 1.

---

## Step 1 - Check prerequisites

```bash
gh auth status
vercel whoami
```

Verify the project is linked to Vercel:
```bash
test -f .vercel/project.json && echo "linked" || echo "not linked"
```

If `.vercel/project.json` does not exist, the project must be linked first. Tell the user:
> The project is not linked to Vercel yet. First run a full `/bootstrap`, or link it yourself with `vercel link --yes --project <name> --scope <team>` (the scope is the account or team that holds the project: without it, an account with several of them makes the command stop), then run `/add-collab` again.

Then exit. Otherwise continue.

## Step 2 - Get a Vercel key limited to THIS project

The key goes into the repository's secrets (`VERCEL_TOKEN`), and **anyone who can write to the repository can read a repository secret**, by changing a workflow. An account-wide key there hands every collaborator all the Vercel projects of the account and their variables (this is what 3.4.21 and earlier did). The key is therefore **limited to this project alone**, kept in a vault item of its own, and checked before it is posted.

**Never read, write or replace the `VERCEL` item of the vault here**: it is the person's global key, other skills use it, and it has nothing to do in a repository.

### 2a - Read the project and name its vault item

```bash
cat .vercel/project.json
```

Note `orgId`, `projectId` and `projectName`. The vault item of this project is `<PROJECT>_VERCEL_GH`, field `api_token`, where `<PROJECT>` is the project's name in capitals, every character outside `A-Z`, `0-9` and `_` replaced by `_` (the same rule as the `<PROJECT>_2FA` item of `/add-2fa`). Print it, and use that exact name in every command below:

```bash
node -e 'const fs=require("fs");let n="";try{n=JSON.parse(fs.readFileSync(".vercel/project.json","utf8")).projectName||""}catch{}if(!n)n=require("path").basename(process.cwd());console.log(n.toUpperCase().replace(/[^A-Z0-9_]/g,"_")+"_VERCEL_GH")'
```

### 2b - The person creates the key in Vercel's dashboard

Vercel refuses to create a key from the CLI (it answers 403): the person makes it in the dashboard. Tell the user (in their language, plain words):
> So that GitHub can deploy this project, it needs a Vercel key. We make one that only opens **this project**: a collaborator who could read it would reach nothing else of your Vercel account.
>
> 1. Open https://vercel.com/account/settings/tokens
> 2. Click **Create Token**
> 3. **Scope**: choose the Vercel team (or your account) that holds the project, then **this project only** (`{projectName}`)
> 4. Name: `gh-actions-{projectName}`
> 5. Expiration: **1 year** (put a reminder in your calendar: deployments stop the day it expires, and `/add-collab` will help you make a new one)
> 6. Click **Create**, and copy the key at once (it starts with `vcp_`; Vercel will not show it again)
> 7. A small window will then open on your machine: paste the key in there, never in our conversation.

### 2c - Collect it in the project's own vault item

Follow `_collect-secret`, then (after `_ensure-vault`):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" add --lang <LANG> \
  --name <PROJECT>_VERCEL_GH --service "Vercel (GitHub deploy of <projectName>)" --fields "api_token:secret"
```

**Do not continue until the command returns 0.** A non-zero exit means the user cancelled and there is no key to work with.

### 2d - Check that the key is limited to this project

The key goes to the check on its standard input, never as an argument and never printed. The check reads `.vercel/project.json`, asks Vercel for this project (it must answer), for the project list (this project alone), and for the account and the team (both must be refused):

```bash
VTOK=$(node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" get <PROJECT>_VERCEL_GH api_token) && [ -n "$VTOK" ] \
  || { echo "The vault is closed, or holds no <PROJECT>_VERCEL_GH api_token: nothing was checked."; exit 1; }
printf '%s' "$VTOK" | node "${CLAUDE_SKILL_DIR}/../../scripts/vercel/check-project-token.mjs" --project-dir .
```

It prints one JSON line; read its `verdict`:
- `"verdict":"limitee"` (exit 0): the key sees this project and nothing else. Continue.
- `"verdict":"trop-large"` (exit 2): the key sees other projects, the account or the whole team. **Never post it.** Tell the person the key opens more than this project, ask them to delete it on https://vercel.com/account/settings/tokens and to make a new one with the scope of step 2b (this project only), then go back to 2c.
- `"verdict":"invalide"` (exit 3): Vercel refuses it on this project (mistyped, expired, or limited to another project). Not posted; back to 2b.
- `"verdict":"injoignable"` (exit 4) or `"indeterminee"` (exit 5): nothing could be proved. Not posted; say so and offer to try again in a moment.

A closed vault stops the command before anything is checked: open it (`node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" unlock --lang <LANG>`), then run the same command again.

## Step 3 - Read project info from `.vercel/project.json`

`orgId` and `projectId`, read in step 2a. They are needed for the workflow.

## Step 4 - Store the 3 secrets in GitHub

`orgId` and `projectId` are identifiers, not secrets, so `--body` is fine for those. The **key is a secret**: putting it in `--body` would write it into the command line, which lands in the conversation exactly like a chat paste. `gh secret set` reads the value from **stdin** when `--body` is omitted. The key is checked again in the same command, so that only a key limited to this project can reach GitHub:

```bash
gh secret set VERCEL_ORG_ID --body "<orgId from .vercel/project.json>"
gh secret set VERCEL_PROJECT_ID --body "<projectId from .vercel/project.json>"
VTOK=$(node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" get <PROJECT>_VERCEL_GH api_token) && [ -n "$VTOK" ] \
  || { echo "The vault is closed, or holds no <PROJECT>_VERCEL_GH api_token: nothing was sent to GitHub."; exit 1; }
printf '%s' "$VTOK" | node "${CLAUDE_SKILL_DIR}/../../scripts/vercel/check-project-token.mjs" --project-dir . >/dev/null \
  || { echo "The key is not limited to this project (or could not be checked): nothing was sent to GitHub."; exit 1; }
printf '%s' "$VTOK" | gh secret set VERCEL_TOKEN
```

Verify all 3 are set:
```bash
gh secret list
```

You should see `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and `VERCEL_TOKEN` listed. If one is missing, re-run the corresponding `gh secret set`. A closed vault stops the key's command before anything is sent (piped directly, the vault's exit 2 printed nothing and GitHub received an empty value: outside review, 3.3.4): open it, then run the same command again.

When this step **replaces** a key posted earlier (the account-wide one of a project set up before 3.4.22, or a key that turned out too broad), tell the person:
> The new key, limited to this project, is in place. Two things left for you:
> - **delete the old key** on https://vercel.com/account/settings/tokens (it still opens your whole account until you do);
> - your general Vercel key, kept in your vault, is no longer used by your repositories. Keep it: other commands of Hypervibe use it.

Never delete the `VERCEL` item of the vault, whatever the person answers.

### What the limited key does not cover

Tell the person once, plainly: the key now reaches **this project only**. But anyone who can push code to the repository can deploy code that reads **every** variable of THIS project at build or run time, Sensitive ones included: inviting someone with write access means trusting them with this project's secrets. Marking secrets **Sensitive** on Vercel (Settings, Environment Variables) still helps: the key alone can no longer read them back, and the workflow below is made to work with them. Never claim Sensitive variables are out of a collaborator's reach.

## Step 5 - Create the workflow file

Create `.github/workflows/deploy.yml`:

```yaml
name: Vercel Deploy

# Why no `vercel pull → build → deploy --prebuilt` pattern:
# `vercel pull` does NOT download env vars marked "Sensitive" on Vercel
# (it's a security feature). If the user marks any required env var as
# Sensitive (highly recommended for secrets - ADMIN_PASSWORD_HASH, AUTH_SECRET,
# API keys), then `vercel build` on the GHA runner crashes because the env
# validator (T3 Zod schema) sees those vars as undefined.
#
# Solution: skip the `pull → build` part and let Vercel do the build itself.
# `vercel deploy [--prod]` without `--prebuilt` uploads the source code, and
# Vercel builds it inside its own infrastructure where Sensitive vars ARE
# injected (same behavior as the native GitHub auto-deploy integration).
#
# Trade-off: build minutes are consumed on Vercel (Hobby = 6000 min/mo, free)
# instead of GHA. Slightly slower (no GHA cache for node_modules) but ~10-30 s
# of difference on T3 projects, negligible. Build logs land in the Vercel
# dashboard, where the user is already going for analytics + env management.
#
# Result: the user can mark any var as Sensitive without breaking the GHA
# deploy - same security posture as Vercel's native integration, while still
# letting GitHub collaborators trigger deploys without paying for Vercel seats.

env:
  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

on:
  push:
    branches:
      - main
      - '**'

jobs:
  deploy-preview:
    if: github.ref != 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Install Vercel CLI
        # 65 or later: CLI 59 first asks for the account (/v2/user), which a key limited to the
        # project is refused, and stops on "Could not retrieve Project Settings" (seen 02/11/2026).
        run: npm install -g "vercel@>=65"

      - name: Deploy preview
        id: deploy
        # The CLI reads its token from VERCEL_TOKEN: never --token on its command line,
        # where the runner's process list shows it.
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
        run: |
          url=$(vercel deploy --yes)
          echo "url=$url" >> "$GITHUB_OUTPUT"

      - name: Comment deploy URL on commit
        uses: actions/github-script@v8
        with:
          script: |
            github.rest.repos.createCommitComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              commit_sha: context.sha,
              body: `Preview deployment: ${{ steps.deploy.outputs.url }}`
            });

  deploy-production:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Install Vercel CLI
        # 65 or later: CLI 59 first asks for the account (/v2/user), which a key limited to the
        # project is refused, and stops on "Could not retrieve Project Settings" (seen 02/11/2026).
        run: npm install -g "vercel@>=65"

      - name: Deploy production
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
        run: vercel deploy --prod --yes
```

> **Note:** if the production branch is not `main`, replace `main` with the correct branch name throughout.
>
> **Sensitive vars security**: you can (and you should) mark all your secrets as "Sensitive" on Vercel - `ADMIN_PASSWORD_HASH_*`, `AUTH_SECRET`, `STRIPE_SECRET_KEY`, etc. This workflow is designed to work with sensitive enabled, unlike the usual GHA templates (which use `vercel pull → build → deploy --prebuilt` and break as soon as a var is sensitive).

## Step 6 - Commit and push the workflow

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add GitHub Actions deploy for collaborators"
git push
```

Verify the workflow triggers on this push and the deployment succeeds. Wait a few seconds, then check:
```bash
gh run list --workflow=deploy.yml --limit 1
```

If the run is queued or in progress, that's fine - note it but continue. If the run failed immediately (most often a missing secret), investigate and fix before continuing.

If you do want to confirm that the deployment actually landed, **do not hand-roll a polling loop** (`for i in $(seq 1 20); do vercel ls ...; sleep 10; done`) - it dies on the harness's 2-minute `Bash` timeout without proving anything. Use the bundled waiter, which waits inside a single process:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vercel/check-deploy.mjs" --sha $(git rev-parse HEAD) --timeout 600
```

Exit codes: `0` ready, `1` failed, `2` timeout, `3` not configured. Use `run_in_background` for a long deploy.

## Step 7 - Update CLAUDE.md

Add (or update) a line in the **Stack** section of `CLAUDE.md`:
> Deploy mode: GitHub Actions (collaborator-friendly, no Vercel seats needed)

## Step 8 - Tell the user to suspend Vercel's native integration

This is **the only manual step** the user must do. Without it, every push will trigger TWO deployments (one from Vercel native, one from GitHub Actions), wasting build minutes and causing race conditions.

Tell the user:
> ✅ Deployment via GitHub Actions is in place.
>
> **Manual action required**: you now need to **suspend** Vercel's native integration on GitHub, otherwise you will get two parallel deployments on every push.
>
> 1. Go to **GitHub** → your repo → **Settings** → **Integrations** (or **Applications**)
> 2. Find **Vercel** in the list
> 3. Click **Configure** then **Suspend**
> 4. ⚠️ **Do not uninstall** - just suspend. That way you can revert easily if needed.
>
> Let me know when it's done.

**Wait for the user to confirm** before returning control to the caller.

## Step 9 - Done

Tell the user:
> ✅ GitHub Actions setup complete. You can now manage your collaborators.

Return control to the calling skill (typically `/add-collab`).


---

## Resource manifest (always)

Every cloud resource this skill creates or adopts is recorded in the project resource manifest (`.hypervibe/resources.json`, versioned with the code) - it is what `/save-project` and `/delete-project` read first, instead of guessing resources by name. Run the recording right after the resource exists; it is idempotent, silent on success, and stores identifiers only (never secrets). Full reference: the `_track-resource` skill.

Record the repository once it exists:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/manifest/manifest.mjs" add --project-dir "<project-root>" \
  --kind github-repo --name "<owner>/<repo>" --added-by <calling-skill>
```
