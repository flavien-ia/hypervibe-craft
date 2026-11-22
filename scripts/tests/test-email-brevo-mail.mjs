#!/usr/bin/env node
// test-email-brevo-mail.mjs - The mail layer a project receives to send through Brevo
// (templates/email/brevo/mail.ts, Hypervibe 3.4.34 / 2.5.13, decisions D1 and D2 of
// 22/11/2026), RUN, not read: Node takes its types away, and its calls to api.brevo.com are
// answered by the copy of Brevo's API on the loopback (fixtures/fake-brevo.mjs). It holds:
//   - nothing is read nor called when the module loads; credentials missing are said by the send;
//   - one token for many sends, its scope always named, one request at a time;
//   - a token asked again a minute before it expires, and once on a 401, never twice;
//   - the key a person made (BREVO_API_KEY) only when the application's two credentials are not
//     both there, and then without any token;
//   - neither the token nor the secret ever in an error or on the console;
//   - escapeForBrevo and the refusal of links to the development machine as they were.
// Nothing reaches Brevo nor the network.
//
//   node scripts/tests/test-email-brevo-mail.mjs

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..");
const TEMPLATE = join(SCRIPTS, "..", "templates", "email", "brevo", "mail.ts");
const WORK = mkdtempSync(join(tmpdir(), "hv-brevo-mail-"));
const { startFakeBrevo } = await import(pathToFileURL(join(SCRIPTS, "tests", "fixtures", "fake-brevo.mjs")).href);

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok || !detail ? "" : ` (${String(detail).slice(0, 400)})`}`);
}
async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

const fake = await startFakeBrevo({ senders: [{ email: "contact@monsite.fr", name: "Mon site", active: true }] });
// The application the project holds, made as the module would make it.
const made = await fetch(`${fake.url}/v3/app-store/apps`, {
  method: "POST",
  headers: { "api-key": fake.token, "content-type": "application/json" },
  body: JSON.stringify({ name: "boutique", distribution_type: "private", app_type: "oauth.m2m", auth: { type: "m2m", scopes: ["transactional.email:write"] } }),
}).then((r) => r.json());
const CLIENT_ID = made.auth.client_id;
const SECRET = made.auth.client_secret;
const DASHBOARD_KEY = fake.token;

// Every call the mail layer makes to api.brevo.com goes to the loopback; anything else is refused.
const realFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host !== "api.brevo.com") throw new Error(`a call outside Brevo: ${u.host}`);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  seen.push({ path: u.pathname, auth: headers.authorization ? "bearer" : headers["api-key"] ? "api-key" : "none" });
  return realFetch(`${fake.url}${u.pathname}${u.search}`, init);
};

// The console, captured: nothing the layer writes may carry a secret.
const printed = [];
for (const k of ["log", "info", "warn", "error", "debug"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    printed.push(a.map(String).join(" "));
    if (k === "log") orig(...a);
  };
}

const copy = join(WORK, "mail.ts");
copyFileSync(TEMPLATE, copy);
// A project of the T3 stack is an ES module, as its package.json says.
writeFileSync(join(WORK, "package.json"), JSON.stringify({ type: "module" }));
let n = 0;
/** A fresh copy of the module, its token cache empty, with this environment. */
async function layer(env) {
  for (const k of ["BREVO_CLIENT_ID", "BREVO_CLIENT_SECRET", "BREVO_API_KEY", "BREVO_SENDER_EMAIL", "BREVO_SENDER_NAME", "MAIL_ALLOW_LOCAL_LINKS"]) delete process.env[k];
  Object.assign(process.env, { BREVO_SENDER_EMAIL: "contact@monsite.fr", BREVO_SENDER_NAME: "Mon site" }, env);
  n += 1;
  return import(`${pathToFileURL(copy).href}?copie=${n}`);
}
const mail = (subject = "Bonjour") => ({ to: [{ email: "client@exemple.test" }], subject, htmlContent: "<p>Bonjour</p>", textContent: "Bonjour" });
const tokensAsked = () => fake.state.tokenCalls.length;
const sendsTried = () => seen.filter((s) => s.path === "/v3/smtp/email").length;
const reset = () => {
  seen.length = 0;
  fake.state.tokenCalls.length = 0;
  fake.state.tokenLife = 3600;
  fake.state.bearerRefused = false;
  fake.state.tokenRefused = false;
};

try {
  console.log("── Rien au chargement, l'absence dite par l'envoi ──");
  {
    reset();
    const m = await layer({});
    check("le module se charge sans identifiants et sans rien appeler", typeof m.sendMail === "function" && seen.length === 0);
    const e = await rejects(m.sendMail(mail()));
    check("sans identifiants : l'envoi dit lesquels manquent, sans rien appeler", /BREVO_CLIENT_ID and BREVO_CLIENT_SECRET are not both set/.test(e?.message ?? "") && seen.length === 0, e?.message);
    const half = await layer({ BREVO_CLIENT_ID: CLIENT_ID });
    const e2 = await rejects(half.sendMail(mail()));
    check("... et avec un seul des deux, pareil", /not both set/.test(e2?.message ?? "") && seen.length === 0, e2?.message);
  }

  console.log("\n── Un jeton pour plusieurs envois, sa portée toujours nommée ──");
  {
    reset();
    const m = await layer({ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET });
    const before = fake.state.sent.length;
    const r1 = await m.sendMail(mail("Premier"));
    const r2 = await m.sendMail(mail("Second"));
    check("deux messages partis, chacun avec son messageId", fake.state.sent.length === before + 2 && Boolean(r1?.messageId) && Boolean(r2?.messageId));
    check("un seul jeton demandé pour les deux", tokensAsked() === 1, String(tokensAsked()));
    check("... en client_credentials, avec la portée transactional.email:write", fake.state.tokenCalls.every((c) => c.grant === "client_credentials" && c.scope === "transactional.email:write" && c.clientId === CLIENT_ID));
    check("... et les envois portent le jeton, jamais une clé", seen.filter((s) => s.path === "/v3/smtp/email").every((s) => s.auth === "bearer"));
    check("l'expéditeur par défaut est celui du projet", fake.state.sent.at(-1)?.from === "contact@monsite.fr");
  }

  console.log("\n── Une seule demande de jeton à la fois ──");
  {
    reset();
    const m = await layer({ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET });
    await Promise.all([m.sendMail(mail("A")), m.sendMail(mail("B")), m.sendMail(mail("C"))]);
    check("trois envois simultanés, un seul jeton demandé", tokensAsked() === 1 && sendsTried() === 3, `${tokensAsked()} jetons, ${sendsTried()} envois`);
  }

  console.log("\n── Le jeton redemandé une minute avant son échéance ──");
  {
    reset();
    fake.state.tokenLife = 30;
    const m = await layer({ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET });
    await m.sendMail(mail("A"));
    await m.sendMail(mail("B"));
    check("un jeton de moins d'une minute n'est pas gardé : redemandé au prochain envoi", tokensAsked() === 2, String(tokensAsked()));
  }

  console.log("\n── Un 401 : un nouveau jeton, un seul nouvel essai ──");
  {
    reset();
    const m = await layer({ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET });
    await m.sendMail(mail("A"));
    fake.state.expireTokens();
    const before = fake.state.sent.length;
    await m.sendMail(mail("B"));
    check("le jeton gardé refusé par Brevo : un nouveau, et le message part", tokensAsked() === 2 && sendsTried() === 3 && fake.state.sent.length === before + 1, `${tokensAsked()} jetons, ${sendsTried()} envois`);
    reset();
    fake.state.bearerRefused = true;
    const e = await rejects(m.sendMail(mail("C")));
    check("deux 401 de suite : une erreur, jamais une boucle (deux envois tentés, un seul jeton de plus)", /Brevo refused the message \(401/.test(e?.message ?? "") && sendsTried() === 2 && tokensAsked() === 1, `${e?.message} ; ${tokensAsked()} jetons, ${sendsTried()} envois`);
    reset();
    fake.state.tokenRefused = true;
    const m2 = await layer({ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET });
    const e2 = await rejects(m2.sendMail(mail("D")));
    check("un jeton refusé : l'erreur le dit, et rien n'est envoyé", /refused the project's sending application a token \(401: Client authentication failed\)/.test(e2?.message ?? "") && sendsTried() === 0, e2?.message);
  }

  console.log("\n── La clé faite à la main, seulement sans l'application ──");
  {
    reset();
    const m = await layer({ BREVO_API_KEY: DASHBOARD_KEY });
    const before = fake.state.sent.length;
    await m.sendMail(mail("Repli"));
    check("seule BREVO_API_KEY : l'envoi passe par l'en-tête api-key, sans jeton", fake.state.sent.length === before + 1 && tokensAsked() === 0 && seen.every((s) => s.auth === "api-key"));
    reset();
    const both = await layer({ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET, BREVO_API_KEY: DASHBOARD_KEY });
    await both.sendMail(mail("Les deux"));
    check("l'application et la clé : l'application gagne, la clé n'est jamais envoyée", tokensAsked() === 1 && seen.filter((s) => s.path === "/v3/smtp/email").every((s) => s.auth === "bearer"));
  }

  console.log("\n── Un refus de Brevo dit dans ses mots ──");
  {
    reset();
    const m = await layer({ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET, BREVO_SENDER_EMAIL: "inconnu@ailleurs.test" });
    const e = await rejects(m.sendMail(mail()));
    check("un expéditeur que Brevo refuse : son message, avec le statut", /Brevo refused the message \(400 invalid_parameter: Sender is not valid\)/.test(e?.message ?? ""), e?.message);
  }

  console.log("\n── Jamais un secret dans une erreur ni sur la console ──");
  {
    const secrets = [SECRET, DASHBOARD_KEY, ...fake.state.tokens.keys()];
    const errors = [];
    reset();
    for (const env of [{ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET }, { BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: "faux" }, { BREVO_API_KEY: "xkeysib-faux" }]) {
      fake.state.bearerRefused = Boolean(env.BREVO_CLIENT_SECRET === SECRET);
      const m = await layer(env);
      const e = await rejects(m.sendMail(mail()));
      if (e) errors.push(`${e.message} ${e.stack ?? ""}`);
    }
    const all = [...secrets, ...fake.state.tokens.keys()];
    const leaked = [...errors, ...printed].filter((t) => all.some((s) => s && t.includes(s)));
    check(`trois échecs (jeton refusé à l'envoi, secret faux, clé fausse) : aucun ne porte un jeton, le secret ou une clé (${errors.length} erreurs, ${printed.length} lignes de console)`, errors.length === 3 && leaked.length === 0, leaked.join(" | "));
    const own = printed.filter((p) => !/^(OK  |FAIL|──|\n──|\d+\/\d+|\(node:\d+\) )/.test(p));
    check("le module n'écrit jamais sur la console", own.length === 0, own.join(" | "));
  }

  console.log("\n── Ce qui ne bouge pas ──");
  {
    const m = await layer({});
    check("escapeForBrevo, comme avant", m.escapeForBrevo(`<a href="x">'{{y}}'&</a>`) === "&lt;a href=&quot;x&quot;&gt;&#39;&#123;&#123;y&#125;&#125;&#39;&amp;&lt;/a&gt;", m.escapeForBrevo(`<a href="x">'{{y}}'&</a>`));
    reset();
    const ml = await layer({ BREVO_CLIENT_ID: CLIENT_ID, BREVO_CLIENT_SECRET: SECRET });
    const e = await rejects(ml.sendMail({ ...mail("Lien"), htmlContent: '<a href="http://localhost:3000/x">x</a>' }));
    check("un lien vers le poste de développement est refusé, sans rien appeler", /contains a link to localhost/.test(e?.message ?? "") && seen.length === 0, e?.message);
    await ml.sendMail({ ...mail("Visiteur"), textContent: "votre lien http://localhost:3000", allowLocalLinks: true });
    check("... sauf dans les mots d'un visiteur (allowLocalLinks)", fake.state.sent.at(-1)?.subject === "Visiteur");
  }
} finally {
  globalThis.fetch = realFetch;
  await fake.close();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
