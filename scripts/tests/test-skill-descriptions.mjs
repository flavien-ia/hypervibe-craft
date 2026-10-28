#!/usr/bin/env node
// test-skill-descriptions.mjs - Recette of the plugin manifest and of the skill
// descriptions and names, read the way the upload dialog reads them.
//
// On 7 September 2026 a participant could not install the plugin through the
// "Upload a plugin" dialog of Claude Desktop: the whole zip was refused with
// "Skill 'skills/add-domain': SKILL.md description cannot contain XML tags".
// That validator (the same one behind the organisation upload in Cowork, see
// anthropics/claude-code#63081) rejects a `description` as soon as it holds a
// `<` or a `>`, arrows and placeholders included: `<Registrar> -> Cloudflare`
// was the culprit, reworded in 3.0.5. Nothing upstream warns about it:
// `claude plugin validate` only reads the manifest, and a marketplace install
// goes through. The defect therefore travels all the way to the person who
// installs, and it can come back with any new skill, which is why it is
// checked here, before every release.
//
// On 28 October 2026 the same dialog (Claude Desktop 4.29, Microsoft Store)
// refused the collaborator plugin 2.4.18 with "Plugin failed validation with
// 1 error. <plugin name> : Plugin description must be at most 500
// characters." The description of its .claude-plugin/plugin.json was 522
// characters long, and had been since 2.3.6 at least: the limit is new, it is
// written nowhere in the plugin documentation, and nothing warned before a new
// collaborator could no longer install the plugin. Hence the limits checked
// here, each one in both directions:
//   - the `description` of .claude-plugin/plugin.json (and of each plugin entry
//     of .claude-plugin/marketplace.json, the same text) is 500 characters at
//     most: the limit seen in the dialog on 28 October 2026;
//   - each skill `description` is 1024 characters at most, and each skill name
//     64 characters at most, in lowercase letters, digits and hyphens: the
//     limits the Agent Skills specification (agentskills.io/specification) and
//     the platform documentation (platform.claude.com, Agent Skills overview)
//     publish. The help center lists "Invalid characters in skill name or
//     description" and "Skill folder name doesn't match the skill name" among
//     the upload errors, so a `name` field must also equal its folder;
//   - the plugin name follows the same rule (the plugin reference only says
//     "use kebab-case"; 64 is the skill limit, applied here for safety).
// Two departures from the specification, both seen accepted by the dialog
// (the 28 October refusal named only the description): the internal skills
// start with `_` (`_push-env-vars`), and a name may hold the word "claude"
// (`_update-claude-md`), which the platform documentation reserves.
// A length is counted in UTF-16 code units, the way JavaScript counts a
// string: never fewer than the characters a person sees.
//
// Only `description` is checked for chevrons. `argument-hint` (`<projet>`, the
// Claude Code convention) and `compatibility` (`>=`) go through untouched and
// must not be reported, so this recette reads the frontmatter the way a YAML
// parser does instead of grepping lines: plain text on one line or continued
// on indented ones, double or single quotes (escapes and line breaks
// included), and the `|` / `>` block forms, whose indicator is not a chevron.
//
//   node scripts/tests/test-skill-descriptions.mjs          (this plugin)
//   node scripts/tests/test-skill-descriptions.mjs <dir>    (another plugin root,
//                                                            or a skills/ folder)

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BOM = String.fromCharCode(0xfeff);

// ── The limits of the upload dialog ──────────────────────────────────
const MAX_PLUGIN_DESCRIPTION = 500;
const MAX_SKILL_DESCRIPTION = 1024;
const MAX_NAME = 64;
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME = /^_?[a-z0-9]+(?:-[a-z0-9]+)*$/;

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

/** Why a name would be refused, or null when it is accepted. */
function nameProblem(name, pattern) {
  if (typeof name !== "string" || name === "") return "nom absent";
  if (name.length > MAX_NAME) return `nom de ${name.length} caracteres, au plus ${MAX_NAME}`;
  if (!pattern.test(name)) return "nom hors minuscules, chiffres et tirets";
  return null;
}

