---
name: _create-contact-page
description: Internal helper - creates a functional /contact page with a secured form (honeypot anti-spam, rate limiting delegated to the tRPC procedure, HTML injection protection). Detects i18n, email provider (Resend vs Brevo), and shadcn/ui + react-hook-form deps. Invoked by /add-email or any future skill that needs to add a contact UI. Not meant to be called directly by users.
user-invocable: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Create Contact Page - Internal helper

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Creates a functional `/contact` page with a secured form (invisible honeypot anti-spam, server-side rate limiting, HTML/Brevo escaping on every user field). Invoked by `/add-email` after the user has accepted the offer to create it.

**Expected prerequisites** (normally guaranteed by the calling skill):
- The tRPC procedure `contact.send` exists (created by `add-email`, or put in place at Step 1 below when the email was set up without it)
- The `mail.ts` utility exports `sendMail` + the escape function (`escapeHtml` for Resend, `escapeForBrevo` for Brevo)
- shadcn/ui is installed (via `/bootstrap`)

---

## Step 1 - Detect the project context

Invoke `_detect-project-root` to retrieve `PROJECT_NAME`, `WEB_DIR`, `IS_MONOREPO`, `IS_NEXTJS`.

Invoke `_check-deps email i18n`:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" email i18n)
email_provider=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).email.provider || 'none')")
i18n_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).i18n.ok)")
```

### Consequences of the detected provider

**If `email_provider === "none"`** -> abort: the contact page depends on a functional email backend. Inform the calling skill and create nothing.

Otherwise (`resend` or `brevo`) -> continue. The React client page is **identical in both cases** (the HTML/Brevo escaping happens server-side in `contact.send`, not in the page). No need to distinguish.

**The contact router may be missing**: `/add-email` does not write it when the email was wanted for something else, nor when the project had no rate limiting yet. When `<WEB_DIR>/src/server/api/routers/contact.ts` is not there, put it in place first:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-email.mjs" --provider "$email_provider" --name "<PROJECT_NAME>" --web-dir "<WEB_DIR>" --contact-router-only
```

It writes the router and registers it in `root.ts`, nothing else. If it refuses because `rateLimitedProcedure` is missing from the project's tRPC, stop here and say so plainly: the form needs the rate limiting that `/bootstrap`'s security setup adds, and a page without its back-end would break the build.

Also retrieve the current sender email from the local env (useful for Step 2):

```bash
SENDER_EMAIL_VAR=$(case "$email_provider" in resend) echo "RESEND_FROM_EMAIL";; brevo) echo "BREVO_SENDER_EMAIL";; esac)
CURRENT_SENDER=$(grep -E "^${SENDER_EMAIL_VAR}=" .env 2>/dev/null | head -1 | sed -E "s/^${SENDER_EMAIL_VAR}=//" | tr -d '"' | tr -d "'")
```

### Determine a functional default for receiving

The goal: a default that **actually works** for receiving the emails. The sender is not always a good choice (e.g. `onboarding@resend.dev` is NOT an inbox - emails sent there disappear silently).

The Resend API does not cleanly expose the account email -> we **ask the user directly** for the receiving address (better UX: explicit rather than guessed). For Brevo, the `CURRENT_SENDER` (verified address) remains a reasonable default to propose.

---

## Step 2 - Ask for the receiving email address

**First, does the sender's domain relay its addresses?** When a domain's mail goes through Cloudflare's Email Routing (its mail servers are `route1.mx.cloudflare.net` and siblings), its addresses are not mailboxes: Cloudflare forwards what they receive to another inbox. A notification sent to an address of the sending domain then goes out and comes back through that relay, which can break its DKIM signature, and the message ends up in spam. Read it for the sender's domain (`CURRENT_SENDER` after its `@`):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/domain-mx.mjs" <sender's domain>
```

It reads the domain's mail servers in public DNS: no key, no vault.

- `relayed: true` -> **no default on that domain**, the sender included. Ask for the final inbox (the one the relay forwards to, often a Gmail or Outlook address), and say why in one sentence, for example: *"Your addresses at <domain> are forwarded to another inbox: sending the form's messages there through that relay can land them in spam, so tell me the inbox they finally arrive in."* If the user still gives an address of that domain, say it once more, then respect their choice.
- `relayed: false` -> the defaults below apply.
- Exit `1` (the DNS could not be read) -> ask for the receiving address with no default.

Proposed default:
- **Resend**: no guessed default - ask for the address, optionally proposing `$CURRENT_SENDER` if it is defined and is not `onboarding@resend.dev`.
- **Brevo**: propose `$CURRENT_SENDER` (verified address, real inbox).

If the current sender is `onboarding@resend.dev`, warn the user that receiving will not work until they provide a real address.

Ask the user (plain language, no jargon):

> ## 📬 Which address do you want to receive the form messages at?
>
> When someone fills out your contact form, their message is sent to you by email. Tell me where you want to receive them:
>
> - **By default**: at `<DEFAULT_RECIPIENT>` (<explanation: "your Resend email" if owner, otherwise "the sending address you just configured">)
> - **Another address**: give me another address (e.g. your personal Gmail `me@gmail.com`)
>
> Tell me *"leave the default"* or type the address you want.

### Depending on the answer

Whatever the choice, **always push** `CONTACT_RECIPIENT_EMAIL` via `_push-env-vars` (we do not rely on the tRPC procedure fallback for the nominal case - the fallback remains only a safety belt):

**If "leave the default"** -> `RECIPIENT = $DEFAULT_RECIPIENT`.

**If the user gives a different address** -> `RECIPIENT = <provided address>`. Quickly validate that it looks like an email (contains `@` and at least one `.` after it). If invalid, ask again.

Then in both cases:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/push-env-vars.mjs" "CONTACT_RECIPIENT_EMAIL=$RECIPIENT"
```

