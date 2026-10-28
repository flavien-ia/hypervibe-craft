#!/usr/bin/env node
// test-template-guards.mjs - Ce que les gabarits laissent passer d'une adresse venue d'ailleurs.
//
// Trois défauts de la même famille, corrigés en 3.3.11 (le premier repris en 3.4.19), tenus ici :
//   - une adresse de retour lue dans l'URL (`callbackUrl`) partait telle quelle dans le routeur
//     après la connexion : `javascript:...` y est exécuté, `//hote` mène ailleurs ;
//   - le lien d'une notification (cloche, notification système) était suivi tel quel ;
//   - l'adresse d'un abonnement aux notifications, déclarée par le navigateur donc par
//     l'utilisateur, était acceptée quelle qu'elle soit, et le serveur y écrivait ensuite.
// Et un quatrième, d'une autre famille : la commande Stripe qui liste les profils affichait la
// clé de test en clair quand une skill la lançait sans filtre.
//
// Les règles sont LUES dans les gabarits (le filtre tel qu'il est écrit, la liste telle qu'elle
// est écrite), puis jouées sur des adresses. Aucun réseau, aucun compte.
//
//   node scripts/tests/test-template-guards.mjs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lire = (rel) => readFileSync(join(ROOT, rel), "utf8");

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 500)})`}`);
}

// ── 1. Un chemin de ce site, et rien d'autre ──
// 3.4.19 : le filtre d'avant (un `/` en tête, ni `/` ni `\` derrière, un motif sur le texte brut)
// laissait passer `/\t/evil.com` : le navigateur retire tabulations et retours à la ligne avant de
// lire une adresse, et en fait `//evil.com`, un autre site (signalé le 28/10/2026). Chaque gabarit lit
// désormais l'adresse par le lecteur d'adresses (`new URL`) dans une fonction à lui, `internalPath`.
// Cette fonction est TIRÉE du texte de chaque gabarit, ses annotations de type retirées, puis jouée
// avec le lecteur d'adresses de Node (celui des navigateurs, WHATWG) : rien n'est recopié ici.
const ORIGINE = "https://site.exemple";
const INTERNES = ["/", "/admin", "/admin/commandes?page=2", "/admin/clients?tri=nom&page=3#liste", "/a/b#c"];
const AILLEURS = [
  "/\t/evil.com",
  new URLSearchParams("callbackUrl=/%09/evil.com").get("callbackUrl"),
  new URLSearchParams("callbackUrl=/%0A/evil.com").get("callbackUrl"),
  new URLSearchParams("callbackUrl=/%0D/evil.com").get("callbackUrl"),
  "/\n/evil.com",
  "/\r/evil.com",
  "/\r\n/evil.com",
  "\t//evil.com",
  " //evil.com",
  "//evil.com",
  "///evil.com",
  "/\\evil.com",
  "\\\\evil.com",
  "/\t\\evil.com",
  "/.//evil.com",
  "/a/..//evil.com",
  "/./\\evil.com",
  `${ORIGINE}//evil.com`,
  "https://evil.com",
  "http://evil.com",
  "http:evil.com",
  "HTTPS://evil.com",
  "https://site.exemple.evil.com/",
  "https://site.exemple@evil.com/",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "\tjavascript:alert(1)",
  "java\tscript:alert(1)",
  "data:text/html,x",
  "https://ex ample.com/",
  "http://[::1",
  "",
];

/**
 * La fonction `internalPath` telle que le gabarit l'écrit, ses seules annotations de type retirées
 * (sa signature), compilée avec `global` (window ou self) pour seul monde. null si elle manque ou ne
 * se lit pas.
 */
