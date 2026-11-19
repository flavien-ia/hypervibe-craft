#!/usr/bin/env node
// test-vault-offline.mjs - Without internet, the vault's window says so: it never reads a network
// that is down as a wrong master password (scripts/vault/offline.mjs, interactive.mjs, launch.mjs).
//
// On 18/11/2026, offline, Flavien typed his RIGHT master password three times and the window answered
// "Master password incorrect" three times. This recette holds, from what bw 2026.4.2 REALLY printed
// with its server out of reach (fixtures/bw-offline.json): the reading of a failure (network,
// password, no account), the server asked before anything is typed and again after a failure, a
// network that never counts as a try, the window's distinct exit code passed through by the
// launcher, and what the skills say of it. No real window opens, `bw` never runs (a stand-in plays
// it in the window's process), no request leaves the machine (local servers and a stand-in fetch).
//
//   node scripts/tests/test-vault-offline.mjs

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VAULT = join(ROOT, "scripts", "vault");
const off = await import(pathToFileURL(join(VAULT, "offline.mjs")).href);
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "scripts", "tests", "fixtures", "bw-offline.json"), "utf8"));

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}
const temps = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "hv-offline-"));
  temps.push(d);
  return d;
};
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const networkError = (code) => new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });

try {
  console.log("── Ce que bw dit, lu ──");
  {
    const failed = FIXTURE.runs.filter((r) => r.expect);
    const wrong = failed.filter((r) => off.classifyBwFailure(r) !== r.expect);
    check(`les ${failed.length} échecs réels de bw ${FIXTURE.bw} sont lus comme ils le sont (réseau, mot de passe, aucun compte)`, failed.length >= 8 && wrong.length === 0, wrong.map((r) => `${r.command} @ ${r.server}: ${off.classifyBwFailure(r)}`).join("; "));
    const offline = failed.filter((r) => r.expect === "network");
    check("... dont les connexions et déverrouillages sans serveur joignable (refusé, nom inconnu, muet)", offline.length >= 5 && ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"].every((code) => offline.some((r) => r.stderr.includes(code))));
    const refused = failed.find((r) => r.expect === "password");
    check("... et le vrai refus d'un mot de passe reste un mot de passe", refused && /Invalid master password/.test(refused.stderr) && off.classifyBwFailure(refused) === "password");
    const ok = FIXTURE.runs.filter((r) => r.succeeded && r.server !== "https://vault.bitwarden.eu");
    check("hors ligne, même un bw status qui réussit écrit l'avertissement réseau : seul un échec est lu", ok.length >= 3 && ok.every((r) => r.status === 0 && /Unable to fetch ServerConfig/.test(r.stderr)));
    check("un échec sans un mot (sortie vide) reste lu comme un mot de passe, comme avant", off.classifyBwFailure({ status: 1, stdout: "", stderr: "" }) === "password");
  }

  console.log("── Le serveur, interrogé ──");
  {
    let asked = 0;
    const probe = async (answers) => { asked += 1; return answers; };
    check("un texte de mot de passe refusé, serveur muet juste après : réseau", (await off.failureKind({ stderr: "Invalid master password." }, { probe: () => probe(false) })) === "network");
    check("... serveur qui répond : mot de passe", (await off.failureKind({ stderr: "Invalid master password." }, { probe: () => probe(true) })) === "password");
    asked = 0;
    check("un texte réseau se passe du serveur", (await off.failureKind(FIXTURE.runs.find((r) => r.expect === "network"), { probe: () => probe(true) })) === "network" && asked === 0);
  }
  {
    const server = createServer((req, res) => res.writeHead(404).end());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const up = `http://127.0.0.1:${server.address().port}`;
    check("un serveur qui répond, même par une erreur 404 : joignable", (await off.serverAnswers(up, { env: {} })) === true);
    await new Promise((r) => server.close(r));
    check("le même port, fermé : injoignable", (await off.serverAnswers(up, { env: {} })) === false);
  }
  {
    const fake = (e) => async () => { throw e; };
    check("un nom introuvable : injoignable", (await off.serverAnswers("https://x.test", { env: {}, fetchImpl: fake(networkError("ENOTFOUND")) })) === false);
    check("une connexion coupée : injoignable", (await off.serverAnswers("https://x.test", { env: {}, fetchImpl: fake(networkError("ECONNRESET")) })) === false);
    check("un certificat refusé dit qu'il y a un réseau : pas de verdict, bw décide", (await off.serverAnswers("https://x.test", { env: {}, fetchImpl: fake(networkError("SELF_SIGNED_CERT_IN_CHAIN")) })) === true);
    let called = false;
    const viaProxy = await off.serverAnswers("https://x.test", { env: { HTTPS_PROXY: "http://proxy:3128" }, fetchImpl: async () => { called = true; throw networkError("ENOTFOUND"); } });
    check("un proxy réglé : la sonde ne tranche pas (bw passe par lui, fetch non)", viaProxy === true && !called);
    const t0 = Date.now();
    const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const silent = await off.serverAnswers("https://x.test", { env: {}, timeoutMs: 300, fetchImpl: hang });
    check("un serveur muet est abandonné au bout du délai, borné", silent === false && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    check("le délai de la sonde est de quelques secondes", off.PROBE_TIMEOUT_MS >= 2000 && off.PROBE_TIMEOUT_MS <= 10000);
  }
  {
    const dir = scratch();
    const data = (obj) => { writeFileSync(join(dir, "data.json"), JSON.stringify(obj)); return off.configuredServer({ dir }); };
    check("le serveur lu dans le dossier de bw : l'UE", data({ global_environment_environment: { region: "EU", urls: {} } }) === "https://vault.bitwarden.eu");
    check("... les États-Unis", data({ global_environment_environment: { region: "US", urls: {} } }) === "https://vault.bitwarden.com");
    check("... un serveur à soi", data({ global_environment_environment: { region: "Self-hosted", urls: { base: "https://coffre.example.org/" } } }) === "https://coffre.example.org");
    check("... celui du compte connecté d'abord", data({ global_account_activeAccountId: "u1", user_u1_environment_environment: { region: "US", urls: {} }, global_environment_environment: { region: "EU", urls: {} } }) === "https://vault.bitwarden.com");
    check("... l'UE quand rien ne se lit", off.configuredServer({ dir: join(dir, "absent") }) === off.DEFAULT_SERVER && off.DEFAULT_SERVER === "https://vault.bitwarden.eu");
  }

  console.log("── Les essais de la fenêtre ──");
  {
    const play = async ({ results, probe = async () => true, signedOut }) => {
      const log = { asks: 0, refused: [] };
      let i = 0;
      let outcome;
      try {
        outcome = await off.tryAttempts({
          max: 3, server: "https://x.test", offline: "OFFLINE", signedOut, probe,
          ask: async () => { log.asks += 1; return "pwd"; },
          run: async () => results[i++] ?? { ok: false, res: { stderr: "Invalid master password." } },
          onRefused: (attempt) => log.refused.push(attempt),
        });
      } catch (e) {
        outcome = e;
      }
      return { ...log, outcome };
    };
    const refused = { ok: false, res: { stderr: "Invalid master password." } };
    const net = { ok: false, res: FIXTURE.runs.find((r) => r.expect === "network") };
    let r = await play({ results: [net] });
    check("un échec réseau au premier essai : la fenêtre se ferme, l'essai n'est pas compté, rien n'est redemandé", r.asks === 1 && r.refused.length === 0 && r.outcome?.offline === true && off.exitCodeOf(r.outcome) === off.OFFLINE_EXIT);
    r = await play({ results: [refused], probe: async () => false });
    check("un refus dont le serveur ne répond plus juste après : réseau aussi, jamais « mot de passe incorrect »", r.asks === 1 && r.refused.length === 0 && r.outcome?.offline === true);
    r = await play({ results: [refused, net] });
    check("un vrai refus puis le réseau qui tombe : un seul essai compté, puis la fermeture", r.asks === 2 && r.refused.join() === "1" && r.outcome?.offline === true);
    r = await play({ results: [refused, refused, refused] });
    check("trois vrais refus : trois essais, « mot de passe incorrect » deux fois, puis l'échec", r.asks === 3 && r.refused.join() === "1,2" && r.outcome === undefined);
    r = await play({ results: [refused, { ok: true, value: "jeton" }] });
    check("un refus puis le bon mot de passe : le coffre s'ouvre", r.asks === 2 && r.outcome === "jeton");
    r = await play({ results: [{ ok: false, res: { stderr: "You are not logged in." } }], signedOut: "NO ACCOUNT" });
    check("aucun compte : dit tel quel, sans essai de plus", r.asks === 1 && r.outcome instanceof Error && r.outcome.message === "NO ACCOUNT" && !r.outcome.offline);
    let thrown = null;
    try {
      await off.requireServer("https://x.test", "OFFLINE", { probe: async () => false });
    } catch (e) {
      thrown = e;
    }
    check("le serveur muet avant de demander quoi que ce soit : l'erreur hors ligne", thrown?.offline === true && thrown.message === "OFFLINE");
    check("le code de sortie hors ligne est à part (ni 1, ni 2 à 5 de vault.mjs, ni 130)", Number.isInteger(off.OFFLINE_EXIT) && ![0, 1, 2, 3, 4, 5, 130].includes(off.OFFLINE_EXIT) && off.exitCodeOf(new Error("x")) === 1);
  }

  console.log("── La vraie fenêtre, bw joué ──");
  {
    // In the window's own process: a stand-in for bw (the plugin's bw found in the temporary home,
    // its runs answered here and written down) and for fetch (the network up or down).
    const home = scratch();
    const bwDir = scratch();
    mkdirSync(join(home, ".hypervibe", "bin"), { recursive: true });
    writeFileSync(join(home, ".hypervibe", "bin", process.platform === "win32" ? "bw.exe" : "bw"), "");
    writeFileSync(join(bwDir, "data.json"), JSON.stringify({ global_environment_environment: { region: "EU", urls: {} } }));
    const stub = join(scratch(), "bw-et-reseau.mjs");
    writeFileSync(stub, `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const isBw = (c) => /(^|[\\\\/])bw(\\.exe)?$/i.test(String(c ?? "").trim());
const note = (line) => appendFileSync(process.env.HV_STUB_LOG, line + "\\n");
const { spawnSync } = childProcess;
childProcess.spawnSync = function (command, args) {
  if (!isBw(command)) return spawnSync.apply(this, arguments);
  const verb = (args ?? []).join(" ");
  note("bw " + verb);
  if (verb === "--version") return { status: 0, stdout: "2026.4.2", stderr: "", output: [] };
  if (verb === "status") return { status: 0, stdout: JSON.stringify({ serverUrl: "https://vault.bitwarden.eu", status: "locked", userEmail: "someone@example.com" }), stderr: "", output: [] };
  return { status: 1, stdout: "", stderr: "refused by the recette", output: [] };
};
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
  note("fetch " + url);
  if (process.env.HV_STUB_NET === "down") throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
  return new Response("", { status: 200 });
};
`);
    const window = (cmd, net) => {
      const log = join(scratch(), "log.txt");
      writeFileSync(log, "");
      const env = { ...process.env, USERPROFILE: home, HOME: home, BITWARDENCLI_APPDATA_DIR: bwDir, HV_STUB_LOG: log, HV_STUB_NET: net, NODE_OPTIONS: `--import=${pathToFileURL(stub).href}` };
      for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "BW_SESSION"]) delete env[name];
      const r = spawnSync(process.execPath, [join(VAULT, "interactive.mjs"), cmd, "--lang", "fr"], { env, input: "\n\n\n\n", encoding: "utf8", timeout: 60000, windowsHide: true });
      return { code: r.status, out: `${r.stdout}${r.stderr}`, log: readFileSync(log, "utf8") };
    };
    const fr = 'Pas de connexion internet : il en faut une pour ouvrir le coffre. Reconnecte-toi, puis relance.';
    let w = window("unlock", "down");
    check("déverrouillage hors ligne : la fenêtre sort en 8 avec le message, sans demander le mot de passe", w.code === off.OFFLINE_EXIT && w.out.includes(fr) && !w.out.includes("Mot de passe maitre") && !/incorrect/i.test(w.out), JSON.stringify({ code: w.code, out: w.out.slice(-300) }));
    check("... et sans lancer bw unlock (ni même bw status, qui attend le serveur hors ligne)", w.log.includes("fetch https://vault.bitwarden.eu") && !/bw (unlock|status)/.test(w.log), w.log);
    w = window("unlock", "up");
    check("en ligne, la même fenêtre passe la sonde et demande le mot de passe", w.log.includes("bw status") && w.out.includes("Mot de passe maitre") && w.code === 1, JSON.stringify({ code: w.code, log: w.log }));
    w = window("login", "down");
    check("connexion hors ligne : sortie 8 avant même de demander l'adresse email", w.code === off.OFFLINE_EXIT && w.out.includes(fr) && !w.out.includes("Email :") && !/bw /.test(w.log.replace(/bw --version\n/g, "")), JSON.stringify({ code: w.code, log: w.log }));
  }

  console.log("── Le lanceur rend le code tel quel ──");
  {
    const home = scratch();
    const standIn = join(scratch(), "fenetre-hors-ligne.mjs");
    writeFileSync(standIn, 'const [what] = process.argv.slice(2);\nprocess.exit(what === "check" ? 1 : 8);\n');
    const noWindow = join(scratch(), "sans-fenetre.mjs");
    const attempts = join(scratch(), "vraies-fenetres.log");
    writeFileSync(noWindow, `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
const OPENERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe", "osascript", "x-terminal-emulator", "gnome-terminal", "konsole", "xterm", "bash", "bash.exe"]);
const isOpener = (c) => OPENERS.has(basename(String(c ?? "")).toLowerCase());
const { spawnSync, spawn } = childProcess;
childProcess.spawnSync = function (c) {
  if (!isOpener(c)) return spawnSync.apply(this, arguments);
  appendFileSync(process.env.HV_NO_WINDOW_LOG, String(c) + "\\n");
  return { status: 1, signal: null, pid: 0, output: [null, "", ""], stdout: "", stderr: "refused: a real window in a recette" };
};
childProcess.spawn = function (c) {
  if (!isOpener(c)) return spawn.apply(this, arguments);
  appendFileSync(process.env.HV_NO_WINDOW_LOG, String(c) + "\\n");
  throw new Error("refused: a real window in a recette");
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, HYPERVIBE_VAULT_STANDIN: standIn, USERPROFILE: home, HOME: home, HV_NO_WINDOW_LOG: attempts, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(noWindow).href}`].filter(Boolean).join(" ") };
    const run = (cmd) => new Promise((resolve) => {
      const child = spawn(process.execPath, [join(VAULT, "launch.mjs"), cmd], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, err }));
    });
    for (const cmd of ["unlock", "login"]) {
      const r = await run(cmd);
      check(`launch.mjs ${cmd} rend le code 8 de la fenêtre, et dit à Claude de ne parler ni de mot de passe ni de rouvrir`, r.code === off.OFFLINE_EXIT && r.err.includes(off.OFFLINE_NOTE), JSON.stringify(r));
    }
    check("... et aucune vraie fenêtre n'a été tentée", !existsSync(attempts));
  }

  console.log("── Le code et les textes ──");
  {
    const win = read("scripts/vault/interactive.mjs");
    const body = (name) => win.slice(win.indexOf(`async function ${name}(`), win.indexOf("\n}\n", win.indexOf(`async function ${name}(`)));
    const unlock = body("doUnlock");
    const login = body("doLogin");
    check("doUnlock interroge le serveur avant bw status et avant le mot de passe", unlock.indexOf("requireServer(") > -1 && unlock.indexOf("requireServer(") < unlock.indexOf('bw(["status"])') && unlock.indexOf("requireServer(") < unlock.indexOf("promptMasked("));
    check("doLogin l'interroge avant l'adresse email", login.indexOf("requireServer(") > -1 && login.indexOf("requireServer(") < login.indexOf('promptVisible(t("email"))'));
    check("les deux boucles passent par tryAttempts (le réseau ne compte jamais un essai)", (unlock.match(/tryAttempts\(/g) ?? []).length === 1 && (login.match(/tryAttempts\(/g) ?? []).length === 1);
    check("doAdd interroge le serveur avant de faire taper les valeurs", body("doAdd").indexOf("requireServer(") > -1 && body("doAdd").indexOf("requireServer(") < body("doAdd").indexOf("promptMasked("));
    check("la fenêtre sort avec le code de l'erreur (8 hors ligne, 1 sinon)", /process\.exit\(exitCodeOf\(e\)\)/.test(win) && !/catch \(e\) \{\s*console\.error\([^)]*\)\);\s*await pause\(\);\s*process\.exit\(1\)/.test(win));
    const i18n = read("scripts/vault/i18n.mjs");
    const frOffline = i18n.match(/fr: \{[\s\S]*?\n {4}offline: "([^"]+)"/)?.[1] ?? "";
    check("le message français est celui demandé, sans accent comme tout le texte de cette fenêtre", frOffline === "Pas de connexion internet : il en faut une pour ouvrir le coffre. Reconnecte-toi, puis relance." && /^[\x20-\x7e]+$/.test(frOffline));
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    check("ni tiret cadratin ni demi-cadratin dans les fichiers touchés", ["scripts/vault/offline.mjs", "scripts/vault/interactive.mjs", "scripts/vault/i18n.mjs", "scripts/vault/launch.mjs"].every((f) => !dashes.test(read(f))));
  }
  {
    const skill = (name) => ["skills", name, "SKILL.md"].join("/");
    const keyring = existsSync(join(ROOT, skill("_add-keyring"))) ? skill("_add-keyring") : skill("add-keyring");
    const says8 = (text) => /(Exit|Sortie) 8 = (no internet|pas d'internet)/.test(text);
    for (const rel of [skill("_get-secret"), skill("_ensure-vault")]) {
      const text = read(rel);
      check(`${rel} : la sortie 8 veut dire pas d'internet, une phrase, on attend, jamais de mauvais mot de passe`, says8(text) && /(one sentence|une phrase)/.test(text) && /(wait|attendre)/.test(text) && /(never speak of a wrong password|parler d'un mauvais mot de passe)/.test(text) && /(in a loop|en boucle)/.test(text));
    }
    const k = read(keyring);
    check(`${keyring} : la sortie 8 de la connexion et du déverrouillage`, /8 = (no internet|pas d'internet)/.test(k) && says8(k) && (k.match(/\b8\b/g) ?? []).length >= 3);
  }
} finally {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
