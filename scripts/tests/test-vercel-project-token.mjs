#!/usr/bin/env node
// test-vercel-project-token.mjs - Recette : la cle Vercel que /add-collab pose dans les secrets du
// depot est limitee au projet, verifiee avant d'etre posee, et jamais prise dans le coffre global.
//
// Jusqu'en 3.4.21, _setup-github-deploy faisait creer une cle a l'echelle du compte, la rangeait
// dans l'element VERCEL du coffre (en ecrasant la cle globale de la personne) et la posait en
// secret GitHub VERCEL_TOKEN. Toute personne qui peut ecrire dans le depot lit ce secret en
// modifiant un workflow : inviter un collaborateur lui donnait tous les projets Vercel du compte.
//
// Deux parties :
//   1. le script de verification (scripts/vercel/check-project-token.mjs), joue contre un faux
//      Vercel sur 127.0.0.1 : cle limitee, cle de compte, cle d'equipe, cle refusee, Vercel muet,
//      compte personnel (pas de teamId), cle jamais affichee ni prise en argument ;
//   2. le texte des skills (_setup-github-deploy, add-collab, leurs pages), qui disent le geste.
//
// Aucun vrai compte, aucun coffre, aucun reseau hors de la boucle locale.
//
//   node scripts/tests/test-vercel-project-token.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "vercel", "check-project-token.mjs");
const lire = (...p) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}

// Construite en deux morceaux : une fausse clé d’un seul tenant ferait sonner gitleaks au commit du miroir.
const KEY = ["vcp", "cle-de-recette-0123456789"].join("_");
const PROJECT = "prj_MIEN";
const TEAM = "team_EQUIPE";

// ─── Le faux Vercel ─────────────────────────────────────────────────────────
// `mode` decrit ce que voit la cle :
//   limitee   : son projet seul, 404 sur /v2/user, 403 sur /v2/teams/<id> (mesure du 02/11/2026)
//   compte    : tous les projets, /v2/user 200
//   equipe1   : une equipe qui ne porte que ce projet, /v2/teams/<id> 200, /v2/user 404
//   compte1   : un seul projet liste, mais /v2/user 200
//   page      : son projet seul sur la page, mais une page suivante annoncee
//   refusee   : 403 partout
//   autre     : une cle limitee a un AUTRE projet (404 sur le sien)
//   panne     : 500 partout
//   liste403  : son projet 200, mais la liste refusee
let mode = "limitee";
let calls = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  calls.push({ path: url.pathname, teamId: url.searchParams.get("teamId"), auth: req.headers.authorization ?? null });
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { message: "unauthorized" } });
  if (mode === "panne") return send(500, { error: { message: "boom" } });
  if (mode === "refusee") return send(403, { error: { message: "forbidden" } });
  const mine = { id: PROJECT, name: "mon-site", accountId: TEAM };
  if (mode === "mauvais-id" && url.pathname === `/v9/projects/${PROJECT}`) return send(200, { id: "prj_AUTRE", name: "autre-site" });
  const autres = [{ id: "prj_AUTRE", name: "autre-site" }, { id: "prj_TROIS", name: "troisieme" }];
  if (url.pathname === `/v9/projects/${PROJECT}`) return mode === "autre" ? send(404, { error: { message: "not found" } }) : send(200, mine);
  if (url.pathname === "/v9/projects") {
    if (mode === "liste403") return send(403, { error: { message: "forbidden" } });
    if (mode === "compte") return send(200, { projects: [mine, ...autres], pagination: { next: null } });
    if (mode === "page") return send(200, { projects: [mine], pagination: { next: 12345 } });
    return send(200, { projects: [mine], pagination: { next: null } });
  }
  if (url.pathname === "/v2/user") return ["compte", "compte1"].includes(mode) ? send(200, { user: { id: "user_1" } }) : send(404, { error: { message: "not found" } });
  if (url.pathname.startsWith("/v2/teams/")) return mode === "equipe1" ? send(200, { id: TEAM }) : send(403, { error: { message: "forbidden" } });
  return send(404, { error: { message: "not found" } });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const API = `http://127.0.0.1:${server.address().port}`;

