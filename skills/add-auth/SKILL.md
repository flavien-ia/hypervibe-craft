---
name: add-auth
description: Add NextAuth (Auth.js) authentication to an existing T3 project. One structured question decides the mode - admin (fixed login in env vars) or users (DB-backed email+password with signup, signin, account page, delete account, and optional forgot-password if email is configured). OAuth providers (Google, GitHub) are offered as optional add-ons AFTER the user-credentials baseline, never as a replacement. This skill is an orchestrator - it delegates the actual implementation to `_setup-auth-admin` or `_setup-auth-users` depending on the chosen mode.
argument-hint: "[mode: admin | users]"
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Add Auth - Orchestrator

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Lightweight orchestrator. Detects the current state via the `// hypervibe:auth-modes <list>` marker at the top of `src/server/auth.ts`, proposes a contextual menu based on what is already installed, and delegates to the right sub-skill (`_setup-auth-admin` / `_setup-auth-users`) for fresh installs. For UPGRADES (adding the second mode when one already exists), Claude drives the contextual editing of `auth.ts` itself - see the UPGRADE Section.

---

## Step 0 - Detect the current state and contextual menu

Read the marker in `src/server/auth.ts`:

```bash
if [ -f "<WEB_DIR>/src/server/auth.ts" ]; then
  grep -E "^// hypervibe:auth-modes" "<WEB_DIR>/src/server/auth.ts" | head -1
fi
```

Parse:
- No file OR no marker → `existing_modes = []`
- `// hypervibe:auth-modes admin` → `["admin"]`
- `// hypervibe:auth-modes users` → `["users"]`
- `// hypervibe:auth-modes admin, users` → `["admin","users"]`
- `auth.ts` present WITHOUT marker → `["unknown"]`

### Case `[]` → fresh install

No menu. Skip to **Step 1**.

### Case `["admin"]` → menu

> ## 🔐 The admin login is already in place
> 1. **Also add a signup system for my users** (both coexist)
> 2. **Change the admin password**
> 3. **Start over from scratch** (deletes auth.ts/password.ts/route.ts + AUTH_SECRET/ADMIN_* first)
> 4. **Something else**

| Choice | Action |
|---|---|
| 1 | UPGRADE Section - Case A. |
| 2 | `node "${CLAUDE_SKILL_DIR}/../../scripts/admin-password.mjs" rotate --project-dir "<WEB_DIR>"` → a new password, written in a file of the user's downloads folder, only its hash pushed (`ADMIN_PASSWORD_HASH_PROD`). Give the user the file's path (`file`), never the password; it works once the site is deployed again. |
| 3 | List the files to delete manually, then ask to re-run. |
| 4 | Ask for clarification. |

### Case `["users"]` → menu

> ## 🔐 User signup is already in place
> 1. **Also add a separate admin login**
> 2. **Add a Google sign-in**
> 3. **Add a GitHub sign-in**
> 4. **Enable password reset** (forgot-password - only if email is configured)
> 5. **Start over from scratch**
> 6. **Something else**

| Choice | Action |
|---|---|
| 1 | UPGRADE Section - Case B. |
| 2 | Invoke `add-google-auth`. |
| 3 | Invoke `add-github-auth`. |
| 4 | `_check-deps email` ; if OK, UPGRADE Section - Case C. Otherwise point to `/add-email`. |
| 5 | List the files to delete (auth.ts, password.ts, auth router, /signin /signup /dashboard /account pages, NextAuth tables in the DB). |
| 6 | Ask for clarification. |

### Case `["admin","users"]` → menu

> ## 🔐 You have BOTH modes (admin + users)
> 1. **Change the admin password** (same as admin case choice 2)
> 2. **Add Google** (same as users case choice 2)
> 3. **Add GitHub** (same as users case choice 3)
> 4. **Enable password reset** (same as users case choice 4)
> 5. **Uninstall a mode** - destructive, ask for explicit confirmation and guide manually
> 6. **Something else**

