#!/usr/bin/env node
// test-redirect-filter.mjs - What /security (and, read-only, /update-hypervibe) finds of an address
// from outside still followed without the URL parser (3.4.19): the filter of the templates from
// 3.3.11 to 3.4.18 (`old-filter`), the text of the templates before (`unfiltered`), another test
// written by hand on the raw text (`suspect`). On a project made in a temporary folder, with the
// templates' old lines as they were published and the templates of this version; no network.
// The same file runs in the solo harness and in the collaborator's.
//
//   node scripts/tests/test-redirect-filter.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "redirect-filter.mjs");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `   (${String(detail).slice(0, 700)})` : ""}`);
}

check("scripts/redirect-filter.mjs existe", existsSync(SCRIPT));
if (!existsSync(SCRIPT)) {
  console.log(`\n${checks - failures}/${checks} verifications`);
  process.exit(1);
}
const F = await import(pathToFileURL(SCRIPT).href);
const lireHarnais = (rel) => readFileSync(join(ROOT, rel), "utf8");

// The lines of the templates as they were published (3.3.11 to 3.4.18, then before 3.3.11).
const FILTRE_ADMIN = '    const callbackUrl = rawCallback && /^\\/(?![/\\\\])/.test(rawCallback) ? rawCallback : "/admin";';
const FILTRE_CLOCHE = "    if (n.url && /^\\/(?![/\\\\])/.test(n.url)) window.location.assign(n.url);";
const FILTRE_SW = '  const url = raw && /^\\/(?![/\\\\])/.test(raw) ? raw : "/";';
const BRUT_CONNEXION = '        const callbackUrl = params.get("callbackUrl") ?? "/admin";';
const BRUT_CLOCHE = "    if (n.url) window.location.assign(n.url);";
const BRUT_SW = '  const url = (event.notification.data as { url?: string })?.url ?? "/";';

const base = mkdtempSync(join(tmpdir(), "hv-redirect-filter-"));
const ecrire = (dir, rel, contenu) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), contenu);
};
const page = (...lignes) => `"use client";\n\nexport function f() {\n${lignes.join("\n")}\n}\n`;

