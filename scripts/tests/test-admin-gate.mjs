#!/usr/bin/env node
// test-admin-gate.mjs - The gate of the admin space, as the harness writes it (3.4.17).
//
// On 26/10/2026, an audit found sites built with this harness whose admin pages left their content
// to anyone: the only check of admin/(protected)/ was its layout, and the layout's redirect carried
// the page Next.js had already rendered. test-admin-gate-next.mjs proves the behaviour on a real
// Next.js (heavy, played before a release); this one holds, without any network, what the harness
// writes for it:
//   1. the templates: the helper (`requireAdmin()`, server only), the page that calls it on its
//      first line, its "use server" action that checks for itself, the layout that keeps its
//      check, the middleware (the session cookie under every name Auth.js gives it, the matcher);
//   2. the module that writes the middleware: the version of Next.js read where Node reads it, the
//      file Next.js 15 and 16 each read, and never a write over a middleware the project has;
//   3. the scripts that call them (/add-auth's admin mode, /add-role), and the skills that say the
//      rule to Claude: the convention written into the project's CLAUDE.md, /add-auth's case B,
//      the users mode, /add-i18n;
//   4. what was already right and must stay so: the users' dashboard and the agents' pages check
//      on their own first lines, and the contact form writes to the site's owner, never to the
//      address it was given.
// Only language-neutral tokens of the skills are read: the same file runs in the solo harness and
// in the Team's collaborator harness.
//
//   node scripts/tests/test-admin-gate.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lire = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n") : "");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 500)})` : ""}`);
}

/** The statements of a default-exported component, first one first (blank lines and comments out). */
function premieresLignes(source) {
  const m = source.match(/export default async function \w+\([^)]*\)[^{]*\{\n([\s\S]*)$/);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
}

console.log("── Les gabarits ──");
{
  const helper = lire("templates/auth/admin/require-admin.ts");
  check("le contrôle requireAdmin() existe, réservé au serveur (import \"server-only\" en tête)", helper.startsWith('import "server-only";\n') && /export async function requireAdmin\(\)/.test(helper));
  check("... il renvoie vers la connexion quand ce n'est pas l'admin", /if \(!\(await isAdmin\(\)\)\) \{\s*redirect\("\/admin\/signin\?callbackUrl=\/admin"\);/.test(helper), helper);

  const page = lire("templates/auth/admin/pages/protected-page.tsx");
  const lignes = premieresLignes(page);
  check("la page admin appelle requireAdmin() en PREMIÈRE ligne, avant toute lecture", lignes[0] === "await requireAdmin();" && /import \{ requireAdmin \} from "~\/server\/require-admin";/.test(page), lignes.slice(0, 2).join(" | "));
  const actions = [...page.matchAll(/"use server";\n\s*([^\n]*)/g)].map((m) => m[1].trim());
  check("chaque action \"use server\" de la page commence par son propre contrôle", actions.length > 0 && actions.every((a) => a === "if (!(await isAdmin())) return;"), JSON.stringify(actions));

  const layout = lire("templates/auth/admin/pages/protected-layout.tsx");
  check("le layout garde son contrôle, en plus", premieresLignes(layout)[0] === "await requireAdmin();", premieresLignes(layout)[0]);

  const mw = lire("templates/auth/admin/middleware.ts");
  check("le middleware porte sa marque en première ligne (une seconde passe le reconnaît)", mw.startsWith("// hypervibe:admin-gate\n"));
  check("... un export par défaut (Next.js 15 et 16 le lisent tous deux)", /export default function \w+\(request: NextRequest\)/.test(mw));
  const cookie = mw.match(/\.some\(\(\{ name \}\) => (\/.+\/)\.test\(name\)\)/);
  let re = null;
  try {
    re = cookie ? new RegExp(cookie[1].slice(1, -1)) : null;
  } catch {
    re = null;
  }
  const oui = ["authjs.session-token", "__Secure-authjs.session-token", "authjs.session-token.0", "__Secure-authjs.session-token.1"];
  const non = ["next-auth.session-token", "authjs.session-token-x", "xauthjs.session-token", "authjs.csrf-token", "__Host-authjs.csrf-token"];
  check("... le cookie de session reconnu sous tous les noms qu'Auth.js lui donne, et seulement eux", re !== null && oui.every((n) => re.test(n)) && non.every((n) => !re.test(n)), cookie?.[1]);
  const matcher = mw.match(/matcher: (\[[^\]]*\])/);
  let chemins = null;
  try {
    chemins = matcher ? JSON.parse(matcher[1]) : null;
  } catch {
    chemins = null;
  }
  check("... il couvre /admin et tout ce qui est dessous, la page de connexion exceptée", JSON.stringify(chemins) === JSON.stringify(["/admin", "/admin/((?!signin).*)"]), matcher?.[1]);
  let sousAdmin = null;
  try {
    sousAdmin = chemins ? new RegExp(`^${chemins[1]}$`) : null;
  } catch {
    sousAdmin = null;
  }
  check("... /admin/clients y passe, /admin/signin n'y passe pas", sousAdmin !== null && sousAdmin.test("/admin/clients") && !sousAdmin.test("/admin/signin"), String(sousAdmin));
  check("... sans cookie, la requête part vers la page de connexion", /url\.pathname = "\/admin\/signin";/.test(mw) && /NextResponse\.redirect\(url\)/.test(mw));
  check("... et seule une requête qui porte le cookie passe", /\n  if \(hasSession\) return NextResponse\.next\(\);\n/.test(mw), mw.match(/\n\s*if \([^)]*\) return NextResponse\.next\(\);/)?.[0]);
}

