// session.mjs - The vault's session: how long it lasts, and its real end.
//
// `bw unlock` hands back a session token. The unlock window (interactive.mjs) writes it to
// ~/.hypervibe/bw-session ("<unix_timestamp>\n<token>"), and every read that is not a window takes
// it from there: vault.mjs, and in the Enterprise harnesses bw-org.mjs and apply-bienvenue.mjs.
// TTL_SECONDS below is the ONE length of a session all of them read: 6 hours since 3.4.16 / 2.4.15
// (12 before).
//
// Until then that length was only a rule of the scripts: a read refused an older session, but
// nothing ever ran `bw lock`, so the token stayed in that file and opened the vault to any program
// of the machine until the next unlock (security audit of 23/10/2026). The session now ends for
// real, in three places, none of which ever blocks a read or an unlock:
//   1. the read that finds the session over locks it (lockSession): `bw lock`, the token handed
//      over in the environment, never on a command line, then the file removed;
//   2. the unlock schedules that lock 6 hours later in the system's own scheduler (scheduleLock),
//      replacing the one of the previous unlock: a one-time task on Windows, caught up at the
//      next sign-in when the computer was off; a launchd agent on macOS, which takes itself away
//      once it has run; systemd-run --user on Linux, else at, else nothing, and that is said;
//   3. the start of every session of Claude Code catches up a computer that was off at that time
//      (sweep, the SessionStart hook of hooks/hooks.json): an expired session is locked in the
//      background, and nothing is said when there is nothing to do.
// A lock or a schedule that fails is said, and the read returns its code as before.
//
// `bw lock` ends whatever session bw holds, the newest one included. So a lock only touches the
// session it was meant for, known by its timestamp: it reads the file again first, and gives up
// when the file holds another session (a later unlock), or when an unlock window is open right now
// (unlock-once.mjs holds its lock): that window replaces the session anyway. This is what keeps two
// unlocks close together (two scheduled routines, two sessions of Claude) from locking each other.
//
// The scheduled lock runs a copy of this file and of the two it imports, kept in
// ~/.hypervibe/vault-lock/ and refreshed at each unlock: a plugin installed from its marketplace
// lives in a folder of its version, which an update can remove before the lock is due.
//
//   node session.mjs lock --at <timestamp> [--launchd]   the scheduled lock (and the hook's)
//   node session.mjs sweep                               the SessionStart hook
//
// Recettes only: HYPERVIBE_BW_STANDIN, a stand-in (a .mjs run by node) for `bw lock`
// (`<stand-in> lock`, the session in its environment as bw would have it): a recette never runs
// the vault's tool.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useBwHome } from "./bw-home.mjs";
import { alive, lockFile, STALE_MS } from "./unlock-once.mjs";

/** How long an unlocked session lasts, in hours: the one length every reader and text uses. */
export const TTL_HOURS = 6;
export const TTL_SECONDS = TTL_HOURS * 60 * 60;
/** The scheduled lock runs this long after the end of the session: by then every reader agrees
 *  it is over (they refuse a session strictly older than TTL_SECONDS). */
export const LOCK_MARGIN_SECONDS = 60;

const HERE = dirname(fileURLToPath(import.meta.url));
/** The files the scheduled lock runs, copied out of the plugin at each unlock. */
const COPIED = ["session.mjs", "bw-home.mjs", "unlock-once.mjs"];

/** The session's file on this machine. */
export const sessionFile = (home = homedir()) => join(home, ".hypervibe", "bw-session");
/** Where the scheduled lock keeps its copy of this file and of the two it imports. */
export const lockDir = (home = homedir()) => join(home, ".hypervibe", "vault-lock");
/** The scheduled lock's name in each system's scheduler. */
export const TASK_NAME = "Hypervibe vault lock";
export const LAUNCHD_LABEL = "fr.hypervibe.vault-lock";
export const SYSTEMD_UNIT = "hypervibe-vault-lock";
const DESCRIPTION = `Locks the Hypervibe vault ${TTL_HOURS} hours after it was opened. Replaced at each unlock.`;

/** The session as its file holds it: {ts, token}, or null when there is none or it is malformed. */
export function readSessionFile(file = sessionFile()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const [first, token] = text.split(/\r?\n/);
  const ts = parseInt(first, 10);
  if (!ts || !token) return null;
  return { ts, token };
}

/**
 * Writes the session's file, readable by its owner alone (0600) outside Windows (3.4.16): a
 * session token is a key to the vault, and another account of the machine could read a file
 * left at 0644. On Windows the user's profile folder carries the rights. `mode` only applies to a
 * file being created, hence the chmod for a file an older version wrote.
 */
