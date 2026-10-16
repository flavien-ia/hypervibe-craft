# Hypervibe

> 🇬🇧 [Read in English](README.md)

Un plugin Claude Code qui crée des projets web complets (stack T3) avec des addons modulaires. Conçu pour les non-techs qui veulent créer et déployer des apps web en décrivant ce qu'ils veulent en français.

> 📘 **Première fois ? Suivez le [guide d'installation pas à pas](https://hypervibe.fr/plugin/installation).** Il couvre les prérequis, les comptes à créer et votre premier projet, de bout en bout.

## Installation

Il vous faut d'abord [Claude Code](https://claude.com/claude-code). Il est inclus dès l'abonnement **Claude Pro** (ou supérieur ; la version gratuite ne suffit pas), et est livré avec l'application Claude pour Mac et Windows, ou en ligne de commande. Pas encore de compte ? [Créez-le et prenez votre abonnement ici](https://claude.ai/referral/BtZlSHizAA). Ensuite, dans Claude Code, lancez :

```
/plugin marketplace add flavien-ia/hypervibe-harness
/plugin install hypervibe@hypervibe-harness
```

Vous mettez à jour depuis une version antérieure à la 2.5 ? Après avoir mis à jour le plugin, relancez simplement `/start` dans Claude Code : il détecte vos anciens mécanismes de tâches de fond et les regroupe pour vous dans le nouveau mécanisme unifié, en toute sécurité et avec votre accord à chaque étape (sans effet si vous n’avez rien à migrer). Plus de contexte dans [MIGRATION.md](MIGRATION.md).

Puis tapez `/start` : il installe tout le reste pour vous (Node.js, pnpm, Git, et les outils de chaque service) et vérifie que vos connexions fonctionnent.

Vous préférez une version guidée, étape par étape ? Suivez le guide complet sur **[hypervibe.fr/plugin/installation](https://hypervibe.fr/plugin/installation)**.

## Codex, OpenCode et Antigravity

Hypervibe est écrit pour Claude Code, mais le même plugin tourne aussi sur **OpenAI Codex**, sur **OpenCode** et sur **Google Antigravity** : les mêmes skills, le même garde-fou, le même serveur MCP. hypervibe.fr sert une version convertie pour chaque hôte et explique comment l'installer sans écrire une ligne de code :

- [Hypervibe pour Codex](https://hypervibe.fr/plugin/codex)
- [Hypervibe pour OpenCode](https://hypervibe.fr/plugin/opencode)
- [Hypervibe pour Antigravity](https://hypervibe.fr/plugin/antigravity)

Les développeurs peuvent aussi convertir ce dépôt eux-mêmes avec les convertisseurs open source derrière ces téléchargements, [claude-plugin-to-codex](https://www.npmjs.com/package/claude-plugin-to-codex), [claude-plugin-to-opencode](https://www.npmjs.com/package/claude-plugin-to-opencode) et [claude-plugin-to-antigravity](https://www.npmjs.com/package/claude-plugin-to-antigravity) (un seul moteur, [claude-plugin-port](https://github.com/flavien-ia/claude-plugin-port)) :

```bash
git clone https://github.com/flavien-ia/hypervibe-harness.git
npx claude-plugin-to-codex --source ./hypervibe-harness         # Codex
npx claude-plugin-to-opencode --source ./hypervibe-harness      # OpenCode
npx claude-plugin-to-antigravity --source ./hypervibe-harness   # Antigravity
```

Ce qui change par rapport à Claude Code : le fichier de règles est `AGENTS.md` (sur Codex et OpenCode, votre `CLAUDE.md` existant sur une machine qui fait aussi tourner Claude Code ; Antigravity ne lit que `AGENTS.md`), une question vous est posée en texte sur Codex et par l'outil `question` sur OpenCode, les routines tournent dans le planificateur des applications de bureau de Codex et d'Antigravity, et quelques skills décrivent encore des menus propres à Claude Code. Tout le reste, coffre-fort compris, ce sont les mêmes scripts.

## Par où commencer

| Première fois ? | Déjà à l'aise ? |
|---|---|
| `/start` - vérifie votre config et présente le plugin | `/bootstrap` - lancez-vous directement |
| `/prof` - explique comment tout fonctionne | `/spec` - construisez un cahier des charges d'abord |

## Comment ça marche

Décrivez simplement ce que vous voulez construire. Claude analyse votre description et déduit les addons nécessaires (base de données, auth, paiements, etc.), puis vous présente le plan pour validation avant de construire.

```
/bootstrap Mon site vitrine de photographe
/bootstrap Mon app de gestion de leads avec comptes utilisateurs
/bootstrap Mon SaaS de facturation en ligne avec paiements Stripe
```

### Trois façons de définir votre projet

Quand vous lancez `/bootstrap`, vous choisissez comment décrire votre app :

- **A - Construire un cahier des charges ensemble** (`/spec`) : Claude vous guide étape par étape à travers 5 blocs (projet, pages, design, fonctionnalités, contraintes) et produit un `cahier-des-charges.md`
- **B - Fournir un cahier des charges existant** : donnez à Claude un fichier `.md`, il le lit et en déduit l'infrastructure
- **C - Description courte uniquement** : Claude pose les questions d'infrastructure en une fois et construit une app simple

## Toutes les skills

### Skills de workflow

| Skill | Ce que ça fait |
|---|---|
| `/bootstrap` | Créer un nouveau projet de zéro |
| `/spec` | Construire un cahier des charges détaillé, étape par étape |
| `/start` | Premier lancement : vérifie les prérequis, présente toutes les commandes |
| `/prof` | Explique comment tout fonctionne simplement (mode pédagogique) |
| `/seo` | Audit SEO et corrections (métadonnées, sitemap, image de partage, structure, URLs/slugs, accessibilité, lisibilité, couverture du sujet, fraîcheur du contenu, commerce local), plus ce que seul le site en ligne montre (un noindex involontaire, une adresse en double, des redirections temporaires, des liens cassés, les erreurs du sitemap). Un score calculé sur une grille fixe, gardé dans le projet pour comparer les passages |
| `/geo` | Audit et optimisation pour les moteurs IA (ChatGPT, Claude, Perplexity, Gemini, Copilot) : d'abord, les robots d'IA peuvent-ils lire les pages (texte sans JavaScript, pare-feu qui les refoule, règles robots.txt construites depuis une liste datée et sourcée des robots d'IA), puis citabilité, E-E-A-T, format Q&A. llms.txt et balisage FAQ proposés pour ce qu'ils sont : des paris. Complémentaire à `/seo`. |
| `/gsc` | Connecte le site à Google Search Console, vérifie le DNS automatiquement, soumet le sitemap, puis audite ce que Google voit vraiment - couverture d'indexation, top requêtes, opportunités (positions 11-20), CTR à améliorer, pages zombies, lues aussi par `/seo` ; propose de brancher Bing Webmaster Tools en important la propriété. Complémentaire à `/seo` (données Google externes). |
| `/security` | Audit de sécurité (secrets, auth, headers, dépendances, RGPD) |
| `/accessibility` | Audit d'accessibilité : lit le code (images, boutons, champs, clavier, focus, zoom), mesure les pages en ligne, explique chaque problème simplement, puis applique les corrections que vous approuvez |
| `/rgpd-audit` | Audit de conformité RGPD - détecte les services tiers utilisés, met à jour le registre des sous-traitants, génère ou rafraîchit la page de politique de confidentialité |
| `/clean` | Trouve les fichiers inutilisés, le code mort, les env vars et tables DB orphelines - revue + suppression sur une branche |
| `/rotate-secret` | Renouvelle une clé secrète (Stripe, Brevo, Google…) partout où elle vit - local + Vercel |
| `/quotas` | Affiche votre consommation actuelle face aux plafonds gratuits de chaque service (Neon, Cloudflare, Brevo, Resend, Vercel) avec verdicts par jauge |
| `/update-hypervibe` | Met le plugin lui-même à jour vers la dernière version publiée (regarde comment il a été installé, garde une sauvegarde) |

### Skills addon

Chaque addon peut être activé pendant `/bootstrap` ou utilisé seul sur un projet existant.

| Skill | Ce que ça ajoute |
|---|---|
| `/add-db` | Neon PostgreSQL + Drizzle ORM (DB provisionnée à Frankfurt, `aws-eu-central-1`) |
| `/add-auth` | NextAuth v5 - interface admin uniquement OU comptes utilisateurs (email+mot de passe avec inscription, page compte, suppression, et mot de passe oublié si email configuré). Google/GitHub OAuth proposés en add-ons optionnels en mode utilisateurs. |
| `/add-google-auth` | Active la connexion via Google OAuth (se greffe sur `/add-auth`) |
| `/add-github-auth` | Active la connexion via GitHub OAuth (se greffe sur `/add-auth`) |
| `/add-email` | Resend ou Brevo pour les emails transactionnels (auto-détecté) |
| `/add-stripe` | Stripe Checkout pour les paiements |
| `/add-i18n` | Internationalisation avec next-intl |
| `/add-storage` | Stockage de fichiers avec Cloudflare R2 |
| `/add-analytics` | Google Analytics (GA4) avec bannière cookies RGPD |
| `/add-map` | Carte interactive vectorielle (MapLibre + OpenFreeMap, gratuit sans clé API, EU). Single pin, multi-pin, itinéraire ou map-first |
| `/add-dark-mode` | Mode sombre (clair / sombre / système) avec sélecteur prêt à l'emploi |
| `/add-test` | Tests automatisés (vitest) + cahier de recette lisible par tous, avec un hook avant publication et une CI qui refusent de publier une fonctionnalité sans sa vérification |
| `/add-domain` | Connecter un nom de domaine personnalisé (guidé) |
| `/new-email-address` | Crée une adresse de réception (`contact@monsite.fr`) redirigée vers votre boîte mail (Cloudflare Email Routing) |
| `/add-cron` | Tâche planifiée - Cloudflare Worker (précis) ou GitHub Action (best-effort), choisi selon ce que fait la tâche |
| `/add-automation` | Tout ce que votre app fait toute seule - route vers une tâche planifiée, une chaîne intelligente dans l'app, un agent autonome ou un worker dédié, selon ce que vous décrivez. |
| `/add-ai` | Ajouter de l'IA dans l'app (assistant conversationnel, analyse et classification, generation de contenu) via OpenRouter. Le cout est estime et valide AVANT tout code, la cle est plafonnee cote fournisseur, et chaque appel est journalise avec son cout reel. |
| `/add-agent-dashboard` | Dashboard de monitoring des agents dans `/admin/agents` (coût, exécutions, détail tour par tour, lancer à la demande) |
| `/add-collab` | Ajouter des collaborateurs GitHub qui peuvent déployer (via GitHub Actions, sans payer de siège Vercel) |
| `/add-backup-db` | Sauvegardes automatiques de la DB Neon (Cloudflare Worker partagé, snapshots rolling + aging) |

Pour utiliser un addon seul, demandez simplement à Claude Code :
> "Ajoute l'authentification à mon projet" → utilise add-auth
> "Configure Stripe pour les paiements" → utilise add-stripe
> "Je veux connecter mon nom de domaine" → utilise add-domain

### Helpers internes

Le plugin embarque aussi des skills internes préfixées `_`, invoquées automatiquement par les skills publiques ci-dessus (jamais par l'utilisateur directement). Elles gèrent les préoccupations partagées : push des env vars (`_push-env-vars`), détection de dépendances (`_check-deps`), génération de secrets, hash de mots de passe, sous-branches de setup auth, installation automatique des CLIs, etc. Tu n'as jamais besoin de les invoquer toi-même.

## Stack technique

Les projets créés avec ce plugin utilisent :

- **Next.js** (App Router) avec TypeScript
- **tRPC** pour les routes API typées
- **Drizzle ORM** pour l'accès à la base de données
- **Tailwind CSS** pour le style
- **shadcn/ui** pour les composants UI
- **Inter** comme police par défaut (via next/font)
- **GitHub** pour le contrôle de version
- **Vercel** pour l'hébergement et le déploiement (fonctions configurées en région `fra1` - Frankfurt)
- **Neon** pour la base de données PostgreSQL (provisionnée à Frankfurt, `aws-eu-central-1` - quand l'addon DB est activé)
- **Resend ou Brevo** pour les emails transactionnels (quand l'addon email est activé)
- **Stripe** pour les paiements (quand l'addon stripe est activé)
- **Cloudflare R2** pour le stockage de fichiers (quand l'addon storage est activé)
- **Google Analytics** pour le suivi du trafic (quand l'addon analytics est activé)
- **next-intl** pour l'internationalisation (quand l'addon i18n est activé)
- **Anthropic** (API Claude) pour les agents IA autonomes (quand l'addon agent est activé)
- **Render** pour héberger les agents IA et automatisations longues (quand l'addon agent / automation route vers Render)
- **Bitwarden** comme **coffre-fort de clés** - vos clés d'accès transverses (Cloudflare, Neon, email…) sont rangées **chiffrées** dans un coffre-fort, jamais en clair sur le disque ni en variable d'environnement. `/start` le met en place (compte gratuit, région EU) ; vous tapez un mot de passe maître une fois par jour et Claude récupère les clés tout seul quand il en a besoin.

## Ce que le bootstrap configure automatiquement

Chaque projet reçoit, quel que soit le mode :

- Scaffold T3 (Next.js + TypeScript + Tailwind + tRPC)
- Bibliothèque de composants shadcn/ui
- SEO de base (métadonnées, robots.txt, sitemap.ts, placeholder OG, HTML sémantique)
- Repo GitHub privé
- Déploiement Vercel **avec fonctions en région `fra1` (Frankfurt)** - meilleure latence pour les visiteurs européens, données qui restent en UE
- Page 404 personnalisée
- Mentions légales + **page de politique de confidentialité data-driven** : alimentée par un registre central des sous-traitants (`src/lib/subprocessors.json`) qui se met à jour automatiquement à chaque ajout de service via les skills `/add-*`
- CLAUDE.md avec toutes les conventions du projet

## Garde-fous

Une règle écrite est une influence. Un hook est un mécanisme. L'écart a été mesuré sur les transcripts d'un utilisateur : une semaine après avoir transformé un comportement coûteux en règle du CLAUDE.md, le même motif représentait encore 17 des 40 appels en échec. Passé en hook `PreToolUse`, il a cessé immédiatement, parce que l'appel ne peut plus être produit et que le modèle reçoit à la place la bonne alternative.

Les opérations irréversibles sont donc gardées, pas seulement déconseillées :

| Commande | Ce qui se passe | Pourquoi |
|---|---|---|
| `git add -A`, `git add .`, `git add :/`, `git add ':(top)'`, `git add '*'`, `git add -u`, `git commit -a`, `git commit --all` | **refus** | Un balayage a déjà emporté dans un commit le travail non commité d'une autre session. Indexer nommément : `git add <fichier>`. |
| `git push` | **confirmation** | Pousser publie. Le consentement vit dans la conversation, donc un humain confirme. |
| `gh pr merge`, `gh run rerun` | **confirmation** | Une fusion vers la branche principale publie (la branche principale, c'est la production), et relancer un déploiement aussi. Lu comme gh le lit : avec l'option du dépôt avant le verbe (`gh pr -R propriétaire/dépôt merge`) ou par `gh api`, la même question. |
| `gh repo delete`, `gh secret delete`, `gh variable delete`, `gh api` en `DELETE`, `gh release delete`, `gh repo rename`, un dépôt créé ou rendu public, ou transféré | **confirmation** | Supprime, expose ou déplace quelque chose sur la forge : un dépôt, une publication (release), un secret, un accès, une branche, par la commande comme par `gh api`. Un dépôt créé par `gh api` sans dire qu'il est privé compte comme public, puisque GitHub le crée public. Les lectures, `gh pr create` et `gh secret set` passent. |
| `vercel --prod`, `--target production`, `promote`, `rollback` | **confirmation** | Les déploiements passent normalement par `git push`. `vercel build --prod` ne déploie rien et n'est pas demandé. |
| `wrangler deploy`, `wrangler secret put` (pas `--dry-run`) | **confirmation** | Le worker partagé tourne avec les clés du compte ; un déploiement publie du code qui les détient. |
| `pnpm db:push`, `pnpm --filter web db:push`, `drizzle-kit push` | **confirmation** | Sur cette stack, la base que vous atteignez EST la production. |
| `node execute-deletions.mjs` | **confirmation** | Suppressions cloud irréversibles. Lire le fichier n'en est pas une. |
| `run-sql.mjs` avec `DROP` / `TRUNCATE` | **refus** sans `--destructif` | Entre deux sauvegardes, rien ne ramène une table supprimée. Le hook lit la même garde que le script, dans le même fichier : un mot-clé cité dans une chaîne (`INSERT INTO log VALUES ('DROP TABLE')`) ne refuse rien. |
| `run-sql.mjs` avec `DELETE`/`UPDATE` sans `WHERE` | **confirmation** | Réécrit toutes les lignes. |
| `curl -X DELETE` vers une API de gestion que le plugin pilote (Neon, Vercel, Cloudflare, GitHub, Render, Upstash, Stripe, Brevo, Resend, Bitwarden, Google), et `PUT` / `PATCH` là où ils écrasent (Neon, Vercel, Cloudflare) | **confirmation** | Un projet, une branche de base avec ses données, un enregistrement DNS : les scripts du plugin vérifient les réponses du fournisseur, un curl nu non. Lire et créer passent. Lu comme curl le lit : options groupées (`-sX DELETE`), la configuration qu'il prend sur son entrée standard, par laquelle les skills lui passent une clé, et une adresse rangée dans une variable que la ligne pose. |
| Un changement chez le registraire d'un domaine (LWS, Hostinger, Gandi, OVH, Porkbun, Namecheap, IONOS, Infomaniak) : ses serveurs de noms, ou les enregistrements qu'il garde | **confirmation** | Tout le domaine se déplace avec, son site et son courrier. Les lectures passent, telles que chaque registraire les dit : Porkbun lit par un POST, Namecheap change par un GET. |
| `git reset --hard`, `git checkout .`, `git clean -f` | **confirmation** | Jette du travail non commité, peut-être celui d'un autre. |
| `git config hypervibe.hooks true`, `ensure-hooks-chain.mjs --trust` | **confirmation** | Faire confiance aux hooks versionnés d'un dépôt, c'est exécuter du code arrivé avec un clone. Une personne décide, dépôt par dépôt. Retirer l'accord (`false`, ou `--unset`) reste libre. |
| `git config user.email <autre chose qu'une adresse>` | **refus** | Chaque commit la porte, et un push la publie : un mot de passe saisi là par erreur partirait sur GitHub. Le refus ne répète jamais la valeur. |
| `shared-worker/ensure.mjs`, `worker-check.mjs` (sans `--dry-run` ni `--no-deploy`) | **confirmation** | Ils peuvent redéployer l'horloge partagée, du code qui tourne avec les clés du compte, comme `wrangler deploy`. |
| `shared-worker/register.mjs`, `migrate-live.mjs` (sans `--list` ni `--no-deploy`, tels que le script les lit), `db-backup-remove-target.mjs` | **confirmation** | Chaque changement du registre de l'horloge se termine par un redéploiement, son code remis à la version du plugin. Un drapeau qu'aucun des trois ne lit n'épargne rien : avec `--dry-run`, la question est posée. |

Les règles regardent la commande, pas son costume. `sudo`, `command`, `env`, `time`, un lanceur (`npx`, `pnpm dlx`), une version épinglée (`wrangler@latest`), un chemin absolu (`/usr/bin/git`), un sous-shell ou un bloc (`(git add -A && ...)`, `{ ... }`, `if ...; then ...`), une tête entre guillemets, et la charge d'un `sh -c` ou d'un `eval` sont retirés ou dépliés avant qu'une règle s'applique. De même pour le script d'un shell qui le lit ailleurs : `bash <<'EOF'`, `bash <<< '...'`, `echo '...' | bash`, `bash <(echo ...)` (le corps d'un heredoc reste une donnée pour toute autre commande), et la ligne que `xargs` recompose à partir de ce qu'on lui envoie (celui de GNU comme celui de macOS), ou que lancent `find -exec`, `timeout`, `stdbuf`, `caffeinate`, et sur macOS `arch`, `xcrun`, `taskpolicy`, `sandbox-exec` et `script`. Leurs options, et celles de `sudo`, `env` ou `nice`, sont lues comme ces outils les lisent : une option longue par son préfixe, sa valeur après `=` ou dans le mot suivant, et `env -S` qui passe une commande entière. Les accolades sont dépliées comme le shell les déplie avant toute exécution : `git add {.,.}` vaut `git add . .`, et `git add src/{a,b}.ts` passe toujours. Chaque mot n'est gardé qu'une fois, et une commande dont les accolades se déplient au-delà de ce que le garde-fou lit demande confirmation. Une frontière est assumée : ce qu'une substitution imprimera (`bash <<< "$(...)"`) n'existe qu'à l'exécution, et c'est la garde propre aux scripts qui tient au-delà. Cinq formes de ce genre passaient devant toutes les règles en 3.0.4 ; fermer la famille plutôt que les cinq, c'est ce qu'une relecture extérieure a demandé.

Tout le reste passe sans encombre, et cette moitié-là est testée avec autant de soin que l'autre : `git add src/a.ts`, `git push --dry-run`, `git add -p`, un `DELETE ... WHERE`, et même un message de commit qui mentionne `git add -A` (`node hooks/test-hooks.mjs`).

Trois choses à savoir :

- **Fail-open.** Le hook s'exécute avant chaque commande ; s'il échoue, il laisse passer et le dit sur stderr. C'est une ceinture, pas un sas. Un fichier manquant à côté de lui laisse les autres règles en place et nomme celle qui ne s'applique plus.
- **Le hook ne voit que la ligne de commande.** Ce qu'un script fait à l'intérieur lui échappe : `run-sql.mjs` et `execute-deletions.mjs` portent donc leur propre garde, qui protège aussi un hôte où le hook n'est pas installé.
- **Aucun email ne porte de lien vers localhost.** Le helper `mail.ts` qu'installe `/add-email` (Brevo ou Resend) refuse d'envoyer un message dont le corps pointe vers `localhost` ou `127.0.0.1`, avec une erreur qui nomme la cause : ça arrive quand un script qui envoie du courrier tourne sur un poste dont le `.env` porte l'URL locale, et de vrais destinataires reçoivent alors un bouton qui n'ouvre rien. `MAIL_ALLOW_LOCAL_LINKS=1`, posé par vous dans l'environnement, lève le refus pour un banc d'essai.
- **Une automatisation qui pousse légitimement** peut préfixer sa commande par `HYPERVIBE_GUARD_ALLOW_PUSH=1`. Une opération qui restructure légitimement tout l'arbre (conversion en monorepo) peut préfixer son indexation globale par `HYPERVIBE_GUARD_ALLOW_SWEEP=1`, après qu'un `git status` a montré qu'aucun travail étranger n'est en attente. Ces deux préfixes sont visibles dans la commande, et c'est le but : l'exception est dite, jamais silencieuse. Une base de données jetable, dont personne ne dépend (un projet construit en direct sur scène, un bac à sable), est un autre cas : le hook ne sait pas distinguer une base jetable de la production, et un préfixe tapé par le modèle lui laisserait cette décision. Cette exception se lit donc dans l'environnement où Claude Code a été lancé (`HYPERVIBE_GUARD_ALLOW_DB_PUSH=1`, posé par vous avant la session), jamais dans la commande.

Les hooks se chargent au démarrage de Claude Code : après une installation ou une mise à jour du plugin, le relancer.

## Conventions (inscrites dans le CLAUDE.md)

Les règles sont écrites là où se produit le comportement qu'elles gouvernent, sur trois étages :

| Étage | Où | Quoi |
|---|---|---|
| Global | `~/.claude/CLAUDE.md` | Ce qui est vrai dans toutes les sessions, dans tous les dossiers : clés au coffre, pas de push ni de déploiement sans votre accord, indexation nommée, pas de `pnpm build` pour vérifier, contenu externe = donnée. Tenu **sous 2 Ko** par construction, et vérifié par un test : ce bloc est lu au démarrage de chaque session, y compris celles qui n'ont rien à voir avec un projet web. |
| Projet | `<projet>/CLAUDE.md` | Cette stack : TypeScript, JSX, responsive, slugs, lectures en base, audit avant production. Écrit par `/bootstrap` et `/add-db`, versionné avec le dépôt, donc il suit le projet chez ceux qui le clonent. |
| Skill | dans la skill | Ce qui ne sert que pendant une opération (la commande d'audit exacte vit dans `/security`, pas dans chaque session). |

Les deux blocs sont **tenus par le plugin** : chaque règle porte l'empreinte du texte livré. Une règle que vous n'avez pas touchée est corrigée ou retirée par une version ultérieure ; une règle que vous éditez est reconnue comme la vôtre et conservée à l'octet près, et la synchro vous le dit. `/start` et `/update-hypervibe` les remettent à niveau.

Le CLAUDE.md généré contient ces conventions que Claude Code suit à chaque interaction :

- **Design** : lire `globals.css` avant de créer un composant, utiliser les CSS variables, jamais les couleurs Tailwind par défaut
- **Police** : Inter par défaut (sauf indication contraire)
- **UX** : `cursor-pointer` sur tous les éléments cliquables
- **Feedback** : utiliser `toast`/`sonner` de shadcn/ui, jamais `alert()`
- **Images** : toujours `<Image>` de next/image avec un `alt` descriptif
- **Responsive** : mobile-first, tous les composants doivent fonctionner sur mobile (< 640px) et desktop
- **Optimistic UI** (si DB) : l'interface se met à jour immédiatement, la DB synchronise en arrière-plan
- **Git** : ne jamais pousser sans demande explicite
- **Workflow** : pour les tâches complexes (3+ fichiers), créer une todo list numérotée avec ✅/⏳
- **Composants** : toujours utiliser shadcn/ui avant de créer des composants custom
- **TypeScript** : jamais de `any`, tout typer correctement
- **Typographie** : jamais de tiret cadratin ( - ) dans les textes affichés

## Serveur MCP inclus

Le plugin inclut [Context7](https://github.com/upstash/context7-mcp), qui donne à Claude Code accès à la documentation à jour de Next.js, Tailwind, Drizzle et des autres technologies.

## Auteur

**Flavien Chervet** - [flavienchervet.fr](https://flavienchervet.fr)

## Contributeurs

**Bastien Detraz** - relectures de sécurité indépendantes du plugin (garde-fous, gardes SQL, audit RGPD), chaque constat mesuré et livré avec sa reproduction.

## Licence

Écrit par Flavien Chervet. Copyright 2026 Hyper Wisdom.

Sous [licence Apache 2.0](LICENSE). Le code source est libre d'utilisation, de modification et de redistribution selon les termes de cette licence.

### Marque

**Hypervibe** et **Certifié Hypervibe** sont des marques de Hyper Wisdom. La licence open source couvre le code, pas le nom : elle ne confère aucun droit d'usage de ces marques (cf. section 6 de la licence Apache). Vous ne pouvez pas nommer un fork, un dérivé, un produit ou un service "Hypervibe", ni laisser entendre une affiliation ou une certification officielle, sans autorisation écrite.
