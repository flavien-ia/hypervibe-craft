# /security

Audite la sécurité de votre app et corrige automatiquement les failles courantes. Hypervibe couvre 13 catégories de risques (secrets exposés, routes mal protégées, dépendances vulnérables, webhooks falsifiés, liens piégés, etc.) avec une explication en langage simple pour chaque trouvaille.

## Quand l'utiliser

- **Avant le passage en production** sur un domaine public
- Après l'ajout d'une fonctionnalité critique (paiements, auth, upload de fichiers)
- De manière périodique (tous les 2-3 mois) pour rester à jour

## Comment ça se passe

1. **Disclaimer affiché en début** : Hypervibe rappelle que c'est un audit des failles courantes. Pour les apps qui traitent des données très sensibles (santé, bancaire, données critiques), un audit de sécurité professionnel reste nécessaire.

2. **Audit en 13 catégories** :
  - **Secrets et variables d'env** : recherche de clés/tokens en dur dans le code, vérification du `.gitignore`, vérification que les secrets ne sont pas commités dans l'historique Git
  - **Authentification et contrôle d'accès** : vérification que les pages admin/protégées ne sont pas accessibles sans login, que les règles d'accès sont appliquées côté serveur, que chaque utilisateur ne peut accéder qu'à ses propres données (pas à celles d'un autre en changeant un id dans la requête), et que changer d'email, de mot de passe ou supprimer son compte demande le mot de passe actuel
  - **Validation des inputs** : vérification que les données utilisateur sont validées côté serveur (zod, etc.), y compris les uploads de fichiers (type et taille)
  - **Injection SQL et requêtes BDD** : vérification que les requêtes sont paramétrées (pas de concaténation de chaînes)
  - **Headers de sécurité** : CSP, HSTS, X-Content-Type-Options, etc. La CSP qu'Hypervibe pose sur chaque site a deux parties : une base, appliquée, qui ne bloque rien de ce que le site charge, et une politique des scripts qui ne fait que signaler dans la console du navigateur ce qu'elle bloquerait. Un projet plus ancien la reçoit par la correction. La rendre bloquante reste votre décision, une fois ces signalements lus, et l'audit ne le fait jamais seul ; une CSP que vous avez écrite vous-même n'est jamais touchée
  - **CORS** : configuration des cross-origin requests
  - **Dépendances vulnérables** : `npm audit` sur les dépendances de production, framework compris
  - **Rate limiting et protection anti-abus** : protection contre le brute force et les abus (ex : sur le login)
  - **Exposition de données** : vérification que les réponses d'API et les logs ne fuient pas de données sensibles, et que l'inscription ou « mot de passe oublié » ne révèlent pas si quelqu'un a un compte
  - **Configuration Next.js** : réglages sûrs du framework (pas de secrets dans les bundles client, etc.)
  - **Webhooks** : vérification que les notifications envoyées par les services tiers (ex : Stripe après un paiement) sont authentifiées, pour que personne ne puisse fabriquer un faux « paiement reçu »
  - **Requêtes côté serveur (SSRF)** : vérification que votre serveur ne peut pas être manipulé pour appeler des adresses internes via une URL fournie par un utilisateur, notifications push comprises
  - **Liens et redirections** : vérification qu'une adresse glissée dans un lien (`?callbackUrl=...`) ne peut ni envoyer vos visiteurs vers un autre site, ni faire exécuter du code au moment où ils se connectent

3. **Rapport pédagogique** : chaque trouvaille est classée ✅ OK / ⚠️ À améliorer / 🔴 Critique. Pour chaque problème :
  - **Explication en langage simple** ("XSS = attaque où quelqu'un injecte du code malveillant dans une page que d'autres visitent")
  - **Conséquence concrète** ("si quelqu'un exploite cette faille, il peut voler les cookies de tes visiteurs")
  - **Correction proposée** avec le **pourquoi** du fix, pas juste le code

4. **Corrections automatiques** : Hypervibe corrige ce qui peut l'être sans risque (ajout de headers, fix dans le code, mise à jour des dépendances vulnérables). Pour le reste, elle vous propose le diff et vous validez.

## Ce que ça crée pour vous

- Un **rapport de sécurité complet** avec verdicts et explications
- Des **corrections appliquées** automatiquement (avec votre accord pour les changements de comportement)
- Une mise à jour potentielle de `CLAUDE.md` avec les conventions de sécurité du projet

## Prérequis

- Aucun prérequis particulier, `/security` peut tourner sur n'importe quel projet du plugin

## Astuces

{{callout:warning|Ne remplace pas un audit pro pour des cas sensibles}}
Si votre app traite des données médicales, financières, ou très personnelles (par ex. identité, biométrie), un audit professionnel reste indispensable. `/security` couvre 95 % des erreurs courantes mais ne remplace pas un expert qui creuse les cas business spécifiques à votre métier.
{{/callout}}

{{callout:tip|Lancez régulièrement}}
Les vulnérabilités évoluent vite (nouvelles failles dans des packages npm chaque semaine). Lancer `/security` tous les 2-3 mois est une bonne hygiène. Hypervibe propose les mises à jour automatiques pour les failles critiques et hautes.
{{/callout}}

{{callout:info|Pas alarmiste}}
Hypervibe est conçue pour **expliquer**, pas pour vous faire peur. Vous voyez chaque problème avec sa conséquence concrète, mais aussi la sévérité réelle (un site vitrine sans formulaire n'a pas les mêmes risques qu'un site avec auth + paiements). Vous priorisez ce qui compte vraiment.
{{/callout}}
