# Changelog

## v3.4.17 (26 octobre 2026)

### Sécurité
- **Les pages de votre espace admin se protègent chacune** : jusqu'ici, l'espace admin que crée `/add-auth` n'avait qu'une protection, posée dans la mise en page commune à toutes ses pages. Or Next.js prépare chaque page en même temps que cette mise en page. Quand un visiteur sans session était renvoyé vers la connexion, le contenu de la page, déjà prêt, partait avec la réponse : un navigateur n'en montre rien, une simple requête le lit en entier. Constaté le 26 octobre sur de vrais sites construits avec Hypervibe. Désormais chaque page vérifie elle-même que c'est bien vous avant de lire la moindre donnée, et une première barrière renvoie vers la connexion toute visite sans session avant que la page soit préparée. La règle est écrite dans le CLAUDE.md de vos projets, pour les pages que Claude ajoutera ensuite ; `/bootstrap` la suit quand il construit l'espace admin d'une application, et `/add-role` pour sa page des utilisateurs.
- **Vos sites existants : relancez `/security` dans chacun.** Il repère une page admin protégée par sa seule mise en page, en donne la preuve sans risque (la taille de la réponse que reçoit un visiteur sans session) et propose la correction. Il signale aussi les défauts voisins, vus sur des sites réels : une action du serveur que n'importe qui peut déclencher, des données personnelles glissées dans le code envoyé aux navigateurs, un traitement coûteux (IA, envois en masse) qu'on lance sans être connecté, un formulaire public qui écrit à l'adresse qu'on lui donne (un relais de spam au nom de votre domaine), un agent qui lit des emails et croit l'adresse de l'expéditeur, qui s'invente.
- **Next.js et next-auth à jour** : `/security` connaît les failles de 2026 sur l'optimiseur d'images de Next.js, et les versions qui les corrigent : 15.5.28 sur la branche qu'installe `/bootstrap`, 16.4.1 ou plus sur la 16, la bêta 32 de next-auth. Un projet créé il y a des mois garde ses anciennes versions tant que personne ne les met à jour.
- **Le garde-fou dit ce qu'un push forcé efface** (retours de Bastien Detraz) : pour un `git push --force`, la question de confirmation nommait les commits qui partent, jamais ceux que le dépôt en ligne perd. Elle les nomme maintenant aussi, et un « oui » ne couvre plus un push qui avait l'air ordinaire.

### Améliorations
- **`/delete-project` ne dit plus « sans perte » sans l'avoir vérifié** (retours de Bastien Detraz) : pour un dossier sans infrastructure, il se fiait au souvenir que la copie locale gardait du dépôt en ligne. Un dépôt en ligne supprimé (le cas courant d'un vieux projet), du travail mis de côté avec `git stash` ou un commit que porte une seule étiquette passaient donc pour « supprimable sans perte ». Le dépôt en ligne est désormais interrogé directement : s'il ne répond pas, le verdict est « inconnu », et une sauvegarde est proposée d'abord. Aucune commande de cet inventaire ne lance plus un programme nommé dans la configuration du dossier, qui a pu être copié de n'importe où.
- **`/delete-project` reconnaît enfin un dossier sans infrastructure** : la 3.4.16 avait ajouté ce parcours pour un vieux projet ou une maquette qui n'a rien dans le cloud (savoir si son code serait perdu, une sauvegarde d'abord, les notes et les skills qui le nomment encore), mais il ne se déclenchait presque jamais. L'inventaire comptait comme une vérification ratée chaque service où vous n'avez pas de compte sur cet ordinateur : Upstash et Render chez presque tout le monde, parfois aussi l'hébergeur, la base, le stockage ou les sauvegardes. Un tel service est désormais laissé de côté, et nommé en une ligne, quand rien dans le projet n'y renvoie. Dès qu'une variable, un paquet, le dossier lié ou le manifeste du projet y renvoie, Hypervibe continue de dire qu'il n'a pas pu vérifier ce service. Un coffre fermé ou un service qui ne répond pas restent signalés comme avant.

### Coulisses
- Chaque point a sa recette, éprouvée en abîmant le code décision par décision.
- La protection de l'espace admin est éprouvée sur un vrai Next.js, en version 15 et en version 16 : la recette construit un petit site à partir des fichiers d'Hypervibe et l'interroge sans session. Avec les fichiers de la version précédente, la réponse emporte la page ; avec ceux-ci, elle ne contient plus rien de la page. Elle se joue avant chaque version.
- La fermeture programmée du coffre gagne une vérification : la copie qui verrouille le coffre à l'heure démarre seule, même quand une mise à jour a retiré entre-temps le dossier de la version précédente.

## v3.4.16 (23 octobre 2026)

### Sécurité
- **Une clé d'envoi d'emails par projet** : jusqu'ici, `/add-email` copiait dans chaque projet la clé de votre compte Resend ou Brevo entier. Il suffisait d'un `.env` vu sur un écran partagé, d'une formation filmée ou d'un hébergeur qui fuit pour ouvrir tout le compte : ses domaines, ses contacts, l'envoi de tous vos projets. Chaque projet reçoit maintenant une clé à lui. Chez Resend, Hypervibe la fabrique : elle ne sert qu'à envoyer, et seulement depuis votre domaine une fois celui-ci vérifié. Chez Brevo, dont le service ne fabrique pas de clé à la demande, Hypervibe vous guide pour la créer au nom du projet. La clé du compte reste dans votre coffre-fort, pour les gestes sur le compte lui-même (signalé par Jérôme Carfantan).
- **Vos projets existants** : relancez `/add-email` dans chacun. Il repère un projet qui tient encore la clé du compte et propose de lui donner la sienne. Une fois chaque projet passé à sa propre clé, renouvelez la clé de votre compte chez Resend ou Brevo, rangez la nouvelle dans votre coffre et faites réenregistrer l'alerte de `/quotas` : les anciennes copies (dans des `.env`, chez l'hébergeur, dans des enregistrements de formation) cessent alors de marcher.
- **Le coffre se referme pour de bon, au bout de six heures** : la session durait douze heures, et à son terme le fichier de session restait sur le disque, toujours capable d'ouvrir le coffre. Elle dure maintenant six heures, puis le coffre est réellement verrouillé : la fermeture est programmée dès l'ouverture (ordinateur éteint, elle se fait à la session suivante), et revérifiée à chaque démarrage. Hors Windows, le fichier de session n'est plus lisible que par son propriétaire. Pour les participants, une protection de plus : un ordinateur resté ouvert ne laisse plus leurs clés à portée toute la nuit.
- **Le garde-fou montre les commits qui partent** : quand il demande de confirmer un `git push`, il liste maintenant les commits que ce push va envoyer. Un « oui » donné pour un seul commit avait emporté avec lui deux commits d'une autre session du même dépôt.

