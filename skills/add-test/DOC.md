# /add-test

Gives your project **automated tests** and a **cahier de recette** (an acceptance book anyone can read), plus the guard that keeps both alive: nothing gets published while a feature has no verification.

> **"Recette"** comes from *recevoir*, to receive: in professional practice it is the moment the person who ordered the software accepts it, with or without reservations. A cahier de recette lists what the application must do and how each point is checked.

## When to use it

- You want to know that the application **still works after each change**, without clicking through it by hand every time
- Someone has to **validate** your application (a manager, a client, an IT department) and needs a document that says what it does and how to check it
- You are building for an organisation that expects the same rigour from internal tools as from suppliers: **acceptance, documentation, maintainability**
- A publication was refused with a "recette" message and you want to understand and fix it

## How it goes

1. **Check**: if the project already has its tests and its cahier, Hypervibe offers a menu (complete the recette after a new feature, run it, reinstall the guard).

2. **Installation of vitest**, the test runner: fast (seconds, no browser), and configured so that server modules load without a real database or real keys.

3. **Inventory**: Hypervibe lists every server feature (each tRPC procedure) and every page of your application, and reads your specification (`cahier-des-charges.md`, if you chose the full spec in `/bootstrap`) for the business rules.

4. **The cahier de recette** (`docs/recette.md`): one line per feature. What it does, how it is checked, the expected result, whether a test or a person verifies it, and its status. Written in business words, not code. Pages get a scenario a human can follow in a browser.

5. **The tests**: at least one per procedure, each tagged with the line of the cahier it covers (`recette: R-07`). They check real outputs and real refusals (a protected action rejects an anonymous visitor, an invalid form is refused, a mutation writes what it should), against a simulated database. They never touch your real data or any online service.

6. **Green, then complete**: the tests pass, and the checker confirms that every procedure has a test and every page is in the cahier.

7. **The guard**: a hook runs the tests and the checker **before every publication** from your computer, and a GitHub Action does the same for everyone, on every push. A refused publication says exactly what is missing.

8. **The rule in `CLAUDE.md`**: from now on, adding a feature means adding its line and its test. Claude Code reads that rule at every session and does it on its own.

## What it creates for you

- `docs/recette.md`: the cahier de recette, with a sign-off table at the bottom (the "procès-verbal")
- `tests/`: one test file per router, plus a helper that calls your API exactly like the application does
- `vitest.config.ts` and the `pnpm test` / `pnpm recette` commands
- `scripts/check-recette.mjs`: the checker (versioned, it runs on every machine and in CI)
- `.hooks/pre-push`: the guard before publication (versioned too, so every collaborator has it; it runs only in a checkout that opted in, which this command does for yours, because a clone never executes the hooks it arrives with)
- `.github/workflows/tests.yml`: the same guard on GitHub, visible to everyone
- Two lines in `CLAUDE.md` that make the rule permanent

## Prerequisites

- The project must be in Next.js (typically initialized by `/bootstrap`)
- `/start` done on the machine (it installs the global git hooks the guard relies on); otherwise the guard is installed for this repository only

## Tips

{{callout:info|A test is not a promise that nothing can go wrong}}
A green suite means "the logic we wrote behaves as written". It does not reproduce a real database constraint, a third-party outage, or a page that looks wrong. That is what the manual lines of the cahier are for: a person follows the scenario on the live version and signs the procès-verbal.
{{/callout}}

{{callout:tip|A refused publication is the guard doing its job}}
The message lists what is missing: a procedure without a test, a page absent from the cahier, a failing test. Open Claude Code and ask "complète la recette et les tests manquants". Never bypass the guard with `--no-verify`: the whole point is that a feature without a verification cannot reach production.
{{/callout}}

{{callout:warning|Pages are verified by people, for now}}
Browser journey tests (Playwright) are not part of this version. A page has a manual scenario in the cahier, written for a human. The cahier is designed so that automated journeys can slot in later without changing anything.
{{/callout}}

{{callout:info|The cahier is the document to hand over}}
If someone validates your application, give them `docs/recette.md`. The manual lines are their checklist, the sign-off table at the bottom is where they record their decision, with or without reservations. It is the same logic as a supplier's acceptance file, applied to what you build yourself.

If nobody has to validate your application, the sign-off table serves no purpose and Hypervibe leaves it out. The cahier itself still earns its keep: it is your own memory of what the app must do, six months from now, and it is already written the day someone asks for it.
{{/callout}}
