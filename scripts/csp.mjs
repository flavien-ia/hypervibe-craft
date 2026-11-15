#!/usr/bin/env node
// csp.mjs - The site's Content-Security-Policy, written into next.config.(ts|mjs|js) as the harness
// writes everything there (setup-security.mjs, next-config.mjs): inside the existing file, never
// regenerated, the config object possibly wrapped (next-intl) or carrying the person's own options.
//
// Why here (security audit of 14/11/2026, four projects, the same missing CSP everywhere): most of a
// CSP needs no tuning per project. Two parts, the model being hypervibe.fr's own next.config.ts:
//   - the BASE, enforced, which blocks nothing a site loads: frame-ancestors 'none' (no page shown
//     in another site's frame, as X-Frame-Options already says), base-uri 'self', object-src
//     'none', form-action 'self'. Two exceptions, each a setting of the block: a path the site
//     shows in a frame of its own (`frame`: frame-ancestors 'self' there, X-Frame-Options
//     SAMEORIGIN), and a form that posts to another site (`form-action --off`: the directive is
//     then not set at all, and the reason is written beside it);
//   - the SCRIPT POLICY, reported only (Content-Security-Policy-Report-Only): the browser says in
//     its console what it would block, and blocks nothing. Each building block adds its domains
//     when it installs (`add`, `preset`, `storage`, or `host` for Vercel's toolbar). Making it
//     blocking is a decision for one project, after reading its reports: nothing here does it.
//
// ⚠️ NEVER a nonce. A nonce is drawn per response: Next.js then renders every page at each visit
// (no static page, no ISR), and a page backed by the database wakes it at every visit, the
// compute quota the rules protect. The script policy is a list of domains, with 'unsafe-inline'
// for the scripts Next.js writes into its pages, assumed.
//
// ONE source of truth: a marked block of the config file, between `// hypervibe-csp:start` and
// `// hypervibe-csp:end`. Its `// csp-source <block> {json}` lines say which block asked for which
// domains, its `// csp-settings {json}` line the two exceptions; the constants below them (cspBase,
// cspReportOnly, cspHeaders) are rewritten from those lines at every call. The config's headers()
// returns `...cspHeaders` after everything else (Next.js: the last rule that sets a header wins).
// Pages only: the API routes and the PDF files are left out, Chrome's PDF viewer refuses to open
// under object-src 'none'.
//
// A CSP of the person's own (a Content-Security-Policy anywhere in next.config, a middleware or
// proxy, vercel.json, or the site's code) is never touched: `apply` answers "present", and `add`
// answers "own" with the sources to add to it by hand.
//
//   node csp.mjs status      [--web-dir <d>]      the block, a policy of the person's own, or nothing
//   node csp.mjs apply       [--web-dir <d>] [--dry-run]
//                                                 the base and the reported script policy written
//   node csp.mjs add         [--web-dir <d>] --source <block> --directive <d> --domain <origin> [--domain ...]
//   node csp.mjs preset      [--web-dir <d>] <name>     the domains of a block that has no module of
//                                                 its own (google-analytics, openfreemap, stripe-js,
//                                                 youtube, spotify)
//   node csp.mjs remove      [--web-dir <d>] --source <block>
//   node csp.mjs frame       [--web-dir <d>] --path <source> [--off]   a path shown in the site's own frame
//   node csp.mjs form-action [--web-dir <d>] --off --reason "<the form that posts elsewhere>" | --on
//   node csp.mjs host        [--web-dir <d>]      Vercel's toolbar (previews), added by /bootstrap
//   node csp.mjs storage     [--project-dir <d>] [--web-dir <d>]
//                                                 the addresses of the project's files (R2_* variables
//                                                 of its .env.local / .env), replacing what the storage
//                                                 had asked for before; "none" without storage
//   node csp.mjs adopt       [--web-dir <d>]      apply, then the presets whose sign the project carries,
//                                                 and the toolbar on a Vercel project (an existing
//                                                 project: /update-hypervibe, /security)
//
//   import { applyCsp, addCspSources, addCspPreset } from "./csp.mjs";
//     -> { state: "written" | "current" | "missing" | "present" | "own" | "review", file, reason? }
//
// "present": a CSP of the person's own, nothing written. "own": the same, met by an addition, whose
// `reason` lists the sources to add by hand. "review": what could not be written, `reason` saying what
// to do by hand. "missing": what --dry-run answers where it would write. A caller says these, it never
// fails a whole run on them. One JSON object on stdout. Exit codes: 0, or 1 for a wrong argument.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FILES = ["next.config.ts", "next.config.mjs", "next.config.js"];
export const START = "// hypervibe-csp:start";
export const END = "// hypervibe-csp:end";

