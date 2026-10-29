// _no-real-vault.mjs - Loaded into every Node process of a recette by run-all.mjs (NODE_OPTIONS
// --import): the vault's own tool (`bw`) never runs during a recette. A launch is refused, without
// reaching anything, and written down; run-all.mjs then fails the suite that did it, naming it.
//
// Why: a recette never opens the vault (the promise of SECURITY.md and of the Enterprise READMEs). Two
// recettes did, unseen, until 04/10/2026: they ran a script with the machine's own home folder, and
// that script read a key in the vault with the session of the day. It showed when the vault's tool
// started keeping its sign-in in one folder on Windows (scripts/vault/bw-home.mjs): the first run of
// the recettes took over the machine's sign-in. A recette that needs the vault plays a fake one.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const LOG = process.env.HV_RECETTE_VAULT_LOG;
const isBw = (command) => /(^|[\\/])bw(\.exe)?$/i.test(String(command ?? "").trim());
/** Where the launch came from: the first frame of the call stack outside this guard and Node. */
const caller = () =>
  (new Error().stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith("at ") && !line.includes("_no-real-vault.mjs") && !line.includes("node:")) ?? "unknown";
const refused = (command, args) => {
  if (LOG) {
    try {
      appendFileSync(LOG, `${JSON.stringify({ script: caller(), verb: (args ?? []).slice(0, 2) })}\n`);
    } catch {
      // The suite fails all the same: the refused launch answers as a failure.
    }
  }
  return { status: 1, signal: null, pid: 0, output: [null, "", ""], stdout: "", stderr: "refused: a recette never runs the vault's tool" };
};

const { spawnSync, execFileSync } = childProcess;
childProcess.spawnSync = function (command, args, options) {
  return isBw(command) ? refused(command, Array.isArray(args) ? args : []) : spawnSync.apply(this, arguments);
};
childProcess.execFileSync = function (command, args) {
  if (isBw(command)) {
    refused(command, Array.isArray(args) ? args : []);
    throw Object.assign(new Error("refused: a recette never runs the vault's tool"), { status: 1 });
  }
  return execFileSync.apply(this, arguments);
};
syncBuiltinESMExports();
