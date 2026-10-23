#!/usr/bin/env node
// run-all.mjs - Every recette of the plugin, in one command.
//
//   node scripts/tests/run-all.mjs
//
// Run this before a release. None of these touch the network, a real project or
// a real database: they work on temporary fixtures and on the plugin's own
// sources, so they are safe to run anywhere, any number of times.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync as guardExists, mkdtempSync as guardDir, readFileSync as guardRead, rmSync as guardRemove } from "node:fs";
import { tmpdir as guardTmp } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SUITES = [
  ["managed rule blocks", join(ROOT, "scripts", "tests", "test-managed-block.mjs")],
  ["the rule on database reads: columns named in findFirst too, the read cached rather than the page, both plans, an untouched copy updated (3.4.16)", join(ROOT, "scripts", "tests", "test-db-reads-rule.mjs")],
  ["global block size", join(ROOT, "scripts", "rules", "measure.mjs")],
  ["bash guardrails", join(ROOT, "hooks", "test-hooks.mjs")],
  ["no skill tells Claude to run a command its guard refuses", join(ROOT, "scripts", "tests", "test-skills-guard.mjs")],
  ["the plugin's paths and the organisation's name are set by the skill that uses them", join(ROOT, "scripts", "tests", "test-skill-variables.mjs")],
  ["git hooks chain (a clone never runs its hooks)", join(ROOT, "scripts", "tests", "test-hooks-chain.mjs")],
  ["child processes and paths with spaces", join(ROOT, "scripts", "tests", "test-spawn-paths.mjs")],
  ["workflow actions on a Node GitHub still runs", join(ROOT, "scripts", "tests", "test-workflow-actions.mjs")],
  ["commands run through a shell work in Windows' shell too", join(ROOT, "scripts", "tests", "test-shell-portable.mjs")],
  ["the folder /bootstrap creates a project in", join(ROOT, "scripts", "tests", "test-detect-projects-dir.mjs")],
  ["Vercel's GitHub application, checked by /start", join(ROOT, "scripts", "tests", "test-vercel-github-app.mjs")],
  ["gh's sign-in asked of the active account", join(ROOT, "scripts", "tests", "test-gh-signin.mjs")],
  ["zip writer", join(ROOT, "scripts", "tests", "test-zip.mjs")],
  ["memory index trimming", join(ROOT, "scripts", "tests", "test-memory-index.mjs")],
  ["shared resources never deleted with a project", join(ROOT, "scripts", "tests", "test-shared-exclusion.mjs")],
  ["the repository /delete-project lists is the one the folder pushes to", join(ROOT, "scripts", "tests", "test-delete-github.mjs")],
  ["what a skill does on the forge, it says only once the forge confirms it", join(ROOT, "scripts", "tests", "test-forge-gestures.mjs")],
  ["a project's own registration on the shared clock is never recorded shared", join(ROOT, "scripts", "tests", "test-manifest-shared.mjs")],
  ["agent template fences", join(ROOT, "scripts", "tests", "test-agent-template-tools.mjs")],
  ["a value of the .env for a shell variable, its prefix for a check", join(ROOT, "scripts", "tests", "test-env-value.mjs")],
  ["SECURITY.md claims", join(ROOT, "scripts", "tests", "test-security-claims.mjs")],
  ["rate limiter: the in-memory copies agree, and the shared counter keeps the contract", join(ROOT, "scripts", "tests", "test-rate-limit.mjs")],
  ["privacy audit: every service the project is connected to, known or not", join(ROOT, "scripts", "tests", "test-rgpd-audit.mjs")],
  ["Render variables: the project's own services, from its .env", join(ROOT, "scripts", "tests", "test-render-env.mjs")],
  ["a Render service found by its exact name, and recorded in the project's manifest", join(ROOT, "scripts", "tests", "test-render-service.mjs")],
  ["a Render service is the project's by its name or by the repository it builds from", join(ROOT, "scripts", "tests", "test-render-match.mjs")],
  ["the Render worker answers as soon as it accepts the work, and the site wakes it", join(ROOT, "scripts", "tests", "test-render-worker.mjs")],
  ["every Render service the harness creates runs in the EU", join(ROOT, "scripts", "tests", "test-render-region.mjs")],
  ["a deployment read through a pipeline, and a conversion that leaves the repository's files", join(ROOT, "scripts", "tests", "test-skill-pipelines.mjs")],
  ["OVH's calls signed in the script's own process, the keys never on a command line (3.4.11)", join(ROOT, "scripts", "tests", "test-registrar-ovh.mjs")],
  ["a domain's mail and names carried into its zone before the switch, never on a failed read (3.4.11)", join(ROOT, "scripts", "tests", "test-dns-survey.mjs")],
  ["Email Routing never enabled over a domain whose mail goes elsewhere, read back (3.4.11)", join(ROOT, "scripts", "tests", "test-email-routing.mjs")],
  ["a domain whose addresses Email Routing relays, read in public DNS (3.4.13)", join(ROOT, "scripts", "tests", "test-domain-mx.mjs")],
  ["a sending domain at Brevo: its records with their own types, one DMARC record at p=none, the sender through the API, no key printed (3.4.13)", join(ROOT, "scripts", "tests", "test-brevo-domain.mjs")],
  ["/delete-project keeps a person's shared accounts without shipping them", join(ROOT, "scripts", "tests", "test-delete-keep.mjs")],
  ["skill descriptions", join(ROOT, "scripts", "tests", "test-skill-descriptions.mjs")],
  ["a script launched through a link still runs", join(ROOT, "scripts", "tests", "test-entry-point.mjs")],
  ["no skill page tells the person to paste a value into the chat", join(ROOT, "scripts", "tests", "test-doc-secrets.mjs")],
  ["skill commands and texts per host", join(ROOT, "scripts", "tests", "test-skill-commands.mjs")],
  ["AI model selection", join(ROOT, "scripts", "tests", "test-ai-models.mjs")],
  ["AI secret containment", join(ROOT, "scripts", "tests", "test-ai-secret.mjs")],
  ["vercel deploy URL parsing", join(ROOT, "scripts", "tests", "test-vercel-deploy-output.mjs")],
  ["vercel plan before taking payments", join(ROOT, "scripts", "tests", "test-vercel-plan.mjs")],
  ["vercel projects in the right team", join(ROOT, "scripts", "tests", "test-vercel-projects.mjs")],
  ["what skills promise in their own text: Vercel's request logs, cumulative refunds, Brevo's records, the contact router and the relay (3.4.13)", join(ROOT, "scripts", "tests", "test-skill-texts.mjs")],
  ["the admin's production password in a file of the downloads folder, never in the conversation (3.4.13)", join(ROOT, "scripts", "tests", "test-admin-password.mjs")],
  ["pnpm workspace overrides", join(ROOT, "scripts", "tests", "test-pnpm-workspace.mjs")],
  ["the code check of a project made before 3.4.5: ESLint's plugins back at the root, diagnosed without writing, repaired on a yes, the lockfile untouched", join(ROOT, "scripts", "tests", "test-repair-lint.mjs")],
  ["map versions and worker", join(ROOT, "scripts", "tests", "test-map-pins.mjs")],
  ["shared worker check at update", join(ROOT, "scripts", "tests", "test-worker-check.mjs")],
  ["the shared clock: its jobs, spread backups, a watch that says what it could not read", join(ROOT, "scripts", "shared-worker", "worker.test.mjs")],
  ["what the plugin knows of the shared clock before touching it", join(ROOT, "scripts", "tests", "test-clock-state.mjs")],
  ["schema drift before db:push", join(ROOT, "scripts", "tests", "test-schema-drift.mjs")],
  ["SQL helper: what it refuses, where it sends", join(ROOT, "scripts", "tests", "test-run-sql.mjs")],
  ["database export never calls a holed backup ok", join(ROOT, "scripts", "tests", "test-dump-db.mjs")],
  ["a connection string never sits in an argument", join(ROOT, "scripts", "tests", "test-push-env-stdin.mjs")],
  ["a .env line read and written as the site's loader reads it: quotes taken off, a # kept between quotes, the window and the helper agree", join(ROOT, "scripts", "tests", "test-env-line.mjs")],
  ["a variable taken out with the tool, and what only counts at the next deployment", join(ROOT, "scripts", "tests", "test-push-env-remove.mjs")],
  ["a deployment checked from a worktree, with a sign-in the tool renews itself", join(ROOT, "scripts", "tests", "test-check-deploy.mjs")],
  ["/delete-project with the vault closed: never half a deletion", join(ROOT, "scripts", "tests", "test-delete-vault.mjs")],
  ["/delete-project on a folder without cloud infrastructure: where its code stands in git, and whether deleting it would lose it (3.4.16)", join(ROOT, "scripts", "tests", "test-delete-local-git.mjs")],
  ["what the templates let through of an address that came from elsewhere", join(ROOT, "scripts", "tests", "test-template-guards.mjs")],
  ["the sender a project already has is kept by /add-email (3.4.11)", join(ROOT, "scripts", "tests", "test-email-sender.mjs")],
  ["a project's own sending key, never the account's: made by Resend's API for sending only, typed by hand at Brevo, revoked only when the project records it (3.4.16)", join(ROOT, "scripts", "tests", "test-email-key.mjs")],
  ["the email templates: Resend's client built at the first send, a reset request that never tells (3.4.11)", join(ROOT, "scripts", "tests", "test-email-templates.mjs")],
  ["accessibility: what shuts someone out is reported, its accessible counterpart is not", join(ROOT, "scripts", "tests", "test-a11y-audit.mjs")],
  ["a secret the host never gives back never erases the project's", join(ROOT, "scripts", "tests", "test-pull-sensitive-empty.mjs")],
  ["database organisation: which answers are certain", join(ROOT, "scripts", "tests", "test-neon-org.mjs")],
  ["the quota watch reads the database organisation it is told: recorded when certain, never guessed, completed on an older clock", join(ROOT, "scripts", "tests", "test-watch-neon-org.mjs")],
  ["/quotas measures every Neon project on its branches, as Neon measures the free plan's cap (1 GB per project, 20 GB in all), and never shows a size it could not read as a green 0 % (3.4.16)", join(ROOT, "scripts", "tests", "test-quotas-neon-storage.mjs")],
  ["/quotas gives each R2 bucket's size, and the month's cost it can say for sure: Vercel's billing on a paid plan, R2 beyond its free 10 GB, Neon's free plan; what it cannot read is said (3.4.16)", join(ROOT, "scripts", "tests", "test-quotas-buckets-cost.mjs")],
  ["git identity: checked and repaired, never shown", join(ROOT, "scripts", "tests", "test-git-identity.mjs")],
  ["the vault's sign-in: one folder for every program on Windows, taken over by a copy", join(ROOT, "scripts", "tests", "test-bw-home.mjs")],
  ["the vault's unlock: one window at a time, none when the vault is already open", join(ROOT, "scripts", "tests", "test-vault-unlock.mjs")],
  ["the vault's session: 6 hours for every reader, then locked for real, scheduled at the unlock and caught up at the start of a session (3.4.16)", join(ROOT, "scripts", "tests", "test-vault-session.mjs")],
  ["a local payment test run by Claude: a test price checked, both started in the background, never a command to type", join(ROOT, "scripts", "tests", "test-stripe-local-test.mjs")],
  ["the SEO a project receives: the site's address in one place, robots.txt with its sitemap, a share image drawn by next/og, earlier lines brought up to date (3.4.12)", join(ROOT, "scripts", "tests", "test-seo-setup.mjs")],
  ["/seo's live checks, and the scores of /seo and /geo on a fixed grid kept in the project (3.4.12)", join(ROOT, "scripts", "tests", "test-seo-tools.mjs")],
  ["Search Console's opportunities, read once for /gsc and /seo (3.4.12)", join(ROOT, "scripts", "tests", "test-gsc-opportunities.mjs")],
  ["/delete-project reads every page of the Cloudflare zones, records and routing rules it looks through (3.4.12)", join(ROOT, "scripts", "tests", "test-delete-cloudflare-pages.mjs")],
  ["/geo: the dated list of AI robots, the robots.txt rules built from it, a page as AI robots receive it, a skill that names no robot (3.4.12)", join(ROOT, "scripts", "tests", "test-geo.mjs")],
  ["/geo reads whether Cloudflare turns AI robots away, read only (3.4.12)", join(ROOT, "scripts", "tests", "test-geo-cloudflare.mjs")],
];

