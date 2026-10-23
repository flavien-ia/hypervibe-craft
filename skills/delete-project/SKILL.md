---
name: delete-project
description: "Cleanly deletes a Hypervibe project and all of its cloud infrastructure - Vercel, Neon, Cloudflare R2 (global + EU), Workers, DNS, db-backup, scheduled crons on the shared worker, Stripe webhook, Render services, OAuth clients, Upstash, etc. First, it displays a BIG warning and asks for a double confirmation (irreversible action). It then performs a COMPLETE inventory, also scanning environment variables to detect third-party services outside the hypervibe stack that might be connected (OpenAI, Mapbox, Sentry, etc.). At the end, it gives the user the paths (not the commands) of the folders to delete via Windows Explorer. Use when the user says \"delete project X\", \"completely clean up X\", \"/delete-project X\", \"clean up project X\", or wants to decommission a project."
allowed-tools: Bash Read Edit Write Glob AskUserQuestion TodoWrite
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Delete Project - Complete decommissioning

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You delete a Hypervibe project and **all** of its associated cloud infrastructure. The user is **non-technical**: no commands for them to type, no bare jargon, file paths to open in Windows Explorer rather than `rm -rf`.

The skill relies on 3 scripts that do the heavy lifting:

- **`scripts/delete-project/discover-resources.mjs`**: Phase 1 (inventory). Scans 17 surfaces in parallel (Vercel, Neon, R2, DNS, crons of the shared worker, env vars, etc.). Returns 1 structured JSON. ~3-5 sec.
- **`scripts/delete-project/execute-deletions.mjs`**: Phase 3 (execution). Takes the inventory + the scope chosen by the user, deletes in parallel where it is safe. Returns a {deleted, failed, skipped} report. Requires `--confirm <project-name>`, matched against the inventory: nothing it does can be undone, so the target is named rather than inherited from a command line that may be stale.
- **`scripts/delete-project/db-backup-remove-target.mjs`**: sub-script for the surgical edit of the shared `db-backup` worker.

Your role = orchestrate the confirmations, validate the scope, present things nicely, never hand-code what the scripts already handle.

---

## Phase 0 - Identify the project + BIG WARNING + double confirmation

### 0.1 Identify the project

If the user did not provide the name (`/delete-project <name>` or *"delete cool-trattoria"*), ask for it **before** displaying the warning - otherwise the warning will be generic.

If the name is ambiguous ("art", "site", "blog"), confirm: *"Do you want to delete the exact project `X`? I will look everywhere for resources named `X` or `X-*`."*

### 0.2 Display the warning (mandatory, never skippable)

```
╔══════════════════════════════════════════════════════════════╗
║  ⚠️  ⚠️  ⚠️    WARNING - IRREVERSIBLE ACTION    ⚠️  ⚠️  ⚠️    ║
╚══════════════════════════════════════════════════════════════╝

I am about to PERMANENTLY delete the project `<PROJECT_NAME>` and all
of its infrastructure:

 • The database and ALL its data (customers, orders,
   bookings, uploaded photos, user accounts...)
 • The automatic backups (they live in the same database)
 • The deployed site and its custom URL
 • The stored files (photos, documents, avatars)
 • Any paid subscriptions possibly linked to it
   (Stripe, Render, Upstash, etc.)
 • The code repository on GitHub, when /bootstrap created it
   for this project (the inventory says so, and you can keep it)

🔴  This is IRREVERSIBLE.
🔴  Nothing can be recovered after deletion.
🔴  If the project contains real data, take a manual backup first.
```

### 0.3 Offer an upfront backup (safety net)

**Even before the double confirmation**, explicitly offer the user to take a snapshot of the project. Display:

> 💡 **A tip before continuing**: do you have a complete backup of the project? If not, I can make one right now - it will create a zip with: code + Git history, database, env variables, R2 content, Claude memory, configs. You will have a safety net in case you change your mind or need to recover some data later.

Use `AskUserQuestion`:
- Question: "Take a backup of the project right before deleting it?"
- Options:
  - `Yes, do the snapshot now (recommended)`
  - `No, I already have a recent backup`
  - `No, I want to delete without a backup`

→ If **"Yes, do the snapshot now"**: **run inline** the snapshot script (without leaving the `/delete-project` skill). See the block below. Once the snapshot has completed successfully, continue with 0.4.
→ If **"No, already backed up"** or **"No, without a backup"**: continue directly with 0.4.

#### If a snapshot is requested: run it inline

First, silently check whether the project's storage keys are in its local environment:

```bash
(cd "<detected-project-path>" && node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" storage)
```

- If `storage.ok === true`: ask via `AskUserQuestion`, "Include the Cloudflare R2 content (can be heavy)?" - options `Yes` / `No, skip R2`.
- If `storage.ok === false`: this only says the keys are not in the local `.env`, **not** that the project has no bucket (keys kept only at the host, a bucket created by hand...). **Do not skip the storage**: run the snapshot without `--skip-storage`, and do not ask. Without the keys, the script looks for the project's buckets with the account token (its manifest first, then its name, in both jurisdictions) and downloads them, or reports that there is none. Skipping here used to leave the files out of the backup in silence, while Phase 3 then emptied the bucket.

No need to ask again for the project (we already have it) or the output folder (the default `~/Dropbox/Download/` is fine for this case).

Then run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/save-project/build-snapshot.mjs" \
  --project "<PROJECT_NAME>" \
  --project-dir "<detected-project-path>" \
  [--skip-storage ONLY if the user explicitly answered "No, skip R2"]
