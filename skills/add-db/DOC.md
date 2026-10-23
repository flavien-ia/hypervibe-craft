# /add-db

Adds a **database** to your project so you can store information that persists over time. Hypervibe provisions a PostgreSQL database hosted in Europe, wires it into your code, and enables automatic backups.

## When to use it

- When your app needs to store information: users, orders, articles, customer records, bookings, editorial content, etc.
- Often called automatically by `/bootstrap` when the project is created. You can also run it later if you want to add persistence to an existing project.

## How it works

1. **Check**: Hypervibe looks at whether a database is already wired into this project.
  - If so, a small menu offers you: push the schema, migrate to a new database, reset the tables, or redo everything. No risk of duplicates.
  - Otherwise, it moves on.
2. **Neon project creation**: a Neon project is created under your account, in the `aws-eu-central-1` region (Frankfurt), the same region as your Vercel functions for minimal latency.
3. **Driver installation**: the Neon serverless driver is installed in your project (edge-computing compatible).
4. **Drizzle ORM configuration**: Hypervibe configures Drizzle (the tool that acts as the intermediary between your code and the database) to talk to your Neon database.
5. **Schema application**: the structure of the tables you have (or that Hypervibe creates) is pushed to the database. From now on, your code can read from and write to it.
6. **Saving the key**: the connection string (`DATABASE_URL`) is saved both in your local `.env` and on Vercel (production + preview + development). You have nothing to copy and paste.
7. **Automatic backups**: Hypervibe quietly enables automatic backups (a new one every 2 weeks, keeping the 2 latest + 3 historical ones over 9 months).

## What it creates for you

- A **Neon project** in your name, ready to receive data
- The **Drizzle schema file** (`src/server/db/schema.ts`) where you (or Hypervibe) will define your tables
- The connection configured in `src/server/db/index.ts`
- The handy commands: `pnpm db:push` (to push a schema change) and `pnpm db:studio` (to explore your data in a graphical interface)
- **Automatic backups** enabled (a Cloudflare Worker shared across your projects)

## Prerequisites

- The project must be a Next.js project (typically initialized by `/bootstrap`)
- A Neon API key must be stored in your vault (item `NEON`) - created once on console.neon.tech. Hypervibe detects this and guides you to add it if nothing is available.

## Tips

{{callout:tip|Neon free plan}}
Neon offers a very generous free plan: 100 projects max, 1 GB of storage per project (20 GB across all projects), 100 compute hours per month. The database pauses automatically when nobody is using it (zero cost when idle). More than enough for the vast majority of projects.
{{/callout}}

{{callout:info|Backups come for free}}
You don't have to configure backups manually: Hypervibe enables a Cloudflare Worker shared across all your projects that takes a Neon snapshot every 2 weeks. A single Cloudflare "slot" used, even for 50 projects.
{{/callout}}

{{callout:warning|Data in Europe}}
The database is deliberately created in Europe (Frankfurt) to comply with RGPD on the data-residency side. You have nothing to do for that.
{{/callout}}
