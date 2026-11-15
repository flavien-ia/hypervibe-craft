---
name: add-analytics
description: Add Google Analytics (GA4) to an existing Next.js project. Includes RGPD cookie consent banner.
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Add Analytics - Google Analytics (GA4)

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Adds Google Analytics tracking to the current project with RGPD-compliant cookie consent. Can be called by `/bootstrap` or standalone on an existing project.

---


## Step 0 - Preflight: is Analytics already configured?

**First of all**, invoke `_check-deps analytics` to detect whether GA4 is already in place:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" analytics)
analytics_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).analytics.ok)")
ga_id=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).analytics.gaId || '')")
```

### If `analytics_ok = true` -> re-configuration mode

GA4 is already in place (ID: `$ga_id`). Do NOT recreate the `<GoogleAnalytics>` and `<CookieConsent>` components, nor rewrite the layout. Show a menu:

> ## 📊 Google Analytics is already in place (ID: **$ga_id**)
>
> What do you want to do?
>
> 1. **Switch GA property** (you created a new GA4 property, or you are migrating to another Google Analytics account) - I just replace the `NEXT_PUBLIC_GA_MEASUREMENT_ID`
> 2. **Reinstall the cookie consent banner** (if the component was deleted by accident or is broken)
> 3. **Reinstall the GoogleAnalytics component** (same thing, if deleted or broken)
> 4. **Exclude admin routes / authenticated areas from tracking** - so that admin and logged-in client sessions are no longer counted as discovery traffic (fixes the pollution of acquisition stats)
> 5. **Set up a regular email report** - I guide you through enabling GA4 scheduled reports (you receive your statistics in your inbox every week or every month, without having to open GA4)
> 6. **Redo everything from scratch** (only useful if the configuration is completely broken - first remove `NEXT_PUBLIC_GA_MEASUREMENT_ID` from the local `.env` and the `GoogleAnalytics.tsx` / `CookieConsent.tsx` components)
> 7. **Something else** - tell me what you want

Wait for the answer.

**Depending on the answer**:

| Choice | Action |
|---|---|
| 1 (switch GA_ID) | Ask for the new GA_ID (format `G-XXXXXXXXXX`). Validate that it starts with `G-`. Push via `_push-env-vars`. Remind the user that the change becomes visible in GA4 within 24-48h (tag propagation). |
| 2 (reinstall cookie banner) | Re-run only the "Create CookieConsent banner" section (Step 5 of the nominal flow). Do not touch the rest. |
| 3 (reinstall GoogleAnalytics) | Re-run only the "Create GoogleAnalytics component" section (Step 4 of the nominal flow). |
| 4 (exclude admin / authenticated) | **Retrofit the exclusion onto an existing component** - see the procedure below. |
| 5 (email report) | Jump straight to **Step 9** (guidance for enabling GA4 scheduled reports). |
| 6 (redo everything) | Abort: ask the user to clean up manually, then re-run. |
| 7 (something else) | Ask for details. Do not launch the full flow by default. |

#### Choice 4 - Retrofit the admin / authenticated exclusion

Locate the existing component (`GoogleAnalytics.tsx`, often under `src/components/` or `src/components/shared/`) and upgrade it to the **Step 4** version:

1. Read the current `GoogleAnalytics.tsx`.
2. If it is still the old version (no `EXCLUDED_PREFIXES` and no `usePathname`), **replace its entire contents** with the Step 4 component (keeping the import path of `NEXT_PUBLIC_GA_MEASUREMENT_ID` and the file location). If it already has `EXCLUDED_PREFIXES`, do not rewrite it - just adjust the list.
3. Follow the **"To do after creating the component - offer to broaden the exclusion"** block of Step 4 to detect and (on confirmation) add the authenticated areas (dashboard, members area, account) to `EXCLUDED_PREFIXES`.
4. Verify: `pnpm tsc --noEmit && pnpm lint`.
5. Remind the user that the effect is immediate on the code side, but that the data already collected in GA4 is not retroactively cleaned (only new admin/client sessions stop being counted).

**At the end**, jump straight to the **final summary**.

### If `analytics_ok = false` (not yet configured)

Continue normally to Step 1. This is the initial installation flow.

---

## Step 1 - Prerequisite: final domain

**Ideally, run `/add-analytics` AFTER configuring the final domain via `/add-domain`.** Otherwise the GA4 web data stream will point to the Vercel URL, and you will have to update it later in GA4 (possible but tedious). Before asking for the ID, check:
- If `NEXT_PUBLIC_APP_URL` points to a `.vercel.app` -> warn the user and offer: (a) do `/add-domain` first (recommended), (b) continue anyway with the Vercel URL and update the GA4 web data stream later.
- If `NEXT_PUBLIC_APP_URL` points to a custom domain -> continue.

## Step 2 - Get the Measurement ID

**Teaching rule**: the audience is often new to this. Before asking anything, explain the two key concepts the user will run into in Google Analytics (property + measurement ID). Use these definitions as-is (with an analogy):

> Before getting the ID, two words to know about Google Analytics:
>
> - **A property** - this is the "record" of a site in Google Analytics. One site = one property. If you have several sites to track (a portfolio + a shop + a blog), you will have **one property per site**, all stored together in your Google Analytics account. Analogy: if your Google Analytics account is a binder, each property is a folder that holds the statistics of one specific site.
>
> - **The measurement ID** (*Measurement ID*, format `G-XXXXXXXXXX`) - this is the **unique number of the property**. It is the one we will paste into your code so that your site sends its visit data to Google Analytics. Without this ID, Google Analytics does not know that it is your site talking. Analogy: it is like the barcode on the box - it links each recorded visit to the right property (the right site).
>
> All you have to do is grab this ID and paste it here. I take care of all the rest.

Then guide the creation, clearly distinguishing the two cases:

**Adapt the guide to the site URL**: replace `<URL_DU_SITE>` below with the value of the project's `NEXT_PUBLIC_APP_URL` (for example `https://cool-trattoria.vercel.app` or a custom domain if already configured). Also replace `<NOM_DU_SITE>` with a short name suited to the current project.

