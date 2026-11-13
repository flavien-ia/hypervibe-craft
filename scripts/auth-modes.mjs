// auth-modes.mjs - What a project's src/server/auth.ts holds, read from its marker and its code.
//
// /add-auth writes `// hypervibe:auth-modes <modes>` in every auth.ts it makes: `admin`, `users`,
// or `admin, users` for a combined sign-in (the admin login grafted on user accounts, or the other
// way round). A script that REPLACES the whole file (setup-2fa.mjs, the admin 2FA) may only do so
// over the admin-only file: a combined marker passed its old check (`admin\b`), and the rewrite
// removed the users' sign-in without a word (report of 12/11/2026).
//
// A library: nothing runs on import.

/** The modes named by the marker line, in order (`["admin", "users"]`), or null without a marker. */
export function authModes(text) {
  const marker = String(text).match(/^\/\/ hypervibe:auth-modes[ \t]+(.*?)[ \t]*\r?$/m);
  if (!marker) return null;
  return marker[1].split(/[\s,]+/).filter(Boolean);
}

/**
 * Why this auth.ts is not one an admin-only rewrite may replace, or null when it is the admin-only
 * sign-in of /add-auth: its marker says `admin` and nothing else, and it holds no other way in (no
 * accounts in the database, no OAuth provider).
 */
export function adminOnlyRefusal(text) {
  const modes = authModes(text);
  if (!modes) {
    return "Auth isn't in hypervibe admin mode (marker `// hypervibe:auth-modes admin` not found). src/server/auth.ts was left as it is.";
  }
  if (modes.length !== 1 || modes[0] !== "admin") {
    return `src/server/auth.ts holds the sign-in modes "${modes.join(", ")}", not the admin login alone: this script rewrites the whole file in admin-only mode and would remove the others. Nothing was installed nor written, and src/server/auth.ts was left as it is. The 2FA of user accounts goes through _setup-2fa-users; the admin of a combined sign-in has none yet.`;
  }
  const others = [
    [/\bDrizzleAdapter\b|\bdb\.query\b|\bdb\.select\b/, "accounts in the database"],
    // Any provider of next-auth but the Credentials one (an outside sign-in added by its skill).
    [/from\s+["']next-auth\/providers\/(?!credentials["'])[\w-]+["']/, "an OAuth provider"],
  ]
    .filter(([re]) => re.test(text))
    .map(([, what]) => what);
  if (others.length) {
    return `src/server/auth.ts is marked admin but also holds ${others.join(" and ")}: this script rewrites the whole file in admin-only mode and would remove them. Nothing was installed nor written, and src/server/auth.ts was left as it is.`;
  }
  return null;
}