```

While it runs, relay the script's `[step] status` logs on stderr to the user (one `↳ ...` per step that finishes).

At the end, the script writes `{status, zipPath, zipSize, ...}` to stdout. Capture it, display the recap:

> ✅ **Snapshot created**: `<zipPath>` (`<zipSize>`) (this recap is valid only when `status` is `ok`; see the `partial` case below)
>
> The zip contains **secrets in plain text**: treat it as a confidential document. We can now continue with the deletion.

**If the snapshot fails** (script exit 1 or `status: "error"`): **stop the `/delete-project` skill** and warn the user. We never delete without a successful backup when the user has explicitly requested one. Display the error and offer: (a) re-run `/save-project` manually to diagnose, (b) re-run `/delete-project` afterwards saying that they already have the backup, (c) abort.

**If the snapshot comes back `status: "partial"`**: it succeeded, but with holes, and `incompleteSteps` names them (typically R2 objects that could not be downloaded after three retries). **Stop here too, and ask before going further.** This is the worst moment to round a hole up to a success: what the backup is missing is about to be deleted for good. Show which steps are incomplete and how many objects are missing, then offer: (a) re-run the snapshot (a fresh run, it does not resume), (b) continue the deletion anyway, knowing exactly what will be lost, (c) abort. Only an explicit answer from the user moves past this.

### 0.4 Double confirmation (Q1 via `AskUserQuestion`, Q2 as a free-text reply)

**Question 1**: "Do you confirm that you want to **permanently delete** the project `<PROJECT_NAME>` and that you accept the irreversible loss of all of its data?"
- Options: `Yes, I confirm` / `No, just pause it` / `No, cancel`

→ If **"pause it"**: explain briefly (suspend the Vercel project, put the Neon DB to sleep) then **stop the skill**.
→ If **"cancel"**: stop the skill.
→ If **"Yes"**: continue with Q2.

**Question 2** (free-text confirmation, **NOT** `AskUserQuestion`).
Ask it as a plain chat message. Do not use `AskUserQuestion`: it requires ≥2 preset options and cannot be a free-text field, so a single-option call fails validation with `too_small: options expected array to have >=2 items`. Send:
> "Final confirmation: reply with the exact name `<PROJECT_NAME>` (nothing else) to confirm the deletion."

Then compare the user's next reply to `<PROJECT_NAME>` **exactly** (case-sensitive, trimmed of surrounding whitespace). If it matches, proceed. If it does not match, refuse and stop.

**Under NO pretext should you proceed to the scan or the execution before these two explicit confirmations.** Even if the user wrote "delete everything without asking me again", the double-check is intentional.

---

## Phase 1 - Inventory (1 script call)

**Open the vault first**: invoke `_ensure-vault` before the inventory. The scan reads the Neon and Cloudflare keys from the vault, and with the vault locked or expired every cloud section comes back `unknown` behind a message that reads like a missing key (reported on 3.1.5). A scope must never be built on a sleeping vault.

```bash
# A folder of its own for THIS run (mkdtemp: unique name, created atomically), in the
# system temp dir, forward slashes so bash, node and the Read tool resolve the same path.
# Never a fixed file name: on 25/09/2026 two deletions running at the same time wrote the
# same inventory file, and one of them read a JSON mixed with the other project's.
# Never /tmp/... either: on Windows Git Bash it is not where node looks.
RUN_DIR="$(node -e "const fs=require('fs'),os=require('os'),p=require('path');console.log(fs.mkdtempSync(p.join(os.tmpdir(),'hv-delete-<PROJECT_NAME>-')).replaceAll(String.fromCharCode(92),'/'))")"
INV="$RUN_DIR/inventory.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/delete-project/discover-resources.mjs" \
  --project "<PROJECT_NAME>" \
  --project-dir "<detected-project-path>" > "$INV"; CODE=$?
