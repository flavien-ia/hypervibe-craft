#!/usr/bin/env node
// test-login-limit.mjs - The limit on sign-in attempts (3.4.23).
//
// Up to 3.4.22 the API route of NextAuth answered the sixth attempt of an address itself, with a 429
// in JSON and no `url`; next-auth's client signIn() reads the `url` of every answer and threw, and
// the sign-in forms, which gave their button back on the line after `await signIn(...)`, stayed
// frozen with no message (reported by Henri on 02/11/2026). This recette holds the fix:
//   1. the templates of this version: the route is NextAuth's own handlers, the limit is at the top
//      of authorize() (TooManyAttempts, a CredentialsSignin with code "too_many_attempts"), the
//      two-step sign-in counts a valid proof once and a forged one always, every form reads the code
//      and gives its button back whatever happens; and nothing in the templates goes back to the old
//      form (a route that answers a 429, a form without `finally`);
//   2. login-limit.mjs: each template of 3.4.22, repaired, becomes the template of this version to
//      the byte (CRLF kept); a file changed by hand is never rewritten; the route never goes without
//      authorize();
//   3. repair-admin-gate.mjs --login-limit: said without the flag, counted and repaired with it, the
//      files git already sees as changed named, the scan and the command;
//   4. /update-hypervibe (or the collaborator's) and /security say it.
// No network, no real project: temporary folders and the harness's own files. The same file runs in
// the solo harness and in the collaborator's. The real code of next-auth was tried apart (the
// release's _outils/3423/epreuve-next-auth.mjs): the harness ships no node_modules.
//
//   node scripts/tests/test-login-limit.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LL = join(ROOT, "scripts", "login-limit.mjs");
const RAG = join(ROOT, "scripts", "repair-admin-gate.mjs");
const FIX = join(ROOT, "scripts", "tests", "fixtures", "login-3422");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 600)})` : ""}`);
}
const lf = (t) => String(t).replace(/\r\n/g, "\n");
const tpl = (rel) => lf(readFileSync(join(ROOT, "templates", rel), "utf8"));
const fix = (name) => readFileSync(join(FIX, name), "utf8");
const FROZEN = /await\s+signIn\(\s*["']credentials["'][\s\S]{0,600}?\}\s*\)\s*;\s*\r?\n\s*setPending\(\s*false\s*\)/;

check("scripts/login-limit.mjs existe", existsSync(LL));
if (!existsSync(LL)) {
  console.error("1 ECHEC(S)");
  process.exit(1);
}
const L = await import(pathToFileURL(LL).href);
const R = await import(pathToFileURL(RAG).href);

// ─── 1. The templates of this version ─────────────────────────────────────────
console.log("── Les gabarits de cette version ──");
{
  const users = tpl("auth/users/route.ts");
  check("la route des deux modes : les mêmes, les gestionnaires de NextAuth tels quels", users === tpl("auth/admin/route.ts") && /^export const \{ GET, POST \} = handlers;$/m.test(users));
  check("... ni 429, ni limiteur, ni réponse fabriquée par la route", !/status:\s*429|checkRateLimit\(|NextResponse|handlers\.POST\(/.test(users));
  for (const [rel, first] of [["auth/users/auth.ts", true], ["auth/admin/auth.ts", true], ["2fa/auth.ts", false]]) {
    const t = tpl(rel);
    check(`${rel} : TooManyAttempts étend CredentialsSignin (de next-auth), code "too_many_attempts"`, /import NextAuth, \{ CredentialsSignin, type DefaultSession \} from "next-auth";/.test(t) && /class TooManyAttempts extends CredentialsSignin \{\n {2}code = "too_many_attempts";\n\}/.test(t));
    check(`... authorize(credentials, request), l'adresse lue dans x-forwarded-for, la clé login:<ip>`, /async authorize\(credentials, request\) \{/.test(t) && t.includes('const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";') && t.includes("if (!checkRateLimit(`login:${ip}`).allowed) throw new TooManyAttempts();") && t.includes('import { checkRateLimit } from "~/lib/rate-limit";'));
    if (first) {
      const at = t.indexOf("async authorize(credentials, request) {");
      const body = t.slice(at).split("\n").slice(1, 3).map((l) => l.trim());
      check(`... la limite d'abord, avant toute lecture des identifiants`, body[0].startsWith("const ip = request.headers") && body[1].startsWith("if (!checkRateLimit("), JSON.stringify(body));
    } else {
      const proofAt = t.indexOf("verifyLoginProof(username, proof)");
      const limitAt = t.indexOf("checkRateLimit(`login:${ip}`)");
      const openAt = t.indexOf('return { id: "admin", name: "Admin" };');
      const appels = t.split("checkRateLimit(").length - 1;
      check("... deux étapes : la preuve valide ouvre la session sans compter, toute autre requête compte", appels === 1 && proofAt > 0 && openAt > proofAt && limitAt > openAt && /throw new TooManyAttempts\(\);\n {8}return null;\n {6}\},/.test(t), `appels du limiteur : ${appels}`);
    }
  }
  check("l'action de connexion à deux étapes compte sur la même clé (login:<ip>)", tpl("2fa/signin-actions.ts").includes("checkRateLimit(`login:${ip}`)"));
  const forms = [
    ["auth/admin/pages/signin.tsx", "signin", false],
    ["auth-signin/plain.tsx", "signin", false],
    ["auth-signin/i18n.tsx", "signin", true],
    ["auth-signup/plain.tsx", "signup", false],
    ["auth-signup/i18n.tsx", "signup", true],
  ];
  for (const [rel, kind, i18n] of forms) {
    const t = tpl(rel);
    const code = t.indexOf('res?.code === "too_many_attempts"');
    const err = t.indexOf("if (!res || res.error) {");
    check(`${rel} : le code lu avant l'erreur générale, une exception de signIn() devient l'erreur générale`, code > 0 && err > code && /\}\)(?:\n\s*)?\.catch\(\(\) => null\)/.test(t));
    if (kind === "signin") check("... et le bouton rendu quoi qu'il arrive (.finally)", /\.finally\(\(\) => setPending\(false\)\);/.test(t) && !FROZEN.test(t));
    else check("... et chaque issue rend le bouton ou quitte la page (catch, ou vers /signin)", /setPending\(false\);\n {4}\}\n {2}\}/.test(t) && !FROZEN.test(t));
    if (i18n) check("... le message vient de la traduction (errorTooManyAttempts)", t.includes('toast.error(t("errorTooManyAttempts"));'));
    else check("... le message en français, au tutoiement du gabarit", /toast\.error\("[^"]*Réessaie[^"]*"\);/.test(t.slice(code)) && !/Réessayez/.test(t));
  }
  for (const ns of ["signin", "signup"]) {
    for (const lang of ["fr", "en"]) {
      const m = JSON.parse(tpl(`auth-${ns}/messages-${lang}.json`))[ns];
      check(`messages ${ns} ${lang} : errorTooManyAttempts présent`, typeof m.errorTooManyAttempts === "string" && m.errorTooManyAttempts.length > 10);
    }
  }
  // The old form never comes back: no template answers a refusal itself, no form gives its button
  // back on the line after signIn() without handling a failure.
  const bad = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(?:ts|tsx|js|mjs)$/.test(e.name)) {
        const t = readFileSync(p, "utf8");
        const rel = relative(ROOT, p).split("\\").join("/");
        if (/\bhandlers\.POST\s*\(/.test(t) && /\b429\b/.test(t)) bad.push(`${rel}: une route qui répond elle-même un 429`);
        if (/next-auth\/react/.test(t) && /signIn\(\s*["']credentials["']/.test(t)) {
          if (FROZEN.test(t)) bad.push(`${rel}: le bouton rendu juste après signIn()`);
          if (!/\.catch\(|\bcatch\s*[({]/.test(t)) bad.push(`${rel}: aucune prise en charge d'une exception de signIn()`);
          if (!/finally/.test(t) && !/catch \(err\)[\s\S]*setPending\(false\)/.test(t)) bad.push(`${rel}: pas de finally`);
        }
      }
    }
  };
  walk(join(ROOT, "templates"));
  check("aucun gabarit ne revient à l'ancien motif (route qui répond un 429, formulaire sans finally)", bad.length === 0, bad.join(" ; "));
  for (const s of ["scripts/setup-auth-users.mjs", "scripts/setup-auth-admin.mjs"]) {
    const t = readFileSync(join(ROOT, s), "utf8");
    check(`${s} : ne dit plus que la route limite les tentatives`, !/route\.ts \(with rate limiting\)/.test(t) && /Sign-in limit: {2}5 attempts per address in 15 minutes, in authorize\(\)/.test(t));
  }
  for (const s of ["skills/_setup-auth-users/SKILL.md", "skills/_setup-auth-admin/SKILL.md"]) {
    const t = readFileSync(join(ROOT, s), "utf8");
    check(`${s} : la limite dite dans authorize(), plus dans la route`, !/API route (?:with|avec) rate limiting/.test(t) && /too_many_attempts/.test(t));
  }
  const addAuth = readFileSync(join(ROOT, "skills/add-auth/SKILL.md"), "utf8");
  check("/add-auth (ajout d'un mode) : la limite reste la première chose d'authorize()", /the limit on sign-in attempts FIRST, before both paths|la limite des tentatives de connexion EN PREMIER, avant les deux paths/.test(addAuth) && /after the limit on sign-in attempts \(its first lines, kept as they are\) and BEFORE the DB lookup|après la limite des tentatives de connexion \(ses premières lignes, gardées telles quelles\) et AVANT le DB lookup/.test(addAuth));
  const fa = readFileSync(join(ROOT, "skills/_setup-2fa-users/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  // The flaw of _setup-2fa-users up to 3.4.22 / 2.5.0: "the password OR the proof" opened an account
  // that enabled 2FA with its password alone, through a direct call to the sign-in route.
  check("_setup-2fa-users : plus jamais « le mot de passe OU la preuve »", !/rechecks the password \*\*or\*\* validates the proof|re-vérifie le mot de passe \*\*ou\*\* valide la preuve/.test(fa));
  check("... le mot de passe accepté SEULEMENT pour un compte sans 2FA, la preuve seule pour un compte qui l'a", /accepts the password ONLY for an account that has NOT enabled 2FA|n'accepte le mot de passe QUE pour un compte qui n'a PAS activé la 2FA/.test(fa) && /only a valid signed proof \(`verifyLoginProof`\) opens the session|seule une preuve signée valide \(`verifyLoginProof`\) ouvre la session/.test(fa));
  const bloc = fa.slice(fa.indexOf("   async authorize(credentials, request) {"), fa.indexOf("   ```", fa.indexOf("   async authorize(credentials, request) {")));
  const preuveOk = bloc.indexOf("if (email && proof && verifyLoginProof(email, proof)) {");
  const verif = bloc.indexOf("const ok = await verifyPassword(password, user.passwordHash);");
  check("... la forme écrite : la preuve d'abord, puis la limite, puis le mot de passe refusé à un compte à 2FA", preuveOk > 0 && bloc.indexOf("checkRateLimit(`login:${ip}`)") > preuveOk && verif > 0 && /if \(!ok \|\| \(await isTwoFactorEnabled\(user\.id\)\)\) return null;/.test(bloc.slice(verif)) && /if \(!email \|\| !password \|\| proof\) return null;/.test(bloc), bloc.slice(0, 200));
  check("... et l'essai de bout en bout demande la route directe, refusée pour un compte à 2FA", /api\/auth\/callback\/credentials/.test(fa) && /must be REFUSED|doit être REFUSÉ/.test(fa));
  const secTexte = readFileSync(join(ROOT, "skills/security/SKILL.md"), "utf8");
  check("/security : un mot de passe qui saute le second facteur par compte est 🔴, signalé et corrigé à la main", /\*\*(?:A password that skips the per-account second factor|Un mot de passe qui saute le second facteur par compte)\*\* ?:[^\n]*isTwoFactorEnabled\(user\.id\)[^\n]*🔴/.test(secTexte) && /(?:nothing repairs it automatically|rien ne le répare automatiquement)/.test(secTexte));
  check("... et l'admin n'a pas ce défaut : son authorize() (gabarit 2fa) ne prend aucun mot de passe", !/password/.test(tpl("2fa/auth.ts").slice(tpl("2fa/auth.ts").indexOf("async authorize("), tpl("2fa/auth.ts").indexOf("callbacks:"))) && /credentials: \{\n {8}username:[^\n]*\n(?: {8}\/\/[^\n]*\n)* {8}proof:/.test(tpl("2fa/auth.ts")));
  check("_setup-2fa-users : une preuve valide jamais comptée deux fois, une fausse toujours", /a request that carries a valid proof is not counted|une requête qui porte une preuve valide n'est pas comptée/.test(fa) && /A forged proof then never buys more attempts|Une fausse preuve n'achète alors aucune tentative de plus/.test(fa));
}

// ─── 2. login-limit.mjs on the templates of 3.4.22 ────────────────────────────
console.log("\n── Les gabarits de la 3.4.22, réparés ──");
{
  check("la route de la 3.4.22 est celle que le script reconnaît, à l'octet", lf(fix("route.ts.txt")) === L.OLD_ROUTE);
  check("... et la nouvelle route est le gabarit de cette version", L.newRoute() === tpl("auth/users/route.ts") && L.newRoute("a\r\nb").includes("\r\n"));
  for (const [name, rel] of [["auth-users.ts.txt", "auth/users/auth.ts"], ["auth-admin.ts.txt", "auth/admin/auth.ts"], ["auth-2fa.ts.txt", "2fa/auth.ts"]]) {
    const r = L.repairAuthorize(fix(name));
    check(`${name} réparé : le gabarit de cette version, à l'octet`, r.text === tpl(rel), r.reason ?? "différent");
    check("... relancé : rien ne change", r.text !== null && L.repairAuthorize(r.text).text === null);
    const c = L.repairAuthorize(lf(fix(name)).replace(/\n/g, "\r\n"));
    check("... en CRLF : le même, en CRLF", c.text === tpl(rel).replace(/\n/g, "\r\n"));
  }
  const google = fix("auth-users.ts.txt").replace('import Credentials from "next-auth/providers/credentials";', 'import Credentials from "next-auth/providers/credentials";\nimport Google from "next-auth/providers/google";').replace("  providers: [\n", "  providers: [\n    Google,\n");
  const rg = L.repairAuthorize(google);
  check("un fichier où /add-google-auth a ajouté son fournisseur : authorize() réparé, Google gardé", rg.text !== null && rg.text.includes("    Google,\n") && rg.text.includes("throw new TooManyAttempts()"), rg.reason);
  const touche = fix("auth-users.ts.txt").replace("if (!ok) return null;", "if (!ok) return null; // vérifié");
  check("authorize() retouché à la main : jamais réécrit, la raison dite", L.repairAuthorize(touche).text === null && /changed by hand/.test(L.repairAuthorize(touche).reason));
  const hybride = fix("auth-users.ts.txt").replace("// hypervibe:auth-modes users", "// hypervibe:auth-modes users\n// hypervibe:auth-modes admin");
  check("deux marqueurs de mode : jamais réécrit", L.repairAuthorize(hybride).text === null);
  for (const [name, rel] of [["admin-signin.tsx.txt", "auth/admin/pages/signin.tsx"], ["auth-signin-plain.tsx.txt", "auth-signin/plain.tsx"], ["auth-signin-i18n.tsx.txt", "auth-signin/i18n.tsx"], ["auth-signup-plain.tsx.txt", "auth-signup/plain.tsx"], ["auth-signup-i18n.tsx.txt", "auth-signup/i18n.tsx"]]) {
    const r = L.repairForm(fix(name));
    check(`${name} réparé : le gabarit de cette version, à l'octet`, r.text === tpl(rel), r.reason ?? "différent");
    check("... relancé : rien ne change", r.text !== null && L.repairForm(r.text).text === null);
    const c = L.repairForm(lf(fix(name)).replace(/\n/g, "\r\n"));
    check("... en CRLF : le même, en CRLF, sans une fin de ligne LF", c.text === tpl(rel).replace(/\n/g, "\r\n") && !/[^\r]\n/.test(c.text));
  }
  const avant3311 = join(ROOT, "scripts", "tests", "fixtures", "redirect-3418");
  for (const name of ["admin-signin.tsx.txt", "auth-signin-plain.tsx.txt", "auth-signin-i18n.tsx.txt"]) {
    const r = L.repairForm(readFileSync(join(avant3311, name), "utf8"));
    check(`${name} de la 3.4.18 (l'ancien filtre encore là) : la connexion réparée, l'adresse de retour laissée telle quelle`, r.text !== null && !FROZEN.test(r.text) && r.text.includes("(?![/"), r.reason);
  }
  const autreMessage = fix("auth-signin-plain.tsx.txt").replace('toast.error("Email ou mot de passe incorrect.");', 'toast.error("Identifiants refusés.");');
  const ra = L.repairForm(autreMessage);
  check("un formulaire dont le message a été changé à la main : jamais réécrit, nommé (changed by hand)", ra.text === null && /changed by hand/.test(ra.reason), JSON.stringify(ra));
  check("un fichier sans connexion : rien", L.repairForm("export const x = 1;\n").text === null);
  const json = '{\n  "signin": {\n    "title": "Connexion"\n  }\n}\n';
  check("un fichier de messages à la mise en page du plugin : la clé ajoutée, rien d'autre", L.addMessage(json, "signin", "X").text === '{\n  "signin": {\n    "title": "Connexion",\n    "errorTooManyAttempts": "X"\n  }\n}\n');
  check("... en CRLF : gardé en CRLF", L.addMessage(json.replace(/\n/g, "\r\n"), "signin", "X").text?.includes('"X"\r\n'));
  check("... déjà là : rien à écrire", L.addMessage('{\n  "signin": {\n    "errorTooManyAttempts": "Y"\n  }\n}\n', "signin", "X").text === null);
  check("... écrit autrement (quatre espaces) : jamais réécrit, la raison dite", /another layout/.test(L.addMessage(json.replace(/ {2}/g, "    "), "signin", "X").reason ?? ""));
}

// ─── Projects ─────────────────────────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), "hv-login-limit-"));
const ecrire = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const lire = (dir, rel) => lf(readFileSync(join(dir, rel), "utf8"));
const RATE = tpl("2fa/rate-limit.ts");
const PKG = (name) => JSON.stringify({ name, dependencies: { next: "15.5.28", "next-auth": "5.0.0-beta.32" } }, null, 2);
/** A project as 3.4.22 made it: users mode (signin + signup), admin mode, or admin + 2FA. */
function projet(name, { mode = "users", app = ".", i18n = false, extra = {} } = {}) {
  const dir = join(base, name);
  const at = (rel) => (app === "." ? rel : `${app}/${rel}`);
  ecrire(dir, "package.json", PKG(name));
  if (app !== ".") ecrire(dir, at("package.json"), PKG(`${name}-web`));
  ecrire(dir, at("src/lib/rate-limit.ts"), RATE);
  ecrire(dir, at("src/app/api/auth/[...nextauth]/route.ts"), fix("route.ts.txt"));
  if (mode === "users") {
    ecrire(dir, at("src/server/auth.ts"), fix("auth-users.ts.txt"));
    const sub = i18n ? "src/app/[locale]" : "src/app";
    ecrire(dir, at(`${sub}/signin/page.tsx`), fix(i18n ? "auth-signin-i18n.tsx.txt" : "auth-signin-plain.tsx.txt").replace("{{FORGOT_PASSWORD_LINK}}", "<span></span>"));
    ecrire(dir, at(`${sub}/signup/page.tsx`), fix(i18n ? "auth-signup-i18n.tsx.txt" : "auth-signup-plain.tsx.txt"));
    if (i18n) {
      for (const lang of ["fr", "en"]) {
        const merged = { common: { hello: lang === "fr" ? "Bonjour" : "Hello" }, ...JSON.parse(fix(`signin-messages-${lang}.json`)), ...JSON.parse(fix(`signup-messages-${lang}.json`)) };
        ecrire(dir, at(`messages/${lang}.json`), `${JSON.stringify(merged, null, 2)}\n`);
      }
    }
  } else {
    ecrire(dir, at("src/server/auth.ts"), fix(mode === "2fa" ? "auth-2fa.ts.txt" : "auth-admin.ts.txt"));
    if (mode === "admin") ecrire(dir, at("src/app/admin/signin/page.tsx"), fix("admin-signin.tsx.txt"));
  }
  for (const [rel, text] of Object.entries(extra)) ecrire(dir, rel, text);
  return dir;
}
const par = (found, file) => found.filter((f) => f.file === file);

try {
  console.log("\n── Ce que le script trouve dans un projet ──");
  {
    const p = projet("users");
    const { found } = L.findLoginLimit(p);
    const route = par(found, "src/app/api/auth/[...nextauth]/route.ts")[0];
    const auth = par(found, "src/server/auth.ts")[0];
    check("un projet de la 3.4.22 (comptes) : la route et authorize() à réparer ensemble (fix: auto)", route?.fix === "auto" && route.form === "old-route" && auth?.fix === "auto" && auth.form === "users", JSON.stringify(found));
    check("... la connexion et l'inscription aussi", par(found, "src/app/signin/page.tsx")[0]?.fix === "auto" && par(found, "src/app/signup/page.tsx")[0]?.form === "signup", JSON.stringify(found));
    check("... L.filesToWrite : authorize(), la route, les deux formulaires", JSON.stringify(L.filesToWrite(found).sort()) === JSON.stringify(["src/app/api/auth/[...nextauth]/route.ts", "src/app/signin/page.tsx", "src/app/signup/page.tsx", "src/server/auth.ts"]));

    const routeMain = projet("route-main", { extra: { "src/app/api/auth/[...nextauth]/route.ts": fix("route.ts.txt").replace("Réessaie", "Réessayez") } });
    const fm = L.findLoginLimit(routeMain).found;
    check("une route retouchée à la main : manual, et authorize() ne bouge pas sans elle (manual)", par(fm, "src/app/api/auth/[...nextauth]/route.ts")[0]?.fix === "manual" && par(fm, "src/server/auth.ts")[0]?.fix === "manual", JSON.stringify(fm));
    check("... les formulaires restent réparables seuls (fix: auto)", par(fm, "src/app/signin/page.tsx")[0]?.fix === "auto");

    const formMain = projet("form-main", { extra: { "src/app/signin/page.tsx": fix("auth-signin-plain.tsx.txt").replace('toast.error("Email ou mot de passe incorrect.");', 'toast.error("Identifiants refusés.");') } });
    const ff = par(L.findLoginLimit(formMain).found, "src/app/signin/page.tsx")[0];
    check("un formulaire retouché qui rend encore son bouton trop tôt : nommé (manual), jamais réécrit", ff?.fix === "manual" && ff.kind === "form", JSON.stringify(ff));

    const authMain = projet("auth-main", { extra: { "src/server/auth.ts": fix("auth-users.ts.txt").replace("if (!ok) return null;", "if (!ok) return null; // retouche") } });
    const fa = L.findLoginLimit(authMain).found;
    const ra = par(fa, "src/app/api/auth/[...nextauth]/route.ts")[0];
    check("authorize() retouché : la route reste telle quelle (manual), jamais privée de sa limite", ra?.fix === "manual" && /src\/server\/auth\.ts/.test(ra.reason) && !fa.some((f) => f.kind === "authorize" && f.fix === "auto"), JSON.stringify(fa));

    const partage = projet("compteur-partage", { extra: { "src/lib/rate-limit.ts": "export async function checkRateLimit(ip: string): Promise<{ allowed: boolean }> { return { allowed: ip !== \"\" }; }\n" } });
    const fp = L.findLoginLimit(partage).found;
    check("le compteur partagé (asynchrone) : manual, la raison dite", par(fp, "src/app/api/auth/[...nextauth]/route.ts")[0]?.fix === "manual" && /shared counter/.test(par(fp, "src/app/api/auth/[...nextauth]/route.ts")[0].reason), JSON.stringify(fp));

    const deux = projet("deux-etapes", { mode: "2fa" });
    const f2 = L.findLoginLimit(deux).found;
    check("un projet à deux étapes : la route et authorize() (form: 2fa) à réparer", par(f2, "src/app/api/auth/[...nextauth]/route.ts")[0]?.fix === "auto" && par(f2, "src/server/auth.ts")[0]?.form === "2fa", JSON.stringify(f2));

    const mono = projet("mono", { mode: "admin", app: "apps/web" });
    const fmo = L.findLoginLimit(mono).found;
    // The older form of the route, from before the public mirror (found word for word in four of
    // Flavien's projects): recognised for the route only.
    check("la forme d'avant le miroir public est celle que le script reconnaît, à l'octet", lf(fix("route-pre-mirror.ts.txt")) === L.OLD_ROUTE_PRE_MIRROR && L.OLD_ROUTES.length === 2);
    const preMiroir = projet("pre-miroir", { extra: { "src/app/api/auth/[...nextauth]/route.ts": fix("route-pre-mirror.ts.txt") } });
    const fpm = L.findLoginLimit(preMiroir).found;
    check("... avec un authorize() des gabarits : la route et authorize() à réparer (fix: auto)", par(fpm, "src/app/api/auth/[...nextauth]/route.ts")[0]?.fix === "auto" && par(fpm, "src/server/auth.ts")[0]?.fix === "auto", JSON.stringify(fpm));
    const wpm = [];
    L.repairLoginLimit(preMiroir, fpm, { write: (rel, text) => (wpm.push(rel), writeFileSync(join(preMiroir, rel), text)) });
    check("... réparée : la route de cette version, authorize() d'abord", lire(preMiroir, "src/app/api/auth/[...nextauth]/route.ts") === tpl("auth/users/route.ts") && wpm.indexOf("src/server/auth.ts") < wpm.indexOf("src/app/api/auth/[...nextauth]/route.ts"), JSON.stringify(wpm));
    const preConfig = projet("pre-miroir-config", { extra: { "src/app/api/auth/[...nextauth]/route.ts": fix("route-pre-mirror.ts.txt") } });
    rmSync(join(preConfig, "src/server/auth.ts"));
    ecrire(preConfig, "src/server/auth/config.ts", 'import Credentials from "next-auth/providers/credentials";\nexport const p = Credentials({ async authorize(c) { return c ? null : null; } });\n');
    const fpc = L.findLoginLimit(preConfig).found;
    check("... avec un authorize() d'une forme jamais relevée (src/server/auth/config.ts) : la route reste à /security (manual)", par(fpc, "src/app/api/auth/[...nextauth]/route.ts")[0]?.fix === "manual" && !fpc.some((f) => f.fix === "auto" && f.kind !== "form"), JSON.stringify(fpc));
    const relatif = projet("pre-miroir-relatif", { extra: { "src/app/api/auth/[...nextauth]/route.ts": fix("route-pre-mirror.ts.txt").replace('from "~/server/auth"', 'from "../../../../lib/auth"') } });
    check("... la même avec des imports relatifs : jamais réécrite (manual)", par(L.findLoginLimit(relatif).found, "src/app/api/auth/[...nextauth]/route.ts")[0]?.fix === "manual");

    check("un monorepo (apps/web) : ses fichiers, son application", fmo.length === 3 && fmo.every((f) => f.app === "apps/web" && f.fix === "auto"), JSON.stringify(fmo));

    const i18n = projet("traduit", { i18n: true });
    const fi = L.findLoginLimit(i18n).found;
    const si = par(fi, "src/app/[locale]/signin/page.tsx")[0];
    check("un projet traduit : les formulaires réparables, leurs fichiers de messages nommés", si?.fix === "auto" && JSON.stringify(si.messages) === JSON.stringify(["messages/en.json", "messages/fr.json"]), JSON.stringify(fi));
    const i18nAutre = projet("traduit-autrement", { i18n: true });
    writeFileSync(join(i18nAutre, "messages/fr.json"), readFileSync(join(i18nAutre, "messages/fr.json"), "utf8").replace(/\n {2}/g, "\n    "));
    const fia = L.findLoginLimit(i18nAutre).found;
    check("... des messages écrits autrement : le formulaire n'est pas touché (manual), la raison dite", par(fia, "src/app/[locale]/signin/page.tsx")[0]?.fix === "manual" && /messages/.test(par(fia, "src/app/[locale]/signin/page.tsx")[0].reason), JSON.stringify(fia));

    const neuf = join(base, "neuf");
    ecrire(neuf, "package.json", PKG("neuf"));
    ecrire(neuf, "src/lib/rate-limit.ts", RATE);
    ecrire(neuf, "src/app/api/auth/[...nextauth]/route.ts", tpl("auth/users/route.ts"));
    ecrire(neuf, "src/server/auth.ts", tpl("auth/users/auth.ts"));
    ecrire(neuf, "src/app/signin/page.tsx", tpl("auth-signin/plain.tsx"));
    ecrire(neuf, "src/app/signup/page.tsx", tpl("auth-signup/plain.tsx"));
    ecrire(neuf, "src/app/admin/signin/page.tsx", tpl("auth/admin/pages/signin.tsx"));
    ecrire(neuf, "src/server/auth-2fa.ts", tpl("2fa/auth.ts"));
    check("un projet fait par cette version : rien à dire", L.findLoginLimit(neuf).found.length === 0, JSON.stringify(L.findLoginLimit(neuf).found));

    const sans = join(base, "sans-limite");
    ecrire(sans, "package.json", PKG("sans"));
    ecrire(sans, "src/server/auth.ts", 'import Credentials from "next-auth/providers/credentials";\nexport const p = Credentials({ async authorize(c) { return c ? null : null; } });\n');
    const fs0 = L.findLoginLimit(sans).found;
    check("un authorize() qui ne nomme aucune limite, sans route qui compte : à lire (fix: read), pour /security seul", fs0.length === 1 && fs0[0].form === "no-limit" && fs0[0].fix === "read", JSON.stringify(fs0));
    ecrire(sans, "src/server/auth.ts", 'import Credentials from "next-auth/providers/credentials";\nimport { limiteAtteinte } from "./limite";\nexport const p = Credentials({ async authorize(c) { if (limiteAtteinte()) return null; return c ? null : null; } });\n');
    const avecLimite = join(base, "limite-maison");
    ecrire(avecLimite, "package.json", PKG("maison"));
    ecrire(avecLimite, "src/server/auth.ts", 'import Credentials from "next-auth/providers/credentials";\nimport { rateLimitAtteint } from "~/lib/rate-limit";\nexport const p = Credentials({ async authorize(c) { if (rateLimitAtteint("x")) return null; return c ? null : null; } });\n');
    check("... une limite maison (un autre nom) : rien", L.findLoginLimit(avecLimite).found.length === 0);
    const cli = spawnSync(process.execPath, [LL, "--project-dir", p], { encoding: "utf8", windowsHide: true });
    let j = null;
    try {
      j = JSON.parse(cli.stdout);
    } catch {
      j = null;
    }
    check("la commande --project-dir : une ligne JSON, sortie 0, rien d'écrit", cli.status === 0 && j?.ok === true && j.counts.auto === 4 && lire(p, "src/server/auth.ts") === lf(fix("auth-users.ts.txt")), `${cli.stdout}${cli.stderr}`.slice(0, 300));
    const absent = spawnSync(process.execPath, [LL, "--project-dir", join(base, "n-existe-pas")], { encoding: "utf8", windowsHide: true });
    check("... un dossier qui n'existe pas : ok false, sortie 1", absent.status === 1 && /"ok":false/.test(absent.stdout));
  }

  console.log("\n── La réparation, par repair-admin-gate.mjs --login-limit ──");
  {
    const p = projet("r-users");
    const sans = R.diagnose(p, { git: true });
    check("sans --login-limit (le texte de la 3.4.22, qui lance ce script juste après l'installation) : dit, hors de needed", sans.needed === false && sans.counts.login === 4 && sans.loginLimit.length === 4, JSON.stringify({ n: sans.needed, c: sans.counts }));
    const avantSans = lire(p, "src/server/auth.ts") + lire(p, "src/app/api/auth/[...nextauth]/route.ts");
    const rSans = R.repair(p);
    check("... et --write sans --login-limit n'écrit rien de la connexion", rSans.written === false && lire(p, "src/server/auth.ts") + lire(p, "src/app/api/auth/[...nextauth]/route.ts") === avantSans, JSON.stringify(rSans));
    // The first pass after installing 3.4.23 runs this script from the text of 3.4.22: a project with
    // something else to repair (here, the old rule of its CLAUDE.md) AND the old sign-in. Without
    // --login-limit, the rule is repaired as that text announces, and the sign-in left as it is.
    const premier = projet("r-premier-passage", { extra: { "CLAUDE.md": `# Projet\n\n## Conventions\n${R.RULES.admin.en.old}\n` } });
    const rPremier = R.repair(premier);
    check("le texte de la 3.4.22 (sans --login-limit) : la règle réparée, aucun fichier de la connexion touché", rPremier.ok === true && rPremier.commit.includes("CLAUDE.md") && !rPremier.commit.some((f) => f !== "CLAUDE.md") && lire(premier, "src/server/auth.ts") === lf(fix("auth-users.ts.txt")) && lire(premier, "src/app/signin/page.tsx") === lf(fix("auth-signin-plain.tsx.txt")).replace("{{FORGOT_PASSWORD_LINK}}", "<span></span>") && !rPremier.remaining.some((x) => x.kind === "login-limit"), JSON.stringify(rPremier).slice(0, 400));
    const avec = R.diagnose(p, { git: true, withLoginLimit: true });
    check("avec --login-limit : compté dans needed (counts.login)", avec.needed === true && avec.counts.login === 4);
    check("... hors d'un dépôt : uncommitted null (inconnu), jamais [] (propre)", avec.uncommitted === null, JSON.stringify(avec.uncommitted));
    const r = R.repair(p, { withLoginLimit: true });
    check("la réparation : authorize(), la route, la connexion et l'inscription deviennent les gabarits de cette version, à l'octet", r.ok === true && lire(p, "src/server/auth.ts") === tpl("auth/users/auth.ts") && lire(p, "src/app/api/auth/[...nextauth]/route.ts") === tpl("auth/users/route.ts") && lire(p, "src/app/signin/page.tsx") === tpl("auth-signin/plain.tsx").replace("{{FORGOT_PASSWORD_LINK}}", "<span></span>") && lire(p, "src/app/signup/page.tsx") === tpl("auth-signup/plain.tsx"), JSON.stringify(r).slice(0, 400));
    check("... authorize() écrit avant la route (commit, loginLimit)", r.commit.indexOf("src/server/auth.ts") >= 0 && r.commit.indexOf("src/server/auth.ts") < r.commit.indexOf("src/app/api/auth/[...nextauth]/route.ts") && r.loginLimit.length === 4, JSON.stringify(r.commit));
    const encore = R.repair(p, { withLoginLimit: true });
    check("... relancée : plus rien à réparer, rien d'écrit", encore.written === false && R.diagnose(p, { withLoginLimit: true }).counts.login === 0, JSON.stringify(encore));

    const main = projet("r-route-main", { extra: { "src/app/api/auth/[...nextauth]/route.ts": fix("route.ts.txt").replace("Réessaie", "Réessayez") } });
    const avantRoute = lire(main, "src/app/api/auth/[...nextauth]/route.ts");
    const rm = R.repair(main, { withLoginLimit: true });
    check("une route retouchée : ni elle ni authorize() touchés, les formulaires réparés", rm.ok === true && lire(main, "src/app/api/auth/[...nextauth]/route.ts") === avantRoute && lire(main, "src/server/auth.ts") === lf(fix("auth-users.ts.txt")) && lire(main, "src/app/signin/page.tsx").includes(".finally(() => setPending(false))"), JSON.stringify(rm).slice(0, 300));
    check("... la route et authorize() renvoyés à /security (remaining, kind: login-limit)", rm.remaining.filter((x) => x.kind === "login-limit" && /\/security/.test(x.reason)).length === 2, JSON.stringify(rm.remaining));

    const t = projet("r-traduit", { i18n: true });
    const rt = R.repair(t, { withLoginLimit: true });
    const fr = JSON.parse(lire(t, "messages/fr.json"));
    const en = JSON.parse(lire(t, "messages/en.json"));
    check("un projet traduit : les formulaires deviennent les gabarits traduits, à l'octet", rt.ok === true && lire(t, "src/app/[locale]/signin/page.tsx") === tpl("auth-signin/i18n.tsx").replace("{{FORGOT_PASSWORD_LINK}}", "<span></span>") && lire(t, "src/app/[locale]/signup/page.tsx") === tpl("auth-signup/i18n.tsx"), JSON.stringify(rt).slice(0, 300));
    check("... les messages fr et en reçoivent la phrase des gabarits, le reste intact", fr.signin.errorTooManyAttempts === JSON.parse(tpl("auth-signin/messages-fr.json")).signin.errorTooManyAttempts && en.signup.errorTooManyAttempts === JSON.parse(tpl("auth-signup/messages-en.json")).signup.errorTooManyAttempts && fr.common.hello === "Bonjour" && rt.commit.includes("messages/fr.json"), JSON.stringify(rt.commit));

    // The page of 3.4.18 with both flags: the return address AND the sign-in, the template of today.
    const vieille = join(base, "r-3418");
    ecrire(vieille, "package.json", PKG("r-3418"));
    ecrire(vieille, "src/lib/rate-limit.ts", RATE);
    ecrire(vieille, "src/app/api/auth/[...nextauth]/route.ts", fix("route.ts.txt"));
    ecrire(vieille, "src/server/auth.ts", fix("auth-admin.ts.txt"));
    ecrire(vieille, "src/app/admin/signin/page.tsx", readFileSync(join(ROOT, "scripts/tests/fixtures/redirect-3418/admin-signin.tsx.txt"), "utf8"));
    const rv = R.repair(vieille, { withRedirects: true, withLoginLimit: true });
    check("la page de connexion de la 3.4.18, --redirects et --login-limit : le gabarit de cette version, à l'octet", rv.ok === true && lire(vieille, "src/app/admin/signin/page.tsx") === tpl("auth/admin/pages/signin.tsx") && lire(vieille, "src/server/auth.ts") === tpl("auth/admin/auth.ts"), JSON.stringify(rv).slice(0, 300));

    // In a repository: the files that already hold work not committed are named; CRLF kept.
    const sansCrochets = join(base, "sans-crochets");
    mkdirSync(sansCrochets, { recursive: true });
    const g = (cwd, ...args) => execFileSync("git", ["-c", `core.hooksPath=${sansCrochets}`, "-c", "commit.gpgsign=false", "-c", "user.name=Recette", "-c", "user.email=recette@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const d = projet("r-depot");
    for (const rel of ["src/app/signin/page.tsx", "src/server/auth.ts"]) writeFileSync(join(d, rel), lire(d, rel).replace(/\n/g, "\r\n"));
    g(d, "init", "-q");
    g(d, "add", "-A");
    g(d, "commit", "-q", "--no-verify", "-m", "Projet");
    writeFileSync(join(d, "src/app/signin/page.tsx"), `${readFileSync(join(d, "src/app/signin/page.tsx"), "utf8")}// en cours\r\n`);
    const dd = R.diagnose(d, { git: true, withLoginLimit: true });
    check("dans un dépôt : le formulaire qui porte du travail non enregistré est nommé (uncommitted)", JSON.stringify(dd.uncommitted) === JSON.stringify(["src/app/signin/page.tsx"]), JSON.stringify(dd.uncommitted));
    const rd = R.repair(d, { withLoginLimit: true });
    const signin = readFileSync(join(d, "src/app/signin/page.tsx"), "utf8");
    check("... la réparation le redit (uncommittedBefore), garde le CRLF et le travail en cours", JSON.stringify(rd.uncommittedBefore) === JSON.stringify(["src/app/signin/page.tsx"]) && signin === `${tpl("auth-signin/plain.tsx").replace("{{FORGOT_PASSWORD_LINK}}", "<span></span>").replace(/\n/g, "\r\n")}// en cours\r\n`, JSON.stringify(rd.uncommittedBefore));
    check("... et authorize() reste en CRLF", readFileSync(join(d, "src/server/auth.ts"), "utf8") === tpl("auth/users/auth.ts").replace(/\n/g, "\r\n"));

    // Something changed between the diagnosis and the repair: the route never goes alone.
    const course = projet("r-course");
    const trouve = L.findLoginLimit(course).found;
    writeFileSync(join(course, "src/server/auth.ts"), `${lire(course, "src/server/auth.ts")}// retouché entre-temps\n`.replace("if (!ok) return null;", "if (!ok) return null; // x"));
    const ecrits = [];
    const rc = L.repairLoginLimit(course, trouve, { write: (rel, text) => (ecrits.push(rel), writeFileSync(join(course, rel), text)) });
    check("authorize() retouché entre le diagnostic et la réparation : la route laissée avec sa limite, dite", !ecrits.includes("src/app/api/auth/[...nextauth]/route.ts") && lf(readFileSync(join(course, "src/app/api/auth/[...nextauth]/route.ts"), "utf8")) === L.OLD_ROUTE && rc.left.some((l) => /route/.test(l.file) && /authorize/.test(l.reason)), JSON.stringify(rc));

    // The scan and the command.
    const sc = projet("r-scan");
    g(sc, "init", "-q");
    const profil = join(base, "profil-vide");
    mkdirSync(profil, { recursive: true });
    const s1 = R.scan({ cwd: sc, home: profil, withLoginLimit: true });
    const s0 = R.scan({ cwd: sc, home: profil });
    const ligne0 = (s0.projects ?? []).find((x) => /r-scan/.test(x.dir));
    check("le scan avec --login-limit compte dans needed un projet qui n'a que la connexion à réparer", s1.needed === 1 && s1.projects[0].counts?.login === 4 && s1.loginLimit === 1, JSON.stringify({ n: s1.needed, l: s1.loginLimit }));
    check("... sans le drapeau : hors de needed, mais ses fichiers nommés pour que la mise à jour le dise", s0.needed === 0 && s0.loginLimit === 1 && ligne0?.loginLimit?.length === 4, JSON.stringify(ligne0));
    const sw = spawnSync(process.execPath, [RAG, "--scan", "--write", "--login-limit"], { encoding: "utf8", windowsHide: true });
    check("--scan n'écrit jamais, même avec --write", sw.status === 1 && /never writes/.test(sw.stdout));
    const c = projet("r-cli", { mode: "admin" });
    const w = spawnSync(process.execPath, [RAG, "--project-dir", c, "--write", "--redirects", "--login-limit"], { encoding: "utf8", windowsHide: true });
    check("la commande : --project-dir <dossier> --write --redirects --login-limit répare, sortie 0", w.status === 0 && lire(c, "src/server/auth.ts") === tpl("auth/admin/auth.ts") && lire(c, "src/app/admin/signin/page.tsx") === tpl("auth/admin/pages/signin.tsx"), `${w.stdout}${w.stderr}`.slice(0, 300));
    const dc = spawnSync(process.execPath, [RAG, "--project-dir", projet("r-cli-lecture"), "--login-limit"], { encoding: "utf8", windowsHide: true });
    check("... sans --write : le diagnostic, rien d'écrit", dc.status === 0 && JSON.parse(dc.stdout).counts.login === 4 && lire(join(base, "r-cli-lecture"), "src/server/auth.ts") === lf(fix("auth-users.ts.txt")));
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

// ─── 4. What the skills say ───────────────────────────────────────────────────
console.log("\n── Ce que disent la mise à jour et /security ──");
{
  const read = (rel) => (existsSync(join(ROOT, rel)) ? lf(readFileSync(join(ROOT, rel), "utf8")) : "");
  const solo = read("skills/update-hypervibe/SKILL.md");
  const collab = read("skills/update-hypervibe-enterprise/SKILL.md");
  const u = solo || collab;
  const calls = [...u.matchAll(/repair-admin-gate\.mjs" (--scan --cwd "\$\(pwd\)"[^`\n]*|--project-dir "<[^"]+>"[^`\n]*)/g)].map((m) => m[0]);
  check("la mise à jour : chaque appel du script porte --redirects --login-limit", calls.length >= 3 && calls.every((c) => /--redirects --login-limit/.test(c)), JSON.stringify(calls));
  check("... le scan aussi", /--scan --cwd "\$\(pwd\)" --redirects --login-limit/.test(u));
  if (solo) {
    check("... le troisième défaut annoncé (la connexion figée), réparé dans le même passage, la route jamais avant authorize()", /The same pass repairs a third defect/.test(solo) && /the route never loses its limit before `authorize\(\)` has it/.test(solo));
    check("... compté dans la liste (counts.login), dit en une phrase, les entrées manual renvoyées à /security", /when `counts\.login` is above 0/.test(solo) && /the sign-in button freezes and says nothing/.test(solo) && /`kind: "login-limit"`/.test(solo) && /\*\*The limit on sign-in attempts\*\* \(`loginLimit`/.test(solo));
    const doc = read("skills/update-hypervibe/DOC.md");
    const docFr = read("skills/update-hypervibe/DOC.fr.md");
    check("... et les pages DOC le disent", /repairs the sign-in that froze after five failed attempts/.test(doc) && /répare la connexion qui se figeait après cinq essais manqués/.test(docFr));
  } else {
    check("... le troisième défaut annoncé (la connexion figée), réparé dans le même passage, la route jamais avant authorize()", /Le même passage répare un troisième défaut/.test(collab) && /la route ne perd jamais sa limite avant qu'`authorize\(\)` l'ait/.test(collab));
    check("... compté dans la liste (counts.login), dit en une phrase, les entrées manual renvoyées à /security", /quand `counts\.login` dépasse 0/.test(collab) && /le bouton de connexion se fige sans rien dire/.test(collab) && /`kind: "login-limit"`/.test(collab) && /\*\*La limite des tentatives de connexion\*\* \(`loginLimit`/.test(collab));
  }
  const sec = read("skills/security/SKILL.md");
  check("/security lance le lecteur de la limite de connexion", /scripts\/login-limit\.mjs" --project-dir </.test(sec));
  check("... la route qui répond elle-même (old-route) est une trouvaille 🟠, le formulaire qui rend le bouton trop tôt 🟡", /`route` \(`form: "old-route"`\)[^\n]*🟠/.test(sec) && /`form` \(`form: "signin"`\)[^\n]*🟡/.test(sec));
  check("... et la correction : la limite dans authorize() (TooManyAttempts), jamais la route seule, le formulaire qui lit le code et rend son bouton", /class TooManyAttempts extends CredentialsSignin/.test(sec) && /Never the route alone|Jamais la route seule/.test(sec) && /\.finally\(\(\) => setPending\(false\)\)/.test(sec) && /res\?\.code === "too_many_attempts"/.test(sec));
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