/** The enforced base, in its order. */
export const BASE = [
  ["frame-ancestors", ["'none'"]],
  ["base-uri", ["'self'"]],
  ["object-src", ["'none'"]],
  ["form-action", ["'self'"]],
];
/** The reported policy before any block adds to it, and the order of its directives. A directive
 *  absent here appears once a block adds to it, starting from 'self'. */
const REPORTED = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
};
const ORDER = ["default-src", "script-src", "style-src", "img-src", "font-src", "connect-src", "frame-src", "media-src", "worker-src"];
/** What a block may add to: the reported fetch directives, and form-action (the base). */
export const ADDABLE = ["script-src", "style-src", "img-src", "font-src", "connect-src", "frame-src", "media-src", "worker-src", "form-action"];
/** A source a block may add: an https or wss origin (a leading *. allowed), no path; or data:/blob:.
 *  Never 'unsafe-*', a nonce, a bare * or http. */
const SOURCE = /^(?:(?:https|wss):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?|data:|blob:)$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** A path of the site, as a headers() source writes it: no quote, no space, no backslash. */
const PATH = /^\/[^\s"'`\\]*$/;
/** The pages the policy covers: everything but the API routes and the PDF files. Written with [.]
 *  rather than an escaped dot: Next.js's route matcher drops a backslash inside a lookahead
 *  (read on its path-to-regexp, 15/11/2026). */
export const PAGES = "/((?!api/|.*[.]pdf$).*)";
/** framed: the paths shown in a frame of the site itself; formAction false: a form posts elsewhere;
 *  enforceScripts: the script policy made blocking, by hand on the csp-settings line, once the
 *  project's reports were read (never written by a command of this file). */
const DEFAULT_SETTINGS = { framed: [], formAction: true, formActionReason: null, enforceScripts: false };

/** The blocks that have no module of their own to declare their domains: the list lives here, and
 *  `signal` is what `adopt` looks for in an existing project. Each read in the provider's own
 *  documentation, on the date given. */
export const PRESETS = {
  "google-analytics": {
    label: "Google Analytics (gtag.js)",
    // developers.google.com/tag-platform/security/guides/csp, 15/11/2026: Google Analytics without
    // Ads features (script-src-elem there, which falls back to script-src).
    signal: { text: ["googletagmanager.com/gtag/js"] },
    directives: {
      "script-src": ["https://www.googletagmanager.com"],
      "img-src": ["https://www.googletagmanager.com", "https://*.google-analytics.com"],
      "connect-src": ["https://www.googletagmanager.com", "https://*.google-analytics.com", "https://*.google.com"],
    },
  },
  openfreemap: {
    label: "OpenFreeMap (the map's tiles)",
    // The style tiles.openfreemap.org/styles/liberty, read on 15/11/2026: its tiles, sprites and fonts
    // all come from tiles.openfreemap.org. MapLibre itself (maplibre.org/maplibre-gl-js/docs, CSP
    // directives): worker-src 'self' and img-src data: blob: 'self', which the reported policy has.
    signal: { text: ["tiles.openfreemap.org"] },
    directives: {
      "connect-src": ["https://tiles.openfreemap.org"],
      "img-src": ["https://tiles.openfreemap.org"],
    },
  },
  "stripe-js": {
    label: "Stripe.js (Elements, embedded pricing table)",
    // docs.stripe.com/security/guide#content-security-policy, 15/11/2026, Stripe.js. Not for the
    // hosted Checkout /add-stripe writes: it is a redirection, nothing of Stripe's loads on the page.
    signal: { deps: ["@stripe/stripe-js"], text: ["js.stripe.com"] },
    directives: {
      "script-src": ["https://js.stripe.com", "https://*.js.stripe.com"],
      "frame-src": ["https://js.stripe.com", "https://*.js.stripe.com", "https://hooks.stripe.com"],
      "connect-src": ["https://api.stripe.com"],
    },
  },
  youtube: {
    label: "YouTube videos",
    // support.google.com/youtube/answer/171780, 15/11/2026: the privacy-enhanced player is served
    // from www.youtube-nocookie.com; the usual one from www.youtube.com.
    signal: { text: ["youtube-nocookie.com/embed", "youtube.com/embed"] },
    directives: { "frame-src": ["https://www.youtube-nocookie.com", "https://www.youtube.com"] },
  },
  spotify: {
    label: "Spotify players",
    // Spotify's oEmbed answer, 15/11/2026: the player's frame is https://open.spotify.com/embed/...
    signal: { text: ["open.spotify.com/embed"] },
    directives: { "frame-src": ["https://open.spotify.com"] },
  },
};

/** What the site's policy lets through for Vercel's toolbar, which Vercel shows on previews
 *  (vercel.com/docs/vercel-toolbar/managing-toolbar#using-a-content-security-policy, read on
 *  15/11/2026). Added at /bootstrap (and by adopt on a Vercel project): without it, every preview
 *  would report the toolbar. Vercel Analytics needs nothing: it is served from the site itself
 *  (/_vercel). Its line is named "host-vercel". */
export const HOST_SOURCE = "host-vercel";
export const VERCEL_TOOLBAR = {
  "script-src": ["https://vercel.live"],
  "connect-src": ["https://vercel.live", "wss://ws-us3.pusher.com"],
  "img-src": ["https://vercel.live", "https://vercel.com"],
  "frame-src": ["https://vercel.live"],
  "style-src": ["https://vercel.live"],
  "font-src": ["https://vercel.live", "https://assets.vercel.com"],
};

// ── reading the file ────────────────────────────────────────────────────────
function configFile(webDir) {
  const name = FILES.find((f) => existsSync(join(webDir, f)));
  return name ? { name, path: join(webDir, name) } : null;
}

function load(webDir) {
  const f = configFile(webDir);
  if (!f) return null;
  const raw = readFileSync(f.path, "utf8");
  return { ...f, eol: raw.includes("\r\n") ? "\r\n" : "\n", text: raw.split("\r\n").join("\n") };
}

function save(f, text) {
  writeFileSync(f.path, text.split("\n").join(f.eol), "utf8");
}

/** The block of the file: {from, to (index after END's line), sources, settings} | {bad} | null. */
export function readBlock(text) {
  const from = text.indexOf(START);
  if (from < 0) return null;
  const endAt = text.indexOf(END, from);
  if (endAt < 0) return { bad: `${START} has no ${END}.` };
  const lineEnd = text.indexOf("\n", endAt);
  const to = lineEnd < 0 ? text.length : lineEnd + 1;
  const body = text.slice(from, endAt);
  const sources = {};
  let settings = { ...DEFAULT_SETTINGS };
  for (const line of body.split("\n")) {
    const s = /^\s*\/\/ csp-source ([a-z0-9-]+) (\{.*\})\s*$/.exec(line);
    const t = /^\s*\/\/ csp-settings (\{.*\})\s*$/.exec(line);
    try {
      if (s) sources[s[1]] = cleanDirectives(JSON.parse(s[2]), s[1]);
      if (t) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(t[1]) };
    } catch (e) {
      return { bad: `A line of the block cannot be read (${e.message}): ${line.trim()}` };
    }
  }
  if (!Array.isArray(settings.framed) || settings.framed.some((p) => !PATH.test(p))) return { bad: "The csp-settings line names a framed path that is not a path of the site." };
  return { from, to, sources, settings };
}