# 2 or 3: the vault is locked or expired and no key is readable without it. No inventory.
if [ "$CODE" = "2" ] || [ "$CODE" = "3" ]; then echo "VAULT_CLOSED=$CODE"; rm -f "$INV"; rmdir "$RUN_DIR"; exit 0; fi
echo "INVENTORY_FILE=$INV"
cat "$INV"
```

**If the block prints `VAULT_CLOSED=...`**: the script refused to scan, because every cloud section would have come back "unknown". No inventory exists. Invoke `_ensure-vault`, then run the block again. (Someone who keeps their keys in environment variables, without a vault, is not concerned: as soon as one key is readable that way, the scan runs.)

The script scans the 17 surfaces in parallel: Vercel (every team of the account, all pages, each project with its id and its team; REST API first, the CLI with an explicit team when the token is refused), Neon (REST API), Cloudflare Workers / R2 (REST API, global+EU) / DNS / Email Routing, db-backup worker (BACKUP_TARGETS), cron ping jobs of the shared `hypervibe-jobs` worker (matched by their `project` field in the registry), Render, Stripe (webhooks + products), Upstash, env vars (Vercel pull + diff whitelist) → detection of third-party services (Sentry, PostHog, Mapbox, OpenAI, etc.), local folder + package.json, Claude memory, GitHub repo, Google/GitHub OAuth via present vars.

The resulting JSON has the form:

```json
{
  "project": "cool-trattoria",
  "scannedAt": "...",
  "vercel":       {
    "found": true,
    "projects": [{ "id": "prj_...", "name": "cool-trattoria", "teamId": "team_...", "teamSlug": "acme", "teamName": "Acme", "personal": false, "via": "link" }],
    "ambiguous": false,
    "linked": { "projectId": "prj_...", "orgId": "team_...", "projectName": "cool-trattoria", "status": "found" },
    "names": [...],
    "source": "rest"
  },
  "neon":         { "found": true, "projects": [{ "id": "...", "name": "..." }] },
  "workers":      { "found": true, "workers": [...] },
  "r2":           { "found": true, "buckets": [{ "name": "...", "jurisdiction": "eu", "createdAt": "...", "objectCount": 543, "sizeBytes": 84700646 }] },
  "dns":          { "found": true, "records": [...] },
  "dbBackup":     { "isTarget": true, "entry": {...} },
  "cronJobs":     { "found": true, "jobs": [{ "name": "cool-trattoria-rapport-hebdo", "cron": "0 8 * * 1", "url": "https://..." }], "secretName": "CRON_SECRET_COOL_TRATTORIA" },
  "render":       { "found": false },
  "stripe":       { "webhooksFound": true, "webhooks": [...] },
  "upstash":      { "found": false },
  "emailRouting": { "found": true, "rules": [...] },
  "envVars":      {
    "sources": ["vercel-production", "local-.env"],
    "thirdPartyDetected": [
      { "envVar": "SENTRY_DSN", "service": "Sentry", "label": "...", "actionUrl": "...", "instructions": "..." }
    ],
    "unknownUnclassified": [],
    "hasGoogleOAuth": true,
    "hasGitHubOAuth": false
  },
  "localDir":     { "exists": true, "path": "/path/to/cool-trattoria", "dependencies": [...] },
  "memory":       { "files": [...] },
  "github":       {
    "exists": true, "url": "...", "nameWithOwner": "acme/cool-trattoria", "foundVia": "origin", "declared": true,
    "deletion": { "deletable": true, "repository": "acme/cool-trattoria", "right": { "ok": false, "account": "acme" } }
  }
}
```

Any section may also carry an **`excluded`** array: resources whose name matched but that were re-attributed to a **more specific sibling project** (`street-cool` when deleting `street`), or recognized as **shared Hypervibe infrastructure** (the `hypervibe-jobs` worker), or **declared shared in the project's manifest**, whatever their kind (a database, a bucket, a DNS zone, an email route, a scheduled task, a Vercel project, a repository...). The two sections that hold a single resource say it by their flag: a shared backup target sets `dbBackup.isTarget` to false, a shared repository sets `github.exists` to false, and the resource moves into their `excluded` array. They are NEVER deleted; surface them in section 2.4 with their `excludedReason`.

The block prints the inventory JSON directly (and echoes its absolute path as `INVENTORY_FILE=…`). Read the JSON from that output. **Keep the `INVENTORY_FILE=…` path**: Phase 3 is given that exact path, pasted as is. The run folder has a unique name, so it cannot be rebuilt by hand, and no other deletion running at the same time can write into it. Move on to Phase 2, unless the inventory is empty in the cloud (section 1.1).

### 1.1 An empty cloud inventory: a folder without infrastructure

An old project, a mock-up, a folder copied from somewhere: it may have nothing in the cloud at all. The inventory is **empty in the cloud** when every cloud section found nothing (`vercel`, `neon`, `workers`, `r2`, `dns`, `emailRouting`, `cronJobs`, `render`, `upstash` with `found: false`, `dbBackup.isTarget` false, no Stripe webhook nor product, `github.exists` false, no AI key nor sending key in the manifest) **and** no section carries an `error`. A scan that failed is not a scan that found nothing: with an `error`, stay in the normal path (section 2.3b says what could not be checked).

Then there is nothing to delete automatically, and the only thing at stake is the folder itself, which the person deletes by hand. The question becomes: **would the code be lost?** Skip Phases 2 and 3, and answer it:

1. **Say it plainly**: nothing of `<PROJECT_NAME>` lives in the cloud (no site, no database, no stored files, no scheduled task, no repository on GitHub), so nothing will be deleted for them.
2. **Where the code stands**, read in `localDir.git`:
   - `repo: false`: the folder is not a git repository, its code exists only here. Unless the person keeps another copy, **code lost if deleted**.
   - `insideLarger: true`: the folder is only part of the repository at `root`. Deleting it is a change in that repository (to commit there), and the figures below are that repository's.
   - `uncommitted` above 0: that many files modified or new, never committed. **Code lost if deleted**, for those.
   - `unpushed` above 0: that many commits that no remote has, all local branches counted. **Code lost if deleted**.
   - `remotes` empty: no remote at all, every commit exists only here. **Code lost if deleted**.
   - `uncommitted` and `unpushed` at 0, and a remote: **deletable without loss**, the code is on `upstream` (or on its remote).
   - A figure at `null` (git did not answer, `repo: null` with an `error`): nothing is proven. Say what could not be checked, and give no "without loss" verdict.
   - An `.env` in the folder is never in git: its keys go with the folder. They still exist at their services; only a key kept nowhere else would be lost, say so if there is one.
3. **The references to the project**, so that nothing keeps pointing to a folder that no longer exists: the memory files of the inventory (`memory.files`, each with its path), and the skills that name the project or its folder: search `~/.claude/skills` (and the project's own `.claude/skills`, if any) for `<PROJECT_NAME>` and for the folder's path, with the Grep tool. List what you find; the person decides what to change in it, never you.
4. **The verdict, in one line**: *"Deletable without loss: the code is on `<remote>`, nothing else lives only here."* or *"Code lost if deleted: <the reasons above, plainly>."*
5. **Offer a backup first**, always when the code would be lost. For a git repository, `/save-project`: its zip keeps the whole history, the uncommitted changes and the files git does not track yet. For a folder that is not a repository, `/save-project` would not keep the code (it saves the code through git): say so, and offer the simplest copy instead, the folder zipped from the Explorer (right-click, Send to, Compressed folder) or the Finder (Compress), kept outside the folder. Wait for the answer.
6. **The folder to delete by hand**: its path (`localDir.path`), to delete from Windows Explorer (right-click, Delete) or the Finder. Never delete the folder yourself, not even here: deleting a project's folder is the person's gesture.

Then end with section 4.5's closing note. Nothing was deleted, so no report of deletions.

---

## Phase 2 - Present the inventory + validate the scope

Display a clear recap in 3 distinct sections, with a non-tech communication tone:

### 2.1 Section "🔵 Hypervibe infrastructure (I can delete it automatically)"

Markdown table listing each category where `found === true` (or `isTarget === true` for dbBackup, `webhooksFound === true` for stripe). For each row: resource (in plain language, e.g. "Vercel (the site's host)"), identifier, planned action.

For R2, state the volume at stake using `objectCount` / `sizeBytes`: *"R2 (the file storage): bucket `x-assets`, **543 files, 84 MB** - emptied then deleted"*. A bucket line without a number reads as an empty shell, and the user validates the destruction of their uploads without realizing it. If the backup of 0.3 was made without the files (the user answered "No, skip R2"), or if there was no backup at all, say it on that same line: *"these files are in no backup"*.

For the memory files: name the files that will be deleted (`isProjectSpecific: true`), the files that mention the project but are kept for review (say so: they stay), and quote each index line that will be removed from `MEMORY.md` (`memory.indexLines`, one per line). Only lines whose link points to a deleted file are removed; a line that merely cites the project stays.

### 2.1a Vercel: which site, in which team

A Vercel project name is unique inside ONE team, not across the account, and many accounts have several teams (the free team Vercel creates for everyone, a company team, a client's team). So every Vercel row names **the team** too: *"Vercel (the site's host): site `cool-trattoria`, in the team Acme"*. Each entry of `vercel.projects` says how it was found (`via`):

- `link` - the project folder is linked to it (`.vercel/project.json`): it is THE site, whatever its name.
- `manifest` - declared by the project and verified by its id.
- `name` - found only because it bears the project's name: say it is a guess, and have the user confirm it.

Then, depending on the inventory:

- `ambiguous: true` - several sites could be the project's (the same name in several teams, or a name match while the folder's link could not be checked). **Nothing is deleted on Vercel until the user picks.** Ask via `AskUserQuestion` (`multiSelect: true`), one option per `projects` entry whose `via` is `name`, labelled with the site and its team (*"`cool-trattoria`, team Acme"*), plus one option to keep them all. Phase 3 passes the ids picked with `--vercel-project`; if the user keeps them all, drop `vercel` from the scope.
- `nameMismatch: true` - the folder is linked to a site whose name differs from the project's (renamed on Vercel, or a folder named differently). Name both and have the user confirm.
- `homonyms` - sites bearing the same name in another team. They are NOT deleted: list them in section 2.4.
- `linked.status: "missing"` - the folder's link points to a site that no longer exists: say it in one line (already deleted, or a stale folder).
- `partial: true` (with a `warning`) - some team could not be read: section 2.3b.

### 2.1b The resource manifest, when the project has one

The inventory carries a `manifest` section when the project declares its resources in `.hypervibe/resources.json` (written by the `add-*` skills at provisioning time). Each declared resource has a `status`:

- `seen-in-scan` / `injected` - it is in the tables above; an `injected` one was found by its **exact identifier** even though its name looks nothing like the project. Mark these rows as *"declared by the project"*: they are the most trustworthy part of the inventory.
- `missing` - declared but verified gone from the account. Mention it in one line (nothing to delete, the manifest is just stale).
- `shared` - declared as shared infrastructure: it is in section 2.4, never in the deletion scope, whatever its name matches.
- `sharedIgnored` (a note, next to the status) - a registration of this project on the shared clock that the manifest marks shared by mistake (a scheduled task, or the backup of a database the manifest does not declare shared): it stays in the deletion scope, since the clock would otherwise keep working for a project that is gone. Say so in one line in the review.
- `unverified` - declared but not checkable automatically (dns-zone, email-route, cron-job, a github-repo the folder does not push to...). **List these in 2.1 too**, marked *"declared by the project - please confirm it is really this project's"*: a declaration is a strong signal, but it is not a live verification.

Conversely, a resource found ONLY by name similarity (no `declared: true`) deserves the opposite caution: say it was **guessed from its name**, and have the user confirm it truly belongs to this project before it enters the scope.

A Render service marked `foundVia: "repository"` is neither: Render says it is built from this project's own repository, whatever its name (the case of an agent created before version 3.4.2, whose service carries the agent's name alone). Present it as *"built from this project's repository"*: it belongs in the scope, and it is billed every month while it exists.

### 2.1c The project's AI keys

A `kind: "ai-key"` entry in the manifest means the project has a spending-capped
key of its own (and an agent, if there is one, has a second). They are not
deleted by the inventory script: revoke them explicitly, in the execution phase,
once the user has validated the scope:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/ai/ai-setup.mjs" revoquer --hash <hash>
```

