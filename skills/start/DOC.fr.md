# /start

Prépare votre ordinateur pour qu'il puisse créer des applications avec Hypervibe.

## Quand l'utiliser

C'est la **toute première commande** à lancer juste après avoir installé le plugin. Elle s'occupe de l'installation des outils nécessaires et de la connexion à vos comptes (GitHub, Vercel, base de données, etc.). Vous ne devriez avoir à la lancer qu'une seule fois.

## Comment ça se passe

1. **Bienvenue + détection** : la commande vérifie quel système vous utilisez (Windows, Mac, Linux).
2. **Audit silencieux** : elle regarde ce qui est déjà installé sur votre machine, sans rien casser.
3. **Installation automatique des bases** : si Node.js, Git ou pnpm manquent, ils sont installés tout seuls (sans rien vous demander).
4. **Rapport** : un récap clair vous montre ce qui est OK ✅, ce qui manque ❌, et ce qui est installé mais pas connecté ⚠️.
5. **Token Cloudflare** : Hypervibe vous guide pour générer un token (pas-à-pas, 1 minute), que vous collez dans une petite fenêtre masquée, jamais dans la conversation. Il est rangé dans votre coffre-fort pour de bon.
6. **Connexions CLI** : un script ouvre une fenêtre dédiée et vous fait vous connecter à GitHub, Vercel, Cloudflare l'un après l'autre. Vous suivez les instructions à l'écran (un navigateur s'ouvre pour chaque connexion).
7. **L'application GitHub de Vercel** : une fois Vercel connecté, la commande vérifie que l'application GitHub de Vercel est installée sur votre compte GitHub, avec l'accès à tous vos dépôts. C'est elle qui permet à chaque `git push` de remettre votre site en ligne tout seul. Si elle manque, ou si elle est limitée à certains dépôts, Hypervibe ouvre la bonne page et vous guide : c'est une autorisation à donner dans le navigateur, elle ne peut pas se faire à votre place.
8. **Clé Neon** : si vous avez connecté la base de données Neon, vous générez une clé API (encore 30 secondes) que la commande sauvegarde. Ça active les sauvegardes automatiques de vos futures bases.
9. **Clé email** : vous choisissez le service qui enverra les emails, Brevo en premier, Resend si vous préférez la connexion par GitHub, et vous générez sa clé, rangée dans votre coffre-fort. Elle sert aux emails de vos apps et aux alertes de vos projets (un quota proche, une sauvegarde ratée).
10. **Récap final + commandes** : à la fin, vous avez un tour d'horizon des commandes disponibles (`/bootstrap`, `/prof`, etc.).
11. **Règles globales** : un petit fichier de règles (`~/.claude/CLAUDE.md`) est créé pour que Claude Code suive vos conventions sur tous vos projets (pas de build pour rien, pas de push sans accord, etc.).

## Ce que ça crée pour vous

- Node.js, pnpm et Git installés et opérationnels
- GitHub, Vercel, Wrangler (Cloudflare) connectés à vos comptes
- Token Cloudflare et clé Neon API sauvegardés dans votre ordinateur. Vous n'aurez plus à les retaper
- Un fichier de règles globales pour Claude Code (`~/.claude/CLAUDE.md`)
- Une liste des commandes que vous pouvez maintenant utiliser

## Prérequis

Aucun. C'est par là que tout commence.

{{callout:info|Pourquoi tous ces outils}}
Pour créer des apps complètes, Hypervibe orchestre plusieurs services : GitHub stocke le code, Vercel met l'app en ligne, Neon héberge la base de données, Brevo ou Resend envoie les emails, Cloudflare gère le DNS et les fichiers. La commande `/start` installe et connecte tout ça **une seule fois** : ensuite vous n'y pensez plus.
{{/callout}}

{{callout:warning|Deux pièges avec GitHub et Vercel}}
Se connecter à Vercel « avec GitHub » n'installe pas l'application GitHub de Vercel : c'est une simple connexion, pas l'autorisation de lire vos dépôts. Et une installation limitée à « Only select repositories » ne voit pas les projets que vous créerez ensuite. Choisissez **All repositories** : vous n'aurez plus à y revenir.
{{/callout}}

{{callout:info|Si vous suivez une formation Hypervibe}}
Lancez la commande avec le code que vous donne votre module de formation (`/start hvi-…`). À la toute fin, et seulement si tout est au vert, `/start` prévient votre espace de formation que l'installation est faite : votre checklist se coche toute seule. Il n'envoie que ce code, rien d'autre sur vous ni sur votre ordinateur. Sans code, rien ne part.
{{/callout}}

{{callout:tip|Si quelque chose se passe mal}}
Le script qui installe les outils peut être interrompu (fermeture de fenêtre, connexion refusée, Ctrl+C). Aucun problème : relancez simplement `/start`. La commande détecte ce qui est déjà OK et reprend là où ça s'était arrêté. Pas de risque de tout casser.
{{/callout}}
