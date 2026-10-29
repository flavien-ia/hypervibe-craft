---
name: add-ai
description: "Add AI to an existing Next.js project: chat assistant, content processing, or generation. Estimates the cost from live prices and provisions a spending-capped key before writing any code. Model-independent through OpenRouter."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js 18+. Needs an OpenRouter account; the management key is read from the vault when it is there, otherwise the user creates one inference key by hand."
---

# Add AI - Intelligence inside the product

Adds AI to the user's application: a chat assistant, a processing step, a
generator. Everything routes through **one file** in the project
(`src/server/ai.ts`), and through **OpenRouter**, so that changing model is a
string to edit rather than a migration.

You own the **feature**: what it does, where it plugs in, what the user sees.
The brick underneath (the key, the budget, the shared file) is installed by
**`_ensure-ai`**, which every intelligence-needing skill of the plugin calls.
That is what guarantees the same three boundaries everywhere.

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

## What this skill refuses to do

Three boundaries, and they matter more than the features. They are applied by
`_ensure-ai`, so they hold identically whichever skill installed the AI:

1. **No code before a validated budget.** The user sees what it will cost, in
   their currency, for their volume, from the live price catalogue. They say
   yes to a number.
2. **No key without a cap.** The key created for the project carries a spending
   limit held by OpenRouter itself. A runaway loop hits a wall on the
   provider's side, not on a counter we wrote.
3. **No free model on personal data.** Free models exist and are genuinely
   useful, but some providers train on what passes through. Free is for
   prototyping; production data goes to paid models with training refused.

A user who deliberately wants to call OpenAI or Anthropic directly is never
blocked: `_ensure-ai` offers the same brick on their provider, records the
choice if they decline even that, and every later skill honours it silently.

## Routing away

Before anything, check this is the right skill:

- The need is an **autonomous process that decides on its own, uses tools, and
  runs in the background** -> **`_create-agent`**, invoked with a brief.
- The need is **scheduled or event-driven processing** -> `/add-automation`,
  which routes to the right shape.
- The need is **a personal recurring mission for the operator** (a weekly brief
  for themselves) -> `/add-routine`, when this tool offers it (otherwise say that
  this tool cannot schedule a mission).

Say which one and hand off. Do not build a second agent runtime here.

## Step 1 - Discovery (4 questions, no more)

Use `AskUserQuestion`. Do not ask what you can infer from the project.

**Q1 - What should the AI do?** Free text, then classify into one recipe:

| Recipe | Signals | What gets built |
|---|---|---|
| `chat` | "assistant", "answer questions", "support", "converse" | Streaming route + chat panel |
| `traitement` | "classify", "extract", "sort", "analyse", "summarise" | `traiterAvecIA()` helper returning validated JSON |
| `generation` | "write", "draft", "produce a text", "description" | Same helper, higher temperature, free-text output |

If the answer covers several, build the dominant one and say the others are one
`MODELES` entry away.

**Q2 - Who uses it?**
- *Me only / my organisation* -> no rate limit needed, generous cap.
- *My logged-in users* -> per-user rate limit, cap sized on the user count.
- *Anyone, publicly* -> **warn explicitly**: a public AI endpoint is a public
  wallet. Per-IP rate limit, tight cap, and say so plainly.

**Q3 - Roughly how many uses per day?** A number, even vague. It drives the
estimate. If they have no idea, propose 50 and say the cap protects them anyway.

**Q4 - Will personal data pass through?** (customer messages, CVs, health,
anything identifying.) If yes -> the free tier is off the table, and the GDPR
entry is mandatory.

## Step 2 - The brick (delegated)

Invoke **`_ensure-ai`** with the brief:

| Field | Value |
|---|---|
| `USAGE` | the recipe name (`chat`, `traitement`, `generation`) |
| `PROFIL` | same as the recipe (`qr` for a short question-answer) |
| `PAR_JOUR` | Q3 |
| `DONNEES_PERSONNELLES` | Q4 |
| `CIBLE` | `app` |

It handles the account check, the cost estimate, the budget the user validates,
the capped key, the shared file, the cost-log table, the GDPR entry and the
CLAUDE.md convention. When the project already has its brick, it is silent and
just binds the new usage.

It hands back `MODE`, `FOURNISSEUR`, `MODELE` and `PLAFOND_USD`. If `MODE` is
`direct`, the project deliberately calls a provider itself: build the recipe
below against the project's existing pattern instead of `appelerIA`, and do not
bring up OpenRouter again.

## Step 3 - Build the recipe

- `chat` -> `templates/ai/chat-route.ts` to `src/app/api/chat/route.ts` (fill
  `__CONSIGNE_SYSTEME__` from what the user described, `__GARDE_ACCES__` from
  Q2, `__USER_ID__` with the session user or `null`), and
  `templates/ai/chat-panel.tsx` to `src/components/chat-panel.tsx`. Wire it into
  a real page, never leave it orphaned.
- `traitement` / `generation` -> `templates/ai/traitement.ts` to
  `src/server/ai-traitement.ts`, `__SCHEMA_CHAMPS__` filled with the fields the
  user actually needs, and call it from a real place in the project.

**Rate limit** if Q2 said users or public: reuse the project's existing limiter
if there is one; otherwise a simple per-user-and-hour count on `ai_usage`, which
is already indexed for it.

## Step 4 - Wrap up

> ✅ **AI installed.**
>
> - What it does: <recipe, in one sentence>
> - Model: <id> (tier <Éco/Qualité>)
> - Estimated cost: **<X> $ per month** for <N> uses a day
> - Hard cap: **<Y> $**, held by OpenRouter. Past it, calls stop and the app
>   says so rather than failing silently.
> - Every call is logged with its real cost in the `ai_usage` table.
>
> To change model, edit `MODELES` in `src/server/ai.ts`. To change the cap, go
> to openrouter.ai/settings/keys.

Then say the one thing they will hit first: **the first call fails if the
OpenRouter account has no credits**, even for free models beyond 50 requests a
day. Adding 10 $ of credits also raises the free-model limit to 1000 a day.