/** A block's directives, checked: only what may be added, only sources as they may be written. */
function cleanDirectives(directives, name) {
  if (!directives || typeof directives !== "object" || Array.isArray(directives)) throw new Error(`the sources of ${name} are not an object`);
  const out = {};
  for (const [d, list] of Object.entries(directives)) {
    if (!ADDABLE.includes(d)) throw new Error(`${d} is not a directive a block may add to (${ADDABLE.join(", ")})`);
    if (!Array.isArray(list)) throw new Error(`the sources of ${d} are not a list`);
    for (const v of list) if (!SOURCE.test(String(v))) throw new Error(`"${v}" is not a source a block may add (an https:// or wss:// origin without a path, or data:, blob:)`);
    if (list.length) out[d] = [...new Set(list.map(String))];
  }
  return out;
}

// ── writing the block ───────────────────────────────────────────────────────
const union = (...lists) => [...new Set(lists.flat())];

/** The merged policy: {base, baseFramed, reported: [[directive, sources]]}. */
export function policy(sources, settings = DEFAULT_SETTINGS) {
  const added = {};
  for (const directives of Object.values(sources)) {
    for (const [d, list] of Object.entries(directives)) added[d] = union(added[d] ?? [], list);
  }
  const base = BASE.filter(([d]) => d !== "form-action" || settings.formAction !== false).map(([d, v]) => [d, d === "form-action" ? union(v, added["form-action"] ?? []) : v]);
  const say = (list) => list.map(([d, v]) => `${d} ${v.join(" ")}`).join("; ");
  const framed = base.map(([d, v]) => [d, d === "frame-ancestors" ? ["'self'"] : v]);
  const reported = ORDER.filter((d) => REPORTED[d] || added[d]).map((d) => [d, union(REPORTED[d] ?? ["'self'"], added[d] ?? [])]);
  return { base: say(base), baseFramed: say(framed), reported };
}