console.log("\n── Le module qui écrit le middleware ──");
const GATE = join(ROOT, "scripts", "admin-gate.mjs");
const gate = existsSync(GATE) ? await import(pathToFileURL(GATE).href) : null;
check("scripts/admin-gate.mjs existe", gate !== null);
const racine = mkdtempSync(join(tmpdir(), "hv-admin-gate-"));
try {
  if (gate) {
    const projet = (nom, { range = "^15.2.3", installed = null, fichiers = {} } = {}) => {
      const dir = join(racine, nom);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: nom, dependencies: { next: range } }));
      if (installed) {
        mkdirSync(join(dir, "node_modules", "next"), { recursive: true });
        writeFileSync(join(dir, "node_modules", "next", "package.json"), JSON.stringify({ name: "next", version: installed }));
      }
      for (const [rel, contenu] of Object.entries(fichiers)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), contenu);
      }
      return dir;
    };
    check("la version de Next.js lue dans la plage du package.json (^15.2.3 : 15)", gate.nextMajor(projet("plage")) === 15);
    check("... la version installée d'abord, quand elle existe (16.4.3 installée sous une plage ^15)", gate.nextMajor(projet("installee", { installed: "16.4.3" })) === 16);
    check("... une étiquette (latest) ne dit rien : null", gate.nextMajor(projet("etiquette", { range: "latest" })) === null);
    const mono = join(racine, "mono");
    mkdirSync(join(mono, "node_modules", "next"), { recursive: true });
    writeFileSync(join(mono, "node_modules", "next", "package.json"), JSON.stringify({ name: "next", version: "16.4.3" }));
    mkdirSync(join(mono, "apps", "web"), { recursive: true });
    writeFileSync(join(mono, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "^15.2.3" } }));
    check("... dans un monorepo, la copie remontée à la racine, lue comme Node la lit", gate.nextMajor(join(mono, "apps", "web")) === 16);

    const quinze = projet("quinze");
    const r15 = gate.ensureAdminMiddleware(quinze);
    check("Next.js 15 sans middleware : src/middleware.ts écrit, avec la marque", r15.status === "written" && r15.file === "src/middleware.ts" && readFileSync(join(quinze, "src", "middleware.ts"), "utf8").startsWith("// hypervibe:admin-gate"), JSON.stringify(r15));
    const seize = projet("seize", { range: "^16.4.1" });
    const r16 = gate.ensureAdminMiddleware(seize);
    check("Next.js 16 sans middleware : src/proxy.ts (le nom que lit cette version), pas de middleware.ts", r16.status === "written" && r16.file === "src/proxy.ts" && existsSync(join(seize, "src", "proxy.ts")) && !existsSync(join(seize, "src", "middleware.ts")), JSON.stringify(r16));
    const inconnue = projet("inconnue", { range: "latest" });
    check("une version inconnue : src/middleware.ts (Next.js 16 lit encore ce nom)", gate.ensureAdminMiddleware(inconnue).file === "src/middleware.ts");
    const encore = gate.ensureAdminMiddleware(quinze);
    check("une seconde passe reconnaît le sien : present, rien de réécrit", encore.status === "present" && encore.file === "src/middleware.ts", JSON.stringify(encore));

    const intl = 'import createMiddleware from "next-intl/middleware";\nimport { routing } from "./i18n/routing";\n\nexport default createMiddleware(routing);\n';
    for (const rel of ["src/middleware.ts", "middleware.ts", "src/proxy.ts", "src/middleware.js"]) {
      const dir = projet(`existant-${rel.replace(/[/.]/g, "-")}`, { range: "^16.4.1", fichiers: { [rel]: intl } });
      const r = gate.ensureAdminMiddleware(dir);
      const autres = gate.MIDDLEWARE_CANDIDATES.filter((c) => c !== rel && existsSync(join(dir, c)));
      check(`un middleware déjà là (${rel}) n'est jamais remplacé : existing, le fichier intact, aucun autre posé`, r.status === "existing" && r.file === rel && readFileSync(join(dir, rel), "utf8") === intl && autres.length === 0, JSON.stringify({ r, autres }));
    }
    const sec = projet("check");
    const essai = gate.ensureAdminMiddleware(sec, { check: true });
    check("--check ne fait que dire : would-write, rien d'écrit", essai.status === "would-write" && !existsSync(join(sec, "src")), JSON.stringify(essai));

    const sansAide = projet("sans-aide");
    check("le contrôle requireAdmin() écrit quand le projet ne l'a pas", gate.ensureRequireAdmin(sansAide) === "written" && readFileSync(join(sansAide, "src", "server", "require-admin.ts"), "utf8") === lire("templates/auth/admin/require-admin.ts"));
    writeFileSync(join(sansAide, "src", "server", "require-admin.ts"), "// le sien\n");
    check("... et jamais par-dessus le sien", gate.ensureRequireAdmin(sansAide) === "present" && readFileSync(join(sansAide, "src", "server", "require-admin.ts"), "utf8") === "// le sien\n");

    const cli = projet("cli", { range: "^16.4.1", fichiers: { "src/middleware.ts": intl } });
    const sortie = spawnSync(process.execPath, [GATE, "--web-dir", cli], { encoding: "utf8", windowsHide: true });
    let json = null;
    try {
      json = JSON.parse(String(sortie.stdout).trim().split("\n").at(-1));
    } catch {
      json = null;
    }
    check("la commande dit tout en JSON sur sa dernière ligne, et nomme le middleware laissé tel quel", sortie.status === 0 && json?.helper === "written" && json?.middleware?.status === "existing" && /already has a middleware \(src\/middleware\.ts\)/.test(sortie.stdout), `${sortie.stdout}${sortie.stderr}`);
  }
} finally {
  rmSync(racine, { recursive: true, force: true });
}