Two reasons not to skip this. A key left alive after the project is gone is a
key nobody watches any more, and the cap that made it safe is now protecting
nothing. And the entries carry the `hash`, so there is no guessing: revoke
exactly those, never "the keys whose name looks like the project".

An entry with `mode: "direct"` has no key of ours to revoke: the project calls a
provider on the user's own account. Say so in section 2.2, so they can revoke it
themselves if they want to.

### 2.1c bis The project's sending key

A `kind: "email-key"` entry in the manifest is the project's own sending key (since 3.4.16 a project never holds the email account's key). Like the AI keys, the inventory script does not delete it: revoke it explicitly, in the execution phase, once the user has validated the scope, and only that one, by the identifier the entry carries:

- `provider: "resend"` → revoked at Resend with the account's key from the vault (the command asks for a confirmation; it refuses an identifier the project's manifest does not record):
  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/email-key.mjs" revoke --project-dir "<project dir>" --id <id>
  ```
- `provider: "brevo"` → made by hand, it goes by hand: section 2.2, *"delete the key `<name>` in Brevo's console (SMTP & API, API keys)"*.

No entry, while the project's `.env` holds a `RESEND_API_KEY` or `BREVO_API_KEY`: a project set up before 3.4.16 may hold the ACCOUNT's key itself. Nothing to revoke for the project then (the account stays, the other projects may use it): say it in 4.3, and advise renewing the account's key at the provider once no project holds it any more.

### 2.1d The code repository (GitHub)

`github.deletion` says whether this skill deletes the repository itself. **It deletes one repository, and only that one: the repository `/bootstrap` created for this project** (declared in the manifest by `/bootstrap`, and the one the project's folder pushes to). Any other repository stays a manual step, whatever the person answers: one found by the account and the project's name, one adopted from the folder's remote, one another skill declared, one the manifest names differently. A repository holds the code and its whole history, and none is deleted on a guess.

- `deletable: true` → a row of 2.1, said plainly: *"GitHub (the code repository): `acme/cool-trattoria`, created by /bootstrap for this project - **deleted, with its whole history** (code, versions, issues). The code also stays in your local folder until you delete it."* The person can keep it at 2.5.
- `deletable: false` → section 2.3, with `deletion.reason` put in plain language.

### 2.2 Section "🟠 Third-party services detected (to delete by hand)"

For each entry in `envVars.thirdPartyDetected`: name of the service with its label (plain language), how it was detected (env var), URL to open, short instructions. If the list is empty, say so clearly: *"No third-party service detected outside the Hypervibe stack."*

### 2.3 Section "🟡 Manual accounts (never automatable)"

Include conditionally:
- If `envVars.hasGoogleOAuth === true` → Google Cloud Console OAuth action + entire GCP project
- If `envVars.hasGitHubOAuth === true` → GitHub OAuth App action
- Deletion of the GitHub repo, when `github.exists` and this skill does not delete it (`github.deletion.deletable` false, section 2.1d): say why in one plain sentence (`deletion.reason`). It is the repository the project's folder pushes to (`github.foundVia: "origin"`); with `github.guessed: true` the folder pushed nowhere and the repository was found by the signed-in account and the project's name only: say so, and have the user confirm it is this project's before listing it
- Deletion of the local folder if `localDir.exists` (to be done via Windows Explorer)

### 2.3b Section "🔴 Scans that could not run" (only if at least one `error`)

A section carrying a `skipped` field (`stripe.skipped: "project has no Stripe"`) is **not** a scan that failed: the project simply has nothing of that kind, and there is nothing to say about it.

Any section carrying an `error` field (typically `vercel.error` or `r2.error`: vault locked, expired token, R2 not enabled on the account) did **not** return "nothing found", it returned "unknown". List them plainly, e.g. *"I could not check the file storage (R2): <reason>. There may be a bucket left."* and offer to fix the cause then re-run Phase 1 before going further. Never let the user validate a scope built on a failed scan.

`vercel.partial: true` is the same warning, narrower: the listing worked, but some team could not be read (its reason is in `vercel.warning`, for instance a CLI too old to list every team). A site living there may be missing from the inventory: say which, and offer the same fix.

### 2.4 Section "⚪ Deliberately left untouched"

- Brevo / Resend (shared)
- Parent Cloudflare zones (the subdomains/DNS are deleted, not the parent zone)
- Stripe products (if found but rarely scoped to the project)
- Every `excluded` entry from the inventory sections (resource attributed to a sibling project, shared Hypervibe infrastructure like the `hypervibe-jobs` worker, or a resource the project's manifest declares shared) - list each with its reason in plain language
- Every `vercel.homonyms` entry: *"a site with the same name exists in the team X, it is left untouched"*

### 2.5 Mandatory scope question

**The inventory is shown first, as a message the user reads.** Sections 2.1 to 2.4 are sent as a visible message BEFORE the `AskUserQuestion` call. A summary kept in your own reasoning does not count; the question never points at a list that was not displayed; and the table of 2.1 is mandatory even for a single resource. Nobody validates an irreversible deletion on a list they have not seen (it happened on 29/09/2026).

Then ask via `AskUserQuestion`:

> "Do I delete **everything** listed under 🔵 (auto infrastructure), or do you want to **keep** some resources?"

**Build the options from the inventory**, never from a fixed list:
- `Delete everything` - always.
- `Keep the database` (excludes `neon` + `db-backup` from the scope) - only if `neon.found`.
- `Keep the DNS` (excludes `dns` from the scope) - only if `dns.found`.
- `Keep the code repository` (excludes `github` from the scope) - only if `github.deletion.deletable`.

The local folder is never an option: this skill never deletes it (section 2.3).

How the question is asked depends on what is left:
- **Two things or more to keep** (`Delete everything` and at least two `Keep`): `multiSelect: true`. If the answer holds `Delete everything` together with a `Keep`, the `Keep` wins: say so in one line before executing.
- **One thing to keep** (`Delete everything` and ONE `Keep`): a single-choice question. The two exclude each other, and a multi-select offered them together.
- **Nothing to keep** (no database, no DNS record: a site alone, for instance): a single-choice question all the same, `Delete what is listed` or `Cancel, delete nothing`. Never an improvised yes/no in plain text, and never no question at all.

**Do not proceed until the scope is explicitly validated.** The Phase 0 confirmations are about the **principle**. Phase 2 confirms the **exact inventory**.

### 2.6 The right to delete the code repository (only when it is in the scope)

`gh` does not hold the right to delete a repository by default (`delete_repo`). The inventory read it, without changing anything: `github.deletion.right`.

- `ok: true` → nothing to do.
- `ok: false`, without `fromEnvironment` → ask via `AskUserQuestion`: *"To delete the code repository myself, GitHub has to give me one more permission: deleting repositories. Do I ask for it now? You will paste a short code on a GitHub page."* Options: `Yes, ask for it` / `No, I will delete it myself at the end`.
  - **Yes** → run in the background (`run_in_background`: `gh` waits for the person while it runs), never in the foreground:
    ```bash
    gh auth refresh -h github.com -s delete_repo
    ```
    After a few seconds, read its output: `gh` writes a one-time code (`First copy your one-time code: XXXX-XXXX`) and the page to open (`https://github.com/login/device`). Give both to the person, the page as a link: they open it, sign in to GitHub with the account the inventory names (`right.account`) if asked, paste the code and authorize. The command ends by itself once they have (`Authentication complete`). The execution reads the right again before deleting anything; if it is still missing, the repository becomes a manual step of the final report.
  - **No**, or the command fails, or the person stops there (the code expires after fifteen minutes) → take `github` out of the scope: the repository becomes a manual step (section 4.2).
  - Never authorize on the person's behalf, and never open the page in a browser yourself.