function fonctionDe(source, global) {
  const at = source.indexOf("function internalPath(");
  if (at < 0) return null;
  const finParams = source.indexOf(")", at);
  const ouvre = source.indexOf("{", finParams);
  if (finParams < 0 || ouvre < 0) return null;
  let profondeur = 0;
  let ferme = -1;
  for (let i = ouvre; i < source.length; i += 1) {
    if (source[i] === "{") profondeur += 1;
    else if (source[i] === "}") {
      profondeur -= 1;
      if (profondeur === 0) {
        ferme = i;
        break;
      }
    }
  }
  if (ferme < 0) return null;
  const signature = source.slice(at, ouvre);
  if (!/^function internalPath\(raw: string \| null \| undefined\): string \| null\s*$/.test(signature)) return null;
  const corps = source.slice(ouvre, ferme + 1);
  try {
    return { corps, f: new Function(global, `return function internalPath(raw) ${corps};`)({ location: { origin: ORIGINE } }) };
  } catch {
    return null;
  }
}

/** Ce qu'une navigation vers `chemin` atteint, lu comme un navigateur le lit depuis ce site. */
const atteint = (chemin) => new URL(chemin, `${ORIGINE}/admin/signin`).origin;

// Toutes les adresses faites de quelques morceaux piégés suivis d'un hôte : aucune ne doit sortir du site.
const MORCEAUX = ["/", "\\", "\t", "\n", "\r", " ", ".", "..", "%2F", "%5C", "%09", ":", "@", "?", "#", "http:", "https:", "javascript:"];
const FUZZ = [];
for (const a of MORCEAUX) {
  FUZZ.push(`${a}evil.com`);
  for (const b of MORCEAUX) {
    FUZZ.push(`${a}${b}evil.com`);
    for (const c of MORCEAUX) FUZZ.push(`${a}${b}${c}evil.com`);
  }
}

