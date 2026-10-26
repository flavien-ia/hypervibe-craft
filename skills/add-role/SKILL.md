---
name: add-role
description: "Adds a user roles system (member, editor, moderator...) to the project. Creates the mechanics (hasRole/getRoles helpers, roles[] column on the users table, admin management page). Prerequisite: /add-auth in users mode. If admin auth is missing, the skill sets it up beforehand automatically to protect the administration page."
argument-hint: "[list,of,roles]"
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Add Role : Orchestrator

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Lightweight orchestrator for the user roles system. Detects the current state via the `// hypervibe:roles <list>` marker at the top of `src/lib/roles.ts`, offers a context-aware menu based on what is already installed, and delegates to the `setup-role.mjs` script for fresh installs. For UPGRADES (adding / removing / renaming a role), Claude drives the contextual editing of `schema.ts` + `roles.ts` itself.

---

## Step 0 : Detect the current state and context-aware menu

Read the marker in `src/lib/roles.ts` :

```bash
if [ -f "<WEB_DIR>/src/lib/roles.ts" ]; then
  grep -E "^// hypervibe:roles" "<WEB_DIR>/src/lib/roles.ts" | head -1
fi
```

Parse :
- No file → `existing_roles = []` (fresh install)
- `// hypervibe:roles member, editor, moderator` → `["member", "editor", "moderator"]`

### Case `[]` → fresh install

No menu. Skip to **Step 1**.

### Non-empty case → menu

> ## 🎭 Your user roles are already in place
> Current roles : `member, editor, moderator` (example)
> 1. **Add a new role**
> 2. **Remove a role** (with reassignment of the users who have it)
> 3. **Rename a role**
> 4. **Change the default role for new sign-ups**
> 5. **Regenerate the administration page** `/admin/users`
> 6. **Start over from scratch** (destructive)
> 7. **Something else**

| Choice | Action |
|---|---|
| 1 | UPGRADE section : Case A (adding a role). |
| 2 | UPGRADE section : Case B (removal + reassignment). |
| 3 | UPGRADE section : Case C (renaming). |
| 4 | UPGRADE section : Case D (changing the default). |
| 5 | Retrieve the current list from `roles.ts`, rewrite the page from the `role/pages/users-page.tsx` and `role/pages/users-table.tsx` templates (the page calls `requireAdmin()` first; `src/server/require-admin.ts` from `auth/admin/require-admin.ts` if the project lacks it). |
| 6 | List the files / migrations to remove manually (roles.ts, admin-users router, admin page, roles column in the schema, pgEnum type) then ask to re-run. Refuse to do it automatically. |
| 7 | Ask for clarification. |

---

## Step 1 : Prerequisites (fresh install only)

1. **Detect project root** : invoke `_detect-project-root` → `WEB_DIR`, `IS_MONOREPO`, `PROJECT_NAME`, `IS_NEXTJS`. Abort if not Next.js.

2. **DB required** : invoke `_check-deps db`. If `db_ok = false`, suggest `/add-db` then re-check.

3. **Users auth required** : read `src/server/auth.ts` and look for the `// hypervibe:auth-modes` marker.
   - Absent or does not contain `users` → suggest `/add-auth` (users mode) to the user. Once it has run, come back to `/add-role`.

4. **Admin auth required for the administration page** : read the same marker.
   - If `admin` is absent : tell the user that you are going to add the admin login first to protect the management page (DO NOT ask for confirmation, this is the normal flow). Run `/add-auth` in admin mode (orchestration). Once done, automatically come back to `/add-role` without asking anything.
   - If the user explicitly declined admin auth (e.g. "no, I'll manage without an admin page") : pass `createAdminPage = false` to the script.

---

## Step 2 : Discovery (3 questions)

### Q1 : Which roles do you want to set up ?

Offer a default suggestion **tailored to the project** by re-reading the `CLAUDE.md` and/or the `cahier-des-charges.md` if present :

