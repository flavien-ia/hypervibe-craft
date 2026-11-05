#!/usr/bin/env node
// dump-db.mjs - Dump a Postgres database to JSON files (one per table) + schema.
//
// Usage:
//   DUMP_DB_CONN=<postgres-url> node dump-db.mjs --out-dir <dir> [--project-dir <path>]
//
// The connection string is a secret, whole: it comes through the DUMP_DB_CONN environment
// variable of this process (what build-snapshot.mjs sets), never through its arguments,
// which anything running on the machine can read in the process list. --conn-string is
// still accepted for a hand-run, with that warning.
//
// Writes:
//   <out-dir>/schema.json          - list of tables + columns + types
//   <out-dir>/<schema>.<table>.json - data rows for each user table
//   <out-dir>/_summary.json        - quick summary (table count, total rows)
//
// Driver detection: tries @neondatabase/serverless, pg, then postgres (in that order),
// resolved from the project's node_modules via createRequire.
//
// Exits 0 on success, 1 on error. Final stdout line is a JSON status report:
//   "ok"       every table was read
//   "partial"  some tables could not be read: they are NAMED (failedTables), exit 0
//   "error"    nothing could be read, or no table at all was readable: exit 1
// An export of a database nothing could be read from is not a backup, and never says "ok".

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const CONN = process.env.DUMP_DB_CONN || arg("--conn-string");
const OUT = arg("--out-dir");
const PROJECT_DIR = arg("--project-dir") || process.cwd();

if (!CONN || !OUT) {
  console.error("Usage: DUMP_DB_CONN=<url> node dump-db.mjs --out-dir <dir> [--project-dir <path>]");
  process.exit(1);
}
if (!process.env.DUMP_DB_CONN) {
  console.error(
    "[dump-db] --conn-string met l'URL de connexion dans la liste des processus et l'historique du shell : preferer la variable d'environnement DUMP_DB_CONN.",
  );
}

mkdirSync(OUT, { recursive: true });

// Try drivers from the project's node_modules
const pkgJson = resolve(PROJECT_DIR, "package.json");
if (!existsSync(pkgJson)) {
  console.log(JSON.stringify({ status: "error", reason: `package.json not found in ${PROJECT_DIR}` }));
  process.exit(1);
}
const projectRequire = createRequire(pkgJson);

async function tryDriver(name) {
  try {
    const pkgPath = projectRequire.resolve(name);
    return await import(pathToFileURL(pkgPath).href);
  } catch {
    return null;
  }
}

async function getQueryFn() {
  // 1) @neondatabase/serverless - Hypervibe default
  const neon = await tryDriver("@neondatabase/serverless");
  if (neon && (neon.neon || neon.default?.neon)) {
    const neonFn = neon.neon || neon.default.neon;
    const sql = neonFn(CONN, { fullResults: false });
    return {
      driver: "@neondatabase/serverless",
      query: async (text) => {
        // Recent @neondatabase/serverless refuses the conventional call
        // `sql(text)` and requires either a tagged template or `sql.query()`.
        // `sql.query(text)` returns the rows array directly.
        if (typeof sql.query === "function") return await sql.query(text);
        return await sql(text); // older driver versions
      },
      end: async () => {},
    };
  }
  // 2) pg
  const pg = await tryDriver("pg");
  if (pg) {
    const PgClient = pg.Client || pg.default?.Client;
    if (PgClient) {
      const client = new PgClient({ connectionString: CONN });
      await client.connect();
      return {
        driver: "pg",
        query: async (text) => (await client.query(text)).rows,
        end: async () => client.end(),
      };
    }
  }
  // 3) postgres (postgres.js)
  const pgjs = await tryDriver("postgres");
  if (pgjs) {
    const postgresFn = pgjs.default || pgjs;
    const sql = postgresFn(CONN);
    return {
      driver: "postgres",
      query: async (text) => await sql.unsafe(text),
      end: async () => sql.end({ timeout: 5 }),
    };
  }
  return null;
}

