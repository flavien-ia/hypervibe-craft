#!/usr/bin/env node
// cloudflare-token-page.mjs - The page that makes a Cloudflare API token with its permissions already
// ticked, so that a person checks and clicks instead of adding thirteen lines one by one with
// "+ Add more" (pre-training sessions of November 2026: that list is where people got stuck).
//
// Cloudflare fills the "Create Token" form from its address:
//   https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=<encoded JSON>&accountId=*&zoneId=all&name=<name>
// with [{"key": "<short key>", "type": "read|edit|purge"}]. Source:
// developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/. A key it does not
// know is DROPPED SILENTLY, with no notice on the page: every key below was read at the source, in
// the permission groups the dashboard itself loads (GET /user/tokens/permission_groups, 11/11/2026).
// There each group carries a `label`, its short key followed by its level ("dns_write",
// "cache_purge"); `write` is asked as "edit" in the address. `cfLabel` keeps that label, and the
// recette derives key and type from it. The three pages were opened and read down to the summary
// on 11/11/2026: every line was ticked, at its level, and nothing else.
//
// One list per key, and the skills read it from here, the page and the readable fallback alike:
//   account       the account's key of the solo harness (/start)
//   organisation  the organisation's key of the Enterprise administrator (/start)
//   project-r2    a project's own storage key, on one account only (/new-project, administrator)
//
//   node cloudflare-token-page.mjs <list> [--name "<token name>"] [--account-id <id>] [--lines]
// Prints {list, url, lines}: `lines` the fallback, "Account · Workers Scripts · Edit", in the
// dashboard's words. --lines prints only those, one per line. Exit 0, or 1 on a usage error.

const ACCOUNT_SOLO = [
  { scope: "Account", group: "Workers Scripts", level: "Edit", cfLabel: "workers_scripts_write" },
  { scope: "Account", group: "Workers R2 Storage", level: "Edit", cfLabel: "workers_r2_write" },
  { scope: "Account", group: "Workers AI", level: "Read", cfLabel: "ai_read" },
  { scope: "Account", group: "Email Routing Addresses", level: "Edit", cfLabel: "email_routing_address_write" },
  { scope: "Account", group: "Account Settings", level: "Read", cfLabel: "account_settings_read" },
  { scope: "Account", group: "Account Analytics", level: "Read", cfLabel: "account_analytics_read" },
  { scope: "User", group: "User Details", level: "Read", cfLabel: "user_details_read" },
  { scope: "User", group: "Memberships", level: "Read", cfLabel: "memberships_read" },
  { scope: "Zone", group: "Zone", level: "Edit", cfLabel: "zone_write" },
  { scope: "Zone", group: "DNS", level: "Edit", cfLabel: "dns_write" },
  { scope: "Zone", group: "Email Routing Rules", level: "Edit", cfLabel: "email_routing_rule_write" },
  { scope: "Zone", group: "Bot Management", level: "Read", cfLabel: "bot_management_read" },
  { scope: "Zone", group: "Cache Purge", level: "Purge", cfLabel: "cache_purge" },
];

const ORGANISATION = [
  { scope: "Account", group: "Workers Scripts", level: "Edit", cfLabel: "workers_scripts_write" },
  { scope: "Account", group: "Workers KV Storage", level: "Edit", cfLabel: "workers_kv_storage_write" },
  { scope: "Account", group: "Workers R2 Storage", level: "Edit", cfLabel: "workers_r2_write" },
  { scope: "Account", group: "Workers AI", level: "Read", cfLabel: "ai_read" },
  { scope: "Account", group: "Email Routing Addresses", level: "Edit", cfLabel: "email_routing_address_write" },
  { scope: "Account", group: "Account Settings", level: "Read", cfLabel: "account_settings_read" },
  { scope: "Account", group: "Account Analytics", level: "Read", cfLabel: "account_analytics_read" },
  { scope: "Account", group: "Notifications", level: "Edit", cfLabel: "notifications_write" },
  { scope: "User", group: "User Details", level: "Read", cfLabel: "user_details_read" },
  { scope: "User", group: "Memberships", level: "Read", cfLabel: "memberships_read" },
  { scope: "Zone", group: "Zone", level: "Edit", cfLabel: "zone_write" },
  { scope: "Zone", group: "DNS", level: "Edit", cfLabel: "dns_write" },
  { scope: "Zone", group: "Email Routing Rules", level: "Edit", cfLabel: "email_routing_rule_write" },
  { scope: "Zone", group: "Cache Purge", level: "Purge", cfLabel: "cache_purge" },
];

const PROJECT_R2 = [{ scope: "Account", group: "Workers R2 Storage", level: "Edit", cfLabel: "workers_r2_write" }];

export const LISTS = Object.freeze({ account: ACCOUNT_SOLO, organisation: ORGANISATION, "project-r2": PROJECT_R2 });
const NAMES = { account: "Claude Code", organisation: "Hypervibe Enterprise", "project-r2": "Claude Code project" };

/** The address's {key, type} of a permission group, from its label in Cloudflare's own list:
 *  the level is the label's last word ("read", "write", "purge"), and "write" is asked as "edit". */
export function keyOf(cfLabel) {
  const m = /^(.+)_(read|write|purge)$/.exec(cfLabel);
  if (!m) throw new Error(`not a permission label: ${cfLabel}`);
  return { key: m[1], type: m[2] === "write" ? "edit" : m[2] };
}

/** The fallback lines, in the dashboard's words: "Account · Workers Scripts · Edit". */
export function linesOf(list) {
  return LISTS[list].map((p) => `${p.scope} · ${p.group} · ${p.level}`);
}

/** The page that opens the form with the list ticked. `accountId`: the one account the token may
 *  touch, for a project's key; all accounts otherwise. */
export function tokenPage(list, { name = NAMES[list], accountId = "*" } = {}) {
  if (!LISTS[list]) throw new Error(`unknown list: ${list} (${Object.keys(LISTS).join(", ")})`);
  if (accountId !== "*" && !/^[0-9a-f]{32}$/.test(accountId)) throw new Error(`not a Cloudflare account id: ${accountId}`);
  const keys = LISTS[list].map((p) => keyOf(p.cfLabel));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&accountId=${encodeURIComponent(accountId)}&zoneId=all&name=${encodeURIComponent(name)}`;
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

const isMain = launchedDirectly();
if (isMain) {
  const [list, ...rest] = process.argv.slice(2);
  const flag = (f) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (!list || !LISTS[list]) throw new Error(`usage: cloudflare-token-page.mjs <${Object.keys(LISTS).join("|")}> [--name <name>] [--account-id <id>] [--lines]`);
    if (rest.includes("--lines")) console.log(linesOf(list).join("\n"));
    else console.log(JSON.stringify({ list, url: tokenPage(list, { name: flag("--name"), accountId: flag("--account-id") }), lines: linesOf(list) }, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
