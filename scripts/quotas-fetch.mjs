#!/usr/bin/env node
// quotas-fetch.mjs - Deterministic core for /quotas.
//
// Fetches free-tier usage in parallel from 6 services, outputs a single
// JSON document on stdout. Claude (in skills/quotas/SKILL.md) renders the
// human-friendly table + verdicts.
//
// Services covered:
//   - Neon (Postgres)            via REST + NEON_API_KEY
//   - Cloudflare R2              via REST + GraphQL + CLOUDFLARE_API_TOKEN
//   - Cloudflare Workers         via GraphQL Analytics + same token
//   - Brevo                      via REST + BREVO_API_KEY
//   - Resend                     via REST with RESEND_FULL_ACCESS_KEY
//                                (self-healed: creates the key once via CLI
//                                if absent, persists at User scope)
//   - Vercel (Hobby)             via REST - partial (deployment count only,
//                                bandwidth & function-time are gated on Pro)
//
// Each fetcher runs under a 10s timeout. One service down doesn't kill the
// run - Promise.allSettled ensures every result is collected.
//
// Usage:
//   node quotas-fetch.mjs [--cf-account <id>]
//
// Output (stdout): JSON. Last line is `{"_quotas":...}` for easy parsing.
// Exit code: always 0 unless a fatal setup error occurs (then 1 with a JSON
// {"_error": "..."} on stderr).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readUserEnv } from "./_read-user-env.mjs";
import { writeUserEnv } from "./_write-user-env.mjs";
import { getSecret } from "./vault/vault.mjs";
import { resolveNeonOrg, withOrg } from "./neon-org.mjs";
import { loadAuthToken } from "./_vercel-auth.mjs";

/** Optional vault field: absent is a normal answer here, never a reason to give up. */
function vaultGetOptional(item, field) {
  try { return getSecret(item, field) || ""; } catch { return ""; }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Free-tier limits live in a sidecar JSON (scripts/quotas-limits.json).
// This is the single source of truth for "free plan caps". The script reads it
// at runtime - no fallback embedded in code, no auto-update from the web. To
// reflect provider changes, edit the JSON and ship a new plugin version.
const LIMITS = JSON.parse(readFileSync(join(__dirname, "quotas-limits.json"), "utf8"));

// ─── Args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let cfAccountOverride = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cf-account" && args[i + 1]) cfAccountOverride = args[++i];
}

// ─── Time helpers ─────────────────────────────────────────────────────
const NOW = new Date();
const MONTH_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const MONTH_END = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1));
const DAY_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));

const billingCycle = {
  monthStart: MONTH_START.toISOString(),
  monthEnd: MONTH_END.toISOString(),
  dayStart: DAY_START.toISOString(),
  daysElapsedInMonth: Math.floor((NOW - MONTH_START) / 86400000),
  daysRemainingInMonth: Math.ceil((MONTH_END - NOW) / 86400000),
};

// ─── Fetch helper with timeout ───────────────────────────────────────
//
// The 10s default fits endpoints that return a fixed-size payload. Listing
// endpoints that enumerate every project/bucket of an account grow with the
// account and need an explicit, longer budget at the call site (see fetchNeon):
// on a loaded account the listing alone exceeds 10s, the AbortController fires,
// and the WHOLE service is reported as unavailable ("This operation was
// aborted") even though the key and the API are perfectly fine.
async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ac.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 100)}`);
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ─── The month's cost (3.4.16 / 2.4.15) ──────────────────────────────
// Only what is read or computed for sure: Vercel's own billing on a paid plan, R2's storage
// beyond its free 10 GB at its published price, Neon's free plan. Nothing is guessed, and what is
// not counted is said (cost.notCounted). The skill shows it only when the person asks about cost.
const R2_STANDARD_USD_PER_GB_MONTH = 0.015; // developers.cloudflare.com/r2/pricing, read on 23/10/2026
const MONTH_FRACTION = (NOW - MONTH_START) / (MONTH_END - MONTH_START);

/** A JSONL answer, one JSON object per line (Vercel's FOCUS billing charges). */
async function fetchJsonLines(url, options = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, lines: [] };
    const lines = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        return { ok: false, status: res.status, lines: [], unreadable: true };
      }
    }
    return { ok: true, status: res.status, lines };
  } finally {
    clearTimeout(t);
  }
}

/** The month's Vercel charges (GET /v1/billing/charges, FOCUS 1.3, from the 1st of the month to
 *  now): what is billed so far, and the month at this pace. Usage charges are projected over the
 *  month; the rest (the plan's seats, taxes, credits) counts once, never multiplied. */
async function vercelMonthCost(token, teamId) {
  const url = `https://api.vercel.com/v1/billing/charges?from=${encodeURIComponent(MONTH_START.toISOString())}&to=${encodeURIComponent(NOW.toISOString())}${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ""}`;
  const r = await fetchJsonLines(url, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ ok: false, status: 0, lines: [] }));
  if (!r.ok) {
    return {
      service: "vercel",
      label: "Vercel",
      status: "unavailable",
      note: r.status === 403
        ? "Vercel refuse de lire la facturation avec cette clé (il faut un rôle qui voit la facturation de l'équipe)."
        : `Facturation Vercel illisible (${r.unreadable ? "réponse illisible" : `HTTP ${r.status || "sans réponse"}`}).`,
    };
  }
  let usage = 0;
  let other = 0;
  const currencies = new Set();
  for (const c of r.lines) {
    const billed = Number(c?.BilledCost);
    if (!Number.isFinite(billed)) continue;
    if (c.BillingCurrency) currencies.add(String(c.BillingCurrency));
    if (c.ChargeCategory === "Usage") usage += billed;
    else other += billed;
  }
  const currency = currencies.size === 1 ? [...currencies][0] : currencies.size === 0 ? "USD" : null;
  const round = (n) => Math.round(n * 100) / 100;
  const early = MONTH_FRACTION < 1 / 31;
  return {
    service: "vercel",
    label: "Vercel",
    status: currency ? "measured" : "unavailable",
    currency,
    monthToDate: round(usage + other),
    projected: currency && !early ? round(other + usage / MONTH_FRACTION) : null,
    note: !currency
      ? "Facturation Vercel en plusieurs devises : non additionnée."
      : early
        ? "Mois commencé depuis moins d'un jour : pas encore de projection."
        : "Facturé depuis le 1er du mois ; l'usage est projeté au rythme actuel, le forfait compté une fois.",
  };
}