### Améliorations
- **La règle sur les lectures en base, réécrite** (retours de Bastien Detraz) : elle nomme `findFirst` et le `.select()` sans colonnes, même pour vérifier un seul champ (mesuré : 530 Ko par ligne, 2,1 Go en trois semaines), demande de mettre en cache la lecture plutôt que la page, avec les outils de Next 15 et de Next 16, et explique pourquoi un délai de 600 secondes ne suffit pas (un visiteur automatique avait fait passer une base de 7 à 17 heures d'éveil par jour). Elle vaut aussi sur un plan payant, où ce temps d'éveil fait la facture. Vos projets la reçoivent à leur prochaine synchronisation, sauf si vous l'aviez retouchée.
- **`/quotas` mesure enfin le stockage de vos bases** : Neon répondait 0 pour la taille de chaque projet, sur les plans payants (retour de Bastien Detraz) et depuis peu sur le plan gratuit, et le tableau affichait un 0 % vert devant des bases pleines. La taille se lit maintenant là où Neon calcule son plafond, et un chiffre illisible s'affiche comme tel, jamais comme un 0. Le plafond du plan gratuit est remis à jour : 1 Go par projet, 20 Go en tout.
- **`/quotas` nomme vos plus gros buckets** : quand le stockage de fichiers approche de son plafond, il affiche les trois plus gros, avec leur taille et leur nombre de fichiers.
- **`/quotas` estime le coût du mois, si vous le demandez** : la facturation de Vercel sur un plan payant, le stockage au-delà des 10 Go gratuits, le plan gratuit de Neon. Il dit aussi ce qu'il ne compte pas.
- **`/delete-project` sur un dossier sans infrastructure** : un vieux projet ou une maquette n'a rien dans le cloud, seul son dossier est en jeu. La commande dit si son code serait perdu (jamais commité, jamais poussé, aucun dépôt) ou s'il peut partir sans perte, propose d'abord une sauvegarde, et retrouve les notes et les skills qui le nomment encore.

### Coulisses
- Chaque point a sa recette, éprouvée en abîmant le code décision par décision.

## v3.4.15 (20 octobre 2026)

### Améliorations
- **Le garde-fou lit une commande rangée dans une variable** : `G=git; $G push --force origin main` ou `A=-A; git add $A` passaient sans question, parce que le garde-fou lisait la ligne telle qu'elle était tapée. Quand la ligne pose elle-même la variable, il lit maintenant la commande que le shell va vraiment lancer (relecture de Bastien Detraz).
- **Plus d'angle mort après un long mot** : quand un long mot bâti sur une variable précédait l'adresse d'une API passée à curl par son entrée standard, cette adresse pouvait échapper au garde-fou. Chaque lecture repart désormais du début (relecture de Bastien Detraz).
- **Une question de moins sur un heredoc protégé** : le texte d'un `<<'EOF'` n'est plus lu à travers les variables de la ligne, puisque le shell n'y remplace rien.
- **Le relevé d'avant la bascule interroge tous les résolveurs** : `/add-domain` recopie les enregistrements existants avant de changer les serveurs de noms. Un seul résolveur qui croyait encore absent un nom créé quelques minutes plus tôt suffisait à le faire oublier. Un enregistrement n'est plus tenu pour absent que si tous les résolveurs le disent.

### Coulisses
- Chaque point a sa recette, éprouvée en abîmant le code décision par décision.

## v3.4.14 (19 octobre 2026)

### Améliorations
- **Le garde-fou lit le corps d'une fonction écrite sur une ligne** : `f() { git push; }; f` passait sans question, alors que la même fonction écrite sur trois lignes demandait. Son corps est lu désormais comme n'importe quel bloc, que la fonction soit appelée ou non (relecture de Bastien Detraz).
- **Une adresse d'API bâtie sur une variable, jusque dans la configuration que reçoit curl** : quand l'adresse arrive à curl par son entrée standard, le garde-fou la lit à travers les variables de la ligne, comme il le faisait déjà sur la ligne elle-même.
- **La recette passe de nouveau sur Mac** : le contrôle du dossier de téléchargements assemblait un chemin Windows à la manière de la machine qui le testait.
- **Trois textes remis à jour** : l'installation de l'espace d'administration ne renvoie plus à des valeurs « visibles dans les journaux », qui n'y sont plus ; l'aide au mot de passe dit où va vraiment celui de la production ; et `/add-email` dit ce que fait la page de contact d'une adresse relayée : il te la déconseille, te le redit une fois, puis respecte ton choix.

### Coulisses
- Chaque point a sa recette, éprouvée en abîmant le code décision par décision.

## v3.4.13 (16 octobre 2026)

### Améliorations
- **Brevo suit son nouveau format** : quand tu relies ton domaine à Brevo, Hypervibe publie ce que Brevo demande aujourd'hui (deux enregistrements pour la signature, un DMARC sans lequel Brevo refuse le domaine), sans jamais doubler ton DMARC ni durcir sa politique, puis envoie un message d'essai et vérifie qu'il est bien signé. L'ancienne méthode perdait la signature.
- **L'expéditeur Brevo se crée tout seul** : plus de détour par le tableau de bord, l'adresse d'expédition est créée par l'API de Brevo et son état vérifié, dans la variable que ton site lit vraiment.
- **Les messages de ton formulaire ne finissent plus dans les indésirables** : si les adresses de ton domaine ne font que relayer vers ta boîte, Hypervibe te demande ta vraie boîte au lieu de passer par ce relais.
- **Un envoi d'emails sans formulaire de contact** : `/add-email` ne pose plus le moteur d'un formulaire quand tu n'en veux pas, ni un fichier qui casserait la compilation.
- **Ton mot de passe d'administration ne passe plus par la conversation** : il est écrit dans un fichier de ton vrai dossier de téléchargements, et `/rotate-secret` sait le renouveler de la même façon.
- **Le garde-fou lit l'adresse d'une API rangée dans une variable** : une suppression chez Cloudflare, Neon ou Vercel passait sans question sous cette forme (relecture de Bastien Detraz).
- **Vercel CLI 64** : `/optimize` lit les requêtes avec la nouvelle commande, et `/delete-project` ne prend plus une demande de la CLI pour une liste vide.
- **/security** repère les remboursements Stripe rendus en trop.

### Coulisses
- Chaque point a sa recette, éprouvée en abîmant le code décision par décision.

## v3.4.12 (14 octobre 2026)

### Améliorations
- **/geo commence par l'essentiel : les robots d'IA peuvent-ils lire votre site ?** Hypervibe vérifie d'abord que le texte de vos pages est bien dans la page reçue (presque aucun robot d'IA n'exécute de JavaScript), qu'aucun pare-feu ne les refoule (le réglage Cloudflare est lu quand votre clé le permet), et ce que votre robots.txt leur dit.
- **/geo s'appuie sur une liste datée et sourcée des robots d'IA** : chaque robot, son éditeur, son rôle (index de recherche d'un moteur IA, lecture à la demande, entraînement) et la page officielle qui le dit. Les trois options du robots.txt se construisent à partir d'elle. Elle corrige plusieurs erreurs : le robot de Google présenté à tort comme réglant les AI Overviews, des robots absents (dont celui de la recherche de ChatGPT), des noms périmés.
- **/geo présente les paris comme des paris** : llms.txt (aucun grand moteur ne confirme le lire) et le balisage FAQ (Google n'en affiche plus les encarts depuis mai 2026) sont proposés, sans promesse.
- **/geo vous aide à savoir si vous êtes cité** : les questions de vos clients, posées aux IA par vous, et le résultat gardé pour la fois suivante.
- **/seo regarde aussi le site en ligne** : un noindex involontaire, l'adresse en .vercel.app qui double votre domaine, des redirections temporaires, des liens cassés, un plan du site qui liste des pages en erreur.
- **/seo donne un score stable**, calculé sur une grille fixe et gardé dans le projet. Le volume de recherche n'est plus inventé : les chiffres de Search Console quand il est relié, sinon « inconnu ». Le référencement local entre dans l'audit.
- **Le référencement de base des nouveaux projets** : l'adresse du site ne retombe plus sur localhost en production, le robots.txt nomme le plan du site, une image de partage est dessinée d'office.
- **/gsc** propose de relier Bing Webmaster Tools, dont l'index sert aussi Copilot.
- **/delete-project voit tout ce que le projet a chez Cloudflare** : toutes les zones du compte, tous leurs enregistrements et toutes leurs règles de routage d'adresses, page après page. Jusqu'ici, il s'arrêtait à la première page (50 zones, 200 enregistrements et 50 règles par zone), et une zone illisible passait pour une zone vide ; elle est désormais signalée.

### Coulisses
- La liste des robots d'IA est relue chaque semaine sur les pages officielles de leurs éditeurs.

## v3.4.11 (14 octobre 2026)

### Améliorations
- **Ton courrier ne se perd plus quand tu branches ton domaine** : avant de confier ton domaine à Cloudflare, `/add-domain` relève ce qu'il porte déjà (les serveurs de ta messagerie, ton SPF, ton DMARC, les clés DKIM des grands fournisseurs, un blog ou une boutique sur un sous-domaine), le recopie dans la nouvelle zone et le relit. Un domaine sur Google Workspace ou chez la messagerie d'OVH cessait sinon de recevoir son courrier quelques minutes après la bascule. Si quelque chose n'a pas pu être relu ou recopié, la bascule attend.
- **Une adresse de redirection ne prend plus le courrier de vraies boîtes** : `/new-email-address` refuse d'activer la redirection de Cloudflare sur un domaine dont le courrier arrive déjà chez un fournisseur de messagerie, et te propose de créer l'adresse chez lui. Il vérifie aussi que la redirection est bien active avant de te l'annoncer.
- **Le garde-fou te demande avant de changer un domaine chez son registraire** : changer les serveurs de noms chez LWS, Hostinger, Gandi, OVH, Porkbun ou Namecheap déplace tout le domaine, et passait sans question alors qu'une simple réécriture chez Cloudflare demandait déjà (relecture de Bastien Detraz). Les lectures passent toujours.
- **OVH sans clé sur la ligne de commande** : les appels à OVH sont signés à l'intérieur du plugin, avec tes trois clés lues dans ton coffre-fort. Une clé ne passe plus jamais en argument d'une commande, et le pointage ne dépend plus d'un outil absent des Mac.
- **Tes clés ne passent jamais par la conversation** : chez Namecheap, Porkbun et OVH, Claude disait encore « donne-les-moi » juste avant d'ouvrir la fenêtre faite pour ça. Il annonce maintenant la fenêtre, où tu les colles directement. IONOS et Infomaniak ne te font plus créer de clé « pour plus tard » qu'aucune commande n'utilisait.
- **L'expéditeur de tes emails n'est plus écrasé** : relancer `/add-email` ne remplace plus une adresse d'expédition vérifiée par l'adresse de test de Resend, qui n'écrit qu'au titulaire du compte.
- **Un mot de passe oublié ne trahit plus qu'un compte existe** : sur les sites qui le proposent, la réponse est la même, que l'adresse ait un compte ou non, même quand l'envoi de l'email échoue.

### Coulisses
- Les commandes de domaine et d'email lisent la clé Cloudflare dans le coffre à chaque étape, au lieu de supposer qu'une étape précédente l'avait chargée.
- Chaque point a sa recette, éprouvée en abîmant le code décision par décision.

## v3.4.10 (12 octobre 2026)

### Nouveautés
- **Les domaines achetés chez LWS** : `/add-domain` sait maintenant pointer tout seul un domaine LWS vers Cloudflare. Il lui faut une clé d'accès, à créer une fois dans ton espace LWS, et l'adresse de ton ordinateur, à autoriser sur la même page. Si LWS refuse, la marche à suivre à la main reste à une étape.

### Améliorations
- **Les fenêtres du coffre-fort se présentent** : chaque fenêtre où tu tapes un mot de passe ou une clé commence par dire ce qu'elle est, que Claude ne voit rien de ce que tu y tapes, et qu'une faute de frappe se rattrape en recommençant. Une testeuse avait été arrêtée par cette fenêtre noire pendant sa préparation.
- **Une installation plus facile à suivre** : `/start` dit où regarder avant de dire quoi faire (la zone de l'écran, puis le bouton exact), te propose dès l'accueil de lui envoyer une capture d'écran si tu bloques, et annonce chaque fenêtre avant qu'elle s'ouvre, avec l'endroit où la retrouver si elle s'ouvre derrière Claude.
- **Brevo sans détour par tes DNS** : si tu avais déjà un compte Brevo, `/start` te demande seulement de vérifier ton adresse d'expédition. L'authentification de ton domaine attend `/add-domain` puis `/add-email`, qui s'en chargent.
- **Un dépôt créé par l'API de GitHub demande ton accord, sauf s'il est dit privé** : GitHub rend public un dépôt créé par son API quand la demande ne précise rien, et le garde-fou ne posait la question que si « public » était écrit en toutes lettres (relecture de Bastien Detraz).
- **`/delete-project` te rend le droit de supprimer des dépôts** : GitHub garde ce droit tant qu'on ne le lui retire pas. Une fois le dépôt supprimé, la commande te propose de le rendre, avec le même petit code sur une page GitHub (relecture de Bastien Detraz).

### Coulisses
- Chaque point a sa recette, éprouvée en abîmant le code décision par décision. Une nouvelle vérification s'assure que chaque prestataire de domaine a sa route dans `/add-domain`.

## v3.4.9 (10 octobre 2026)

### Améliorations
- **Une seule fenêtre de mot de passe à la fois** : quand deux tâches trouvaient ton coffre-fort fermé à la même minute, chacune ouvrait sa fenêtre, et il fallait taper ton mot de passe deux fois. Désormais, un coffre déjà ouvert n'ouvre aucune fenêtre, et une seconde demande attend celle qui est ouverte au lieu d'en ouvrir une autre.
- **Ton coffre-fort reste à un seul endroit** : une simple vérification de l'outil du coffre recréait un ancien fichier de connexion, vide, tourné vers le serveur américain de Bitwarden. Plus aucune commande ne passe à côté du dossier unique.
- **`/delete-project` supprime aussi le dépôt de code créé par `/bootstrap`** : c'était jusqu'ici une étape à faire à la main. Hypervibe ne supprime que ce dépôt-là, celui qu'il a créé pour le projet, et laisse tout autre dépôt à ta main. L'inventaire le dit avant que tu choisisses, tu peux le garder, et GitHub demande d'abord une autorisation de plus : un code à coller sur une page GitHub.
- **Tester un paiement sans taper de commande** : après `/add-stripe`, dis simplement « on teste un paiement ». Claude lance le site et le relais de Stripe, vérifie qu'un produit est achetable en mode test, puis te donne les liens et la carte de test.
- **Un mot de passe avec un `$` arrive entier** : ton site relisait `pa$$w0rd` comme `pa$`. Les valeurs sont maintenant écrites pour qu'il les relise telles quelles, y compris celles que tu récupères depuis l'hébergeur.
- **Le garde-fou de GitHub ne se contourne plus en déplaçant un mot** : fusionner, supprimer ou rendre un dépôt public demande ta confirmation même quand la commande est écrite autrement, ou passe par l'API de GitHub. Supprimer une publication et renommer un dépôt demandent aussi.

### Coulisses
- Chaque point a sa recette, éprouvée en abîmant le code décision par décision ; la lecture des `$` est vérifiée avec le chargeur de Next lui-même. Une liste d'exemples d'outils corrigée dans `/start`.

## v3.4.8 (8 octobre 2026)

### Améliorations
- **La veille des quotas voit de nouveau tes bases Neon** : sur certains comptes, Neon refuse désormais de lister les bases tant qu'on ne lui dit pas de quelle organisation il s'agit, et la veille quotidienne de ton horloge ne voyait plus aucune base, donc aucun dépassement. Elle retient maintenant ton organisation Neon quand elle est certaine : celle rangée dans ton coffre-fort, ou la seule de ton compte. La mise à jour de l'horloge, que `/update-hypervibe` te propose, suffit : rien à reconfigurer.
- **Quand l'organisation ne se devine pas, tu sais quoi faire** : si ton compte Neon appartient à plusieurs organisations, Hypervibe ne choisit jamais à ta place, et `/quotas` te donne la marche à suivre. Il suffit de ranger l'identifiant de la bonne organisation dans ton coffre-fort, puis de relancer `/quotas`.
- **Le mail d'alerte dit quoi faire** : quand Neon réclame l'organisation, le mail explique où trouver son identifiant (dans la console Neon, rubrique Organization settings) et où le ranger, avec un message tout prêt à coller dans Claude Code. La réponse brute de Neon reste en bas, pour qui veut la lire.

### Coulisses
- Une nouvelle recette joue chaque cas avec un faux Neon : une seule organisation, plusieurs, aucune, une clé d'organisation, Neon injoignable, et une horloge mise en place avant ce correctif.

## v3.4.7 (6 octobre 2026)

### Améliorations
- **Une page Cloudflare s'ouvre une fois vers la fin de `/start`**, sur un compte Cloudflare tout neuf : l'ouvrir suffit à activer le réglage dont les tâches automatiques ont besoin. Il n'y a rien à faire dessus, tu peux la fermer, et `/start` termine tout seul.
- **Le garde-fou pose aussi ses questions sur GitHub** : avant d'accepter une demande de fusion ou de relancer une mise en ligne (les deux publient), et avant de supprimer, rendre public ou déplacer quelque chose là-bas (un dépôt, un secret, une variable). Il le faisait déjà pour un envoi par `git push`.
- **Changer la clé des tâches planifiées n'en casse plus aucune** : `/rotate-secret` la met aussi à jour dans le dépôt quand `/add-cron` y a installé son horloge de secours. Avant, chaque tâche lancée par GitHub était refusée après le changement.
- **`/add-collab` ne dit « retiré » que quand c'est vrai** : il relit toute la liste, annule une invitation encore en attente, et une lecture ratée n'est plus prise pour un départ.
- **`/delete-project` trouve le bon dépôt** : il le lit dans le dossier du projet, y compris quand le dépôt appartient à une organisation, au lieu de le deviner. Une lecture ratée n'est plus prise pour une absence, et quand il doit deviner, il te demande de confirmer.

### Coulisses
- Deux nouvelles vérifications à chaque version : aucune commande écrite dans une skill n'est refusée par le garde-fou, et chaque skill trouve elle-même le dossier du plugin et le nom de l'organisation dont elle se sert.

## v3.4.6 (6 octobre 2026)

### Améliorations
- **La réparation de la vérification de code marche aussi avec un ancien pnpm** : un projet resté sur une ancienne version de pnpm 10 ne lisait pas le réglage posé par la 3.4.5, et `pnpm lint` restait cassé après la réparation. Elle demande maintenant à pnpm, dans le projet, où il lit ce réglage, et l'écrit aussi dans `.npmrc` quand il le faut. Les nouveaux projets naissent de la même façon. Le fichier de verrou ne bouge toujours pas, et rien n'est touché sans ton accord.
- **Une réparation qui ne suffit pas est dite** : `/update-hypervibe` l'annonce franchement au lieu de laisser croire que c'est réglé.

## v3.4.5 (6 octobre 2026)

### Améliorations
- **La vérification de code de tes projets remarche** : sur les projets créés par `/bootstrap` avec une version récente de pnpm, `pnpm lint` s'arrêtait sur « ESLint couldn't find the plugin ». Les nouveaux projets naissent avec le bon réglage, et `/update-hypervibe` propose de réparer le projet ouvert : un réglage ajouté, une réinstallation d'une minute, et le fichier de verrou ne bouge pas. Rien n'est touché sans ton accord.
- **Une clé arrive en ligne telle quelle** : une ligne recopiée d'un `.env` avec des guillemets (`CLE="valeur"`) partait chez l'hébergeur avec ses guillemets. Elle est désormais lue comme ton site la lit : guillemets retirés, note de fin de ligne laissée de côté.
- **Un mot de passe avec un `#` reste entier** : une valeur tapée dans la fenêtre masquée, ou écrite dans ton `.env`, est mise entre guillemets quand il le faut, pour que ton site la relise exactement.

### Coulisses
- Une seule règle pour lire et écrire une ligne de `.env`, partagée par tous les outils qui en manipulent, avec ses recettes.

## v3.4.4 (5 octobre 2026)

### Nouveautés
- **Hypervibe sur Google Antigravity** : le harnais tourne aussi dans Antigravity, en vrai plugin, avec les mêmes skills, le même garde-fou et le même serveur MCP. hypervibe.fr sert une version convertie et explique comment l'installer : hypervibe.fr/plugin/antigravity. Tes routines y tournent dans le planificateur d'Antigravity : la mission que tu valides, les permissions les plus étroites, et c'est toi qui l'allumes dans le tableau Automations.

### Coulisses
- Les recettes vérifient que chaque routine a son texte pour chaque outil qui sait planifier.
- Le contrôle de durée du garde-fou mesure désormais ce que coûte le garde-fou lui-même, et non plus la vitesse de la machine : il échouait dès que l'ordinateur était chargé.

## v3.4.3 (5 octobre 2026)

### Améliorations
- **Tes processus Render tournent en Europe** : une automatisation réveillée par ton site ou un agent, créés par le harnais, tournent désormais à Francfort. Jusqu'ici, faute de région précisée, Render les plaçait par défaut dans l'Oregon, aux États-Unis. Un service déjà créé ne change pas de région tout seul : la marche à suivre pour le recréer à Francfort est indiquée.

### Coulisses
- Une recette vérifie à chaque version que chaque service décrit par le harnais tourne à Francfort.

## v3.4.2 (5 octobre 2026)

### Améliorations
- **Les automatisations sur Render se réveillent enfin** : un processus gratuit chez Render devait être réveillé par votre horloge partagée, ce qu'elle n'a jamais su faire, si bien qu'il ne tournait pas. C'est maintenant une route de votre site qui le réveille aux heures choisies, avec un secret que seuls les deux connaissent.
- **Un processus répond tout de suite** : il accepte le travail, répond, puis travaille. Il ne répondait qu'à la fin, et un appel qui n'attendait pas assez le croyait en panne.
- **Supprimer un projet supprime aussi son agent** : le service Render d'un agent (environ 7 USD par mois) et sa clé d'IA plafonnée survivaient à la suppression du projet. Ils sont désormais inscrits dans le projet, et `/delete-project` reconnaît aussi un agent créé avant cette version, par le dépôt dont il est construit.
- **Le passage en monorepo ne casse plus le projet** : les automatismes du dépôt et la liste des ressources du projet restent à leur place, aucun fichier de secrets ne peut entrer dans le commit, et on vous dit quel réglage changer chez Vercel avant de pousser.
- **/add-domain** ne dit plus « redéployé » quand le redéploiement d'un Worker Cloudflare a échoué.
- **/rotate-secret** ne se tait plus quand le coffre ou Render n'ont pas pu être lus, et dit quand Render a refusé un redéploiement.
- **Les emails d'erreur d'un agent** ne se perdent plus en silence quand le motif contient des accolades.

### Coulisses
- Cinq vérifications de plus à chaque version, dont une qui lance pour de vrai le code d'un processus.

## v3.4.1 (4 octobre 2026)

### Améliorations
- **Le coffre-fort sous Windows** : avec Claude Desktop installé depuis le Microsoft Store, le coffre ouvert dans Claude paraissait fermé pour tout programme lancé à côté (le bouton « Run » d'un bloc de commande, le terminal intégré), et chaque côté redemandait le mot de passe maître à tour de rôle. Le coffre garde désormais sa connexion dans un seul dossier, le même pour tous les programmes. La connexion déjà faite y est recopiée une fois, sans rien effacer : rien à refaire de votre côté.
- **/accessibility** : sa présentation courte suit maintenant le format des autres commandes.

### Coulisses
- Les vérifications lancées avant chaque version n'ouvrent plus jamais le coffre : l'une d'elles lisait le vrai coffre de la machine. Elle a désormais son propre dossier, et un garde-fou fait échouer toute vérification qui lancerait l'outil du coffre.

## v3.4.0 (3 octobre 2026)

Une nouvelle commande pour que votre application serve tout le monde.

### Nouveautés
- **`/accessibility`** : un audit d'accessibilité de votre application. Hypervibe lit votre code (images sans texte de remplacement, boutons qui ne sont qu'une icône, champs sans étiquette, éléments que le clavier n'atteint pas, focus invisible, zoom bloqué sur mobile), mesure vos pages en ligne (le score d'accessibilité et les contrastes de couleur), vous explique chaque problème en mots simples, puis applique les corrections que vous validez. Les choix de design restent les vôtres. Utile avant un lancement, et depuis juin 2025 une obligation pour de nombreux services vendus aux particuliers dans l'Union européenne.

### Coulisses
- Une recette neuve : chaque règle de l'audit est vérifiée dans les deux sens, ce qui exclut quelqu'un est signalé, son équivalent accessible ne l'est pas.

## v3.3.11 (2 octobre 2026)

Version de correction nourrie par la relecture hebdomadaire des sessions réelles : le paiement, les liens piégés, la suppression d'un projet, et un défaut des emails de l'horloge partagée.

### Sécurité
- **Liens piégés à la connexion** : sur les pages de connexion de l'administration et de la double authentification, l'adresse de retour lue dans le lien était suivie telle quelle. Un lien fabriqué pouvait envoyer la personne sur un autre site, ou faire exécuter du code juste après sa connexion. Seul un chemin interne est désormais accepté. Même règle pour le lien d'une notification, dans la cloche comme au clic sur une notification du téléphone ou de l'ordinateur.
- **`/security`, un treizième contrôle** : toute navigation construite depuis une adresse venue de l'extérieur est cherchée, et classée critique. Quatre angles morts sont aussi couverts : les actions sensibles du compte (changer d'email ou de mot de passe demande le mot de passe actuel), la découverte de qui est inscrit, l'adresse où revient un paiement, et les notifications push.
- **Notifications push** : l'adresse d'un abonnement doit être celle d'un service de notification connu (Google, Mozilla, Apple, Microsoft). Un utilisateur connecté pouvait jusque-là faire écrire le serveur à l'adresse de son choix.
- **Compte Stripe** : la commande qui liste les comptes reliés affichait la clé de test dans la conversation. Elle ne montre plus que le nom du compte.

### Améliorations
- **`/add-stripe` et la nouvelle version de Stripe** : la version 23 de la bibliothèque, sortie le 30 septembre, refusait le code généré. Le gabarit est corrigé, et la version est désormais nommée à l'installation.
- **`/add-stripe`, le bon compte** : si vous avez plusieurs comptes Stripe, Hypervibe vous fait confirmer celui qui encaissera les paiements du projet, au lieu de prendre celui que l'outil Stripe avait en tête.
- **`/add-stripe`, ce qu'on oublie** : le lien vers vos CGV est placé à côté du bouton de paiement, un email à l'acheteur et une notification pour vous sont proposés après chaque vente, et avant le passage au réel Hypervibe vous rappelle le nom que verra l'acheteur et propose de retirer les commandes laissées par vos essais.
- **`/delete-project`** : l'inventaire s'affiche toujours avant la question de périmètre, dont les choix ne proposent plus de garder ce que le projet n'a pas. Si le coffre-fort s'est refermé entre la validation et l'exécution, rien n'est supprimé : auparavant le site partait, puis la base échouait sur une clé « manquante » qui existait bel et bien.
- **`/optimize` et `/clean`** : quand un autre travail est en cours dans le dossier du projet, les correctifs se préparent dans un dossier à part, sans copie de vos clés, et ce dossier est retiré à la fin. `/optimize` sait aussi chercher ce qui empêche la base de s'endormir.
- **`/security`, les briques vulnérables** : celles qu'une autre brique amène sont mises à jour par la bonne commande, et ce qui reste figé par cette autre brique est classé et noté, au lieu de revenir à chaque audit.
- **Alertes de l'horloge partagée** : un email d'alerte dont le texte contenait des accolades (la réponse d'un site, le message d'un fournisseur) pouvait être accepté par le service d'envoi, puis jeté. `/update-hypervibe` met votre horloge à niveau.
- **Création d'un site** : les icônes de marque (Instagram, LinkedIn, GitHub) ont quitté la bibliothèque d'icônes. `/bootstrap` le sait, et ne bute plus dessus.

### Coulisses
- L'outil des variables d'environnement sait retirer une variable, affiche son aide, et rappelle qu'une valeur remplacée ne compte qu'à la prochaine mise en ligne. Une valeur du coffre n'est recopiée dans un projet que si vous l'avez demandé.
- La vérification d'une mise en ligne renouvelle elle-même sa connexion à l'hébergeur, et fonctionne depuis un dossier de travail à part.
- Quatre recettes neuves : le retrait d'une variable, la vérification d'une mise en ligne, la suppression d'un projet coffre fermé, et ce que les gabarits laissent passer d'une adresse venue d'ailleurs.

## v3.3.10 (1er octobre 2026)

Version de correction consacrée au garde-fou, nourrie par la réécriture de ses règles pour la prochaine architecture et par une relecture extérieure de la 3.3.9.

### Sécurité
- **Garde-fou, les mots habillés** : `git "push"`, `git add '-A'` ou `git add \-A` passaient sans question ni refus. Chaque mot est lu comme le terminal le remet à la commande, quels que soient ses guillemets.
- **Garde-fou, les options de git** : elles sont lues comme git les lit, abrégées (`--har` pour `--hard`), groupées, ou placées plus loin dans la ligne (`git reset HEAD~1 --hard`, `git commit -m "x" -a`).
- **Garde-fou, les essais à blanc** : un `--dry-run` n'épargne la confirmation que si la commande le lit vraiment comme tel. Annulé plus loin, glissé dans une valeur ou collé à un autre mot, il laissait partir un vrai push sans question.
- **Horloge partagée** : les scripts qui la redéploient sont lus avec leurs propres options. Un `--dry-run` donné à un script qui ne le connaît pas n'évite plus la confirmation, et le renouvellement d'une clé la demande toujours.
- **Script rangé dans une variable** : la confirmation est demandée même quand le chemin du script passe par une variable posée sur la ligne.
- **Pousser en sautant les tests** : le refus tient aussi sous la forme abrégée de `--no-verify`.

### Améliorations
- **Plugin atteint par un lien** : sur macOS, ou quand le dossier du plugin passe par un lien symbolique, une quinzaine de scripts ne faisaient rien, sans le dire. Ils tournent normalement.
- **Fiches des commandes** : `/start`, `/rotate-secret`, `/add-google-auth` et `/add-storage` décrivent la petite fenêtre où se colle une clé, jamais la conversation.
- **Reprise d'un projet existant** : une base reconnue par sa seule adresse n'est plus inscrite deux fois dans la fiche du projet.

### Coulisses
- Trois recettes neuves : le démarrage des scripts à travers un lien, les fiches des commandes, et la table de permissions d'OpenCode comparée au garde-fou.

## v3.3.9 (30 septembre 2026)

Version de correction consacrée à l'horloge partagée (tâches planifiées, sauvegardes, veille des quotas), nourrie par le retour d'un utilisateur qui y a migré huit projets.

### Améliorations
- **Sauvegardes des bases** : chaque base a désormais sa propre minute dans l'heure de sauvegarde. Au-delà d'une dizaine de bases, les sauvegardes lancées toutes ensemble dépassaient la limite de l'offre gratuite de Cloudflare et échouaient.
- **Veille des quotas** : quand elle n'a pas pu lire un service, elle vous le dit par email au lieu de se taire.
- **Renouvellement de la clé des tâches planifiées** : `/rotate-secret` la pose aussi sur l'horloge. Sans ça, toutes les tâches du projet étaient refusées après une rotation.
- **Horloge GitHub** : elle n'est plus présentée comme illimitée (sur un dépôt privé, chaque passage compte une minute du quota gratuit), et sa petite tâche d'entretien mensuelle n'est plus ajoutée qu'aux dépôts publics, les seuls que GitHub met en sommeil.
- **Horloge partagée** : une vérification qui échoue (réseau, limite de débit) n'est plus prise pour une horloge absente, et son accès de contrôle (état, déclenchement manuel) est rallumé sur les comptes qui le permettent.
- **Suppression d'un projet** : ses tâches et sa sauvegarde partent avec lui, même marquées « partagées » par erreur.
- **Reprise d'un projet existant** : sa base est retrouvée dans toutes les organisations Neon de la clé, et le message dit pourquoi quand elle ne l'est pas.

### Sécurité
- **Garde-fou** : il demande confirmation avant tout script du plugin qui redéploie l'horloge partagée, comme le promet la page de sécurité.
- **Tâches planifiées** : leur adresse reste fermée tant que la clé manque.
- **Création d'un agent** : la clé Cloudflare ne s'affiche plus dans la conversation.

## v3.3.8 (30 septembre 2026)

### Améliorations
- **`/start` vérifie l'application GitHub de Vercel** : une fois Vercel connecté, `/start` vérifie que l'application GitHub de Vercel est installée sur votre compte GitHub, avec l'accès à tous vos dépôts. C'est elle qui permet à chaque `git push` de remettre votre site en ligne tout seul. Si elle manque, ou si elle est limitée à certains dépôts, `/start` ouvre la bonne page et vous guide pas à pas. Jusqu'ici, le problème ne se voyait qu'après le premier `/bootstrap`, quand les mises en ligne suivantes ne partaient pas.
- **`/bootstrap` trouve votre dossier de projets** : sous Windows, un chemin avec des espaces était mal lu, et un dossier de projets au nom libre était ignoré au profit d'un dossier `DEV` qui n'existait pas. `/bootstrap` propose désormais le dossier où vous travaillez, ou son parent, dès qu'il contient déjà des projets.
- **Tests automatiques sur GitHub** : les tests posés par `/add-test` s'arrêtaient dès leur deuxième étape dans un projet qui déclare pnpm dans son `package.json`. La dernière version d'un outil de GitHub y cherchait pnpm avant qu'il soit installé. C'est corrigé.

### Coulisses
- Nouvelles vérifications à chaque version : aucune commande lancée par un script ne dépend du terminal de Mac et Linux, chaque automatisme GitHub installe Node sans ce comportement, et le choix du dossier de projets est rejoué sur les cas qui l'avaient trompé.

## v3.3.7 (29 septembre 2026)

### Améliorations
- **Clés de vos services** : les commandes que Claude lance pour parler à Cloudflare, Google Search Console, Brevo, Resend, Neon, Render et aux registrars de domaines ne mettent plus la clé dans la ligne de commande de `curl`, où tout programme de la machine pouvait la lire. La clé passe par l'entrée standard, comme le faisait déjà `/rotate-secret`. Cela touche notamment `/add-domain`, `/start`, `/gsc`, `/new-email-address` et `/quotas`.
- **Mise en ligne par GitHub** : le jeton Vercel arrive à l'outil de mise en ligne par son environnement, et plus par sa ligne de commande.
- **Garde-fou** : un appel qui supprime ou réécrit chez un fournisseur reste repéré sous la nouvelle forme, y compris quand la méthode voyage avec la clé, et les options groupées comme `-sX DELETE` sont lues comme curl les lit.
- **Migration de l'horloge partagée** : les commandes de vérification qu'elle affiche ne mettent plus le jeton d'administration en argument, et la valeur à renvoyer est lue dans le `.env` du projet au lieu d'être recopiée.

### Coulisses
- La recette lit maintenant toutes les commandes du plugin (skills, scripts, gabarits), variables du shell comprises. Elle trouve 83 commandes dans la 3.3.6 et aucune dans la 3.3.7.
- Correctifs issus d'une relecture extérieure de la 3.3.6.

## v3.3.6 (28 septembre 2026)

### Améliorations
- **Garde-fou** : des accolades répétées ne déguisent plus un ajout de tout le projet (`git add .` suivi de `{,}` répétés). Chaque mot n'est gardé qu'une fois pendant le dépliage, et une commande dont les accolades se déplient au-delà de ce que le garde-fou sait lire demande confirmation au lieu de passer.
- **Garde-fou** : trois lanceurs de macOS de plus sont lus comme les autres, `taskpolicy`, `sandbox-exec` et `script`.
- **Clé Cloudflare** : la vérification de l'installation et la mise en place d'un agent n'envoient plus la clé dans la ligne de commande d'un autre programme, où tout logiciel de la machine pouvait la lire.
- **Automatismes GitHub** : les tâches planifiées, les tests et la mise en ligne par GitHub utilisent les versions des actions qui tournent sur Node 24. GitHub n'affiche plus d'avertissement à chaque exécution.
- **Connexion GitHub** : la vérification de `/start` ne se trompe plus quand un ancien compte GitHub reste enregistré à côté de celui en service.

### Coulisses
- Trois recettes neuves : les versions des actions GitHub, aucune clé en argument de `curl` ou `wget`, la connexion GitHub vérifiée sur le compte actif.
- Correctifs issus d'une relecture extérieure de la 3.3.5, et d'un essai en réel de la prochaine architecture.

## v3.3.5 (28 septembre 2026)

### Améliorations
- **Renouvellement d'une clé** : quand la clé n'est pas là où la commande la cherche (le mauvais dossier dans un monorepo, par exemple), le renouvellement s'arrête avant d'envoyer quoi que ce soit. Jusqu'ici, il pouvait écrire une valeur vide dans le coffre ou dans un Worker Cloudflare.
- **Coffre-fort** : il refuse désormais une valeur vide, quel que soit l'outil qui lui écrit. Une étape qui échoue en amont ne peut plus effacer une clé globale.
- **Garde-fou** : les accolades sont dépliées comme le shell les déplie avant de lancer une commande, ce qui ferme une façon détournée d'ajouter tout le projet d'un coup (`git add {.,.}`). Deux lanceurs de macOS, `arch` et `xcrun`, sont lus comme les autres.
- **Mot de passe administrateur** : pour en changer, ou pour ajouter un utilisateur à la main, la consigne écrite dans le projet fait taper le mot de passe dans la fenêtre masquée, jamais dans la conversation.
- **Passage de Stripe en live** : la désactivation du webhook de test s'arrête si la clé de test manque, au lieu de partir sans elle.

### Coulisses
- Le déploiement par GitHub des collaborateurs vérifie la clé lue au coffre avant de l'envoyer, et la migration de l'horloge partagée prend la clé d'un projet dans son `.env` au lieu de la faire recopier.
- Les recettes repèrent désormais ces formes : une valeur recopiée dans une commande, une valeur du coffre envoyée sans contrôle, une valeur relue puis écrite sans vérification.
- Correctifs issus d'une relecture extérieure de la 3.3.4.

## v3.3.4 (27 septembre 2026)

### Sécurité
- **Aucun secret en argument d'une commande** : la clé OpenRouter créée par `/add-ai`, le secret de session et ceux de la double authentification posés à l'installation de la connexion, et la clé d'envoi des emails passaient en argument d'une commande, lisible par tout programme de la machine. Ils passent désormais d'une commande à l'autre sans jamais apparaître, et une recette le vérifie à chaque version.
- **Plus aucun secret par la conversation** : `/add-google-auth` et `/add-github-auth` ouvrent une fenêtre masquée pour le secret de connexion, et la clé des tâches planifiées (`/add-cron`) comme la clé privée des notifications (`/add-push-notification`) ne passent plus par l'échange avec Claude.
- **Une étape qui échoue ne vide plus une clé de production** : une valeur vide est refusée avant tout envoi, et `/rotate-secret` comme le passage en live de `/add-stripe` vérifient leurs valeurs avant de les envoyer (relecture de Bastien Detraz).
- **Garde-fou** : il lit les options de `sudo`, `env`, `nice`, `timeout` et `stdbuf` comme ces outils les lisent, et une accolade collée à un mot (`xargs -I{} git add {}`) ne le trompe plus.

### Corrections
- **`/add-domain` ne casse plus les tâches planifiées** : un Worker recevait l'adresse `https://undefined` avant d'être redéployé. Seules les adresses de ce projet sont repointées, celle d'un autre projet reste intacte, sur Cloudflare comme sur Render.
- **Render** : un service absent du manifeste du projet n'est plus modifié sans ton accord.

## v3.3.3 (27 septembre 2026)

### Corrections
- **Vos secrets ne sont plus effacés en local** : récupérer les variables de votre site, par exemple pour restaurer un `.env.local` perdu, écrivait une valeur vide par-dessus chaque clé secrète. Vercel ne rend jamais la valeur d'un secret : ces clés sont désormais signalées comme illisibles, et votre valeur locale est gardée.
- **Vérification de votre projet** : une base bien configurée n'est plus déclarée absente parce que la production cache la valeur de sa connexion.
- **`/save-project`** : les secrets que Vercel ne rend pas ne sont plus comptés comme des variables ni copiés vides dans la sauvegarde. Leurs noms sont listés en tête de chaque fichier, et la notice de restauration dit où reprendre leur valeur.
- **Windows** : la récupération des variables fonctionne aussi quand le nom de votre dossier utilisateur contient une espace.

### Coulisses
- Une recette rejoue ces cas avec un faux outil Vercel qui rend les secrets vides, comme le vrai.

## v3.3.2 (27 septembre 2026)

### Améliorations
- **Vos clés ne passent plus par la conversation** : `/rotate-secret`, `/add-stripe` et `/add-storage` font passer chaque clé par la fenêtre masquée, ou directement d'un outil à l'autre, et `/add-storage` dit lesquelles des trois valeurs affichées par Cloudflare saisir. Les clés live de Stripe ne touchent plus au `.env` de votre poste : elles partent à l'hébergement seulement.
- **Stripe et nom de domaine** : `/add-domain` ne repointe plus que les webhooks de CE projet, jamais ceux d'un autre projet du même compte Stripe.
- **Render enfin mis à jour** : `/rotate-secret` et `/add-domain` écrivent la nouvelle valeur dans les services Render que vous désignez, et les redéploient.
- **`/bootstrap`** attend le déploiement de CE commit, en arrière-plan, au lieu d'une attente qui s'interrompait au bout de deux minutes. Un outil privé (tout derrière la connexion admin) peut se passer de pages légales, et une demande de « thème sombre » donne une palette sombre unique, sans bouton clair/sombre.
- **`/rgpd-audit`** reconnaît un site dont le dossier `app/` est à la racine, signale une politique de confidentialité rangée là où le site ne la sert pas, et lit aussi les feuilles de style.
- **Garde-fou** : il lit aussi les commandes lancées par `find -exec`, par `xargs` à la manière de macOS, ou derrière `timeout`, `stdbuf` et `caffeinate`.

### Coulisses
- Merci à Bastien Detraz, dont la relecture de la 3.3.1 est à l'origine de plusieurs de ces corrections : il rejoint les contributeurs du projet.
- Nouveaux outils internes pour lire une valeur du `.env` sans l'afficher et écrire les variables d'un service Render.

## v3.3.1 (26 septembre 2026)

### Améliorations
- **Suppression d'un projet** : deux suppressions lancées en même temps ne se mélangent plus. Chaque exécution range son inventaire à part, et la suppression refuse un inventaire illisible ou celui d'un autre projet. La liste des comptes que vous partagez entre vos projets est expliquée dans la documentation de `/delete-project`, et elle prévient quand elle est illisible.
- **Audit RGPD** : un service que vous documentez vous-même n'est plus déclaré « périmé » au passage suivant, car sa fiche exige désormais la règle qui permet de le reconnaître, ses sources et sa date. Un fichier illisible (un `package.json` abîmé) suspend toute proposition de retrait au lieu de passer pour une absence. L'audit lit tout le code du site, même sans dossier `src`, et voit les adresses écrites sans `https:`.
- **Garde-fou** : il garde ses règles même si l'un de ses fichiers voisins manque, et reconnaît les commandes relancées par `xargs`.
- **Démarrage** : `/start` rappelle que le nom Git est publié avec chaque commit.
- **Politique de confidentialité** : la fiche de l'hébergeur distingue ce que couvre son contrat de traitement (offres Pro et Enterprise) de sa certification, et la fiche Sentry précise que le choix de la région est définitif.

### Coulisses
- Des dossiers temporaires propres à chaque exécution partout où un nom fixe traînait, un index pour le compteur partagé de l'anti-abus, et les recettes enrichies des essais d'un relecteur extérieur.

## v3.3.0 (23 septembre 2026)

### Nouveautés
- **Audit RGPD de tous les services** : `/rgpd-audit` repère désormais tous les services branchés à votre projet, y compris ceux que le plugin ne connaît pas encore (une variable qui ressemble à une clé, le paquet d'un service connu, une adresse que votre code contacte). Il vous les signale « à identifier », puis, avec vous, rédige la fiche du service à partir des pages officielles du fournisseur, ou note pourquoi aucune donnée personnelle n'y passe.
- **Sentry, Upstash et Vercel Speed Insights** rejoignent le catalogue de la politique de confidentialité.

### Améliorations
- **Audit de sécurité** : `/security` ne prend plus la limitation anti-abus intégrée pour un défaut, et n'ajoute plus de service externe de lui-même. Face à une vraie attaque, il propose un compteur partagé qui vit dans la base de votre projet, sans nouveau compte ni nouvelle clé.
- **Politique de confidentialité** : OpenRouter, que le plugin déclare lui-même, n'est plus proposé au retrait.
- **Domaine** : `/add-domain` reconnaît Google Analytics sous le nom de variable qu'écrit `/add-analytics`.

### Coulisses
- La liste des comptes à ne jamais proposer à la suppression ne fait plus partie du plugin : `/delete-project` la lit sur la machine de chacun.
- Nouvelles recettes pour l'audit RGPD, le limiteur et la suppression de projet.

## v3.2.6 (22 septembre 2026)

### Améliorations
- **Identité Git vérifiée au démarrage** : `/start` contrôle le nom et l'adresse qui signent vos commits, sans jamais afficher leur valeur. Une adresse qui n'en est pas une (un mot de passe saisi par erreur, un nom et une adresse inversés) est signalée avec sa réparation, et `/bootstrap` refuse de faire le premier commit avec elle.
- **Garde-fou** : un shell qui reçoit son script par un heredoc, un tube ou un here-string est jugé comme un `bash -c` ; `git add :/` est refusé comme `git add .` ; une requête qui cite `DROP TABLE` dans une chaîne n'est plus refusée à tort ; les suppressions par `curl` chez Vercel, Cloudflare et les autres services que le plugin pilote demandent une confirmation ; retirer l'accord des hooks reste libre ; une adresse d'auteur Git qui n'est pas une adresse est refusée.
- **`/delete-project`** : une ressource que le projet déclare partagée n'est plus jamais proposée à la suppression, quel que soit son genre.
- **Sauvegardes** : la documentation dit enfin comment retrouver des données dans une sauvegarde.

### Coulisses
- Le mail d'alerte de l'horloge encadre le texte d'erreur du fournisseur comme une donnée et ne dicte plus de redéploiement ; la règle écrite dans vos projets ne propose plus de passer la chaîne de connexion en argument ; un `INSERT … ON CONFLICT DO UPDATE` n'est plus pris pour un `UPDATE` sans condition ; la recette du chaînage des hooks est valable sur macOS.

## v3.2.5 (20 septembre 2026)

Une version de correction, centrée sur la base de données : plus sûre, plus discrète avec tes secrets, et plus honnête quand quelque chose échoue.

### Améliorations
- **Ta base de données reste en Europe** : dans un projet qui regroupe plusieurs applications, `/add-db` créait la base sans préciser de région, donc aux États-Unis. Elle est maintenant créée à Francfort, comme partout ailleurs, et sa région est notée dans ton projet.
- **L'adresse de connexion de ta base ne se montre plus jamais** : elle ne s'affiche plus à l'écran, même quand une étape échoue, et ne passe plus dans une ligne de commande. Si une étape échoue après la création de la base, son adresse est quand même rangée dans ton projet au lieu d'être perdue.
- **Suppressions accidentelles mieux arrêtées** : toute commande qui supprime quelque chose dans ta base est reconnue (plus seulement la suppression d'une table), et une confirmation t'est toujours demandée avant de l'exécuter.
- **`/save-project` ne dit plus « tout va bien » à tort** : si des tables n'ont pas pu être lues, la sauvegarde le signale en évidence et nomme les tables qui manquent.
- **Coffre-fort verrouillé** : `/add-db` et `/quotas` te demandent maintenant de l'ouvrir, au lieu de te proposer de créer une nouvelle clé.
- **Chiffres du plan gratuit de Neon remis à jour** : 10 copies par base (et non 20), 100 heures de calcul par mois.

### Coulisses
- L'adresse de connexion n'est envoyée qu'aux serveurs de Neon, jamais ailleurs. Le contrôle qui précède une mise à jour de la structure de ta base refuse de forcer quand il n'a pas pu tout vérifier. Cinq nouvelles vérifications automatiques accompagnent ces corrections.

## v3.2.4 (19 septembre 2026)

### Améliorations
- **Suppression d'un projet plus sûre pour vos fichiers** : la sauvegarde proposée avant de supprimer un projet ne laisse plus de côté les fichiers stockés quand les clés du stockage manquent sur votre ordinateur. Elle les retrouve et les télécharge quand même, et ne les écarte que si vous le demandez. Quand les fichiers ne sont dans aucune sauvegarde, l'inventaire le dit sur la ligne du stockage, avant votre validation.
- **Les ressources partagées ne partent plus avec un projet** : une ressource déclarée partagée entre plusieurs projets (espace de stockage, base de données, service, webhook) n'est plus proposée à la suppression. Jusqu'ici, seules les tâches de fond partagées étaient protégées.

### Coulisses
- Deux nouveaux contrôles dans la recette, pour qu'aucune version future ne revienne en arrière sur ces deux points.

## v3.2.3 (18 septembre 2026)

### Améliorations
- **Garde-fou plus juste** : un message de commit rédigé sur plusieurs lignes qui cite une commande (par exemple « git add -A reste refusé ») n'est plus pris pour la commande elle-même, ni refusé à tort.
- **Garde-fou plus sûr** : plusieurs façons de faire passer une commande sensible sans confirmation sont fermées. Une apostrophe entre guillemets (« l'accord », « c'est ») ne cache plus ce qui la suit, et une commande glissée dans une construction particulière du shell, dans un commentaire contenant une apostrophe ou lancée en arrière-plan est désormais examinée comme les autres.
- **Horloge partagée** : la demande de confirmation avant de relancer l'horloge ne se déclenche plus sur le script d'un autre projet qui porte le même nom.

### Coulisses
- La lecture des lignes de commande par le garde-fou a été réécrite d'un seul tenant : guillemets, textes sur plusieurs lignes, substitutions et commentaires y sont compris comme le shell les comprend. 35 nouveaux cas de recette, vérifiés aussi dans l'autre sens (ils échouent sur l'ancienne version).
- Merci à la relecture extérieure qui a signalé ces défauts.

## v3.2.2 (18 septembre 2026)

### Améliorations
- **Le trafic sortant de Neon est compté par projet.** Le plan gratuit de Neon accorde 5 Go par mois à chaque projet, et non 5 Go pour tout le compte comme le plugin le croyait. `/quotas` compare désormais votre projet le plus gourmand à ses 5 Go, la surveillance quotidienne alerte projet par projet, et la règle écrite dans le `CLAUDE.md` de vos projets se corrige toute seule à la prochaine mise à jour. Finies les fausses alertes quand plusieurs petits projets s'additionnaient.
- **Une sauvegarde de base qui échoue vous prévient enfin.** Sur une installation standard, l'échec d'une sauvegarde Neon ne partait jamais par email : seule une ligne de journal en gardait la trace. L'alerte utilise maintenant l'adresse déjà configurée pour vos quotas. Et si un projet a été supprimé chez Neon, l'email le dit clairement et explique comment le retirer des sauvegardes.
- **`/add-domain` pense aux Suisses.** Si vous n'avez pas encore de domaine et que la Suisse est en jeu (domaine en `.ch`, système en fr-CH ou de-CH), la skill propose Infomaniak à côté de Hostinger. Seul le changement de serveurs DNS s'y fait à la main, guidé clic par clic.
- **`/quotas` oriente vers la bonne skill.** Quand un plafond Neon approche, il recommande `/optimize` dans le projet concerné, et n'envoie plus vers `/clean`, qui ne réduit pas ce qu'une app consomme.

### Coulisses
- `/update-hypervibe` reconnaît ces deux défauts sur une horloge partagée déjà déployée, et vous dit ce que la réparation corrige.
- `/add-db` et `/optimize` expliquent le plafond par projet.

## v3.2.1 (17 septembre 2026)

### Améliorations
- **Suppression d'un projet** : le site est cherché dans toutes vos équipes Vercel, puis supprimé par son identifiant et son équipe, plus par son seul nom. Si deux de vos sites portent le même nom dans deux équipes, Hypervibe vous demande lequel retirer au lieu de choisir à votre place, et il vérifie que le site a bien disparu avant de l'annoncer.
- **Serveurs Render** : ils réapparaissent dans l'inventaire de suppression. Leur clé d'accès, pourtant rangée dans votre coffre, n'était pas lue : vos services Render passaient inaperçus.
- **Contrôle du nom d'un nouveau projet** : il regarde maintenant tous vos sites, dans toutes vos équipes et sur toutes les pages, au lieu des vingt premiers d'une seule équipe. Un nom déjà pris est donc repéré avant la création.
- **Quotas et mise en place** : la clé d'accès Vercel est lue dans le fichier le plus récent. Depuis la dernière mise à jour de l'outil Vercel, une clé périmée pouvait être prise, et votre hébergement apparaissait à tort comme déconnecté.

### Coulisses
- Tout ce que le plugin demande à Vercel passe désormais par un module commun, protégé par une recette de 97 vérifications qui rejoue un compte à plusieurs équipes, sans jamais toucher au vôtre.

## v3.2.0 (15 septembre 2026)

### Nouveautés
- **Codex et OpenCode, sur un pied d'égalité** : le plugin déclare désormais lui-même ce dont ses versions Codex et OpenCode ont besoin (noms de skills acceptés par ces outils, ce qui ne s'y transpose pas), et `/add-routine` s'appuie sur les tâches planifiées de l'application Codex. Les archives converties se téléchargent sur hypervibe.fr/plugin/codex et hypervibe.fr/plugin/opencode, et s'y mettent à jour toutes seules.
- **`/add-stripe` vérifie le plan Vercel** : avant d'ouvrir les paiements, le plugin lit le plan du projet et prévient si c'est le plan gratuit Hobby, que Vercel réserve à un usage non commercial (un site qui encaisse peut être suspendu). Le passage en Pro est proposé avant la mise en ligne.

### Améliorations
- **Enregistrement des ressources réparé** : dans douze commandes (`/bootstrap`, `/add-db`, `/add-cron`, `/add-domain`, `/add-storage`, `/add-stripe`, `/add-backup-db`, `/new-email-address` et quatre aides internes), la commande qui note une ressource dans le manifeste du projet contenait un retour à la ligne mal écrit, qui pouvait la faire échouer.
- **Routines** : `/add-automation`, `/add-ai` et la création d'agent disent clairement quand l'outil en cours ne sait pas planifier une mission, au lieu d'en promettre une.

### Coulisses
- Nouvelle recette qui refuse les commandes mal écrites, les ancres de chemin sans accolades et les dossiers de plugin tapés en dur ; recette du plan Vercel.

## v3.1.9 (15 septembre 2026)

### Sécurité
- **Une commande cachée dans une substitution est jugée comme les autres.** `x=$(git push origin main)`, `` v=`git add -A` `` ou `result=$(node …/ensure.mjs)` passaient devant le garde-fou : l'affectation avalait le début de la commande. Le contenu des parenthèses et des accents graves est désormais déplié et repasse par la décision, comme la charge d'un `sh -c`. En particulier, les commandes qui mettent l'horloge partagée en place depuis /add-cron, /add-backup-db et /add-automation demandent bien confirmation avant de déployer, comme le disaient leurs consignes.
- **L'accord de confiance des hooks est reconnu sous toutes ses casses et malgré un commentaire** : `git config HYPERVIBE.HOOKS true` demande (git lit les clés sans tenir compte de la casse), et un `--unset` placé dans un commentaire ne fait plus passer une écriture pour une lecture. L'horloge partagée est reconnue au nom de son script, quel que soit le dossier d'où on la lance.

### Corrections
- **Le contrôle de dépendances ne dicte plus la commande de l'accord** dans son rapport : il dit qu'une personne l'active, et renvoie à /add-test.

- **Aucun email généré par un projet ne porte de lien vers localhost** : le module d'envoi installé par /add-email (Brevo ou Resend) et celui de l'agent généré refusent un message dont le corps pointe vers localhost ou 127.0.0.1. Un essai lancé avec la configuration locale ne peut plus partir vers de vrais destinataires avec une adresse de développement.

### Coulisses
- Dix-huit cas de garde-fou de plus, dans les deux sens (substitutions dans des guillemets doubles jugées, dans des apostrophes simples laissées telles quelles). Relecture extérieure de la 3.1.8.

## v3.1.8 (14 septembre 2026)

### Sécurité
- **Faire confiance aux hooks d'un dépôt est un geste humain.** Depuis la 3.1.5, les hooks git versionnés d'un dépôt ne s'exécutent qu'après un accord donné dans ce clone. Le garde-fou demande désormais confirmation avant que cet accord soit posé, sous toutes ses formes, et le message du hook ne dicte plus la commande au modèle : une personne décide, dépôt par dépôt. /add-test demande donc une confirmation de plus, pour le dépôt qu'il équipe.
- **Le redéploiement de l'horloge partagée demande, même quand un script du plugin s'en charge.** La vérification de la mise à jour et les commandes qui mettent l'horloge en place font d'abord un essai à blanc, qui dit si un déploiement serait nécessaire sans rien toucher ; la vraie commande n'est lancée que si quelque chose changerait, et le garde-fou demande confirmation à ce moment-là, comme pour `wrangler deploy`. Plus aucune question quand tout est à jour, une question quand ça déploie.

### Corrections
- **/delete-project ne désindexe que ce qu'il supprime.** L'index de mémoire perdait les lignes d'autres sujets qui citaient le projet au passage, et gardait sans ligne les fichiers conservés pour relecture. Seules les lignes dont le lien pointe vers un fichier réellement supprimé sont retirées, et elles sont montrées avant confirmation, avec le reste.
- **Une horloge partagée en retard est signalée.** Après une installation manuelle du plugin, l'horloge garde l'ancienne version sans que rien ne le dise. Le contrôle de dépendances le mentionne désormais, avec le remède, sans jamais redéployer de lui-même.

### Coulisses
- Une recette de plus (la désindexation par lien), des cas de garde-fou pour l'accord et l'horloge, et un essai à blanc dans le script de l'horloge. Relecture extérieure de la 3.1.6 et retour d'un utilisateur de la 3.1.7.

## v3.1.7 (13 septembre 2026)

### Corrections
- **Un dossier utilisateur avec un espace ne casse plus rien.** Sur Windows, quand le profil s'appelle par exemple `C:\Users\Prénom Nom`, les scripts du plugin étaient lancés à travers un shell qui coupait leur chemin à l'espace : /delete-project échouait à retirer la sauvegarde automatique, /save-project ne produisait pas son export de base, et la fenêtre du coffre-fort ne s'ouvrait jamais (ni pour le déverrouiller, ni pour y ranger une clé pendant /start). Les scripts se lancent désormais sans shell, les commandes Windows qui en exigent un reçoivent chaque argument protégé, et une recette rejoue le scénario depuis un dossier avec un espace.
- **Le zip de /save-project n'a plus besoin de python** : il est écrit par le plugin lui-même, à l'identique sur tous les systèmes. Sur beaucoup de postes Windows, `python` n'était que l'alias du Store et la sauvegarde échouait à sa dernière étape.
- **/start ne dépend plus du chemin d'installation de l'auteur** : ses scripts se trouvent par rapport à la skill, quelle que soit la façon dont le plugin a été installé.

### Améliorations
- **Une sauvegarde plus honnête** : quand Vercel ne répond pas (projet déjà retiré), les fichiers `.env` locaux sont copiés ; les fichiers non suivis par git sont copiés et plus seulement listés ; la mémoire Claude est cherchée dans tous les dossiers qui mentionnent le projet, pas seulement dans le sien ; le dossier de sortie par défaut est votre dossier Téléchargements.
- **/delete-project** rouvre le coffre-fort avant l'inventaire, dit « coffre verrouillé » plutôt que « clé manquante » quand c'est le cas, et ne laisse plus de titre orphelin dans l'index de mémoire.

### Coulisses
- Deux recettes de plus (chemins avec espace, écriture du zip), un contrôle qui interdit le retour de l'ancienne forme de lancement dans tous les scripts, et un fichier de correspondance des règles du garde-fou pour un futur portage vers OpenCode, sans effet ici. Signalé par un utilisateur de la 3.1.5.

## v3.1.6 (13 septembre 2026)

### Corrections
- **L'alerte de stockage R2 voit enfin tout votre compte.** Elle ne lisait que le plus gros de vos espaces de stockage (les buckets) au lieu de leur total : sur un compte réel à 10,2 Go, elle en voyait 8,5, et pouvait rester muette au-delà des 10 Go gratuits. Elle additionne désormais le dernier relevé de chaque bucket, dans `/quotas` comme dans l'horloge partagée qui envoie l'alerte par email.
- **Le décompte des opérations R2 suit la grille officielle de Cloudflare** : les suppressions, gratuites, ne comptent plus comme des lectures.

### Améliorations
- **/update-hypervibe remet votre horloge partagée à niveau.** Installer une nouvelle version ne touchait pas le worker `hypervibe-jobs` déjà déployé sur votre compte Cloudflare : il gardait son ancien code, défauts compris. La mise à jour vérifie maintenant qu'il exécute la même version que le plugin, le redéploie sinon, et vous dit ce que la réparation corrige. Elle ne crée jamais d'horloge, et fait la même vérification quand vous êtes déjà à jour.

### Coulisses
- Une recette vérifie cette réparation (aucune horloge créée, une horloge à jour laissée intacte, le défaut du stockage reconnu), et les tests du worker couvrent un compte à plusieurs buckets.

## v3.1.5 (13 septembre 2026)

### Sécurité
- **Un clone n'exécute plus jamais les hooks qu'il transporte.** Depuis la 3.1.0, les hooks git globaux posés par /start exécutaient le `.hooks/pre-commit` et le `.hooks/pre-push` versionnés de n'importe quel dépôt, y compris un dépôt fraîchement cloné pour être examiné. Ils ne s'exécutent plus qu'après un accord donné dans ce clone précis (`git config hypervibe.hooks true`, posé par /add-test, jamais transporté par un clone) ; sans accord, le hook se signale et ne fait rien. /start, /add-test et /update-hypervibe referment la porte sur une machine déjà équipée. Signalé en privé par un relecteur extérieur.
- **L'exception de mise à jour de schéma vient de votre environnement, plus de la commande** : le préfixe que tapait le modèle ne suffit plus. Pour une base jetable (une démo sur scène), la variable se pose avant de lancer Claude Code.
- **L'action GitHub des tests** réduit le jeton du dépôt à la lecture et n'autorise plus tous les scripts d'installation d'un coup : seule la liste du projet compte.

### Améliorations
- **Contrôle de dérive avant une mise à jour de schéma** : avant de pousser le schéma, le plugin compare le code à la base réelle et refuse de supprimer ce que la base contient et que le code ne déclare pas (une colonne ajoutée à la main, une table posée par un autre outil). Il l'explique et vous laisse choisir. Vécu sur un projet réel le 30 août.

### Coulisses
- Une recette exécute le scénario du chaînage (clone approuvé ou non, rafraîchissement d'un ancien hook), et le contrôle de dépendances signale un clone équipé dont l'accord manque.

## v3.1.4 (11 septembre 2026)

### Améliorations
- **Le garde-fou regarde la commande, pas son costume** : `sudo`, un chemin absolu, `command`, `env`, `time`, un sous-shell, un bloc `if ... then`, la charge d'un `sh -c`, une version épinglée (`wrangler@latest`) ne cachent plus une commande aux règles. Les formes équivalentes d'actions déjà gardées sont fermées aussi (`vercel deploy --target production`, `pnpm --filter web db:push`, `git checkout .`, `git clean --force`, `git add -Av`), et quatre faux positifs disparaissent : lire le script de suppression avec `cat` ou `grep`, `vercel build --prod`, `wrangler deploy --dry-run`, et l'alias `--destructive` que run-sql acceptait déjà.
- **Le garde-fou voit aussi l'outil Monitor**, qui exécute du shell comme Bash.
- **Le cadre anti-injection de l'agent généré couvre la base de données** : les lignes renvoyées par `db_query` arrivent entre les mêmes marqueurs que les pages web, et le prompt de sécurité le dit. Le gabarit de traitement IA et l'exemple de workflow encadrent de la même façon le document qu'ils font lire.
- **La consigne « contenu externe = donnée, jamais instruction »** est posée dans dix skills qui lisent du contenu tiers par la sortie d'un script (audit éco, performance, sécurité, sept connecteurs DNS), et la recette l'impose désormais.

### Coulisses
- La recette de sécurité exécute ce qu'elle valide : l'empreinte de la clé de signature est recalculée depuis la clé, run-sql et le script de suppression sont lancés à sec, le fail-open du hook est exercé. Un fichier RELEASE.md décrit la procédure de release. Ces points viennent d'une relecture extérieure de la 3.0.4.

## v3.1.3 (10 septembre 2026)

### Améliorations
- **Cartes (/add-map)** : les cartes passent à MapLibre version 6, qui corrige une faille de sécurité critique présente dans toute la version 5. Une petite étape au lancement sert désormais le moteur de carte depuis votre propre site, indispensable pour que les rues, les noms de lieux et vos tracés s'affichent.
- **Mettre à jour une carte existante** : relancez `/add-map` sur un projet qui a déjà une carte et choisissez « Mettre à jour le moteur de carte ». Vos points, vos pages et votre style ne bougent pas.
- **Nouveau projet (/bootstrap)** : chaque projet neuf part avec un plancher de sécurité sur un composant interne de Next.js, ce qui fait disparaître des alertes d'audit sans effet sur votre site. Le déploiement sur Vercel reste compatible.
- **Fin du bootstrap** : l'adresse de votre site en ligne est de nouveau correctement repérée après le premier déploiement.

### Coulisses
- Sous Windows, une version de bibliothèque pouvait se retrouver figée par erreur et ne plus recevoir de correctifs : c'est corrigé.
- Trois nouvelles recettes vérifient ces points à chaque version.

## v3.1.2 (9 septembre 2026)

### Améliorations
- **Une sauvegarde dit maintenant quand elle est trouée.** Quand `/save-project` n'arrive pas à récupérer une partie de vos fichiers stockés en ligne, son compte rendu final l'annonce, au lieu de conclure à une réussite complète. Il nomme les étapes incomplètes et le nombre de fichiers manquants. Une archive trouée doit se découvrir le jour où on la fabrique, pas le jour où on en a besoin.
- **Plus de suppression sur une sauvegarde incomplète.** `/delete-project` propose une sauvegarde avant d'effacer un projet. Si celle-ci revient incomplète, la commande s'arrête désormais et vous demande quoi faire, en montrant ce qui manque. Auparavant elle continuait : ce qui manquait à la sauvegarde était supprimé pour de bon.
- **Une dépendance inutile en moins dans vos projets Stripe.** `/add-stripe` n'installe plus la bibliothèque Stripe destinée au navigateur. Vos paiements passent par une page hébergée par Stripe, qui ne s'en sert jamais. Un paquet de moins à embarquer, et une source de moins de ruptures au fil de ses versions.

## v3.1.1 (9 septembre 2026)

### Améliorations
- **Le cahier de recette explique son propre nom.** Le document produit par `/add-test` s'ouvre désormais sur une définition du mot « recette » (il vient de *recevoir* : le moment où celui qui a commandé un logiciel l'accepte, avec ou sans réserves). Le terme est celui que votre client ou votre service informatique emploiera ; autant le connaître avant qu'on vous le demande.
- **La table de signature ne s'impose plus.** Elle n'a de sens que si quelqu'un doit valider votre application. Pour un projet personnel ou un portfolio, Hypervibe la laisse de côté : une table que personne ne signera fait passer tout le document pour de la paperasse.
- **Mise à jour de schéma sans interruption en démonstration.** Une base jetable dont personne ne dépend (un projet construit en direct devant un public, un bac à sable) peut préfixer sa commande par `HYPERVIBE_GUARD_ALLOW_DB_PUSH=1` et éviter la demande de confirmation. Comme les deux autres exceptions, le préfixe reste visible dans la commande : l'exception est dite, jamais silencieuse.

### Coulisses
- Le contrôle de sécurité des garde-fous vérifie désormais l'emplacement des préfixes d'exception plutôt que leur nombre : ajouter une exception légitime ne fait plus échouer la vérification.

## v3.1.0 (9 septembre 2026)

### Nouveautés
- **Skill `/add-test`** : donne à un projet des tests automatisés (vitest) et un cahier de recette lisible par n'importe qui (`docs/recette.md`, une ligne par fonctionnalité : ce qu'elle fait, comment on le vérifie, qui valide). Chaque procédure de l'API a son test, chaque page son scénario, et un garde-fou refuse de publier tant qu'une fonctionnalité n'a pas sa vérification : avant chaque envoi depuis votre ordinateur, et sur GitHub pour tout le monde.

### Améliorations
- **Le garde-fou de publication ne se contourne plus** : pousser avec `--no-verify` est refusé par le plugin, avec la marche à suivre (compléter la recette plutôt que la sauter).
- **`/bootstrap` propose les tests** en fin de parcours : une phrase suffit pour équiper le projet.
- **`/start` prépare la machine** pour que les vérifications propres à chaque dépôt (`.hooks/pre-commit`, `.hooks/pre-push`) s'exécutent, en plus du scan des secrets.

### Coulisses
- Les hooks git globaux enchaînent désormais vers ceux du dépôt ; nouveau contrôle `tests` dans la détection des dépendances ; gabarits de tests (configuration vitest, appelant tRPC, contrôle de recette, action GitHub).

## v3.0.5 (7 septembre 2026)

### Correctifs
- **Installation dans Claude Desktop** : le téléversement du plugin échouait avec le message « SKILL.md description cannot contain XML tags ». La description de la commande `/add-domain` contenait des chevrons que le contrôle de Claude Desktop prend pour des balises. Elle est reformulée, sans rien changer à ce que fait la commande. L'installation par la marketplace n'était pas concernée.

## v3.0.4 (5 septembre 2026)

### Améliorations
- **Formulaire de contact** : ajouter un formulaire n'installe plus une version de la bibliothèque de validation incompatible avec le reste du projet. Sur les projets créés par `/bootstrap`, cette incompatibilité pouvait casser la vérification des variables d'environnement, et donc le déploiement.
- **Attente d'un déploiement Vercel** : quand le jeton d'accès a expiré, la reprise passe désormais par le geste le plus léger au lieu d'une reconnexion complète. Moins d'interruption au milieu d'un déploiement.

### Coulisses
- Version d'entretien : les deux correctifs viennent de la veille hebdomadaire des dépendances. Aucune nouvelle commande, aucun changement de comportement pour les projets existants.

## v3.0.3 (5 septembre 2026)

### Améliorations
- **Comptes Vercel à plusieurs espaces de travail** : la création d'un projet ne s'interrompt plus si votre compte Vercel contient plusieurs espaces (un compte personnel et un ou plusieurs espaces d'équipe). Jusqu'ici, l'outil de Vercel refusait de choisir tout seul et s'arrêtait brutalement en plein milieu, laissant un projet à moitié construit.
- **Le bon espace est retrouvé automatiquement** : celui que vos autres projets utilisent déjà. Et si le choix reste réellement ambigu, la question vous est posée en clair plutôt que devinée : décider entre votre compte personnel et l'espace de votre entreprise vous appartient.

## v3.0.2 (4 septembre 2026)

### Améliorations
- **Releases signées** : chaque version publiée sur GitHub porte désormais une signature cryptographique (le tag et le commit), vérifiable sans faire confiance ni au site ni au badge de GitHub. La page de sécurité publie la clé et la commande pour vérifier, dit ce que la signature couvre (le code source) et ce qu'elle ne couvre pas (l'archive reconstruite par le site), et prévoit la rotation de la clé. Les versions jusqu'à la 3.0.1 sont antérieures à la clé et ne sont pas signées.

### Coulisses
- La recette de sécurité vérifie que la page publie bien la clé et la commande de vérification (trois contrôles de plus, 43 au total).

## v3.0.1 (3 septembre 2026)

### Améliorations
- **Le garde-fou voit à travers `npx` et `pnpm dlx`** : une mise en production directe (`vercel --prod`) demandait confirmation, mais passait telle quelle derrière un lanceur. Les deux formes demandent maintenant votre accord, comme `git commit --all`, oublié jusqu'ici.
- **Déployer un worker Cloudflare ou écrire ses secrets demande confirmation** : le worker partagé tourne avec les clés du compte, et un `wrangler deploy` direct n'était couvert par rien.
- **Fin d'un faux positif** : lire le fichier `run-sql.mjs` (par `grep` ou `cat`) était refusé dès qu'un mot-clé SQL figurait sur la ligne. Le garde-fou n'examine plus le SQL que lorsqu'un programme lance vraiment le script.
- **Les refus ne soufflent plus leur propre contournement** : les préfixes d'exception restent documentés dans le README, ils ne figurent plus dans le message rendu au modèle.
- **gitleaks est vérifié avant d'être installé** : l'archive téléchargée est comparée au fichier d'empreintes de la même release, et un écart annule l'installation.
- **Le CLI Bitwarden n'est plus téléchargé à l'aveugle** : l'installateur résout lui-même la redirection, refuse toute cible hors de la release officielle, et note la version obtenue.
- **Plus aucun fichier de secrets dans votre dépôt** : la vérification des dépendances et l'audit `/clean` écrivent les variables Vercel dans le dossier temporaire du système, jamais à côté de votre code.
- **L'agent généré suit les redirections avec méfiance** : chaque saut repasse par la garde anti-SSRF, un envoi n'est jamais redirigé, et les URL très longues vers des hôtes inconnus sont refusées, parce qu'une fuite tient dans une adresse.

### Coulisses
- La page sécurité dit désormais ce que détient le worker partagé, et ce que vaut vraiment le refus de SQL destructeur sur un hôte sans hooks. Chacune de ces phrases est vérifiée par la recette avant publication.
- Ces correctifs répondent à une relecture externe et détaillée de la version 2.9.5, faite sur le code publié.

## v3.0.0 (30 août 2026)

### Ce qui change pour vous

- **Deux commandes disparaissent : `/add-workflow` et `/add-agent`.** Vous n'avez plus à choisir vous-même entre une chaîne d'étapes et un agent autonome : décrivez votre besoin à **`/add-automation`**, qui reconnaît la bonne forme et la construit. Se tromper entre les deux coûtait cher, l'une ne demande aucune infrastructure, l'autre un serveur à elle.
- **Toute l'IA de vos projets passe désormais par OpenRouter.** Changer de modèle devient une ligne à modifier au lieu d'un chantier, et vous n'êtes plus lié à un seul fournisseur.
- **Trois garanties, appliquées partout de la même façon** : le coût est estimé et validé par vous avant la première ligne de code, la clé de votre projet porte un plafond de dépense tenu par le fournisseur (une boucle emballée tape un mur, pas votre carte bancaire), et chaque appel refuse que vos données servent à entraîner un modèle.
- **Vous préférez appeler OpenAI ou Anthropic en direct ?** Dites-le : le choix est respecté, noté, et plus jamais remis en question.

### Améliorations

- **Agents** : chaque agent reçoit maintenant sa propre clé plafonnée, distincte de celle de votre application. Un agent qui s'emballe ne peut plus assécher le budget des fonctionnalités que vos utilisateurs ont sous les yeux.
- **`/security`** signale, à titre informatif, un appel de modèle écrit en dehors du fichier partagé, donc hors plafond et hors journal des coûts.
- **Suppression d'un projet** : ses clés d'IA sont désormais révoquées avec le reste.

### Coulisses

- Le worker des agents n'embarque plus aucune bibliothèque de fournisseur, il parle au modèle directement.
- Le coût de chaque appel vient du fournisseur lui-même, il n'est plus recalculé depuis une grille de prix à tenir à jour.

## v2.10.2 (27 août 2026)

### Améliorations

- **Les commandes d'automatisation se distinguent enfin au premier coup d'oeil.** Six d'entre elles se ressemblaient dans la liste, avec des descriptions si longues qu'on ne voyait plus ce qui les séparait. Chacune dit maintenant en une phrase ce qu'elle installe, et nomme sa voisine la plus proche pour vous aiguiller :

  - `/add-ai` répond en quelques secondes, dans votre application
  - `/add-workflow` enchaîne des étapes quand un événement arrive, et se termine
  - `/add-agent` tourne en boucle, choisit ses actions et se souvient
  - `/add-cron` se déclenche à l'heure, pas sur un événement
  - `/add-routine` est une mission récurrente pour vous, sur votre compte Claude
  - `/add-automation` vous oriente vers la bonne quand vous hésitez

### Coulisses

- Nettoyage de ponctuation dans la commande de tâches planifiées.

## v2.10.1 (27 août 2026)

### Améliorations

- **La page de `/add-ai` est désormais en français**, avec sa documentation complète : quand utiliser la commande, comment ça se passe, ce qu'elle crée pour vous, et quatre encadrés sur les pièges du budget et des données personnelles. La version précédente n'affichait qu'un résumé technique en anglais.

### Coulisses

- Un contrôle automatique vérifie qu'une nouvelle commande arrive avec sa documentation dans les deux langues, et une description courte, avant d'être publiée. C'est ce qui a manqué à la version précédente.

## v2.10.0 (27 août 2026)

### Nouveautés

- **`/add-ai` : ajouter de l'IA dans votre application.** Un assistant conversationnel, une analyse automatique de vos contenus, ou de la rédaction : la commande vous pose quatre questions, en déduit la bonne approche, et installe tout. Elle passe par OpenRouter, qui ouvre l'accès à des centaines de modèles avec une seule clé.

  Deux garde-fous, parce que l'IA se paie à l'usage. Le coût est calculé et validé **avant** la moindre ligne de code, à partir des prix réels du moment : vous dites oui à un montant, pas à une idée. Et la clé créée pour votre projet porte un **plafond de dépense** tenu par le fournisseur, qu'aucun bug ne peut dépasser. Chaque appel est ensuite enregistré avec son coût exact, visible dans votre application.

### Améliorations

- **Fenêtre du coffre-fort** : elle redemande votre mot de passe principal jusqu'à trois fois. Une faute de frappe se rattrape sur place, au lieu de devoir tout relancer.
- **`/add-workflow`** s'appuie sur l'IA installée par `/add-ai` quand elle est déjà là : plus de deuxième clé à fournir, et le budget est encadré d'office.
- **`/add-agent`** renvoie vers `/add-ai` quand vous décrivez un assistant qui répond en direct à vos utilisateurs : c'est l'outil fait pour ça, et il est bien plus léger qu'un agent autonome.

### Coulisses

- Deux nouvelles recettes de vérification tournent à chaque version : le choix des modèles selon le budget, et l'étanchéité des clés d'API.

## v2.9.5 (25 août 2026)

### Améliorations
- **Manifeste des ressources : ancrage automatique à la racine** : quel que soit le dossier visé, le manifeste s'écrit et se lit à la racine du dépôt du projet. Un monorepo à plusieurs apps garde un seul manifeste qui liste tout ; dans un dossier qui regroupe plusieurs dépôts, chacun a le sien.
- **Sauvegarde et suppression** : les deux retrouvent le manifeste même lancées depuis un sous-dossier du projet, au lieu de retomber sans bruit sur la recherche par nom.
- **Adoption d'un projet existant** : elle lit les identifiants du sous-dossier visé et de la racine (utile en monorepo), et reconnaît les bases dont l'adresse de connexion passe par un pooler.
- **Mise à jour du plugin** : la proposition d'adoption repère les dossiers qui regroupent plusieurs projets et propose d'adopter chacun, en distinguant monorepo et regroupement de dépôts.

## v2.9.4 (25 août 2026)

### Nouveautés
- **Manifeste des ressources** : chaque projet garde désormais la liste exacte de ce qu'il possède dans le cloud (base de données, stockage, domaine, tâches planifiées...) dans un petit fichier versionné avec le code, rempli automatiquement à la création de chaque ressource. Les sauvegardes et la suppression s'appuient dessus au lieu de deviner par ressemblance de noms.
- **Adoption des projets existants** : après une mise à jour du plugin, un projet déjà en place peut générer ce manifeste en une commande, à partir de ses propres identifiants (jamais par similarité de noms), avec validation avant écriture.

### Améliorations
- **Sauvegarde complète (/save-project)** : chaque fichier du stockage est retéléchargé jusqu'à trois fois en cas de coupure réseau ; si des fichiers manquent malgré tout, la sauvegarde l'annonce clairement et la liste des manquants est incluse dans l'archive, au lieu d'un faux succès silencieux. Un stockage nommé différemment du projet est maintenant retrouvé grâce au manifeste.
- **Suppression de projet (/delete-project)** : l'inventaire distingue ce que le projet déclare posséder de ce qui est deviné par le nom, vérifie chaque déclaration par son identifiant exact, et protège les ressources partagées entre projets.

### Coulisses
- Ajustements de l'onboarding /start et de la synchronisation des règles gérées.

## v2.9.3 (21 août 2026)

### Correctifs

- **La page sécurité disait faux sur les installations.** Elle affirmait que rien n'était téléchargé et que le plugin se servait uniquement des outils déjà présents sur votre machine : c'est vrai du plugin, et faux de l'expérience. La commande de démarrage installe Node.js, Git et pnpm par le gestionnaire de paquets de votre système, un détecteur de fuites de secrets branché sur tous vos enregistrements de code, et l'outil du coffre-fort. Ceux-là sans rien vous demander, parce que rien ne marche sans. Les outils qui servent à mettre en ligne, eux, attendent votre accord. La page a donc une section entière qui liste tout cela, sépare les deux régimes, et nomme les deux réglages système modifiés au passage.
- **Deux autres affirmations étaient trop larges.** « Il ne modifie pas vos réglages de sécurité » devient « aucun droit supplémentaire dans Claude Code », ce qui est le fait vérifiable. Et la mention selon laquelle chaque commande interne restreint sa liste d'outils a été retirée : une partie le fait, pas toutes.
- **L'adresse pour signaler une faille** devient contact@hypervibe.fr, celle de l'entreprise, au lieu d'une adresse personnelle.

### Coulisses

- Les vérifications automatiques sont désormais lancées à chaque publication, et un seul échec arrête la mise en ligne. Six d'entre elles sont nouvelles et arriment la page sécurité au code : un téléchargement qui apparaîtrait ailleurs que dans les trois endroits documentés fera échouer la recette, et la formule fautive ne peut plus revenir sans qu'on s'en aperçoive.

## v2.9.2 (21 août 2026)

### Correctifs

- **Le garde-fou ne refuse plus les instructions du plugin lui-même.** Six commandes (dont `/bootstrap`, trois fois) prescrivaient encore `git add .`, que le garde-fou livré en 2.9.0 refuse : Claude se faisait bloquer par sa propre consigne en plein flux. Elles indexent désormais les fichiers par leur nom. La conversion en monorepo, qui déplace tout l'arbre, est le seul cas où le balayage est légitime : elle le dit explicitement par un préfixe, après avoir vérifié qu'aucun travail étranger n'est en attente.
- **`git -C <dossier>` ne contourne plus rien.** Les options globales de git décalaient la sous-commande et faisaient passer `git -C x add -A` ou `git -C x push` sous le radar. Elles sont neutralisées avant l'analyse.

## v2.9.1 (21 août 2026)

### Correctifs

- **La vérification du téléchargement ne bloque plus une mise à jour légitime.** Introduite en 2.9.0, elle comparait l'archive reçue à l'empreinte annoncée par le site. Or cette annonce est mise en cache dix minutes : juste après une nouvelle version, elle décrivait encore la précédente, et la mise à jour concluait à tort que le fichier était altéré. Elle ne compare désormais que lorsque le site parle bien de la version qui vient d'être téléchargée, et le site rafraîchit son annonce dès la publication. Refuser une mise à jour valide était la pire des deux erreurs.

## v2.9.0 (21 août 2026)

### Nouveautés

- **Des garde-fous, pas seulement des consignes** : les opérations qu'on ne peut pas défaire sont désormais bloquées ou soumises à votre confirmation. Un balayage `git add -A` et le SQL destructeur sont refusés, avec la bonne alternative en clair ; un push, une mise en ligne directe, un envoi de schéma en base, une suppression de projet ou un `git reset --hard` demandent votre accord. Tout le reste passe sans rien demander, et cette moitié-là est testée avec autant de soin que l'autre. Fermez et rouvrez Claude Code après la mise à jour pour que ça prenne effet.
- **Une page sécurité** (`SECURITY.md`, et sa version lisible sur hypervibe.fr) : ce que le plugin contient, ce qu'il refuse de faire, comment vérifier que ce que vous avez téléchargé est bien ce qui a été publié.
- **Vos téléchargements se vérifient tout seuls** : chaque version publiée porte une empreinte, et la mise à jour refuse d'installer si ce qu'elle a reçu ne correspond pas.

### Améliorations

- **Vos règles se corrigent enfin toutes seules.** Jusqu'ici, le bloc de règles écrit dans votre CLAUDE.md était figé au jour de votre première installation : une règle livrée avec une erreur y restait pour toujours, et les nouvelles n'arrivaient jamais. Chaque règle porte maintenant une empreinte de son texte : celles que vous n'avez pas touchées se mettent à jour ou disparaissent quand il le faut, celles que vous avez modifiées restent les vôtres, mot pour mot, et on vous le dit.
- **Le bloc global a fondu de moitié**, et les règles qui ne valent que dans un projet web (TypeScript, responsive, adresses de pages, lectures en base) sont descendues dans le CLAUDE.md du projet, où elles sont utiles et où elles suivent le dépôt. Le bloc global ne garde que ce qui est vrai partout.
- **Les agents que vous créez sont désormais tenus** : celui qui lit le web ne peut écrire qu'aux adresses et aux services que vous avez listés, vides par défaut. Ce qu'il récupère lui revient encadré, pour qu'une page ne puisse pas se faire passer pour une consigne.
- **L'audit des dépendances remarche** : la commande d'avant échouait en silence sur tout projet pnpm. `/security` et la règle utilisent maintenant `pnpm audit --prod`.
- **Les commandes qui vont chercher de la documentation** disent explicitement ce qu'elles font du contenu récupéré : de la matière à analyser, jamais des instructions à suivre.

### Coulisses

- Une suite de recettes (`node scripts/tests/run-all.mjs`) vérifie les garde-fous dans les deux sens, la mécanique des blocs de règles, les barrières des agents générés, et que chaque affirmation de la page sécurité est toujours vraie.

## v2.8.5 (14 août 2026)

### Coulisses
- **Modèle d'agent** : les trois outils livrés avec `/add-agent` (requête en base, appel HTTP, envoi d'email) déclaraient leur type en pointant vers un chemin interne du SDK Anthropic, un chemin que l'éditeur peut réorganiser d'une version à l'autre sans préavis. Ils utilisent désormais la surface publique du SDK, comme le faisait déjà la boucle principale de l'agent. Rien ne change à l'usage : les agents générés se comportent à l'identique, ils encaisseront simplement les prochaines mises à jour du SDK sans casser.

## v2.8.4 (13 août 2026)

### Améliorations
- **Choix du service d'email à l'installation** : `/start` vous demande maintenant lequel des deux services vous voulez utiliser, Resend ou Brevo, puis vous accompagne jusqu'au bout sur celui que vous avez choisi (création de la clé, rangement au coffre, vérification). Auparavant il n'installait que Resend.
- **Les emails d'alerte partent par votre service** : la surveillance des quotas, l'échec d'une sauvegarde de base et l'échec d'une tâche planifiée vous préviennent désormais quel que soit le service configuré. Jusqu'ici ces alertes ne savaient passer que par Brevo : sur une machine équipée de Resend, elles ne pouvaient pas être mises en place, et les pannes restaient invisibles.
- **`/quotas` suit la même règle** : quand il installe la surveillance quotidienne pour vous, il utilise le service que vous avez déjà, et vous dit précisément ce qui manque le cas échéant (adresse d'expéditeur à confirmer chez Brevo, domaine à vérifier chez Resend).

### Coulisses
- Le canal d'alerte de l'horloge partagée accepte les deux services et retient celui de votre installation. Les installations existantes gardent exactement leur comportement.

## v2.8.3 (12 août 2026)

### Corrections

- **Les bases de données savent enfin dans quelle organisation aller** : Neon range chaque base dans une organisation, et rien ne disait jamais laquelle. Sur un compte qui possède la sienne, la création d'une base pouvait échouer avec un message qui n'orientait vers rien, ou aller se ranger ailleurs que prévu. Le premier démarrage repère maintenant l'organisation et la retient une fois pour toutes ; il ne te fait choisir que si ton compte en compte plusieurs, et ne devine jamais à ta place.
- **Le contrôle des noms de projet voit de nouveau tes bases** : par le même défaut, il annonçait « aucun conflit » sans avoir rien lu. Il cherchait en prime ta clé Neon dans un ancien emplacement, abandonné depuis le passage au coffre-fort, et se taisait donc sur une machine récente.
- **Le coffre-fort ne perd plus rien** : ajouter une information à une clé déjà rangée remplaçait tout ce qu'elle contenait, et la clé disparaissait sans un mot. Ce qui est déjà là est désormais préservé.
- **Suivi des quotas** : sur un compte membre de plusieurs organisations, la formule affichée pouvait être celle d'une autre que la tienne. Elle se déduit maintenant des projets réellement lus.
- **Suppression de projet et sauvegardes automatiques** profitent de la même correction : elles regardaient au mauvais endroit, et pouvaient laisser des ressources derrière elles ou surveiller un compte vide.

## v2.8.2 (12 août 2026)

### Améliorations
- **La chasse aux surcoûts sait maintenant interroger votre base directement.** Lire le code dit ce qui *peut* coûter cher, pas ce qui tourne vraiment. Quand ce que `/optimize` trouve dans le code n'explique pas ce que votre base consomme, il arrête de lire et lui demande combien de fois chaque requête a réellement été exécutée. Ce qu'il cherche est une cadence : une requête appelée des milliers de fois par heure alors que rien dans le code ne le demande. Deux réserves qu'il vous dira de lui-même, sans quoi le chiffre induit en erreur : le compteur ne couvre que la période depuis le dernier réveil de la base, et le haut du classement est occupé par l'entretien interne de la base, pas par votre application.
- **L'audit écologique ne propose plus une commande qui n'existe pas.** À la fin, `/eco-audit` proposait de publier vos corrections avec une commande absente du plugin. Il propose désormais de publier comme votre projet publie réellement.

## v2.8.1 (8 août 2026)

### Améliorations
- **Documentation de `/optimize`** : la nouvelle commande a désormais sa fiche complète sur le site, en français et en anglais, comme les autres. Elle explique ce que la commande cherche, ce que vous obtenez, et surtout le point le moins intuitif : ce n'est pas la taille de votre base de données qui coûte, c'est le nombre de fois qu'on la lit.

## v2.8.0 (8 août 2026)

### Nouveautés
- **`/optimize`** : une nouvelle commande qui cherche ce qui coûte cher dans ton application, côté serveur. Elle croise ton code avec la consommation réelle de tes services, classe les causes par coût mesuré, et te propose les correctifs un par un, avec leur niveau de confiance et leur dangerosité. Rien n'est modifié sans ton accord.

### Améliorations
- **Bonnes pratiques de lecture en base, posées par `/start`** : elles rejoignent les règles de ta configuration globale, donc elles s'appliquent à tous tes projets. Le quota qui saute en premier sur les offres gratuites, c'est le volume de données que ta base renvoie, et il se mesure au nombre de lectures multiplié par ce que chacune rapporte, pas à la taille de la base. Une petite base lue souvent coûte plus cher qu'une grosse base lue rarement.
- **`/add-db`** explique désormais comment écrire une requête qui ne coûte rien : ne demander que les colonnes réellement affichées, borner les listes, et éviter les rafraîchissements en boucle qui ne s'arrêtent jamais. Ces règles sont écrites dans la mémoire du projet, donc elles s'appliquent à chaque fois que tu y travailles.
- **`/security`** rend son rapport plus concret, avec un exemple complet de ce à quoi ressemble une faille expliquée en français courant, conséquence et correctif compris.

## v2.7.9 (7 août 2026)

### Nouveautés
- **Vérification du stockage** : `/add-storage` teste maintenant votre bucket pour de vrai avant d'annoncer que le stockage fonctionne. Il liste quelques fichiers, signe une URL, et vous dit précisément quoi corriger si quelque chose cloche (clés refusées, bucket introuvable, mauvaise région).

### Améliorations
- **`/add-agent` propose les modèles actuels** : le choix se fait désormais entre Claude Sonnet 5, Opus 5 et Haiku 4.5. Jusqu'ici les agents étaient créés sur une génération précédente, sans que rien ne le signale.
- **Coûts justes pour les agents Haiku** : le suivi de dépense d'un agent Haiku affichait un montant trois fois trop élevé.
- **Écart de prix annoncé correctement** : passer un agent en Opus coûte environ 1,7 fois le prix de Sonnet, et non 5 fois comme l'indiquait le questionnaire.

### Coulisses
- Table de tarification complétée pour le modèle Claude Fable 5.
- Les briques dont la version est volontairement figée (cartes, planificateur de tâches, TypeScript) portent maintenant dans le code la raison du gel et la condition pour le lever.

## v2.7.8 (6 août 2026)

### Améliorations
- **Création d'une routine** : quand la mission peut tourner aussi bien sur l'ordinateur que dans le cloud, le plugin ne tranche plus en silence. Il pose la question et recommande l'ordinateur par défaut : une routine locale hérite de tout ce qui marche déjà chez toi (coffre-fort de clés, fichiers du projet, outils installés, comptes connectés), alors qu'une routine cloud repart de zéro et oblige à redéposer des clés de son côté. Le cloud n'est proposé que pour le cas qui le justifie vraiment : une mission qui doit tourner ordinateur éteint.

## v2.7.7 (5 août 2026)

### Nouveautés
- **`/update-hypervibe`** : met Hypervibe à jour sans quitter votre conversation. La commande commence par regarder comment vous avez installé le plugin. Si vous l'avez ajouté par une commande, Claude Code le tient déjà à jour tout seul : elle vous le dit et vous donne la commande native, plutôt que d'agir dans son dos. Si vous aviez téléversé le zip dans Claude Desktop, elle compare votre version à la dernière publiée, télécharge la nouvelle, vérifie qu'il s'agit bien d'un plugin complet avant de toucher à votre installation, puis la remplace en gardant l'ancienne en sauvegarde juste à côté.

### Coulisses
- Une mise à jour qui échoue ne vous laisse jamais sans plugin : la version précédente est remise en place d'elle-même, et la commande vous dit ce qui a échoué. L'archive téléchargée est aussi inspectée avant d'être déballée, pour qu'aucun fichier ne puisse s'écrire ailleurs que dans le dossier du plugin.

## v2.7.6 (5 août 2026)

### Nouveautés
- **Trois services de plus dans votre politique de confidentialité** : le fournisseur de cartes, le service qui achemine les notifications push, et la redirection d'emails d'un nom de domaine. Tous les trois voient passer des données de vos visiteurs et n'étaient jamais mentionnés.

### Améliorations
- **La carte se déclare enfin** : `/add-map` était censée inscrire son fournisseur de cartes dans votre politique, mais l'étape ne pouvait pas aboutir. Résultat, chaque site avec une carte omettait le service qui reçoit l'adresse IP de ses visiteurs à chaque page. C'est réparé.
- **`/rgpd-audit` pose les questions que le code ne peut pas trancher** : certains services se configurent chez le fournisseur et ne laissent aucune trace dans votre projet, une adresse `contact@` redirigée par exemple. L'audit les demande maintenant, une seule fois.
- **Il ne propose plus de supprimer une mention pourtant juste** : ces mêmes services, invisibles pour lui, ressortaient comme obsolètes à chaque passage. Une politique « corrigée » de cette façon finissait par mentir.
- **`/add-push-notification` et `/new-email-address`** déclarent désormais le service qu'elles mettent en place.

### Coulisses
- Le registre des sous-traitants distingue ce qui se détecte automatiquement de ce qui se déclare à la main.

## v2.7.5 (5 août 2026)

### Améliorations

- **Une tâche planifiée qui échoue vous prévient enfin.** Quand l'horloge partagée appelle votre site et reçoit une erreur (clé périmée, adresse renommée, application qui plante), la tâche n'a tout simplement pas lieu, et elle ne se rattrape pas toute seule. Jusqu'ici l'échec ne partait que dans des journaux que personne ne lit. Vous recevez maintenant un mail qui nomme la tâche, la cause, et la piste la plus probable, au maximum une fois toutes les 6 heures tant que la panne dure. Sur une installation existante, lancez `/quotas` une fois pour activer la surveillance.

- **Render : le plan gratuit dit enfin la vérité.** Chez Render, le plan gratuit n'existe pas pour les processus permanents. `/add-automation` vous fait donc choisir en amont entre un service gratuit réveillé par l'horloge (endormi entre deux passages, parfait pour du travail lourd mais ponctuel) et un vrai processus permanent à environ 7 USD par mois, seul capable de ne rien manquer. Et `/add-agent` annonce désormais que la facture démarre le jour du déploiement, pas au premier travail de l'agent.

- **Plus de faux échecs sous Windows.** `/add-db` et `/add-agent` pouvaient renvoyer un code d'erreur incohérent juste après un appel réseau, ce qui empêchait de reprendre l'installation là où elle s'était arrêtée. Corrigé.

### Coulisses

- L'audit RGPD reconnaît Render quel que soit le type de service hébergé : le sous-traitant est le même.

## v2.7.4 (3 août 2026)

### Correctifs
- **Les commits ne sont plus bloqués quand votre nom d'utilisateur Windows contient une espace** : le contrôle anti-fuite de secrets installé par `/start` ne trouvait plus sa configuration, et refusait alors *tous* les commits, sur *tous* vos projets. Relancez `/start` pour réparer une machine déjà touchée.
- **Les tâches planifiées se déploient sans compte public Cloudflare** : la mise en ligne échouait tant qu'on n'avait pas créé un sous-domaine public, alors que ces tâches ne répondent à aucune adresse web. Corrigé pour les tâches partagées comme pour celles propres à un projet.
- **Identification du compte Cloudflare plus robuste** : quand la clé d'accès ne permet pas de lister les comptes, le plugin retrouve l'identifiant autrement. En cas d'échec, le message dit désormais quelle permission manque et où trouver l'identifiant à la main.

### Coulisses
- Merci à Manuel Ferreira pour deux rapports de bug précis, reproduits à l'identique.

## v2.7.3 (2 août 2026)

### Corrections
- **Suppression de projet : les fichiers stockés étaient oubliés.** `/delete-project` annonçait "aucun espace de stockage" pour absolument tous les projets, à cause d'un accès Cloudflare qui échouait en silence. Les espaces de stockage survivaient donc à la suppression, et continuaient d'être facturés. Ils sont désormais retrouvés dans les deux juridictions (mondiale et européenne), avec leur contenu annoncé ("543 fichiers, 84 Mo") avant que vous validiez.
- **Suppression de projet : sites Vercel introuvables.** Seuls les 20 projets les plus récents étaient examinés. Au-delà, votre site était déclaré inexistant et restait en ligne. Tous vos projets sont maintenant passés en revue.
- **Un espace de stockage non vide peut enfin être supprimé** : son contenu est effacé automatiquement juste avant.
- **Sauvegarde de projet : fichiers manquants.** `/save-project` produisait une archive sans aucun fichier uploadé lorsque les clés de stockage n'étaient pas dans le projet, sans jamais le signaler. Le contenu est maintenant récupéré dans tous les cas.

### Améliorations
- **Une vérification qui échoue ne se lit plus comme "rien à supprimer"** : coffre verrouillé, accès expiré, le problème est annoncé clairement avant que vous validiez la suppression.
- **Migration vers le stockage européen simplifiée** (`/add-storage`) : procédure deux fois plus courte, sans copie aller-retour inutile. Deux pièges documentés au passage : la clé d'accès est à régénérer, et l'adresse publique des fichiers change.

## v2.7.2 (2 août 2026)

### Améliorations
- **Paiements Stripe** : la version d'API n'est plus figée dans le plugin, elle est lue dans le SDK au moment de l'installation. Les projets créés avec `/add-stripe` compilent de nouveau, quelle que soit la date à laquelle vous les créez.
- **Agents** : `/add-agent` demande à Anthropic quel est son modèle le plus récent au lieu d'en garder un codé en dur, et le modèle retenu arrive vraiment dans l'agent généré (l'option `--model` restait sans effet).
- **Coût de la base de données** : `/add-cron` vous prévient quand une cadence trop serrée maintient la base Neon éveillée en permanence, et le relevé de consommation affiche enfin le temps de calcul réel (il indiquait toujours 0 h).
- **Déclenchement manuel d'un agent** : l'agent n'interroge plus sa file d'attente toutes les 5 secondes en continu. Il reste réactif pendant sa fenêtre d'activité puis espace ses vérifications à 10 minutes au repos, ce qui laisse la base s'endormir. Un agent au repos peut donc mettre jusqu'à 10 minutes à démarrer, le tableau de bord affiche « en file ».
- **Notifications** : la cloche se rafraîchit à l'instant où une notification arrive, via le service worker, au lieu d'interroger le serveur toutes les 30 secondes.
- **Surveillance** : le worker partagé surveille aussi les quotas Neon (trafic sortant, calcul, stockage) et prévient par email quand une sauvegarde de base échoue.

### Coulisses
- Les types du SDK Anthropic sont pris sur sa surface publique et non plus sur un chemin interne : les agents générés ne cassent plus quand le paquet réorganise ses fichiers.

## v2.7.1 (1er août 2026)

### Corrections
- **Fenêtre de saisie des clés** : en français, le message de confirmation affiché une fois la clé enregistrée pouvait se lire comme une consigne à exécuter vous-même plutôt que comme une confirmation que c'était fait. Les phrases concernées ont été reformulées, à la fin de l'enregistrement comme à l'ouverture du coffre-fort.

## v2.7.0 (1er août 2026)

### Nouveautés
- **Vos clés d'accès ne passent plus par la conversation** : dès qu'une clé ou un mot de passe est nécessaire, une petite fenêtre s'ouvre sur votre ordinateur pour la saisie. La valeur part ensuite soit dans votre coffre-fort, soit dans les réglages de votre projet. Plus rien n'est écrit dans le fil de discussion, qui lui reste consultable longtemps après.
- **La fenêtre de saisie parle votre langue** : français ou anglais selon la langue de votre conversation, y compris à la création du coffre-fort et à son ouverture quotidienne.

### Améliorations
- **Suivi des quotas** : la partie base de données restait vide quand vous aviez beaucoup de projets. Elle s'affiche maintenant correctement, et un message clair remplace l'erreur technique quand un service met trop de temps à répondre.
- **Passage d'un site en plusieurs langues** : sous Windows, le serveur d'aperçu bloquait la réorganisation des pages. Il est désormais arrêté puis relancé automatiquement.
- **Mise en ligne** : la vérification qu'un déploiement a bien abouti ne s'interrompt plus au bout de deux minutes.

### Coulisses
- Nouvelle brique interne de collecte des secrets, qui remplace la précédente, et correction de chemins de modèles dans l'ajout de comptes utilisateurs.

## v2.6.4 (31 juillet 2026)

### Améliorations
- **Claude te parle dans ta langue dès la première question** : jusqu'ici, lancer une commande seule (par exemple `/bootstrap`, sans rien écrire d'autre) faisait démarrer Claude en anglais, faute d'indice sur ta langue. Il se base désormais sur l'ensemble de la conversation et, à défaut, sur la langue de ton ordinateur. Le changement porte sur toutes les commandes du plugin.
- **Suppression d'un projet** : Claude ne demande plus s'il faut supprimer l'espace de stockage de fichiers quand le projet n'en a pas. La question n'apparaît que s'il en existe vraiment un.

### Suppressions
- **`/save-config`** (sauvegarde de ta configuration Claude vers un dépôt privé) : retirée du plugin. Elle avait été ajoutée la veille et n'a pas été retenue.

### Coulisses
- Consigne de langue harmonisée sur les 82 commandes du plugin, y compris les commandes internes appelées par les autres.

## v2.6.3 (30 juillet 2026)

### Améliorations
- **Documentation de `/save-config`** : la commande de sauvegarde de ta configuration a désormais sa fiche complète, en français et en anglais, avec ce qu'elle copie exactement, ce qu'elle ne copie jamais, et la marche à suivre le jour où tu dois tout remonter sur une machine neuve. Elle est rangée dans la catégorie Outils.

## v2.6.2 (30 juillet 2026)

### Nouveautés
- **Sauvegarde de ta configuration** : la nouvelle commande `/save-config` met à l'abri tout ce que Claude sait de toi et de tes projets (tes règles, tes skills, sa mémoire, tes plugins) dans un dépôt GitHub privé qui t'appartient. Elle archive aussi ton historique de conversations et l'état de ta barre de gauche dans ton cloud (Dropbox, OneDrive, iCloud, Google Drive, Nextcloud). Tes clés n'en font jamais partie : elles restent dans ton coffre. Au passage, elle te propose de programmer cette sauvegarde tous les jours, pour ne plus jamais y penser.

### Améliorations
- **Première installation** : `/start` propose désormais de mettre en place cette sauvegarde une fois ton environnement prêt. Une question, une réponse, c'est réglé. Si tu dis non, il n'insiste pas.

### Coulisses
- Le fichier de réglages est sauvegardé avec les valeurs de son bloc `env` masquées : c'est l'endroit où une clé API atterrit par accident, et le dépôt de sauvegarde part sur GitHub.

## v2.6.1 (30 juillet 2026)

### Corrections
- **Cartes** : les cartes ajoutées avec `/add-map` ne s'affichaient plus et faisaient planter la page avec un message d'erreur. En cause, une nouvelle version de MapLibre (la brique qui dessine les cartes) publiée le 22 juillet, devenue incompatible avec la couche React utilisée par le plugin. L'installation s'appuie désormais sur la dernière version stable compatible. Un projet déjà touché se répare en relançant `/add-map`. Le piège est documenté pour qu'il ne revienne pas.

### Améliorations
- **Création de projet** : `/bootstrap` ne décide plus tout seul de créer un dossier `DEV` à la racine du disque. Il regarde d'abord où vous rangez déjà vos projets, y compris sur le Bureau ou dans OneDrive, et vous demande confirmation quand plusieurs emplacements sont possibles. Fini le projet créé dans un dossier introuvable.

## v2.6.0 (25 juillet 2026)

### Nouveautés
- **Vérification de déploiement** : Claude peut désormais attendre proprement qu'une mise en ligne Vercel se termine, et te dire si elle est prête, en échec ou trop longue. Avant, l'attente mourait au bout de deux minutes et il fallait aller vérifier à la main.

### Améliorations
- **`/start` ne gèle plus** : le diagnostic d'installation teste chaque outil avec son propre délai maximum. Un service injoignable ne bloque plus tout le rapport, il apparaît simplement en « pas vérifié ».
- **`/security` plus honnête** : l'audit des dépendances ne supprime plus le fichier de verrouillage d'un projet qui en a légitimement un, et il ne présente plus comme réussi un audit qui n'a pas pu tourner.
- **Base de données** : plusieurs commandes SQL envoyées d'un coup fonctionnent enfin, et de façon atomique : soit tout s'applique, soit rien. Une modification de base ne peut plus rester à moitié faite.

### Coulisses
- Connexion Vercel mutualisée entre les outils internes, avec repli automatique quand le jeton d'accès a expiré.
- Dépendances du modèle d'agent mises à jour.

## v2.5.5 (23 juillet 2026)

### Nouveautés
- **`/add-routine`** : confier une mission récurrente à votre propre Claude (un brief chaque matin, une analyse le vendredi, une veille qui vous alerte). Aucun code, aucune infrastructure : la routine tourne sur votre compte Claude, au rythme que vous choisissez.
- **`/add-workflow`** : ajouter à votre app un enchaînement d'étapes déclenché par un événement (un document déposé, un formulaire envoyé, un paiement reçu), avec des étapes intelligentes là où il en faut. Tout tourne dans votre app, et chaque exécution est tracée étape par étape dans votre base. C'est ce que beaucoup de gens appellent « un agent », sans qu'un agent soit nécessaire.

### Améliorations
- **`/add-automation`** oriente maintenant vers ces deux nouvelles portes : une mission récurrente pour vous part en routine Claude, une chaîne déclenchée par un événement part en workflow, et les traitements lourds ou continus restent sur un vrai worker (Cloudflare ou Render).
- **`/save-project`** : les sauvegardes récupèrent enfin le contenu de votre stockage de fichiers dans tous les cas (lecture directe avec les clés de votre projet, sans dépendre d'un outil en ligne de commande), et le téléchargement est nettement plus rapide. La sauvegarde de la base de données fonctionne à nouveau avec les versions récentes du pilote Neon. Surtout, une sauvegarde qui se retrouverait vide s'annonce désormais comme une erreur au lieu de passer pour un succès.

## v2.5.4 (16 juillet 2026)

### Améliorations
- **Le coffre-fort fait autorité sur les réglages de ton ordinateur** : si une ancienne clé d'accès traînait encore dans les réglages de ta machine (comme en posaient les versions d'avant le coffre-fort), elle pouvait passer devant le coffre sans rien dire. Résultat possible : Hypervibe installait les tâches de fond sur le mauvais compte Cloudflare, ou branchait les sauvegardes sur la mauvaise base de données, sans afficher la moindre erreur. Le coffre est désormais consulté en premier, et une vieille clé restée en place est ignorée, puis signalée pour que tu puisses la retirer.
- **Plus de repli silencieux quand le coffre est verrouillé** : si Hypervibe a besoin d'une clé alors que ton coffre est fermé, il te le dit clairement au lieu de se rabattre sans prévenir sur une valeur peut-être périmée.

### Coulisses
- Une clé lue plusieurs fois au cours d'une même commande n'est plus redemandée au coffre à chaque fois : elle est gardée en mémoire le temps de la commande. Les opérations qui en consultent plusieurs (sauvegardes, alertes de quota) s'en trouvent accélérées.

## v2.5.3 (16 juillet 2026)

### Améliorations
- **Suppression de projet (`/delete-project`)** : la confirmation finale, où l'on retape le nom du projet, échouait et bloquait la skill. Elle se fait désormais par une simple réponse dans le chat. La double vérification avant toute suppression reste inchangée.
- **Fiabilité sous Windows** : la suppression de projet et le changement de serveurs de noms chez Hostinger écrivaient leurs fichiers de travail à un endroit introuvable sous Windows, ce qui les faisait échouer. Les chemins sont maintenant calculés pour fonctionner sur Windows comme sur Mac, et les messages d'erreur des services sont affichés en clair.

### Coulisses
- Nettoyage de la documentation interne de la mise en place de l'email : elle décrivait encore une ligne de commande Resend abandonnée depuis, alors que la clé est lue dans le coffre-fort et que tout passe par l'API. Aucun changement de comportement.

## v2.5.2 (5 juillet 2026)

### Nouveautés
- **Garde-fou anti-collision de noms** : avant de créer un projet, Hypervibe vérifie que le nom choisi ne se confond pas avec un projet déjà présent sur tes comptes (Neon, Vercel, dossiers voisins, horloge partagée des tâches de fond). Si un nom risque de rendre une suppression future ambiguë (par exemple créer « street » alors que « street-cool » existe déjà), il te prévient et propose des variantes sûres. Objectif : qu’un `/delete-project` n’emporte jamais le mauvais projet.

### Améliorations
- **Migration automatique vers l’horloge partagée** : plus aucune commande à taper. En relançant `/start` après la mise à jour, Hypervibe détecte tout seul les anciens mécanismes de fond (sauvegardes, alertes de quota, tâches planifiées) et les regroupe dans le mécanisme unifié, en toute sécurité et avec ton accord à chaque étape.
- **Suppression de projet plus fiable** : la création et la suppression de projet partagent désormais la même logique de reconnaissance des noms, pour toujours s’accorder sur ce qui « entre en collision ».

### Coulisses
- Fonction de correspondance de noms mutualisée entre les skills, ajustements internes de l’enregistrement des tâches planifiées.

## v2.5.1 (5 juillet 2026)

### Nouveautés
- **Commande `/migrate-workers`** : si vous venez d'une version antérieure à la 2.5, tapez `/migrate-workers` après la mise à jour et Claude regroupe automatiquement vos anciens mécanismes de fond (sauvegardes, alertes de quota, tâches planifiées) dans la nouvelle horloge partagée unifiée. Il vérifie que tout fonctionne par un vrai test avant de retirer quoi que ce soit, et ne supprime rien sans votre accord. Sans effet si vous n'avez rien à migrer.

### Améliorations
- **/start** vous signale désormais s'il détecte d'anciens mécanismes de fond encore en place, et vous invite à lancer `/migrate-workers`.

## v2.5.0 (5 juillet 2026)

### Nouveautés
- **Routines Claude** : les missions récurrentes personnelles (« briefe-moi chaque matin », « analyse ma semaine le vendredi ») peuvent désormais être confiées directement à votre Claude, sans aucune infrastructure. `/add-automation` et `/add-agent` proposent automatiquement cette voie légère quand elle convient.
- **Horloge partagée unifiée** : vos tâches planifiées, vos sauvegardes de base de données et la surveillance des quotas tournent désormais dans un seul mécanisme mutualisé (un seul emplacement Cloudflare pour tous vos projets), versionné et récupérable.
- **Guide de migration** : un fichier MIGRATION.md à donner à Claude Code fait la transition depuis les anciennes versions, proprement et avec votre accord à chaque étape.

### Améliorations
- **/add-automation** : comprend d'abord si la tâche sert votre app ou vous-même, et recommande la bonne solution en expliquant ses raisons.
- **/add-cron** : mise en place plus simple et plus fiable (une seule étape), GitHub en secours si Cloudflare n'est pas configuré.
- **/add-agent** : oriente les missions personnelles vers une routine légère ; l'agent complet reste pour les fonctions de votre produit.
- **/add-backup-db et /quotas** : brancher un projet ou la surveillance se fait en un appel, tout est consigné dans un registre versionné.

### Coulisses
- Nouveau module interne partagé (worker unifié testé de bout en bout, 51 tests), nettoyage de cinq anciens scripts.

## v2.4.2 (4 juillet 2026)

### Améliorations
- **Sites multilingues mieux référencés** : la commande `/add-i18n` génère désormais un balisage SEO correct page par page. Chaque page obtient sa propre URL canonique et ses variantes de langue (hreflang), au lieu d'un balisage global hérité du gabarit qui faisait pointer toutes les pages vers l'accueil (les moteurs voyaient alors chaque page comme un doublon de la page d'accueil). Un nouvel utilitaire `localeAlternates()` pose ces balises directement dans chaque page.

### Coulisses
- Refonte du script d'installation i18n pour appliquer ce nouveau modèle de balisage par page.

## v2.4.1 (2 juillet 2026)

### Améliorations
- **Audit de sécurité (/security)** : la checklist couvre quatre nouvelles familles de failles, parmi les plus fréquentes dans les apps construites vite : l'accès aux données d'un autre utilisateur en changeant un identifiant dans la requête (IDOR), les webhooks non authentifiés (un faux "paiement reçu" Stripe devient impossible), le CSRF sur les routes personnalisées, et le SSRF (empêcher votre serveur d'appeler des adresses internes via une URL fournie par un utilisateur). L'audit vérifie aussi que la version de Next.js n'est pas touchée par une faille critique connue.
- **Correctifs plus sûrs** : l'ajout automatique des headers de sécurité s'insère désormais dans votre configuration existante au lieu de la réécrire. Les projets avec internationalisation, redirections ou options personnalisées ne perdent plus rien.
- **Header obsolète retiré** : X-XSS-Protection (déprécié, potentiellement contre-productif) n'est plus ajouté, et il est retiré s'il était présent d'un audit précédent.
- **Qualité après correction** : la skill vérifie systématiquement que le projet compile et passe le lint après ses corrections.
