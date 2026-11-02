#!/usr/bin/env node
// login-limit.mjs - Where a project limits its sign-in attempts in the API route of NextAuth, the
// form of the templates up to 3.4.22, and the sign-in forms that this broke (3.4.23).
//
// Up to 3.4.22, the templates wrapped NextAuth's POST handler in src/app/api/auth/[...nextauth]/
// route.ts and answered the sixth attempt of an address in 15 minutes themselves: a 429, in JSON,
// with no `url`. next-auth's client signIn() reads the `url` of every answer (`new URL(data.url)`,
// 5.0.0-beta.32): on that answer it threw, and the sign-in forms, which gave the button back on the
// line after `await signIn(...)`, stayed frozen with no message (reported on 02/11/2026). 3.4.23
// moves the limit into authorize() (a `TooManyAttempts` that extends CredentialsSignin, which
// Auth.js turns into `code: "too_many_attempts"` for the form), gives the route back to NextAuth's
// own handlers, and has the forms read that code and give the button back whatever happens.
//
//   node login-limit.mjs --project-dir <dir>
//
// It reads the code of the project (node_modules, hidden folders, build outputs and public/ left
// out), writes nothing, and prints one JSON line:
//   { ok: true, dir, found: [{ file, kind, form, fix, reason?, app, messages? }], counts, unreadable }
// The kinds:
//   route      the API route answers a refused attempt itself (`form: "old-route"`);
//   authorize  the Credentials provider's authorize() that must take the limit back
//              (`form: "users" | "admin" | "2fa"`), or one that names no limiter at all while no
//              route counts for it either (`form: "no-limit"`, `fix: "read"`: /security reads it);
//   form       a sign-in form that gives the button back right after `await signIn(...)`
//              (`form: "signin" | "signup"`).
// `fix: "auto"` is a file still written word for word as the templates wrote it: /update-hypervibe
// repairs it (repairLoginLimit below, called by repair-admin-gate.mjs with --login-limit). The route
// and authorize() go together, or not at all: the route never loses its limit before authorize()
// has it. `fix: "manual"` is anything else: /security fixes it, never the update.
// Exit 0, or 1 when the folder cannot be read.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SKIPPED = new Set(["node_modules", ".next", "dist", "build", "out", "coverage", "public"]);
const MAX_FILES = 20000;
const MAX_DEPTH = 12;
const MAX_SIZE = 1024 * 1024;
const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

const slash = (p) => p.split(sep).join("/");
const lf = (t) => String(t).replace(/\r\n/g, "\n");

// ─── The forms the templates wrote up to 3.4.22 ───────────────────────────────
// Read in every published version (the public mirror's tags from v2.4.1 to v3.4.22, the Enterprise
// archives from 1.5.0 to 2.5.0) on 02/11/2026: one form of the route, identical for both modes, and
// one form of each authorize(); the forms' lines below are the same in every version, only what
// follows them changed (the return address, 3.3.11 and 3.4.19), and it is left as it is.

/** The API route of both modes, up to 3.4.22, as the templates wrote it (render() changes nothing in it). */
export const OLD_ROUTE = [
  'import { type NextRequest, NextResponse } from "next/server";',
  'import { handlers } from "~/server/auth";',
  'import { checkRateLimit } from "~/lib/rate-limit";',
  "",
  "export const GET = handlers.GET;",
  "",
  "/**",
  " * NextAuth POST handler with IP-based rate limiting on the credentials callback.",
  " * Other NextAuth POST endpoints (CSRF token, signout, etc.) bypass the limiter.",
  " */",
  "export async function POST(req: NextRequest) {",
  "  const url = new URL(req.url);",
  '  if (url.pathname.includes("/callback/credentials")) {',
  '    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";',
  "    const { allowed, retryAfterMs } = checkRateLimit(ip);",
  "    if (!allowed) {",
  "      return NextResponse.json(",
  '        { error: "Trop de tentatives. Réessaie dans quelques minutes." },',
  "        {",
  "          status: 429,",
  '          headers: { "Retry-After": String(Math.ceil((retryAfterMs ?? 0) / 1000)) },',
  "        },",
  "      );",
  "    }",
  "  }",
  "  return handlers.POST(req);",
  "}",
  "",
].join("\n");

