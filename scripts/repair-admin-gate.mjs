#!/usr/bin/env node
// repair-admin-gate.mjs - Closes the admin space of a project built before 3.4.17 (3.4.18).
//
// Until 3.4.17, the only check of the admin space that /add-auth creates was the layout of
// admin/(protected)/. Next.js renders a layout and its page at the same time: when the layout
// redirected a visitor without a session, the page it had already rendered left in the body of the
// redirect, readable with a plain request (found on 26/10/2026 on sites built with this harness).
// 3.4.17 fixed the templates and /security, not the projects already built: each one stays exposed
// until someone repairs it, and its CLAUDE.md keeps teaching Claude the old pattern for every new
// page. /update-hypervibe (and the collaborator's /update-hypervibe-enterprise) offers this repair for
// every project of the machine that needs it:
//
//   node repair-admin-gate.mjs --project-dir <dir>           the diagnosis of one project; nothing
//                                                            is written
//   node repair-admin-gate.mjs --project-dir <dir> --write   the repair of that project
//   node repair-admin-gate.mjs --scan [--cwd <dir>]          the projects of this machine, each
//                                                            diagnosed; nothing is written
//                                 [--collab]                 the collaborator's order of the copies
//
// The diagnosis, for each Next.js app of the project (its root, or the apps/* of a monorepo):
//   - every page of an admin/(protected)/ folder of src/app, at any depth (a project translated by
//     /add-i18n has it under [locale]): `checked` (its default function starts with
//     `await requireAdmin()`, or with `if (!(await isAdmin())) redirect(...)`, the form of the
//     agents' pages), `client` ("use client": no finding, as /security says), `to-fix` (a server
//     page without that check, written as a function declaration: the check goes in safely),
//     `manual` (any other form, a check of its own, a layout that lets in more than the admin, a
//     project where the templates' requireAdmin() would not fit);
//   - the pages of the other spaces protected by their layout only (a members' area, a role's
//     space): `review`, never corrected here, the right check depends on the space. A layout closes
//     its pages only by a guard call, or by a redirect (or notFound()) when the session, the admin or
//     a role is MISSING: next-intl's notFound() for a language, a session read for a menu, or a
//     sign-in layout that sends a signed-in visitor home close nothing;
//   - for each page left to Claude, the check that fits (`fix`), never weaker than its layout's:
//     `requireAdmin` (the templates' helper), `layout` (the check of the layout named in `layout`,
//     copied on its first lines), `admin` (the project's own admin check, where nothing closes the
//     admin space);
//   - the helper and the first barrier, as admin-gate.mjs --check would say them, but `skipped`, with
//     a `reason`, where --write will not write them: no page will call requireAdmin(), the templates
//     do not fit, no /admin/signin page, or a session cookie that is not the one of Auth.js 5 (a
//     next-auth older than 5, a configuration that renames it);
//   - the project's CLAUDE.md (and AGENTS.md, the rules file of the ports): the rules that the
//     versions before 3.4.17 wrote (`outdated`, or `edited` when its words were changed), the one of
//     3.4.17 (`current`), or none (`absent`).
// The repair touches only what the diagnosis named: the helper and the barrier (never over a
// middleware the project already has), `await requireAdmin();` first in each `to-fix` page with its
// import (and `async` when the function was not), the old rule replaced in its place. Run again, it
// changes nothing. It lists the files it wrote (`commit`) and what is left to Claude (`remaining`).
// It never runs git, but for these questions, each asked in the neutral form of 3.4.17 (no file
// system monitor, no filter, no hook, no pager, no optional lock), without a shell, five seconds at
// most: which of the files it would write already have changes not committed (`uncommitted`, with
// --project-dir only); and, with --scan, for each working copy other than the first that still needs
// the repair, whether it has changes not committed (`git status`) and whether what it holds is
// already in the production branch (`git merge-base --is-ancestor HEAD <branch>`, see copyState).
//
// 3.4.19: the --scan groups the working copies of one repository (`git worktree add`) into one
// project, each copy with its branch, the copy on the production branch first (`copies`,
// `productionBranch`); the diagnosis also names an address from outside still followed through the
// old filter of the templates (`openRedirect`, from redirect-filter.mjs), and with --redirects counts
// it in `needed` (`counts.redirect`) and --write repairs the lines that are still the templates' own,
// word for word (`fix: "auto"`), never another (`fix: "manual"`, left to /security); a page that starts with `await requireAdmin("/admin")` (one plain string) is
// `checked`; `uncommitted` reads git's paths and the project's to their real path.
//
// 3.4.20: every working copy of a project, and its `dir`, are given by their real path. A copy found
// through worktrees/*/gitdir came back as git wrote it (/private/var/... on macOS), the others as the
// scan met them (/var/...): one group held two forms of the same folders (reported on 28/10/2026).
// A project's `needed` is its first copy's, the one offered for the repair: five old copies of
// branches already merged no longer kept a repaired project "to repair" (reported the same day). The
// other copies that still need it are named apart (`otherCopies`), each with its state (`merged`:
// nothing pending and already in the production branch; `work`: changes not committed, or commits
// the production branch does not have; `unread`), and are never offered for writing. With --collab
// (the collaborator's /update-hypervibe-enterprise), in a project of the organisation
// (.github/workflows/deploy.yml), the copy on the work branch `collab/<login>` is offered first.
//
// One JSON line. Exit 0, or 1 when a step failed (`step` says which).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { HELPER_FILE, ensureAdminMiddleware, ensureRequireAdmin } from "./admin-gate.mjs";
import { detect, fromGitBashPath } from "./detect-projects-dir.mjs";
import { findRedirectFilters, repairRedirects } from "./redirect-filter.mjs";

// ─── The rules of the project's CLAUDE.md ─────────────────────────────────────
// Each rule as it arrives in a project's CLAUDE.md (the skill's backticks unescaped): the one the
// versions before 3.4.17 wrote (the solo harness from v2.4.0 to 3.4.16 in English, the
// collaborator's from 1.5.0 to 2.4.15 in French: one wording each, read in every published version
// on 26/10/2026) and the one of 3.4.17. An old rule is replaced by the current one of its language.
// The rule of the members' area did not exist before 3.4.17: it is only ever `current` or `absent`.
export const RULES = {
  admin: {
    key: /\*\*(?:Admin structure|Structure admin)\*\*/,
    en: {
      old: "- **Admin structure**: route group `src/app/admin/(protected)/` which contains the pages to protect (gate in its `layout.tsx` via `if (!await isAdmin()) redirect(\"/admin/signin?callbackUrl=/admin\")`). `src/app/admin/signin/page.tsx` stays outside the group to avoid the redirect loop. Any new admin page goes in `(protected)/`. NEVER add a gate in `app/admin/layout.tsx` (this layout also wraps signin → infinite loop).",
      current: "- **Admin structure**: the pages to protect live in the route group `src/app/admin/(protected)/`, and every `page.tsx` there starts with `await requireAdmin()` (from `~/server/require-admin`) before reading any data: the check of the group's `layout.tsx` is not enough (the layout's redirect carries the page's content, Next.js rendering both at the same time). A page that needs interactivity stays a server page that calls `requireAdmin()` and renders a client component kept in its own file. Every `\"use server\"` action starts with `if (!(await isAdmin())) return;` (the sign-in action alone excepted: it is public by nature, and limited in attempts). The middleware (`src/middleware.ts`, `src/proxy.ts` from Next.js 16) sends a visitor without a session cookie to the sign-in page: a first barrier, never the only one. `src/app/admin/signin/page.tsx` stays outside the group to avoid the redirect loop. NEVER add a check in `app/admin/layout.tsx` (this layout also wraps signin → infinite loop).",
    },
    fr: {
      old: "- **Structure admin** : route group `src/app/admin/(protected)/` qui contient les pages à protéger (gate dans son `layout.tsx` via `if (!await isAdmin()) redirect(\"/admin/signin?callbackUrl=/admin\")`). `src/app/admin/signin/page.tsx` reste hors du groupe pour éviter la boucle de redirection. Toute nouvelle page admin va dans `(protected)/`. Ne JAMAIS ajouter de gate dans `app/admin/layout.tsx` (ce layout englobe aussi signin → boucle infinie).",
      current: "- **Structure admin** : les pages à protéger vivent dans le route group `src/app/admin/(protected)/`, et chaque `page.tsx` de `(protected)/` commence par `await requireAdmin()` (de `~/server/require-admin`) avant toute lecture de données ; le contrôle du layout ne suffit pas (la redirection du layout emporte le contenu de la page, Next.js rendant les deux en même temps). Une page qui a besoin d'interactivité reste une page serveur qui appelle `requireAdmin()` puis affiche un composant client rangé dans son propre fichier. Toute action `\"use server\"` commence par `if (!(await isAdmin())) return;` (seule exception : l'action de connexion, publique par nature et limitée en tentatives). Le middleware (`src/middleware.ts`, `src/proxy.ts` à partir de Next.js 16) renvoie un visiteur sans cookie de session vers la page de connexion : une première barrière, jamais la seule. `src/app/admin/signin/page.tsx` reste hors du groupe pour éviter la boucle de redirection. Ne JAMAIS ajouter de contrôle dans `app/admin/layout.tsx` (ce layout englobe aussi signin → boucle infinie).",
    },
    /** The current rule teaches requireAdmin(); a line under the same key that does not is the old one. */
    isCurrent: (line) => /requireAdmin/.test(line),
  },
  role: {
    key: /hasRole\(await auth\(\), \[\.\.\.\]\)/,
    en: {
      old: "- To gate a tRPC procedure by role : use `protectedProcedure` then check `hasRole(ctx.session, [...])` at the start, otherwise `throw new TRPCError({ code: \"UNAUTHORIZED\" })`. To gate a server-component page : check `hasRole(await auth(), [...])`, otherwise `redirect(\"/\")`.",
      current: "- To gate a tRPC procedure by role : use `protectedProcedure` then check `hasRole(ctx.session, [...])` at the start, otherwise `throw new TRPCError({ code: \"UNAUTHORIZED\" })`. To gate a server-component page : check `hasRole(await auth(), [...])` on its first lines, before reading any data, otherwise `redirect(\"/\")`. A check in a shared `layout.tsx` is not enough : the layout's redirect carries the page's content.",
    },
    fr: {
      old: "- Pour gater une procédure tRPC par rôle : utiliser `protectedProcedure` puis vérifier `hasRole(ctx.session, [...])` au début, sinon `throw new TRPCError({ code: \"UNAUTHORIZED\" })`. Pour gater une page server-component : check `hasRole(await auth(), [...])`, sinon `redirect(\"/\")`.",
      current: "- Pour gater une procédure tRPC par rôle : utiliser `protectedProcedure` puis vérifier `hasRole(ctx.session, [...])` au début, sinon `throw new TRPCError({ code: \"UNAUTHORIZED\" })`. Pour gater une page server-component : check `hasRole(await auth(), [...])` dans ses premières lignes, avant toute lecture de données, sinon `redirect(\"/\")`. Un contrôle dans un `layout.tsx` partagé ne suffit pas : la redirection du layout emporte le contenu de la page.",
    },
    isCurrent: (line) => /layout\.tsx/.test(line) && /(first lines|premières lignes)/.test(line),
  },
  users: {
    key: /\*\*(?:Pages for signed-in users|Pages des utilisateurs connectés)\*\*/,
    en: {
      current: "- **Pages for signed-in users**: a server page that shows a user's data checks the session itself on its first lines, before reading anything, as `/dashboard` does (`const session = await auth(); if (!session?.user) redirect(\"/signin?callbackUrl=...\")`). A check in a shared `layout.tsx` is not enough: Next.js renders the layout and the page at the same time, and the layout's redirect carries the page's content. Every `\"use server\"` action that changes something checks the session first too.",
    },
    fr: {
      current: "- **Pages des utilisateurs connectés** : une page serveur qui montre les données d'un utilisateur contrôle elle-même la session dans ses premières lignes, avant toute lecture, comme `/dashboard` (`const session = await auth(); if (!session?.user) redirect(\"/signin?callbackUrl=...\")`). Un contrôle dans un `layout.tsx` partagé ne suffit pas : Next.js rend le layout et la page en même temps, et la redirection du layout emporte le contenu de la page. Toute action `\"use server\"` qui change quelque chose contrôle la session d'abord, elle aussi.",
    },
    isCurrent: () => true,
  },
};