function asMetric(name, used, limit, unit, scope = "account-month") {
  return {
    name,
    used: Math.round(used * 1000) / 1000,
    limit,
    unit,
    pctUsed: limit ? Math.round((used / limit) * 1000) / 10 : null,
    scope,
  };
}

// ─── Self-healing Resend full-access key ─────────────────────────────
function ensureResendFullAccessKey() {
  // The Resend key lives in the vault (item RESEND, field api_key) - full-access by design.
  // No more CLI minting. Falls back to a legacy env var during the migration period.
  try {
    const key = getSecret("RESEND", "api_key");
    return { key, justCreated: false };
  } catch (e) {
    if (e.code === 2 || e.code === 3) {
      return { key: null, justCreated: false, reason: "Coffre-fort verrouillé - déverrouille-le (bw unlock) puis réessaie." };
    }
    // code 4 (absente du coffre) → fallback env legacy ci-dessous.
  }
  const legacy = readUserEnv("RESEND_API_KEY") || readUserEnv("RESEND_FULL_ACCESS_KEY");
  if (legacy) return { key: legacy, justCreated: false };
  return {
    key: null,
    justCreated: false,
    reason: 'Clé Resend absente du coffre. Range-la : `node scripts/vault/launch.mjs add --name RESEND --service Resend --fields "api_key:secret"`.',
  };
}