try {
  const p = join(base, "projet");
  ecrire(p, "package.json", JSON.stringify({ name: "projet", dependencies: { next: "^15.5.28" } }));
  ecrire(p, "src/app/admin/signin/page.tsx", page("    const rawCallback = params.get(\"callbackUrl\");", FILTRE_ADMIN, "    router.push(callbackUrl);"));
  ecrire(p, "src/components/notification-bell.tsx", page(FILTRE_CLOCHE));
  ecrire(p, "src/app/sw.ts", page(FILTRE_SW));
  ecrire(p, "apps/web/src/app/(auth)/signin/page.tsx", page(BRUT_CONNEXION, "        router.push(callbackUrl);"));
  ecrire(p, "src/components/vieille-cloche.tsx", page(BRUT_CLOCHE));
  ecrire(p, "src/app/vieux-sw.ts", page(BRUT_SW));
  ecrire(p, "src/lib/retour.ts", page("  if (next.startsWith(\"/\")) router.push(next);", "  const ok = /^\\/[^/]/.test(next);", "  if (to[0] === '/') location.assign(to);"));
  // What must stay silent: a comment, the templates of this version, an unrelated startsWith, the
  // folders that are not the project's code.
  ecrire(p, "src/lib/note.ts", `// L'ancien filtre était ${FILTRE_ADMIN.trim()}\n/*\n * ${FILTRE_CLOCHE.trim()}\n */\nexport const x = 1;\n`);
  ecrire(p, "src/lib/routes.ts", 'export const admin = (p: string) => p.startsWith("/admin");\nexport const deux = (p: string) => p.startsWith("//");\n');
  for (const [rel, gabarit] of [
    ["src/app/admin/signin/neuf.tsx", "templates/auth/admin/pages/signin.tsx"],
    ["src/app/2fa/neuf.tsx", "templates/2fa/signin-page.tsx"],
    ["src/app/signin/neuf.tsx", "templates/auth-signin/plain.tsx"],
    ["src/app/[locale]/signin/neuf.tsx", "templates/auth-signin/i18n.tsx"],
    ["src/components/cloche-neuve.tsx", "templates/notif-center/notification-bell.tsx"],
    ["src/app/sw-neuf.ts", "templates/push/sw-push-handlers.ts"],
  ]) ecrire(p, rel, lireHarnais(gabarit));
  ecrire(p, "node_modules/paquet/index.js", FILTRE_ADMIN);
  ecrire(p, ".next/server/page.js", FILTRE_ADMIN);
  ecrire(p, "public/sw.js", FILTRE_SW);
  ecrire(p, "src/notes.md", FILTRE_ADMIN);

  const d = F.diagnoseRedirects(p);
  const de = (file, form) => d.found.filter((x) => x.file === file && x.form === form);
  check("l'ancien filtre des gabarits (3.3.11 à 3.4.18) : trouvé dans la connexion, sa ligne nommée (old-filter)", de("src/app/admin/signin/page.tsx", "old-filter").length === 1 && de("src/app/admin/signin/page.tsx", "old-filter")[0].line === 5, JSON.stringify(d.found));
  check("... dans la cloche et dans le service worker aussi", de("src/components/notification-bell.tsx", "old-filter").length === 1 && de("src/app/sw.ts", "old-filter").length === 1, JSON.stringify(d.found));
  check("les gabarits d'avant la 3.3.11 (l'adresse suivie telle qu'elle venait) : unfiltered, dans une application de monorepo comprise", de("apps/web/src/app/(auth)/signin/page.tsx", "unfiltered").length === 1 && de("src/components/vieille-cloche.tsx", "unfiltered").length === 1 && de("src/app/vieux-sw.ts", "unfiltered").length === 1, JSON.stringify(d.found));
  check("les autres tests écrits à la main sur le texte brut (startsWith(\"/\"), un motif, le premier caractère) : suspect, à lire", de("src/lib/retour.ts", "suspect").length === 3, JSON.stringify(d.found.filter((x) => x.file === "src/lib/retour.ts")));
  check("rien dans un commentaire", !d.found.some((x) => x.file === "src/lib/note.ts"), JSON.stringify(d.found));
  check("rien pour startsWith(\"/admin\") ni startsWith(\"//\")", !d.found.some((x) => x.file === "src/lib/routes.ts"));
  check("les gabarits de cette version ne sont pas signalés (internalPath, le lecteur d'adresses)", !d.found.some((x) => /neuf|cloche-neuve/.test(x.file)), JSON.stringify(d.found.filter((x) => /neuf|cloche-neuve/.test(x.file))));
  check("jamais node_modules, .next, public/ ni un fichier qui n'est pas du code", !d.found.some((x) => /^(node_modules|\.next|public)\//.test(x.file) || x.file.endsWith(".md")), JSON.stringify(d.found.map((x) => x.file)));
  check("les comptes par forme", d.counts["old-filter"] === 3 && d.counts.unfiltered === 3 && d.counts.suspect === 3, JSON.stringify(d.counts));

  // A folder that cannot be read is said, and the rest goes on.
  const illisible = (dir, opts) => {
    if (/[\\/]lib$/.test(dir)) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    return readdirSync(dir, opts);
  };
  const d2 = F.diagnoseRedirects(p, { readdir: illisible });
  check("un dossier illisible est dit, et le reste continue", d2.unreadable.some((u) => u.path === "src/lib" && u.error === "EACCES") && d2.counts["old-filter"] === 3, JSON.stringify(d2.unreadable));

  // The command.
  const avant = readFileSync(join(p, "src/app/admin/signin/page.tsx"), "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "--project-dir", p], { encoding: "utf8", windowsHide: true });
  let j = null;
  try {
    j = JSON.parse(String(r.stdout).trim());
  } catch {
    j = null;
  }
  check("--project-dir : une seule ligne JSON, sortie 0, les mêmes trouvailles", r.status === 0 && String(r.stdout).trim().split("\n").length === 1 && j?.ok === true && j.counts?.["old-filter"] === 3, `${r.stdout}${r.stderr}`.slice(0, 300));
  check("... rien d'écrit", readFileSync(join(p, "src/app/admin/signin/page.tsx"), "utf8") === avant);
  const absent = spawnSync(process.execPath, [SCRIPT, "--project-dir", join(base, "n-existe-pas")], { encoding: "utf8", windowsHide: true });
  check("un dossier qui n'existe pas : ok false, sortie 1", absent.status === 1 && /"ok":false/.test(absent.stdout), absent.stdout);

  // ── The repair (repairRedirects), called by /update-hypervibe through repair-admin-gate.mjs ──
  // The six templates as 3.4.18 published them (scripts/tests/fixtures/redirect-3418/), repaired:
  // each must become, to the byte, the template of this version.
  const FIX = join(ROOT, "scripts", "tests", "fixtures", "redirect-3418");
  const PAIRES_GABARITS = [
    ["admin-signin.tsx.txt", "templates/auth/admin/pages/signin.tsx"],
    ["2fa-signin-page.tsx.txt", "templates/2fa/signin-page.tsx"],
    ["auth-signin-plain.tsx.txt", "templates/auth-signin/plain.tsx"],
    ["auth-signin-i18n.tsx.txt", "templates/auth-signin/i18n.tsx"],
    ["notification-bell.tsx.txt", "templates/notif-center/notification-bell.tsx"],
    ["sw-push-handlers.ts.txt", "templates/push/sw-push-handlers.ts"],
  ];
  check("la réparation existe (repairRedirects)", typeof F.repairRedirects === "function");
  if (typeof F.repairRedirects === "function") {
    for (const [vieux, neuf] of PAIRES_GABARITS) {
      const avant = readFileSync(join(FIX, vieux), "utf8");
      const r = F.repairRedirects(avant);
      check(`${neuf} de la 3.4.18, réparé : identique à l'octet au gabarit de cette version`, r.text === lireHarnais(neuf) && r.fixed.length === 1 && r.manual.length === 0, r.text === null ? JSON.stringify(r) : "différent");
      check(`... puis relancé sur le fichier réparé : rien ne change`, r.text !== null && F.repairRedirects(r.text).text === null && F.repairRedirects(r.text).fixed.length === 0);
      const crlf = avant.replace(/\n/g, "\r\n");
      const rc = F.repairRedirects(crlf);
      check(`... en fins de ligne CRLF : le même gabarit, en CRLF, sans une seule fin de ligne LF`, rc.text === lireHarnais(neuf).replace(/\n/g, "\r\n") && !/[^\r]\n/.test(rc.text), rc.text === null ? JSON.stringify(rc) : "différent");
    }
    // Another default page, another indentation: still the templates' lines.
    const ailleurs = readFileSync(join(FIX, "admin-signin.tsx.txt"), "utf8").replace('rawCallback : "/admin";', 'rawCallback : "/espace/accueil";');
    const ra = F.repairRedirects(ailleurs);
    check("une autre page par défaut (/espace/accueil) : réparée, la page par défaut gardée", ra.text !== null && ra.text.includes('const callbackUrl = internalPath(params.get("callbackUrl")) ?? "/espace/accueil";') && !ra.text.includes("(?![/"));
    const sansCommentaire = readFileSync(join(FIX, "admin-signin.tsx.txt"), "utf8").replace("    // Only accept a same-origin relative path. The router runs a `javascript:`\n    // address, and an `https://` or `//` one sends the admin to another site:\n    // ?callbackUrl= must never be taken as it comes.\n", "");
    const rs = F.repairRedirects(sansCommentaire);
    check("le commentaire d'origine retiré à la main : seules les deux lignes changent, aucun commentaire ajouté", rs.text !== null && !rs.text.includes("(internalPath, above)") && rs.text.includes('    const callbackUrl = internalPath(params.get("callbackUrl")) ?? "/admin";'));
    // What is never rewritten: a line changed by hand (the fix proposed on 28/10/2026, an extra test),
    // a file that already names internalPath, the form before 3.3.11.
    const retouchee = readFileSync(join(FIX, "admin-signin.tsx.txt"), "utf8").replace('rawCallback && /^\\/(?![/\\\\])/.test(rawCallback) ? rawCallback', 'rawCallback && /^\\/(?![/\\\\])/.test(rawCallback) && !rawCallback.includes("\\t") ? rawCallback');
    const rr = F.repairRedirects(retouchee);
    check("une ligne de l'ancien filtre retouchée à la main : jamais réécrite, nommée (manual)", rr.text === null && rr.fixed.length === 0 && rr.manual.length === 1, JSON.stringify(rr));
    const dejaNomme = `${readFileSync(join(FIX, "admin-signin.tsx.txt"), "utf8")}\n// internalPath est ailleurs\n`;
    const rd = F.repairRedirects(dejaNomme);
    check("un fichier qui nomme déjà internalPath : jamais retouché, la ligne nommée (manual)", rd.text === null && rd.manual.length === 1 && /internalPath/.test(rd.reason ?? ""), JSON.stringify(rd));
    const brut = page(BRUT_CONNEXION, "        router.push(callbackUrl);");
    check("la forme d'avant la 3.3.11 (l'adresse suivie telle quelle) : jamais réécrite ici", F.repairRedirects(brut).text === null);
    const deux = `${readFileSync(join(FIX, "admin-signin.tsx.txt"), "utf8")}`.replace("    router.push(callbackUrl);", "    router.push(callbackUrl);\n    const rawCallback = params.get(\"callbackUrl\");\n    const callbackUrl = rawCallback && /^\\/(?![/\\\\])/.test(rawCallback) ? rawCallback : \"/admin\";");
    const r2 = F.repairRedirects(deux);
    check("deux appels dans un fichier : les deux réparés, la fonction posée une seule fois", r2.text !== null && r2.fixed.length === 2 && (r2.text.match(/function internalPath\(/g) ?? []).length === 1);
  }

  // /security calls it, and says what each form is worth.
  const security = lireHarnais("skills/security/SKILL.md");
  check("/security lance ce lecteur sur le projet", /scripts\/redirect-filter\.mjs" --project-dir </.test(security));
  check("/security : old-filter et unfiltered sont 🔴, jamais ✅ ; suspect se lit", /`old-filter`[^\n]*`unfiltered`[^\n]*🔴[^\n]*(never ✅|jamais ✅)/.test(security) && /`suspect`/.test(security));
  check("/security propose le lecteur d'adresses (internalPath, new URL), plus le motif", /function internalPath\(raw: string \| null \| undefined\): string \| null \{/.test(security) && /target\.pathname\.startsWith\("\/\/"\)/.test(security) && !security.includes("/^\\/(?!["));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
if (failures) {
  console.error(`${failures} ECHEC(S)`);
  process.exit(1);
}
