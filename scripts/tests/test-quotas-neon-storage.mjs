#!/usr/bin/env node
// test-quotas-neon-storage.mjs - /quotas reads the size of a Neon project on its branches, as Neon
// measures the free plan's cap, and never shows a size it could not read as a green 0 % (3.4.16 /
// 2.4.15).
//
// The project's own size counters (synthetic_storage_size, data_storage_bytes_hour) are legacy
// ones: 0 on a usage-based plan (a Launch account whose largest main branch held 312 MB, shown as
// 0 GB: Bastien Detraz, 22/10/2026), and 0 on the 17 projects of a free account on 16/10/2026,
// full databases included, behind a green 0 % (hypervibe-learn). What must hold:
//   1. every project is measured on its branches: the sum of their logical_size ("The Free plan
//      caps storage per project based on logical_size across branches", Neon, read on 23/10/2026);
//   2. the project's own figure is a fallback, when its branches do not answer, and the note says
//      so; a size read nowhere is said, with the project's name;
//   3. no size read anywhere, or every project at 0 while some compute or send data: the storage
//      is "unavailable", with its reason, never a figure with a verdict;
//   4. the free plan's caps are today's: 1 GB per project, 20 GB in all.
// quotas-fetch.mjs runs for real, in a home folder of its own (the vault reads as locked there, no
// `bw` ever runs), with a recette's Neon key in its environment and _fake-net.mjs, which answers for
// Neon from a scenario and refuses every other address: nothing leaves the machine.
//
//   node scripts/tests/test-quotas-neon-storage.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const QUOTAS = join(ROOT, "scripts", "quotas-fetch.mjs");
const FAKE_NET = pathToFileURL(join(ROOT, "scripts", "tests", "_fake-net.mjs")).href;
const API = "https://console.neon.tech/api/v2";
const MB = 1024 * 1024;

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 500)})` : ""}`);
}

