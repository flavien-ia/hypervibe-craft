#!/usr/bin/env node
// test-auth-templates.mjs - The sign-in a project receives from /add-auth, read in the templates
// themselves (retours de Manuel Ferreira, 12/11/2026, corrective 3.4.30):
//   1. no pattern the T3 lint refuses (`next build` stops on it): `!x || !x.y` where `x?.y` is
//      asked (prefer-optional-chain), a type assertion after `"k" in err` has already narrowed it
//      (no-unnecessary-type-assertion);
//   2. every read of the accounts names its columns (the project's rule on database reads);
//   3. the admin page signs out from the browser (next-auth/react), never by a server action, which
//      answered 303 and left the session open;
//   4. a session ends with its account: the jwt callback, extracted from the template and played,
//      ends a session whose account is gone or whose password changed since it opened;
//   5. deleting an account asks for the current password, checked on the server, as /security's
//      grid requires;
//   6. the admin 2FA never rewrites an auth.ts that holds another mode: a combined sign-in is
//      refused and left byte-identical.
// No network, no database, no vault: the templates are read, the 2FA script stops at its preflight.
//
//   node scripts/tests/test-auth-templates.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lire = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 500)})`}`);
}

/** Every file of a folder, recursively, that matches. */
function fichiers(dir, re, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) fichiers(full, re, out);
    else if (re.test(name)) out.push(full);
  }
  return out;
}

// The code a project receives for its sign-in: the templates of /add-auth and of the 2FA, the reset
// routers of each sender included (templates/auth/users/auth-router-with-reset-<sender>.ts).
const CODE = fichiers(join(ROOT, "templates"), /\.(?:ts|tsx)$/)
  .filter((f) => /[\\/](?:auth[^\\/]*|2fa)[\\/]/.test(f))
  .map((f) => relative(ROOT, f).replace(/\\/g, "/"));
/** The reset routers, one per sender, and the sender's name. */
const RESET = CODE.filter((f) => /\/auth-router-with-reset-[a-z]+\.ts$/.test(f));
const expediteur = (f) => f.match(/auth-router-with-reset-([a-z]+)\.ts$/)[1];
check("les routeurs de réinitialisation sont trouvés (Brevo et Resend)", RESET.map(expediteur).sort().join(",") === "brevo,resend", RESET.join(", "));
check("les gabarits de connexion sont trouvés (au moins 25)", CODE.length >= 25, CODE.length);

