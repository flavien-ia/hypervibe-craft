// _inventory-rules.mjs - Small rules of the inventory, kept apart so a recette can hold them
// without running a whole discovery (scripts/tests/test-delete-vault.mjs).

import { realpathSync } from "node:fs";

/** A variable the host or the build tooling injects by itself (`vercel env pull` writes them into
 *  the file it produces: VERCEL_GIT_*, VERCEL_OIDC_TOKEN, TURBO_*, NX_DAEMON...) is never a
 *  service the project is connected to. NX_CLOUD_* stays: that one is an account. */
export const isSystemVar = (name) =>
  name.startsWith("VERCEL_") || name.startsWith("TURBO_") || (name.startsWith("NX_") && !name.startsWith("NX_CLOUD_"));

/** A variable whose name says the project uses Stripe. */
export const isStripeVar = (name) => /^(NEXT_PUBLIC_)?STRIPE_/.test(name);

/**
 * Where the code of a project's folder stands in git (3.4.16): is it a repository, what is not
 * committed, what is committed but on no remote. A folder without any cloud infrastructure (an
 * old project, a mock-up) is deleted by hand, and its code is lost with it unless it lives
 * elsewhere: the same check had been improvised twice, once where the code would have been lost
 * (hypervibe-learn, 23/10/2026). Read only, five seconds at most per call; a figure git could not
 * give is null, never 0. `run` is spawnSync (a recette may pass its own).
 */
export function localGitState(dir, run) {
  const git = (...args) => run("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
  const lines = (r) => (r.status === 0 ? String(r.stdout ?? "").split(/\r?\n/).filter((l) => l.trim()) : null);
  const top = git("rev-parse", "--show-toplevel");
  if (top.status !== 0) return { repo: false };
  const root = String(top.stdout ?? "").trim();
  const status = lines(git("status", "--porcelain"));
  const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  // Commits of every local branch that no remote has: what a deletion would take with it.
  const unpushed = lines(git("log", "--branches", "--not", "--remotes", "--oneline", "--no-decorate", "--no-color"));
  const remotes = lines(git("remote"));
  // The same folder, however it is spelled: its real path (macOS's /var is /private/var), one kind
  // of separator, no trailing one, and on Windows no case.
  const norm = (p) => {
    let real = String(p);
    try {
      real = realpathSync(real);
    } catch {
      // A path that cannot be resolved is compared as written.
    }
    const flat = real.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? flat.toLowerCase() : flat;
  };
  const same = (a, b) => norm(a) === norm(b);
  return {
    repo: true,
    root,
    // The folder is only part of a larger repository: deleting it is a change in that one.
    insideLarger: !same(root, String(dir)),
    uncommitted: status === null ? null : status.length,
    upstream: upstream.status === 0 ? String(upstream.stdout ?? "").trim() : null,
    unpushed: unpushed === null ? null : unpushed.length,
    remotes: remotes ?? [],
  };
}

/**
 * The Stripe section of an inventory, when no Stripe key could be read.
 *
 * A project that has no Stripe is not a scan that failed. Without a key, the section used to
 * carry `error: "STRIPE_SECRET_KEY missing"` for EVERY project, and the skill reads an `error` as
 * "this scan could not run, tell the user": the two contradicted each other, and the reader
 * learned to pass over an `error`. The error stays only when the project references Stripe (one
 * of its variables, the package, or a webhook it declares): there, its webhooks could not be
 * listed, and the person must know.
 *
 * Changes `stripe` in place. Returns true when the section was turned into a "skipped" one.
 */
export function settleStripeWithoutKey(stripe, { hasStripeVar, dependencies, manifestKinds } = {}) {
  const usesStripe =
    hasStripeVar === true ||
    (Array.isArray(dependencies) && dependencies.includes("stripe")) ||
    (Array.isArray(manifestKinds) && manifestKinds.includes("stripe-webhook"));
  if (usesStripe) return false;
  delete stripe.error;
  stripe.found = false;
  stripe.webhooksFound = false;
  stripe.skipped = "project has no Stripe";
  return true;
}
