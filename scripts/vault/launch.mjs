#!/usr/bin/env node
// launch.mjs - Cross-OS launcher for the INTERACTIVE vault operations.
//
// Opens a real terminal window running `node interactive.mjs <cmd> <flags>`, so the user
// types their master password / secret values in a genuine TTY - never in Claude's tool I/O.
// BLOCKS until the operation finishes (so the caller can then read with vault.mjs).
//
//   node launch.mjs login  [--server <url>]
//   node launch.mjs unlock
//   node launch.mjs add --name <ITEM> [--service <S>] [--fields "..."] [--folder <F>]
//   node launch.mjs collect-env --keys "KEY:secret,..." --project-dir <dir> [--target ...] [--url <url>]
//
// `add` and `collect-env` are the two destinations of the "no secret ever transits through
// the conversation" convention: a GLOBAL key reused across projects goes to the vault, a
// PROJECT secret goes to that project's .env + Vercel. Same window, same guarantee.
//
// `unlock` opens ONE window at a time (unlock-once.mjs): none when the vault is already open, and
// a second call while a window is open waits for it, then reads the session again.
//
// Design note: ALL secret logic is in interactive.mjs (cross-OS Node). This launcher only
// knows how to OPEN a window per OS - the single piece of OS-specific code in the vault layer.
//
// Recettes only: HYPERVIBE_VAULT_STANDIN, a stand-in (a .mjs run by node) for the window
// (`<stand-in> <cmd> <flags>`) and for the session's check (`<stand-in> check`, 0 when the vault
// is open): two launches are then played side by side without a window or a vault.

import { spawnSync, spawn } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, tmpdir } from "node:os";
import { resolveLang, makeT } from "./i18n.mjs";
import { OFFLINE_EXIT, OFFLINE_NOTE } from "./offline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERACTIVE = join(__dirname, "interactive.mjs");
const STANDIN = (process.env.HYPERVIBE_VAULT_STANDIN ?? "").endsWith(".mjs") ? process.env.HYPERVIBE_VAULT_STANDIN : null;

const [cmd, ...passthrough] = process.argv.slice(2);
if (!["login", "unlock", "add", "collect-env"].includes(cmd)) {
  console.error("Usage: launch.mjs <login|unlock|add|collect-env> [flags]");
  process.exit(1);
}

const os = platform();

