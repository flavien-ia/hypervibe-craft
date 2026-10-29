#!/usr/bin/env node
// update-hypervibe.mjs - Mise a jour du plugin Hypervibe (solo, open source).
//
// Le solo se distribue de deux facons, et une seule des deux a besoin de ce script :
//   - installe par depot GitHub (`/plugin marketplace add flavien-ia/hypervibe-harness`)
//     -> Claude Code met a jour tout seul, on ne touche a rien et on le dit.
//   - televerse a la main dans Claude Desktop (le zip du site)
//     -> personne ne previent l'utilisateur qu'une version est sortie : c'est notre travail.
// Le mode se lit dans le registre de Claude Code (known_marketplaces.json), pas par heuristique.
//
//   node update-hypervibe.mjs check    [--plugin-dir DIR]
//   node update-hypervibe.mjs download [--plugin-dir DIR]
//   node update-hypervibe.mjs install  --zip FICHIER [--plugin-dir DIR]
//
// Contrairement à Hypervibe Enterprise, aucune licence n'entre en jeu : le plugin est sous Apache 2.0,
// l'annonce de version se lit sur le depot public et l'archive se telecharge sans jeton.
//
// Sortie (stdout) : un objet JSON unique.
// Codes de sortie : 0 = commande executee, 1 = erreur, 2 = reseau injoignable.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { homedir } from "node:os";
import path from "node:path";
import { placeDuPlugin } from "../plugin-place.mjs";

const MANIFESTE_PUBLIC =
  "https://raw.githubusercontent.com/flavien-ia/hypervibe-harness/main/.claude-plugin/marketplace.json";
const TELECHARGEMENT = "https://hypervibe.fr/api/plugin/download-public";
// Ce que le site annonce de la version courante : sa version et l'empreinte
// de l'archive servie. Sert a verifier le telechargement avant de remplacer
// une installation qui marche.
const MANIFESTE_COURANT = "https://hypervibe.fr/api/plugin/current";
const DOSSIER_TRAVAIL = path.join(homedir(), ".hypervibe", "updates");

const args = process.argv.slice(2);
const commande = args[0];
function arg(nom, defaut = null) {
  const i = args.indexOf(nom);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : defaut;
}

// Ne jamais appeler process.exit() ici : sous Windows, une sortie dans les
// millisecondes qui suivent une reponse HTTPS avorte le processus (code 127 au
// lieu du vrai statut). On pose le code et on laisse la boucle se vider.
function rendre(objet, code = 0) {
  process.stdout.write(JSON.stringify(objet, null, 2) + "\n");
  process.exitCode = code;
}

function lireJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function comparerVersions(a, b) {
  const na = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const nb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] || 0) > (nb[i] || 0)) return 1;
    if ((na[i] || 0) < (nb[i] || 0)) return -1;
  }
  return 0;
}

// --- Reperage du plugin et de son mode d'installation -----------------------

function dossierPlugin() {
  const fourni = arg("--plugin-dir");
  if (fourni) return path.resolve(fourni);
  // Depuis scripts/update/ : deux crans au-dessus.
  const ici = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.resolve(decodeURIComponent(ici), "..", "..");
}

function modeInstallation(pluginDir) {
  const marketDir = path.dirname(pluginDir);
  const nomMarket = path.basename(marketDir);
  const registre = path.join(homedir(), ".claude", "plugins", "known_marketplaces.json");
  let source = null;
  if (existsSync(registre)) {
    try {
      const connus = lireJson(registre);
      const entree =
        connus[nomMarket] ||
        Object.values(connus).find(
          (e) => String(e?.installLocation || "").toLowerCase() === marketDir.toLowerCase(),
        );
      source = entree?.source?.source ?? null;
    } catch {
      source = null;
    }
  }
  // `directory` = televersement manuel dans Claude Desktop. `github` = depot suivi
  // par Claude Code, qui gere lui-meme la mise a jour. Registre absent (installation
  // exotique) : on se rabat sur le manuel, le seul cas ou notre aide sert a quelque chose.
  return {
    mode: source === "github" ? "marketplace" : "manuel",
    marketplace: nomMarket,
    marketplaceDir: marketDir,
    sourceRegistre: source,
  };
}

