#!/usr/bin/env node
// test-repair-admin-gate.mjs - The repair of the admin space of the projects built before 3.4.17,
// offered by /update-hypervibe (and the collaborator's /update-hypervibe-enterprise), 3.4.18:
//   1. the diagnosis of a page: `checked`, `client`, `to-fix` (a function declaration without the
//      check), `manual` (an arrow, a name, a check of its own, a layout that lets in more than the
//      admin, a project where the templates' requireAdmin() would not fit), and `review` for a
//      members' area closed by its layout only; it never writes;
//   2. the repair: `await requireAdmin();` first in each `to-fix` page with its import, `async` when
//      it was missing, nothing else in the page; the helper and the barrier, never over a middleware
//      the project has; the old rule of the CLAUDE.md (and AGENTS.md) replaced in its place, in its
//      language, never twice; run again, nothing changes;
//   3. which files the repair would write already have changes not committed, asked of git without
//      ever running a program the folder's configuration names;
//   4. the --scan: the projects of an umbrella folder and of the folders where projects are kept, one
//      and two levels down, node_modules and hidden folders left alone, a folder that cannot be read
//      said without stopping the rest; the profile itself is a simulated one; the working copies of
//      a repository grouped, each by its real path (3.4.20), the project's `needed` being its first
//      copy's and the others said apart with their state (`otherCopies`), the collaborator's work
//      branch first with --collab;
//   5. the rules the script writes are the ones the skills write today, and the update skill calls it.
// Projects made in a temporary folder from the old templates (3.4.16, kept here as they were) and
// from the harness's own; no network, no real project. The same file runs in the solo harness and in
// the collaborator's.
//
//   node scripts/tests/test-repair-admin-gate.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "repair-admin-gate.mjs");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 700)})` : ""}`);
}

check("scripts/repair-admin-gate.mjs existe", existsSync(SCRIPT));
if (!existsSync(SCRIPT)) {
  console.log(`\n${checks - failures}/${checks} verifications`);
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
const R = await import(pathToFileURL(SCRIPT).href);
const { render } = await import(pathToFileURL(join(ROOT, "scripts", "_render.mjs")).href);
const lireHarnais = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n") : "");

// ─── The templates of 3.4.16, as /add-auth wrote them (the layout alone checked) ───
const ANCIEN_LAYOUT = `import { redirect } from "next/navigation";
import { isAdmin } from "~/server/auth";

export default async function AdminProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAdmin())) {
    redirect("/admin/signin?callbackUrl=/admin");
  }
  return <>{children}</>;
}
`;
const ANCIEN_PAGE = `import { signOut } from "~/server/auth";
import { Button } from "~/components/ui/button";

export default function AdminHomePage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Espace admin</h1>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/admin/signin" });
          }}
        >
          <Button variant="outline" type="submit" className="cursor-pointer">
            Se déconnecter
          </Button>
        </form>
      </div>
      <p className="mt-6 text-muted-foreground">
        Bienvenue dans ton espace admin. C’est ici que tu géreras les contenus
        de ton site. Demande à Claude d’ajouter les pages dont tu as besoin
        (par exemple : « ajoute une page pour gérer les réservations »).
      </p>
    </main>
  );
}
`;
// What the repair must make of it, to the byte.
const PAGE_REPAREE = ANCIEN_PAGE.replace('import { Button } from "~/components/ui/button";\n', 'import { Button } from "~/components/ui/button";\nimport { requireAdmin } from "~/server/require-admin";\n').replace("export default function AdminHomePage() {\n", "export default async function AdminHomePage() {\n  await requireAdmin();\n");
const SIGNIN = 'export default function Connexion() {\n  return <p>connexion</p>;\n}\n';
const PAGE_PARAMS = `import { db } from "~/server/db";

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await db.query.clients.findFirst({ where: (c, { eq }) => eq(c.id, id) });
  return (
    <main>
      <h1>{client?.name}</h1>
      <p>{\`Fiche de \${client?.name ?? "l'inconnu"}\`}</p>
    </main>
  );
}
`;
const PAGE_CLIENTE = '"use client";\n\nimport { api } from "~/trpc/react";\n\nexport default function Commandes() {\n  const { data } = api.commandes.list.useQuery();\n  return <ul>{data?.map((c) => <li key={c.id}>{c.nom}</li>)}</ul>;\n}\n';
const PAGE_FLECHEE = 'import { db } from "~/server/db";\n\nexport default async () => {\n  const rows = await db.query.reglages.findMany();\n  return <pre>{rows.length}</pre>;\n};\n';
const PAGE_NOMMEE = 'import { db } from "~/server/db";\n\nconst Factures = async () => {\n  const rows = await db.query.factures.findMany();\n  return <pre>{rows.length}</pre>;\n};\n\nexport default Factures;\n';
const PAGE_ISADMIN = 'import { redirect } from "next/navigation";\nimport { isAdmin } from "~/server/auth";\n\nexport default async function Agents() {\n  if (!(await isAdmin())) redirect("/admin/signin?callbackUrl=/admin/agents");\n  return <p>agents</p>;\n}\n';
const PAGE_MAISON = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\nimport { db } from "~/server/db";\n\nexport default async function Journal() {\n  const rows = await db.query.journal.findMany();\n  const session = await auth();\n  if (!session) redirect("/admin/signin");\n  return <pre>{rows.length}</pre>;\n}\n';
const LAYOUT_ESPACE = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\n\nexport default async function EspaceLayout({ children }: { children: React.ReactNode }) {\n  const session = await auth();\n  if (!session?.user) redirect("/signin");\n  return <>{children}</>;\n}\n';
const PAGE_ESPACE = 'import { db } from "~/server/db";\n\nexport default async function Compte() {\n  const factures = await db.query.factures.findMany();\n  return <pre>{factures.length}</pre>;\n}\n';
const PAGE_ESPACE_SURE = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\n\nexport default async function Tableau() {\n  const session = await auth();\n  if (!session?.user) redirect("/signin?callbackUrl=/tableau");\n  return <p>{session.user.name}</p>;\n}\n';
const LAYOUT_ROLE = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\nimport { hasRole } from "~/lib/roles";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  if (!hasRole(await auth(), ["moderateur"])) redirect("/");\n  return <>{children}</>;\n}\n';
const INTL = 'import createMiddleware from "next-intl/middleware";\nimport { routing } from "./i18n/routing";\n\nexport default createMiddleware(routing);\n';
const ROLES = 'import type { Session } from "next-auth";\n\nexport function hasRole(session: Session | null, allowed: readonly string[]): boolean {\n  return Boolean(session?.user && allowed.length);\n}\n';

const regle = (nom, langue, quoi) => R.RULES[nom][langue][quoi];
const claude = (...lignes) => `# Projet\n\n## Conventions\n\n${lignes.join("\n")}\n- Une autre convention, qui reste.\n`;

const base = mkdtempSync(join(tmpdir(), "hv-repair-admin-gate-"));
const ecrire = (dir, rel, contenu) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), contenu);
};
const lire = (dir, rel) => readFileSync(join(dir, rel), "utf8");
/** A project as the older harness left it: the layout alone checks the admin space. */
function projet(nom, { next = "^15.2.3", nextAuth = "5.0.0-beta.25", auth = "admin", pages = {}, layout = ANCIEN_LAYOUT, signin = "src/app/admin/signin/page.tsx", alias = true, fichiers = {}, rules = null } = {}) {
  const dir = join(base, nom);
  ecrire(dir, "package.json", JSON.stringify({ name: nom, private: true, dependencies: { next, "next-auth": nextAuth } }));
  ecrire(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: alias ? { "~/*": ["./src/*"] } : { "@/*": ["./src/*"] } } }, null, 2));
  if (auth === "admin") ecrire(dir, "src/server/auth.ts", render("auth/admin/auth.ts", {}));
  if (auth === "users") ecrire(dir, "src/server/auth.ts", render("auth/users/auth.ts", {}));
  if (signin) ecrire(dir, signin, SIGNIN);
  if (layout) ecrire(dir, "src/app/admin/(protected)/layout.tsx", layout);
  for (const [rel, src] of Object.entries(pages)) ecrire(dir, rel, src);
  for (const [rel, src] of Object.entries(fichiers)) ecrire(dir, rel, src);
  if (rules !== null) ecrire(dir, "CLAUDE.md", rules);
  return dir;
}
const P = (rel) => `src/app/admin/(protected)/${rel}`;
const statut = (d, rel) => d.pages.find((p) => p.file === rel)?.status ?? null;
/** Every file of a folder and its content: what a run that writes nothing must leave as it was. */
function empreinte(dir) {
  const out = {};
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else out[p.slice(dir.length)] = readFileSync(p, "utf8");
    }
  };
  visit(dir);
  return JSON.stringify(out);
}