// ─── Service: Neon ────────────────────────────────────────────────────
//
// Limits in scripts/quotas-limits.json under LIMITS.neon.free.
//
// IMPORTANT: BOTH storage and compute are per-project on Free Plan (not
// account-wide!). Summing across projects and comparing to a single budget
// is doubly wrong. We surface the heaviest project for each metric (the one
// closest to its own per-project cap), plus list any project that's already
// over its limit.
async function fetchNeon() {
  let apiKey;
  let coffreFerme = false;
  try {
    apiKey = getSecret("NEON", "api_key");
  } catch (e) {
    // Un coffre verrouillé (2) ou une session expirée (3) n'est pas une clé absente : le dire,
    // sinon la personne part créer une seconde clé pour un service déjà configuré.
    coffreFerme = e?.code === 2 || e?.code === 3;
    apiKey = readUserEnv("NEON_API_KEY");
  }
  if (!apiKey && coffreFerme) return svc("neon", "Neon (Postgres)", false, [], "Coffre-fort verrouillé : la clé Neon n'a pas pu être lue. Déverrouille-le puis réessaie (rien n'est à reconfigurer).");
  if (!apiKey) return svc("neon", "Neon (Postgres)", false, [], "Clé API Neon non configurée (coffre-fort `NEON` ou env). `/start` la met en place.");

  // Try to read the actual plan from the org endpoint so we can be honest
  // about whether the displayed limits even apply.
  // 45s like the list call below, and for the same non-obvious reason: the
  // sibling service fetchers each run a SYNCHRONOUS vault read (spawnSync,
  // seconds each) that blocks the event loop while this request is in flight.
  // With the default 10s budget the timer expires DURING those blocks and
  // aborts a request the API answered in <1s (seen 2026-08-02).
  // Which organisation, though? This endpoint lists every organisation the key is a
  // MEMBER of, other people's included, so reading [0] reported a stranger's plan
  // whenever the account belonged to more than one. Resolve it properly, and only
  // claim a plan when we know whose it is.
  const org = await resolveNeonOrg(apiKey, vaultGetOptional);
  const orgs = await fetchJson("https://console.neon.tech/api/v2/users/me/organizations", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  }, 45000);
  const liste = orgs.ok ? orgs.json.organizations || [] : [];

  // 45s (not the 10s default): this endpoint enumerates EVERY project of the
  // account with its storage/compute counters, so it gets slower as the account
  // fills up. The free tier allows 100 projects; at that scale the listing
  // routinely takes >10s and the default budget would abort the whole Neon
  // block, reporting "indisponible" on a perfectly healthy account.
  const r = await fetchJson(withOrg("https://console.neon.tech/api/v2/projects?limit=400", org.orgId), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  }, 45000);
  if (!r.ok) return svc("neon", "Neon (Postgres)", false, [], `API Neon: HTTP ${r.status}`);

  const projects = r.json.projects || [];

  // De quelle organisation ces projets viennent-ils ? Ils le disent eux-memes. C'est plus
  // sur que de deviner : sans org_id resolu, Neon a repondu pour l'organisation par defaut
  // du compte, et c'est SON plan qui s'applique aux chiffres ci-dessous. Annoncer
  // "unknown" ferait conclure a tort qu'il n'y a pas de plafond.
  const orgEffectif = org.orgId || projects[0]?.org_id || null;
  const plan = orgEffectif
    ? liste.find((o) => o.id === orgEffectif)?.plan || "free"
    : liste.length === 1 ? liste[0].plan || "free" : "unknown";

  // ⚠️ The LIST endpoint does NOT carry the consumption counters
  // (compute_time_seconds / data_transfer_bytes are absent from its items;
  // only synthetic_storage_size is there). The old code read `cpu_used_sec`
  // from the list and therefore always reported 0 h of compute - the exact
  // blind spot that let a compute leak go unnoticed in July 2026. The
  // authoritative counters live on the per-project GET, so fan out one GET
  // per project (bounded concurrency, the whole block has a 45s budget).
  const details = [];
  const CHUNK = 8;
  for (let i = 0; i < projects.length; i += CHUNK) {
    const chunk = await Promise.all(
      projects.slice(i, i + CHUNK).map(async (p) => {
        const d = await fetchJson(`https://console.neon.tech/api/v2/projects/${p.id}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        }, 15000).catch(() => null);
        return d?.ok ? d.json.project : p; // fall back to the list item (storage only)
      }),
    );
    details.push(...chunk);
  }

  // The size of each project, read where Neon computes the free plan's cap: the sum of the
  // logical_size of its branches ("The Free plan caps storage per project based on logical_size
  // across branches", "Sum across branches to get total project storage": Neon's usage and cost
  // calculations, read on 23/10/2026). The project's own figure (synthetic_storage_size) is a
  // legacy counter: 0 on a usage-based plan (312 MB of a Launch account shown as 0 GB, Bastien
  // Detraz, 22/10/2026), and 0 on the 17 projects of a free account on 16/10/2026, full databases
  // included, behind a green 0 %. It is only a fallback now, when the branches do not answer.
  // A size read nowhere is said, never shown as 0 GB.
  const sizes = [];
  for (let i = 0; i < details.length; i += CHUNK) {
    const chunk = await Promise.all(
      details.slice(i, i + CHUNK).map(async (p) => {
        const b = await fetchJson(`https://console.neon.tech/api/v2/projects/${p.id}/branches`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        }, 15000).catch(() => null);
        if (b?.ok && Array.isArray(b.json?.branches)) {
          return { bytes: b.json.branches.reduce((n, br) => n + (Number(br.logical_size) || 0), 0), from: "branches" };
        }
        const own = Number(p.synthetic_storage_size) || 0;
        return own > 0 ? { bytes: own, from: "project" } : { bytes: 0, from: "unread" };
      }),
    );
    sizes.push(...chunk);
  }
  const sizeUnread = details.filter((_, i) => sizes[i].from === "unread").map((p) => p.name);
  const sizeFromProject = details.filter((_, i) => sizes[i].from === "project").map((p) => p.name);

  // Build per-project view. On Free, storage, compute AND egress are all capped
  // per project. Egress was long treated here as pooled across the account;
  // Neon's plans page states otherwise ("5 GB per project per month", "the
  // network transfer allowance is per project", checked 2026-09-18), so a sum
  // of small projects no longer reads as an alarm: only the heaviest one counts.
  const projectsView = details.map((p, i) => ({
    name: p.name,
    sizeFrom: sizes[i].from,
    storageGB: sizes[i].bytes / 1073741824,
    computeH: (p.compute_time_seconds || 0) / 3600,
    egressGB: (p.data_transfer_bytes || 0) / 1073741824,
  }));

  const projectsByStorage = [...projectsView].sort((a, b) => b.storageGB - a.storageGB);
  const projectsByCompute = [...projectsView].sort((a, b) => b.computeH - a.computeH);
  const projectsByEgress = [...projectsView].sort((a, b) => b.egressGB - a.egressGB);

  const heaviestStorage = projectsByStorage[0] || { name: "-", storageGB: 0 };
  const heaviestCompute = projectsByCompute[0] || { name: "-", computeH: 0 };
  const heaviestEgress = projectsByEgress[0] || { name: "-", egressGB: 0 };

  const L = LIMITS.neon.free;
  const overStorageLimit = projectsView.filter((p) => p.storageGB > L.storageGBPerProject);
  const overComputeLimit = projectsView.filter((p) => p.computeH > L.computeHoursPerProject);
  const overEgressLimit = projectsView.filter((p) => p.egressGB > L.egressGBPerProjectPerMonth);

  // Limits depend on the plan. Free = the per-project values from JSON.
  // Launch/Scale = pay-as-you-go (no hard cap). We only show Free limits for
  // free orgs; paid orgs see consumption without a limit bar.
  const isFree = plan === "free";

  // Never a green 0 % on a size nobody read: no project's size could be read, or every project
  // weighs 0 while some of them compute or send data (an empty project still weighs a few
  // megabytes). The storage is then "unavailable", with its reason.
  const storageBlind =
    projectsView.length > 0 &&
    (sizeUnread.length === projectsView.length ||
      (projectsView.every((p) => p.storageGB === 0) && projectsView.some((p) => p.computeH > 0 || p.egressGB > 0)));
  const storageBlindReason = !storageBlind
    ? null
    : sizeUnread.length === projectsView.length
      ? "Neon n'a donné la taille d'aucun projet (ni par ses branches, ni par le projet lui-même)."
      : "Neon donne 0 octet pour chaque projet alors que du calcul ou du trafic sortant est compté : la taille n'est pas lisible ici.";
  const totalStorageGB = projectsView.reduce((n, p) => n + p.storageGB, 0);

  const metrics = [
    storageBlind
      ? {
          name: "Storage projet le + gros",
          used: null,
          limit: isFree ? L.storageGBPerProject : null,
          unit: "GB",
          pctUsed: null,
          scope: "per-project-month",
          unavailable: `${storageBlindReason} À vérifier dans la console Neon (onglet Storage de chaque projet).`,
        }
      : asMetric(
          `Storage projet le + gros (${heaviestStorage.name})`,
          heaviestStorage.storageGB,
          isFree ? L.storageGBPerProject : null,
          "GB",
          "per-project-month",
        ),
    // The free plan caps the total too, independently of the per-project cap (Neon's plans page,
    // read on 23/10/2026: 1 GB per project, 20 GB across all projects).
    ...(isFree && L.storageGBTotal && !storageBlind
      ? [asMetric(`Storage total (${projectsView.length} projets)`, totalStorageGB, L.storageGBTotal, "GB", "account")]
      : []),
    asMetric(
      `Compute projet le + actif (${heaviestCompute.name})`,
      heaviestCompute.computeH,
      isFree ? L.computeHoursPerProject : null,
      "h",
      "per-project-month",
    ),
    asMetric(
      `Egress projet le + gourmand (${heaviestEgress.name})`,
      heaviestEgress.egressGB,
      isFree ? L.egressGBPerProjectPerMonth : null,
      "GB",
      "per-project-month",
    ),
    asMetric("Projets actifs", projects.length, isFree ? L.projectsMax : null, "projets", "account"),
  ];

  const overParts = [];
  if (overStorageLimit.length) overParts.push(`storage > ${L.storageGBPerProject} GB sur ${overStorageLimit.length} projet(s) : ${overStorageLimit.map(p => p.name).join(", ")}`);
  if (overComputeLimit.length) overParts.push(`compute > ${L.computeHoursPerProject} h sur ${overComputeLimit.length} projet(s) : ${overComputeLimit.map(p => p.name).join(", ")}`);
  if (overEgressLimit.length) overParts.push(`egress > ${L.egressGBPerProjectPerMonth} GB sur ${overEgressLimit.length} projet(s) : ${overEgressLimit.map(p => p.name).join(", ")}`);

  const sizeNote = storageBlind
    ? ` ⚠️ Stockage indisponible : ${storageBlindReason}`
    : (sizeFromProject.length ? ` Taille de ${sizeFromProject.length} projet(s) (${sizeFromProject.join(", ")}) lue sur le chiffre du projet : ses branches n'ont pas répondu.` : "") +
      (sizeUnread.length ? ` ⚠️ Taille illisible pour ${sizeUnread.length} projet(s) (${sizeUnread.join(", ")}) : comptée 0, à vérifier dans la console Neon.` : "");
  const note = (isFree
    ? `Plan Free détecté. Limites par projet : ${L.storageGBPerProject} GB storage${L.storageGBTotal ? ` (${L.storageGBTotal} GB au total sur tous les projets)` : ""} · ${L.computeHoursPerProject} h compute · ${L.egressGBPerProjectPerMonth} GB egress par mois. Account : ${L.projectsMax} projets max. Vérifié le ${LIMITS.neon.lastChecked}.${overParts.length ? ` ⚠️ ${overParts.join(" · ")}` : ""}`
    : `Plan ${plan} détecté. Pas de plafond dur (facturation à l'usage). Les chiffres ci-dessus reflètent ta consommation ce mois.`) + sizeNote;

  const breakdown = projects.length > 1 ? projectsByStorage.map((p) => ({
    label: p.name,
    storageGB: Math.round(p.storageGB * 1000) / 1000,
    ...(p.sizeFrom === "unread" || storageBlind ? { storageUnread: true } : {}),
    computeH: Math.round(p.computeH * 100) / 100,
    egressGB: Math.round(p.egressGB * 1000) / 1000,
    overStorage: p.storageGB > L.storageGBPerProject,
    overCompute: p.computeH > L.computeHoursPerProject,
    overEgress: p.egressGB > L.egressGBPerProjectPerMonth,
  })) : null;

  const cost = isFree
    ? { service: "neon", label: "Neon", status: "free", currency: "USD", monthToDate: 0, projected: 0, note: "Plan gratuit : 0 $." }
    : { service: "neon", label: "Neon", status: "not-estimated", note: `Plan ${plan} : facturé à l'usage, la facture se lit dans la console Neon (Billing) ; elle n'est pas estimée ici.` };

  return svc("neon", "Neon (Postgres)", true, metrics, note, breakdown, { cost });
}

