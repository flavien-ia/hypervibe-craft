#!/usr/bin/env node
// test-start-report-install.mjs - Recette of /start telling the training space that the installation
// succeeded (3.4.35, decision of Flavien of 23/11/2026).
//
//   - without a well-formed code, nothing is sent (exit 2);
//   - with one: a POST of {code} alone, as JSON, to the address the environment names; 200 is
//     reported (0), 400 refused (2), anything else or no answer an error (1);
//   - the skill keeps the code from its arguments without showing it, and sends it only at the
//     conclusion, when every check of Step 6 is green, never blocking the conclusion on it.
// No network: a server on 127.0.0.1 stands in for the training space.
//
//   node scripts/tests/test-start-report-install.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "start", "report-install.mjs");
const CODE = "hvi-compte-de-recette-AAAAAAAAAAAAAAAAAAAAAA";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? ` (${String(detail).slice(0, 300)})` : ""}`);
}

function run(args, url) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (url) env.HYPERVIBE_PREPARATION_URL = url;
    else delete env.HYPERVIBE_PREPARATION_URL;
    const child = spawn(process.execPath, [SCRIPT, ...args], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

/** A training space that answers `status`, and remembers what it received. */
function space(status) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, type: req.headers["content-type"], body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? '{"ok":true}' : '{"error":"x"}');
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}/api/preparation/installation`, close: () => server.close() })));
}

const silent = await space(200);
let r = await run([], silent.url);
check("no code: nothing sent, exit 2", r.code === 2 && silent.seen.length === 0, r.out);
r = await run(["--code", "pas-un-code"], silent.url);
check("a code that is not one: nothing sent, exit 2", r.code === 2 && silent.seen.length === 0, r.out);
silent.close();

const ok = await space(200);
r = await run(["--code", CODE], ok.url);
check("200: reported, exit 0", r.code === 0 && JSON.parse(r.out).result === "reported", r.out);
check("... a POST of the code alone, as JSON", ok.seen.length === 1 && ok.seen[0].method === "POST" && /application\/json/.test(ok.seen[0].type) && JSON.stringify(JSON.parse(ok.seen[0].body)) === JSON.stringify({ code: CODE }), JSON.stringify(ok.seen));
ok.close();

const refused = await space(400);
r = await run(["--code", CODE], refused.url);
check("400: refused, exit 2", r.code === 2 && JSON.parse(r.out).result === "refused", r.out);
refused.close();

const broken = await space(500);
r = await run(["--code", CODE], broken.url);
check("500: an error, exit 1", r.code === 1 && JSON.parse(r.out).result === "error", r.out);
broken.close();

r = await run(["--code", CODE], "http://127.0.0.1:9/nobody");
check("no answer: an error, exit 1", r.code === 1 && JSON.parse(r.out).result === "error", r.out);

const script = readFileSync(SCRIPT, "utf8");
check("the training space's address by default", script.includes('"https://app.hypervibe.fr/api/preparation/installation"'));

const skill = readFileSync(join(ROOT, "skills", "start", "SKILL.md"), "utf8");
const step1 = skill.slice(skill.indexOf("## Step 1"), skill.indexOf("## Step 2"));
const step10 = skill.slice(skill.indexOf("## Step 10"));
check("Step 1 keeps a code starting with hvi- as INSTALL_CODE, never shown, never asked", /INSTALL_CODE/.test(step1) && /hvi-/.test(step1) && /Never show it back, never ask for it/.test(step1));
check("Step 10 sends it only with INSTALL_CODE AND every check of Step 6 green", /INSTALL_CODE` is set AND every check of Step 6 is green/.test(step10) && step10.includes("scripts/start/report-install.mjs") && step10.indexOf("report-install.mjs") < step10.indexOf("It's ready"));
check("... never retried, never blocking the conclusion", /Never retry in a loop, never block the conclusion on it/.test(step10));

// Brevo first for the email (3.4.35, decision of 23/11/2026), Resend still offered.
const step7bis = skill.slice(skill.indexOf("## Step 7bis"), skill.indexOf("## Step 8"));
check("/start offers Brevo first (recommended), Resend for whoever prefers signing in with GitHub", step7bis.includes("**Brevo (Recommended)**") && step7bis.indexOf("**Brevo (Recommended)**") < step7bis.indexOf("**Resend**") && step7bis.includes("prefer signing in with GitHub"));
const addEmail = readFileSync(join(ROOT, "skills", "add-email", "SKILL.md"), "utf8");
check("/add-email with no key at all goes to Brevo, account first, then the key", addEmail.includes("| None | **Brevo** |") && addEmail.includes("Create one for free on **https://www.brevo.com**"));
check("... and still to Brevo when both keys are there", addEmail.includes("| Both | **Brevo** |"));

console.log(`\n${checks - failures}/${checks} checks`);
if (failures) process.exit(1);