try {
  console.log("── Le diagnostic d'un projet construit avant la 3.4.17 ──");
  const ancien = projet("ancien", {
    pages: {
      [P("page.tsx")]: ANCIEN_PAGE,
      [P("clients/[id]/page.tsx")]: PAGE_PARAMS,
      [P("clients/[id]/factures/page.tsx")]: ANCIEN_PAGE.replace("AdminHomePage", "Factures"),
      [P("commandes/page.tsx")]: PAGE_CLIENTE,
      [P("reglages/page.tsx")]: PAGE_FLECHEE,
      [P("factures/page.tsx")]: PAGE_NOMMEE,
      [P("agents/page.tsx")]: PAGE_ISADMIN,
      [P("journal/page.tsx")]: PAGE_MAISON,
      [P("controlee/page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}),
      "src/app/(espace)/layout.tsx": LAYOUT_ESPACE,
      "src/app/(espace)/compte/page.tsx": PAGE_ESPACE,
      "src/app/(espace)/tableau/page.tsx": PAGE_ESPACE_SURE,
      "src/app/(espace)/panier/page.tsx": PAGE_CLIENTE,
      "src/app/page.tsx": PAGE_ESPACE,
      "src/app/admin/(protected)/_composants/page.tsx": ANCIEN_PAGE,
    },
    rules: claude(regle("admin", "en", "old"), regle("role", "en", "old")),
  });
  const avant = empreinte(ancien);
  const d = R.diagnose(ancien);
  check("à réparer (needed: true)", d.needed === true, JSON.stringify(d).slice(0, 400));
  check("la page synchrone d'avant (le gabarit de la 3.4.16) : to-fix", statut(d, P("page.tsx")) === "to-fix", JSON.stringify(d.pages));
  check("une page asynchrone avec des paramètres : to-fix", statut(d, P("clients/[id]/page.tsx")) === "to-fix");
  check("une page imbriquée, deux niveaux plus bas : to-fix", statut(d, P("clients/[id]/factures/page.tsx")) === "to-fix");
  check("la page déjà contrôlée (le gabarit de la 3.4.17) : checked, donc absente de la liste", statut(d, P("controlee/page.tsx")) === null);
  check("une page qui commence par if (!(await isAdmin())) redirect(...) (les pages des agents) : checked", statut(d, P("agents/page.tsx")) === null);
  check("une page client (\"use client\") : pas de défaut, absente de la liste", statut(d, P("commandes/page.tsx")) === null);
  check("une fonction fléchée : manual, jamais corrigée par le script", statut(d, P("reglages/page.tsx")) === "manual" && /arrow/.test(d.pages.find((p) => p.file === P("reglages/page.tsx"))?.reason ?? ""));
  check("un export par défaut d'un nom : manual", statut(d, P("factures/page.tsx")) === "manual");
  check("un contrôle maison qui vient après une lecture : manual, avec sa raison", statut(d, P("journal/page.tsx")) === "manual" && /check of its own/.test(d.pages.find((p) => p.file === P("journal/page.tsx"))?.reason ?? ""));
  check("... et le contrôle qui convient est nommé (requireAdmin)", d.pages.filter((p) => p.status === "manual").every((p) => p.fix === "requireAdmin"), JSON.stringify(d.pages));
  check("l'espace membres gardé par son seul layout : sa page sans contrôle est review, avec le contrôle de ce layout (fix: layout, son chemin)", statut(d, "src/app/(espace)/compte/page.tsx") === "review" && d.pages.find((p) => p.file === "src/app/(espace)/compte/page.tsx")?.fix === "layout" && d.pages.find((p) => p.file === "src/app/(espace)/compte/page.tsx")?.layout === "src/app/(espace)/layout.tsx", JSON.stringify(d.pages));
  check("... sa page qui contrôle elle-même la session n'est pas citée, sa page client non plus", statut(d, "src/app/(espace)/tableau/page.tsx") === null && statut(d, "src/app/(espace)/panier/page.tsx") === null);
  check("une page qu'aucun layout ne garde (l'accueil) n'est pas citée", statut(d, "src/app/page.tsx") === null);
  check("un dossier privé (_composants) n'est pas une route : ignoré", !d.pages.some((p) => p.file.includes("_composants")));
  check("les comptes : 3 to-fix, 3 manual, 1 review, 2 checked, 1 client", JSON.stringify(d.counts) === JSON.stringify({ checked: 2, client: 1, toFix: 3, manual: 3, review: 1, redirect: 0 }), JSON.stringify(d.counts));
  const app = d.apps[0];
  check("le mode d'authentification : isAdmin exporté par ~/server/auth, requireAdmin() utilisable", app?.auth?.isAdmin === true && app.requireAdmin === "usable" && JSON.stringify(app.auth.modes) === JSON.stringify(["admin"]), JSON.stringify(app));
  check("le contrôle et la barrière, comme admin-gate.mjs --check les dirait : would-write, src/middleware.ts (Next.js 15)", app?.helper?.status === "would-write" && app.middleware?.status === "would-write" && app.middleware.file === "src/middleware.ts", JSON.stringify(app));
  const cm = d.claudeMd.find((c) => c.file === "CLAUDE.md");
  check("le CLAUDE.md : la règle de l'espace admin d'avant (outdated), celle de /add-role d'avant (outdated), celle de l'espace membres absente", cm?.admin === "outdated" && cm.role === "outdated" && cm.users === "absent", JSON.stringify(d.claudeMd));
  check("le diagnostic n'a rien écrit", empreinte(ancien) === avant);

  console.log("\n── La réparation ──");
  const r = R.repair(ancien);
  check("ok, et les fichiers écrits listés pour être enregistrés par leur nom", r.ok === true && r.written === true, JSON.stringify(r).slice(0, 500));
  const attendus = ["src/server/require-admin.ts", "src/middleware.ts", P("page.tsx"), P("clients/[id]/page.tsx"), P("clients/[id]/factures/page.tsx"), "CLAUDE.md"];
  check("commit : le contrôle, la barrière, les trois pages, le CLAUDE.md, et rien d'autre", JSON.stringify([...r.commit].sort()) === JSON.stringify([...attendus].sort()), JSON.stringify(r.commit));
  check("la page d'avant devient exactement : l'import, async, await requireAdmin(); en première ligne, rien d'autre", lire(ancien, P("page.tsx")) === PAGE_REPAREE, lire(ancien, P("page.tsx")).slice(0, 300));
  const params = lire(ancien, P("clients/[id]/page.tsx"));
  check("la page asynchrone : le contrôle avant la lecture des paramètres, sans async en double", params === PAGE_PARAMS.replace('import { db } from "~/server/db";\n', 'import { db } from "~/server/db";\nimport { requireAdmin } from "~/server/require-admin";\n').replace("}) {\n  const { id }", "}) {\n  await requireAdmin();\n  const { id }"), params.slice(0, 300));
  check("le contrôle posé depuis le gabarit, la barrière aussi", lire(ancien, "src/server/require-admin.ts") === render("auth/admin/require-admin.ts", {}) && lire(ancien, "src/middleware.ts").startsWith("// hypervibe:admin-gate"));
  check("le layout garde son contrôle, inchangé", lire(ancien, P("layout.tsx")) === ANCIEN_LAYOUT);
  check("les pages manual, review, client et checked ne sont jamais modifiées", lire(ancien, P("reglages/page.tsx")) === PAGE_FLECHEE && lire(ancien, P("factures/page.tsx")) === PAGE_NOMMEE && lire(ancien, P("journal/page.tsx")) === PAGE_MAISON && lire(ancien, "src/app/(espace)/compte/page.tsx") === PAGE_ESPACE && lire(ancien, P("commandes/page.tsx")) === PAGE_CLIENTE && lire(ancien, P("agents/page.tsx")) === PAGE_ISADMIN);
  const texte = lire(ancien, "CLAUDE.md");
  check("le CLAUDE.md : l'ancienne règle de l'espace admin remplacée par celle de la 3.4.17, à sa place", texte === claude(regle("admin", "en", "current"), regle("role", "en", "current")), texte);
  check("... une seule fois (aucune seconde ligne)", texte.split("**Admin structure**").length === 2);
  const restent = (r.remaining ?? []).map((x) => `${x.status} ${x.file}`).sort();
  check("la sortie dit ce qui reste à Claude : les manual et la review", JSON.stringify(restent) === JSON.stringify([`manual ${P("factures/page.tsx")}`, `manual ${P("journal/page.tsx")}`, `manual ${P("reglages/page.tsx")}`, "review src/app/(espace)/compte/page.tsx"].sort()), JSON.stringify(restent));
  check("... et que le projet reste à réparer tant qu'elles attendent (needed: true)", r.needed === true);
  const apres = R.diagnose(ancien);
  check("après : les trois pages checked, le CLAUDE.md current, le contrôle et la barrière present", apres.counts.toFix === 0 && apres.counts.checked === 5 && apres.claudeMd[0].admin === "current" && apres.claudeMd[0].role === "current" && apres.apps[0].helper?.status === "present" && apres.apps[0].middleware.status === "present", JSON.stringify(apres.counts));
  check("... needed reste vrai tant que des pages manual ou review attendent Claude", apres.needed === true);
  const empreinteApres = empreinte(ancien);
  const r2 = R.repair(ancien);
  check("une seconde réparation ne change rien : aucun fichier écrit", r2.ok === true && r2.commit.length === 0 && empreinte(ancien) === empreinteApres, JSON.stringify(r2.commit));

  console.log("\n── Un projet déjà réparé ──");
  const repare = projet("repare", { layout: render("auth/admin/pages/protected-layout.tsx", {}), pages: { [P("page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}) }, fichiers: { "src/server/require-admin.ts": render("auth/admin/require-admin.ts", {}), "src/middleware.ts": render("auth/admin/middleware.ts", {}) }, rules: claude(regle("admin", "en", "current")) });
  const dr = R.diagnose(repare);
  check("construit avec les gabarits de la 3.4.17 : needed: false", dr.needed === false && dr.counts.checked === 1, JSON.stringify(dr).slice(0, 300));
  const avantRep = empreinte(repare);
  const rr = R.repair(repare);
  check("... et sa réparation n'écrit rien", rr.ok === true && rr.written === false && empreinte(repare) === avantRep, JSON.stringify(rr));
  // A page Claude corrected by hand, in a form the script does not change: recognised as checked,
  // or the next update would offer the same repair again for ever.
  const main = projet("main", { pages: { [P("page.tsx")]: 'import { requireAdmin } from "~/server/require-admin";\n\nconst Accueil = async () => {\n  await requireAdmin();\n  return <p>admin</p>;\n};\n\nexport default Accueil;\n', [P("x/page.tsx")]: 'export default async () => {\n  await requireAdmin();\n  return <p>x</p>;\n};\n' }, fichiers: { "src/server/require-admin.ts": render("auth/admin/require-admin.ts", {}), "src/middleware.ts": render("auth/admin/middleware.ts", {}) } });
  check("une page corrigée à la main sous une autre forme (un nom, une fonction fléchée) : checked, le projet n'est plus à réparer", R.diagnose(main).needed === false, JSON.stringify(R.diagnose(main).pages));

  console.log("\n── Le middleware que le projet a déjà ──");
  const intl = projet("intl", { pages: { [P("page.tsx")]: ANCIEN_PAGE }, fichiers: { "src/middleware.ts": INTL } });
  const di = R.diagnose(intl);
  check("un middleware déjà là (next-intl) : existing, nommé", di.apps[0].middleware?.status === "existing" && di.apps[0].middleware.file === "src/middleware.ts", JSON.stringify(di.apps[0]));
  const ri = R.repair(intl);
  check("... jamais écrasé : le fichier intact, aucun proxy.ts posé à côté, la page corrigée quand même", lire(intl, "src/middleware.ts") === INTL && !existsSync(join(intl, "src", "proxy.ts")) && ri.apps[0].middleware.status === "existing" && !ri.commit.includes("src/middleware.ts") && ri.commit.includes(P("page.tsx")), JSON.stringify(ri));
  const seize = projet("seize", { next: "^16.4.1", pages: { [P("page.tsx")]: ANCIEN_PAGE } });
  const rs = R.repair(seize);
  check("Next.js 16 : la barrière sous src/proxy.ts, le nom que lit cette version", rs.commit.includes("src/proxy.ts") && existsSync(join(seize, "src", "proxy.ts")) && !existsSync(join(seize, "src", "middleware.ts")), JSON.stringify(rs.commit));

  console.log("\n── Là où requireAdmin() ne convient pas ──");
  const users = projet("users", { auth: "users", signin: "src/app/signin/page.tsx", pages: { [P("page.tsx")]: ANCIEN_PAGE }, layout: ANCIEN_LAYOUT.replace(/isAdmin/g, "hasAdmin") });
  const du = R.diagnose(users);
  check("le mode utilisateurs seul (pas d'isAdmin dans ~/server/auth) : manual, le contrôle de l'admin du projet nommé (fix: admin), jamais une simple session", statut(du, P("page.tsx")) === "manual" && du.pages[0].fix === "admin" && du.apps[0].requireAdmin === "no-isAdmin" && du.apps[0].auth.isAdmin === false, JSON.stringify(du.pages));
  check("... et le diagnostic n'annonce ni contrôle commun ni barrière que --write ne posera pas : skipped, avec la raison des pages", du.apps[0].helper?.status === "skipped" && du.apps[0].helper.reason === "no-isAdmin" && du.apps[0].middleware?.status === "skipped" && du.apps[0].middleware.reason === "no-isAdmin", JSON.stringify(du.apps[0]));
  const ru = R.repair(users);
  check("... et rien n'est écrit pour lui : ni contrôle, ni barrière, ni page", !existsSync(join(users, "src", "server", "require-admin.ts")) && !existsSync(join(users, "src", "middleware.ts")) && lire(users, P("page.tsx")) === ANCIEN_PAGE && ru.commit.length === 0, JSON.stringify(ru.commit));
  const roles = projet("roles", { auth: "users", signin: "src/app/signin/page.tsx", pages: { [P("page.tsx")]: ANCIEN_PAGE }, layout: null, fichiers: { "src/lib/roles.ts": ROLES } });
  check("... avec /add-role (hasRole exporté) : le contrôle de l'admin du projet, jamais un simple rôle (fix: admin)", R.diagnose(roles).pages[0]?.fix === "admin", JSON.stringify(R.diagnose(roles).pages));
  const role = projet("role-layout", { layout: LAYOUT_ROLE, pages: { [P("page.tsx")]: ANCIEN_PAGE }, fichiers: { "src/lib/roles.ts": ROLES } });
  const dro = R.diagnose(role);
  check("un layout de l'espace admin qui laisse entrer un rôle : manual (requireAdmin fermerait la porte à ce rôle), avec le contrôle de ce layout (fix: layout)", statut(dro, P("page.tsx")) === "manual" && dro.pages[0].fix === "layout" && dro.pages[0].layout === P("layout.tsx"), JSON.stringify(dro.pages));
  const sansAlias = projet("sans-alias", { alias: false, pages: { [P("page.tsx")]: ANCIEN_PAGE } });
  check("sans l'alias ~/ : manual (l'import des gabarits ne se résoudrait pas)", statut(R.diagnose(sansAlias), P("page.tsx")) === "manual" && R.diagnose(sansAlias).apps[0].requireAdmin === "no-alias");
  const sansConnexion = projet("sans-connexion", { signin: null, pages: { [P("page.tsx")]: ANCIEN_PAGE } });
  check("sans page /admin/signin : manual (requireAdmin() des gabarits y renvoie)", statut(R.diagnose(sansConnexion), P("page.tsx")) === "manual" && R.diagnose(sansConnexion).apps[0].requireAdmin === "no-signin");
  // A project that already has its own helper (written by /security, say), and no isAdmin nor any
  // admin sign-in page: its requireAdmin() is its own, so the pages take it; the barrier, which sends
  // to /admin/signin, is not written.
  const sienne = projet("aide-sienne", { auth: "users", signin: "src/app/signin/page.tsx", pages: { [P("page.tsx")]: ANCIEN_PAGE }, fichiers: { "src/server/require-admin.ts": "export async function requireAdmin(): Promise<void> {}\n" } });
  const ds = R.diagnose(sienne);
  check("un projet qui a déjà son propre require-admin.ts : ses pages sont to-fix (son contrôle est le sien), même sans isAdmin", statut(ds, P("page.tsx")) === "to-fix" && ds.apps[0].requireAdmin === "usable", JSON.stringify(ds.pages));
  const rsi = R.repair(sienne);
  check("... et sans page /admin/signin, la barrière qui y renverrait n'est pas posée (skipped, no-signin, dit dès le diagnostic), son contrôle jamais remplacé", ds.apps[0].middleware?.status === "skipped" && ds.apps[0].middleware.reason === "no-signin" && rsi.commit.includes(P("page.tsx")) && !existsSync(join(sienne, "src", "middleware.ts")) && rsi.apps[0].middleware?.status === "skipped" && lire(sienne, "src/server/require-admin.ts") === "export async function requireAdmin(): Promise<void> {}\n", JSON.stringify(rsi));
  const roleEspace = projet("espace-role", { layout: null, pages: { "src/app/(moderation)/layout.tsx": LAYOUT_ROLE, "src/app/(moderation)/signalements/page.tsx": PAGE_ESPACE }, fichiers: { "src/lib/roles.ts": ROLES } });
  const dre = R.diagnose(roleEspace);
  check("l'espace d'un rôle gardé par son seul layout : review, avec le contrôle de ce layout (fix: layout) ; un projet qui n'a que cela est à réparer", dre.needed === true && statut(dre, "src/app/(moderation)/signalements/page.tsx") === "review" && dre.pages[0].fix === "layout" && dre.pages[0].layout === "src/app/(moderation)/layout.tsx" && dre.counts.review === 1, JSON.stringify(dre.pages));
  // An admin space whose pages need nothing (here, a client page), only its CLAUDE.md: --write will
  // write neither the helper nor the barrier, and the diagnosis says so.
  const rien = projet("rien-a-poser", { pages: { [P("page.tsx")]: PAGE_CLIENTE }, rules: claude(regle("admin", "en", "old")) });
  const drien = R.diagnose(rien);
  const rrien = R.repair(rien);
  check("aucune page n'appellera le contrôle : contrôle et barrière skipped (nothing-to-fix), et la réparation n'écrit que la règle", drien.apps[0].helper?.status === "skipped" && drien.apps[0].helper.reason === "nothing-to-fix" && drien.apps[0].middleware?.status === "skipped" && JSON.stringify(rrien.commit) === JSON.stringify(["CLAUDE.md"]) && !existsSync(join(rien, "src", "middleware.ts")), JSON.stringify({ a: drien.apps[0], c: rrien.commit }));

  console.log("\n── Un layout ne ferme ses pages que si sa redirection dépend d'une session qui manque ──");
  {
    // next-intl's [locale] layout: notFound() for an unknown language, auth() for the menu.
    const LAYOUT_LOCALE = 'import { notFound } from "next/navigation";\nimport { hasLocale } from "next-intl";\nimport { routing } from "~/i18n/routing";\nimport { auth } from "~/server/auth";\n\nexport default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {\n  const { locale } = await params;\n  if (!hasLocale(routing.locales, locale)) notFound();\n  const session = await auth();\n  return (\n    <html lang={locale}>\n      <body>\n        <header>{session?.user ? session.user.name : null}</header>\n        {children}\n      </body>\n    </html>\n  );\n}\n';
    const loc = projet("locale-publique", { layout: null, signin: "src/app/[locale]/admin/signin/page.tsx", pages: { "src/app/[locale]/layout.tsx": LAYOUT_LOCALE, "src/app/[locale]/page.tsx": PAGE_ESPACE, "src/app/[locale]/tarifs/page.tsx": PAGE_ESPACE } });
    const dloc = R.diagnose(loc);
    check("le layout [locale] de next-intl (notFound pour une langue inconnue, auth() pour le menu) : pas une garde, ses pages publiques ne sont pas citées", dloc.needed === false && dloc.pages.length === 0, JSON.stringify(dloc.pages));
    // A sign-in layout does the opposite of a gate: it sends the person already signed in elsewhere.
    const LAYOUT_CONNEXION = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  const session = await auth();\n  if (session?.user?.id) redirect("/");\n  return <>{children}</>;\n}\n';
    const cx = projet("connexion", { layout: null, pages: { "src/app/(connexion)/layout.tsx": LAYOUT_CONNEXION, "src/app/(connexion)/mot-de-passe/page.tsx": PAGE_ESPACE } });
    check("un layout de connexion qui renvoie ailleurs la personne déjà connectée : pas une garde, sa page n'est pas citée", R.diagnose(cx).pages.length === 0, JSON.stringify(R.diagnose(cx).pages));
    const LAYOUT_PRESENT = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  const session = await auth();\n  if (session !== null) redirect("/compte");\n  return <>{children}</>;\n}\n';
    const pr = projet("presente", { layout: null, pages: { "src/app/(accueil)/layout.tsx": LAYOUT_PRESENT, "src/app/(accueil)/inscription/page.tsx": PAGE_ESPACE } });
    check("... ni session !== null (une session présente) : rien à revoir", R.diagnose(pr).pages.length === 0, JSON.stringify(R.diagnose(pr).pages));
    const LAYOUT_NOTFOUND = 'import { notFound } from "next/navigation";\nimport { isAdmin } from "~/server/auth";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  if (!(await isAdmin())) notFound();\n  return <>{children}</>;\n}\n';
    const nf = projet("notfound", { layout: null, pages: { "src/app/(gestion)/layout.tsx": LAYOUT_NOTFOUND, "src/app/(gestion)/factures/page.tsx": PAGE_ESPACE } });
    const dnf = R.diagnose(nf);
    check("if (!(await isAdmin())) notFound(); : une garde de l'admin, sa page review, avec requireAdmin() puisque les gabarits conviennent", statut(dnf, "src/app/(gestion)/factures/page.tsx") === "review" && dnf.pages[0].fix === "requireAdmin" && /admin check/.test(dnf.pages[0].reason), JSON.stringify(dnf.pages));
    const LAYOUT_NUL = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  const session = await auth();\n  if (session === null) redirect("/signin");\n  return <>{children}</>;\n}\n';
    const nul = projet("nul", { layout: null, pages: { "src/app/(membres)/layout.tsx": LAYOUT_NUL, "src/app/(membres)/profil/page.tsx": PAGE_ESPACE } });
    check("une session comparée à null : une garde, la page review", statut(R.diagnose(nul), "src/app/(membres)/profil/page.tsx") === "review", JSON.stringify(R.diagnose(nul).pages));
    const LAYOUT_ROLE_DIFF = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  const session = await auth();\n  if (session?.user?.role !== "gestion") redirect("/");\n  return <>{children}</>;\n}\n';
    const rd = projet("role-different", { layout: null, pages: { "src/app/(gestion)/layout.tsx": LAYOUT_ROLE_DIFF, "src/app/(gestion)/stock/page.tsx": PAGE_ESPACE } });
    check("un rôle comparé par !== : une garde par le rôle, la page review avec le contrôle de ce layout", statut(R.diagnose(rd), "src/app/(gestion)/stock/page.tsx") === "review" && /by role/.test(R.diagnose(rd).pages[0]?.reason ?? "") && R.diagnose(rd).pages[0]?.fix === "layout", JSON.stringify(R.diagnose(rd).pages));
    // A root layout that reads the session for its menu, next to a sign-out action that redirects:
    // the redirect belongs to the action, not to the layout's own flow.
    const LAYOUT_MENU = 'import { redirect } from "next/navigation";\nimport { auth, signOut } from "~/server/auth";\n\nexport default async function RootLayout({ children }: { children: React.ReactNode }) {\n  const session = await auth();\n  async function sortir() {\n    "use server";\n    if (!session) redirect("/");\n    await signOut();\n  }\n  return (\n    <html lang="fr">\n      <body>\n        {session ? <form action={sortir}><button>Sortir</button></form> : null}\n        {children}\n      </body>\n    </html>\n  );\n}\n';
    const menu = projet("menu", { layout: null, pages: { "src/app/layout.tsx": LAYOUT_MENU, "src/app/page.tsx": PAGE_ESPACE } });
    check("un layout racine qui lit la session pour son menu, à côté d'une action de déconnexion qui redirige : pas une garde, rien à revoir", R.diagnose(menu).needed === false, JSON.stringify(R.diagnose(menu).pages));
    const LAYOUT_RETOUR = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  const session = await auth();\n  if (!session?.user) return redirect("/signin");\n  return <>{children}</>;\n}\n';
    const retour = projet("retour", { layout: null, pages: { "src/app/(membres)/layout.tsx": LAYOUT_RETOUR, "src/app/(membres)/compte/page.tsx": PAGE_ESPACE } });
    check("une garde écrite return redirect(...) est une garde : la page sans contrôle est review", statut(R.diagnose(retour), "src/app/(membres)/compte/page.tsx") === "review", JSON.stringify(R.diagnose(retour).pages));
    // A layout that only adds a menu for signed-in people: it reads the session, tests that it is
    // missing, and still shows the page. No redirect, no gate.
    const LAYOUT_BARRE = 'import { auth } from "~/server/auth";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  const session = await auth();\n  if (!session) return <>{children}</>;\n  return <div className="avec-barre">{children}</div>;\n}\n';
    const barre = projet("barre", { layout: null, pages: { "src/app/(site)/layout.tsx": LAYOUT_BARRE, "src/app/(site)/blog/page.tsx": PAGE_ESPACE } });
    check("un layout qui lit la session et montre la page de toute façon (pas de redirection) : pas une garde", R.diagnose(barre).pages.length === 0, JSON.stringify(R.diagnose(barre).pages));
    const LAYOUT_DESTRUCTURE = 'import { redirect } from "next/navigation";\nimport { currentUser } from "~/server/session";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  const { user } = await currentUser();\n  if (!user) redirect("/signin");\n  return <>{children}</>;\n}\n';
    const dest = projet("destructure", { layout: null, pages: { "src/app/(membres)/layout.tsx": LAYOUT_DESTRUCTURE, "src/app/(membres)/factures/page.tsx": PAGE_ESPACE } });
    check("une session lue par déstructuration (const { user } = await currentUser()) : la garde est vue, la page review", statut(R.diagnose(dest), "src/app/(membres)/factures/page.tsx") === "review", JSON.stringify(R.diagnose(dest).pages));
    // A page whose only session read is in a "use server" action declared in it: the action's check,
    // not the page's. The page is to fix, and the check goes before the action.
    const PAGE_ACTION = 'import { redirect } from "next/navigation";\nimport { auth } from "~/server/auth";\nimport { db } from "~/server/db";\n\nexport default async function Notes() {\n  async function enregistrer(data: FormData) {\n    "use server";\n    const session = await auth();\n    if (!session) redirect("/admin/signin");\n    await db.insert(notes).values({ texte: String(data.get("texte")) });\n  }\n  const rows = await db.query.notes.findMany();\n  return <form action={enregistrer}>{rows.length}</form>;\n}\n';
    const action = projet("action", { pages: { [P("notes/page.tsx")]: PAGE_ACTION } });
    check("le contrôle d'une action déclarée dans la page n'est pas celui de la page : to-fix", statut(R.diagnose(action), P("notes/page.tsx")) === "to-fix", JSON.stringify(R.diagnose(action).pages));
    check("... et le contrôle de la page passe avant l'action, rien d'autre ne bouge", R.fixPage(PAGE_ACTION) === PAGE_ACTION.replace('import { db } from "~/server/db";\n', 'import { db } from "~/server/db";\nimport { requireAdmin } from "~/server/require-admin";\n').replace("Notes() {\n", "Notes() {\n  await requireAdmin();\n"), R.fixPage(PAGE_ACTION));
  }

  console.log("\n── Dans le doute, c'est une garde (la règle des comparaisons) ──");
  {
    // Generic layouts built around the same page, outside admin/(protected): each one is a gate or not
    // by its condition alone.
    const layout = (corps, imports = 'import { auth } from "~/server/auth";\n') => `import { notFound, redirect } from "next/navigation";\n${imports}\nexport default async function L({ children }: { children: React.ReactNode }) {\n${corps}\n  return <>{children}</>;\n}\n`;
    const sous = (nom, corps, imports) => {
      const d = R.diagnose(projet(nom, { layout: null, pages: { "src/app/(back-office)/layout.tsx": layout(corps, imports), "src/app/(back-office)/commandes/page.tsx": PAGE_ESPACE } }));
      return d.pages.find((p) => p.file === "src/app/(back-office)/commandes/page.tsx") ?? null;
    };
    const ID = sous("id-admin", '  const session = await auth();\n  if (session?.user?.id !== "admin") redirect("/admin/signin");');
    check("un identifiant de la session comparé par !== à une valeur fixe (\"admin\") : une garde de l'admin, la page review avec requireAdmin()", ID?.status === "review" && ID.fix === "requireAdmin" && /admin check/.test(ID.reason), JSON.stringify(ID));
    const ENV = sous("email-env", '  const session = await auth();\n  if (session?.user?.email !== process.env.ADMIN_EMAIL) redirect("/");');
    check("l'adresse de la session comparée par !== à une variable d'environnement d'admin : une garde de l'admin, la page review", ENV?.status === "review" && ENV.fix === "requireAdmin", JSON.stringify(ENV));
    const MAISON = sous("appel-maison", '  const session = await auth();\n  if (!estAdmin(session?.user?.email)) redirect("/");', 'import { auth } from "~/server/auth";\nimport { estAdmin } from "~/lib/acces";\n');
    check("un appel maison nié qui reçoit la session (et nomme l'admin) : une garde de l'admin, la page review", MAISON?.status === "review" && MAISON.fix === "requireAdmin", JSON.stringify(MAISON));
    const DROIT = sous("appel-droit", '  const session = await auth();\n  if (!peutGerer(session)) redirect("/");', 'import { auth } from "~/server/auth";\nimport { peutGerer } from "~/lib/acces";\n');
    check("... un appel maison nié qui ne nomme pas l'admin : une garde, la page review avec le contrôle de ce layout (fix: layout)", DROIT?.status === "review" && DROIT.fix === "layout", JSON.stringify(DROIT));
    const AUTRE = sous("forme-inconnue", '  const session = await auth();\n  if (Date.parse(session?.expires ?? "") < Date.now()) redirect("/connexion");');
    check("une forme que la règle ne connaît pas, qui lit la session et redirige : signalée (review, le contrôle de ce layout)", AUTRE?.status === "review" && AUTRE.fix === "layout", JSON.stringify(AUTRE));
    // In the admin space, a gate in doubt that names the admin is not taken for the admin's: nothing
    // is written for its pages without the person.
    const doute = R.diagnose(projet("doute-admin", { layout: layout('  const session = await auth();\n  if (process.env.ESPACE_FERME === "1" && session?.user?.id !== "admin") redirect("/admin/signin");'), pages: { [P("page.tsx")]: ANCIEN_PAGE } }));
    check("... et dans l'espace admin, une garde dans le doute n'est jamais corrigée par le script (manual, le contrôle du layout)", statut(doute, P("page.tsx")) === "manual" && doute.pages[0].fix === "layout", JSON.stringify(doute.pages));
    const PUBLIC = R.diagnose(projet("admins-vers-leur-espace", { layout: null, pages: { "src/app/(site)/layout.tsx": layout('  const session = await auth();\n  if (session?.user?.role === "admin") redirect("/admin");'), "src/app/(site)/tarifs/page.tsx": PAGE_ESPACE } }));
    check("role === \"admin\" qui renvoie les admins vers leur espace depuis un layout public : pas une garde, rien à revoir", PUBLIC.pages.length === 0, JSON.stringify(PUBLIC.pages));
    const ET = sous("connecte-pas-admin", '  const session = await auth();\n  if (session && session.user.role !== "admin") redirect("/");');
    check("une session présente ET un rôle qui n'est pas l'admin (&&) : une garde de l'admin", ET?.status === "review" && ET.fix === "requireAdmin", JSON.stringify(ET));
    const OU = sous("ou-une-part", '  const session = await auth();\n  if ((session && session.user.role !== "admin") || session?.user?.bloque) redirect("/");');
    check("une combinaison par || dont une part est une garde : une garde (de l'admin)", OU?.status === "review" && OU.fix === "requireAdmin", JSON.stringify(OU));
    const DOUBLE = R.diagnose(projet("double-negation", { layout: null, pages: { "src/app/(connexion)/layout.tsx": layout('  const session = await auth();\n  if (!!session) redirect("/");'), "src/app/(connexion)/oubli/page.tsx": PAGE_ESPACE } }));
    check("une double négation (!!session) : une session présente, pas une garde", DOUBLE.pages.length === 0, JSON.stringify(DOUBLE.pages));
    const TIRE = sous("variable-tiree", '  const session = await auth();\n  const user = session?.user;\n  if (!user) redirect("/connexion");');
    check("une variable tirée de la session (const user = session?.user) : suivie, la garde est vue", TIRE?.status === "review", JSON.stringify(TIRE));
    const BOOL = sous("variable-booleenne", '  const session = await auth();\n  const gerant = session?.user?.role === "gerant";\n  if (!gerant) redirect("/");');
    check("... une variable qui tient une comparaison (const gerant = role === \"gerant\") : sa négation est une garde par le rôle", BOOL?.status === "review" && BOOL.fix === "layout" && /by role/.test(BOOL.reason), JSON.stringify(BOOL));
    const REPLI = R.diagnose(projet("langue-repli", { layout: null, pages: { "src/app/[locale]/layout.tsx": layout('  const session = await auth();\n  const langue = session?.user?.langue ?? "fr";\n  if (!hasLocale(routing.locales, langue)) notFound();', 'import { auth } from "~/server/auth";\nimport { hasLocale } from "next-intl";\nimport { routing } from "~/i18n/routing";\n'), "src/app/[locale]/page.tsx": PAGE_ESPACE } }));
    check("... mais une lecture avec un repli (?? \"fr\") n'est pas suivie : la langue d'un layout public n'en fait pas une garde", REPLI.pages.length === 0, JSON.stringify(REPLI.pages));
    const COOKIE = sous("session-cookie", '  const session = (await cookies()).get("session")?.value;\n  if (!session) redirect("/connexion");', 'import { cookies } from "next/headers";\n');
    check("une session lue ailleurs que par auth() (un cookie), sous son nom : la garde est vue", COOKIE?.status === "review", JSON.stringify(COOKIE));
  }

  console.log("\n── Jamais un contrôle plus faible que celui du layout ──");
  {
    // Closed to the admin through a variable, and no /admin/signin: the templates' requireAdmin() does
    // not fit; the page takes its layout's own check, never a mere session.
    const LAYOUT_ADMIN_VAR = 'import { redirect } from "next/navigation";\nimport { isAdmin } from "~/server/auth";\n\nexport default async function L({ children }: { children: React.ReactNode }) {\n  const admin = await isAdmin();\n  if (!admin) redirect("/");\n  return <>{children}</>;\n}\n';
    const fort = projet("fort", { signin: null, layout: LAYOUT_ADMIN_VAR, pages: { [P("page.tsx")]: ANCIEN_PAGE, "src/app/(gestion)/layout.tsx": LAYOUT_ADMIN_VAR, "src/app/(gestion)/clients/page.tsx": PAGE_ESPACE, "src/app/(gestion)/membres/page.tsx": PAGE_ESPACE_SURE, "src/app/(gestion)/rapports/layout.tsx": LAYOUT_ADMIN_VAR.replace('redirect("/")', 'redirect("/rapports-refuses")'), "src/app/(gestion)/rapports/page.tsx": PAGE_ESPACE } });
    const dfo = R.diagnose(fort);
    const page = (f) => dfo.pages.find((p) => p.file === f);
    check("un espace fermé par isAdmin(), sans page /admin/signin : ses pages ne sortent jamais en session, mais avec le contrôle de leur layout (fix: layout)", page(P("page.tsx"))?.fix === "layout" && page(P("page.tsx"))?.layout === P("layout.tsx") && page("src/app/(gestion)/clients/page.tsx")?.fix === "layout" && page("src/app/(gestion)/clients/page.tsx")?.layout === "src/app/(gestion)/layout.tsx" && !dfo.pages.some((p) => p.fix === "session"), JSON.stringify(dfo.pages));
    check("... et une page qui ne contrôle que la session sous ce layout reste à revoir : un membre connecté passerait son contrôle", page("src/app/(gestion)/membres/page.tsx")?.status === "review" && /weaker/.test(page("src/app/(gestion)/membres/page.tsx")?.reason ?? ""), JSON.stringify(dfo.pages));
    check("... sous deux layouts qui ferment à l'admin, c'est le plus proche de la page qui est nommé", page("src/app/(gestion)/rapports/page.tsx")?.layout === "src/app/(gestion)/rapports/layout.tsx", JSON.stringify(dfo.pages));
  }

  console.log("\n── La barrière ne cherche que le cookie de session du projet ──");
  {
    const v4 = projet("next-auth-4", { nextAuth: "^4.24.7", pages: { [P("page.tsx")]: ANCIEN_PAGE } });
    const dv4 = R.diagnose(v4);
    check("next-auth 4 (son cookie de session n'est pas celui que cherche la barrière) : barrière skipped (next-auth-4), la page reçoit quand même requireAdmin()", dv4.apps[0].auth.nextAuth === 4 && dv4.apps[0].middleware?.status === "skipped" && dv4.apps[0].middleware.reason === "next-auth-4" && statut(dv4, P("page.tsx")) === "to-fix", JSON.stringify(dv4.apps[0]));
    const rv4 = R.repair(v4);
    check("... la réparation corrige la page et pose le contrôle, jamais la barrière", rv4.commit.includes(P("page.tsx")) && rv4.commit.includes("src/server/require-admin.ts") && !existsSync(join(v4, "src", "middleware.ts")), JSON.stringify(rv4.commit));
    const installe = projet("next-auth-installe", { pages: { [P("page.tsx")]: ANCIEN_PAGE }, fichiers: { "node_modules/next-auth/package.json": JSON.stringify({ name: "next-auth", version: "4.24.11" }) } });
    check("... la version installée d'abord : 4.24.11 installée sous une plage 5, skipped", R.diagnose(installe).apps[0].middleware?.reason === "next-auth-4", JSON.stringify(R.diagnose(installe).apps[0]));
    const renomme = projet("cookie-renomme", { pages: { [P("page.tsx")]: ANCIEN_PAGE }, fichiers: { "src/server/auth.ts": render("auth/admin/auth.ts", {}).replace('session: { strategy: "jwt" },', 'session: { strategy: "jwt" },\n  cookies: { sessionToken: { name: "admin-session" } },') } });
    const drn = R.diagnose(renomme);
    check("une configuration qui renomme le cookie de session : barrière skipped (custom-cookie), la page reçoit quand même requireAdmin()", drn.apps[0].middleware?.status === "skipped" && drn.apps[0].middleware.reason === "custom-cookie" && statut(drn, P("page.tsx")) === "to-fix", JSON.stringify(drn.apps[0]));
  }

  console.log("\n── Les formes d'une page ──");
  {
    const locale = projet("locale", { signin: "src/app/[locale]/admin/signin/page.tsx", layout: null, pages: { "src/app/[locale]/admin/(protected)/layout.tsx": ANCIEN_LAYOUT, "src/app/[locale]/admin/(protected)/page.tsx": ANCIEN_PAGE } });
    const dl = R.diagnose(locale);
    check("un projet traduit (/add-i18n) : l'espace admin sous [locale] trouvé, to-fix", statut(dl, "src/app/[locale]/admin/(protected)/page.tsx") === "to-fix" && dl.apps[0].requireAdmin === "usable", JSON.stringify(dl.pages));
    const crlf = ANCIEN_PAGE.replace(/\n/g, "\r\n");
    const fc = R.fixPage(crlf);
    check("une page en CRLF garde ses fins de ligne", fc === PAGE_REPAREE.replace(/\n/g, "\r\n"), JSON.stringify(fc?.slice(0, 200)));
    const style = "import { db } from '~/server/db'\n\nexport default async function P() {\n  const x = await db.query.a.findMany()\n  return <p>{x.length}</p>\n}\n";
    check("une page sans points-virgules, en guillemets simples : le même style", R.fixPage(style) === "import { db } from '~/server/db'\nimport { requireAdmin } from '~/server/require-admin'\n\nexport default async function P() {\n  await requireAdmin()\n  const x = await db.query.a.findMany()\n  return <p>{x.length}</p>\n}\n", R.fixPage(style));
    const sansImport = "export default function P() {\n  return <p>x</p>;\n}\n";
    check("une page sans aucun import : l'import en tête", R.fixPage(sansImport) === 'import { requireAdmin } from "~/server/require-admin";\nexport default async function P() {\n  await requireAdmin();\n  return <p>x</p>;\n}\n', R.fixPage(sansImport));
    const typee = 'import type { ReactNode } from "react";\n\nexport default async function P(): Promise<ReactNode> {\n  return <p>x</p>;\n}\n';
    check("un type de retour simple : corrigée", /Promise<ReactNode> \{\n  await requireAdmin\(\);\n  return/.test(R.fixPage(typee) ?? ""));
    const piege = "import { db } from \"~/server/db\";\n\n// export default function Faux() {}\nexport default async function P() {\n  const s = \"} { export default\";\n  return <p>{s} l'apostrophe {'}'}</p>;\n}\n";
    const fp = R.fixPage(piege);
    check("un commentaire, une chaîne et une apostrophe qui contiennent des accolades ne trompent pas la lecture", fp === piege.replace('import { db } from "~/server/db";\n', 'import { db } from "~/server/db";\nimport { requireAdmin } from "~/server/require-admin";\n').replace("async function P() {\n", "async function P() {\n  await requireAdmin();\n"), fp);
    // A component above the default export, whose JSX text carries apostrophes next to braces: the
    // apostrophe of `l'été` is text, not a string, or the braces would no longer balance.
    const aide = "import { db } from \"~/server/db\";\n\nfunction Ligne({ nom }: { nom: string }) {\n  return <li>l'été de {nom} {nom ? 'oui' : \"non\"} c'est {'}'}</li>;\n}\n\nexport default async function P() {\n  const rows = await db.query.a.findMany();\n  return <ul>{rows.map((r) => <Ligne key={r.id} nom={r.nom} />)}</ul>;\n}\n";
    const fa = R.fixPage(aide);
    check("un composant au-dessus de l'export par défaut, avec des apostrophes et des accolades dans son JSX : la page est trouvée et corrigée", fa === aide.replace('import { db } from "~/server/db";\n', 'import { db } from "~/server/db";\nimport { requireAdmin } from "~/server/require-admin";\n').replace("async function P() {\n", "async function P() {\n  await requireAdmin();\n"), fa);
    check("... et la lecture de son corps va jusqu'à sa vraie fin", (() => {
      const info = R.readPage(aide);
      return info.form === "function" && aide.slice(info.bodyEnd) === "}\n";
    })());
    check("une page déjà corrigée ne l'est pas deux fois (fixPage rend null)", R.fixPage(PAGE_REPAREE) === null);
    check("une page client, une fonction fléchée : fixPage ne les touche pas", R.fixPage(PAGE_CLIENTE) === null && R.fixPage(PAGE_FLECHEE) === null);
    const deja = 'import { requireAdmin } from "~/server/require-admin";\n\nexport default async function P() {\n  return <p>x</p>;\n}\n';
    check("l'import déjà là n'est pas ajouté une seconde fois", (R.fixPage(deja) ?? "").split("from \"~/server/require-admin\"").length === 2 && /\{\n  await requireAdmin\(\);\n  return/.test(R.fixPage(deja) ?? ""));
    const autre = projet("autre-require", { pages: { [P("page.tsx")]: 'import { requireAdmin } from "~/lib/guards";\n\nexport default async function P() {\n  return <p>x</p>;\n}\n' } });
    check("un requireAdmin importé d'ailleurs : manual", statut(R.diagnose(autre), P("page.tsx")) === "manual");
  }

  console.log("\n── Le CLAUDE.md, et AGENTS.md ──");
  {
    const fr = projet("fr", { pages: { [P("page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}) }, fichiers: { "src/server/require-admin.ts": "export async function requireAdmin() {}\n", "src/middleware.ts": render("auth/admin/middleware.ts", {}), "AGENTS.md": claude(regle("admin", "fr", "old")) } });
    const df = R.diagnose(fr);
    check("AGENTS.md (le fichier de règles des portages), la règle d'avant en français : outdated, à réparer", df.needed === true && df.claudeMd.find((c) => c.file === "AGENTS.md")?.admin === "outdated", JSON.stringify(df.claudeMd));
    R.repair(fr);
    check("... remplacée par la règle française de la 3.4.17", lire(fr, "AGENTS.md") === claude(regle("admin", "fr", "current")), lire(fr, "AGENTS.md"));
    const deux = projet("deux-regles", { pages: { [P("page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}) }, fichiers: { "src/server/require-admin.ts": "export async function requireAdmin() {}\n", "src/middleware.ts": render("auth/admin/middleware.ts", {}) }, rules: claude(regle("admin", "en", "current"), regle("admin", "en", "old")) });
    R.repair(deux);
    check("l'ancienne règle à côté de la nouvelle : l'ancienne retirée, jamais une seconde nouvelle", lire(deux, "CLAUDE.md") === claude(regle("admin", "en", "current")), lire(deux, "CLAUDE.md"));
    const echappee = regle("admin", "en", "old").replace(/`/g, "\\`").replace("→", "->");
    const ech = projet("echappee", { pages: { [P("page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}) }, fichiers: { "src/server/require-admin.ts": "export async function requireAdmin() {}\n", "src/middleware.ts": render("auth/admin/middleware.ts", {}) }, rules: `# P\r\n\r\n  ${echappee}\r\n` });
    R.repair(ech);
    check("une règle d'avant recopiée avec ses accents graves échappés, une flèche ASCII, en CRLF et en retrait : reconnue, remplacée, le retrait et les CRLF gardés", lire(ech, "CLAUDE.md") === `# P\r\n\r\n  ${regle("admin", "en", "current")}\r\n`, JSON.stringify(lire(ech, "CLAUDE.md").slice(0, 120)));
    const modifiee = projet("modifiee", { pages: { [P("page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}) }, fichiers: { "src/server/require-admin.ts": "export async function requireAdmin() {}\n", "src/middleware.ts": render("auth/admin/middleware.ts", {}) }, rules: claude(`${regle("admin", "en", "old")} Admin pages use the AdminShell component.`) });
    const dm = R.diagnose(modifiee);
    const rm = R.repair(modifiee);
    check("une règle d'avant dont la personne a changé les mots : edited, à réparer, jamais réécrite par le script, laissée à Claude", dm.needed === true && dm.claudeMd[0].admin === "edited" && !rm.commit.includes("CLAUDE.md") && rm.remaining.some((x) => x.file === "CLAUDE.md" && x.rule === "admin"), JSON.stringify({ c: dm.claudeMd, rm }));
    const membres = projet("membres", { layout: null, auth: "users", signin: "src/app/signin/page.tsx", rules: claude(regle("users", "en", "current")) });
    check("la règle de l'espace membres de la 3.4.17 : current (elle n'existait pas avant : jamais outdated)", R.diagnose(membres).claudeMd[0].users === "current" && R.diagnose(membres).needed === false, JSON.stringify(R.diagnose(membres)));
  }

  console.log("\n── Un monorepo ──");
  {
    const mono = join(base, "mono");
    ecrire(mono, "package.json", JSON.stringify({ name: "mono", private: true }));
    const web = join(mono, "apps", "web");
    ecrire(web, "package.json", JSON.stringify({ name: "web", dependencies: { next: "^15.2.3" } }));
    ecrire(web, "tsconfig.json", JSON.stringify({ extends: "../../tsconfig.base.json" }));
    ecrire(mono, "tsconfig.base.json", JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } } }));
    ecrire(web, "src/server/auth.ts", render("auth/admin/auth.ts", {}));
    ecrire(web, "src/app/admin/signin/page.tsx", SIGNIN);
    ecrire(web, "src/app/admin/(protected)/layout.tsx", ANCIEN_LAYOUT);
    ecrire(web, "src/app/admin/(protected)/page.tsx", ANCIEN_PAGE);
    ecrire(web, "CLAUDE.md", claude(regle("admin", "en", "old")));
    const dmo = R.diagnose(mono);
    check("diagnostiqué depuis la racine du dépôt : l'application apps/web trouvée, ses pages nommées depuis la racine", dmo.needed === true && dmo.apps[0]?.dir === "apps/web" && statut(dmo, "apps/web/src/app/admin/(protected)/page.tsx") === "to-fix", JSON.stringify(dmo).slice(0, 400));
    check("... le CLAUDE.md de l'application lu aussi", dmo.claudeMd.some((c) => c.file === "apps/web/CLAUDE.md" && c.admin === "outdated"), JSON.stringify(dmo.claudeMd));
    const rmo = R.repair(mono);
    check("... la réparation écrit dans l'application, et nomme les fichiers depuis la racine", JSON.stringify([...rmo.commit].sort()) === JSON.stringify(["apps/web/CLAUDE.md", "apps/web/src/app/admin/(protected)/page.tsx", "apps/web/src/middleware.ts", "apps/web/src/server/require-admin.ts"]), JSON.stringify(rmo.commit));
    check("... et dit que le projet n'est plus à réparer (needed: false)", rmo.needed === false, JSON.stringify(rmo));
    check("un dossier qui n'est pas un projet Next.js : rien à faire", R.diagnose(join(base, "mono", "apps")).needed === false);
  }

  console.log("\n── Ce que git dit des fichiers à écrire, sans rien lancer de la configuration du dossier ──");
  {
    const sansCrochets = join(base, "sans-crochets");
    mkdirSync(sansCrochets, { recursive: true });
    const g = (cwd, ...args) => execFileSync("git", ["-c", `core.hooksPath=${sansCrochets}`, "-c", "commit.gpgsign=false", "-c", "user.name=Recette", "-c", "user.email=recette@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const depot = projet("depot", { pages: { [P("page.tsx")]: ANCIEN_PAGE, [P("clients/page.tsx")]: ANCIEN_PAGE.replace("AdminHomePage", "Clients") }, rules: claude(regle("admin", "en", "old")) });
    g(depot, "init", "-q");
    g(depot, "add", "-A");
    g(depot, "commit", "-q", "--no-verify", "-m", "Projet");
    writeFileSync(join(depot, P("clients/page.tsx")), `${ANCIEN_PAGE.replace("AdminHomePage", "Clients")}// travail en cours\n`);
    const temoins = join(base, "temoins");
    mkdirSync(temoins, { recursive: true });
    const fw = (p) => p.replace(/\\/g, "/");
    writeFileSync(join(depot, ".gitattributes"), "*.tsx filter=temoin\n*.md filter=temoin\n");
    g(depot, "config", "core.fsmonitor", `echo fsmonitor > "${fw(join(temoins, "fsmonitor"))}"; false`);
    g(depot, "config", "filter.temoin.clean", `sh -c 'echo clean > "${fw(join(temoins, "clean"))}"; cat'`);
    g(depot, "config", "filter.temoin.process", `sh -c 'echo process > "${fw(join(temoins, "process"))}"'`);
    const futur = new Date(Date.now() + 60_000);
    utimesSync(join(depot, P("page.tsx")), futur, futur);
    const dg = R.diagnose(depot, { git: true });
    check("le fichier à corriger qui porte déjà du travail non enregistré est nommé (uncommitted), les autres non", JSON.stringify(dg.uncommitted) === JSON.stringify([P("clients/page.tsx")]), JSON.stringify(dg.uncommitted));
    const rg = R.repair(depot);
    check("la réparation le redit (uncommittedBefore), parmi les fichiers écrits", JSON.stringify(rg.uncommittedBefore) === JSON.stringify([P("clients/page.tsx")]) && rg.commit.includes(P("clients/page.tsx")), JSON.stringify(rg));
    check("... et le travail en cours de la personne est toujours là, le contrôle ajouté", lire(depot, P("clients/page.tsx")).endsWith("// travail en cours\n") && /\{\n  await requireAdmin\(\);/.test(lire(depot, P("clients/page.tsx"))));
    check("un core.fsmonitor de la configuration du dossier n'est jamais lancé (diagnostic et réparation)", !existsSync(join(temoins, "fsmonitor")));
    check("... ni les filtres qu'elle définit", !existsSync(join(temoins, "clean")) && !existsSync(join(temoins, "process")));
    // The temporary folder is in no repository on a machine of ours; if it ever were, null could not be told.
    const dansUnDepot = spawnSync("git", ["-C", base, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).status === 0;
    const horsDepot = R.diagnose(projet("hors-depot", { pages: { [P("page.tsx")]: ANCIEN_PAGE } }), { git: true }).uncommitted;
    check("un dossier hors de tout dépôt : uncommitted null (inconnu), jamais [] (propre)", dansUnDepot || horsDepot === null, JSON.stringify(horsDepot));
    const src = readFileSync(SCRIPT, "utf8");
    check("dans le source : aucun git status nu, la forme neutre de la 3.4.17", /"--no-optional-locks"/.test(src) && /"core\.fsmonitor=false"/.test(src) && /core\.hooksPath=\$\{neutral\}/.test(src) && /"core\.virtualFilesystem="/.test(src) && /"--literal-pathspecs"/.test(src) && /"--ignore-submodules=all"/.test(src));
  }

  console.log("\n── Les projets de la machine (--scan) ──");
  {
    const s = join(base, "scan");
    const profil = join(s, "profil");
    const nextPkg = (dir, nom) => ecrire(dir, "package.json", JSON.stringify({ name: nom, dependencies: { next: "^15.2.3" } }));
    const depotNext = (dir, nom, { ancienne = false } = {}) => {
      nextPkg(dir, nom);
      mkdirSync(join(dir, ".git"), { recursive: true });
      if (ancienne) {
        ecrire(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } } }));
        ecrire(dir, "src/server/auth.ts", render("auth/admin/auth.ts", {}));
        ecrire(dir, "src/app/admin/signin/page.tsx", SIGNIN);
        ecrire(dir, P("layout.tsx"), ANCIEN_LAYOUT);
        ecrire(dir, P("page.tsx"), ANCIEN_PAGE);
      }
    };
    const DEV = join(profil, "DEV");
    depotNext(join(DEV, "alpha"), "alpha", { ancienne: true });
    depotNext(join(DEV, "beta"), "beta");
    nextPkg(join(DEV, "sans-depot"), "sans-depot");
    depotNext(join(DEV, "clients", "gamma"), "gamma", { ancienne: true });
    depotNext(join(DEV, "node_modules", "omega"), "omega", { ancienne: true });
    depotNext(join(profil, "vrac", "perdu"), "perdu", { ancienne: true });
    depotNext(join(DEV, ".cache", "zeta"), "zeta", { ancienne: true });
    depotNext(join(DEV, "a", "b", "trop-profond"), "trop-profond", { ancienne: true });
    mkdirSync(join(DEV, "illisible", "cache"), { recursive: true });
    depotNext(join(DEV, "apres-illisible"), "apres-illisible", { ancienne: true });
    const parapluie = join(s, "parapluie");
    depotNext(join(parapluie, "site"), "site", { ancienne: true });
    depotNext(join(parapluie, "protos", "demo"), "demo");
    // A folder this machine cannot read (a permission refused): played by the reader the scan is given.
    const illisible = (dir, opts) => {
      if (/[\\/]illisible$/.test(dir)) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return readdirSync(dir, opts);
    };
    const res = R.scan({ cwd: parapluie, home: profil, readdir: illisible });
    const noms = (res.projects ?? []).map((p) => p.name).sort();
    check("le dossier parapluie : ses sous-projets trouvés, un et deux niveaux plus bas", noms.includes("site") && noms.includes("demo"), JSON.stringify(noms));
    check("le dossier des projets du profil : les projets, un et deux niveaux plus bas", noms.includes("alpha") && noms.includes("beta") && noms.includes("gamma") && noms.includes("apres-illisible"), JSON.stringify(noms));
    check("jamais node_modules, ni un dossier caché, ni plus bas que deux niveaux, ni un dossier qui n'est pas sa propre racine de dépôt", !noms.includes("omega") && !noms.includes("zeta") && !noms.includes("trop-profond") && !noms.includes("sans-depot"), JSON.stringify(noms));
    check("un dossier illisible est dit, et le reste continue", (res.unreadable ?? []).some((u) => /illisible$/.test(u.path) && u.error === "EACCES") && noms.includes("apres-illisible"), JSON.stringify(res.unreadable));
    check("les projets à réparer en tête, comptés (needed), avec leurs pages", res.needed === 4 && res.projects.slice(0, 4).every((p) => p.needed === true && p.counts?.toFix === 1), JSON.stringify(res.projects.map((p) => [p.name, p.needed])));
    check("le profil lui-même n'est jamais parcouru comme un dossier de projets", !(res.scanned ?? []).some((h) => h.toLowerCase().replace(/\\/g, "/") === profil.toLowerCase().replace(/\\/g, "/")), JSON.stringify(res.scanned));
    const depuisProfil = R.findProjects({ cwd: profil, home: profil, readdir: illisible });
    check("... même quand le dossier courant est le profil : ce qu'il range ailleurs que dans un dossier de projets n'est pas parcouru", !depuisProfil.projects.some((p) => /[\\/]perdu$/.test(p)) && depuisProfil.projects.some((p) => /[\\/]alpha$/.test(p)), JSON.stringify(depuisProfil.projects));
    const dedans = R.findProjects({ cwd: join(DEV, "alpha", "src", "app"), home: join(s, "vide") });
    check("le dossier courant dans un projet : la racine de ce projet trouvée", dedans.projects.some((p) => /[\\/]alpha$/.test(p)), JSON.stringify(dedans.projects));
    check("le scan n'a rien écrit (la page d'alpha intacte)", lire(join(DEV, "alpha"), P("page.tsx")) === ANCIEN_PAGE);
  }

  console.log("\n── 3.4.19 : un projet atteint par un lien, les copies de travail, requireAdmin avec un argument, l'ancien filtre d'adresse ──");
  {
    const s = join(base, "s3419");
    const sansCrochets = join(s, "sans-crochets");
    mkdirSync(sansCrochets, { recursive: true });
    const g = (cwd, ...args) => execFileSync("git", ["-c", `core.hooksPath=${sansCrochets}`, "-c", "commit.gpgsign=false", "-c", "user.name=Recette", "-c", "user.email=recette@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const depotAncien = (dir) => {
      ecrire(dir, "package.json", JSON.stringify({ name: dir.split(/[\\/]/).pop(), private: true, dependencies: { next: "^15.2.3", "next-auth": "5.0.0-beta.25" } }));
      ecrire(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } } }));
      ecrire(dir, "src/server/auth.ts", render("auth/admin/auth.ts", {}));
      ecrire(dir, "src/app/admin/signin/page.tsx", SIGNIN);
      ecrire(dir, P("layout.tsx"), ANCIEN_LAYOUT);
      ecrire(dir, P("page.tsx"), ANCIEN_PAGE);
      ecrire(dir, P("clients/page.tsx"), ANCIEN_PAGE.replace("AdminHomePage", "Clients"));
    };

    // a. Reached through a link: macOS's temporary folder (/var -> /private/var), a folder linked from
    // elsewhere, a junction under Windows (no administrator's right needed).
    const vrai = join(s, "vrai");
    const depot = join(vrai, "depot");
    depotAncien(depot);
    g(depot, "init", "-q");
    g(depot, "add", "-A");
    g(depot, "commit", "-q", "--no-verify", "-m", "Projet");
    writeFileSync(join(depot, P("clients/page.tsx")), `${ANCIEN_PAGE.replace("AdminHomePage", "Clients")}// travail en cours\n`);
    const lien = join(s, "lien");
    let lienFait = true;
    try {
      symlinkSync(vrai, lien, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      lienFait = false;
      console.log(`     (lien impossible ici : ${e.code ?? e.message}, cas non joué)`);
    }
    if (lienFait) {
      const parLien = join(lien, "depot");
      const dl = R.diagnose(parLien, { git: true });
      check("un projet atteint par un lien (jonction sous Windows, lien symbolique ailleurs) : uncommitted nomme le fichier en cours, jamais null", JSON.stringify(dl.uncommitted) === JSON.stringify([P("clients/page.tsx")]), JSON.stringify(dl.uncommitted));
      check("... la même réponse que par le chemin réel", JSON.stringify(R.diagnose(depot, { git: true }).uncommitted) === JSON.stringify(dl.uncommitted));
      const rl = R.repair(parLien);
      check("... et la réparation par le lien le redit (uncommittedBefore)", JSON.stringify(rl.uncommittedBefore) === JSON.stringify([P("clients/page.tsx")]), JSON.stringify(rl.uncommittedBefore));
    }
    // A project in a subfolder of a larger repository: the paths given to git are read from the folder.
    const grand = join(s, "grand");
    depotAncien(join(grand, "site"));
    g(grand, "init", "-q");
    g(grand, "add", "-A");
    g(grand, "commit", "-q", "--no-verify", "-m", "Grand");
    writeFileSync(join(grand, "site", P("page.tsx")), `${ANCIEN_PAGE}// travail\n`);
    const sous = R.diagnose(join(grand, "site"), { git: true });
    check("un projet dans un sous-dossier d'un plus grand dépôt : le fichier en cours nommé, les autres non", JSON.stringify(sous.uncommitted) === JSON.stringify([P("page.tsx")]), JSON.stringify(sous.uncommitted));

    // c. The working copies of one repository: one project, each copy with its branch.
    const repo = join(s, "copies", "boutique");
    depotAncien(repo);
    g(repo, "init", "-q");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "--no-verify", "-m", "Boutique");
    g(repo, "branch", "demo-salon");
    g(repo, "branch", "essai");
    g(repo, "checkout", "-q", "demo-salon");
    const copieMain = join(s, "copies", "boutique-main");
    const copieEssai = join(s, "copies", "boutique-essai");
    g(repo, "worktree", "add", "-q", copieMain, "main");
    g(repo, "worktree", "add", "-q", copieEssai, "essai");
    // A copy the scan does not meet (a hidden folder): found through the repository's own files.
    const cachee = join(s, "copies", ".cache", "boutique-cachee");
    g(repo, "branch", "cachee");
    g(repo, "worktree", "add", "-q", cachee, "cachee");
    const dossierCopies = join(s, "copies");
    const sc = R.scan({ cwd: dossierCopies, home: join(s, "profil-vide") });
    const boutiques = (sc.projects ?? []).filter((p) => /boutique/.test(p.dir));
    check("un dépôt et ses copies de travail (git worktree add) : un seul projet", boutiques.length === 1, JSON.stringify((sc.projects ?? []).map((p) => p.dir)));
    const b = boutiques[0] ?? {};
    // Compared by their real paths: the script gives every copy by its real one (3.4.20), and the
    // folders of this recette may be reached through a link (macOS's /var is /private/var).
    const reel = (p) => {
      try {
        return realpathSync(String(p));
      } catch {
        return String(p);
      }
    };
    const memes = (a, c) => reel(a).toLowerCase().replace(/\\/g, "/") === reel(c).toLowerCase().replace(/\\/g, "/");
    check("... proposé d'abord par la copie de la branche qui se déploie (main), même quand le dossier principal est sur une branche de démo", memes(b.dir, copieMain) && b.branch === "main" && b.productionBranch === "main", JSON.stringify({ dir: b.dir, branch: b.branch, prod: b.productionBranch }));
    const branches = (b.copies ?? []).map((c) => c.branch);
    check("... avec toutes ses copies et leur branche, la copie de production en tête, chacune comptée", (b.copies ?? []).length === 4 && branches[0] === "main" && b.copies[0].production === true && ["demo-salon", "essai", "cachee"].every((x) => branches.includes(x)) && b.copies.every((c) => c.counts?.toFix === 2), JSON.stringify(b.copies));
    check("... la copie qu'un dossier caché tenait, trouvée par les fichiers du dépôt", (b.copies ?? []).some((c) => memes(c.dir, cachee)));
    check("... compté une fois dans needed", sc.needed === boutiques.filter((p) => p.needed).length && b.needed === true, JSON.stringify(sc.needed));
    // 3.4.20: the copy of the production branch repaired, the others not yet (old copies of branches
    // already merged, nothing pending): the project is repaired, its other copies said apart.
    const reparee = R.repair(copieMain);
    const sc1 = R.scan({ cwd: dossierCopies, home: join(s, "profil-vide") });
    const b1 = (sc1.projects ?? []).find((p) => /boutique/.test(p.dir)) ?? {};
    const autres = b1.otherCopies ?? [];
    check("la copie de production réparée, les autres pas encore : le projet n'est plus à réparer (son needed est celui de la copie proposée), la copie réparée dite propre", reparee.ok === true && memes(b1.dir, copieMain) && b1.needed === false && sc1.needed === 0 && b1.copies?.[0]?.needed === false && b1.copies.slice(1).every((c) => c.needed === true), JSON.stringify({ n: b1.needed, c: (b1.copies ?? []).map((c) => [c.branch, c.needed]) }));
    check("... ses autres copies dites à part (otherCopies), chacune avec sa branche et son compte, et le scan compte le projet (otherCopies)", autres.length === 3 && ["demo-salon", "essai", "cachee"].every((x) => autres.some((c) => c.branch === x)) && autres.every((c) => c.counts?.toFix === 2) && sc1.otherCopies === 1 && b1.firstCopy === "production", JSON.stringify({ autres, n: sc1.otherCopies, f: b1.firstCopy }));
    check("... rien en attente et déjà contenues dans la branche de production : merged, containedIn main", autres.length === 3 && autres.every((c) => c.state === "merged" && c.uncommitted === false && c.contained === true && c.containedIn === "main"), JSON.stringify(autres.map((c) => [c.branch, c.state, c.uncommitted, c.contained, c.containedIn])));
    // Work in progress: a file not committed in one copy, a commit that main does not have in another.
    writeFileSync(join(copieEssai, "notes.txt"), "à reprendre\n");
    writeFileSync(join(cachee, "ajout.txt"), "nouveau\n");
    g(cachee, "add", "ajout.txt");
    g(cachee, "commit", "-q", "--no-verify", "-m", "Ajout");
    const avantEtat = [repo, copieEssai, cachee].map(empreinte);
    const sc1b = R.scan({ cwd: dossierCopies, home: join(s, "profil-vide") });
    const autresB = ((sc1b.projects ?? []).find((p) => /boutique/.test(p.dir)) ?? {}).otherCopies ?? [];
    const de = (br) => autresB.find((c) => c.branch === br) ?? {};
    check("une autre copie qui porte un fichier pas encore enregistré : work (uncommitted)", de("essai").state === "work" && de("essai").uncommitted === true, JSON.stringify(de("essai")));
    check("une autre copie qui porte un commit absent de la branche de production : work (contained: false), sans rien d'autre en attente", de("cachee").state === "work" && de("cachee").contained === false && de("cachee").uncommitted === false, JSON.stringify(de("cachee")));
    check("... et celle qui n'a rien de neuf reste merged", de("demo-salon").state === "merged", JSON.stringify(de("demo-salon")));
    check("lire l'état des autres copies n'a rien écrit dans aucune d'elles", JSON.stringify([repo, copieEssai, cachee].map(empreinte)) === JSON.stringify(avantEtat));
    const etatDe = typeof R.copyState === "function" ? R.copyState : () => ({});
    // What the copy holds is on the remote's production branch, not yet on the local one: contained.
    const sommet = g(cachee, "rev-parse", "HEAD").trim();
    g(repo, "update-ref", "refs/remotes/origin/main", sommet);
    const parLeDistant = etatDe(cachee, "main", { common: join(repo, ".git") });
    g(repo, "update-ref", "-d", "refs/remotes/origin/main");
    check("un commit déjà sur la branche de production du dépôt distant (origin/main), pas encore sur la locale : contenu (merged)", parLeDistant.state === "merged" && parLeDistant.contained === true, JSON.stringify(parLeDistant));
    const sansReponse = etatDe(copieEssai, "main", { run: () => ({ status: 128, stdout: "", stderr: "" }) });
    check("git qui ne répond pas : unread, jamais merged", sansReponse.state === "unread" && sansReponse.uncommitted === null && sansReponse.contained === null, JSON.stringify(sansReponse));
    const sansBranche = etatDe(copieEssai, null);
    check("sans branche à laquelle comparer et un fichier en cours : work (le fichier suffit) ; contained null", sansBranche.state === "work" && sansBranche.contained === null && sansBranche.containedIn === null, JSON.stringify(sansBranche));
    // The remote's default branch wins when it is known (refs/remotes/origin/HEAD), without the network.
    g(repo, "update-ref", "refs/remotes/origin/essai", "HEAD");
    g(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/essai");
    const sc2 = R.scan({ cwd: dossierCopies, home: join(s, "profil-vide") });
    const b2 = (sc2.projects ?? []).find((p) => /boutique/.test(p.dir)) ?? {};
    check("la branche par défaut du dépôt distant connue (origin/HEAD) : sa copie en tête", memes(b2.dir, copieEssai) && b2.productionBranch === "essai", JSON.stringify({ dir: b2.dir, prod: b2.productionBranch }));
    check("... sans réseau : la branche est lue dans les fichiers du dépôt (productionFrom: origin)", b2.productionFrom === "origin");
    // A repository without a copy on its production branch: the main folder first.
    const seul = join(s, "seul", "atelier");
    depotAncien(seul);
    g(seul, "init", "-q");
    g(seul, "add", "-A");
    g(seul, "commit", "-q", "--no-verify", "-m", "Atelier");
    g(seul, "checkout", "-q", "-b", "maquette");
    g(seul, "branch", "-D", "main");
    const autreCopie = join(s, "seul", "atelier-v2");
    g(seul, "worktree", "add", "-q", "-b", "v2", autreCopie);
    const g3 = typeof R.groupCopies === "function" ? R.groupCopies([autreCopie, seul]) : [];
    check("sans copie sur main ni master : le dossier principal en tête", g3.length === 1 && memes(g3[0].copies[0].dir, seul) && g3[0].production.branch === null, JSON.stringify(g3.map((x) => x.copies.map((c) => c.branch))));
    check("un projet sans copie de travail garde sa forme (ni copies), avec sa branche", !("copies" in R.scan({ cwd: join(s, "vrai"), home: join(s, "profil-vide") }).projects.find((p) => /depot/.test(p.dir))), "");
    const atelier = (R.scan({ cwd: join(s, "seul"), home: join(s, "profil-vide") }).projects ?? []).find((p) => /atelier/.test(p.dir)) ?? {};
    check("sans branche de production lue : le needed est celui du dossier principal (firstCopy: main), l'autre copie comparée à sa branche", atelier.firstCopy === "main" && atelier.needed === true && atelier.otherCopies?.length === 1 && atelier.otherCopies[0].containedIn === "maquette" && atelier.otherCopies[0].state === "merged", JSON.stringify({ f: atelier.firstCopy, n: atelier.needed, o: atelier.otherCopies }));

    // 3.4.20, Bastien on macOS: a copy found through worktrees/*/gitdir came back as git wrote it (its
    // real path, /private/var/...) and the others as the scan met them (/var/...). Reproduced here by
    // a link (a junction under Windows): the repository and its hidden copy made by their real path,
    // the scan run through the link.
    const reelles = join(s, "copies-reelles");
    const vitrine = join(reelles, "vitrine");
    depotAncien(vitrine);
    g(vitrine, "init", "-q");
    g(vitrine, "add", "-A");
    g(vitrine, "commit", "-q", "--no-verify", "-m", "Vitrine");
    g(vitrine, "branch", "cachee");
    const vitrineCachee = join(reelles, ".cache", "vitrine-cachee");
    g(vitrine, "worktree", "add", "-q", vitrineCachee, "cachee");
    const lienCopies = join(s, "copies-lien");
    let lienCopiesFait = true;
    try {
      symlinkSync(reelles, lienCopies, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      lienCopiesFait = false;
      console.log(`     (lien impossible ici : ${e.code ?? e.message}, cas non joué)`);
    }
    if (lienCopiesFait) {
      const v = (R.scan({ cwd: lienCopies, home: join(s, "profil-vide") }).projects ?? []).find((p) => /vitrine/.test(p.dir)) ?? {};
      const formes = [v.dir, ...(v.copies ?? []).map((c) => c.dir), ...(v.otherCopies ?? []).map((c) => c.dir)];
      check("atteint par un lien : la copie qu'un dossier caché tenait, trouvée par les fichiers du dépôt", (v.copies ?? []).length === 2 && v.copies.some((c) => memes(c.dir, vitrineCachee)), JSON.stringify(v.copies));
      check("... et toutes les copies du groupe, son dir compris, rendues par leur chemin réel : jamais deux formes de chemin dans un même groupe", formes.length >= 3 && formes.every((d) => typeof d === "string" && d === reel(d)), JSON.stringify(formes));
    }

    // The collaborator (--collab): in a project of the organisation, the copy on the work branch
    // collab/<login> first, and the project's needed is that copy's.
    const org = join(s, "org", "portail");
    depotAncien(org);
    ecrire(org, ".github/workflows/deploy.yml", "name: deploy\non: push\n");
    g(org, "init", "-q");
    g(org, "add", "-A");
    g(org, "commit", "-q", "--no-verify", "-m", "Portail");
    g(org, "branch", "collab/alice");
    const travail = join(s, "org", "portail-alice");
    g(org, "worktree", "add", "-q", travail, "collab/alice");
    const portail = (opts) => (R.scan({ cwd: join(s, "org"), home: join(s, "profil-vide"), ...opts }).projects ?? []).find((p) => /portail/.test(p.dir)) ?? {};
    const pc = portail({ collab: true });
    check("--collab, un projet de l'organisation : la copie de la branche de travail collab/<pseudo> d'abord (firstCopy: work-branch), la copie de main dans otherCopies", memes(pc.dir, travail) && pc.branch === "collab/alice" && pc.firstCopy === "work-branch" && pc.otherCopies?.length === 1 && pc.otherCopies[0].branch === "main", JSON.stringify({ d: pc.dir, b: pc.branch, f: pc.firstCopy, o: pc.otherCopies }));
    const cliCollab = spawnSync(process.execPath, [SCRIPT, "--scan", "--cwd", join(s, "org"), "--home", join(s, "profil-vide"), "--collab"], { encoding: "utf8", windowsHide: true });
    const parCli = (() => {
      try {
        return (JSON.parse(String(cliCollab.stdout).trim()).projects ?? []).find((p) => /portail/.test(p.dir)) ?? {};
      } catch {
        return {};
      }
    })();
    check("la commande : --scan ... --collab met la copie de la branche de travail d'abord, sortie 0", cliCollab.status === 0 && memes(parCli.dir, travail) && parCli.firstCopy === "work-branch", `${cliCollab.stdout}${cliCollab.stderr}`.slice(0, 300));
    const ps = portail({});
    check("... sans --collab (le solo) : la copie de production d'abord, comme avant", memes(ps.dir, org) && ps.firstCopy === "production", JSON.stringify({ d: ps.dir, f: ps.firstCopy }));
    R.repair(travail);
    const pr = portail({ collab: true });
    check("--collab : la copie de travail réparée, le projet n'est plus à réparer, main (rien en attente) dite à part", pr.needed === false && pr.otherCopies?.[0]?.state === "merged", JSON.stringify({ n: pr.needed, o: pr.otherCopies }));
    const sansOrg = join(s, "perso", "carnet");
    depotAncien(sansOrg);
    g(sansOrg, "init", "-q");
    g(sansOrg, "add", "-A");
    g(sansOrg, "commit", "-q", "--no-verify", "-m", "Carnet");
    g(sansOrg, "branch", "collab/alice");
    g(sansOrg, "worktree", "add", "-q", join(s, "perso", "carnet-alice"), "collab/alice");
    const carnet = (R.scan({ cwd: join(s, "perso"), home: join(s, "profil-vide"), collab: true }).projects ?? []).find((p) => /carnet/.test(p.dir)) ?? {};
    check("--collab, un dépôt qui n'est pas de l'organisation (sans deploy.yml) : la branche collab/ n'y passe pas devant", memes(carnet.dir, sansOrg) && carnet.firstCopy === "production", JSON.stringify({ d: carnet.dir, f: carnet.firstCopy }));
    g(org, "branch", "collab/bob");
    g(org, "worktree", "add", "-q", join(s, "org", "portail-bob"), "collab/bob");
    const deux = portail({ collab: true });
    check("--collab, deux copies sur une branche collab/ : le script ne choisit pas (la copie de production d'abord), workBranches les nomme pour que la mise à jour demande", deux.firstCopy === "production" && JSON.stringify([...(deux.workBranches ?? [])].sort()) === JSON.stringify(["collab/alice", "collab/bob"]), JSON.stringify({ f: deux.firstCopy, w: deux.workBranches }));
    check("... et otherCopies ne nomme que les copies qui ont encore les pages d'avant (la copie déjà réparée n'y est pas)", JSON.stringify((deux.otherCopies ?? []).map((c) => c.branch)) === JSON.stringify(["collab/bob"]), JSON.stringify((deux.otherCopies ?? []).map((c) => [c.branch, c.state])));

    // d. A page that starts with requireAdmin() given one plain string.
    const avecArg = projet("avec-argument", {
      pages: {
        [P("page.tsx")]: 'import { requireAdmin } from "~/server/require-admin";\n\nexport default async function A() {\n  await requireAdmin("/admin");\n  return <p>a</p>;\n}\n',
        [P("simples/page.tsx")]: "import { requireAdmin } from \"~/server/require-admin\";\n\nexport default async function B() {\n  await requireAdmin('/admin/simples');\n  return <p>b</p>;\n}\n",
        [P("gabarit/page.tsx")]: "import { requireAdmin } from \"~/server/require-admin\";\n\nexport default async function C() {\n  await requireAdmin(`/admin/gabarit`);\n  return <p>c</p>;\n}\n",
        [P("variable/page.tsx")]: 'import { requireAdmin } from "~/server/require-admin";\n\nconst ICI = "/admin/variable";\n\nexport default async function D() {\n  await requireAdmin(ICI);\n  return <p>d</p>;\n}\n',
        [P("interpolee/page.tsx")]: 'import { requireAdmin } from "~/server/require-admin";\n\nexport default async function E({ params }: { params: { id: string } }) {\n  await requireAdmin(`/admin/${params.id}`);\n  return <p>e</p>;\n}\n',
        [P("commentaire/page.tsx")]: 'import { db } from "~/server/db";\n\nexport default async function F() {\n  // await requireAdmin("/admin");\n  const rows = await db.query.t.findMany();\n  return <p>{rows.length}</p>;\n}\n',
        [P("chaine/page.tsx")]: 'import { db } from "~/server/db";\n\nexport default async function G() {\n  "await requireAdmin(\'/admin\')";\n  const rows = await db.query.t.findMany();\n  return <p>{rows.length}</p>;\n}\n',
      },
    });
    const da = R.diagnose(avecArg);
    check("await requireAdmin(\"/admin\") en tête : checked, comme await requireAdmin()", statut(da, P("page.tsx")) === null && statut(da, P("simples/page.tsx")) === null && statut(da, P("gabarit/page.tsx")) === null && da.counts.checked >= 3, JSON.stringify(da.pages));
    check("... mais pas un argument qui n'est pas une chaîne simple (une variable, un gabarit interpolé) : à lire", statut(da, P("variable/page.tsx")) === "manual" && statut(da, P("interpolee/page.tsx")) === "manual", JSON.stringify(da.pages));
    check("... ni un commentaire ou une chaîne qui contient les mots : la page reste à corriger", statut(da, P("commentaire/page.tsx")) === "to-fix" && statut(da, P("chaine/page.tsx")) === "to-fix", JSON.stringify(da.pages));

    // The old filter of the return address: said, read-only, outside `needed`.
    const VIEILLE_CONNEXION = '"use client";\n\nexport function f(params: URLSearchParams) {\n  const rawCallback = params.get("callbackUrl");\n  const callbackUrl = rawCallback && /^\\/(?![/\\\\])/.test(rawCallback) ? rawCallback : "/admin";\n  return callbackUrl;\n}\n';
    const filtre = projet("ancien-filtre", { pages: { [P("page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}) }, fichiers: { "src/app/admin/signin/page.tsx": VIEILLE_CONNEXION } });
    const df = R.diagnose(filtre);
    check("l'ancien filtre de l'adresse de retour : nommé (openRedirect, son fichier, sa ligne), hors de needed", df.needed === false && df.openRedirect?.length === 1 && df.openRedirect[0].file === "src/app/admin/signin/page.tsx" && df.openRedirect[0].line === 5 && df.openRedirect[0].form === "old-filter", JSON.stringify({ needed: df.needed, o: df.openRedirect }));
    const avantFiltre = empreinte(filtre);
    const rf = R.repair(filtre);
    check("... jamais réparé par ce script : rien d'écrit", rf.written === false && empreinte(filtre) === avantFiltre, JSON.stringify(rf));
    const sansFiltre = R.diagnose(projet("gabarit-neuf", { pages: { [P("page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}) }, fichiers: { "src/app/admin/signin/page.tsx": render("auth/admin/pages/signin.tsx", {}) } }));
    check("... et le gabarit de connexion de cette version n'est pas signalé", Array.isArray(sansFiltre.openRedirect) && sansFiltre.openRedirect.length === 0, JSON.stringify(sansFiltre.openRedirect));
    const scf = R.scan({ cwd: join(base, "ancien-filtre"), home: join(s, "profil-vide") });
    check("le scan compte les projets qui gardent l'ancien filtre (openRedirect), même sans rien à réparer", scf.openRedirect === 1 && scf.needed === 0, JSON.stringify({ o: scf.openRedirect, n: scf.needed }));
    const ligneFiltre = (scf.projects ?? []).find((p) => /ancien-filtre/.test(p.dir));
    check("... et la ligne de ce projet nomme ses lignes, pour que la mise à jour le dise", ligneFiltre?.needed === false && ligneFiltre?.openRedirect?.length === 1 && ligneFiltre.openRedirect[0].form === "old-filter", JSON.stringify(ligneFiltre));

    // The repair of the old filter, with --redirects (the text of 3.4.19 passes it).
    const FIX = join(ROOT, "scripts", "tests", "fixtures", "redirect-3418");
    const vieilleConnexion = readFileSync(join(FIX, "admin-signin.tsx.txt"), "utf8");
    const vieilleCloche = readFileSync(join(FIX, "notification-bell.tsx.txt"), "utf8");
    const retouchee = vieilleCloche.replace("if (n.url && /^\\/(?![/\\\\])/.test(n.url)) window", "if (n.url && n.url.length < 200 && /^\\/(?![/\\\\])/.test(n.url)) window");
    const sansAdmin = () => ({ [P("page.tsx")]: render("auth/admin/pages/protected-page.tsx", {}) });
    const filtres = projet("filtres", { pages: sansAdmin(), fichiers: { "src/app/admin/signin/page.tsx": vieilleConnexion, "src/components/notification-bell.tsx": retouchee } });
    const sansDrapeau = R.diagnose(filtres, { git: true });
    check("sans --redirects (le texte de la 3.4.18, qui lance ce script juste après l'installation) : l'ancien filtre dit, hors de needed, rien à écrire", sansDrapeau.needed === false && sansDrapeau.openRedirect.length === 2 && JSON.stringify(sansDrapeau.uncommitted) !== "undefined", JSON.stringify({ n: sansDrapeau.needed, o: sansDrapeau.openRedirect }));
    const avantSans = empreinte(filtres);
    const rSans = R.repair(filtres);
    check("... et --write sans --redirects ne touche à rien de l'ancien filtre", rSans.written === false && empreinte(filtres) === avantSans, JSON.stringify(rSans));
    // The first pass after installing 3.4.19 runs this script from the text of 3.4.18: a project with
    // an admin page to close AND the old filter. Without --redirects, the page is repaired as that
    // text announces, and the sign-in page is left as it is.
    const premierPassage = projet("premier-passage", { pages: { [P("page.tsx")]: ANCIEN_PAGE }, fichiers: { "src/app/admin/signin/page.tsx": vieilleConnexion } });
    const rPremier = R.repair(premierPassage);
    check("le texte de la 3.4.18 (sans --redirects) : la page admin réparée, la page de connexion laissée telle quelle", rPremier.ok === true && rPremier.commit.includes(P("page.tsx")) && !rPremier.commit.includes("src/app/admin/signin/page.tsx") && lire(premierPassage, "src/app/admin/signin/page.tsx") === vieilleConnexion && !rPremier.remaining.some((x) => x.kind === "redirect"), JSON.stringify(rPremier.commit));
    const avec = R.diagnose(filtres, { git: true, withRedirects: true });
    const parFichier = (f) => avec.openRedirect.find((x) => x.file === f);
    check("avec --redirects : la ligne des gabarits est à réparer (fix: auto), comptée dans needed (counts.redirect)", avec.needed === true && avec.counts.redirect === 1 && parFichier("src/app/admin/signin/page.tsx")?.fix === "auto", JSON.stringify(avec.openRedirect));
    check("... une ligne retouchée à la main : manual, jamais comptée à réparer", parFichier("src/components/notification-bell.tsx")?.fix === "manual", JSON.stringify(avec.openRedirect));
    check("... hors d'un dépôt : uncommitted null (inconnu), jamais [] (propre)", avec.uncommitted === null, JSON.stringify(avec.uncommitted));
    const rAvec = R.repair(filtres, { withRedirects: true });
    check("la réparation : la page de connexion devient le gabarit de cette version, à l'octet", rAvec.ok === true && lire(filtres, "src/app/admin/signin/page.tsx") === lireHarnais("templates/auth/admin/pages/signin.tsx"), JSON.stringify(rAvec).slice(0, 300));
    check("... nommée dans commit et dans redirects", rAvec.commit?.includes("src/app/admin/signin/page.tsx") && rAvec.redirects?.some((x) => x.file === "src/app/admin/signin/page.tsx"), JSON.stringify(rAvec.commit));
    check("... la ligne retouchée laissée telle quelle, renvoyée à /security (remaining, kind: redirect)", lire(filtres, "src/components/notification-bell.tsx") === retouchee && rAvec.remaining.some((x) => x.kind === "redirect" && x.file === "src/components/notification-bell.tsx" && /\/security/.test(x.reason)), JSON.stringify(rAvec.remaining));
    const encore = R.diagnose(filtres, { withRedirects: true });
    const rEncore = R.repair(filtres, { withRedirects: true });
    check("... relancée, plus rien à réparer de l'ancien filtre, rien d'écrit", encore.counts.redirect === 0 && encore.needed === false && rEncore.written === false, JSON.stringify({ c: encore.counts, w: rEncore.written }));
    // In a repository: the file already holds work not committed, and git says so; CRLF kept.
    const depotFiltre = projet("depot-filtre", { pages: sansAdmin(), fichiers: { "src/app/admin/signin/page.tsx": vieilleConnexion.replace(/\n/g, "\r\n") } });
    g(depotFiltre, "init", "-q");
    g(depotFiltre, "add", "-A");
    g(depotFiltre, "commit", "-q", "--no-verify", "-m", "Projet");
    writeFileSync(join(depotFiltre, "src/app/admin/signin/page.tsx"), `${vieilleConnexion.replace(/\n/g, "\r\n")}// en cours\r\n`);
    const dDepot = R.diagnose(depotFiltre, { git: true, withRedirects: true });
    check("dans un dépôt : le fichier de l'ancien filtre qui porte du travail non enregistré est nommé (uncommitted)", JSON.stringify(dDepot.uncommitted) === JSON.stringify(["src/app/admin/signin/page.tsx"]), JSON.stringify(dDepot.uncommitted));
    const rDepot = R.repair(depotFiltre, { withRedirects: true });
    const repare = lire(depotFiltre, "src/app/admin/signin/page.tsx");
    check("... la réparation le redit (uncommittedBefore), garde le CRLF et le travail en cours", JSON.stringify(rDepot.uncommittedBefore) === JSON.stringify(["src/app/admin/signin/page.tsx"]) && repare === `${lireHarnais("templates/auth/admin/pages/signin.tsx").replace(/\n/g, "\r\n")}// en cours\r\n`, JSON.stringify(rDepot.uncommittedBefore));
    check("le scan avec --redirects compte dans needed un projet qui n'a que l'ancien filtre à réparer", (() => {
      const p2 = projet("filtres-scan", { pages: sansAdmin(), fichiers: { "src/app/admin/signin/page.tsx": vieilleConnexion } });
      const sc = R.scan({ cwd: p2, home: join(s, "profil-vide"), withRedirects: true });
      const sc0 = R.scan({ cwd: p2, home: join(s, "profil-vide") });
      return sc.needed === 1 && sc.projects[0].counts?.redirect === 1 && sc0.needed === 0;
    })());
    const cliFiltre = projet("cli-filtre", { pages: sansAdmin(), fichiers: { "src/app/admin/signin/page.tsx": vieilleConnexion } });
    const wCli = spawnSync(process.execPath, [SCRIPT, "--project-dir", cliFiltre, "--write", "--redirects"], { encoding: "utf8", windowsHide: true });
    check("la commande : --project-dir <dossier> --write --redirects répare, sortie 0", wCli.status === 0 && lire(cliFiltre, "src/app/admin/signin/page.tsx") === lireHarnais("templates/auth/admin/pages/signin.tsx"), `${wCli.stdout}${wCli.stderr}`.slice(0, 300));
  }

  console.log("\n── La commande ──");
  {
    const cli = projet("cli", { pages: { [P("page.tsx")]: ANCIEN_PAGE } });
    const avantCli = empreinte(cli);
    const lancer = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });
    const json = (r) => {
      try {
        return JSON.parse(String(r.stdout).trim());
      } catch {
        return null;
      }
    };
    const d1 = lancer("--project-dir", cli);
    check("--project-dir : une seule ligne JSON, sortie 0, rien d'écrit", d1.status === 0 && String(d1.stdout).trim().split("\n").length === 1 && json(d1)?.needed === true && empreinte(cli) === avantCli, `${d1.stdout}${d1.stderr}`.slice(0, 300));
    check("... avec uncommitted (null : ce dossier n'est pas un dépôt)", json(d1) !== null && "uncommitted" in json(d1));
    const w = lancer("--project-dir", cli, "--write");
    check("--write : la réparation, sa liste commit, sortie 0", w.status === 0 && json(w)?.ok === true && json(w).commit.includes(P("page.tsx")), `${w.stdout}${w.stderr}`.slice(0, 300));
    const sw = lancer("--scan", "--write");
    check("--scan --write : refusé, sortie 1, le scan n'écrit jamais", sw.status === 1 && json(sw)?.ok === false && json(sw).step === "args", `${sw.stdout}${sw.stderr}`);
    const absent = lancer("--project-dir", join(base, "n-existe-pas"));
    check("un dossier qui n'existe pas : ok false, étape dite, sortie 1", absent.status === 1 && json(absent)?.ok === false && json(absent).step === "read", `${absent.stdout}`);
    if (process.platform === "win32") {
      const bash = `/${cli[0].toLowerCase()}${cli.slice(2).replace(/\\/g, "/")}`;
      check("un chemin écrit comme Git Bash l'écrit (/c/...) est lu sous Windows", json(lancer("--project-dir", bash))?.dir?.toLowerCase() === cli.toLowerCase(), bash);
    }
  }

  console.log("\n── Les règles du script sont celles que les skills écrivent aujourd'hui ──");
  {
    const entreAccents = (texte, cle) => (texte.split("\n").find((l) => l.includes(cle) && /^\s*- `- /.test(l)) ?? "").replace(/^\s*- `/, "").replace(/`\s*$/, "").replace(/\\`/g, "`");
    const admin = lireHarnais("skills/_setup-auth-admin/SKILL.md");
    const langue = admin.includes("**Structure admin**") ? "fr" : "en";
    check(`la règle de l'espace admin (${langue}) : celle de _setup-auth-admin, mot pour mot`, entreAccents(admin, langue === "fr" ? "**Structure admin**" : "**Admin structure**") === regle("admin", langue, "current"));
    const role = lireHarnais("skills/add-role/SKILL.md").split("\n").find((l) => /^- (To gate a tRPC procedure by role|Pour gater une procédure tRPC par rôle)/.test(l)) ?? "";
    check(`la règle de /add-role (${langue}) : celle de la skill, mot pour mot`, role.trim() === regle("role", langue, "current"), role.slice(0, 120));
    const users = entreAccents(lireHarnais("skills/_setup-auth-users/SKILL.md"), langue === "fr" ? "**Pages des utilisateurs connectés**" : "**Pages for signed-in users**");
    check(`la règle de l'espace membres (${langue}) : celle de _setup-auth-users, mot pour mot`, users === regle("users", langue, "current"));
    check("l'ancienne règle de l'espace admin et la nouvelle se distinguent (requireAdmin)", R.readRule(regle("admin", "en", "old"), "admin").status === "outdated" && R.readRule(regle("admin", "fr", "old"), "admin").status === "outdated" && R.readRule(regle("admin", "fr", "current"), "admin").status === "current");
  }

  console.log("\n── La mise à jour propose la réparation ──");
  {
    const skill = ["skills/update-hypervibe/SKILL.md", "skills/update-hypervibe-enterprise/SKILL.md"].map(lireHarnais).join("\n");
    check("elle cherche les projets de la machine (--scan), sans rien écrire", /repair-admin-gate\.mjs" --scan --cwd "\$\(pwd\)"/.test(skill));
    check("... puis répare un projet choisi (--project-dir ... --write)", /repair-admin-gate\.mjs" --project-dir "<[^"]+>" --write/.test(skill));
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