/** Opens the window of `cmd` and resolves to its exit code once the person has closed it. */
async function openWindow() {
  if (STANDIN) {
    const r = spawnSync(process.execPath, [STANDIN, cmd, ...passthrough], { stdio: "inherit" });
    return r.status ?? 1;
  }
  if (os === "win32") {
    // Open a NEW console window running `node interactive.mjs <cmd> <flags>` and wait for it.
    // Start-Process -FilePath node creates a fresh console (a real TTY → masked input works),
    // -Wait blocks until the user finishes.
    //
    // Every element is wrapped in DOUBLE quotes inside its PowerShell single
    // quotes: Start-Process joins -ArgumentList with spaces and never quotes an
    // element itself, so a profile path with a space (C:\Users\First Last\...)
    // reached node in two pieces, node failed to find the module, and the
    // window died before anyone saw it. For those users the vault never opened
    // and /start never got past its keys (reported in July, diagnosed on 3.1.5).
    const q = (s) => `'"${String(s).replace(/"/g, '\\"').replace(/'/g, "''")}"'`;
    const argList = ["--no-deprecation", INTERACTIVE, cmd, ...passthrough].map(q).join(",");
    // CRITICAL: capture the INNER node process exit code, not PowerShell's. Plain
    // `Start-Process -Wait` makes PowerShell exit 0 as soon as it launched the window -
    // even if interactive.mjs failed (wrong password / wrong 2FA code). `-PassThru` returns
    // the process object so we can `exit $p.ExitCode` and propagate the REAL result.
    // Without this, a failed login looked like a success to the caller (bug confirmed 2026-05-31).
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        `$p = Start-Process -FilePath node -ArgumentList @(${argList}) -Wait -PassThru; exit $p.ExitCode`],
      { stdio: "inherit" }
    );
    return res.status || 0;
  }
  // macOS / Linux - UNTESTED (validate on a real machine before shipping to non-Windows users).
  // Open a terminal running the node command, then `touch` a sentinel so we can block here.
  const sentinel = join(tmpdir(), `hv-vault-${cmd}-${process.pid}.done`);
  try { if (existsSync(sentinel)) rmSync(sentinel); } catch {}
  const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const nodeCmd = ["node", "--no-deprecation", sh(INTERACTIVE), sh(cmd), ...passthrough.map(sh)].join(" ");
  // Write the inner command's EXIT CODE into the sentinel (not a bare `touch`), so a failed
  // login/unlock (wrong password or 2FA) propagates back instead of looking like a success.
  const runLine = `${nodeCmd}; echo $? > ${sh(sentinel)}`;

  // UX safety net: if the window does not open (permission denied, no emulator...), the user
  // immediately sees what to run by hand instead of waiting for the timeout.
  // These two lines are read by the USER, so they follow --lang like the window itself.
  const langFlagIdx = passthrough.indexOf("--lang");
  const t = makeT(resolveLang(langFlagIdx >= 0 ? passthrough[langFlagIdx + 1] : null));
  console.error(t("willOpen", { cmd }));
  console.error(t("ifNothingOpens", { cmd: nodeCmd }));

  if (os === "darwin") {
    // `do script` returns as soon as Terminal has started the command, so the osascript status
    // reflects whether we were ALLOWED to drive Terminal (macOS Automation permission).
    // We fail fast and clearly instead of waiting 15 min for a window that will never come.
    const osa = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(runLine)}\nend tell`;
    const r = spawnSync("osascript", ["-e", osa], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(t("osascriptFailed", { detail: r.stderr ? ": " + r.stderr.trim() : "" }));
      console.error(t("osascriptFix"));
      return 1;
    }
  } else {
    // Linux: try common emulators in order.
    const tried = [
      ["x-terminal-emulator", ["-e", "bash", "-lc", runLine]],
      ["gnome-terminal", ["--", "bash", "-lc", runLine]],
      ["konsole", ["-e", "bash", "-lc", runLine]],
      ["xterm", ["-e", "bash", "-lc", runLine]],
    ];
    let launched = false;
    for (const [bin, args] of tried) {
      const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { stdio: "ignore" });
      if (r.status === 0) { spawn(bin, args, { stdio: "ignore", detached: true }).unref(); launched = true; break; }
    }
    if (!launched) {
      console.error(t("noEmulator", { cmd: nodeCmd }));
      return 1;
    }
  }

  // Block until the sentinel appears (user finished in the window). Timeout ~15 min.
  const deadline = Date.now() + 15 * 60 * 1000;
  while (!existsSync(sentinel)) {
    if (Date.now() > deadline) { console.error(t("windowTimeout")); return 1; }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Propagate the inner exit code written into the sentinel (0 = success).
  let code = 0;
  try { code = parseInt(readFileSync(sentinel, "utf8").trim(), 10); } catch {}
  if (!Number.isInteger(code)) code = 0;
  try { rmSync(sentinel); } catch {}
  return code;
}

/** Whether the vault is open now: the very check vault.mjs makes (the session's token, accepted
 *  by bw), or the stand-in's answer in a recette. */
async function sessionOk() {
  if (STANDIN) return spawnSync(process.execPath, [STANDIN, "check"], { stdio: "ignore" }).status === 0;
  const { sessionStatus } = await import("./vault.mjs");
  return sessionStatus() === "unlocked";
}

/** Leaves with the window's code, untouched. A window closed for want of a network (OFFLINE_EXIT,
 *  offline.mjs) is also said to Claude, who reads this output: no wrong password, no new window. */
function leave(code) {
  if (code === OFFLINE_EXIT) console.error(OFFLINE_NOTE);
  process.exit(code);
}

if (cmd === "unlock") {
  const { unlockOnce } = await import("./unlock-once.mjs");
  leave(await unlockOnce({ openWindow, sessionOk, pollMs: STANDIN ? 100 : 1000 }));
}
leave(await openWindow());