// ─── Service: Cloudflare (R2 + Workers) ──────────────────────────────
async function fetchCloudflare() {
  const token = readUserEnv("CLOUDFLARE_API_TOKEN");
  if (!token) return [
    svc("cloudflareR2", "Cloudflare R2 (stockage)", false, [], "CLOUDFLARE_API_TOKEN non configuré. `/start` le met en place."),
    svc("cloudflareWorkers", "Cloudflare Workers", false, [], "CLOUDFLARE_API_TOKEN non configuré."),
  ];

  // Resolve account ID
  let accountId = cfAccountOverride;
  if (!accountId) {
    const acc = await fetchJson("https://api.cloudflare.com/client/v4/accounts", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!acc.ok || !acc.json.success) {
      return [
        svc("cloudflareR2", "Cloudflare R2 (stockage)", false, [], "Échec récupération compte CF"),
        svc("cloudflareWorkers", "Cloudflare Workers", false, [], "Échec récupération compte CF"),
      ];
    }
    accountId = acc.json.result?.[0]?.id;
    if (!accountId) {
      return [
        svc("cloudflareR2", "Cloudflare R2 (stockage)", false, [], "Aucun compte CF accessible"),
        svc("cloudflareWorkers", "Cloudflare Workers", false, [], "Aucun compte CF accessible"),
      ];
    }
  }

  const r2 = await fetchR2(token, accountId);
  const workers = await fetchWorkers(token, accountId);
  return [r2, workers];
}

