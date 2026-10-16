#!/usr/bin/env node
// test-admin-password.mjs - The admin's production password never goes through the conversation
// (3.4.13): admin-password.mjs writes it in a file of the person's real downloads folder (read where
// the system declares it), pushes only its hash, and returns only the file's path; setup-auth-admin.mjs
// and the skills that used to display it follow. No network, no vault: temporary folders and stubs.
//
//   node scripts/tests/test-admin-password.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { downloadsDir, expandWindows } = await import(pathToFileURL(join(ROOT, "scripts", "downloads-dir.mjs")).href);
const { main, writeCredentialsFile, newAdminPassword, EXIT } = await import(pathToFileURL(join(ROOT, "scripts", "admin-password.mjs")).href);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${String(detail).slice(0, 400)})`}`);
}
const verifies = (password, hash) => {
  const [salt, h] = String(hash).split(":");
  return Boolean(salt && h) && scryptSync(password, salt, 64).toString("hex") === h;
};

console.log("── Le vrai dossier de téléchargements ──");
{
  const reg = (out) => () => ({ status: 0, stdout: out });
  const exists = (set) => (d) => set.includes(d);
  const env = { USERPROFILE: "C:\\Users\\lea" };
  const windows = downloadsDir({ platform: "win32", env, home: "C:\\Users\\lea", run: reg("\r\nHKEY_CURRENT_USER\\...\\User Shell Folders\r\n    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\Dropbox\\Download\r\n"), exists: exists(["C:\\Users\\lea\\Dropbox\\Download", "C:\\Users\\lea\\Downloads"]) });
  check("Windows : le dossier que déclare le registre (déplacé dans Dropbox), pas ~/Downloads", windows === "C:\\Users\\lea\\Dropbox\\Download", windows);
  check("... les %VARIABLES% lues comme Windows, quelle que soit leur casse", expandWindows("%userprofile%\\x", env) === "C:\\Users\\lea\\x");
  const sansRegistre = downloadsDir({ platform: "win32", env, home: "C:\\Users\\lea", run: () => ({ status: 1, stdout: "" }), exists: exists(["C:\\Users\\lea\\Downloads"]) });
  check("Windows sans réponse du registre : ~/Downloads", /Downloads$/.test(sansRegistre), sansRegistre);
  const linux = downloadsDir({ platform: "linux", env: {}, home: "/home/lea", run: reg("/home/lea/Téléchargements\n"), exists: exists(["/home/lea/Téléchargements"]) });
  check("Linux : le dossier que donne xdg-user-dir", linux === "/home/lea/Téléchargements", linux);
  const rien = downloadsDir({ platform: "darwin", env: {}, home: "/Users/lea", run: () => ({ status: 1 }), exists: () => false });
  check("aucun dossier de téléchargements : le dossier personnel", rien === "/Users/lea", rien);
}