// The vault's tool never runs during a recette (_no-real-vault.mjs): every Node process of a suite
// loads the guard, which refuses a launch of `bw` without reaching anything and writes it down, and
// the suite that tried fails, named. (Node 20 and later: before, --import in NODE_OPTIONS is unknown.)
const GUARD = Number(process.versions.node.split(".")[0]) >= 20 ? pathToFileURL(join(ROOT, "scripts", "tests", "_no-real-vault.mjs")).href : null;
const guardEnv = (log) => (GUARD ? { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${GUARD}`].filter(Boolean).join(" "), HV_RECETTE_VAULT_LOG: log } : {});
/** What a suite's guard wrote down, said as a failure, or null. */
function vaultNote(log) {
  if (!guardExists(log)) return null;
  const who = [...new Set(guardRead(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).script))].join(", ");
  return `\nECHEC : cette recette a lance l'outil du coffre (bw), refuse sans rien atteindre : ${who}. Une recette ne l'ouvre jamais : lui donner un dossier personnel a elle, ou un faux coffre.\n`;
}
/** One suite, under the guard: its output, or the error that says why it failed. */
function runSuite(script) {
  const work = guardDir(join(guardTmp(), "hv-recette-coffre-"));
  const log = join(work, "bw.log");
  let out;
  let error = null;
  try {
    out = execFileSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ...guardEnv(log) } });
  } catch (e) {
    error = e;
  }
  try {
    const note = vaultNote(log);
    if (note && error) error.stdout = `${error.stdout ?? ""}${note}`;
    if (note && !error) error = Object.assign(new Error("vault"), { stdout: `${out}${note}`, stderr: "" });
    if (error) throw error;
    return out;
  } finally {
    guardRemove(work, { recursive: true, force: true });
  }
}

let failed = 0;
for (const [nom, script] of SUITES) {
  process.stdout.write(`\n=== ${nom} ===\n`);
  try {
    const out = runSuite(script);
    // Only the tail matters when everything passes.
    const lignes = out.trimEnd().split("\n");
    process.stdout.write(lignes.slice(-2).join("\n") + "\n");
  } catch (e) {
    failed += 1;
    process.stdout.write((e.stdout ?? "") + (e.stderr ?? "") + "\n");
  }
}

if (failed) {
  console.error(`\n${failed} suite(s) en echec`);
  process.exit(1);
}
console.log("\nToutes les recettes passent.");
