#!/usr/bin/env node
// test-clock-state.mjs - What the plugin knows of the shared clock before touching it (3.3.9).
//
// Until 3.3.8 a failed probe (network, throttling, a refusal) read as "not deployed", which could
// deploy an empty registry over an organisation's clock; every clock was written without its
// workers.dev address, so its /status and /trigger never answered; and a rotated CRON_SECRET
// never reached the clock, whose tasks then answered 401. Nothing here touches the network, the
// vault or the real clock: the probes get a fake fetch, the files live in a temporary folder.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WORKER_DIR = join(ROOT, "scripts", "shared-worker");
const lib = await import(pathToFileURL(join(WORKER_DIR, "_lib.mjs")).href);

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const answer = (status, body = {}) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const unreachable = async () => {
  throw new Error("network down");
};

// ── 1. Is the clock deployed? An unknown is never an absence ──
check("a worker the API returns is deployed", (await lib.deploymentState("t", ACCOUNT, "hypervibe-jobs", answer(200))) === "deployed");
check("a 404 is an absence", (await lib.deploymentState("t", ACCOUNT, "hypervibe-jobs", answer(404))) === "absent");
for (const status of [401, 403, 429, 500, 503]) {
  check(`a ${status} is unknown, never an absence`, (await lib.deploymentState("t", ACCOUNT, "hypervibe-jobs", answer(status))) === "unknown");
}
check("a network failure is unknown", (await lib.deploymentState("t", ACCOUNT, "hypervibe-jobs", unreachable)) === "unknown");
check(
  "no token or no account is unknown",
  (await lib.deploymentState("", ACCOUNT, "hypervibe-jobs", answer(404))) === "unknown" &&
    (await lib.deploymentState("t", null, "hypervibe-jobs", answer(404))) === "unknown",
);

// ── 2. The account's workers.dev subdomain, where the control plane answers ──
check("a registered subdomain is present", (await lib.accountSubdomain("t", ACCOUNT, answer(200, { result: { subdomain: "studio" } }))).state === "present");
check("an account without one is absent", (await lib.accountSubdomain("t", ACCOUNT, answer(200, { result: { subdomain: "" } }))).state === "absent");
check("a refusal is unknown", (await lib.accountSubdomain("t", ACCOUNT, answer(403))).state === "unknown");
check("a network failure too", (await lib.accountSubdomain("t", ACCOUNT, unreachable)).state === "unknown");
// A new account (06/10/2026): its address appears the first time its Workers page is opened, and
// until then Cloudflare may answer with a "not found" rather than an empty address.
check("a 404 is an account without one, absent", (await lib.accountSubdomain("t", ACCOUNT, answer(404, { success: false, errors: [{ code: 10007, message: "not found" }] }))).state === "absent");
check("... and so is Cloudflare's error 10007, whatever its status", (await lib.accountSubdomain("t", ACCOUNT, answer(400, { success: false, errors: [{ code: 10007 }] }))).state === "absent");
check("... while a server error stays unknown", (await lib.accountSubdomain("t", ACCOUNT, answer(500, { success: false, errors: [{ code: 10000 }] }))).state === "unknown");
check("the page that registers it: the account's Workers page in the dashboard", lib.workersDevPage(ACCOUNT) === `https://dash.cloudflare.com/${ACCOUNT}/workers-and-pages`);
{
  const ensureSrc = readFileSync(join(WORKER_DIR, "ensure.mjs"), "utf8");
  check("the dry run says whether the account has its address, and the page to open when it has not", /workersDev,/.test(ensureSrc) && /workersDevPage: workersDevPageUrl/.test(ensureSrc) && /if \(workersDev === "absent"\) workersDevPageUrl = workersDevPage\(accountId\);/.test(ensureSrc));
}

