---
name: _add-keyring
description: "Internal. Sets up the access-key vault (Bitwarden) on the machine: installs the tool, connects the account, opens the daily session. Invoked by /start (Step 3bis) and by skills that discover a missing vault (_ensure-vault, _get-secret...). Not meant to be invoked directly by users."
user-invocable: false
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# _add-keyring - The vault for your access keys

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You set up an encrypted vault (Bitwarden) where the user's **global keys** (Cloudflare, Neon, email, etc.) will live - the ones they reuse across all their projects. Instead of sitting in plain text in system variables, they are encrypted and you read them on demand after a daily unlock.

> **Script vocabulary** (internal): `INSTALL="${CLAUDE_SKILL_DIR}/../../scripts/vault/install-bw.mjs"`, `VAULT="${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs"`, `LAUNCH="${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs"`.

---

## Step 1 - OS detection + tool installation

Detect the OS silently:
```bash
uname -s 2>/dev/null || echo "Windows"
```
`Darwin`→mac, `MINGW`/`MSYS`/`Windows`→windows, `Linux`→linux.

Install the Bitwarden tool (idempotent, does nothing if it is already there):
```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/install-bw.mjs"
```
- `OK` → already present, say nothing.
- `INSTALLED...` → say *"I installed the vault tool."* The PATH may not be active in the current terminal - for the rest of THIS session, export the bin folder:
  - Windows: `export PATH="$PATH:$HOME/.hypervibe/bin:/c/Users/$USERNAME/.hypervibe/bin"`
  - mac/linux: `export PATH="$PATH:$HOME/.hypervibe/bin"`
