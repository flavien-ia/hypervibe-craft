---
name: _create-agent
description: "Internal - scaffolds an autonomous AI agent on its own worker: a capped key, a budget circuit breaker, tools, optional memory and a full trace. Invoked by add-automation or add-ai with a routing brief. Not for direct use."
user-invocable: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---


## ⚠️ Before any call to the script (to do BEFORE any other command in this skill)

```bash
# Detect the project's root organization
eval "$(node "${CLAUDE_SKILL_DIR}/../../scripts/wrangler-env-init.mjs" 2>/dev/null)"
```

Always through `eval "$(...)"`: the script prints the export lines, token included, and only `eval` keeps them out of the conversation.

(Not strictly required here, but handy if you hit a case where Wrangler is needed - typically not.)


# Create Agent - Scaffold an autonomous AI agent

## The brief you are invoked with

You are never reached by a user typing a command: `add-automation` (or `add-ai`)
has already established that this need has a real agentic loop or genuine
autonomy, and that neither a workflow nor a routine fits. **Do not re-run that
decision.** It hands you:

| Field | What it carries |
|---|---|
| `GOAL` | what the agent must accomplish, in the user's words |
| `TRIGGER` | cron / continuous / manual |
| `VOLUME` | how often it runs |

Q1 below is therefore already answered: restate the goal in one line and move to
Q1.bis. The remaining questions (memory, budget, tools, allowlists) are yours to
ask, because they have no equivalent upstream.

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You help the user set up an AI agent in their project. You ask few questions (max 5 needed), and you do the scaffolding + deployment work for them.

The deterministic code (scaffold templates, install deps, push schema, etc.) lives in `scripts/setup-agent.mjs`. This SKILL:
1. Asks the discovery questions (and short-circuits to `_create-routine` when the mission is operator-side and low-frequency - see Q1.bis)
2. Makes sure the agent has its own capped key (via `_ensure-ai` for the one-time setup)
3. Delegates to `_convert-to-turborepo` if the project is not a monorepo
4. Runs `setup-agent.mjs` with the right args
5. Communicates the result + the remaining manual actions (Render Blueprint setup)

---

## Preflight - vault unlocked

This skill reads the OpenRouter management key (and often Render/Cloudflare) from the vault → first, make sure it is unlocked (follow **`_ensure-vault`**): `node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" status` → if `locked`/`expired`, run `launch.mjs unlock`; if the vault does not exist, delegate to `_add-keyring`.

---

## Step 0 - Quick detection

Check up front that the ground is OK before asking questions.

### 0.a - Detect the Next.js project

Invoke `_detect-project-root` to get `PROJECT_NAME`, `WEB_DIR`, `IS_NEXTJS`, `IS_MONOREPO`. If `IS_NEXTJS=no` → explain to the user that a Next.js project is required (run `/bootstrap` first).

### 0.b - Detect whether email is configured

The agent sends emails (failures, daily digests, etc.) - email MUST be configured, otherwise error notifications won't go out.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" email
```

If `email_ok = false` → stop and tell the user:

> For an agent to be able to send you emails (error alerts, budget cap exceeded, its own emails if it sends any) - I need you to have email sending configured on your project. Run `/add-email` first, then come back here. It takes ~3 min.

### 0.c - Detect a Neon DB

The agent persists its invocations + turns + memory to the DB.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" db
```

If `db_ok = false` → ask the user:

> An agent stores its execution history and its memory in a database. You don't have a database configured yet. Do you want me to run `/add-db` now to set one up before continuing? *(takes 1 min)*

If yes → invoke `/add-db`, wait, come back here. If no → explain that we can't continue without a DB and stop.

---

## Step 1 - Discovery (5 questions max, in plain language)

You ask the questions one by one, in simple language. The answers fill the args for `setup-agent.mjs`.

The brief already carries `GOAL`: skip Q1 and work from it.

### Q1 - What is the agent's goal?

> Describe in one sentence what you want your agent to do. A few examples to inspire you:
>
> - *"Every morning at 7am, read my RSS feeds and email me a brief of the important articles"*
> - *"Watch my support emails, and for each email with a simple question, propose a reply as a draft"*
> - *"Once a week, aggregate Stripe + Vercel + Brevo stats and send me a dashboard"*
>
> What's yours?

