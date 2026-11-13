---
name: _setup-2fa-users
description: Internal. Sets up optional per-user 2FA (TOTP) on a hypervibe user-accounts auth. Each user enables 2FA from their account page (scan a QR, confirm a code), with the secret + one-off backup codes stored per-user in the database. Login asks for the code after the password only for users who enabled it. Invoked by /add-2fa when the project is in users mode. Claude-piloted (no script) because the account page and signin flow are project-specific. Not meant to be invoked directly by users.
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Setup 2FA - Users mode (optional per user, in DB)

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Sets up **optional per-user** 2FA on a Hypervibe accounts-based auth. No deterministic script: the Account page and the login flow vary from one project to another, so Claude implements it contextually by following this guide. **Check the build (`pnpm tsc --noEmit` + `pnpm lint`) after each large block.**

**Input variables** (passed by `add-2fa`): `PROJECT_NAME`, `WEB_DIR`, `AUTH_APP`.

> ⚠️ **Sensitive auth flow + project-specific.** Implement block by block, check the build between each one, and test the login (enable 2FA → log out → log back in with a code) before concluding.

---

## Step 1 - Prerequisites (DB + user auth)

- `_check-deps db` → if `db_ok=false`, point to `/add-db` then stop.
- Confirm that `src/server/auth.ts` contains the `users` marker and that the `users` table exists (schema). Otherwise stop (the target is the accounts-based auth).
- Install the libs: `cd <WEB_DIR> && pnpm add otpauth qrcode`.

---

## Step 2 - Schema: per-user 2FA tables

Add to `src/server/db/schema.ts` (making sure `text, boolean, timestamp, serial` are imported from `drizzle-orm/pg-core`):

```ts
/** Per-user 2FA (TOTP). */
export const userTwoFactor = createTable("user_two_factor", {
  userId: text("user_id").primaryKey(),
  secret: text("secret").notNull(),
  enabled: boolean("enabled").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const userBackupCode = createTable("user_backup_code", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});
```

Then `cd <WEB_DIR> && pnpm db:push`.

---

## Step 3 - TOTP helpers + DB access

**`src/lib/totp.ts`** (generic, the secret is passed as an argument because it is per-user):

```ts
import { TOTP, Secret } from "otpauth";
import { randomBytes } from "crypto";

export function generateTotpSecret(): string { return new Secret({ size: 20 }).base32; }
export function totpUrl(issuer: string, account: string, secret: string): string {
  return new TOTP({ issuer, label: account, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).toString();
}
export function verifyTotp(secret: string, token: string): boolean {
  const clean = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  return new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).validate({ token: clean, window: 1 }) !== null;
}
export function generateBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const h = randomBytes(4).toString("hex").toUpperCase();
    return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
  });
}
```

**`src/lib/user-2fa.ts`** (DB; reuses `hashPassword`/`verifyPassword` from `~/lib/password`):

```ts
import { eq, and, isNull } from "drizzle-orm";
import { db } from "~/server/db";
import { userTwoFactor, userBackupCode } from "~/server/db/schema";
import { hashPassword, verifyPassword } from "~/lib/password";

export async function getUser2fa(userId: string) {
  return (await db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, userId)).limit(1))[0] ?? null;
}
export async function isTwoFactorEnabled(userId: string) {
  return (await getUser2fa(userId))?.enabled ?? false;
}
export async function setPendingSecret(userId: string, secret: string) {
  const existing = await getUser2fa(userId);
  if (existing) await db.update(userTwoFactor).set({ secret, enabled: false }).where(eq(userTwoFactor.userId, userId));
  else await db.insert(userTwoFactor).values({ userId, secret, enabled: false });
}
export async function enableTwoFactor(userId: string) {
  await db.update(userTwoFactor).set({ enabled: true }).where(eq(userTwoFactor.userId, userId));
}
export async function disableTwoFactor(userId: string) {
  await db.delete(userTwoFactor).where(eq(userTwoFactor.userId, userId));
  await db.delete(userBackupCode).where(eq(userBackupCode.userId, userId));
}
export async function replaceBackupCodes(userId: string, codes: string[]) {
  await db.delete(userBackupCode).where(eq(userBackupCode.userId, userId));
  for (const c of codes) await db.insert(userBackupCode).values({ userId, codeHash: await hashPassword(c.toUpperCase()) });
}
export async function consumeUserBackupCode(userId: string, code: string) {
  const norm = code.trim().toUpperCase();
  const rows = await db.select().from(userBackupCode).where(and(eq(userBackupCode.userId, userId), isNull(userBackupCode.usedAt)));
  for (const r of rows) if (await verifyPassword(norm, r.codeHash)) {
    await db.update(userBackupCode).set({ usedAt: new Date() }).where(eq(userBackupCode.id, r.id));
    return true;
  }
  return false;
}
```

