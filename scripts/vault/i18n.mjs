// i18n.mjs - User-facing strings for the interactive vault window.
//
// The window is a SEPARATE process: it cannot see the conversation, so it has no
// way to know which language the user speaks. The calling skill does know, and
// passes it with `--lang fr`. When the flag is absent we fall back to the OS
// locale, then to English. Never guess from anything else.
//
// Only the WINDOW is translated here. Scripts whose output is read by Claude
// rather than by the user (push-env-vars, vault.mjs...) deliberately stay in
// English: that output is diagnostics, not user interface.
//
// Adding a language: copy the `en` block, translate the values, keep the {braces}
// placeholders. Any key missing from a language silently falls back to English,
// so a partial translation is safe to ship.
//
// The session's length is never written here: it comes from session.mjs (TTL_HOURS), the one
// length every reader of the session uses.

import { TTL_HOURS } from "./session.mjs";

const STRINGS = {
  en: {
    // Said first, in every window: a black window that asks for passwords is what frightens
    // people who have never seen one (a tester of 08/10/2026, during the preparation).
    reassure: "This window is expected: it is here, and only here, that you type your passwords and keys.\nClaude sees nothing of what you type, and nothing here can break: a typo is undone by starting again. When it is done, simply go back to Claude.\n",
    pressEnter: "\nPress Enter to close...",
    installing: "Vault tool not found, running automatic installation...\n",
    bwMissing: "The vault tool was not found and automatic installation failed. Check your connection, or install it manually: https://bitwarden.com/help/cli/",
    bwCannotRun: "Cannot run the vault tool. Set up the vault again to reinstall it.",

    email: "Email: ",
    emailRequired: "An email address is required.",
    masterPassword: "Master password: ",
    alreadyLoggedIn: "Already signed in as {email} on {server}.",
    signingIn: "Signing in...",
    twoFactorIntro: "If two-factor authentication (2FA) is enabled on your account, a CODE will be requested right after.",
    twoFactorWhere: "  - Depending on your setup, this code arrives either in your authenticator app (Google Authenticator, etc.),",
    twoFactorMail: "    or by EMAIL (check your inbox, the message arrives at sign-in time).",
    twoFactorType: "  - Type the code into this window, then Enter.",
    emailAgain: "Email [{email}] (Enter to keep it): ",
    signInRetry: "\nSign-in failed, wrong password or 2FA code? (attempt {attempt} of {total}). Try again.\n",
    signInFailedFinal: "Sign-in failed {total} times in a row. Start the operation again to retry.",
    signedIn: "\nSigned in. Next step: unlock.",

    notSignedIn: "No account is signed in on this machine. Sign in first, before unlocking.",
    unlocking: "Unlocking the vault for {email}...",
    unlockWrongPassword: "\nWrong master password (attempt {attempt} of {total}). Try again.\n",
    unlockFailedFinal: "Wrong master password {total} times in a row. Start the operation again to retry.",
    unlocked: `Vault unlocked for ${TTL_HOURS}h: after that, it locks itself again.`,
    lockNotScheduled: `The automatic lock in ${TTL_HOURS}h could not be scheduled on this computer ({detail}). The vault will still lock itself at the first key read, or at the first start of Claude, after ${TTL_HOURS}h.`,

    vaultLocked: "Vault locked or session expired. Unlock it first.",
    itemName: "Item name (e.g. CLOUDFLARE): ",
    nameRequired: "A name is required.",
    serviceOptional: "Service (optional): ",
    fieldsPrompt: "Fields (name:type,... ; default value:secret): ",
    badFieldType: "Unknown field type: {type}",
    folderFailed: "Cannot find or create the folder '{folder}' in the vault.",
    storingItem: "\nStoring '{name}' in folder '{folder}'{service}\n",
    serviceSuffix: " (service: {service})",
    hiddenPrompt: "{name} (hidden): ",
    plainPrompt: "{name}: ",
    emptyValue: "No value entered for '{name}'.",
    saveFailed: "Could not save '{name}'.",
    savedCreated: "'{name}' created.",
    savedUpdated: "'{name}' updated.",

    keysRequired: "--keys is required (e.g. --keys \"STRIPE_SECRET_KEY:secret\").",
    projectDirRequired: "--project-dir is required.",
    projectNotFound: "Project folder not found: {dir}",
    emptyKeyName: "Empty key name in --keys.",
    openingUrl: "\nOpening {url} in your browser.",
    grabValue: "Grab the value there, then come back to THIS window.\n",
    collectIntro: "Storing {count} value(s) for the project at {dir}.",
    collectWhere: "Typed here, they go straight into the project's .env (and Vercel).",
    collectNeverChat: "They never pass through our conversation.\n",
    collectFailed: "Saving failed. Details:\n{detail}",
    collectSavedLocal: "\nSaved to the project's .env: {names}.",
    collectSavedVercel: "\nSaved to the project's .env and pushed to Vercel: {names}.",
    collectSavedFile: "\nKept aside in {file}, in the project (not in .env, not online yet): {names}.",
    badStageFile: "A file of its own must be named .env.<name>, in the project: {file}",

    willOpen: "[vault] A terminal window will open for the \"{cmd}\" step.",
    ifNothingOpens: "[vault] If nothing opens, run this by hand in a terminal:\n           {cmd}",
    osascriptFailed: "[vault] Could not open Terminal{detail}.",
    osascriptFix: "[vault] Allow Terminal in System Settings -> Privacy & Security -> Automation, then try again, or run the command above by hand.",
    noEmulator: "[vault] No terminal window could be opened. Run this by hand: {cmd}",
    windowTimeout: "[vault] Gave up waiting for the terminal window.",
  },

  fr: {
    reassure: "Cette fenetre est normale : c'est ici, et seulement ici, que tu tapes tes mots de passe et tes cles.\nClaude ne voit rien de ce que tu y tapes, et tu ne peux rien casser : une faute de frappe se rattrape en recommencant. Quand c'est fini, reviens simplement dans Claude.\n",
    pressEnter: "\nAppuie sur Entree pour fermer...",
    installing: "Outil de coffre introuvable, installation automatique en cours...\n",
    bwMissing: "L'outil de coffre est introuvable et l'installation automatique a echoue. Verifie ta connexion, ou installe-le manuellement : https://bitwarden.com/help/cli/",
    bwCannotRun: "Impossible de lancer l'outil de coffre. Relance la configuration du coffre pour le reinstaller.",

    email: "Email : ",
    emailRequired: "Une adresse email est necessaire.",
    masterPassword: "Mot de passe maitre : ",
    alreadyLoggedIn: "Deja connecte en tant que {email} sur {server}.",
    signingIn: "Connexion en cours...",
    twoFactorIntro: "Si la double authentification (2FA) est active sur ton compte, un CODE va etre demande juste apres.",
    twoFactorWhere: "  - Selon ta configuration, ce code arrive soit dans ton application d'authentification (Google Authenticator, etc.),",
    twoFactorMail: "    soit par EMAIL (regarde ta boite, le message arrive au moment de la connexion).",
    twoFactorType: "  - Saisis le code dans cette fenetre, puis Entree.",
    emailAgain: "Email [{email}] (Entree pour le garder) : ",
    signInRetry: "\nEchec de la connexion, mauvais mot de passe ou mauvais code 2FA ? (essai {attempt} sur {total}). Reessaie.\n",
    signInFailedFinal: "Echec de la connexion {total} fois de suite. Relance l'operation pour reessayer.",
    signedIn: "\nLa connexion a reussi. Etape suivante : le deverrouillage.",

    notSignedIn: "Aucun compte n'est connecte sur cette machine. Connecte-toi d'abord, avant de deverrouiller.",
    unlocking: "Deverrouillage du coffre pour {email}...",
    unlockWrongPassword: "\nMot de passe maitre incorrect (essai {attempt} sur {total}). Reessaie.\n",
    unlockFailedFinal: "Mot de passe maitre incorrect {total} fois de suite. Relance l'operation pour reessayer.",
    unlocked: `Le coffre est ouvert pour ${TTL_HOURS}h : ensuite, il se referme tout seul.`,
    lockNotScheduled: `La fermeture automatique dans ${TTL_HOURS}h n'a pas pu etre programmee sur cet ordinateur ({detail}). Le coffre se refermera quand meme a la premiere lecture d'une cle, ou au premier lancement de Claude, apres ${TTL_HOURS}h.`,

    vaultLocked: "Coffre verrouille ou session expiree. Deverrouille-le d'abord.",
    itemName: "Nom de l'element (ex : CLOUDFLARE) : ",
    nameRequired: "Un nom est necessaire.",
    serviceOptional: "Service (facultatif) : ",
    fieldsPrompt: "Champs (nom:type,... ; par defaut value:secret) : ",
    badFieldType: "Type de champ inconnu : {type}",
    folderFailed: "Impossible de trouver ou de creer le dossier '{folder}' dans le coffre.",
    storingItem: "\nEnregistrement de '{name}' dans le dossier '{folder}'{service}\n",
    serviceSuffix: " (service : {service})",
    hiddenPrompt: "{name} (masque) : ",
    plainPrompt: "{name} : ",
    emptyValue: "Aucune valeur saisie pour '{name}'.",
    saveFailed: "Impossible d'enregistrer '{name}'.",
    savedCreated: "'{name}' est maintenant dans le coffre.",
    savedUpdated: "'{name}' a bien ete mis a jour dans le coffre.",

    keysRequired: "--keys est obligatoire (ex : --keys \"STRIPE_SECRET_KEY:secret\").",
    projectDirRequired: "--project-dir est obligatoire.",
    projectNotFound: "Dossier de projet introuvable : {dir}",
    emptyKeyName: "Nom de cle vide dans --keys.",
    openingUrl: "\nOuverture de {url} dans ton navigateur.",
    grabValue: "Recupere la valeur la-bas, puis reviens dans CETTE fenetre.\n",
    collectIntro: "Enregistrement de {count} valeur(s) pour le projet situe dans {dir}.",
    collectWhere: "Saisies ici, elles vont directement dans le .env du projet (et sur Vercel).",
    collectNeverChat: "Elles ne passent jamais par notre conversation.\n",
    collectFailed: "L'enregistrement a echoue. Details :\n{detail}",
    collectSavedLocal: "\nC'est fait. Ces valeurs sont maintenant dans le .env du projet : {names}.",
    collectSavedVercel: "\nC'est fait. Ces valeurs sont maintenant dans le .env du projet et sur Vercel : {names}.",
    collectSavedFile: "\nC'est fait. Ces valeurs sont gardees a part dans {file}, dans le projet (ni dans le .env, ni en ligne pour l'instant) : {names}.",
    badStageFile: "Un fichier a part doit s'appeler .env.<nom>, dans le projet : {file}",

    willOpen: "[coffre] Une fenetre de terminal va s'ouvrir pour l'etape \"{cmd}\".",
    ifNothingOpens: "[coffre] Si rien ne s'ouvre, lance ceci a la main dans un terminal :\n           {cmd}",
    osascriptFailed: "[coffre] Impossible d'ouvrir le Terminal{detail}.",
    osascriptFix: "[coffre] Autorise Terminal dans Reglages Systeme -> Confidentialite et securite -> Automatisation, puis reessaie, ou lance la commande ci-dessus a la main.",
    noEmulator: "[coffre] Aucune fenetre de terminal n'a pu etre ouverte. Lance ceci a la main : {cmd}",
    windowTimeout: "[coffre] Abandon de l'attente de la fenetre de terminal.",
  },
};

// The window runs in a bare console. On Windows that console is very often a
// legacy code page (cp850/cp1252) where accented characters render as mojibake,
// and we cannot reliably fix that from here. So the translations above are
// written WITHOUT accents on purpose: slightly rough to read, but correct
// everywhere. Do not "fix" them by adding accents back.
//
// CONSEQUENCE for French, and it bites: without its accent, a lone past participle
// becomes an imperative. "Enregistre dans le .env" reads as an ORDER to the user
// ("go and save it yourself") instead of a statement of fact ("saved"). Same trap
// with "Connecte", "Deverrouille", "Cree", "Pousse". So never end on a bare past
// participle: use a full clause ("C'est fait. Ces valeurs sont maintenant dans...",
// "La connexion a reussi", "Le coffre est ouvert") or a noun ("Enregistrement de...").

export function resolveLang(flag) {
  const candidate = flag && flag !== "true" ? flag : osLocale();
  const short = String(candidate || "").slice(0, 2).toLowerCase();
  return STRINGS[short] ? short : "en";
}

function osLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en";
  }
}

export function makeT(lang) {
  const dict = STRINGS[lang] || STRINGS.en;
  return (key, vars = {}) => {
    const template = dict[key] ?? STRINGS.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  };
}