The helper updates the local `.env` AND Vercel (production/preview/development) in a single idempotent operation. The tRPC procedure `contact.send` reads `process.env.CONTACT_RECIPIENT_EMAIL`.

**⚠️ Brevo note**: if the provider is Brevo and the user gives a custom address, remind them that Brevo does not require formal validation of the recipient (unlike the sender, which must be verified). No blocking, but if the address is wrong, the email will disappear silently (Brevo 201-then-async-fail).

---

## Step 3 - Install the missing deps

### 3.a - react-hook-form + zod

Check in `<WEB_DIR>/package.json`:

```bash
grep -qE '"(react-hook-form|@hookform/resolvers|zod)"' "<WEB_DIR>/package.json"
```

If any of the three is missing, install:

```bash
cd <WEB_DIR> && pnpm add react-hook-form @hookform/resolvers "zod@^3"
```

> **Why `zod@^3` and not a bare `zod`.** The create-t3-app scaffold ships
> `zod@^3.24.2` together with `@t3-oss/env-nextjs@^0.12.x`, whose peer range is
> `zod: ^3.24.0` - zod 4 is not supported there. A bare `pnpm add zod` resolves
> the `latest` tag (zod 4.x), breaks that peer and the typing of `src/env.js`.
> Lift this pin once the scaffold ships `@t3-oss/env-nextjs` >= 0.13, which
> accepts `^3.24.0 || ^4.0.0`.

### 3.b - Required shadcn/ui components

The page needs: `card`, `input`, `textarea`, `button`, `label`, `alert`. Check that each is present in `<WEB_DIR>/src/components/ui/`:

```bash
for c in card input textarea button label alert; do
  [ -f "<WEB_DIR>/src/components/ui/$c.tsx" ] || MISSING="$MISSING $c"
done
```

If `MISSING` is non-empty, install:

```bash
cd <WEB_DIR> && pnpm dlx shadcn@latest add$MISSING
```

---

## Step 4 - Copy the template (standard i18n-aware pattern)

The contact page follows the plugin's standard i18n-aware feature pattern. All the files (plain.tsx, i18n.tsx, messages-fr.json, messages-en.json) are in `templates/contact-page/` at the plugin root.

### 4.a - Choose the variant and the path

```bash
PLUGIN_ROOT="${CLAUDE_SKILL_DIR}/../.."
if [ "$i18n_ok" = "true" ]; then
  VARIANT="i18n"
  DEST="<WEB_DIR>/src/app/[locale]/contact/page.tsx"
else
  VARIANT="plain"
  DEST="<WEB_DIR>/src/app/contact/page.tsx"
fi
```

### 4.b - Copy the right template

```bash
mkdir -p "$(dirname "$DEST")"
cp "$PLUGIN_ROOT/templates/contact-page/$VARIANT.tsx" "$DEST"
```

### 4.c - If i18n is active, merge the messages

```bash
if [ "$i18n_ok" = "true" ]; then
  node "$PLUGIN_ROOT/scripts/_i18n-merge-messages.mjs" --web-dir "<WEB_DIR>" --feature contact-page
fi
```

The helper merges the `contact.*` keys into every `messages/<locale>.json` in the project. EN fallback for the locales the template does not ship (the helper warns about those locales). If other languages are present (e.g. `es.json`, `de.json`), warn the user that the translations must be completed manually.

---

## Step 5 - Return to the calling skill

Do not display a clean summary (the calling skill produces its own final summary). Just confirm the path of the created page:

```
CONTACT_PAGE_CREATED: <DEST>
```

The calling skill will integrate this info into its user-facing summary.