console.log("\n── Le fichier, jamais la conversation ──");
const work = mkdtempSync(join(tmpdir(), "hv-admin-"));
try {
  const dl = join(work, "Telechargements");
  mkdirSync(dl);
  const { password, hash } = newAdminPassword();
  check("un mot de passe de 24 lettres et chiffres, et son empreinte scrypt", /^[A-Za-z0-9]{24}$/.test(password) && verifies(password, hash));
  const f1 = writeCredentialsFile({ dir: dl, project: "atelier", username: "admin", password, url: "https://atelier.fr/admin/signin", now: new Date(2026, 9, 16, 18, 5) });
  const text = readFileSync(f1, "utf8");
  check("le fichier porte la page de connexion, l'identifiant et le mot de passe", text.includes("https://atelier.fr/admin/signin") && text.includes("admin") && text.includes(password), f1);
  check("... et dit de le ranger puis de le supprimer", /password manager/.test(text) && /supprimez ce fichier/.test(text));
  const f2 = writeCredentialsFile({ dir: dl, project: "atelier", username: "admin", password: "x".repeat(24), now: new Date(2026, 9, 16, 18, 5) });
  check("un second fichier de la même minute n'écrase pas le premier", f2 !== f1 && readFileSync(f1, "utf8").includes(password), `${f1} | ${f2}`);

  const projet = join(work, "projet");
  mkdirSync(projet);
  writeFileSync(join(projet, "package.json"), JSON.stringify({ name: "atelier" }));
  writeFileSync(join(projet, ".env"), "ADMIN_USERNAME=patronne\nNEXT_PUBLIC_APP_URL=https://atelier.fr\n");
  let pushed = null;
  let r = main(["rotate", "--project-dir", projet], { dir: dl, push: (dir, h) => ((pushed = { dir, h }), { ok: true }) });
  const written = r.out.file ? readFileSync(r.out.file, "utf8") : "";
  const newPassword = /Mot de passe : ([A-Za-z0-9]{24})/.exec(written)?.[1];
  check("rotate : le fichier écrit, l'empreinte poussée, rien d'autre", r.code === EXIT.OK && r.out.ok && JSON.stringify(r.out.pushed) === '["ADMIN_PASSWORD_HASH_PROD"]' && pushed?.dir === projet, JSON.stringify(r.out));
  check("... l'empreinte poussée est celle du mot de passe du fichier", Boolean(newPassword) && verifies(newPassword, pushed?.h));
  check("... l'identifiant du projet et sa page de connexion sont dans le fichier", written.includes("patronne") && written.includes("https://atelier.fr/admin/signin"));
  check("... et la réponse ne porte ni le mot de passe ni son empreinte", Boolean(newPassword) && !JSON.stringify(r.out).includes(newPassword) && !JSON.stringify(r.out).includes(String(pushed?.h).split(":")[1]));

  pushed = null;
  r = main(["rotate", "--project-dir", projet], { dir: join(work, "absent"), push: () => ((pushed = true), { ok: true }) });
  check("un fichier impossible à écrire : rien n'est poussé, le mot de passe actuel reste valable", r.code === EXIT.FAILED && pushed === null && /nothing was changed/.test(r.out.error ?? ""), JSON.stringify(r.out));
  r = main(["rotate", "--project-dir", projet], { dir: dl, push: () => ({ ok: false }) });
  check("une empreinte qui ne part pas : dit, avec la commande pour la renvoyer depuis .env, sans la montrer", r.code === EXIT.FAILED && Boolean(r.out.file) && /grep '\^ADMIN_PASSWORD_HASH_PROD='/.test(r.out.error ?? ""), JSON.stringify(r.out));
  r = main(["rotate"], {});
  check("sans dossier de projet : usage, exit 5", r.code === EXIT.USAGE);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("\n── Ceux qui l'affichaient ──");
const setup = read("scripts/setup-auth-admin.mjs");
check("setup-auth-admin.mjs ne rend plus le mot de passe, seulement le chemin du fichier", !/prodPassword/.test(setup) && /credentialsFile: state\.credentialsFile/.test(setup) && /writeCredentialsFile\(/.test(setup));
check("... et écrit le fichier avant de pousser quoi que ce soit", setup.indexOf("writeCredentialsFile(") < setup.indexOf('await step("pushEnvVars", pushEnvVars)'));
const skill = read("skills/_setup-auth-admin/SKILL.md");
check("_setup-auth-admin ne fait plus afficher le mot de passe", !/PROD_PASSWORD|prodPassword|display it ONCE/i.test(skill) && /credentialsFile/.test(skill));
check("... ni générer par --generate, qui l'imprime", !/hash-password\.mjs" --generate/.test(skill) && /admin-password\.mjs" rotate/.test(skill));
const addAuth = read("skills/add-auth/SKILL.md");
check("/add-auth (un admin ajouté à des comptes) passe par le même fichier", /admin-password\.mjs" rotate/.test(addAuth) && !/show the PROD password ONCE/.test(addAuth));
{
  // Aucune skill ne lance --generate là où sa sortie se lit, ni ne fait afficher un mot de passe.
  const skillsDir = join(ROOT, "skills");
  const fautives = readdirSync(skillsDir).filter((d) => {
    const f = join(skillsDir, d, "SKILL.md");
    if (!existsSync(f)) return false;
    const t = readFileSync(f, "utf8");
    return /hash-password\.mjs" --generate/.test(t) || /password=`? ONCE|plain password ONCE|display it ONCE|afficher le `password=`|l'afficher UNE fois/i.test(t);
  });
  check("aucune skill ne fait générer un mot de passe là où sa sortie se lit, ni ne le fait afficher", fautives.length === 0, fautives.join(", "));
}
const rotate = read("skills/rotate-secret/SKILL.md");
check("/rotate-secret renouvelle le mot de passe admin par le fichier, et dit qu'il attend un déploiement", /Strategy = `admin-password`/.test(rotate) && /admin-password\.mjs" rotate/.test(rotate) && /deployed again/.test(rotate));
{
  const projet = mkdtempSync(join(tmpdir(), "hv-rotation-"));
  try {
    writeFileSync(join(projet, ".env"), "ADMIN_PASSWORD_HASH_PROD=a:b\nADMIN_USERNAME=admin\n");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "list-rotatable-secrets.mjs"), "--json"], { cwd: projet, encoding: "utf8", windowsHide: true });
    const list = JSON.parse(r.stdout || "[]");
    const admin = list.find((x) => x.key === "ADMIN_PASSWORD_HASH_PROD");
    check("la liste des clés renouvelables propose le mot de passe admin de production", Boolean(admin) && admin.special === "admin-password", r.stdout.slice(0, 300));
  } finally {
    rmSync(projet, { recursive: true, force: true });
  }
}
{
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "hash-password.mjs")], { input: "Admin1234!", encoding: "utf8", windowsHide: true });
  check("hash-password.mjs garde sa ligne de commande : l'empreinte d'un mot de passe lu sur l'entrée", r.status === 0 && verifies("Admin1234!", r.stdout));
  check("... et existe toujours pour --generate (usage interne, jamais lu par un agent)", spawnSync(process.execPath, [join(ROOT, "scripts", "hash-password.mjs"), "--generate"], { encoding: "utf8", windowsHide: true }).stdout.startsWith("password="));
}

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
