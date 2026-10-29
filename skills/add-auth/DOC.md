# /add-auth

Adds **sign-in / signup** to your app. A single question decides between two modes for you: an admin login reserved for you, or a complete user accounts system.

## When to use it

- You want a private area on your site that only you (or a few people) can see
- Your app has users who need to create an account, sign in, and have their own space
- You want to add sign-in via Google or GitHub (you will run `/add-auth` first, then `/add-google-auth` or `/add-github-auth`)

## How it works

1. **Check**: Hypervibe detects whether authentication is already in place on the project. If so, you get a small menu to evolve it (add Google, change the admin password, add "forgot password", etc.).

2. **Main question** (unless already chosen by `/bootstrap`): Hypervibe asks what type of authentication you want:
  - **Admin mode**: a single fixed login (yours), with a password stored in the environment variables. Perfect for a backoffice, a private dashboard, a site admin.
  - **Users mode**: a real system with signup, sign-in, account page, account deletion. Suitable when you have external users who need their own space.

3. **Automatic setup**:
  - **Admin mode**: Hypervibe generates a secure password, hashes it, pushes it into your Vercel + local variables. The plaintext password is shown to you **only once**: save it in your password manager.
  - **Users mode**: Hypervibe adds the necessary tables to the database (users, sessions, accounts, verifications), creates the `/signin` / `/signup` / `/account` pages, the tRPC API for signup/sign-in, and the full NextAuth integration.

4. **Optional follow-up**: Hypervibe then offers to add Google or GitHub OAuth as a complement (never as a replacement, email/password remains the baseline).

## What it creates for you

**In admin mode**:
- A `src/server/auth.ts` file that handles a fixed login
- The `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH_DEV`, `ADMIN_PASSWORD_HASH_PROD` variables in `.env` + Vercel
- An `isAdmin()` function you can use to protect pages
- Password shown once for you

**In users mode**:
- All the NextAuth tables in the database (users, sessions, accounts, verification_tokens, password_reset_tokens)
- `/signin`, `/signup`, `/account` pages, and optionally `/forgot-password` + `/reset-password`
- tRPC API for secure signup and sign-in (scrypt hashing, rate limiting, anti-brute-force protection)
- Site layout updated with a user menu (sign-in/sign-out)

## Prerequisites

- The project must be in Next.js
- Users mode: requires a database, `/add-db` must have been run first (Hypervibe offers it to you if missing)
- Users mode with forgot password: also requires `/add-email` to be configured

## Tips

{{callout:tip|You can have both modes at the same time}}
If you have already chosen a mode and want to add the other one later, re-run `/add-auth`: a menu offers to add the second mode without breaking the existing one. The admin login and the users signup can coexist.
{{/callout}}

{{callout:warning|The admin password is shown only once}}
In admin mode, the plaintext password is shown to you **only once** at the end of the setup. Save it in your password manager immediately, it is not stored anywhere in plaintext on disk (only the hash exists).
{{/callout}}