// ── 1. Ce que le lint de T3 refuse ──
// `!user || !user.passwordHash` : prefer-optional-chain (`!user?.passwordHash`). Signalé dans
// src/server/auth.ts du mode users.
const CHAINE = /!\s*([A-Za-z_$][\w$.]*)\s*\|\|\s*!\s*\1\./;
// `"message" in err ? String((err as { message: unknown }).message)` : `in` a déjà rétréci le type,
// l'assertion ne change rien (no-unnecessary-type-assertion). Signalé dans src/app/signup/page.tsx.
const ASSERTION = /"(\w+)"\s+in\s+(\w+)[\s\S]{0,120}?\(\s*\2\s+as\s+\{[^}]*\b\1\b/;
const chaine = CODE.filter((f) => CHAINE.test(lire(f)));
check("aucun `!x || !x.y` dans les gabarits de connexion (prefer-optional-chain)", chaine.length === 0, chaine.join(", "));
const assertion = CODE.filter((f) => ASSERTION.test(lire(f)));
check("aucune assertion de type après un `\"k\" in err` (no-unnecessary-type-assertion)", assertion.length === 0, assertion.join(", "));
check("... et ces deux motifs attrapent bien ce qui était écrit (témoins)", CHAINE.test("if (!user || !user.passwordHash) return null;") && ASSERTION.test('err && typeof err === "object" && "message" in err\n          ? String((err as { message: unknown }).message)') && !CHAINE.test("if (!user?.passwordHash) return null;") && !ASSERTION.test('"message" in err ? String(err.message) : ""'));

// ── 2. Les lectures nomment leurs colonnes ──
/** Each `db.query.<t>.findFirst({...})` / `findMany({...})` of a text: its object, braces counted. */
function lectures(text) {
  const out = [];
  const re = /db\.query\.\w+\.(?:findFirst|findMany)\(\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") depth -= 1;
      i += 1;
    }
    out.push(text.slice(m.index, i));
  }
  return out;
}
const SKILL_2FA = "skills/_setup-2fa-users/SKILL.md";
const sansColonnes = [];
let lues = 0;
for (const f of [...CODE, SKILL_2FA]) {
  for (const l of lectures(lire(f))) {
    lues += 1;
    if (!/\bcolumns:\s*\{/.test(l)) sansColonnes.push(`${f}: ${l.replace(/\s+/g, " ").slice(0, 90)}`);
  }
}
check("des lectures de comptes sont trouvées (au moins 8)", lues >= 8, lues);
check("chaque lecture des gabarits de connexion nomme ses colonnes (`columns`)", sansColonnes.length === 0, sansColonnes.join(" | "));

// ── 3. La déconnexion de l'espace admin ──
{
  const page = lire("templates/auth/admin/pages/protected-page.tsx");
  const bouton = existsSync(join(ROOT, "templates/auth/admin/pages/sign-out-button.tsx")) ? lire("templates/auth/admin/pages/sign-out-button.tsx") : "";
  check("la page admin n'appelle plus signOut dans une action serveur", !/signOut\s*\(/.test(page) && !/from "~\/server\/auth"/.test(page), page.slice(0, 200));
  check("... elle affiche le bouton client", /import \{ SignOutButton \} from "\.\/sign-out-button";/.test(page) && /<SignOutButton \/>/.test(page));
  check("le bouton est un composant client qui passe par next-auth/react, vers la connexion admin", bouton.startsWith('"use client";\n') && /import \{ signOut \} from "next-auth\/react";/.test(bouton) && /signOut\(\{ redirectTo: "\/admin\/signin" \}\)/.test(bouton) && /cursor-pointer/.test(bouton));
  const setup = lire("scripts/setup-auth-admin.mjs");
  check("setup-auth-admin écrit le bouton à côté de la page", setup.includes('["src/app/admin/(protected)/sign-out-button.tsx", "auth/admin/pages/sign-out-button.tsx"]'));
  const users = [lire("templates/auth-account/plain.tsx"), lire("templates/auth-account/i18n.tsx")];
  check("le mode users se déconnecte aussi par next-auth/react (la page Mon compte)", users.every((t) => /from "next-auth\/react"/.test(t) && !/"use server"/.test(t)));
}

// ── 4. Une session finit avec son compte ──
{
  const auth = lire("templates/auth/users/auth.ts");
  const acc = auth.match(/const accountOf = cache\(async \(id: string\) =>\s*db\.query\.users\.findFirst\(\{\s*columns: \{ id: true, passwordChangedAt: true \},\s*where: eq\(users\.id, id\),\s*\}\),\s*\);/);
  check("la lecture du compte : une par requête (cache de React), par id, deux colonnes", Boolean(acc) && /^import \{ cache \} from "react";$/m.test(auth));
  const corps = auth.match(/ {4}async jwt\(\{ token, user \}\) \{\n([\s\S]*?)\n {4}\},\n/);
  check("le rappel jwt est trouvé dans le gabarit", Boolean(corps));
  if (corps) {
    let jwt = null;
    try {
      // Le corps tel qu'il est écrit, sans annotation de type à retirer : joué avec un compte simulé.
      jwt = new Function("accountOf", `return async function jwt({ token, user }) {\n${corps[1]}\n};`);
    } catch (e) {
      check("le corps du rappel jwt se lit comme du JavaScript", false, e.message);
    }
    if (jwt) {
      const comptes = new Map();
      const lus = [];
      const play = jwt(async (id) => (lus.push(id), comptes.get(id)));
      const ouvert = await play({ token: { sub: "x" }, user: { id: "u1" } });
      check("à la connexion : l'id et l'heure d'ouverture dans le jeton, sans lecture", ouvert?.id === "u1" && typeof ouvert?.signedInAt === "number" && lus.length === 0, JSON.stringify(ouvert));
      check("compte supprimé : la session finit (null)", (await play({ token: { id: "u1", signedInAt: Date.now() } })) === null);
      comptes.set("u1", { id: "u1", passwordChangedAt: null });
      const garde = { id: "u1", signedInAt: Date.now() };
      check("compte présent : la session continue", (await play({ token: garde })) === garde);
      comptes.set("u1", { id: "u1", passwordChangedAt: new Date(Date.now() + 1000) });
      check("mot de passe changé après l'ouverture : la session finit", (await play({ token: { id: "u1", signedInAt: Date.now() } })) === null);
      comptes.set("u1", { id: "u1", passwordChangedAt: new Date(Date.now() - 60_000) });
      check("mot de passe changé avant l'ouverture : la session continue", (await play({ token: { id: "u1", signedInAt: Date.now() } })) !== null);
      check("un jeton d'avant (sans heure d'ouverture), mot de passe changé depuis : il finit", (await play({ token: { id: "u1" } })) === null);
      check("un jeton sans id : la session finit", (await play({ token: {} })) === null);
    }
  }
  const schema = lire("templates/auth/users/schema-additions.ts");
  check("la table users porte passwordChangedAt", /passwordChangedAt: timestamp\("password_changed_at", \{ mode: "date", withTimezone: true \}\),/.test(schema));
  for (const f of RESET) {
    check(`la réinitialisation pose passwordChangedAt (${expediteur(f)})`, /\.set\(\{ passwordHash: newHash, passwordChangedAt: new Date\(\) \}\)/.test(lire(f)));
  }
  const regle = lire("skills/_setup-auth-users/SKILL.md");
  check("la règle écrite dans le CLAUDE.md du projet le dit (A session ends with its account)", /\*\*A session ends with its account\*\*/.test(regle) && /jwt\\` callback/.test(regle));
  const grille = lire("skills/security/SKILL.md");
  const bloc1b = grille.slice(grille.indexOf("### 1b"), grille.indexOf("### 1c") > 0 ? grille.indexOf("### 1c") : undefined);
  check("/security le cherche dans sa grille (1b) : le rappel jwt qui lit le compte", /\*\*A session that outlives its account\*\*/.test(bloc1b) && /callbacks\.jwt/.test(bloc1b) && /return `null`/.test(bloc1b));
  const ajout = lire("skills/add-auth/SKILL.md");
  check("une connexion combinée laisse passer l'admin avant la lecture (add-auth, cas A et B)", (ajout.match(/if \(token\.id === "admin"\) return token;/g) ?? []).length >= 2);
}

// ── 5. Supprimer son compte demande le mot de passe actuel ──
{
  for (const f of ["templates/auth/users/auth-router.ts", ...RESET]) {
    const t = lire(f);
    const debut = t.indexOf("deleteAccount:");
    const bloc = debut < 0 ? "" : t.slice(debut, t.indexOf("\n    }),", debut));
    const verifie = bloc.indexOf("verifyPassword(input.password, account.passwordHash)");
    const efface = bloc.indexOf("db.delete(users)");
    check(`${f} : deleteAccount reçoit le mot de passe et le vérifie AVANT d'effacer`, /\.input\(z\.object\(\{ password: z\.string\(\)\.min\(1\)\.max\(200\) \}\)\)/.test(bloc) && verifie > 0 && efface > verifie, bloc.slice(0, 120));
    check(`${f} : ... limité en tentatives par compte`, /checkRateLimit\(`delete-account:\$\{ctx\.session\.user\.id\}`\)/.test(bloc) && /from "~\/lib\/rate-limit"/.test(t));
  }
  for (const v of ["plain", "i18n"]) {
    const t = lire(`templates/auth-account/${v}.tsx`);
    check(`la page Mon compte (${v}) demande le mot de passe actuel et l'envoie`, /type="password"/.test(t) && /autoComplete="current-password"/.test(t) && /deleteAccount\.mutate\(\{ password \}\)/.test(t) && !/deleteAccount\.mutate\(\)/.test(t));
  }
  for (const lang of ["fr", "en"]) {
    const m = JSON.parse(lire(`templates/auth-account/messages-${lang}.json`)).account;
    check(`le libellé du champ existe en ${lang}`, typeof m.deletePasswordLabel === "string" && m.deletePasswordLabel.length > 0);
  }
  const grille = lire("skills/security/SKILL.md");
  check("la grille de /security et le gabarit disent la même chose : la suppression demande le mot de passe ACTUEL, vérifié sur le serveur", /deleting the account must ask for the CURRENT password, checked on the server/.test(grille) && /`auth\.deleteAccount`/.test(grille));
}

// ── 6. La 2FA admin ne réécrit jamais une connexion qui porte un autre mode ──
{
  const { adminOnlyRefusal, authModes } = await import(pathToFileURL(join(ROOT, "scripts", "auth-modes.mjs")).href);
  const admin = lire("templates/auth/admin/auth.ts");
  const users = lire("templates/auth/users/auth.ts");
  const combine = users.replace("// hypervibe:auth-modes users", "// hypervibe:auth-modes admin, users");
  check("les modes lus sur le marqueur", JSON.stringify(authModes(combine)) === '["admin","users"]' && JSON.stringify(authModes(admin)) === '["admin"]' && authModes("export {}") === null);
  check("la connexion admin seule du gabarit est acceptée", adminOnlyRefusal(admin) === null, adminOnlyRefusal(admin));
  check("le marqueur combiné est refusé", /admin, users/.test(adminOnlyRefusal(combine) ?? ""));
  check("un fichier marqué admin qui porte des comptes en base est refusé", Boolean(adminOnlyRefusal(admin + "\nconst a = DrizzleAdapter(db);\n")));
  check("un fichier marqué admin qui porte un fournisseur extérieur est refusé", Boolean(adminOnlyRefusal(`import Exemple from "next-auth/providers/exemple";\n${admin}`)));

  // Le script lui-même, sur un projet de recette : il s'arrête au contrôle, avant toute installation.
  const base = mkdtempSync(join(tmpdir(), "hv-auth-2fa-"));
  try {
    for (const [nom, texte] of [["combine", combine], ["admin-et-base", admin.replace("export const { auth", "const _a = DrizzleAdapter;\nexport const { auth")]]) {
      const dir = join(base, nom);
      mkdirSync(join(dir, "src", "server"), { recursive: true });
      mkdirSync(join(dir, "src", "lib"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: nom, private: true, dependencies: { next: "15.5.29" } }));
      writeFileSync(join(dir, "src", "server", "auth.ts"), texte);
      writeFileSync(join(dir, "src", "lib", "password.ts"), "export {};\n");
      // A tripwire: a script that let the file through stops at its next check (2FA already there),
      // before installing anything or writing a line. Without it, the script of before this fix ran
      // its whole course on the fixture, pnpm add included.
      writeFileSync(join(dir, "src", "lib", "auth-2fa.ts"), "export {};\n");
      const r = spawnSync(process.execPath, [join(ROOT, "scripts", "setup-2fa.mjs"), "--name", "atelier", "--web-dir", dir], { encoding: "utf8", cwd: dir });
      const apres = readFileSync(join(dir, "src", "server", "auth.ts"), "utf8");
      check(`setup-2fa refuse (${nom}) : sortie 1, rien d'écrit, auth.ts identique à l'octet`, r.status === 1 && apres === texte && /left as it is/.test(r.stderr) && readdirSync(join(dir, "src", "lib")).length === 2, `${r.status} ${r.stderr.slice(-300)}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const orchestre = lire("skills/add-2fa/SKILL.md");
  check("/add-2fa demande quel compte, l'administrateur en premier, sur une connexion combinée", /Marker = `admin, users`/.test(orchestre) && /"The administrator" \(listed first\)/.test(orchestre) && !/For `admin, users`, we handle the \*\*user\*\* 2FA/.test(orchestre));
}

console.log(`\n${checks - failures}/${checks} vérifications`);
process.exit(failures ? 1 : 0);
