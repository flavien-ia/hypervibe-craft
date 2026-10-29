# /spec

Builds a structured **specification** (cahier des charges) for your project with you, one question at a time, no jargon.

## When to use it

- Before a `/bootstrap` when you want to take the time to clarify what you really want to build
- At any moment to clarify a new project, even if you are not going to start it right away
- When you have a jumble of ideas and want to structure them before coding

The specification it produces is a readable `.md` file that `/bootstrap` can then consume.

## How it works

Hypervibe guides you through **4 short blocks**. At each block, you answer the questions at your own pace, Hypervibe sums up what it understood, and we move on to the next one.

**Block 1: Project identity**
- Who is the app for (customers, colleagues, general public, yourself)?
- What problem does it solve?
- Are you drawing inspiration from an existing site or app for the vibe?

**Block 2: The pages**
- Which pages should your app have? (Hypervibe proposes a baseline like "home, about, contact, dashboard" that you adapt.)
- For each page, what does the user see? What actions can they take?
- Is there an admin or restricted area?

**Block 3: The design**
- What visual vibe? Several options are offered: modern and clean, dark and elegant, colorful and dynamic, corporate, or something else.
- Do you have any colors in mind?
- A site you find beautiful and that we can use as a reference?

**Block 4: Content and details**
- Have you already written some copy, or do we put in placeholder content to replace later?
- Anything we did not cover? (A specific integration, a tool you absolutely want to use, a particular constraint.)

At the end, Hypervibe writes the `cahier-des-charges.md` file into your project folder and shows it to you for validation. You can still edit it before it gets used.

## What it creates for you

- A clear, structured `cahier-des-charges.md` file, ready to be consumed by `/bootstrap`
- A written record of your vision for the project (useful for you, for others, for yourself in 6 months)
- Hypervibe also takes the opportunity to silently infer the technical building blocks you will need (database, auth, payments, etc.). You do **not** need to think about them

## Prerequisites

None. You can run `/spec` even without an existing project. If you launch it from `/bootstrap`, even better, because the project's name and initial description are already known.

## Tips

{{callout:tip|Audio mode}}
To answer faster and more naturally, switch to **audio mode** in Claude Desktop (microphone icon in the chat bar). You speak, Claude understands. Often smoother than typing everything out, especially when describing your vision.
{{/callout}}

{{callout:info|No technical jargon expected}}
You do not need to know any technical terms. If Hypervibe asks you something, it is in plain language. If an option is not clear, ask it to explain or to suggest concrete examples.
{{/callout}}
