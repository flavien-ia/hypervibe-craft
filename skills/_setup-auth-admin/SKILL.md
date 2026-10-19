---
name: _setup-auth-admin
description: Internal helper - sets up NextAuth in admin-credentials mode (fixed login via env vars, no DB, no OAuth). Invoked by add-auth when the user chose the "admin-only interface" option. Installs NextAuth core, configures the CredentialsProvider with a single hardcoded admin, generates dev + prod password hashes, adds rate limiting on login, and pushes env vars. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Setup Auth - Admin-credentials mode

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Installs NextAuth in **admin mode**: a single admin account whose credentials live in the env vars (no DB). Invoked by `add-auth` when the user chose "Just a protected admin interface".

The deterministic code (install, AUTH_SECRET generation, dev+prod hashes, scaffold `auth.ts` / `password.ts` / API route, scaffold pages `/admin/signin` + `/admin` (protected route group), push env vars) lives in `scripts/setup-auth-admin.mjs`. This SKILL only handles the pre-flight (passed by `add-auth`), the script invocation, and the post-script communication (where the prod password's file is, never the password itself + CLAUDE.md).

**Input variables** (passed by `add-auth`): `WEB_DIR`, `IS_MONOREPO`, `PROJECT_NAME`.

⚠️ **Fresh install only** - the script refuses if `src/server/auth.ts` already exists. The "add admin on top of existing users-credentials" case is driven by Claude from `add-auth` Step 0, NOT by this skill.

---

## Step 1 - Run the script

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-auth-admin.mjs" \
  --name "<PROJECT_NAME>" \
  --web-dir "<WEB_DIR>"
```

The script chains 9 sub-steps: preflight, install next-auth@beta, AUTH_SECRET generation, dev hash (`Admin1234!`) + prod generation (24 alphanumeric chars) + hash, write `src/lib/password.ts`, write `src/server/auth.ts` (marker `// hypervibe:auth-modes admin`), write API route with rate limiting, write admin pages (`src/app/admin/signin/page.tsx` + `src/app/admin/(protected)/{layout,page}.tsx` - route group that isolates the gate from the signin to avoid the redirect loop), push env vars (AUTH_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH_DEV, ADMIN_PASSWORD_HASH_PROD, target=all).

### During execution

The script prints live:
- `▸ <step>` when it starts each sub-step
- `✅ <result>` at the end
- `⚠️ <warning>` (notably if `src/lib/rate-limit.ts` is absent - bootstrap is supposed to create it; the warning is non-blocking but the TS build will fail as long as `rate-limit.ts` does not exist)
- At the end, a structured **handoff banner**
- On the last line on success, a parseable JSON object:
  ```json
  {"success":true,"authMode":"admin","credentialsFile":"<path>","envVars":["AUTH_SECRET","ADMIN_USERNAME","ADMIN_PASSWORD_HASH_DEV","ADMIN_PASSWORD_HASH_PROD"]}
  ```

The production password is **never** in this output, and never goes through the conversation: the script writes it, with the identifier and the sign-in page, in a file of the person's downloads folder (`credentialsFile`), and only its hash goes to the project. Never open, read or display that file: it is the person's.

### On success

Mark the step ✅, capture `credentialsFile` from the JSON, and move on to Step 2.

### On failure

1. Read the error just above the handoff banner.
2. Identify the failed step (`❌ Failed at: <step>`). The name maps 1:1 to a function in the script - open `setup-auth-admin.mjs` and look at the function.
3. Diagnose:
   - `preflight` failed → usually `src/server/auth.ts` already exists (re-config), or one of the pages `src/app/admin/signin/page.tsx` / `src/app/admin/(protected)/{layout,page}.tsx` already exists → go back to the Step 0 menu of `add-auth`. Or `package.json` missing / no Next.js.
   - `installNextAuth` failed → pnpm / network error → retry manually.
   - `hashPasswords` failed → often `hash-password.mjs` not found (sibling script absent) or Node too old. Diagnose with `node "${CLAUDE_SKILL_DIR}/../../scripts/hash-password.mjs" --help`.
   - `writeAuthTs` / `writePasswordTs` / `writeApiRoute` / `writeAdminPages` failed → filesystem permission (rare) or missing template.
   - `pushEnvVars` failed → all the code is in place, only the env vars did not land → run the command the error message gives: it pushes them again from `.env` without showing them. Their values are in no output, so never look for them there.
4. Continue the remaining steps manually.

---

## Step 2 - Update CLAUDE.md

Invoke `_update-claude-md` with:

- `stack`: `- **Auth**: NextAuth v5 (admin mode - single account via env vars)`
- `conventions`:
  - `- Auth admin: \`await isAdmin()\` from \`~/server/auth\` to check access. Session via \`await auth()\`.`
  - `- **Admin structure**: route group \`src/app/admin/(protected)/\` which contains the pages to protect (gate in its \`layout.tsx\` via \`if (!await isAdmin()) redirect("/admin/signin?callbackUrl=/admin")\`). \`src/app/admin/signin/page.tsx\` stays outside the group to avoid the redirect loop. Any new admin page goes in \`(protected)/\`. NEVER add a gate in \`app/admin/layout.tsx\` (this layout also wraps signin → infinite loop).`
- `custom`:
  - heading: `## Changing the admin password in production`
  - body:
    ```
    Admin auth uses `ADMIN_PASSWORD_HASH_DEV` (dev) and `ADMIN_PASSWORD_HASH_PROD` (prod), selected via NODE_ENV.
    To change it, the user types the new password in the masked window, never in the conversation: `node "<path>/scripts/vault/launch.mjs" collect-env --keys "NEW_ADMIN_PASSWORD:secret" --project-dir <app folder> --file .env.admin-password`; then hash it and push the hash in one go: `H=$(node "<path>/scripts/env-value.mjs" --project-dir <app folder> --file .env.admin-password NEW_ADMIN_PASSWORD | node "<path>/scripts/hash-password.mjs") && [ -n "$H" ] && printf 'ADMIN_PASSWORD_HASH_PROD=%s\n' "$H" | node "<path>/scripts/push-env-vars.mjs" --stdin`, and delete `.env.admin-password`.
    To generate a new random password instead: `node "<path>/scripts/admin-password.mjs" rotate --project-dir <app folder>`. It writes the new password in a file of the user's downloads folder and pushes only its hash: the password never appears in the conversation, and it works once the site is deployed again.
    ```
- `env-vars`:
  - `- \`AUTH_SECRET\` - NextAuth session secret`
  - `- \`ADMIN_USERNAME\` - admin login name (default: admin)`
  - `- \`ADMIN_PASSWORD_HASH_DEV\` - scrypt hash of the dev admin password (Admin1234!)`
  - `- \`ADMIN_PASSWORD_HASH_PROD\` - scrypt hash of the prod admin password (unique per project)`

---

## Step 3 - Summary for the user

Display exactly (replacing `<CREDENTIALS_FILE>` with the `credentialsFile` path of Step 1):

> ## ✅ Your admin interface is ready
>
> You are the only one who can sign in. Here are your credentials:
>
> **Locally (on your computer during development)**:
> - Username: `admin`
> - Password: `Admin1234!`
>
> **In production (on your live site)**: the username and the password are in a file I have put in your downloads folder, so that the password never appears in our conversation:
> `<CREDENTIALS_FILE>`
>
> ⚠️ **Open it, save the password in your password manager, then delete the file.** It is stored nowhere else, only a hash (an unreadable version) is kept in the project. If you lose it, ask me for a new one.
>
> **How to use it**: go to `/admin/signin` and sign in. You will be redirected to `/admin`, your admin space (which for now just contains a welcome message and a sign-out button). Ask me whenever you want *"add an admin page to manage X"* - I will create the pages directly in the right folder (`src/app/admin/(protected)/...`) with the protection already in place.

If the script reported warnings (e.g. `rate-limit.ts` absent), mention it here.

**Never ask for the production password, never read the file**: if the person pastes the password into the conversation anyway, say so plainly and offer a new one (`admin-password.mjs rotate`), since a password written in a conversation is kept in its history.
