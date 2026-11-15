# /bootstrap

Creates a complete web project from your description in a few sentences. Code, hosting, database, payments: everything is set up to have an app online in 15 to 25 minutes.

## When to use it

To start a new project. It is the most powerful command in the plugin: you describe what you want in a few sentences, and it builds the whole app.

## How it works

The bootstrap unfolds in **8 steps**, with two fully autonomous phases and a discussion phase in the middle:

**Phase 1: Automatic construction** (~5 minutes, no intervention)
1. You give the **project name** and a **short description**.
2. Hypervibe builds the skeleton of the app: code structure, GitHub repo, Vercel configuration, first page online, security checks. You watch the steps scroll by; at the end, your site already responds with a minimal page and the automatic deployment is validated.

**Phase 2: What we build** (variable duration, discussion)
3. Hypervibe asks you **how you want to define the project**, with two options:
  - **The core of your app** (recommended): you describe the one thing your app must do well, in one or two screens. In vibe coding, this is what gives the best results: you get the core working first, adjust it until it is right, then add the features one by one, as you need them. An app built all at once is harder to steer, and part of it usually has to be removed.
  - **A full spec**: you build it together, question by question (pages, design, features), and Hypervibe builds everything it describes.
4. Hypervibe presents you a **summary** of the inferred features (database, authentication, emails, payments, etc.) and waits for your validation. You can change the list as much as you want before validating.

**Phase 3: Building the app** (~10-15 minutes, no intervention)
5. **Module configuration** (one by one): database, authentication, emails, payments, multilingual, storage... according to your validation.
6. **Building the application**: with the core, only its one or two screens (and the admin area if the core needs one), finished and designed; with the full spec, every page it describes. Responsive layout in both cases.
7. **Legal pages** automatically created (legal notice, GDPR-compliant privacy policy).
8. **Security audit + final push + summary**: dependency check, deployment, and a complete summary of what was done and what may remain to be done on your side (create an account on a given service, configure a domain, etc.).

At the end, you have an online, functional site, with all the technical building blocks in place.

## What it creates for you

- A complete **Next.js 15** project (structure, dependencies, configuration)
- A **private GitHub repo** with all the code versioned
- A **Vercel project** with automatic deployment (each change deploys on its own)
- An **online URL** where your app is accessible immediately
- According to what you chose: database, authentication, emails, payments, multilingual, storage, analytics
- The **legal pages** (legal notice + GDPR-friendly privacy policy)
- A `CLAUDE.md` file that serves as memory for Claude on this project (with the core, it keeps what the core is, its screens and what you left for later)
- All of it **hosted in Europe** (Frankfurt) for latency and GDPR compliance

## Prerequisites

- `/start` must have been run once on your machine (tools installed + accounts connected)
- If you plan to add a database, a Neon API key must be in your vault (Hypervibe guides you to add it if needed)

## Tips

{{callout:tip|If the session is interrupted}}
The bootstrap is long. If the Claude conversation is interrupted along the way (context limit, error, accidental close), no panic: just say **"continue"** in the same chat. Hypervibe re-reads its own thread and resumes where it left off. No work is lost.
{{/callout}}

{{callout:info|You do not write a single line of code}}
You describe your project in natural language, you validate the choices proposed to you. Everything else, code, configuration, deployment, security, is fully automated. You have **nothing** to type in a terminal.
{{/callout}}

{{callout:tip|Start with the core, then grow it}}
With the core, the final summary tells you what comes next: try the core, ask for the corrections you want until it is right, then add one feature at a time, simply by describing it in a sentence.
{{/callout}}

{{callout:warning|Name choice = final}}
The project name you give at Step 1 becomes the name of the GitHub repo and the Vercel project. These two names are hard to change afterward. Choose well (in kebab-case, for example: `my-great-app`).
{{/callout}}
