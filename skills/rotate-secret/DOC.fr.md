# /rotate-secret

Renouvelle une clé secrète partout où elle vit, en local et en ligne, en une seule commande. Stripe, Resend, Google, GitHub OAuth, secrets internes : Hypervibe vous guide selon le type de clé.

## Quand l'utiliser

- Vous **suspectez une fuite** d'une de vos clés (commit accidentel sur un repo public, capture d'écran partagée, etc.)
- Un **collaborateur quitte** votre équipe et vous voulez révoquer son accès indirect
- Vous faites une **rotation périodique** par hygiène de sécurité (tous les 3-6 mois sur les services critiques)

## Comment ça se passe

1. **Identification du secret** : vous pouvez passer le nom de la clé en argument (`/rotate-secret stripe`) ou Hypervibe vous présente une liste des secrets actuellement présents dans votre `.env` et vous choisissez.

2. **Type de secret** : Hypervibe détecte si c'est :
  - **Une clé tierce** (Stripe, Resend, Google OAuth, GitHub OAuth, Brevo, etc.) → il faut la régénérer côté provider
  - **Un secret auto-géré** (CRON_SECRET, AUTH_SECRET, etc.) → Hypervibe peut le régénérer toute seule

3. **Pour une clé tierce** : Hypervibe vous guide **clic-par-clic** dans le dashboard du provider concerné :
  - **Stripe** : dashboard.stripe.com/apikeys → Roll key
  - **Resend** : resend.com/api-keys → Revoke + Create new
  - **La clé d’envoi du projet chez Brevo** : Hypervibe fait au projet une nouvelle application d’envoi, puis supprime l’ancienne une fois votre site en ligne redéployé avec la nouvelle (jamais avant : il cesserait d’envoyer). Pour un secret qui a fuité, il le renouvelle tout de suite à la place, et le site est à redéployer aussitôt
  - **Google OAuth** : Google Cloud Console → identifiants → reset secret
  - **GitHub OAuth** : github.com/settings/developers → ton app → Generate a new client secret
  - Etc.
   
   Une petite fenêtre s'ouvre ensuite sur votre ordinateur : vous y collez la nouvelle valeur, jamais dans la conversation. Elle part directement dans `.env` et sur l'hébergement.

4. **Pour un secret auto-géré** : Hypervibe génère elle-même une nouvelle valeur cryptographiquement solide, sans rien vous demander.

5. **Push partout** :
  - Mise à jour de `.env` local
  - Mise à jour de Vercel (production + preview)
  - Idempotent : la **vieille valeur est écrasée**, pas juste ajoutée à côté

6. **Vérification** : Hypervibe vous propose de tester immédiatement (par exemple : `pnpm dev` + un test de checkout Stripe si c'était une clé Stripe).

## Ce que ça crée pour vous

- Une **nouvelle valeur** pour le secret choisi
- **Mise à jour partout** : `.env` local + Vercel (production + preview)
- L'**ancienne valeur** révoquée chez le provider (vous l'avez fait dans le dashboard pendant l'étape 3)
- Temps d'indisponibilité minimal : pour la plupart des providers vous créez la nouvelle clé à côté de l'ancienne, donc aucune interruption ; pour quelques-uns (par exemple le secret de webhook Stripe ou un mot de passe de base de données) l'ancienne valeur est invalidée dès que vous la régénérez, d'où une brève fenêtre jusqu'à ce que la nouvelle valeur soit poussée et redéployée

## Prérequis

- Vous devez être dans un projet existant (avec un `.env` ou une intégration Vercel active)
- Pour les clés tierces : un accès à votre compte chez le provider (Stripe, Resend, etc.)

## Astuces

{{callout:tip|Faites-le sans hésiter en cas de doute}}
Si vous avez le moindre doute sur la sécurité d'une clé (capture d'écran partagée par mégarde, commit suspect, ancien collaborateur qui aurait pu voir l'écran...), **renouvelez immédiatement**. Ça ne coûte que quelques minutes, et les conséquences d'une clé compromise (notamment Stripe pour les paiements) peuvent être désastreuses.
{{/callout}}

{{callout:info|Rotation périodique = bonne hygiène}}
Sur les clés les plus critiques (Stripe, AUTH_SECRET, clés admin) : pensez à les renouveler tous les 3-6 mois même sans suspicion de fuite. C'est une protection contre les fuites silencieuses (un commit ancien sur un repo public, une variable d'env qui aurait fuité dans des logs, etc.).
{{/callout}}

{{callout:warning|Webhook secrets = procédure spécifique}}
Pour les `STRIPE_WEBHOOK_SECRET` ou autres webhook secrets, la rotation est un peu plus subtile : il faut recréer le webhook côté provider, et la clé est différente entre local (CLI `stripe listen`) et production. Hypervibe le sait et vous guide selon le cas (ne touche pas au `.env` local quand vous rotatez le webhook prod, et vice versa).
{{/callout}}
