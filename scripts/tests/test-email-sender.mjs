#!/usr/bin/env node
// test-email-sender.mjs - /add-email keeps the sender a project already has (3.4.11): the plan of
// scripts/email-sender.mjs, and setup-email.mjs reading the project's own .env for it before it
// pushes anything. Reads and computes only: nothing is installed, nothing sent.
//
//   node scripts/tests/test-email-sender.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { contactRouterPlan, senderPlan } = await import(pathToFileURL(join(ROOT, "scripts", "email-sender.mjs")).href);
const { envValue } = await import(pathToFileURL(join(ROOT, "scripts", "env-value.mjs")).href);

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}

console.log("── Ce que /add-email pousse comme expéditeur ──");
let p = senderPlan({ provider: "resend", inPlace: {} });
check("Resend, aucun expéditeur : l'adresse de test de Resend est posée", JSON.stringify(p.pushed) === '["RESEND_FROM_EMAIL=onboarding@resend.dev"]' && p.kept.length === 0);
p = senderPlan({ provider: "resend", inPlace: { RESEND_FROM_EMAIL: "bonjour@atelier.fr" } });
check("Resend, un expéditeur vérifié en place : il est gardé, rien n'est poussé", p.pushed.length === 0 && JSON.stringify(p.kept) === '["RESEND_FROM_EMAIL"]', JSON.stringify(p));
p = senderPlan({ provider: "brevo", inPlace: {}, brevoSender: "contact@atelier.fr", brevoSenderName: "Atelier" });
check("Brevo, rien en place : l'expéditeur saisi et son nom sont posés", JSON.stringify(p.pushed) === '["BREVO_SENDER_EMAIL=contact@atelier.fr","BREVO_SENDER_NAME=Atelier"]');
p = senderPlan({ provider: "brevo", inPlace: { BREVO_SENDER_EMAIL: "equipe@cabinet.fr", BREVO_SENDER_NAME: "Cabinet" }, brevoSender: "autre@atelier.fr", brevoSenderName: "Autre" });
check("Brevo, l'expéditeur de l'administrateur en place : gardé, l'adresse saisie n'écrase rien", p.pushed.length === 0 && p.kept.length === 2, JSON.stringify(p));
p = senderPlan({ provider: "brevo", inPlace: { BREVO_SENDER_EMAIL: "equipe@cabinet.fr" }, brevoSender: "x@y.fr", brevoSenderName: "Atelier" });
check("Brevo, l'adresse en place sans nom : l'adresse gardée, seul le nom manquant est posé", JSON.stringify(p.pushed) === '["BREVO_SENDER_NAME=Atelier"]' && JSON.stringify(p.kept) === '["BREVO_SENDER_EMAIL"]', JSON.stringify(p));

