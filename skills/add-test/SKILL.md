---
name: add-test
description: Add vitest tests and a human-readable cahier de recette (docs/recette.md) to a T3 project, with a pre-push hook and CI that refuse to publish a feature without its verification.
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Add Test - tests automatisés + cahier de recette

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Gives the project two things that answer the same question, "does it work, and will it still work after the next change?", for two audiences:

- **`docs/recette.md`, the cahier de recette**: one line per feature, readable by someone who has never opened the code. What the feature does, how it is checked, what is expected, who validates.
- **Automated tests** (vitest): one per tRPC procedure at least, each tagged with the line of the cahier it covers (`// recette: R-07`).

And it wires the guard that keeps both alive: a **pre-push hook** and a **GitHub Action** that run the tests and refuse to publish while a procedure has no test or a page is missing from the cahier. From then on, "add a feature" means "add its line and its test", and the project's `CLAUDE.md` says so.

What this skill does NOT do: browser journey tests (Playwright). Pages are covered by a manual scenario in the cahier, written for a human. Journey tests may come in a later version; the cahier is designed so they can slot in without changing anything.

---

## Step 0 - Preflight: is the project already equipped?

**First of all**, invoke `_check-deps tests`:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" tests)
tests_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).tests.ok)")
```

### If `tests_ok = true` -> maintenance mode

The project already has vitest, a cahier de recette and the checker. Do NOT reinstall anything. Show a menu:

> ## ✅ Les tests et le cahier de recette sont déjà en place
>
> Que veux-tu faire ?
>
> 1. **Compléter la recette et les tests** (après une nouvelle fonctionnalité, ou parce que la publication a été refusée)
> 2. **Lancer la recette** et me montrer le résultat
> 3. **Réinstaller le garde-fou** (hook avant publication, action GitHub) s'il a été supprimé
> 4. **Autre chose** - dis-moi

Wait for the answer.

| Choice | Action |
|---|---|
| 1 | Jump to **Step 5** (inventory), then Steps 6 to 8. Only ADD what is missing: never rewrite existing lines or tests. |
| 2 | Run `pnpm test` then `node scripts/check-recette.mjs` (in `WEB_DIR`), and explain the result in plain words: what is verified, what is missing, what it means for the next publication. Then stop. |
| 3 | Re-run Step 3 for `.hooks/pre-push` and `.github/workflows/tests.yml` only, then Step 9. Then stop. |
| 4 | Ask for details. Do not launch the full flow by default. |

### If `tests_ok = false` -> installation

Continue to Step 1.

---

## Step 1 - Detect the project structure

Invoke `_detect-project-root`. You get `PROJECT_NAME`, `WEB_DIR`, `IS_MONOREPO`, `IS_NEXTJS`. If `IS_NEXTJS=no`, stop: this skill is for a Next.js project (typically initialized by `/bootstrap`).

Everything below runs **inside `WEB_DIR`** (`.` for a single app, `apps/web` in a monorepo). The hook and the GitHub Action are the only files written at the repository root.

## Step 2 - Install vitest

```bash
cd <WEB_DIR>
pnpm add -D vitest
node -e "
const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.scripts??={};
p.scripts.test??='vitest run';
p.scripts['test:watch']??='vitest';
p.scripts.recette??='node scripts/check-recette.mjs';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');"
```

Idempotent: existing scripts are kept.

## Step 3 - Copy the templates

From `${CLAUDE_SKILL_DIR}/../../templates/tests/`:

| Template | Destination | Note |
|---|---|---|
| `vitest.config.ts` | `<WEB_DIR>/vitest.config.ts` | Do not overwrite an existing one: merge the `test.env` and `setupFiles` entries instead. |
| `setup.ts` | `<WEB_DIR>/tests/setup.ts` | Placeholder env values, so server modules load without real services. |
| `caller.ts` | `<WEB_DIR>/tests/helpers/caller.ts` | The tRPC caller used by every test. It puts the project's `db` (from `~/server/db`) in the context, so a test's `vi.mock("~/server/db")` is what the procedures receive. **Project without a database** (no `src/server/db/index.ts`): remove the `db` import and the `db` property from the helper. |
| `healthcheck.test.ts` | `<WEB_DIR>/tests/healthcheck.test.ts` | **Only if** `src/server/api/routers/healthcheck.ts` exists (created by `/bootstrap`). Otherwise skip it, and R-01 in the cahier will be the first real feature instead. |
| `check-recette.mjs` | `<WEB_DIR>/scripts/check-recette.mjs` | The checker. Versioned in the project: it runs on every machine and in CI. |
| `pre-push` | `<repo root>/.hooks/pre-push` | Replace `{{WEB_DIR}}` with the detected value (`.` or `apps/web`). Then `git update-index --add --chmod=+x .hooks/pre-push` after staging, so the executable bit travels with the repository. |
| `tests.yml` | `<repo root>/.github/workflows/tests.yml` | Replace `{{WEB_DIR}}`. |
| `recette.md` | `<WEB_DIR>/docs/recette.md` | Written in **Step 6**, not copied as is: it is the template of the cahier. |

Read each template before copying: they carry the explanations the user will read later (in the files themselves), so keep them intact apart from the placeholders.

## Step 4 - First run

```bash
cd <WEB_DIR> && pnpm test
```

The healthcheck test must pass. If it fails **at import time** (a server module refuses to load), the cause is almost always a variable that `~/env` demands: add it to `tests/setup.ts` with a placeholder value of the right shape. Never put a real key there. If it fails because the project has no healthcheck router, delete `tests/healthcheck.test.ts` and continue: Step 7 writes the real tests.

Two import-time failures are already handled by the templates, so you recognize them rather than fix them: `Cannot find module '.../next/server' imported from next-auth/lib/env.js` (vitest cannot resolve next-auth's own imports in a pnpm layout: `vitest.config.ts` inlines `next-auth`), and `This module cannot be imported from a Client Component module` (the `server-only` marker: `tests/setup.ts` neutralizes it, and simulates `next/cache` for the same reason). If either still appears, the project's `vitest.config.ts` or `tests/setup.ts` was not replaced by the template: compare and merge.

## Step 5 - Inventory: what must be covered

```bash
cd <WEB_DIR> && node scripts/check-recette.mjs --inventaire
```

You get, as JSON: the routers with their procedures, the pages with their routes, the existing tests, and (if a cahier exists) what is still uncovered. Also read:

- `cahier-des-charges.md` at the project root, if the full spec of `/bootstrap` produced one: it holds the business rules the cahier must state (a rule the spec writes is a line of the recette).
- `CLAUDE.md`: the conventions and the stack, to describe features with the right words.

## Step 6 - Write the cahier de recette

Write `<WEB_DIR>/docs/recette.md` from the `recette.md` template: keep its header (it teaches the word "recette" and explains the columns to a human), keep the R-01 line only if the healthcheck test exists, and generate the lines:

- **One line per tRPC procedure** (`Vérifiée par: test`). Describe the feature in business terms, not the procedure name: "Envoi du formulaire de contact", not `contact.send`. Put the procedure name in the "Comment on vérifie" column, so the reader can find the test.
- **One line per page** (`Vérifiée par: manuel`), with a scenario a person can follow in a browser and an expected result they can observe. The route (`/contact`) MUST appear in the line: that is how the checker matches a page to the cahier.
- **One line per business rule** from the spec that is not obviously a procedure or a page (a pricing rule, a deadline, a quota). Mark it `test` if it lives in code you can call, `manuel` otherwise.

Identifiers `R-01`, `R-02`... in order, never reused. Write the lines in the user's language. Statut: `ok` for lines you will cover with a passing test in Step 7, `à faire` for manual scenarios nobody has run yet.

**The "Procès-verbal" section is the enterprise half of this document, and it is not for everyone.** Keep it when the project is delivered to someone (a client, an employer, an IT department) - the template already says it can be removed otherwise. **Drop the section entirely** when the context makes it plainly useless: a personal project, a portfolio, a tool the user built for themselves alone. A signature table nobody will ever sign makes the whole document look like paperwork, and the rest of the cahier is what earns its keep.

In maintenance mode (Step 0, choice 1): append the missing lines with the next free identifiers, do not renumber.

## Step 7 - Write the tests

One file per router: `<WEB_DIR>/tests/<router>.test.ts`. Rules:

- **Meaningful assertions.** Each test checks a real output or a real refusal. Never `expect(true).toBe(true)`, never a test that only checks "it did not throw".
- **The literal `<router>.<procedure>` call through the caller** (`await caller().contact.send({...})`): the checker recognizes coverage by that exact text.
- **Tag every test** with the cahier line: `// recette: R-07` above the `it`, or in the file header for a whole file (`// recette: R-07, R-08`).
- **Never a real database, never the network.** A procedure that reads or writes `ctx.db` gets a simulated module:
  ```ts
  vi.mock("~/server/db", () => ({
    db: { query: { posts: { findMany: async () => [{ id: 1, title: "Bonjour" }] } } },
  }));
  ```
  Shape the fake after what the procedure actually calls (read the router first). For Drizzle query builders (`db.select().from()...`), return a chainable fake whose terminal call resolves to the fixture. Same for an email module (`~/lib/mail`, `~/server/mail`), a payment client, a storage client: simulate the module the router imports, then assert on what it received.