export function renderBlock(sources, settings = DEFAULT_SETTINGS) {
  const p = policy(sources, settings);
  const lines = [
    `${START} (written by the Hypervibe harness, scripts/csp.mjs)`,
    "// The site's Content-Security-Policy, in two parts.",
    "// - The base is enforced and blocks nothing a site loads: no plugin, no <base> tag, no page shown",
    "//   in another site's frame, forms sent to this site only.",
    "// - The script policy is only reported (Report-Only): the browser says in its console what it",
    "//   would block, and blocks nothing. Making it blocking is a decision for this project, taken",
    "//   after reading those reports.",
    "// No nonce, on purpose: a nonce makes Next.js render every page at each visit (no static page).",
    "// Each building block adds its domains on a csp-source line when it installs; the constants below",
    "// are rewritten from those lines: change a line, or run the harness's command, never the policy.",
    ...Object.keys(sources).sort().map((name) => `// csp-source ${name} ${JSON.stringify(sources[name])}`),
    `// csp-settings ${JSON.stringify({ framed: settings.framed ?? [], formAction: settings.formAction !== false, formActionReason: settings.formActionReason ?? null, enforceScripts: settings.enforceScripts === true })}`,
  ];
  const enforce = settings.enforceScripts === true;
  if (enforce) lines.push("// The script policy is BLOCKING (enforceScripts, set by hand after reading the reports).");
  if (settings.formAction === false) lines.push(`// form-action is not set: ${String(settings.formActionReason ?? "a form of the site posts to another site").replace(/\n/g, " ")}`);
  lines.push(`const cspBase = "${p.base}";`);
  if (settings.framed?.length) lines.push(`const cspBaseFramed = "${p.baseFramed}";`);
  lines.push("const cspReportOnly = [");
  for (const [d, v] of p.reported) {
    if (d === "script-src") {
      const [self, inline, ...rest] = v;
      lines.push(`  \`script-src ${self} ${inline}\${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}${rest.length ? ` ${rest.join(" ")}` : ""}\`,`);
    } else lines.push(`  "${d} ${v.join(" ")}",`);
  }
  lines.push('].join("; ");');
  lines.push("const cspHeaders = [");
  lines.push("  {");
  lines.push("    // Pages only: the API routes and the PDF files are left out (Chrome's PDF viewer refuses to");
  lines.push("    // open under object-src 'none').");
  lines.push(`    source: "${PAGES}",`);
  lines.push("    headers: [");
  if (enforce) lines.push('      { key: "Content-Security-Policy", value: `${cspBase}; ${cspReportOnly}` },');
  else {
    lines.push('      { key: "Content-Security-Policy", value: cspBase },');
    lines.push('      { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },');
  }
  lines.push("    ],");
  lines.push("  },");
  for (const path of settings.framed ?? []) {
    lines.push("  // Shown in a frame of the site itself: this rule comes last, and the last one to set a header wins.");
    lines.push("  {");
    lines.push(`    source: "${path}",`);
    lines.push("    headers: [");
    lines.push('      { key: "X-Frame-Options", value: "SAMEORIGIN" },');
    lines.push(enforce ? '      { key: "Content-Security-Policy", value: `${cspBaseFramed}; ${cspReportOnly}` },' : '      { key: "Content-Security-Policy", value: cspBaseFramed },');
    lines.push("    ],");
    lines.push("  },");
  }
  lines.push("];");
  lines.push(END);
  return `${lines.join("\n")}\n`;
}

