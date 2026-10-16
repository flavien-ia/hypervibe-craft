# /add-email

Enables **transactional email sending** from your app, via Resend or Brevo. For contact forms, confirmations, notifications, welcome emails, etc.

## When to use it

- You want to add a **contact form** to your site
- You want to send automatic emails to your users (signup confirmation, forgotten password, event notification)
- You want to send emails from your own domain (`contact@mysite.com`) rather than from a third-party service

## Resend or Brevo?

The skill **handles both providers** and chooses automatically, without asking, based on what you already have:

| Your env variables | Provider installed | Note |
|---|---|---|
| None | **Resend by default** | You will create the key afterwards, the skill tells you how |
| `RESEND_API_KEY` only | Resend | silent |
| `BREVO_API_KEY` only | Brevo | silent |
| Both | **Brevo by default** | Mentioned in the final summary so you can switch if needed |

{{callout:info|Why these defaults}}
**Resend** is the default when starting from scratch: modern DX (polished Next.js integrations), a free tier of 3,000 emails/month, easy to get started. **Brevo** takes over when both keys are present because it is a European service with built-in CRM and email marketing - typical of a more advanced "pro" stack. In both cases, you can switch manually by deleting the config and re-running `/add-email`.
{{/callout}}

## How it works

1. **Check**: Hypervibe looks at whether a provider is already configured in THIS project. If so, a menu offers to change the sending address, the recipient, create a `/contact` page, or start over - **without switching provider** (Resend stays Resend, Brevo stays Brevo).

2. **Automatic provider choice** (for a fresh install): a decision rule based on your env keys (see the table above). No question asked.

3. **Prerequisite check**:
   - For Resend: a Resend API key stored in the vault (item `RESEND`) - created once at resend.com/api-keys
   - For Brevo: a Brevo API key (vault `BREVO`, or `BREVO_API_KEY` in the session)

4. **SDK install + scaffolding**:
   - The appropriate SDK is installed (`resend` or `@getbrevo/brevo`)
   - A `src/server/mail.ts` file is created with a reusable `sendMail()` function + all the guards (`escapeHtml` for Resend, `escapeForBrevo` for Brevo, which has a silent Mustache templating quirk)
   - A `contact` tRPC router is added to handle the contact form on the server side (anti-spam honeypot, rate limiting, sanitization), when the email is meant for a contact form and the project already has its rate limiting; otherwise the contact page adds it later

5. **Environment variables**: the right keys are pushed to `.env` + Vercel.

6. **Sending address (optional)**: for Resend, you start on `onboarding@resend.dev` (test address) and Hypervibe offers to configure your domain (add DNS records in Cloudflare, automatic Resend verification). For Brevo, you provide your sender from the start, and Hypervibe creates it at Brevo through its API when your account does not have it yet, then checks that it is active.

7. **Contact page (optional)**: at the end, Hypervibe offers to create a working `/contact` page (Name, Email, Message form + react-hook-form + zod, responsive). It asks where the messages should arrive: a real inbox, never an address your domain only forwards elsewhere (that relay can send them to spam).

## What it creates for you

- Depending on the chosen provider: a **Resend** or **Brevo API key**, read from the vault (item `RESEND` or `BREVO`)
- The appropriate SDK installed (`resend` or `@getbrevo/brevo` v5+)
- `src/server/mail.ts` with `sendMail()` + escaping helper (`escapeHtml` or `escapeForBrevo`)
- A `contact` tRPC router (`src/server/api/routers/contact.ts`) for the form
- The necessary env variables (`RESEND_API_KEY` + `RESEND_FROM_EMAIL`, or `BREVO_API_KEY` + `BREVO_SENDER_EMAIL` + `BREVO_SENDER_NAME`) in `.env` + Vercel
- For Brevo: a `## Email - Brevo quirk` section in your project `CLAUDE.md` (a reminder of the silent templating trap)
- If you want: your **domain configured in the provider** with the DNS records added to Cloudflare
- If you want: a complete, working **`/contact` page**

## Prerequisites

- The project must be in Next.js with tRPC (typically initialized by `/bootstrap`)
- An email key stored in the **vault**: either Resend (item `RESEND`, 3000 emails/month) or Brevo (item `BREVO`, 300/day ≈ 9000/month). `/add-email` detects it automatically and, if it is missing, guides you to create it and store it in the vault.
- To configure a custom domain: your domain must be managed by Cloudflare (otherwise run `/add-domain` first)

## Tips

{{callout:warning|Resend - test address = only you receive the emails}}
By default, `RESEND_FROM_EMAIL` is `onboarding@resend.dev` (Resend test address). With this address, **emails can only go to YOUR own address** (the one on your Resend account). It is perfect for checking that everything works, but not enough to send to your users. To send to anyone, configure your domain (Hypervibe offers this at the end of the skill).
{{/callout}}

{{callout:warning|Brevo - an active sender}}
On the Brevo side, the sender email (`BREVO_SENDER_EMAIL`) must be an **active sender**. Hypervibe creates it through Brevo's API when your account does not have it, and reads its state: on a domain Brevo has authenticated, it is active right away; otherwise Brevo sends a confirmation message to that address, to open once. Without an active sender, emails fail silently - Brevo accepts the request but does not deliver.
{{/callout}}

{{callout:tip|Free plans}}
- **Resend**: 3,000 emails/month, 100/day
- **Brevo**: 300 emails/day (≈ 9,000/month)

More than enough to get started in both cases. Brevo is more generous on monthly volume, Resend has a slightly smoother DX.
{{/callout}}

{{callout:info|How to switch provider}}
If you installed Resend and want to move to Brevo (or vice versa): delete the current config (key in `.env` + the files `src/server/mail.ts` + `src/server/api/routers/contact.ts`), make sure you have the target provider's key in the vault (item `RESEND` or `BREVO`), then re-run `/add-email`. The skill will install the new provider cleanly.
{{/callout}}
