---
name: spec
description: Guide the user through building a detailed project specification (cahier des charges) for a web application. Produces a structured .md file ready to be used by /bootstrap. Use when the user wants to define their project step by step before building it.
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (vercel, gh)."
---

# Spec - Guided Project Specification Builder

## Communication
- Detect the user's language from the conversation (the user's own messages, anywhere in the session - not just this invocation: a bare slash command like `/bootstrap` carries no language signal by itself). If nothing in the conversation gives a signal, fall back to the OS locale (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().locale)"`) before defaulting to English. ALWAYS reply in that language for every user-facing message: questions, progress, confirmations, summaries, errors - including any example text quoted in this skill, which is illustrative and must be translated, never sent verbatim.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

You are a product strategist helping a non-technical user define their web application project. Your goal is to produce a clear, structured `cahier-des-charges.md` file that `/bootstrap` can consume to build the app.

**Important rules:**
- Speak in a friendly and accessible tone
- Never use technical jargon without explaining it
- Ask questions one bloc at a time (not all at once)
- After each bloc, summarize what you understood before moving to the next
- If the user is vague, propose concrete options to choose from
- Adapt the depth of questions to the complexity of the project

The project name and short description have already been provided by `/bootstrap` before calling this skill. Use them as context.

⚠️ **No explicit questions about infrastructure** (DB, auth, email, stripe, etc.). You **silently infer** these decisions from what the user describes in blocs 1-2 (pages, actions, admin area, mentioned payments, etc.), exactly as `/bootstrap` does when there is no spec. No "confirm the infra" recap either in the spec: the final confirmation happens **only once**, in bootstrap Step 4b after you hand control back.

⚠️ **No questions about the domain, GitHub collaborators, or legal notices** in the spec:
- Domain → `/add-domain` post-bootstrap, out of scope of "what are we building"
- Collaborators → `/add-collab` post-bootstrap, same
- Legal notices → bootstrap generates them systematically (French law), no need to ask

**Before starting the questions**, display this tip:

> **Tip:** To answer faster and more naturally, you can switch to **audio mode** (mic icon in the chat bar). You speak, Claude understands. It is often smoother than typing everything out.

---

## Progress communication (adapted for a conversational skill)

At the very start, **announce the 4 blocs** that you will cover together with the user, as a checklist:

> Here are the 4 blocs we are going to build together:
> - ⬜ Project identity (for whom, what, why)
> - ⬜ Pages (which pages, what actions on each)
> - ⬜ Design (mood, colors, inspirations)
> - ⬜ Content and details (texts or placeholder, anything else to mention)

**At the transition between blocs** (not at each individual question, that would be too verbose), announce that the bloc is complete:

> ✅ **Bloc 1: Identity** - moving on to the next one.

At the end, the 4 blocs must all be `✅` before generating the specification file.

⚠️ NEVER use the "Step N" numbers from this SKILL.md file in your messages, they are an internal structure. Speak only in terms of "blocs".

---

## Bloc 1 - The project

Ask:
- **Who is this app for?** (your customers, your colleagues, the general public, just you?)
- **What problem does it solve?** (what do people do today without this app, and why is it painful?)
- **Is there an existing site or app you draw inspiration from?** (not to copy, but to understand the mood and the features)

Summarize, confirm with the user, then move to Bloc 2.

---

## Bloc 2 - The pages

Ask:
- **Which pages should your app have?** Propose a base list adapted to the project (e.g. home, about, contact, dashboard, etc.) and ask the user to confirm, add, or remove.
- **For each main page**, ask: what do we see on it? What actions can the user take? (E.g. "on the home page, there is a hero with a CTA, a benefits section, and testimonials")
- **Is there an admin area or a restricted area?** (e.g. a backoffice to manage content, a dashboard)

Carefully note each action mentioned, it is the main source of the infrastructure inference (booking → DB, login → auth, payment → stripe, upload → storage, etc.).

Summarize the sitemap, confirm with the user, then move to Bloc 3.

---

## Bloc 3 - The design

Ask:
- **What visual mood?** Propose concrete options:
  - Modern and clean (lots of white, minimalist)
  - Dark and elegant (black background, colored accents)
  - Colorful and dynamic (bright colors, energy)
  - Corporate and professional (sober, serious)
  - Other (describe)
- **Do you have any colors in mind?** (primary color, accent color, otherwise I will propose a fitting palette)
- **A site whose "look" you would like?** (give a URL if possible)
- **Mobile first?** Most of the time yes, but confirm.

Summarize the design direction, confirm, then move to Bloc 4.

---

## Bloc 4 - Content and other details

A short and focused bloc. Just ask:

- **For the page texts, have you already written something or do we use placeholder content?** (Lorem Ipsum / suitable fake content that you can replace afterwards)
- **Anything we have not covered?** A specific integration, a particular constraint, a technical detail you know about that changes everything (e.g. "I MUST have TipTap as the editor", "it is for a B2B client with an enterprise SSO", etc.)

Summarize, confirm, then proceed to the silent inference + file generation.

---

## Silent inference of the infrastructure (before generating the file)

⚠️ This section is **internal**, the user sees NOTHING of this step. No menu, no recap, no confirmation. You deduce silently, you fill in the "5. Infrastructure technique" section of the generated file, and the confirmation will happen later in bootstrap Step 4b.

**Inference rules** (identical to branches B/C of bootstrap, keep both consistent):

