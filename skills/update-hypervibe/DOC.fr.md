# /update-hypervibe

Met Hypervibe à jour vers la dernière version publiée, sans quitter votre conversation.

## Quand l’utiliser

{{callout:info|Cela dépend de la façon dont vous avez installé Hypervibe}}
Si vous avez installé le plugin **avec une commande** (`/plugin marketplace add flavien-ia/hypervibe-harness`), Claude Code le tient déjà à jour tout seul. Cette commande vous le dira et vous donnera la commande native, plutôt que d’agir dans son dos.
{{/callout}}

- Vous avez installé Hypervibe en **téléversant le zip** dans Claude Desktop, et vous voulez savoir si une version plus récente est sortie
- Une nouvelle version a été annoncée et vous la voulez sans refaire l’installation à la main
- Vous voulez simplement savoir quelle version vous utilisez

## Comment ça se passe

1. **Elle regarde comment le plugin a été installé.** Claude Code tient un registre de la provenance de chaque plugin. Hypervibe le lit au lieu de deviner.

2. **Elle compare les versions.** La vôtre face à celle publiée dans le dépôt public. Si c’est la même, elle vous le dit, remet quand même à niveau les règles de Claude et les hooks git communs de cet ordinateur (sans rien écrire dans vos dépôts), puis passe aux étapes qui ont lieu aussi quand vous êtes déjà à jour.

3. **Elle télécharge la nouvelle version** depuis hypervibe.fr. Sans compte ni clé : le plugin est open source (Apache 2.0).

4. **Elle vérifie l’archive avant de toucher à quoi que ce soit.** La nouvelle version est déballée dans un dossier à part et inspectée : est-ce bien un plugin complet, la version est-elle celle attendue, rien n’essaie-t-il d’écrire en dehors de son dossier. Votre installation qui fonctionne n’est pas touchée tant que ces contrôles ne sont pas passés.

5. **Elle permute les dossiers et garde une sauvegarde.** L’ancienne version est mise de côté sous le nom `hypervibe-backup-<version>`. Si une étape échoue, elle est remise en place immédiatement : vous ne vous retrouvez jamais sans plugin. Sous Claude Desktop, cette sauvegarde ne sert que pendant la permutation elle-même : Desktop l’efface de lui-même quelques minutes plus tard, la commande ne vous la promet donc pas.

6. **Elle remet votre horloge partagée à niveau.** Si votre compte Cloudflare fait tourner l’horloge partagée d’Hypervibe (le worker `hypervibe-jobs`, qui porte les sauvegardes des bases, les alertes de quotas et les tâches planifiées), elle vérifie que l’horloge exécute bien le code de la version que vous avez désormais, et la redéploie sinon. Une horloge restée en arrière garde ses anciens défauts, même avec un plugin à jour. Cette vérification a lieu aussi quand vous êtes déjà à jour.

7. **Elle propose de fermer l’espace admin de vos projets existants.** Jusqu’à la 3.4.17, une page de l’espace admin que crée `/add-auth` pouvait laisser lire son contenu à quelqu’un qui la demandait sans être connecté. La commande cherche les projets de votre ordinateur qui ont encore ce défaut, vous les liste, et répare ceux que vous choisissez : chaque page admin vérifie alors elle-même que c’est bien vous, et les règles du projet cessent d’apprendre l’ancienne façon de faire à Claude. Rien n’est écrit avant votre réponse. La réparation ne protège votre site qu’une fois en ligne : la commande propose d’enregistrer le changement et de le publier, et la publication reste votre « oui ». Un projet tenu dans plusieurs dossiers (des copies de travail d’un même dépôt, chacune sur sa branche) n’est listé qu’une fois, le dossier de la branche d’où votre site part en ligne en premier. Ses autres dossiers ne sont jamais réparés par cette étape : quand ils ont encore les anciennes pages, la commande le dit en une ligne, en précisant s’ils portent du travail en cours, et vous pouvez les mettre à jour ou les retirer. Dans le même passage, et avec le même « oui », elle répare aussi les liens de connexion et de notification qui vérifient encore l’adresse où ils ramènent avec un filtre qu’un lien vers un autre site traverse. Une ligne que vous avez retouchée à la main est laissée telle quelle, et nommée : `/security` dans ce projet la corrige. Cette étape a lieu aussi quand vous êtes déjà à jour.

8. **Elle vous demande de taper `/reload-plugins`** (ou d’ouvrir une nouvelle conversation), c’est ce qui charge réellement la nouvelle version, garde-fous compris. Sous Claude Desktop, l’écran Plugins continue d’afficher le numéro de la version que vous aviez téléversée : c’est normal, et la commande vous dit quelle version tourne. Pour le savoir à tout moment, demandez « quelle version tourne ? » : la réponse est lue dans le plugin que Claude a chargé. Sur un ordinateur où le scan des secrets n’a jamais été installé, rien n’est écrit dans vos dépôts, et aucun n’est jamais déclaré de confiance pour ses hooks git à votre place.

## Ce que vous obtenez

- Le plugin mis à jour sur place, au même endroit
- La version précédente conservée en sauvegarde juste à côté, jusqu’à ce que vous décidiez de l’effacer (sauf sous Claude Desktop, qui l’efface de lui-même)
- Le catalogue local des plugins remis d’accord avec le nouveau numéro de version
- Votre horloge partagée alignée sur la version du plugin, si vous en avez une
- L’espace admin des projets que vous avez choisis fermé, sur votre site en ligne dès qu’ils sont republiés

## Bon à savoir

- **La sauvegarde n’est pas supprimée toute seule** (hors de Claude Desktop). Rechargez, vérifiez que tout fonctionne, puis demandez à la retirer.
- **Une mise à jour ratée ne vous coûte rien** : la version précédente est restaurée d’elle-même, et la commande vous dit ce qui a échoué.
- **Rien n’est envoyé à Hypervibe.** La vérification lit un fichier public, le téléchargement est anonyme. Le seul envoi est le code de votre horloge partagée, vers votre propre compte Cloudflare, et seulement quand elle était en retard.
