#!/usr/bin/env node
// test-admin-gate-next.mjs - The gate of the admin space, on a real Next.js (3.4.17).
//
// On 26/10/2026, an audit found sites built with this harness whose admin pages left their content
// to anyone: the only check of admin/(protected)/ was its layout, and Next.js renders a layout and
// its page at the same time, so when the layout redirected a visitor without a session (307), the
// page it had already rendered left in the body of that redirect, readable with a plain `curl`. It
// is the behaviour of the renderer itself, so it is tried on the renderer itself: a small project
// built from the harness's own templates (auth.ts, the layout, the page, the helper, the middleware
// the harness would write), a page that reads a recognisable piece of data, built and served on a
// free port of this machine, then asked without a cookie. What must hold, for each version:
//   - an admin sees the page and its data (otherwise "the data is absent" would prove nothing);
//   - without a cookie, the answer is a redirect, and the data is not in it;
//   - with a cookie that is not a session (the middleware lets it through), the data is not in it
//     either: requireAdmin() at the top of the page protects it, not the middleware;
//   - the same for a request of the router's own format (RSC), and for one that claims the client
//     already holds the layout;
//   - the middleware is written under the name this version of Next.js reads.
//
// Heavy: it installs Next.js, React, TypeScript and next-auth from the npm registry (the only
// network it reads; --prefer-offline, pnpm's store usually has them), then builds and serves two
// small projects. run-all.mjs therefore skips it unless HV_RECETTE_NEXT=1, and it is played on
// purpose before every release:
//   HV_RECETTE_NEXT=1 node _outils/atelier/recette.mjs hypervibe test-admin-gate-next.mjs
// HV_RECETTE_NEXT_VERSIONS="15.5.28,16.4.3" picks the versions of Next.js (default: those two).
// Telemetry off, nothing else is reached; everything is removed at the end.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 600)})` : ""}`);
}

if (process.env.HV_RECETTE_NEXT !== "1") {
  console.log("Recette sautée : elle installe Next.js depuis le registre npm et construit deux projets. À jouer avant chaque release :");
  console.log("0/0 verifications (sautée : HV_RECETTE_NEXT=1 pour la jouer)");
  process.exit(0);
}

const { render } = await import(pathToFileURL(join(ROOT, "scripts", "_render.mjs")).href);
// The module that writes the middleware. Absent from a harness that predates it: the project is
// then built without one, as such a harness would leave it.
const GATE = join(ROOT, "scripts", "admin-gate.mjs");
const gate = existsSync(GATE) ? await import(pathToFileURL(GATE).href) : null;
const tpl = (rel) => existsSync(join(ROOT, "templates", rel));

const VERSIONS = String(process.env.HV_RECETTE_NEXT_VERSIONS || "15.5.28,16.4.3").split(",").map((v) => v.trim()).filter(Boolean);
const MARQUEUR = `HV-RECETTE-DONNEE-ADMIN-${randomBytes(6).toString("hex")}`;
const SECRET = randomBytes(32).toString("base64url");
const ENV = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", AUTH_SECRET: SECRET, AUTH_TRUST_HOST: "true" };
delete ENV.NODE_ENV;

/** The page of the template, made to read a piece of data: the read goes right before the page's
 *  `return`, so whatever the template does first stays first, and the data is shown in it. */
