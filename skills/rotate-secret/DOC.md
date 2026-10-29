# /rotate-secret

Renews a secret key everywhere it lives, locally and online, in a single command. Stripe, Resend, Google, GitHub OAuth, internal secrets: Hypervibe guides you based on the type of key.

## When to use it

- You **suspect a leak** of one of your keys (accidental commit to a public repo, shared screenshot, etc.)
- A **collaborator is leaving** your organisation and you want to revoke their indirect access
- You are doing a **periodic rotation** for security hygiene (every 3-6 months on critical services)

## How it works

1. **Identifying the secret**: you can pass the key name as an argument (`/rotate-secret stripe`) or Hypervibe shows you a list of the secrets currently present in your `.env` and you pick one.

2. **Secret type**: Hypervibe detects whether it is:
  - **A third-party key** (Stripe, Resend, Google OAuth, GitHub OAuth, Brevo, etc.) -> it needs to be regenerated on the provider's side
  - **A self-managed secret** (CRON_SECRET, AUTH_SECRET, etc.) -> Hypervibe can regenerate it on its own

3. **For a third-party key**: Hypervibe guides you **click by click** through the relevant provider's dashboard:
  - **Stripe**: dashboard.stripe.com/apikeys -> Roll key
  - **Resend**: resend.com/api-keys -> Revoke + Create new
  - **Google OAuth**: Google Cloud Console -> credentials -> reset secret
  - **GitHub OAuth**: github.com/settings/developers -> your app -> Generate a new client secret
  - Etc.
   
   A small window then opens on your machine: you paste the new value there, never into the conversation. It goes straight into `.env` and the hosting.

4. **For a self-managed secret**: Hypervibe generates a new cryptographically strong value itself, without asking you anything.

5. **Push everywhere**:
  - Updates the local `.env`
  - Updates Vercel (production + preview)
  - Idempotent: the **old value is overwritten**, not just added alongside it

6. **Verification**: Hypervibe offers to test it immediately (for example: `pnpm dev` + a Stripe checkout test if it was a Stripe key).

## What it creates for you

- A **new value** for the chosen secret
- **Updated everywhere**: local `.env` + Vercel (production + preview)
- The **old value** revoked at the provider (you did this in the dashboard during step 3)
- Minimal downtime: for most providers you create the new key alongside the old one, so there is no interruption; for a few (for example the Stripe webhook secret or a database password) the old value is invalidated the moment you regenerate it, leaving a brief window until the new value is pushed and redeployed

## Prerequisites

- You must be inside an existing project (with a `.env` or an active Vercel integration)
- For third-party keys: access to your account at the provider (Stripe, Resend, etc.)

## Tips

{{callout:tip|Do it without hesitation when in doubt}}
If you have the slightest doubt about the security of a key (a screenshot shared by mistake, a suspicious commit, a former collaborator who might have seen the screen...), **renew it immediately**. It only takes a few minutes, and the consequences of a compromised key (notably Stripe for payments) can be disastrous.
{{/callout}}

{{callout:info|Periodic rotation = good hygiene}}
For the most critical keys (Stripe, AUTH_SECRET, admin keys): consider renewing them every 3-6 months even without any suspicion of a leak. It is a safeguard against silent leaks (an old commit on a public repo, an env variable that may have leaked into logs, etc.).
{{/callout}}

{{callout:warning|Webhook secrets = specific procedure}}
For `STRIPE_WEBHOOK_SECRET` or other webhook secrets, the rotation is a bit more subtle: you need to recreate the webhook on the provider's side, and the key is different between local (CLI `stripe listen`) and production. Hypervibe knows this and guides you depending on the case (it does not touch the local `.env` when you rotate the prod webhook, and vice versa).
{{/callout}}
