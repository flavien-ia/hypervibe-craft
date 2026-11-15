# /new-email-address

Creates a **new receiving address** on a domain that is already connected (for example `support@mysite.com` forwarded to your Gmail).

## When to use it

- You have connected your domain via `/add-domain` and you want to create several addresses (`contact@`, `support@`, `hello@`, `info@`…)
- You want to receive emails on your domain without creating a real mailbox
- You want to create a **catch-all** (`*@mysite.com` that forwards everything to a single mailbox)

## How it works

1. **Cloudflare check**: Hypervibe checks that your Cloudflare token is valid. Otherwise, it sends you to `/start`.

2. **Domain identification**: Hypervibe looks in your project's `CLAUDE.md` to retrieve the already connected domain. If it cannot find it, it asks you.

3. **Email Routing activation**: Hypervibe quietly enables Email Routing on your Cloudflare zone (idempotent, no problem if it is already active). On the first pass, Cloudflare automatically adds the necessary MX + SPF records.

4. **Alias prefix**: Hypervibe asks you for the prefix you want (the part before the `@`), for example `support`, `hello`, `info`, `contact`, `hi`, `me`. You can also answer `*` or "all" to create a catch-all.

5. **Destination**:
  - If Hypervibe was already called from `/add-domain` and you provided a destination address, it is reused.
  - Otherwise, Hypervibe lists your already verified destinations (if there are any) and offers to reuse them, or to add a new one.
  - If it is a new destination, Cloudflare sends it a verification email, you must click the link in your mailbox, then tell Hypervibe "done".

6. **Rule creation**: Hypervibe creates the forwarding rule in Cloudflare. From now on, emails received at `<prefix>@<domain>` are forwarded instantly to your target mailbox.

7. **Test**: Hypervibe offers to test by sending an email to the new address from another mailbox. If there are several addresses to create, Hypervibe loops back to save time.

## What it creates for you

- A **new forwarding rule** in Cloudflare Email Routing
- If it is the first time on this domain: **Email Routing enabled** + MX/SPF records added automatically
- If it is a new destination: an email to verify in your mailbox

## Prerequisites

- Your domain must already be managed by Cloudflare (typically after `/add-domain`)
- Cloudflare connected to your computer (`/start` takes care of that)

## Tips

{{callout:tip|Catch-all = handy so you never miss anything}}
If you want to **receive everything** on your domain (`anything@mysite.com` → your mailbox), answer `*` when Hypervibe asks you for the prefix. This is handy if you give your address in different forms to different services (`amazon@mysite.com` for Amazon, `netflix@mysite.com` for Netflix, etc.). You instantly know who shared your email if you receive spam.
{{/callout}}

{{callout:info|You reply from your usual mailbox}}
Email Routing only **receives** emails. To **send** from your domain (`contact@mysite.com`), you need to set up a service like Resend (`/add-email`) or add your domain in Gmail/Outlook as a sending alias.
{{/callout}}

{{callout:warning|Check your spam on the first add}}
The first time you use a destination, Cloudflare sends a verification email, it sometimes lands in your mailbox's spam folder. Remember to check before telling Hypervibe "done", otherwise the rule will not work.
{{/callout}}

{{callout:info|A Cloudflare key made before this version}}
Turning Email Routing on through Cloudflare needs one permission that keys made by earlier versions of Hypervibe do not have: **Zone Settings** (Edit). If Cloudflare refuses for that reason, Hypervibe says so and offers two ways out: add that permission to your key on Cloudflare (a minute, the key keeps its value), or turn Email Routing on once yourself in the Cloudflare dashboard. Keys made from now on include it.
{{/callout}}
