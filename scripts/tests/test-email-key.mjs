#!/usr/bin/env node
// test-email-key.mjs - A project's own sending key, never the account's (3.4.16, Jérôme
// Carfantan's mail of 21/10/2026).
//
// Until 3.4.15 /add-email copied the email account's key (a Resend "Full Access" key, the Brevo
// account's key) into every project's .env and hosting: one .env seen, and the whole account was
// open. What must hold now:
//   1. Resend: the project's key is made by the API with the account's key, limited to sending,
//      and to the sender's domain once Resend has verified it; it lands in the project's .env (and
//      its hosting), is recorded in the manifest by its id, and nothing ever prints a key;
//   2. a project that holds its own key is never given a second one in silence (--rotate), one
//      that holds the account's is told so (--replace), a key nobody holds is revoked at once;
//   3. revoke touches a key the project records, and nothing else;
//   4. Brevo: the project's sending application made by the API (3.4.34), limited to sending, its
//      two variables written together; rotated, deleted, its secret renewed; a key typed by the
//      person (the fallback, and projects of before) recorded, never the account's, told apart
//      (legacy) and moved to the application, then taken away; the route refusing falls back;
//   5. setup-email.mjs reads the project's own key, refuses the account's, never pushes a key;
//   6. the skills say it, and the guardrail asks before a revocation.
// No network, no vault, no hosting: a fake Resend on 127.0.0.1 (HYPERVIBE_RESEND_API), the
// account's key as its recette stand-in (HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY, honoured only with
// that loopback), and projects without a hosting link (push-env-vars.mjs writes their .env only).
//
//   node scripts/tests/test-email-key.mjs

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "email-key.mjs");
const SETUP = join(ROOT, "scripts", "setup-email.mjs");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 500)})` : ""}`);
}

// ── The fake Resend ──────────────────────────────────────────────────────────────
const ACCOUNT = "re_COMPTE_de_recette_SECRET_0000";
const BREVO_ACCOUNT = "xkeysib-COMPTE-de-recette-SECRET";
const resend = { keys: [], domains: [{ id: "d-verifie", name: "exemple.fr", status: "verified" }, { id: "d-attente", name: "attente.fr", status: "pending" }], calls: [], n: 0 };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = body ? JSON.parse(body) : null;
    resend.calls.push({ method: req.method, path: url.pathname, body: json });
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const auth = String(req.headers.authorization ?? "");
    if (auth !== `Bearer ${ACCOUNT}`) {
      return resend.keys.some((k) => auth === `Bearer ${k.token}`)
        ? send(401, { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails." })
        : send(400, { statusCode: 400, name: "validation_error", message: "API key is invalid" });
    }
    if (req.method === "GET" && url.pathname === "/api-keys") return send(200, { object: "list", has_more: false, data: resend.keys.map(({ id, name, created_at }) => ({ id, name, created_at, last_used_at: null })) });
    if (req.method === "POST" && url.pathname === "/api-keys") {
      resend.n += 1;
      const key = { id: `k-${resend.n}`, name: json.name, token: `re_projet_${resend.n}_SECRET_cle`, permission: json.permission, domain_id: json.domain_id ?? null, created_at: new Date().toISOString() };
      resend.keys.push(key);
      return send(201, { id: key.id, object: "api_key", token: key.token });
    }
    const del = /^\/api-keys\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && del) {
      const before = resend.keys.length;
      resend.keys = resend.keys.filter((k) => k.id !== decodeURIComponent(del[1]));
      return before === resend.keys.length ? send(404, { statusCode: 404, name: "not_found", message: "API key not found" }) : send(200, { object: "api_key", id: del[1], deleted: true });
    }
    if (req.method === "GET" && url.pathname === "/domains") return send(200, { object: "list", has_more: false, data: resend.domains });
    send(404, { statusCode: 404, name: "not_found", message: "no such route in the fake" });
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const API = `http://127.0.0.1:${server.address().port}`;

const temps = [];
const scratch = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
const HOME = scratch("hv-email-key-home-");
const ENV = { ...process.env, HOME, USERPROFILE: HOME, APPDATA: join(HOME, "appdata"), HYPERVIBE_RESEND_API: API, HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY: ACCOUNT };
for (const k of ["RESEND_API_KEY", "BREVO_API_KEY", "VERCEL_TOKEN"]) delete ENV[k];

/** A project of the recette's own: package.json, and its .env. */
function project({ deps = { next: "15.0.0", resend: "4.0.0" }, env = "RESEND_FROM_EMAIL=onboarding@resend.dev\n" } = {}) {
  const dir = scratch("hv-email-key-projet-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: deps }));
  writeFileSync(join(dir, ".env"), env);
  return dir;
}
const envOf = (dir, key) => (readFileSync(join(dir, ".env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? null);
const manifestOf = (dir) => (existsSync(join(dir, ".hypervibe", "resources.json")) ? readFileSync(join(dir, ".hypervibe", "resources.json"), "utf8") : "");
const keysOf = (dir) => {
  try {
    return JSON.parse(manifestOf(dir)).resources.filter((r) => r.kind === "email-key");
  } catch {
    return [];
  }
};
/** email-key.mjs for real; its JSON, its exit code, and its whole output (to look for keys). */
function run(args, env = ENV, script = SCRIPT) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [script, ...args], { env, windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(out.trim().split("\n").pop());
      } catch {
        json = null;
      }
      done({ code, json, all: `${out}${err}` });
    });
  });
}
const noKeyIn = (text) => !/SECRET/.test(text);

