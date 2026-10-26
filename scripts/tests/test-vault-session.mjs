#!/usr/bin/env node
// test-vault-session.mjs - The vault's session: 6 hours, one length for every reader, and a real
// end (3.4.16 / 2.4.15, security audit of 23/10/2026).
//
// Until then the session's limit (12 hours) was only a rule of the scripts: a read refused an older
// session, but nothing ever ran `bw lock`, and the token kept opening the vault to any program of
// the machine until the next unlock. What must hold now:
//   1. one length (TTL_SECONDS of scripts/vault/session.mjs), read by every file that reads the
//      session, and by the window's texts;
//   2. a session found over is locked for real (`bw lock`, the token in its environment, never on
//      its command line), then its file removed; never a newer session, never during an unlock,
//      never a thrown error, never the token in a message;
//   3. the unlock schedules that lock 6 hours later in the system's own scheduler (Windows task,
//      macOS launchd agent, systemd-run then at on Linux, else said), without a window, through a
//      copy kept out of the plugin that runs alone once the plugin's folder is gone (3.4.17);
//   4. the SessionStart hook catches up a computer that was off, in the background, fast, silent
//      when there is nothing to do;
//   5. the texts say 6 hours, and that the vault closes for real.
// No vault, no window, no scheduler: `bw` is a stand-in (HYPERVIBE_BW_STANDIN) in a home folder of
// the recette's own, and the schedulers are recorded, never run.
//
//   node scripts/tests/test-vault-session.mjs

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VAULT_DIR = join(ROOT, "scripts", "vault");
const SESSION = join(VAULT_DIR, "session.mjs");
const S = await import(pathToFileURL(SESSION).href);

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 500)})` : ""}`);
}

