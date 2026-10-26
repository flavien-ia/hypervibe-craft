// _inventory-rules.mjs - Small rules of the inventory, kept apart so a recette can hold them
// without running a whole discovery (scripts/tests/test-delete-vault.mjs).

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A variable the host or the build tooling injects by itself (`vercel env pull` writes them into
 *  the file it produces: VERCEL_GIT_*, VERCEL_OIDC_TOKEN, TURBO_*, NX_DAEMON...) is never a
 *  service the project is connected to. NX_CLOUD_* stays: that one is an account. */
export const isSystemVar = (name) =>
  name.startsWith("VERCEL_") || name.startsWith("TURBO_") || (name.startsWith("NX_") && !name.startsWith("NX_CLOUD_"));

/** A variable whose name says the project uses Stripe. */
export const isStripeVar = (name) => /^(NEXT_PUBLIC_)?STRIPE_/.test(name);

/**
 * Where the code of a project's folder stands in git (3.4.16): is it a repository, what is not
 * committed, what exists nowhere else. A folder without any cloud infrastructure (an old project,
 * a mock-up) is deleted by hand, and its code is lost with it unless it lives elsewhere: the same
 * check had been improvised twice, once where the code would have been lost (hypervibe-learn,
 * 23/10/2026). A figure git could not give is null, never 0. `run` is spawnSync (a recette may pass
 * its own).
 *
 * "Elsewhere" is asked of the remotes themselves (3.4.17, Bastien Detraz's report of 25/10/2026):
 * counted against this copy's own idea of its remotes, a deleted remote repository (the usual case
 * of a folder whose cloud is gone), work put aside by `git stash`, or a commit that only a tag
 * carries, all read 0, and the verdict was "deletable without loss" for code that existed nowhere
 * else. Each remote is asked with `git ls-remote` (ten seconds at most, never a prompt); one that
 * does not answer proves nothing, and with no remote answering, `unpushed` is null.
 *
 * No git command here runs a program that the repository's configuration names: the folder may
 * have been copied from anywhere, and its configuration may name any program. `status` runs with
 * the file system monitor off, no hooks, no optional lock (so no index written), the filters of the
 * repository's own configuration emptied and submodules ignored; the reads of history show no
 * signature; no pager; the remotes are asked from outside the repository, their address handed over
 * through the environment (never on a command line, where the process list shows it), with only
 * git's own transports allowed.
 */
