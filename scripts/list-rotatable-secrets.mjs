#!/usr/bin/env node
// List the rotatable secrets present in the local .env, classified by provider.
// Output format: human-friendly menu, ready to be relayed to the user.
//
// Usage:
//   node list-rotatable-secrets.mjs [--json]
//
// --json : machine-readable output (array of {key, provider, category, autoGeneratable})

import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

const envPath = ".env";
if (!existsSync(envPath)) {
  if (asJson) {
    console.log("[]");
  } else {
    console.log("No .env file found in this project.");
  }
  process.exit(0);
}

const content = readFileSync(envPath, "utf8");
const keys = [];
for (const line of content.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx <= 0) continue;
  const key = trimmed.slice(0, idx).trim();
  if (key) keys.push(key);
}

// Patterns and their provider category. Order matters - first match wins.
const PATTERNS = [
  // Stripe
  { match: /^STRIPE_SECRET_KEY$/, provider: "Stripe", label: "Stripe server secret key", category: "payments", autoGen: false },
  { match: /^STRIPE_WEBHOOK_SECRET$/, provider: "Stripe", label: "Stripe webhook secret", category: "payments", autoGen: false },
  { match: /^STRIPE_/, provider: "Stripe", label: "Stripe configuration", category: "payments", autoGen: false },
  // Email
  { match: /^BREVO_API_KEY$/, provider: "Brevo", label: "Brevo API key", category: "email", autoGen: false },
  { match: /^RESEND_API_KEY$/, provider: "Resend", label: "Resend API key", category: "email", autoGen: false },
  // OAuth
  { match: /^AUTH_GOOGLE_(ID|SECRET)$/, provider: "Google OAuth", label: "Google login (OAuth)", category: "auth", autoGen: false, group: "google-oauth" },
  { match: /^AUTH_GITHUB_(ID|SECRET)$/, provider: "GitHub OAuth", label: "GitHub login (OAuth)", category: "auth", autoGen: false, group: "github-oauth" },
  // LLM providers. OPENROUTER_API_KEY is the one the plugin installs; the two
  // others belong to projects that deliberately call a provider directly, and
  // they must stay rotatable for exactly that reason.
  { match: /^OPENROUTER_API_KEY$/, provider: "OpenRouter", label: "AI key of the project", category: "llm", autoGen: false },
  { match: /^OPENAI_API_KEY$/, provider: "OpenAI", label: "OpenAI API key", category: "llm", autoGen: false },
  { match: /^ANTHROPIC_API_KEY$/, provider: "Anthropic", label: "Anthropic API key", category: "llm", autoGen: false },
  // The admin's production password (its hash): a new one through admin-password.mjs, which writes it
  // in a file of the user's downloads folder, never in the conversation (3.4.13). The development
  // one is the fixed Admin1234!: nothing to renew.
  { match: /^ADMIN_PASSWORD_HASH_PROD$/, provider: "Internal", label: "Admin password (production)", category: "internal", autoGen: false, special: "admin-password" },
  // Self-managed (auto-generatable)
  { match: /^AUTH_SECRET$/, provider: "Internal", label: "NextAuth session secret", category: "internal", autoGen: true },
  { match: /^CRON_SECRET$/, provider: "Internal", label: "Scheduled tasks token", category: "internal", autoGen: true },
  { match: /_WEBHOOK_SECRET$/, provider: "Internal", label: "Internal webhook secret", category: "internal", autoGen: true },
  { match: /^INTERNAL_/, provider: "Internal", label: "Internal secret", category: "internal", autoGen: true },
  // DB / infra (special cases)
  { match: /^DATABASE_URL$/, provider: "Neon", label: "Database connection (Neon)", category: "infra", autoGen: false, special: "neon" },
  { match: /^CLOUDFLARE_API_TOKEN$/, provider: "Cloudflare", label: "Cloudflare token", category: "infra", autoGen: false },
  { match: /^BLOB_READ_WRITE_TOKEN$/, provider: "Vercel Blob", label: "Vercel Blob token", category: "infra", autoGen: false },
  { match: /^R2_/, provider: "Cloudflare R2", label: "Cloudflare R2 key", category: "infra", autoGen: false },
];

// NEXT_PUBLIC_* keys are NOT secret (they're exposed client-side), don't list as rotatable
function isPublic(key) {
  return key.startsWith("NEXT_PUBLIC_") || key.startsWith("PUBLIC_");
}

const matched = [];
for (const key of keys) {
  if (isPublic(key)) continue;
  const pattern = PATTERNS.find((p) => p.match.test(key));
  if (pattern) {
    matched.push({ key, ...pattern, match: undefined });
  } else if (/(_SECRET|_KEY|_TOKEN|_PASSWORD)$/.test(key)) {
    // Generic secret-looking key
    matched.push({ key, provider: "Unknown", label: key, category: "other", autoGen: false });
  }
}

// Group OAuth pairs (ID + SECRET) into one item
const grouped = [];
const seenGroups = new Set();
for (const item of matched) {
  if (item.group && seenGroups.has(item.group)) continue;
  if (item.group) {
    seenGroups.add(item.group);
    const pair = matched.filter((m) => m.group === item.group);
    grouped.push({
      ...item,
      key: pair.map((p) => p.key).join(" + "),
      keys: pair.map((p) => p.key),
    });
  } else {
    grouped.push(item);
  }
}

if (asJson) {
  console.log(JSON.stringify(grouped, null, 2));
  process.exit(0);
}

// Human output, grouped by category
const CATEGORY_TITLES = {
  payments: "💳 Payments",
  email: "📧 Email",
  auth: "🔐 Login",
  llm: "🤖 AI / LLM",
  internal: "⚙️ Project-internal",
  infra: "🏗️ Infrastructure",
  other: "❓ Other",
};

const byCategory = {};
for (const item of grouped) {
  if (!byCategory[item.category]) byCategory[item.category] = [];
  byCategory[item.category].push(item);
}

const order = ["payments", "email", "auth", "llm", "internal", "infra", "other"];
let n = 0;
let out = "Here are the keys you can renew in this project :\n";
for (const cat of order) {
  const items = byCategory[cat];
  if (!items || items.length === 0) continue;
  out += `\n**${CATEGORY_TITLES[cat]}**\n`;
  for (const item of items) {
    n += 1;
    out += `  ${n}. ${item.label} (\`${item.key}\`)`;
    if (item.autoGen) out += "  *- automatic renewal, no user action*";
    if (item.special === "neon") out += "  *- warning : brief site downtime*";
    if (item.special === "admin-password") out += "  *- the new one works after the next deployment*";
    out += "\n";
  }
}
out += "\nTell me the number (or the key name) to renew.";
console.log(out);