- `ok: false` with `fromEnvironment: true` → `gh` uses a token an environment variable gives (`GH_TOKEN`, `GITHUB_TOKEN`), which `gh auth refresh` cannot change. Say so in one line and take `github` out of the scope: manual step.
- `ok: null` → the right cannot be read (`reason` says why): take `github` out of the scope, manual step, and say why in one line.

---

## Phase 3 - Execution (1 script call)

**Open the vault again first**: invoke `_ensure-vault` before the execution. Confirmations can take an evening, or a night: the vault's session lasts six hours, and it may have closed since the inventory.

Build the `scope` JSON array from the Phase 2.5 choices. Possible categories:

```
["vercel","neon","r2","workers","dns","db-backup","cron-jobs","render","stripe-webhooks","upstash","email-routing","memory","github"]
```

If the user chose "Delete everything", pass `["all"]`. Otherwise remove the categories they want to keep. When 2.6 took `github` out of the scope, list the categories instead of `["all"]`: `["all"]` includes the repository. `github` deletes only the repository `/bootstrap` created for this project (section 2.1d): the script decides it again from the inventory's facts, and any other repository is reported as a manual step, whatever the scope says.

```bash
# The EXACT path Phase 1 printed as INVENTORY_FILE=..., pasted as is (shell state does not
# persist between calls, and the run folder has a unique name: never rebuild it by hand).
INV="<INVENTORY_FILE printed by Phase 1>"
REPORT="$(dirname "$INV")/report.json"
# --confirm names the target: the script refuses to run unless it matches the
# inventory. Substitute the real project name (the one confirmed above).
node "${CLAUDE_SKILL_DIR}/../../scripts/delete-project/execute-deletions.mjs" \
  --inventory "$INV" \
  --confirm "<project-name>" \
  --scope '["all"]' > "$REPORT"; CODE=$?
cat "$REPORT"
# The inventory is removed only when the script ran: a refusal keeps it for the next attempt.
if [ "$CODE" = "0" ]; then rm -f "$INV" "$REPORT" && rmdir "$(dirname "$INV")"; else echo "EXIT_CODE=$CODE - the inventory is kept: $INV"; fi
```

