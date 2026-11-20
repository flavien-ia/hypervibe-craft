#!/usr/bin/env node
// Apply security hardening to a fresh T3 scaffold.
//
// Usage:
//   node setup-security.mjs          (from project root)
//
// What it does (all idempotent - safe to re-run):
//   1. Patches next.config.(js|mjs|ts) by INJECTING securityHeaders + poweredByHeader:false
//      + reactStrictMode:true + async headers() into the existing config object. The file
//      is never regenerated, so wrapped configs (next-intl, PWA...) and custom options
//      (redirects, remotePatterns...) survive. Also strips the deprecated X-XSS-Protection
//      header if a previous version of this script added it. Also injects
//      images.remotePatterns for the placeholder hosts (picsum.photos, fastly.picsum.photos,
//      images.unsplash.com) when the config has no `images` key: without it, next/image answers
//      400 for every placeholder image the project rules prescribe. An existing `images` key is
//      never touched.
//   2. Wraps the `[TRPC]` timing console.log in src/server/api/trpc.ts with
//      `if (t._config.isDev)` so timing info doesn't leak in production logs.
//   3. Creates src/lib/rate-limit.ts (in-memory rate limiter with auto-cleanup).
//   4. Appends `rateLimitedProcedure` to src/server/api/trpc.ts (with `checkRateLimit`
//      import) so other skills can use it for public routes that accept user input.
//      Its error message is written in English - the calling skill translates it to
//      the project's language afterwards.
//   5. Writes the site's Content-Security-Policy (scripts/csp.mjs): a base that is
//      enforced and blocks nothing a site loads (frame-ancestors, base-uri, object-src,
//      form-action), and a script policy that is only REPORTED (Report-Only), to which each
//      building block adds its domains when it installs. Merged into the existing headers(),
//      never a nonce (it would render every page at each visit), and never over a CSP the
//      project already sets: that one is left as it is, and said.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyCsp } from "./csp.mjs";

const actions = [];

// ─── 1. next.config ────────────────────────────────────────────────────
const SECURITY_HEADERS_BLOCK = `const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];
`;

// The hosts of the placeholder images the rules prescribe (Lorem Picsum, which redirects to its
// fastly mirror, and Unsplash). next/image only optimizes a remote image whose host is listed:
// without them, every placeholder answers 400 at the optimizer (seen on 13/11/2026).
const PLACEHOLDER_IMAGE_HOSTS = ["picsum.photos", "fastly.picsum.photos", "images.unsplash.com"];
const IMAGES_KEY = `  images: {
    remotePatterns: [
${PLACEHOLDER_IMAGE_HOSTS.map((h) => `      { protocol: "https", hostname: "${h}" },`).join("\n")}
    ],
  },`;

