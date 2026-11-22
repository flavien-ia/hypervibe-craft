---
name: _check-deps
description: Internal helper to check project dependencies (DB, email, etc.) with robust heuristics that don't fall for T3 bootstrap placeholders or localhost defaults. Delegates to bundled scripts/check-deps.mjs. Returns JSON. Triggered by add-auth, add-backup-db, and any skill that needs to verify a real cloud dependency is wired up. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Check Deps - Internal helper

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Check if a project has real cloud dependencies wired up (not just T3 defaults / placeholders). Delegates to a bundled Node script - never reimplement the checks inline.

## Env files read

The script merges all Next.js-style env files found at the cwd, with Next.js precedence (later overrides earlier) :

1. `.env`
2. `.env.development`
3. `.env.development.local`
4. `.env.local`

So a var set in **any** of these is detected - critical since some projects put `DATABASE_URL` in `.env.local` only.

## Invocation

From the project root :

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" <check1> [<check2> ...] [--include-vercel]
```

Output : JSON on stdout. Exit code is always 0 - parse the JSON to get per-check `ok` + `reason`.

### Flag `--include-vercel`

Opt-in : runs a `vercel env pull` on the `production` environment and **merges the Vercel vars on top of the local vars** (Vercel wins on conflict). Useful for checks like "is production correctly configured?" (e.g., `/security`, `/clean`).

Prerequisites : project linked to Vercel (`.vercel/project.json` present) and Vercel CLI installed.

Cost : ~2 seconds of network call. Only use it when the Vercel source matters.

If `--include-vercel` is passed, the JSON output includes a `_meta` key with :
- `sources: ["local", "vercel-production"]` if the pull succeeded, otherwise `["local"]` only
- `vercelPull.keys` : list of the **names** of the vars retrieved from Vercel (never the values - no secret leak in the output)

Whatever the checks requested, `_meta.sharedWorker` is present when a shared clock was deployed from this machine. `stale: true` means it runs an older plugin version, which happens after a manual install of the plugin: say it once, in one sentence, with the remedy in `hint`. Never redeploy from here.

## Supported checks

### `db` - real cloud DB wired up

`ok: true` if and only if :
1. `DATABASE_URL` is present in `.env`
2. Its value matches NONE of the disqualifying patterns (case-insensitive) :
   - `@localhost:` (points to local)
   - `@127.0.0.1:` (same)
   - `placeholder` (the word, wherever it is)
   - `//postgres:postgres@` (typical T3/Docker default pair)
   - `YOUR_DB` (marker from `.env.example`)
   - `^file:` (local SQLite, not a cloud DB)
3. A `drizzle.config.ts` or `.js` exists at the root, in `apps/web/`, or in `packages/db/`

Fields returned : `{ ok, reason, host?, drizzleConfig? }`.

### `email` - Resend or Brevo configured

