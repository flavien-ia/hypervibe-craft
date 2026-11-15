# /add-test

Donne à votre projet des **tests automatisés** et un **cahier de recette** lisible par n'importe qui, plus le garde-fou qui maintient les deux en vie : rien n'est publié tant qu'une fonctionnalité n'a pas sa vérification.

> **« Recette »** vient de *recevoir* : dans le monde professionnel, c'est le moment où celui qui a commandé un logiciel le reçoit et dit « oui, c'est conforme » ou « non, voici mes réserves ». Un cahier de recette est la liste de ce que l'application doit faire et de la façon dont on vérifie chaque point.

## Quand l'utiliser

- Vous voulez savoir que l'application **marche encore après chaque changement**, sans la re-cliquer à la main à chaque fois
- Quelqu'un doit **valider** votre application (un responsable, un client, une DSI) et a besoin d'un document qui dit ce qu'elle fait et comment le vérifier
- Vous construisez pour une organisation qui attend de ses outils internes la même rigueur que de ses prestataires : **recette, documentation, maintenabilité**
- Une publication a été refusée avec un message « recette » et vous voulez comprendre et corriger

## Comment ça se passe

1. **Vérification** : si le projet a déjà ses tests et son cahier, Hypervibe vous propose un menu (compléter la recette après une nouvelle fonctionnalité, la lancer, réinstaller le garde-fou).

2. **Installation de vitest**, le lanceur de tests : rapide (quelques secondes, pas de navigateur), et configuré pour que les modules du serveur se chargent sans vraie base ni vraies clés.

3. **Inventaire** : Hypervibe liste chaque fonctionnalité du serveur (chaque procédure tRPC) et chaque page de votre application, et relit votre cahier des charges (`cahier-des-charges.md`, si vous avez choisi le cahier des charges complet dans `/bootstrap`) pour les règles métier.

4. **Le cahier de recette** (`docs/recette.md`) : une ligne par fonctionnalité. Ce qu'elle fait, comment on la vérifie, le résultat attendu, si c'est un test ou une personne qui vérifie, et son statut. Écrit en mots métier, pas en code. Les pages ont un scénario qu'un humain peut suivre dans un navigateur.

5. **Les tests** : au moins un par procédure, chacun tagué avec la ligne du cahier qu'il couvre (`recette: R-07`). Ils vérifient de vrais résultats et de vrais refus (une action protégée rejette un visiteur anonyme, un formulaire invalide est refusé, une écriture écrit bien ce qu'elle doit), contre une base simulée. Ils ne touchent jamais vos vraies données ni un service en ligne.

6. **Vert, puis complet** : les tests passent, et le contrôle confirme que chaque procédure a son test et chaque page sa ligne.

7. **Le garde-fou** : un hook lance les tests et le contrôle **avant chaque publication** depuis votre ordinateur, et une action GitHub fait la même chose pour tout le monde, à chaque push. Une publication refusée dit exactement ce qui manque.

8. **La règle dans `CLAUDE.md`** : désormais, ajouter une fonctionnalité, c'est ajouter sa ligne et son test. Claude Code relit cette règle à chaque session et le fait de lui-même.

## Ce que ça crée pour vous

- `docs/recette.md` : le cahier de recette, avec sa table de signature en bas (le « procès-verbal »)
- `tests/` : un fichier de tests par routeur, plus un utilitaire qui appelle votre API exactement comme l'application le fait
- `vitest.config.ts` et les commandes `pnpm test` / `pnpm recette`
- `scripts/check-recette.mjs` : le contrôle (versionné, il tourne sur chaque machine et en intégration continue)
- `.hooks/pre-push` : le garde-fou avant publication (versionné aussi, pour que chaque collaborateur l'ait ; il ne s'exécute que dans un clone qui l'a activé, ce que cette commande fait pour le vôtre, parce qu'un clone n'exécute jamais de lui-même les hooks qu'il transporte)
- `.github/workflows/tests.yml` : le même garde-fou sur GitHub, visible de tous
- Deux lignes dans `CLAUDE.md` qui rendent la règle permanente

## Prérequis

- Le projet doit être en Next.js (typiquement initialisé par `/bootstrap`)
- `/start` fait sur la machine (il installe les hooks git globaux sur lesquels le garde-fou s'appuie) ; sinon le garde-fou est installé pour ce dépôt seulement

## Conseils

{{callout:info|Un test n'est pas la promesse que rien ne peut casser}}
Une suite verte veut dire « la logique que nous avons écrite se comporte comme écrit ». Elle ne reproduit ni une contrainte de la vraie base, ni la panne d'un service tiers, ni une page qui s'affiche mal. C'est à ça que servent les lignes manuelles du cahier : une personne suit le scénario sur la version en ligne et signe le procès-verbal.
{{/callout}}

{{callout:tip|Une publication refusée, c'est le garde-fou qui fait son travail}}
Le message liste ce qui manque : une procédure sans test, une page absente du cahier, un test qui échoue. Ouvrez Claude Code et demandez « complète la recette et les tests manquants ». Ne contournez jamais le garde-fou avec `--no-verify` : tout l'intérêt est qu'une fonctionnalité sans vérification ne puisse pas atteindre la production.
{{/callout}}

{{callout:warning|Les pages sont vérifiées par des personnes, pour l'instant}}
Les tests de parcours dans un navigateur (Playwright) ne font pas partie de cette version. Une page a un scénario manuel dans le cahier, écrit pour un humain. Le cahier est conçu pour que des parcours automatisés s'y ajoutent plus tard sans rien changer.
{{/callout}}

{{callout:info|Le cahier est le document à remettre}}
Si quelqu'un valide votre application, donnez-lui `docs/recette.md`. Les lignes manuelles sont sa liste de contrôle, la table de signature en bas est l'endroit où il consigne sa décision, avec ou sans réserve. C'est la logique du dossier de recette d'un prestataire, appliquée à ce que vous construisez vous-même.

Si personne n'a à valider votre application, la table de signature ne sert à rien et Hypervibe la retire. Le cahier, lui, reste utile : c'est votre mémoire de ce que l'app doit faire, six mois plus tard, et il est déjà écrit le jour où quelqu'un vous le demande.
{{/callout}}
