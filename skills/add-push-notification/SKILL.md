---
name: add-push-notification
description: "Adds push notifications (Web Push) to a Next.js app. Generates the VAPID keys, creates the subscriptions table, extends the PWA service worker with the push handlers, and adds an 'Enable notifications' button on the user side plus a server-side send helper. DEPENDS on /add-pwa (web push needs the service worker installed by the PWA): if the app is not a PWA, the skill explains this and offers to turn it into a PWA first. Also depends on /add-db and /add-auth (users mode)."
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Add Push Notification: Web Push (PWA)

You add **push notifications** to the current project's app: the user can enable notifications on their device, and the server can send notifications even when the app is closed.

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

---

## Step 0: Re-run? (idempotence)

Detect whether push is already in place: the `hypervibe:push` marker at the top of `<WEB_DIR>/src/server/push.ts`.

```bash
test -f "<WEB_DIR>/src/server/push.ts" && grep -q "hypervibe:push" "<WEB_DIR>/src/server/push.ts" && echo present || echo absent
```

- **present** → first, the version of `web-push` the project carries. A project set up while this skill installed it unpinned may have web-push 4, which `src/server/push.ts` cannot load (no default export): sending fails at run time.

  ```bash
  node -e "const v=require('<WEB_DIR>/node_modules/web-push/package.json').version;console.log(v.split('.')[0]==='3'?'ok':'v'+v)" 2>/dev/null || echo missing
  ```

  Anything but `ok`: run `cd <WEB_DIR> && pnpm add "web-push@^3.6.7" && pnpm add -D "@types/web-push@^3.6.4"` and tell the user in one sentence that the push library goes back to version 3, the one the app's code is written for. Then the menu: (1) reinstall the enable button, (2) regenerate the VAPID keys (warning: invalidates existing subscriptions), (3) resend a test notification. Handle it, then skip to the summary.
- **absent** → Step 1.

---

## Step 1: Prerequisites (order matters)

Templates/scripts path: `${CLAUDE_SKILL_DIR}/../../templates/push/` and `${CLAUDE_SKILL_DIR}/../../scripts/`.

1. **Detect project root**: invoke `_detect-project-root` → `WEB_DIR`, `IS_MONOREPO`, `IS_NEXTJS`. Abort if not Next.js.

2. **PWA present? (hard dependency)**

   ```bash
   test -f "<WEB_DIR>/src/app/manifest.ts" && grep -q "hypervibe:pwa" "<WEB_DIR>/src/app/manifest.ts" \
     && test -f "<WEB_DIR>/src/app/sw.ts" && echo pwa-ok || echo pwa-missing
   ```

   - **pwa-ok** → continue.
   - **pwa-missing** → **explain then offer**, via `AskUserQuestion`:

     > Push notifications are **not possible until your app is a PWA** (an installable app). It is the invisible component of the PWA, the "service worker", that receives notifications and displays them, even when the app is closed. Without it, there is no technical way to push a notification.
     >
     > I can **turn your app into a PWA now** (installable + offline cache), then continue on to notifications. It is quick and risk-free.

     Options:
     - **Yes, turn my app into a PWA** → run the `/add-pwa` skill, then **re-test** the marker above. Once `pwa-ok`, continue.
     - **No, not now** → stop cleanly: "No problem. Run `/add-push-notification` again whenever you want, and I will offer to install the PWA first."

3. **Database**: invoke `_check-deps db`. If `db_ok = false`, offer `/add-db` (push subscriptions are stored in the database), then re-check.

4. **Auth in users mode**: read `<WEB_DIR>/src/server/auth.ts` and look for the `// hypervibe:auth-modes` marker. If it does not contain `users`, offer `/add-auth` (users mode): a push subscription is tied to a logged-in user. Once it is in place, come back here.

---

## Step 2: Install web-push

```bash
# Major 3 pinned: web-push 4 is ESM with no default export, and templates/push/server-push.ts
# imports it by default (`import webpush`). `import * as webpush` is not the way out yet: it fails at
# run time on 3.x (CommonJS). Move to 4 when server-push.ts and @types/web-push (3.6.x today) both follow it.
pnpm add "web-push@^3.6.7"
pnpm add -D "@types/web-push@^3.6.4"
```

---

## Step 3: VAPID keys (project-specific secrets)