// ── a policy of the person's own ────────────────────────────────────────────
const OWN = /Content-Security-Policy/i;
const CODE = /\.(?:[cm]?[jt]sx?)$/;

/** Where the project already sets a CSP of its own (the block excluded): [paths]. */
export function ownCsp(webDir, configText = null) {
  const found = [];
  if (configText !== null && OWN.test(configText)) found.push(configFile(webDir)?.name ?? "next.config");
  for (const f of ["middleware.ts", "middleware.js", "middleware.mjs", "proxy.ts", "proxy.js", "vercel.json"]) {
    if (existsSync(join(webDir, f)) && OWN.test(readFileSync(join(webDir, f), "utf8"))) found.push(f);
  }
  const visit = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      const r = `${rel}/${name}`;
      if (statSync(full).isDirectory()) visit(full, r);
      else if (CODE.test(name) && OWN.test(readFileSync(full, "utf8"))) found.push(r);
    }
  };
  if (existsSync(join(webDir, "src"))) visit(join(webDir, "src"), "src");
  return found;
}

// ── wiring headers() ────────────────────────────────────────────────────────
/** The index of the bracket that closes the one at `open`, strings and comments skipped. */
function closing(text, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i <= 0) return -1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === "\\") i += 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** The end of the expression that starts at `from`: the `;` (or the closing brace of the body) at
 *  depth 0. */
function expressionEnd(text, from, bodyEnd) {
  for (let i = from; i < bodyEnd; i += 1) {
    const c = text[i];
    if (c === ";") return i;
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0 || i >= bodyEnd) return bodyEnd;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i <= 0) return -1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      const j = closing(text, i);
      if (j < 0) return -1;
      i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === "\\") i += 1;
    }
  }
  return bodyEnd;
}