/** The project's rules files: Claude Code's, and the ports' (Codex, OpenCode, Antigravity). */
export const RULES_FILES = ["CLAUDE.md", "AGENTS.md"];

/** A rule's line compared as Claude may have written it: escaped backticks, an ASCII arrow, the
 *  spacing, the bullet and a final full stop do not count. */
function normalRule(text) {
  return String(text)
    .replace(/\\`/g, "`")
    .replace(/->/g, "→")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

/** The status of one rule in a rules file's text, and the lines that carry it. */
export function readRule(text, name) {
  const rule = RULES[name];
  const lines = text.split("\n");
  const found = [];
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (!rule.key.test(line.replace(/\\`/g, "`"))) return;
    let status;
    if (rule.isCurrent(line)) status = "current";
    else {
      const lang = ["en", "fr"].find((l) => rule[l].old && normalRule(line) === normalRule(rule[l].old));
      status = lang ? "outdated" : "edited";
      found.push({ index, status, lang: lang ?? null });
      return;
    }
    found.push({ index, status, lang: null });
  });
  const has = (s) => found.some((f) => f.status === s);
  const status = has("edited") ? "edited" : has("outdated") ? "outdated" : has("current") ? "current" : "absent";
  return { status, found };
}

/** The text of a rules file with every old rule of the exact former wording replaced by the current
 *  one of its language, in its place (its indent and bullet kept), never a second current line: when
 *  the current rule is already there, the old line goes. `edited` lines are left to Claude. */
export function replaceRules(text) {
  const lines = text.split("\n");
  const drop = new Set();
  let replaced = 0;
  let removed = 0;
  for (const name of ["admin", "role"]) {
    const { found } = readRule(text, name);
    const old = found.filter((f) => f.status === "outdated");
    if (!old.length) continue;
    let currentThere = found.some((f) => f.status === "current");
    for (const f of old) {
      if (currentThere) {
        drop.add(f.index);
        removed += 1;
        continue;
      }
      const raw = lines[f.index];
      const cr = raw.endsWith("\r") ? "\r" : "";
      const prefix = raw.replace(/\r$/, "").match(/^(\s*[-*+]\s+)/)?.[1] ?? "- ";
      lines[f.index] = `${prefix}${RULES[name][f.lang].current.replace(/^- /, "")}${cr}`;
      replaced += 1;
      currentThere = true;
    }
  }
  return { text: lines.filter((_, i) => !drop.has(i)).join("\n"), replaced, removed };
}

// ─── Reading a page ───────────────────────────────────────────────────────────

/** The words after which an expression starts: a string or a regular expression may follow them. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof", "from", "import", "export", "default", "as", "satisfies", "extends", "module"]);
/** The punctuation after which an expression starts. Never a closing brace: in JSX, what follows
 *  `{name}` is text (`{name}'s`), or the slash of a self-closing tag (`<A b={c} />`). */
const BEFORE_EXPRESSION_CHARS = "(,=:[!&|?{;~+-*%<>^";

/**
 * The source with its comments, and the insides of its strings, template literals and regular
 * expressions, turned into spaces (line breaks kept): what is left is the code, at the same offsets.
 * A quote opens a string only where an expression can start (after a punctuation or a keyword, never
 * right after a word): an apostrophe in JSX text (`l'été`) is text. A quote that meets a line break
 * before its closing one is not a string either.
 */
export function maskSource(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b && k < n; k += 1) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let prevChar = "";
  let prevWord = "";
  const regexEnd = (i) => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const ch = src[j];
      if (ch === "\n" || ch === "\r") return -1;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1;
        return j;
      }
      j += 1;
    }
    return -1;
  };
  const template = (start) => {
    let i = start;
    let from = start;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(from, i);
        return i + 1;
      }
      if (c === "$" && src[i + 1] === "{") {
        blank(from, i);
        const close = code(i + 2, true);
        i = close + 1;
        from = i;
        continue;
      }
      i += 1;
    }
    blank(from, n);
    return n;
  };
  // Code until the end, or (inside a template's ${...}) until the brace that closes it.
  const code = (start, inExpression) => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "/" && d === "/") {
        let e = src.indexOf("\n", i);
        if (e < 0) e = n;
        blank(i, e);
        i = e;
        continue;
      }
      if (c === "/" && d === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e < 0 ? n : e + 2;
        blank(i, end);
        i = end;
        continue;
      }
      const expressionStarts = prevChar === "" || BEFORE_EXPRESSION_CHARS.includes(prevChar) || BEFORE_EXPRESSION.has(prevWord);
      if (c === "'" || c === '"') {
        if (expressionStarts) {
          let j = i + 1;
          while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
          if (j < n && src[j] === c) {
            blank(i + 1, j);
            i = j + 1;
            prevChar = c;
            prevWord = "";
            continue;
          }
        }
        prevChar = c;
        prevWord = "";
        i += 1;
        continue;
      }
      if (c === "`") {
        i = template(i + 1);
        prevChar = "`";
        prevWord = "";
        continue;
      }
      if (c === "/" && expressionStarts) {
        const end = regexEnd(i);
        if (end > 0) {
          blank(i + 1, end);
          i = end;
          prevChar = "/";
          prevWord = "";
          continue;
        }
      }
      if (inExpression) {
        if (c === "{") depth += 1;
        else if (c === "}") {
          if (depth === 0) return i;
          depth -= 1;
        }
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(src[j])) j += 1;
        prevWord = src.slice(i, j);
        prevChar = src[j - 1];
        i = j;
        continue;
      }
      if (!/\s/.test(c)) {
        prevChar = c;
        prevWord = "";
      }
      i += 1;
    }
    return n;
  };
  code(0, false);
  return out.join("");
}

/** The index of the bracket that closes the one at `open`, counting only that kind of bracket in
 *  the masked source; -1 when it is not closed. */
function closing(masked, open) {
  const o = masked[open];
  const c = { "(": ")", "{": "}", "[": "]" }[o];
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === o) depth += 1;
    else if (masked[i] === c) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The indexes of a word at the top level of the masked source (outside every bracket). */
function topLevel(masked, word) {
  const at = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && masked.startsWith(word, i) && !/[\w$]/.test(masked[i - 1] ?? "") && !/[\w$]/.test(masked[i + word.length] ?? "")) at.push(i);
  }
  return at;
}

const skipSpace = (masked, i) => {
  let j = i;
  while (j < masked.length && /\s/.test(masked[j])) j += 1;
  return j;
};

