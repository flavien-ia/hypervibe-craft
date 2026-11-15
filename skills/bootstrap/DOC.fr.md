# /bootstrap

Crée un projet web complet à partir de votre description en quelques phrases. Code, hébergement, base de données, paiements : tout est mis en place pour avoir une app en ligne en 15 à 25 minutes.

## Quand l'utiliser

Pour démarrer un nouveau projet. C'est la commande la plus puissante du plugin : vous lui décrivez ce que vous voulez en quelques phrases, et elle construit toute l'app.

## Comment ça se passe

Le bootstrap se déroule en **8 étapes**, avec deux phases d'autonomie totale et une phase de discussion au milieu :

**Phase 1 : Construction automatique** (~5 minutes, sans intervention)
1. Vous donnez le **nom du projet** et une **description courte**.
2. Hypervibe construit le squelette de l'app : structure du code, repo GitHub, configuration Vercel, première page en ligne, vérifications de sécurité. Vous regardez défiler les étapes ; à la fin, votre site répond déjà avec une page minimale et le déploiement automatique est validé.

**Phase 2 : Ce qu'on construit** (durée variable, discussion)
3. Hypervibe vous demande **comment vous voulez définir le projet**, avec deux options :
  - **Le cœur de votre app** (recommandé) : vous décrivez la chose que votre app doit bien faire, en un ou deux écrans. En vibe coding, c'est ce qui donne les meilleurs résultats : le cœur fonctionne d'abord, vous l'ajustez jusqu'à ce qu'il soit juste, puis vous ajoutez les fonctions une par une, au fil de vos besoins. Une app construite d'un bloc se pilote mal, et une partie finit souvent par être retirée.
  - **Un cahier des charges complet** : vous le construisez ensemble, question par question (pages, design, fonctionnalités), et Hypervibe construit tout ce qu'il décrit.
4. Hypervibe vous présente un **récap** des fonctionnalités déduites (base de données, authentification, emails, paiements, etc.) et attend votre validation. Vous pouvez modifier la liste autant que vous voulez avant de valider.

**Phase 3 : Construction de l'app** (~10-15 minutes, sans intervention)
5. **Configuration des modules** (un par un) : base de données, authentification, emails, paiements, multilingue, stockage… selon votre validation.
6. **Construction de l'application** : avec le cœur, uniquement ses un ou deux écrans (et l'espace admin si le cœur en a besoin), finis et soignés ; avec le cahier des charges complet, toutes les pages qu'il décrit. Mise en page responsive dans les deux cas.
7. **Pages légales** automatiquement créées (mentions légales, politique de confidentialité conforme RGPD).
8. **Audit sécurité + push final + récap** : vérification des dépendances, déploiement, et un récap complet de ce qui a été fait et de ce qui reste éventuellement à faire de votre côté (créer un compte sur tel service, configurer un domaine, etc.).

À la fin, vous avez un site en ligne, fonctionnel, avec toutes les briques techniques en place.

## Ce que ça crée pour vous

- Un projet **Next.js 15** complet (structure, dépendances, configuration)
- Un **repo GitHub privé** avec tout le code versionné
- Un **projet Vercel** avec déploiement automatique (chaque modification se déploie toute seule)
- Une **URL en ligne** où votre app est accessible immédiatement
- Selon ce que vous avez choisi : base de données, authentification, emails, paiements, multilingue, stockage, analytics
- Les **pages légales** (mentions légales + politique de confidentialité RGPD-friendly)
- Un fichier `CLAUDE.md` qui sert de mémoire à Claude pour ce projet (avec le cœur, il garde ce qu'est le cœur, ses écrans et ce que vous avez laissé pour plus tard)
- Le tout **hébergé en Europe** (Frankfurt) pour la latence et la conformité RGPD

## Prérequis

- `/start` doit avoir été lancé une fois sur votre machine (outils installés + comptes connectés)
- Si vous comptez ajouter une base de données, une clé API Neon doit être dans votre coffre-fort (Hypervibe vous guide pour l'ajouter au besoin)

## Astuces

{{callout:tip|Si la session s'interrompt}}
Le bootstrap est long. Si la conversation Claude est interrompue en cours de route (limite de contexte, erreur, fermeture accidentelle), pas de panique : dites simplement **"continue"** dans le même chat. Hypervibe relit son propre fil et reprend là où il s'était arrêté. Aucun travail n'est perdu.
{{/callout}}

{{callout:info|Vous n'écrivez aucune ligne de code}}
Vous décrivez votre projet en langage naturel, vous validez les choix qu'on vous propose. Tout le reste, code, configuration, déploiement, sécurité, est entièrement automatisé. Vous n'avez **rien** à taper dans un terminal.
{{/callout}}

{{callout:tip|Commencer par le cœur, puis le faire grandir}}
Avec le cœur, le récap final vous dit la suite : essayez le cœur, demandez les corrections que vous voulez jusqu'à ce qu'il soit juste, puis ajoutez une fonction à la fois, simplement en la décrivant en une phrase.
{{/callout}}

{{callout:warning|Choix du nom = définitif}}
Le nom de projet que vous donnez à l'Étape 1 devient le nom du repo GitHub et du projet Vercel. Ces deux noms sont compliqués à changer après. Choisissez bien (en kebab-case, par exemple : `ma-super-app`).
{{/callout}}
