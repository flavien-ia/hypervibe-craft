#!/usr/bin/env node
// test-csp.mjs - The site's Content-Security-Policy the harness keeps (scripts/csp.mjs, decision
// of 15/11/2026 after the audit of 14/11/2026: the same missing CSP on four projects). Each case of
// the request, on a fixture: a blank config (through setup-security.mjs, as /bootstrap writes it), a
// config wrapped by next-intl, a headers() of the person's own, a CSP already there (nothing touched),
// a path shown in the site's own frame, a form that posts elsewhere; then the additions of the
// building blocks (a preset, Vercel's toolbar, the storage's addresses), the hand-edited lines, and
// what an existing project receives (adopt). Ported to the published line in the corrective 3.4.31 /
// 2.5.10 (no anti-robot check there, the storage is R2 alone, Vercel the only host). The configs written are imported for real and their headers() called,
// and the header a path receives is computed as Next.js does (the last rule that sets it wins).
//
//   node scripts/tests/test-csp.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const csp = await import(pathToFileURL(join(ROOT, "scripts", "csp.mjs")).href);
const SECURITY = join(ROOT, "scripts", "setup-security.mjs");
const WORK = mkdtempSync(join(tmpdir(), "hv-csp-"));

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 500)})`}`);
}
let n = 0;
function project(files) {
  n += 1;
  const dir = join(WORK, `p${n}`);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
const read = (dir, f) => readFileSync(join(dir, f), "utf8");
/** The config's headers(), called for real (its imports of the project dropped). */
async function rulesOf(text) {
  const body = text.replace(/^import .*$/gm, "");
  const url = `data:text/javascript;base64,${Buffer.from(body).toString("base64")}#${Math.random()}`;
  const cfg = (await import(url)).default;
  return cfg.headers ? cfg.headers() : [];
}
/** A rule's source as a regular expression, for the shapes these configs use. */
function matcher(source) {
  if (source === "/(.*)") return /^\/.*$/;
  // The pages' source as Next.js reads it, written out here rather than taken from csp.PAGES, so
  // that a change to the source is seen (mutation of 15/11/2026).
  if (source === "/((?!api/|.*[.]pdf$).*)") return /^\/(?!api\/|.*[.]pdf$).*$/i;
  const m = /^(\/[^:]*?)\/:path\*$/.exec(source);
  if (m) return new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/.*)?$`);
  return new RegExp(`^${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}
/** What a path receives: every rule that matches, in order, the last one to set a key winning. */
function headersFor(rules, path) {
  const out = {};
  for (const r of rules) if (matcher(r.source).test(path)) for (const h of r.headers) out[h.key] = h.value;
  return out;
}

const T3 = `/**
 * Run \`build\` or \`dev\` with \`SKIP_ENV_VALIDATION\` to skip env validation.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {};

export default config;
`;
/** What /bootstrap writes: setup-security.mjs where the harness makes projects. The administrator's
 *  harness makes none and has no such script: its configs get the security headers as that script
 *  writes them (its block and its headers()), then the policy, as the script would add it. */
const SECURES = existsSync(SECURITY);
const SECURITY_BLOCK = `const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
];
`;
function secure(dir) {
  if (SECURES) return execFileSync(process.execPath, [SECURITY], { cwd: dir, encoding: "utf8" });
  const name = ["next.config.js", "next.config.ts", "next.config.mjs"].find((f) => existsSync(join(dir, f)));
  let t = read(dir, name);
  if (!t.includes("const securityHeaders")) {
    const headersKey = '\n  async headers() {\n    return [{ source: "/(.*)", headers: securityHeaders }];\n  },';
    t = t.replace(/(const \w+(?:: NextConfig)? = \{)(\})?/, (_m, open, close) => `${SECURITY_BLOCK}\n${open}${headersKey}${close ? "\n}" : ""}`);
    writeFileSync(join(dir, name), t);
  }
  const r = csp.applyCsp(dir);
  return r.state === "written" ? "Content-Security-Policy written" : r.state;
}
const BASE = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

try {
  // ── 1. A blank config, through setup-security.mjs (what /bootstrap runs) ────────────────────
  console.log("── Une configuration neuve, par la mise en sécurité ──");
  const blank = project({ "next.config.js": T3 });
  const out1 = secure(blank);
  const once = read(blank, "next.config.js");
  check("la mise en sécurité écrit la politique et le dit", /Content-Security-Policy written/.test(out1) && once.includes(csp.START) && once.includes(csp.END), out1);
  const rules1 = await rulesOf(once);
  const home = headersFor(rules1, "/");
  check("une page reçoit la base, appliquée, telle quelle", home["Content-Security-Policy"] === BASE, JSON.stringify(home));
  check("... la politique des scripts en Report-Only, avec 'unsafe-inline' et sans nonce", /^default-src 'self'; script-src 'self' 'unsafe-inline'; /.test(home["Content-Security-Policy-Report-Only"] ?? "") && !/'nonce-|strict-dynamic/.test(once), home["Content-Security-Policy-Report-Only"]);
  check("... et garde les en-têtes de sécurité du harnais", home["X-Frame-Options"] === "DENY" && home["X-Content-Type-Options"] === "nosniff");
  check("les routes d'API et les PDF n'ont pas la politique (la visionneuse de Chrome)", !headersFor(rules1, "/api/trpc/x")["Content-Security-Policy"] && !headersFor(rules1, "/docs/plaquette.pdf")["Content-Security-Policy"] && headersFor(rules1, "/docs")["Content-Security-Policy"] === BASE);
  check("headers() renvoie les en-têtes du harnais puis la politique, en dernier", /return \[\{ source: "\/\(\.\*\)", headers: securityHeaders \}, \.\.\.cspHeaders\];/.test(once), once);
  secure(blank);
  check("relancée, la mise en sécurité ne change plus rien", read(blank, "next.config.js") === once);
  check("en développement, 'unsafe-eval' s'ajoute au seul script-src (rechargement à chaud)", /process\.env\.NODE_ENV === "development" \? " 'unsafe-eval'" : ""/.test(once));
  const status1 = csp.status(blank);
  check("status lit le bloc, branché", status1.state === "block" && status1.wired === true, JSON.stringify(status1));

  // ── 2. A config wrapped by next-intl, in TypeScript ─────────────────────────────────────────
  console.log("\n── Une configuration enveloppée (next-intl) ──");
  const WRAPPED = `import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  async redirects() {
    return [{ source: "/old", destination: "/new", permanent: true }];
  },
};

export default withNextIntl(nextConfig);
`;
  const wrapped = project({ "next.config.ts": WRAPPED });
  secure(wrapped);
  const w = read(wrapped, "next.config.ts");
  check("le bloc est écrit avant l'objet, après les en-têtes du harnais", w.indexOf("const securityHeaders") < w.indexOf(csp.START) && w.indexOf(csp.END) < w.indexOf("const nextConfig: NextConfig = {"), w);
  check("l'enveloppe, les imports et les redirections restent tels quels", w.includes("export default withNextIntl(nextConfig);") && w.includes('import createNextIntlPlugin from "next-intl/plugin";') && w.includes('return [{ source: "/old", destination: "/new", permanent: true }];'));
  check("... et headers() renvoie la politique", /\.\.\.cspHeaders\]/.test(w));
  const crlf = project({ "next.config.ts": WRAPPED.replace(/\n/g, "\r\n") });
  csp.applyCsp(crlf);
  const c = read(crlf, "next.config.ts");
  check("un fichier en CRLF le reste", !/[^\r]\n/.test(c) && c.includes(csp.START));

  // ── 3. A headers() of the person's own ─────────────────────────────────────────────────────
  console.log("\n── Un headers() de la personne ──");
  const OWN_HEADERS = `const config = {
  async headers() {
    // the site's own rules
    return [
      { source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
      { source: "/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000" }] },
    ];
  },
};

export default config;
`;
  const ownHeaders = project({ "next.config.mjs": OWN_HEADERS });
  const r3 = csp.applyCsp(ownHeaders);
  const h3 = read(ownHeaders, "next.config.mjs");
  const rules3 = await rulesOf(h3);
  check("la politique s'ajoute à son tableau, en dernier, ses règles intactes", r3.state === "written" && rules3.length === 3 && rules3[2].source === csp.PAGES && rules3[1].source === "/fonts/:path*", JSON.stringify(rules3.map((r) => r.source)));
  check("... à la ligne, avec l'indentation de ses règles", /\n {6}\.\.\.cspHeaders,\n {4}\];/.test(h3), h3);
  const VAR_HEADERS = `const rules = [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }];
const config = {
  async headers() {
    return rules;
  },
};

export default config;
`;
  const varHeaders = project({ "next.config.mjs": VAR_HEADERS });
  csp.applyCsp(varHeaders);
  const rulesVar = await rulesOf(read(varHeaders, "next.config.mjs"));
  check("un headers() qui renvoie une variable : enveloppé, la variable d'abord", rulesVar.length === 2 && rulesVar[0].source === "/(.*)" && rulesVar[1].source === csp.PAGES, JSON.stringify(rulesVar.map((r) => r.source)));
  const TWO_RETURNS = OWN_HEADERS.replace("    // the site's own rules\n", '    if (process.env.X) return [];\n');
  const two = project({ "next.config.mjs": TWO_RETURNS });
  const r3b = csp.applyCsp(two);
  check("deux return dans headers() : rien d'écrit, et ce qu'il faut faire à la main est dit", r3b.state === "review" && /more than one place/.test(r3b.reason) && read(two, "next.config.mjs") === TWO_RETURNS, JSON.stringify(r3b));

  // ── 4. A CSP already there: nothing touched ────────────────────────────────────────────────
  console.log("\n── Une CSP déjà présente ──");
  const THEIRS = OWN_HEADERS.replace('[{ key: "X-Frame-Options", value: "DENY" }]', '[{ key: "Content-Security-Policy", value: "default-src \'self\'" }]');
  const theirs = project({ "next.config.mjs": THEIRS });
  const r4 = csp.applyCsp(theirs);
  check("dans next.config : « present », le fichier identique à l'octet", r4.state === "present" && r4.where.includes("next.config.mjs") && read(theirs, "next.config.mjs") === THEIRS, JSON.stringify(r4));
  const viaMiddleware = project({ "next.config.js": T3, "src/middleware.ts": 'export function middleware() { const h = new Headers(); h.set("Content-Security-Policy", "default-src \'self\'"); }\n' });
  secure(viaMiddleware);
  const m4 = read(viaMiddleware, "next.config.js");
  check("dans un middleware : la mise en sécurité écrit ses en-têtes, jamais la politique", m4.includes("X-Content-Type-Options") && !m4.includes(csp.START), m4);
  const add4 = csp.addCspPreset(theirs, "google-analytics");
  check("une brique qui s'ajoute : « own », ses domaines dits pour être ajoutés à la main, rien d'écrit", add4.state === "own" && /www\.googletagmanager\.com/.test(add4.reason) && read(theirs, "next.config.mjs") === THEIRS, JSON.stringify(add4));

  // ── 5. A path shown in the site's own frame ────────────────────────────────────────────────
  console.log("\n── Un chemin affiché dans un cadre du site ──");
  const framed = project({ "next.config.js": T3 });
  secure(framed);
  csp.setFramed(framed, "/embed/:path*");
  const rules5 = await rulesOf(read(framed, "next.config.js"));
  const inFrame = headersFor(rules5, "/embed/widget");
  const elsewhere = headersFor(rules5, "/contact");
  check("le chemin reçoit frame-ancestors 'self' et X-Frame-Options SAMEORIGIN (la dernière règle gagne)", /frame-ancestors 'self'/.test(inFrame["Content-Security-Policy"] ?? "") && inFrame["X-Frame-Options"] === "SAMEORIGIN" && /object-src 'none'/.test(inFrame["Content-Security-Policy"]), JSON.stringify(inFrame));
  check("... les autres pages gardent 'none' et DENY", elsewhere["Content-Security-Policy"] === BASE && elsewhere["X-Frame-Options"] === "DENY", JSON.stringify(elsewhere));
  csp.setFramed(framed, "/embed/:path*", { on: false });
  check("--off le retire", !read(framed, "next.config.js").includes("cspBaseFramed"));
  let badPath = null;
  try {
    csp.setFramed(framed, 'embed" + evil');
  } catch (e) {
    badPath = e;
  }
  check("un chemin qui n'en est pas un est refusé", badPath !== null);

  // ── 6. A form that posts to another site ───────────────────────────────────────────────────
  console.log("\n── Un formulaire qui poste ailleurs ──");
  let noReason = null;
  try {
    csp.setFormAction(framed, { on: false });
  } catch (e) {
    noReason = e;
  }
  check("form-action --off exige sa raison", noReason !== null && /--reason/.test(noReason.message));
  csp.setFormAction(framed, { on: false, reason: "the newsletter form posts to the mailing provider" });
  const f6 = read(framed, "next.config.js");
  const base6 = headersFor(await rulesOf(f6), "/")["Content-Security-Policy"];
  check("form-action n'est plus posé, et la raison est écrite à côté", !/form-action/.test(base6) && /frame-ancestors 'none'/.test(base6) && f6.includes("// form-action is not set: the newsletter form posts to the mailing provider"), base6);
  csp.setFormAction(framed, { on: true });
  check("--on le remet", headersFor(await rulesOf(read(framed, "next.config.js")), "/")["Content-Security-Policy"] === BASE);

  // ── 7. The building blocks' additions ──────────────────────────────────────────────────────
  console.log("\n── Ce que les briques ajoutent ──");
  const blocks = project({ "next.config.js": T3 });
  secure(blocks);
  const ga = csp.addCspPreset(blocks, "google-analytics");
  const ro7 = headersFor(await rulesOf(read(blocks, "next.config.js")), "/")["Content-Security-Policy-Report-Only"];
  check("un préréglage : ses domaines dans la politique rapportée, la base intacte", ga.state === "written" && /script-src 'self' 'unsafe-inline' https:\/\/www\.googletagmanager\.com/.test(ro7) && /connect-src 'self' https:\/\/www\.googletagmanager\.com https:\/\/\*\.google-analytics\.com/.test(ro7), ro7);
  check("... et une ligne csp-source qui dit quelle brique l'a demandé", /\/\/ csp-source google-analytics \{"script-src":\["https:\/\/www\.googletagmanager\.com"\]/.test(read(blocks, "next.config.js")));
  check("relancé : « current », rien ne change", csp.addCspPreset(blocks, "google-analytics").state === "current");
  csp.addCspSources(blocks, "host-vercel", { "frame-src": ["https://vercel.live"] });
  const ro7b = headersFor(await rulesOf(read(blocks, "next.config.js")), "/")["Content-Security-Policy-Report-Only"];
  check("une directive absente apparaît, à partir de 'self'", /frame-src 'self' https:\/\/vercel\.live/.test(ro7b), ro7b);
  for (const [label, d, v] of [["'unsafe-eval'", "script-src", "'unsafe-eval'"], ["http://", "script-src", "http://x.example"], ["un chemin", "img-src", "https://x.example/a"], ["une étoile seule", "img-src", "*"], ["frame-ancestors", "frame-ancestors", "https://x.example"]]) {
    let refused = null;
    try {
      csp.addCspSources(blocks, "x", { [d]: [v] });
    } catch (e) {
      refused = e;
    }
    check(`refusé : ${label}`, refused !== null);
  }
  csp.removeCspSource(blocks, "host-vercel");
  check("remove retire la ligne de la brique, et ses domaines", !read(blocks, "next.config.js").includes("vercel.live"));

  // A line edited by hand, then the block rewritten from it.
  const hand = read(blocks, "next.config.js").replace('// csp-source google-analytics {"script-src":["https://www.googletagmanager.com"]', '// csp-source google-analytics {"script-src":["https://www.googletagmanager.com","https://ssl.example.com"]');
  writeFileSync(join(blocks, "next.config.js"), hand);
  csp.applyCsp(blocks);
  const ro7c = headersFor(await rulesOf(read(blocks, "next.config.js")), "/")["Content-Security-Policy-Report-Only"];
  check("une ligne csp-source changée à la main : la politique est réécrite d'après elle", /script-src [^;]*https:\/\/ssl\.example\.com/.test(ro7c), ro7c);
  const broken = read(blocks, "next.config.js").replace('"https://ssl.example.com"]', '"https://ssl.example.com"');
  writeFileSync(join(blocks, "next.config.js"), broken);
  const r7 = csp.applyCsp(blocks);
  check("une ligne illisible : « review », rien d'écrit", r7.state === "review" && read(blocks, "next.config.js") === broken, JSON.stringify(r7));
  writeFileSync(join(blocks, "next.config.js"), hand);
  const enforced = read(blocks, "next.config.js").replace('"enforceScripts":false', '"enforceScripts":true');
  writeFileSync(join(blocks, "next.config.js"), enforced);
  csp.applyCsp(blocks);
  const h7 = headersFor(await rulesOf(read(blocks, "next.config.js")), "/");
  check("enforceScripts posé à la main : une seule politique appliquée, plus de Report-Only", !h7["Content-Security-Policy-Report-Only"] && /^frame-ancestors 'none'.*; default-src 'self'; script-src 'self' 'unsafe-inline'/.test(h7["Content-Security-Policy"] ?? ""), JSON.stringify(h7));
  check("... et aucune commande du fichier ne le pose", !/enforceScripts\s*=\s*true|enforceScripts:\s*true/.test(readFileSync(join(ROOT, "scripts", "csp.mjs"), "utf8")));

  // ── 8. The storage's addresses, read from the project's variables (R2) ─────────────────────
  console.log("\n── Les adresses du stockage ──");
  const hosted = csp.storageOrigins({ R2_ENDPOINT: "https://abc.eu.r2.cloudflarestorage.com", R2_BUCKET_NAME: "site-assets" });
  const pub = csp.storageOrigins({ R2_ENDPOINT: "https://abc.eu.r2.cloudflarestorage.com", R2_BUCKET_NAME: "site-assets", R2_PUBLIC_URL: "https://pub-0123.r2.dev/" });
  check("le point d'accès (adresses en chemin) et le seau dans son nom (le client S3 par défaut)", JSON.stringify(hosted) === '["https://abc.eu.r2.cloudflarestorage.com","https://site-assets.abc.eu.r2.cloudflarestorage.com"]', JSON.stringify(hosted));
  check("... puis l'adresse publique du seau", JSON.stringify(pub) === '["https://abc.eu.r2.cloudflarestorage.com","https://site-assets.abc.eu.r2.cloudflarestorage.com","https://pub-0123.r2.dev"]', JSON.stringify(pub));
  check("sans point d'accès : rien (le stockage n'est pas installé)", csp.storageOrigins({}) === null);
  const site8 = project({ "next.config.js": T3, ".env.local": "R2_ENDPOINT=https://abc.eu.r2.cloudflarestorage.com\n", ".env": "R2_ENDPOINT=https://ignored.example.com\nR2_BUCKET_NAME=site-assets\n" });
  secure(site8);
  const s8 = csp.storageCsp(site8, site8);
  const ro8 = headersFor(await rulesOf(read(site8, "next.config.js")), "/")["Content-Security-Policy-Report-Only"];
  check("storage : images, médias et téléversements vers le seau, .env.local d'abord", s8.state === "written" && ["img-src", "media-src", "connect-src"].every((d) => new RegExp(`${d} [^;]*https://site-assets\\.abc\\.eu\\.r2\\.cloudflarestorage\\.com`).test(ro8)) && !ro8.includes("ignored.example.com"), ro8);
  writeFileSync(join(site8, ".env.local"), "R2_ENDPOINT=https://abc.eu.r2.cloudflarestorage.com\nR2_PUBLIC_URL=https://files.monsite.fr\n");
  csp.storageCsp(site8, site8);
  writeFileSync(join(site8, ".env.local"), "R2_ENDPOINT=https://abc.eu.r2.cloudflarestorage.com\nR2_PUBLIC_URL=https://cdn.monsite.fr\n");
  csp.storageCsp(site8, site8);
  const s8b = read(site8, "next.config.js");
  check("relancé après un changement d'adresse publique : la nouvelle remplace l'ancienne", s8b.includes("https://cdn.monsite.fr") && !s8b.includes("https://files.monsite.fr"));
  const none8 = project({ "next.config.js": T3 });
  const n8 = csp.storageCsp(none8, none8);
  check("un projet sans stockage : « none », rien d'écrit", n8.state === "none" && read(none8, "next.config.js") === T3, JSON.stringify(n8));

  // ── 9. An existing project: adopt ──────────────────────────────────────────────────────────
  console.log("\n── Un projet existant (adopt) ──");
  const old = project({
    "next.config.js": T3,
    "package.json": JSON.stringify({ dependencies: { next: "15.5.0" } }),
    "src/components/GoogleAnalytics.tsx": "export const s = `https://www.googletagmanager.com/gtag/js?id=${id}`;\n",
    "src/components/site/map.tsx": 'const TILE_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";\n',
  });
  const a9 = csp.adopt(old);
  check("le bloc écrit, et les préréglages dont le projet porte le signe, eux seuls", a9.state === "written" && JSON.stringify(a9.presets.map((p) => p.preset).sort()) === '["google-analytics","openfreemap"]', JSON.stringify(a9));
  check("relancé : « current »", csp.adopt(old).state === "current");
  check("un projet sans next.config : « review », rien d'écrit", csp.applyCsp(project({ "package.json": "{}" })).state === "review");
  const onVercel = project({ "next.config.js": T3, "vercel.json": '{ "regions": ["fra1"] }\n' });
  const a9b = csp.adopt(onVercel);
  const ro9 = headersFor(await rulesOf(read(onVercel, "next.config.js")), "/")["Content-Security-Policy-Report-Only"];
  check("un projet Vercel : la barre d'outils des aperçus en plus (ligne host-vercel)", a9b.presets.some((p) => p.preset === csp.HOST_SOURCE) && /script-src [^;]*https:\/\/vercel\.live/.test(ro9) && /frame-src 'self' https:\/\/vercel\.live/.test(ro9), JSON.stringify(a9b) + ro9);

  // ── 10. The command line, Vercel's toolbar, the callers ────────────────────────────────────
  console.log("\n── La ligne de commande, la barre Vercel, les appelants ──");
  const cli = JSON.parse(execFileSync(process.execPath, [join(ROOT, "scripts", "csp.mjs"), "preset", "youtube", "--web-dir", old], { encoding: "utf8" }));
  check("csp.mjs preset youtube : un objet JSON, le lecteur sans cookie dans frame-src", cli.ok === true && cli.state === "written" && /frame-src 'self' https:\/\/www\.youtube-nocookie\.com/.test(read(old, "next.config.js")), JSON.stringify(cli));
  let exit = 0;
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "csp.mjs"), "add", "--web-dir", old, "--source", "x", "--directive", "script-src", "--domain", "'unsafe-eval'"], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    exit = e.status;
  }
  check("une source refusée : code 1", exit === 1);
  const cliNone = JSON.parse(execFileSync(process.execPath, [join(ROOT, "scripts", "csp.mjs"), "storage", "--project-dir", none8], { encoding: "utf8" }));
  check("csp.mjs storage sans stockage : code 0, « none »", cliNone.ok === true && cliNone.state === "none", JSON.stringify(cliNone));
  check("la barre Vercel, écrite comme une brique peut l'écrire", csp.VERCEL_TOOLBAR["script-src"]?.includes("https://vercel.live") && Object.values(csp.VERCEL_TOOLBAR).flat().every((v) => /^(https|wss):\/\//.test(v)));
  const caller = (rel, re) => !existsSync(join(ROOT, ...rel)) || re.test(readFileSync(join(ROOT, ...rel), "utf8"));
  check("setup-security.mjs écrit la politique (applyCsp, à chaque passage)", caller(["scripts", "setup-security.mjs"], /import \{ applyCsp \} from "\.\/csp\.mjs";[\s\S]*\npatchCsp\(\);/));
  check("bootstrap-init.mjs y ajoute la barre Vercel avec vercel.json", caller(["scripts", "bootstrap-init.mjs"], /function vercelConfig\(\) \{[\s\S]*?addCspHost\(PROJECT_DIR\)[\s\S]*?\n\}/));
  check("setup-map.mjs y ajoute les tuiles de la carte", caller(["scripts", "setup-map.mjs"], /addCspPreset\(webDir, "openfreemap"\)/));
  const fileText = readFileSync(join(ROOT, "scripts", "csp.mjs"), "utf8");
  check("aucun tiret long ni demi-cadratin, aucun \\u échappé", !/[\u2013\u2014]/.test(fileText) && !/\\u[0-9a-fA-F]{4}/.test(fileText));
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
