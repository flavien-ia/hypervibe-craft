#!/usr/bin/env node
// test-cloudflare-token-page.mjs - The page that makes the Cloudflare token with its permissions
// already ticked (3.4.29 / 2.5.8), and the readable fallback the skills keep next to it:
//   - every key is derived from the label Cloudflare's own list gives its permission group (a key it
//     does not know is dropped silently, with no notice on the page);
//   - the address carries exactly the list, no more, no less, and the account it is limited to;
//   - each fallback list written in a skill is the module's list, line for line, and the reverse;
//   - the skills open the page the module builds, never the bare token page with a list to tick.
//
//   node scripts/tests/test-cloudflare-token-page.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOD = join(ROOT, "scripts", "cloudflare-token-page.mjs");
const { LISTS, keyOf, linesOf, tokenPage } = await import(pathToFileURL(MOD).href);
const read = (...p) => (existsSync(join(ROOT, ...p)) ? readFileSync(join(ROOT, ...p), "utf8") : "");

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}

console.log("── Les clés, tirées des libellés de Cloudflare ──");
check("le niveau vient du dernier mot du libellé, « write » demandé en « edit »", JSON.stringify(keyOf("dns_write")) === '{"key":"dns","type":"edit"}' && JSON.stringify(keyOf("ai_read")) === '{"key":"ai","type":"read"}' && JSON.stringify(keyOf("cache_purge")) === '{"key":"cache","type":"purge"}');
let refused = false;
try { keyOf("dns"); } catch { refused = true; }
check("un libellé sans niveau est refusé, jamais deviné", refused);
const LEVEL = { read: "Read", edit: "Edit", purge: "Purge" };
for (const [name, list] of Object.entries(LISTS)) {
  const bad = list.filter((p) => LEVEL[keyOf(p.cfLabel).type] !== p.level || !["Account", "Zone", "User"].includes(p.scope));
  check(`${name} : le niveau lisible de chaque ligne est celui de sa clé, chaque ligne a sa portée`, bad.length === 0, bad.map((p) => p.cfLabel).join(", "));
  const seen = list.map((p) => p.cfLabel);
  check(`${name} : aucune ligne deux fois`, new Set(seen).size === seen.length);
}

console.log("\n── L'adresse ──");
for (const name of Object.keys(LISTS)) {
  const u = new URL(tokenPage(name));
  const keys = JSON.parse(u.searchParams.get("permissionGroupKeys"));
  const want = LISTS[name].map((p) => keyOf(p.cfLabel));
  check(`${name} : la page des jetons de l'utilisateur, avec exactement la liste, dans son ordre`, u.origin + u.pathname === "https://dash.cloudflare.com/profile/api-tokens" && JSON.stringify(keys) === JSON.stringify(want), JSON.stringify(keys));
  check(`${name} : tous les comptes et toutes les zones par défaut, un nom posé`, u.searchParams.get("accountId") === "*" && u.searchParams.get("zoneId") === "all" && (u.searchParams.get("name") ?? "").length > 0);
}
check("la clé du compte du solo : les treize lignes que demandait /start", LISTS.account.length === 13);
check("la clé de l'organisation : les quatorze lignes que demandait /start de l'administrateur", LISTS.organisation.length === 14);
const one = new URL(tokenPage("project-r2", { name: "atelier-liza", accountId: "0123456789abcdef0123456789abcdef" }));
check("la clé d'un projet : une seule ligne, limitée au compte donné, au nom du projet", JSON.parse(one.searchParams.get("permissionGroupKeys")).length === 1 && one.searchParams.get("accountId") === "0123456789abcdef0123456789abcdef" && one.searchParams.get("name") === "atelier-liza");
let badId = false;
try { tokenPage("project-r2", { accountId: "x&zoneId=1" }); } catch { badId = true; }
check("un identifiant de compte qui n'en est pas un est refusé (rien ne s'ajoute à l'adresse)", badId);
const cli = spawnSync(process.execPath, [MOD, "account"], { encoding: "utf8" });
const out = cli.status === 0 ? JSON.parse(cli.stdout) : null;
check("la ligne de commande rend la page et la liste de repli", out?.url === tokenPage("account") && JSON.stringify(out?.lines) === JSON.stringify(linesOf("account")), cli.stderr);
const cliBad = spawnSync(process.execPath, [MOD, "toutes"], { encoding: "utf8" });
check("... et refuse une liste inconnue (code 1)", cliBad.status === 1);

console.log("\n── Les skills : la page du module, et la même liste en repli ──");
/** The fallback lines written in a skill, after its heading line, without the notes in italics. */
function fallback(text, heading) {
  const at = text.indexOf(heading);
  if (at < 0) return null;
  const out = [];
  for (const line of text.slice(at + heading.length).split("\n").slice(1)) {
    if (!line.startsWith("- ")) break;
    out.push(line.slice(2).replace(/\s+\*\(.*\)\*\s*$/, "").trim());
  }
  return out;
}
const sets = (a, b) => {
  const missing = b.filter((x) => !a.includes(x));
  const extra = a.filter((x) => !b.includes(x));
  return { ok: missing.length === 0 && extra.length === 0 && a.length === b.length, missing, extra };
};
// [skill, list, heading of its fallback list]: the administrator's /start makes the organisation's
// key, the solo's the account's (the administrator's skills are still written in French here).
const SKILLS = read("skills", "start", "SKILL.md").includes("Liste de repli (la même")
  ? [["start", "organisation", "Liste de repli (la même que `lines`"]]
  : [["start", "account", "Fallback list (the same as `lines`"]];
for (const [skill, list, heading] of SKILLS) {
  const text = read("skills", skill, "SKILL.md");
  check(`/${skill} lit la liste « ${list} » du module`, text.includes(`cloudflare-token-page.mjs" ${list}`));
  const fb = fallback(text, heading);
  const cmp = fb ? sets(fb, linesOf(list)) : { ok: false, missing: ["(liste de repli introuvable)"], extra: [] };
  check(`/${skill} : chaque ligne du repli est dans l'adresse, et chaque ligne de l'adresse est dans le repli`, cmp.ok, `manque ${cmp.missing.join(" | ")} ; en trop ${cmp.extra.join(" | ")}`);
  check(`/${skill} : la personne se connecte avant que la page s'ouvre (Cloudflare perd le préremplissage à la connexion)`, /dash\.cloudflare\.com\*\*[^\n]*\n[\s\S]{0,400}open-url\.mjs" "<url>"/.test(text));
  check(`/${skill} : plus de recette à cocher ligne par ligne comme chemin principal`, !/Permissions\*\* \((click|clique) "\+ Add more"/.test(text));
}
const np = read("skills", "new-project", "SKILL.md");
if (np) {
  check("/new-project : la clé du projet par la liste « project-r2 », limitée au compte de l'organisation quand il est seul", np.includes('cloudflare-token-page.mjs" project-r2 --name "$PROJET"') && np.includes('--account-id "$CF_ACCOUNT"'));
  check("/new-project : son repli dit la même ligne", np.includes(linesOf("project-r2")[0]));
}
const all = ["start", "new-project"].map((s) => read("skills", s, "SKILL.md")).join("\n");
check("aucune skill n'ouvre plus la page nue des jetons pour y faire cocher une liste", !/open-url\.mjs" "https:\/\/dash\.cloudflare\.com\/profile\/api-tokens"/.test(all));

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
