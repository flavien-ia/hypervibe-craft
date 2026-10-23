#!/usr/bin/env node
// test-quotas-buckets-cost.mjs - /quotas gives each R2 bucket's size, and the month's cost it can
// say for sure (3.4.16 / 2.4.15, passe hypervibe-learn du 23/10/2026).
//
// What must hold:
//   1. R2: the detail lists every bucket with its jurisdiction, its size and its number of objects,
//      the largest first; a bucket the analytics do not measure yet has no size (null, never 0); a
//      bucket gone more than three hours ago is not counted; the account's sum is unchanged;
//   2. the month's cost: Vercel's own billing on a paid plan (usage projected over the month, the
//      plan's seats counted once), R2's storage beyond its free 10 GB at 0.015 $ the GB-month, Neon's
//      free plan at 0 $; what cannot be read is "unavailable", never a 0, and what is never counted
//      (Cloudflare's subscription, the email providers' plans) is said;
//   3. nothing here calls Cloudflare's billing.
// quotas-fetch.mjs runs for real, in a home folder of its own (the vault reads as locked there, no
// `bw` ever runs), with recette keys in its environment and _fake-net.mjs, which answers from a
// scenario and refuses every other address: nothing leaves the machine.
//
//   node scripts/tests/test-quotas-buckets-cost.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const QUOTAS = join(ROOT, "scripts", "quotas-fetch.mjs");
const FAKE_NET = pathToFileURL(join(ROOT, "scripts", "tests", "_fake-net.mjs")).href;
const NEON = "https://console.neon.tech/api/v2";
const CF = "https://api.cloudflare.com/client/v4";
const V = "https://api.vercel.com";
const GB = 1024 ** 3;

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 500)})` : ""}`);
}