/** An older form of the same route, from before the public mirror (before v2.4.1): in no published
 *  version that could be read, but found word for word in four of Flavien's projects (maigic,
 *  books/apps/hyperprompt, atelier-ia-qalia, ia-booster-qalia), read only, on 02/11/2026; a fifth
 *  (plus33) has the same text with relative imports, and is not this form. Recognised for the route
 *  only: an authorize() or a form of a form never read stays for /security. */
export const OLD_ROUTE_PRE_MIRROR = [
  'import { type NextRequest, NextResponse } from "next/server";',
  'import { handlers } from "~/server/auth";',
  'import { checkRateLimit } from "~/lib/rate-limit";',
  "",
  "export const GET = handlers.GET;",
  "",
  "export async function POST(req: NextRequest) {",
  "  const url = new URL(req.url);",
  "",
  "  // Appliquer le rate limit uniquement sur la route de login credentials",
  '  if (url.pathname.includes("/callback/credentials")) {',
  "    const ip =",
  '      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??',
  '      req.headers.get("x-real-ip") ??',
  '      "unknown";',
  "",
  "    const { allowed, retryAfterMs } = checkRateLimit(ip);",
  "",
  "    if (!allowed) {",
  "      const retryAfterSec = Math.ceil((retryAfterMs ?? 0) / 1000);",
  "      return NextResponse.json(",
  '        { error: "Trop de tentatives de connexion. Réessaie dans quelques minutes." },',
  "        {",
  "          status: 429,",
  '          headers: { "Retry-After": String(retryAfterSec) },',
  "        },",
  "      );",
  "    }",
  "  }",
  "",
  "  return handlers.POST(req);",
  "}",
  "",
].join("\n");
/** Every form of the route the repair rewrites. */
export const OLD_ROUTES = [OLD_ROUTE, OLD_ROUTE_PRE_MIRROR];

/** Each authorize() of the templates up to 3.4.22, its lines from its signature to its `},`, and the
 *  template of this version that holds the new one. */
const AUTHORIZE = {
  users: {
    template: "auth/users/auth.ts",
    old: [
      "      async authorize(credentials) {",
      "        const email = credentials?.email as string | undefined;",
      "        const password = credentials?.password as string | undefined;",
      "        if (!email || !password) return null;",
      "",
      "        const user = await db.query.users.findFirst({ where: eq(users.email, email) });",
      "        if (!user || !user.passwordHash) return null;",
      "",
      "        const ok = await verifyPassword(password, user.passwordHash);",
      "        if (!ok) return null;",
      "",
      "        return {",
      "          id: user.id,",
      "          email: user.email,",
      "          name: user.name,",
      "          image: user.image,",
      "        };",
      "      },",
    ],
  },
  admin: {
    template: "auth/admin/auth.ts",
    old: [
      "      async authorize(credentials) {",
      "        const username = credentials?.username as string | undefined;",
      "        const password = credentials?.password as string | undefined;",
      "        if (!username || !password) return null;",
      "",
      "        // Always run the password verification (even on a username mismatch) so",
      "        // the response time does not reveal whether the username was correct.",
      '        const expectedUsername = process.env.ADMIN_USERNAME ?? "admin";',
      "        const hash = getAdminPasswordHash();",
      "        const ok = await verifyPassword(password, hash);",
      "        if (username !== expectedUsername || !ok) return null;",
      "",
      '        return { id: "admin", name: "Admin" };',
      "      },",
    ],
  },
  "2fa": {
    template: "2fa/auth.ts",
    old: [
      "      async authorize(credentials) {",
      "        const username = credentials?.username as string | undefined;",
      "        const proof = credentials?.proof as string | undefined;",
      "        if (!username || !proof) return null;",
      "",
      '        const expectedUsername = process.env.ADMIN_USERNAME ?? "admin";',
      "        if (username !== expectedUsername) return null;",
      "",
      "        if (!verifyLoginProof(username, proof)) return null;",
      "",
      '        return { id: "admin", name: "Admin" };',
      "      },",
    ],
  },
};
const OLD_IMPORT = 'import NextAuth, { type DefaultSession } from "next-auth";';
const NEW_IMPORT = 'import NextAuth, { CredentialsSignin, type DefaultSession } from "next-auth";';
const LIMIT_IMPORT = 'import { checkRateLimit } from "~/lib/rate-limit";';
const MARKER = "// hypervibe:auth-modes";