> **If you have never used Google Analytics:**
>
> 1. Go to https://analytics.google.com/
> 2. Click **"Start measuring"**
> 3. **Account name**: your name or your company's - it is the global container, you will be able to put several properties in it (one site each) later. Click **"Next"**.
> 4. **Property name**: `<NOM_DU_SITE>` (the name of the site we are configuring now). Click **"Next"**.
> 5. The next screens ask you a few things about the context (**country**, **currency**, **industry category**, **business size**, **business objectives**). Choose whatever best matches your activity, it has no impact on the tracking itself - it is just to help Google personalize the default reports. Continue all the way through by clicking **"Next"** on each screen.
> 6. At the **"Start collecting data"** screen, choose the **Web** platform (and not Android or iOS - it really is a website that we are tracking).
> 7. In the screen that opens (**"Set up data stream"**):
>    - **Website URL**: `<URL_DU_SITE>`
>    - **Stream name**: `<NOM_DU_SITE>` (use the same name as the property, it keeps things simple)
>    - Click **"Create and continue"**
> 8. A window opens with a snippet of code to install manually. **Close this window** (cross in the top right) - no need to copy this code, I handle the integration myself.
> 9. You then land on the **"Web stream details"** screen. That is where the **measurement ID** appears (format `G-XXXXXXXXXX`, toward the top right of the page). Copy it and paste it here.
>
> **If you already have a Google Analytics account** (another site is already tracked in it):
>
> 1. Go to https://analytics.google.com/
> 2. Menu at the bottom left -> **Admin** (gear icon)
> 3. **"+ Create"** button -> choose **"Property"** (you create a new record for your new site, in your existing account)
> 4. **Property name**: `<NOM_DU_SITE>`. Click **"Next"**.
> 5. As with a first-time creation, the next screens ask you a few contextual things (**country**, **currency**, **industry category**, **business objectives**). Choose whatever best matches, continue with **"Next"**.
> 6. At the stream configuration screen, choose the **Web** platform.
> 7. **Website URL**: `<URL_DU_SITE>` - **Stream name**: `<NOM_DU_SITE>` - then **"Create and continue"**.
> 8. Close the window with the code snippet (no need, I handle it).
> 9. On the **"Web stream details"** screen, copy the **measurement ID** (`G-XXXXXXXXXX`) and paste it here.

