# /add-role

Adds a **user roles system** to differentiate access rights in your app. Each user can have one or more roles (`membre`, `editeur`, `moderateur`, etc.), and certain pages or features can be reserved for them.

## When to use it

- Your users don't all have the same rights : some read, some publish, some moderate
- You want a **subscription** system with different tiers (`free`, `pro`, `enterprise`)
- You want an internal group with distinct permissions (`agent`, `superviseur`)
- You want an **administration page** to change each user's role from a table

## How it works

1. **Checks** : Hypervibe verifies that you do have a database and a user accounts system (`/add-auth` in users mode). If admin auth is missing, it sets it up beforehand automatically so the management page is protected.

2. **Choosing the roles** : Hypervibe offers a list tailored to your project (for example `membre, editeur, moderateur` for an editorial site, `acheteur, vendeur, moderateur` for a marketplace). You accept it or give your own.

3. **Default role** : Hypervibe asks which role each new visitor who signs up will receive (typically the most restricted, for example `membre`).

4. **Migration of existing users** (if there are any) : Hypervibe asks which role to assign to your already-registered users.

5. **Automatic setup** :
  - Adding the "role" type to the database (Postgres `enum`)
  - Adding the `roles` column to the users table
  - Creating the `hasRole`, `getRoles` helpers reusable everywhere in your code
  - Wiring the roles into the login system (NextAuth) : each session knows the user's roles
  - The signup procedure automatically assigns the default role to new accounts
  - Creating the `/admin/users` page : a table of all your users with a dropdown menu per row to change their role, plus a "Multi-role mode" option if some users have several at once

## What it creates for you

- A **Postgres `user_role` type** with your list of roles
- A **`roles`** column (array of roles) on the users table
- The **`src/lib/roles.ts`** file that exposes the helpers `hasRole(session, [...])`, `getRoles(session)`, and the list of French labels for the UI
- An **update to the login system** : roles are available in `session.user.roles` on both client and server
- An **admin page `/admin/users`** : list of accounts, search, filter by role, change dropdown (single or multi)
- A **secured tRPC procedure** to modify roles, accessible only to the global admin
- An **update to the project's `CLAUDE.md`** : the roles convention is documented so future changes follow the pattern

## Prerequisites

- The project must have `/add-auth` in **users** mode (user accounts in the database)
- The database must be wired up (`/add-db` has been run)
- If you want the management page (most of the time yes), `/add-auth` in admin mode will be run beforehand by Hypervibe if missing

## Tips

{{callout:tip|The `admin` role is deliberately reserved}}
The name `admin` is reserved for your app's global admin login (configured by `/add-auth` in admin mode, stored in an environment variable, not in the database). Hypervibe refuses to add it to the user roles list. For a DB role with equivalent power, use `moderateur`, `manager`, or `superviseur`. This guarantees there will never be any confusion between the two notions.
{{/callout}}

{{callout:tip|A single role at first, multi-role later if needed}}
By default the admin page offers a simple dropdown menu (a single role per user), enough in most cases. If you need a user to have several roles at once (for example `editeur` AND `moderateur`), tick "Multi-role mode" at the top of the page : the dropdown becomes a checkbox list. The underlying mechanics support both modes without any change of structure.
{{/callout}}

{{callout:info|Evolving your roles later}}
You can re-run `/add-role` at any time to add a new role, remove one, rename, or change the default role. Hypervibe detects the existing configuration and offers you a suitable menu. For destructive operations (removing a role), it always asks which other role to reassign the affected users to.
{{/callout}}

{{callout:info|To protect a page or an action by role}}
You don't have to handle the helpers yourself. Just tell Hypervibe : *"protect page X for moderators only"*, or *"only `pro` users can call this function"*. The pattern to follow is documented in the project's `CLAUDE.md`, so Claude applies it on its own for every new page you ask it for.
{{/callout}}