console.log("\n── Les scripts qui les posent ──");
{
  const setup = lire("scripts/setup-auth-admin.mjs");
  check("/add-auth (admin) écrit le contrôle avec les pages", /\["src\/server\/require-admin\.ts", "auth\/admin\/require-admin\.ts"\]/.test(setup));
  check("... refuse de l'écraser (un fichier du projet n'est jamais remplacé)", /pageCollisions = \[[^\]]*"src\/server\/require-admin\.ts"/.test(setup));
  const etapes = setup.match(/const STEPS = \[([^\]]*)\]/)?.[1] ?? "";
  const ordre = [...setup.matchAll(/await step\("(\w+)"/g)].map((m) => m[1]);
  check("... pose le middleware par le module, dans une étape à elle, entre les pages et les variables", /import \{ ensureAdminMiddleware \} from "\.\/admin-gate\.mjs";/.test(setup) && /"writeAdminGate"/.test(etapes) && ordre.indexOf("writeAdminGate") === ordre.indexOf("writeAdminPages") + 1 && ordre.indexOf("pushEnvVars") === ordre.indexOf("writeAdminGate") + 1 && /state\.adminGate = ensureAdminMiddleware\(WEB_DIR\)/.test(setup), ordre.join(","));
  check("... et le dit dans son JSON final (adminGate)", /adminGate: state\.adminGate,/.test(setup));

  const role = lire("scripts/setup-role.mjs");
  check("/add-role écrit la page ET son tableau client", /render\("role\/pages\/users-page\.tsx", \{\}\)/.test(role) && /"users-table\.tsx"\), render\("role\/pages\/users-table\.tsx", \{\}\)/.test(role));
  check("... et pose le contrôle et le middleware s'ils manquent (un espace admin plus ancien)", /ensureRequireAdmin\(WEB_DIR\)/.test(role) && /ensureAdminMiddleware\(WEB_DIR\)/.test(role));
  const usersPage = lire("templates/role/pages/users-page.tsx");
  check("la page des utilisateurs est une page serveur qui appelle requireAdmin() en première ligne", !/"use client"/.test(usersPage) && premieresLignes(usersPage)[0] === "await requireAdmin();", premieresLignes(usersPage)[0]);
  const table = lire("templates/role/pages/users-table.tsx");
  check("... son tableau interactif est un composant client à part, ses données par adminUsers.*", /"use client";/.test(table) && /export function UsersTable\(\)/.test(table) && /api\.adminUsers\.list\.useQuery\(\)/.test(table));
  check("... dont chaque procédure vérifie l'admin (inchangé)", (lire("templates/role/admin-router.ts").match(/await assertAdmin\(\);/g) ?? []).length >= 2);
}