First check whether they already exist in the environment (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`): if so, do not regenerate (that would invalidate the subscriptions). Otherwise, generate them:

```bash
cd "<WEB_DIR>" && node "${CLAUDE_SKILL_DIR}/../../scripts/generate-vapid-keys.mjs" --env \
  | node "${CLAUDE_SKILL_DIR}/../../scripts/push-env-vars.mjs" --stdin
```

The two keys go from the generator to the local `.env` and Vercel on a pipe: the private key never appears in the conversation, nor in a process argument. Then push the subject, which is not a secret, via `_push-env-vars`:
- `VAPID_SUBJECT=mailto:<project contact email>` (read `BREVO_SENDER_EMAIL` / `ADMIN_EMAIL` / the project domain; default `mailto:contact@<domain>`).

These are **project-specific** secrets (like `AUTH_SECRET`): they go in `.env` + Vercel, **never** in the global vault.

---

## Step 4: Subscriptions table

1. Insert the contents of `templates/push/schema-snippet.ts` into the Drizzle schema (`<WEB_DIR>/src/server/db/schema.ts`, or `packages/db/src/schema.ts` in a monorepo), after the `users` table. Check that the imports used (`index`, `text`, `timestamp`, `sql`, `createTable`, `users`) are present (add them otherwise). Adapt `createTable` to the project conventions if the helper has a different name.
2. Push the schema:
   ```bash
   cd "<WEB_DIR>" && pnpm db:push
   ```

---

## Step 5: Extend the service worker (the heart of the dependency)

Insert the push handlers into the service worker created by `/add-pwa`. Read `templates/push/sw-push-handlers.ts`, replace `__APP_NAME__`, and insert its contents into `<WEB_DIR>/src/app/sw.ts` **right after** the `// hypervibe:push-handlers` marker line.

**Idempotence**: if `src/app/sw.ts` already contains an `addEventListener("push"`, do not reinsert. **Exception**: if the existing push handler does NOT contain the `postMessage({ type: "hv:new-notification" })` broadcast (older installs), add that broadcast block to the existing handler — it is what lets the notification-center bell update in real time without aggressive polling (which keeps the Neon database awake: it only autosuspends after 5 min without a query).

(The `public/sw.js` is regenerated at the next build: in dev the SW is disabled, so push can only be observed after deployment.)

---

## Step 6: Server (send helper + tRPC router)

1. Copy `templates/push/server-push.ts` to `<WEB_DIR>/src/server/push.ts`. Replace `__VAPID_SUBJECT__` with the `mailto:` from Step 3. The template already contains the `// hypervibe:push` marker on the first line (detected at Step 0 and by `/add-notification-center`): **keep it**.
2. Copy `templates/push/push-router.ts` to `<WEB_DIR>/src/server/api/routers/push.ts`.
3. Wire the router into `appRouter` (`<WEB_DIR>/src/server/api/root.ts`):
   ```ts
   import { pushRouter } from "~/server/api/routers/push";
   // inside createTRPCRouter({ ... }):
   push: pushRouter,
   ```
4. **Wiring the notification center (any order)**: check whether the in-app center is already installed:
   ```bash
   test -f "<WEB_DIR>/src/server/notify.ts" && grep -q "hypervibe:notification-center" "<WEB_DIR>/src/server/notify.ts" && echo center-present || echo center-absent
   ```
   - **center-present** → follow `templates/notif-center/notify-push-block.ts`: add the `sendPushToUser` import at the top of `notify.ts` and replace the marker line `// hypervibe:notify-push` with `await sendPushToUser(db, userId, payload);` (idempotent). That way `notifyUser` rings the bell **and** pushes to the phone.
   - **center-absent** → do nothing here (offered at Step 9).

To send a push from anywhere on the server side:
`await sendPushToUser(db, userId, { title: "...", body: "...", url: "/..." })`.
(If the in-app center is present, prefer `notifyUser(...)` which does both.)

---

## Step 7: "Enable notifications" button (user side)

1. Copy `templates/push/enable-notifications.tsx` to `<WEB_DIR>/src/components/`.
2. **Toasts**: the template uses `sonner`. If the project does not have `sonner` or a mounted `<Toaster />`, either install it (`pnpm add sonner` + mount `<Toaster />` in the layout), or replace the `toast.*` calls with a simple visual feedback (local state + message). Also adapt the colors to the palette.
3. Mount `<EnableNotifications />` in a **logged-in area** (account page, dashboard, settings). Ask the user where they want the button if the placement is not obvious, or put it on the account page by default.

---

## Step 8 (bis): Declare the delivery service

The payload does not travel from your server to the device: it goes through the
push service of **the browser the person uses** (Apple, Google, Mozilla). That
service is a recipient, whatever the site publisher decides, so it belongs in the
registry.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add web-push
```

Worth saying to the user, because it is the reassuring half: the payload is
encrypted with the VAPID keys generated at Step 3, so the service that carries it
cannot read it. Only the destination device can.

## Step 8: CLAUDE.md + verification

1. Invoke `_update-claude-md`:
   - `stack`: `- **Push**: Web Push (web-push + VAPID), subscriptions in the \`push_subscription\` table, handlers in the service worker.`
   - `env-vars`: `- \`NEXT_PUBLIC_VAPID_PUBLIC_KEY\` / \`VAPID_PRIVATE_KEY\` / \`VAPID_SUBJECT\`: Web Push (VAPID) keys`
   - `conventions`: `- Send a notification: \`sendPushToUser(db, userId, { title, body, url })\` from \`~/server/push\`. \`url\` is an internal path (\`/orders/12\`): a click on the notification opens the home page for anything else, never another site.`
2. Verify:
   ```bash
   cd "<WEB_DIR>" && pnpm tsc --noEmit && pnpm lint
   ```

---

## Step 9: Summary + iOS caveat

- Users can enable notifications from the button, and the server can send them notifications via `sendPushToUser`.
- **iOS caveat (important, tell the user)**: on iPhone/iPad, web push only works **if the app has been installed to the home screen** (PWA, iOS 16.4+), and the activation must be triggered by a user gesture (the button). This is an Apple constraint, not a bug.
- **To test after deployment**: install the app on mobile, click "Enable notifications", then trigger a test send.
- Without deployment there is nothing to observe: the service worker is disabled in dev.

### Cross-offer: in-app notification center (if absent)

Check `test -f "<WEB_DIR>/src/server/notify.ts"`. If absent, offer via `AskUserQuestion`:

> You now have **system** notifications (push): they arrive on the phone, even with the app closed. You can also add an **in-app notification center**: a bell with a badge showing the unread count and the list of notifications, viewable at any time.
>
> The difference: push grabs attention **outside** the app (and disappears); the bell keeps a **viewable history inside** it (read/unread). The two complement each other, and a single `notifyUser` call will send both.

- **Yes** → run `/add-notification-center` (which will detect push and wire push sending into `notifyUser`).
- **No** → "No problem. You can add it later with `/add-notification-center`."
