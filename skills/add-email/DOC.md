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

3. **Prerequisite check**: your email account's key, stored once in the vault (item `RESEND`, created at resend.com/api-keys, or item `BREVO`). It stays there, for the gestures on the account itself (your sending domain, your senders, and at Resend the projects' keys): no project ever holds it.
   - **The project's own sending key**: for Resend, Hypervibe makes it for you through Resend's API; it can only send, and once your sending domain is verified, only from that domain. For Brevo, whose API makes no key, you make it in Brevo's console under the project's name, and paste it in a masked window that puts it in the project only.
   - Either way, if one project's key leaks (a `.env` seen on a screen, a repository or a hosting that leaks), only that project's sending is exposed: never your whole account, its domains and contacts, nor your other projects.

4. **SDK install + scaffolding**:
   - The appropriate SDK is installed (`resend` or `@getbrevo/brevo`)
   - A `src/server/mail.ts` file is created with a reusable `sendMail()` function + all the guards (`escapeHtml` for Resend, `escapeForBrevo` for Brevo, which has a silent Mustache templating quirk)
   - A `contact` tRPC router is added to handle the contact form on the server side (anti-spam honeypot, rate limiting, sanitization), when the email is meant for a contact form and the project already has its rate limiting; otherwise the contact page adds it later

5. **Environment variables**: the right keys are pushed to `.env` + Vercel.

6. **Sending address (optional)**: for Resend, you start on `onboarding@resend.dev` (test address) and Hypervibe offers to configure your domain (add DNS records in Cloudflare, automatic Resend verification). For Brevo, you provide your sender from the start, and Hypervibe creates it at Brevo through its API when your account does not have it yet, then checks that it is active.

7. **Contact page (optional)**: at the end, Hypervibe offers to create a working `/contact` page (Name, Email, Message form + react-hook-form + zod, responsive). It asks where the messages should arrive, preferably a real inbox rather than an address your domain only forwards elsewhere (that relay can send them to spam): if you insist on such an address, it says so once more, then keeps it.

## What it creates for you

- An **own sending key** for the project (Resend: made through its API, sending only; Brevo: made in its console under the project's name), in `.env` and at the hosting, recorded in the project's manifest: `/rotate-secret` renews it, `/delete-project` revokes it. Your account's key stays in the vault.
- The appropriate SDK installed (`resend` or `@getbrevo/brevo` v5+)
- `src/server/mail.ts` with `sendMail()` + escaping helper (`escapeHtml` or `escapeForBrevo`)
- A `contact` tRPC router (`src/server/api/routers/contact.ts`) for the form
- The necessary env variables (`RESEND_API_KEY` + `RESEND_FROM_EMAIL`, or `BREVO_API_KEY` + `BREVO_SENDER_EMAIL` + `BREVO_SENDER_NAME`) in `.env` + Vercel
- For Brevo: a `## Email - Brevo quirk` section in your project `CLAUDE.md` (a reminder of the silent templating trap)
- If you want: your **domain configured in the provider** with the DNS records added to Cloudflare
- If you want: a complete, working **`/contact` page**

## Prerequisites

- The project must be in Next.js with tRPC (typically initialized by `/bootstrap`)
- Your email account's key stored in the **vault**: either Resend (item `RESEND`, 3000 emails/month) or Brevo (item `BREVO`, 300/day ≈ 9000/month). `/add-email` detects it automatically and, if it is missing, guides you to create it and store it in the vault. It never leaves it: the project gets a key of its own.
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

{{callout:warning|Projects set up before version 3.4.16}}
They may hold your account's key itself. Re-run `/add-email` in each of them: it notices it and gives the project its own key. Once every project has its own, renew your account's key at the provider (Resend: API Keys; Brevo: SMTP & API, API keys), store the new one in your vault, and have `/quotas` register its alert again (the shared clock keeps a copy of the account's key to send it): the old copies of the account's key (in `.env` files, at the hosting, in recordings) then stop working.
{{/callout}}

{{callout:info|How to switch provider}}
If you installed Resend and want to move to Brevo (or vice versa): delete the current config (key in `.env` + the files `src/server/mail.ts` + `src/server/api/routers/contact.ts`), make sure you have the target provider's key in the vault (item `RESEND` or `BREVO`), then re-run `/add-email`. The skill will install the new provider cleanly.
{{/callout}}
