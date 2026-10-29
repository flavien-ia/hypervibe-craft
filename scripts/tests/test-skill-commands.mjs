#!/usr/bin/env node
/**
 * Recette : ce que les skills font taper, et ce que leurs ports lisent.
 *
 * Trois defauts qu'aucune autre recette ne voyait :
 *  - une continuation de ligne ecrite `\n` (deux caracteres) au lieu d'une
 *    barre oblique suivie d'un vrai retour a la ligne. Quinze commandes
 *    `manifest.mjs add ... \n  --kind` l'ont porte jusqu'en 3.1.9 (retour
 *    utilisateur du 15/09/2026) : le modele recopie la commande, le shell
 *    recoit un argument `n` en trop ;
 *  - l'ancre du dossier de la skill ecrite sans accolades (le nom de la
 *    variable derriere un dollar nu), que le convertisseur Codex/OpenCode ne
 *    reecrivait pas jusqu'a sa 0.4.0. La forme du plugin est le dollar suivi
 *    du nom entre accolades ;
 *  - un texte par outil (`SKILL.codex.md`...) sans original ou mal nomme, et
 *    un `ports.json` qui exclurait une skill qui n'existe pas.
 * Aucun reseau, lecture seule des sources du plugin. Les ancres des exemples
 * sont assemblees a l'execution : ecrites en clair, le convertisseur les
 * reecrirait dans le port, ou les signalerait comme oubliees.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = join(ROOT, "skills");

let echecs = 0;
let total = 0;
const verifier = (nom, condition, detail = "") => {
  total += 1;
  if (condition) console.log(`  ok   ${nom}`);
  else {
    echecs += 1;
    console.log(`  ECHEC ${nom}${detail ? ` : ${detail}` : ""}`);
  }
};

const DOLLAR = "$";
const VARIABLE = "CLAUDE_" + "SKILL_DIR";
const ancreNue = DOLLAR + VARIABLE;
const ancreAccolades = DOLLAR + "{" + VARIABLE + "}";

// Devant une option, ou devant ||, && ou | (la commande de /register-cron publiee en 2.3.4).
const CONTINUATION_LITTERALE = /[ \t]\\n[ \t]+(?:-|\|\||&&|\|)/;
const ANCRE_SANS_ACCOLADES = new RegExp("\\" + DOLLAR + "CLAUDE_(?:SKILL_DIR|PLUGIN_ROOT)(?![A-Za-z0-9_])");
// Le dossier du plugin tape en dur (celui du poste de l'auteur) : il ne vaut
// que la ou le plugin a ete televerse dans Claude Desktop, jamais dans un port.
// Sept commandes des harnais Enterprise l'ont porte jusqu'en 2.1.10 (le `start` solo jusqu'en 3.1.6).
const CHEMIN_CODE_EN_DUR = /\.claude\/plugins\/marketplaces\/[^/\s"'`]+\/hypervibe/;
const VARIANTE = /\.(codex|opencode|antigravity)\.md$/;

console.log("\nLes motifs eux-memes");
verifier("une continuation ecrite \\n est reperee", CONTINUATION_LITTERALE.test('add --project-dir "<p>" \\n  --kind db-backup'));
verifier("... et devant || ou un tube aussi", CONTINUATION_LITTERALE.test('[ -n "$X" ] \\n  || exit 1') && CONTINUATION_LITTERALE.test('printf x \\n  | node a.mjs'));
verifier("une vraie continuation passe", !CONTINUATION_LITTERALE.test('add --project-dir "<p>" \\\n  --kind db-backup'));
verifier("un \\n de printf ou de chaine JS passe", !CONTINUATION_LITTERALE.test('printf "ok\\n"; console.log("a\\n- b")'));
verifier("un chemin Windows passe", !CONTINUATION_LITTERALE.test("C:\\Program Files\\nodejs"));
verifier("l'ancre sans accolades est reperee", ANCRE_SANS_ACCOLADES.test('node "' + ancreNue + '/../../scripts/x.mjs"'));
verifier("l'ancre avec accolades passe", !ANCRE_SANS_ACCOLADES.test('node "' + ancreAccolades + '/../../scripts/x.mjs"'));
verifier("un dossier de plugin tape en dur est repere", CHEMIN_CODE_EN_DUR.test('PLUGIN_DIR="' + DOLLAR + 'HOME/.claude/plugins/marketplaces/mon-poste/hypervibe-enterprise-admin"'));
verifier("l'ancre du plugin passe", !CHEMIN_CODE_EN_DUR.test('PLUGIN_DIR="' + ancreAccolades + '/../.."'));

const markdowns = [];
const parcourir = (skill, dossier) => {
  for (const e of readdirSync(dossier, { withFileTypes: true })) {
    const p = join(dossier, e.name);
    if (e.isDirectory()) parcourir(skill, p);
    else if (e.name.endsWith(".md")) markdowns.push({ skill, p, rel: p.slice(SKILLS.length + 1).split("\\").join("/") });
  }
};
for (const skill of readdirSync(SKILLS).sort()) {
  if (statSync(join(SKILLS, skill)).isDirectory()) parcourir(skill, join(SKILLS, skill));
}

console.log(`\nLes ${markdowns.length} fichiers Markdown des skills`);
const continuations = [];
const ancres = [];
const chemins = [];
const jetonsImprimes = [];
// wrangler-env-init.mjs imprime les lignes `export CLOUDFLARE_API_TOKEN=...` : lance nu, le
// jeton finit dans la conversation (/_create-agent jusqu'en 3.3.8). Seul `eval "$(...)"` le
// garde dans le shell.
const LANCE_ENV_INIT = /\bnode\s+"[^"]*wrangler-env-init\.mjs"/;
const ENV_INIT_SOUS_EVAL = /eval\s+"\$\(\s*node\s+"[^"]*wrangler-env-init\.mjs"/;
for (const f of markdowns) {
  readFileSync(f.p, "utf8").split(/\r?\n/).forEach((ligne, i) => {
    if (CONTINUATION_LITTERALE.test(ligne)) continuations.push(`${f.rel}:${i + 1}`);
    if (ANCRE_SANS_ACCOLADES.test(ligne)) ancres.push(`${f.rel}:${i + 1}`);
    if (CHEMIN_CODE_EN_DUR.test(ligne)) chemins.push(`${f.rel}:${i + 1}`);
    if (LANCE_ENV_INIT.test(ligne) && !ENV_INIT_SOUS_EVAL.test(ligne)) jetonsImprimes.push(`${f.rel}:${i + 1}`);
  });
}
verifier("aucune continuation de ligne ecrite \\n", continuations.length === 0, continuations.slice(0, 5).join(", "));
verifier("aucune ancre sans accolades", ancres.length === 0, ancres.slice(0, 5).join(", "));
verifier("aucun dossier de plugin tape en dur", chemins.length === 0, chemins.slice(0, 7).join(", "));
verifier("wrangler-env-init.mjs toujours sous eval (le jeton ne s'imprime jamais)", jetonsImprimes.length === 0, jetonsImprimes.slice(0, 5).join(", "));
{
  // Temoin : la regle voit la forme fautive, et laisse passer la bonne.
  const nu = `node "${DOLLAR}{CLAUDE_SKILL_DIR}/../../scripts/wrangler-env-init.mjs" 2>/dev/null`;
  const sousEval = `eval "$(${nu})"`;
  verifier("temoin : wrangler-env-init lance nu est vu", LANCE_ENV_INIT.test(nu) && !ENV_INIT_SOUS_EVAL.test(nu));
  verifier("temoin : wrangler-env-init sous eval passe", LANCE_ENV_INIT.test(sousEval) && ENV_INIT_SOUS_EVAL.test(sousEval));
}

// L'horloge GitHub (3.3.9). Sur un depot prive chaque passage compte au moins une minute du quota
// d'Actions : elle n'est pas illimitee. GitHub ne met en sommeil que les taches planifiees des
// depots publics : un keepalive cree sans lire la visibilite poussait chaque mois un commit vide
// dans les depots prives de l'organisation. Et un rafraichissement du coffre partage dont on ne
// lit pas le code de sortie laisse conclure qu'une cle manque quand le coffre est verrouille.
const keepalives = [];
const illimitees = [];
const sansCodes = [];
const APPEL_COFFRE = /apply-bienvenue\.mjs" --project "[^"]*" --no-clone/g;
const codesLus = (suite) => suite.includes("`2` / `3`") && suite.includes("`4`");
for (const f of markdowns) {
  const texte = readFileSync(f.p, "utf8");
  if (texte.includes("keepalive.yml") && !texte.includes("visibility")) keepalives.push(f.rel);
  if (f.skill === "add-cron" && /illimit|unlimited/i.test(texte)) illimitees.push(f.rel);
  for (const m of texte.matchAll(APPEL_COFFRE)) {
    if (!codesLus(texte.slice(m.index, m.index + 2000))) sansCodes.push(f.rel);
  }
}
verifier("un keepalive ne se cree qu'apres avoir lu la visibilite du depot", keepalives.length === 0, keepalives.join(", "));
verifier("l'horloge GitHub n'est jamais dite illimitee", illimitees.length === 0, illimitees.join(", "));
verifier("chaque rafraichissement du coffre partage lit ses codes de sortie", sansCodes.length === 0, sansCodes.join(", "));
{
  // Temoin : un appel suivi de son tableau passe, un appel nu est vu.
  const appel = 'node "x/apply-bienvenue.mjs" --project "p" --no-clone --no-verify';
  verifier("temoin : un appel au coffre sans ses codes est vu", [...appel.matchAll(APPEL_COFFRE)].length === 1 && !codesLus(appel + "\nRe-check."));
  verifier("temoin : un appel suivi de ses codes passe", codesLus(appel + "\n| `2` / `3` | verrouille |\n| `4` | absent |"));
}

// Une route de tache planifiee ne compare jamais l'en-tete a `Bearer ${process.env.CRON_SECRET}`
// fabrique sur place : tant que la variable manque, cette chaine vaut "Bearer undefined", que
// n'importe qui peut envoyer (3.3.9). Textes des skills, et scripts qui ecrivent des routes.
const ATTENDU_OUVERT = /Bearer \\?\$\{process\.env\.CRON_SECRET\}/;
const routesOuvertes = [];
const scripts = [];
const parcourirScripts = (dossier) => {
  for (const e of readdirSync(dossier, { withFileTypes: true })) {
    const p = join(dossier, e.name);
    if (e.isDirectory()) {
      if (e.name !== "tests" && e.name !== "node_modules") parcourirScripts(p);
    } else if (/\.(?:mjs|js)$/.test(e.name)) scripts.push(p);
  }
};
parcourirScripts(join(ROOT, "scripts"));
for (const p of [...markdowns.map((f) => f.p), ...scripts]) {
  readFileSync(p, "utf8").split(/\r?\n/).forEach((ligne, i) => {
    if (ATTENDU_OUVERT.test(ligne)) routesOuvertes.push(`${p.slice(ROOT.length + 1).split("\\").join("/")}:${i + 1}`);
  });
}
verifier("une route de tache planifiee reste fermee tant que CRON_SECRET manque", routesOuvertes.length === 0, routesOuvertes.slice(0, 5).join(", "));
verifier(
  "temoin : l'attendu fabrique sur place est vu, meme echappe dans un gabarit",
  ATTENDU_OUVERT.test("if (auth !== `Bearer ${process.env.CRON_SECRET}`) {") && ATTENDU_OUVERT.test("const expected = \\`Bearer \\${process.env.CRON_SECRET}\\`;"),
);
verifier("temoin : la forme fermee passe", !ATTENDU_OUVERT.test("if (!secret || auth !== `Bearer ${secret}`) {"));

console.log("\nTextes par outil et ports.json");
const variantes = markdowns.filter((f) => VARIANTE.test(f.rel));
for (const v of variantes) {
  verifier(`${v.rel} remplace un fichier qui existe`, existsSync(v.p.replace(VARIANTE, ".md")));
  if (/(^|\/)SKILL\.(codex|opencode|antigravity)\.md$/.test(v.rel)) {
    const nom = readFileSync(v.p, "utf8").match(/^name:\s*(.+?)\s*$/m)?.[1];
    verifier(`${v.rel} porte le nom de sa skill`, nom === v.skill, nom);
  }
}
const ports = JSON.parse(readFileSync(join(ROOT, "ports.json"), "utf8"));
const exclues = Array.isArray(ports.exclude) ? ports.exclude : Object.values(ports.exclude ?? {}).flat();
for (const skill of new Set(exclues)) {
  verifier(`ports.json exclut une skill qui existe : ${skill}`, existsSync(join(SKILLS, skill, "SKILL.md")));
}
// Codex et Antigravity ont un planificateur : chaque routine y a sa variante, ou reste hors de leur
// port (sinon le port garderait le texte de Claude Code, qui parle d'un autre planificateur).
for (const outil of ["codex", "antigravity"]) {
  for (const skill of ["add-routine", "_create-routine"]) {
    const variante = existsSync(join(SKILLS, skill, `SKILL.${outil}.md`));
    verifier(`${skill} : une variante ${outil}, ou hors du port ${outil}`, variante || (ports.exclude?.[outil] ?? []).includes(skill));
  }
}
verifier(
  "ports.json : prefixe des skills internes conforme",
  /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/.test(ports.internalPrefix ?? ""),
  String(ports.internalPrefix),
);

console.log(`\n${total - echecs}/${total} verifications passent`);
process.exit(echecs ? 1 : 0);