- **`vi.mock` is hoisted.** vitest moves every `vi.mock(...)` to the top of the file, before the `const` declarations: a factory that references a top-level variable throws `Cannot access 'x' before initialization`. Any fake the test needs to inspect or mutate later (a `vi.fn()` you assert on, an env object you toggle) MUST be created in `vi.hoisted`:
  ```ts
  const { sendMail, envSimule } = vi.hoisted(() => ({
    sendMail: vi.fn<(envoi: { to: { email: string }[]; subject: string }) => Promise<void>>(async () => undefined),
    envSimule: { BREVO_API_KEY: "cle-de-test" as string | undefined },
  }));
  vi.mock("~/lib/mail", () => ({ sendMail }));
  vi.mock("~/env", () => ({ env: envSimule }));
  ```
  Give `vi.fn` its signature (`vi.fn<(arg: T) => R>()`): without it, `mock.calls[0][0]` is typed as never and `pnpm tsc --noEmit` fails on the test.
- **Rate-limited procedures** (`rateLimitedProcedure`, keyed by IP): give each test its own `x-forwarded-for` header through the caller, or the fifth call of the file trips the limit meant for the sixth.
- **Patterns to cover, per procedure:**
  - a public query: the happy path, with the exact shape of the result;
  - a protected procedure called anonymously: `await expect(caller().x.y()).rejects.toMatchObject({ code: "UNAUTHORIZED" })`;
  - an input validated by zod: one invalid input rejected with `BAD_REQUEST`, one valid input accepted;
  - a mutation: the fake records what was written, and the test checks it (a `vi.fn()` on `insert`/`update`).