const HEADERS_FN = /\b(?:async\s+)?headers\s*\(\s*\)\s*(?::\s*[^{]+)?\{|\bheaders\s*:\s*async\s*\(\s*\)\s*(?::\s*[^=]+)?=>\s*\{/;
/** The config object literal, found as setup-security.mjs finds it. */
const OBJECT = /(const\s+\w+\s*(?::\s*[\w.]+)?\s*=\s*\{)(\s*\})?/;

/** `...cspHeaders` returned by the config's headers(): {text} | {reason}. */
function wire(text) {
  const from = text.indexOf(START);
  const outside = from < 0 ? text : text.slice(0, from) + text.slice(text.indexOf(END, from));
  if (/\.\.\.cspHeaders\b/.test(outside) || /\breturn\s+cspHeaders\b/.test(outside)) return { text };
  const fn = HEADERS_FN.exec(text);
  if (!fn) {
    const m = OBJECT.exec(text);
    if (!m) return { reason: "the config object was not found: return ...cspHeaders from its headers() by hand." };
    const key = ["  async headers() {", "    return [...cspHeaders];", "  },"].join("\n");
    const inserted = m[2] ? `${m[1]}\n${key}\n}` : `${m[1]}\n${key}`;
    return { text: text.slice(0, m.index) + inserted + text.slice(m.index + m[0].length) };
  }
  const open = fn.index + fn[0].length - 1;
  const close = closing(text, open);
  if (close < 0) return { reason: "its headers() could not be read: return ...cspHeaders from it by hand, last." };
  const body = text.slice(open + 1, close);
  const returns = [...body.matchAll(/\breturn\b/g)];
  if (returns.length !== 1) return { reason: "its headers() returns in more than one place: add ...cspHeaders, last, to what it returns, by hand." };
  const exprStart = open + 1 + returns[0].index + "return".length;
  const end = expressionEnd(text, exprStart, close);
  if (end < 0) return { reason: "its headers() could not be read: return ...cspHeaders from it by hand, last." };
  const expr = text.slice(exprStart, end);
  const trimmed = expr.trim();
  let next;
  const lead = expr.slice(0, expr.length - expr.trimStart().length);
  if (trimmed.startsWith("[") && closing(trimmed, 0) === trimmed.length - 1) {
    const inner = trimmed.slice(1, -1);
    const tail = /\s*$/.exec(inner)[0];
    const head = inner.slice(0, inner.length - tail.length);
    if (!head.trim()) next = "[...cspHeaders]";
    else if (tail.includes("\n")) {
      const lastLine = head.slice(head.lastIndexOf("\n") + 1);
      const indent = /^\s*/.exec(lastLine)[0];
      next = `[${head}${head.trimEnd().endsWith(",") ? "" : ","}\n${indent}...cspHeaders,${tail}]`;
    } else next = `[${head.trimEnd().replace(/,$/, "")}, ...cspHeaders]`;
  } else {
    next = `[...(${trimmed}), ...cspHeaders]`;
  }
  return { text: text.slice(0, exprStart) + lead + next + text.slice(end) };
}

/** Where the block goes: after the harness's securityHeaders, else before the config object (and
 *  before the JSDoc that types it). */
function insertBlock(text, block) {
  const sec = /const\s+securityHeaders\b[^=\n]*=\s*\[/.exec(text);
  if (sec) {
    const close = closing(text, sec.index + sec[0].length - 1);
    if (close >= 0) {
      const lineEnd = text.indexOf("\n", close);
      const at = lineEnd < 0 ? text.length : lineEnd + 1;
      return `${text.slice(0, at)}\n${block}${text.slice(at)}`;
    }
  }
  const m = OBJECT.exec(text);
  if (!m) return null;
  let at = text.lastIndexOf("\n", m.index - 1) + 1;
  const before = text.slice(0, at).replace(/\n$/, "");
  const prev = before.slice(before.lastIndexOf("\n") + 1);
  if (/^\s*\/\*\*.*\*\/\s*$/.test(prev)) at = before.lastIndexOf("\n") + 1;
  return `${text.slice(0, at)}${block}\n${text.slice(at)}`;
}

// ── the gestures ────────────────────────────────────────────────────────────
/** The block written (or rewritten from its own lines) and headers() wired. `mutate` changes
 *  {sources, settings} before the block is written. */
function write(webDir, { write: really = true, mutate = null } = {}) {
  const dir = resolve(webDir);
  const f = load(dir);
  if (!f) return { state: "review", file: null, reason: "No next.config.(ts|mjs|js) in the site's folder: the Content-Security-Policy was not written." };
  let text = f.text;
  const block = readBlock(text);
  if (block?.bad) return { state: "review", file: f.name, reason: `The harness's Content-Security-Policy block of ${f.name} cannot be read: ${block.bad} Put the line back as it was, then run the command again.` };
  if (!block) {
    const own = ownCsp(dir, text);
    if (own.length) return { state: "present", file: f.name, where: own };
  }
  const state = { sources: block ? { ...block.sources } : {}, settings: block ? { ...block.settings } : { ...DEFAULT_SETTINGS } };
  if (mutate) {
    const r = mutate(state);
    if (r?.error) return { state: "review", file: f.name, reason: r.error };
  }
  const rendered = renderBlock(state.sources, state.settings);
  if (block) text = text.slice(0, block.from) + rendered + text.slice(block.to);
  else {
    const at = insertBlock(text, rendered);
    if (at === null) return { state: "review", file: f.name, reason: `The config object of ${f.name} was not found: the Content-Security-Policy was not written.` };
    text = at;
  }
  const wired = wire(text);
  if (wired.reason) return { state: "review", file: f.name, reason: `The Content-Security-Policy block is ready, but ${wired.reason}` };
  text = wired.text;
  if (text === f.text) return { state: "current", file: f.name, sources: Object.keys(state.sources).sort() };
  if (really) save(f, text);
  return { state: really ? "written" : "missing", file: f.name, sources: Object.keys(state.sources).sort() };
}

/** The base and the reported script policy, written or brought in step. */
export function applyCsp(webDir, opts = {}) {
  return write(webDir, opts);
}

const listOf = (directives) => Object.entries(directives).map(([d, v]) => `${d} ${v.join(" ")}`).join("; ");

/** A block's domains added to the reported policy (form-action: to the base). `replace`: the
 *  block's line becomes exactly these (a block whose address changed, the storage's). */
export function addCspSources(webDir, source, directives, { replace = false, ...opts } = {}) {
  if (!NAME.test(String(source ?? ""))) throw new Error(`Not a block name: "${source}" (lowercase letters, digits, dashes).`);
  const clean = cleanDirectives(directives, source);
  const r = write(webDir, {
    ...opts,
    mutate: (s) => {
      const had = replace ? {} : (s.sources[source] ?? {});
      const merged = { ...had };
      for (const [d, v] of Object.entries(clean)) merged[d] = union(had[d] ?? [], v);
      s.sources[source] = merged;
    },
  });
  if (r.state === "present") {
    return { state: "own", file: r.file, where: r.where, reason: `This project has a Content-Security-Policy of its own (${r.where.join(", ")}): add ${listOf(clean)} to it by hand.` };
  }
  return r;
}

export function addCspPreset(webDir, name, opts = {}) {
  const p = PRESETS[name];
  if (!p) throw new Error(`Unknown preset: "${name}" (${Object.keys(PRESETS).join(", ")}).`);
  return { ...addCspSources(webDir, name, p.directives, opts), preset: name, label: p.label };
}

/** Vercel's toolbar in the reported policy (the host of every project of this harness). */
export function addCspHost(webDir, opts = {}) {
  return addCspSources(webDir, HOST_SOURCE, VERCEL_TOOLBAR, opts);
}

// ── the storage's addresses (/add-storage: Cloudflare R2) ───────────────────
/** The R2_* variables of the project's .env.local then .env (the first file wins), as r2-check.mjs
 *  reads them. */
export function readStorageEnv(projectDir) {
  const found = {};
  for (const file of [".env.local", ".env"]) {
    const p = join(projectDir, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^(R2_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || found[m[1]]) continue;
      found[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return found;
}

/** The origins the visitor's browser reaches the project's files at: the endpoint (path-style
 *  addresses), the bucket in the endpoint's host name (the S3 client's default, virtual-hosted
 *  addresses), and the public address when the bucket has one. null without an endpoint. */
export function storageOrigins(env) {
  if (!env.R2_ENDPOINT) return null;
  const origins = [];
  const add = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol === "https:") origins.push(`https://${u.host.toLowerCase()}`);
    } catch {
      // not an address: nothing to let through
    }
  };
  add(env.R2_ENDPOINT);
  if (env.R2_BUCKET_NAME && /^[a-z0-9][a-z0-9-]{1,62}$/.test(env.R2_BUCKET_NAME)) {
    try {
      add(`https://${env.R2_BUCKET_NAME}.${new URL(env.R2_ENDPOINT).host}`);
    } catch {
      // not an address
    }
  }
  if (env.R2_PUBLIC_URL) add(env.R2_PUBLIC_URL);
  return [...new Set(origins)].filter((o) => SOURCE.test(o));
}

/** Those origins in the site's policy (images, media, and the browser's own uploads), replacing
 *  what the storage had asked for before (a new bucket, a new public address). */
export function storageCsp(projectDir, webDir = projectDir, opts = {}) {
  const origins = storageOrigins(readStorageEnv(resolve(projectDir)));
  if (!origins) return { state: "none", reason: "The project's .env names no R2_ENDPOINT: it has no storage, nothing to add." };
  if (!origins.length) return { state: "review", reason: "The project's R2_ENDPOINT is not an https address: nothing was added to the site's policy." };
  return { ...addCspSources(webDir, "storage", { "img-src": origins, "media-src": origins, "connect-src": origins }, { replace: true, ...opts }), origins };
}

export function removeCspSource(webDir, source, opts = {}) {
  return write(webDir, { ...opts, mutate: (s) => void delete s.sources[source] });
}

export function setFramed(webDir, path, { on = true, ...opts } = {}) {
  if (!PATH.test(String(path ?? ""))) throw new Error(`Not a path of the site: "${path}" (it starts with /, for instance /embed/:path*).`);
  return write(webDir, {
    ...opts,
    mutate: (s) => {
      const list = (s.settings.framed ?? []).filter((p) => p !== path);
      s.settings.framed = on ? [...list, path] : list;
    },
  });
}

export function setFormAction(webDir, { on, reason = null, ...opts } = {}) {
  if (!on && !String(reason ?? "").trim()) throw new Error("form-action --off takes --reason: the form that posts to another site, said in a few words.");
  return write(webDir, {
    ...opts,
    mutate: (s) => {
      s.settings.formAction = Boolean(on);
      s.settings.formActionReason = on ? null : String(reason).trim();
    },
  });
}

export function status(webDir) {
  const dir = resolve(webDir);
  const f = load(dir);
  if (!f) return { state: "none", file: null };
  const block = readBlock(f.text);
  if (block?.bad) return { state: "review", file: f.name, reason: block.bad };
  if (block) return { state: "block", file: f.name, sources: block.sources, settings: block.settings, wired: !wire(f.text).reason && wire(f.text).text === f.text };
  const own = ownCsp(dir, f.text);
  return own.length ? { state: "present", file: f.name, where: own } : { state: "absent", file: f.name };
}

/** What the project carries of a preset's sign: its dependencies, then a text of its code. */
function carries(dir, signal) {
  let deps = {};
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // no package.json: only the code is read
  }
  if ((signal.deps ?? []).some((d) => deps[d])) return true;
  let hit = false;
  const visit = (d) => {
    for (const name of readdirSync(d)) {
      if (hit || name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (CODE.test(name)) {
        const t = readFileSync(full, "utf8");
        if ((signal.text ?? []).some((s) => t.includes(s))) hit = true;
      }
    }
  };
  if (existsSync(join(dir, "src"))) visit(join(dir, "src"));
  return hit;
}

/** An existing project: the block, then each preset whose sign the project carries, and Vercel's
 *  toolbar when the site is a Vercel project (vercel.json or .vercel/). */
export function adopt(webDir, opts = {}) {
  const dir = resolve(webDir);
  const base = applyCsp(dir, opts);
  if (base.state === "present" || base.state === "review") return { ...base, presets: [] };
  const presets = [];
  for (const [name, p] of Object.entries(PRESETS)) {
    if (!carries(dir, p.signal)) continue;
    const r = addCspSources(dir, name, p.directives, opts);
    presets.push({ preset: name, label: p.label, state: r.state });
  }
  if (existsSync(join(dir, "vercel.json")) || existsSync(join(dir, ".vercel"))) {
    const r = addCspHost(dir, opts);
    presets.push({ preset: HOST_SOURCE, label: "Vercel toolbar (previews)", state: r.state });
  }
  const after = status(dir);
  return { state: base.state === "current" && presets.every((p) => p.state === "current") ? "current" : opts.write === false ? "missing" : "written", file: base.file, presets, sources: after.sources ? Object.keys(after.sources).sort() : [] };
}

// ── command line ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = { domain: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (["dry-run", "off", "on"].includes(key)) flags[key] = true;
    else if (key === "domain") {
      flags.domain.push(String(argv[i + 1] ?? ""));
      i += 1;
    } else {
      flags[key] = argv[i + 1];
      i += 1;
    }
  }
  return { flags, positional };
}

const USAGE = "Usage: csp.mjs <status|apply|add|preset|host|storage|remove|frame|form-action|adopt> [--web-dir <d>] (see the head of the file)";

export function runCli(argv) {
  const { flags, positional } = parseArgs(argv);
  const [verb, arg] = positional;
  const webDir = flags["web-dir"] ?? process.cwd();
  const opts = { write: !flags["dry-run"] };
  switch (verb) {
    case "status":
      return status(webDir);
    case "apply":
      return applyCsp(webDir, opts);
    case "add":
      if (!flags.directive || !flags.domain.length) throw new Error("add takes --source <block> --directive <directive> --domain <origin> [--domain ...].");
      return addCspSources(webDir, flags.source, { [flags.directive]: flags.domain.map((d) => d.toLowerCase()) }, opts);
    case "preset":
      return addCspPreset(webDir, arg, opts);
    case "host":
      return addCspHost(webDir, opts);
    case "storage":
      return storageCsp(flags["project-dir"] ?? webDir, flags["web-dir"] ?? flags["project-dir"] ?? process.cwd(), opts);
    case "remove":
      if (!flags.source) throw new Error("remove takes --source <block>.");
      return removeCspSource(webDir, flags.source, opts);
    case "frame":
      return setFramed(webDir, flags.path, { on: !flags.off, ...opts });
    case "form-action":
      if (Boolean(flags.on) === Boolean(flags.off)) throw new Error("form-action takes --on, or --off --reason \"...\".");
      return setFormAction(webDir, { on: Boolean(flags.on), reason: flags.reason, ...opts });
    case "adopt":
      return adopt(webDir, opts);
    default:
      throw new Error(USAGE);
  }
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
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...runCli(process.argv.slice(2)) })}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e.message || String(e) })}\n`);
    process.exitCode = 1;
  }
}