/** The sign-in forms: their lines from `const res = await signIn(` to the end of the error branch.
 *  `fields` are the two lines of what is sent, `msg` the general error, `tooMany` the new message. */
const FORMS = {
  signin: {
    fields: [
      ["username,", "password,"],
      ["email,", "password,"],
    ],
    msgs: {
      '"Identifiant ou mot de passe incorrect."': '"Trop de tentatives. Réessaie dans quelques minutes."',
      '"Email ou mot de passe incorrect."': '"Trop de tentatives. Réessaie dans quelques minutes."',
      't("errorInvalidCredentials")': 't("errorTooManyAttempts")',
    },
    namespace: "signin",
    old: (f, msg) => ['const res = await signIn("credentials", {', `  ${f[0]}`, `  ${f[1]}`, "  redirect: false,", "});", "setPending(false);", "", "if (res?.error) {", `  toast.error(${msg});`, "  return;", "}"],
    after: (f, msg, tooMany) => [
      "// The button always comes back: .catch() turns a failure (the network, an",
      "// unexpected answer) into the general error, .finally() gives the button back.",
      'const res = await signIn("credentials", {',
      `  ${f[0]}`,
      `  ${f[1]}`,
      "  redirect: false,",
      "})",
      "  .catch(() => null)",
      "  .finally(() => setPending(false));",
      "",
      "// Too many attempts: the code authorize() gives (TooManyAttempts, src/server/auth.ts).",
      'if (res?.code === "too_many_attempts") {',
      `  toast.error(${tooMany});`,
      "  return;",
      "}",
      "if (!res || res.error) {",
      `  toast.error(${msg});`,
      "  return;",
      "}",
    ],
  },
  signup: {
    fields: [["email,", "password,"]],
    msgs: {
      '"Compte créé, mais la connexion automatique a échoué. Connecte-toi manuellement."': '"Compte créé, mais trop de tentatives de connexion. Réessaie de te connecter dans quelques minutes."',
      't("errorAutoSigninFailed")': 't("errorTooManyAttempts")',
    },
    namespace: "signup",
    old: (f, msg) => ['const res = await signIn("credentials", {', `  ${f[0]}`, `  ${f[1]}`, "  redirect: false,", "});", "if (res?.error) {", `  toast.error(${msg});`, '  router.push("/signin");', "  return;", "}"],
    after: (f, msg, tooMany) => [
      "// A failure (the network, an unexpected answer) is said as a refusal: the",
      "// account exists, the person signs in from the sign-in page.",
      'const res = await signIn("credentials", {',
      `  ${f[0]}`,
      `  ${f[1]}`,
      "  redirect: false,",
      "}).catch(() => null);",
      "// Too many attempts: the code authorize() gives (TooManyAttempts, src/server/auth.ts).",
      'if (res?.code === "too_many_attempts") {',
      `  toast.error(${tooMany});`,
      '  router.push("/signin");',
      "  return;",
      "}",
      "if (!res || res.error) {",
      `  toast.error(${msg});`,
      '  router.push("/signin");',
      "  return;",
      "}",
    ],
  },
};

/** The message a translated form shows, per language of a messages file (English for the others,
 *  as _i18n-merge-messages.mjs does). Read from the templates' own messages files. */
function messageFor(namespace, file) {
  const lang = basename(file).toLowerCase().startsWith("fr") ? "fr" : "en";
  try {
    return JSON.parse(readFileSync(join(TEMPLATES, `auth-${namespace}`, `messages-${lang}.json`), "utf8"))[namespace].errorTooManyAttempts ?? null;
  } catch {
    return null;
  }
}

// ─── Reading the project ──────────────────────────────────────────────────────

/** The app a file belongs to: the folder that holds its `src/`, "." at the project's root. */
function appOf(rel) {
  const at = rel.lastIndexOf("/src/");
  if (rel.startsWith("src/")) return ".";
  return at < 0 ? null : rel.slice(0, at);
}
const inApp = (app, rel) => (app === "." ? rel : `${app}/${rel}`);

