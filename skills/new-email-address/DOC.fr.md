# /new-email-address

Crée une **nouvelle adresse de réception** sur un domaine déjà connecté (par exemple `support@monsite.fr` redirigé vers votre Gmail).

## Quand l'utiliser

- Vous avez connecté votre domaine via `/add-domain` et vous voulez créer plusieurs adresses (`contact@`, `support@`, `hello@`, `info@`…)
- Vous voulez recevoir des emails sur votre domaine sans créer une vraie boîte mail
- Vous voulez créer un **catch-all** (`*@monsite.fr` qui redirige tout vers une seule boîte)

## Comment ça se passe

1. **Vérification Cloudflare** : Hypervibe vérifie que votre token Cloudflare est valide. Sinon, elle vous renvoie vers `/start`.

2. **Identification du domaine** : Hypervibe regarde dans le `CLAUDE.md` de votre projet pour récupérer le domaine déjà connecté. Si elle ne le trouve pas, elle vous le demande.

3. **Activation d'Email Routing** : Hypervibe active discrètement Email Routing sur votre zone Cloudflare (idempotent, pas de souci si déjà actif). Au premier passage, Cloudflare ajoute automatiquement les records MX + SPF nécessaires.

4. **Préfixe de l'alias** : Hypervibe vous demande le préfixe que vous voulez (la partie avant le `@`), par exemple `support`, `hello`, `info`, `contact`, `bonjour`, `moi`. Vous pouvez aussi répondre `*` ou "toutes" pour créer un catch-all.

5. **Destination** :
  - Si Hypervibe a déjà été appelée depuis `/add-domain` et que vous avez fourni une adresse de destination, elle est réutilisée.
  - Sinon, Hypervibe liste vos destinations déjà vérifiées (s'il y en a) et vous propose de les réutiliser, ou d'en ajouter une nouvelle.
  - Si c'est une nouvelle destination, Cloudflare lui envoie un email de vérification, vous devez cliquer sur le lien dans votre boîte mail, puis dire à Hypervibe "c'est fait".

6. **Création de la règle** : Hypervibe crée la règle de redirection dans Cloudflare. À partir de maintenant, les emails reçus sur `<préfixe>@<domaine>` sont redirigés instantanément vers votre boîte cible.

7. **Test** : Hypervibe vous propose de tester en envoyant un email vers la nouvelle adresse depuis une autre boîte. Si plusieurs adresses à créer, Hypervibe reboucle pour gagner du temps.

## Ce que ça crée pour vous

- Une **nouvelle règle de redirection** dans Cloudflare Email Routing
- Si c'est la première fois sur ce domaine : **Email Routing activé** + records MX/SPF posés automatiquement
- Si c'est une nouvelle destination : un email à vérifier dans votre boîte

## Prérequis

- Votre domaine doit déjà être géré par Cloudflare (typiquement après `/add-domain`)
- Cloudflare connecté à votre ordi (`/start` s'en occupe)

## Astuces

{{callout:tip|Catch-all = utile pour ne rien rater}}
Si vous voulez **tout recevoir** sur votre domaine (`n'importe.quoi@monsite.fr` → votre boîte), répondez `*` quand Hypervibe vous demande le préfixe. C'est pratique si vous donnez votre adresse sous différentes formes à différents services (`amazon@monsite.fr` pour Amazon, `netflix@monsite.fr` pour Netflix, etc.). Vous savez instantanément qui a partagé votre email si vous recevez du spam.
{{/callout}}

{{callout:info|Vous répondez depuis votre boîte habituelle}}
Email Routing ne **reçoit** que les emails. Pour **envoyer** depuis votre domaine (`contact@monsite.fr`), il faut configurer un service comme Resend (`/add-email`) ou ajouter votre domaine dans Gmail/Outlook comme alias d'envoi.
{{/callout}}

{{callout:warning|Vérifiez vos spams au premier ajout}}
La première fois que vous utilisez une destination, Cloudflare envoie un email de vérification, il atterrit parfois dans le dossier spam de votre boîte mail. Pensez à vérifier avant de dire à Hypervibe "c'est fait", sinon la règle ne fonctionnera pas.
{{/callout}}

{{callout:info|Une clé Cloudflare faite avant cette version}}
Activer Email Routing chez Cloudflare demande une permission que les clés faites par les versions précédentes d'Hypervibe n'ont pas : **Zone Settings** (Edit). Si Cloudflare refuse pour cette raison, Hypervibe vous le dit et vous propose deux issues : ajouter cette permission à votre clé chez Cloudflare (une minute, la clé garde sa valeur), ou activer Email Routing une fois vous-même dans le tableau de bord de Cloudflare. Les clés faites désormais l'incluent.
{{/callout}}
