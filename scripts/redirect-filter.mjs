#!/usr/bin/env node
// redirect-filter.mjs - Where a project follows an address that comes from outside (the return
// address read in the URL after sign-in, the link of a notification) without reading it with the
// URL parser (3.4.19).
//
// From 3.3.11 to 3.4.18, the templates of this plugin kept such an address only when a pattern on
// its raw text saw one `/` at the start and neither `/` nor `\` after it. A browser reads an address
// after dropping its tabs and line breaks: `/\t/evil.com` (`/%09/evil.com` in a link, decoded by
// searchParams.get) passes the pattern and becomes `//evil.com`, another site. Right after signing
// in, a trapped link sends the administrator to a copy of the site (reported on 28/10/2026). Before
// 3.3.11, the templates followed the address as it came. 3.4.19 reads it with the URL parser; the
// projects built before keep the old text until someone changes it.
//
//   node redirect-filter.mjs --project-dir <dir>
//
// It reads the code of the project (every .ts, .tsx, .js, .jsx, .mjs, .cjs file, node_modules,
// hidden folders, build outputs and public/ left out), writes nothing, and prints one JSON line:
//   { ok: true, dir, found: [{ file, line, form }], counts: { "old-filter", unfiltered, suspect }, unreadable }
// The forms:
//   old-filter  the pattern of the templates from 3.3.11 to 3.4.18: one `/`, then neither `/` nor `\`;
//   unfiltered  the text of the templates before 3.3.11, the address followed as it came;
//   suspect     another test written by hand on the raw text (a pattern that wants a leading `/`,
//               startsWith("/"), the first character compared to "/"): to read, a finding when it
//               is what guards a navigation.
// /security reads all three. /update-hypervibe repairs the first one where its lines are still the
// templates' own, word for word (repairRedirects below, called by repair-admin-gate.mjs), and names
// the rest, which /security fixes.
// Exit 0, or 1 when the folder cannot be read.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SKIPPED = new Set(["node_modules", ".next", "dist", "build", "out", "coverage", "public"]);
const MAX_FILES = 20000;
const MAX_DEPTH = 12;
const MAX_SIZE = 1024 * 1024;

