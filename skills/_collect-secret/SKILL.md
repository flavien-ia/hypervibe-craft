---
name: _collect-secret
description: Internal pattern helper for every skill that needs a value the user must fetch from an external provider (API key, token, OAuth secret, measurement ID...). Defines the plugin-wide convention - a SECRET is always typed into a masked OS window and lands either in the vault (global key) or in the project .env + Vercel (project secret), never in the conversation; a non-secret IDENTIFIER can simply be pasted in chat. Also covers browser auto-open, one-shot value warnings, format validation, and the headless fallback. Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# _collect-secret - Get a value from a provider, without leaking it

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Internal helper for the flow *"the user goes into their browser, performs a manual action at a provider, and brings back a value"*. Invoke it from any skill that needs a value the provider's API cannot create or read programmatically.

There is no single binary to call. This is a **standardized pattern** the calling skill follows, plus two small utilities: one to open the browser, one to open a masked input window.

## `--lang` - always substitute it

Every window command below carries `--lang <LANG>`. **Replace `<LANG>` with the two-letter code of the language you detected for the conversation** (`fr`, `en`, ...) before running the command. Never send the literal `<LANG>`.

The window is a **separate process**: it cannot see the conversation, so it has no way to detect the language on its own. You are the only one who knows it. Without the flag the window falls back to the machine's locale, which is wrong exactly when it matters - a French user on an English Windows would get an English window in the middle of a French conversation.

Supported today: `fr`, `en`. Any other code falls back to English rather than failing.

---

## THE RULE - a secret never transits through the conversation

**Classify the value first. Everything else follows from that.**

| Kind | Examples | How it comes back |
|---|---|---|
| **Secret** | API key, token, client secret, webhook signing secret, connection URL with a password, admin key | **Masked OS window.** Never in chat. |
| **Identifier** | GA4 measurement ID (`G-XXXXXXXXXX`), OAuth *client ID*, account ID, project slug, public key, region | Plain chat paste is fine. |

The test: **would leaking this value let someone act as the user?** If yes, it is a secret. If you hesitate, treat it as a secret.

Why this matters: a value pasted in the conversation is written in clear text into the session transcript, which has no guaranteed lifetime and no encryption at rest. Storing it "only in `.env`, never in the repo" does not undo that - the leak already happened, upstream. A window keeps the value inside a process the conversation never sees.

Do not impose the window on identifiers. A GA4 measurement ID is visible in the source of every page of the site; asking for it in a masked window would add friction and teach the user that the window is bureaucracy rather than protection.

---

## Secrets - the two destinations

Which destination depends on the **scope** of the key, matching the plugin's existing split.

### A. Global key, reused across projects → the vault

Cloudflare, Neon, the registrar token, the account-level Resend/Brevo key, an Anthropic admin key. Follow `_ensure-vault` first (the vault must exist and be unlocked), then:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" add --lang <LANG> \
  --name <ITEM> --service <ServiceName> --fields "api_key:secret"
```

Read it back later with `_get-secret`. Never with `echo`.

### B. Secret belonging to ONE project → the project's `.env` + Vercel

A project-scoped API key, `DATABASE_URL`, a Stripe key for this app. These live in the project, not in the vault:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" collect-env --lang <LANG> \
  --keys "STRIPE_SECRET_KEY:secret" \
  --project-dir "<absolute project dir>" \
  --url "https://dashboard.stripe.com/apikeys"
```

- `--keys` takes `NAME:secret` or `NAME:text`, comma-separated. Ask for several keys in one window only when they come from the same screen (an OAuth client ID + secret, for instance); `text` fields are shown in clear as they are typed, `secret` fields are masked.
- `--url` is optional: it opens that page in the browser from inside the window, so the user grabs the value and comes straight back.
- `--target production,preview` if you need something other than the default.
- The window hands the values straight to `_push-env-vars` (local `.env` + Vercel, idempotent). It does **not** need the vault, so it works on a project that has none.

Both commands **block** until the user is done, and return a non-zero exit code if they cancel or something fails. Read the exit code, do not assume success.

---

## The pattern - 5 steps

### Step 1 - Announce the action

Always prefix with 🌐 so the user sees at a glance that something is expected of them.

> ## 🌐 An action from you
>
> I'm going to open **<PROVIDER_NAME>** in your browser (URL: `<URL>`). Here's what you'll do:
>
> 1. <instruction 1 in plain language>
> 2. <instruction 2>
> 3. Copy the value (which looks like `<example format>`).
>
> **For a secret, add:** A small window will then open on your machine. Paste the value in there, not in our conversation, so it never gets written into this chat.
>
> <⚠️ warning if the value is one-shot - see below>

