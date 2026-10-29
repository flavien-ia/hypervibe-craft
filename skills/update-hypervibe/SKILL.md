---
name: update-hypervibe
description: Update the Hypervibe plugin to the latest published version. Detects how the plugin was installed - a marketplace install is updated natively by Claude Code (point to the command, change nothing), a manual zip upload in Claude Desktop is updated here (download, verify, swap with a backup). Use when the user says "/update-hypervibe", "update hypervibe", "update the plugin", "mets a jour hypervibe", "is there a new version?", "which version is running?", or asks whether their plugin is up to date.
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js 18+. No account and no API key: the plugin is open source, the published version is read from the public repository and the archive is downloaded without a token."
---

# Update Hypervibe

Updates **this plugin** to the latest published version.

Hypervibe is installed in one of two ways, and only one of them needs you:

- **Marketplace install** (`/plugin marketplace add flavien-ia/hypervibe-harness`): Claude Code tracks the repository and updates the plugin itself. Replacing files behind its back would put it at odds with its own registry. You point to the native command and stop.
- **Manual upload** (the zip from hypervibe.fr, dropped into Claude Desktop): nobody tells the user a new version came out. That is the case this skill exists for.

The mode is read from Claude Code's own registry, never guessed.

## Progress reporting

The audience may not be technical. Plain sentences, no jargon: "I am checking whether a newer version exists", "I am replacing the plugin files", never "unzip" or "backup directory" without explaining.

## Step 1 - Check

```bash
PLUGIN_DIR="${CLAUDE_SKILL_DIR}/../.."
node "$PLUGIN_DIR/scripts/update/update-hypervibe.mjs" check
```

Read the JSON:

- `offline: true` → *"I cannot reach the update server right now, try again a little later."* **STOP.**
- `mode: "marketplace"` → Claude Code owns the update. Report the versions, then give the command from `commandeNative` and explain it runs in Claude Code, not here. If `updateAvailable` is false, run Step 3b (the rules), the hooks-chain step (Step 3c - Close the hooks chain), Step 3d and Step 3f first. **STOP** (do not download anything).
- `updateAvailable: false` → *"Your plugin is already up to date (version `localVersion`)."* Run Step 3b (the rules), the hooks-chain step (Step 3c - Close the hooks chain), Step 3d and Step 3f, then **STOP.**
- `updateAvailable: true` and `mode: "manuel"` → announce: *"A new version is available: `publishedVersion` (you have `localVersion`). Shall I download and install it?"* Wait for the yes.

## Step 2 - Download

```bash
node "$PLUGIN_DIR/scripts/update/update-hypervibe.mjs" download
```

The JSON gives `file` (the archive, in `~/.hypervibe/updates/`), `version`, `files`, `sha256` and `sha256Verified`.

**The download verifies itself.** The script compares the hash of what it received against the fingerprint the site publishes for that version, and returns `ok: false, reason: "sha256-mismatch"` rather than handing you an archive to install. If that happens, **stop**: say the download does not match what was published, that nothing was installed, and that the same fingerprint appears on the GitHub release if the user wants to check for themselves. Do not retry blindly, do not install anyway.

`sha256Verified: false` means the site did not publish a fingerprint for that version (published before the mechanism existed, or the manifest was unreachable). That is not an error: continue, and do not mention it.

⚠️ **Compare `version` with the `publishedVersion` of Step 1.** The repository announces the release, the site serves it; on the rare occasion the two disagree, the download is the one telling the truth. If they differ, say so plainly and offer to retry later rather than installing something the user did not agree to. **STOP** on any failure, passing on the `message`.

## Step 3 - Install

```bash
node "$PLUGIN_DIR/scripts/update/update-hypervibe.mjs" install --zip "<file from step 2>"
```

The script unpacks the archive to a temporary folder and checks it is a complete plugin **before** touching the installation in place. Only then does it move the current folder aside as a backup and put the new one in its place. If anything fails at any point, the previous version is restored on its own.