/** The calls that read the session, the admin or a role, and the kind of check each one makes. */
const READS = { auth: "session", getServerAuthSession: "session", getServerSession: "session", currentUser: "session", getSession: "session", isAdmin: "admin", hasRole: "role", getRoles: "role" };
/** The calls that close by themselves (they redirect when their check fails). */
const GATE_CALLS = { requireAdmin: "admin", requireRole: "role", requireUser: "session", requireAuth: "session" };
/** What stops a visitor: a redirect, or a page that does not exist for them. */
const STOPS = /\b(?:redirect|notFound|permanentRedirect)\s*\(/;
const KINDS = ["admin", "role", "session"];
/** The stronger of two kinds of check: the admin, then a role, then a session. */
const stronger = (a, b) => (a && b ? KINDS[Math.min(KINDS.indexOf(a), KINDS.indexOf(b))] : a ?? b ?? null);

/** The two first statements that close a page to anyone but the admin. requireAdmin() may take one
 *  plain string, as a project's own helper does (`await requireAdmin("/admin")`, the page to come
 *  back to): read on the masked source, where a comment or a string that holds the words is blank. */
const FIRST_REQUIRE_ADMIN = /^await\s+requireAdmin\s*\(\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`$\n]*`)?\s*\)/;
const FIRST_IS_ADMIN = /^if\s*\(\s*!\s*(?:\(\s*await\s+isAdmin\s*\(\s*\)\s*\)|await\s+isAdmin\s*\(\s*\))\s*\)\s*\{?\s*(?:return\s+)?(?:redirect|notFound|permanentRedirect)\s*\(/;
/** A plain type annotation: nothing in it that could be taken for code (no brace, no parenthesis). */
const PLAIN_TYPE = /^[\s\w.$<>,[\]|&?]*$/;
const BOM = String.fromCharCode(0xfeff);

/** What says that nothing is there. */
const NULLISH = /^(?:null|undefined|void\s+0)$/;
/** A name that holds a session whatever gives it (`session`, `authSession`, `useSession`). */
const SESSION_NAME = /^[A-Za-z_$][\w$]*[sS]ession$|^session$/;
/** A role named in a comparison (`role !== "x"`, `user.roles`): read as a role there, as before. */
const ROLE_NAME = /\broles?\b|[a-z0-9]Roles?\b/;
/** The properties that only say who is signed in: true as soon as someone is. */
const IDENTITY = new Set(["user", "id", "email", "name", "image", "sub", "userId", "uid", "data", "expires"]);
/**
 * A condition is read in three cases: nobody signed in, someone signed in who is neither the admin nor
 * of the role tested, and the admin (or that role) signed in. 1 true, 0 false, U unknown.
 */
const U = 0.5;
const UNKNOWN = [U, U, U];
const escapeName = (name) => name.replace(/\$/g, "\\$");

/** The strongest kind of what a masked piece of code reads, or null when it reads nothing. */
function readKind(text, vars, roleNames = false) {
  let kind = null;
  for (const [name, k] of Object.entries(READS)) if (new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(text)) kind = stronger(kind, k);
  for (const [name, v] of vars) if (new RegExp(`(?<![\\w$.])${escapeName(name)}(?![\\w$])`).test(text)) kind = stronger(kind, v.kind);
  for (const m of text.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) if (SESSION_NAME.test(m[0])) kind = stronger(kind, "session");
  if (roleNames && ROLE_NAME.test(text)) kind = stronger(kind, "role");
  return kind;
}

/** The masked range with what is inside its brackets turned into spaces: its top level only. */
function flat(m, s, e) {
  let depth = 0;
  let out = "";
  for (let i = s; i < e; i += 1) {
    const c = m[i];
    if (c === ")" || c === "]" || c === "}") depth -= 1;
    out += depth > 0 ? " " : c;
    if (c === "(" || c === "[" || c === "{") depth += 1;
  }
  return out;
}

/** The pieces of a masked range split on an operator found at its top level. */
function splitTop(m, s, e, op) {
  const top = flat(m, s, e);
  const parts = [];
  let from = 0;
  for (let i = top.indexOf(op); i >= 0; i = top.indexOf(op, i + op.length)) {
    parts.push([s + from, s + i]);
    from = i + op.length;
  }
  parts.push([s + from, e]);
  return parts;
}

/** The arguments of a call, between its parentheses. */
function argsOf(m, s, e) {
  return s >= e || !m.slice(s, e).trim() ? [] : splitTop(m, s, e, ",");
}

/**
 * A chain read from its head (`session?.user?.id`, `(await auth())?.user`, `hasRole(s, ["x"])`): the
 * name at its head, its properties, its calls, and whether the head itself is called. null when the
 * range is something else.
 */
function chainOf(m, s, e) {
  let i = skipSpace(m, s);
  let ch;
  if (m[i] === "(") {
    const c = closing(m, i);
    if (c < 0 || c >= e) return null;
    let j = skipSpace(m, i + 1);
    if (/^await\b/.test(m.slice(j, c))) j += 5;
    const inner = chainOf(m, j, c);
    if (!inner) return null;
    ch = { ...inner, props: [...inner.props], calls: [...inner.calls] };
    i = c + 1;
  } else {
    const id = /^[A-Za-z_$][\w$]*/.exec(m.slice(i, e));
    if (!id) return null;
    ch = { name: id[0], props: [], calls: [], headCalled: false };
    i += id[0].length;
  }
  while (i < e) {
    if (/\s/.test(m[i])) {
      i += 1;
      continue;
    }
    // A non-null assertion (`session!.user`).
    if (m[i] === "!" && m[i + 1] !== "=") {
      i += 1;
      continue;
    }
    let dot = false;
    if (m.startsWith("?.", i)) {
      i = skipSpace(m, i + 2);
      dot = true;
    } else if (m[i] === ".") {
      i = skipSpace(m, i + 1);
      dot = true;
    }
    if (i >= e) return null;
    if (m[i] === "(" || m[i] === "[") {
      const k = closing(m, i);
      if (k < 0 || k >= e) return null;
      if (m[i] === "(") {
        if (!ch.props.length && !ch.calls.length) ch.headCalled = true;
        ch.calls.push([i + 1, k]);
      } else ch.props.push("[]");
      i = k + 1;
      continue;
    }
    if (!dot) return null;
    const id = /^#?[A-Za-z_$][\w$]*/.exec(m.slice(i, e));
    if (!id) return null;
    ch.props.push(id[0]);
    i += id[0].length;
  }
  return ch;
}

/** The head of a chain when it is a read: a read call, a variable that holds one, a session's name. */
function headOf(ch, vars) {
  if (READS[ch.name] && ch.headCalled) return { kind: READS[ch.name] };
  if (vars.has(ch.name)) return vars.get(ch.name);
  if (SESSION_NAME.test(ch.name)) return { kind: "session" };
  return null;
}

/** Whether an argument is a plain read (`session`, `await auth()`, `session?.user?.email`). */
function plainRead(m, s, e, vars) {
  let i = skipSpace(m, s);
  if (/^await\b/.test(m.slice(i, e))) i += 5;
  const ch = chainOf(m, i, e);
  return Boolean(ch && headOf(ch, vars));
}

/** One operand that is neither a comparison nor a combination: a chain, a call, or another form. */
function leafOf(m, r, s, e, vars) {
  if (!readKind(m.slice(s, e), vars)) return { s: UNKNOWN, kind: null };
  const ch = chainOf(m, s, e);
  if (!ch) return { s: UNKNOWN, kind: "role" };
  const raw = r.slice(s, e);
  const admin = /admin/i.test(raw);
  const head = headOf(ch, vars);
  if (head) {
    const ownCalls = ch.calls.length - (ch.headCalled ? 1 : 0);
    if (head.s && !ch.props.length && !ownCalls) return { s: head.s, kind: admin ? "admin" : head.kind };
    if (head.kind !== "session" || admin) return { s: [0, 0, 1], kind: admin ? "admin" : head.kind };
    if (ROLE_NAME.test(raw)) return { s: [0, 0, 1], kind: "role" };
    if (!ownCalls && ch.props.every((p) => IDENTITY.has(p))) return { s: [0, 1, 1], kind: "session" };
    return { s: [0, U, U], kind: "session" };
  }
  // A check of the project's own that receives a plain read (`estAdmin(session?.user?.email)`): false
  // when nobody is signed in; about the admin when it names it, a role otherwise. Anything less plain
  // (a read with a fallback) cannot be read for sure.
  for (const [a, b] of ch.calls) {
    for (const [x, y] of argsOf(m, a, b)) if (readKind(m.slice(x, y), vars) && !plainRead(m, x, y, vars)) return { s: UNKNOWN, kind: "role" };
  }
  return admin ? { s: [0, 0, 1], kind: "admin" } : { s: [0, U, U], kind: "role" };
}

/** A comparison: by `===`/`==` or `!==`/`!=`, to null, to false, or to another value. */
function compareOf(m, r, s, e, at, op, vars) {
  const left = [s, at];
  const right = [at + op.length, e];
  const lr = readKind(m.slice(...left), vars, true);
  const rr = readKind(m.slice(...right), vars, true);
  if (!lr && !rr) return { s: UNKNOWN, kind: null };
  const read = lr ? left : right;
  const value = m.slice(...(lr ? right : left)).trim();
  const eq = op[0] === "=";
  const admin = /admin/i.test(r.slice(s, e));
  if (NULLISH.test(value)) return { s: eq ? [1, 0, 0] : [0, 1, 1], kind: admin ? "admin" : lr ?? rr };
  if (eq && value === "false") {
    const side = evaluate(m, r, read[0], read[1], vars);
    return { s: side.s.map((x) => 1 - x), kind: admin ? "admin" : side.kind ?? "role" };
  }
  return { s: eq ? [0, 0, 1] : [1, 1, 0], kind: admin ? "admin" : "role" };
}

/**
 * The truth of a masked condition in the three cases, and the kind of what it reads (null when it
 * reads nothing). A form that reads the session but is not one of those the rule knows is unknown.
 */
export function evaluate(m, r, s, e, vars) {
  while (s < e && /\s/.test(m[s])) s += 1;
  while (e > s && /\s/.test(m[e - 1])) e -= 1;
  const none = { s: UNKNOWN, kind: null };
  if (s >= e) return none;
  if (m[s] === "(" && closing(m, s) === e - 1) return evaluate(m, r, s + 1, e - 1, vars);
  const text = m.slice(s, e);
  if (!readKind(text, vars, true)) return none;
  const strict = readKind(text, vars);
  const other = strict ? { s: UNKNOWN, kind: "role" } : none;
  const top = flat(m, s, e);
  // A ternary, `??`, an assignment, a comma: another form.
  if (/\?(?!\.)|,|(?:^|[^=!<>])=(?![=>])/.test(top)) return other;
  for (const op of ["||", "&&"]) {
    const parts = splitTop(m, s, e, op);
    if (parts.length > 1) {
      const vals = parts.map(([a, b]) => evaluate(m, r, a, b, vars));
      const pick = op === "||" ? Math.max : Math.min;
      return { op, parts: vals, s: [0, 1, 2].map((i) => pick(...vals.map((v) => v.s[i]))), kind: vals.reduce((k, v) => stronger(k, v.kind), null) };
    }
  }
  const eqs = [...top.matchAll(/===|!==|==|!=/g)];
  if (eqs.length > 1) return other;
  if (eqs.length === 1) return compareOf(m, r, s, e, s + eqs[0].index, eqs[0][0], vars);
  if (!strict) return none;
  if (/[<>+\-*/%^~|&]|\b(?:in|instanceof|as|satisfies|typeof|void|delete|new)\b/.test(top)) return other;
  if (m[s] === "!") {
    const v = evaluate(m, r, s + 1, e, vars);
    return { s: v.s.map((x) => 1 - x), kind: v.kind };
  }
  if (/^await\b/.test(text)) return evaluate(m, r, s + 5, e, vars);
  return leafOf(m, r, s, e, vars);
}

/**
 * Whether a condition is a gate, of which kind, and for sure or in doubt: true for a visitor who lacks
 * the session, the admin or the role (nobody signed in; or someone signed in while the admin is let
 * through), or unknown there. A combination by `||` is a gate as soon as one of its parts is; a part of
 * a `&&` that would be a gate on its own makes the whole a gate in doubt.
 */
function gateOfNode(node, masked = false) {
  const [A, B, F] = node.s;
  let kind = null;
  let definite = false;
  if (node.kind && (A > 0 || (B > 0 && F === 0))) {
    kind = node.kind;
    definite = !masked && (A === 1 || (B === 1 && F === 0));
  }
  for (const p of node.parts ?? []) {
    const g = gateOfNode(p, masked || node.op === "&&");
    if (g) {
      kind = stronger(kind, g.kind);
      definite ||= g.definite;
    }
  }
  return kind ? { kind, definite } : null;
}

/**
 * Whether the condition of an `if` (the masked range [s, e) of the flow, `raw` its text at the same
 * offsets) closes the page, and how: "admin", "role", "session", or null. NOT a gate: a read on its own
 * (`session`, `session?.user?.id`, `await isAdmin()`, `hasRole(...)`), an equality to a value
 * (`role === "admin"`), `!== null`, and their `&&`. A gate: a negation of what reads (`!session`,
 * `!(await isAdmin())`, `!estAdmin(session?.user?.email)`), `!==` to a value (`id !== "admin"`,
 * `email !== process.env.ADMIN_EMAIL`), an equality to null, a `||` one part of which is a gate, and,
 * in doubt, any other form that reads the session. The kind: the admin when the value compared or the
 * call negated names it, a role for another value, the session for a plain negation; a gate in doubt is
 * never taken for the admin's, so that nothing is written for it without the person.
 */
export function guardIn(flow, raw, s, e, vars) {
  const g = gateOfNode(evaluate(flow, raw, s, e, vars));
  if (!g) return null;
  return g.definite || g.kind !== "admin" ? g.kind : "role";
}

/**
 * The variables a flow assigns from a read: a name or a destructured one, with what they hold. A name
 * assigned from a form whose truth for a visitor without a session is known (`session?.user`,
 * `session?.user?.role === "admin"`) holds it; a read with a fallback (`?? "fr"`) is not followed.
 */
function varsOf(flow, raw) {
  const vars = new Map();
  const decls = [];
  for (const m of flow.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=(?![=>])/g)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let end = flow.length;
    for (let i = start; i < flow.length; i += 1) {
      const c = flow[i];
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth -= 1;
      } else if (depth === 0 && (c === ";" || c === "\n")) {
        end = i;
        break;
      }
    }
    decls.push([m[1], start, end]);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    let added = false;
    for (const [target, s, e] of decls) {
      const rhs = readKind(flow.slice(s, e), vars);
      if (!rhs) continue;
      if (target.startsWith("{")) {
        for (const part of target.slice(1, -1).split(",")) {
          const name = part.split(":").pop().trim().split(/[\s=]/)[0];
          if (!/^[A-Za-z_$][\w$]*$/.test(name) || vars.has(name)) continue;
          const kind = /admin/i.test(name) ? "admin" : ROLE_NAME.test(name) ? "role" : rhs;
          vars.set(name, { kind, s: kind === "session" ? [0, 1, 1] : [0, 0, 1] });
          added = true;
        }
      } else if (!vars.has(target)) {
        const v = evaluate(flow, raw, s, e, vars);
        if (v.kind && (v.s[0] === 0 || v.s[0] === 1)) {
          vars.set(target, { kind: v.kind, s: v.s });
          added = true;
        }
      }
    }
    if (!added) break;
  }
  return vars;
}