### Step 2 - Open the browser

For an identifier, or when you are not passing `--url` to the window:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/open-url.mjs" "<URL>"
```

Cross-platform (macOS `open`, Windows `start`, Linux `xdg-open`). Always show the URL in plain text too: some setups will not auto-open.

### Step 3 - Collect the value

- **Secret** → open the window (section above) and wait for it to return. The value never reaches you, and that is the point: you will not be able to check it yourself, so rely on the exit code.
- **Identifier** → the user pastes it in their next message. Use it, do not echo it back needlessly.

### Step 4 - Format validation

Only possible for identifiers, and for secrets the window itself refuses (it rejects empty input). If an identifier does not match the expected shape:

> The value you gave me doesn't look like what I expected (expected: `<format description>`, for example `G-XXXXXXXXXX`). Could you double-check it? If you're sure it's correct, tell me *"force"* and I'll continue anyway.

Max **3 attempts**, then a clean abort.

If a **secret** turns out to be wrong (the API call fails with a 401 later), do not ask the user to paste it in chat "just to check". Re-run the window.

### Step 5 - Confirm without revealing

> ✅ Key stored for this project. I'm continuing with <next action>.

Never restate a secret, not even truncated, not even its length. For an identifier, echoing it is fine.

---

## Fallback - no window available

In a headless, remote or scheduled session there is no OS window to open. The commands above will fail. In that case, **chat paste is tolerated**, but never silently:

> ⚠️ I can't open a secure input window in this session, so this key would have to go through our conversation, in clear text, and it would stay written in this session's history. Two options:
>
> 1. **Recommended**: redo this step from Claude Code on your machine, where I can open the window.
> 2. **Continue anyway**: paste the key here, and plan to rotate it at the provider once we're done.

Wait for an explicit choice. If they choose option 2, take the value, use it, and **remind them at the end of the skill** to rotate that key. Do not quietly drop the reminder.

---

## ⚠️ One-shot values

Many providers display a secret **only once**, at creation time:
- GitHub OAuth client_secret
- Resend API key
- Brevo API key
- Anthropic API key and admin key
- Stripe webhook signing secret (Reveal then re-Reveal works, but regenerating breaks the webhooks)

For these, add to Step 1:

> ⚠️ **Important**: <provider> will **never show this value again** once you close the window. Copy it right away.

Order matters here: open the input window **before** the user closes the provider's page, so a one-shot value is never lost between the two.

---

## Catalog of common providers

(enrich over time)

### Stripe - Secret Key  ·  *secret → project*

- URL: `https://dashboard.stripe.com/apikeys`
- Pre-conditions: Stripe account + the app/sub-account already created
- Instructions:
  1. If you've never revealed the **Secret key**: click **Reveal** on the corresponding row
  2. If you want to generate a new one (rotation): click **Roll key** + confirm
  3. Copy the value (starts with `sk_live_` in production or `sk_test_` in test mode)
- Format: starts with `sk_live_` or `sk_test_`, length ~100 chars

### Stripe - Webhook Secret  ·  *secret → project*

- URL: `https://dashboard.stripe.com/webhooks`
- Instructions:
  1. Open your app's webhook endpoint
  2. **Signing secret** section → click **Reveal**
  3. Copy the value
- Format: starts with `whsec_`

### Resend - API Key  ·  *secret → vault if account-wide, project if scoped*

- URL: `https://resend.com/api-keys`
- Instructions:
  1. Click **Create API Key** at the top right
  2. Give it a descriptive name (e.g., `<project>-prod`)
  3. Copy the value **immediately** (one-shot)
- Format: starts with `re_` · ⚠️ One-shot

### Brevo - API Key  ·  *secret → vault if account-wide, project if scoped*

- URL: `https://app.brevo.com/security/api-keys`
- Instructions:
  1. Click **Generate a new API key**
  2. Give it a name
  3. Copy the value **immediately** (one-shot)
- Format: starts with `xkeysib-` · ⚠️ One-shot

### Google OAuth - Client ID + Secret  ·  *ID = identifier, Secret = secret → project*