### Case `["unknown"]` → pre-existing auth not recognized

> ⚠️ You already have a `src/server/auth.ts` but I do not recognize its origin (no hypervibe marker). Three options: (1) you tell me what you want to do and I guide you manually; (2) you confirm that I can overwrite and start over; (3) we stop.

---

## Step 1 - Choose the mode (fresh install only)

If called from `/bootstrap`, the mode is already chosen → skip to Step 2. If standalone with an explicit arg (`admin` / `users`), use it. Otherwise AskUserQuestion:

> **What type of authentication does your project need?**
> - **Just a protected admin interface** (only you log in - content management, site admin)
> - **A system for your users** (visitors create an account and sign in)

→ `auth_mode = admin-credentials` or `user-credentials`.

**Why is email+pwd the baseline when there are users?** It is the only 0-config system that works everywhere. OAuth (Google, GitHub) is a convenience added on top, never a replacement.

---

## Step 2 - Prerequisites (fresh install only)

Invoke `_detect-project-root` → `PROJECT_NAME`, `WEB_DIR`, `IS_MONOREPO`, `IS_NEXTJS`. Abort if not Next.js.

If `auth_mode = user-credentials`: `_check-deps db` → if `db_ok = false`, propose `/add-db` then re-check.

---

## Step 3 - Delegate to the sub-skill (fresh install)

- `auth_mode = admin-credentials` → invoke `_setup-auth-admin` with `WEB_DIR`, `IS_MONOREPO`, `PROJECT_NAME`.
- `auth_mode = user-credentials` → invoke `_setup-auth-users`.

The sub-skill handles the script + UserMenu (users mode) + CLAUDE.md + summary. When it hands control back, you are done - the orchestrator has nothing to add.

---

## UPGRADE Section - Add a mode (Claude drives, no script)

No script - the risk of corrupting the existing `auth.ts` is too high. Claude reads the existing file, reads the reference templates in `${CLAUDE_SKILL_DIR}/../../templates/auth/`, and patches contextually. Check `pnpm tsc --noEmit` at the end to validate.

> **Template paths in this section are relative to the PLUGIN ROOT, not to this skill's folder.** Always resolve them through `${CLAUDE_SKILL_DIR}/../../templates/…`, exactly as written below. Dropping that prefix makes the path resolve inside `skills/add-auth/`, where no `templates/` folder exists, and the read fails with "No such file or directory".

### Case A - Add `users` on top of an existing `admin`

Reference templates: `${CLAUDE_SKILL_DIR}/../../templates/auth/users/{auth.ts, password.ts, schema-additions.ts, schema-additions-reset-tokens.ts, auth-router*.ts, route.ts}`.

Steps (all driven by Claude):

1. `_check-deps db` (DB required) ; `_check-deps email` (optional for reset).
2. **Build the hybrid `auth.ts`**: marker → `// hypervibe:auth-modes admin, users`. Import `DrizzleAdapter`, schema tables, `eq`, `db`. Module augmentation `Session.user.id`. `authorize()`: admin path FIRST (check `email === ADMIN_USERNAME`, `getAdminPasswordHash`), users path as FALLBACK (`db.query.users.findFirst` → `verifyPassword`). Keep `isAdmin()`. Add jwt/session callbacks.
3. **Extend `password.ts`**: add `hashPassword()` (from the users template). Keep `getAdminPasswordHash` + `verifyPassword`.
4. **Patch schema.ts** - like `setup-auth-users.mjs` does in the `patchSchema` step: add the missing imports (`text, integer, primaryKey, index, timestamp` pg-core, `sql` drizzle-orm, `AdapterAccount` type next-auth/adapters), append the 4 NextAuth tables (+ `password_reset_tokens` if email_ok).
5. **`pnpm db:push`**, after `node "${CLAUDE_SKILL_DIR}/../../scripts/neon/schema-drift.mjs"` from `<WEB_DIR>` (read-only): `--force` only on exit `0`; on exit `3` stop and show the user what the push would delete.
6. **Patch trpc.ts** - add `protectedProcedure` (and `rateLimitedProcedure` if missing). Take inspiration from the `setup-auth-users.mjs` `addProtectedProcedure` step.
7. **Create `src/server/api/routers/auth.ts`** from the right template (`auth-router.ts` or `auth-router-with-reset-{provider}.ts`).
8. **Register in `root.ts`**: import + `auth: authRouter,`.
9. **Create `src/app/api/auth/[...nextauth]/route.ts`** from the template (admin and users are identical).
10. **Create the 4 users pages**: signin (with `FORGOT_PASSWORD_LINK` substituted), signup, dashboard, account (+ forgot/reset if email_ok).
11. **Patch `layout.tsx`** for the user-menu (best-effort, like `_setup-auth-users` Step 2).
12. **Update CLAUDE.md** - add the users sections in addition to the admin sections already present.
13. **`pnpm tsc --noEmit`** - check that it compiles.
14. **Summary**: "User signup has been added on top of the admin login. The admin login keeps working and has priority in the authorize callback."