async function versionPubliee() {
  const reponse = await fetch(MANIFESTE_PUBLIC, { headers: { "User-Agent": "hypervibe-update" } });
  if (!reponse.ok) throw new Error(`le depot public a repondu ${reponse.status}`);
  const manifeste = await reponse.json();
  const entree = (manifeste.plugins || []).find((p) => p.name === "hypervibe");
  if (!entree?.version) throw new Error("aucune entree 'hypervibe' dans le manifeste public");
  return entree.version;
}

// --- Lecture d'archive zip (sans dependance) --------------------------------
// L'archive vient de notre propre API (JSZip, deflate) : pas de zip64, pas de
// chiffrement. Tout autre cas leve une erreur au lieu d'ecrire des fichiers douteux.

function lireArchive(buf) {
  let fin = -1;
  const plancher = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= plancher; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      fin = i;
      break;
    }
  }
  if (fin < 0) throw new Error("archive illisible (fin de repertoire introuvable)");
  const nombre = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  if (p === 0xffffffff) throw new Error("archive au format zip64, non geree");

  const entrees = [];
  for (let i = 0; i < nombre; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("repertoire d'archive corrompu");
    const methode = buf.readUInt16LE(p + 10);
    const tailleComp = buf.readUInt32LE(p + 20);
    const lNom = buf.readUInt16LE(p + 28);
    const lExtra = buf.readUInt16LE(p + 30);
    const lComm = buf.readUInt16LE(p + 32);
    const decalage = buf.readUInt32LE(p + 42);
    const nom = buf.toString("utf8", p + 46, p + 46 + lNom);
    entrees.push({ nom, methode, tailleComp, decalage });
    p += 46 + lNom + lExtra + lComm;
  }

  return entrees
    .filter((e) => !e.nom.endsWith("/"))
    .map((e) => {
      if (buf.readUInt32LE(e.decalage) !== 0x04034b50) throw new Error(`entree illisible : ${e.nom}`);
      const lNom = buf.readUInt16LE(e.decalage + 26);
      const lExtra = buf.readUInt16LE(e.decalage + 28);
      const debut = e.decalage + 30 + lNom + lExtra;
      const brut = buf.subarray(debut, debut + e.tailleComp);
      if (e.methode === 0) return { nom: e.nom, contenu: brut };
      if (e.methode === 8) return { nom: e.nom, contenu: inflateRawSync(brut) };
      throw new Error(`compression non geree (${e.methode}) : ${e.nom}`);
    });
}

function extraire(entrees, destination) {
  for (const e of entrees) {
    // Une archive ne doit jamais pouvoir ecrire hors de sa destination.
    if (e.nom.includes("..") || path.isAbsolute(e.nom) || /^[A-Za-z]:/.test(e.nom)) {
      throw new Error(`chemin refuse dans l'archive : ${e.nom}`);
    }
    const cible = path.join(destination, e.nom);
    mkdirSync(path.dirname(cible), { recursive: true });
    writeFileSync(cible, e.contenu);
  }
}

// --- Commandes ---------------------------------------------------------------

async function cmdCheck() {
  const pluginDir = dossierPlugin();
  const manifeste = path.join(pluginDir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifeste)) {
    return rendre(
      { ok: false, raison: "plugin_introuvable", pluginDir, message: `Aucun plugin Hypervibe dans ${pluginDir}.` },
      1,
    );
  }
  const locale = lireJson(manifeste).version;
  const install = modeInstallation(pluginDir);

  let publiee;
  try {
    publiee = await versionPubliee();
  } catch (e) {
    return rendre(
      {
        ok: false,
        offline: true,
        ...install,
        pluginDir,
        localVersion: locale,
        message: `Impossible de joindre le depot public : ${e.message}`,
      },
      2,
    );
  }

  rendre({
    ok: true,
    ...install,
    pluginDir,
    localVersion: locale,
    publishedVersion: publiee,
    updateAvailable: comparerVersions(publiee, locale) > 0,
    // Pour une installation suivie par Claude Code, la mise a jour lui appartient :
    // remplacer les fichiers dans son dos le mettrait en desaccord avec son registre.
    commandeNative: install.mode === "marketplace" ? `/plugin marketplace update ${install.marketplace}` : null,
  });
}

