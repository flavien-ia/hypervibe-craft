// _shared-exclusion.mjs - A resource the project's manifest declares SHARED never leaves
// with the project, whatever its kind.
//
// The name scans of discover-resources.mjs may pick it up (a shared bucket, database,
// service, zone or repository whose name contains the project's); this takes it back out of
// the deletion inventory, into the section's `excluded` list, with the reason. Until the
// storage lot (18/09/2026) only a shared worker was taken out, and until an outside review of
// 3.2.4 only five kinds of the thirteen the manifest knows: a shared Upstash database was
// still deleted for good, and so were shared DNS records, email routes, backup targets,
// scheduled pings, Vercel projects and a shared repository was offered for deletion.

const EXCLUDED_REASON = "declared shared in the project manifest (never deleted here)";

const lower = (value) => String(value ?? "").toLowerCase();
const byIdOrName = (item, r) => Boolean((r.id && item.id === r.id) || (r.name && item.name === r.name));

/** Does an email routing rule deliver to this address? */
function routesTo(rule, address) {
  const wanted = lower(address);
  if (!wanted) return false;
  return (rule.matchers || []).some((m) => lower(m.value) === wanted) || lower(rule.name) === wanted;
}

/** kind -> where its resources sit in the inventory, and "is this entry that resource?".
 *  `list`: the array of a section; `flag`: the key that says the section holds something,
 *  which execute-deletions.mjs reads before deleting. A section that holds ONE resource (the
 *  backup target, the repository) has no list: `same` then reads the section itself. */
export const SHARED_RULES = {
  "cf-worker": { section: "workers", list: "workers", flag: "found", same: (item, r) => lower(item.id) === lower(r.name) },
  "r2-bucket": {
    section: "r2",
    list: "buckets",
    flag: "found",
    same: (item, r) => item.name === r.name && (item.jurisdiction || "global") === (r.jurisdiction === "eu" ? "eu" : "global"),
  },
  "neon-project": { section: "neon", list: "projects", flag: "found", same: byIdOrName },
  "render-service": { section: "render", list: "services", flag: "found", same: byIdOrName },
  "stripe-webhook": {
    section: "stripe",
    list: "webhooks",
    flag: "webhooksFound",
    same: (item, r) => Boolean((r.id && item.id === r.id) || (r.name && item.url === r.name)),
  },
  "upstash-db": { section: "upstash", list: "databases", flag: "found", same: byIdOrName },
  "vercel-project": { section: "vercel", list: "projects", flag: "found", same: byIdOrName },
  // A shared zone keeps every record the name scan found in it: which of them belong to
  // this project is a person's call, never a guess made before an irreversible deletion.
  "dns-zone": {
    section: "dns",
    list: "records",
    flag: "found",
    same: (item, r) => Boolean((r.id && item.zoneId === r.id) || (r.name && lower(item.zoneName) === lower(r.name))),
  },
  "email-route": { section: "emailRouting", list: "rules", flag: "found", same: (item, r) => routesTo(item, r.name) },
  // A ping job is named `<project>-<task>` since 2026-07-05; the manifest records the task.
  "cron-job": {
    section: "cronJobs",
    list: "jobs",
    flag: "found",
    same: (item, r, context) => lower(item.name) === lower(r.name) || (Boolean(context.project) && lower(item.name) === `${lower(context.project)}-${lower(r.name)}`),
  },
  "db-backup": { section: "dbBackup", flag: "isTarget", same: (section, r) => Boolean(section.isTarget) && lower(section.entry?.name) === lower(r.name) },
  "github-repo": {
    section: "github",
    flag: "exists",
    same: (section, r) =>
      Boolean(section.exists) && Boolean(r.name) && (lower(section.url).endsWith(`/${lower(r.name)}`) || lower(r.name).endsWith(`/${lower(section.name)}`)),
  },
};

/** The kinds of the manifest that nothing here deletes, so that nothing needs to protect. */
export const NOT_DELETED_KINDS = ["ai-key", "email-key"];

/** Every inventory section a rule reads: discover-resources.mjs hands them all over. */
export const SHARED_SECTIONS = [...new Set(Object.values(SHARED_RULES).map((rule) => rule.section))];

/** A project's own registrations on the shared clock are never shared, whatever the manifest
 *  says (3.3.9): a scheduled task calls this project's own route, and a backup is this project's
 *  database's, shared only when the manifest declares that database shared. Marked shared by
 *  mistake (the clock is shared, the flag followed), they were taken out of the deletion, and the
 *  clock would have kept backing up a deleted database. manifest.mjs refuses the flag on them
 *  since; this covers the manifests written before.
 *  @param {{kind: string, shared?: boolean}} resource  a manifest entry
 *  @param {Array<{kind: string, shared?: boolean}>} resources  the whole manifest
 *  @returns {string|null} why its shared flag is ignored, or null when the flag holds */
export function sharedIgnoredReason(resource, resources = []) {
  if (!resource?.shared) return null;
  if (resource.kind === "cron-job") {
    return "a scheduled task calls this project's own route: it leaves with the project, even marked shared";
  }
  if (resource.kind === "db-backup" && !resources.some((r) => r?.kind === "neon-project" && r.shared)) {
    return "the backup of this project's database, which the manifest does not declare shared: it leaves with the project, even marked shared";
  }
  return null;
}

/** Takes a declared shared resource out of its inventory section, in place.
 *  @param {Record<string, any>} sections  the inventory sections, as discover builds them
 *  @param {{kind: string, name?: string, id?: string, jurisdiction?: string}} resource
 *  @param {{project?: string}} [context]  the project being deleted
 *  @returns {number} how many inventory entries left the deletion list */
export function excludeShared(sections, resource, context = {}) {
  const rule = SHARED_RULES[resource?.kind];
  if (!rule) return 0;
  const section = sections?.[rule.section];
  if (!section || typeof section !== "object") return 0;

  if (!rule.list) {
    if (!rule.same(section, resource, context)) return 0;
    const { excluded, ...held } = section;
    delete held[rule.flag];
    section.excluded = [...(excluded || []), { ...held, excludedReason: EXCLUDED_REASON }];
    section[rule.flag] = false;
    return 1;
  }

  if (!Array.isArray(section[rule.list])) return 0;
  const kept = [];
  let moved = 0;
  for (const item of section[rule.list]) {
    if (rule.same(item, resource, context)) {
      section.excluded = [...(section.excluded || []), { ...item, excludedReason: EXCLUDED_REASON }];
      moved += 1;
    } else {
      kept.push(item);
    }
  }
  if (moved) {
    section[rule.list] = kept;
    section[rule.flag] = kept.length > 0;
  }
  return moved;
}