const dir = mkdtempSync(join(tmpdir(), "hv-clock-"));
try {
  // ── 3. The workers.dev setting of the clock's wrangler.toml ──
  const toml = (block) =>
    ['name = "hypervibe-jobs"', 'main = "worker.js"', `account_id = "${ACCOUNT}"`, block, "", "[triggers]", 'crons = ["* * * * *"]', ""].join("\n");
  const file = join(dir, "wrangler.toml");
  // A clock scaffolded until 3.3.8: the setting and its comment, word for word.
  writeFileSync(
    file,
    toml(
      [
        "# This worker only answers to cron triggers, never to HTTP. Without this line",
        "# wrangler assumes a workers.dev route and refuses to deploy on an account",
        "# that never registered a workers.dev subdomain.",
        "workers_dev = false",
      ].join("\n"),
    ),
  );
  check("the account a clock deploys to is read from its own file", lib.clockAccountId(dir) === ACCOUNT);
  check("a clock written until 3.3.8 does not serve its control plane", lib.servesWorkersDev(dir) === false);
  check("switching it on changes the file", lib.enableWorkersDev(dir) === true);
  const healed = readFileSync(file, "utf8");
  check("the clock then serves /status and /trigger", lib.servesWorkersDev(dir) === true && /^workers_dev = true$/m.test(healed));
  check(
    "the old comment is gone, the rest of the file untouched",
    !healed.includes("never to HTTP") && healed.includes(`account_id = "${ACCOUNT}"`) && healed.includes('crons = ["* * * * *"]'),
  );
  check("a second pass changes nothing", lib.enableWorkersDev(dir) === false);
  writeFileSync(file, toml(""));
  check("a clock whose file says nothing serves it (wrangler's default)", lib.servesWorkersDev(dir) === true);
  check(
    "a new clock is written with it, but for an account without a subdomain",
    /^workers_dev = true$/m.test(lib.workersDevBlock(true)) && /^workers_dev = false$/m.test(lib.workersDevBlock(false)),
  );

  // ── 4. A rotated CRON_SECRET reaches the clock, by the environment only ──
  writeFileSync(join(dir, "jobs.js"), 'export default {"jobs":[]};\n');
  const rotate = (value) => {
    const env = { ...process.env };
    delete env.CRON_SECRET_VALUE;
    if (value) env.CRON_SECRET_VALUE = value;
    const r = spawnSync(process.execPath, [join(WORKER_DIR, "register.mjs"), "--dir", dir, "--rotate-secret", "--project-name", "vitrine"], {
      encoding: "utf8",
      env,
    });
    try {
      return JSON.parse(String(r.stdout).trim().split("\n").pop());
    } catch {
      return { ok: false, error: `${r.stdout}${r.stderr}` };
    }
  };
  const empty = rotate("");
  check("a rotation without its value sends nothing", empty.ok === false && /CRON_SECRET_VALUE/.test(empty.error || ""), empty.error);
  const none = rotate("valeur-de-recette");
  check("a project with no task on the clock has nothing to replace there", none.ok === true && none.action === "no-job", none.error);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 5. The skills that change CRON_SECRET hand it to the clock ──
// The solo rotates it with /rotate-secret, the organisation's administrator (re)provisions it with
// /register-cron. The value goes through the environment, never an argument.
const carriers = ["rotate-secret", "register-cron"].map((s) => join(ROOT, "skills", s, "SKILL.md")).filter((p) => existsSync(p));
const handsIt = carriers.filter((p) => /CRON_SECRET_VALUE="[^"\n]*" node "[^"\n]*register\.mjs" --rotate-secret/.test(readFileSync(p, "utf8")));
check("the skill that changes CRON_SECRET puts it on the clock too", carriers.length > 0 && handsIt.length === carriers.length, carriers.map((p) => p.split(/[\\/]/).slice(-2, -1)[0]).join(", "));
const byArgument = carriers.filter((p) => readFileSync(p, "utf8").split(/\r?\n/).some((l) => l.includes("--rotate-secret") && /--rotate-secret[^\n]*--(?:value|secret)\b/.test(l)));
check("never as an argument", byArgument.length === 0);

// ── 6. ensure.mjs reads the three answers, and the organisation's never takes a clock over blind ──
const ensure = readFileSync(join(WORKER_DIR, "ensure.mjs"), "utf8");
check("ensure.mjs asks whether the clock is deployed in three answers", ensure.includes("deploymentState("));
const harness = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).name;
if (harness === "hypervibe-enterprise-admin") {
  check(
    "the administrator's refuses to scaffold over a clock it cannot see",
    ensure.includes('flags["force-takeover"]') && ensure.includes("Could not tell whether the organisation's clock is already deployed"),
  );
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) process.exit(1);
