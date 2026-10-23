# /quotas

Shows where your usage stands on each service against the free-plan caps. Handy for anticipating an overage without having to open 6 separate dashboards (Neon, Cloudflare, Brevo, Resend, Vercel).

## When to use it

- You want to **anticipate a quota overage** and switch to a paid plan in time
- You want to **understand** where your free plans stand (without having to open 6 separate dashboards)
- You want to check, after a spike in load (e.g. a product launch), that no service is hitting its limit

## How it works

1. **Running the script**: Hypervibe runs 6 fetchers in parallel that query each service's API. It takes 2 to 5 seconds.

2. **Fetching the data**: for each service, Hypervibe reads:
  - **Neon**: number of projects used, storage used (per project, up to 1 GB each and 20 GB in all, read on each project's branches as Neon measures it), compute hours used (up to 100h / month / project)
  - **Cloudflare R2**: GB stored, read/write operations, and the size of each bucket
  - **Cloudflare Workers**: requests / day, cron slots used out of the 5 free ones
  - **Brevo**: emails sent / month (up to 300/day free)
  - **Resend**: emails sent / month (3,000 free) + 100/day
  - **Vercel**: bandwidth, functions, builds, hobby seats

3. **Table display**: each metric has:
  - **Usage** vs **cap** (e.g. *"0.247 GB / 1 GB (24.7%)"*)
  - **Emoji verdict**: ✅ (under 70%), ⚠️ (70-90%), 🔴 (90%+), and ❓ for a figure that could not be read: never a green 0 %
  - **Projection** when applicable (e.g. *"At the current pace, you will reach the cap in 18 days"*)

4. **Detailed breakdown**: for Neon (which has **per-project** quotas), Hypervibe also shows the detail per project, to identify exactly which one is consuming the most. For R2, when the storage gets close to its cap, it names your three largest buckets, with their size and their number of files (read only: nothing is deleted).

5. **Advice**: for each ⚠️ or 🔴 verdict, Hypervibe proposes concrete actions (lighten the project, move to a higher plan, etc.).

6. **The month's cost, if you ask**: ask how much it costs you and Hypervibe adds an estimate limited to what it can read or compute for sure: Vercel's own billing on a paid plan (with the month at this pace), R2's storage beyond its free 10 GB, Neon's free plan at 0 $. It says what it does not count: Cloudflare's subscription (the key has no right to read billing) and the email providers' plans. An estimate, never the bill.

7. **Daily watch (checked in passing)**: while it is at it, Hypervibe makes sure your daily quota watch is in place: a small job on your **shared clock** (the mutualized mechanism that also runs your scheduled tasks and database backups) checks your Cloudflare R2 storage once a day and emails you if you approach the free 10 GB (alert from 9 GB). No standalone machinery, no extra Cloudflare slot.

## What it creates for you

- A **table report** with your current usage on the 6 main services
- A **per-project** view when relevant (Neon in particular)
- **Recommendations** to anticipate an overage
- No change to your accounts or plans: the report is read-only. The only thing `/quotas` may set up (the first time) is the **daily watch job** on your shared clock, so you get warned by email between two reports

## Prerequisites

- The relevant services must be connected to your machine (via `/start` or via the user-scope API keys)
- You can run `/quotas` from any folder, it is an **account-wide** view, not project-specific

## Tips

{{callout:tip|Run it every month}}
A regular glance (at the start of each month) saves you the unpleasant surprise of an overage. It is especially useful for Neon (which has per-project quotas) and Resend (3,000 emails / month goes fast if you have several apps). And between two reports, the daily watch on your shared clock keeps an eye on your storage for you.
{{/callout}}

{{callout:info|Free plans = genuinely comfortable}}
For the vast majority of personal or small-business projects, you will stay well below the free caps. Hypervibe says so in the report when a service is *very* far from the limit (e.g. *"you are using 2% of Cloudflare R2, you are fine for years"*).
{{/callout}}

{{callout:warning|Neon = per-project caps}}
Neon specificity: the 1 GB of storage and 100h of compute are **per project**, not per account, and the storage also has a cap on the whole account: 20 GB across all projects. **Each project** must not exceed 1 GB. Hypervibe shows the per-project breakdown to identify the one that is filling up.
{{/callout}}
