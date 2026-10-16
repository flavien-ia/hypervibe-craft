# /add-email

Active **l'envoi d'emails transactionnels** depuis votre app, via Resend ou Brevo. Pour les formulaires de contact, les confirmations, les notifications, les emails de bienvenue, etc.

## Quand l'utiliser

- Vous voulez ajouter un **formulaire de contact** sur votre site
- Vous voulez envoyer des emails automatiques à vos utilisateurs (confirmation d'inscription, mot de passe oublié, notification d'événement)
- Vous voulez envoyer des emails depuis votre propre domaine (`contact@monsite.fr`) plutôt que depuis un service tiers

## Resend ou Brevo ?

La skill **gère les deux providers** et choisit automatiquement, sans question, selon ce que vous avez déjà :

| Vos variables d'env | Provider installé | Note |
|---|---|---|
| Aucune | **Resend par défaut** | Vous créerez la clé après, la skill vous dit comment |
| `RESEND_API_KEY` seule | Resend | silencieux |
| `BREVO_API_KEY` seule | Brevo | silencieux |
| Les deux | **Brevo par défaut** | Mentionné dans le résumé final pour que vous puissiez switcher si besoin |

{{callout:info|Pourquoi ces défauts}}
**Resend** est le défaut quand on part de zéro : DX moderne (intégrations Next.js soignées), free tier de 3 000 emails/mois, facile à débuter. **Brevo** prend la main quand les deux clés sont là parce que c'est un service européen avec CRM et marketing email intégrés - typique d'une stack "pro" plus avancée. Dans les deux cas, vous pouvez switcher manuellement en supprimant la config et en relançant `/add-email`.
{{/callout}}

## Comment ça se passe

1. **Vérification** : Hypervibe regarde si un provider est déjà configuré dans CE projet. Si oui, un menu vous propose de changer l'adresse d'expédition, le destinataire, créer une page `/contact`, ou tout refaire - **sans switcher de provider** (Resend reste Resend, Brevo reste Brevo).

2. **Choix automatique du provider** (si install neuf) : règle de décision basée sur vos clés env (voir tableau ci-dessus). Aucune question posée.

3. **Vérification des prérequis** :
   - Pour Resend : une clé API Resend rangée dans le coffre-fort (item `RESEND`) - créée une fois sur resend.com/api-keys
   - Pour Brevo : une clé API Brevo (coffre-fort `BREVO`, ou `BREVO_API_KEY` en session)

4. **Installation du SDK + scaffolding** :
   - Le SDK approprié est installé (`resend` ou `@getbrevo/brevo`)
   - Un fichier `src/server/mail.ts` est créé avec une fonction `sendMail()` réutilisable + tous les garde-fous (`escapeHtml` pour Resend, `escapeForBrevo` pour Brevo qui a un quirk de templating Mustache silencieux)
   - Un router tRPC `contact` est ajouté pour gérer le formulaire de contact côté serveur (honeypot anti-spam, rate limiting, sanitisation), quand l'envoi sert à un formulaire de contact et que le projet a déjà sa limitation de débit ; sinon, la page de contact l'ajoute plus tard

5. **Variables d'environnement** : les bonnes clés sont poussées dans `.env` + Vercel.

6. **Adresse d'expédition (optionnel)** : pour Resend, vous démarrez sur `onboarding@resend.dev` (adresse de test) et Hypervibe vous propose de configurer votre domaine (ajout DNS records dans Cloudflare, vérification Resend automatique). Pour Brevo, vous renseignez votre expéditeur dès le départ, et Hypervibe le crée chez Brevo par son API quand votre compte ne l'a pas encore, puis vérifie qu'il est actif.

7. **Page de contact (optionnel)** : à la fin, Hypervibe vous propose de créer une page `/contact` fonctionnelle (formulaire Nom, Email, Message + react-hook-form + zod, responsive). Il vous demande où les messages doivent arriver : une vraie boîte, jamais une adresse que votre domaine ne fait que relayer ailleurs (ce relais peut les envoyer dans les indésirables).

## Ce que ça crée pour vous

- Selon le provider choisi : une **clé API Resend** ou **Brevo**, lue depuis le coffre-fort (item `RESEND` ou `BREVO`)
- Le SDK approprié installé (`resend` ou `@getbrevo/brevo` v5+)
- `src/server/mail.ts` avec `sendMail()` + helper d'échappement (`escapeHtml` ou `escapeForBrevo`)
- Un router tRPC `contact` (`src/server/api/routers/contact.ts`) pour le formulaire
- Les variables d'env nécessaires (`RESEND_API_KEY` + `RESEND_FROM_EMAIL`, ou `BREVO_API_KEY` + `BREVO_SENDER_EMAIL` + `BREVO_SENDER_NAME`) dans `.env` + Vercel
- Pour Brevo : une section `## Email - Brevo quirk` dans votre `CLAUDE.md` projet (mémo du piège du templating silencieux)
- Si vous le souhaitez : votre **domaine configuré dans le provider** avec les DNS records ajoutés à Cloudflare
- Si vous le souhaitez : une **page `/contact`** complète et fonctionnelle

## Prérequis

- Le projet doit être en Next.js avec tRPC (typiquement initialisé par `/bootstrap`)
- Une clé email rangée dans le **coffre-fort** : soit Resend (item `RESEND`, 3000 emails/mois), soit Brevo (item `BREVO`, 300/jour ≈ 9000/mois). `/add-email` la détecte automatiquement et, si elle manque, vous guide pour la créer et la ranger dans le coffre.
- Pour configurer un domaine personnalisé : votre domaine doit être géré par Cloudflare (sinon lancez `/add-domain` d'abord)

## Astuces

{{callout:warning|Resend - adresse de test = vous seul recevez les emails}}
Par défaut, `RESEND_FROM_EMAIL` est `onboarding@resend.dev` (adresse de test Resend). Avec cette adresse, **les emails ne peuvent partir que vers VOTRE propre adresse** (celle de votre compte Resend). C'est parfait pour vérifier que tout marche, mais pas suffisant pour envoyer à vos utilisateurs. Pour envoyer à n'importe qui, configurez votre domaine (Hypervibe vous le propose à la fin de la skill).
{{/callout}}

{{callout:warning|Brevo - un expéditeur actif}}
Côté Brevo, l'adresse d'expédition (`BREVO_SENDER_EMAIL`) doit être un **expéditeur actif**. Hypervibe le crée par l'API de Brevo quand votre compte ne l'a pas, et lit son état : sur un domaine que Brevo a authentifié, il est actif tout de suite ; sinon, Brevo envoie un message de confirmation à cette adresse, à ouvrir une fois. Sans expéditeur actif, les emails partent en erreur silencieuse - Brevo accepte la requête mais ne livre pas.
{{/callout}}

{{callout:tip|Plans gratuits}}
- **Resend** : 3 000 emails/mois, 100/jour
- **Brevo** : 300 emails/jour (≈ 9 000/mois)

Largement suffisant pour démarrer dans les deux cas. Brevo est plus généreux sur le volume mensuel, Resend a une DX un peu plus fluide.
{{/callout}}

{{callout:info|Comment switcher de provider}}
Si vous avez installé Resend et voulez passer à Brevo (ou inversement) : supprimez la config actuelle (clé dans `.env` + fichiers `src/server/mail.ts` + `src/server/api/routers/contact.ts`), assurez-vous d'avoir la clé du provider cible dans le coffre-fort (item `RESEND` ou `BREVO`), puis relancez `/add-email`. La skill installera le nouveau provider proprement.
{{/callout}}