- **Content / blog / editorial** project → `lecteur, contributeur, moderateur`
- **Marketplace** → `acheteur, vendeur, moderateur`
- **Paid SaaS** (Stripe detected) → `free, pro, enterprise`
- **Support / helpdesk** → `client, agent, superviseur`
- **Community / forum** → `membre, contributeur, moderateur`
- **Generic default** → `membre, editeur, moderateur`

Present the suggestion via `askUserQuestion` :

> Which roles do you want for your users ?
> - Accept the suggestion : `membre, editeur, moderateur`
> - Customize (you give your list in free-form language)

If customizing, ask for the list. Normalize :
- Lowercase + kebab-case ASCII for storage (`éditeur` → `editeur`)
- Keep the original label (with capitals, accents) for `ROLE_LABELS`, which is used by the UI

**Safeguards (mandatory, explicit refusal)** :
- If the user proposes `admin`, `administrator`, `root`, `superuser`, `superadmin`, refuse firmly :

> The name `admin` is reserved for your app's global admin login (the one that manages the whole site, configured by /add-auth). For a DB role with equivalent power, use `moderateur`, `manager`, or `superviseur`. Which name do you prefer for this role ?

- The `setup-role.mjs` script re-validates on the code side and also refuses. Do not bypass it.

### Q2 : What is the default role when someone signs up ?

Default suggestion : the first role in the list (the most restricted). Present via `askUserQuestion` or free conversation.

### Q3 : Migration of existing users (skip if DB empty)

Run a small check : `psql` via Drizzle or a throwaway tsx script to count the rows in `user` :

```bash
cd <WEB_DIR>
npx tsx -e "import { db } from '~/server/db'; import { users } from '~/server/db/schema'; const c = await db.select().from(users); console.log(c.length);"
```

If 0 → skip Q3, `backfillRole = defaultRole`.

Otherwise, ask :

> I detected N users already signed up. Which role do you want to assign to them ?
> - The default role (`<defaultRole>`)
> - Another role from the list
> - Decide case by case (rare, manual via the admin page after install)

---

## Step 3 : Run the script

Build the config file and run `setup-role.mjs` :

```bash
cd <WEB_DIR>
CONFIG="${TMPDIR:-/tmp}/add-role-config-$(date +%s).json"
cat > "$CONFIG" <<'EOF'
{
  "webDir": "<WEB_DIR>",
  "roles": ["membre", "editeur", "moderateur"],
  "roleLabels": {
    "membre": "Membre",
    "editeur": "Éditeur",
    "moderateur": "Modérateur"
  },
  "defaultRole": "membre",
  "backfillRole": "membre",
  "createAdminPage": true
}
EOF
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-role.mjs" --config "$CONFIG"
rm -f "$CONFIG"
```

Tell the user :

> ↳ I'm creating the roles system : enum in the database, roles[] column on the user table, helpers, admin page if you asked for it.

The script prints its own `▸ <step>` as it goes ; relay it in natural language without quoting the internal names. Examples :

- `▸ Patching src/server/db/schema.ts` → `↳ I'm adding the new "role" type to the database.`
- `▸ Pushing schema with drizzle-kit` → `↳ I'm applying the change to your database.`
- `▸ Backfilling existing users with role "membre"` → `↳ I'm assigning the "membre" role to your existing users.`
- `▸ Writing src/lib/roles.ts` → `↳ I'm placing the role-checking helpers in the project.`
- `▸ Patching src/server/auth.ts (expose roles in JWT + session)` → `↳ I'm wiring the roles into the login system, so they are available everywhere in your app.`
- `▸ Writing src/app/admin/(protected)/users/page.tsx` → `↳ I'm creating the user management page in your admin (it checks that it is you before showing anything).`
- `▸ Running pnpm tsc --noEmit` → `↳ I'm checking that everything compiles correctly.`

At the end, the script prints a JSON (last line of stdout). Parse it to confirm success :