const temps = [];
/** quotas-fetch.mjs against a scenario: its Neon block, and the addresses it asked for. */
function run(scenario) {
  const home = mkdtempSync(join(tmpdir(), "hv-quotas-neon-"));
  temps.push(home);
  const log = join(home, "net.log");
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), NEON_API_KEY: "cle-neon-de-recette", HV_RECETTE_NET: JSON.stringify(scenario), HV_RECETTE_NET_LOG: log, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${FAKE_NET}`].filter(Boolean).join(" ") };
  for (const k of ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "BREVO_API_KEY", "RESEND_API_KEY", "RESEND_FULL_ACCESS_KEY", "VERCEL_TOKEN"]) delete env[k];
  const r = spawnSync(process.execPath, [QUOTAS], { env, encoding: "utf8", cwd: home, timeout: 120000 });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = null;
  }
  const neon = out?.services?.find((s) => s.service === "neon") ?? null;
  const asked = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).url) : [];
  return { r, neon, asked };
}
const metric = (neon, start) => neon?.metrics?.find((m) => m.name.startsWith(start)) ?? null;
const row = (neon, label) => neon?.breakdown?.find((b) => b.label === label) ?? null;
const gb = (mb) => Math.round((mb / 1024) * 1000) / 1000;
/** A project as GET /projects/{id} answers it. */
const project = (id, name, org, extra = {}) => ({ project: { id, name, org_id: org, synthetic_storage_size: 0, data_storage_bytes_hour: 0, compute_time_seconds: 3600, data_transfer_bytes: 0, ...extra } });
const org = (id, plan) => [`${API}/users/me/organizations`, { body: { organizations: [{ id, name: "Recette", plan }] } }];

try {
  console.log("── Un compte au plan Launch : la taille des projets vaut 0, elle se lit sur les branches ──");
  {
    const { r, neon, asked } = run([
      org("org-recette", "launch"),
      [`${API}/projects?`, { body: { projects: [{ id: "p-gros", name: "gros", org_id: "org-recette", synthetic_storage_size: 0 }, { id: "p-petit", name: "petit", org_id: "org-recette", synthetic_storage_size: 0 }, { id: "p-illisible", name: "illisible", org_id: "org-recette", synthetic_storage_size: 0 }] } }],
      // A branch first: its address starts with the project's, and the first prefix wins.
      [`${API}/projects/p-gros/branches`, { body: { branches: [{ id: "br-main", logical_size: 312 * MB }, { id: "br-essai", logical_size: 40 * MB }] } }],
      [`${API}/projects/p-gros`, { body: project("p-gros", "gros", "org-recette") }],
      [`${API}/projects/p-petit/branches`, { body: { branches: [{ id: "br-main", logical_size: 10 * MB }] } }],
      [`${API}/projects/p-petit`, { body: project("p-petit", "petit", "org-recette") }],
      [`${API}/projects/p-illisible/branches`, { status: 500, body: { message: "erreur de recette" } }],
      [`${API}/projects/p-illisible`, { body: project("p-illisible", "illisible", "org-recette") }],
    ]);
    check("le bloc Neon est lu (plan launch)", r.status === 0 && neon?.available === true && /Plan launch/.test(neon?.note ?? ""), `${r.status} ${r.stderr.slice(0, 300)} ${JSON.stringify(neon)}`);
    const storage = metric(neon, "Storage projet");
    check("le projet le plus gros se mesure à la somme de ses branches (312 Mo + 40 Mo), pas à 0", Boolean(storage) && /gros/.test(storage.name) && Math.abs(storage.used - gb(352)) < 0.0011 && storage.limit === null, JSON.stringify(storage));
    check("... chaque projet du détail aussi", Math.abs((row(neon, "gros")?.storageGB ?? 0) - 0.344) < 0.0011 && Math.abs((row(neon, "petit")?.storageGB ?? 0) - 0.01) < 0.0011, JSON.stringify(neon?.breakdown));
    check("une taille illisible est dite, avec le nom du projet, et marquée dans le détail", /Taille illisible pour 1 projet\(s\) \(illisible\)/.test(neon?.note ?? "") && row(neon, "illisible")?.storageGB === 0 && row(neon, "illisible")?.storageUnread === true, neon?.note);
    check("les branches ont été demandées à Neon, projet par projet", ["p-gros", "p-petit", "p-illisible"].every((id) => asked.includes(`${API}/projects/${id}/branches`)), asked.join(" | "));
    check("un plan payant n'a pas de total plafonné", !metric(neon, "Storage total"), JSON.stringify(neon?.metrics));
  }

  console.log("\n── Un compte gratuit : les branches font foi, aux plafonds d'aujourd'hui (1 Go par projet, 20 Go en tout) ──");
  {
    const { r, neon, asked } = run([
      org("org-libre", "free"),
      [`${API}/projects?`, { body: { projects: [{ id: "p-un", name: "un", org_id: "org-libre", synthetic_storage_size: 200 * MB }, { id: "p-deux", name: "deux", org_id: "org-libre", synthetic_storage_size: 0 }] } }],
      [`${API}/projects/p-un/branches`, { body: { branches: [{ id: "br-main", logical_size: 220 * MB }] } }],
      [`${API}/projects/p-un`, { body: project("p-un", "un", "org-libre", { synthetic_storage_size: 200 * MB, compute_time_seconds: 0 }) }],
      [`${API}/projects/p-deux/branches`, { body: { branches: [{ id: "br-main", logical_size: 30 * MB }] } }],
      [`${API}/projects/p-deux`, { body: project("p-deux", "deux", "org-libre", { compute_time_seconds: 0 }) }],
    ]);
    const storage = metric(neon, "Storage projet");
    check("la taille vient des branches (220 Mo), pas du chiffre du projet (200 Mo)", r.status === 0 && Math.abs((storage?.used ?? -1) - gb(220)) < 0.0011, JSON.stringify(storage));
    check("... rapportée au plafond d'aujourd'hui : 1 Go par projet", storage?.limit === 1 && Math.abs((storage?.pctUsed ?? -1) - 21.5) < 0.11, JSON.stringify(storage));
    const total = metric(neon, "Storage total");
    check("... et le total de tous les projets (250 Mo) sur ses 20 Go", Boolean(total) && total.limit === 20 && Math.abs(total.used - gb(250)) < 0.0011 && /2 projets/.test(total.name), JSON.stringify(total));
    check("les branches de chaque projet sont lues", asked.includes(`${API}/projects/p-un/branches`) && asked.includes(`${API}/projects/p-deux/branches`), asked.join(" | "));
    check("la note dit les plafonds d'aujourd'hui, et rien sur une taille illisible", /1 GB storage \(20 GB au total/.test(neon?.note ?? "") && !/illisible|indisponible|chiffre du projet/.test(neon?.note ?? ""), neon?.note);
  }

  console.log("\n── Des branches qui ne répondent pas : le chiffre du projet en dernier recours, et dit ──");
  {
    const { neon } = run([
      org("org-libre", "free"),
      [`${API}/projects?`, { body: { projects: [{ id: "p-un", name: "un", org_id: "org-libre", synthetic_storage_size: 200 * MB }] } }],
      [`${API}/projects/p-un/branches`, { status: 503, body: { message: "erreur de recette" } }],
      [`${API}/projects/p-un`, { body: project("p-un", "un", "org-libre", { synthetic_storage_size: 200 * MB }) }],
    ]);
    const storage = metric(neon, "Storage projet");
    check("la taille du projet (200 Mo) sert quand ses branches ne répondent pas", Math.abs((storage?.used ?? -1) - gb(200)) < 0.0011, JSON.stringify(storage));
    check("... et la note le dit, avec le nom du projet", /Taille de 1 projet\(s\) \(un\) lue sur le chiffre du projet/.test(neon?.note ?? ""), neon?.note);
  }

  console.log("\n── Le compte du 16/10 : tout à 0, et du calcul compté : le stockage est indisponible, jamais un 0 % vert ──");
  {
    const { neon } = run([
      org("org-libre", "free"),
      [`${API}/projects?`, { body: { projects: [{ id: "p-a", name: "a", org_id: "org-libre", synthetic_storage_size: 0 }, { id: "p-b", name: "b", org_id: "org-libre", synthetic_storage_size: 0 }] } }],
      [`${API}/projects/p-a/branches`, { status: 500, body: { message: "erreur de recette" } }],
      [`${API}/projects/p-a`, { body: project("p-a", "a", "org-libre", { compute_time_seconds: 7200 }) }],
      [`${API}/projects/p-b/branches`, { status: 500, body: { message: "erreur de recette" } }],
      [`${API}/projects/p-b`, { body: project("p-b", "b", "org-libre", { compute_time_seconds: 0 }) }],
    ]);
    const storage = metric(neon, "Storage projet");
    check("aucune taille lue : la métrique est indisponible, sans chiffre ni pourcentage", storage?.used === null && storage?.pctUsed === null && /aucun projet/.test(storage?.unavailable ?? ""), JSON.stringify(storage));
    check("... la note le dit, et le détail marque chaque projet", /Stockage indisponible/.test(neon?.note ?? "") && neon?.breakdown?.every((b) => b.storageUnread === true), `${neon?.note} ${JSON.stringify(neon?.breakdown)}`);
    check("... et aucun total n'est donné sur des tailles inconnues", !metric(neon, "Storage total"), JSON.stringify(neon?.metrics));
    check("le calcul, lui, reste mesuré", Math.abs((metric(neon, "Compute")?.used ?? -1) - 2) < 0.011, JSON.stringify(metric(neon, "Compute")));
  }
  {
    const { neon } = run([
      org("org-libre", "free"),
      [`${API}/projects?`, { body: { projects: [{ id: "p-a", name: "a", org_id: "org-libre", synthetic_storage_size: 0 }] } }],
      [`${API}/projects/p-a/branches`, { body: { branches: [{ id: "br-main", logical_size: 0 }] } }],
      [`${API}/projects/p-a`, { body: project("p-a", "a", "org-libre", { compute_time_seconds: 0, data_transfer_bytes: 50 * MB }) }],
    ]);
    const storage = metric(neon, "Storage projet");
    check("des branches qui disent 0 alors que la base envoie des données : indisponible aussi", storage?.used === null && /0 octet pour chaque projet/.test(storage?.unavailable ?? ""), JSON.stringify(storage));
  }
} finally {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