async function fetchR2(token, accountId) {
  // Bucket list across BOTH jurisdictions (default + EU). R2 EU-jurisdiction
  // buckets are invisible to the default endpoint and require the
  // `cf-r2-jurisdiction: eu` header. We fetch both and merge, tagging each
  // bucket with its jurisdiction so the breakdown shows it.
  const bucketsDefault = await fetchJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!bucketsDefault.ok || !bucketsDefault.json.success) {
    const msg = bucketsDefault.json?.errors?.[0]?.message || `HTTP ${bucketsDefault.status}`;
    if (/not enabled|subscription|10000/i.test(msg)) {
      return svc("cloudflareR2", "Cloudflare R2 (stockage)", false, [], "R2 non activé sur le compte (lance `/add-storage` pour l'activer)");
    }
    return svc("cloudflareR2", "Cloudflare R2 (stockage)", false, [], `API R2: ${msg}`);
  }
  const bucketsEu = await fetchJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "cf-r2-jurisdiction": "eu" },
  });
  // EU jurisdiction list failure is non-fatal - fall back to default-only list.
  const bucketListDefault = (bucketsDefault.json.result?.buckets || []).map((b) => ({ ...b, jurisdiction: "default" }));
  const bucketListEu = (bucketsEu.ok && bucketsEu.json?.success ? bucketsEu.json.result?.buckets || [] : []).map((b) => ({ ...b, jurisdiction: "eu" }));
  const bucketList = [...bucketListDefault, ...bucketListEu];

  // Storage: the latest sample of every bucket over the last 6 hours, summed by
  // sumLatestBucketStorage (below). Operations: summed over the current month.
  const gqlBody = {
    query: `query R2Usage($accountTag: String!, $storageStart: String!, $start: String!, $end: String!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $storageStart, datetime_leq: $end }
            orderBy: [datetime_DESC]
          ) {
            max { payloadSize metadataSize objectCount }
            dimensions { bucketName datetime }
          }
          r2OperationsAdaptiveGroups(
            limit: 100
            filter: { datetime_geq: $start, datetime_leq: $end }
          ) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }`,
    variables: {
      accountTag: accountId,
      storageStart: new Date(NOW.getTime() - 6 * 3600 * 1000).toISOString(),
      start: MONTH_START.toISOString(),
      end: NOW.toISOString(),
    },
  };
  const gql = await fetchJson("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(gqlBody),
  });

  let storageBytes = null;
  let perBucket = [];
  let classAOps = null;
  let classBOps = null;
  if (gql.ok && gql.json?.data?.viewer?.accounts?.[0]) {
    const acc = gql.json.data.viewer.accounts[0];
    const storageRows = acc.r2StorageAdaptiveGroups || [];
    if (storageRows.length > 0) {
      const latest = sumLatestBucketStorage(storageRows);
      storageBytes = latest.bytes;
      perBucket = latest.perBucket;
    }
    const opsBuckets = acc.r2OperationsAdaptiveGroups || [];
    classAOps = 0;
    classBOps = 0;
    // Official R2 pricing (developers.cloudflare.com/r2/pricing). Anything that is
    // neither class A nor free counts as class B (e.g. "ReportUsageSummary").
    const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"]);
    const FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);
    for (const b of opsBuckets) {
      const action = b.dimensions?.actionType;
      const reqs = b.sum?.requests || 0;
      if (CLASS_A.has(action)) classAOps += reqs;
      else if (!FREE.has(action)) classBOps += reqs;
    }
  }

  // Free tier limits from quotas-limits.json
  const R2 = LIMITS.cloudflareR2.free;
  const metrics = [];
  if (storageBytes !== null) metrics.push(asMetric("Storage", storageBytes / 1073741824, R2.storageGBPerMonth, "GB", "account-month"));
  if (classAOps !== null) metrics.push(asMetric("Opérations classe A (writes)", classAOps, R2.classAOpsPerMonth, "ops", "account-month"));
  if (classBOps !== null) metrics.push(asMetric("Opérations classe B (reads)", classBOps, R2.classBOpsPerMonth, "ops", "account-month"));
  metrics.push(asMetric("Buckets", bucketList.length, null, "buckets", "account"));

  // Each bucket with its size and its number of objects, the largest first, like Neon's projects
  // (3.4.16): the account's sum said that storage was filling up, never which bucket. The size
  // comes from the analytics, which name a bucket without its jurisdiction: a name that exists
  // in both jurisdictions gets the size the analytics give that name. A bucket the analytics do
  // not measure yet (created in the last hours) has no size, rather than 0. Read only: nothing
  // here deletes anything.
  const sizeOf = new Map(perBucket.map((b) => [b.name, b]));
  const listed = new Set(bucketList.map((b) => b.name));
  const rows = [
    ...bucketList.map((b) => ({ name: b.name, jurisdiction: b.jurisdiction, creationDate: b.creation_date ?? null, measured: sizeOf.get(b.name) ?? null })),
    // Measured but not listed: the EU list failed, or the bucket went in the last three hours.
    ...perBucket.filter((b) => !listed.has(b.name)).map((b) => ({ name: b.name, jurisdiction: null, creationDate: null, measured: b })),
  ];
  const breakdown = rows.length > 0
    ? rows
        .map((b) => ({
          label: `${b.name}${b.jurisdiction === "eu" ? " (EU)" : ""}`,
          bucket: b.name,
          jurisdiction: b.jurisdiction,
          storageGB: b.measured ? Math.round((b.measured.bytes / 1073741824) * 1000) / 1000 : null,
          objects: b.measured ? b.measured.objects : null,
          creationDate: b.creationDate,
        }))
        .sort((a, b) => (b.storageGB ?? -1) - (a.storageGB ?? -1))
    : null;

  // The storage beyond the free 10 GB, at Standard storage's published price, if the size stays
  // the same all month (R2 bills GB-months). Operations are not counted here.
  const overGB = storageBytes === null ? null : Math.max(0, storageBytes / 1073741824 - R2.storageGBPerMonth);
  const cost = overGB === null
    ? { service: "cloudflareR2", label: "Cloudflare R2", status: "unavailable", note: "Taille R2 non mesurée : pas d'estimation." }
    : {
        service: "cloudflareR2",
        label: "Cloudflare R2",
        status: "estimated",
        currency: "USD",
        projected: Math.round(overGB * R2_STANDARD_USD_PER_GB_MONTH * 100) / 100,
        note: overGB > 0
          ? `${(Math.round(overGB * 100) / 100).toLocaleString("fr-FR")} GB au-delà des ${R2.storageGBPerMonth} GB gratuits, à ${R2_STANDARD_USD_PER_GB_MONTH} $ le GB-mois, si la taille reste la même tout le mois (opérations non comptées).`
          : `Sous les ${R2.storageGBPerMonth} GB gratuits : 0 $ pour le stockage (opérations non comptées).`,
      };

  return svc(
    "cloudflareR2",
    "Cloudflare R2 (stockage)",
    metrics.length > 1 || storageBytes !== null,
    metrics,
    storageBytes === null ? "Analytics R2 non disponibles (compte trop récent ou trop peu d'usage)" : null,
    breakdown,
    { cost },
  );
}