`ok: true` if `RESEND_API_KEY`, `BREVO_CLIENT_ID` with `BREVO_CLIENT_SECRET` (the project's Brevo sending application, 3.4.34), OR `BREVO_API_KEY` is present in `.env` AND does not match a placeholder pattern (empty, `placeholder`, `your_api_key`, `xxx...`, `re_your...`, `xkeysib-your...`).

Fields returned : `{ ok, provider: "resend"|"brevo"|null, reason }`.

### `auth` - NextAuth / auth lib installed & configured

`ok: true` if :
1. An auth file exists at one of these locations (at the root level OR prefixed by `apps/web/`) : `src/server/auth.ts`, `src/server/auth/index.ts`, `src/server/auth.config.ts`, `src/lib/auth.ts`, `src/lib/auth/index.ts`, `src/auth.ts`, `src/auth/index.ts`, `src/app/auth.ts`, `auth.ts`, `auth.config.ts`
2. A secret is present in the env : `AUTH_SECRET` OR `NEXTAUTH_SECRET` OR `BETTER_AUTH_SECRET`, and non-placeholder

The check also tries to **infer the mode** from the env : presence of `ADMIN_PASSWORD_HASH_DEV` or `_PROD` → `admin-credentials`, otherwise `user-credentials`.

Fields returned : `{ ok, reason, authFile?, secretVar?, mode?: "admin-credentials"|"user-credentials" }`.

### `vercel` - project linked to Vercel

`ok: true` if `.vercel/project.json` exists at the root and contains valid `projectId` + `orgId`.

Fields returned : `{ ok, reason, projectId?, orgId? }`.

### `github-repo` - project pushed to a GitHub remote

`ok: true` if `.git/config` contains a remote pointing to `github.com` (HTTPS or SSH). Parses the owner and the repo name.

Fields returned : `{ ok, reason, owner?, repo?, nameWithOwner? }`.

### `i18n` - next-intl installed

`ok: true` if `next-intl` is listed in the dependencies of `package.json` (root) or `apps/web/package.json`. Also tries to locate the `messages/` folder for the translations.

Fields returned : `{ ok, reason, packageJson?, messagesDir?: string|null }`.

### `stripe` - Stripe configured

`ok: true` if `STRIPE_SECRET_KEY` is present, non-placeholder, and starts with `sk_`. Automatically detects the mode (`test` or `live`).

Fields returned : `{ ok, reason, mode?: "test"|"live"|"unknown" }`.

### `storage` - Cloudflare R2 configured

`ok: true` if `R2_ACCOUNT_ID` (or `CLOUDFLARE_ACCOUNT_ID`), `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` are all present and non-placeholders.

Also detects the **R2 jurisdiction** from the format of `R2_ENDPOINT` :
- `https://<acc>.eu.r2.cloudflarestorage.com` → `jurisdiction: "eu"` (strict GDPR ✅)
- `https://<acc>.r2.cloudflarestorage.com` → `jurisdiction: "default"` (global jurisdiction, data potentially outside the EU)
- absent → `jurisdiction: "unknown"`

If the jurisdiction is not EU, also returns a `jurisdictionWarning` field (string) with a migration recommendation. `ok` stays `true` so as not to break existing setups - it is up to the consuming skill to surface the warning if relevant (e.g., in the Step 0 menu of `add-storage`).

Fields returned : `{ ok, reason, bucket?: string|null, publicUrl?: string|null, jurisdiction?: "eu"|"default"|"unknown", jurisdictionWarning?: string|null }`.

### `analytics` - Google Analytics (GA4) configured

`ok: true` if `NEXT_PUBLIC_GA_MEASUREMENT_ID` (the name `/add-analytics` writes; the older `NEXT_PUBLIC_GA_ID` is still accepted) is present, non-placeholder, and starts with `G-` (GA4 format).

Fields returned : `{ ok, reason, gaId? }`.

### `cloudflare` - Cloudflare API token configured AND valid

Checks that a Cloudflare API token is in place in the **system** env (not in `.env`, because it is a machine config shared across projects) AND that it is actually valid by querying `https://api.cloudflare.com/client/v4/user/tokens/verify`.

`ok: true` if and only if :
1. `CLOUDFLARE_API_TOKEN` OR `CF_API_TOKEN` is present (hypervibe convention = both point to the same token - `wrangler` reads `CLOUDFLARE_API_TOKEN`, the `curl` REST API calls can use either name)
2. The value is not a placeholder
3. The Cloudflare API returns `{ success: true, result: { status: "active" } }` for this token

If the check fails, the `reason` includes a suggestion : `- run /start to configure`. To be used before any Cloudflare operation (DNS via curl API, Workers via wrangler, Email Routing via curl, R2 via wrangler or curl...).

Fields returned : `{ ok, reason, varName? }`.

## Typical usage

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" db email)
# Parse with node -e (jq is not installed on the target machine)
db_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).db.ok)")
email_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).email.ok)")
email_provider=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).email.provider || 'none')")
```

## Rules

- **Always** use this helper when a skill's next step depends on a dependency being real (never `grep DATABASE_URL .env` inline - T3 placeholders systematically cause false positives).
- If a check returns `ok: false`, relay the `reason` to the user in plain language (translate from technical to non-tech - ex: *"DATABASE_URL points to localhost"* → *"your database points to your own computer, you need one reachable from the internet"*). Then offer to invoke the corresponding `add-*` skill via a natural-language prompt.
- Exit code is always 0 - the script never fails just because a check is negative. Only a truly malformed invocation (unknown flag) exits non-zero.

## Extending

To add a new check (e.g., `auth`, `vercel-linked`, `github-repo`), add a function in `scripts/check-deps.mjs` and wire it into the dispatch switch. Document the new check here in the "Supported checks" section. Keep heuristics encapsulated - never require callers to reimplement them.