const GABARITS = [
  ["templates/auth/admin/pages/signin.tsx", "window", "la connexion de l'admin", "/admin"],
  ["templates/2fa/signin-page.tsx", "window", "la connexion à deux facteurs", "/admin"],
  ["templates/auth-signin/plain.tsx", "window", "la connexion des membres", "/dashboard"],
  ["templates/auth-signin/i18n.tsx", "window", "la connexion des membres (traduite)", "/dashboard"],
  ["templates/notif-center/notification-bell.tsx", "window", "la cloche", null],
  ["templates/push/sw-push-handlers.ts", "self", "le clic sur une notification système", null],
];
const corps = new Set();
for (const [fichier, global, quoi, repli] of GABARITS) {
  if (!existsSync(join(ROOT, fichier))) {
    check(`${quoi} : le gabarit existe (${fichier})`, false);
    continue;
  }
  const source = lire(fichier);
  const lue = fonctionDe(source, global);
  check(`${quoi} : l'adresse passe par internalPath, lue dans le gabarit et jouée`, lue !== null, fichier);
  if (!lue) continue;
  corps.add(lue.corps.replace(/\b(window|self)\.location/g, "LIEU.location"));
  // Une adresse que le lecteur refuse (un hôte invalide) lève une exception : la fonction la rattrape
  // et rend null. Une exception qui sort d'elle est comptée comme une réponse fausse, et dite.
  const internalPath = (a) => {
    try {
      return lue.f(a);
    } catch (e) {
      return `EXCEPTION ${e?.code ?? e?.message ?? e}`;
    }
  };
  const passees = AILLEURS.filter((a) => internalPath(a) !== null);
  check(`${quoi} : aucune adresse d'ailleurs ne passe (tabulation, retour à la ligne, //, \\, /.//, javascript:, un autre site, un hôte invalide, vide)`, passees.length === 0, JSON.stringify(passees.map((a) => [a, internalPath(a)])));
  const abimes = INTERNES.filter((a) => internalPath(a) !== a);
  check(`${quoi} : un chemin de ce site passe intact, paramètres et ancre compris`, abimes.length === 0, JSON.stringify(abimes.map((a) => [a, internalPath(a)])));
  check(`${quoi} : l'adresse complète de ce site se ramène à son chemin`, internalPath(`${ORIGINE}/admin/clients?x=1#y`) === "/admin/clients?x=1#y");
  const sorties = FUZZ.filter((a) => {
    const r = internalPath(a);
    return r !== null && (!r.startsWith("/") || r.startsWith("//") || atteint(r) !== ORIGINE);
  });
  check(`${quoi} : ${FUZZ.length} adresses piégées, aucune ne mène hors du site`, sorties.length === 0, JSON.stringify(sorties.slice(0, 8).map((a) => [a, internalPath(a)])));
  check(`${quoi} : plus aucun motif sur le texte brut`, !source.includes("/^\\/(?![") && !/\.test\((raw|rawCallback|n\.url)\)/.test(source), fichier);
  // L'appel : ce que la page ou le clic fait de la réponse.
  if (repli) {
    const appel = new RegExp(`const callbackUrl = (internalPath\\(params\\.get\\("callbackUrl"\\)\\) \\?\\? "${repli.replace(/\//g, "\\/")}");`).exec(source);
    check(`${quoi} : callbackUrl vient de internalPath, avec ${repli} à défaut, et c'est lui que suit le routeur`, appel !== null && /router\.push\(callbackUrl\)/.test(source), fichier);
    if (appel) {
      const joue = (lien) => new Function("internalPath", "params", `return ${appel[1]};`)(internalPath, new URLSearchParams(lien));
      check(`${quoi} : ?callbackUrl=/%09/evil.com (décodé par searchParams.get) ramène à ${repli}`, joue("callbackUrl=/%09/evil.com") === repli && joue("callbackUrl=%2F%0A%2Fevil.com") === repli && joue("") === repli && joue("callbackUrl=") === repli);
      check(`${quoi} : ?callbackUrl=/admin/clients%3Fpage%3D2 est suivi tel quel`, joue("callbackUrl=%2Fadmin%2Fclients%3Fpage%3D2%23liste") === "/admin/clients?page=2#liste");
    }
  }
}
check("la même fonction dans tous les gabarits (seul window ou self change)", corps.size === 1, `${corps.size} versions`);
{
  const cloche = lire("templates/notif-center/notification-bell.tsx");
  check("la cloche ne suit le lien que s'il est un chemin de ce site, et rien d'autre", /const lien = internalPath\(n\.url\);\s*\n\s*if \(lien\) window\.location\.assign\(lien\);/.test(cloche) && (cloche.match(/location\.assign\(/g) ?? []).length === 1);
  const sw = lire("templates/push/sw-push-handlers.ts");
  check("le clic sur une notification système ouvre le chemin de ce site, l'accueil sinon", /const url = internalPath\(\(event\.notification\.data as \{ url\?: string \}\)\?\.url\) \?\? "\/";/.test(sw) && /navigate\(url\)/.test(sw) && /openWindow\(url\)/.test(sw));
}
// Aucun gabarit ni aucune skill ne garde l'ancien filtre, ni ne le propose en correctif.
{
  const restes = [];
  const parcours = (rel) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) parcours(p);
      else if (e.isFile()) {
        const t = readFileSync(join(ROOT, p), "utf8");
        if (t.includes("/^\\/(?![") || /rawCallback && \/\^/.test(t)) restes.push(p);
      }
    }
  };
  for (const rel of ["templates", "skills"]) if (existsSync(join(ROOT, rel))) parcours(rel);
  check("aucun gabarit ni aucune skill ne contient plus l'ancien filtre (un motif sur le texte brut de l'adresse)", restes.length === 0, restes.join(", "));
}