→ Capture as `<USER_DESCRIPTION>`. Used for Q2 (inferring the trigger), for the system prompt, and for the additional tools.

### Q1.bis - The routine shortcut (check BEFORE going further)

Only when **`_create-routine`** is among the skills available in this session. Otherwise this tool cannot schedule a mission: skip Q1.bis and continue with Q2.

Look at WHO the mission serves and HOW OFTEN it runs:

- **Operator-side + scheduled (cadence >= 1 hour)** - the output is for the user themselves (a brief, a digest, an analysis, a watch report) and it runs at fixed moments (daily, weekly...). Two of the three Q1 examples are in this case (the morning RSS brief, the weekly stats digest). → This does NOT need the full agent machinery (Render worker, database tables, dashboard, budget caps). Offer the light path:

> Good news: for this kind of personal recurring mission, you don't need any infrastructure at all. I can set it up as a **routine**: the AI tool you are using right now runs the mission on schedule (it uses a bit of your subscription, and it serves you personally - not your app). Zero code, zero hosting, ready in 2 minutes.
>
> The full agent (with its own server, database traces and dashboard) stays the right choice if you want this to run for your app's users, or if you want detailed execution logs you can audit. Which do you prefer, the **routine** (recommended here) or the **full agent**?

If the user picks the routine → invoke **`_create-routine`** with the goal + cadence, and STOP here (no Step 2-7; `_create-routine` handles everything including the final summary).
If the user picks the full agent (or the mission is genuinely product-side / continuous / on-demand for a team) → continue with Q2.

- **Product-side, continuous, or on-demand dashboard** - the agent serves the app's end users, must watch something 24/7 (routines cannot: 1 hour minimum between runs), or must be triggered from an admin dashboard with full traceability. → Continue with Q2, this skill is the right tool.

### Q2 - When should the agent run? (trigger)

Infer a default from the description, but ask for confirmation:

> Based on what you describe, your agent would be triggered: **[INFER: "at a fixed time (cron)" / "continuously (watches all the time)" / "on demand (you click to launch it)"]**.
>
> 1. ⏰ **At a fixed time** - a cron (every morning 7am, every Monday…)
> 2. 🔄 **Continuously** - the agent runs 24/7 and reacts to events (incoming emails, webhooks)
> 3. 👤 **On demand** - you click a "Run" button from the dashboard to trigger it
>
> Which one? *(the scaffold will differ slightly: for cron I'll ask you the schedule, for continuous you need an event source, for manual you'll just get the dashboard button.)*

→ Capture `--trigger`: `cron` | `continuous` | `manual`.

If `cron` → ask a Q2.bis:

> At what cadence? *(in plain words, I'll translate it into a cron expression)*
>
> 1. Every day at a fixed time (e.g. 7am)
> 2. Every Monday morning
> 3. Every X hours
> 4. Other - specify

→ Capture `AGENT_CRON_SCHEDULE` (e.g. `0 7 * * *` for 7am every day).
→ Also capture `AGENT_CRON_PROMPT`: a default prompt sent to the agent on each tick (e.g. `"Read the RSS feeds and send today's brief."`). Infer it from the description.

### Q3 - Memory between runs?

> Should your agent **remember** things between its runs?
>
> 1. **No, stateless agent** - it does its job, forgets everything, starts from scratch each time *(the simplest, for cases like "summarize my RSS every morning")*
> 2. **Yes, structured memory** - it retains specific things identified by a key: *"who I've already replied to", "the last article I summarized", counters…* *(a simple table in the database, free)*
> 3. **Yes, semantic memory** *(advanced)* - it can recall memories **by meaning**, not by key: *"find the memories related to a theme", "search my knowledge base", RAG.* Uses Cloudflare Workers AI to compute the embeddings - **no new key to create**, we reuse your existing Cloudflare token.

→ Capture `--memory`: `none` | `kv` | `pgvector`.

**Recommendation**: `kv` covers 80% of cases. `pgvector` is useful if the agent needs to do semantic search over hundreds/thousands of memories. If the user hesitates, suggest `kv` - they can always add vector memory later by re-running the scaffold on the same name.

### Q3.bis - If pgvector: check the Workers AI scope on the Cloudflare token

(This sub-question only comes up if the user chose `pgvector` at Q3.)

The Cloudflare token created by `/start` today includes the `Workers AI:Read` scope (checked in the `/start` checklist). BUT for older users who created their token before this addition, the scope is missing.

The `setup-agent.mjs` script runs an automatic **smoke test** at the start of the `patchMemory` step: a POST call to the embedding endpoint to verify the scope. If it fails, the script fails with a clear message:

> Cloudflare Workers AI smoke test failed. Your token probably lacks the 'Workers AI:Read' scope. Regenerate at https://dash.cloudflare.com/profile/api-tokens and ADD that scope.

If you (Claude) get this error from the script, tell the user:

> Your current Cloudflare token doesn't allow using Workers AI (which is needed for semantic memory). No problem, it takes 30 seconds to update it:
>
> 1. Go to **https://dash.cloudflare.com/profile/api-tokens**
> 2. Find your "Claude Code" token (created by `/start`) → click **"Edit"**
> 3. In **Permissions**, click **"+ Add more"** and add: **Account · Workers AI · Read**
> 4. Click **"Continue to summary"** → **"Save Token"**
> 5. Come back here and tell me "done" - I'll re-run the scaffold

No need to regenerate the entire token (so no re-paste to do). Cloudflare lets you edit an existing token to add a scope.

### Q4 - Model

Do NOT ask by default. The script reads the live catalogue and picks the top of
the quality tier at scaffold time, which is the right default for an agent: it
reasons over several turns and calls tools, so this is not where to save a few
cents.

Ask only if the user brings it up, or if their description points at one of the
two edges:

> By default I take the best reasoning model available at this moment. Two cases
> where another choice is better:
>
> - **a cheaper, faster model**, when the agent does something simple and repeats
>   it a lot;
> - **a specific model** you already know you want.

-> Capture `--model` with the full identifier, provider included, as OpenRouter
writes it (`anthropic/claude-sonnet-5`, `google/gemini-2.5-flash`). To list what
is available: `ai-setup.mjs modeles --gamme <eco|qualite>`.

Nothing to keep in sync: the cost of every call comes from the provider's own
figure, so a model this skill has never heard of is still billed correctly.

### Q5 - Budget cap

Clear display:

> ⚠️ **Budget guardrail**
>
> To avoid an agent that loops costing you 200 EUR overnight, there's an automatic cap: if consumption exceeds the cap, the agent auto-pauses and you receive an email.
>
> Default caps:
> - **5 USD / day**
> - **50 USD / month**
>
> Do you want to adjust them?
>
> 1. **Keep the defaults** *(recommended to start)*
> 2. Customize

→ Capture `AGENT_DAILY_BUDGET_USD` and `AGENT_MONTHLY_BUDGET_USD` (defaults `5` and `50`).

### Q6 - Who may this agent write to?

This agent will read content from the open web and can query the database. Those two together are what makes it worth attacking: a page it reads can try to make it mail your data somewhere. It cannot be talked out of a list it is not allowed to leave, so we set the list now.

Ask in plain language, proposing the defaults:

> 📤 **Who may this agent contact?**
>
> It can send emails and call external services. To keep a web page it reads from turning it against you, I restrict both, right now:
>
> - **Emails**: only to `<ADMIN_EMAIL detected in the web .env>` *(you can add addresses, or a whole domain like `@yourcompany.com`)*
> - **External services it may WRITE to**: none *(it can read anything; writing is what I lock down)*
>
> Does that suit you?

→ Capture `MAIL_ALLOWLIST` (comma separated; default: the admin address found in step 0.b) and `FETCH_WRITE_HOSTS` (comma separated hostnames, default empty). If the agent's job obviously requires posting somewhere (a webhook, an API it must update), propose that host explicitly rather than leaving it to be discovered later.

Both land in `render.yaml` and stay editable in the Render dashboard.

### Inferring the agent name

No question - infer a kebab-case slug from the description. E.g.:
- *"Summarize my RSS every morning"* → `rss-digest`
- *"Watch my support emails"* → `support-email-watcher`
- *"Weekly Stripe + Vercel stats"* → `weekly-stats-report`

Check that no `apps/<slug>/` already exists - if it does, suffix it (`-2`, `-3`).

### Inferring the system prompt

⚠️ Write the **mission only**. Do not put safety rules in it (how to treat fetched content, what must never leave). Those live in `AGENT_SAFETY_PROMPT`, a separate constant in `loop.ts` that the scaffold does not overwrite: `--system-prompt` replaces the mission constant wholesale, so anything written there would be lost on the next scaffold and duplicated in the meantime.

Generate a clear system prompt from the description. Format:

```
You are <NAME>, an autonomous agent. Your goal: <GOAL>.
Triggers: <HOW_TRIGGERED>.
Tools at your disposal:
- <list>
Memory: <stateless|kv table>.
When done with a task, respond with a brief summary of what you did. If you can't accomplish the task, explain why in plain text.
```

---

## Step 2 - The agent's own key and budget

The agent runs on **its own capped key**, separate from the app's. The reason is
worth saying out loud to the user, because it is what makes an autonomous
process safe to run: an agent that loops must not be able to drain the budget
of the features their users are looking at, and two budgets read separately are
two budgets you can actually reason about.

Ask one question, and only this one:

> An autonomous agent works on its own, so I give it **its own budget**, held by
> the provider rather than by our code: past the cap, it stops, and it tells you.
> **How much per month?** Twenty dollars is a comfortable start for a daily
> agent, and you can raise it at any time.

Then check the setup is in place, which is the same one-time setup as everywhere
else in the plugin:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/ai/ai-setup.mjs" cles
```

- Exit 0 -> ready. Pass the amount to `setup-agent.mjs` as `--budget-usd`, which
  mints the key and writes it into the agent's own folder. Nothing else to do
  here.
- Exit 2, `raison: "coffre-verrouille"` -> follow **`_ensure-vault`**, retry.
- Exit 2, `raison: "cle-absente"` -> follow **`_ensure-ai`**, which walks the
  user through the one-time OpenRouter setup, then come back here.

The key value never crosses the conversation: the script writes it into
`apps/<agent-name>/.env` itself. The user copies it from that file into Render
at deploy time, exactly like `DATABASE_URL`.

---

## Step 3 - Check the monorepo (and convert if needed)

The agent lives in `apps/<slug>/` - so the project must be a Turborepo monorepo.

If `IS_MONOREPO=no` (Step 0.a), invoke `_convert-to-turborepo`:

> To have your agent live alongside your Next.js site, I need to turn your project into a **monorepo** (just a new `apps/web/` folder that contains your site, and you'll be able to have other apps next to it). It's safe and we can roll it back if needed.

Invoke skill: `_convert-to-turborepo` then re-check `IS_MONOREPO=yes` before continuing.

---

## Step 4 - Make sure the Render key is in the vault

Render is driven via its **REST API** (`api.render.com/v1`), no CLI to install. Invoke `_setup-render` (checks/adds the `RENDER.api_key` key in the vault, idempotent).

---

## Step 5 - Run the setup-agent script

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/setup-agent.mjs" \
  --name "<SLUG>" \
  --description "<USER_DESCRIPTION>" \
  --web-dir "<WEB_DIR>" \
  --trigger "<TRIGGER>" \
  --memory "<MEMORY_MODE>" \
  --model "<MODEL_ID>" \
  --system-prompt "<GENERATED_SYSTEM_PROMPT>" \
  --mail-allowlist "<MAIL_ALLOWLIST>" \
  --fetch-write-hosts "<FETCH_WRITE_HOSTS>"
```

The script chains 13 sub-steps (preflight, resolveModel, ensureMonorepo, scaffoldAgent, agentKey, patchSystemPrompt, patchAgentName, patchModel, patchTools, patchMemory, mergeSchema, installDeps, drizzlePush, handoff). Show progress to the user via `↳ <action>` then `✅`.

### On success → JSON on stdout:

```json
{
  "success": true,
  "agentName": "<slug>",
  "agentDir": "apps/<slug>",
  "trigger": "cron",
  "memory": "kv",
  "model": "anthropic/claude-sonnet-5",
  "schemaPatched": true,
  "warnings": [],
  "nextSteps": { ... }
}
```

Capture this JSON, use it for the final summary (Step 7).

### On failure:

Read the error just above the handoff banner. Diagnose by step:
- `preflight` → bad args (invalid slug, folder already existing) - fix then re-run
- `agentKey` → the capped key could not be created, back to Step 2
- `ensureMonorepo` → `_convert-to-turborepo` did not run, back to Step 3
- `scaffoldAgent` / `patchXxx` → rare (filesystem issue), inspect
- `mergeSchema` → conflict in `src/server/db/schema.ts` (resolve manually at the end)
- `installDeps` → pnpm/network error (retry)
- `drizzlePush` → invalid schema or DB issue (often recoverable)

---

## Step 6 - Offer the dashboard

> ## 🎛️ Do you want the dashboard to monitor your agent?
>
> Without a dashboard, your agent runs in the background and you see its logs on Render - functional but blind. **With a dashboard**, you get in your admin area (`/admin/agents`):
>
> - A list of each run with date, duration, cost
> - Turn-by-turn detail (each decision, each tool called) - useful for debugging
> - Aggregated cost stats (per day, over 30 days)
> - A **"Run now"** button with a custom prompt - handy for testing
>
> ⚠️ Prerequisite: your site must have admin authentication configured (`/add-auth` in admin mode). Without that, I can't install the dashboard because the pages would be public.
>
> Do you want me to add it? *(I'll invoke `/add-agent-dashboard` which handles everything)*

If the user says yes:

1. Check that `/add-auth` admin is in place (look at `apps/web/src/server/auth.ts` for `isAdmin` or `adminProcedure`).
2. If missing → ask the user to run `/add-auth` (admin mode) first.
3. If present → invoke `/add-agent-dashboard`. This skill is idempotent: if already installed, it no-ops.

If the user says no:

> OK, your agent runs without a dashboard. You can follow the logs on https://dashboard.render.com → your service → Logs. If you change your mind later, run `/add-agent-dashboard` to add it - it works with all your existing agents.

---

## RGPD - Privacy policy

Add OpenRouter and Render to the project's RGPD subprocessor registry:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-privacy-policy.mjs" --add openrouter --add render
```

OpenRouter routes the prompts sent by the agent (potentially user data - varies by agent), with training refused on every call. Render hosts the background worker. The helper is idempotent.

If the `politique-de-confidentialite/page.tsx` page exists (created by `/bootstrap`), it updates automatically. Otherwise, only the registry is created - `/rgpd-audit` can generate the page later.

---

## Step 7 - Final summary + manual Render actions

From the JSON captured in Step 5, display exactly:

> ## ✅ Your agent **<NAME>** is scaffolded
>
> 📁 Code: `apps/<NAME>/` *(15+ files: loop, tools, memory, render config, …)*
> 🗃️ DB tables created in Neon: `agent_invocations`, `agent_turns`, `agent_memory_kv`, `agent_trigger_queue`
> 🤖 Model: <MODEL_ID>
> ⏰ Trigger: <TRIGGER> *(+ cron expression if applicable)*
> 🧠 Memory: <kv | stateless>
> 💰 Caps: <DAILY> USD/day, <MONTHLY> USD/month
>
> ### To put it live
>
> 1. **Commit + push** what I just scaffolded (by name: the new `apps/<NAME>` folder plus the root files `git status --short` lists as modified, typically `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`):
>    ```
>    git add apps/<NAME> <modified root files> && git commit -m "feat(agent): scaffold <NAME> agent" && git push
>    ```
>    The push asks you to confirm: that is the guardrail doing its job.<if the project was converted to a monorepo in this session> Before it: your site's hosting must build from `apps/web/` (the setting the conversion asked you to change), or every deployment of your site fails from this push on.</if>
>
> 2. **Create the Render service** *(manual action, ~2 min)*:
>    - Go to **https://dashboard.render.com/blueprints**
>    - Click **"New Blueprint Instance"**
>    - Select your GitHub repo
>    - Render automatically detects `apps/<NAME>/render.yaml`, and names the service **`<renderServiceName>`**
>    - Fill in the **environment variables** (list below)
>    - Click **"Apply"**
>    - **Then tell me**: I record the service in your project, so that deleting the project one day deletes it too (it is billed every month while it exists).
>
> 3. **Environment variables to fill in on Render**:
>    - `OPENROUTER_API_KEY` - the agent's own capped key, in `apps/<agent-name>/.env`
>    - `DATABASE_URL` - copy from your web project's `.env`
>    - `BREVO_API_KEY` + `BREVO_SENDER_EMAIL` + `BREVO_SENDER_NAME` *(or Resend equivalents)* - copy from your web project's `.env`: the project's own sending key, never your email account's
>    - `ADMIN_EMAIL` - where the agent's error emails arrive
>    - `AGENT_DAILY_BUDGET_USD=5` *(or what you chose)*
>    - `AGENT_MONTHLY_BUDGET_USD=50`
>    - {{IF cron}}`AGENT_CRON_SCHEDULE` - *(e.g. `0 7 * * *`)*
>    - {{IF cron}}`AGENT_CRON_PROMPT` - the prompt sent to the agent on each run
>
> ### Once live
>
> - The agent's logs appear in the Render dashboard → "Logs"
> - You receive an automatic email on error or when a cap is reached
> - To trigger manually (without a custom dashboard): insert a row into the `agent_trigger_queue` table with your prompt → the agent picks it up within 5 s when it has been active in the last 5 minutes, within 10 min otherwise (adaptive polling: a fixed 5 s loop would keep the Neon database awake 24/7 and burn ~186 of the 100 monthly free compute hours)
>
> When you have a larger project, tell me *"add my agent's dashboard"* (or run `/add-agent-dashboard`) and I'll scaffold the monitoring pages.

---

## Important conventions

- **The agent's key is its own, and capped**: minted for this agent alone, written into `apps/<name>/.env` (git-ignored), never in the repo and never shared with the app's key. Render receives it via the dashboard.
- **Render = manual for Blueprint creation**: no reliable API/CLI for it. The skill scaffolds the code and explains the 2 min of remaining clicks.
- **Shared schema**: the `agent_*` tables live in the main Neon DB, not in a separate DB. The worker has its own copy of `schema.ts` that points to the same physical tables.
- **No chatbot**: if the user describes a real-time UI thing ("a chatbot on my site that answers visitors"), hand off to **`/add-ai`**: it is built exactly for that (streaming route, chat panel, capped key, cost log). An agent loop with tools and memory would be both heavier and slower for a question that must be answered in two seconds.
- **The hosting bill starts the day the Blueprint is applied, not the day the agent first runs**: the Background Worker sits on the starter plan (~7 USD/month), and Render bills an always-on service whether or not it has anything to do. Only the model usage is proportional to actual runs. Say this before the user clicks Apply. If they want to try the agent without paying Render, it runs locally with `pnpm dev` in `apps/<name>/`, as long as they keep the terminal open. There is no free variant of this service type: Render's free instance type does not exist for background workers, and a free web service would sleep after 15 minutes, which defeats the purpose.

---

## Common errors

- **"The agent doesn't trigger despite the cron"** → check `AGENT_CRON_SCHEDULE` is set on the Render dashboard (not in the yaml - sync:false). Also check the cron format (5 fields: `m h dom mon dow`).
- **"The error email doesn't arrive"** → check `ADMIN_EMAIL` is set on Render + email provider (BREVO/RESEND) operational. Test with an invocation that fails on purpose.
- **"The worker crashes at boot with OPENROUTER_API_KEY missing"** → the var isn't surfaced to Render. Re-check in the Render dashboard → service → Environment.
- **"db:push fails with a schema error"** → conflict with the existing schema (table `agent_invocations` already present with other columns?). Inspect the diff.


---

## Resource manifest (always)

Every cloud resource this skill creates or adopts is recorded in the project resource manifest (`.hypervibe/resources.json`, versioned with the code) - it is what `/save-project` and `/delete-project` read first, instead of guessing resources by name. Run the recording right after the resource exists; it is idempotent, silent on success, and stores identifiers only (never secrets). Full reference: the `_track-resource` skill.

Two records belong to this skill, and they are what lets `/delete-project` remove the agent with its project:

- **The agent's key** (kind `ai-key`, named `<NAME>-agent`): recorded by the setup script itself, right after the key is minted (`agentKeyRecorded: true` in its JSON). If it says `false`, its warning names the cause: record the key with `_track-resource` (kind `ai-key`, field `hash`) before going further, or the key will outlive the project.
- **The agent's Render service** (kind `render-service`): it only exists once the person has applied the Blueprint. When they say it is done, find it by its exact name and record it:

  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/render/service.mjs" find --project-dir "<project-root>" \
    --name "<renderServiceName>" --record --added-by _create-agent
  ```

  Exit 0: `recorded: true`. Exit 4: no service of that name yet (the Blueprint was not applied, or the service was renamed: ask). Exit 6: several services carry that name: ask which one is this project's. Exit 2: unlock the vault and run again. Exit 1: say what failed, never take it for "no service".
