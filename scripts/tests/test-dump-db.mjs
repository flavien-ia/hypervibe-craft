#!/usr/bin/env node
// test-dump-db.mjs - Recette of scripts/save-project/dump-db.mjs.
//
// An export of a database nothing could be read from is not a backup: it must never say
// "ok". And the connection string is a secret: it reaches the script through its
// environment, never its arguments, and never comes back out.
//
// No network, no database: a fake `pg` driver is written into a temporary project, and
// answers from a script of table names (a name starting with "refusee" throws).
//
//   node scripts/tests/test-dump-db.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "save-project", "dump-db.mjs");
const SECRET = "motdepasse-qui-ne-doit-jamais-sortir";
const CONN = `postgres://app:${SECRET}@db.exemple.fr:5432/app`;

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}

const FAKE_PG = `
const tables = JSON.parse(process.env.FAKE_TABLES || "[]");
const catalog = process.env.FAKE_CATALOG ?? "0";
exports.Client = class {
  constructor(opts) { this.opts = opts; }
  async connect() {}
  async end() {}
  async query(text) {
    if (/pg_catalog\\.pg_class/.test(text)) {
      if (catalog === "illisible") throw new Error("permission denied for pg_class");
      return { rows: [{ n: Number(catalog) }] };
    }
    if (/information_schema\\.tables/.test(text)) return { rows: tables.map((t) => ({ table_schema: "public", table_name: t })) };
    if (/information_schema\\.columns/.test(text)) return { rows: [] };
    const m = /FROM "public"\\."([^"]+)"/.exec(text);
    if (m && m[1].startsWith("refusee")) throw new Error("permission denied for table " + m[1]);
    return { rows: [{ id: 1 }, { id: 2 }] };
  }
};
`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "hv-dump-db-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "essai", version: "1.0.0" }));
  mkdirSync(join(dir, "node_modules", "pg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pg", "package.json"), JSON.stringify({ name: "pg", version: "0.0.0", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", "pg", "index.js"), FAKE_PG);
  return dir;
}

function dump(tables, { viaArgument = false, catalog = "0" } = {}) {
  const dir = project();
  const out = join(dir, "db");
  const args = [SCRIPT, "--out-dir", out, "--project-dir", dir];
  if (viaArgument) args.push("--conn-string", CONN);
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, DUMP_DB_CONN: viaArgument ? "" : CONN, FAKE_TABLES: JSON.stringify(tables), FAKE_CATALOG: catalog },
  });
  let payload = null;
  try {
    payload = JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch {}
  const summary = existsSync(join(out, "_summary.json")) ? JSON.parse(readFileSync(join(out, "_summary.json"), "utf8")) : null;
  rmSync(dir, { recursive: true, force: true });
  return { r, payload, summary };
}

console.log("── Toutes les tables lues ──");
{
  const { r, payload } = dump(["clients", "commandes"]);
  check("statut ok, exit 0", payload?.status === "ok" && r.status === 0, `${payload?.status} / exit ${r.status}`);
  check("2 tables, 4 lignes", payload?.tableCount === 2 && payload?.totalRows === 4);
  check("pas de failedTables quand tout est lu", payload && !("failedTables" in payload));
  check("la chaine passee par l'environnement ne ressort nulle part", !(r.stdout + r.stderr).includes(SECRET));
  check("aucun avertissement quand la chaine vient de l'environnement", !/conn-string/.test(r.stderr));
}

console.log("\n── Des tables refusees : la sauvegarde a des trous, et le dit ──");
{
  const { r, payload, summary } = dump(["clients", "refusee_paiements", "commandes"]);
  check("statut partial, exit 0", payload?.status === "partial" && r.status === 0, `${payload?.status} / exit ${r.status}`);
  check("la table non lue est nommee", JSON.stringify(payload?.failedTables) === JSON.stringify(["public.refusee_paiements"]));
  check("une raison lisible accompagne le statut", /1 of 3 table/.test(payload?.reason || ""));
  check("_summary.json garde la raison de la table", summary?.tables?.some((t) => t.name === "public.refusee_paiements" && /permission denied/.test(t.error)));
}

console.log("\n── Aucune table lisible : ce n'est pas une sauvegarde ──");
{
  const { r, payload } = dump(["refusee_a", "refusee_b"]);
  check("statut error, exit 1 (avant : ok, 0 ligne)", payload?.status === "error" && r.status === 1, `${payload?.status} / exit ${r.status}`);
  check("les deux tables sont nommees", payload?.failedTables?.length === 2);
}

console.log("\n── Une base sans table, et des tables que le role ne voit pas (banc du 04/11/2026) ──");
{
  const vide = dump([], { catalog: "0" });
  check("base sans aucune table : statut ok, emptyDatabase, exit 0", vide.payload?.status === "ok" && vide.payload?.tableCount === 0 && vide.payload?.emptyDatabase === true && vide.r.status === 0, JSON.stringify(vide.payload));
  const cachees = dump([], { catalog: "3" });
  check("tables invisibles au role : erreur qui le dit, exit 1, jamais emptyDatabase", cachees.payload?.status === "error" && !cachees.payload?.emptyDatabase && /3 table\(s\) exist/.test(cachees.payload?.reason ?? "") && cachees.r.status === 1, JSON.stringify(cachees.payload));
  const muet = dump([], { catalog: "illisible" });
  check("catalogue illisible : rien n'est conclu (ok sans emptyDatabase)", muet.payload?.status === "ok" && muet.payload?.tableCount === 0 && !muet.payload?.emptyDatabase, JSON.stringify(muet.payload));
  const src = readFileSync(join(ROOT, "scripts", "save-project", "build-snapshot.mjs"), "utf8");
  check("/save-project ne passe une base vide en skipped que sur emptyDatabase", /tableCount \?\? 0\) === 0 && payload\.emptyDatabase === true\)\s*\{\s*logStep\("db-dump", "skipped"/.test(src));
}

console.log("\n── L'ancien passage par argument reste accepte, avec son avertissement ──");
{
  const { r, payload } = dump(["clients"], { viaArgument: true });
  check("statut ok", payload?.status === "ok" && r.status === 0);
  check("l'avertissement nomme DUMP_DB_CONN", /DUMP_DB_CONN/.test(r.stderr));
  check("l'avertissement ne montre pas la chaine", !(r.stdout + r.stderr).includes(SECRET));
}

console.log("\n── Sans chaine de connexion ──");
{
  const dir = project();
  const r = spawnSync(process.execPath, [SCRIPT, "--out-dir", join(dir, "db"), "--project-dir", dir], {
    encoding: "utf8",
    env: { ...process.env, DUMP_DB_CONN: "" },
  });
  rmSync(dir, { recursive: true, force: true });
  check("exit 1 et l'usage cite la variable d'environnement", r.status === 1 && /DUMP_DB_CONN/.test(r.stderr));
}

console.log("\n── build-snapshot.mjs ne passe plus la chaine en argument ──");
{
  const src = readFileSync(join(ROOT, "scripts", "save-project", "build-snapshot.mjs"), "utf8");
  check("plus de --conn-string dans l'appel", !/"--conn-string"/.test(src));
  check("la chaine voyage par l'environnement de l'enfant", /DUMP_DB_CONN:\s*connString/.test(src));
  check("un export partiel est rapporte comme tel", /logStep\("db-dump", "partial"/.test(src));
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