/**
 * Whether a function closes itself, and how: "admin", "role", "session", or null, read in its own
 * flow (its body, masked, the functions declared in it left out; `raw`, its text at the same offsets).
 * Only two things close it: a guard call (requireAdmin(), requireRole(), requireUser(), requireAuth()),
 * or an `if` whose condition is a gate (guardIn) and whose branch redirects or calls notFound(). A
 * redirect when the session IS there (a sign-in layout sending a signed-in visitor home) closes
 * nothing; neither does a session read for a menu next to a redirect for something else (next-intl's
 * notFound() for an unknown language).
 */
export function gateOf(flow, raw = flow) {
  let kind = null;
  for (const [call, k] of Object.entries(GATE_CALLS)) if (new RegExp(`\\b${call}\\s*\\(`).test(flow)) kind = stronger(kind, k);
  const vars = varsOf(flow, raw);
  for (const m of flow.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closing(flow, open);
    if (close < 0) continue;
    // Its branch: a block, or one statement.
    const k = skipSpace(flow, close + 1);
    let end = flow.length;
    if (flow[k] === "{") end = closing(flow, k) < 0 ? flow.length : closing(flow, k) + 1;
    else {
      const stop = /[;\n]/.exec(flow.slice(k));
      if (stop) end = k + stop.index + 1;
    }
    if (!STOPS.test(flow.slice(k, end))) continue;
    const g = guardIn(flow, raw, open + 1, close, vars);
    if (g) kind = stronger(kind, g);
  }
  return kind;
}

/** The block body of a function whose `function` keyword is at `at`, or why it cannot be read. */
function functionBody(masked, at) {
  let j = skipSpace(masked, at + 8);
  if (masked[j] === "*") return { why: "a generator" };
  const name = /^[A-Za-z_$][\w$]*/.exec(masked.slice(j));
  if (name) j = skipSpace(masked, j + name[0].length);
  if (masked[j] === "<") return { why: "type parameters" };
  if (masked[j] !== "(") return { why: "its parameters" };
  const paramsEnd = closing(masked, j);
  if (paramsEnd < 0) return { why: "its parameters" };
  j = skipSpace(masked, paramsEnd + 1);
  if (masked[j] === ":") {
    const brace = masked.indexOf("{", j);
    if (brace < 0 || !PLAIN_TYPE.test(masked.slice(j + 1, brace))) return { why: "its return type" };
    j = brace;
  }
  if (masked[j] !== "{") return { why: "its body" };
  const close = closing(masked, j);
  return close < 0 ? { why: "its body" } : { open: j, close };
}

/** The block body of an arrow function that starts at `at` (`async`, its parameters, or the name of
 *  its single parameter), or why it cannot be read. */
function arrowBody(masked, at) {
  let j = at;
  if (/^async\b/.test(masked.slice(j))) j = skipSpace(masked, j + 5);
  if (masked[j] === "<") return { why: "type parameters" };
  if (masked[j] === "(") {
    const end = closing(masked, j);
    if (end < 0) return { why: "its parameters" };
    j = skipSpace(masked, end + 1);
    if (masked[j] === ":") {
      const arrow = masked.indexOf("=>", j);
      if (arrow < 0 || !PLAIN_TYPE.test(masked.slice(j + 1, arrow))) return { why: "its return type" };
      j = arrow;
    }
  } else {
    const name = /^[A-Za-z_$][\w$]*/.exec(masked.slice(j));
    if (!name) return { why: "its parameters" };
    j = skipSpace(masked, j + name[0].length);
  }
  if (!masked.startsWith("=>", j)) return { why: "its form" };
  j = skipSpace(masked, j + 2);
  if (masked[j] !== "{") return { why: "a body without braces" };
  const close = closing(masked, j);
  return close < 0 ? { why: "its body" } : { open: j, close };
}

/**
 * A masked body with the bodies of the functions declared in it turned into spaces: what the function
 * does itself (a check, a redirect), not what a nested function or a "use server" action would do once
 * called.
 */
export function withoutNestedFunctions(masked) {
  let out = masked;
  const blank = (open, close) => {
    out = out.slice(0, open + 1) + out.slice(open + 1, close).replace(/[^\r\n]/g, " ") + out.slice(close);
  };
  for (let i = 0; i < out.length; i += 1) {
    if (out.startsWith("function", i) && !/[\w$]/.test(out[i - 1] ?? "") && !/[\w$]/.test(out[i + 8] ?? "")) {
      const b = functionBody(out, i);
      if (b.open !== undefined) {
        blank(b.open, b.close);
        i = b.close;
      }
    } else if (out.startsWith("=>", i)) {
      const k = skipSpace(out, i + 2);
      const close = out[k] === "{" ? closing(out, k) : -1;
      if (close > 0) {
        blank(k, close);
        i = close;
      }
    }
  }
  return out;
}

/** The body of the function that a top-level name holds (`function Name(`, `const Name = ...`). */
function namedBody(masked, name) {
  const id = name.replace(/\$/g, "\\$");
  for (const at of topLevel(masked, "function")) {
    if (new RegExp(`^function\\s*\\*?\\s*${id}\\s*[(<]`).test(masked.slice(at, at + 200))) return functionBody(masked, at);
  }
  for (const kw of ["const", "let", "var"]) {
    for (const at of topLevel(masked, kw)) {
      const m = new RegExp(`^${kw}\\s+${id}\\s*(?::([^=]*))?=\\s*`).exec(masked.slice(at, at + 400));
      if (!m) continue;
      if (m[1] !== undefined && !PLAIN_TYPE.test(m[1])) return { why: "its type" };
      const rhs = at + m[0].length;
      if (/^(?:async\s+)?function\b/.test(masked.slice(rhs, rhs + 40))) return functionBody(masked, masked.indexOf("function", rhs));
      return arrowBody(masked, rhs);
    }
  }
  return { why: "where the name is defined" };
}

/**
 * What a page or layout file is: a client component, or the form of its default export (`function`,
 * `arrow`, `name`, `reexport`, `class`, `other`, `none`, `unreadable`). When the body of its function
 * can be read, whatever the form: how it starts (`first`: `requireAdmin`, `isAdmin` or null), what it
 * does itself (`flow`: its body masked, nested functions left out) and whether that closes it
 * (`gate`, by gateOf). For a function declaration, where `function` and its body are, whether it is
 * async, and the file's imports: what fixPage() needs.
 */