const temps = [];
const scratch = (prefix = "hv-session-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
const lire = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const NOW = Date.now();
const SECOND = 1000;
const HOUR = 3600 * SECOND;
/** A home folder of the recette's own, with a session written `ageMs` ago (none when null). */
function home(ageMs, token = "jeton-de-recette-SECRET-0042") {
  const h = scratch("hv-session-home-");
  if (ageMs !== null) {
    mkdirSync(join(h, ".hypervibe"), { recursive: true });
    writeFileSync(join(h, ".hypervibe", "bw-session"), `${Math.floor((NOW - ageMs) / 1000)}\n${token}`);
  }
  return h;
}
const sessionOf = (h) => join(h, ".hypervibe", "bw-session");

// The stand-in for `bw`: it writes down what it was given (never the token itself: whether the
// session it received is the expected one, and whether the token sat on its command line).
const STANDIN = join(scratch("hv-session-bw-"), "faux-bw.mjs");
writeFileSync(
  STANDIN,
  [
    'import { appendFileSync } from "node:fs";',
    "const expected = process.env.FAKE_BW_EXPECTED || '';",
    "const record = { argv: process.argv.slice(2), sessionOk: process.env.BW_SESSION === expected, tokenInArgs: Boolean(expected) && process.argv.some((a) => a.includes(expected)), noInteraction: process.env.BW_NOINTERACTION === 'true' };",
    "appendFileSync(process.env.FAKE_BW_LOG, JSON.stringify(record) + '\\n');",
    "const mode = process.env.FAKE_BW_MODE || 'ok';",
    "if (mode === 'fail') { process.stderr.write('boom ' + (process.env.BW_SESSION || '') + '\\n'); process.exit(1); }",
    "if (mode === 'signed-out') { process.stdout.write('You are not logged in.\\n'); process.exit(1); }",
    "process.stdout.write('Your vault is locked.\\n');",
    "",
  ].join("\n"),
);
const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** The environment of a script launched against a home folder, `bw` played by the stand-in. */
function envFor(h, { token = "jeton-de-recette-SECRET-0042", mode = "ok" } = {}) {
  const log = join(h, "faux-bw.log");
  const env = { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, "appdata"), LOCALAPPDATA: join(h, "localappdata"), HYPERVIBE_BW_STANDIN: STANDIN, FAKE_BW_LOG: log, FAKE_BW_EXPECTED: token, FAKE_BW_MODE: mode, BITWARDENCLI_APPDATA_DIR: join(h, "bw-data") };
  return { env, log };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log("── 1. Une seule durée, lue par tous ──");
  check("la session dure 6 heures, une seule constante", S.TTL_HOURS === 6 && S.TTL_SECONDS === 6 * 3600);
  {
    // Every file of the harness that names the session's file reads it through session.mjs, and
    // none carries a length of its own (the old 12 * 60 * 60 lived in four of them).
    const files = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        if (n === "node_modules" || n === ".git" || n === "tests") continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(?:mjs|js|cjs)$/.test(n)) files.push(p);
      }
    };
    walk(join(ROOT, "scripts"));
    walk(join(ROOT, "hooks"));
    const readers = files.filter((f) => f !== SESSION && /bw-session/.test(readFileSync(f, "utf8")));
    const own = readers.filter((f) => /\d+\s*\*\s*60\s*\*\s*60/.test(readFileSync(f, "utf8")) || !/from "\.\/(?:vault\/)?session\.mjs"/.test(readFileSync(f, "utf8")));
    check("chaque lecteur de la session passe par session.mjs, aucun n'a sa propre durée", readers.length >= 2 && own.length === 0, own.map((f) => relative(ROOT, f)).join(", "));
    const i18n = await import(pathToFileURL(join(VAULT_DIR, "i18n.mjs")).href);
    const fr = i18n.makeT("fr");
    const en = i18n.makeT("en");
    check("la fenêtre dit la durée de la constante, en français et en anglais", fr("unlocked").includes(`${S.TTL_HOURS}h`) && en("unlocked").includes(`${S.TTL_HOURS}h`) && !/12/.test(fr("unlocked") + en("unlocked")), `${fr("unlocked")} | ${en("unlocked")}`);
    check("... et que le coffre se referme ensuite", /referme/.test(fr("unlocked")) && /locks itself/.test(en("unlocked")));
    check("... et quand la fermeture n'a pas pu être programmée, elle le dit avec la raison", fr("lockNotScheduled", { detail: "raison" }).includes("raison") && en("lockNotScheduled", { detail: "why" }).includes("why"));
    check("le texte de la fenêtre n'écrit pas la durée lui-même", !/12h|Valable 12|Valid for 12/.test(readFileSync(join(VAULT_DIR, "i18n.mjs"), "utf8")));
  }
  {
    const ts = Math.floor(NOW / 1000);
    check("une session de 6 h tout juste n'est pas finie, une seconde de plus si", !S.isExpired(ts - 6 * 3600, ts * 1000) && S.isExpired(ts - 6 * 3600 - 1, ts * 1000));
  }

  console.log("\n── 2. Le vrai verrouillage d'une session finie ──");
  /** A runner that plays `bw lock` in memory. */
  const runner = (status = 0, said = "Your vault is locked.", effect = null) => {
    const seen = [];
    return {
      seen,
      run: (token, opts) => {
        seen.push({ token, opts });
        if (effect) effect();
        return { status, stdout: status === 0 ? said : "", stderr: status === 0 ? "" : said };
      },
    };
  };
  {
    const h = home(6 * HOUR + 10 * SECOND);
    const r0 = runner();
    const r = S.lockSession({ file: sessionOf(h), home: h, run: r0.run, unlockLock: join(h, ".hypervibe", "bw-unlock.lock") });
    check("une session finie : bw lock, avec son jeton, puis son fichier retiré", r.ended === true && r.reason === "locked" && r0.seen.length === 1 && r0.seen[0].token === "jeton-de-recette-SECRET-0042" && !existsSync(sessionOf(h)), JSON.stringify(r));
  }
  {
    const h = home(5 * HOUR);
    const r0 = runner();
    const r = S.lockSession({ file: sessionOf(h), home: h, run: r0.run });
    check("une session qui n'est pas finie n'est pas touchée", r.reason === "not-expired" && r0.seen.length === 0 && existsSync(sessionOf(h)), JSON.stringify(r));
  }
  {
    const h = home(7 * HOUR);
    const ts = Number(readFileSync(sessionOf(h), "utf8").split("\n")[0]);
    const r0 = runner();
    const r = S.lockSession({ at: ts - 3600, file: sessionOf(h), home: h, run: r0.run });
    check("le verrouillage programmé pour une autre session ne touche pas celle du fichier", r.reason === "newer-session" && r0.seen.length === 0 && existsSync(sessionOf(h)), JSON.stringify(r));
    const r2 = S.lockSession({ at: ts, file: sessionOf(h), home: h, run: r0.run });
    check("... celui de sa propre session la verrouille", r2.reason === "locked" && r0.seen.length === 1, JSON.stringify(r2));
  }
  {
    const h = home(7 * HOUR);
    const lock = join(h, ".hypervibe", "bw-unlock.lock");
    writeFileSync(lock, `${process.pid}\n${new Date(NOW).toISOString()}\n`);
    const r0 = runner();
    const r = S.lockSession({ file: sessionOf(h), home: h, run: r0.run, unlockLock: lock });
    check("une fenêtre de déverrouillage ouverte : rien n'est verrouillé (elle remplace la session)", r.reason === "unlock-in-progress" && r0.seen.length === 0 && existsSync(sessionOf(h)), JSON.stringify(r));
    writeFileSync(lock, `${process.pid}\n${new Date(NOW - 16 * 60000).toISOString()}\n`);
    const r2 = S.lockSession({ file: sessionOf(h), home: h, run: r0.run, unlockLock: lock });
    check("... une fenêtre abandonnée depuis plus de 15 minutes n'empêche plus rien", r2.reason === "locked", JSON.stringify(r2));
  }
  {
    const h = home(7 * HOUR);
    const r0 = runner(1, "boom jeton-de-recette-SECRET-0042");
    let r;
    let thrown = null;
    try {
      r = S.lockSession({ file: sessionOf(h), home: h, run: r0.run });
    } catch (e) {
      thrown = e;
    }
    check("un verrouillage raté ne lève rien, se dit, et garde le fichier (réessayé plus tard)", !thrown && r.reason === "lock-failed" && /boom/.test(r.detail) && existsSync(sessionOf(h)), JSON.stringify(r ?? thrown?.message));
    check("... sans jamais redire le jeton", !JSON.stringify(r).includes("SECRET-0042") && !S.lockOutcome(r).includes("SECRET-0042"));
  }
  {
    const h = home(7 * HOUR);
    const r = S.lockSession({ file: sessionOf(h), home: h, run: runner(1, "You are not logged in.").run });
    check("aucun compte connecté : le jeton n'ouvre rien, son fichier part quand même", r.reason === "signed-out" && r.ended === true && !existsSync(sessionOf(h)), JSON.stringify(r));
  }
  {
    // An unlock that lands while the lock runs: its new session is never removed.
    const h = home(7 * HOUR);
    const r0 = runner(0, "Your vault is locked.", () => writeFileSync(sessionOf(h), `${Math.floor(NOW / 1000)}\nnouvelle-session`));
    const r = S.lockSession({ file: sessionOf(h), home: h, run: r0.run });
    check("une session écrite pendant le verrouillage reste en place", r.reason === "locked" && existsSync(sessionOf(h)) && readFileSync(sessionOf(h), "utf8").includes("nouvelle-session"), JSON.stringify(r));
  }
  {
    const h = home(null);
    check("pas de session : rien à verrouiller", S.lockSession({ file: sessionOf(h), home: h, run: runner().run }).reason === "no-session");
  }
  {
    const h = home(7 * HOUR);
    const guard = join(h, ".hypervibe", "bw-locking");
    writeFileSync(guard, "");
    const r0 = runner();
    const r = S.lockSession({ file: sessionOf(h), home: h, run: r0.run });
    check("un verrouillage déjà en cours : pas un second bw lock en même temps", r.reason === "lock-running" && r0.seen.length === 0, JSON.stringify(r));
    const old = (NOW - 2 * 60000) / 1000;
    utimesSync(guard, old, old);
    const r2 = S.lockSession({ file: sessionOf(h), home: h, run: r0.run });
    check("... un verrou de verrouillage oublié depuis plus d'une minute n'est plus à personne", r2.reason === "locked" && !existsSync(guard), JSON.stringify(r2));
  }

  console.log("\n── 2 bis. Le fichier de session, lisible par son seul propriétaire (hors Windows) ──");
  {
    const vu = [];
    const faux = { writeFileSync: (f, data, opts) => vu.push(["write", f, data, opts]), chmodSync: (f, mode) => vu.push(["chmod", f, mode]) };
    S.writeSessionFile("/h/.hypervibe/bw-session", 1700000000, "jeton-SECRET", { os: "linux", fsImpl: faux });
    check("Linux, macOS : écrit en 0600, puis 0600 posé (un fichier d'une ancienne version aussi)", vu[0]?.[0] === "write" && vu[0][2] === "1700000000\njeton-SECRET" && vu[0][3]?.mode === 0o600 && vu[1]?.[0] === "chmod" && vu[1][2] === 0o600, JSON.stringify(vu));
    vu.length = 0;
    S.writeSessionFile("C:/h/.hypervibe/bw-session", 1700000000, "jeton-SECRET", { os: "win32", fsImpl: faux });
    check("Windows : écrit, sans chmod (les droits du profil font foi)", vu.length === 1 && vu[0][0] === "write", JSON.stringify(vu));
    const d = scratch("hv-session-0600-");
    const f = join(d, "bw-session");
    writeFileSync(f, "ancien");
    S.writeSessionFile(f, 1700000000, "jeton-SECRET");
    check("pour de vrai sur cette machine : le contenu d'une session, à la place de l'ancien", readFileSync(f, "utf8") === "1700000000\njeton-SECRET");
    if (process.platform !== "win32") check("... et en 0600, même par-dessus un fichier qui existait", (statSync(f).mode & 0o777) === 0o600, (statSync(f).mode & 0o777).toString(8));
    const fenetre = lire(join(VAULT_DIR, "interactive.mjs"));
    check("la fenêtre de déverrouillage écrit la session par writeSessionFile, et seulement ainsi", /writeSessionFile\(SESSION_FILE, ts, token\)/.test(fenetre) && !/writeFileSync\(SESSION_FILE/.test(fenetre));
  }

  console.log("\n── 3. Le verrouillage programmé au déverrouillage ──");
  const TS = 1_800_000_000;
  const DUE = Math.ceil(((TS + 6 * 3600 + 60) * 1000) / 60000) * 60000;
  /** A scheduler recorded, never run: each call answered by `answer(cmd, args)`. */
  const scheduler = (answer = () => ({ status: 0, stdout: "scheduled", stderr: "" })) => {
    const seen = [];
    return { seen, run: (cmd, args, opts = {}) => (seen.push({ cmd, args, input: opts.input ?? null }), answer(cmd, args)) };
  };
  {
    const h = home(null);
    const sch = scheduler();
    const r = S.scheduleLock({ at: TS, os: "win32", home: h, run: sch.run, node: "C:\\Program Files\\nodejs\\node.exe" });
    const ps = sch.seen.find((c) => c.cmd === "powershell.exe")?.args?.at(-1) ?? "";
    check("Windows : une tâche planifiée unique, remplacée à chaque déverrouillage", r.ok === true && r.how === "task-scheduler" && /Register-ScheduledTask -TaskName 'Hypervibe vault lock'/.test(ps) && /-Force/.test(ps) && /New-ScheduledTaskTrigger -Once/.test(ps), JSON.stringify(r));
    check("... à l'heure de fin de la session (6 h et une minute, à la minute près)", ps.includes(`FromUnixTimeSeconds(${DUE / 1000})`) && r.due === new Date(DUE).toISOString(), r.due);
    check("... rattrapée à la prochaine ouverture de session si l'heure est passée", /-StartWhenAvailable/.test(ps));
    check("... lancée par wscript, sans fenêtre, avec l'horodatage de SA session", /-Execute 'wscript\.exe'/.test(ps) && ps.includes(`lock.vbs" ${TS}'`), ps);
    const vbs = readFileSync(join(h, ".hypervibe", "vault-lock", "lock.vbs"));
    const text = vbs.subarray(2).toString("utf16le");
    check("... le lanceur, en UTF-16 avec sa marque, cache la console et passe l'horodatage reçu", vbs[0] === 0xff && vbs[1] === 0xfe && /, 0, False/.test(text) && /lock --at " & a\(0\)/.test(text) && text.includes("C:\\Program Files\\nodejs\\node.exe"), text);
    // A copy that is not there fails this check by its name, without stopping the recette.
    const inLockDir = (f) => join(h, ".hypervibe", "vault-lock", f);
    const copies = ["session.mjs", "bw-home.mjs", "unlock-once.mjs"].every((f) => existsSync(inLockDir(f)) && readFileSync(inLockDir(f)).equals(readFileSync(join(VAULT_DIR, f))));
    check("... et il lance une copie du verrouillage hors du plugin (une mise à jour peut retirer son dossier)", copies && text.includes(join(h, ".hypervibe", "vault-lock", "session.mjs")));
    const failing = scheduler(() => ({ status: 1, stdout: "", stderr: "Accès refusé" }));
    const r2 = S.scheduleLock({ at: TS, os: "win32", home: h, run: failing.run, node: "node" });
    check("... une programmation refusée ne lève rien et dit pourquoi", r2.ok === false && /Accès refusé/.test(r2.detail), JSON.stringify(r2));
  }
  {
    const h = home(null);
    const sch = scheduler(() => ({ status: 0, stdout: "", stderr: "" }));
    const r = S.scheduleLock({ at: TS, os: "darwin", home: h, run: sch.run, node: "/opt/homebrew/bin/node", uid: 501 });
    const plist = readFileSync(join(h, "Library", "LaunchAgents", "fr.hypervibe.vault-lock.plist"), "utf8");
    const due = new Date(DUE);
    check("macOS : un agent launchd, remplacé (bootout puis bootstrap)", r.ok === true && r.how === "launchd" && sch.seen[0]?.args?.[0] === "bootout" && sch.seen[1]?.args?.[0] === "bootstrap", JSON.stringify(sch.seen.map((c) => c.args)));
    check("... à la minute de fin de la session, et à l'ouverture de session (Mac éteint à l'heure)", plist.includes(`<key>Month</key><integer>${due.getMonth() + 1}</integer><key>Day</key><integer>${due.getDate()}</integer><key>Hour</key><integer>${due.getHours()}</integer><key>Minute</key><integer>${due.getMinutes()}</integer>`) && /<key>RunAtLoad<\/key><true\/>/.test(plist), plist);
    check("... qui verrouille SA session et se retire après avoir tourné", plist.includes(`<string>lock</string><string>--at</string><string>${TS}</string><string>--launchd</string>`));
    const refused = scheduler((cmd, args) => ({ status: args[0] === "bootstrap" ? 5 : 0, stdout: "", stderr: "" }));
    const r2 = S.scheduleLock({ at: TS, os: "darwin", home: h, run: refused.run, node: "node", uid: 501 });
    check("... un bootstrap refusé se rattrape par load -w", r2.ok === true && refused.seen.some((c) => c.args[0] === "load" && c.args[1] === "-w"));
  }
  {
    const h = home(null);
    const sch = scheduler(() => ({ status: 0, stdout: "", stderr: "" }));
    const r = S.scheduleLock({ at: TS, os: "linux", home: h, run: sch.run, node: "/usr/bin/node" });
    const sr = sch.seen.find((c) => c.cmd === "systemd-run");
    const due = new Date(DUE);
    const cal = `${due.getUTCFullYear()}-${String(due.getUTCMonth() + 1).padStart(2, "0")}-${String(due.getUTCDate()).padStart(2, "0")} ${String(due.getUTCHours()).padStart(2, "0")}:${String(due.getUTCMinutes()).padStart(2, "0")}:00 UTC`;
    check("Linux : systemd-run --user, le minuteur précédent arrêté d'abord", r.ok === true && r.how === "systemd-run" && sch.seen[0]?.cmd === "systemctl" && sr?.args?.includes("--user") && sr?.args?.includes(`--unit=hypervibe-vault-lock`) && sr?.args?.includes(`--on-calendar=${cal}`), JSON.stringify(sr));
    check("... qui verrouille SA session, par la copie hors du plugin", JSON.stringify(sr?.args?.slice(-5)) === JSON.stringify(["/usr/bin/node", join(h, ".hypervibe", "vault-lock", "session.mjs"), "lock", "--at", String(TS)]), JSON.stringify(sr?.args?.slice(-5)));
    const noSystemd = scheduler((cmd) => (cmd === "systemd-run" ? { status: 1, stdout: "", stderr: "Failed to connect to bus" } : cmd === "at" ? { status: 0, stdout: "", stderr: "job 17 at Thu Jan 15 10:01:00 2027" } : { status: 0, stdout: "", stderr: "" }));
    const r2 = S.scheduleLock({ at: TS, os: "linux", home: h, run: noSystemd.run, node: "/usr/bin/node" });
    const at = noSystemd.seen.find((c) => c.cmd === "at");
    check("... à défaut, at, la commande sur son entrée standard", r2.ok === true && r2.how === "at" && at?.args?.[0] === "-t" && /lock' '--at' '1800000000'/.test(at?.input ?? ""), JSON.stringify(at));
    const again = scheduler((cmd) => (cmd === "systemd-run" ? { status: 1, stdout: "", stderr: "" } : cmd === "at" ? { status: 0, stdout: "", stderr: "job 18 at ..." } : { status: 0, stdout: "", stderr: "" }));
    S.scheduleLock({ at: TS + 60, os: "linux", home: h, run: again.run, node: "/usr/bin/node" });
    check("... le travail at du déverrouillage précédent est retiré", again.seen.some((c) => c.cmd === "atrm" && c.args[0] === "17"), JSON.stringify(again.seen.map((c) => c.cmd)));
    const nothing = scheduler(() => ({ status: 1, stdout: "", stderr: "" }));
    const r3 = S.scheduleLock({ at: TS, os: "linux", home: h, run: nothing.run, node: "/usr/bin/node" });
    check("... à défaut de tout, rien, et c'est dit", r3.ok === false && /neither systemd-run --user nor at/.test(r3.detail), JSON.stringify(r3));
  }
  {
    const r = S.scheduleLock({ at: "pas-un-horodatage", os: "win32", home: home(null), run: scheduler().run });
    check("un horodatage illisible : rien de programmé, et dit", r.ok === false && /timestamp/.test(r.detail), JSON.stringify(r));
  }
  {
    const win = lire(join(VAULT_DIR, "interactive.mjs"));
    check("la fenêtre programme le verrouillage juste après avoir écrit la session, et dit un échec", win.indexOf("writeSessionFile(SESSION_FILE, ts, token)") > 0 && win.indexOf("scheduleLock({ at: ts })") > win.indexOf("writeSessionFile(SESSION_FILE, ts, token)") && /lockNotScheduled/.test(win));
  }

  console.log("\n── 4. Les lecteurs, lancés pour de vrai ──");
  const VAULT = join(VAULT_DIR, "vault.mjs");
  {
    const h = home(6 * HOUR + 30 * SECOND);
    const { env, log } = envFor(h);
    const r = spawnSync(process.execPath, [VAULT, "status"], { env, encoding: "utf8" });
    const c = calls(log);
    check("vault.mjs status, session finie : « expired », et bw lock a tourné une fois", r.stdout.trim() === "expired" && c.length === 1 && c[0].argv.join(" ") === "lock", `${r.stdout} ${JSON.stringify(c)}`);
    check("... le jeton dans son environnement, jamais sur sa ligne de commande", c[0]?.sessionOk === true && c[0]?.tokenInArgs === false && c[0]?.noInteraction === true, JSON.stringify(c));
    check("... le fichier de session est retiré", !existsSync(sessionOf(h)));
    const r2 = spawnSync(process.execPath, [VAULT, "status"], { env, encoding: "utf8" });
    check("... ensuite le coffre se dit verrouillé, sans relancer bw", r2.stdout.trim() === "locked" && calls(log).length === 1, r2.stdout);
  }
  {
    const h = home(6 * HOUR + 30 * SECOND);
    const { env } = envFor(h);
    const r = spawnSync(process.execPath, [VAULT, "get", "NEON", "api_key"], { env, encoding: "utf8" });
    check("vault.mjs get, session finie : code 3, et le message dit 6 h et le verrouillage", r.status === 3 && /expired \(>6h\): the vault was locked/.test(r.stderr), `${r.status} ${r.stderr}`);
  }
  {
    const h = home(6 * HOUR + 30 * SECOND);
    const { env } = envFor(h, { mode: "fail" });
    const r = spawnSync(process.execPath, [VAULT, "get", "NEON", "api_key"], { env, encoding: "utf8" });
    check("un bw lock qui échoue : la lecture rend son code 3 comme avant, et dit l'échec", r.status === 3 && /locking it failed \(boom/.test(r.stderr) && existsSync(sessionOf(h)), `${r.status} ${r.stderr}`);
    check("... sans redire le jeton", !r.stderr.includes("SECRET-0042"), r.stderr);
  }
  // Une session encore valide ne se lance pas ici : sa lecture appellerait le vrai bw (list items,
  // unlock --check), qu'une recette ne lance jamais (_no-real-vault.mjs l'a vu sous run-all.mjs, le
  // 23/10/2026). Son cas est tenu en mémoire, section 2 : « une session qui n'est pas finie n'est
  // pas touchée ».
  for (const [name, args] of [
    ["bw-org.mjs", ["get-secret", "Projet - recette", "RESEND_API_KEY"]],
    ["apply-bienvenue.mjs", ["--project", "recette", "--no-clone", "--no-verify"]],
  ]) {
    const script = join(ROOT, "scripts", name);
    if (!existsSync(script)) continue;
    const h = home(6 * HOUR + 30 * SECOND);
    const { env, log } = envFor(h);
    const r = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", cwd: h });
    check(`${name}, session finie : code 3, verrouillée pour de vrai, message en 6 h`, r.status === 3 && calls(log).length === 1 && !existsSync(sessionOf(h)) && /plus de 6 h/.test(r.stderr) && /verrouillé/.test(r.stderr), `${r.status} ${r.stderr.slice(0, 300)}`);
  }
  {
    const h = home(7 * HOUR);
    const ts = Number(readFileSync(sessionOf(h), "utf8").split("\n")[0]);
    const { env, log } = envFor(h);
    let r = spawnSync(process.execPath, [SESSION, "lock", "--at", String(ts - 60)], { env, encoding: "utf8" });
    check("le verrouillage programmé (session.mjs lock) d'une autre session ne fait rien", /newer-session/.test(r.stdout) && calls(log).length === 0 && existsSync(sessionOf(h)), r.stdout);
    r = spawnSync(process.execPath, [SESSION, "lock", "--at", String(ts)], { env, encoding: "utf8" });
    const last = existsSync(join(h, ".hypervibe", "vault-lock", "last-run.json")) ? readFileSync(join(h, ".hypervibe", "vault-lock", "last-run.json"), "utf8") : "";
    check("... celui de SA session la verrouille, et en garde une trace sans le jeton", /"reason":"locked"/.test(r.stdout) && calls(log).length === 1 && !existsSync(sessionOf(h)) && /"reason":"locked"/.test(last) && !last.includes("SECRET-0042"), `${r.stdout} ${last}`);
  }
  {
    // What the scheduler will run must run alone: a plugin installed from its marketplace lives in a
    // folder of its version, which an update can remove before the lock is due (3.4.17: what 3.4.16
    // does, now held by its run). A plugin folder of the recette's own is copied from this one, the
    // lock is scheduled from it, that folder is removed, then the very command the scheduler
    // recorded is launched. A task aimed at the plugin's own script, or an import that resolves in
    // the plugin but not in the copy, fails here.
    const h = home(7 * HOUR);
    const ts = Number(readFileSync(sessionOf(h), "utf8").split("\n")[0]);
    const plugin = join(scratch("hv-session-plugin-"), "scripts", "vault");
    mkdirSync(plugin, { recursive: true });
    for (const f of readdirSync(VAULT_DIR)) if (f.endsWith(".mjs")) copyFileSync(join(VAULT_DIR, f), join(plugin, f));
    const sch = scheduler(() => ({ status: 0, stdout: "", stderr: "" }));
    const made = S.scheduleLock({ at: ts, os: "linux", home: h, run: sch.run, node: process.execPath, source: plugin });
    // systemd-run's command ends with: <node> <script> lock --at <timestamp>.
    const scheduled = sch.seen.find((c) => c.cmd === "systemd-run")?.args?.slice(-4) ?? [];
    rmSync(dirname(dirname(plugin)), { recursive: true, force: true });
    const { env, log } = envFor(h);
    const r = spawnSync(process.execPath, scheduled, { env, encoding: "utf8", cwd: h });
    check("ce que le planificateur lancera se lance seul, le dossier du plugin retiré : la copie verrouille SA session", made.ok === true && scheduled.length === 4 && !existsSync(plugin) && r.status === 0 && /"reason":"locked"/.test(r.stdout) && calls(log).length === 1 && !existsSync(sessionOf(h)), `${made.ok} ${JSON.stringify(scheduled)} ${r.status} ${r.stdout} ${String(r.stderr).slice(0, 300)}`);
  }

  console.log("\n── 5. Le rattrapage au démarrage de Claude Code ──");
  {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
    const entry = (hooks.hooks?.SessionStart ?? []).flatMap((e) => (e.hooks ?? []).map((x) => ({ ...x, matcher: e.matcher })));
    const sweep = entry.find((x) => /scripts\/vault\/session\.mjs" sweep$/.test(x.command ?? ""));
    check("un crochet SessionStart lance le contrôle, sur tout démarrage, avec une limite courte", Boolean(sweep) && /\$\{CLAUDE_PLUGIN_ROOT\}/.test(sweep.command) && (sweep.matcher ?? "") === "" && (sweep.timeout ?? 60) <= 10, JSON.stringify(entry));
  }
  {
    // The work of the check itself, without Node's start: well under 100 ms.
    const quiet = home(2 * HOUR);
    const over = home(7 * HOUR);
    const spawned = [];
    let t = performance.now();
    const a = S.sweep({ file: sessionOf(quiet), spawnLock: (ts) => spawned.push(ts) });
    const quietMs = performance.now() - t;
    t = performance.now();
    const b = S.sweep({ file: sessionOf(over), spawnLock: (ts) => spawned.push(ts) });
    const overMs = performance.now() - t;
    check(`rien à faire : rien de lancé (${quietMs.toFixed(1)} ms)`, a.action === "none" && spawned.length === 1 && quietMs < 100);
    check(`une session finie : son verrouillage lancé à part, sans l'attendre (${overMs.toFixed(1)} ms)`, b.action === "locking" && spawned[0] === b.ts && overMs < 100);
  }
  {
    // For real: the hook as Claude Code runs it, then its detached lock.
    const h = home(7 * HOUR);
    const { env, log } = envFor(h);
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [SESSION, "sweep"], { env, encoding: "utf8", input: "{}" });
    const ms = performance.now() - t0;
    check(`le crochet rend la main aussitôt (processus complet : ${ms.toFixed(0)} ms), en une ligne qui le dit`, r.status === 0 && ms < 5000 && /being locked now/.test(r.stdout) && r.stdout.trim().split("\n").length === 1, `${r.status} ${r.stdout}`);
    let waited = 0;
    while (existsSync(sessionOf(h)) && waited < 15000) {
      await pause(100);
      waited += 100;
    }
    const c = calls(log);
    check("... et le verrouillage lancé à part a tourné : bw lock, le jeton dans l'environnement, le fichier retiré", c.length === 1 && c[0].argv[0] === "lock" && c[0].sessionOk === true && !existsSync(sessionOf(h)), JSON.stringify(c));
  }
  for (const [label, age] of [["sans session", null], ["une session en cours", 2 * HOUR]]) {
    const h = home(age);
    const { env, log } = envFor(h);
    const r = spawnSync(process.execPath, [SESSION, "sweep"], { env, encoding: "utf8", input: "{}" });
    await pause(300);
    check(`le crochet, ${label} : rien dit, rien lancé, code 0`, r.status === 0 && r.stdout === "" && calls(log).length === 0, `${r.status} ${r.stdout}`);
  }
  {
    // A hook that fails must never fail a session's start: a session file it cannot read.
    const h = home(null);
    mkdirSync(join(h, ".hypervibe", "bw-session"), { recursive: true });
    const r = spawnSync(process.execPath, [SESSION, "sweep"], { env: envFor(h).env, encoding: "utf8", input: "{}" });
    check("le crochet devant un fichier de session illisible : code 0, rien dit", r.status === 0 && r.stdout === "", `${r.status} ${r.stdout}`);
  }

  console.log("\n── 6. Ce que disent les textes ──");
  {
    const docs = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.md$/.test(n)) docs.push(p);
      }
    };
    walk(join(ROOT, "skills"));
    for (const f of ["README.md", "README.fr.md", "SECURITY.md"]) if (existsSync(join(ROOT, f))) docs.push(join(ROOT, f));
    const twelve = /(?:session|coffre|vault|ouvert|open|valid|valable|déverrouill|unlock)[^.]{0,80}(?:12\s?h\b|12 hours|12 heures|douze heures|twelve hours)|(?:12\s?h\b|12 hours|12 heures|douze heures|twelve hours)[^.]{0,40}(?:session|coffre|vault)|TTL 12/i;
    // Read sentence by sentence (a page wraps its lines): a sentence that tells what was true
    // before this version ("Until 3.4.16 ...") is history, not a claim.
    const history = /\b(?:until|jusqu'(?:à|a)(?: la)?)\s+(?:3\.4\.16|2\.4\.15)/i;
    const sentences = (f) => readFileSync(f, "utf8").replace(/\s+/g, " ").split(/(?<=[.!?])\s/);
    const stale = docs.filter((f) => sentences(f).some((s) => twelve.test(s) && !history.test(s)));
    check("plus aucun texte ne dit que le coffre reste ouvert 12 heures", stale.length === 0, stale.map((f) => relative(ROOT, f)).join(", "));
    const keyring = ["skills/_add-keyring/SKILL.md", "skills/add-keyring/SKILL.md"].map((f) => join(ROOT, f)).find(existsSync);
    check("la mise en place du coffre dit 6 h, et qu'il se referme tout seul", Boolean(keyring) && /6\s?h/.test(readFileSync(keyring, "utf8")) && /(?:locks itself|se referme)/.test(readFileSync(keyring, "utf8")));
    const en = lire(join(ROOT, "README.md")).replace(/\s+/g, " ");
    const frReadme = lire(join(ROOT, "README.fr.md")).replace(/\s+/g, " ");
    check("le README dit les six heures et le vrai verrouillage, en anglais et en français", /six hours/.test(en) && /(?:locks itself for real|really locked)/.test(en) && /six heures/.test(frReadme) && /(?:se referme vraiment|vraiment verrouillé)/.test(frReadme));
    if (existsSync(join(ROOT, "SECURITY.md"))) {
      const sec = lire(join(ROOT, "SECURITY.md"));
      check("SECURITY.md dit la session de 6 heures et son vrai verrouillage", /six hours/.test(sec) && /`bw lock`/.test(sec) && /scheduled/.test(sec), "");
    }
  }
} finally {
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // a detached lock may still hold its folder for a moment
    }
  }
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