export function writeSessionFile(file, ts, token, { os = platform(), fsImpl = { writeFileSync, chmodSync } } = {}) {
  fsImpl.writeFileSync(file, `${ts}\n${token}`, { encoding: "utf8", mode: 0o600 });
  if (os !== "win32") fsImpl.chmodSync(file, 0o600);
}

/** Whether a session written at `ts` (seconds) is over at `now` (milliseconds). */
export function isExpired(ts, now = Date.now()) {
  return Math.floor(now / 1000) - ts > TTL_SECONDS;
}

/** Whether an unlock window is open right now: the lock of unlock-once.mjs, held by a process
 *  that still runs, for less than its own limit. */
export function unlockInProgress(file = lockFile(), now = Date.now(), isAlive = alive) {
  try {
    const [pid, at] = readFileSync(file, "utf8").split(/\r?\n/);
    const since = Date.parse(at);
    return Number.isFinite(since) && now - since <= STALE_MS && isAlive(Number(pid));
  } catch {
    return false;
  }
}

/** The `bw` this plugin installed, else the one on the PATH (the order of vault.mjs). */
export function bwCommand(home = homedir()) {
  const exe = platform() === "win32" ? "bw.exe" : "bw";
  for (const c of [join(home, ".hypervibe", "bin", exe), join(home, "bin", exe), "/opt/homebrew/bin/bw", "/usr/local/bin/bw"]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // not there
    }
  }
  return "bw";
}

/** `bw lock`, the session in its environment (BW_SESSION), never on its command line. */
export function runBwLock(token, { home = homedir(), env = process.env } = {}) {
  const childEnv = { ...env, BW_SESSION: token, BW_NOINTERACTION: "true" };
  const standIn = String(env.HYPERVIBE_BW_STANDIN ?? "").endsWith(".mjs") ? env.HYPERVIBE_BW_STANDIN : null;
  if (standIn) return spawnSync(process.execPath, [standIn, "lock"], { encoding: "utf8", env: childEnv, windowsHide: true, timeout: 20000 });
  // On Windows, the plugin's one sign-in folder (bw-home.mjs), the one vault.mjs uses.
  useBwHome({ env: childEnv, home });
  const cmd = bwCommand(home);
  const viaShell = platform() === "win32" && cmd === "bw";
  return spawnSync(cmd, ["lock"], { encoding: "utf8", env: childEnv, shell: viaShell, windowsHide: true, timeout: 20000 });
}

const firstLine = (text) =>
  String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? "";

/** One lock at a time on this machine: two SessionStart hooks (two harnesses installed), or a read
 *  and the scheduled lock at the same minute, would otherwise run two `bw lock` at once. A guard
 *  older than a minute is nobody's. Returns the release, or null when another lock runs. */
function takeLockGuard(file, now) {
  const guard = join(dirname(file), "bw-locking");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(dirname(guard), { recursive: true });
      closeSync(openSync(guard, "wx"));
      return () => rmSync(guard, { force: true });
    } catch (e) {
      if (e?.code !== "EEXIST") return () => {};
      let old = false;
      try {
        old = now - statSync(guard).mtimeMs > 60000;
      } catch {
        old = true;
      }
      if (!old) return null;
      rmSync(guard, { force: true });
    }
  }
  return null;
}

/**
 * Locks the session written at `at` (its timestamp, in seconds; any session when null), if it is
 * still the one in the file and it is over: `bw lock` with the token in its environment, then the
 * file removed. Never throws, never says the token.
 * `run`, `now`, `isAlive`, `unlockLock`: recettes only.
 * @returns {{ended: boolean, reason: string, detail?: string}} reason: "locked" | "signed-out"
 *   (no account here: the token opens nothing, its file is removed all the same) | "no-session" |
 *   "newer-session" | "not-expired" | "unlock-in-progress" | "lock-running" | "lock-failed"
 */