function patchNextConfig() {
  const candidates = ["next.config.ts", "next.config.mjs", "next.config.js"];
  const file = candidates.find((f) => existsSync(f));
  if (!file) {
    actions.push("⚠️  next.config.(ts|mjs|js) not found - skipping security headers patch");
    return;
  }

  let content = readFileSync(file, "utf8");
  let changed = false;

  // Deprecated header: remove it if a previous version of this script (or a human) added it.
  const xssLine = /^[ \t]*\{\s*key:\s*["']X-XSS-Protection["'][^}]*\},?[ \t]*\r?\n/m;
  if (xssLine.test(content)) {
    content = content.replace(xssLine, "");
    changed = true;
    actions.push(`✓ ${file}: removed deprecated X-XSS-Protection header`);
  }

  // The placeholder hosts, before the headers: a project patched by an earlier version (headers
  // already there) gets them too. Any `images` key, even one without remotePatterns, is the
  // project's own and stays as it is.
  const configObj = /(const\s+\w+\s*(?::\s*[\w.]+)?\s*=\s*\{)/;
  if (/\bimages\s*:/.test(content)) {
    actions.push(`✓ ${file}: an images key is already present (left as it is)`);
  } else if (configObj.test(content)) {
    // An empty object ({}) gets its closing brace back on its own line.
    const emptyObj = new RegExp(`${configObj.source}\\s*\\}`);
    content = emptyObj.test(content)
      ? content.replace(emptyObj, `$1\n${IMAGES_KEY}\n}`)
      : content.replace(configObj, `$1\n${IMAGES_KEY}`);
    changed = true;
    actions.push(`✓ ${file}: injected images.remotePatterns (${PLACEHOLDER_IMAGE_HOSTS.join(", ")})`);
  } else {
    actions.push(`⚠️  ${file}: could not locate the config object literal - add images.remotePatterns manually`);
  }

  if (content.includes("X-Content-Type-Options")) {
    actions.push(`✓ ${file}: security headers already present`);
    if (changed) writeFileSync(file, content);
    return;
  }

  // The config may be wrapped (next-intl, PWA...) or carry custom options
  // (redirects, remotePatterns...) - inject into the existing object, never regenerate.
  if (/async\s+headers\s*\(/.test(content)) {
    actions.push(
      `⚠️  ${file}: has a custom headers() but no security headers - merge securityHeaders into it manually`,
    );
    if (changed) writeFileSync(file, content);
    return;
  }

  const objRe = /(const\s+\w+\s*(?::\s*[\w.]+)?\s*=\s*\{)/;
  const m = content.match(objRe);
  if (!m) {
    actions.push(
      `⚠️  ${file}: could not locate the config object literal - add securityHeaders manually`,
    );
    if (changed) writeFileSync(file, content);
    return;
  }

  const keys = [];
  if (!/poweredByHeader/.test(content)) keys.push("  poweredByHeader: false,");
  if (!/reactStrictMode/.test(content)) keys.push("  reactStrictMode: true,");
  keys.push(`  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },`);

  content = content.replace(objRe, `${SECURITY_HEADERS_BLOCK}\n$1\n${keys.join("\n")}`);
  writeFileSync(file, content);
  actions.push(`✓ ${file}: injected securityHeaders + headers() into the existing config`);
}

// ─── 2. trpc.ts : wrap console.log + add rateLimitedProcedure ──────────
function patchTrpcFile() {
  const file = "src/server/api/trpc.ts";
  if (!existsSync(file)) {
    actions.push(`⚠️  ${file} not found - skipping trpc patches`);
    return;
  }

  let content = readFileSync(file, "utf8");
  let changed = false;

  // 2a. Wrap the "[TRPC] ... took ...ms" console.log with isDev guard (idempotent)
  const alreadyWrapped = /if\s*\(\s*t\._config\.isDev\s*\)\s*\{\s*console\.log\(`\[TRPC\]/.test(
    content,
  );
  if (!alreadyWrapped) {
    // Pattern: a bare `console.log(\`[TRPC] ... took ...ms\`);` line with its leading whitespace
    const bare = /^([ \t]*)console\.log\((`\[TRPC\][^`]*`)\);/m;
    if (bare.test(content)) {
      content = content.replace(
        bare,
        (_, indent, tpl) =>
          `${indent}if (t._config.isDev) {\n${indent}  console.log(${tpl});\n${indent}}`,
      );
      changed = true;
      actions.push(`✓ ${file}: wrapped [TRPC] timing console.log with isDev guard`);
    } else {
      actions.push(`⚠️  ${file}: [TRPC] console.log pattern not found - leaving unchanged`);
    }
  } else {
    actions.push(`✓ ${file}: [TRPC] timing already guarded`);
  }

  // 2b. Add rateLimitedProcedure (idempotent)
  if (content.includes("rateLimitedProcedure")) {
    actions.push(`✓ ${file}: rateLimitedProcedure already present`);
  } else {
    // Ensure TRPCError is imported
    if (!/import\s*\{[^}]*TRPCError[^}]*\}\s*from\s*["']@trpc\/server["']/.test(content)) {
      if (/import\s*\{([^}]*)\}\s*from\s*["']@trpc\/server["']/.test(content)) {
        content = content.replace(
          /import\s*\{([^}]*)\}\s*from\s*["']@trpc\/server["']/,
          (_, inner) => {
            const trimmed = inner.trim();
            const sep = trimmed.endsWith(",") ? "" : ",";
            return `import { ${trimmed}${sep} TRPCError } from "@trpc/server"`;
          },
        );
      } else {
        // Prepend an import if @trpc/server isn't imported in any form (unlikely in T3 but safe)
        content = `import { TRPCError } from "@trpc/server";\n${content}`;
      }
    }

    // Add the checkRateLimit import
    if (!content.includes(`from "~/lib/rate-limit"`)) {
      const lastImportMatch = content.match(/^(?:import[^;]+;[\r\n]*)+/);
      const insertion = `import { checkRateLimit } from "~/lib/rate-limit";\n`;
      if (lastImportMatch) {
        content = content.replace(lastImportMatch[0], lastImportMatch[0] + insertion);
      } else {
        content = insertion + content;
      }
    }

    // Append the rateLimitedProcedure export at end of file.
    // The message is written in English on purpose - the calling skill translates it
    // to the project's language right after running this script.
    const procedureBlock = `
export const rateLimitedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  // A request that carries no address falls in one of twenty counts drawn at random: no single
  // count of five closes the door on everyone (the old "unknown" did), and a flood still meets a
  // ceiling, twenty times wider.
  const forwarded = ctx.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = forwarded === "" ? null : forwarded;
  const { allowed, retryAfterMs } = checkRateLimit(ip ?? \`no-address:\${Math.floor(Math.random() * 20)}\`);
  if (!allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: \`Too many attempts. Try again in \${Math.ceil((retryAfterMs ?? 0) / 1000 / 60)} minute(s).\`,
    });
  }
  return next();
});
`;
    content = content.trimEnd() + "\n" + procedureBlock;
    changed = true;
    actions.push(`✓ ${file}: added rateLimitedProcedure + imports`);
  }

  if (changed) writeFileSync(file, content);
}

// ─── 3. src/lib/rate-limit.ts ──────────────────────────────────────────
function writeRateLimitFile() {
  const file = "src/lib/rate-limit.ts";
  if (existsSync(file)) {
    actions.push(`✓ ${file}: already exists (not overwritten)`);
    return;
  }

  mkdirSync(dirname(file), { recursive: true });

  const content = `// In-memory rate limiter, on purpose. Every running copy of the server keeps
// its own count and a restart resets it: under a real attack, a limit of 5 can
// let a few more attempts through. At this site's scale that still makes
// guessing a password or a code impractical, with no service, key or account
// to add. The security audit reports it as a known limit, not as a flaw. If a
// real attack ever shows up, its "Shared counter" moves the count into this
// project's own database: no new service.
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const attempts = new Map<string, { count: number; firstAttempt: number }>();

// Auto-cleanup expired entries every 5 minutes
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of attempts) {
    if (now - value.firstAttempt > WINDOW_MS) attempts.delete(key);
  }
}, 5 * 60 * 1000);
cleanup.unref(); // Don't prevent serverless process from exiting

export function checkRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAttempt: now });
    return { allowed: true };
  }

  if (entry.count >= MAX_ATTEMPTS) {
    const retryAfterMs = WINDOW_MS - (now - entry.firstAttempt);
    return { allowed: false, retryAfterMs };
  }

  entry.count++;
  return { allowed: true };
}
`;

  writeFileSync(file, content);
  actions.push(`✓ ${file}: created`);
}

// ─── 5. Content-Security-Policy ────────────────────────────────────────
function patchCsp() {
  const r = applyCsp(process.cwd());
  if (r.state === "written") actions.push(`✓ ${r.file}: Content-Security-Policy written (base enforced, script policy reported only)`);
  else if (r.state === "current") actions.push(`✓ ${r.file}: Content-Security-Policy already in place`);
  else if (r.state === "present") actions.push(`✓ ${r.file}: the project sets a Content-Security-Policy of its own (${r.where.join(", ")}), left as it is`);
  else actions.push(`⚠️  CSP_REVIEW: ${r.reason}`);
}

// ─── Run ───────────────────────────────────────────────────────────────
patchNextConfig();
patchCsp();
writeRateLimitFile();
patchTrpcFile();

console.log("");
console.log("Security hardening:");
for (const a of actions) console.log(`  ${a}`);
console.log("");
console.log("✅ Security hardening applied.");