const box = mkdtempSync(join(tmpdir(), "hv-vercel-token-"));
function projet(orgId, projectId = PROJECT) {
  const dir = mkdtempSync(join(box, "p-"));
  mkdirSync(join(dir, ".vercel"));
  writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ orgId, projectId }));
  return dir;
}
const EQUIPE = projet(TEAM);
const PERSO = projet("user_PERSO");

/** Lance le script, la cle sur l'entree standard. { code, out, err, json } */
function lancer(args, stdin, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HYPERVIBE_VERCEL_API: API, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(out.trim().split("\n").pop());
      } catch {
        /* not JSON */
      }
      done({ code, out, err, json });
    });
    child.stdin.end(stdin);
  });
}

async function scenario(nom, m, dir, attendu, codeAttendu, extra = () => true) {
  mode = m;
  calls = [];
  const r = await lancer(["--project-dir", dir], KEY);
  check(`${nom} : verdict ${attendu}, code ${codeAttendu}`, r.json?.verdict === attendu && r.code === codeAttendu, `${r.code} ${r.out.trim()} ${r.err.trim()}`);
  check(`${nom} : la cle n'apparait jamais dans la sortie`, !`${r.out}${r.err}`.includes(KEY));
  if (!extra(r)) check(`${nom} : condition propre au cas`, false, JSON.stringify(calls));
  return r;
}

console.log("── Le script de verification, contre un faux Vercel ──");
await scenario("une cle limitee au projet", "limitee", EQUIPE, "limitee", 0, (r) => r.json?.ok === true);
check("... l'equipe est passee en teamId sur le projet et la liste", calls.filter((c) => c.path.startsWith("/v9/")).every((c) => c.teamId === TEAM));
check("... la cle voyage en en-tete, jamais dans l'adresse", calls.every((c) => c.auth === `Bearer ${KEY}`));
check("... l'equipe elle-meme est interrogee (une cle d'equipe se trahit la)", calls.some((c) => c.path === `/v2/teams/${TEAM}`));
await scenario("une cle de compte (tous les projets)", "compte", EQUIPE, "trop-large", 2, (r) => r.json?.otherProjects === 2 && r.json?.ok === false);
await scenario("une cle d'equipe dont l'equipe ne porte que ce projet", "equipe1", EQUIPE, "trop-large", 2);
await scenario("une cle de compte qui ne liste qu'un projet", "compte1", EQUIPE, "trop-large", 2);
await scenario("une liste qui annonce une page suivante", "page", EQUIPE, "trop-large", 2);
await scenario("une cle refusee", "refusee", EQUIPE, "invalide", 3);
await scenario("une cle limitee a un autre projet", "autre", EQUIPE, "invalide", 3);
await scenario("Vercel en panne", "panne", EQUIPE, "injoignable", 4);
await scenario("un projet rendu sous un autre identifiant", "mauvais-id", EQUIPE, "invalide", 3);
await scenario("une liste refusee ne prouve rien", "liste403", EQUIPE, "indeterminee", 5);
await scenario("un projet de compte personnel (ancien compte)", "limitee", PERSO, "limitee", 0);
check("... aucun teamId n'est envoye pour un orgId de compte personnel", calls.every((c) => c.teamId === null) && !calls.some((c) => c.path.startsWith("/v2/teams/")));

