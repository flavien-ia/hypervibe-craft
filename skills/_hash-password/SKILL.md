---
name: _hash-password
description: Internal helper to hash a password with Node's native scrypt (NOT bcrypt - bcrypt hashes contain $ characters that break shell and env var handling). Delegates to the bundled scripts/hash-password.mjs. Can hash a provided password or generate + hash a random one. Output format is `salt:hash` (hex:hex), shell-safe. Used by add-auth for admin credentials. Never writes secrets to files. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Hash Password - Internal helper

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Hash a password with scrypt. Delegates to a bundled Node script - never reimplement inline.

## Why scrypt, not bcrypt

bcrypt hashes contain `$` (e.g. `$2b$10$...`). `$` is interpreted by shells and mangled by `vercel env add`, causing silent corruption. scrypt hashes are plain `salt:hash` hex strings, fully shell-safe and env-var-safe.

**If you see bcrypt hashes anywhere in the project** (`$2a$`, `$2b$`, `$2y$` prefixes), refuse and tell the user to rehash in scrypt first.

## Invocation

### Hash a provided password (password supplied via stdin - never via argv)

```bash
HASH=$(printf '%s' "Admin1234!" | node "${CLAUDE_SKILL_DIR}/../../scripts/hash-password.mjs")
```

Returns a single line on stdout: `salt:hash` (both hex), no trailing newline. Capture it directly in a shell variable.

### A random password for the user (the admin's, in production)

Never generate it where you read it: a password shown in the conversation stays in its history. Use the script that writes it for the user alone:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/admin-password.mjs" rotate --project-dir "<app folder>"
```

It generates the password, writes it with the identifier and the sign-in page in a file of the user's downloads folder, and pushes only its hash (`ADMIN_PASSWORD_HASH_PROD`). Its JSON gives the file's path (`file`): give the user that path, never the password, and never read the file. The new password works once the site is deployed again.

`hash-password.mjs --generate` (which prints `password=` and `hash=` on its output) stays for scripts that capture it internally: never run it in a command whose output you read.

## Defaults

- `--length 24` for `--generate` (24 chars = ~143 bits of entropy, still typeable)
- `--format alphanumeric` for `--generate` (no special chars, comfortable in a terminal)

## Rules

- **Always** use this helper (never inline `scryptSync` or `bcrypt`).
- Never write the plain password in the project, and never display a password in the conversation. The only file that holds one is the file `admin-password.mjs` writes in the user's downloads folder, for them alone.
- Never log hashes or passwords to stdout. A hash goes to `_push-env-vars` through a shell variable or a pipe.
- The scrypt parameters are `salt=16 bytes`, `keylen=64 bytes`. Verification in the project uses the same params (in `src/lib/password.ts` created by `add-auth`), with `timingSafeEqual` to prevent timing attacks.
