/**
 * OpenRouter : catalogue de modèles, estimation de coût, clés de projet.
 *
 * Deux principes qui expliquent la forme de ce module.
 *
 * 1. Les prix ne sont JAMAIS écrits en dur. Une table de tarifs recopiée dans
 *    le plugin ment au bout de quelques mois, et elle ment silencieusement :
 *    l'utilisateur valide un budget calculé sur des prix périmés. Tout part
 *    donc du catalogue public `GET /api/v1/models`, qui porte les prix réels
 *    du moment (et même ceux du cache).
 *
 * 2. Le plafond de dépense appartient au fournisseur, pas à notre code. Une
 *    clé OpenRouter se crée avec une limite de crédits : c'est un coupe-circuit
 *    côté serveur, qu'aucun bug applicatif ne peut contourner. Le suivi qu'on
 *    ajoute dans l'app sert à VOIR la dépense, pas à l'empêcher.
 *
 * Aucune dépendance : `fetch` natif de Node 18+.
 */

const API = "https://openrouter.ai/api/v1";

/** Marge appliquée aux estimations : un usage réel dépasse toujours le modèle. */
export const MARGE_ESTIMATION = 1.3;

// ─── Catalogue et prix ───────────────────────────────────────────────────────

let cacheCatalogue = null;

/**
 * Le catalogue complet, avec les prix par token (dollars). Mis en cache pour
 * la durée du processus : une skill l'interroge plusieurs fois.
 */
export async function catalogueModeles() {
  if (cacheCatalogue) return cacheCatalogue;
  const res = await fetch(`${API}/models`);
  if (!res.ok) {
    throw new Error(
      `Catalogue OpenRouter indisponible (HTTP ${res.status}). Sans lui, aucune estimation de coût n'est fiable : réessayez plus tard.`,
    );
  }
  const { data } = await res.json();
  cacheCatalogue = data.map((m) => ({
    id: m.id,
    nom: m.name,
    contexte: m.context_length ?? 0,
    prixEntree: Number(m.pricing?.prompt ?? 0),
    prixSortie: Number(m.pricing?.completion ?? 0),
    prixCacheLecture: Number(m.pricing?.input_cache_read ?? 0),
    prixCacheEcriture: Number(m.pricing?.input_cache_write ?? 0),
    gratuit:
      Number(m.pricing?.prompt ?? 0) === 0 &&
      Number(m.pricing?.completion ?? 0) === 0,
  }));
  return cacheCatalogue;
}

/**
 * Injecte un catalogue de test, et rend la fonction qui remet l'état d'origine.
 *
 * Seule couture ouverte pour la recette : les tests du plugin ne touchent
 * jamais le réseau, et une sélection de modèles qui n'est pas testable est
 * une sélection qu'on découvre cassée chez l'utilisateur.
 */
export function _injecterCatalogue(liste) {
  const avant = cacheCatalogue;
  cacheCatalogue = liste;
  return () => {
    cacheCatalogue = avant;
  };
}

export async function modele(id) {
  const trouve = (await catalogueModeles()).find((m) => m.id === id);
  if (!trouve) {
    throw new Error(
      `Modèle « ${id} » absent du catalogue OpenRouter. Il a peut-être été retiré : choisissez-en un autre.`,
    );
  }
  return trouve;
}

/**
 * Les trois gammes, et comment on choisit un modèle dedans.
 *
 * Le tri par prix ne marche pas : vers le bas il ramène des modèles minuscules,
 * vers le haut des modèles hérités ou exotiques (une version « batch », un
 * ancien porte-drapeau resté cher). Le prix dit ce que ça coûte, jamais ce que
 * ça vaut.
 *
 * D'où deux étages. Une BANDE de prix qui définit la gamme, et une liste de
 * FAMILLES par ordre de préférence, qui dit quoi proposer en premier dedans.
 * Les familles sont des préfixes, pas des identifiants : `anthropic/claude-sonnet`
 * désigne le Sonnet du moment, quelle que soit sa version. Si une famille
 * disparaît du catalogue, on complète simplement avec le reste de la bande, et
 * la skill continue de fonctionner.
 */