{
  mode = "limitee";
  calls = [];
  const r = await lancer(["--project-dir", EQUIPE], "   \n");
  check("rien sur l'entree standard : absente, code 6, aucune requete", r.json?.verdict === "absente" && r.code === 6 && calls.length === 0, r.out);
}
{
  calls = [];
  const r = await lancer(["--project-dir", EQUIPE, "--token", KEY], "");
  check("une cle donnee en argument est refusee, sans requete et sans la recopier", r.code === 1 && calls.length === 0 && !r.out.includes(KEY), r.out);
  const r2 = await lancer(["--project-dir", EQUIPE, KEY], "");
  check("une cle donnee comme argument nu n'est jamais recopiee dans la reponse", r2.code === 1 && !r2.out.includes(KEY), r2.out);
}
{
  const vide = mkdtempSync(join(box, "vide-"));
  const r = await lancer(["--project-dir", vide], KEY);
  check("un dossier sans projet Vercel lie : code 1", r.code === 1 && r.json?.verdict === "usage", r.out);
}
{
  // Sans lancer de requete vers le vrai Vercel : la regle d'adresse est celle du script, lue ici.
  const { vercelApiBase } = await import("../_vercel-projects.mjs");
  const src = readFileSync(SCRIPT, "utf8");
  check(
    "l'adresse d'API ne vient que de la regle de boucle locale (jamais la cle vers un autre hote)",
    src.includes('import { vercelApiBase } from "../_vercel-projects.mjs"') && !/HYPERVIBE_VERCEL_API/.test(src.replace(/^\/\/.*$/gm, "")) &&
      /const base = vercelApiBase\(\);/.test(src) &&
      vercelApiBase({ HYPERVIBE_VERCEL_API: "http://exemple.invalid" }) === "https://api.vercel.com",
  );
}
server.close();
rmSync(box, { recursive: true, force: true });