console.log("\n── Ce que les skills disent à Claude ──");
{
  const admin = lire("skills/_setup-auth-admin/SKILL.md");
  const convention = admin.match(/^\s*- `- \*\*(?:Admin structure|Structure admin)\*\*.*$/m)?.[0] ?? "";
  check("la convention du CLAUDE.md : chaque page commence par await requireAdmin()", /await requireAdmin\(\)/.test(convention) && /page\.tsx/.test(convention), convention.slice(0, 200));
  check("... le contrôle du layout ne suffit pas, et elle ne l'enseigne plus comme la barrière", /layout\.tsx/.test(convention) && !/redirect\("\/admin\/signin\?callbackUrl=\/admin"\)/.test(convention), convention.slice(0, 300));
  check("... toute action \"use server\" commence par if (!(await isAdmin())) return;", convention.includes("if (!(await isAdmin())) return;"));
  check("... le middleware, sous ses deux noms, première barrière", /src\/middleware\.ts/.test(convention) && /src\/proxy\.ts/.test(convention));
  check("la skill sait quoi faire d'un middleware déjà là (fusion quand c'est sûr, sinon le dire)", /`adminGate\.status`/.test(admin) && /`existing`/.test(admin) && /templates\/auth\/admin\/middleware\.ts/.test(admin));
  check("/add-auth, cas B (l'admin ajouté sur des comptes existants), pose le contrôle aussi", /scripts\/admin-gate\.mjs" --web-dir <WEB_DIR>/.test(lire("skills/add-auth/SKILL.md")));
  check("le mode utilisateurs : une page contrôle la session elle-même, pas son layout (dans la ligne de convention même)", /^\s*- `- \*\*[^\n]*const session = await auth\(\); if \(!session\?\.user\) redirect\([^\n]*layout\.tsx/m.test(lire("skills/_setup-auth-users/SKILL.md")));
  check("/add-i18n garde le contrôle admin en tête quand il fusionne son middleware", /hypervibe:admin-gate/.test(lire("skills/add-i18n/SKILL.md")));
  check("/add-role nomme les deux gabarits de la page", /role\/pages\/users-table\.tsx/.test(lire("skills/add-role/SKILL.md")));
  const boot = lire("skills/bootstrap/SKILL.md");
  check("/bootstrap, quand il construit un espace admin : chaque page commence par await requireAdmin(), le layout n'est plus « la » barrière", /page\.tsx\s+← \/admin ?: await requireAdmin\(\)/.test(boot) && !/layout\.tsx\s+← gate/.test(boot) && boot.includes("if (!(await isAdmin())) return;"));
}

console.log("\n── Ce qui était juste et doit le rester ──");
{
  for (const rel of ["templates/auth-dashboard/plain.tsx", "templates/auth-dashboard/i18n.tsx"]) {
    const src = lire(rel);
    const corps = src.slice(src.indexOf("export default async function"));
    const iAuth = corps.indexOf("await auth()");
    const iRedirect = corps.indexOf("redirect(");
    const iRetour = corps.indexOf("return (");
    check(`${rel} : la session contrôlée avant de rien montrer`, iAuth > 0 && iRedirect > iAuth && iRetour > iRedirect);
  }
  for (const rel of ["templates/agent-dashboard/pages/agents-list.tsx", "templates/agent-dashboard/pages/agent-detail.tsx", "templates/agent-dashboard/pages/invocation-detail.tsx"]) {
    if (!existsSync(join(ROOT, rel))) continue;
    check(`${rel} : le contrôle admin en première ligne`, /^if \(!\(await isAdmin\(\)\)\) redirect\(/.test(premieresLignes(lire(rel))[0] ?? ""), premieresLignes(lire(rel))[0]);
  }
  for (const rel of ["templates/email/resend/contact-router.ts", "templates/email/brevo/contact-router.ts"]) {
    const src = lire(rel);
    const envoi = src.slice(src.indexOf("await sendMail("), src.indexOf("subject:"));
    check(`${rel} : le formulaire écrit au propriétaire du site, jamais à l'adresse saisie`, /CONTACT_RECIPIENT_EMAIL/.test(envoi) && !/input\.email/.test(envoi) && !/replyTo|reply_to/i.test(src), envoi);
  }
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
