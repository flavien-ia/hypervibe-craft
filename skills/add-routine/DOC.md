# /add-routine

Create a recurring mission for your own Claude: a morning brief, a Friday analysis, a watch that alerts you. No code, no infrastructure: it is **your** assistant working for **you**, at the pace you choose.

## When to use it

- A **morning brief**: "every day at 8, read X and send me 5 lines"
- A **weekly analysis**: "every Friday, look at my stats and propose improvements"
- A **watch**: "monitor this topic and alert me when something happens"
- A **periodic triage**: "every Monday, review Y and prepare a summary for me"

The criterion: the output is **for you** (or your organisation), not for your app or its users.

## How it goes

1. **You describe the mission and the pace.** If your sentence already says it all ("brief me every morning on my competitors"), Hypervibe asks nothing more.

2. **The guard**: if what you describe actually serves your app (cleaning the database, emailing your customers...), Hypervibe stops you honestly and reroutes: an app must never depend on your personal Claude account.

3. **The two truths, said plainly**: the routine runs on **your Claude account** (each run consumes a bit of your subscription, and stops if the subscription stops); depending on your setup it runs in the cloud (even with your computer off) or on this computer while the Claude app is open.

4. **The mission is drafted with you**: objective, steps, resources, deliverable, limits. It is THE contract of the routine; you validate it before anything is created.

5. **Creation and verification**: the routine is created, verified, and Hypervibe tells you when it runs next.

## What it creates for you

- A **routine on your Claude account** (cloud or local), with its mission validated by you
- **Nothing in your project**: no code, no table, no deployment
- If the mission concerns one of your Hypervibe projects: a note in its `CLAUDE.md`

## Prerequisites

- Your Claude subscription, nothing else
- Cloud routines: a recent Claude Code or the desktop app; local tasks: the desktop app

## Tips

{{callout:tip|Natural-language control}}
Once the routine is in place: *"pause my routine"*, *"change the schedule"*, *"show me its last run"*, *"delete it"*. Nothing to configure anywhere.
{{/callout}}

{{callout:warning|Never for your app}}
Everything your **app** needs to function (cleanups, customer emails, syncs) belongs on the app's infrastructure: `/add-cron` or `/add-automation`. A routine that stops must never break anything beyond your own comfort.
{{/callout}}