function pageQuiLit(source) {
  let page = source.replace(/export default (?:async )?function (\w+)\(/, "export default async function $1(");
  page = `import { lireDonnee } from "~/server/donnee";\n${page}`;
  const avantRetour = page.search(/\n(\s*)return \(/);
  const main = page.match(/<main[^>]*>/);
  if (avantRetour < 0 || !main) return null;
  const retrait = page.slice(avantRetour + 1).match(/^\s*/)[0];
  page = `${page.slice(0, avantRetour)}\n${retrait}const donnee = await lireDonnee();${page.slice(avantRetour)}`;
  return page.replace(/<main[^>]*>/, (m) => `${m}\n      <p data-recette="donnee">{donnee}</p>`);
}

const ecrire = (projet, rel, contenu) => {
  mkdirSync(dirname(join(projet, rel)), { recursive: true });
  writeFileSync(join(projet, rel), contenu);
};

function portLibre() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function arreter(serveur) {
  if (!serveur || serveur.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(serveur.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  else serveur.kill("SIGTERM");
}

async function demander(url, { cookie, entetes = {} } = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...entetes };
  let r = await fetch(url, { redirect: "manual", headers });
  // Next.js 16 first sends a request of the router's format to the same address with its `_rsc`
  // parameter: that one hop is followed, with the same headers, or the probe would prove nothing.
  const lieu = r.headers.get("location") ?? "";
  if (entetes.RSC && r.status === 307 && new URL(lieu, url).pathname === new URL(url).pathname && new URL(lieu, url).searchParams.has("_rsc")) {
    r = await fetch(new URL(lieu, url), { redirect: "manual", headers });
  }
  const corps = await r.text();
  return { statut: r.status, corps, taille: Buffer.byteLength(corps), lieu: r.headers.get("location") ?? "" };
}

const redirection = (s) => s === 307 || s === 308 || s === 302 || s === 303;
const resume = (r) => `statut ${r.statut}, ${r.taille} octets, vers ${r.lieu || "rien"}`;

for (const version of VERSIONS) {
  console.log(`\n── Next.js ${version} ──`);
  const projet = mkdtempSync(join(tmpdir(), "hv-gate-next-"));
  let serveur = null;
  try {
    // ── The project, from the harness's templates ──
    ecrire(projet, "package.json", `${JSON.stringify({
      name: "hv-recette-gate",
      private: true,
      type: "module",
      dependencies: { next: version, react: "^19.0.0", "react-dom": "^19.0.0", "next-auth": "5.0.0-beta.32" },
      devDependencies: { typescript: "^5.8.2", "@types/node": "^20.14.10", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0" },
    }, null, 2)}\n`);
    ecrire(projet, ".npmrc", "strict-dep-builds=false\n");
    ecrire(projet, "tsconfig.json", `${JSON.stringify({
      compilerOptions: {
        target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true,
        esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true,
        jsx: "preserve", incremental: true, plugins: [{ name: "next" }], baseUrl: ".", paths: { "~/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }, null, 2)}\n`);
    ecrire(projet, "next.config.js", "export default {};\n");
    ecrire(projet, "src/app/layout.tsx", 'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="fr">\n      <body>{children}</body>\n    </html>\n  );\n}\n');
    ecrire(projet, "src/app/admin/signin/page.tsx", "export default function Connexion() {\n  return <p>connexion</p>;\n}\n");
    ecrire(projet, "src/components/ui/button.tsx", 'import type { ComponentProps } from "react";\n\nexport function Button({ variant, ...props }: ComponentProps<"button"> & { variant?: string }) {\n  return <button data-variant={variant} {...props} />;\n}\n');
    ecrire(projet, "src/server/donnee.ts", `export async function lireDonnee(): Promise<string> {\n  await new Promise((r) => setTimeout(r, 20));\n  return "${MARQUEUR}";\n}\n`);
    ecrire(projet, "src/server/auth.ts", render("auth/admin/auth.ts", {}));
    ecrire(projet, "src/lib/password.ts", render("auth/admin/password.ts", {}));
    if (tpl("auth/admin/require-admin.ts")) ecrire(projet, "src/server/require-admin.ts", render("auth/admin/require-admin.ts", {}));
    ecrire(projet, "src/app/admin/(protected)/layout.tsx", render("auth/admin/pages/protected-layout.tsx", {}));
    const page = pageQuiLit(render("auth/admin/pages/protected-page.tsx", {}));
    check("la page sonde se construit depuis le gabarit de la page admin", page !== null);
    if (!page) continue;
    ecrire(projet, "src/app/admin/(protected)/page.tsx", page);
    ecrire(projet, "src/app/admin/(protected)/clients/page.tsx", page);

    // ── Installed from the registry, then the middleware as the harness writes it ──
    const t0 = Date.now();
    const install = spawnSync("pnpm install --prefer-offline --config.strict-dep-builds=false --reporter=append-only", {
      cwd: projet, shell: true, encoding: "utf8", env: ENV, timeout: 300_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    check(`installé depuis le registre npm (${Math.round((Date.now() - t0) / 1000)} s)`, install.status === 0, `${install.stdout}${install.stderr}`.slice(-600));
    if (install.status !== 0) continue;
    const installee = JSON.parse(readFileSync(join(projet, "node_modules", "next", "package.json"), "utf8")).version;
    check(`la version installée est bien ${version}`, installee === version, installee);
    const attendu = Number(version.split(".")[0]) >= 16 ? "src/proxy.ts" : "src/middleware.ts";
    const pose = gate ? gate.ensureAdminMiddleware(projet) : null;
    check(`le middleware est posé sous le nom que lit Next.js ${version.split(".")[0]} (${attendu})`, pose?.status === "written" && pose.file === attendu && existsSync(join(projet, attendu)), JSON.stringify(pose));

    const nextBin = join(projet, "node_modules", "next", "dist", "bin", "next");
    const t1 = Date.now();
    const build = spawnSync(process.execPath, [nextBin, "build"], { cwd: projet, encoding: "utf8", env: ENV, timeout: 300_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    check(`le projet se construit (${Math.round((Date.now() - t1) / 1000)} s)`, build.status === 0, `${build.stdout}${build.stderr}`.slice(-1200));
    if (build.status !== 0) continue;

    // ── Served on a free port of this machine ──
    const port = await portLibre();
    const base = `http://127.0.0.1:${port}`;
    serveur = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: projet, env: ENV, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let journal = "";
    serveur.stdout.on("data", (d) => (journal += d));
    serveur.stderr.on("data", (d) => (journal += d));
    let pret = false;
    for (let i = 0; i < 120 && !pret && serveur.exitCode === null; i += 1) {
      try {
        pret = (await fetch(`${base}/admin/signin`, { redirect: "manual" })).status === 200;
      } catch {
        // Not listening yet.
      }
      if (!pret) await new Promise((r) => setTimeout(r, 500));
    }
    check("le site répond", pret, journal.slice(-600));
    if (!pret) continue;

    // An admin's session, signed with the project's own secret, as Auth.js signs it.
    const jwt = realpathSync(join(projet, "node_modules", "next-auth", "jwt.js"));
    const { encode } = await import(pathToFileURL(jwt).href);
    const session = await encode({ token: { id: "admin", name: "Admin", sub: "admin" }, secret: SECRET, salt: "authjs.session-token" });
    const admin = `authjs.session-token=${session}`;
    const leurre = "authjs.session-token=pas-une-session";
    // The router's own format, from a client that claims to hold everything down to the group's
    // layout already: only the page would be rendered.
    const arbre = encodeURIComponent(JSON.stringify(["", { children: ["admin", { children: ["(protected)", { children: ["__DEFAULT__", {}] }] }] }, null, null, true]));

    for (const chemin of ["/admin", "/admin/clients"]) {
      const temoin = await demander(base + chemin, { cookie: admin });
      check(`${chemin}, un admin connecté : la page et sa donnée (témoin)`, temoin.statut === 200 && temoin.corps.includes(MARQUEUR), resume(temoin));
      const sans = await demander(base + chemin);
      check(`${chemin} sans cookie : une redirection vers la connexion, sans la donnée (${resume(sans)})`, redirection(sans.statut) && /\/admin\/signin/.test(sans.lieu) && !sans.corps.includes(MARQUEUR), sans.corps.includes(MARQUEUR) ? "LA REDIRECTION EMPORTE LA PAGE" : resume(sans));
      // The first barrier answers before anything is rendered: a few dozen bytes. A redirect of the
      // page itself weighs kilobytes, even without the data.
      check(`${chemin} sans cookie : c'est le middleware qui répond, la page n'est jamais préparée (moins d'un kilo-octet)`, redirection(sans.statut) && sans.taille < 1024, resume(sans));
      const faux = await demander(base + chemin, { cookie: leurre });
      check(`${chemin} avec un cookie qui n'est pas une session (le middleware laisse passer) : sans la donnée (${resume(faux)})`, !faux.corps.includes(MARQUEUR) && faux.statut !== 200, faux.corps.includes(MARQUEUR) ? "LA PAGE PART AVEC LA RÉPONSE" : resume(faux));
      const rsc = await demander(base + chemin, { cookie: leurre, entetes: { RSC: "1" } });
      check(`${chemin}, requête au format du routeur (RSC) : sans la donnée (${resume(rsc)})`, !rsc.corps.includes(MARQUEUR), "LA PAGE PART AVEC LA RÉPONSE");
      const saut = await demander(base + chemin, { cookie: leurre, entetes: { RSC: "1", "Next-Router-State-Tree": arbre } });
      // Next.js 16 refuses this tree (an error, before any rendering): there is nothing to conclude
      // there, and it is said rather than counted as a pass.
      if (saut.statut >= 500 && !saut.corps.includes(MARQUEUR)) console.log(`INFO ${chemin}, requête qui dit tenir déjà le layout : refusée par cette version (${resume(saut)}), rien à conclure`);
      else check(`${chemin}, requête qui dit tenir déjà le layout : sans la donnée (${resume(saut)})`, !saut.corps.includes(MARQUEUR), "LA PAGE PART SANS LE LAYOUT");
    }
  } catch (e) {
    check("la recette va au bout", false, e?.stack ?? String(e));
  } finally {
    arreter(serveur);
    await new Promise((r) => setTimeout(r, 500));
    rmSync(projet, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