**Do not proceed until the user provides the ID.**

## Step 3 - Push env var

Invoke `_push-env-vars` with:
- `NEXT_PUBLIC_GA_MEASUREMENT_ID=G-XXXXXXXXXX`

The helper writes to `.env` local AND pushes to Vercel (all 3 environments).

## Step 4 - Create GoogleAnalytics component

Create a `GoogleAnalytics` component (location depends on project structure - e.g. `src/components/GoogleAnalytics.tsx` or `src/components/shared/GoogleAnalytics.tsx`):

```typescript
"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Route prefixes excluded from Google Analytics.
 * No page whose path starts with one of these prefixes is tracked
 * (neither on direct load, nor on internal navigation). By default: the admin.
 *
 * Add your authenticated routes here if you want to keep them out of the
 * acquisition stats (admin/client sessions are not discovery traffic),
 * for example: "/dashboard", "/espace-membres", "/compte".
 */
const EXCLUDED_PREFIXES = ["/admin"];

function isExcludedPath(pathname: string | null) {
  if (!pathname) return false;
  return EXCLUDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Sends a `page_view` on each internal navigation (SPA), skipping
 * the first one (already emitted by the inline script) and the excluded routes.
 * Coupled with `send_page_view: false` in the config, this is what prevents
 * GA4's enhanced measurement from counting /admin routes
 * reached through internal navigation.
 */
function PageViewTracker() {
  const pathname = usePathname();
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return; // initial page_view already sent by the inline script
    }
    if (isExcludedPath(pathname)) return;
    window.gtag?.("event", "page_view", {
      page_path: pathname,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [pathname]);

  return null;
}

export function GoogleAnalytics() {
  const [consent, setConsent] = useState(false);
  const pathname = usePathname();
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

  useEffect(() => {
    setConsent(localStorage.getItem("cookie-consent") === "accepted");

    const handler = () =>
      setConsent(localStorage.getItem("cookie-consent") === "accepted");
    window.addEventListener("cookie-consent-change", handler);
    return () => window.removeEventListener("cookie-consent-change", handler);
  }, []);

  // No consent, no ID, or excluded route (admin/authenticated area):
  // we do not even load gtag.js -> no session_start nor GA cookie dropped,
  // so no pollution of the acquisition stats by admin/client sessions.
  if (!consent || !gaId || isExcludedPath(pathname)) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${gaId}', { send_page_view: false });
          gtag('event', 'page_view');
        `}
      </Script>
      <PageViewTracker />
    </>
  );
}
```

**Important:** This component listens for `cookie-consent-change` events, so GA loads instantly when the user accepts - no page reload needed.

**Exclusion of admin / authenticated routes.** The component does not trigger GA4 on **any** route listed in `EXCLUDED_PREFIXES` (default: `["/admin"]`):

- **Direct load of an excluded route** (the admin opens `/admin`, refreshes, etc.): `isExcludedPath(pathname)` is true -> the component returns `null` -> `gtag.js` is never loaded -> no `session_start`, no `_ga` cookie, no pollution of the acquisition stats.
- **Internal navigation to an excluded route** (a visitor moves from a public page to `/admin`): the config runs with `send_page_view: false` (enhanced measurement no longer auto-emits a `page_view` on history changes), and `PageViewTracker` skips the excluded paths -> the `/admin` page is never counted.
- The initial `page_view` is emitted by the inline script (reliable, no race with `gtag.js`); `PageViewTracker` only handles subsequent navigations.

**To do after creating the component - offer to broaden the exclusion.** Spot the project's authenticated areas and offer the user to add them to `EXCLUDED_PREFIXES`:

1. Detect the candidate route segments (in bash, adapt `<web-root>`):
   ```bash
   ls -d <web-root>/src/app/admin <web-root>/src/app/\(admin\) \
         <web-root>/src/app/dashboard <web-root>/src/app/espace-membres \
         <web-root>/src/app/compte <web-root>/src/app/account 2>/dev/null
   ```
   (and the variants under `<web-root>/src/app/[locale]/…` if the project is i18n).
2. For each authenticated area found (dashboard, members area, account…), offer in plain language to add it to `EXCLUDED_PREFIXES` so that logged-in client sessions do not pollute the acquisition stats either. Only add the prefixes the user confirms.
   - ⚠️ With i18n routes prefixed by the locale (`/fr/compte`, `/en/account`), a bare prefix like `/compte` will not match. In that case, add the segment without the locale via a looser comparison, or explicitly list the localized prefixes.

**Advanced option - exclude every authenticated session (not just by URL).** If the project wants to exclude *any* page as soon as the user is logged in (and not just fixed URL prefixes), and it uses NextAuth with a `SessionProvider` mounted at the root, you can add a session guard in the component:

```typescript
import { useSession } from "next-auth/react";
// …
const { status } = useSession();
// in the render, in addition to the other guards:
if (status === "authenticated") return null;
```

Only offer this option if a `SessionProvider` already wraps the app (otherwise `useSession` crashes). By default, URL-prefix exclusion is enough and stays simpler.

**Then let Google's addresses through the site's Content-Security-Policy** (the reported part, which only watches: nothing is blocked either way). The list of Google's domains lives in the plugin, never here:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/csp.mjs" preset google-analytics --web-dir "<WEB_DIR>"
```