The script exits `0` once it has run, whatever each category did (the report says what failed). These exit codes are refusals BEFORE the first deletion, and nothing was deleted:
- **`2` or `3`**: the vault is locked (`2`) or expired (`3`), and a category of the scope needs a key it holds. Invoke `_ensure-vault`, then run the same command again with the same inventory: it is still valid. Before this check, the site was deleted at its host and the database then failed with a "key missing" that sent people looking for a key that existed.
- **`7`**: the inventory is unreadable, or `--confirm` does not name the project.
- **`1`** with a usage message: an argument is missing or malformed (the inventory's path, the scope).

Any other failure (the script crashed half way, the report is empty) says nothing by itself about what was deleted: never tell the user "nothing was deleted" on it. Run the Phase 1 inventory again, and report what is left.

When Phase 2 had the user pick among Vercel sites (`vercel.ambiguous`), add `--vercel-project` followed by the ids picked, comma-separated, to that command. Sites designated by the folder's link or by the manifest are always included; without the flag, an ambiguous inventory deletes nothing on Vercel (`failed.vercel.needsChoice`, with the `choices`).

Create a todo list with one entry per scope category. Mark "in_progress" before the run and "completed" after (a single script run ⇒ you mark them within 2 seconds max).

The script runs:
- **In parallel**: Vercel, R2 (both jurisdictions), Workers, DNS, Render, Stripe webhooks, Upstash, Email Routing
- **Sequentially afterwards**: Neon → db-backup (needs the Neon projectId to remove the target) → cron-jobs (same shared-worker registry as db-backup, never concurrent) → Memory → the GitHub repository (last: a run that stops half way leaves the code where it was)

The resulting JSON:

```json
{
  "project": "cool-trattoria",
  "deleted": {
    "vercel":  { "status": "deleted", "results": [{ "id": "prj_...", "name": "...", "team": "acme", "status": "deleted", "via": "rest", "verified": true }] },
    "neon":    { "status": "deleted", "results": [...] },
    ...
  },
  "failed":  { "<category>": { "status": "failed", "error": "..." } },
  "skipped": { "<category>": { "status": "skipped", "reason": "..." } }
}
```

---

## Phase 4 - Final report

Display a recap to the user, plain language, with the following structure:

### 4.1 "✅ Deleted automatically"
Table of the `report.deleted` entries translated into accessible language.

For Vercel, name each site with its team. A result `absent` means the site was already gone. `verified: false` means Vercel accepted the deletion but it could not be checked afterwards (the `note` says why): say so, and suggest a look at the team's page on vercel.com rather than announcing a certainty.

For the code repository (`deleted.github.results`): `deleted` names the repository, `verified: false` meaning GitHub accepted the deletion but it could not be checked afterwards; `absent` means it was already gone.

### 4.2 "🟡 To do yourself via Windows Explorer / the browser"

Ordered list with click-by-click instructions:

1. **Delete the local folder** (if `localDir.exists`)
   - Path: `C:\DEV\<PROJECT_NAME>`
   - Action: Open Windows Explorer → right-click → Delete (or Shift+Delete)
   - Note: *"I would have liked to do it automatically, but my sandbox blocks deleting folders under C:\DEV\ for your safety."*

2. **Delete the GitHub repo** (if `github.exists` and it was not deleted above: kept out of the scope, `skipped.github` with `manual: true`, or `failed.github`)
   - Why it is left to them, in one line: not created by /bootstrap (`reason`), the right to delete it missing (`needsScope`), GitHub refused (`error`), or their own choice. When `needsScope` is set and they would rather have it done for them, offer section 2.6, then the execution again with `--scope '["github"]'` on a fresh inventory
   - URL: `<github.url>/settings` (the address the inventory read, never one composed from an account and a name)
   - Action: scroll all the way down → Danger Zone → "Delete this repository" → retype the repo name

3. **Delete the Google OAuth client** (if `envVars.hasGoogleOAuth === true`)
   - URL: `https://console.cloud.google.com` → select the project → APIs and services → Credentials
   - Action: find the OAuth client `<PROJECT_NAME>-nextauth` (or similar) → trash

4. **Delete the entire GCP project** (optional, if Google OAuth is present)
   - URL: `https://console.cloud.google.com` → IAM → Manage resources
   - Action: check `<PROJECT_NAME>` → Delete (30-day grace period)

5. **Detected third-party services** (for each entry in `envVars.thirdPartyDetected`):
   - Name of the service with label
   - Exact URL (from `actionUrl`)
   - Precise instructions (from `instructions`)

### 4.3 "ℹ️ Deliberately left untouched"
- Brevo / Resend accounts: shared (only the project's own sending key goes, section 2.1c bis)
- Parent Cloudflare zones: shared
- Stripe products (if found): risk of being used by other projects
- **The memory files kept for review**: every result `kept` of the memory step (under `deleted.memory.results`, or under `skipped.memory.results` when nothing was deleted at all: its `reason` then says how many). Name each file and say why it stayed: it mentions the project without being the project's own. The user decides what to do with it.

### 4.4 The right to delete repositories, given back (only when section 2.6 asked for it in this run)

`gh` keeps a right it was given until it is taken back (its own help says so): once the repository is gone, every later session could delete a repository, with only the guard's question in front of it. So when this run asked GitHub for that right (section 2.6, `Yes`), whatever became of the repository, ask via `AskUserQuestion`: *"I no longer need the right to delete repositories that GitHub gave me earlier. Do I give it back now? Same short code on a GitHub page."* Options: `Yes, give it back` / `No, keep it`.

- **Yes** → in the background, exactly as in section 2.6 (the one-time code and the page `https://github.com/login/device`, given to the person; the command ends by itself once they have authorized; never on their behalf, never the page opened by you):
  ```bash
  gh auth refresh -h github.com --remove-scopes delete_repo
  ```
- **No**, or the command fails → one line: the right stays, and the same command gives it back whenever they like.

When the right was already there before this run (`github.deletion.right.ok: true` at the inventory), leave it as it is and say so in one line, with that command. (A remark of Bastien Detraz, 10/10/2026.)

### 4.5 Closing note
> "There you go, the automatable cloud infrastructure is cleaned up. You still have the X manual actions above to finish the cleanup. No rush - you can do it at your own pace. If you want, I can stay here and guide you step by step when you click."

---

## Non-tech communication rule

- Technical terms always paired with plain language:
  - "Vercel (the site's host)"
  - "Neon (the database)"
  - "R2 (the file storage)"
  - "Worker `db-backup` (the robot that does the automatic backups)"
- For manual actions, always give: **where to click / what to open + why**. Never a shell command for the user.
- For reports, markdown tables with 3 distinct sections (✅ / 🟡 / ⚪).

---

## Known pitfalls (edge cases)

### Vercel: a name is not an address
A project name is unique inside one team, and the CLI acts on the team it is set to. Deleting with a bare `vercel project rm <name>` missed a project living in the account's other team (2026-09-17), and would have deleted a same-named project of the current team instead. The deletion now goes by **id and team** (`scripts/_vercel-projects.mjs`): the REST API first (`DELETE /v9/projects/{id}?teamId=...`), then, when the token is refused, the CLI with an explicit `--scope` on every call. Two more traps of the CLI, handled there: `vercel project rm` asks for confirmation even for a project that does not exist, and a refused prompt still exits 0. Only its success line counts, and every deletion is followed by a check that the project is gone. Never delete a Vercel project by hand with a bare name either: add `--scope <team>`.

### R2 jurisdictions
The two jurisdictions are separate namespaces: the SAME bucket name can exist in `global` and in `eu` simultaneously. The script scans both (Cloudflare REST API, `cf-r2-jurisdiction: eu` header for the EU one) and tags each hit with `jurisdiction: "global"|"eu"`, which the deletion then replays.

**Never go back to `wrangler r2 bucket list` here.** Wrangler only reads its credentials from the process ENV, but since the vault migration the token lives in the vault: a bare `spawn("wrangler", …)` fails with *"In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN"*. That failure used to be swallowed and `scanR2` reported "no bucket" for EVERY project, leaving buckets orphaned and billed (bug fixed 2026-08-02). If a wrangler call is ever unavoidable, the token MUST be injected into the child env (`{ env: { ...process.env, CLOUDFLARE_API_TOKEN } }`, or the `wrangler()` helper of `scripts/shared-worker/_lib.mjs`).

### Deleting a bucket = emptying it first
Cloudflare refuses to delete a bucket that still holds objects (HTTP 409, `code 10008`). The execution therefore lists and deletes every object before dropping the bucket. **No S3 key pair is required**: the account API token lists (`GET /r2/buckets/{b}/objects`, `per_page` defaults to 20, cursor-paginated) and deletes (`DELETE .../objects/{key}`) objects perfectly well - only the wrangler CLI cannot (no `list` subcommand). Watch out for one trap on this endpoint family: a failed object delete answers **HTTP 200 with `success: false`**, so the HTTP status alone is not a verdict. The report gives `objectsDeleted` per bucket; announce that number in Phase 4, it is irreversible data.

The inventory carries `objectCount` and `sizeBytes` per bucket (from `/usage`): say it in Phase 2 ("543 files, 84 MB") before the user validates.

### Vercel project listing
`vercel projects ls` returns only its FIRST PAGE (20 projects), for the CURRENT team only: any older project was declared "not found" and left orphaned (bug fixed 2026-08-02), and a project of another team too (fixed 2026-09-17). The scan lists every team, all pages: REST API first (`/v2/teams`, then `/v9/projects` per team), otherwise the CLI in JSON (`vercel teams ls --format json`, then `vercel project ls --format json --scope <team>` per team), and as a last resort, with a CLI too old for JSON, the table of the current team only (`partial: true`). On current accounts an API call without `teamId` answers for the default team, so each project is attributed to the account its own record names, never to the listing that returned it. The `vercel.source` field says which path was used (`rest`, `cli`, `cli-table`).

### A scan that fails is not a scan that found nothing
The `vercel` and `r2` sections carry an `error` field when the API call itself failed (vault locked, dead token, R2 not enabled). `found: false` **with** an `error` means "unknown", not "nothing to delete" - surface it in Phase 2 and offer to re-run rather than letting the user validate a truncated inventory.

### Sandbox `rm -rf` on C:\DEV\
The Claude Code classifier often blocks `rm -rf` under `C:\DEV\` (deny rule), even with the user's explicit authorization. Trying via PowerShell or Node.js is also detected. **Do not try to work around it** - give the path to the user in the final report so they delete it via Windows Explorer.

### Shared db-backup worker
`~/.db-backup-worker/wrangler.toml` is shared across **all** Neon projects. The `db-backup-remove-target.mjs` script does a surgical edit (removes ONLY the project's entry + redeploys). If the redeploy fails, it rolls back the toml automatically.

### Shared hypervibe-jobs worker (cron pings)
Scheduled tasks created by `/add-cron` live in the same registry as the unified backups (`~/.hypervibe-jobs/jobs.js`) as jobs of kind `ping`. Without cleanup, the worker keeps hitting a dead URL at every schedule after the project is gone. Two subtleties:
- **Matching**: since 2026-07-05 the registry name is composite (`<project>-<task>`), so the scan matches jobs by their `project` field (with the per-project secret name as fallback for older entries), never by name. Each job is then removed by its registry name via the shared-worker registry script: the jobs of the other projects are untouched.
- **Worker secret**: once no registry job of the project remains, the execution also deletes the `CRON_SECRET_<PROJECT>` secret from the shared worker (Cloudflare API). If a removal failed, the secret is kept (reported as `kept` in the result) - safe to retry with scope `["cron-jobs"]`. The app-side `CRON_SECRET` env var disappears with the Vercel project.

### Neon backups
The backups (`backup-*` branches) live **in the Neon project itself**. When you delete the project (Phase 3, category `neon`), the backups go with it. No separate action.

### GitHub: the one repository this skill deletes
Since 3.4.9 the execution deletes the repository `/bootstrap` created for the project (`gh repo delete <owner/name> --yes`), and no other (`scripts/delete-project/_github-repo.mjs`). Three facts must agree, all read again by the execution from the inventory, never taken from a flag: the project's folder pushes to it (`foundVia: "origin"`, never a guess by account and name), the manifest declares it, and the declaration comes from `/bootstrap` (`addedBy: "bootstrap"`; `adopt` or another skill does not count). Before 3.4.9 the step was always manual: two demonstration projects kept their repository (23/09/2026). `gh` needs the `delete_repo` right, absent by default: section 2.6 asks for it with the person (`gh auth refresh`), never on their behalf. The repository goes last.

### Google OAuth
No MCP / CLI lets you delete a Google Cloud Console OAuth client. Always manual (URL provided in Phase 4.2).

### Accounts shared between projects (keep list)
An account the person uses for several projects (a personal API key, a shared CRM) must never be offered for deletion: removing it for one project cuts all the others. The person lists those accounts on their machine, in `~/.hypervibe/delete-project-keep.json`, never in the plugin:

```json
{ "keep": [{ "pattern": "^MYCRM_", "label": "My CRM, shared by my projects" }] }
```

Each pattern matches environment variable names; a match is reported as "keep", ahead of the generic entry of the same service. **If the discovery prints that this file could not be read, or that a rule is not a valid pattern, say so to the user before Phase 2**: the list protects nothing in this run, so ask which shared accounts to keep, and suggest fixing the file. When the user mentions an account shared between projects, offer to add its rule to the file.

### Detected third-party services
The env vars scan (Phase 1, env vars sub-step) is **conservative**: any non-whitelisted var is flagged. Better a false positive (the user says "oh no, that one is fine") than a false negative (a third-party service keeps billing). The whitelist lives in `templates/delete-project/known-env-vars.json`. To add a new var to the standard stack, edit this file.

### Stripe products
The **webhooks** are safe to delete (1 per project, URL clearly linked). The **products** are rarely scoped per project → the script does NOT delete them automatically, they are merely mentioned in the report for a manual decision.

### Ambiguous names
Matching is word-boundary based, not substring based: deleting `art` does not match `smart-app`, and the shared background workers (`hypervibe-jobs`, legacy `db-backup`) are excluded by name whatever the project is called. When several projects share a prefix (`street` and `street-cool`), every resource that also matches a **more specific known project** (known = shared-worker registry, sibling folders of the project dir, Neon/Vercel project lists) is automatically moved to the section's `excluded` array and left untouched. Limit: a sibling project with zero local footprint (no folder, no registry job, not visible in the Neon/Vercel lists) cannot be recognized, so its derived resources would still show up in the inventory. **The Phase 2 review stays the final safety net**: read the resource names carefully before validating the scope, and when in doubt ask the user.

### `.env.delete-check` temp file
The Phase 1 script temporarily creates a `.env.delete-check` file to parse the var names (NOT the values). It deletes it systematically at the end, even on error. Check in the report that it does not exist in the local project after the run.

### Brevo / Resend
The email ACCOUNT is shared by every project: the script does not touch anything on it. What belongs to the project is its own sending key, revoked in section 2.1c bis (a project set up before 3.4.16 may hold the account's key instead: nothing to revoke then). If the sender configured in the project's vars (`BREVO_SENDER_EMAIL` / `RESEND_FROM_EMAIL`) is **different** from the standard address, flag it in Phase 4.2 - a dedicated sender may have been validated on Brevo/Resend.