- URL: `https://console.cloud.google.com/apis/credentials`
- Pre-conditions: existing Google Cloud project
- Instructions:
  1. **Create Credentials → OAuth client ID**
  2. Type: **Web application**
  3. Authorized redirect URI: `<app-url>/api/auth/callback/google`
  4. Copy the **Client ID** (format `<digits>-<hash>.apps.googleusercontent.com`)
  5. Copy the **Client Secret** (format starts with `GOCSPX-`)
- Both come from the same screen → one window: `--keys "AUTH_GOOGLE_ID:text,AUTH_GOOGLE_SECRET:secret"`

### GitHub OAuth - Client ID + Secret  ·  *ID = identifier, Secret = secret → project*

- URL: `https://github.com/settings/developers`
- Instructions:
  1. **OAuth Apps → New OAuth App**
  2. Authorization callback URL: `<app-url>/api/auth/callback/github`
  3. Copy the **Client ID** (displayed directly, format `Ov...` or `Iv...`)
  4. Click **Generate a new client secret**
  5. Copy the **Client secret** **immediately** (one-shot)
- One window: `--keys "AUTH_GITHUB_ID:text,AUTH_GITHUB_SECRET:secret"` · ⚠️ The secret is one-shot

### Anthropic - API Key (workspace-scoped)  ·  *secret → project*

- URL: `https://console.anthropic.com/settings/keys`
- Instructions:
  1. **Create Key**
  2. Give it a name (e.g., `<project>-prod`)
  3. Copy the value **immediately** (one-shot)
- Format: starts with `sk-ant-api` · ⚠️ One-shot

### Anthropic - Admin Key  ·  *secret → vault (account-wide)*

- URL: `https://console.anthropic.com/settings/admin-keys`
- Instructions: **Create Admin Key**, copy immediately
- Format: starts with `sk-ant-admin` · ⚠️ One-shot

### Cloudflare - API Token (scoped, custom)  ·  *secret → vault*

- URL: `https://dash.cloudflare.com/profile/api-tokens`
- Instructions:
  1. **Create Token → Custom token**
  2. Permissions to add (depending on usage): Workers Scripts:Edit, R2:Edit, Workers KV Storage:Edit, etc.
  3. Account Resources: your account
  4. **Continue to summary → Create Token**
  5. Copy the value

### Cloudflare R2 - bucket token (S3 API)  ·  *secret → project*

- URL: `https://dash.cloudflare.com/` → **Storage & databases** → **R2 Object Storage** → **Overview** → **Account details** → **{} Manage** (`Manage R2 API Tokens`)
- Instructions:
  1. **Create Account API token**
  2. Name it after the application; permission **Object Read & Write** (or **Object Read only** for a read-only use)
  3. **Apply to specific buckets only**, and pick the project's bucket
  4. **Create Account API Token**
- The page then shows THREE values. Collect only two, in ONE window: the **Access Key ID** and the **Secret Access Key** (shown only once). The **Token value** is a Cloudflare API token: it gives no right on the objects, through the REST API or S3. Do not collect it.
- Window (destination B, the project's `.env` + hosting): `--keys "R2_ACCESS_KEY_ID:secret,R2_SECRET_ACCESS_KEY:secret"`
- The S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`, or `https://<account-id>.eu.r2.cloudflarestorage.com` for a bucket in the EU jurisdiction.
- Checking an account token: `/accounts/{account_id}/tokens/verify`, not `/user/tokens/verify` (which calls it invalid).

### Vercel - Personal Access Token  ·  *secret → vault*

- URL: `https://vercel.com/account/tokens`
- Instructions:
  1. **Create Token**, give it a name
  2. Scope: Full Account (or the Vercel team, if applicable)
  3. Expiration: your choice (6 months typical)
  4. **Create**, then copy the value

### Google Analytics - Measurement ID  ·  *identifier → chat paste is fine*

- URL: `https://analytics.google.com/`
- Instructions: Admin → Data streams → your web stream → **Measurement ID** at the top right
- Format: `G-XXXXXXXXXX`
- Not a secret: it ships in the HTML of every page of the site. Do not put it behind a window.

---

## Global rules

- **Classify first**: secret → window, identifier → chat. When in doubt, secret.
- **Always show the URL in plain text** - auto-open is not guaranteed.
- **Always prefix with 🌐** so a manual action is visible.
- **Always warn on one-shot values**, and open the input window before the provider's page is closed.
- **Never relay a secret** in a reply, not even partially, not even to confirm it.
- **Read the exit code** of the window command instead of assuming it worked.
- **Ask one screen at a time**: batch several keys in one window only when the provider shows them together.