`state: "written"` or `"current"` → nothing to say. `state: "own"` → the project sets a policy of its own, which the plugin never touches: pass on its `reason` (the domains to add to it by hand) in one sentence. `state: "review"` → pass on its `reason`.

## Step 5 - Create CookieConsent banner

Create a `CookieConsent` component alongside the GoogleAnalytics component, at `src/components/CookieConsent.tsx`.

**Pattern used: shared i18n-aware templates** (preferred over inline code). Hypervibe ships two ready-to-use variants under `templates/cookie-banner/`:

- `plain.tsx`: single-language version (hardcoded FR text)
- `i18n.tsx`: multilingual version (uses `useTranslations("cookies")` + `Link` from `~/i18n/routing`)

And two message files: `messages-fr.json`, `messages-en.json` (key `cookies.*`).

### Procedure

1. **Detect the project's i18n state**: run in bash
   ```bash
   if [ -f "<web-root>/src/i18n/routing.ts" ]; then echo i18n; else echo plain; fi
   ```

2. **Copy the right template**:
   - **plain**: copy `${CLAUDE_SKILL_DIR}/../../templates/cookie-banner/plain.tsx` to `<web-root>/src/components/CookieConsent.tsx`
   - **i18n**: copy `${CLAUDE_SKILL_DIR}/../../templates/cookie-banner/i18n.tsx` to `<web-root>/src/components/CookieConsent.tsx`, then run:
     ```bash
     node "${CLAUDE_SKILL_DIR}/../../scripts/_i18n-merge-messages.mjs" --web-dir <web-root> --feature cookie-banner
     ```
     to merge the `cookies.*` keys into all the project's `messages/<locale>.json` files (with EN fallback for the locales we do not ship).

3. **Adjust the colors**: both templates have a `bg-black/90` background and an "Accept" button `bg-white text-black`. Replace with the project's colors:
   - Look in `globals.css` or the project's `CLAUDE.md` for the main accent color
   - Replace `bg-white` (on the accept button) with the accent class. Dark text on a light accent, white on a dark accent.

**Important**: **NEVER** mention a specific tool in the message (no "Google Analytics", "Meta Pixel", etc.) - the generic wording must stay valid even if the user adds other tracking tools later. This is already the case by default in the templates ("audience measurement").

### Component detail (for reference - do not rewrite by hand, copy the template)

**Design rules**:
- Small popup in the **bottom-left corner** (not a full-width bar)
- Max width `max-w-sm`, rounded `rounded-xl`, with backdrop blur
- Text in `text-xs`, discreet and light
- Link to privacy policy page using `Link` (next/link in single-language, next-intl `~/i18n/routing` in multilingual)
- Two buttons: refuse (outline/ghost) and accept (filled with project accent color)
- Both buttons must have `cursor-pointer` class
- Background: semi-transparent dark matching the site's dark color