/** Every code file of the project, read (null when it could not be). */
function codeFiles(abs, readdir, unreadable) {
  const out = [];
  const visit = (d, depth) => {
    if (depth > MAX_DEPTH || out.length > MAX_FILES) return;
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
        let text = null;
        try {
          if (statSync(p).size > MAX_SIZE) continue;
          text = readFileSync(p, "utf8");
        } catch (err) {
          unreadable.push({ path: slash(relative(abs, p)), error: err.code ?? "unreadable" });
          continue;
        }
        out.push({ rel: slash(relative(abs, p)), text });
      }
    }
  };
  visit(abs, 0);
  return out;
}

/** A route that answers a refused attempt itself: NextAuth's POST wrapped, a limiter, a 429. */
const isOldRoute = (text) => /\bhandlers\.POST\s*\(/.test(text) && /\bcheckRateLimit\s*\(/.test(text) && /\b429\b/.test(text);
/** A file that defines a Credentials provider's authorize(). */
const isAuthorizeFile = (text) => /\bauthorize\s*\(/.test(text) && /\bCredentials(?:Provider)?\s*\(/.test(text);
/** A form that gives the button back on the line after `await signIn("credentials", ...)`. */
const FROZEN = /await\s+signIn\(\s*["']credentials["'][\s\S]{0,600}?\}\s*\)\s*;\s*\r?\n\s*setPending\(\s*false\s*\)/;

/** The lines `want` (without indentation) found at `lines[i]`, all under one indentation: that
 *  indentation, or null. */
function matchAt(lines, i, want) {
  const ind = /^[ \t]*/.exec(lines[i] ?? "")[0];
  for (let k = 0; k < want.length; k += 1) {
    const expected = want[k] === "" ? "" : ind + want[k];
    if (lines[i + k] !== expected) return null;
  }
  return ind;
}

/** Every block of `kind`'s old form in the lines: where, its indentation, its fields and message. */
function findForms(lines, kind) {
  const f = FORMS[kind];
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^[ \t]*const res = await signIn\("credentials", \{$/.test(lines[i])) continue;
    for (const fields of f.fields) {
      let hit = null;
      for (const msg of Object.keys(f.msgs)) {
        const want = f.old(fields, msg);
        const ind = matchAt(lines, i, want);
        if (ind !== null) {
          hit = { at: i, length: want.length, ind, fields, msg };
          break;
        }
      }
      if (hit) {
        found.push(hit);
        break;
      }
    }
  }
  return found;
}

/** The new text of a form, or `{ text: null, reason }`. */
export function repairForm(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = lf(text).split("\n");
  const hits = [];
  for (const kind of Object.keys(FORMS)) for (const h of findForms(lines, kind)) hits.push({ ...h, kind });
  if (!hits.length) return { text: null, kinds: [], reason: FROZEN.test(text) ? "the form's lines changed by hand" : "nothing to repair" };
  const out = [...lines];
  for (const h of [...hits].sort((a, b) => b.at - a.at)) {
    const f = FORMS[h.kind];
    out.splice(h.at, h.length, ...f.after(h.fields, h.msg, f.msgs[h.msg]).map((l) => (l === "" ? "" : h.ind + l)));
  }
  const repaired = out.join("\n");
  if (FROZEN.test(repaired)) return { text: null, kinds: [], reason: "another sign-in in the file still gives the button back too early" };
  return { text: repaired.replace(/\n/g, eol), kinds: hits.map((h) => ({ kind: h.kind, translated: h.msg.startsWith("t(") })), reason: null };
}

/** The pieces of this version's authorize() template: the class TooManyAttempts with its comment
 *  and the blank line after it, and the authorize() block. */
function templatePieces(kind) {
  let text;
  try {
    text = lf(readFileSync(join(TEMPLATES, AUTHORIZE[kind].template), "utf8"));
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const cls = lines.findIndex((l) => l.startsWith("class TooManyAttempts "));
  const start = cls > 0 && lines[cls - 1] === " */" ? lines.slice(0, cls).lastIndexOf("/**") : cls;
  const clsEnd = lines.findIndex((l, i) => i > cls && l === "}");
  const auth = lines.findIndex((l) => l.startsWith("      async authorize("));
  const authEnd = lines.findIndex((l, i) => i > auth && l === "      },");
  if (cls < 0 || start < 0 || clsEnd < 0 || auth < 0 || authEnd < 0) return null;
  return { cls: [...lines.slice(start, clsEnd + 1), ""], authorize: lines.slice(auth, authEnd + 1) };
}

/** The line after which an import goes: the end of the last import at the top of the file. */
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

/** Which old authorize() the text holds, exactly once, or null. */
function authorizeKind(lines) {
  const kinds = [];
  for (const [kind, a] of Object.entries(AUTHORIZE)) {
    for (let i = 0; i < lines.length; i += 1) if (a.old.every((l, k) => lines[i + k] === l)) kinds.push({ kind, at: i });
  }
  return kinds.length === 1 ? kinds[0] : null;
}

/**
 * The new text of src/server/auth.ts, the limit in authorize(): `{ text, kind }`, or `{ text: null,
 * reason }`. Only an authorize() still written as the templates wrote it, word for word, with the
 * import of next-auth and the marker of the templates: the rest of the file (a Google provider
 * added later, for instance) is left as it is.
 */
export function repairAuthorize(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = lf(text).split("\n");
  if (/\bTooManyAttempts\b|\bcheckRateLimit\b/.test(text)) return { text: null, reason: "the file already names TooManyAttempts or checkRateLimit" };
  const found = authorizeKind(lines);
  if (!found) return { text: null, reason: "authorize() changed by hand, or a form the templates never wrote" };
  if (lines.filter((l) => l === OLD_IMPORT).length !== 1) return { text: null, kind: found.kind, reason: "the import of next-auth changed by hand" };
  if (lines.filter((l) => l.startsWith(MARKER)).length !== 1) return { text: null, kind: found.kind, reason: "the marker of the templates is missing" };
  const pieces = templatePieces(found.kind);
  if (!pieces) return { text: null, kind: found.kind, reason: "the template of this version could not be read" };
  const out = [...lines];
  out.splice(found.at, AUTHORIZE[found.kind].old.length, ...pieces.authorize);
  out.splice(out.findIndex((l) => l.startsWith(MARKER)), 0, ...pieces.cls);
  out[out.indexOf(OLD_IMPORT)] = NEW_IMPORT;
  const at = lastImport(out);
  if (at < 0) return { text: null, kind: found.kind, reason: "no import to put the limiter's after" };
  out.splice(at + 1, 0, LIMIT_IMPORT);
  return { text: out.join("\n").replace(/\n/g, eol), kind: found.kind, reason: null };
}

/** The route of this version, in the end of line of `text`. */
export function newRoute(text = "") {
  let route;
  try {
    route = lf(readFileSync(join(TEMPLATES, "auth/users/route.ts"), "utf8"));
  } catch {
    return null;
  }
  return String(text).includes("\r\n") ? route.replace(/\n/g, "\r\n") : route;
}

/** A messages file with `errorTooManyAttempts` added to its namespace: `{ text }` (null when it is
 *  already there), or `{ reason }` when it cannot be written back as it was read (JSON written by
 *  hand, comments, another indentation: the key is then added by hand). */
export function addMessage(text, namespace, message) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { reason: "not JSON" };
  }
  const ns = data?.[namespace];
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) return { reason: `no "${namespace}" in it` };
  if (Object.prototype.hasOwnProperty.call(ns, "errorTooManyAttempts")) return { text: null };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (`${JSON.stringify(data, null, 2)}\n` !== lf(text)) return { reason: "written in another layout than the plugin's" };
  ns.errorTooManyAttempts = message;
  return { text: `${JSON.stringify(data, null, 2)}\n`.replace(/\n/g, eol) };
}

/** The messages files of an app that hold `namespace`, with what adding the key would write. */
function messagesPlan(abs, app, namespace, readFile = readFileSync) {
  const dir = join(abs, app, "messages");
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return { files: [], reason: "no messages folder" };
  }
  const files = [];
  for (const n of names) {
    const rel = slash(join(app === "." ? "" : app, "messages", n));
    let text;
    try {
      text = readFile(join(dir, n), "utf8");
    } catch {
      return { files: [], reason: `${rel} could not be read` };
    }
    let has = false;
    try {
      has = Boolean(JSON.parse(text)?.[namespace]);
    } catch {
      return { files: [], reason: `${rel} is not JSON` };
    }
    if (!has) continue;
    const message = messageFor(namespace, n);
    if (!message) return { files: [], reason: "the message of the templates could not be read" };
    const r = addMessage(text, namespace, message);
    if (r.reason) return { files: [], reason: `${rel}: ${r.reason}` };
    if (r.text !== null) files.push({ file: rel, text: r.text });
  }
  return { files, reason: null, any: names.length > 0 };
}

/**
 * Everything of the project that concerns the limit of sign-in attempts, each with its fix. Writes
 * nothing. `readdir` simulates a folder that cannot be read (the recettes).
 */
export function findLoginLimit(dir, { readdir = readdirSync } = {}) {
  const abs = resolve(dir);
  const unreadable = [];
  const files = codeFiles(abs, readdir, unreadable);
  const found = [];
  const apps = new Map();
  const appState = (app) => {
    if (!apps.has(app)) apps.set(app, { routes: [], authFiles: [], forms: [] });
    return apps.get(app);
  };
  for (const f of files) {
    const app = appOf(f.rel);
    if (app === null) continue;
    if (/\/route\.(?:ts|js|mjs)$/.test(f.rel) && isOldRoute(f.text)) appState(app).routes.push(f);
    if (isAuthorizeFile(f.text)) appState(app).authFiles.push(f);
    if (/\bsignIn\(\s*["']credentials["']/.test(f.text) && /next-auth\/react/.test(f.text)) appState(app).forms.push(f);
  }
  for (const [app, st] of apps) {
    const authRel = inApp(app, "src/server/auth.ts");
    // The route and authorize(): the route is rewritten only when authorize() takes the limit back
    // in the same pass, never before.
    for (const r of st.routes) {
      const exact = OLD_ROUTES.includes(lf(r.text)) && r.rel === inApp(app, "src/app/api/auth/[...nextauth]/route.ts");
      let reason = exact ? null : "the route changed by hand, or a form the templates never wrote";
      let authPlan = null;
      if (exact) {
        const authFile = st.authFiles.find((a) => a.rel === authRel) ?? files.find((a) => a.rel === authRel) ?? null;
        const limiter = (() => {
          try {
            return readFileSync(join(abs, inApp(app, "src/lib/rate-limit.ts")), "utf8");
          } catch {
            return null;
          }
        })();
        if (!authFile) reason = "no src/server/auth.ts to move the limit into";
        else if (limiter === null) reason = "no src/lib/rate-limit.ts";
        else if (!/export function checkRateLimit\s*\(/.test(limiter)) reason = "the limiter is the shared counter (asynchronous) or written by hand";
        else {
          const a = repairAuthorize(authFile.text);
          if (a.text === null) reason = `src/server/auth.ts: ${a.reason}`;
          else authPlan = { file: authFile.rel, kind: "authorize", form: a.kind, fix: "auto", app };
        }
      }
      found.push({ file: r.rel, kind: "route", form: "old-route", fix: authPlan ? "auto" : "manual", ...(authPlan ? {} : { reason }), app });
      if (authPlan) found.push(authPlan);
      else {
        const authFile = st.authFiles.find((a) => a.rel === authRel) ?? st.authFiles[0];
        if (authFile && !found.some((f) => f.file === authFile.rel)) found.push({ file: authFile.rel, kind: "authorize", form: "old-route", fix: "manual", reason: "the limit lives in the route: authorize() takes it back with the route", app });
      }
    }
    // An authorize() that names no limiter at all, while no route counts for it: to read (`fix:
    // "read"`), for /security only. A limiter of another name (a project's own) is not one of these.
    if (!st.routes.length) {
      for (const a of st.authFiles) {
        if (/rate.?limit|too.?many|attempt/i.test(a.text)) continue;
        found.push({ file: a.rel, kind: "authorize", form: "no-limit", fix: "read", reason: "authorize() names no limit on sign-in attempts", app });
      }
    }
    // The forms.
    for (const f of st.forms) {
      const r = repairForm(f.text);
      if (r.text === null) {
        if (FROZEN.test(f.text)) found.push({ file: f.rel, kind: "form", form: "signin", fix: "manual", reason: r.reason, app });
        continue;
      }
      const form = r.kinds.some((k) => k.kind === "signin") ? "signin" : "signup";
      const namespaces = [...new Set(r.kinds.filter((k) => k.translated).map((k) => FORMS[k.kind].namespace))];
      const messages = [];
      let reason = null;
      for (const ns of namespaces) {
        const plan = messagesPlan(abs, app, ns);
        if (plan.reason) reason = `a translated form whose messages cannot take the new one (${plan.reason})`;
        else if (!plan.any) reason = "a translated form without a messages folder";
        else messages.push(...plan.files.map((m) => m.file));
      }
      found.push({ file: f.rel, kind: "form", form, fix: reason ? "manual" : "auto", ...(reason ? { reason } : {}), ...(messages.length ? { messages: [...new Set(messages)] } : {}), app });
    }
  }
  return { found, unreadable };
}

/** The files the repair writes for what `findLoginLimit` found: the auto ones, and the messages
 *  files their forms need. */
export function filesToWrite(found) {
  const out = [];
  for (const f of found.filter((x) => x.fix === "auto")) {
    if (!out.includes(f.file)) out.push(f.file);
    for (const m of f.messages ?? []) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * The repair of what `findLoginLimit` named `auto`, read again from the disk as it is now: each file
 * rewritten as the templates of this version write it, nothing else in it. authorize() before the
 * route: the route never loses its limit before authorize() has it. Returns the files written, in
 * the order written, and what was left (the reason).
 */
export function repairLoginLimit(dir, found, { write, read = (p) => readFileSync(p, "utf8") }) {
  const abs = resolve(dir);
  const written = [];
  const left = [];
  const autos = found.filter((f) => f.fix === "auto");
  const order = { authorize: 0, route: 1, form: 2 };
  const authorizeDone = new Set();
  for (const f of [...autos].sort((a, b) => order[a.kind] - order[b.kind])) {
    const text = read(join(abs, f.file));
    if (f.kind === "authorize") {
      const r = repairAuthorize(text);
      if (r.text === null) {
        left.push({ file: f.file, reason: r.reason });
        continue;
      }
      write(f.file, r.text);
      written.push(f.file);
      authorizeDone.add(f.app);
    } else if (f.kind === "route") {
      if (!authorizeDone.has(f.app) || !OLD_ROUTES.includes(lf(text))) {
        left.push({ file: f.file, reason: authorizeDone.has(f.app) ? "the route changed since the diagnosis" : "authorize() could not take the limit back" });
        continue;
      }
      const route = newRoute(text);
      if (route === null) {
        left.push({ file: f.file, reason: "the template of this version could not be read" });
        continue;
      }
      write(f.file, route);
      written.push(f.file);
    } else {
      const r = repairForm(text);
      if (r.text === null) {
        left.push({ file: f.file, reason: r.reason });
        continue;
      }
      // The messages first: a translated form never names a key its files do not have.
      let ok = true;
      const pending = [];
      for (const ns of [...new Set(r.kinds.filter((k) => k.translated).map((k) => FORMS[k.kind].namespace))]) {
        const plan = messagesPlan(abs, f.app, ns, (p) => read(p));
        if (plan.reason || !plan.any) {
          ok = false;
          left.push({ file: f.file, reason: plan.reason ?? "no messages folder" });
          break;
        }
        pending.push(...plan.files);
      }
      if (!ok) continue;
      for (const m of pending) {
        write(m.file, m.text);
        if (!written.includes(m.file)) written.push(m.file);
      }
      write(f.file, r.text);
      written.push(f.file);
    }
  }
  return { written, left };
}

/** The diagnosis of one project, standalone (/security). */
export function diagnoseLoginLimit(dir, options = {}) {
  const abs = resolve(dir);
  try {
    if (!statSync(abs).isDirectory()) return { ok: false, dir: abs, detail: "not a folder" };
  } catch {
    return { ok: false, dir: abs, detail: "not a folder" };
  }
  const { found, unreadable } = findLoginLimit(abs, options);
  const counts = { auto: found.filter((f) => f.fix === "auto").length, manual: found.filter((f) => f.fix === "manual").length, read: found.filter((f) => f.fix === "read").length };
  return { ok: true, dir: abs, found, counts, unreadable };
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
  const out = diagnoseLoginLimit(dir);
  console.log(JSON.stringify(out));
  process.exitCode = out.ok === false ? 1 : 0;
}