export function localGitState(dir, run, { lsRemoteTimeout = 10000 } = {}) {
  // An empty folder of our own: the hooks' folder git is pointed to, and where the remotes are asked.
  const neutre = mkdtempSync(join(tmpdir(), "hv-git-neutre-"));
  try {
    const sure = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${neutre}`, "-c", "core.virtualFilesystem=", "-c", "log.showSignature=false"];
    const git = (args, opts = {}) => run("git", ["-C", dir, ...sure, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
    const lines = (r) => (r.status === 0 ? String(r.stdout ?? "").split(/\r?\n/).filter((l) => l.trim()) : null);
    const top = git(["rev-parse", "--show-toplevel"]);
    if (top.status !== 0) return { repo: false };
    const root = String(top.stdout ?? "").trim();

    // What is not committed. The filters the repository's own configuration defines run on every
    // file `status` reads again (a copied folder: all of them): emptied here. When the configuration
    // cannot be read, `status` does not run at all.
    const filtres = git(["config", "--show-scope", "--includes", "--name-only", "--get-regexp", "^filter\\..+\\.(clean|smudge|process)$"]);
    let uncommitted = null;
    if (filtres.status === 0 || filtres.status === 1) {
      const vides = (filtres.status === 0 ? String(filtres.stdout ?? "") : "")
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter(([portee, cle]) => cle && (portee === "local" || portee === "worktree"))
        .flatMap(([, cle]) => ["-c", `${cle}=`]);
      const status = lines(git([...vides, "status", "--porcelain", "--ignore-submodules=all"]));
      uncommitted = status === null ? null : status.length;
    }
    const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const remotes = lines(git(["remote"]));

    // What each remote really holds, asked of it: a copy's own idea of its remotes dates from its
    // last fetch, and outlives the remote repository.
    const remotesAnswered = [];
    const remotesSilent = [];
    const theirs = new Set();
    for (const name of remotes ?? []) {
      const url = git(["config", "--get", `remote.${name}.url`]);
      const address = url.status === 0 ? String(url.stdout ?? "").trim() : "";
      // A helper's syntax (`<transport>::<address>`, `ext::` runs a command) is never asked.
      if (!address || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(address)) {
        remotesSilent.push(name);
        continue;
      }
      const env = {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.hv-distant.url",
        GIT_CONFIG_VALUE_0: address,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GCM_INTERACTIVE: "never",
        GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
        GIT_CEILING_DIRECTORIES: dirname(neutre),
      };
      delete env.GIT_DIR;
      delete env.GIT_WORK_TREE;
      if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=8";
      const ls = run("git", ["--no-pager", "ls-remote", "hv-distant"], { cwd: neutre, env, encoding: "utf8", timeout: lsRemoteTimeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      if (ls.status !== 0) {
        remotesSilent.push(name);
        continue;
      }
      remotesAnswered.push(name);
      for (const l of String(ls.stdout ?? "").split(/\r?\n/)) {
        const sha = l.trim().split(/\s+/)[0];
        if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha ?? "")) theirs.add(sha);
      }
    }

    // The commits of the local branches, the tags and the HEAD that no remote that answered holds.
    // A head the copy never fetched cannot be compared: `remoteAhead` says the count may be too high.
    let unpushed = null;
    let remoteAhead = false;
    if (remotes !== null && (remotes.length === 0 || remotesAnswered.length > 0)) {
      let connus = [];
      let lu = true;
      if (theirs.size) {
        const check = git(["cat-file", "--batch-check"], { input: `${[...theirs].join("\n")}\n` });
        if (check.status === 0) {
          for (const l of String(check.stdout ?? "").split(/\r?\n/)) {
            const [sha, type] = l.trim().split(/\s+/);
            if (!sha) continue;
            if (type === "missing") remoteAhead = true;
            else connus.push(sha);
          }
        } else lu = false;
      }
      if (lu) {
        const head = git(["rev-parse", "--verify", "--quiet", "HEAD"]).status === 0 ? ["HEAD"] : [];
        const count = git(["rev-list", "--count", "--branches", "--tags", ...head, "--stdin"], { input: connus.map((s) => `^${s}\n`).join("") });
        unpushed = count.status === 0 ? Number(String(count.stdout ?? "").trim()) : null;
        if (!Number.isInteger(unpushed)) unpushed = null;
      }
    }

    // Work put aside by `git stash`: a stash is never pushed.
    const stash = git(["rev-parse", "--verify", "--quiet", "refs/stash"]);
    let stashed = null;
    if (stash.status === 1) stashed = 0;
    else if (stash.status === 0) {
      const entries = lines(git(["log", "-g", "--no-show-signature", "--format=%H", "refs/stash", "--"]));
      stashed = entries && entries.length ? entries.length : 1;
    }

    // Submodules are not looked into (their own configuration would apply): nothing is proven for them.
    const index = lines(git(["ls-files", "--stage"]));
    const submodules = index === null ? null : index.filter((l) => l.startsWith("160000 ")).length;

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
      uncommitted,
      upstream: upstream.status === 0 ? String(upstream.stdout ?? "").trim() : null,
      unpushed,
      stashed,
      submodules,
      remotes: remotes ?? [],
      remotesAnswered,
      remotesSilent,
      remoteAhead,
    };
  } finally {
    rmSync(neutre, { recursive: true, force: true });
  }
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

// ─── A service this machine has no account at (3.4.17) ──────────────────────────────────────────
//
// Section 1.1 of /delete-project (a folder with nothing in the cloud) needs an inventory where no
// section carries an `error`. Until 3.4.17 a section carried one as soon as its service had no
// account on this machine: Upstash ("~/.upstash.json missing") on every machine without an Upstash
// account, Render on every machine without a Render key, the database, the site, the storage and
// the other Cloudflare sections when their key was not there, the backups when no backup worker was
// set up here. Most people never reached 1.1, and the normal path said "could not check" for
// services they never used. Such a section is now `skipped`, with its reason, when this machine has
// no account there AND nothing of the project points to the service. As soon as something does,
// the error stays: what the project holds there could not be listed, and the person must know.
// Only "no account here" is settled this way: a vault that is locked or expired, a key the service
// refused, a read or a request that failed stay errors.

/**
 * A provider key the inventory reads: from the vault first, else from this machine's environment,
 * with what its absence means. `absent` is true only when the vault ANSWERED that it holds no such
 * key (no such item or field, codes 4 and 5 of vault.mjs, or the field left empty) and no variable
 * holds one either: this machine has no account at that service. A vault that is locked or expired
 * (2, 3), or whose read failed (1, or anything else), never makes a key absent: the key may well
 * be in it. `getSecret` is vault.mjs's, `readEnv` reads a variable of this machine (a recette
 * passes its own).
 * @returns {{value: string, absent: boolean}}
 */
export function readProviderKey({ item, field, envNames = [] }, { getSecret, readEnv }) {
  let vaultHasNone = false;
  try {
    const value = getSecret(item, field);
    if (value) return { value, absent: false };
    vaultHasNone = true;
  } catch (e) {
    vaultHasNone = e?.code === 4 || e?.code === 5;
  }
  for (const name of envNames) {
    const value = readEnv(name);
    if (value) return { value, absent: false };
  }
  return { value: "", absent: vaultHasNone };
}

/**
 * What points to each service, in a project. Wider on purpose than the signs the privacy audit
 * reads (scripts/privacy/services.mjs): there, a false sign adds a line to a policy; here, a missing
 * one would hide a service the project uses behind "nothing to check". `backup` is the shared
 * backup worker, which the manifest records as `db-backup`.
 */
const POINTERS = {
  upstash: { vars: [/^UPSTASH_/, /^KV_REST_API_/, /^KV_URL$/], packages: [/^@upstash\//, /^@vercel\/kv$/], kinds: ["upstash-db"], files: [] },
  render: { vars: [/^RENDER_/], packages: [], kinds: ["render-service"], files: ["render.yaml", "render.yml"] },
  neon: { vars: [/^NEON_/], packages: [/^@neondatabase\//], kinds: ["neon-project", "db-backup"], files: [], databases: true },
  vercel: { vars: [/^VERCEL_/, /^NEXT_PUBLIC_VERCEL_/], packages: [/^@vercel\//, /^vercel$/], kinds: ["vercel-project"], files: [".vercel/project.json", "vercel.json"] },
  cloudflare: {
    vars: [/^CLOUDFLARE_/, /^CF_/, /^R2_/],
    packages: [/^wrangler$/, /^@cloudflare\//],
    kinds: ["r2-bucket", "cf-worker", "dns-zone", "dns-record", "email-route"],
    files: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"],
  },
  backup: { vars: [], packages: [], kinds: ["db-backup"], files: [] },
};

/** The files of a service, looked for in the project's folder and its workspaces. */
export const POINTER_FILES = [...new Set(Object.values(POINTERS).flatMap((p) => p.files))];

/** The variables that hold the connection to a database. */
const DATABASE_VARS = /^(DATABASE_URL|DATABASE_URL_UNPOOLED|DIRECT_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|POSTGRES_URL_NON_POOLING|POSTGRES_URL_NO_SSL|PGHOST|PGHOST_UNPOOLED)$/;

/** A connection that names this machine or a placeholder, never a database in the cloud: the
 *  scaffold's `postgresql://postgres:password@localhost:5432/app`, an empty value, a template. Any
 *  other value counts as a database in the cloud. */
export function localConnection(value) {
  const v = String(value ?? "").trim();
  if (!v || /^(localhost|127\.0\.0\.1|::1)$/i.test(v)) return true;
  return [/@localhost(?:[:/?]|$)/i, /@127\.0\.0\.1(?:[:/?]|$)/, /@\[::1\](?:[:/?]|$)/, /^file:/i, /placeholder/i, /YOUR_[A-Z]/, /<[^>]*>/, /\bchangeme\b/i].some((re) => re.test(v));
}

/** The folder and its workspaces one level down (apps/*, packages/*: a monorepo keeps a site's
 *  variables, packages and link there), as {rel, abs}. */
function projectRoots(dir) {
  const roots = [{ rel: "", abs: dir }];
  for (const group of ["apps", "packages"]) {
    let names = [];
    try {
      names = readdirSync(join(dir, group));
    } catch {
      continue;
    }
    for (const name of names.slice(0, 50)) {
      try {
        if (name !== "node_modules" && statSync(join(dir, group, name)).isDirectory()) roots.push({ rel: `${group}/${name}`, abs: join(dir, group, name) });
      } catch {
        // gone in the meantime
      }
    }
  }
  return roots;
}

const unquote = (s) => String(s ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");

/**
 * The facts projectPointers reads, from the project's folder and its workspaces: the names of the
 * variables of `.env` and `.env.local` (and those the host's production gave, `pulledVarNames`,
 * whose values the inventory never keeps), whether each database connection names this machine
 * or the cloud (only that word is kept, never the value), the packages, the files of a service,
 * the kinds of the manifest's entries. A file that is there but cannot be read is listed in
 * `unreadable`: what it says is unknown, so it counts as pointing everywhere.
 */
export function readProjectFacts(dir, { pulledVarNames = [], manifestKinds = [] } = {}) {
  const varNames = new Set(pulledVarNames);
  const dependencies = new Set();
  const files = [];
  const unreadable = [];
  const connections = [];
  for (const name of pulledVarNames) if (DATABASE_VARS.test(name)) connections.push({ name, where: "unknown" });
  const read = (abs, rel) => {
    if (!existsSync(abs)) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      unreadable.push(rel);
      return null;
    }
  };
  for (const { rel, abs } of projectRoots(dir)) {
    const at = (f) => (rel ? `${rel}/${f}` : f);
    for (const envFile of [".env", ".env.local"]) {
      const text = read(join(abs, envFile), at(envFile));
      if (text === null) continue;
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
        if (!m) continue;
        varNames.add(m[1]);
        if (DATABASE_VARS.test(m[1])) connections.push({ name: m[1], where: localConnection(unquote(m[2])) ? "local" : "cloud" });
      }
    }
    const pkg = read(join(abs, "package.json"), at("package.json"));
    if (pkg !== null) {
      try {
        const p = JSON.parse(pkg);
        for (const d of [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]) dependencies.add(d);
      } catch {
        unreadable.push(at("package.json"));
      }
    }
    for (const f of POINTER_FILES) if (existsSync(join(abs, f))) files.push(at(f));
  }
  return { varNames: [...varNames], dependencies: [...dependencies], manifestKinds: [...new Set(manifestKinds)], files, connections, unreadable };
}

/**
 * For each service of POINTERS, what of the project points to it (empty: nothing does): a
 * variable, a package, an entry of the manifest, a file of the service, a connection to a database
 * outside this machine, or a file that could not be read.
 * @returns {Record<string, string[]>}
 */
export function projectPointers({ varNames = [], dependencies = [], manifestKinds = [], files = [], connections = [], unreadable = [] } = {}) {
  const out = {};
  for (const [service, p] of Object.entries(POINTERS)) {
    const why = [];
    for (const v of varNames) if (p.vars.some((re) => re.test(v))) why.push(`variable ${v}`);
    for (const d of dependencies) if (p.packages.some((re) => re.test(d))) why.push(`package ${d}`);
    for (const k of manifestKinds) if (p.kinds.includes(k)) why.push(`manifest entry ${k}`);
    for (const f of files) if (p.files.some((m) => f === m || f.endsWith(`/${m}`))) why.push(`file ${f}`);
    if (p.databases) for (const c of connections) if (c.where !== "local") why.push(`database connection ${c.name}`);
    for (const u of unreadable) why.push(`unreadable ${u}`);
    out[service] = why;
  }
  return out;
}

/** The sections that can have no account on this machine: [section, service, what `skipped` says]. */
export const WITHOUT_ACCOUNT = [
  ["upstash", "upstash", "no Upstash account on this machine (~/.upstash.json), and nothing in the project points to Upstash"],
  ["render", "render", "no Render key on this machine, and nothing in the project points to Render"],
  ["neon", "neon", "no Neon key on this machine, and nothing in the project points to a database in the cloud"],
  ["vercel", "vercel", "no Vercel sign-in on this machine, and nothing in the project points to Vercel"],
  ["workers", "cloudflare", "no Cloudflare key on this machine, and nothing in the project points to Cloudflare"],
  ["r2", "cloudflare", "no Cloudflare key on this machine, and nothing in the project points to Cloudflare"],
  ["dns", "cloudflare", "no Cloudflare key on this machine, and nothing in the project points to Cloudflare"],
  ["emailRouting", "cloudflare", "no Cloudflare key on this machine, and nothing in the project points to Cloudflare"],
  ["dbBackup", "backup", "no backup worker set up on this machine, and the project's manifest records no backup"],
];

/**
 * Settles the sections whose service has no account on this machine. Each scan says it by
 * `noAccount: true`, and only for that cause (a file or a key that is not there). Such a section
 * becomes `skipped` when nothing of the project points to its service (`pointers`, from
 * projectPointers); it keeps its error otherwise. The marker never reaches the inventory.
 * Changes the sections in place, and returns the names of those it turned into skipped ones.
 */
export function settleWithoutAccount(sections, pointers) {
  const settled = [];
  for (const [name, service, skipped] of WITHOUT_ACCOUNT) {
    const section = sections?.[name];
    if (!section || typeof section !== "object" || section.noAccount !== true) continue;
    delete section.noAccount;
    if ((pointers?.[service] ?? []).length > 0) continue;
    delete section.error;
    if (name === "dbBackup") section.isTarget = false;
    else section.found = false;
    section.skipped = skipped;
    settled.push(name);
  }
  return settled;
}