**Why `dispatch` also on `refuse()`**: if a previous session accepted and loaded GA, then the user refuses, the dispatched event lets `GoogleAnalytics` (or any future tracker) react (stop sending events, clean the dataLayer). Refusing without a dispatch would leave the previously loaded tracker in zombie mode until the next reload.

**`openCookiePreferences()` helper**: exposed for the footer / settings page, it lets you reopen the banner. The CNIL requires that withdrawing consent be as easy as giving it, so a "Manage cookies" link in the footer is the minimum.

**Adapt the link to the privacy policy**: by default the template points to `/politique-de-confidentialite` (the path created by `/bootstrap`). In i18n mode, the `Link` from `~/i18n/routing` automatically prefixes the locale. If the project uses a different path (e.g. `/privacy`), adjust the `href`.

## Step 6 - Add to root layout

Add both components to the root layout, before `</body>`:

```typescript
import { GoogleAnalytics } from "~/components/GoogleAnalytics";
import { CookieConsent } from "~/components/CookieConsent";

// Before </body>:
<GoogleAnalytics />
<CookieConsent />
```

## Step 6.5 - Add "Manage cookies" link to the footer (RGPD requirement)

**This is legally required.** The CNIL mandates that the user must be able to withdraw consent at any time, with the same level of effort as giving it. A discreet link in the footer fulfills this obligation.

Locate the project's footer component (typically `src/components/layout/footer.tsx`, `src/components/Footer.tsx`, or similar). Add a button alongside the other legal links (e.g. next to "Mentions légales", "Politique de confidentialité"):

```tsx
import { openCookiePreferences } from "~/components/shared/CookieConsent";
// (or wherever CookieConsent lives in this project)

// In the footer legal links row:
<button
  type="button"
  onClick={openCookiePreferences}
  className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-primary"
>
  {/* If the project has i18n: */}
  {t("manageCookies")}
  {/* Else: */}
  Gérer mes cookies
</button>
```

**If the project has i18n** : add the translation key to all message files:
- FR: `"manageCookies": "Gérer mes cookies"`
- EN: `"manageCookies": "Manage cookies"`
- JA: `"manageCookies": "Cookieを管理"`
- ES: `"manageCookies": "Gestionar cookies"`
- DE: `"manageCookies": "Cookies verwalten"`

Place it in the same namespace as the other footer legal links (typically `footer.manageCookies`).

**Note** : if the project has no footer yet (rare), skip this step but inform the user - they'll need to add the link manually when they build their footer.

## Step 7 - Update legal pages (RGPD)

**This is mandatory for RGPD compliance.**

Add Google Analytics to the project's RGPD subprocessor registry:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add google-analytics
```

The helper is idempotent. The `google-analytics` key automatically marks the subprocessor as requiring consent (`requiresConsent: true`). If the `politique-de-confidentialite/page.tsx` page exists (created by `/bootstrap`), it updates automatically from the registry.

**If the project has a hand-written privacy policy** (not generated by bootstrap), open it and:
- Replace any "no cookies" / "aucun cookie" mention with the new reality
- Mention that the site uses audience measurement cookies (Google Analytics) dropped only after explicit consent
- Mention that the user can withdraw their consent at any time by clearing the browser cookies
- Add Google to the list of subprocessors if not already present

If the site has i18n, update ALL language files.

## Step 8 - Update CLAUDE.md

Invoke `_update-claude-md` with:
- `stack`: `- **Analytics**: Google Analytics (GA4) with RGPD cookie consent`
- `env-vars`: `- \`NEXT_PUBLIC_GA_MEASUREMENT_ID\` - GA4 Measurement ID`
- `conventions`:
  - `- Tracking with consent: to add a tool that drops cookies (Meta Pixel, Hotjar, LinkedIn Insight Tag, etc.), reuse the pattern of \`GoogleAnalytics.tsx\` - read \`localStorage.cookie-consent === "accepted"\` + listen to the \`cookie-consent-change\` event to load the script conditionally. **Do NOT change the banner wording** to mention the new tool: the "audience measurement" text covers any tracker by default.`
  - `- Analytics exclusion: \`GoogleAnalytics.tsx\` does not trigger GA4 on any route listed in \`EXCLUDED_PREFIXES\` (default \`["/admin"]\`) - gtag.js is not loaded on these routes (no pollution of the acquisition stats by admin/client sessions) and internal navigations to these routes are not counted (\`send_page_view: false\` + \`PageViewTracker\`). To also exclude an authenticated area, add its URL prefix to \`EXCLUDED_PREFIXES\`.`

