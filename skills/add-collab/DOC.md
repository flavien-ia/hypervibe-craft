# /add-collab

Invite or remove collaborators on your project without paying for one Vercel seat per person. Everything goes through GitHub and an automatic deployment system wired in as a replacement for the native Vercel integration.

## When to use it

- You want to **invite a developer** to work on your project without paying for an extra Vercel license
- You want to **remove a collaborator** (an employee leaving, end of an engagement, etc.)
- You just want to see your current list of collaborators

## How it works

1. **Setup detection**: the first time you run `/add-collab` on a project, Hypervibe detects that the **GitHub Actions** deployment chain is not yet configured. It sets it up automatically:
  - A Vercel key **limited to this project** is created (1 action in the Vercel dashboard, Hypervibe guides you through it), kept in your vault, and checked before it goes to GitHub: Hypervibe refuses a key that opens anything else of your Vercel account
  - The necessary secrets are pushed to GitHub
  - A workflow file is created so that every `git push` to `main` redeploys to production, and every other branch generates a preview deployment
  - **One last setting on the Vercel side for you to do yourself**: pause the native Vercel integration on GitHub to avoid having two deployments running in parallel on every push. Hypervibe gives you the exact clicks.

   This setup happens only **once per project**. On subsequent runs, Hypervibe checks the key again before going to your collaborators. A project set up before version 3.4.22 deploys with your whole-account key: Hypervibe tells you, and offers to replace it with a key limited to this project.

2. **Current list**: Hypervibe displays the existing collaborators with their role (admin / push / triage / read).

3. **Your actions**: you say in plain language what you want to do:
  - *"Add alice"*, an invitation is sent to the GitHub user `alice` with the default `push` role
  - *"Remove bob"*, bob is removed from the collaborators immediately
  - *"Add charlie and remove dave"*, multiple actions in a single sentence
  - *"Add eve as admin"*, a specific role (you can also ask for `pull`, `triage`, `push`, `maintain`)

4. **Verification + recap**: Hypervibe re-lists the collaborators after each action so you can see the up-to-date state. It says "removed" only once GitHub confirms it: an invitation still pending is cancelled, and a list that could not be read is said to be so.

## What it creates for you

- On the first run: the complete **GitHub Actions chain** (workflow + secrets) that lets you deploy without Vercel seats
- Over time: **invitations sent** to collaborators (they receive a GitHub email to accept)
- **Immediate removals** when you remove someone

## Prerequisites

- The project must be a **GitHub repo** linked to a **Vercel project** (typically after `/bootstrap`)
- You must be the owner (or have admin rights) on the repo

## Tips

{{callout:tip|Why GitHub Actions rather than native Vercel}}
By default, Vercel deploys via its native GitHub integration, but every GitHub collaborator who wants to view / trigger deployments must have a **paid Vercel seat** (~$20/month/person). By switching to GitHub Actions, **any GitHub collaborator** can trigger a deployment just by pushing, with no extra Vercel seat to pay for. You keep your single Vercel account as owner.
{{/callout}}

{{callout:warning|One push = one deploy}}
Once the chain is in place, **any push** to `main` (by any authorized collaborator) triggers a production deployment. Pushes to other branches create preview deployments. If you want to block that for some contributors, use GitHub's branch protection rules (require PR review before merging to main): on a private repository, they need GitHub Pro or a paid organization.
{{/callout}}

{{callout:warning|What a collaborator can reach}}
Anyone who can write to your repository can read the key GitHub deploys with. That is why it is limited to this project: they reach nothing else of your Vercel account. But someone who can push code can still deploy code that reads every variable of this project, even those marked **Sensitive** on Vercel: only invite people you would trust with this project's secrets. Marking your secrets Sensitive still helps, since the key alone can no longer read them back. Once you have replaced an old key, delete it on your Vercel key page; keep your general Vercel key in your vault, other commands use it.
{{/callout}}

{{callout:warning|The main branch of a private repository on a free GitHub account}}
On a free GitHub account, the main branch of a private repository cannot be protected: GitHub asks you to upgrade to GitHub Pro. A collaborator with write access can then push straight to production. Ask each person to work on their own branch and open a pull request that you merge. GitHub Pro (or a paid organization) lets you protect the main branch for real.
{{/callout}}

{{callout:info|Removing a collaborator does not roll back their deployments}}
When you remove someone, **the deployments they already made stay online**: nothing is undone automatically. If you want to remove a specific deployment, do it manually from your Vercel dashboard.
{{/callout}}