---

## Step 4 - Enrollment server actions (`src/app/account/two-factor-actions.ts`)

Generate the secret on the server, return the **QR (SVG)** so it can be displayed in the browser (never the chat). Replace `<ISSUER>` with the project name.

```ts
"use server";
import QRCode from "qrcode";
import { auth } from "~/server/auth";
import { generateTotpSecret, totpUrl, verifyTotp, generateBackupCodes } from "~/lib/totp";
import { getUser2fa, setPendingSecret, enableTwoFactor, disableTwoFactor, replaceBackupCodes, isTwoFactorEnabled } from "~/lib/user-2fa";

const ISSUER = "<ISSUER>";

export async function start2faSetup() {
  const s = await auth(); const userId = s?.user?.id;
  if (!userId) return { error: "unauthorized" as const };
  if (await isTwoFactorEnabled(userId)) return { error: "already_enabled" as const };
  const secret = generateTotpSecret();
  await setPendingSecret(userId, secret);
  const url = totpUrl(ISSUER, s.user.email ?? "account", secret);
  const qrSvg = await QRCode.toString(url, { type: "svg", margin: 2, width: 200 });
  return { secret, qrSvg };
}
export async function confirm2faSetup(code: string) {
  const s = await auth(); const userId = s?.user?.id;
  if (!userId) return { error: "unauthorized" as const };
  const row = await getUser2fa(userId);
  if (!row) return { error: "no_setup" as const };
  if (!verifyTotp(row.secret, code)) return { error: "invalid_code" as const };
  await enableTwoFactor(userId);
  const backupCodes = generateBackupCodes();
  await replaceBackupCodes(userId, backupCodes);
  return { enabled: true as const, backupCodes };
}
export async function disable2fa() {
  const s = await auth(); const userId = s?.user?.id;
  if (!userId) return { error: "unauthorized" as const };
  await disableTwoFactor(userId); return { disabled: true as const };
}
export async function regenerateBackupCodes() {
  const s = await auth(); const userId = s?.user?.id;
  if (!userId || !(await isTwoFactorEnabled(userId))) return { error: "not_enabled" as const };
  const backupCodes = generateBackupCodes();
  await replaceBackupCodes(userId, backupCodes);
  return { backupCodes };
}
```

> Check that the session exposes `user.id` (the Hypervibe user auth does). If it exposes an `email` but no `id`, adapt the helpers so the key = email.

---

## Step 5 - 2FA section in the Account page

Create a client component `src/app/account/two-factor-section.tsx` ("Security - Two-factor authentication") with 3 states:
1. **Disabled**: an "Enable" button. On click → `start2faSetup()` → display the **QR (`qrSvg`)** + the key + a "6-digit code" field + a "Confirm" button → `confirm2faSetup(code)`.
2. **Confirmation OK**: display the 8 backup codes **only once** (in the browser) with "write them down now".
3. **Enabled**: an "enabled" badge + "Disable" (`disable2fa`) and "Regenerate codes" (`regenerateBackupCodes`) buttons.

Style: reuse the project's shadcn/ui components (Card, Button, Input, toast). Import the section into `src/app/account/page.tsx` (pass the component the initial state `isTwoFactorEnabled(userId)` computed server-side in the page).

---

## Step 6 - 2FA step at login (the sensitive point)

The users flow logs in via `signIn("credentials", …)`. Add a 2FA step **only for accounts that enabled it**. Recommended approach (mirror of admin mode):

1. Create a **server action** `loginAction({ email, password, code? })` in `src/app/signin/actions.ts`:
   - rate-limit with the key `login:<ip>` (see `~/lib/rate-limit`), the key `authorize()` counts on too,
   - check email + password (DB lookup + `verifyPassword`) → if KO `bad_credentials`,
   - if `isTwoFactorEnabled(userId)`: require `code` (`2fa_required` if absent), check `verifyTotp(secret, code) || consumeUserBackupCode(userId, code)` → `invalid_code` otherwise,
   - emit a **signed proof** (HMAC `AUTH_SECRET`, like admin mode: create a reduced `src/lib/auth-2fa.ts` with `createLoginProof`/`verifyLoginProof`) and call `signIn("credentials", { email, proof, redirect: false })`.