## Step 9 - Proposal: regular email report (optional)

Once analytics is configured and CLAUDE.md is updated, offer the user to enable GA4's **scheduled email reports**. This is useful to keep an eye on their traffic without having to open Google Analytics every week.

⚠️ **Technical note**: this feature is **100% UI** in Google Analytics. No Google API lets you configure it programmatically. Your added value here is the click-by-click guidance - NEVER claim to have enabled the scheduling yourself.

### 9.a - Intro question

> Do you want to receive a **regular email report** with your statistics (number of visitors, most viewed pages, where visitors come from, etc.) - without having to open Google Analytics?
>
> Google Analytics offers this feature natively, it takes 2 minutes to enable in their interface. I guide you step by step if you want.

Use `AskUserQuestion` with two options:
- **Yes, guide me** -> continue to 9.b
- **Not now** (I will do it later or not at all) -> skip to Step 10, and mention in the summary that the user can enable this later via the GA4 docs.

### 9.b - Step-by-step guidance

Show this procedure as-is (the audience is often new to this, every step counts):

> **Set up a scheduled email report in Google Analytics:**
>
> 1. Go to https://analytics.google.com/ and select your property **via the drop-down list at the top of the page** (if you have several, it is the one we just configured).
> 2. In the left menu, click **Reports**.
> 3. Choose the report you want to receive. To get started, I recommend **"Pages and screens"** (*Engagement* section): it gives you the ranking of your most viewed pages - it is the most useful day-to-day metric.
> 4. At the top right of the report, click the **Share** icon (three small dots connected to each other by lines, like a mini graph).
> 5. Choose **"Schedule email"**.
> 6. Configure:
>    - **Recipients**: your email (add other people if you want - partners, collaborators…)
>    - **Frequency**: **weekly** (every Monday for example) for tight monitoring, or **monthly** if you are starting out and traffic is still light
>    - **Format**: **PDF** (readable directly in your email) or **CSV** (if you want to reuse the data in a spreadsheet)
>    - **Subject and message**: customize them, or leave the default values
> 7. Click **Save**.
>
> You can repeat for other useful reports:
> - **Acquisition > Overview**: where your visitors come from (Google, social media, direct access…)
> - **Engagement > Events**: the interactions on your site (clicks, form submissions if you have configured custom events)
> - **Demographics > Overview**: countries, languages, devices used
>
> Scheduled reports can be edited or deleted from **Admin > Scheduled reports** (at the bottom of the left menu).

### 9.c - Wait for confirmation

> Tell me when it is done - or if you prefer to handle it later, no worries, we can continue.

If the user says "it is done" -> add to the summary the line "📬 GA4 scheduled email report enabled" + continue to Step 10.
If the user says "later" -> mention in the summary that the guidance is available by re-running `/add-analytics` (re-configuration mode).

---

## Step 10 - Summary

Tell the user:
- Google Analytics is installed with RGPD consent
- Tracking only triggers after the cookies are accepted
- The admin routes (`/admin`) are excluded from tracking: no admin session is counted as discovery traffic. If authenticated areas (dashboard, members area, account) were added to the exclusion, remind them here. Specify that the list is set in `EXCLUDED_PREFIXES` at the top of `GoogleAnalytics.tsx`.
- Discreet cookie banner in the bottom left with the project's accent color
- Legal pages updated
- Data visible on https://analytics.google.com/
- To track custom events: `window.gtag?.("event", "event_name", { param: "value" })`
- If scheduled email reports were configured in Step 9: remind that the user can manage their reports in GA4 -> Admin -> Scheduled reports
