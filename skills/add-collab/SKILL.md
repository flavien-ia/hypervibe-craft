---
name: add-collab
description: Manage GitHub collaborators on a project that uses the GitHub Actions deploy setup. Lists current collaborators, lets the user add or remove them, and explains how to do it manually. On first use (when the GitHub Actions deploy is not yet configured), it triggers the internal _setup-github-deploy helper to put the deploy infrastructure in place. The goal is to let any GitHub collaborator deploy without paying for a Vercel seat.
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Add Collab - Manage GitHub collaborators

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You manage the GitHub collaborators of the current project.

This skill assumes the project is hosted on GitHub and deployed via Vercel. The first time it runs on a new project, it sets up GitHub Actions as the deploy mechanism (via the `_setup-github-deploy` helper). On subsequent runs, it skips straight to collaborator management.

---

## Step 1 - Detect whether GitHub Actions deploy is already configured

Run two checks in parallel:

```bash
# Check 1 - workflow file exists locally
test -f .github/workflows/deploy.yml && echo "workflow:yes" || echo "workflow:no"

# Check 2 - the 3 Vercel secrets exist on GitHub
gh secret list 2>/dev/null | awk '{print $1}'
```

The setup is **complete** only if **all 4 conditions** are true:
- `.github/workflows/deploy.yml` exists locally
- Secret `VERCEL_ORG_ID` is listed
- Secret `VERCEL_PROJECT_ID` is listed
- Secret `VERCEL_TOKEN` is listed

If **any** of these is missing, the setup is incomplete → invoke the **`_setup-github-deploy`** internal skill, wait for it to complete, then continue to Step 2.

If everything is in place, tell the user:
> ✅ Collaborative deployment is already configured on this project. I'll check the key it deploys with, then go to the collaborators.

Then run Step 1b, **every time**, before Step 2.

### Step 1b - Check the Vercel key of an equipped project (every run)

Anyone who can write to the repository can read its `VERCEL_TOKEN` secret, by changing a workflow. That key must open **this project only**. A repository secret cannot be read back: the check can only bear on the key this machine holds, in the project's own vault item `<PROJECT>_VERCEL_GH` (field `api_token`; `<PROJECT>` is derived as in step 2a of `_setup-github-deploy`: print it with the same command).

```bash
VTOK=$(node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" get <PROJECT>_VERCEL_GH api_token); VCODE=$?
[ "$VCODE" -eq 0 ] && [ -n "$VTOK" ] && printf '%s' "$VTOK" | node "${CLAUDE_SKILL_DIR}/../../scripts/vercel/check-project-token.mjs" --project-dir .
echo "VAULT_EXIT=$VCODE"
```

Read the result:
- **`"verdict":"limitee"`**: the key reaches this project only. Say so in one line and continue to Step 2.
- **Vault exit code 4 (`VAULT_EXIT=4`), no item of the project**: the project was equipped **before 3.4.22**, with the account-wide key. Tell the person plainly: the key in this repository opens **their whole Vercel account** (every project and its variables) to anyone who can write to the repository, collaborators included. Offer to replace it now by a key limited to this project: on a yes, run steps 2 and 4 of `_setup-github-deploy` (the new key replaces the `VERCEL_TOKEN` secret; nothing else changes), which also tell the person to delete the old key on https://vercel.com/account/settings/tokens. Their general `VERCEL` key of the vault is no longer used by the repository, but **never delete the `VERCEL` item of the vault**: other skills use it.
- **`"verdict":"trop-large"`**: the project's own key sees more than this project. Same offer: replace it (steps 2 and 4 of `_setup-github-deploy`), then delete the old key on https://vercel.com/account/settings/tokens.
- **`"verdict":"invalide"`**: the key is refused (expired, deleted): deployments from GitHub stop working. Offer to make a new one (same steps).
- **Vault exit code 2 or 3**: the vault is closed; open it (`node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" unlock --lang <LANG>`) and run the check again. **`injoignable` / `indeterminee`**: say that the key could not be checked.

If the person declines the replacement, or the key could not be checked, do **not block** the management of collaborators: removing someone, in particular, must stay possible. But **never invite** anyone before the person has been told, in this run, what the key in the repository gives access to; the invitation confirmation in Step 4 repeats it in one line.

---

## Step 2 - List current collaborators