- `ok: true` → the JSON gives `version`, `oldVersion`, `backup`, `backupKept` and `desktop`. Go to Step 3b. Keep `backupKept` and `desktop` for Step 4.
- `ok: false` → nothing was replaced, or the previous version was put back. Report the `message` honestly. **STOP.**

## Step 3b - Bring the rules in step

The plugin writes a managed block of rules into `~/.claude/CLAUDE.md`. Until now it was only ever synced by `/start`, so an installed machine kept the rules of the day it was set up: a rule shipped with a mistake stayed wrong, and new rules never arrived. Run it here, right after a successful install, and also when Step 1 finds the plugin already up to date (marketplace or manual): a plugin uploaded by hand in Claude Desktop, or updated natively by Claude Code, arrives without this step having run. The script is idempotent and safe to run again:

```bash
PLUGIN_DIR="${CLAUDE_SKILL_DIR}/../.."
node "$PLUGIN_DIR/scripts/update-global-claude-md.mjs"
```

One JSON line comes back. Mention only what is not empty, in one sentence, in the user's language: rules added, updated, removed. **If `keptEdited` is not empty, name those rules**: they have a newer version, but the user's own wording was kept.

⚠️ **If `movedToProject` is not empty, say so and give the command, whatever folder we are in.** Those rules left the global block because they belong to a web project, and until the user writes the project block into each of their existing repositories, **they apply nowhere**. The gap is invisible: the rules simply vanish from `~/.claude/CLAUDE.md`. Reported on 2026-08-21 by a user who watched seven rules disappear with no way to know he had to go and fetch them:

> Those rules now live in your projects rather than in every session. In each existing web project, run: `node "<PLUGIN_DIR>/scripts/rules/update-project-claude-md.mjs"` (replace `<PLUGIN_DIR>` with the real path). New projects get the block on their own.

Then, if the current folder is itself a web project (`package.json` with `next`, and a `CLAUDE.md`), offer to bring its project rules in step right away, and run it only if the user agrees:

```bash
node "$PLUGIN_DIR/scripts/rules/update-project-claude-md.mjs"
```

## Step 3c - Adopt the resource manifest in existing projects

Recent plugin versions record every cloud resource a project owns in `.hypervibe/resources.json` (the **resource manifest**), at the moment the resource is created. Backups and deletion read it first, instead of guessing resources by name - the guessing is what used to make a backup silently skip a bucket named differently from the project. Projects created before this mechanism have no manifest: this step catches them up, the same way Step 3b catches up the rules.

If the current folder is a web project (`package.json` with `next`) **without** `.hypervibe/resources.json`, offer to adopt it. If the user agrees:

```bash
node "$PLUGIN_DIR/scripts/manifest/manifest.mjs" adopt --project-dir "<project-root>"
```

This is a **dry run**: it derives resources from the project's own identifiers (database host, storage variables, Vercel link, git remote, wrangler.toml, public URL) - never from name similarity - and touches nothing. Present what it found, in plain language, with each `source`. Then, only after the user confirms:

```bash
node "$PLUGIN_DIR/scripts/manifest/manifest.mjs" adopt --project-dir "<project-root>" --write
```

Three things to say around it:

1. **The file is meant to be committed** (never gitignored): it holds identifiers only, no secrets, and documents the project's infrastructure.
2. **Adoption only sees what the project itself declares locally.** Resources with no local trace (a cron on the shared clock, a domain zone the env does not mention, a storage bucket whose credentials are kept elsewhere) are not found - list what obviously might be missing and offer to record them with `manifest.mjs add` (the `_track-resource` skill documents kinds and fields). Better an explicitly incomplete manifest than a guessed one.
3. **Other existing projects need the same pass**: adoption runs per project. Mention it once, with the command to run from each project's folder.