2. Adapt the **Credentials provider** in `src/server/auth.ts`: a `proof` field in addition to `password`. **A password alone must never open an account that enabled 2FA**: the sign-in route (`/api/auth/callback/credentials`) can be called directly, without the action, so `authorize()` accepts the password ONLY for an account that has NOT enabled 2FA (`isTwoFactorEnabled(user.id)` false); for an account that enabled it, only a valid signed proof (`verifyLoginProof`) opens the session, and the password alone gives `null`. Never "the password OR the proof" for everyone: that lets anyone who knows the password skip the second factor. Keep the user DB lookup (id, email…). Keep the limit (`TooManyAttempts`), with one change, as `${CLAUDE_SKILL_DIR}/../../templates/2fa/auth.ts` does: a request that carries a valid proof is not counted (the action has already counted it, under the same key), any other request is. A forged proof then never buys more attempts, and a sign-in in two steps never counts twice. The shape to write (with the imports of the users template, `verifyLoginProof` from `~/lib/auth-2fa` and `isTwoFactorEnabled` from `~/lib/user-2fa`):

   ```ts
   async authorize(credentials, request) {
     const email = credentials?.email as string | undefined;
     const password = credentials?.password as string | undefined;
     const proof = credentials?.proof as string | undefined;
     // A proof signed by loginAction: the password and the second factor were checked there,
     // and the attempt counted. It alone opens an account that enabled 2FA.
     if (email && proof && verifyLoginProof(email, proof)) {
       const user = await db.query.users.findFirst({ columns: { id: true, email: true, name: true, image: true, passwordHash: true }, where: eq(users.email, email) });
       return user ? { id: user.id, email: user.email, name: user.name, image: user.image } : null;
     }
     // Anything else counts: a forged proof, a password.
     const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
     if (!checkRateLimit(`login:${ip}`).allowed) throw new TooManyAttempts();
     if (!email || !password || proof) return null;
     const user = await db.query.users.findFirst({ columns: { id: true, email: true, name: true, image: true, passwordHash: true }, where: eq(users.email, email) });
     if (!user?.passwordHash) return null;
     const ok = await verifyPassword(password, user.passwordHash);
     // A password alone never opens an account that enabled 2FA, whoever calls the route.
     if (!ok || (await isTwoFactorEnabled(user.id))) return null;
     return { id: user.id, email: user.email, name: user.name, image: user.image };
   }
   ```
3. Adapt `src/app/signin/page.tsx`: 2 steps (email+password → if `2fa_required`, a code field), reusing the admin signin pattern (`credentials`/`2fa` states).

> This is the only part that touches the core of the auth. Implement it carefully, check the build, and **test end to end**: enable 2FA on a test account, log out, log back in (the code must be requested), test a wrong code, test a backup code, and verify that an account WITHOUT 2FA still logs in with password only. Then the direct route, the case that matters most: from the browser's console on the sign-in page (the person types the test password there, never in the chat), `const { csrfToken } = await (await fetch("/api/auth/csrf")).json(); const r = await fetch("/api/auth/callback/credentials", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" }, body: new URLSearchParams({ email: "<test account>", password: "<its password>", csrfToken }) }); (await r.json()).url` with the right password of the account WITH 2FA must be REFUSED (the address it gives carries `error=CredentialsSignin`, and no session opens); the same call for the account without 2FA succeeds. If the account with 2FA gets a session, `authorize()` still accepts the password alone: fix it before going on.

---

## Step 7 - CLAUDE.md + summary

`_update-claude-md` (section `## Two-factor authentication (2FA)` on the users side: optional per account, tables `user_two_factor` / `user_backup_code`, helpers `src/lib/{totp,user-2fa}.ts`, actions `account/two-factor-actions.ts`, 2FA step at login).

Summary to the user:
> ## ✅ Two-factor authentication available for your users
> Each user can enable it from their **Account** page ("Security"): they scan a QR in **<AUTH_APP>**, confirm a code, and receive 8 backup codes (shown once in their browser). At the next login, they will be asked for their code after the password. Accounts that do not enable it keep going with password only.

---

## Implementation note

This sub-skill is **piloted by Claude** (no deterministic script) because the Account page and the login flow are project-specific. The secrets/codes **never go through the chat**: enrollment happens in the user's browser. To be **tested on a real user-auth project** before relying on it in production.
