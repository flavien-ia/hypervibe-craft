#!/usr/bin/env node
// test-skill-texts.mjs - What some skills promise in their own text, where no script carries it
// (3.4.13): the Vercel request logs of CLI 64 in /optimize, the cumulative refunds of Stripe in
// /security, Brevo's records published by their script in _dns-brevo, the sender checked through
// Brevo's API and the contact router left out when it is not wanted in /add-email, the relay of the
// sending domain and the contact router put in place by _create-contact-page. Reads files only.
//
//   node scripts/tests/test-skill-texts.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let checks = 0;
let failures = 0;
function check(label, ok) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
}

const optimize = read("skills/optimize/SKILL.md");
check("/optimize lit les requêtes par `vercel logs requests` (CLI 64), et pagine par --next", /`vercel logs requests --json --since <start> --until <end> --limit <n>`/.test(optimize) && /--next <the summary's next value>/.test(optimize));
check("... laisse de côté la ligne de résumé, et dit que ces journaux ne servent que les projets d'une équipe", /summary line that is not a request/.test(optimize) && /owned by a team/.test(optimize));
check("... et garde la forme d'avant la 64", /Below 64 \(`vercel --version`\)/.test(optimize));

const security = read("skills/security/SKILL.md");
const k = security.slice(security.indexOf("### 1k"), security.indexOf("### 1l"));
check("/security 1k : le montant cumulé de charge.refunded, rendu en trop à chaque remboursement partiel", /\*\*Refunds and cumulative amounts\*\*/.test(k) && /`amount_refunded` is the total refunded so far/.test(k) && /🔴 Critical when money or credit is given back/.test(k));
check("... et la voie juste : l'écart avec ce qui a déjà été rendu, ou chaque remboursement une seule fois", /only the difference with what was already given back/.test(k) && /`refund\.created`/.test(k));

const brevo = read("skills/_dns-brevo/SKILL.md");
check("_dns-brevo passe par son script, et n'écrit plus ses enregistrements à la main", /brevo-domain\.mjs/.test(brevo) && /node "\$BD" publish <domain>/.test(brevo) && !/"type":\\?"TXT\\?",\\?"name/.test(brevo) && !/three TXT records/.test(brevo));
check("... un DMARC déjà là gardé tel quel, jamais un second, jamais une politique plus stricte avant un test réussi", /never a second one/.test(brevo) && /at `p=none`/.test(brevo) && /Never before\./.test(brevo));
check("... finit par un vrai message, lu dans ses en-têtes d'authentification", /node "\$BD" test <domain> --from/.test(brevo) && /`dkim=pass` with `header\.d=<domain>`/.test(brevo) && /permerror/.test(brevo));
check("... et pose l'expéditeur dans BREVO_SENDER_EMAIL sans écraser celui du projet, plus dans CONTACT_EMAIL", /BREVO_SENDER_EMAIL/.test(brevo) && /Never overwrite it/.test(brevo) && !/CONTACT_EMAIL=contact@/.test(brevo));

const email = read("skills/add-email/SKILL.md");
check("/add-email vérifie l'expéditeur par l'API de Brevo au lieu de renvoyer au tableau de bord", /brevo-domain\.mjs" sender <sender-email>/.test(email) && !/must be \*\*verified\*\* in the Brevo dashboard/.test(email));
check("... passe --no-contact-router quand l'envoi n'est pas pour un formulaire, et ne propose pas la page alors", /--no-contact-router/.test(email) && /skipped:no-rate-limit/.test(email));

const contact = read("skills/_create-contact-page/SKILL.md");
check("_create-contact-page lit le relais du domaine d'envoi avant de proposer un destinataire", /domain-mx\.mjs" <sender's domain>/.test(contact) && /no default on that domain/.test(contact));
check("... et pose le routeur de contact s'il manque, par le seul mode qui ne fait que ça", /--contact-router-only/.test(contact));

// /security, 3.4.17: the admin pages protected by their layout only (audit of 26/10/2026), the server
// actions, the data a client module carries, costly work behind an open door, an old site's
// X-XSS-Protection, the 2026 advisories and the versions to ask for, a form that emails the address it
// was given, the incoming email an agent trusts, router.push on Next.js 15.5, and four levels.
{
  const s = security;
  const section = (a, b) => s.slice(s.indexOf(a), b ? s.indexOf(b) : undefined);
  const b = section("### 1b", "### 1c");
  check("/security : quatre niveaux, 🟠 et 🟡 en plus de 🔴 et ✅, dans la légende et dans le rapport", /- 🟡 To improve/.test(s) && /- 🟠 Important/.test(s) && /> 🟠 \*\*Important \(X points\)\*\*/.test(s) && /> 🟡 \*\*To improve \(X points\)\*\*/.test(s) && !/> ⚠️ \*\*To improve/.test(s));
  check("... chaque point vaut pour un projet créé avant sa règle", /Every point applies to a project made before its rule existed/.test(s));
  check("/security 1b : le contrôle posé dans le seul layout, 🔴, page par page", /\*\*Access check placed in a layout only\*\*/.test(b) && /is 🔴, even when the layout checks/.test(b));
  check("... avec la preuve sans risque (la taille d'une 307 sans cookie), sans rien recopier", b.includes('curl -s -o /dev/null -w "%{http_code} %{size_download}\\n" https://<site>/admin/<page>') && /Never copy what comes back into the report/.test(b));
  check("... et le correctif : requireAdmin() en première ligne de chaque page, le middleware en première barrière", /`await requireAdmin\(\)` on the first line of every page/.test(b) && /a middleware as a first barrier/.test(b));
  check("/security 1b : les actions \"use server\" sans contrôle, 🟠 quand elles écrivent, 🟡 sinon, la connexion exceptée", /\*\*Server actions without a check\*\*/.test(b) && /🟠 when it writes, deletes, sends or purges a cache/.test(b) && /🟡 when it only reads/.test(b) && /sign-in action itself is public/.test(b));
  check("/security 1b : les données d'un module importé par un composant client, import \"server-only\"", /\*\*Personal data in a module that a client component imports\*\*/.test(b) && /import "server-only"/.test(b));
  check("/security 1b : un traitement coûteux sans session ni secret, 🔴", /\*\*Costly work behind an open door\*\*/.test(b) && /Without either: 🔴/.test(b));
  const e = section("### 1e", "### 1f");
  check("/security 1e : X-XSS-Protection cherché aussi dans ce que le site envoie, 🟡 (les sites anciens)", /curl -sI https:\/\/<site>\/ \| grep -i x-xss-protection/.test(e) && /flag it 🟡/.test(e));
  const g = section("### 1g", "### 1h");
  check("/security 1g : les avis de 2026 sur l'optimiseur d'images (SVG jusqu'à 15.5.27 et 16.4.0, AVIF avant 15.5.24)", /GHSA-2464-fhr4-w9xw/.test(g) && /up to 15\.5\.27 and from 16\.0\.0 to 16\.4\.0/.test(g) && /GHSA-2xp9-vwfh-vxw4/.test(g) && /before 15\.5\.24/.test(g) && /`images\.remotePatterns`/.test(g));
  check("... et les versions à demander : next 15.5.28 ou 16.4.1, next-auth 5.0.0-beta.32", /`next` 15\.5\.28 or later on the 15\.5 branch/.test(g) && /16\.4\.1 or later on the 16 branch/.test(g) && /`next-auth` 5\.0\.0-beta\.32 or later/.test(g));
  const h = section("### 1h", "### 1i");
  check("/security 1h : un formulaire public qui écrit à l'adresse saisie, 🟠", /\*\*A public form that emails the address it was given\*\*/.test(h) && /🟠\. Find it/.test(h));
  const k2 = section("### 1k", "### 1l");
  check("/security 1k : un agent qui se fie à l'expéditeur, les résultats d'authentification, 🟠 sans SPF ni DMARC strict", /\*\*Incoming email read by an agent or a script\*\*/.test(k2) && /`Authentication-Results`/.test(k2) && /`p=quarantine` or `p=reject`/.test(k2) && /🟠 when the expected sender's domain has no SPF record/.test(k2));
  const n = section("### 1n");
  check("/security 1n : toujours 🔴, et Next.js 15.5 dit sans garde contre javascript: dans router.push", /This is 🔴, never 🟠, whatever the version of Next\.js/.test(n) && /there is no guard against it in `router\.push` or `router\.replace` on the 15\.5 branch/.test(n));
  check("... aucune phrase de la skill ne prête cette garde au routeur de Next.js 15", !/(Next\.js 15|15\.5)[^.\n]*(blocks|refuses|filters out|guards)/i.test(s.replace(/there is no guard against it/g, "")));
  check("/security, corrections : le contrôle et le middleware par le module, la règle écrite dans le CLAUDE.md", /scripts\/admin-gate\.mjs" --web-dir <app folder>/.test(s) && /every page of `\(protected\)\/` starts with `await requireAdmin\(\)` before reading any data/.test(s));
}

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