export const GAMMES = {
  gratuit: {
    libelle: "Gratuit",
    minEntree: -1,
    maxEntree: 0,
    maxSortie: 0,
    contexteMin: 8000,
    familles: [],
    usage:
      "Prototypage et données non personnelles uniquement : certains fournisseurs gratuits s'autorisent à entraîner sur ce qui passe.",
  },
  eco: {
    libelle: "Éco",
    // Dollars par TOKEN. En dollars par million : jusqu'à 1 en entrée, 5 en
    // sortie, ce qui est la classe « rapide » de tous les grands fournisseurs.
    minEntree: 0,
    maxEntree: 1e-6,
    maxSortie: 5e-6,
    contexteMin: 32000,
    // Préfixes de génération (gemini-3, gpt-5) ou de famille : chacun ramène son membre le moins
    // cher dans la bande, donc un préfixe trop large (google/gemini) ramènerait une génération
    // d'avant restée bon marché. Relus sur le catalogue du 07/11/2026.
    familles: [
      "anthropic/claude-haiku",
      "google/gemini-3",
      "openai/gpt-5",
      "deepseek/deepseek",
    ],
    usage:
      "Classification, extraction, résumé, gros volumes : la qualité suffit largement et le coût reste marginal.",
  },
  qualite: {
    libelle: "Qualité",
    // Plancher volontaire à 1 $/M en entrée : en dessous commence la gamme
    // Éco, et proposer les mêmes modèles dans les deux viderait le choix de
    // son sens.
    minEntree: 1e-6,
    maxEntree: 10e-6,
    maxSortie: 40e-6,
    contexteMin: 100000,
    familles: [
      "anthropic/claude-sonnet",
      "google/gemini-3",
      "openai/gpt-5",
    ],
    usage:
      "Conversation exposée aux clients, rédaction qui porte la marque, raisonnement sur des cas complexes.",
  },
};

/** Variantes qui ne sont pas des modèles de conversation utilisables ici. */
// -codex : spécialisés dans le code, à égalité de prix avec le modèle général de la même
// génération, ils passaient devant lui (gpt-5.1-codex-max en Qualité, le 07/11/2026).
const EXCLUS = /:batch|-image|-tts|-audio|whisper|embed|-search|-codex|-preview$/;

function dansLaBande(m, g, gamme) {
  if (gamme === "gratuit") return m.gratuit;
  return (
    !m.gratuit &&
    m.prixEntree > g.minEntree &&
    m.prixEntree <= g.maxEntree &&
    m.prixSortie <= g.maxSortie
  );
}

export async function candidats(gamme, { limite = 8 } = {}) {
  const g = GAMMES[gamme];
  if (!g) throw new Error(`Gamme inconnue : ${gamme}`);
  const eligibles = (await catalogueModeles())
    .filter((m) => m.contexte >= g.contexteMin)
    // Prix négatif = méta-modèle de routage (la famille openrouter/*) : son
    // tarif dépend du modèle réellement choisi, il est donc inestimable, et
    // sans ce filtre il passait en tête avec un coût négatif.
    .filter((m) => m.prixEntree >= 0 && m.prixSortie >= 0)
    .filter((m) => !m.id.startsWith("openrouter/"))
    .filter((m) => !EXCLUS.test(m.id))
    .filter((m) => dansLaBande(m, g, gamme));

  const retenus = [];
  const prendre = (m) => {
    if (m && !retenus.some((r) => r.id === m.id) && retenus.length < limite) {
      retenus.push(m);
    }
  };

  // D'abord les familles préférées, dans l'ordre : pour chacune, le membre le
  // moins cher qui tient dans la bande (donc la version courante, pas une
  // ancienne restée chère).
  for (const famille of g.familles) {
    const membres = eligibles
      .filter((m) => m.id.startsWith(famille))
      .sort((a, b) => a.prixEntree + a.prixSortie - (b.prixEntree + b.prixSortie));
    prendre(membres[0]);
  }

  // Puis on complète avec le reste de la bande, du moins cher au plus cher :
  // c'est le repli quand les familles connues ont disparu du catalogue.
  for (const m of [...eligibles].sort(
    (a, b) => a.prixEntree + a.prixSortie - (b.prixEntree + b.prixSortie),
  )) {
    prendre(m);
  }

  return retenus;
}

// ─── Estimation ──────────────────────────────────────────────────────────────

/**
 * Le coût d'un profil d'usage, en dollars.
 *
 * `tokensEntree` / `tokensSortie` décrivent UN appel type. La marge couvre
 * l'écart entre le modèle et la vraie vie (relances, contextes plus longs que
 * prévu) : mieux vaut annoncer trop que surprendre.
 */
export function estimer({
  prixEntree,
  prixSortie,
  tokensEntree,
  tokensSortie,
  appelsParJour,
  marge = MARGE_ESTIMATION,
}) {
  const parAppel = tokensEntree * prixEntree + tokensSortie * prixSortie;
  const parAppelMarge = parAppel * marge;
  return {
    parAppel: parAppelMarge,
    parJour: parAppelMarge * appelsParJour,
    parMois: parAppelMarge * appelsParJour * 30,
  };
}