// ── Reading a frontmatter value the way YAML does ────────────────────

/** A text without its byte order mark. */
function withoutBom(text) {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** The frontmatter block of a SKILL.md, or null when the file has none. */
function frontmatterOf(content) {
  const text = withoutBom(content);
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? m[1] : null;
}

/** Content of a quoted flow scalar whose opening quote is the first character
 *  of `text`. Stops at the closing quote: what follows (a comment, at most)
 *  is not part of the value. */
function quoted(text) {
  const q = text[0];
  let out = "";
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i];
    if (q === '"' && c === "\\") {
      const n = text[i + 1] ?? "";
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
      i += 1;
    } else if (c === q) {
      if (q === "'" && text[i + 1] === "'") {
        out += "'";
        i += 1;
      } else return out;
    } else out += c;
  }
  return out; // unterminated quote: everything read so far
}

/**
 * The value of a top-level key of a frontmatter, or null when the key is
 * absent. Covers the forms a SKILL.md actually uses: plain text on one line or
 * continued on indented lines, double or single quotes (possibly spanning
 * lines), and the `|` / `>` block scalars. The plugin ships without
 * node_modules, so this is a reader of those forms, not a YAML parser.
 */
function valueOf(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  const keyLine = new RegExp(`^${key}:(\\s|$)`);
  const start = lines.findIndex((l) => keyLine.test(l));
  if (start < 0) return null;
  const head = lines[start].slice(key.length + 1).replace(/^[ \t]*/, "");
  // The value owns every following line that is blank or indented; the next
  // top-level key (column 0) ends it.
  const body = [];
  for (let i = start + 1; i < lines.length && /^(\s|$)/.test(lines[i]); i += 1) body.push(lines[i]);
  while (body.length && body.at(-1).trim() === "") body.pop();

  if (/^[|>][-+0-9]*[ \t]*(#.*)?$/.test(head)) {
    const indents = body.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
    const indent = indents.length ? Math.min(...indents) : 0;
    return body.map((l) => l.slice(indent)).join("\n").trim();
  }
  const folded = [head, ...body.map((l) => l.trim())].join(" ").trim();
  if (folded.startsWith('"') || folded.startsWith("'")) return quoted(folded);
  return folded.replace(/\s#.*$/, "").trim();
}

/** The `description` value of a frontmatter, or null when the key is absent. */
function descriptionOf(frontmatter) {
  return valueOf(frontmatter, "description");
}

/** The neighbourhood of the first chevron, on one line. */
function excerpt(description) {
  const flat = description.replace(/\s+/g, " ");
  const at = flat.search(/[<>]/);
  const from = Math.max(0, at - 30);
  const to = Math.min(flat.length, at + 30);
  return `${from > 0 ? "..." : ""}${flat.slice(from, to)}${to < flat.length ? "..." : ""}`;
}

/** Every skills/<name>/SKILL.md under `root` (a plugin root, or a skills/
 *  folder itself), with the ones the dialog would refuse: a chevron in the
 *  description, a description too long, a name it does not accept. */
function scan(root) {
  const skills = basename(root) === "skills" ? root : join(root, "skills");
  const result = { skills, total: 0, fautifs: [], sansDescription: [], tropLongues: [], nomsFautifs: [], plusLongue: null };
  if (!existsSync(skills)) return result;
  for (const nom of readdirSync(skills).sort()) {
    const file = join(skills, nom, "SKILL.md");
    if (!statSync(join(skills, nom)).isDirectory() || !existsSync(file)) continue;
    result.total += 1;
    const fm = frontmatterOf(readFileSync(file, "utf8"));
    const description = fm === null ? null : descriptionOf(fm);
    const nomDossier = nameProblem(nom, SKILL_NAME);
    if (nomDossier) result.nomsFautifs.push({ nom, raison: `dossier : ${nomDossier}` });
    const champ = fm === null ? null : valueOf(fm, "name");
    if (champ !== null && champ !== nom) result.nomsFautifs.push({ nom, raison: `champ name "${champ}" different du dossier` });
    if (description === null) {
      result.sansDescription.push(nom);
      continue;
    }
    if (/[<>]/.test(description)) result.fautifs.push({ nom, extrait: excerpt(description) });
    if (description.length > MAX_SKILL_DESCRIPTION) result.tropLongues.push({ nom, longueur: description.length });
    if (!result.plusLongue || description.length > result.plusLongue.longueur) {
      result.plusLongue = { nom, longueur: description.length };
    }
  }
  return result;
}

/** The manifest of a plugin root, with what the dialog would refuse in it and
 *  in the plugin entries of a marketplace.json beside it. */
function manifest(root) {
  const file = join(root, ".claude-plugin", "plugin.json");
  const result = { absent: !existsSync(file), name: null, longueur: null, problemes: [] };
  if (result.absent) return result;
  const fautif = (fichier, raison) => result.problemes.push({ fichier, raison });
  let pj;
  try {
    pj = JSON.parse(withoutBom(readFileSync(file, "utf8")));
  } catch (e) {
    fautif(".claude-plugin/plugin.json", `JSON illisible : ${e.message}`);
    return result;
  }
  result.name = pj.name ?? null;
  const nom = nameProblem(pj.name, PLUGIN_NAME);
  if (nom) fautif(".claude-plugin/plugin.json", nom);
  if (typeof pj.description !== "string" || !pj.description.trim()) {
    fautif(".claude-plugin/plugin.json", "description absente");
  } else {
    result.longueur = pj.description.length;
    if (pj.description.length > MAX_PLUGIN_DESCRIPTION) {
      fautif(".claude-plugin/plugin.json", `description de ${pj.description.length} caracteres, au plus ${MAX_PLUGIN_DESCRIPTION}`);
    }
  }
  const market = join(root, ".claude-plugin", "marketplace.json");
  if (existsSync(market)) {
    let mj;
    try {
      mj = JSON.parse(withoutBom(readFileSync(market, "utf8")));
    } catch (e) {
      fautif(".claude-plugin/marketplace.json", `JSON illisible : ${e.message}`);
      return result;
    }
    for (const entree of Array.isArray(mj.plugins) ? mj.plugins : []) {
      const ou = `.claude-plugin/marketplace.json, plugin ${entree?.name}`;
      const n = nameProblem(entree?.name, PLUGIN_NAME);
      if (n) fautif(ou, n);
      const d = entree?.description;
      if (typeof d === "string" && d.length > MAX_PLUGIN_DESCRIPTION) {
        fautif(ou, `description de ${d.length} caracteres, au plus ${MAX_PLUGIN_DESCRIPTION}`);
      }
    }
  }
  return result;
}

// ── The reader, on each YAML form ────────────────────────────────────
check(
  "guillemets doubles : les guillemets echappes restent dans la valeur",
  descriptionOf('name: x\ndescription: "Adds Google login (\\"Continue with Google\\") to a project."') ===
    'Adds Google login ("Continue with Google") to a project.',
);
check(
  "guillemets doubles sur deux lignes : la valeur est repliee",
  descriptionOf('description: "Starts here\n  and ends here."\ncompatibility: ">= 2.1"') === "Starts here and ends here.",
);
check(
  "guillemets simples : la paire '' vaut une apostrophe",
  descriptionOf("description: 'It''s quoted the other way.'") === "It's quoted the other way.",
);
check(
  "texte nu sur plusieurs lignes : les lignes indentees en font partie, pas la cle suivante",
  descriptionOf("description: Starts on the key line\n  and continues below.\nallowed-tools: Bash") ===
    "Starts on the key line and continues below.",
);
check(
  "texte nu commence a la ligne suivante",
  descriptionOf("description:\n  The whole value sits on the next line.") === "The whole value sits on the next line.",
);
check(
  "bloc litteral | : l'indicateur n'est pas dans la valeur",
  descriptionOf("description: |\n  Line one.\n  Line two.\nname: x") === "Line one.\nLine two.",
);
check(
  "bloc plie >- : l'indicateur n'est pas dans la valeur",
  descriptionOf("description: >-\n  Folded text\n  on two lines.\nargument-hint: <projet>") === "Folded text\non two lines.",
);
check("fins de ligne CRLF", descriptionOf("name: x\r\ndescription: Clean text.\r\nargument-hint: <p>") === "Clean text.");
check("cle absente : null", descriptionOf("name: x\nargument-hint: <projet>") === null);
check("fichier sans frontmatter : null", frontmatterOf("# Just a title\n\nSome text.") === null);
check("marque d'ordre d'octets ignoree", frontmatterOf(`${BOM}---\nname: x\n---\n`) === "name: x");
check("champ name lu, entre guillemets aussi", valueOf("name: add-db\ndescription: x", "name") === "add-db" && valueOf('name: "_get-secret"', "name") === "_get-secret");
check("champ name absent : null", valueOf("description: x", "name") === null);

// ── The name rules, both ways ────────────────────────────────────────
// From here to the real plugin, the limits are written as numbers, never
// through the constants above: a constant raised by mistake would otherwise
// move its own fixtures along, and nothing would notice.
for (const n of ["add-db", "add-2fa", "_push-env-vars", "_setup-2fa-admin", "a", "x".repeat(64), `_${"x".repeat(63)}`]) {
  check(`nom de skill accepte : ${n.length > 20 ? `${n.slice(0, 8)}... (${n.length})` : n}`, nameProblem(n, SKILL_NAME) === null);
}
for (const n of ["Add-Db", "add_db", "add.db", "add db", "-add-db", "add-db-", "add--db", "__x", "x_", "", "x".repeat(65), `_${"x".repeat(64)}`]) {
  check(`nom de skill refuse : ${n.length > 20 ? `${n.slice(0, 8)}... (${n.length})` : JSON.stringify(n)}`, nameProblem(n, SKILL_NAME) !== null);
}
for (const n of ["hypervibe", "hypervibe-enterprise-collab", "hypervibe-enterprise-admin"]) {
  check(`nom de plugin accepte : ${n}`, nameProblem(n, PLUGIN_NAME) === null);
}
for (const n of ["Hypervibe", "_hypervibe", "hypervibe_collab", "hypervibe:collab", "x".repeat(65)]) {
  check(`nom de plugin refuse : ${n.length > 20 ? `${n.slice(0, 8)}... (${n.length})` : n}`, nameProblem(n, PLUGIN_NAME) !== null);
}
check("une longueur se compte en unites UTF-16 : un caractere hors du plan de base compte double", String.fromCodePoint(0x1f600).length === 2);

// ── Both directions, on a fixture skills/ folder ─────────────────────
// A check is only trusted once it has been seen doing both things: reporting
// what the validator refuses, and staying quiet on what it accepts. The same
// forms as the real skills, plus the ones nobody uses yet. Each fixture gets a
// `name` equal to its folder, unless the fixture is about that very field.
const box = mkdtempSync(join(tmpdir(), "hv-skill-desc-"));
function fixture(nom, frontmatter, { crlf = false, nomPropre = true } = {}) {
  mkdirSync(join(box, "skills", nom), { recursive: true });
  const fm = nomPropre ? `name: ${nom}\n${frontmatter}` : frontmatter;
  const text = `---\n${fm}\n---\n\n# ${nom}\n`;
  writeFileSync(join(box, "skills", nom, "SKILL.md"), crlf ? text.replace(/\n/g, "\r\n") : text);
}
const PROPRES = {
  "texte-nu": "description: Guide the user, then Cloudflare, then Vercel.",
  "texte-nu-suite-indentee": "description: Starts on the key line\n  and continues below.\nallowed-tools: Bash",
  "texte-nu-ligne-suivante": "description:\n  The whole value sits on the next line.",
  "guillemets-doubles": 'description: "Adds Google login (\\"Continue with Google\\") to a project."',
  "guillemets-doubles-suite": 'description: "Starts here\n  and ends here."\ncompatibility: ">= 2.1"',
  "guillemets-simples": "description: 'It''s quoted the other way.'",
  "bloc-litteral": "description: |\n  Line one.\n  Line two.",
  "bloc-plie": "description: >-\n  Folded text\n  on two lines.\nargument-hint: <projet>",
  "chevrons-dans-les-autres-champs":
    'description: Clean text.\nargument-hint: <domaine> --project=<projet>\ncompatibility: "Claude Code >= 2.1"',
  "fins-de-ligne-crlf": "description: Clean text on CRLF lines.\nargument-hint: <projet>",
  "_interne": "description: An internal skill, its name starts with an underscore.",
  "description-1024": `description: ${"d".repeat(1024)}`,
  "description-1024-sur-deux-lignes": `description: ${"d".repeat(600)}\n  ${"d".repeat(423)}`,
  [`n${"x".repeat(63)}`]: "description: A name of exactly 64 characters.",
};
const FAUTIVES = {
  "chevron-texte-nu": "description: Target architecture: <Registrar> -> Cloudflare -> Vercel.",
  "chevron-guillemets-doubles": 'description: "Pass <name> as the argument."',
  "chevron-guillemets-simples": "description: 'Use <projet> here.'",
  "chevron-suite-indentee": "description: Starts clean\n  then a <tag> on the continuation line.",
  "chevron-bloc-plie": "description: >\n  Folded with a <tag> inside.",
  "fleche-seule": "description: Registrar -> Cloudflare, an arrow is a chevron too.",
};
const TROP_LONGUES = {
  "description-1025": `description: ${"d".repeat(1025)}`,
  "description-1025-sur-deux-lignes": `description: ${"d".repeat(600)}\n  ${"d".repeat(424)}`,
  "description-1025-bloc": `description: |\n  ${"d".repeat(1025)}`,
};
const NOMS_FAUTIFS = {
  "Majuscule-Au-Debut": "description: A capital letter in the folder name.",
  "souligne_au_milieu": "description: An underscore inside the name.",
  "double--tiret": "description: Two hyphens in a row.",
  "-tiret-au-debut": "description: A leading hyphen.",
  "tiret-a-la-fin-": "description: A trailing hyphen.",
  [`n${"x".repeat(64)}`]: "description: A name of 65 characters.",
};
const CHAMP_DIFFERENT = { "nom-du-dossier": "name: autre-nom\ndescription: The name field differs from the folder." };
for (const [nom, fm] of Object.entries(PROPRES)) fixture(nom, fm, { crlf: nom === "fins-de-ligne-crlf" });
for (const [nom, fm] of Object.entries(FAUTIVES)) fixture(nom, fm);
for (const [nom, fm] of Object.entries(TROP_LONGUES)) fixture(nom, fm);
for (const [nom, fm] of Object.entries(NOMS_FAUTIFS)) fixture(nom, fm);
for (const [nom, fm] of Object.entries(CHAMP_DIFFERENT)) fixture(nom, fm, { nomPropre: false });
mkdirSync(join(box, "skills", "sans-description"));
writeFileSync(join(box, "skills", "sans-description", "SKILL.md"), "---\nname: sans-description\nargument-hint: <projet>\n---\n");
mkdirSync(join(box, "skills", "sans-frontmatter"));
writeFileSync(join(box, "skills", "sans-frontmatter", "SKILL.md"), "# Just a title\n");

const essai = scan(box);
const groupes = [PROPRES, FAUTIVES, TROP_LONGUES, NOMS_FAUTIFS, CHAMP_DIFFERENT];
const attendues = groupes.reduce((n, g) => n + Object.keys(g).length, 0) + 2;
check("toutes les fixtures sont lues", essai.total === attendues, `${essai.total}/${attendues}`);
const signalee = (nom) =>
  essai.fautifs.some((f) => f.nom === nom) ||
  essai.sansDescription.includes(nom) ||
  essai.tropLongues.some((f) => f.nom === nom) ||
  essai.nomsFautifs.some((f) => f.nom === nom);
for (const nom of Object.keys(PROPRES)) {
  check(`acceptee : ${nom.length > 30 ? `${nom.slice(0, 8)}... (${nom.length})` : nom}`, !signalee(nom));
}
for (const nom of Object.keys(FAUTIVES)) {
  const f = essai.fautifs.find((x) => x.nom === nom);
  check(`refusee : ${nom}`, Boolean(f), f?.extrait);
}
for (const nom of Object.keys(TROP_LONGUES)) {
  const f = essai.tropLongues.find((x) => x.nom === nom);
  check(`refusee, description trop longue : ${nom}`, f?.longueur === 1025, f ? `${f.longueur} caracteres` : "non signalee");
}
for (const nom of [...Object.keys(NOMS_FAUTIFS), ...Object.keys(CHAMP_DIFFERENT)]) {
  const f = essai.nomsFautifs.find((x) => x.nom === nom);
  check(`refusee, nom : ${nom.length > 30 ? `${nom.slice(0, 8)}... (${nom.length})` : nom}`, Boolean(f), f?.raison);
}
check(
  "une description absente est signalee a part, jamais comme un chevron",
  essai.sansDescription.includes("sans-description") &&
    essai.sansDescription.includes("sans-frontmatter") &&
    !essai.fautifs.some((f) => f.nom.startsWith("sans-")),
);
check(
  "rien d'autre n'est signale",
  essai.fautifs.length === Object.keys(FAUTIVES).length &&
    essai.sansDescription.length === 2 &&
    essai.tropLongues.length === Object.keys(TROP_LONGUES).length &&
    essai.nomsFautifs.length === Object.keys(NOMS_FAUTIFS).length + Object.keys(CHAMP_DIFFERENT).length,
  `${essai.fautifs.length} chevrons, ${essai.sansDescription.length} sans description, ${essai.tropLongues.length} trop longues, ${essai.nomsFautifs.length} noms`,
);
check(
  "la plus longue description est relevee",
  essai.plusLongue?.longueur === 1025,
  essai.plusLongue ? `${essai.plusLongue.longueur}, skills/${essai.plusLongue.nom}` : "aucune",
);

// ── Both directions, on fixture manifests ────────────────────────────
function plugin(nom, pj, market) {
  const dir = join(box, "plugins", nom, ".claude-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), typeof pj === "string" ? pj : `${JSON.stringify(pj, null, 2)}\n`);
  if (market) writeFileSync(join(dir, "marketplace.json"), `${JSON.stringify(market, null, 2)}\n`);
  return manifest(join(box, "plugins", nom));
}
const DESC = (n) => "e".repeat(n);
const MANIFESTES_PROPRES = {
  "description-500": { name: "mon-plugin", description: DESC(500) },
  "description-500-accents": { name: "mon-plugin", description: "é".repeat(500) },
  "nom-64": { name: `p${"x".repeat(63)}`, description: "Short." },
  "avec-marketplace": [
    { name: "mon-plugin", description: "Short." },
    { name: "market", plugins: [{ name: "mon-plugin", source: "./", description: DESC(500) }] },
  ],
};
const MANIFESTES_FAUTIFS = {
  "description-501": [{ name: "mon-plugin", description: DESC(501) }, null, /plugin\.json/, /501 caracteres/],
  "description-501-accents": [{ name: "mon-plugin", description: "é".repeat(501) }, null, /plugin\.json/, /501 caracteres/],
  "description-absente": [{ name: "mon-plugin" }, null, /plugin\.json/, /description absente/],
  "nom-majuscules": [{ name: "Mon-Plugin", description: "Short." }, null, /plugin\.json/, /minuscules/],
  "nom-souligne": [{ name: "_mon-plugin", description: "Short." }, null, /plugin\.json/, /minuscules/],
  "nom-65": [{ name: `p${"x".repeat(64)}`, description: "Short." }, null, /plugin\.json/, /65 caracteres/],
  "marketplace-501": [
    { name: "mon-plugin", description: "Short." },
    { name: "market", plugins: [{ name: "mon-plugin", source: "./", description: DESC(501) }] },
    /marketplace\.json, plugin mon-plugin/,
    /501 caracteres/,
  ],
  "json-illisible": ["{ not json", null, /plugin\.json/, /JSON illisible/],
};
for (const [nom, args] of Object.entries(MANIFESTES_PROPRES)) {
  const [pj, market] = Array.isArray(args) ? args : [args, null];
  const m = plugin(nom, pj, market);
  check(`manifeste accepte : ${nom}`, !m.absent && m.problemes.length === 0, m.problemes.map((p) => `${p.fichier} : ${p.raison}`).join(" ; "));
}
for (const [nom, [pj, market, fichier, raison]] of Object.entries(MANIFESTES_FAUTIFS)) {
  const m = plugin(nom, pj, market);
  const p = m.problemes.find((x) => fichier.test(x.fichier) && raison.test(x.raison));
  check(`manifeste refuse, fichier et raison nommes : ${nom}`, Boolean(p) && m.problemes.length === 1, m.problemes.map((x) => `${x.fichier} : ${x.raison}`).join(" ; "));
}
check("manifeste absent : dit absent", manifest(join(box, "plugins", "inexistant")).absent === true);
rmSync(box, { recursive: true, force: true });

// ── The real plugin ──────────────────────────────────────────────────
const cible = process.argv[2] ? resolve(process.argv[2]) : ROOT;
const racinePlugin = basename(cible) === "skills" ? dirname(cible) : cible;
const reel = scan(cible);
const man = manifest(racinePlugin);
if (process.argv[2]) console.log(`\nPlugin lu dans ${racinePlugin}, skills lues dans ${reel.skills}`);
if (man.absent && process.argv[2]) {
  console.log(`(pas de .claude-plugin/plugin.json dans ${racinePlugin} : manifeste non controle)`);
} else {
  check(".claude-plugin/plugin.json present", !man.absent);
  for (const p of man.problemes) check(`${p.fichier} : accepte par le televersement Claude Desktop`, false, p.raison);
  if (!man.absent && !man.problemes.length) {
    check(
      `manifeste ${man.name} : nom conforme, description de ${man.longueur} caracteres (au plus ${MAX_PLUGIN_DESCRIPTION})`,
      true,
    );
  }
}
check("le dossier skills/ existe et contient des skills", reel.total > 0);
for (const nom of reel.sansDescription) {
  check(`skills/${nom} : description presente`, false, "champ absent ou frontmatter illisible");
}
for (const f of reel.fautifs) {
  check(`skills/${f.nom} : description sans chevron`, false, f.extrait);
}
for (const f of reel.tropLongues) {
  check(`skills/${f.nom}/SKILL.md : description de ${MAX_SKILL_DESCRIPTION} caracteres au plus`, false, `${f.longueur} caracteres`);
}
for (const f of reel.nomsFautifs) {
  check(`skills/${f.nom} : nom accepte par le televersement Claude Desktop`, false, f.raison);
}
if (reel.total > 0 && !reel.sansDescription.length && !reel.fautifs.length) {
  check(`${reel.total} descriptions sans chevron : le televersement Claude Desktop les acceptera`, true);
}
if (reel.total > 0 && !reel.tropLongues.length && reel.plusLongue) {
  check(
    `${reel.total} descriptions de ${MAX_SKILL_DESCRIPTION} caracteres au plus`,
    true,
    `la plus longue : ${reel.plusLongue.longueur}, skills/${reel.plusLongue.nom}`,
  );
}
if (reel.total > 0 && !reel.nomsFautifs.length) {
  check(`${reel.total} noms de skills conformes (minuscules, chiffres, tirets, ${MAX_NAME} caracteres au plus, egaux au dossier)`, true);
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
