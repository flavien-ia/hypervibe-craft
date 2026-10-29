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
check("... laisse de côté la ligne de résumé, et dit que ces journaux ne servent que les projets d'une équipe", /summary line that is not a request/.test(optimize) && /owned by a Vercel team/.test(optimize));
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

// /update-hypervibe, 3.4.19: the end no longer says to close and reopen Claude Code, but to type
// /reload-plugins (or open a new conversation), which loads an installed version (decision E2).
{
  const u = read("skills/update-hypervibe/SKILL.md").replace(/\r\n/g, "\n");
  const fin = u.slice(u.indexOf("## Step 4 - Wrap up"));
  check("/update-hypervibe : la fin dit /reload-plugins (ou une nouvelle conversation), jamais « close and reopen »", /type `\/reload-plugins`\*\* \(or open a new conversation\)/.test(fin) && !/close and reopen/i.test(u));
  const docs = ["DOC.md", "DOC.fr.md"].map((f) => read(`skills/update-hypervibe/${f}`)).join("\n");
  check("... et ses pages de documentation aussi", (docs.match(/\/reload-plugins/g) ?? []).length === 2 && !/restart Claude Code|relancer Claude Code/.test(docs));
}

// /update-hypervibe, 3.4.18: the repair of the admin space of the projects built before 3.4.17.
{
  const u = read("skills/update-hypervibe/SKILL.md").replace(/\r\n/g, "\n");
  const at = u.indexOf("## Step 3f - Close the admin space of existing projects");
  const step = at < 0 ? "" : u.slice(at, u.indexOf("\n## ", at + 3));
  const one = u.slice(u.indexOf("## Step 1 - Check"), u.indexOf("## Step 2 - Download"));
  check("/update-hypervibe : l'étape qui ferme l'espace admin des projets existants, après celle du lint", at > u.indexOf("## Step 3e - Repair the code check") && at < u.indexOf("## Step 4 - Wrap up"));
  check("... jouée aussi quand le plugin est déjà à jour (installé d'ailleurs, ou par l'ancien texte)", /If `updateAvailable` is false, run Step 3b \(the rules\), the hooks-chain step \(Step 3c - Close the hooks chain\), Step 3d and Step 3f first\./.test(one) && /Run Step 3b \(the rules\), the hooks-chain step \(Step 3c - Close the hooks chain\), Step 3d and Step 3f, then \*\*STOP\.\*\*/.test(one));
  check("... cherche les projets de la machine sans rien écrire, puis les liste en mots simples", /repair-admin-gate\.mjs" --scan --cwd "\$\(pwd\)"/.test(step) && /It writes nothing/.test(step) && /`counts\.toFix \+ counts\.manual \+ counts\.review`/.test(step));
  check("... dit ce qui se passe aujourd'hui, en une phrase", /A page of the admin space can let its content be read by someone who asks for it without being signed in/.test(step));
  check("... l'accord avant toute écriture : tous les projets proposés, rien d'écrit avant la réponse", /offering every one of them \(a multiple choice when they fit in one question, otherwise the numbered list[^)]*\)\. \*\*Nothing is written before that answer\.\*\*/.test(step) && step.indexOf("Nothing is written before that answer") < step.indexOf("--write"));
  check("... les pages manual et review corrigées à la main par la règle de /security, le changement montré, sur un oui", /rule of `\/security` \(Step 3, point 2\)/.test(step) && /Show each change and apply it only on a yes/.test(step));
  check("... le middleware déjà là jamais remplacé, fusionné quand c'est sûr, sinon dit", /never replaced/.test(step) && /`\/\/ hypervibe:admin-gate` as its first line/.test(step) && /otherwise say in one sentence what is missing/.test(step));
  check("... la vérification du code quand les dépendances sont là, sinon dite", /`pnpm tsc --noEmit && pnpm lint`/.test(step) && /Without `node_modules`, say so/.test(step));
  check("... le commit proposé, par les noms de fichiers", /\*\*The commit, offered\.\*\*/.test(step) && /git add -- <files>/.test(step) && !/git add -A|git add \./.test(step));
  check("... la mise en ligne reste un geste de la personne : proposée, et la question du garde-fou est son oui", /\*\*Putting it online, offered too\.\*\*/.test(step) && /the guardrail asks at that moment and lists what leaves, and that question is the person's yes/.test(step));
  check("... la réparation ne vaut qu'une fois déployée, et l'étape le dit", /\*\*The repair protects the live site only once it is deployed\*\*/.test(step) && /Say it plainly/.test(step));
  check("... la preuve sans risque une fois en ligne : la taille de la réponse sans cookie, jamais son contenu affiché", step.includes('curl -s -o /dev/null -w "%{http_code} %{size_download}\\n" https://<site>/admin/<page>') && /\*\*Never print what comes back\*\*/.test(step) && /grep -c/.test(step));
  check("... et pour finir : un audit complet reste le rôle de /security", /a complete audit of each project remains the job of `\/security`/.test(step));
  check("... jamais un contrôle plus faible que celui du layout : layout dit (le contrôle du layout nommé, recopié), admin dit", /never a weaker one than its layout's/.test(step) && /`layout` is the check of the layout named in `layout` \(the same condition, the same redirect\), copied on the page's first lines/.test(step) && /`admin` is the project's own admin check/.test(step) && !/`session` is the session read/.test(step));
  check("... une page review peut être un espace admin hors de admin/(protected), ou un layout dont le contrôle se lit mal, compté comme une garde", /an admin space outside `admin\/\(protected\)`, or a layout whose check the script could not read for sure, which it counts as one/.test(step));
  check("... une page publique ne se ferme jamais : l'accueil, les tarifs restent tels quels, et dans le doute, demander", /Before closing a `review` page, make sure it is meant for signed-in people only: a public page \(the home page, the pricing, a page anyone may read\) stays as it is, and when in doubt, ask\./.test(step));
  check("... ce que --write ne posera pas (skipped) n'est jamais annoncé, sa raison est dite", /A `skipped` one is not written by `--write`: never announce it/.test(step) && /`helper\.status` is `would-write`/.test(step));
  check("... la barrière skipped dite là où l'étape traite existing : pas de page de connexion, ou un cookie de session qui n'est pas le sien (next-auth 4, cookie renommé)", /When `middleware\.status` is `skipped`, no barrier is written/.test(step) && /`next-auth-4`/.test(step) && /`custom-cookie`/.test(step) && /send the administrator back to sign-in forever/.test(step));
}

// 3.4.19: the return address read with the URL parser (reported on 28/10/2026), and the points of a
// reader of 3.4.18 on /update-hypervibe (the same day): an unknown `uncommitted`, the working copies
// of a repository, the old filter said read-only.
{
  const s = security;
  const n = s.slice(s.indexOf("### 1n"), s.indexOf("## Step 2 - Report"));
  check("/security 1n : un test écrit sur le texte brut de l'adresse est un défaut, 🔴 comme s'il manquait (l'ancien filtre des gabarits nommé)", /a test written on the raw text is a finding too, 🔴 like a missing one/.test(n) && /the filter of this plugin's templates from 3\.3\.11 to 3\.4\.18/.test(n) && /`\/\\t\/evil\.com`/.test(n));
  check("... le chemin de ce site lu par le lecteur d'adresses, jamais par un motif", /\*\*path of this site, read with the URL parser\*\*, never with a pattern on the raw text/.test(n));
  const u = read("skills/update-hypervibe/SKILL.md").replace(/\r\n/g, "\n");
  const at = u.indexOf("## Step 3f - Close the admin space of existing projects");
  const step = at < 0 ? "" : u.slice(at, u.indexOf("\n## ", at + 3));
  check("/update-hypervibe 3f : uncommitted null n'est jamais « rien en attente », et c'est dit avant le commit", /When `uncommitted` is `null`, git could not be asked/.test(step) && /it is never "nothing pending"/.test(step) && /I could not check whether these files already hold changes not saved yet: look at them before the commit\./.test(step));
  check("... point 6 : uncommittedBefore null, aucun commit proposé avant que la personne ait regardé", /When `uncommittedBefore` \(or `uncommitted` of point 1\) is `null`/.test(step) && /offer no commit until the person has looked at those files/.test(step));
  check("... les copies de travail d'un dépôt : UN projet, la copie de la branche qui se déploie d'abord, les autres avec leur branche", /\*\*A project with `copies`\*\*/.test(step) && /it is ONE project, never one line per folder/.test(step) && /`productionBranch`/.test(step) && /When `productionBranch` is null/.test(step));
  check("... l'ancien filtre réparé dans le même passage, avec --redirects sur les trois appels du script", /--scan --cwd "\$\(pwd\)" --redirects/.test(step) && /--project-dir "<project folder>" --redirects` \(writes nothing\)/.test(step) && /--project-dir "<project folder>" --write --redirects/.test(step) && /The same pass repairs a second defect, in the same projects and with the same agreement/.test(step));
  check("... annoncé avant d'écrire (les fichiers en fix: auto), compté dans la liste (counts.redirect)", /each file of `openRedirect` with `fix: "auto"`/.test(step) && /when `counts\.redirect` is above 0/.test(step) && /A trapped link can send someone, right after they sign in, to another site/.test(step));
  check("... une ligne retouchée à la main (fix: manual, kind: redirect) jamais réécrite, renvoyée à /security", /A line with `fix: "manual"`[^\n]*is never rewritten by this step, it is only said/.test(step) && /`\/security` in this project fixes it/.test(step) && /An entry with `kind: "redirect"`[^\n]*is not corrected in this step/.test(step) && /then the lines left to `\/security` below \(`openRedirect`\), then go on/.test(step));
  const doc = read("skills/update-hypervibe/DOC.md");
  check("... et la page DOC le dit (copies listées une fois, le filtre réparé dans le même passage, la ligne retouchée laissée)", /is listed once/.test(doc) && /In the same pass, and with the same yes, it also repairs the sign-in and notification links/.test(doc) && /A line you changed by hand is left as it is/.test(doc));
}

// 3.4.20: a project's `needed` is the one of the copy offered first, and its other working copies
// that still have the old pages are said apart, one line per project, never offered for writing nor
// for removal (Bastien, 28/10/2026: five old copies of branches already merged kept a repaired
// project "to repair", and the warning was no longer read).
{
  const u = read("skills/update-hypervibe/SKILL.md").replace(/\r\n/g, "\n");
  const at = u.indexOf("## Step 3f - Close the admin space of existing projects");
  const step = at < 0 ? "" : u.slice(at, u.indexOf("\n## ", at + 3));
  check("/update-hypervibe 3f : le needed d'un projet, ses comptes et la réparation sont ceux de la copie proposée d'abord (firstCopy dit pourquoi)", /The project's `needed`, its counts and the repair are that copy's alone/.test(step) && /`firstCopy` says why that copy comes first/.test(step) && !/as choices of their own/.test(step));
  check("... les autres copies qui ont encore les anciennes pages : otherCopies, une ligne par projet, même quand le projet n'est pas à réparer", /\*\*The other copies that still have the old pages\*\* \(`otherCopies`, on any project of `projects`, `needed` or not/.test(step) && /one line per project, never one per folder/.test(step) && /then the other copies below \(`otherCopies`\), then the lines left to `\/security`/.test(step));
  check("... leur état dit en mots (merged, work, unread), et ce qu'on peut en faire : mises à jour ou retirées", /`merged`, \*"with nothing pending, and already in <containedIn>"\*/.test(step) && /`work`, \*"with work in progress"\*/.test(step) && /`unread`, \*"I could not read whether they hold work in progress"\*/.test(step) && /Each can be brought up to date from <containedIn>, or removed once it is of no use\./.test(step));
  check("... jamais proposées à la réparation, à l'écriture ni à la suppression", /Never offer to repair them, to write in them, or to remove them: this step only says it, and the person decides/.test(step));
  const doc = read("skills/update-hypervibe/DOC.md");
  const docFr = read("skills/update-hypervibe/DOC.fr.md");
  check("... et les pages DOC le disent (les autres dossiers jamais réparés, à mettre à jour ou retirer)", /Its other folders are never repaired by this step/.test(doc) && /you can bring them up to date or remove them/.test(doc) && /Ses autres dossiers ne sont jamais réparés par cette étape/.test(docFr) && /vous pouvez les mettre à jour ou les retirer/.test(docFr));
}

// /update-hypervibe, 3.4.21 (banc Desktop du 29/10/2026, défaut D) : on "already up to date",
// marketplace or manual, the rules and the hooks chain run too: a plugin uploaded by hand or updated
// natively arrives without them, and would keep the old block of the global hooks.
{
  const u = read("skills/update-hypervibe/SKILL.md").replace(/\r\n/g, "\n");
  const check1 = u.slice(u.indexOf("## Step 1 - Check"), u.indexOf("## Step 2 - Download"));
  const runs = check1.match(/Run Step 3b \(the rules\), the hooks-chain step \(Step 3c - Close the hooks chain\), Step 3d and Step 3f/gi) || [];
  check("/update-hypervibe : already up to date (marketplace and manual) runs the rules and the hooks chain, then 3d and 3f", runs.length === 2);
  const regles = u.slice(u.indexOf("## Step 3b - Bring the rules in step"), u.indexOf("## Step 3c - Adopt the resource manifest"));
  const hooks = u.slice(u.indexOf("## Step 3c - Close the hooks chain"), u.indexOf("## Step 3d - Bring the shared clock"));
  check("... and both sections say so", /also when Step 1 finds the plugin already up to date \(marketplace or manual\)/.test(regles) && /idempotent and safe to run again/.test(regles) && /also when Step 1 finds the plugin already up to date \(marketplace or manual/.test(hooks));
  const doc = read("skills/update-hypervibe/DOC.md");
  const docFr = read("skills/update-hypervibe/DOC.fr.md");
  check("... and the DOC pages say it in both languages", /still brings this computer's Claude rules and machine-wide git hooks in step/.test(doc) && /remet quand même à niveau les règles de Claude et les hooks git communs de cet ordinateur/.test(docFr));
}

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