If the current folder is **not** itself a web project, do not stop at that: it may be an **umbrella folder** holding several sub-projects (a parent directory with `site/`, `cockpit/`, `protos/<name>/`, each being its own repository). Look one and two levels down for folders that are **their own repository** (they contain `.git`, plus a `package.json`), list what you find, and offer to adopt each sub-project - each gets its own manifest at its own root, through the same dry-run then `--write` flow. A folder with a `package.json` but no `.git` of its own, sitting INSIDE a repository (e.g. `apps/web`), is an app of a **monorepo**, not a sub-project: the monorepo takes ONE manifest at its repository root, and the adoption runs from anywhere inside it (the tool anchors at the root on its own). The rule to state plainly: **one manifest per repository root, never in the umbrella folder** - the umbrella owns nothing, its sub-projects do. This nesting is exactly how existing projects get missed: a tour that only looks at the top level walks straight past them. If nothing is found at any level, mention that each existing project can be adopted by running the command from its folder, and move on.

## Step 3c - Close the hooks chain on this machine

Until 3.1.4 the global git hooks written by `/start` ran the versioned `.hooks/pre-commit` and `.hooks/pre-push` of ANY repository, a clone included, which is exactly what git's own hooks are never versioned to prevent. The block now runs a checkout's hooks only after a local opt-in (`git config hypervibe.hooks true`, set by `/add-test`, never cloned). An installed machine keeps the old block until something rewrites it, so run this right after the install, and also when Step 1 finds the plugin already up to date (marketplace or manual: a plugin uploaded by hand or updated natively arrives without this step; idempotent, a few milliseconds):

```bash
PLUGIN_DIR="${CLAUDE_SKILL_DIR}/../.."
node "$PLUGIN_DIR/scripts/ensure-hooks-chain.mjs"
```

`REFRESHED` means the old block was replaced in both global hooks; `OK` means the machine was already closed; `INSTALLED` means the pre-push chain was missing and is now in place; `FOREIGN` means a pre-push that is not Hypervibe's exists and was left alone (say so, in one sentence). `LOCAL` means this machine has no machine-wide git hooks (the secret scan was never installed by `/start`): there is nothing to close, and **nothing was written, nothing was trusted**. Say it in one plain sentence (*"this computer has no machine-wide git hooks, so there was nothing to close here"*), never as an unexpected result, and never as "the hooks of this repository were set up". Then, if the current folder is a repository equipped by `/add-test` (it has a `.hooks/pre-push`), tell the user that its hook is now inert on this machine until they opt in, and offer the command `git config hypervibe.hooks true`. Run it only if they agree: it is their decision, per checkout. After `LOCAL`, that opt-in alone runs nothing (no chain hook exists on this machine): offer `/start` instead, which installs the secret scan and the chain, or, for this repository only, `node "$PLUGIN_DIR/scripts/ensure-hooks-chain.mjs" --trust` (the guardrail asks first). Only with the user's agreement.

## Step 3d - Bring the shared clock in step

The shared clock is the `hypervibe-jobs` worker that `/start` deploys on the user's Cloudflare account: it runs the database backups, the quota alerts and the scheduled pings. Installing a new plugin never touches it, so a machine can run the newest plugin and an old worker for months. Check it after a successful install, and when Step 1 finds the plugin already up to date (the plugin files may have moved forward while the worker stayed behind, for instance after a manual install):

```bash
PLUGIN_DIR="${CLAUDE_SKILL_DIR}/../.."
eval "$(node "$PLUGIN_DIR/scripts/wrangler-env-init.mjs")"
node "$PLUGIN_DIR/scripts/shared-worker/worker-check.mjs" --dry-run
```

The dry run never creates a worker (no `~/.hypervibe-jobs` on this machine means nothing to repair), compares locally, and changes nothing. One JSON line comes back:

- `status: "absent"` or `"up_to_date"` → say nothing.
- `status: "stale"` → the clock runs an older plugin version. Say so in one sentence, and what the repair fixes when `knownBugs` is not empty (from each `message`; for the storage bug: *"your storage alert only looked at the largest bucket instead of the whole account"*). Then say that bringing it in step **redeploys the worker on the user's Cloudflare account**, and run the real command **only once the user agrees**; the guardrail asks for confirmation at that moment, and that question is the same yes (outside review, 3.1.6):

```bash
node "$PLUGIN_DIR/scripts/shared-worker/worker-check.mjs"
```

- `status: "updated"` → one sentence: the shared clock now runs this version of the plugin. When it also carries `neonOrg` with a `remedy` (the quota watch cannot tell which Neon organisation to read), pass the remedy on in one or two sentences, without choosing an organisation for the user.
- `ok: false` with an `error` about `CLOUDFLARE_API_TOKEN` → the vault is locked. Say a window will open for the master password, run `node "$PLUGIN_DIR/scripts/vault/launch.mjs" unlock`, then run the check once more.
- any other `ok: false` → pass on `error` (and `howTo` when present), and say the clock keeps its previous version until the next `/quotas` or the next update. Never hold the rest of the update on it.

## Step 3e - Repair the code check of the current project

Projects made by `/bootstrap` before 3.4.5 may have a broken code check: `pnpm lint` stops on "ESLint couldn't find the plugin eslint-plugin-react-hooks", because pnpm 10 and later no longer put ESLint's plugins at the project's root. If the current folder is a web project (`package.json` with `next`), diagnose it (nothing is written):

```bash
PLUGIN_DIR="${CLAUDE_SKILL_DIR}/../.."
node "$PLUGIN_DIR/scripts/repair-lint.mjs" --project-dir "<project-root>"
```

- `needed: false` → say nothing.
- `needed: true` → say it in one sentence (with `reachable: true`, the check works today only thanks to an older install, and the next reinstall would break it), then what the repair does: one block in `pnpm-workspace.yaml`, the same setting in `.npmrc` when the project's version of pnpm reads it only there (an older pnpm 10, `reason: "npmrc-missing"`), then a reinstall of the project's dependencies (about a minute; the lockfile does not change). Run it only if the user agrees:

```bash
PLUGIN_DIR="${CLAUDE_SKILL_DIR}/../.."
node "$PLUGIN_DIR/scripts/repair-lint.mjs" --project-dir "<project-root>" --write
```

`repaired: true` → the code check works again, and the files to commit are the ones `commit` lists (`pnpm-workspace.yaml`, `.npmrc`, or both: offer to commit them by name). `repaired: false` after a reinstall → say so plainly, the code check still stops: nothing more is tried, and the files written stay to look at. `note` present → no dependencies are installed here: the block is in place, and the next `pnpm install` finishes the job. `ok: false` with `step: "install"` → pass on `detail`: the lockfile is probably not in step with `package.json`; a `pnpm install` run by the user brings it in step, then the same command again.

Other projects made by `/bootstrap` need the same pass: mention it once, with the command to run from each project's folder.

## Step 3f - Close the admin space of existing projects

Until 3.4.17, the admin space that `/add-auth` creates was protected by its layout alone. Next.js renders a layout and its page at the same time: when the layout sends a visitor without a session to the sign-in page, the content of the page, already prepared, leaves with that redirect. A browser shows nothing, a plain request reads it all. 3.4.17 fixed what the plugin writes and taught `/security` to find the defect, but a project built before stays exposed until it is repaired, and its CLAUDE.md keeps teaching Claude the old pattern for every new admin page. This step offers the repair for every project of this machine that needs it.