// ── 2. L'adresse d'un abonnement : un service de notification connu ──
{
  const src = lire("templates/push/server-push.ts");
  const liste = /const PUSH_SERVICE_HOSTS = \[([\s\S]*?)\];/.exec(src);
  const hotes = liste ? [...liste[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  check("la liste des services est lisible dans le gabarit", hotes.length >= 4, src.slice(0, 200));
  // La règle écrite dans le gabarit, rejouée ici sur la liste lue.
  const regle = /url\.protocol !== "https:" \|\| url\.port \|\| url\.username \|\| url\.password/.test(src) && /host === known \|\| host\.endsWith\(`\.\$\{known\}`\)/.test(src);
  check("la règle : https, sans port ni identifiants, l'hôte ou l'un de ses sous-domaines", regle);
  const accepte = (endpoint) => {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
      const host = url.hostname.toLowerCase();
      return hotes.some((known) => host === known || host.endsWith(`.${known}`));
    } catch {
      return false;
    }
  };
  const VRAIS = [
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://jmt17.google.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QabcDEF",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ];
  const FAUX = [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.exemple.invalid/fcm/send/abc",
    "https://exemple.invalid/fcm.googleapis.com",
    "https://notify.windows.com.exemple.invalid/w/",
    "https://faux-notify.windows.com.exemple.invalid/",
    "https://169.254.169.254/latest/meta-data/",
    "https://localhost/",
    "http://127.0.0.1:3000/api",
    "pas une adresse",
  ];
  check("les adresses des navigateurs passent (Chrome, Chrome en préversion, Firefox, Safari, Edge)", VRAIS.every(accepte), JSON.stringify(VRAIS.filter((v) => !accepte(v))));
  check("rien d'autre ne passe (http, un port, des identifiants, un hôte qui imite, une adresse interne)", !FAUX.some(accepte), JSON.stringify(FAUX.filter(accepte)));
  const routeur = lire("templates/push/push-router.ts");
  check("l'inscription refuse une adresse qui n'est pas celle d'un service", /\.refine\(isPushServiceEndpoint,/.test(routeur) && /import \{ isPushServiceEndpoint \} from "~\/server\/push"/.test(routeur));
  check("l'envoi saute une adresse enregistrée avant la liste", /if \(!isPushServiceEndpoint\(s\.endpoint\)\) continue;/.test(src));
  const securite = lire("skills/security/SKILL.md");
  check("/security nomme les mêmes services que le gabarit", hotes.every((h) => securite.includes(`\`${h}\``)), hotes.filter((h) => !securite.includes(`\`${h}\``)).join(", "));
}

// ── 3. Stripe : le gabarit et les commandes ──
{
  const gabarit = lire("scripts/setup-stripe.mjs");
  check("le gabarit de paiement ne passe plus payment_method_types (retiré des types en stripe 23)", !/^\s*payment_method_types\s*:/m.test(gabarit));
  const skill = lire("skills/add-stripe/SKILL.md");
  check("/add-stripe installe stripe épinglé sur sa version majeure", /pnpm add stripe@\^23\b/.test(skill) && !/pnpm add stripe(\s|`|$)/m.test(skill));

  // `stripe config --list` écrit la clé de test en clair : aucune skill ne le lance sans filtre.
  const nus = [];
  const skillsDir = join(ROOT, "skills");
  for (const nom of readdirSync(skillsDir)) {
    const f = join(skillsDir, nom, "SKILL.md");
    if (!existsSync(f)) continue;
    readFileSync(f, "utf8")
      .split(/\r?\n/)
      .forEach((ligne, i) => {
        if (!/stripe config --list/.test(ligne)) return;
        // Une commande à lancer (pas une phrase qui la nomme pour l'interdire) : elle est filtrée.
        const commande = /^\s*(stripe config --list|[A-Z_]+=\$\(stripe config --list)/.test(ligne) || /^\s*```/.test(ligne);
        const filtree = /stripe config --list[^|\n]*\|\s*grep -E/.test(ligne);
        if (commande && !filtree) nus.push(`${nom}:${i + 1}`);
      });
  }
  check("aucune skill ne lance `stripe config --list` sans filtrer ce qu'il affiche", nus.length === 0, nus.join(", "));
  check("/add-stripe ne lit du profil que le nom du compte et son identifiant", /stripe config --list 2>\/dev\/null \| grep -E '[^']*display_name\|account_id/.test(skill));
  const commandes = skill.split(/\r?\n/).filter((l) => /^\s*stripe (listen|trigger|products|prices|webhook_endpoints)\b/.test(l));
  const sansProfil = commandes.filter((l) => !l.includes("<STRIPE_PROFILE>"));
  check("chaque commande Stripe de /add-stripe porte le profil du projet", commandes.length >= 3 && sansProfil.length === 0, sansProfil.join(" | "));
}

console.log(`\n${checks - failures}/${checks} verifications`);
process.exitCode = failures ? 1 : 0;
