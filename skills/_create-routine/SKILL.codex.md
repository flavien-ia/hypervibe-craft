---
name: _create-routine
description: Internal helper that turns an operator-side agentic task ("brief me every morning", "analyze my week every Friday", "watch X and alert me") into a scheduled task of the Codex app, run on this computer. Checks that the session can schedule, explains in plain words where and how it runs, drafts a self-contained mission prompt, creates the task with the Codex app's scheduling tool and verifies it. Invoked by /add-automation and _create-agent for the ops-agentic quadrant. NEVER for app runtime jobs (those go to /add-cron or a worker). Not meant to be invoked directly by users.
user-invocable: false
---

# Create Routine - Internal helper (Codex)

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal tool names, and never show a raw schedule rule: say "every weekday at 8:57", not the rule behind it.
- Show progress as a short natural-language checklist (in-progress and done states).

You receive from the calling skill (or infer from the conversation):
- `GOAL` - what the routine must accomplish, in the user's words
- `CADENCE` - when it should run (plain language: "every morning", "Friday evening", "once a week")

## What a routine is (say this to the user, adapted to their language)

> A routine is a mission that **Codex runs for you on a schedule**, without you having to ask. It can read, reason, use the tools Codex has on this computer, and write you a result, which appears in the **Scheduled** section of the Codex app. It works for you personally: it is NOT a part of your app's infrastructure.

## Step 0 - Guard: is this really an operator-side task?

A routine is the right tool ONLY when the OUTPUT is for the operator (the user or their organisation): a brief, a report, a triage, an alert, a proposal. If the task's output feeds the APP or its end users (cleaning the database, sending emails to customers, syncing data the app displays), STOP and hand back to `/add-automation`: that is an app runtime job and it must run on the app's infrastructure (worker or cron), never on someone's computer.

Three-point smell test (any hit = app job, bounce back):
1. Would the app break or the end users notice if this stopped running?
2. Does it write to the app's database or send messages to the app's users?
3. Should it keep working when this computer is off or the Codex app is closed?

## Step 1 - Check that this session can schedule

Scheduled tasks belong to the **Codex desktop app**, which gives Codex a scheduling tool: it creates, views, updates and deletes scheduled tasks, next to a tool that lists the projects a task can run in. Look at the tools available in this session:

- **The scheduling tool is there** → continue with Step 2.
- **It is not** (Codex in a terminal, in an editor extension, or an app version without scheduled tasks) → guided creation. Go through Steps 2 to 5 to settle the warnings, the shape, the mission prompt and the schedule, then hand the user the prompt ready to paste and tell them to open the Codex app, go to **Scheduled**, and create the task there with that prompt and the schedule in plain words. Report `{ created: false, mechanism: "guided" }`.

Never write the scheduler's files by hand: their format belongs to the app.

## Step 2 - The honest warnings (mandatory, in plain words)

Before creating anything, tell the user (adapt, do not soften):

> 1. **It runs on this computer, inside the Codex app.** At the scheduled time the computer must be on and the Codex app open, and the project the task works on must still be on this computer.
> 2. **It runs unattended.** Nobody approves its actions while it runs, so the mission must read, analyze and report, or act only within limits you set now. It keeps your usual Codex permissions.
> 3. **It uses your ChatGPT plan** (or your API credits), like a conversation you would have yourself. That is exactly why routines only serve YOU, never something your app needs to function.

## Step 3 - Where each run happens

Two shapes, and the user decides (one short question, unless the request already says it):

- **A new chat for each run** (recommended for a recurring mission): every run starts fresh from the mission prompt and reports in **Scheduled**. Runs are independent, which suits a brief, a weekly analysis or a watch. For the tool, this is a standalone task: `kind: "cron"`.
- **Back in this chat**: every run continues the current conversation, with everything said so far. Suits keeping an eye on one piece of ongoing work. For the tool, this is a heartbeat: `kind: "heartbeat"` with `destination: "thread"`.

## Step 4 - Draft the mission prompt

A new chat per run starts from a BLANK context: the prompt must be fully self-contained. Draft it with:

1. **Objective** - one clear sentence.
2. **Steps** - the concrete sequence (what to read, what to analyze, what to produce).
3. **Resources** - exact file paths, URLs, repositories, connectors or tools to use.
4. **Output** - what to deliver (a summary in the run, a draft, a file only if the user asked for one).
5. **Constraints** - tone, length, budget of actions, what NOT to do.

The prompt describes the task only: the schedule, the project and the chat are given to the tool separately, never written into the prompt. Never reference "this conversation" or "as discussed" in a new-chat routine. Show the drafted prompt to the user and let them adjust it before creating: it is THE contract of the routine.

## Step 5 - Translate the cadence

- Read times in the user's local time. Do not convert them to UTC and do not add a start date.
- A new chat per run takes two kinds of schedule: every N hours, or weekly on chosen days at a set time. "Every day at 9" is weekly on all seven days (`FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=9;BYMINUTE=4`), "every weekday" lists MO to FR.
- Back in this chat also takes intervals in minutes (`FREQ=MINUTELY;INTERVAL=30`) and daily schedules.
- Approximate wording ("around 9am") → avoid minutes :00 and :30 (8:57 or 9:04): it spreads the load and runs earlier in practice.
- A standalone task every few minutes deserves a question: an operator brief rarely needs it; if it truly does, it is probably an app job in disguise (back to Step 0).

## Step 6 - Create, verify, hand over

1. **Project** (new chat per run only): if the mission works on a project (its files, its repository), ask the projects tool for the list and take that project's id. Otherwise, no project.
2. **Create** through the scheduling tool: a short name derived from the goal (e.g. `morning-competitor-brief`), the prompt, the schedule rule, status `ACTIVE`. For a new chat per run, also the project id (or none), `executionEnvironment: "local"`, the model set in `~/.codex/config.toml` (`model = ...`) unless the user names another, and a `medium` reasoning effort. Codex asks the user to approve the call: that approval is expected, say it is coming.
   If a field cannot be settled with confidence, use the tool's suggested creation instead: the app shows the task, and the user reviews and saves it.
3. **Verify**: scheduled tasks are kept in `$CODEX_HOME/automations/*/automation.toml` (`~/.codex/automations` by default). Find the new one by name or prompt, or view it through the tool with its id, and check the schedule. Tell the user when the next run happens, in plain words. If it cannot be found, say so and send the user to **Scheduled** in the app.
4. If the routine uses connectors or the browser, recommend running it once by hand from **Scheduled**, so any permission question is answered before the first unattended run.
5. Tell the user how to manage it later, in their words: pause it, change the mission or the schedule, delete it, from **Scheduled** in the Codex app or simply by asking ("pause my morning brief", "move my brief to 7am"). For such a request: find the task in `$CODEX_HOME/automations/*/automation.toml`, then update it through the tool with every field given again and only the requested ones changed (paused = status `PAUSED`), or delete it. Prefer updating an existing task to creating a duplicate.

## Return to the calling skill

Report back: `{ created: true, mechanism: "codex-app", id, schedule, nextRun }` so the caller can include it in its final summary. If the user declined after the warnings, report `{ created: false, reason }` - the calling skill then offers the classic alternatives (a cron with a simple script, or nothing).