console.log("\n── Le script lit l'expéditeur du projet avant de pousser ──");
{
  const dir = mkdtempSync(join(tmpdir(), "hv-sender-"));
  try {
    writeFileSync(join(dir, ".env"), "AUTRE=1\n");
    writeFileSync(join(dir, ".env.local"), 'RESEND_FROM_EMAIL="bonjour@atelier.fr"\n');
    check("l'expéditeur rangé dans .env.local (là où l'équipe le dépose) est lu", envValue(dir, "RESEND_FROM_EMAIL") === "bonjour@atelier.fr");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const setup = readFileSync(join(ROOT, "scripts", "setup-email.mjs"), "utf8");
check("setup-email.mjs lit les trois expéditeurs du projet par envValue", ["RESEND_FROM_EMAIL", "BREVO_SENDER_EMAIL", "BREVO_SENDER_NAME"].every((k) => setup.includes(`${k}: envValue(WEB_DIR, "${k}")`)));
check("... et ne pousse que ce que le plan dit manquer", /senderPlan\(\{ provider, inPlace: senderInPlace/.test(setup) && /\.\.\.pushed\]|const kvs = pushed;/.test(setup) && !/kvs\.push\(`RESEND_FROM_EMAIL=onboarding@resend\.dev`\)/.test(setup));
check("... et ne réclame l'adresse Brevo que si le projet n'en a pas", /if \(provider === "brevo" && !senderInPlace\.BREVO_SENDER_EMAIL(?: && !contactRouterOnly)?\)/.test(setup));

console.log("\n── Le routeur de contact n'est écrit que s'il est voulu et s'il compile (3.4.13) ──");
const AVEC = "export const rateLimitedProcedure = t.procedure;";
let plan = contactRouterPlan({ skip: true, trpc: AVEC });
check("--no-contact-router : ni écrit ni enregistré, et c'est dit", plan.write === false && plan.reason === "asked", JSON.stringify(plan));
plan = contactRouterPlan({ trpc: "export const publicProcedure = t.procedure;" });
check("sans rateLimitedProcedure : pas écrit (il casserait la compilation)", plan.write === false && plan.reason === "no-rate-limit", JSON.stringify(plan));
plan = contactRouterPlan({ trpc: null });
check("sans trpc.ts : pas écrit", plan.write === false && plan.reason === "no-trpc", JSON.stringify(plan));
plan = contactRouterPlan({ trpc: AVEC });
check("avec rateLimitedProcedure : écrit", plan.write === true, JSON.stringify(plan));
plan = contactRouterPlan({ only: true, skip: true, trpc: AVEC });
check("--contact-router-only l'emporte : c'est tout ce qu'on lui demande", plan.write === true, JSON.stringify(plan));
check("setup-email.mjs n'écrit ni n'enregistre le routeur sans le feu vert du plan", /if \(ROUTER\.write\) \{\s*await step\("writeContactRouter", writeContactRouter\);\s*await step\("registerRouter", registerRouter\);\s*\}/.test(setup) && /contactRouterPlan\(\{\s*skip: noContactRouter,\s*only: contactRouterOnly,/.test(setup));
check("... et dit dans sa dernière ligne ce qu'il en a fait", /contactRouter: ROUTER\.write \? "written" : `skipped:\$\{ROUTER\.reason\}`/.test(setup));

{
  // Un projet de test : le routeur de contact seul, demandé après coup par la page de contact.
  const dir = mkdtempSync(join(tmpdir(), "hv-routeur-"));
  const projet = (trpc) => {
    mkdirSync(join(dir, "src", "server", "api", "routers"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { next: "15.0.0", "@trpc/server": "11.0.0" } }));
    writeFileSync(join(dir, "src", "server", "api", "trpc.ts"), trpc);
    writeFileSync(join(dir, "src", "server", "api", "root.ts"), 'import { createTRPCRouter } from "~/server/api/trpc";\n\nexport const appRouter = createTRPCRouter({\n  post: postRouter,\n});\n');
    writeFileSync(join(dir, "src", "server", "mail.ts"), "export async function sendMail() {}\n");
  };
  const lancer = () => spawnSync(process.execPath, [join(ROOT, "scripts", "setup-email.mjs"), "--provider", "brevo", "--name", "demo", "--web-dir", dir, "--contact-router-only"], { encoding: "utf8", windowsHide: true });
  try {
    projet(AVEC);
    let r = lancer();
    const routeur = join(dir, "src", "server", "api", "routers", "contact.ts");
    check("--contact-router-only : le routeur écrit, sans rien installer ni lire au coffre", r.status === 0 && existsSync(routeur) && /"contactRouter":"written"/.test(r.stdout), `${r.status} ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
    check("... et enregistré dans root.ts", readFileSync(join(dir, "src", "server", "api", "root.ts"), "utf8").includes("contact: contactRouter"));
    r = lancer();
    check("... relancé : rien n'est écrasé, rien n'est enregistré deux fois", r.status === 0 && readFileSync(join(dir, "src", "server", "api", "root.ts"), "utf8").split("contactRouter,").length === 2, `${r.status} ${r.stderr.slice(-300)}`);
    rmSync(dir, { recursive: true, force: true });
    projet("export const publicProcedure = t.procedure;");
    r = lancer();
    check("--contact-router-only sans rateLimitedProcedure : refusé, et rien n'est écrit", r.status !== 0 && !existsSync(routeur) && /rateLimitedProcedure/.test(`${r.stdout}${r.stderr}`), `${r.status} ${r.stderr.slice(-300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