try {
  console.log("── 1. Resend : la clé du projet, faite par l'API ──");
  const p1 = project();
  let r = await run(["status", "--project-dir", p1]);
  check("un projet neuf ne tient aucune clé", r.code === 0 && r.json?.holds === "none" && r.json?.provider === "resend", JSON.stringify(r.json));
  resend.calls.length = 0;
  r = await run(["mint", "--project-dir", p1, "--name", "demo"]);
  const made = resend.keys.at(-1);
  const post = resend.calls.find((c) => c.method === "POST" && c.path === "/api-keys");
  check("mint : une clé faite chez Resend, limitée à l'envoi", r.code === 0 && r.json?.status === "created" && post?.body?.permission === "sending_access", `${r.code} ${JSON.stringify(r.json)} ${JSON.stringify(post?.body)}`);
  check("... nommée d'après le projet", /^demo \d{4}-\d{2}-\d{2}$/.test(post?.body?.name ?? ""), post?.body?.name);
  check("... sans domaine tant que l'expéditeur est l'adresse de test", !post?.body?.domain_id && r.json?.key?.domain === null);
  check("... dans le .env du projet : la clé du projet, jamais celle du compte", envOf(p1, "RESEND_API_KEY") === made?.token && envOf(p1, "RESEND_API_KEY") !== ACCOUNT);
  check("... inscrite au manifeste par son identifiant, sans aucune valeur", keysOf(p1).length === 1 && keysOf(p1)[0].id === made?.id && keysOf(p1)[0].provider === "resend" && noKeyIn(manifestOf(p1)), manifestOf(p1));
  check("... et rien n'affiche une clé (ni celle du projet, ni celle du compte)", noKeyIn(r.all), r.all);
  r = await run(["status", "--project-dir", p1]);
  check("status : le projet tient sa propre clé", r.json?.holds === "own" && noKeyIn(r.all), JSON.stringify(r.json));

  console.log("\n── 2. Jamais une seconde clé en silence ; la rotation ; le domaine vérifié ──");
  resend.calls.length = 0;
  r = await run(["mint", "--project-dir", p1, "--name", "demo"]);
  check("une clé propre déjà là : refus (code 5), rien de fait chez Resend", r.code === 5 && !resend.calls.some((c) => c.method === "POST"), `${r.code} ${JSON.stringify(r.json)}`);
  writeFileSync(join(p1, ".env"), readFileSync(join(p1, ".env"), "utf8").replace("onboarding@resend.dev", "contact@exemple.fr"));
  const old = made.id;
  resend.calls.length = 0;
  r = await run(["mint", "--project-dir", p1, "--name", "demo", "--rotate"]);
  const rotated = resend.keys.at(-1);
  check("--rotate : une nouvelle clé, limitée au domaine vérifié de l'expéditeur", r.code === 0 && r.json?.status === "rotated" && resend.calls.find((c) => c.method === "POST")?.body?.domain_id === "d-verifie" && r.json?.key?.domain === "exemple.fr", `${r.code} ${JSON.stringify(r.json)}`);
  check("... l'ancienne n'est pas révoquée tout de suite (le site tourne encore avec), elle revient à révoquer", JSON.stringify(r.json?.toRevoke) === JSON.stringify([old]) && resend.keys.some((k) => k.id === old) && !resend.calls.some((c) => c.method === "DELETE"), JSON.stringify(r.json));
  check("... le .env tient la nouvelle", envOf(p1, "RESEND_API_KEY") === rotated.token);
  resend.calls.length = 0;
  r = await run(["revoke", "--project-dir", p1, "--id", old]);
  check("revoke : l'ancienne révoquée chez Resend, relue absente, sortie du manifeste", r.code === 0 && r.json?.revoked === true && resend.calls.some((c) => c.method === "DELETE" && c.path === `/api-keys/${old}`) && !resend.keys.some((k) => k.id === old) && !keysOf(p1).some((k) => k.id === old) && keysOf(p1).some((k) => k.id === rotated.id), `${r.code} ${JSON.stringify(r.json)}`);
  resend.calls.length = 0;
  r = await run(["revoke", "--project-dir", p1, "--id", "k-dun-autre-projet"]);
  check("revoke d'une clé que le projet n'inscrit pas : refus (code 6), rien envoyé à Resend", r.code === 6 && !resend.calls.some((c) => c.method === "DELETE"), `${r.code} ${JSON.stringify(r.json)}`);
  {
    const p = project({ env: "RESEND_FROM_EMAIL=contact@attente.fr\n" });
    resend.calls.length = 0;
    r = await run(["mint", "--project-dir", p, "--name", "demo"]);
    check("un domaine pas encore vérifié : la clé sans domaine, et c'est dit", r.code === 0 && !resend.calls.find((c) => c.method === "POST")?.body?.domain_id && /attente\.fr is not verified/.test(r.json?.domainNote ?? ""), JSON.stringify(r.json));
  }

  console.log("\n── 3. Un projet qui tient la clé du compte ──");
  {
    const p = project({ env: `RESEND_FROM_EMAIL=onboarding@resend.dev\nRESEND_API_KEY=${ACCOUNT}\n` });
    r = await run(["status", "--project-dir", p]);
    check("status : « account », sans jamais l'afficher", r.json?.holds === "account" && noKeyIn(r.all), r.all);
    resend.calls.length = 0;
    r = await run(["mint", "--project-dir", p, "--name", "demo"]);
    check("mint sans --replace : refus (code 5), et la raison", r.code === 5 && /ACCOUNT's key/.test(r.json?.error ?? "") && !resend.calls.some((c) => c.method === "POST"), JSON.stringify(r.json));
    r = await run(["mint", "--project-dir", p, "--name", "demo", "--replace"]);
    check("--replace : la clé du projet prend la place de celle du compte", r.code === 0 && r.json?.status === "replaced" && envOf(p, "RESEND_API_KEY") === resend.keys.at(-1).token && /renew it there/.test(r.json?.accountKey ?? ""), JSON.stringify(r.json));
  }
  {
    // A key written nowhere is never left alive: a .env that cannot be written.
    const p = project();
    chmodSync(join(p, ".env"), 0o444);
    resend.calls.length = 0;
    const before = resend.keys.length;
    r = await run(["mint", "--project-dir", p, "--name", "demo"]);
    chmodSync(join(p, ".env"), 0o644);
    check("une clé faite mais écrite nulle part est révoquée aussitôt (code 1)", r.code === 1 && resend.calls.some((c) => c.method === "POST") && resend.calls.some((c) => c.method === "DELETE") && resend.keys.length === before && !envOf(p, "RESEND_API_KEY"), `${r.code} ${JSON.stringify(r.json)} ${JSON.stringify(resend.calls.map((c) => c.method))}`);
  }

  console.log("\n── 4. Brevo : la clé faite à la main, jamais celle du compte ──");
  {
    const env = { ...ENV, HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY: BREVO_ACCOUNT };
    const p = project({ deps: { next: "15.0.0", "@getbrevo/brevo": "5.0.0" }, env: `BREVO_SENDER_EMAIL=contact@exemple.fr\nBREVO_API_KEY=${BREVO_ACCOUNT}\n` });
    r = await run(["record", "--project-dir", p, "--provider", "brevo", "--key-name", "demo"], env);
    check("record de la clé du compte : refus (code 5), rien d'inscrit", r.code === 5 && keysOf(p).length === 0 && noKeyIn(r.all), r.all);
    writeFileSync(join(p, ".env"), "BREVO_SENDER_EMAIL=contact@exemple.fr\nBREVO_API_KEY=xkeysib-projet-demo-SECRET\n");
    r = await run(["record", "--project-dir", p, "--provider", "brevo", "--key-name", "demo"], env);
    check("record de la clé du projet : inscrite par son nom, sans sa valeur", r.code === 0 && keysOf(p)[0]?.name === "demo" && keysOf(p)[0]?.provider === "brevo" && noKeyIn(manifestOf(p)), `${r.code} ${manifestOf(p)}`);
    r = await run(["status", "--project-dir", p], env);
    check("status : « legacy » (une clé faite à la main, l'application pas encore là)", r.json?.holds === "legacy" && r.json?.provider === "brevo" && r.json?.legacyVariable === "BREVO_API_KEY" && r.json?.ownAlready === false, JSON.stringify(r.json));
    r = await run(["mint", "--project-dir", p, "--name", "demo"], env);
    check("mint sans --replace sur une clé d'avant : refus (code 5), rien de fait", r.code === 5 && r.json?.holds === "legacy", JSON.stringify(r.json));
  }

  console.log("\n── 4 bis. Brevo : l'application d'envoi du projet, faite par l'API (3.4.34) ──");
  {
    const { startFakeBrevo } = await import(pathToFileURL(join(ROOT, "scripts", "tests", "fixtures", "fake-brevo.mjs")).href);
    const fake = await startFakeBrevo({ token: BREVO_ACCOUNT });
    const env = { ...ENV, HYPERVIBE_BREVO_API: fake.url, HYPERVIBE_EMAIL_STANDIN_ACCOUNT_KEY: BREVO_ACCOUNT };
    const noAppSecret = (text) => ![...fake.state.apps.values()].some((a) => text.includes(a.client_secret)) && ![...fake.state.tokens.keys()].some((t) => text.includes(t));
    try {
      const p = project({ deps: { next: "15.0.0" }, env: "BREVO_SENDER_EMAIL=contact@exemple.fr\n" });
      let r = await run(["mint", "--project-dir", p, "--name", "demo", "--provider", "brevo"], env);
      const app = [...fake.state.apps.values()][0];
      check("mint --provider brevo : une application faite, limitée à l'envoi, nommée d'après le projet", r.code === 0 && r.json?.status === "created" && app?.scopes.join() === "transactional.email:write" && /^demo \d{4}-\d{2}-\d{2}$/.test(app?.name ?? ""), `${r.code} ${JSON.stringify(r.json)}`);
      check("... un jeton demandé avec la portée nommée avant de rendre", fake.state.tokenCalls.some((c) => c.scope === "transactional.email:write" && c.clientId === app?.client_id));
      check("... ses deux variables dans le .env du projet, en un geste", envOf(p, "BREVO_CLIENT_ID") === app?.client_id && envOf(p, "BREVO_CLIENT_SECRET") === app?.client_secret && !envOf(p, "BREVO_API_KEY"));
      check("... inscrite au manifeste par son identifiant, sans aucun secret", keysOf(p).some((k) => k.id === app?.app_id && k.provider === "brevo" && k.made === "api") && noAppSecret(manifestOf(p)), manifestOf(p));
      check("... et rien n'affiche le secret ni un jeton", noAppSecret(r.all), r.all);
      r = await run(["status", "--project-dir", p], env);
      check("status : « own »", r.json?.holds === "own" && r.json?.provider === "brevo" && noAppSecret(r.all), JSON.stringify(r.json));
      r = await run(["mint", "--project-dir", p, "--name", "demo"], env);
      check("une application déjà là : refus (code 5), rien de fait", r.code === 5 && fake.state.apps.size === 1, JSON.stringify(r.json));
      r = await run(["mint", "--project-dir", p, "--name", "demo", "--rotate"], env);
      check("--rotate : une nouvelle application, l'ancienne gardée jusqu'au déploiement (toRevoke)", r.code === 0 && r.json?.status === "rotated" && JSON.stringify(r.json?.toRevoke) === JSON.stringify([app?.app_id]) && fake.state.apps.has(app?.app_id) && envOf(p, "BREVO_CLIENT_ID") !== app?.client_id, JSON.stringify(r.json));
      r = await run(["revoke", "--project-dir", p, "--id", app.app_id], env);
      check("revoke : l'ancienne supprimée chez Brevo, relue absente, sortie du manifeste, la limite d'une heure dite", r.code === 0 && r.json?.revoked === true && !fake.state.apps.has(app.app_id) && !keysOf(p).some((k) => k.id === app.app_id) && /an hour/.test(r.json?.lingering ?? ""), JSON.stringify(r.json));
      const before = envOf(p, "BREVO_CLIENT_SECRET");
      r = await run(["renew", "--project-dir", p], env);
      const now = [...fake.state.apps.values()].find((a) => a.client_id === envOf(p, "BREVO_CLIENT_ID"));
      check("renew : le secret renouvelé sur place, le nouveau dans le .env, à déployer tout de suite", r.code === 0 && r.json?.status === "renewed" && envOf(p, "BREVO_CLIENT_SECRET") !== before && envOf(p, "BREVO_CLIENT_SECRET") === now?.client_secret && /now/.test(r.json?.deploy ?? "") && noAppSecret(r.all), JSON.stringify(r.json));

      const old = project({ deps: { next: "15.0.0", "@getbrevo/brevo": "5.0.0" }, env: "BREVO_SENDER_EMAIL=contact@exemple.fr\nBREVO_API_KEY=xkeysib-projet-ancien-SECRET\n" });
      r = await run(["retire-legacy", "--project-dir", old], env);
      check("retire-legacy avant l'application : refus (code 5), rien de retiré", r.code === 5 && envOf(old, "BREVO_API_KEY") === "xkeysib-projet-ancien-SECRET", JSON.stringify(r.json));
      r = await run(["mint", "--project-dir", old, "--name", "ancien", "--replace"], env);
      check("--replace : l'application à côté de l'ancienne clé, qui reste jusqu'au déploiement", r.code === 0 && r.json?.status === "replaced" && r.json?.legacyVariable === "BREVO_API_KEY" && Boolean(envOf(old, "BREVO_CLIENT_ID")) && envOf(old, "BREVO_API_KEY") === "xkeysib-projet-ancien-SECRET", JSON.stringify(r.json));
      r = await run(["status", "--project-dir", old], env);
      check("status : « legacy », l'application déjà là (ownAlready)", r.json?.holds === "legacy" && r.json?.ownAlready === true, JSON.stringify(r.json));
      r = await run(["mint", "--project-dir", old, "--name", "ancien", "--replace"], env);
      check("... --replace une seconde fois : rien de fait (code 5)", r.code === 5 && r.json?.ownAlready === true, JSON.stringify(r.json));
      r = await run(["retire-legacy", "--project-dir", old], env);
      check("retire-legacy : l'ancienne clé sortie du .env, l'application reste, sa suppression chez Brevo demandée", r.code === 0 && r.json?.status === "retired" && !envOf(old, "BREVO_API_KEY") && Boolean(envOf(old, "BREVO_CLIENT_ID")) && Boolean(r.json?.toDeleteByHand), JSON.stringify(r.json));
      r = await run(["status", "--project-dir", old], env);
      check("... et le projet tient désormais sa propre application", r.json?.holds === "own", JSON.stringify(r.json));

      fake.state.appStore = { status: 404, body: { code: "not_found", message: "Not found" } };
      const fb = project({ deps: { next: "15.0.0" }, env: "BREVO_SENDER_EMAIL=contact@exemple.fr\n" });
      r = await run(["mint", "--project-dir", fb, "--name", "repli", "--provider", "brevo"], env);
      check("la route des applications refuse : code 7, fallback dashboard-key, rien d'écrit ni d'inscrit", r.code === 7 && r.json?.fallback === "dashboard-key" && !envOf(fb, "BREVO_CLIENT_ID") && keysOf(fb).length === 0, JSON.stringify(r.json));
      fake.state.appStore = { status: 401, body: { code: "unauthorized", message: "Key not found" } };
      r = await run(["mint", "--project-dir", fb, "--name", "repli", "--provider", "brevo"], env);
      check("... un refus de la clé du compte (401) n'est pas un repli : code 1", r.code === 1 && !r.json?.fallback, JSON.stringify(r.json));
      fake.state.appStore = null;
      fake.state.appShape = "wide-scope";
      const count = fake.state.apps.size;
      r = await run(["mint", "--project-dir", fb, "--name", "large", "--provider", "brevo"], env);
      check("une application qui tient plus que l'envoi : supprimée aussitôt, code 7, rien d'écrit", r.code === 7 && fake.state.apps.size === count && !envOf(fb, "BREVO_CLIENT_ID"), JSON.stringify(r.json));
      fake.state.appShape = null;
    } finally {
      await fake.close();
    }
  }

  console.log("\n── 5. setup-email.mjs lit la clé du projet, refuse celle du compte, ne pousse aucune clé ──");
  {
    const src = readFileSync(SETUP, "utf8");
    check("plus aucun repli sur la clé du compte (readUserEnv, getSecret de la clé)", !/readUserEnv\(/.test(src) && !/getSecret\(item/.test(src));
    check("la clé est lue dans le .env du projet, et jamais poussée", /const value = envValue\(WEB_DIR, envVar\)/.test(src) && /const kvs = pushed;/.test(src) && !/RESEND_API_KEY" : "BREVO_API_KEY"\}=\$\{state\.apiKey\}/.test(src));
    check("Brevo : l'application du projet lue d'abord, plus aucun paquet installé, le mail.ts seul remplaçable (--mail-only)", /envValue\(WEB_DIR, "BREVO_CLIENT_ID"\) && envValue\(WEB_DIR, "BREVO_CLIENT_SECRET"\)/.test(src) && !/pnpm add @getbrevo\/brevo/.test(src) && /--mail-only/.test(src));
    const p = project({ deps: { next: "15.0.0", "@trpc/server": "11.0.0" }, env: `RESEND_FROM_EMAIL=onboarding@resend.dev\nRESEND_API_KEY=${ACCOUNT}\n` });
    mkdirSync(join(p, "src", "server", "api"), { recursive: true });
    writeFileSync(join(p, "src", "server", "api", "trpc.ts"), "export const rateLimitedProcedure = 1;\n");
    r = await run(["--provider", "resend", "--name", "demo", "--web-dir", p], ENV, SETUP);
    check("un projet qui tient la clé du compte : setup-email s'arrête avant d'installer quoi que ce soit", r.code !== 0 && /ACCOUNT's key/.test(r.all) && /Failed at: getApiKey/.test(r.all) && noKeyIn(r.all), r.all.slice(-600));
    writeFileSync(join(p, ".env"), "RESEND_FROM_EMAIL=onboarding@resend.dev\n");
    r = await run(["--provider", "resend", "--name", "demo", "--web-dir", p], ENV, SETUP);
    check("... un projet sans clé à lui : il dit de la faire d'abord (email-key.mjs mint)", r.code !== 0 && /email-key\.mjs mint/.test(r.all) && /Failed at: getApiKey/.test(r.all), r.all.slice(-600));
  }

  console.log("\n── 6. Ce que disent les skills ──");
  {
    const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
    const add = read("skills/add-email/SKILL.md");
    check("/add-email fait la clé du projet (Resend par l'API, Brevo par l'API, la clé faite à la main en repli puis record)", /email-key\.mjs" mint --project-dir/.test(add) && /--provider brevo/.test(add) && /Exit 7/.test(add) && /collect-env/.test(add) && /email-key\.mjs" record --project-dir/.test(add));
    check("... propose à un projet Brevo d'avant son application, sans coupure (mail.ts, déploiement suivi, puis l'ancienne variable retirée)", /holds: "legacy"/.test(add) && /--mail-only/.test(add) && /check-deploy\.mjs/.test(add) && /email-key\.mjs" retire-legacy --project-dir/.test(add));
    check("... propose de remplacer la clé du compte dans un projet qui la tient, puis de la renouveler", /email-key\.mjs" status --project-dir/.test(add) && /--replace/.test(add) && /renew the account's key/i.test(add));
    check("... et dit que la clé du compte reste au coffre, jamais dans le projet", /This is the ACCOUNT's key: it never goes into the project/.test(add) && /A project never holds the account's key/.test(add));
    const del = read("skills/delete-project/SKILL.md");
    check("/delete-project révoque la clé d'envoi du projet, et seulement elle", /email-key\.mjs" revoke --project-dir/.test(del) && /kind: "email-key"/.test(del));
    const rot = read("skills/rotate-secret/SKILL.md");
    check("/rotate-secret renouvelle la clé du projet (mint --rotate, puis revoke après le déploiement)", /mint --project-dir[^\n]*--rotate/.test(rot) && /revoke --project-dir/.test(rot));
    check("... et pour un secret Brevo qui a fuité, le renouvelle sur place (renew)", /email-key\.mjs" renew --project-dir/.test(rot));
    check("/delete-project supprime l'application Brevo du projet, et dit l'heure de sursis d'un jeton", /made: "api"/.test(del) && /lingering/.test(del));
    check("... et ne réécrit plus le coffre avec la clé d'un projet", !/`RESEND_API_KEY`→`RESEND\.api_key`/.test(rot) && !/`BREVO_API_KEY`→`BREVO\.api_key`/.test(rot));
    const rules = read("hooks/rules.mjs");
    check("le garde-fou demande avant une révocation, et les pages de sécurité le disent", /launchedBase === "email-key\.mjs"/.test(rules) && /\| `email-key\.mjs revoke` .*\| \*\*confirmation\*\* \|/.test(read("README.md")) && /\| `email-key\.mjs revoke` .*\| \*\*confirmation\*\* \|/.test(read("README.fr.md")) && /`email-key\.mjs revoke`/.test(read("SECURITY.md")) && /"\*email-key\.mjs\*": "ask"/.test(read("hooks/opencode.permission.json")));
    check("SECURITY.md dit que la clé du compte d'envoi ne va jamais dans un projet", /The email account's key is a global key that never goes into a project/.test(read("SECURITY.md").replace(/\s+/g, " ")));
    const docEn = read("skills/add-email/DOC.md");
    const docFr = read("skills/add-email/DOC.fr.md");
    check("les pages de /add-email le disent, en anglais et en français", /own sending key/i.test(docEn) && /clé d’envoi propre|clé d'envoi propre/i.test(docFr));
  }
} finally {
  server.closeAllConnections?.();
  await new Promise((ok) => server.close(() => ok()));
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
