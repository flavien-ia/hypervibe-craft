---
name: save-project
description: "Creates a complete backup (timestamped zip) of a Hypervibe project - code (git bundle), database (schema + JSON data), Vercel environment variables, Cloudflare R2 content, Claude memory files, and configs (Vercel/wrangler/Stripe). Useful before `/delete-project`, before a big refactor, at the end of a mission, or for an offline archive. The zip is saved to Dropbox/Download by default."
allowed-tools: Bash Read Edit Write Glob AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# /save-project - Complete snapshot of a Hypervibe project

You create a complete zip of everything that defines a Hypervibe project, at a given point in time. The zip is used as a safety net before a risky operation (deletion, refactor, end of mission) or as a personal/client archive.

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

---

## Step 1 - Preflight

### 1a. Determine the project

The project name can come from:
- A direct argument (`/save-project <name>`)
- The current directory (read `package.json` at the root of `process.cwd()`, take the `name` field)
- A directory further up if we are in a monorepo (`apps/web/package.json`)

If the name is ambiguous (e.g. a monorepo where the root `package.json` has a different name than `apps/web/package.json`), show both and ask which one to use.

If really nothing can be found, ask the user:

> *"Which folder contains the project to back up? (absolute or relative path)"*

### 1b. Verify that it really is a Hypervibe project

Criteria:
- `package.json` exists at the root of the project
- At least one of: `.vercel/project.json`, `wrangler.toml`, `.git/`, presence of `next` in the dependencies

If nothing matches, flag it but offer to continue anyway (it might be a non-Hypervibe project that the user still wants to back up).

### 1c. Present the plan to the user

Show a concise recap:

> ## 📦 Snapshot of project **<name>**
>
> Here is what will be included in the zip:
>
> | Item | Status | Notes |
> |---|---|---|
> | **Code + Git history** | ✅ included | Complete git bundle, restorable via `git clone` |
> | **Working changes** | <✅ included / ➖ none> | Uncommitted changes captured via `git diff HEAD` |
> | **Database** | <✅ included / ⚠️ not detected> | Schema + all tables, JSON format |
> | **Vercel env variables** | <✅ included / ⚠️ project not linked> | production + preview + development |
> | **Cloudflare R2** | <to confirm> | See question below |
> | **Claude memory** | ✅ included | Files in `~/.claude/projects/.../memory/` |
> | **Configs** | ✅ included | Vercel, wrangler.toml, Stripe webhooks (URLs only, **no secrets**) |
>
> ⚠️ **Important note**: the zip will contain **plaintext secrets** in the `.env` files. Treat it as a confidential document after creation.

### 1d. R2 question

If the project potentially has R2 storage (do not check beforehand, the script detects it):

Use **AskUserQuestion**:

> Question: "Include the content of the R2 buckets in the snapshot?"
> - Option 1: **Yes - include everything (recommended)** - may take a while if there are many files (videos, images)
> - Option 2: **No - skip R2** - faster snapshot, does not contain the uploaded files
> - Option 3: **Just the buckets, not the content** - equivalent to "no" right now (the script cannot dump only the metadata)

If the answer is "Just the buckets, not the content", use `--skip-storage` like option 2 (and explain to the user that in this version, the skill cannot export the metadata without the content, so it amounts to the same thing).

**Two download paths, both complete.** With `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in the `.env`, the S3 API is used (`mode: "s3"`). Without them, the script falls back to the Cloudflare REST API with the account token from the vault (`mode: "rest-api"`), which lists and reads objects just as well - a project whose R2 keys were never put in the `.env` is still backed up in full. Only the wrangler CLI is unable to do this (it has `r2 object get/put/delete` but no `list`), which is why the old fallback silently produced empty snapshots.

### 1e. Output path question

Use **AskUserQuestion**:

> Question: "Where to save the zip?"
> - Option 1: **the Downloads folder (recommended)** - `~/Downloads` when it exists (the script also accepts a Dropbox download folder if that is what the machine has), otherwise the home folder
> - Option 2: **In the current folder** - convenient if you want everything in the same place
> - Option 3: **Other path** - the user specifies it explicitly

If Option 3, ask for the path as a follow-up (free text). Verify that it exists or can be created.

### 1f. Final confirmation

Before launching, one last confirmation:

> Final recap:
> - Project: `<name>`
> - Source: `<path>`
> - Destination: `<path>/<name>-snapshot-<TS>.zip`
> - R2: <included / skipped>
>
> Launch the backup?

If yes, move on to Step 2. Otherwise, cancel cleanly.

---

## Step 2 - Execution

Launch the bundled script:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/save-project/build-snapshot.mjs" \
  --project "<name>" \
  --project-dir "<absolute-path-of-the-project>" \
  --out "<destination-path>" \
  [--skip-storage if the user said no]
```

During execution, the script logs each step to stderr with a `[step] status` prefix. You can relay these logs to the user in real time via `↳ ...` (one per step that completes).

At the end, the script writes a JSON `{status, zipPath, zipSize, timestamp, incompleteSteps?, steps}` to stdout. Capture it.

The top-level `status` is computed from the steps, so it can be trusted on its own: `ok` when every step completed or was deliberately skipped, `partial` when at least one step came back `partial` or `error` (the zip exists, it has holes), and `error` only when the run crashed and produced no zip at all. When it is `partial`, `incompleteSteps` names exactly which steps and why: report them, never round `partial` up to a success.