export function lockSession({ at = null, file = sessionFile(), home = homedir(), now = Date.now, run = runBwLock, isAlive = alive, unlockLock = lockFile(home) } = {}) {
  let release = null;
  try {
    const s = readSessionFile(file);
    if (!s) return { ended: false, reason: "no-session" };
    if (at !== null && at !== undefined && s.ts !== Number(at)) return { ended: false, reason: "newer-session" };
    if (!isExpired(s.ts, now())) return { ended: false, reason: "not-expired" };
    if (unlockInProgress(unlockLock, now(), isAlive)) return { ended: false, reason: "unlock-in-progress" };
    release = takeLockGuard(file, now());
    if (!release) return { ended: false, reason: "lock-running" };
    const r = run(s.token, { home });
    const said = `${r?.stdout ?? ""}${r?.stderr ?? ""}`.split(s.token).join("<session>");
    const signedOut = /not logged in/i.test(said);
    if (r?.status !== 0 && !signedOut) {
      return { ended: false, reason: "lock-failed", detail: firstLine(said) || (r?.error ? String(r.error.code ?? r.error.message) : `exit ${r?.status}`) };
    }
    // The file goes only if it still holds that session: a later unlock keeps its own.
    const again = readSessionFile(file);
    if (again && again.ts === s.ts && again.token === s.token) rmSync(file, { force: true });
    return { ended: true, reason: signedOut ? "signed-out" : "locked" };
  } catch (e) {
    return { ended: false, reason: "lock-failed", detail: firstLine(e?.message ?? String(e)) };
  } finally {
    if (release) release();
  }
}

/** What became of a lock, in one clause, for the message of the read that asked for it. */
export function lockOutcome(r, lang = "en") {
  const fr = lang === "fr";
  switch (r?.reason) {
    case "locked":
      return fr ? "le coffre a été verrouillé" : "the vault was locked";
    case "signed-out":
      return fr ? "aucun compte n'est connecté ici, il n'y avait rien à verrouiller" : "no account is signed in here, there was nothing to lock";
    case "newer-session":
      return fr ? "une session plus récente est en place, elle n'a pas été touchée" : "a newer session is in place, it was left alone";
    case "unlock-in-progress":
      return fr ? "une fenêtre de déverrouillage est ouverte, elle remplace la session" : "an unlock window is open, it replaces the session";
    case "lock-running":
      return fr ? "un verrouillage est déjà en cours" : "a lock is already under way";
    case "lock-failed":
      return fr
        ? `le verrouillage a échoué (${r.detail}) : la session reste ouverte jusqu'au prochain déverrouillage`
        : `locking it failed (${r.detail}): the session stays open until the next unlock`;
    default:
      return fr ? "il n'y avait rien à verrouiller" : "there was nothing to lock";
  }
}

/**
 * The SessionStart hook's check: a session that expired while the computer was off (or asleep at
 * the scheduled time) is locked in a detached process. Returns at once, whatever happens.
 * `spawnLock`, `now`: recettes only.
 * @returns {{action: "none"} | {action: "locking", ts: number}}
 */
export function sweep({ file = sessionFile(), now = Date.now, spawnLock = spawnDetachedLock } = {}) {
  const s = readSessionFile(file);
  if (!s || !isExpired(s.ts, now())) return { action: "none" };
  spawnLock(s.ts);
  return { action: "locking", ts: s.ts };
}

function spawnDetachedLock(ts) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "lock", "--at", String(ts)], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

// ─── The lock scheduled at the unlock ────────────────────────────────────────

/** The node the scheduler starts. With Homebrew, process.execPath names a versioned folder that
 *  `brew upgrade node` deletes: its stable link is taken instead (Hypervibe Brain does the same). */
function stableNode() {
  const p = process.execPath;
  const m = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(p);
  if (m) {
    for (const c of [`${m[1]}/opt/${m[2]}/bin/node`, `${m[1]}/bin/node`]) {
      try {
        if (statSync(c).isFile()) return c;
      } catch {
        // not there
      }
    }
  }
  return p;
}