- Users, accounts, data, content management (mention of "booking", "order", "article", "client record", etc. in bloc 1-2) → `add-db` + `add-auth` (credentials)
- Admin area / backoffice / protected pages (bloc 2) → `add-auth` (credentials, admin mode if only the owner logs in; users mode if public signup)
- Login / signup (explicit mention in bloc 1-2) → `add-auth` (credentials). No OAuth question here, bootstrap will use Credentials, the user can add Google/GitHub via `/add-google-auth` post-bootstrap.
- Emails, contact form, notifications, confirmations (bloc 1-2) → `add-email`
- Payments, checkout, pricing, subscription (bloc 1-2) → `add-stripe`
- Multiple languages, translation (bloc 1-3) → `add-i18n`
- File, image, document upload (bloc 2) → `add-storage`
- Automatic background tasks (non-AI) (scheduled newsletters, data processing, API sync) → `add-automation`
- **Autonomous AI agent** (LLM that decides on actions, uses tools, optionally with memory - "agent that watches X", "agent that summarizes Y", "agent that reacts to Z") → `add-agent`
- **Analytics, tracking, statistics** → `add-analytics`. ⚠️ **STRICT OPT-IN**: propose `add-analytics` ONLY if the user has explicitly written/said words like "analytics", "tracking", "statistics", "Google Analytics", "GA4", "audience", "audience measurement". **Never as a "useful" default**, a site that talks about marketing or SaaS does NOT trigger analytics on its own. When in doubt → no.
- Any app that implicitly stores data needs `add-db` (e.g. "booking app" → DB mandatory).

**If a decision is genuinely ambiguous** (e.g. the user mentioned payments but we do not know whether it is a one-time purchase or a subscription) → ask **ONE single short question** targeted at the ambiguity before generating the file. No more than one question, otherwise we fall back into the old explicit Bloc 4 pattern.

---

## Generate the spec file

### Step 1 - Determine and announce the location

Before writing anything, get the absolute path of the current working directory:

```bash
pwd
```

On Windows with Git Bash, `pwd` returns a path like `/c/DEV/mon-projet`. Keep this path in a mental variable `$PROJECT_DIR`.

Then explicitly tell the user where the file will be created (important: on Claude Desktop, the user does not see the file tree, so you must always tell them where things are):

> I am creating your specification in:
> `{$PROJECT_DIR}/cahier-des-charges.md`

### Step 2 - Write the file

Produce the `cahier-des-charges.md` file in the current directory with the following structure:

```markdown
# Cahier des charges - <Project Name>

## 1. Vue d'ensemble
- Description du projet
- Public cible
- Problème résolu

## 2. Pages
Pour chaque page :
- Nom et URL
- Contenu et sections
- Actions utilisateur

## 3. Design
- Ambiance visuelle
- Couleurs (si définies)
- Inspirations (si fournies)
- Responsive : oui (mobile-first)

## 4. Contenu et détails
- Textes : placeholder / fournis
- Notes spécifiques

## 5. Infrastructure technique (inférée)
- Base de données : oui/non (add-db)
- Authentification : oui/non - type (add-auth)
- Email transactionnel : oui/non (add-email)
- Paiements : oui/non (add-stripe)
- Multilingue : oui/non - langues (add-i18n)
- Stockage fichiers : oui/non (add-storage)
- Traitement automatique en arrière-plan (non-IA) : oui/non - type (add-automation)
- Agent IA autonome : oui/non - but de l'agent (add-agent)
- Analytics : oui/non (add-analytics) - uniquement si demandé explicitement
```

### Step 3 - Build the clickable `file://` link

Build an absolute `file://` URL (Claude Desktop renders markdown links as clickable, which lets the user open the file in their editor). On Git Bash Windows, convert `/c/...` to `C:/...`:

```bash
ABS_PATH="$(pwd)/cahier-des-charges.md"
if [[ "$ABS_PATH" =~ ^/([a-z])/ ]]; then
  DRIVE="${BASH_REMATCH[1]^^}"
  FILE_URL="file:///${DRIVE}:${ABS_PATH#/${BASH_REMATCH[1]}}"
else
  FILE_URL="file://$ABS_PATH"
fi
echo "$FILE_URL"
```

### Step 4 - Present the result to the user

**Always** display the absolute path **and** the clickable link, then show the file content for validation:

> ✅ **Your specification is created!**
>
> **Location:** `{$PROJECT_DIR}/cahier-des-charges.md`
>
> [📄 Open the specification]({$FILE_URL})
>
> Here is its content below. Read it and tell me if you want to change anything. When it is good, I hand control back to `/bootstrap` which will show you the final recap before launching the creation.
>
> ---
>
> [full content of the file here]

---

## Return to bootstrap

Once the user validates the spec content, return control to `/bootstrap` with:
1. The path to the spec file (`cahier-des-charges.md`)
2. The infrastructure decisions (from the silent inference):
   - add-db: yes/no
   - add-auth: yes/no (+ admin / users mode)
   - add-email: yes/no
   - add-stripe: yes/no
   - add-i18n: yes/no (+ languages)
   - add-storage: yes/no
   - add-automation: yes/no (+ type)
   - add-agent: yes/no (+ agent's purpose)
   - add-analytics: yes/no (only if explicitly requested)

Bootstrap will then do the single confirmation recap (Step 4b) that gathers: project + spec + inferred addons. That is where the user validates or modifies the list, not here.
