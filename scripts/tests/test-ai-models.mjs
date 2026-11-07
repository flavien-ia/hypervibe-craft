#!/usr/bin/env node
/**
 * Recette de la sélection de modèles et de l'estimation de coût de `/add-ai`.
 *
 * Aucun accès réseau : le catalogue est injecté. Ce qui est vérifié ici n'est
 * pas cosmétique, chaque contrôle vient d'un défaut réel rencontré pendant la
 * construction (méta-modèles de routage à prix négatif proposés en premier,
 * gamme Qualité renvoyant les modèles bon marché d'Éco, variantes « batch »
 * inutilisables en conversation).
 */

import {
  _injecterCatalogue,
  candidats,
  estimer,
  GAMMES,
  tableauEstimation,
} from "../ai/openrouter.mjs";

const M = (id, entree, sortie, contexte = 200000) => ({
  id,
  nom: id,
  contexte,
  prixEntree: entree / 1e6,
  prixSortie: sortie / 1e6,
  prixCacheLecture: 0,
  prixCacheEcriture: 0,
  gratuit: entree === 0 && sortie === 0,
});

const CATALOGUE = [
  // Méta-modèles de routage : prix « variable », encodé -1 par OpenRouter.
  { ...M("openrouter/auto-beta", -1e6, -1e6), gratuit: false },
  { ...M("openrouter/fusion", -1e6, -1e6), gratuit: false },
  // Gratuits.
  M("un-labo/petit-modele:free", 0, 0, 32000),
  M("autre-labo/mini:free", 0, 0, 16000),
  // Éco.
  M("anthropic/claude-haiku-5.5", 0.1, 0.5, 1000000),
  M("anthropic/claude-haiku-4.5", 1, 5, 200000),
  M("google/gemini-3.1-flash-lite", 0.25, 1.5, 1048000),
  M("google/gemini-2.5-flash-lite", 0.1, 0.4, 1048000),
  M("openai/gpt-5-nano", 0.05, 0.4, 400000),
  M("openai/gpt-4.1-mini", 0.4, 1.6, 1047000),
  M("obscur/pas-cher", 0.02, 0.1, 64000),
  // Qualité.
  M("anthropic/claude-sonnet-5", 2, 10, 1000000),
  M("anthropic/claude-sonnet-4.5", 3, 15, 1000000),
  M("google/gemini-2.5-pro", 1.25, 10, 1048000),
  M("google/gemini-3.5-flash", 1.5, 9, 1048000),
  M("openai/gpt-5.1-codex-max", 1.25, 10, 400000),
  M("openai/gpt-5.1", 1.25, 10, 400000),
  M("openai/gpt-4.1", 2, 8, 1047000),
  // Pièges : variantes inutilisables en conversation.
  M("openai/o3-pro:batch", 20, 80, 200000),
  M("google/gemini-2.5-flash-image", 0.3, 2.5, 32000),
  M("un-labo/truc-embed", 0.1, 0.1, 32000),
  // Contexte trop court pour Éco.
  M("etroit/modele", 0.2, 0.5, 4000),
];

let echecs = 0;
let total = 0;
function verifier(nom, condition, detail = "") {
  total += 1;
  if (condition) {
    console.log(`  ok   ${nom}`);
  } else {
    echecs += 1;
    console.log(`  ECHEC ${nom}${detail ? ` : ${detail}` : ""}`);
  }
}

const restaurer = _injecterCatalogue(CATALOGUE);