/** A command run quietly: {status, stdout, stderr}; a command that is not there answers null. */
function runQuiet(cmd, args, { input } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, windowsHide: true, timeout: 60000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? ` ${r.error.code ?? r.error.message}` : ""}` };
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pad = (n) => String(n).padStart(2, "0");

/** This file and the two it imports, copied where the scheduled lock runs them. */
function copyForScheduler(home, source) {
  const dir = lockDir(home);
  mkdirSync(dir, { recursive: true });
  if (resolve(source).toLowerCase() !== resolve(dir).toLowerCase()) {
    for (const f of COPIED) copyFileSync(join(source, f), join(dir, f));
  }
  return join(dir, "session.mjs");
}

function scheduleWindows({ at, due, home, run, node, script }) {
  // wscript starts node without a console window: a task that started node itself would flash one
  // on the screen. The script is written in UTF-16 with its mark, so that a profile folder with an
  // accent (C:\Users\Prénom) reaches wscript intact. The session's timestamp is the task's own
  // argument: the script cannot disagree with the task that runs it.
  const vbs = join(lockDir(home), "lock.vbs");
  const body = `Set a = WScript.Arguments\r\nCreateObject("WScript.Shell").Run """${node}"" ""${script}"" lock --at " & a(0), 0, False\r\n`;
  writeFileSync(vbs, String.fromCharCode(0xfeff) + body, "utf16le");
  const ps = [
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psq(`//B //Nologo "${vbs}" ${Number(at)}`)}`,
    // An instant, not a time of day: the trigger carries its offset, whatever the time zone.
    `$t = New-ScheduledTaskTrigger -Once -At ([DateTimeOffset]::FromUnixTimeSeconds(${Math.floor(due.getTime() / 1000)}).LocalDateTime)`,
    // StartWhenAvailable: missed while the computer was off, it runs at the next sign-in.
    "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew",
    `Register-ScheduledTask -TaskName ${psq(TASK_NAME)} -Action $a -Trigger $t -Settings $s -Description ${psq(DESCRIPTION)} -Force | Out-Null`,
    "'scheduled'",
  ].join("; ");
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps]);
  if (r.status === 0 && /scheduled/.test(r.stdout)) return { ok: true, how: "task-scheduler" };
  return { ok: false, how: "task-scheduler", detail: firstLine(`${r.stderr}\n${r.stdout}`) || `exit ${r.status}` };
}

/** The plist of the macOS agent: it runs at the due minute, and at load (a sign-in after the Mac
 *  was off at that time); the lock it runs takes the agent away once its session is over. */
export function launchdPlist({ node, script, at, due }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>lock</string><string>--at</string><string>${Number(at)}</string><string>--launchd</string></array>
  <key>StartCalendarInterval</key><dict><key>Month</key><integer>${due.getMonth() + 1}</integer><key>Day</key><integer>${due.getDate()}</integer><key>Hour</key><integer>${due.getHours()}</integer><key>Minute</key><integer>${due.getMinutes()}</integer></dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
}

export const launchdPlistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

function scheduleMac({ at, due, home, run, node, script, uid }) {
  const plist = launchdPlistPath(home);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, launchdPlist({ node, script, at, due }), "utf8");
  run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  let r = run("launchctl", ["bootstrap", `gui/${uid}`, plist]);
  // Right after a bootout, bootstrap can refuse for a moment: the older load does the same job.
  if (r.status !== 0) r = run("launchctl", ["load", "-w", plist]);
  if (r.status === 0) return { ok: true, how: "launchd" };
  return { ok: false, how: "launchd", detail: firstLine(`${r.stderr}\n${r.stdout}`) || `exit ${r.status}` };
}

function scheduleLinux({ at, due, home, run, node, script }) {
  const command = [node, script, "lock", "--at", String(Number(at))];
  // systemd first: a transient timer of the person's own manager, gone once it has run. The one of
  // the previous unlock is stopped first: a unit name is taken until then.
  run("systemctl", ["--user", "stop", `${SYSTEMD_UNIT}.timer`]);
  run("systemctl", ["--user", "reset-failed", `${SYSTEMD_UNIT}.service`, `${SYSTEMD_UNIT}.timer`]);
  const calendar = `${due.getUTCFullYear()}-${pad(due.getUTCMonth() + 1)}-${pad(due.getUTCDate())} ${pad(due.getUTCHours())}:${pad(due.getUTCMinutes())}:${pad(due.getUTCSeconds())} UTC`;
  const s = run("systemd-run", ["--user", `--unit=${SYSTEMD_UNIT}`, `--description=${DESCRIPTION}`, `--on-calendar=${calendar}`, "--timer-property=AccuracySec=1s", "--collect", "--quiet", ...command]);
  if (s.status === 0) return { ok: true, how: "systemd-run" };
  // Else at: the job of the previous unlock is taken away first (its number kept here).
  const jobFile = join(lockDir(home), "at-job");
  let previous = "";
  try {
    previous = readFileSync(jobFile, "utf8").trim();
  } catch {
    previous = "";
  }
  if (/^\d+$/.test(previous)) run("atrm", [previous]);
  const when = `${due.getFullYear()}${pad(due.getMonth() + 1)}${pad(due.getDate())}${pad(due.getHours())}${pad(due.getMinutes())}`;
  const a = run("at", ["-t", when], { input: `${command.map(shq).join(" ")}\n` });
  if (a.status === 0) {
    const job = /job\s+(\d+)/i.exec(`${a.stderr}\n${a.stdout}`)?.[1];
    if (job) writeFileSync(jobFile, job);
    return { ok: true, how: "at" };
  }
  return { ok: false, how: null, detail: "neither systemd-run --user nor at could schedule it on this computer" };
}

/**
 * Schedules the lock of the session written at `at` (seconds), TTL_SECONDS later (plus
 * LOCK_MARGIN_SECONDS, rounded up to the minute), in this system's scheduler, replacing the one of
 * the previous unlock. Never throws: a schedule that could not be made comes back with `ok: false`
 * and why, and the unlock goes on (the read that finds the session over, and the SessionStart hook,
 * lock it all the same). `os`, `home`, `run`, `node`, `uid`, `source`: recettes only.
 * @returns {{ok: boolean, how: string|null, due: string, detail?: string}}
 */
export function scheduleLock({ at, os = platform(), home = homedir(), run = runQuiet, node = stableNode(), uid = process.getuid?.() ?? 501, source = HERE } = {}) {
  if (!Number.isInteger(Number(at)) || Number(at) <= 0) return { ok: false, how: null, due: null, detail: `not a session's timestamp: ${at}` };
  const due = new Date(Math.ceil(((Number(at) + TTL_SECONDS + LOCK_MARGIN_SECONDS) * 1000) / 60000) * 60000);
  try {
    const script = copyForScheduler(home, source);
    const how =
      os === "win32"
        ? scheduleWindows({ at, due, home, run, node, script })
        : os === "darwin"
          ? scheduleMac({ at, due, home, run, node, script, uid })
          : scheduleLinux({ at, due, home, run, node, script });
    return { ...how, due: due.toISOString() };
  } catch (e) {
    return { ok: false, how: null, due: due.toISOString(), detail: firstLine(e?.message ?? String(e)) };
  }
}

/** The macOS agent takes itself away once its session is over (or replaced): its plist first,
 *  then out of launchd, which ends this very process. */
function removeLaunchdAgent(home = homedir()) {
  rmSync(launchdPlistPath(home), { force: true });
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
}

// ─── Launched as a script, or imported ────────────────────────────────────────
// Node gives a module its real path and keeps in argv[1] the path as it was typed. Compared as
// they come, the two differ as soon as the plugin is reached through a symbolic link (macOS's
// temporary folder, a ~/.claude kept by a configuration repository): the script then did
// nothing and exited 0, "I could not" read as "nothing to report" (outside review, 3.3.9).
// Both are read to their real path. The same block in every script, held by
// scripts/tests/test-entry-point.mjs.
import { realpathSync as realPathOf } from "node:fs";
import { fileURLToPath as pathOfUrl } from "node:url";
function launchedDirectly() {
  try {
    if (!process.argv[1]) return false;
    const self = realPathOf(pathOfUrl(import.meta.url));
    const launched = realPathOf(process.argv[1]);
    return process.platform === "win32" ? self.toLowerCase() === launched.toLowerCase() : self === launched;
  } catch {
    return false;
  }
}

if (launchedDirectly()) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "sweep") {
    // The SessionStart hook: what it prints enters the session of Claude Code, so it prints only
    // when it acts. It never fails a session's start.
    try {
      const r = sweep();
      if (r.action === "locking") {
        process.stdout.write(`[Hypervibe] The vault's session was more than ${TTL_HOURS} h old: it is being locked now. The next key read opens the unlock window, as usual.\n`);
      }
    } catch {
      // silent: a check that fails must never slow down or break a session
    }
    process.exit(0);
  } else if (cmd === "lock") {
    const i = rest.indexOf("--at");
    const at = i >= 0 ? Number(rest[i + 1]) : NaN;
    if (!Number.isInteger(at) || at <= 0) {
      process.stderr.write("Usage: session.mjs lock --at <timestamp> [--launchd]\n");
      process.exit(1);
    }
    const r = lockSession({ at });
    // What the last scheduled lock did, for whoever checks it later (never a token).
    try {
      mkdirSync(lockDir(), { recursive: true });
      writeFileSync(join(lockDir(), "last-run.json"), `${JSON.stringify({ session: at, ranAt: new Date().toISOString(), ...r })}\n`);
    } catch {
      // a trace that cannot be written changes nothing
    }
    process.stdout.write(`${JSON.stringify(r)}\n`);
    // The agent stays only while its session is not over yet (a run at load, before the due
    // time) or could not be locked (it tries again at the next sign-in).
    if (rest.includes("--launchd") && !["not-expired", "lock-failed", "unlock-in-progress", "lock-running"].includes(r.reason)) {
      removeLaunchdAgent();
    }
    process.exit(0);
  } else {
    process.stderr.write("Usage: session.mjs <lock --at <timestamp> [--launchd] | sweep>\n");
    process.exit(1);
  }
}