export function readPage(src) {
  const text = src.startsWith(BOM) ? src.slice(1) : src;
  const offset = src.length - text.length;
  const masked = maskSource(text);
  // The directives at the head of the file ("use client" among them).
  let client = false;
  for (let i = skipSpace(masked, 0); ; ) {
    const m = /^(['"])(use [a-z ]+)\1\s*;?/.exec(text.slice(i));
    if (!m) break;
    if (m[2] === "use client") client = true;
    i = skipSpace(masked, i + m[0].length);
  }
  const info = { client, form: "none", offset, text, masked, imports: [] };
  if (client) return info;

  // The imports, and a requireAdmin of the file's own or imported from another module.
  for (const at of topLevel(masked, "import")) {
    const next = skipSpace(masked, at + 6);
    if (masked[next] === "(" || masked[next] === ".") continue;
    let q = next;
    while (q < masked.length && masked[q] !== '"' && masked[q] !== "'" && masked[q] !== ";") q += 1;
    const close = masked[q] === '"' || masked[q] === "'" ? masked.indexOf(masked[q], q + 1) : -1;
    if (close < 0) return { ...info, form: "unreadable", why: "its imports" };
    let end = close + 1;
    const semi = /^[ \t]*;/.exec(masked.slice(end));
    if (semi) end += semi[0].length;
    info.imports.push({ end, quote: masked[q], semi: Boolean(semi), from: text.slice(q + 1, close), clause: masked.slice(at, q) });
  }
  info.importsRequireAdmin = info.imports.find((im) => /\brequireAdmin\b/.test(im.clause))?.from ?? null;
  info.definesRequireAdmin = /\b(?:function|const|let|var|class)\s+requireAdmin\b/.test(masked);

  const exp = topLevel(masked, "export").find((i) => /^export\s+default\b/.test(masked.slice(i, i + 40)));
  if (exp === undefined) {
    info.form = topLevel(masked, "export").some((i) => /^export\s*\{[^}]*\bdefault\b/.test(masked.slice(i, i + 400))) ? "reexport" : "none";
    return info;
  }
  info.exportAt = exp;
  const i = skipSpace(masked, exp + /^export\s+default/.exec(masked.slice(exp))[0].length);
  const rest = masked.slice(i, i + 400);
  let body;
  const fn = /^(async\s+)?function\b/.exec(rest);
  if (fn) {
    info.form = "function";
    info.async = Boolean(fn[1]);
    info.fnAt = i + (fn[1] ? fn[1].length : 0);
    body = functionBody(masked, info.fnAt);
  } else if (/^class\b/.test(rest)) {
    info.form = "class";
    return info;
  } else if (/^(?:async\b\s*)?(?:\(|<|[A-Za-z_$][\w$]*\s*=>)/.test(rest)) {
    info.form = "arrow";
    body = arrowBody(masked, i);
  } else if (/^[A-Za-z_$][\w$]*\s*(?:;|\n|$)/.test(rest)) {
    info.form = "name";
    body = namedBody(masked, /^[A-Za-z_$][\w$]*/.exec(rest)[0]);
  } else {
    info.form = "other";
    return info;
  }
  if (body.why) {
    info.why = body.why;
    if (info.form === "function") info.form = "unreadable";
    return info;
  }
  info.bodyOpen = body.open;
  info.bodyEnd = body.close;
  const head = masked.slice(skipSpace(masked, body.open + 1), body.close);
  info.first = FIRST_REQUIRE_ADMIN.test(head) ? "requireAdmin" : FIRST_IS_ADMIN.test(head) ? "isAdmin" : null;
  info.flow = withoutNestedFunctions(masked.slice(body.open + 1, body.close));
  info.gate = gateOf(info.flow, text.slice(body.open + 1, body.close));
  return info;
}

/**
 * The page with `await requireAdmin();` as the first statement of its default function, the import
 * added after the last one (in the file's own quotes, with or without its semicolons), `async` added
 * when the function was not: nothing else moves. null when the page is not a function declaration
 * that can take it, or when the result would not read as a checked page.
 */
export function fixPage(src) {
  const info = readPage(src);
  if (info.client || info.form !== "function" || info.first || info.bodyOpen === undefined) return null;
  const { text, masked, offset } = info;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const last = info.imports.at(-1);
  const quote = last ? last.quote : '"';
  const semi = last ? last.semi : true;
  const stmt = `await requireAdmin()${semi ? ";" : ""}`;
  const inserts = [];
  // The statement first in the body, at the indentation of the body's first line.
  const body = text.slice(info.bodyOpen + 1, info.bodyEnd);
  const lineBreak = /^[ \t]*\r?\n/.exec(body);
  if (lineBreak) {
    const firstLine = body.slice(lineBreak[0].length).split(/\r?\n/).find((l) => l.trim());
    const lineStart = text.lastIndexOf("\n", info.exportAt) + 1;
    const indent = firstLine !== undefined ? /^[ \t]*/.exec(firstLine)[0] : `${/^[ \t]*/.exec(text.slice(lineStart))[0]}  `;
    inserts.push([info.bodyOpen + 1, `${eol}${indent}${stmt}`]);
  } else {
    inserts.push([info.bodyOpen + 1, ` ${stmt}${body.trim() ? "" : " "}`]);
  }
  if (!info.async) inserts.push([info.fnAt, "async "]);
  if (!info.importsRequireAdmin) {
    const line = `import { requireAdmin } from ${quote}~/server/require-admin${quote}${semi ? ";" : ""}`;
    if (last) {
      const nl = text.indexOf("\n", last.end);
      inserts.push(nl < 0 ? [text.length, `${eol}${line}`] : [nl + 1, `${line}${eol}`]);
    } else {
      const at = skipSpace(masked, 0);
      inserts.push([text.lastIndexOf("\n", at - 1) + 1, `${line}${eol}`]);
    }
  }
  let out = text;
  for (const [at, piece] of inserts.sort((a, b) => b[0] - a[0])) out = out.slice(0, at) + piece + out.slice(at);
  const again = readPage(out);
  if (again.form !== "function" || again.first !== "requireAdmin") return null;
  return src.slice(0, offset) + out;
}

// ─── A project ────────────────────────────────────────────────────────────────

const PAGE_FILE = /^page\.(tsx|jsx|ts|js)$/;
const LAYOUT_FILE = /^layout\.(tsx|jsx|ts|js)$/;
const AUTH_FILES = ["src/server/auth.ts", "src/server/auth.tsx", "src/server/auth/index.ts", "src/server/auth.js", "src/server/auth/index.js"];
const skippedDir = (name) => name.startsWith(".") || name.startsWith("_") || name === "node_modules";
const slash = (p) => p.split(sep).join("/");

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function dependsOnNext(dir) {
  const text = readText(join(dir, "package.json"));
  if (text === null) return false;
  try {
    const pkg = JSON.parse(text);
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.next);
  } catch {
    return false;
  }
}

/** The Next.js apps of a project: its root, and the apps/* of a monorepo. */
export function nextApps(dir) {
  const apps = dependsOnNext(dir) ? ["."] : [];
  try {
    for (const e of readdirSync(join(dir, "apps"), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && dependsOnNext(join(dir, "apps", e.name))) apps.push(`apps/${e.name}`);
    }
  } catch {
    // No apps folder.
  }
  return apps;
}

/**
 * How a layout closes its pages: "admin", "role", "session", or "none". Its gate is what its own
 * function does (gateOf: a guard call, or a redirect when the session, the admin or a role is
 * missing); a layout that cannot be read that way is judged on its whole text.
 */
function layoutGuard(src) {
  const text = src ?? "";
  const info = readPage(text);
  return (info.flow !== undefined ? info.gate : gateOf(maskSource(text), text)) ?? "none";
}

/** The pages and layouts of an app's src/app, with the folders that lead to each. */
function walkApp(appDir, unreadable, projectDir) {
  const root = join(appDir, "src", "app");
  const pages = [];
  const layouts = new Map();
  let seen = 0;
  const visit = (dir, segs) => {
    if (segs.length > 24 || seen > 20000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      unreadable.push({ path: slash(relative(projectDir, dir)) || ".", error: e.code ?? String(e.message) });
      return;
    }
    for (const e of entries) {
      seen += 1;
      if (e.isDirectory()) {
        if (!skippedDir(e.name)) visit(join(dir, e.name), [...segs, e.name]);
      } else if (e.isFile()) {
        if (PAGE_FILE.test(e.name)) pages.push({ segs, file: join(dir, e.name) });
        else if (LAYOUT_FILE.test(e.name)) layouts.set(segs.join("/"), join(dir, e.name));
      }
    }
  };
  if (existsSync(root)) visit(root, []);
  return { pages, layouts };
}

const inAdminSpace = (segs) => segs.some((s, i) => s === "admin" && segs[i + 1] === "(protected)");
/** A sign-in page of the admin space: .../admin/signin, route groups allowed in between. */
function isAdminSignin(segs) {
  if (segs.at(-1) !== "signin") return false;
  for (let i = segs.length - 2; i >= 0; i -= 1) {
    if (segs[i] === "admin") return true;
    if (!/^\(.*\)$/.test(segs[i])) return false;
  }
  return false;
}

function tsconfigHasAlias(appDir) {
  const text = readText(join(appDir, "tsconfig.json"));
  if (text === null) return false;
  if (/["']~\/\*["']\s*:/.test(text)) return true;
  const ext = /"extends"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (ext && ext.startsWith(".")) {
    const base = readText(resolve(appDir, ext.endsWith(".json") ? ext : `${ext}.json`));
    return base !== null && /["']~\/\*["']\s*:/.test(base);
  }
  return false;
}

/**
 * The major version of a package the app runs: the installed one first (its node_modules, then those
 * of the folders above it up to the project's own, where a monorepo hoists it), then the range of its
 * package.json; null when neither says (a tag such as "beta", a workspace link). As admin-gate.mjs
 * reads Next.js.
 */
function majorOf(appDir, projectDir, name) {
  const top = resolve(projectDir);
  for (let d = resolve(appDir); ; d = dirname(d)) {
    const text = readText(join(d, "node_modules", name, "package.json"));
    if (text !== null) {
      try {
        const major = Number(String(JSON.parse(text).version).split(".")[0]);
        if (Number.isInteger(major) && major > 0) return major;
      } catch {
        // An unreadable copy: the range says it.
      }
      break;
    }
    if (same(d) === same(top) || dirname(d) === d) break;
  }
  try {
    const pkg = JSON.parse(readText(join(appDir, "package.json")) ?? "{}");
    const range = String({ ...pkg.devDependencies, ...pkg.dependencies }[name] ?? "");
    const m = range.match(/^[\^~>=v\s]*(\d+)(?:\.|$)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** The files of the app's authentication: src/server/auth.* and what src/server/auth/ holds. */
function authSources(appDir) {
  const files = AUTH_FILES.filter((f) => existsSync(join(appDir, f)));
  try {
    for (const e of readdirSync(join(appDir, "src", "server", "auth"), { withFileTypes: true })) {
      if (e.isFile() && /\.(ts|tsx|js|mjs)$/.test(e.name)) files.push(`src/server/auth/${e.name}`);
    }
  } catch {
    // No auth folder.
  }
  return [...new Set(files)];
}

/**
 * What the app offers the templates: requireAdmin() needs `isAdmin` from ~/server/auth, the `~/`
 * alias and an admin sign-in page (where it sends a visitor), unless the project has its own helper.
 * The barrier sends a request without the session cookie of Auth.js 5 (`authjs.session-token`) to
 * /admin/signin: it is posed only where that page exists and that cookie is the project's, never on
 * a next-auth older than 5 (its cookie is `next-auth.session-token`) nor on a configuration that
 * renames the session cookie, where it would send the administrator back to sign-in forever.
 */
function appContext(appDir, projectDir, signin) {
  const authFile = AUTH_FILES.find((f) => existsSync(join(appDir, f))) ?? null;
  const authSrc = authFile ? readText(join(appDir, authFile)) ?? "" : "";
  const authMasked = maskSource(authSrc);
  const isAdmin = /\bexport\s+(?:async\s+)?function\s+isAdmin\b|\bexport\s+(?:const|let)\s+isAdmin\b|\bexport\s*\{[^}]*\bisAdmin\b[^}]*\}/.test(authMasked);
  const modes = (/^\/\/\s*hypervibe:auth-modes\s+(.+)$/m.exec(authSrc)?.[1] ?? "").split(/[,\s]+/).filter(Boolean);
  const hasRole = /\bexport\s+(?:async\s+)?function\s+hasRole\b/.test(maskSource(readText(join(appDir, "src/lib/roles.ts")) ?? ""));
  const helperPresent = existsSync(join(appDir, HELPER_FILE));
  const alias = tsconfigHasAlias(appDir);
  const requireAdmin = helperPresent ? "usable" : !isAdmin ? "no-isAdmin" : !alias ? "no-alias" : !signin ? "no-signin" : "usable";
  const nextAuth = majorOf(appDir, projectDir, "next-auth");
  const customCookie = authSources(appDir).some((f) => /\bcookies\s*:|\bsessionToken\s*:/.test(maskSource(readText(join(appDir, f)) ?? "")));
  const barrier = !signin ? "no-signin" : nextAuth !== null && nextAuth < 5 ? "next-auth-4" : customCookie ? "custom-cookie" : null;
  return { auth: { file: authFile, modes, isAdmin, hasRole, nextAuth, customCookie }, requireAdmin, signin, barrier };
}

const REASONS = {
  "no-isAdmin": "no isAdmin in ~/server/auth: requireAdmin() of the templates relies on it",
  "no-alias": "no ~/ alias in tsconfig.json: the templates import through it",
  "no-signin": "no /admin/signin page: requireAdmin() of the templates sends a visitor there",
};
const FORMS = {
  arrow: "an arrow function",
  name: "a default export of a name",
  reexport: "a re-export",
  class: "a class",
  other: "a form the script does not change",
  none: "no default export",
  unreadable: "a page the script could not read safely",
};

/**
 * The check a page should take, never weaker than what its layout asks: `requireAdmin` when the
 * templates' helper fits and nothing lets in more than the admin; under a layout that closes it
 * otherwise, `layout` (that layout's own check, copied on the page's first lines, the layout named
 * in `layout`); in an admin space that nothing closes, `admin` (the project's own admin check).
 */
function fitFor(guard, ctx, inAdmin) {
  const fix = (guard.kind === "admin" || (guard.kind === "none" && inAdmin)) && ctx.requireAdmin === "usable" ? "requireAdmin" : guard.kind !== "none" ? "layout" : "admin";
  return fix === "layout" ? { fix, layout: guard.file } : { fix };
}

/** One page of the admin space: its status, why, and the check that fits it. */
function adminPage(src, guard, ctx) {
  const fit = fitFor(guard, ctx, true);
  const manual = (reason) => ({ status: "manual", reason, ...fit });
  if (src === null) return manual("unreadable file");
  const info = readPage(src);
  if (info.client) return { status: "client" };
  if (info.first) return { status: "checked" };
  if (guard.kind === "role" || guard.kind === "session") return manual(`its layout lets in more than the admin (by ${guard.kind}): the page takes the layout's own check`);
  if (info.form !== "function") return manual(`${FORMS[info.form] ?? info.form}${info.why ? ` (${info.why})` : ""}`);
  if (info.definesRequireAdmin || (info.importsRequireAdmin && info.importsRequireAdmin !== "~/server/require-admin")) return manual("a requireAdmin of its own");
  if (info.gate) return manual("a check of its own: whether it comes before any read is for Claude to read");
  if (ctx.requireAdmin !== "usable") return manual(REASONS[ctx.requireAdmin]);
  return { status: "to-fix", reason: guard.kind === "admin" ? "protected by its layout only" : "no check, in the page or in its layout" };
}

/** One page of another space closed by its layout: `review` unless it closes itself at least as
 *  strongly as its layout does (a session check under an admin layout lets a member through). */
function spacePage(src, guard, ctx) {
  const fit = fitFor(guard, ctx, false);
  const review = (reason) => ({ status: "review", reason, ...fit });
  if (src === null) return review("unreadable file");
  const info = readPage(src);
  if (info.client) return { status: "client" };
  if (info.first || (info.gate && KINDS.indexOf(info.gate) <= KINDS.indexOf(guard.kind))) return { status: "checked" };
  if (info.gate) return review(`its own check (by ${info.gate}) is weaker than its layout's (by ${guard.kind})`);
  return review(`protected by its layout only (by ${guard.kind === "admin" ? "the admin check" : guard.kind})`);
}

/**
 * The diagnosis of one project. Writes nothing. `git: true` also asks git which of the files the
 * repair would write already have changes not committed.
 */
export function diagnose(dir, { git = false, run = spawnSync, withRedirects = false } = {}) {
  const abs = resolve(dir);
  let stat = null;
  try {
    stat = statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat?.isDirectory()) return { ok: false, step: "read", dir: abs, detail: "not a folder" };
  const pkg = readText(join(abs, "package.json"));
  let name = basename(abs);
  try {
    name = JSON.parse(pkg ?? "{}").name || name;
  } catch {
    // The folder's name.
  }
  const apps = nextApps(abs);
  if (!apps.length) return { dir: abs, name, needed: false, reason: "not-a-next-project" };
  const unreadable = [];
  const counts = { checked: 0, client: 0, toFix: 0, manual: 0, review: 0 };
  const pages = [];
  const appsOut = [];
  for (const app of apps) {
    const appDir = join(abs, app);
    const { pages: found, layouts } = walkApp(appDir, unreadable, abs);
    const ctx = appContext(appDir, abs, found.some((p) => isAdminSignin(p.segs)));
    const guardCache = new Map();
    // The strongest gate of the layouts that wrap a page; among equals, the innermost (its check is
    // the one the page takes).
    const guardOf = (segs) => {
      let kind = "none";
      let file = null;
      for (let k = 0; k <= segs.length; k += 1) {
        const f = layouts.get(segs.slice(0, k).join("/"));
        if (!f) continue;
        if (!guardCache.has(f)) guardCache.set(f, layoutGuard(readText(f)));
        const g = guardCache.get(f);
        if (g !== "none" && (kind === "none" || KINDS.indexOf(g) <= KINDS.indexOf(kind))) {
          kind = g;
          file = f;
        }
      }
      return { kind, file: file ? slash(relative(abs, file)) : null };
    };
    let adminSpace = false;
    let wantsHelper = false;
    for (const p of found) {
      const rel = slash(relative(abs, p.file));
      const src = readText(p.file);
      if (src === null) unreadable.push({ path: rel, error: "unreadable" });
      if (inAdminSpace(p.segs)) {
        adminSpace = true;
        const r = adminPage(src, guardOf(p.segs), ctx);
        counts[r.status === "to-fix" ? "toFix" : r.status] += 1;
        if (r.status === "to-fix" || (r.status === "manual" && r.fix === "requireAdmin")) wantsHelper = true;
        if (r.status === "to-fix" || r.status === "manual") pages.push({ file: rel, ...r, app });
        continue;
      }
      const guard = guardOf(p.segs);
      if (guard.kind === "none") continue;
      const r = spacePage(src, guard, ctx);
      if (r.status === "review") {
        counts.review += 1;
        pages.push({ file: rel, ...r, app });
      }
    }
    const out = { dir: app, next: null, auth: ctx.auth, adminSpace, requireAdmin: adminSpace ? ctx.requireAdmin : null, helper: null, middleware: null };
    if (adminSpace) {
      // What --write will do, and only that: the helper and the barrier go in when a page will call
      // requireAdmin() and the templates fit; otherwise they are `skipped`, with the pages' reason.
      out.writes = wantsHelper && ctx.requireAdmin === "usable";
      const notWritten = out.writes ? null : ctx.requireAdmin !== "usable" ? ctx.requireAdmin : "nothing-to-fix";
      const helper = ensureRequireAdmin(appDir, { check: true });
      out.helper = helper === "would-write" && notWritten ? { status: "skipped", reason: notWritten } : { status: helper };
      const mw = ensureAdminMiddleware(appDir, { check: true });
      out.next = mw.next;
      const barrier = notWritten ?? ctx.barrier;
      out.middleware = mw.status === "would-write" && barrier ? { ...mw, status: "skipped", reason: barrier } : mw;
    }
    appsOut.push(out);
  }
  // The rules files: the project's, and each app's.
  const claudeMd = [];
  for (const where of [...new Set([".", ...apps])]) {
    for (const fileName of RULES_FILES) {
      const file = join(abs, where, fileName);
      if (!existsSync(file)) continue;
      const text = readText(file);
      const rel = slash(relative(abs, file));
      if (text === null) {
        unreadable.push({ path: rel, error: "unreadable" });
        continue;
      }
      claudeMd.push({ file: rel, admin: readRule(text, "admin").status, role: readRule(text, "role").status, users: readRule(text, "users").status });
    }
  }
  const rulesNeeded = claudeMd.some((c) => ["outdated", "edited"].includes(c.admin) || ["outdated", "edited"].includes(c.role));
  // An address from outside (the return address after sign-in, a notification's link) still followed
  // through the filter of the templates from 3.3.11 to 3.4.18, or as it came before them
  // (redirect-filter.mjs). Each line is `fix: "auto"` when it is still the templates' own, word for
  // word (repairRedirects rewrites it), `fix: "manual"` otherwise: /security fixes it, never this
  // script. It counts in `needed` (counts.redirect) only with `withRedirects` (--redirects): the
  // text of /update-hypervibe that announces this repair passes it. The text of 3.4.18 runs this
  // script right after installing 3.4.19, and announces only the admin space: without the flag,
  // nothing about the filter is written, and it is only said.
  const redirects = findRedirectFilters(abs);
  for (const u of redirects.unreadable) if (!unreadable.some((x) => x.path === u.path)) unreadable.push(u);
  const plans = new Map();
  const openRedirect = redirects.found
    .filter((f) => f.form !== "suspect")
    .map((f) => {
      if (f.form !== "old-filter") return { ...f, fix: "manual" };
      if (!plans.has(f.file)) plans.set(f.file, repairRedirects(readText(join(abs, f.file)) ?? ""));
      const plan = plans.get(f.file);
      return plan.fixed.includes(f.line) ? { ...f, fix: "auto" } : { ...f, fix: "manual", ...(plan.reason ? { reason: plan.reason } : {}) };
    });
  counts.redirect = openRedirect.filter((f) => f.fix === "auto").length;
  const needed = counts.toFix + counts.manual + counts.review > 0 || rulesNeeded || (withRedirects && counts.redirect > 0);
  const result = { dir: abs, name, needed, counts, pages, apps: appsOut, claudeMd, openRedirect, unreadable };
  if (git) {
    const redirectFiles = withRedirects ? [...new Set(openRedirect.filter((f) => f.fix === "auto").map((f) => f.file))] : [];
    const toWrite = [...pages.filter((p) => p.status === "to-fix").map((p) => p.file), ...claudeMd.filter((c) => c.admin === "outdated" || c.role === "outdated").map((c) => c.file), ...redirectFiles];
    result.uncommitted = uncommittedFiles(abs, toWrite, run);
  }
  return result;
}

/** A path read to its real one (every link resolved), or as it is when it cannot be read. */
function realOf(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** git run in `base` in the neutral form of 3.4.17, without a shell, five seconds at most; the hooks
 *  pointed to `neutral`, an empty folder of ours. */
function neutralGit(base, neutral, run) {
  const safe = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${neutral}`, "-c", "core.virtualFilesystem="];
  return (args) => run("git", ["-C", base, ...safe, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

/** The `-c` that empty the filters of the repository's own configuration, or null when git could not
 *  say them. */
function emptiedFilters(git) {
  const filters = git(["config", "--show-scope", "--includes", "--name-only", "--get-regexp", "^filter\\..+\\.(clean|smudge|process)$"]);
  if (filters.status !== 0 && filters.status !== 1) return null;
  return (filters.status === 0 ? String(filters.stdout ?? "") : "")
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter(([scope, key]) => key && (scope === "local" || scope === "worktree"))
    .flatMap(([, key]) => ["-c", `${key}=`]);
}

/**
 * Which of `files` (relative to `dir`) already have changes not committed, asked of git in the
 * neutral form of 3.4.17 (localGitState of /delete-project): no pager, no optional lock, no file
 * system monitor, the hooks pointed to an empty folder of ours, the filters of the repository's own
 * configuration emptied, submodules ignored, the paths read literally. A project's folder may have
 * been copied from anywhere, and its configuration may name any program. null when the folder is
 * not in a repository or git could not answer.
 *
 * git answers with real paths (the root it gives has every symbolic link resolved), and a project
 * may be reached through one: macOS's temporary folder (/var is a link to /private/var), a folder
 * linked from elsewhere, a junction under Windows. Mixing the root git gives with the folder as it
 * was typed put every file "outside the repository" (git exits 128), and the answer was null
 * (reported on 28/10/2026). Both sides are read to their real path, and git is run from the real
 * folder.
 */
export function uncommittedFiles(dir, files, run = spawnSync) {
  if (!files.length) return [];
  const base = realOf(dir);
  const neutral = mkdtempSync(join(tmpdir(), "hv-git-neutre-"));
  try {
    const git = neutralGit(base, neutral, run);
    const top = git(["rev-parse", "--show-toplevel"]);
    if (top.status !== 0) return null;
    const root = realOf(String(top.stdout ?? "").trim());
    const emptied = emptiedFilters(git);
    if (emptied === null) return null;
    // The paths given to git are read from the folder it runs in (the real one); the ones it prints
    // are relative to the repository's root.
    const fromRoot = (f) => slash(relative(root, join(base, f)));
    const st = git([...emptied, "status", "--porcelain", "-z", "--ignore-submodules=all", "--untracked-files=all", "--", ...files.map(slash)]);
    if (st.status !== 0) return null;
    const changed = new Set();
    const parts = String(st.stdout ?? "").split("\0");
    for (let k = 0; k < parts.length; k += 1) {
      const entry = parts[k];
      if (entry.length < 4) continue;
      changed.add(entry.slice(3));
      if (/[RC]/.test(entry[0])) k += 1;
    }
    return files.filter((f) => changed.has(fromRoot(f)));
  } finally {
    rmSync(neutral, { recursive: true, force: true });
  }
}

/** The repair of one project: only what the diagnosis named. */
export function repair(dir, { run = spawnSync, withRedirects = false } = {}) {
  const before = diagnose(dir, { git: true, run, withRedirects });
  if (before.ok === false) return before;
  if (!before.needed) return { ok: true, dir: before.dir, name: before.name, needed: false, written: false, commit: [], remaining: [] };
  const abs = before.dir;
  const commit = [];
  const apps = [];
  const write = (rel, text) => {
    writeFileSync(join(abs, rel), text);
    if (!commit.includes(rel)) commit.push(rel);
  };
  let step = "helper";
  try {
    for (const app of before.apps) {
      const appDir = join(abs, app.dir);
      const done = { dir: app.dir, helper: app.helper, middleware: app.middleware };
      if (app.adminSpace && app.writes) {
        step = "helper";
        const h = ensureRequireAdmin(appDir);
        done.helper = { status: h };
        if (h === "written") commit.push(slash(join(app.dir === "." ? "" : app.dir, HELPER_FILE)));
        step = "middleware";
        if (app.middleware?.status !== "skipped") {
          const m = ensureAdminMiddleware(appDir);
          done.middleware = m;
          if (m.status === "written") commit.push(slash(join(app.dir === "." ? "" : app.dir, m.file)));
        }
      }
      apps.push(done);
    }
    const fixed = [];
    step = "page";
    for (const p of before.pages.filter((x) => x.status === "to-fix")) {
      const src = readFileSync(join(abs, p.file), "utf8");
      const out = fixPage(src);
      if (out === null) {
        p.status = "manual";
        p.reason = "the check could not go in safely";
        p.fix = "requireAdmin";
        continue;
      }
      write(p.file, out);
      fixed.push(p.file);
    }
    step = "claude-md";
    const rules = [];
    for (const c of before.claudeMd.filter((x) => x.admin === "outdated" || x.role === "outdated")) {
      const text = readFileSync(join(abs, c.file), "utf8");
      const r = replaceRules(text);
      if (r.text !== text) {
        write(c.file, r.text);
        rules.push({ file: c.file, replaced: r.replaced, removed: r.removed });
      }
    }
    const remaining = [
      ...before.pages.filter((p) => p.status === "manual" || p.status === "review"),
      ...before.claudeMd.flatMap((c) => ["admin", "role"].filter((rule) => c[rule] === "edited").map((rule) => ({ file: c.file, status: "manual", reason: `the ${rule === "admin" ? "admin space's" : "role"} rule before 3.4.17, in other words`, rule }))),
    ];
    // The old filter of the return address, with --redirects only: the lines that are still the
    // templates' own, nothing else (repairRedirects reads the file again as it is now).
    const redirectsFixed = [];
    if (withRedirects) {
      step = "redirect";
      for (const file of [...new Set(before.openRedirect.filter((f) => f.fix === "auto").map((f) => f.file))]) {
        const r = repairRedirects(readFileSync(join(abs, file), "utf8"));
        if (r.text === null) continue;
        write(file, r.text);
        redirectsFixed.push({ file, lines: r.fixed });
      }
      for (const f of before.openRedirect.filter((x) => x.fix === "manual")) remaining.push({ file: f.file, line: f.line, status: "manual", kind: "redirect", form: f.form, reason: f.form === "unfiltered" ? "the return address followed as it came: /security fixes it" : `the old filter, not the templates' own lines (${f.reason ?? "changed by hand"}): /security fixes it` });
    }
    const after = diagnose(abs, { withRedirects });
    const uncommittedBefore = before.uncommitted === null ? null : commit.filter((f) => before.uncommitted.includes(f));
    return { ok: true, dir: abs, name: before.name, written: commit.length > 0, commit, fixed, rules, redirects: redirectsFixed, apps, remaining, uncommittedBefore, needed: after.needed };
  } catch (e) {
    return { ok: false, step, dir: abs, detail: String(e?.message ?? e).slice(0, 300), commit };
  }
}

// ─── The projects of this machine ─────────────────────────────────────────────

const same = (p) => {
  let real = String(p);
  try {
    real = realpathSync(real);
  } catch {
    // Compared as written.
  }
  const flat = real.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? flat.toLowerCase() : flat;
};

/** A folder that is a project: its own repository root, with Next.js at its root or in its apps.
 *  Its `.git` may be a file: a working copy made by `git worktree add` (grouped under its repository
 *  by scan()), or a submodule. */
const isProject = (dir) => existsSync(join(dir, ".git")) && nextApps(dir).length > 0;

// ─── The working copies of a repository ───────────────────────────────────────
// `git worktree add` makes a second working copy of a repository, with a `.git` FILE that points to
// the repository's own folder. Each copy is its own folder and was counted as a project: 14
// "projects" for 3 repositories on one machine (reported on 28/10/2026). Keeping only the main folder
// is not enough either: it may be on a demo branch while a copy holds the branch that is deployed.
// So the copies of a repository are grouped, each with its branch, and the one on the branch that
// goes to production is offered first. Everything is read in the files git keeps (HEAD, commondir,
// worktrees/*/gitdir, refs): git is never run, nothing is written, no network. Each copy is given by
// its real path: git writes worktrees/*/gitdir with every link resolved, and the scan meets the
// others as their parent folder was typed (3.4.20).
//
// The project's `needed` is its first copy's: the repair is offered there only. An old copy of a
// branch already merged kept a repaired project "to repair" for good, and the warning ended up
// unread (reported on 28/10/2026). The other copies that still need it are named apart, with their
// state (copyState), which is the one place where git is asked: whether a copy has changes not
// committed, and whether what it holds is already in the production branch.

/** The text of a small file of git's, or null. */
const gitFile = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * What git keeps of a working copy: its own git folder, the repository's folder that all its copies
 * share (`common`), and its branch (null when detached or unreadable). null without a readable .git.
 */
export function gitCopyOf(dir) {
  const dotGit = join(dir, ".git");
  let gitDir;
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) gitDir = dotGit;
    else if (st.isFile()) {
      const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(gitFile(dotGit) ?? "");
      if (!m) return null;
      gitDir = resolve(dir, m[1]);
    } else return null;
  } catch {
    return null;
  }
  const commondir = gitFile(join(gitDir, "commondir"));
  const common = commondir && commondir.trim() ? resolve(gitDir, commondir.trim()) : gitDir;
  const branch = /^ref:[ \t]*refs\/heads\/(.+?)[ \t]*$/m.exec(gitFile(join(gitDir, "HEAD")) ?? "")?.[1] ?? null;
  return { dir: resolve(dir), gitDir, common, branch };
}

/** Whether a branch exists in the repository: its file under refs/heads, or a line of packed-refs. */
function hasBranch(common, name) {
  if (existsSync(join(common, "refs", "heads", ...name.split("/")))) return true;
  const packed = gitFile(join(common, "packed-refs")) ?? "";
  return packed.split(/\r?\n/).some((l) => l.trim().endsWith(` refs/heads/${name}`));
}

/**
 * The branch that goes to production, read without the network: the default branch of the remote
 * (`refs/remotes/origin/HEAD`, set by `git clone` and by `git remote set-head`), otherwise `main`,
 * then `master`, when the repository or one of its copies has it. `from` says which.
 */
export function productionBranchOf(common, branches = []) {
  const head = /^ref:[ \t]*refs\/remotes\/origin\/(.+?)[ \t]*$/m.exec(gitFile(join(common, "refs", "remotes", "origin", "HEAD")) ?? "")?.[1];
  if (head) return { branch: head, from: "origin" };
  for (const name of ["main", "master"]) if (branches.includes(name) || hasBranch(common, name)) return { branch: name, from: "default" };
  return { branch: null, from: null };
}

/** The refs of `branch` that the repository has, read in its files: the local one, then the
 *  remote's. Both names when the repository's folder is not known (git then says). */
function refsOf(common, branch) {
  const refs = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
  if (!common) return refs;
  const packed = (gitFile(join(common, "packed-refs")) ?? "").split(/\r?\n/);
  return refs.filter((ref) => existsSync(join(common, ...ref.split("/"))) || packed.some((l) => l.trim().endsWith(` ${ref}`)));
}

/**
 * The state of a working copy that the repair leaves alone, said so that the person knows whether it
 * can be brought up to date or removed (nothing is ever written in it, nothing is removed):
 *   - `uncommitted`: whether it has changes not committed (`git status`, untracked files counted,
 *     ignored ones not), null when git could not say;
 *   - `contained`: whether what it holds is already in `reference`, the production branch (or the
 *     branch of the copy offered first, when the production branch is not read): `git merge-base
 *     --is-ancestor HEAD <ref>`, against the local branch, then the remote's; null when no such
 *     branch is there or git could not say;
 *   - `state`: `work` when it has changes not committed or commits the branch does not have,
 *     `merged` when neither, `unread` otherwise.
 * git is asked in the neutral form of uncommittedFiles, from the copy's real folder.
 */
export function copyState(dir, reference, { common = null, run = spawnSync } = {}) {
  const folder = realOf(dir);
  const neutral = mkdtempSync(join(tmpdir(), "hv-git-neutre-"));
  let uncommitted = null;
  let contained = null;
  try {
    const git = neutralGit(folder, neutral, run);
    const emptied = emptiedFilters(git);
    if (emptied !== null) {
      const st = git([...emptied, "status", "--porcelain", "-z", "--ignore-submodules=all", "--untracked-files=normal"]);
      if (st.status === 0) uncommitted = String(st.stdout ?? "").length > 0;
    }
    for (const ref of reference ? refsOf(common, reference) : []) {
      const a = git(["merge-base", "--is-ancestor", "HEAD", ref]);
      if (a.status === 0) {
        contained = true;
        break;
      }
      if (a.status === 1) contained = false;
    }
  } finally {
    rmSync(neutral, { recursive: true, force: true });
  }
  const state = uncommitted === true || contained === false ? "work" : uncommitted === false && contained === true ? "merged" : "unread";
  return { state, uncommitted, contained, containedIn: reference ?? null };
}

/**
 * Every working copy of the repository `common`: its main folder (the parent of a `.git` folder) and
 * the copies that `worktrees/*` names, when they still exist. Read in the repository's own files.
 */
function copiesOf(common) {
  const out = [];
  if (/^\.git$/i.test(basename(common))) out.push(dirname(common));
  try {
    for (const e of readdirSync(join(common, "worktrees"), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const pointer = (gitFile(join(common, "worktrees", e.name, "gitdir")) ?? "").trim();
      if (!pointer) continue;
      const copy = dirname(resolve(join(common, "worktrees", e.name), pointer));
      if (existsSync(join(copy, ".git"))) out.push(copy);
    }
  } catch {
    // No other working copy.
  }
  return out;
}

/** The repository root that holds `dir`, or null. */
function repositoryOf(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

/**
 * The projects of this machine: the current folder's own project, and the projects one and two
 * levels down the current folder and the folders where this machine keeps projects
 * (detect-projects-dir.mjs). Never node_modules, .git, .next nor a hidden folder; never the profile
 * itself nor a disk's root as a folder to look into; a folder that cannot be read is said and the
 * rest goes on. `home` simulates a profile (the recettes: nothing of the real one is read), and
 * `readdir` a folder that cannot be read.
 */
export function findProjects({ cwd = process.cwd(), home = null, plat = process.platform, readdir = readdirSync } = {}) {
  const isWin = plat === "win32";
  const here = resolve(fromGitBashPath(cwd, isWin));
  const found = new Map();
  const unreadable = [];
  const holders = [];
  const add = (dir) => {
    const key = same(dir);
    if (!found.has(key)) found.set(key, resolve(dir));
  };
  // The current folder's project: the repository that holds it, or the folder itself.
  const repo = repositoryOf(here);
  if (repo && nextApps(repo).length) add(repo);
  else if (nextApps(here).length) add(here);
  // The folders to look into.
  const profile = resolve(home ? fromGitBashPath(home, isWin) : (process.env.USERPROFILE || process.env.HOME || here));
  const notAHolder = (p) => same(p) === same(profile) || resolve(p) === parse(resolve(p)).root;
  const candidates = [here, ...detect({ cwd: here, home, plat }).candidates.filter((c) => c.exists).map((c) => c.path)];
  const seenHolders = new Set();
  for (const c of candidates) {
    if (notAHolder(c) || seenHolders.has(same(c))) continue;
    seenHolders.add(same(c));
    holders.push(resolve(c));
  }
  const look = (dir, level) => {
    if (level > 2) return;
    let entries;
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch (e) {
      unreadable.push({ path: dir, error: e.code ?? String(e.message) });
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const child = join(dir, e.name);
      if (isProject(child)) add(child);
      look(child, level + 1);
    }
  };
  for (const h of holders) {
    if (isProject(h)) add(h);
    look(h, 1);
  }
  return { projects: [...found.values()], holders, unreadable };
}

/**
 * The projects found, grouped by repository: the working copies of one repository (a main folder and
 * the copies of `git worktree add`) make one project. Its first copy is the one on the production
 * branch, otherwise the main folder, otherwise the first found; the others follow, each with its
 * branch. A copy that the scan did not meet (made elsewhere, a hidden folder) is added when it holds
 * Next.js. A folder whose git cannot be read is a project of its own, as before. Every copy is given
 * by its real path (3.4.20), so that one group never holds two forms of a path.
 *
 * `collab` (the collaborator's harness): in a project of the organisation (the copy has
 * .github/workflows/deploy.yml), the copy on a `collab/` branch comes first, before the production
 * one. The collaborator works on `collab/<login>` and sends it to production through its own path
 * (`_publish-prod`); the copy on `main` is never where the repair goes. Read in the files, without
 * the network: the login is not known here, so this holds only when ONE copy is on such a branch;
 * with several, the order stays the production one and `workBranches` names them, for the skill to
 * ask which one is the person's. `first` says why the first copy is first: `work-branch`,
 * `production`, `main` (the main folder) or `found`.
 */
export function groupCopies(projects, { collab = false } = {}) {
  const groups = new Map();
  const add = (key, dir, copy) => {
    if (!groups.has(key)) groups.set(key, { common: copy?.common ?? null, copies: new Map() });
    const g = groups.get(key);
    if (!g.copies.has(same(dir))) g.copies.set(same(dir), copy ?? { dir: resolve(dir), branch: null });
  };
  for (const dir of projects) {
    const copy = gitCopyOf(dir);
    add(copy ? `repo:${same(copy.common)}` : `dir:${same(dir)}`, dir, copy);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.common) {
      for (const other of copiesOf(g.common)) {
        if (g.copies.has(same(other)) || !nextApps(other).length) continue;
        const copy = gitCopyOf(other);
        if (copy && same(copy.common) === same(g.common)) g.copies.set(same(other), copy);
      }
    }
    const copies = [...g.copies.values()].map((c) => ({ ...c, dir: realOf(c.dir) }));
    const production = g.common ? productionBranchOf(g.common, copies.map((c) => c.branch).filter(Boolean)) : { branch: null, from: null };
    const main = g.common && /^\.git$/i.test(basename(g.common)) ? same(dirname(g.common)) : null;
    const working = collab ? copies.filter((c) => /^collab\/./.test(c.branch ?? "") && existsSync(join(c.dir, ".github", "workflows", "deploy.yml"))) : [];
    const work = working.length === 1 ? working[0] : null;
    const rank = (c) => (c === work ? -1 : production.branch && c.branch === production.branch ? 0 : same(c.dir) === main ? 1 : 2);
    copies.sort((a, b) => rank(a) - rank(b));
    const head = copies[0];
    const first = head === work ? "work-branch" : production.branch && head.branch === production.branch ? "production" : main && same(head.dir) === main ? "main" : "found";
    out.push({ copies, production, first, ...(working.length > 1 ? { workBranches: working.map((c) => c.branch) } : {}) });
  }
  return out;
}

/** Every project of this machine, diagnosed, the working copies of a repository grouped. Writes
 *  nothing. */
export function scan(options = {}) {
  const { projects, holders, unreadable } = findProjects(options);
  const unread = [...unreadable];
  const results = groupCopies(projects, { collab: Boolean(options.collab) }).map(({ copies, production, first: offered, workBranches }) => {
    const diagnosed = copies.map((c) => ({ copy: c, d: diagnose(c.dir, { withRedirects: Boolean(options.withRedirects) }) }));
    for (const { d } of diagnosed) for (const u of d.unreadable ?? []) unread.push({ path: join(d.dir, u.path), error: u.error });
    const [first, ...others] = diagnosed;
    const r = { ...first.d };
    delete r.unreadable;
    r.branch = first.copy.branch;
    r.productionBranch = production.branch;
    r.productionFrom = production.from;
    if (others.length) {
      // Every working copy, the first one included, each with its own count.
      r.copies = diagnosed.map(({ copy, d }) => ({ dir: d.dir, branch: copy.branch, production: Boolean(production.branch) && copy.branch === production.branch, needed: d.needed, counts: d.counts ?? null, openRedirect: (d.openRedirect ?? []).length }));
      // The project's `needed` stays its first copy's (r is that copy's diagnosis): the repair is
      // offered there only. The other copies that still need it are said apart, with their state.
      r.firstCopy = offered;
      if (workBranches) r.workBranches = workBranches;
      const reference = production.branch ?? first.copy.branch;
      r.otherCopies = others
        .filter(({ d }) => d.needed)
        .map(({ copy, d }) => ({ dir: d.dir, branch: copy.branch, counts: d.counts ?? null, openRedirect: (d.openRedirect ?? []).length, ...copyState(copy.dir, reference, { common: copy.common ?? null, run: options.run }) }));
    }
    return r;
  });
  const needed = results.filter((r) => r.needed);
  const brief = ({ dir, name, needed: n, reason, branch, productionBranch, firstCopy, workBranches, otherCopies, copies, openRedirect }) => ({ dir, name, needed: n, ...(reason ? { reason } : {}), ...(firstCopy ? { firstCopy } : {}), ...(workBranches ? { workBranches } : {}), ...(otherCopies ? { otherCopies } : {}), branch, productionBranch, ...(copies ? { copies } : {}), openRedirect: openRedirect ?? [] });
  const withRedirect = (r) => (r.openRedirect ?? []).length > 0 || (r.copies ?? []).some((c) => c.openRedirect > 0);
  return {
    scanned: holders,
    needed: needed.length,
    otherCopies: results.filter((r) => (r.otherCopies ?? []).length > 0).length,
    openRedirect: results.filter(withRedirect).length,
    projects: [...needed, ...results.filter((r) => !r.needed).map(brief)],
    unreadable: unread,
  };
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
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  let out;
  if (args.includes("--scan")) {
    out = args.includes("--write")
      ? { ok: false, step: "args", detail: "--scan never writes: repair one project at a time, with --project-dir <dir> --write" }
      : scan({ cwd: value("--cwd") ?? process.cwd(), home: value("--home") ?? null, withRedirects: args.includes("--redirects"), collab: args.includes("--collab") });
  } else {
    const dir = resolve(fromGitBashPath(value("--project-dir") ?? process.cwd()));
    const withRedirects = args.includes("--redirects");
    out = args.includes("--write") ? repair(dir, { withRedirects }) : diagnose(dir, { git: true, withRedirects });
  }
  console.log(JSON.stringify(out));
  process.exitCode = out.ok === false ? 1 : 0;
}
