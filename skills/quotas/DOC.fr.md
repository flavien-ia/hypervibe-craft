# /quotas

Affiche où en est votre consommation sur chaque service face aux plafonds des plans gratuits. Pratique pour anticiper un dépassement sans devoir ouvrir 6 dashboards séparés (Neon, Cloudflare, Brevo, Resend, Vercel).

## Quand l’utiliser

- Vous voulez **anticiper un dépassement** de quota et basculer sur un plan payant à temps
- Vous voulez **comprendre** où en sont vos forfaits gratuits (sans devoir ouvrir 6 dashboards séparés)
- Vous voulez vérifier après une montée en charge (par ex. un lancement de produit) qu’aucun service n’est en limite

## Comment ça se passe

1. **Lancement du script** : Hypervibe exécute en parallèle 6 fetchers qui interrogent les API de chaque service. Ça prend 2 à 5 secondes.

2. **Récupération des données** : pour chaque service, Hypervibe lit :
  - **Neon** : nombre de projets utilisés, storage utilisé (par projet, jusqu’à 1 Go chacun et 20 Go en tout, lu sur les branches de chaque projet comme Neon le mesure), heures de calcul utilisées (jusqu’à 100h / mois / projet)
  - **Cloudflare R2** : Go stockés, opérations lecture/écriture, et la taille de chaque bucket
  - **Cloudflare Workers** : requêtes / jour, slots cron utilisés sur les 5 gratuits
  - **Brevo** : emails envoyés / mois (jusqu’à 300/jour gratuits)
  - **Resend** : emails envoyés / mois (3 000 gratuits) + 100/jour
  - **Vercel** : bandwidth, fonctions, builds, hobby seats

3. **Affichage en tableau** : chaque métrique a :
  - **Utilisation** vs **plafond** (par ex. *"0.247 Go / 1 Go (24,7 %)"*)
  - **Verdict emoji** : ✅ (sous 70 %), ⚠️ (70-90 %), 🔴 (90 %+), et ❓ pour un chiffre qui n’a pas pu être lu : jamais un 0 % vert
  - **Projection** quand applicable (par ex. *"Au rythme actuel, vous atteindrez le plafond dans 18 jours"*)

4. **Breakdown détaillé** : pour Neon (qui a des quotas **par projet**), Hypervibe affiche aussi le détail par projet, pour identifier exactement lequel consomme le plus. Pour R2, quand le stockage approche de son plafond, il nomme vos trois plus gros buckets, avec leur taille et leur nombre de fichiers (en lecture seule : rien n’est supprimé).

5. **Conseils** : pour chaque verdict ⚠️ ou 🔴, Hypervibe propose des actions concrètes (alléger le projet, passer au plan supérieur, etc.).

6. **Le coût du mois, si vous le demandez** : demandez combien ça vous coûte, et Hypervibe ajoute une estimation limitée à ce qu’il lit ou calcule à coup sûr : la facturation de Vercel lui-même sur un plan payant (avec le mois à ce rythme), le stockage R2 au-delà de ses 10 Go gratuits, le plan gratuit de Neon à 0 $. Il dit ce qu’il ne compte pas : l’abonnement Cloudflare (la clé n’a pas le droit de lire la facturation) et les forfaits des services d’email. Une estimation, jamais la facture.

7. **Surveillance quotidienne (vérifiée au passage)** : pendant qu’elle y est, Hypervibe s’assure que votre surveillance quotidienne de quotas est en place : un petit job sur votre **horloge partagée** (le mécanisme mutualisé qui exécute aussi vos tâches planifiées et vos sauvegardes de base) vérifie chaque jour votre stockage Cloudflare R2 et vous envoie un email si vous approchez des 10 Go gratuits (alerte à partir de 9 Go). Aucune machinerie à part, aucune place Cloudflare en plus.

## Ce que ça crée pour vous

- Un **rapport tableau** avec votre consommation actuelle sur les 6 services principaux
- Une vue **par projet** quand c’est pertinent (Neon notamment)
- Des **recommandations** pour anticiper un dépassement
- Aucune modification de vos comptes ou forfaits : le rapport est en lecture seule. La seule chose que `/quotas` peut mettre en place (la première fois), c’est le **job de surveillance quotidienne** sur votre horloge partagée, pour être prévenu par email entre deux rapports

## Prérequis

- Les services concernés doivent être connectés à votre ordi (via `/start` ou via les clés API user-scope)
- Vous pouvez lancer `/quotas` depuis n’importe quel dossier, c’est une vue **compte-wide**, pas projet-spécifique

## Astuces

{{callout:tip|Lancez tous les mois}}
Un coup d’œil régulier (chaque début de mois) vous évite la mauvaise surprise du dépassement. C’est particulièrement utile sur Neon (qui a des quotas par projet) et Resend (3 000 emails / mois passe vite si vous avez plusieurs apps). Et entre deux rapports, la surveillance quotidienne sur votre horloge partagée garde un œil sur votre stockage pour vous.
{{/callout}}

{{callout:info|Plans gratuits = vraiment confortables}}
Pour la grande majorité des projets perso ou petit business, vous resterez bien en dessous des plafonds gratuits. Hypervibe le précise dans le rapport quand un service est *très* loin de la limite (par ex. *"vous utilisez 2 % de Cloudflare R2, vous êtes tranquille pour des années"*).
{{/callout}}

{{callout:warning|Neon = plafonds par projet}}
Particularité Neon : le 1 Go de storage et les 100h de calcul sont **par projet**, pas par compte, et le stockage a aussi un plafond sur tout le compte : 20 Go pour l’ensemble des projets. **Chaque projet** ne doit pas dépasser 1 Go. Hypervibe affiche le breakdown par projet pour identifier celui qui est en train de saturer.
{{/callout}}
