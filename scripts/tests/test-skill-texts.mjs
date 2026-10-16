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

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
