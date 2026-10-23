# /add-db

Ajoute une **base de données** à votre projet pour y stocker des informations qui restent dans le temps. Hypervibe provisionne une base PostgreSQL hébergée en Europe, la branche à votre code et active les sauvegardes automatiques.

## Quand l'utiliser

- Quand votre app a besoin de stocker des informations : utilisateurs, commandes, articles, fiches clients, réservations, contenu éditorial, etc.
- Souvent appelée automatiquement par `/bootstrap` au moment de la création du projet. Vous pouvez aussi la lancer plus tard si vous voulez ajouter la persistance à un projet déjà existant.

## Comment ça se passe

1. **Vérification** : Hypervibe regarde si une base de données est déjà branchée à ce projet.
  - Si oui, un petit menu vous propose : pousser le schéma, migrer vers une nouvelle base, reset des tables, ou tout refaire. Pas de risque de doublon.
  - Sinon, on enchaîne.
2. **Création du projet Neon** : un projet Neon est créé sous votre compte, en région `aws-eu-central-1` (Frankfurt), même région que vos fonctions Vercel pour une latence minimale.
3. **Installation du driver** : le pilote Neon serverless est installé dans votre projet (compatible edge computing).
4. **Configuration de Drizzle ORM** : Hypervibe configure Drizzle (l'outil qui sert d'intermédiaire entre votre code et la base) pour parler à votre base Neon.
5. **Application du schéma** : la structure des tables que vous avez (ou que Hypervibe crée) est poussée sur la base. À partir de maintenant, votre code peut lire et écrire dedans.
6. **Sauvegarde de la clé** : la chaîne de connexion (`DATABASE_URL`) est sauvegardée à la fois dans votre `.env` local et sur Vercel (production + preview + development). Vous n'avez rien à copier-coller.
7. **Sauvegardes automatiques** : Hypervibe active discrètement les sauvegardes auto (une nouvelle toutes les 2 semaines, conservation des 2 dernières + 3 historiques sur 9 mois).

## Ce que ça crée pour vous

- Un **projet Neon** à votre nom, prêt à recevoir des données
- Le **fichier de schéma Drizzle** (`src/server/db/schema.ts`) où vous (ou Hypervibe) définirez vos tables
- La connexion configurée dans `src/server/db/index.ts`
- Les commandes utiles : `pnpm db:push` (pour pousser un changement de schéma) et `pnpm db:studio` (pour explorer vos données dans une interface graphique)
- Les **sauvegardes automatiques** activées (Cloudflare Worker mutualisé entre vos projets)

## Prérequis

- Le projet doit être un projet Next.js (typiquement initialisé par `/bootstrap`)
- Une clé API Neon doit être rangée dans votre coffre-fort (item `NEON`) - créée une fois sur console.neon.tech. Hypervibe le détecte et vous guide pour l'ajouter si rien n'est dispo.

## Astuces

{{callout:tip|Plan gratuit Neon}}
Neon offre un plan gratuit très généreux : 100 projets max, 1 Go de stockage par projet (20 Go pour l'ensemble des projets), 100 heures de calcul par mois. La base se met en pause automatiquement quand personne ne l'utilise (zero cost when idle). Largement suffisant pour la grande majorité des projets.
{{/callout}}

{{callout:info|Les sauvegardes, c'est offert}}
Vous n'avez pas à configurer manuellement les sauvegardes : Hypervibe active un Cloudflare Worker mutualisé entre tous vos projets qui prend une snapshot Neon toutes les 2 semaines. Une seule "case" Cloudflare consommée, même pour 50 projets.
{{/callout}}

{{callout:warning|Données en Europe}}
La base est volontairement créée en Europe (Frankfurt) pour respecter le RGPD côté résidence des données. Vous n'avez rien à faire pour ça.
{{/callout}}
