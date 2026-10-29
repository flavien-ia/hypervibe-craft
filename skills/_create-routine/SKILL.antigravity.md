---
name: _create-routine
description: Internal helper that turns an operator-side agentic task ("brief me every morning", "analyze my week every Friday", "watch X and alert me") into a scheduled automation of the Antigravity app, run on this computer. Explains in plain words where and how it runs, drafts a self-contained mission prompt, writes the automation with the narrowest permissions it needs, offers a test run, and hands over to the Automations dashboard. Invoked by /add-automation and _create-agent for the ops-agentic quadrant. NEVER for app runtime jobs (those go to /add-cron or a worker). Not meant to be invoked directly by users.
user-invocable: false
---

# Create Routine - Internal helper (Antigravity)

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never mention internal file names (`sidecar.json`) and never show a raw schedule rule: say "every weekday at 8:57", not the rule behind it.
- Show progress as a short natural-language checklist (in-progress and done states).

You receive from the calling skill (or infer from the conversation):
- `GOAL` - what the routine must accomplish, in the user's words
- `CADENCE` - when it should run (plain language: "every morning", "Friday evening", "once a week")

## What a routine is (say this to the user, adapted to their language)

> A routine is a mission that **Antigravity runs for you on a schedule**, without you having to ask. Each run starts a fresh conversation from the mission you approve now, reads, reasons, uses the tools you allow, and reports in the **Automations** dashboard. It works for you personally: it is NOT a part of your app's infrastructure.

## Step 0 - Guard: is this really an operator-side task?

A routine is the right tool ONLY when the OUTPUT is for the operator (the user or their organisation): a brief, a report, a triage, an alert, a proposal. If the task's output feeds the APP or its end users (cleaning the database, sending emails to customers, syncing data the app displays), STOP and hand back to `/add-automation`: that is an app runtime job and it must run on the app's infrastructure (worker or cron), never on someone's computer.

Three-point smell test (any hit = app job, bounce back):
1. Would the app break or the end users notice if this stopped running?
2. Does it write to the app's database or send messages to the app's users?
3. Should it keep working when this computer is off or the Antigravity app is closed?

## Step 1 - The honest warnings (mandatory, in plain words)

Before creating anything, tell the user (adapt, do not soften):

> 1. **It runs on this computer, inside the Antigravity app.** At the scheduled time the computer must be on and Antigravity open.
> 2. **It runs unattended, with only the permissions we grant it now.** Every run inherits your global permissions plus the ones listed for this routine; any other command is refused automatically. So the mission must read, analyze and report, or act only within the limits we set.
> 3. **It uses your Antigravity plan**, like a conversation you would have yourself. That is exactly why routines only serve YOU, never something your app needs to function.

## Step 2 - Draft the mission prompt

Each run starts from a BLANK conversation, with no memory of earlier runs: the prompt must be fully self-contained. Draft it with:

1. **Objective** - one clear sentence.
2. **Steps** - the concrete sequence (what to read, what to analyze, what to produce).
3. **Resources** - exact file paths, URLs, repositories or tools to use.
4. **Output** - what to deliver (a summary in the run, a draft, a file only if the user asked for one).
5. **Constraints** - tone, length, budget of actions, what NOT to do.

The prompt describes the task only: the schedule is set separately, never written into the prompt. Never reference "this conversation" or "as discussed". Show the drafted prompt to the user and let them adjust it before creating: it is THE contract of the routine.

## Step 3 - Translate the cadence

A standard five-field cron rule (`minute hour day-of-month month day-of-week`), in the user's local time zone, never converted to UTC:
- every hour: `0 * * * *`; every day at 9:00: `0 9 * * *`; every weekday at 9:00: `0 9 * * 1-5`; every Monday at 9:00: `0 9 * * 1`.
- Approximate wording ("around 9am") → avoid minutes :00 and :30 (8:57 or 9:04).
- Every few minutes deserves a question: an operator brief rarely needs it; if it truly does, it is probably an app job in disguise (back to Step 0).

## Step 4 - Write the automation

Antigravity bundles its own guide for scheduled automations (the built-in `automation` skill). When it is available in this session, read it first: it is the authority on the format, and it may be more recent than these lines.

1. Tell the user you are now creating the **<display name>** automation (a clear human name, e.g. "Morning competitor brief").
2. Write `~/.gemini/config/sidecars/<id>/sidecar.json`, `<id>` a short kebab-case name derived from the goal (`morning-competitor-brief`), with snake_case keys only:

   ```json
   {
     "builtin": "schedule",
     "args": ["<cron rule>", "agentapi", "new-conversation", "--", "<the mission prompt>"],
     "restart_policy": "always",
     "display_name": "<display name>",
     "description": "<one sentence: when it runs and what it does>",
     "agent_permissions": {
       "access_grants": []
     }
   }
   ```

   Keep `"--"` right before the prompt.
3. **Permissions, the narrowest ones**: list in `access_grants` only what the mission truly needs and what you have checked exists here: `command(<binary and subcommand>)` (e.g. `command(gh pr list)`), `read_file(<absolute path>)`, `write_file(<absolute path>)`, `read_url(<domain>)`, `mcp(<server>/<tool>)` for a server present in this session. Add `"workspace_uris": ["file:///absolute/path"]` to `agent_permissions` when the mission works in a project folder. Never a wildcard (`command(*)`, `read_file(/)`, `mcp(*)`), never a guessed tool.
4. **Never switch the automation on yourself**: the user does it in the Automations dashboard.

## Step 5 - Offer a test run, then hand over

1. Ask the user whether to run the mission once now, in this conversation, so the exact permissions it needs show up before the first unattended run. If yes: do the task once, then update `access_grants` (and the prompt, if the run taught you a precise path or flag) with exactly what was used.
2. Tell the user, by the display name, to switch the routine on in the **Automations** dashboard: [Open Automations Dashboard](sidecar://dashboard). Once on, it runs at the schedule, in plain words.
3. Tell the user how to manage it later, in their words: pause it or switch it off from the Automations dashboard, or simply ask ("move my brief to 7am", "change the mission", "delete it"). For such a request: find the automation in `~/.gemini/config/sidecars/*/sidecar.json` by display name or prompt, then edit that file (only the requested fields) or, to delete it, ask the user to remove it from the dashboard. Prefer updating an existing automation to creating a duplicate.

## Return to the calling skill

Report back: `{ created: true, mechanism: "antigravity-automation", id, schedule, enabled: false }` so the caller can include it in its final summary, and remind it that the user still has to switch it on. If the user declined after the warnings, report `{ created: false, reason }` - the calling skill then offers the classic alternatives (a cron with a simple script, or nothing).