const temps = [];
/** quotas-fetch.mjs against a scenario: its whole answer, and the addresses it asked for. */
function run(scenario) {
  const home = mkdtempSync(join(tmpdir(), "hv-quotas-cout-"));
  temps.push(home);
  const log = join(home, "net.log");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    NEON_API_KEY: "cle-neon-de-recette",
    CLOUDFLARE_API_TOKEN: "cle-cloudflare-de-recette",
    VERCEL_TOKEN: "cle-vercel-de-recette",
    HV_RECETTE_NET: JSON.stringify(scenario),
    HV_RECETTE_NET_LOG: log,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${FAKE_NET}`].filter(Boolean).join(" "),
  };
  for (const k of ["CF_API_TOKEN", "BREVO_API_KEY", "RESEND_API_KEY", "RESEND_FULL_ACCESS_KEY"]) delete env[k];
  const r = spawnSync(process.execPath, [QUOTAS, "--cf-account", "acc-recette"], { env, encoding: "utf8", cwd: home, timeout: 120000 });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = null;
  }
  const asked = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, out, asked };
}
const service = (out, id) => out?.services?.find((s) => s.service === id) ?? null;
const costOf = (out, id) => out?.cost?.items?.find((c) => c.service === id) ?? null;

// The month's position, as quotas-fetch.mjs computes it (to the second).
const now = new Date();
const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
const fraction = (now - monthStart) / (monthEnd - monthStart);

/** A sample of R2's storage analytics for one bucket. */
const sample = (bucket, bytes, objects, hoursAgo) => ({ max: { payloadSize: bytes, metadataSize: 0, objectCount: objects }, dimensions: { bucketName: bucket, datetime: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString() } });

/** A scenario: Neon free with one project, R2 with three listed buckets, Vercel on `vercelPlan`. */
function scenario({ vercelPlan = "pro", charges = null, chargesStatus = 200, storage = null } = {}) {
  const storageRows = storage ?? [
    sample("site-assets", 7 * GB, 30000, 2),
    sample("site-assets", 8 * GB, 41203, 0.5),
    sample("photos-eu", 5 * GB, 3980, 0.5),
    sample("non-liste", 0.25 * GB, 12, 1),
    sample("parti", 9 * GB, 999, 6),
  ];
  return [
    [`${NEON}/users/me/organizations`, { body: { organizations: [{ id: "org-libre", name: "Recette", plan: "free" }] } }],
    [`${NEON}/projects?`, { body: { projects: [{ id: "p-un", name: "un", org_id: "org-libre", synthetic_storage_size: 0 }] } }],
    [`${NEON}/projects/p-un/branches`, { body: { branches: [{ id: "br-main", logical_size: 64 * 1024 * 1024 }] } }],
    [`${NEON}/projects/p-un`, { body: { project: { id: "p-un", name: "un", org_id: "org-libre", compute_time_seconds: 3600, data_transfer_bytes: 0 } } }],
    // The EU list: the same address, with the jurisdiction header. Listed first: the first match wins.
    [`${CF}/accounts/acc-recette/r2/buckets`, { body: { success: true, result: { buckets: [{ name: "photos-eu", creation_date: "2026-02-01T00:00:00Z" }] } } }, { header: "cf-r2-jurisdiction", value: "eu" }],
    [`${CF}/accounts/acc-recette/r2/buckets`, { body: { success: true, result: { buckets: [{ name: "site-assets", creation_date: "2026-01-01T00:00:00Z" }, { name: "tout-neuf", creation_date: "2026-10-23T08:00:00Z" }] } } }],
    [`${CF}/graphql`, { body: { data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: storageRows, r2OperationsAdaptiveGroups: [{ sum: { requests: 1200 }, dimensions: { actionType: "PutObject" } }] }] } } } }],
    [`${V}/v2/user`, { body: { user: { id: "u-recette", defaultTeamId: "team_recette", billing: { plan: "hobby" } } } }],
    [`${V}/v2/teams/team_recette`, { body: { id: "team_recette", slug: "recette", billing: { plan: vercelPlan } } }],
    [`${V}/v2/teams`, { body: { teams: [{ id: "team_recette", slug: "recette", name: "Recette" }], pagination: { next: null } } }],
    [`${V}/v6/deployments`, { body: { deployments: [], pagination: {} } }],
    [`${V}/v9/projects`, { body: { projects: [{ id: "prj-1", name: "site" }], pagination: { next: null } } }],
    [`${V}/v10/projects`, { body: { projects: [{ id: "prj-1", name: "site" }], pagination: { next: null } } }],
    [`${V}/v1/billing/charges`, chargesStatus === 200
      ? { text: (charges ?? [
          { BilledCost: "20", BillingCurrency: "USD", ChargeCategory: "Purchase", ServiceName: "Pro seat" },
          { BilledCost: "3.10", BillingCurrency: "USD", ChargeCategory: "Usage", ServiceName: "Fast Data Transfer" },
        ]).map((c) => JSON.stringify(c)).join("\n") }
      : { status: chargesStatus, body: { error: { code: "forbidden", message: "Not authorized" } } }],
  ];
}

try {
  console.log("── R2 : la taille de chaque bucket, le plus gros d'abord ──");
  const a = run(scenario());
  {
    const r2 = service(a.out, "cloudflareR2");
    check("le bloc R2 est lu", a.r.status === 0 && r2?.available === true, `${a.r.status} ${a.r.stderr.slice(0, 300)} ${JSON.stringify(r2)}`);
    const storage = r2?.metrics?.find((m) => m.name === "Storage");
    check("la somme du compte ne compte que les derniers relevés de moins de 3 h (8 + 5 + 0,25 Go)", Math.abs((storage?.used ?? -1) - 13.25) < 0.0011, JSON.stringify(storage));
    const rows = r2?.breakdown ?? [];
    check("le détail suit la taille, le plus gros d'abord", rows.map((b) => b.bucket).join(",") === "site-assets,photos-eu,non-liste,tout-neuf", JSON.stringify(rows.map((b) => b.bucket)));
    const site = rows.find((b) => b.bucket === "site-assets");
    check("... chaque bucket avec sa juridiction, sa taille (son dernier relevé) et ses objets", site?.jurisdiction === "default" && site?.storageGB === 8 && site?.objects === 41203 && rows.find((b) => b.bucket === "photos-eu")?.jurisdiction === "eu" && /\(EU\)/.test(rows.find((b) => b.bucket === "photos-eu")?.label ?? ""), JSON.stringify(rows));
    const neuf = rows.find((b) => b.bucket === "tout-neuf");
    check("un bucket pas encore mesuré n'a pas de taille (null), jamais 0", neuf && neuf.storageGB === null && neuf.objects === null, JSON.stringify(neuf));
    check("un bucket mesuré mais pas listé apparaît, sans juridiction connue", rows.find((b) => b.bucket === "non-liste")?.jurisdiction === null, JSON.stringify(rows));
    check("un bucket parti depuis plus de 3 h n'apparaît pas", !rows.some((b) => b.bucket === "parti"), JSON.stringify(rows));
    check("rien n'est supprimé : aucune requête autre qu'une lecture vers Cloudflare", a.asked.filter((q) => q.url.startsWith(CF)).every((q) => q.method === "GET" || (q.method === "POST" && q.url === `${CF}/graphql`)), JSON.stringify(a.asked.filter((q) => q.url.startsWith(CF))));
  }

  console.log("\n── Le coût du mois : ce qui se lit ou se calcule, rien de deviné ──");
  {
    const vercel = costOf(a.out, "vercel");
    check("Vercel payant : la facturation de Vercel est lue pour le mois en cours", a.asked.some((q) => q.url.startsWith(`${V}/v1/billing/charges?from=`) && q.url.includes("teamId=team_recette")), JSON.stringify(a.asked.filter((q) => q.url.startsWith(V)).map((q) => q.url)));
    check("... le facturé depuis le 1er (23,10 $)", vercel?.status === "measured" && vercel?.monthToDate === 23.1 && vercel?.currency === "USD", JSON.stringify(vercel));
    const attendu = fraction < 1 / 31 ? null : Math.round((20 + 3.1 / fraction) * 100) / 100;
    check("... l'usage projeté sur le mois, le forfait compté une fois", attendu === null ? vercel?.projected === null : Math.abs((vercel?.projected ?? -1) - attendu) < 0.05, `${JSON.stringify(vercel)} attendu ${attendu}`);
    const r2 = costOf(a.out, "cloudflareR2");
    check("R2 : 3,25 Go au-delà des 10 Go gratuits, à 0,015 $ le Go-mois (0,05 $)", r2?.status === "estimated" && r2?.projected === Math.round(3.25 * 0.015 * 100) / 100 && /au-delà des 10 GB gratuits/.test(r2?.note ?? ""), JSON.stringify(r2));
    const neon = costOf(a.out, "neon");
    check("Neon au plan gratuit : 0 $", neon?.status === "free" && neon?.projected === 0, JSON.stringify(neon));
    const total = Math.round(((vercel?.projected ?? 0) + (r2?.projected ?? 0)) * 100) / 100;
    check("le total additionne ce qui est connu, en dollars", Math.abs((a.out?.cost?.projectedTotal ?? -1) - total) < 0.011 && a.out?.cost?.currency === "USD", JSON.stringify(a.out?.cost));
    check("ce qui n'est jamais compté est dit : l'abonnement Cloudflare (pas de droit de lecture), Brevo et Resend", (a.out?.cost?.notCounted ?? []).some((l) => /Cloudflare/.test(l) && /facturation/.test(l)) && (a.out?.cost?.notCounted ?? []).some((l) => /Brevo, Resend/.test(l)), JSON.stringify(a.out?.cost?.notCounted));
    check("la facturation de Cloudflare n'est jamais appelée", !a.asked.some((q) => /billing|subscriptions/.test(q.url) && q.url.startsWith(CF)), JSON.stringify(a.asked.map((q) => q.url)));
    check("le coût vit à part, pas dans chaque service", !(a.out?.services ?? []).some((s) => "cost" in s), "");
  }

  console.log("\n── Ce qui ne se lit pas reste « indisponible », jamais un 0 ──");
  {
    const b = run(scenario({ chargesStatus: 403 }));
    const vercel = costOf(b.out, "vercel");
    check("une facturation Vercel refusée : indisponible, avec la raison, sans chiffre", vercel?.status === "unavailable" && vercel?.projected === undefined && /rôle/.test(vercel?.note ?? ""), JSON.stringify(vercel));
    check("... le total ne la compte pas, et se dit incomplet", b.out?.cost?.complete === false, JSON.stringify(b.out?.cost));
    const c = run(scenario({ vercelPlan: "hobby", storage: [sample("site-assets", 2 * GB, 10, 0.5)] }));
    check("Vercel Hobby : gratuit, sans appel à la facturation", costOf(c.out, "vercel")?.status === "free" && !c.asked.some((q) => q.url.startsWith(`${V}/v1/billing`)), JSON.stringify(costOf(c.out, "vercel")));
    check("R2 sous les 10 Go : 0 $ pour le stockage", costOf(c.out, "cloudflareR2")?.projected === 0 && /Sous les 10 GB gratuits/.test(costOf(c.out, "cloudflareR2")?.note ?? ""), JSON.stringify(costOf(c.out, "cloudflareR2")));
    check("... et tout étant connu, le total se dit complet (0 $)", c.out?.cost?.complete === true && c.out?.cost?.projectedTotal === 0, JSON.stringify(c.out?.cost));
    const d = run(scenario({ storage: [] }));
    check("R2 sans relevé : l'estimation est indisponible, pas 0 $", costOf(d.out, "cloudflareR2")?.status === "unavailable" && costOf(d.out, "cloudflareR2")?.projected === undefined, JSON.stringify(costOf(d.out, "cloudflareR2")));
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
