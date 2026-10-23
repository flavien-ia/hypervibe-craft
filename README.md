# Hypervibe

> 🇫🇷 [Lire en français](README.fr.md)

A Claude Code plugin that bootstraps full-stack T3 projects with modular addons. Built for non-technical users who want to create and deploy web apps by describing what they want in plain language.

> 📘 **First time? Follow the [step-by-step installation guide](https://hypervibe.fr/plugin/installation).** It walks you through the prerequisites, the accounts to create, and your first project, end to end.

## Installation

You need [Claude Code](https://claude.com/claude-code) first. It is included with a **Claude Pro** plan or higher (the free plan is not enough), and ships with the Claude desktop app (Mac and Windows) or as a CLI. New to Claude? [Create your account and subscribe here](https://claude.ai/referral/BtZlSHizAA). Then, inside Claude Code, run:

```
/plugin marketplace add flavien-ia/hypervibe-harness
/plugin install hypervibe@hypervibe-harness
```

Updating from a version older than 2.5? After updating the plugin, just re-run `/start` in Claude Code: it detects your old background mechanisms and consolidates them into the new unified one for you, safely and with your consent at each step (nothing happens if you have nothing to migrate). More context in [MIGRATION.md](MIGRATION.md).

Then type `/start`: it installs everything else for you (Node.js, pnpm, Git, and each service's CLI) and checks that all your connections work.

Prefer a guided, click-by-click version? See the full walkthrough at **[hypervibe.fr/plugin/installation](https://hypervibe.fr/plugin/installation)**.

## Codex, OpenCode and Antigravity

Hypervibe is written for Claude Code, but the same plugin also runs on **OpenAI Codex**, on **OpenCode** and on **Google Antigravity**: the same skills, the same guardrail, the same MCP server. hypervibe.fr serves a version converted for each host and explains how to install it without writing a line of code:

- [Hypervibe for Codex](https://hypervibe.fr/en/plugin/codex)
- [Hypervibe for OpenCode](https://hypervibe.fr/en/plugin/opencode)
- [Hypervibe for Antigravity](https://hypervibe.fr/en/plugin/antigravity)

Developers can also convert this repository themselves with the open source converters behind those downloads, [claude-plugin-to-codex](https://www.npmjs.com/package/claude-plugin-to-codex), [claude-plugin-to-opencode](https://www.npmjs.com/package/claude-plugin-to-opencode) and [claude-plugin-to-antigravity](https://www.npmjs.com/package/claude-plugin-to-antigravity) (one engine, [claude-plugin-port](https://github.com/flavien-ia/claude-plugin-port)):

```bash
git clone https://github.com/flavien-ia/hypervibe-harness.git
npx claude-plugin-to-codex --source ./hypervibe-harness         # Codex
npx claude-plugin-to-opencode --source ./hypervibe-harness      # OpenCode
npx claude-plugin-to-antigravity --source ./hypervibe-harness   # Antigravity
```

What differs from Claude Code: the rules file is `AGENTS.md` (on Codex and OpenCode, your existing `CLAUDE.md` on a machine that also runs Claude Code; Antigravity reads `AGENTS.md` only), a question to you is asked in plain text on Codex and through the `question` tool on OpenCode, routines run in the scheduler of Codex's and Antigravity's desktop apps, and a few skills still describe menus that only Claude Code has. Everything else, vault included, is the same scripts.

## Getting started

| New to this? | Already comfortable? |
|---|---|
| `/start` - checks your setup and shows you around | `/bootstrap` - jump straight in |
| `/prof` - explains how everything works | `/spec` - build a detailed spec first |

## How it works

Just describe what you want to build. Claude analyzes your description and infers which addons are needed (database, auth, payments, etc.), then presents the plan for your approval before building.

```
/bootstrap My photographer portfolio website
/bootstrap My lead management dashboard with user accounts
/bootstrap My online invoicing SaaS with Stripe payments
```

### Three ways to define your project

When you launch `/bootstrap`, you choose how to describe your app:

- **A - Build a spec together** (`/spec`): Claude guides you step by step through 5 blocks (project, pages, design, features, constraints) and produces a `cahier-des-charges.md`
- **B - Provide an existing spec**: give Claude a `.md` file, he reads it and infers the infrastructure
- **C - Short description only**: Claude asks the infrastructure questions in one go and builds a simple app

## All skills

### Workflow skills

| Skill | What it does |
|---|---|
| `/bootstrap` | Create a new project from scratch |
| `/spec` | Build a detailed project specification, step by step |
| `/start` | First-time onboarding: checks prerequisites, presents all commands |
| `/prof` | Explains how everything works in plain language (pedagogical mode) |
| `/seo` | Audit SEO and fix issues (metadata, sitemap, share image, structure, URLs/slugs, accessibility, readability, topic coverage, freshness, local business), plus what only the live site shows (an unintended noindex, a duplicate address, temporary redirects, broken links, the sitemap's errors). A score computed on a fixed grid, kept in the project to compare passes |
| `/geo` | Audit and optimize for AI answer engines (ChatGPT, Claude, Perplexity, Gemini, Copilot): first whether AI robots can read the pages (text without JavaScript, a firewall that turns them away, robots.txt rules built from a dated and sourced list of AI robots), then citability, E-E-A-T, Q&A format. llms.txt and FAQ markup offered as what they are: bets. Complementary to `/seo`. |
| `/gsc` | Connect the site to Google Search Console, verify DNS automatically, submit the sitemap, then audit what Google actually sees - indexing coverage, top queries, quick wins (positions 11-20), low CTR pages, zombie pages, read by `/seo` too; offers to connect Bing Webmaster Tools by importing the property. Complementary to `/seo` (external Google data). |
| `/security` | Security audit (secrets, auth, headers, dependencies, RGPD) |
| `/accessibility` | Accessibility audit: reads the code (images, buttons, form fields, keyboard, focus, zoom), measures the live pages, explains each problem in plain words, then applies the fixes you approve |
| `/rgpd-audit` | RGPD compliance audit - detects third-party services in use, updates the subprocessors registry, generates or refreshes the privacy policy page |
| `/clean` | Find unused files, dead code, orphan env vars and DB tables - review + delete on a branch |
| `/rotate-secret` | Rotate a secret (Stripe, Brevo, Google…) everywhere it lives - local + Vercel |
| `/quotas` | Show your current usage against each service's free tier (Neon, Cloudflare, Brevo, Resend, Vercel) with verdicts per gauge |
| `/update-hypervibe` | Update the plugin itself to the latest published version (checks how it was installed, keeps a backup) |

### Addon skills

Each addon can be activated during `/bootstrap` or used standalone on an existing project.

| Skill | What it adds |
|---|---|
| `/add-db` | Neon PostgreSQL + Drizzle ORM (DB provisioned in Frankfurt, `aws-eu-central-1`) |
| `/add-auth` | NextAuth v5 - admin-only interface OR user accounts (email+password with signup, account, delete, and optional forgot-password if email is configured). Google/GitHub OAuth offered as optional add-ons in users mode. |
| `/add-google-auth` | Add Google OAuth login (extends `/add-auth`) |
| `/add-github-auth` | Add GitHub OAuth login (extends `/add-auth`) |
| `/add-email` | Resend or Brevo transactional emails (auto-detected) |
| `/add-stripe` | Stripe Checkout payments |
| `/add-i18n` | next-intl internationalization |
| `/add-storage` | Cloudflare R2 file storage |
| `/add-analytics` | Google Analytics (GA4) with RGPD cookie consent |
| `/add-map` | Interactive vector map (MapLibre + OpenFreeMap - free, no API key, EU). Single pin, multi-pin, route, or map-first layouts |
| `/add-dark-mode` | Dark mode (light / dark / system) with a ready-to-use toggle |
| `/add-test` | Automated tests (vitest) + a human-readable cahier de recette, with a pre-push hook and CI that refuse to publish a feature without its verification |
| `/add-domain` | Connect a custom domain name (guided setup) |
| `/new-email-address` | Create a receiving address (`contact@yourdomain.com`) forwarded to your inbox (Cloudflare Email Routing) |
| `/add-cron` | Scheduled task - Cloudflare Worker (precise) or GitHub Action (best-effort), chosen based on what the cron does |
| `/add-automation` | Anything your app does on its own - routes to a scheduled task, an in-app intelligent pipeline, an autonomous agent, or a dedicated worker, depending on what you describe. |
| `/add-ai` | Add AI to the app (chat assistant, analysis and classification, content generation) through OpenRouter. Cost is estimated and approved BEFORE any code, the key carries a provider-side spending cap, and every call is logged with its real cost. |
| `/add-agent-dashboard` | Monitoring dashboard for agents under `/admin/agents` (cost, runs, turn-by-turn detail, run-now button) |
| `/add-collab` | Add GitHub collaborators that can deploy (via GitHub Actions, without paying a Vercel seat) |
| `/add-backup-db` | Automated Neon DB backups (shared Cloudflare Worker, rolling + aging snapshots) |

To use an addon standalone, simply ask Claude Code:
> "Add authentication to my project" → uses add-auth
> "Set up Stripe for payments" → uses add-stripe
> "I want to connect my domain name" → uses add-domain

### Internal helpers

The plugin also ships with `_`-prefixed internal skills that are invoked automatically by the public skills above (never by the user directly). They handle shared concerns like env var pushing (`_push-env-vars`), dependency detection (`_check-deps`), secret generation, password hashing, auth setup sub-branches, CLI auto-install, etc. You never need to invoke them yourself.

## Stack

Projects bootstrapped with this plugin use:

- **Next.js** (App Router) with TypeScript
- **tRPC** for type-safe API routes
- **Drizzle ORM** for database access
- **Tailwind CSS** for styling
- **shadcn/ui** for UI components
- **Inter** as the default font (via next/font)
- **GitHub** for source control
- **Vercel** for hosting and deployment (functions pinned to `fra1` - Frankfurt)
- **Neon** for PostgreSQL database (provisioned in Frankfurt, `aws-eu-central-1` - when DB addon is used)
- **Resend or Brevo** for transactional emails (when the email addon is used)
- **Stripe** for payments (when stripe addon is used)
- **Cloudflare R2** for file storage (when storage addon is used)
- **Google Analytics** for analytics (when analytics addon is used)
- **next-intl** for internationalization (when i18n addon is used)
- **Anthropic** (Claude API) for autonomous AI agents (when the agent addon is used)
- **Render** for hosting AI agents and long-running automations (when the agent / automation addon routes to Render)
- **Bitwarden** as a **key vault** - your cross-project access keys (Cloudflare, Neon, email…) are stored **encrypted** in a vault, never in plaintext on disk or in environment variables. `/start` sets it up (free account, EU region); you type one master password when the vault is closed, it stays open six hours and then locks itself for real, and in between Claude fetches the keys on its own when needed.

## What the bootstrap sets up automatically

Every project gets, regardless of mode:

- T3 scaffold (Next.js + TypeScript + Tailwind + tRPC)
- shadcn/ui component library
- Base SEO (metadata, robots.txt, sitemap.ts, OG placeholder, semantic HTML)
- GitHub private repo
- Vercel deployment **with functions pinned to `fra1` (Frankfurt)** - better latency for EU visitors, data stays in EU
- Custom 404 page
- Mentions légales + **data-driven privacy policy page**: powered by a central subprocessors registry (`src/lib/subprocessors.json`) that auto-updates whenever you add a service via `/add-*` skills
- CLAUDE.md with all project conventions

## Guardrails

A written rule is an influence. A hook is a mechanism. The difference was measured on a user's own transcripts: a week after a costly behaviour had been turned into a rule in CLAUDE.md, the same pattern still accounted for 17 of 40 failing tool calls. Turned into a `PreToolUse` hook, it stopped at once, because the call can no longer be produced and the model is handed the correct alternative instead.

So the operations that cannot be undone are guarded, not merely discouraged:

| Command | What happens | Why |
|---|---|---|
| `git add -A`, `git add .`, `git add :/`, `git add ':(top)'`, `git add '*'`, `git add -u`, `git commit -a`, `git commit --all` | **refused** | A sweeping stage once swept another session's uncommitted work into a commit. Stage nominatively: `git add <file>`. |
| `git push` | **confirmation** | Pushing publishes. Consent lives in the conversation, so a human confirms. The question names the commits that leave when the push sends its branch to its upstream (`git log @{u}..HEAD`) or a branch to its remote (`git push origin main`: `origin/main..main`): another session's commits no longer leave unseen. |
| `gh pr merge`, `gh run rerun` | **confirmation** | A merge into the main branch publishes (the main branch is production), and so does running a deployment again. Read the way gh reads it: with the repository option before the verb (`gh pr -R owner/repo merge`) or through `gh api`, the same question. |
| `gh repo delete`, `gh secret delete`, `gh variable delete`, `gh api` with `DELETE`, `gh release delete`, `gh repo rename`, a repository created or made public, or transferred | **confirmation** | Deletes, exposes or moves something on the forge: a repository, a release, a secret, an access, a branch, through the command or through `gh api`. A repository created through `gh api` without saying it is private counts as public, as GitHub creates it public. Reads, `gh pr create` and `gh secret set` pass. |
| `vercel --prod`, `--target production`, `promote`, `rollback` | **confirmation** | Deploys normally go through `git push`. `vercel build --prod` deploys nothing and is not asked. |
| `wrangler deploy`, `wrangler secret put` (not `--dry-run`) | **confirmation** | The shared worker runs with the account's keys; a deploy publishes code that holds them. |
| `pnpm db:push`, `pnpm --filter web db:push`, `drizzle-kit push` | **confirmation** | On this stack the database you reach IS production. |
| `node execute-deletions.mjs` | **confirmation** | Irreversible cloud deletions. Reading the file is not one. |
| `run-sql.mjs` with `DROP` / `TRUNCATE` | **refused** without `--destructif` | Between two backups, nothing brings a dropped table back. The hook reads the same check as the script, in the same file: a keyword inside a string literal (`INSERT INTO log VALUES ('DROP TABLE')`) refuses nothing. |
| `run-sql.mjs` with `DELETE`/`UPDATE` and no `WHERE` | **confirmation** | Rewrites every row. |
| `curl -X DELETE` to a management API the plugin operates (Neon, Vercel, Cloudflare, GitHub, Render, Upstash, Stripe, Brevo, Resend, Bitwarden, Google), and `PUT` / `PATCH` where they overwrite (Neon, Vercel, Cloudflare) | **confirmation** | A project, a database branch with its data, a DNS record: the plugin's scripts check the provider's answers, a bare curl does not. Reads and creations pass. Read as curl reads it: grouped options (`-sX DELETE`), the config it takes on its standard input, which is how the skills hand it a key, and an address kept in a variable the line sets. |
| A change at a domain's registrar (LWS, Hostinger, Gandi, OVH, Porkbun, Namecheap, IONOS, Infomaniak): its nameservers, or the records it keeps | **confirmation** | The whole domain moves with it, its site and its mail. Reads pass, as each registrar says them: Porkbun reads with a POST, Namecheap changes with a GET. |
| `email-key.mjs revoke` (a project's own sending key, revoked at Resend by the plugin's script) | **confirmation** | A site that still sends with the key stops sending: the old key goes only once the site runs with the new one. The script refuses a key the project's manifest does not record, so the account's key and another project's are never revoked. Reading a project's state and making its key pass, as a creation does. |
| `git reset --hard`, `git checkout .`, `git clean -f` | **confirmation** | Discards uncommitted work, possibly someone else's. |
| `git config hypervibe.hooks true`, `ensure-hooks-chain.mjs --trust` | **confirmation** | Trusting a checkout's versioned git hooks runs code that arrived with a clone. A person decides, per checkout. Withdrawing it (`false`, or `--unset`) stays free. |
| `git config user.email <something that is not an address>` | **refused** | Every commit carries it, and a push publishes it: a password typed there by mistake would reach GitHub. The refusal never repeats the value. |
| `shared-worker/ensure.mjs`, `worker-check.mjs` (without `--dry-run` or `--no-deploy`) | **confirmation** | They can redeploy the shared clock, code that runs with the account's keys, like `wrangler deploy`. |
| `shared-worker/register.mjs`, `migrate-live.mjs` (without `--list` or `--no-deploy`, as the script reads them), `db-backup-remove-target.mjs` | **confirmation** | Every change of the clock's registry ends in a redeploy, its code brought up to the plugin's version. A flag none of them reads spares nothing: with `--dry-run`, the question is asked. |

The rules look at the command, not at its costume. `sudo`, `command`, `env`, `time`, a launcher (`npx`, `pnpm dlx`), a version pin (`wrangler@latest`), an absolute path (`/usr/bin/git`), a subshell or a block (`(git add -A && ...)`, `{ ... }`, `if ...; then ...`), a quoted head, and the payload of `sh -c` or `eval` are stripped or unfolded before any rule runs. So is the script of a shell that reads it from elsewhere: `bash <<'EOF'`, `bash <<< '...'`, `echo '...' | bash`, `bash <(echo ...)` (a heredoc's body stays data for every other command), and the line `xargs` rebuilds from what it is sent (GNU's and macOS's), or runs through `find -exec`, `timeout`, `stdbuf`, `caffeinate`, or macOS's `arch`, `xcrun`, `taskpolicy`, `sandbox-exec` and `script`. Their options, and those of `sudo`, `env` or `nice`, are read the way these tools read them: a long option by its prefix, its value after `=` or in the next word, and `env -S` hands over a whole command. Braces are expanded as the shell expands them before anything runs: `git add {.,.}` is `git add . .`, and `git add src/{a,b}.ts` still passes. Each word is kept once, and a command whose braces unfold past what the guard reads is asked about. One frontier is chosen: what a substitution will print (`bash <<< "$(...)"`) only exists at run time, and the scripts' own checks are what hold beyond it. Five such shapes walked past every rule on 3.0.4; closing the family, rather than the five, is what an outside review asked for.

Everything else passes untouched, and that half is tested as carefully as the other: `git add src/a.ts`, `git push --dry-run`, `git add -p`, a `DELETE ... WHERE`, even a commit message that merely mentions `git add -A` all go through (`node hooks/test-hooks.mjs`).

Three things worth knowing:

- **Fail-open.** The hook runs before every Bash call; if it ever fails, it lets the command through and says so on stderr. It is a seatbelt, not an airlock. A file missing beside it leaves the other rules in force and names the one that is off.
- **The hook only sees the command line.** What a script does internally escapes it, so `run-sql.mjs` and `execute-deletions.mjs` carry their own checks. Those also protect a host where the hook is not installed.
- **No email carries a link to localhost.** The `mail.ts` helper that `/add-email` installs (Brevo or Resend) refuses to send a message whose body links to `localhost` or `127.0.0.1`, with an error that names the cause: it happens when a script that sends mail runs on a workstation whose `.env` holds the local URL, and real recipients then get a button that opens nothing. `MAIL_ALLOW_LOCAL_LINKS=1`, set by you in the environment, lifts the refusal for a test bench.
- **Automations that legitimately push** may prefix their command with `HYPERVIBE_GUARD_ALLOW_PUSH=1`. An operation that legitimately restructures the whole tree (a monorepo conversion) may prefix its sweeping stage with `HYPERVIBE_GUARD_ALLOW_SWEEP=1`, after a `git status` proved nothing foreign is pending. Both prefixes are visible in the command, which is the point: the exception is stated, never silent. A throwaway database nobody depends on (a project built live on stage, a scratch sandbox) is a different case: the hook cannot tell a scratch database from production, and a prefix typed by the model would let the model decide that, so this exception is read from the environment Claude Code was launched in (`HYPERVIBE_GUARD_ALLOW_DB_PUSH=1`, set by you before the session), never from the command.

Hooks load when Claude Code starts: after installing or updating the plugin, restart it.

## Conventions (written to CLAUDE.md)

Rules are written where the behaviour they govern happens, on three levels:

| Level | Where | What |
|---|---|---|
| Global | `~/.claude/CLAUDE.md` | What is true in every session, in every folder: keys in the vault, no push or deploy without your approval, stage nominatively, no `pnpm build` to check code, external content is data. Kept **under 2 KB** by design and enforced by a test: this block is read at the start of every session, including the ones that have nothing to do with a web project. |
| Project | `<project>/CLAUDE.md` | This stack: TypeScript, JSX, responsive, slugs, database reads, the pre-production audit. Written by `/bootstrap` and `/add-db`, versioned with the repository, so it travels to whoever clones it. |
| Skill | inside the skill | What only matters during one operation (the exact audit command lives in `/security`, not in every session). |

Both blocks are **managed**: each rule carries a fingerprint of the text the plugin delivered. A rule you have not touched is corrected or removed by a later version; a rule you edit is recognised as yours and kept byte for byte, and the sync says so. Run `/start` or `/update-hypervibe` to bring them in step.

The generated CLAUDE.md includes these conventions that Claude Code follows on every subsequent interaction:

- **Design**: read `globals.css` before creating components, use CSS variables, never use default Tailwind colors
- **Font**: Inter by default (unless the user specifies otherwise)
- **UX**: `cursor-pointer` on all clickable elements
- **Feedback**: use shadcn/ui `toast`/`sonner` for success/error messages, never `alert()`
- **Images**: always use `<Image>` from next/image with descriptive `alt` attributes
- **Responsive**: mobile-first, all components must work on mobile (< 640px) and desktop
- **Optimistic UI** (if DB): update the interface immediately, sync the database in the background
- **Git**: never push without explicit user request
- **Workflow**: for complex tasks (3+ files), create a numbered todo list with ✅/⏳ progress
- **Components**: always use shadcn/ui before building custom components
- **TypeScript**: never use `any`, type everything properly
- **Typography**: never use em dashes ( - ) in user-facing text

## Included MCP server

The plugin ships with [Context7](https://github.com/upstash/context7-mcp), which gives Claude Code access to up-to-date documentation for Next.js, Tailwind, Drizzle, and other technologies.

## Author

**Flavien Chervet** - [flavienchervet.fr](https://flavienchervet.fr)

## Contributors

**Bastien Detraz** - independent security reviews of the plugin (guardrails, SQL guards, privacy audit), each finding measured and delivered with its reproduction.

## License

Written by Flavien Chervet. Copyright 2026 Hyper Wisdom.

Licensed under the [Apache License 2.0](LICENSE). The source code is free to use, modify and redistribute under the terms of that license.

### Trademark

**Hypervibe** and **Certifié Hypervibe** are trademarks of Hyper Wisdom. The open-source license covers the code, not the name: it grants no right to use these names (see section 6 of the Apache License). You may not name a fork, derivative, product or service "Hypervibe", nor imply an official affiliation or certification, without written permission.