// R2 storage for the whole account = the LATEST sample of each bucket, summed.
// Cloudflare samples every bucket roughly every 30 minutes. Without grouping by
// bucket, `max` returned the size of the single largest bucket, not the account:
// 8.5 GB reported for 10.2 GB actually stored (2026-09-13). A bucket whose latest
// sample lags the account's newest sample by more than 3 hours has been deleted:
// it no longer counts.
// perBucket: each bucket counted, {name, bytes, objects}, the largest first (3.4.16).
function sumLatestBucketStorage(rows) {
  const latest = new Map();
  for (const r of rows || []) {
    const bucket = r?.dimensions?.bucketName;
    const at = Date.parse(r?.dimensions?.datetime ?? "");
    if (!bucket || Number.isNaN(at)) continue;
    const prev = latest.get(bucket);
    if (!prev || at > prev.at) {
      latest.set(bucket, {
        at,
        bytes: (r.max?.payloadSize || 0) + (r.max?.metadataSize || 0),
        objects: r.max?.objectCount || 0,
      });
    }
  }
  const newest = Math.max(0, ...[...latest.values()].map((v) => v.at));
  let bytes = 0;
  let objects = 0;
  let buckets = 0;
  const perBucket = [];
  for (const [name, v] of latest) {
    if (newest - v.at > 3 * 3600 * 1000) continue;
    bytes += v.bytes;
    objects += v.objects;
    buckets++;
    perBucket.push({ name, bytes: v.bytes, objects: v.objects });
  }
  perBucket.sort((a, b) => b.bytes - a.bytes);
  return { bytes, objects, buckets, perBucket };
}

async function fetchWorkers(token, accountId) {
  // Workers requests per day (free tier: 100k/day)
  const gqlBody = {
    query: `query WorkersUsage($accountTag: String!, $start: String!, $end: String!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 1
            filter: { datetime_geq: $start, datetime_leq: $end }
          ) {
            sum { requests errors }
          }
        }
      }
    }`,
    variables: {
      accountTag: accountId,
      start: DAY_START.toISOString(),
      end: NOW.toISOString(),
    },
  };
  const gql = await fetchJson("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(gqlBody),
  });

  if (!gql.ok || !gql.json?.data?.viewer?.accounts?.[0]) {
    return svc("cloudflareWorkers", "Cloudflare Workers", false, [], "Analytics Workers non disponibles (probablement aucun Worker déployé)");
  }
  const data = gql.json.data.viewer.accounts[0].workersInvocationsAdaptive?.[0]?.sum;
  const W = LIMITS.cloudflareWorkers.free;
  if (!data) {
    return svc(
      "cloudflareWorkers",
      "Cloudflare Workers",
      true,
      [asMetric("Requêtes aujourd'hui", 0, W.requestsPerDay, "requêtes", "account-day")],
      "Aucune requête Worker aujourd'hui",
    );
  }

  return svc(
    "cloudflareWorkers",
    "Cloudflare Workers",
    true,
    [
      asMetric("Requêtes aujourd'hui", data.requests || 0, W.requestsPerDay, "requêtes", "account-day"),
      asMetric("Erreurs aujourd'hui", data.errors || 0, null, "erreurs", "account-day"),
    ],
  );
}