let qfn;
try {
  qfn = await getQueryFn();
} catch (e) {
  console.log(JSON.stringify({ status: "error", reason: `driver init failed: ${e.message}` }));
  process.exit(1);
}
if (!qfn) {
  console.log(JSON.stringify({ status: "error", reason: "No Postgres driver found in project node_modules (looked for @neondatabase/serverless, pg, postgres)" }));
  process.exit(1);
}

try {
  // List user tables
  const tables = await qfn.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `);

  // No table listed. information_schema only lists the tables the role holds a right on, so the
  // catalog says which it is: a database that holds no table yet (a project whose /add-db created
  // the database and nothing else, bench of 04/11/2026), or tables this role cannot read, which is
  // no backup at all. A catalog that cannot be read decides nothing: the caller keeps its own rule.
  let emptyDatabase = false;
  if (tables.length === 0) {
    let inCatalog = null;
    try {
      const [row] = await qfn.query(`
        SELECT count(*)::int AS n
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_toast%'
      `);
      inCatalog = Number(row?.n);
    } catch {
      inCatalog = null;
    }
    if (inCatalog > 0) {
      console.log(JSON.stringify({ status: "error", driver: qfn.driver, tableCount: 0, totalRows: 0, reason: `${inCatalog} table(s) exist in the database, but the role this connection uses can read none of them` }));
      process.exitCode = 1;
      throw Object.assign(new Error("reported"), { reported: true });
    }
    emptyDatabase = inCatalog === 0;
  }

  // Columns metadata
  const columns = await qfn.query(`
    SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, ordinal_position
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  `);

  const schema = {
    driver: qfn.driver,
    dumpedAt: new Date().toISOString(),
    tables: tables.map((t) => `${t.table_schema}.${t.table_name}`),
    columns,
  };
  writeFileSync(resolve(OUT, "schema.json"), JSON.stringify(schema, null, 2));

  // Dump table data
  const tablesDumped = [];
  let totalRows = 0;
  for (const t of tables) {
    const fullName = `${t.table_schema}.${t.table_name}`;
    const safeName = fullName.replace(/[^\w.-]/g, "_");
    let rows;
    try {
      rows = await qfn.query(`SELECT * FROM "${t.table_schema}"."${t.table_name}"`);
    } catch (e) {
      tablesDumped.push({ name: fullName, error: e.message });
      continue;
    }
    writeFileSync(resolve(OUT, `${safeName}.json`), JSON.stringify(rows, null, 2));
    tablesDumped.push({ name: fullName, rows: rows.length });
    totalRows += rows.length;
  }

  writeFileSync(resolve(OUT, "_summary.json"), JSON.stringify({
    driver: qfn.driver,
    tableCount: tables.length,
    totalRows,
    tables: tablesDumped,
  }, null, 2));

  // A table that could not be read (permissions, suspended compute, exhausted quota) used
  // to vanish into _summary.json while the run reported "ok" with totalRows: 0.
  const failed = tablesDumped.filter((t) => t.error).map((t) => t.name);
  const status = failed.length === 0 ? "ok" : failed.length === tables.length ? "error" : "partial";
  console.log(JSON.stringify({
    status,
    driver: qfn.driver,
    tableCount: tables.length,
    totalRows,
    ...(emptyDatabase ? { emptyDatabase: true } : {}),
    ...(failed.length
      ? {
          failedTables: failed,
          reason: `${failed.length} of ${tables.length} table(s) could not be read (details in _summary.json)`,
        }
      : {}),
  }));
  if (status === "error") process.exitCode = 1;
} catch (e) {
  if (!e?.reported) {
    console.log(JSON.stringify({ status: "error", reason: e.message }));
    process.exitCode = 1;
  }
} finally {
  try { await qfn.end(); } catch {}
}