The same pass repairs a second defect, in the same projects and with the same agreement. From 3.3.11 to 3.4.18, the sign-in pages, the notification bell and the click on a system notification checked the address a link brings back to (`?callbackUrl=`, a notification's link) with a pattern on its raw text. A browser drops tabs and line breaks before reading an address: `/%09/evil.com` passes the pattern and leads to another site, right after signing in. 3.4.19 reads that address with the URL reader (`internalPath`). The script rewrites the old lines where they are still the templates' own, word for word, and never another one.

Run it after a successful install, and also when Step 1 finds the plugin already up to date (marketplace or manual): the update that brought this step ran the text of the previous version, which did not have it, so the projects are caught up by the next `/update-hypervibe`.

```bash
PLUGIN_DIR="${CLAUDE_SKILL_DIR}/../.."
node "$PLUGIN_DIR/scripts/repair-admin-gate.mjs" --scan --cwd "$(pwd)" --redirects
```

`--redirects` (on every call of this step) adds the return address to the repair. It looks at the current folder and its project, and at the folders where this machine keeps projects, one and two levels down (never the whole disk). It writes nothing and prints one JSON line.

- `needed: 0` → one sentence (*"None of your projects has an admin space or a sign-in link left open."*), then the other copies below (`otherCopies`), then the lines left to `/security` below (`openRedirect`), then go on.
- `unreadable` not empty → name those folders in one sentence: they were not looked at. Never stop on them.
- Otherwise, list each project of `projects` whose `needed` is true, in plain words, one line each: its `name`, its folder (`dir`) and the number of pages to correct (`counts.toFix + counts.manual + counts.review`), adding *"its CLAUDE.md still teaches the old rule"* when one of its `claudeMd` entries says `outdated` or `edited`, and *"and N sign-in or notification links to make safe"* when `counts.redirect` is above 0. Then say what happens today, in one sentence each, only for what the list holds: *"A page of the admin space can let its content be read by someone who asks for it without being signed in: a browser shows nothing, a simple request reads it."*; *"A trapped link can send someone, right after they sign in, to another site that copies yours."* Then ask which projects to repair, offering every one of them (a multiple choice when they fit in one question, otherwise the numbered list and an answer in words: all of them, or their numbers). **Nothing is written before that answer.** A project left out stays as it is: say it once.
- **A project with `copies`** is one repository with several working copies (folders made by `git worktree add`, each on its own branch): it is ONE project, never one line per folder. Its line names the branch of `dir` (`branch`), the copy offered first: the one on the branch the site deploys from (`productionBranch`, read in the repository's own files: its remote's default branch, otherwise `main`, then `master`; `productionFrom` says which; `firstCopy` says why that copy comes first). The project's `needed`, its counts and the repair are that copy's alone: a repair reaches the live site only through that branch. When `productionBranch` is null, say that the branch the site deploys from could not be read, and ask which copy holds it before repairing.
- **The other copies that still have the old pages** (`otherCopies`, on any project of `projects`, `needed` or not; the scan's `otherCopies` counts the projects that have some): one line per project, never one per folder, after the list above: *"<name>: N other working copies of this project still have the pages from before (<their branches>)"*, then what their `state` says: `merged`, *"with nothing pending, and already in <containedIn>"*; `work`, *"with work in progress"* (`uncommitted` true: files not saved yet; `contained` false: commits that <containedIn> does not have); `unread`, *"I could not read whether they hold work in progress"*. Then: *"They are not what is online. Each can be brought up to date from <containedIn>, or removed once it is of no use."* Never offer to repair them, to write in them, or to remove them: this step only says it, and the person decides (a copy with work in progress is theirs to finish first).
- **The return address after signing in** (`openRedirect`: the number of projects concerned, each project's `openRedirect` naming its lines, and `copies[].openRedirect` counting a copy's): a line with `fix: "auto"` is the templates' own, and is part of the repair above (`counts.redirect`). A line with `fix: "manual"` (changed by hand, or the form before 3.3.11 that follows the address as it comes) is never rewritten by this step, it is only said. Name each project that has one, in one line: *"<name>: after signing in (or on a notification's link), the address carried by the link is still checked in a way that a link to another site gets through, written differently from the templates: `/security` in this project fixes it."* A project without a `manual` line is not named here.

Then, for each project chosen, one after the other:

1. **What will change.** `node "$PLUGIN_DIR/scripts/repair-admin-gate.mjs" --project-dir "<project folder>" --redirects` (writes nothing). Say it in plain words: the check added at the top of each page of `pages` whose `status` is `to-fix`, the helper that check calls when `helper.status` is `would-write`, the first barrier when `middleware.status` is `would-write` (its `file`), the rule of the CLAUDE.md brought up to date, and each file of `openRedirect` with `fix: "auto"` (its `file`), where the address of the link is read by the URL reader from now on (a small function, `internalPath`, added once at the top of the file, nothing else changed). A `skipped` one is not written by `--write`: never announce it; its `reason` says why (the pages' own reason, or `nothing-to-fix` when no page will call the check; for the barrier, see point 4). When `uncommitted` lists files, say that they already hold changes not committed yet: committing the repair would take those changes along, and the person decides when. When `uncommitted` is `null`, git could not be asked (a folder that is not a repository, or git did not answer): it is never "nothing pending". Say it: *"I could not check whether these files already hold changes not saved yet: look at them before the commit."*
2. **The repair.** `node "$PLUGIN_DIR/scripts/repair-admin-gate.mjs" --project-dir "<project folder>" --write --redirects`. It touches only what the diagnosis named: `await requireAdmin();` first in each `to-fix` page, with its import, and `async` when the function was not, nothing else in the page; the layout keeps its own check; and the old lines of the return address that are still the templates' own (`redirects` lists the files), nothing else in the file. `ok: false` → pass on `step` and `detail`, name what was already written (`commit`), and go to the next project.
3. **What the script leaves to you** (`remaining`). An entry with `kind: "redirect"` (a return address written differently from the templates) is not corrected in this step: say it, and that `/security` in this project fixes it. The others are corrected by hand with the rule of `/security` (Step 3, point 2): each `manual` page (its `reason` says why) and each `review` page (a page its layout alone protects: a members' area, a role's space, an admin space outside `admin/(protected)`, or a layout whose check the script could not read for sure, which it counts as one) gets the check that `fix` names, on its first lines, before any read, nothing else changed, and never a weaker one than its layout's: `requireAdmin` is `await requireAdmin();` (from `~/server/require-admin`); `layout` is the check of the layout named in `layout` (the same condition, the same redirect), copied on the page's first lines; `admin` is the project's own admin check (`isAdmin()` from `~/server/auth` when it exists; otherwise ask the person what closes their admin space). Before closing a `review` page, make sure it is meant for signed-in people only: a public page (the home page, the pricing, a page anyone may read) stays as it is, and when in doubt, ask. A rule of the CLAUDE.md marked `edited` (the old rule, in other words) is rewritten as the current one, keeping what the person added. Show each change and apply it only on a yes. When `review` pages were corrected and the CLAUDE.md has no rule for the pages of signed-in users (`users: "absent"`), offer to add it (`_update-claude-md`, section Conventions, the line `_setup-auth-users` writes).
4. **A middleware the project already has** (`middleware.status: "existing"`, named in `file`): never replaced. When that is safe, merge the gate of `${CLAUDE_SKILL_DIR}/../../templates/auth/admin/middleware.ts` into it (the cookie check first, for the admin paths only, then its own logic, with `// hypervibe:admin-gate` as its first line so that the next check recognises it), shown first, on a yes; otherwise say in one sentence what is missing. The pages are protected by `requireAdmin()` either way. When `middleware.status` is `skipped`, no barrier is written, and its `reason` says why, in one sentence: no `/admin/signin` page to send to (`no-signin`), or a session cookie that is not the one it looks for (`next-auth-4`, a next-auth older than 5; `custom-cookie`, a configuration that renames it), where it would send the administrator back to sign-in forever.
5. **The code check.** In each app of the project (`apps[].dir`), when its dependencies are installed (a `node_modules` folder there): `pnpm tsc --noEmit && pnpm lint`, and fix what they raise. Without `node_modules`, say so: the check runs after the next `pnpm install`.
6. **The commit, offered.** The files of `commit` and the ones corrected by hand in this step, by name, each path in quotes: `git add -- <files>` then `git commit -m "<what changed, in a few words>" -- <files>`. Say it again first when one of them was in `uncommitted`. When `uncommittedBefore` (or `uncommitted` of point 1) is `null`, nothing tells whether those files held changes of the person's before the repair: say it again, and offer no commit until the person has looked at those files and said the commit may take them as they are. A project that is not a git repository has nothing to commit: say so.
7. **Putting it online, offered too.** **The repair protects the live site only once it is deployed**: until then, the site keeps the old behaviour: a request without a session still reads the pages, and a trapped link still leads elsewhere. Say it plainly. When the project deploys from its pushes, `git push` puts it online; the guardrail asks at that moment and lists what leaves, and that question is the person's yes. A branch other than the one the site deploys from (usually `main`) is not online yet: say so.
8. **The proof, once online.** When the project knows its public address (`node "$PLUGIN_DIR/scripts/env-value.mjs" --project-dir "<app folder>" NEXT_PUBLIC_APP_URL` gives an `https://` address other than localhost), wait for the deployment of that commit (`node "$PLUGIN_DIR/scripts/vercel/check-deploy.mjs" --project-dir "<app folder>" --sha "$(git rev-parse HEAD)" --timeout 600`), then ask, without any cookie, for one page that was `to-fix` (its address is its folders after `src/app`, route groups in parentheses left out; `/admin` itself when its page was one), the proof without risk of `/security` (1b):

   ```bash
   curl -s -o /dev/null -w "%{http_code} %{size_download}\n" https://<site>/admin/<page>
   ```

   A redirect of a few dozen bytes: the first barrier answered, and the page no longer leaves with it. When the project kept its own middleware without the gate, the redirect comes from the page itself and weighs a few kilobytes: count a word the page shows instead (`curl -s https://<site>/admin/<page> | grep -c "<a word of the page>"`), and 0 means its content no longer leaves. **Never print what comes back**: it may be personal data. Without a known address, say that `/security` makes the same check once the site is online.

To finish, one sentence: this repair closes the admin space, and a complete audit of each project remains the job of `/security`.

## Step 4 - Wrap up

> **Update installed (version `<version>`)! ✨**
>
> One last thing: **type `/reload-plugins`** (or open a new conversation) so Claude loads the new version, its guardrails and rules included.

Then, depending on the JSON of Step 3:

- `backupKept: true` → add: *"The previous version is kept as a backup (`hypervibe-backup-<old version>`): once you have confirmed everything works, you can ask me to delete it."* If a `hypervibe-backup-*` folder from an **earlier** update is still lying around and the current plugin works, offer to delete that one too.
- `backupKept: false` → **never promise a backup.** The plugin does not live in a marketplace folder (on Claude Desktop, the registry of uploaded plugins deletes every folder it does not know a few minutes after an update, the backup included). The backup only served to undo the swap if it had failed. Say nothing about it, unless the user asks: then say exactly that.
- `desktop: true` → add one sentence: *"Claude Desktop will keep showing the old number in its Plugins screen, that is normal: the version that runs is `<version>`."* (Desktop shows the version of the upload, never the one on disk.)

## Which version is running?

When the user asks which version of Hypervibe runs (*"quelle version tourne ?"*, *"which version do I have?"*), **never search the disk for a `plugin.json`**: other copies may lie around (an old bench, a download) and the Plugins screen of Claude Desktop shows the version of the upload, not the one that runs. Run Step 1 only and answer with its `localVersion` and its `pluginDir`: they are read in the very folder this skill was loaded from. If an update was installed earlier in this conversation without `/reload-plugins`, say that the conversation still runs the previous version until then. Then stop: offer the update only if `updateAvailable` is true, and install nothing without a yes.