/** The pattern of the templates from 3.3.11 to 3.4.18, as a regular expression literal: `/^\/(?![`. */
const OLD_FILTER = "/^\\/(?![";
/** The text of the templates before 3.3.11: the return address and the link followed as they came. */
const UNFILTERED = [
  /\b(?:const|let|var)\s+callbackUrl\s*=\s*params\.get\(\s*["']callbackUrl["']\s*\)\s*(?:\?\?|\|\|)/,
  /\bif\s*\(\s*n\.url\s*\)\s*window\.location\.assign\(\s*n\.url\s*\)/,
  /\bconst\s+url\s*=\s*\(\s*event\.notification\.data\b[^;]*\)\s*\?\.\s*url\s*(?:\?\?|\|\|)/,
];
/** A hand-written test of a leading `/` on the raw text. */
const SUSPECT = [
  /\/\^(?:\\\/|\[[^\]]*\/[^\]]*\])[^\n]*\/[a-z]*\s*\.test\s*\(/,
  /\.startsWith\(\s*(["'`])\/\1\s*\)/,
  /(?:\[0\]|\.charAt\(\s*0\s*\))\s*={2,3}\s*(["'`])\/\1/,
];

const slash = (p) => p.split(sep).join("/");

/** A line that is only a comment, or the inside of a block comment. */
const commentLine = (line) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** The form of one line, or null. */
export function formOf(line) {
  if (commentLine(line)) return null;
  if (line.includes(OLD_FILTER)) return "old-filter";
  if (UNFILTERED.some((re) => re.test(line))) return "unfiltered";
  if (SUSPECT.some((re) => re.test(line))) return "suspect";
  return null;
}

/**
 * Every line of the project's code that follows an outside address without the URL parser, with its
 * form. `readdir` simulates a folder that cannot be read (the recettes).
 */
export function findRedirectFilters(dir, { readdir = readdirSync } = {}) {
  const abs = resolve(dir);
  const found = [];
  const unreadable = [];
  let files = 0;
  const visit = (d, depth) => {
    if (depth > MAX_DEPTH || files > MAX_FILES) return;
    let entries;
    try {
      entries = readdir(d, { withFileTypes: true });
    } catch (e) {
      unreadable.push({ path: slash(relative(abs, d)) || ".", error: e.code ?? String(e.message) });
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIPPED.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile() && CODE.test(e.name)) {
        files += 1;
        let text;
        try {
          if (statSync(p).size > MAX_SIZE) continue;
          text = readFileSync(p, "utf8");
        } catch (err) {
          unreadable.push({ path: slash(relative(abs, p)), error: err.code ?? "unreadable" });
          continue;
        }
        text.split(/\r?\n/).forEach((line, i) => {
          const form = formOf(line);
          if (form) found.push({ file: slash(relative(abs, p)), line: i + 1, form });
        });
      }
    }
  };
  visit(abs, 0);
  return { found, unreadable };
}

/** The diagnosis of one project: what was found, counted by form. */
export function diagnoseRedirects(dir, options = {}) {
  const abs = resolve(dir);
  try {
    if (!statSync(abs).isDirectory()) return { ok: false, dir: abs, detail: "not a folder" };
  } catch {
    return { ok: false, dir: abs, detail: "not a folder" };
  }
  const { found, unreadable } = findRedirectFilters(abs, options);
  const counts = { "old-filter": 0, unfiltered: 0, suspect: 0 };
  for (const f of found) counts[f.form] += 1;
  return { ok: true, dir: abs, found, counts, unreadable };
}

// ─── The repair of the old filter, where its lines are the templates' own ─────
// Only the lines the templates wrote from 3.3.11 to 3.4.18 (and the plain sign-in before), word for
// word, at any indentation, with the default page the project has: they become the call of
// internalPath(), with the comment of 3.4.19 when the old one is still above them, and the function
// goes in once per file, as in the templates of 3.4.19 (after the last import; in a service worker,
// before its notificationclick listener). A line changed by hand, a file that already names
// internalPath, a form the templates never wrote: never rewritten, left to /security.

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
const OLD_RE = String.raw`/^\/(?![/\\])/`;
const KINDS = {
  callback: {
    first: String.raw`const rawCallback = params.get("callbackUrl");`,
    second: String.raw`const callbackUrl = rawCallback && ` + OLD_RE + String.raw`.test(rawCallback) ? rawCallback : "`,
    after: (fallback) => `const callbackUrl = internalPath(params.get("callbackUrl")) ?? "${fallback}";`,
    template: "auth/admin/pages/signin.tsx",
    comments: [
      [
        ["// Only accept a same-origin relative path. The router runs a `javascript:`", "// address, and an `https://` or `//` one sends the admin to another site:", "// ?callbackUrl= must never be taken as it comes."],
        ["// Only a path of this site. The router runs a `javascript:` address, and", "// another site's address sends the admin there: ?callbackUrl= must never be", "// taken as it comes (internalPath, above)."],
      ],
      [
        ["// Only accept a same-origin relative path - block open redirects such as", "// ?callbackUrl=https://evil.com or //evil.com."],
        ["// Only a path of this site - no open redirect through ?callbackUrl=https://evil.com,", "// //evil.com or /%09/evil.com (internalPath, above)."],
      ],
    ],
  },
  bell: {
    first: null,
    second: String.raw`if (n.url && ` + OLD_RE + String.raw`.test(n.url)) window.location.assign(n.url);`,
    after: () => ["const lien = internalPath(n.url);", "if (lien) window.location.assign(lien);"],
    template: "notif-center/notification-bell.tsx",
    comments: [
      [
        ["// Un lien de notification vient de la base : seul un chemin interne est suivi", "// (un seul / en tête, ni // ni /\\). Une adresse javascript: ou un autre site", "// ne déclenche aucune navigation."],
        ["// Un lien de notification vient de la base : seul un chemin de ce site est", "// suivi (internalPath, plus haut). Une adresse javascript: ou un autre site ne", "// déclenche aucune navigation."],
      ],
    ],
  },
  sw: {
    first: String.raw`const raw = (event.notification.data as { url?: string })?.url;`,
    second: String.raw`const url = raw && ` + OLD_RE + String.raw`.test(raw) ? raw : "`,
    after: (fallback) => `const url = internalPath((event.notification.data as { url?: string })?.url) ?? "${fallback}";`,
    template: "push/sw-push-handlers.ts",
    comments: [
      [
        ['// Le lien d\'une notification est un chemin interne ("/commandes/12"). Tout le reste (adresse', '// externe, "//hote", "javascript:") ouvre l\'accueil : un clic n\'envoie jamais vers un autre site.'],
        ['// Le lien d\'une notification est un chemin de ce site ("/commandes/12"). Tout le reste (adresse', '// externe, "//hote", "/\\t/hote", "javascript:") ouvre l\'accueil : un clic n\'envoie jamais vers', "// un autre site."],
      ],
    ],
  },
};

/** The function internalPath() as the template of 3.4.19 writes it, its comment included: lines. */
function functionOf(template) {
  let text;
  try {
    text = readFileSync(join(TEMPLATES, template), "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith("function internalPath("));
  if (at < 0) return null;
  let start = at;
  if (lines[at - 1] === " */") while (start > 0 && !lines[start - 1].startsWith("/**")) start -= 1;
  if (start !== at) start -= 1;
  const end = lines.findIndex((l, i) => i > at && l === "}");
  return end < 0 ? null : lines.slice(start, end + 1);
}

/** The line after which the function goes: the end of the last import at the top of the file. */
function lastImport(lines) {
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^import\b/.test(lines[i])) continue;
    let j = i;
    while (j < lines.length && !/(?:\bfrom\s*["'][^"']+["']|^import\s*["'][^"']+["'])\s*;?\s*$/.test(lines[j])) j += 1;
    if (j >= lines.length) return -1;
    last = j;
    i = j;
  }
  return last;
}

/**
 * The repair of one file's text. Returns `{ text, fixed, manual, reason }`: the new text (null when
 * nothing changes), the lines (1-based, of the text given) of the old filter that are repaired, and
 * those left as they are (never rewritten), with why.
 */
export function repairRedirects(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const oldLines = lines.flatMap((l, i) => (formOf(l) === "old-filter" ? [i + 1] : []));
  const none = (reason) => ({ text: null, fixed: [], manual: oldLines, reason });
  if (!oldLines.length) return { text: null, fixed: [], manual: [], reason: null };
  if (/\binternalPath\b/.test(text)) return none("internalPath is already named in the file");
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const [kind, k] of Object.entries(KINDS)) {
      const pre = k.first === null ? 0 : 1;
      const ind = /^[ \t]*/.exec(lines[i])[0];
      if (k.first !== null && lines[i] !== ind + k.first) continue;
      const line = lines[i + pre] ?? "";
      if (!line.startsWith(ind + k.second)) continue;
      let fallback = "";
      if (k.first !== null) {
        const m = /^([^"\\\r\n]*)";$/.exec(line.slice(ind.length + k.second.length));
        if (!m) continue;
        fallback = m[1];
      } else if (line !== ind + k.second) continue;
      // The comment of the templates just above, when it is still there, word for word.
      let from = i;
      let comment = null;
      for (const [before, after] of k.comments) {
        const top = i - before.length;
        if (top >= 0 && before.every((c, n) => lines[top + n] === ind + c)) {
          from = top;
          comment = after;
          break;
        }
      }
      const call = k.after(fallback);
      found.push({ kind, from, to: i + pre, filterLine: i + pre + 1, lines: [...(comment ?? []), ...(Array.isArray(call) ? call : [call])].map((l) => ind + l) });
      i += pre;
      break;
    }
  }
  if (!found.length) return none("lines changed by hand, or a form the templates never wrote");
  const kinds = new Set(found.map((f) => (f.kind === "sw" ? "self" : "window")));
  if (kinds.size > 1) return none("both a page and a service worker in one file");
  const fn = functionOf(KINDS[found[0].kind].template);
  if (!fn) return none("the function of the templates could not be read");
  let out = [...lines];
  for (const f of [...found].reverse()) out.splice(f.from, f.to - f.from + 1, ...f.lines);
  if (kinds.has("self")) {
    const at = out.flatMap((l, i) => (l.startsWith('self.addEventListener("notificationclick"') ? [i] : []));
    if (at.length !== 1) return none("no single notificationclick listener to put the function before");
    out.splice(at[0], 0, ...fn, "");
  } else {
    const at = lastImport(out);
    if (at < 0) return none("no import to put the function after");
    out.splice(at + 1, 0, "", ...fn);
  }
  const fixed = found.map((f) => f.filterLine);
  const repaired = out.join(eol);
  // Read again: the lines that were repaired no longer carry the old filter, and nothing else moved.
  if (repaired.split(/\r?\n/).filter((l) => formOf(l) === "old-filter").length !== oldLines.length - fixed.length) return none("the repaired text could not be read back");
  return { text: repaired, fixed, manual: oldLines.filter((n) => !fixed.includes(n)), reason: null };
}

// ─── Launched as a script, or imported ────────────────────────────────────────
// Node gives a module its real path and keeps in argv[1] the path as it was typed. Compared as
// they come, the two differ as soon as the plugin is reached through a symbolic link (macOS's
// temporary folder, a ~/.claude kept by a configuration repository): the script then did
// nothing and exited 0, "I could not" read as "nothing to report" (outside review, 3.3.9).
// Both are read to their real path. The same block in every script, held by
// scripts/tests/test-entry-point.mjs.
import { realpathSync as realPathOf } from "node:fs";
import { fileURLToPath as pathOfUrl } from "node:url";
function launchedDirectly() {
  try {
    if (!process.argv[1]) return false;
    const self = realPathOf(pathOfUrl(import.meta.url));
    const launched = realPathOf(process.argv[1]);
    return process.platform === "win32" ? self.toLowerCase() === launched.toLowerCase() : self === launched;
  } catch {
    return false;
  }
}

if (launchedDirectly()) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--project-dir");
  const { fromGitBashPath } = await import("./detect-projects-dir.mjs");
  const dir = resolve(fromGitBashPath(at >= 0 ? args[at + 1] : process.cwd()));
  const out = diagnoseRedirects(dir);
  console.log(JSON.stringify(out));
  process.exitCode = out.ok === false ? 1 : 0;
}