try {
  const eco = await candidats("eco", { limite: 6 });
  const qualite = await candidats("qualite", { limite: 6 });
  const gratuit = await candidats("gratuit", { limite: 6 });
  const ids = (l) => l.map((m) => m.id);

  console.log("\n- Exclusions");
  const tous = [...eco, ...qualite, ...gratuit];
  verifier(
    "aucun méta-modèle de routage",
    !tous.some((m) => m.id.startsWith("openrouter/")),
    ids(tous).filter((i) => i.startsWith("openrouter/")).join(", "),
  );
  verifier("aucun prix négatif", !tous.some((m) => m.prixEntree < 0 || m.prixSortie < 0));
  verifier("aucune variante batch", !ids(tous).some((i) => i.includes(":batch")));
  verifier("aucune variante image", !ids(tous).some((i) => i.includes("-image")));
  verifier("aucun modèle d'embeddings", !ids(tous).some((i) => i.includes("embed")));
  verifier(
    "contexte trop court écarté d'Éco",
    !ids(eco).includes("etroit/modele"),
  );

  console.log("\n- Les gammes ne se recouvrent pas");
  const communs = ids(eco).filter((i) => ids(qualite).includes(i));
  verifier(
    "Éco et Qualité n'ont aucun modèle en commun",
    communs.length === 0,
    communs.join(", "),
  );
  verifier(
    "Éco reste sous le plafond de sa bande",
    eco.every((m) => m.prixEntree <= GAMMES.eco.maxEntree),
  );
  verifier(
    "Qualité reste au-dessus du plancher de sa bande",
    qualite.every((m) => m.prixEntree > GAMMES.qualite.minEntree),
  );
  verifier(
    "Gratuit ne contient que du gratuit",
    gratuit.length > 0 && gratuit.every((m) => m.prixEntree === 0 && m.prixSortie === 0),
  );

  console.log("\n- Ordre de préférence");
  verifier(
    "Éco propose une famille connue en premier",
    ids(eco)[0] === "anthropic/claude-haiku-5.5",
    `obtenu ${ids(eco)[0]}`,
  );
  verifier(
    "une génération d'avant ne passe pas devant la courante, même moins chère",
    ids(eco).indexOf("google/gemini-3.1-flash-lite") >= 0 &&
      ids(eco).indexOf("google/gemini-3.1-flash-lite") < ids(eco).indexOf("google/gemini-2.5-flash-lite"),
    ids(eco).join(", "),
  );
  verifier(
    "un modèle spécialisé dans le code ne passe pas devant le modèle général",
    ids(qualite).includes("openai/gpt-5.1") && !ids(qualite).includes("openai/gpt-5.1-codex-max"),
    ids(qualite).join(", "),
  );
  verifier(
    "Qualité propose Sonnet en premier",
    ids(qualite)[0] === "anthropic/claude-sonnet-5",
    `obtenu ${ids(qualite)[0]}`,
  );
  verifier(
    "la version la moins chère d'une famille l'emporte",
    ids(qualite).includes("anthropic/claude-sonnet-5") &&
      !ids(qualite).slice(0, 1).includes("anthropic/claude-sonnet-4.5"),
  );
  verifier(
    "un modèle hors famille complète quand même la liste",
    ids(eco).includes("obscur/pas-cher"),
  );

  console.log("\n- Arithmétique");
  const e = estimer({
    prixEntree: 1e-6,
    prixSortie: 2e-6,
    tokensEntree: 1000,
    tokensSortie: 500,
    appelsParJour: 10,
    marge: 1,
  });
  verifier(
    "coût par appel exact (1000 x 1$/M + 500 x 2$/M = 0,002 $)",
    Math.abs(e.parAppel - 0.002) < 1e-9,
    `obtenu ${e.parAppel}`,
  );
  verifier("le mois vaut trente jours", Math.abs(e.parMois - e.parJour * 30) < 1e-9);
  const avecMarge = estimer({
    prixEntree: 1e-6,
    prixSortie: 2e-6,
    tokensEntree: 1000,
    tokensSortie: 500,
    appelsParJour: 10,
  });
  verifier(
    "la marge par défaut majore l'estimation",
    avecMarge.parAppel > e.parAppel,
  );

  console.log("\n- Tableau d'estimation");
  const t = await tableauEstimation({
    gamme: "qualite",
    profil: "chat",
    appelsParJour: 50,
  });
  verifier("le tableau porte des lignes", t.lignes.length > 0);
  verifier(
    "chaque ligne porte un coût mensuel numérique",
    t.lignes.every((l) => typeof l.parMoisNum === "number" && l.parMoisNum > 0),
  );
  verifier(
    "un profil inconnu est refusé",
    await tableauEstimation({ gamme: "eco", profil: "inexistant", appelsParJour: 1 })
      .then(() => false)
      .catch(() => true),
  );
} finally {
  restaurer();
}

console.log(`\n${total - echecs}/${total} vérifications passées`);
process.exit(echecs === 0 ? 0 : 1);