// ─── Le texte des skills ────────────────────────────────────────────────────
console.log("\n── _setup-github-deploy ──");
const setup = lire("skills", "_setup-github-deploy", "SKILL.md");
const blocsBash = (t) => [...t.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const blocs = (t) =>[...t.matchAll(/```(?:bash|yaml)\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
const SETUP = {
  "ne lit jamais l'element VERCEL global du coffre": (t) => !/vault\.mjs"?\s+get\s+VERCEL\s/.test(blocs(t)),
  "n'ecrit jamais l'element VERCEL global du coffre": (t) => !/--name\s+"?VERCEL"?\s/.test(blocs(t)),
  "range la cle dans un element propre au projet": (t) => /--name\s+"?<PROJECT>_VERCEL_GH"?/.test(t) && /vault\.mjs"?\s+get\s+"?<PROJECT>_VERCEL_GH"?\s+api_token/.test(t),
  "fait creer une cle limitee au projet dans le tableau de bord": (t) => /1\. Open https:\/\/vercel\.com\/account\/settings\/tokens\n/.test(t) && /\*\*Scope\*\*[^\n]*\*\*this project only\*\*/.test(t) && /vcp_/.test(t) && /Vercel refuses? to create a (?:key|token) from the CLI/i.test(t),
  "verifie la cle avant de la poser, et refuse si elle n'est pas limitee": (t) => {
    const v = t.indexOf("check-project-token.mjs");
    const pose = t.indexOf("gh secret set VERCEL_TOKEN");
    return v > 0 && pose > v && /"verdict":\s*"limitee"|verdict.{0,40}limitee/.test(t.slice(v, pose));
  },
  "la commande qui pose la cle la reverifie d'abord, et s'arrete si elle n'est pas limitee": (t) => {
    const bloc = [...t.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes("gh secret set VERCEL_TOKEN"));
    if (!bloc) return false;
    const v = bloc.indexOf("check-project-token.mjs");
    return v > 0 && v < bloc.indexOf("| gh secret set VERCEL_TOKEN") && /check-project-token\.mjs" --project-dir \. >\/dev\/null \\\n\s*\|\| \{[^}]*exit 1; \}/.test(bloc);
  },
  "la cle passe par l'entree standard, garde-fou du coffre ferme conserve": (t) =>
    /printf '%s' "\$VTOK" \| node "[^"]*check-project-token\.mjs"/.test(t) && /printf '%s' "\$VTOK" \| gh secret set VERCEL_TOKEN/.test(t) &&
    // Chaque commande qui verifie ou pose la cle s'arrete d'abord sur un coffre ferme.
    blocsBash(t).filter((b) => /check-project-token\.mjs|gh secret set VERCEL_TOKEN/.test(b)).every((b) => /api_token\) && \[ -n "\$VTOK" \] \\\n\s*\|\| \{[^}]*exit 1; \}/.test(b)),
  // Une version fixee, jamais un plancher : le travail detient la cle, il ne doit pas installer la
  // derniere CLI publiee (remarque de Bastien du 03/11/2026 sur la 3.4.22). 65 au moins : la 59 echoue.
  "le workflow fixe la CLI Vercel a une version exacte, 65 ou plus": (t) => {
    const installs = [...t.matchAll(/run: npm install -g (.+)/g)].map((m) => m[1].trim());
    return installs.length === 2 && installs.every((i) => /^vercel@(\d+)\.\d+\.\d+$/.test(i) && Number(i.match(/^vercel@(\d+)/)[1]) >= 65);
  },
};
for (const [name, rule] of Object.entries(SETUP)) check(name, rule(setup));

console.log("\n── /add-collab ──");
const collab = lire("skills", "add-collab", "SKILL.md");
const COLLAB = {
  "a chaque passage, la cle du projet est verifiee avant toute invitation": (t) => {
    const v = t.indexOf("check-project-token.mjs");
    return v > 0 && v < t.indexOf("## Step 2") && /<PROJECT>_VERCEL_GH/.test(t.slice(0, t.indexOf("## Step 2")));
  },
  "un projet equipe avant la 3.4.22 (pas d'element propre) est signale, et le remplacement propose": (t) => /before 3\.4\.22/.test(t) && /exit code 4|exits? 4/i.test(t),
  "la cle VERCEL globale n'est jamais supprimee": (t) => /never delete(?:s)? (?:the|it|this)[^.]*VERCEL|VERCEL[^.]*never (?:be )?delete/i.test(t) && !/vault\.mjs"?\s+delete\s+VERCEL/.test(t),
  "rappelle de supprimer l'ancienne cle sur la page des cles Vercel": (t) => /before 3\.4\.22[^\n]*delete the old (?:key|token)/i.test(t) && /trop-large[^\n]*delete the old (?:key|token)/i.test(t) && /vercel\.com\/account\/settings\/tokens/.test(t),
  "previent de la branche principale non protegeable sur un compte gratuit": (t) => /Upgrade to GitHub Pro/.test(t) && /branch/i.test(t) && /pull request/i.test(t),
  // Sensitive ne protège pas d'un collaborateur qui pousse du code : ne jamais promettre l'inverse.
  "rappelle que toutes les variables du projet restent lisibles, Sensitive compris": (t) => /every variable of (?:this|THIS) project, Sensitive ones included/i.test(t) && !/except those marked \**Sensitive/i.test(t),
  "ne refuse pas la gestion si la personne decline, mais n'invite pas sans l'avoir prevenue": (t) => /not \**(?:block|stop)/i.test(t) && /never invite/i.test(t),
};
for (const [name, rule] of Object.entries(COLLAB)) check(name, rule(collab));

console.log("\n── Les pages de /add-collab ──");
const docEn = lire("skills", "add-collab", "DOC.md");
const docFr = lire("skills", "add-collab", "DOC.fr.md");
check("DOC.md dit la cle limitee au projet", /limited to (?:this|the) project/i.test(docEn) && /GitHub Pro/.test(docEn));
check("DOC.fr.md dit la cle limitee au projet", /limitée (?:à ce|au) projet/i.test(docFr) && /GitHub Pro/.test(docFr));

console.log("\n── Temoins : l'ancien texte est vu ──");
const ANCIEN = [
  'node "${CLAUDE_SKILL_DIR}/../../scripts/vault/launch.mjs" add --lang <LANG> \\\n  --name VERCEL --service Vercel --fields "api_token:secret"',
  'VTOK=$(node "${CLAUDE_SKILL_DIR}/../../scripts/vault/vault.mjs" get VERCEL api_token) && [ -n "$VTOK" ]',
  "printf '%s' \"$VTOK\" | gh secret set VERCEL_TOKEN",
  "      - name: Install Vercel CLI\n        run: npm install -g vercel",
].map((b) => "```bash\n" + b + "\n```").join("\n");
const passees = Object.entries(SETUP).filter(([, rule]) => rule(ANCIEN)).map(([n]) => n);
check("aucune regle de _setup-github-deploy ne laisse passer l'ancien texte", passees.length === 0, passees.join(" ; "));

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures > 0) {
  console.log(`ECHEC : ${failures} verification(s) en echec.`);
  process.exit(1);
}
console.log("OK : la cle de /add-collab est limitee au projet, verifiee avant d'etre posee.");