```json
{"success":true,"roles":["membre","editeur","moderateur"],"defaultRole":"membre","backfillRole":"membre","adminPage":true}
```

### If the script fails

1. Read `❌ Failed at: <step>` in the handoff banner.
2. Map it to the script's function (1:1, same name).
3. Diagnose based on the error (see common cases below).
4. Do not re-run blindly : resolve the cause first.

**Common cases** :
- `preflight` failed → often `src/lib/roles.ts` already exists (re-config) or a missing prerequisite clearly reported in the message.
- `patchSchema` failed → the schema has an unexpected shape. Inspect and patch by hand.
- `pushSchema` failed with **"Schema patched on disk but NOT pushed"** → the users table (or another) holds data that `schema.ts` does not declare, and the push would have deleted it (list printed just above). Show it to the user in plain words; declare those columns in `schema.ts` or get an explicit go, then `cd <WEB_DIR> && npx drizzle-kit push` (never `--force`).
- `pushSchema` failed otherwise → DB unreachable or `drizzle-kit` crashes. Check `DATABASE_URL`, re-run.
- `patchAuthTs` failed → the project's auth.ts was manually modified and no longer matches the pattern. Patch the callbacks by hand, taking inspiration from the script's `replace()` calls.

---

## Step 4 : Post-script communication

### CLAUDE.md update

Invoke `_update-claude-md` with two entries in the `conventions` section :

```
- User roles : <list>. Default for new sign-ups : <default>. Helpers `hasRole(session, [...])` and `getRoles(session)` in `~/lib/roles`. The `admin` role is RESERVED for admin credentials (env var, never in the DB) : never add it to the enum.
- To gate a tRPC procedure by role : use `protectedProcedure` then check `hasRole(ctx.session, [...])` at the start, otherwise `throw new TRPCError({ code: "UNAUTHORIZED" })`. To gate a server-component page : check `hasRole(await auth(), [...])` on its first lines, before reading any data, otherwise `redirect("/")`. A check in a shared `layout.tsx` is not enough : the layout's redirect carries the page's content.
```

### Patch admin sidebar (if the script warned about it)

If the handoff banner contains a `Sidebar at <path> doesn't link to /admin/users` or `No admin sidebar file found` warning, open the project's sidebar file (look for `admin-sidebar`, `sidebar`, or the nav bar in the admin/(protected) layout) and manually add a link :

```tsx
<Link href="/admin/users">Utilisateurs</Link>
```

with a consistent style (look at the other sidebar links to copy the Tailwind pattern).

### Final recap to the user

Show a clear, jargon-free recap :

> 🎉 **Roles system set up.**
>
> **Available roles** : `<list>`. New sign-ups get the `<default>` role by default. Your existing users were set to `<backfillRole>`.
>
> **To manage roles** : log in as admin and go to **`/admin/users`**. There you'll find the list of all your accounts with a dropdown to change their role. Tick "Multi-role mode" if a user needs to have several.
>
> **To protect a page by role** : just tell me *"protect page X for moderators only"* and I'll take care of it.
>
> **To add / remove / rename a role later** : re-run `/add-role` and choose from the menu.

---

## UPGRADE section : Modifying existing roles (Claude drives, no script)

No script : the risk of corrupting `roles.ts` + `schema.ts` + the references in the code is too high. Claude reads the existing setup, applies the changes by hand, and checks `pnpm tsc --noEmit` at the end.

### Case A : Add a new role

1. Ask for the name of the new role. Validate (kebab-case ASCII, no `admin`/synonyms).
2. Ask for the display label.
3. **Patch `src/server/db/schema.ts`** : add the value to `userRoleEnum`. Postgres : adding a value to an existing enum requires `ALTER TYPE user_role ADD VALUE 'nouveau';`. Run via tsx :
   ```ts
   import { sql } from "drizzle-orm";
   import { db } from "~/server/db";
   await db.execute(sql\`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'nouveau'\`);
   ```