### Case B - Add `admin` on top of an existing `users`

Reference templates: `${CLAUDE_SKILL_DIR}/../../templates/auth/admin/{auth.ts, password.ts}` (for the snippets to integrate).

1. **Hash the DEV password and push it**: `H=$(printf '%s' "Admin1234!" | node "<path>/hash-password.mjs") && [ -n "$H" ] && printf 'ADMIN_USERNAME=admin\nADMIN_PASSWORD_HASH_DEV=%s\n' "$H" | node "<path>/push-env-vars.mjs" --target=all --stdin`.
2. **The PROD password, never in the conversation**: `node "<path>/admin-password.mjs" rotate --project-dir <app folder>`. It generates it, writes it with the identifier and the sign-in page in a file of the user's downloads folder, and pushes only `ADMIN_PASSWORD_HASH_PROD`. Its JSON gives the file's path (`file`), never the password: never read that file. Never `hash-password.mjs --generate` here: it prints the password where you read it.
3. **Extend `password.ts`** - add `getAdminPasswordHash()` from the admin template. Keep `hashPassword` + `verifyPassword`.
4. **Patch `auth.ts`**: marker → `// hypervibe:auth-modes admin, users`. Import `getAdminPasswordHash` from `~/lib/password`. In `authorize()`, BEFORE the DB lookup, add the admin path:
   ```ts
   if (process.env.ADMIN_USERNAME && email === process.env.ADMIN_USERNAME) {
     const hash = getAdminPasswordHash();
     if (await verifyPassword(password, hash)) return { id: "admin", email, name: "Admin" };
     return null;
   }
   ```
   Add `export async function isAdmin() { return (await auth())?.user?.id === "admin"; }`.
5. **Update CLAUDE.md** - add the admin section in addition to the users sections.
6. **`pnpm tsc --noEmit`** - check.
7. **Summary**: give the path of the file that holds the PROD credentials (open it, save the password in a password manager, delete the file), never the password; explain the coexistence in authorize.

### Case C - Enable password reset on an existing `users` (email already OK)

1. **Append `password_reset_tokens`** to schema.ts from `${CLAUDE_SKILL_DIR}/../../templates/auth/users/schema-additions-reset-tokens.ts`.
2. **`pnpm db:push`**.
3. **Replace `src/server/api/routers/auth.ts`** with the `auth-router-with-reset-{resend,brevo}.ts` template (depending on the detected provider).
4. **Create `/forgot-password/page.tsx` and `/reset-password/page.tsx`** from the templates.
5. **Patch signin.tsx**: replace `<span></span>` (placeholder for `FORGOT_PASSWORD_LINK`) with the `<Link href="/forgot-password" ...>Forgot password?</Link>`.
6. **Update CLAUDE.md** - add the reset mention.
7. **`pnpm tsc --noEmit`** + summary.