// ─── Service: Brevo ──────────────────────────────────────────────────
async function fetchBrevo() {
  const apiKey = readUserEnv("BREVO_API_KEY");
  if (!apiKey) return svc("brevo", "Brevo (email)", false, [], "BREVO_API_KEY non configurée");

  const r = await fetchJson("https://api.brevo.com/v3/account", {
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  if (!r.ok) return svc("brevo", "Brevo (email)", false, [], `API Brevo: HTTP ${r.status}`);

  // plan[] contains entries like:
  //   { type: "free", creditsType: "sendLimit", credits: 300 }      → daily send limit
  //   { type: "subscription", creditsType: "userLimit", credits: 1 }
  // For free tier: "sendLimit" = daily quota of 300/day.
  // We prefer the API-supplied limit (handles paid plans correctly), and fall
  // back to LIMITS.brevo.free.emailsPerDay only if the API doesn't expose one.
  const plans = r.json.plan || [];
  const sendLimitEntry = plans.find((p) => p.creditsType === "sendLimit");
  const dailyLimit = sendLimitEntry?.credits || LIMITS.brevo.free.emailsPerDay;
  const planType = plans.map((p) => p.type).join("/") || "free";

  // Brevo's /account doesn't expose "emails sent today". Best-effort: count
  // recent transactional emails via /smtp/statistics/aggregatedReport for today.
  const today = NOW.toISOString().slice(0, 10);
  const stats = await fetchJson(`https://api.brevo.com/v3/smtp/statistics/aggregatedReport?startDate=${today}&endDate=${today}`, {
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  let sentToday = null;
  if (stats.ok) sentToday = stats.json.requests || 0;

  const metrics = [];
  if (sentToday !== null) {
    metrics.push(asMetric("Emails envoyés aujourd'hui", sentToday, dailyLimit, "emails", "account-day"));
  } else {
    metrics.push(asMetric("Limite journalière du plan", dailyLimit, null, "emails/jour", "account"));
  }

  const planNote = `Plan détecté : ${planType}${sendLimitEntry ? ` (${dailyLimit} emails/jour)` : ""}`;
  return svc(
    "brevo",
    "Brevo (email)",
    true,
    metrics,
    sentToday === null ? `${planNote}. Statistiques d'envoi du jour non disponibles.` : planNote,
  );
}

// ─── Service: Resend (with self-heal) ────────────────────────────────
async function fetchResend() {
  const heal = ensureResendFullAccessKey();
  if (!heal.key) return svc("resend", "Resend (email)", false, [], heal.reason || "Pas de clé Resend full-access");

  const justCreated = heal.justCreated;

  // Paginate /emails until we exit the current month
  // Free tier: 100/day, 3000/month (as of 2026)
  let sentToday = 0;
  let sentThisMonth = 0;
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 50; // safety cap

  while (pages < MAX_PAGES) {
    const url = new URL("https://api.resend.com/emails");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("after", cursor);

    const r = await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${heal.key}`, Accept: "application/json" },
    });
    if (!r.ok) {
      return svc(
        "resend",
        "Resend (email)",
        false,
        [],
        `API Resend: HTTP ${r.status} - ${r.json?.message || ""}`,
        null,
        { resendKeyJustCreated: justCreated },
      );
    }

    const emails = r.json.data || [];
    if (emails.length === 0) break;

    let exitedMonth = false;
    for (const e of emails) {
      // Resend's created_at is "YYYY-MM-DD HH:MM:SS.uuuuuu+00" (Postgres-ish);
      // normalize to ISO.
      const ts = new Date((e.created_at || "").replace(" ", "T").replace(/\.\d+\+00$/, ".000Z").replace("+00", "Z"));
      if (Number.isNaN(ts.getTime())) continue;
      if (ts < MONTH_START) {
        exitedMonth = true;
        break;
      }
      sentThisMonth++;
      if (ts >= DAY_START) sentToday++;
    }

    if (exitedMonth || !r.json.has_more) break;
    cursor = emails[emails.length - 1]?.id;
    if (!cursor) break;
    pages++;
  }

  const RS = LIMITS.resend.free;
  return svc(
    "resend",
    "Resend (email)",
    true,
    [
      asMetric("Emails aujourd'hui", sentToday, RS.emailsPerDay, "emails", "account-day"),
      asMetric("Emails ce mois", sentThisMonth, RS.emailsPerMonth, "emails", "account-month"),
    ],
    pages >= MAX_PAGES ? "Pagination atteinte (résultats peut-être incomplets - usage très élevé ?)" : null,
    null,
    { resendKeyJustCreated: justCreated },
  );
}

// ─── Service: Vercel (plan-aware - partial) ──────────────────────────
//
// Plan detection: `/v2/user` returns `user.billing.plan` for the personal
// account, but most projects live on a Vercel team. We resolve the user's default
// Vercel team and read its `billing.plan` - that's the plan that actually applies
// to deployments. Falls back to user plan if no default Vercel team.
//
// What we surface: plan label, deployment count this month, project count.
// Bandwidth / function-time aren't exposed via API on any plan (the
// `/v1/usage` endpoint rejects every reasonable date range with
// `invalid_time_range`), so we always link to the dashboard for those.
async function fetchVercel() {
  // The CLI login, read like every other script (_vercel-auth.mjs: the freshest
  // auth file, xdg.data of CLI v59 included). A private reader here took the
  // first file found, the pre-v59 one frozen with a dead token, and reported the
  // login as expired (seen on 2026-09-17). VERCEL_TOKEN stays an override
  // (a Personal Access Token, useful without the CLI).
  const token = readUserEnv("VERCEL_TOKEN") || loadAuthToken();
  if (!token) return svc("vercel", "Vercel (hébergement)", false, [], "Vercel CLI non connectée (lance `vercel login` ou définis VERCEL_TOKEN)");

  // Resolve user + default Vercel team + plan in one shot
  const userRes = await fetchJson("https://api.vercel.com/v2/user", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) {
    return svc("vercel", "Vercel (hébergement)", false, [], `API Vercel: HTTP ${userRes.status} - token Vercel invalide ou expiré (lance \`vercel login\`)`);
  }
  const user = userRes.json.user || {};
  const teamId = user.defaultTeamId || null;
  let plan = user.billing?.plan || null;
  let teamSlug = null;
  if (teamId) {
    const teamRes = await fetchJson(`https://api.vercel.com/v2/teams/${teamId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (teamRes.ok) {
      plan = teamRes.json.billing?.plan || plan;
      teamSlug = teamRes.json.slug || null;
    }
  }
  plan = plan || "hobby";

  const teamSuffix = teamId ? `&teamId=${teamId}` : "";

  // Count deployments this month
  const since = MONTH_START.getTime();
  let depCount = 0;
  let depCursor = null;
  let pages = 0;
  while (pages < 50) {
    const url = `https://api.vercel.com/v6/deployments?since=${since}&limit=100${teamSuffix}${depCursor ? `&until=${depCursor}` : ""}`;
    const r = await fetchJson(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!r.ok) break;
    const deps = r.json.deployments || [];
    depCount += deps.length;
    if (!r.json.pagination?.next || deps.length < 100) break;
    depCursor = r.json.pagination.next;
    pages++;
  }

  // Count projects, every page (the first one stops at 100)
  let projectCount = 0;
  let projCursor = null;
  for (let page = 0; page < 30; page++) {
    const r = await fetchJson(`https://api.vercel.com/v9/projects?limit=100${teamSuffix}${projCursor ? `&until=${projCursor}` : ""}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!r.ok) {
      if (page === 0) projectCount = null;
      break;
    }
    projectCount += (r.json.projects || []).length;
    const next = r.json.pagination?.next;
    if (!next || next === projCursor) break;
    projCursor = next;
  }

  const dashboardUrl = teamSlug
    ? `https://vercel.com/${teamSlug}/~/usage`
    : "https://vercel.com/dashboard/usage";

  // Plan-aware French label
  const planFr = plan === "hobby" ? "Hobby (gratuit)"
    : plan === "pro" ? "Pro"
    : plan === "enterprise" ? "Enterprise"
    : plan;

  const planNote = plan === "hobby"
    ? `Plan ${planFr} détecté. Limites : 100 GB bandwidth / 100 h function-time / 6000 min build par mois. Ces métriques ne sont pas exposées en API - voir ${dashboardUrl}.`
    : plan === "pro"
      ? `Plan ${planFr} détecté. Inclus : 1 TB bandwidth + 1000 GB-h function-time + 24k min build par mois (dépassement facturé à l'usage). Les chiffres détaillés ne sont pas exposés en API - voir ${dashboardUrl}.`
      : `Plan ${planFr} détecté. Quotas définis par contrat. Voir ${dashboardUrl}.`;

  // The month's cost, from Vercel's own billing on a paid plan (3.4.16).
  const cost = plan === "hobby"
    ? { service: "vercel", label: "Vercel", status: "free", currency: "USD", monthToDate: 0, projected: 0, note: "Plan Hobby : gratuit." }
    : await vercelMonthCost(token, teamId);

  return svc(
    "vercel",
    "Vercel (hébergement)",
    "partial",
    [
      asMetric("Déploiements ce mois", depCount, null, "deploys", "account-month"),
      ...(projectCount !== null ? [asMetric("Projets", projectCount, null, "projets", "account")] : []),
    ],
    planNote,
    null,
    { cost },
  );
}

// ─── Service struct helper ───────────────────────────────────────────
function svc(service, label, available, metrics, note = null, breakdown = null, extras = null) {
  return { service, label, available, metrics, note, breakdown, ...(extras || {}) };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  // Run all fetchers in parallel, isolate errors
  const fetcherPromises = [
    safeRun("neon", fetchNeon),
    safeRun("cloudflare", fetchCloudflare), // returns array of 2
    safeRun("brevo", fetchBrevo),
    safeRun("resend", fetchResend),
    safeRun("vercel", fetchVercel),
  ];

  const settled = await Promise.allSettled(fetcherPromises);

  const services = [];
  let resendKeyJustCreated = false;
  for (const res of settled) {
    if (res.status !== "fulfilled") continue;
    const v = res.value;
    if (Array.isArray(v)) {
      for (const s of v) {
        if (s.resendKeyJustCreated) resendKeyJustCreated = true;
        services.push(s);
      }
    } else {
      if (v.resendKeyJustCreated) resendKeyJustCreated = true;
      services.push(v);
    }
  }

  // The month's cost, gathered from the services that could say it (they carry it as `cost`).
  const items = [];
  for (const s of services) {
    if (s.cost) items.push(s.cost);
    delete s.cost;
  }
  const counted = items.filter((c) => typeof c.projected === "number" && c.currency === "USD");
  const cost = {
    currency: "USD",
    items,
    projectedTotal: Math.round(counted.reduce((n, c) => n + c.projected, 0) * 100) / 100,
    complete: items.length > 0 && items.every((c) => counted.includes(c)),
    notCounted: [
      "Cloudflare : l'abonnement (Workers payant, autres produits) n'est pas lu, la clé Cloudflare du harnais n'a pas le droit de lire la facturation.",
      "Brevo, Resend : leur forfait n'est pas compté ici.",
    ],
  };

  const out = {
    fetchedAt: NOW.toISOString(),
    billingCycle,
    services,
    cost,
    selfHealing: { resendKeyJustCreated },
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

async function safeRun(name, fn) {
  try {
    return await fn();
  } catch (e) {
    // An aborted fetch is a timeout, not an outage. The raw message ("This
    // operation was aborted") reads like the service is down and sends the
    // reader chasing a non-existent API problem, so name the real cause.
    const aborted = e?.name === "AbortError" || /aborted/i.test(e?.message || "");
    if (process.env.QUOTAS_DEBUG) console.error("[debug " + name + "]", e?.name, e?.message, e?.stack?.slice(0, 900));
    const note = aborted
      ? "Service trop lent a repondre (delai depasse). Le compte et la cle sont probablement bons : relance /quotas, et si ca persiste c'est que le service met trop longtemps a lister tes ressources."
      : `Erreur: ${e.message?.slice(0, 200)}`;
    return svc(name, name, false, [], note);
  }
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ _error: e.message }) + "\n");
  process.exit(1);
});