/** Profils types, pour que l'estimation parle de cas concrets. */
export const PROFILS = {
  chat: {
    libelle: "Une conversation (environ 6 échanges)",
    tokensEntree: 6000,
    tokensSortie: 1800,
  },
  traitement: {
    libelle: "Un document analysé ou classé",
    tokensEntree: 3000,
    tokensSortie: 400,
  },
  generation: {
    libelle: "Un texte rédigé (article, description)",
    tokensEntree: 1500,
    tokensSortie: 2500,
  },
  qr: {
    libelle: "Une question sur vos contenus",
    tokensEntree: 5000,
    tokensSortie: 600,
  },
};

const usd = (n) =>
  n >= 1 ? `${n.toFixed(2)} $` : n >= 0.01 ? `${n.toFixed(3)} $` : `${n.toFixed(5)} $`;

/** Le tableau que la skill montre AVANT de scaffolder quoi que ce soit. */
export async function tableauEstimation({ gamme, profil, appelsParJour }) {
  const p = PROFILS[profil];
  if (!p) throw new Error(`Profil inconnu : ${profil}`);
  const modeles = await candidats(gamme, { limite: 3 });
  if (!modeles.length) {
    return {
      gamme,
      profil,
      appelsParJour,
      lignes: [],
      note: `Aucun modèle ne correspond à la gamme « ${GAMMES[gamme].libelle} » dans le catalogue du jour.`,
    };
  }
  return {
    gamme,
    gammeLibelle: GAMMES[gamme].libelle,
    profil,
    profilLibelle: p.libelle,
    appelsParJour,
    lignes: modeles.map((m) => {
      const e = estimer({
        prixEntree: m.prixEntree,
        prixSortie: m.prixSortie,
        tokensEntree: p.tokensEntree,
        tokensSortie: p.tokensSortie,
        appelsParJour,
      });
      return {
        id: m.id,
        nom: m.nom,
        gratuit: m.gratuit,
        parAppel: usd(e.parAppel),
        parMois: usd(e.parMois),
        parMoisNum: e.parMois,
      };
    }),
  };
}

// ─── Clés de projet ──────────────────────────────────────────────────────────

/**
 * Crée une clé d'inférence dédiée à un projet, plafonnée.
 *
 * `cleGestion` est la clé de MANAGEMENT (openrouter.ai/settings/management-keys),
 * qui ne sert jamais à l'inférence : elle ne sait que fabriquer, lister et
 * révoquer des clés. C'est le même partage qu'entre la clé Admin OpenAI et les
 * clés de service : une seule clé à conserver, autant de clés jetables que de
 * projets, et un projet compromis ne compromet que son propre plafond.
 */
export async function creerCleProjet({
  cleGestion,
  nom,
  plafondUsd,
  resetQuotidien = false,
}) {
  if (!cleGestion) throw new Error("Clé de management OpenRouter manquante.");
  if (!(plafondUsd > 0)) {
    throw new Error(
      "Un plafond strictement positif est obligatoire : une clé sans limite est exactement ce que cette skill existe pour éviter.",
    );
  }
  const res = await fetch(`${API}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cleGestion}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: nom,
      limit: plafondUsd,
      // Un plafond MENSUEL par défaut, comme les skills le présentent : sans limit_reset, OpenRouter
      // ne remet jamais le compteur à zéro, et la clé s’arrêtait pour de bon au premier plafond
      // atteint (relevé au banc Enterprise, 06/11/2026). Remise à zéro le 1er du mois, minuit UTC.
      limit_reset: resetQuotidien ? "daily" : "monthly",
    }),
  });
  const corps = await res.text();
  if (!res.ok) {
    throw new Error(
      `Création de clé refusée (HTTP ${res.status}) : ${corps.slice(0, 300)}`,
    );
  }
  const data = JSON.parse(corps);
  // La valeur utilisable n'est renvoyée qu'ici, une seule fois.
  const valeur = data.key ?? data.data?.key;
  if (!valeur) {
    throw new Error(
      "OpenRouter n'a pas renvoyé la clé. Rien n'a été installé ; vérifiez sur openrouter.ai/settings/keys qu'une clé orpheline n'a pas été créée.",
    );
  }
  return { valeur, hash: data.data?.hash ?? data.hash ?? null, plafondUsd };
}

export async function listerCles(cleGestion) {
  const res = await fetch(`${API}/keys`, {
    headers: { Authorization: `Bearer ${cleGestion}` },
  });
  if (!res.ok) throw new Error(`Lecture des clés refusée (HTTP ${res.status}).`);
  const { data } = await res.json();
  return data ?? [];
}

export async function supprimerCle(cleGestion, hash) {
  const res = await fetch(`${API}/keys/${hash}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cleGestion}` },
  });
  if (!res.ok)
    throw new Error(`Suppression de clé refusée (HTTP ${res.status}).`);
  return true;
}
