---
name: new-email-address
description: "Create a new receiving address on a domain already connected via /add-domain. Uses Cloudflare Email Routing to forward messages (e.g. support@mydomain.com) to an existing mailbox (Gmail, Outlook, etc.). Can take a destination address as an argument (typical case: called from /add-domain). The first time a destination address is used, the user must click the verification link sent by Cloudflare."
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# New Email Address - Create a receiving address

You add a receiving email address (for example `support@mydomain.com`) on a domain already connected to Cloudflare via `/add-domain`. Cloudflare Email Routing forwards messages to an existing mailbox (Gmail, Outlook, etc.), no real mailbox is created, just transparent forwarding.

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

**Optional argument**: you may receive a destination address as an argument (e.g. `you@example.com`), typically when the skill is called from `/add-domain` which has just configured the first alias. In that case, do not ask for the destination again.

---

## Step 1 - Preflight

Invoke the internal skill `_detect-project-root` to retrieve `PROJECT_NAME`, `WEB_DIR`. No need to check `IS_NEXTJS` - this skill can run independently of the framework (it does not touch the code, only Cloudflare).

Check that the Cloudflare token is present and valid:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" cloudflare)
cf_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).cloudflare.ok)")
```

**If `cf_ok = false`** → route to `/start`:

> I need your Cloudflare account connected to your computer to manage email addresses. That is not done yet.
>
> Run **`/start`** - it creates a Cloudflare API token in 2 guided minutes. Then run `/new-email-address` again and I will pick up here.

**If `cf_ok = true`** → fetch the Cloudflare token from the vault for the API calls below:

```bash
CFTOK=$(node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" get CLOUDFLARE api_token)
```
Apply the `_get-secret` pattern on the exit code: 2/3 → unlock then retry; 4 → the key is not in the vault. **Never display `$CFTOK`.**

---

## Step 2 - Identify the domain

Look in `<WEB_DIR>/CLAUDE.md` (and at the project root) for the "Custom domain" section that contains `The production domain is \`<domain>\``. Store it in `<domain>`.

**If not found**:

> On which domain do you want to add a new email address? (e.g. `mydomain.com`)

Wait for the answer.

---

## Step 3 - Check the Cloudflare zone

```bash
VAULT="${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs"
CFTOK=$(node "$VAULT" get CLOUDFLARE api_token)
ZONE_RESPONSE=$(printf 'header = "Authorization: Bearer %s"\n' "$CFTOK" | curl -s --config - \
  "https://api.cloudflare.com/client/v4/zones?name=<domain>")
ZONE_ID=$(echo "$ZONE_RESPONSE" | node -e "const d = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(d.result?.[0]?.id || '');")
ACCOUNT_ID=$(echo "$ZONE_RESPONSE" | node -e "const d = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(d.result?.[0]?.account?.id || '');")
```

**If `ZONE_ID` is empty** → clear error:

> I cannot find `<domain>` in your Cloudflare account. You first need to connect it with `/add-domain` (which switches the nameservers at your registrar and creates the Cloudflare zone). Once that is done, run `/new-email-address` again.

Abort.

---

## Step 4 - Make sure Email Routing is enabled

Email Routing takes the domain's mail servers (MX) for itself: it cannot share them with a mail provider (Cloudflare's documentation says so). On a domain that already receives its mail elsewhere (Google Workspace, Microsoft 365, OVH's mail...), enabling it would cut those mailboxes off. The plugin's script checks the zone's mail servers first, enables only when none belongs to another provider, and reads Cloudflare's settings back:

```bash
ROUTING="${CLAUDE_SKILL_DIR}/../../scripts/email-routing.mjs"
node "$ROUTING" enable <domain>
```

- **Exit 0** (`enabled: true`): Email Routing is on (`already: true` if it was). On a first activation Cloudflare adds its own MX and SPF records. Go on.
- **Exit 2** (`foreignMx`): the domain receives its mail at another provider. **Stop here**: tell the user, in plain words, that their mailboxes there would stop receiving, and that the address is better created with that provider (most of them offer aliases). Replacing those mailboxes with forwarding is a change of mail provider, not this skill's to make.
- **Exit 1**: Cloudflare refused, or the settings do not read back as enabled (`error`, in Cloudflare's own words): say it, and stop. Never announce an activation that did not read back. When `missingRight` is set, the Cloudflare key lacks the right **Zone · Zone Settings · Edit** (keys made before 3.4.31 do not have it): say so in plain words, and offer the two ways out the `error` gives, adding that right to the key (its page on Cloudflare, the key's line, **Edit**, then the **Zone policy** block) or enabling Email Routing once in the dashboard; then run the command again.
- **Exit 3 / 4**: open the vault (`_ensure-vault`), or run `/start`.

---

## Step 5 - Ask for the alias prefix

> Which address do you want to create? Just give the **prefix** (the part before the `@`), I will complete it with `@<domain>`.
>
> Examples: `support`, `hello`, `info`, `contact`, `hi`, `me`

Wait for the answer, store it in `<prefix>`. Validate basically (letters, digits, hyphens, underscore, dot - no space or special character).

**Special case: catch-all.** If the user answers `*` or "all", switch to the catch-all rule (`matchers: [{type: "all"}]`) instead of a literal matcher. This forwards `anything@<domain>` to the destination. Propose it if the user mentions "all emails" or "catch-all".

---

## Step 6 - Determine the destination address

### 6.a - If an argument was passed (call from /add-domain)

Use the argument directly as `<dest>` and move on to Step 7.

### 6.b - Otherwise: list the already verified destinations

```bash
VAULT="${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs"
CFTOK=$(node "$VAULT" get CLOUDFLARE api_token)
DESTS=$(printf 'header = "Authorization: Bearer %s"\n' "$CFTOK" | curl -s --config - \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/email/routing/addresses")
VERIFIED_LIST=$(echo "$DESTS" | node -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const verified = (d.result || []).filter(a => a.verified).map(a => a.email);
console.log(verified.join('\n'));
")
```

- **No verified destination** → ask:
  > Which mailbox do you want to forward `<prefix>@<domain>` to? (e.g. `youremail@gmail.com`)

- **A single verified destination** → propose:
  > I see you already have `<email>` configured as a destination. Shall I forward `<prefix>@<domain>` to it?
  >
  > (or give me another address if you prefer)

- **Several verified destinations** → menu:
  > You already have several destinations configured. Which one should `<prefix>@<domain>` forward to?
  >
  > 1. `<email1>`
  > 2. `<email2>`
  > …
  > N. A new address

Store it in `<dest>`.

---

## Step 7 - Make sure the destination is verified

Re-check in `$DESTS` whether `<dest>` is present AND `verified` is not null.

**If already verified** → move on to Step 8.

**Otherwise (new destination or unverified destination)**:

```bash
VAULT="${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs"
CFTOK=$(node "$VAULT" get CLOUDFLARE api_token)
printf 'header = "Authorization: Bearer %s"\n' "$CFTOK" | curl -s --config - -X POST \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"<dest>\"}" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/email/routing/addresses"
```

Then:

> 📬 Cloudflare has just sent a verification email to `<dest>`. Go click the link in that email (remember to check the spam folder), then tell me "done" so I can continue.

**Wait for the user's explicit confirmation.** Do not proceed until they have confirmed (otherwise creating the rule may fail or the rule may be inactive).

---

## Step 8 - Create the forwarding rule

### Literal rule (exact prefix)

```bash
VAULT="${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs"
CFTOK=$(node "$VAULT" get CLOUDFLARE api_token)
printf 'header = "Authorization: Bearer %s"\n' "$CFTOK" | curl -s --config - -X POST \
  -H "Content-Type: application/json" \
  -d "{\"enabled\":true,\"name\":\"Route <prefix> to <dest>\",\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"<prefix>@<domain>\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"<dest>\"]}]}" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules"
```

### Catch-all rule (if the user asked for `*`)

```bash
VAULT="${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs"
CFTOK=$(node "$VAULT" get CLOUDFLARE api_token)
printf 'header = "Authorization: Bearer %s"\n' "$CFTOK" | curl -s --config - -X POST \
  -H "Content-Type: application/json" \
  -d "{\"enabled\":true,\"name\":\"Catch-all to <dest>\",\"matchers\":[{\"type\":\"all\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"<dest>\"]}]}" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules"
```

Parse the response to confirm the record was created (`result.id` present).

---

## Step 8 (bis) - Declare the email relay

Every message sent to this address travels through Cloudflare before reaching the
destination mailbox. Content, sender, recipient: that is a processing of personal
data, and no other step declares it.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add cloudflare
```

Run it from the project root when this address belongs to a project that has a
privacy policy. If you are not in that project right now, do not go hunting for
it: `/rgpd-audit` asks the question on its own and updates the page. The `cloudflare` entry is flagged `manuallyDeclared`: DNS and
email routing leave no trace in the repository, so the RGPD audit cannot detect
them and must never suggest removing the entry.

## Step 9 - Confirm + test

> ✅ **Address created!** Emails sent to **`<prefix>@<domain>`** will be forwarded to **`<dest>`**.
>
> **Test it right now:** send an email (from an address other than `<dest>`) to `<prefix>@<domain>`. You should receive it in the `<dest>` mailbox within a few seconds.
>
> **If nothing arrives after a few minutes**: check your spam folder, and take a look in your Cloudflare dashboard → **Email** → **Email Routing** → **Routing rules** to see whether the rule is properly `Enabled`.

**If the user wants to add another address right away**, propose:

> Do you want to create another address on `<domain>`? Just tell me the prefix and I will start over (I keep `<dest>` as the default destination).

If yes → loop back to Step 5 (we skip steps 1-4 which are already OK).


---

## Resource manifest (always)

Every cloud resource this skill creates or adopts is recorded in the project resource manifest (`.hypervibe/resources.json`, versioned with the code) - it is what `/save-project` and `/delete-project` read first, instead of guessing resources by name. Run the recording right after the resource exists; it is idempotent, silent on success, and stores identifiers only (never secrets). Full reference: the `_track-resource` skill.

Record the routing rule:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/manifest/manifest.mjs" add --project-dir "<project-root>" \
  --kind email-route --name "<address@domain>" --field zone=<apex-domain> --added-by new-email-address
```
