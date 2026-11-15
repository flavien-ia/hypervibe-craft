# /security

Audits the security of your app and automatically fixes common flaws. Hypervibe covers 13 risk categories (exposed secrets, poorly protected routes, vulnerable dependencies, forged webhooks, booby-trapped links, etc.) with a plain-language explanation for each finding.

## When to use it

- **Before going to production** on a public domain
- After adding a critical feature (payments, auth, file uploads)
- Periodically (every 2-3 months) to stay up to date

## How it works

1. **Disclaimer displayed at the start**: Hypervibe reminds you that this is an audit of common flaws. For apps that handle very sensitive data (health, banking, critical data), a professional security audit is still necessary.

2. **Audit across 13 categories**:
  - **Secrets and env variables**: search for hardcoded keys/tokens in the code, check the `.gitignore`, verify that secrets are not committed in the Git history
  - **Authentication and access control**: verify that admin/protected pages are not accessible without login, that access rules are enforced server-side, that each user can only reach their own data (not someone else's by changing an id in the request), and that changing the email, the password or deleting the account asks for the current password
  - **Input validation**: verify that user data is validated server-side (zod, etc.), including file uploads (type and size)
  - **SQL injection and database queries**: verify that queries are parameterized (no string concatenation)
  - **Security headers**: CSP, HSTS, X-Content-Type-Options, etc. The CSP Hypervibe sets on every site has two parts: a base, enforced, that blocks nothing the site loads, and a script policy that only reports, in the browser's console, what it would block. An older project receives it through the fixes. Making it blocking stays your decision, once those reports are read, and the audit never does it on its own; a CSP you wrote yourself is never touched
  - **CORS**: cross-origin request configuration
  - **Vulnerable dependencies**: `npm audit` on production dependencies, including the framework itself
  - **Rate limiting and abuse protection**: protection against brute force and abuse (e.g. on login)
  - **Data exposure**: verify that API responses and logs do not leak sensitive data, and that sign-up or "forgot my password" do not reveal whether someone has an account
  - **Next.js configuration**: safe framework settings (no secrets in client bundles, etc.)
  - **Webhooks**: verify that notifications sent by third-party services (e.g. Stripe after a payment) are authenticated, so nobody can forge a fake "payment received"
  - **Server-side requests (SSRF)**: verify that your server cannot be tricked into calling internal addresses through a user-provided URL, push notifications included
  - **Links and redirections**: verify that an address slipped into a link (`?callbackUrl=...`) can neither send your visitors to another site, nor run code at the moment they sign in

3. **Educational report**: each finding is classified ✅ OK / ⚠️ To improve / 🔴 Critical. For each problem:
  - **Plain-language explanation** ("XSS = an attack where someone injects malicious code into a page that other people visit")
  - **Concrete consequence** ("if someone exploits this flaw, they can steal your visitors' cookies")
  - **Proposed fix** with the **why** of the fix, not just the code

4. **Automatic fixes**: Hypervibe fixes what can be fixed safely (adding headers, fixing the code, updating vulnerable dependencies). For the rest, it shows you the diff and you approve it.

## What it creates for you

- A **complete security report** with verdicts and explanations
- **Fixes applied** automatically (with your approval for behavior changes)
- A potential update to `CLAUDE.md` with the project's security conventions

## Prerequisites

- No particular prerequisite, `/security` can run on any project in the plugin

## Tips

{{callout:warning|Does not replace a professional audit for sensitive cases}}
If your app handles medical, financial, or very personal data (e.g. identity, biometrics), a professional audit is still essential. `/security` covers 95% of common mistakes but does not replace an expert who digs into the business cases specific to your field.
{{/callout}}

{{callout:tip|Run it regularly}}
Vulnerabilities evolve quickly (new flaws in npm packages every week). Running `/security` every 2-3 months is good hygiene. Hypervibe proposes automatic updates for critical and high-severity flaws.
{{/callout}}

{{callout:info|Not alarmist}}
Hypervibe is designed to **explain**, not to scare you. You see each problem with its concrete consequence, but also the real severity (a showcase site with no form does not have the same risks as a site with auth + payments). You prioritize what really matters.
{{/callout}}