- **A large project** (more than 30 procedures): write and run router by router, so a failing fake is found while it is still small.

## Step 8 - Green, then complete

```bash
cd <WEB_DIR> && pnpm test && node scripts/check-recette.mjs
```

Both must be clean. The checker lists what is still missing, in plain language: a line marked `test` without a tagged test, a procedure no test exercises, a page absent from the cahier. Fix, re-run. Then:

```bash
pnpm tsc --noEmit && pnpm lint
```

Test files are TypeScript like the rest of the project: they go through the same checks.

## Step 9 - The hook on this machine, and the opt-in of this checkout

The repository's `.hooks/pre-push` only runs if two things hold. The machine's global git hooks must hand over to it (Hypervibe sets `core.hooksPath` globally for the secret scan, which makes `.git/hooks` inert). And THIS checkout must have opted in: `.hooks/` files are versioned, so they arrive with any clone, and git does not version its hooks precisely so that cloning can never execute code. The opt-in is a local git config value (`hypervibe.hooks = true`), which a clone never carries. Both in one command, run from the repository:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/ensure-hooks-chain.mjs" --trust
```

| Output | Meaning |
|---|---|
| `OK` / `INSTALLED` / `REFRESHED` (followed by `TRUSTED`) | The global chain hook is in place (refreshed if an older, ungated block was found), and this checkout is trusted: its `.hooks/pre-push` now runs before every push. |
| `LOCAL TRUSTED` | No global hooks path (the secret scan was never installed): the chain was written into this repository's `.git/hooks/pre-push` instead, and the checkout is trusted. Suggest `/start` later, which installs the global setup. |
| `FOREIGN` | A `pre-push` that is not Hypervibe's already exists. Do not overwrite it. Tell the user where it is (`~/.git-hooks/pre-push`) and what to add to it (the chain block of `scripts/ensure-hooks-chain.mjs`). |

Other people who clone the project do not get the guard by cloning, and that is the point: on their machine the hook announces itself at the first commit or push and stays inert until they opt in themselves, once, in their clone (`git config hypervibe.hooks true`). The GitHub Action covers the case where they have not.

## Step 10 - Update CLAUDE.md

Invoke `_update-claude-md` with:
- `commands`:
  - `- \`pnpm test\` - lance les tests (vitest)`
  - `- \`pnpm recette\` - vérifie que chaque fonctionnalité a sa vérification dans \`docs/recette.md\``