4. **Patch `src/lib/roles.ts`** : add the role to `ROLES` (tuple as const) and to `ROLE_LABELS`. Update the `// hypervibe:roles ...` marker.
5. **CLAUDE.md** : invoke `_update-claude-md` to update the `User roles :` line with the new list.
6. `pnpm tsc --noEmit` + recap to the user.

### Case B : Remove a role (destructive, forced reassignment)

1. Ask which role to remove. Prevent removal of `defaultRole` (unless the user picks a new one right after).
2. Count the users who have this role. Ask which role to reassign them to (suggest the default role).
3. **UPDATE the users** : remove the role from their array, add the replacement role if necessary. Via tsx :
   ```ts
   await db.execute(sql\`
     UPDATE "user"
     SET roles = array_remove(roles, 'supprime')
     WHERE 'supprime' = ANY(roles);
   \`);
   // If reassignment is necessary (users who had ONLY this role) :
   await db.execute(sql\`
     UPDATE "user"
     SET roles = array_append(roles, 'replacement')
     WHERE cardinality(roles) = 0;
   \`);
   ```
4. **Postgres limitation** : a Postgres enum **cannot** drop a value without recreating the whole enum. Two options :
   - Recreate the enum (complex, downtime on this column).
   - Keep the value in the enum but remove it from `ROLES` on the code side. The Postgres value remains but no code selects it.

   **Recommendation** : option 2 (keep the orphaned Postgres value). Document it in CLAUDE.md.
5. **Patch `src/lib/roles.ts`** : remove from `ROLES` and `ROLE_LABELS`. Update the marker.
6. **Patch all references to the removed role in the code** (`hasRole(_, ["supprime"])` etc.). Grep and fix.
7. `pnpm tsc --noEmit` + recap.

### Case C : Rename a role

1. Ask old name → new name.
2. **Postgres** : `ALTER TYPE user_role RENAME VALUE 'ancien' TO 'nouveau';`. Via tsx.
3. **Patch `src/lib/roles.ts`** : tuple + labels + marker.
4. **Patch all references in the code** : `hasRole(_, ["ancien"])`, etc. Grep and fix.
5. CLAUDE.md + tsc check + recap.

### Case D : Change the default role for new sign-ups

1. Ask for the new default (from the current list).
2. **Patch `src/lib/roles.ts`** : `DEFAULT_ROLE`.
3. **Patch `src/server/api/routers/auth.ts`** : the signup procedure uses `roles: ["<old>"]`. Replace it with `roles: ["<new>"]`.
4. **Patch `src/server/db/schema.ts`** : if the `roles` column has a `.default(sql\`'{<old>}'::user_role[]\`)`, change it. Optional : `pnpm db:push` so the Postgres default is up to date too.
5. CLAUDE.md + tsc check + recap.

---

## Important rules

- **i18n convention** : the `/admin/users` page (and all admin pages generated by this skill) **stays in French** regardless of the project's locale. No string extraction into `messages/`, no use of `useTranslations()`. Rationale : 1-user surface (the admin/owner), high string volume, near-zero translation ROI. Same convention as `mentions-legales`, `cgv`, and other admin pages of the plugin. If the user insists on translating their admin, do it manually without touching the template.
- **You do it, you don't have it done.** Everything goes through the script or your own edits. The user never types a command.
- **The anti-`admin` safeguard** is non-negotiable. Never accept `admin` in the roles list, even if the user insists. Explain why and offer an alternative.
- **Idempotence** : if the user re-runs `/add-role` after a success, the marker exists → UPGRADE menu. If the marker is partial/broken (`unknown` case), ask how to proceed.
- **`pnpm tsc --noEmit`** at the end of any modification (script or manual upgrade). If it fails, diagnose and fix before finalizing.
- **Non-technical audience** : all recaps, questions, and error messages are in plain language, without unexplained jargon.