- `ERROR: ...` → report it to the user and offer the official manual install (https://bitwarden.com/help/cli/), non-blocking. **NEVER improvise a download of `bw`/`bw.exe` yourself** (ad-hoc PowerShell `Invoke-WebRequest`, direct `curl`, etc.): running an unscripted external binary triggers an authorization prompt and is not reliable. If you think the install failed for a transient reason (network), re-run **the same** `install-bw.mjs` once; otherwise, route to the official manual install.

---

## Step 2 - Current state of the vault

⚠️ **Two indicators exist, do not confuse them**:
- **`node "$VAULT" status`** (the Hypervibe session) = **the ONLY source of truth for knowing whether the vault is OPEN** (`unlocked` / `locked` / `expired`). This is what matters for reading/writing keys.
- **`node "$VAULT" account`** is used **only** to know whether an **account is connected** on the machine (`"signedIn": true` or `false`). It unlocks nothing, so it says nothing about whether the vault is open: **NEVER use it to decide whether the vault is open**, otherwise you would trigger an unnecessary unlock. ⚠️ Never ask the `bw` tool itself (`bw status`): on Windows it can read another sign-in folder than the plugin's, and would call a connected machine `unauthenticated`.

**Check FIRST whether the vault is already open** (the most frequent case during the day):
```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" status 2>/dev/null
```
- `unlocked` → **the vault is already open, it is ready**: go directly to **Step 6** (offer NEITHER login NOR unlock).
- `locked` or `expired` → the vault is not open: you need to determine whether the connection is missing or just the unlock → continue below.

**Only then**, look at the account state (login):
```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" account 2>/dev/null   # {"signedIn": true|false, "account": ...}
```
- `"signedIn": false` → no account connected on this machine (this does NOT say whether an account exists elsewhere) → **Step 3** (login). It is also the answer when the `bw` tool cannot run here: the windows (`launch.mjs login/unlock/add`) **reinstall the tool automatically** if it is missing, and the sign-in window says so when an account is in fact already connected.
- `"signedIn": true` → an account is **already connected** (`account` names it), only the unlock is missing → **Step 5** (unlock). **Do NOT log in again.**

---

## Step 3 - Does the user already have an account? (ask BEFORE opening anything)

`"signedIn": false` only means "not connected on this machine", not "no account". **Do NOT open the signup page by default.** First, ask the question via the **AskUserQuestion** tool:

> **Question**: "Do you already have a Bitwarden account (the vault)?"
> - **Yes, in Europe**: account created on `vault.bitwarden.eu` (the most common case). → we go straight to the connection (Step 4, EU server).
> - **Yes, in the United States**: account created on `vault.bitwarden.com`. → connection Step 4, US server.
> - **No, I don't have one yet**: → we create the account (Step 3bis), then connect.
> - **I'm not sure**: treat as "No" (we create an EU account; if the connection later fails because an account already existed, we will adjust).

Remember the chosen **region**: it sets the `--server` for the login.
- Europe or new account → `https://vault.bitwarden.eu`
- United States → `https://vault.bitwarden.com`

Depending on the answer:
- **Already has an account (EU or US)** → go directly to **Step 4** with the right server.
- **No account / not sure** → do **Step 3bis** below, then Step 4 (EU server).

---

## Step 3bis - Create the account (only if the user does not have one)

> **We are going to create a vault for your access keys.** It is free and takes 2 minutes.
>
> 1. I will open the signup page for you. Create your account with your email.
> 2. Choose a strong **master password**. Very important: it is the only key to the vault. If you forget it, no one (not even Bitwarden) can recover it, and all the content would be lost. **Write it down somewhere offline** (a piece of paper in a drawer).
> 3. Enable **two-factor authentication** (Settings, Security, Two-step Login, via an app like Google Authenticator): recommended, this vault holds sensitive access keys.

Open the signup page (EU region, data hosted in Europe):
```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/open-url.mjs" "https://vault.bitwarden.eu/#/register" 2>/dev/null
```

Wait for the user to confirm they have created their account (and enabled 2FA). Account region = EU.

---

## Step 4 - Connection (dedicated window)

> A window will open to connect you to your vault: a text window, often black. **That is expected, and nothing in it can break**: a typo is undone by starting again. If you do not see it, it opened behind this one: look for it in the taskbar at the bottom of the screen (Windows) or in the Dock (Mac). Enter your email then your master password (you will see asterisks appear). **This information stays in the window, I never see it.**
>
> If **two-factor authentication** is enabled, a **code** will be requested right after: depending on your configuration it arrives in your **authenticator app** (Google Authenticator, etc.) or **by email** (the email is sent at the moment of connection, check your inbox). Copy the code into the window.

Launch the connection with the server of the region remembered at Step 3 (EU by default; US only if the user said they have a US account):
```bash
# Europe / new account:
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" login --lang <LANG> --server https://vault.bitwarden.eu
# (US account: replace with --server https://vault.bitwarden.com)
```
The command **blocks until the window is closed and now returns the real exit code** (0 = success, non-zero = failure: wrong password or wrong 2FA code). **NEVER assume success just because the window closed.** Always re-check with `node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" account`:
- `"signedIn": true` → connection succeeded, go to Step 5.
- still `"signedIn": false` → the connection failed: explain it to the user and offer to retry (wrong credentials or wrong 2FA code; or wrong region: if they thought they were on EU but it did not work, retry with the US server). The window already asked **3 times** before closing, so a failure here means three wrong attempts: ask the user before opening another one, never relaunch it on reflex. **Do not move on to Step 5 until `vault.mjs account` confirms the connection.**

---

## Step 5 - First unlock (dedicated window)

> Last step: we open the vault. A window will open - type your **master password**. The vault stays open for 6h, then it locks itself for real: after that, a window asks for it again at the first need.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" unlock --lang <LANG>
```
Blocks until closed. The window **self-repairs and re-checks the state before unlocking**: if the `bw` tool is missing, it reinstalls it automatically; if it shows "No account connected" (`vault.mjs account` = `"signedIn": false`), **do NOT loop back on the unlock**, return to **Step 3** (login) first. Then confirm the result:
```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" status
```
- `unlocked` → ✅ success.
- `locked`/`expired` → the unlock did not complete: the window already asked for the password **3 times**, so offer Step 5 again **once** only, and only after asking. If it fails again with "not connected", it is a login problem (Step 3), not an unlock one: do not insist on the unlock.

---

## Step 6 - Conclusion

> ✅ **Your vault is ready!**
>
> From now on, your important access keys (Cloudflare, database, email...) will be stored there securely. When I need them, I read them directly - you have nothing to copy over. Just one thing: **when the vault is closed, I will ask you for your master password** (a small window will open). It stays open six hours, then it locks itself again, for your safety.

If `_add-keyring` was called by `/start`, hand control back to `/start`. Otherwise, it is done.

---

## Technical notes (for Claude, not for the user)

- The vault stores **only the global keys** (reused across projects). The secrets specific to ONE project (`DATABASE_URL`, `AUTH_SECRET`...) stay in the `.env` + Vercel - do not put them here.
- To READ a key afterwards: follow the pattern of the `_get-secret` skill (read into a shell variable + auto-unlock, never display the value).
- To ADD a key: `node "$LAUNCH" add --name <ITEM> --service <S> --fields "f1:secret,f2:text"` (entry in the window, never via Claude).
- Per-user session: `~/.hypervibe/bw-session` (outside the plugin folder, survives updates). It lasts 6 hours, then the vault is really locked (`bw lock`, the file removed): by a lock scheduled at the unlock, by the first read after the end, and at the start of a Claude Code session (`scripts/vault/session.mjs`).