- `conventions`:
  - `- **Tests et recette** : \`docs/recette.md\` est le cahier de recette, une ligne par fonctionnalité (identifiant \`R-xx\`). Toute fonctionnalité nouvelle ou modifiée ajoute ou relit sa ligne ET son test (\`tests/<routeur>.test.ts\`, tagué \`// recette: R-xx\`, appelant \`<routeur>.<procédure>\` via \`tests/helpers/caller.ts\`, base simulée par \`vi.mock("~/server/db")\`, jamais de vraie base). Toute nouvelle page ajoute sa ligne (scénario manuel, avec sa route). \`pnpm test\` avant tout commit : le hook pre-push et l'action GitHub refusent de publier tant qu'une procédure n'a pas de test ou qu'une page manque au cahier. Ne jamais contourner avec \`--no-verify\` : compléter la recette à la place.`

Translate these lines into the user's language if the project's CLAUDE.md is not in French.

## Step 11 - Commit (no push)

Stage nominatively (the guardrail refuses `git add -A`), then commit:

```bash
git add docs/recette.md tests scripts/check-recette.mjs vitest.config.ts package.json pnpm-lock.yaml CLAUDE.md .hooks/pre-push .github/workflows/tests.yml
git update-index --chmod=+x .hooks/pre-push
git commit -m "feat(tests): cahier de recette et tests automatisés"
```

(Adapt the paths with `<WEB_DIR>/` in a monorepo.) Do NOT push: the user publishes when they want to, and that push will be the first one the hook checks.

## Step 12 - Summary

Tell the user, in plain words:

- What now exists: the cahier (`docs/recette.md`, N lines, so many by test, so many manual), the tests (N files, all green), the guard (before every publication on this machine, and on GitHub for everyone).
- **How it works from now on**: adding a feature adds its line and its test; that is written in `CLAUDE.md`, so Claude Code does it on its own. If a publication is refused, the message says exactly what is missing, and "complète la recette et les tests manquants" fixes it.
- **What the cahier is for**: explain the word in one sentence (it comes from *recevoir*: the moment the person who ordered the software accepts it), then say what it does for them. If someone validates the application, it is the document to hand over: the manual lines are their checklist, the "Procès-verbal" table is where they sign off. If nobody does, it is their own memory of what the app must do, six months from now, and it is already written the day someone asks.
- What is not covered yet: browser journeys (a page is checked by a person following the scenario), and anything the fakes do not reproduce (a real database constraint, a third-party service). Say it plainly: a green suite means "the logic we wrote behaves as written", not "nothing can go wrong".