async function cmdDownload() {
  mkdirSync(DOSSIER_TRAVAIL, { recursive: true });
  let reponse;
  try {
    reponse = await fetch(TELECHARGEMENT, { headers: { "User-Agent": "hypervibe-update" } });
  } catch (e) {
    return rendre({ ok: false, offline: true, message: `Telechargement injoignable : ${e.message}` }, 2);
  }
  if (!reponse.ok) {
    return rendre({ ok: false, message: `Le site a repondu ${reponse.status} au telechargement.` }, 1);
  }
  const buf = Buffer.from(await reponse.arrayBuffer());

  let entrees;
  try {
    entrees = lireArchive(buf);
  } catch (e) {
    return rendre({ ok: false, message: `Archive inexploitable : ${e.message}` }, 1);
  }
  const manifeste = entrees.find((e) => e.nom === "hypervibe/.claude-plugin/plugin.json");
  if (!manifeste) {
    return rendre({ ok: false, message: "L'archive ne contient pas de plugin Hypervibe." }, 1);
  }
  const version = JSON.parse(manifeste.contenu.toString("utf8")).version;

  const empreinte = createHash("sha256").update(buf).digest("hex");

  // Verification d'integrite. Le site publie l'empreinte de l'archive qu'il
  // sert ; on refait le calcul sur ce qu'on a recu. Un ecart signifie que le
  // telechargement n'est pas ce qui a ete publie (transfert corrompu, cache
  // intermediaire, archive substituee) : on ne remplace pas une installation
  // qui marche par un fichier dont on ne sait pas ce qu'il est.
  //
  // Portee exacte, pour ne pas se raconter d'histoires : la meme origine sert
  // le fichier et son empreinte, donc ceci prouve l'integrite du transfert,
  // pas l'authenticite si le site lui-meme est compromis. Le canal independant
  // est la release GitHub, qui porte la meme empreinte.
  //
  // Une version publiee avant ce mecanisme n'a pas d'empreinte : on installe
  // alors sans verifier, plutot que de bloquer une mise a jour legitime.
  //
  // La comparaison n'a de sens que si le manifeste decrit LA MEME version que
  // l'archive recue. Sinon (cache pas encore rafraichi, ou release survenue
  // entre les deux appels), les deux empreintes different legitimement : on
  // installe sans verifier plutot que de refuser a tort. Refuser une mise a
  // jour valide est la pire des deux erreurs.
  let attendue = null;
  try {
    const r = await fetch(MANIFESTE_COURANT, { headers: { "User-Agent": "hypervibe-update" } });
    if (r.ok) {
      const j = await r.json();
      if (
        j &&
        j.version === version &&
        typeof j.sha256 === "string" &&
        j.sha256.length === 64
      ) {
        attendue = j.sha256;
      }
    }
  } catch {
    // Manifeste injoignable : on continue sans verifier (le telechargement,
    // lui, a reussi). Ne jamais faire dependre la mise a jour d'un second
    // appel reseau facultatif.
  }
  if (attendue && attendue !== empreinte) {
    return rendre(
      {
        ok: false,
        reason: "sha256-mismatch",
        expected: attendue,
        got: empreinte,
        message:
          "L'archive telechargee ne correspond pas a l'empreinte publiee par le site. Rien n'a ete installe. Reessayer plus tard, et si l'ecart persiste, verifier l'empreinte sur la release GitHub avant d'installer quoi que ce soit.",
      },
      1,
    );
  }

  const fichier = path.join(DOSSIER_TRAVAIL, `hypervibe-${version}.zip`);
  writeFileSync(fichier, buf);
  rendre({
    ok: true,
    file: fichier,
    version,
    files: entrees.length,
    sizeBytes: buf.length,
    sha256: empreinte,
    sha256Verified: attendue !== null,
  });
}