### Partial errors

It is OK if some steps are skipped (e.g. no R2, project not linked to Vercel) - the script continues. An `error` step does not block the next one. Only one step is truly fatal = the zip itself fails.

---

## Step 3 - Report to the user

Show a clear recap:

> ## ✅ Snapshot complete
>
> **File**: `<zipPath>`
> **Size**: `<zipSize>`
>
> ### Content
>
> | Step | Status | Notes |
> |---|---|---|
> | Code + history | ✅ ok | <bundleBytes in MB>, uncommitted changes: <yes/no> |
> | Env variables | ✅ ok | <production: X vars, preview: Y, dev: Z> |
> | Database | <✅ ok / ⚠️ partial / ➖ skipped> | <driver>, <tableCount> tables, <totalRows> rows in total<, NOT READ: N tables>; when `db-dump` is `skipped` because the database holds no table yet, say just that: there is nothing to back up there, which is normal right after `/add-db` |
> | Cloudflare R2 | <✅ ok / ⚠️ partial / ➖ skipped> | <bucketsScanned> buckets, <totalObjects> objects (<totalSize>)<, MISSING: N objects> |
> | Claude memory | ✅ ok | <matchedDirs> memory folder(s) copied |
> | Configs | ✅ ok | <captured> |
>
> ### ⚠️ Zip security
>
> This file contains **plaintext secrets**. Before anything:
> - Do not share it by unencrypted email or on a public channel
> - If you put it on a cloud service (Dropbox, iCloud...), make sure it is your personal account, not a shared one
> - If you no longer need it, delete it
>
> ### To restore
>
> The `MANIFEST.md` inside the zip explains the procedure. In short: `git clone code/repo.bundle`, then recreate the DB / buckets / webhooks from the provided files. You can always reopen Claude Code in the extracted folder and ask it to guide the restoration.

If a step has `status: "error"`, mention it honestly with the error message - no need to hide it.

If `r2-download` has `status: "partial"`, say so PROMINENTLY - this is a backup with holes in it, and the whole point of a backup is that the holes are found now, not the day it is needed. Give the number of missing objects and point to `storage/_MANQUANTS.txt` inside the zip, which lists every missing key. Each object was already retried three times with growing backoff, so what remains is not a transient cut: either the object disappeared from the bucket between the listing and the download, or something is genuinely wrong with the storage. Offer to re-run the backup (a new run starts from scratch; it does not resume this one).

If `db-dump` has `status: "partial"`, say so just as PROMINENTLY: some tables could not be read (`failedTables` names them, `db/_summary.json` inside the zip gives the reason for each), so their rows are NOT in this backup. Usual causes: a role without the right on that table, a database that went to sleep or hit its quota mid-run. Offer to re-run, and never present this zip as a complete backup of the data. When no table at all could be read the step comes back `error`, not `partial`: the zip then holds no data.

If the `git-bundle` step is skipped (not a git repo), insist: **without a git bundle, the source code is not in the snapshot**. Ask the user whether they still want to keep this zip or cancel everything.

---

## Common errors to handle

- **Python not installed**: the last step (the zip) fails. Rare if Python is already installed (often a dependency that is present), but possible for some users. In that case, offer to install Python or to zip by hand from the `WORK_DIR` folder that the script shows on error.
- **DATABASE_URL not found**: the project may not have a Neon DB, or the variable has a different name. Ask the user whether they want to continue without a DB (the snapshot is still useful for the code/env/configs).
- **Vercel CLI missing**: env-vars step skipped, we continue. Mention it in the report.
- **Wrangler CLI missing**: r2-download step skipped, we continue.
- **R2 bucket not found while the project HAS storage**: the download reads the project resource manifest (`.hypervibe/resources.json`) first - a bucket recorded there is found by its exact name and jurisdiction, whatever it is called. Only unrecorded buckets fall back to name-matching against the project name, and that match is deliberately strict (it is shared with `/delete-project`, where a loose match would destroy another project's data): a bucket whose name does not contain the project name as a whole token is NOT found, and the step reports "no R2 bucket found for this project" - which reads exactly like "this project has no storage". Never relay that as fact without checking. The durable fix is to record the bucket in the manifest (see `_track-resource`); the authoritative alternative is the project's `.env` (`R2_BUCKET_NAME`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), which takes the S3 path and skips guessing entirely. Seen in the wild: a project named `app-<name>` whose bucket is `<name>-assets` - no whole-token match, and the backup would have shipped without a single image while reporting success.
- **The script crashes entirely (exit 1)**: the `WORK_DIR` is left as is for debugging. The path is in the JSON output. Give it to the user so they can go check / delete it manually.

---

## What NOT to do

- ❌ Never launch `/save-project` automatically from another skill without explicit confirmation (the zip has a cost in time and disk)
- ❌ Never include the `whsec_*` (Stripe webhook secrets) - the script already handles this but stay vigilant if you are reading code in parallel
- ❌ Do not offer an automatic `/restore-project` - it does not exist and that is intentional (too dangerous). Restoration is manual and assisted.
- ❌ Do not do an automatic `git push` or `commit` - we work read-only on the project
