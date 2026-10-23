---
name: _ensure-vault
description: Internal preflight - make sure the Bitwarden vault is unlocked before a skill reads any global key. Run at the start of every skill that will consume a vault secret (Cloudflare, Neon, Resend/Brevo, Hostinger, Anthropic…), so the unlock window pops once up-front instead of a key-read silently failing mid-flow. Not meant to be invoked directly by users.
user-invocable: false
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# _ensure-vault - "the vault is open" preflight

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

To run **at the start** of any skill that will read a key from the vault. Goal: open the unlock window **once up-front** rather than letting a key-read silently fail later (notably the case of scripts that go through `readUserEnv`, which returns `null` without flagging "locked").

Since the vault stays open for 6h and then locks itself for real, this preflight triggers a window **at most every 6 hours**, on first need.

## Snippet (run as-is)

```bash
VAULT="${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs"
ST=$(node "$VAULT" status 2>/dev/null)
echo "vault:$ST"
```

Depending on `ST`:

- **`unlocked`** → vault ready, continue the skill normally.
- **`locked` or `expired`** → notify the user in the chat, then open the unlock window (blocking), then re-check:
  > "Your key vault is closed - a window will open for your master password (the vault then stays open 6 hours)."
  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" unlock --lang <LANG>
  node "$VAULT" status   # should return "unlocked"
  ```
  The window asks for the master password up to **3 times** before giving up, so a typo is fixed on the spot. If it still exits non-zero, the three attempts were wrong: say so in the chat and ask the user before opening another window. Never reopen one on your own - that is how a mistyped password turns into an endless chain of windows.
  Only one unlock window opens at a time on the machine: a call made while another is open waits for it, and exits 0 if the vault opened, 1 if not.
- **Empty output / error** (no `bw`, no account connected → vault never configured) → the vault does not exist yet: **delegate to `_add-keyring`** (installs bw + creates the account + login + unlock), then re-check. If the user declines to set up the vault, flag it and stop cleanly (the skill will not be able to retrieve its keys).

## When to use it

Any skill that, directly or via a script (`check-deps`, `setup-db`, `setup-email`, `wrangler-env-init`, `quotas-fetch`, `count-cf-cron-slots`, `gsc-token`, `run-sql`…), will need a global key (Cloudflare, Neon, Resend/Brevo, Hostinger, Anthropic). Do it **before** the bulk of the work.

(Note: the read helpers stay non-interactive - they never open a window themselves. It is this preflight, orchestrated by Claude, that guarantees the vault is open at the right moment.)
