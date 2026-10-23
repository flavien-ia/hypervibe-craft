# /delete-project

Cleanly and permanently deletes a Hypervibe project and all of its associated cloud infrastructure. Before any action, a big warning and a double confirmation, because the operation is **irreversible** (database, hosting, stored files, backups, domains, payment webhooks, cloud services).

## When to use it

- You are abandoning a project (test, prototype, obsolete app) and you want to **clean everything up** so you don't leave cloud infrastructure lying around
- You want to **avoid paying** for services that stayed active (Render, Stripe live, Neon beyond the free tier, etc.)
- You want to **free up quotas** on your free plans (Cloudflare R2, Neon, Vercel) for your next projects
- You want to **decommission** an app that will no longer be used (end of a mission, a client leaving, a complete redesign)
- You want to clear away an old folder or a mock-up **without any cloud infrastructure**: nothing is deleted for you, but Hypervibe tells you whether its code would be lost (never committed, never pushed, no repository at all) or whether it can go without loss, offers a backup first, finds the notes and skills that still name it, and gives you the folder to delete

## How it works

The deletion happens in **4 phases**, with an explicit validation point at each critical step.

**Phase 1: Identification + big warning**

1. Hypervibe asks you for the exact name of the project to delete (if not already provided as an argument).
2. A full-screen warning is displayed, listing everything that will be deleted: data, backups, the live site, stored files, any paid subscriptions.
3. **First confirmation**: Hypervibe offers you 3 options:
  - Yes, I confirm the permanent deletion
  - No, just pause it (suspend Vercel, put the database to sleep, without deleting anything)
  - No, I cancel
4. **Second confirmation**: Hypervibe asks you to **retype the exact name** of the project (case-sensitive) to validate. If the string does not match, the skill stops.

**Phase 2: Complete inventory**

Hypervibe runs a parallel scan over **17 surfaces** to identify everything that belongs to the project:
- Hosting (Vercel)
- Database (Neon)
- File storage (Cloudflare R2, in global and European versions)
- Automations (Cloudflare Workers)
- Domains and DNS, email forwarding (Cloudflare)
- Automatic backups (`db-backup` worker shared across your projects)
- Scheduled tasks (crons registered on the shared worker, which would otherwise keep pinging a dead URL)
- Background workers (Render)
- Payments (Stripe webhooks)
- Caches and queues (Upstash)
- Local and Vercel environment variables
- Local code folder + dependencies
- The project's Claude memory
- GitHub repo (deleted by the skill when `/bootstrap` created it for this project)

The scan also detects **third-party services** plugged in outside the Hypervibe stack (Sentry, OpenAI, Mapbox, Notion, etc.) by analyzing your environment variables.

Matching is precise to the word: each resource is attributed to the most specific project (deleting `street` touches nothing that belongs to `street-cool`), and the shared clock that runs your backups and scheduled tasks is never listed.

On Vercel, the site is looked for in **all your teams** (the free team Vercel creates for everyone, your company's, a client's), and designated by its id and its team, not only by its name. If two of your sites bear the same name in two different teams, Hypervibe asks you which one to delete instead of picking for you.

**Phase 3: Scope selection**

Hypervibe presents you with a clear recap in 4 sections:

- **🔵 Hypervibe infrastructure** that the skill can delete automatically
- **🟠 Detected third-party services** for you to delete yourself (Hypervibe gives you the exact URL and the click-by-click steps for each one)
- **🟡 Mandatory manual actions** (deletion of the local folder, of a GitHub repo `/bootstrap` did not create, the Google/GitHub OAuth clients) that the skill cannot do for you
- **⚪ Deliberately left untouched** (your Brevo/Resend account, parent Cloudflare zones, Stripe products; the project's own sending key, on the other hand, is revoked)

You choose: delete everything, or keep certain pieces (the database, the DNS, the code repository). The skill launches nothing until this choice is validated.

**Phase 4: Execution + report**

Hypervibe chains the deletions in parallel where possible (Vercel, R2, Workers, DNS, Stripe webhooks, Render, Upstash, Email Routing) then serially where there are dependencies (Neon, then removal of the project from the shared `db-backup` worker, then its scheduled tasks on the shared worker, then Claude memory, and the GitHub repo last).

If your vault has closed in the meantime (its session lasts six hours, and confirming can take an evening), nothing is deleted at all, the site included: Hypervibe asks you to open the vault again, then resumes with the same inventory. A project is never left half deleted for a key that could not be read.

At the end, a report shows you:
- ✅ What was deleted automatically
- 🟡 The manual actions you still have to do (local folder, GitHub repo, OAuth, detected third-party services), with the exact path and the clicks to make for each
- ℹ️ What was deliberately left in place

## What it does for you

- Deletes **all the automatable Hypervibe infrastructure** of the project in a single pass
- **Proactively detects the third-party services** you plugged in along the way and that could keep billing
- Gives you, for each remaining action, **the exact URL and the click-by-click instructions**
- Preserves **shared services** (Brevo, Resend, parent Cloudflare zones, automatic backups of other projects) without touching anything on them, except the project's own sending key, revoked with it
- Guarantees that **no orphaned resource is left lying around** in your cloud accounts

## Prerequisites

- The project must be a Hypervibe project (created via `/bootstrap`)
- You must be connected to the relevant services (`/start` handles this for Vercel, Cloudflare, GitHub, Neon)
- You must have administrator rights on the project (typically the case if you created it)

## Tips

{{callout:info|Protect the accounts shared between your projects}}
If several of your projects use the same personal account (an API key, a CRM), list it once in `~/.hypervibe/delete-project-keep.json` on your computer: `/delete-project` will then always keep it, whichever project you delete. Claude can write the rule for you. If this file becomes unreadable, the deletion says so before proposing anything.
{{/callout}}

{{callout:warning|The operation is strictly irreversible}}
Once the deletion is launched, **no data can be recovered**. If your project contains important information (real orders, user accounts, photos uploaded by clients...), first take a manual backup (DB export, copy of the local folder, dump of the R2 files) before launching the skill. The double confirmation exists precisely for that.
{{/callout}}

{{callout:tip|You can just pause it}}
If you are hesitant about permanently deleting, choose the "just pause it" option at the first confirmation. Hypervibe suspends the Vercel project and puts the Neon database to sleep: no spending, no traffic, but nothing is lost. You can reactivate later if needed, or re-run `/delete-project` to delete it for good.
{{/callout}}

{{callout:info|Stay in control of what gets deleted}}
At Phase 3, you are not required to delete everything in one block. For example, you can keep the database (to recover the data later) while deleting the hosting, or keep the DNS (to reuse the domain on a new project) while cleaning up the rest. Hypervibe offers you each option à la carte.
{{/callout}}

{{callout:info|The GitHub repo: only the one /bootstrap created}}
Hypervibe deletes one repository, and only that one: the repository `/bootstrap` created for this project, which the project's folder pushes to. The inventory says it plainly before you choose, and you can keep it. Any other repository (created by hand, adopted, or found only by its name) stays yours to delete: you receive its GitHub address at the end (in Settings: Danger Zone). To delete a repository, GitHub has to give Claude one more permission (`delete_repo`, deleting repositories): Hypervibe asks you before anything is deleted, and you paste a short code on a GitHub page. Say no, and the repository simply becomes a manual step.
{{/callout}}

{{callout:info|The local folder remains your responsibility}}
For security reasons, Hypervibe never deletes the code folder on your computer. At the end of the process, you receive the exact path to open in Windows Explorer to delete it. It is a conscious step to avoid losing code by mistake: until you delete it, the code still sits there, even once the repository is gone.
{{/callout}}
