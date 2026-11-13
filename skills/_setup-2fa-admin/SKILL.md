---
name: _setup-2fa-admin
description: Internal. Sets up 2FA (TOTP) on a hypervibe admin-credentials login - mandatory for the single admin. TOTP code after the password, trusted-device cookie (24h), backup codes, idle auto-logout. The TOTP secret + backup codes are written to the Bitwarden vault (never the chat). Invoked by /add-2fa when the project is in admin mode. Not meant to be invoked directly by users.
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Setup 2FA - Admin mode

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Sets up 2FA on a hypervibe **admin** login. The deterministic core (install, generation of the secret + codes, writing the code, vault storage, env push) lives in `scripts/setup-2fa.mjs`. This skill handles the pre-flight (vault), the invocation, mounting the auto-logout, and the summary.

**Input variables** (passed by `add-2fa`): `PROJECT_NAME`, `WEB_DIR`, `AUTH_APP`.

---

## Step 1 - Vault pre-flight

The 2FA secret + the codes are stored in the Bitwarden vault. Make sure it is unlocked (the `_ensure-vault` pattern):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" status
```

- `unlocked` -> continue.
- `locked` / `expired` -> warn the user ("vault is locked, a window will open for your master password"), then:
  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" unlock --lang <LANG>
  ```
  (blocking, the user enters their master pwd, auto-closes on success). Then continue.
- Vault not installed -> delegate to `_add-keyring`, then continue.

> Info: if the vault stays unavailable, the script falls back (gitignored file), non-blocking.

---

## Step 2 - Run the install

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-2fa.mjs" \
  --name "<PROJECT_NAME>" \
  --issuer "<PROJECT_NAME capitalized>" \
  --web-dir "<WEB_DIR>"
```

7 sub-steps (preflight, install otpauth + qrcode, TOTP secret, backup codes, writing the code, **storage in the vault** + scan QR, push of the environment variables). Ends with a handoff banner + JSON:
`{"success":true,"storedIn":"vault|file","vaultItem":"<NAME>_2FA","qrPath":"…/.2fa-setup/qrcode.png"}`

Relay it in plain language (`↳ Generating your secret…`, `↳ Storing your keys in your vault…`).

**On success**: capture `storedIn`, `vaultItem`, `qrPath`. Move on to Step 3.

**On failure**: read the error above the banner (`❌ Failed at: <step>`, maps 1:1 to a function in `setup-2fa.mjs`). Causes: preflight (no admin auth / 2FA already present, or an `auth.ts` that is not the admin login alone: a combined sign-in `admin, users`, accounts in the database or an OAuth provider; the script refuses and leaves the file untouched, since it rewrites it whole: never work around it, go back to `add-2fa` Step 1), install (pnpm/network), env push. If `src/lib/rate-limit.ts` was missing (a project that ran `/add-auth` outside of bootstrap), the script **creates a minimal one automatically** while writing the code: no more broken build.

---

## Step 3 - Mount the auto-logout (contextual edit)

The script created `src/components/dashboard/idle-timeout.tsx` but did not mount it. In `<WEB_DIR>/src/app/admin/(protected)/layout.tsx`:
1. `import { IdleTimeout } from "~/components/dashboard/idle-timeout";`
2. Render `<IdleTimeout />` right before `{children}` (adapt to the actual wrapper; `<><IdleTimeout />{children}</>` if the layout returns `<>{children}</>`).

Verify: `cd <WEB_DIR> && pnpm tsc --noEmit` then `pnpm lint`.

---

## Step 4 - Update CLAUDE.md

Invoke `_update-claude-md`:
- `env-vars`: `- \`ADMIN_TOTP_SECRET\` - TOTP secret for admin 2FA` ; `- \`ADMIN_2FA_BACKUP_HASHES\` - hashed backup codes (JSON)`
- `custom` heading `## Two-factor authentication (2FA)`, body:
  ```
  Admin login = password + 2FA (TOTP code).
  - `loginAction` (`src/app/admin/signin/actions.ts`) = single entry point (password + 2nd factor + trust cookie + signed proof → signIn). NextAuth `authorize` validates the proof (`verifyLoginProof`).
  - TOTP: `src/lib/auth-2fa.ts`, secret `ADMIN_TOTP_SECRET`. Codes: `src/lib/auth-backup-codes.ts`, hashed `ADMIN_2FA_BACKUP_HASHES`.
  - Trusted device: 24h cookie. Idle logout: `IdleTimeout` (30 min). Session 8h.
  - Secret + codes in plain text: in the Bitwarden vault (item `<PROJECT>_2FA`). To regenerate: delete `src/lib/auth-2fa.ts` then re-run `/add-2fa`.
  ```

---

## Step 5 - Final summary (tailored to the app)

> ## ✅ Two-factor authentication enabled
>
> Logging in as admin will now require **your password + a 6-digit code** from **<AUTH_APP>**.
>
> **To do now (one time):**
> 1. Open your **Bitwarden vault**, item **`<vaultItem>`**: your TOTP key and your 8 backup codes are there (encrypted, never displayed in the chat).
> 2. In **<AUTH_APP>**, add the entry: either by **scanning** the QR (`<qrPath>`), or by pasting the **key** from the vault.
> 3. Keep the **backup codes** handy (they are already in your vault) in case you lose your phone.
> 4. Once enrolled, **delete the `.2fa-setup/` folder** (it only contains the scan QR; already ignored by git). Tell me "delete the 2FA folder" and I'll do it.
>
> After that: password + code from <AUTH_APP>. For 24h on this browser, only the password will be asked again; auto-logout after 30 min of inactivity.

**If `storedIn = "file"`** (vault unavailable at install time): replace point 1 with *"open `<folder>/secrets.txt`, save the key + the codes in your password manager, then delete the `.2fa-setup/` folder"*.

⚠️ Never re-display the secret or the codes in the chat - they are in the vault (or the file).