function cmdInstall() {
  const zip = arg("--zip");
  if (!zip || !existsSync(zip)) return rendre({ ok: false, message: "Archive absente : passer --zip <fichier>." }, 1);
  const pluginDir = dossierPlugin();
  const install = modeInstallation(pluginDir);
  if (install.mode === "marketplace" && !args.includes("--force")) {
    return rendre(
      {
        ok: false,
        raison: "gere_par_claude_code",
        message: `Ce plugin est suivi par Claude Code : /plugin marketplace update ${install.marketplace}.`,
      },
      1,
    );
  }

  const manifesteActuel = path.join(pluginDir, ".claude-plugin", "plugin.json");
  const ancienne = existsSync(manifesteActuel) ? lireJson(manifesteActuel).version : "inconnue";

  let entrees;
  try {
    entrees = lireArchive(readFileSync(zip));
  } catch (e) {
    return rendre({ ok: false, message: `Archive inexploitable : ${e.message}` }, 1);
  }

  // On deballe et on controle AVANT de toucher au plugin en place : tant que la
  // nouvelle version n'est pas prouvee complete, l'installation actuelle ne bouge pas.
  const temporaire = path.join(DOSSIER_TRAVAIL, `extraction-${process.pid}`);
  rmSync(temporaire, { recursive: true, force: true });
  mkdirSync(temporaire, { recursive: true });
  let nouvelle;
  try {
    extraire(entrees, temporaire);
    const racine = path.join(temporaire, "hypervibe");
    nouvelle = lireJson(path.join(racine, ".claude-plugin", "plugin.json")).version;
    // Les trois piliers du plugin. Pas de `commands/` : ici ce sont les skills qui
    // portent les commandes. Une archive valide mais amputee est ainsi refusee avant
    // d'avoir touche a l'installation en place.
    for (const requis of ["skills", "scripts", "templates"]) {
      const p = path.join(racine, requis);
      if (!existsSync(p) || readdirSync(p).length === 0) throw new Error(`dossier ${requis} absent ou vide`);
    }
    if (entrees.length < 50) throw new Error(`archive trop maigre (${entrees.length} fichiers)`);
  } catch (e) {
    rmSync(temporaire, { recursive: true, force: true });
    return rendre({ ok: false, message: `Nouvelle version incomplete, rien n'a ete remplace : ${e.message}` }, 1);
  }

  const sauvegarde = `${pluginDir}-backup-${ancienne}`;
  rmSync(sauvegarde, { recursive: true, force: true });
  try {
    if (existsSync(pluginDir)) renameSync(pluginDir, sauvegarde);
    renameSync(path.join(temporaire, "hypervibe"), pluginDir);
  } catch (e) {
    // Permutation ratee : on remet l'ancienne en place plutot que de laisser un trou.
    if (!existsSync(pluginDir) && existsSync(sauvegarde)) renameSync(sauvegarde, pluginDir);
    rmSync(temporaire, { recursive: true, force: true });
    return rendre({ ok: false, message: `Remplacement impossible, version precedente restauree : ${e.message}` }, 1);
  }
  rmSync(temporaire, { recursive: true, force: true });

  const posee = lireJson(path.join(pluginDir, ".claude-plugin", "plugin.json")).version;
  if (posee !== nouvelle) {
    rmSync(pluginDir, { recursive: true, force: true });
    renameSync(sauvegarde, pluginDir);
    return rendre({ ok: false, message: "Verification finale en echec, version precedente restauree." }, 1);
  }

  // Catalogue local : par NOM, jamais par index (il porte aussi les plugins d'equipe).
  let catalogue = false;
  const fichierCatalogue = path.join(install.marketplaceDir, ".claude-plugin", "marketplace.json");
  if (existsSync(fichierCatalogue)) {
    try {
      const j = lireJson(fichierCatalogue);
      const entree = (j.plugins || []).find((p) => p.name === "hypervibe");
      if (entree) {
        entree.version = nouvelle;
        writeFileSync(fichierCatalogue, JSON.stringify(j, null, 2) + "\n");
        catalogue = true;
      }
    } catch {
      catalogue = false;
    }
  }

  // La sauvegarde n'est promise que dans un dossier de marketplace : le registre des plugins
  // televerses de Claude Desktop l'efface en quelques minutes (voir scripts/plugin-place.mjs).
  const { place, backupKept, desktop } = placeDuPlugin(pluginDir, "hypervibe");
  rendre({
    ok: true,
    oldVersion: ancienne,
    version: nouvelle,
    pluginDir,
    backup: sauvegarde,
    backupKept,
    desktop,
    place,
    catalogueMisAJour: catalogue,
  });
}

try {
  if (commande === "check") await cmdCheck();
  else if (commande === "download") await cmdDownload();
  else if (commande === "install") cmdInstall();
  else rendre({ ok: false, message: "Commande attendue : check | download | install" }, 1);
} catch (e) {
  rendre({ ok: false, message: e?.message || String(e) }, 1);
}