Get the repo identifier:
```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

List all collaborators (every page: the forge answers 30 at a time), then the invitations not accepted yet:
```bash
gh api --paginate repos/{owner}/{repo}/collaborators -q '.[] | {login, role: .role_name, permission: (if .permissions.admin then "admin" elif .permissions.push then "push" elif .permissions.triage then "triage" else "read" end)}'
gh api --paginate repos/{owner}/{repo}/invitations -q '.[] | {id, invitee: .invitee.login, permission: .permissions}'
```

Replace `{owner}/{repo}` with the value returned above. If either command fails, say so: an unread list is not an empty one, and nothing is added or removed until it reads.

Display the list to the user. Format example:
> ## 👥 Current collaborators on repo `{owner}/{repo}`
>
> 1. **you** - admin (owner)
> 2. **alice** - push (can commit, push, open PRs)
> 3. **bob** - triage (can view and triage issues, cannot commit)
>
> _Total: 3 collaborators_

If there's only the owner (you), tell the user:
> ## 👥 Current collaborators
>
> You are the only collaborator on repo `{owner}/{repo}` for now.

---

## Step 3 - Ask what the user wants to do

Tell the user:
> What would you like to do?
>
> - **Add a collaborator** - give me their **GitHub username** (e.g. `alice`).
> - **Remove a collaborator** - give me their **username** or their number in the list above.
> - You can do both in a single sentence, for example: *"Add charlie and remove bob"*.
> - Or reply **nothing** / **skip** to exit without changing anything.
>
> 💡 You can also do everything manually from the GitHub interface at any time:
> - **Add** → GitHub → your repo → **Settings** → **Collaborators and teams** → **Add people** → type the username → choose the role.
> - **Remove** → GitHub → your repo → **Settings** → **Collaborators and teams** → find the person → click **Remove**.

Wait for the user's response.

---

## Step 4 - Process the user's request

Parse the user's natural-language response. Identify each requested action (additions and removals can be combined in one message).

### For each ADD action

**Before the first invitation of the run, warn once** (in the person's language, plain words), and wait for a go:
> Before I invite anyone, two things to know:
> - **Production is open to every collaborator who can write.** On a free GitHub account, the main branch of a private repository cannot be protected (GitHub answers "Upgrade to GitHub Pro"): a collaborator with write access can push straight to `main`, which deploys to production. The safe habit: each person works on their own branch and opens a pull request, that you merge. GitHub Pro (or a paid organization) lets you protect `main` for real.
> - **What the Vercel key gives access to**: this project only (if Step 1b found it limited). A collaborator who can push code can still deploy code that reads every variable of this project, Sensitive ones included: invite only people you would trust with this project's secrets. Marking secrets **Sensitive** on Vercel still keeps them out of reach of the key alone.
>
> Shall I send the invitation?

If Step 1b found the key too broad and the person kept it, say it again here: the invitation also opens their whole Vercel account.

```bash
gh api repos/{owner}/{repo}/collaborators/{username} -X PUT -f permission=push
```

`permission=push` is the recommended default - the collaborator can commit, push, open PRs, and trigger the deploy workflow, but **cannot** change repo settings or delete branches.

If the user explicitly asks for another role, accept these values:
- `pull` - read-only (can clone, can't push)
- `triage` - can manage issues/PRs without write access
- `push` - default (can commit and push)
- `maintain` - push + can manage some repo settings (but not destructive)
- `admin` - full control, including deleting the repo (use with caution)

After each successful add, confirm:
> ✅ Invitation sent to **{username}** (role: `push`). They'll receive a GitHub email to accept before they get access to the repo.

If the API call fails (user not found, already a collab, etc.), report the error and continue with the other actions.

### For each REMOVE action

If the user gave a number from the list, resolve it to a username first.

```bash
gh api repos/{owner}/{repo}/collaborators/{username} -X DELETE
```

This is silent on success (HTTP 204). A person who has not accepted their invitation yet is not a collaborator: cancel the invitation instead, by its `id` from the list of Step 2:
```bash
gh api repos/{owner}/{repo}/invitations/{invitation_id} -X DELETE
```

Then read the forge again, and say "removed" only on what it answers: `GET .../collaborators/{username}` answers 204 while the person is still a collaborator and 404 once they are not.
```bash
gh api -i repos/{owner}/{repo}/collaborators/{username} 2>/dev/null | grep -m1 '^HTTP' || echo "NO_ANSWER"
INV=$(gh api --paginate repos/{owner}/{repo}/invitations -q '.[].invitee.login') \
  && { printf '%s\n' "$INV" | grep -qx "{username}" && echo "INVITATION_STILL_PENDING" || echo "NO_INVITATION"; } \
  || echo "INVITATIONS_UNREAD"
```
- A `404` status line and `NO_INVITATION` → removed.
- A `204` status line, or `INVITATION_STILL_PENDING` → the access is still there: the removal did not go through, say so.
- `NO_ANSWER`, `INVITATIONS_UNREAD`, or any other status → **unknown**: say that the removal could not be checked, never "removed".

After each verified remove, confirm:
> ✅ **{username}** has been removed from the collaborators.
>
> ⚠️ Important: they can no longer push or trigger a deploy. **But the deployments they already triggered stay online** - nothing is rolled back automatically. If you want to remove a specific deployment, do it manually from your Vercel dashboard.

If the user tries to remove themselves (the owner), refuse:
> ❌ You can't remove yourself from a repo you own. If you want to transfer ownership, do it from GitHub → Settings → **Transfer ownership**.

---

## Step 5 - Loop or finish

After processing all the user's actions, ask:
> Would you like to do anything else? (add / remove / skip)

If yes → return to Step 2 (re-list to show the updated state).
If no → continue to Step 6.

---

## Step 6 - Final summary

Show the updated collaborator list one last time (re-run Step 2's `gh api` command), then:

> ## ✅ Done
>
> Here's how to manage your collaborators going forward:
>
> - **With me**: just run `/add-collab` again any time.
> - **Manually on GitHub**:
>   - **Add** → Settings → Collaborators and teams → **Add people**
>   - **Remove** → Settings → Collaborators and teams → find the person → **Remove**
>
> All the collaborators you added can now deploy without paying for a Vercel seat: on every push to a branch, GitHub Actions builds a preview; on every push to `main`, GitHub Actions deploys to production.
