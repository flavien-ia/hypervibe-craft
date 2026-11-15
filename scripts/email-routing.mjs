#!/usr/bin/env node
// email-routing.mjs - Cloudflare's Email Routing on a domain's zone, for /new-email-address
// (3.4.11). Email Routing takes the domain's MX for itself: it cannot share them with a mail
// provider (Google Workspace, Microsoft 365, OVH's mail...), Cloudflare's documentation says so.
// Until 3.4.11 the skill enabled it without looking at the zone's MX and threw the answer away:
// on a domain with real mailboxes, their mail could stop arriving (outside review of 3.4.10).
//
//   node email-routing.mjs status <domain>
//        read: {ok, enabled, status, foreignMx}
//   node email-routing.mjs enable <domain>
//        refused (exit 2, nothing changed) while the zone has mail servers other than Email
//        Routing's own; otherwise enables it, then reads the zone's settings back:
//        {ok, enabled, status, already}
//        A refusal for lack of the key's right "Zone · Zone Settings · Edit" names it (`missingRight`).
//
// Exit codes: 0 done, 1 a read failed or Cloudflare refused (its words in `error`), 2 the domain
// receives its mail elsewhere (`foreignMx`), 3 the vault is locked or its session expired, 4 no
// Cloudflare key in the vault, 5 usage. One JSON object on stdout, never a key.
//
// Recettes only: HYPERVIBE_CLOUDFLARE_API, a fake on the loopback (anything else is ignored); with
// it, and only then, the key may come from CLOUDFLARE_API_TOKEN.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const EXIT = { OK: 0, UNREADABLE: 1, ELSEWHERE: 2, LOCKED: 3, NO_KEY: 4, USAGE: 5 };
/** Email Routing's own mail servers: route1.mx.cloudflare.net and its siblings. */
export const isRoutingMx = (host) => /^route\d+\.mx\.cloudflare\.net\.?$/i.test(String(host ?? ""));

/** The Cloudflare API's base: Cloudflare's, or a recette's fake on the loopback. */
export function apiBase(env = process.env) {
  const o = env.HYPERVIBE_CLOUDFLARE_API;
  return o && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o) ? `${o}/client/v4` : CLOUDFLARE;
}
/** The key: from the environment only with a recette's loopback API, from the vault otherwise. */
export function readKey(env = process.env, base = apiBase(env), vault = fromVault) {
  if (base !== CLOUDFLARE) return env.CLOUDFLARE_API_TOKEN ? { key: env.CLOUDFLARE_API_TOKEN } : { code: EXIT.NO_KEY, error: "No Cloudflare key." };
  const r = vault();
  if (r.status === 2 || r.status === 3) return { code: EXIT.LOCKED, error: "The vault is locked (or its session expired): open it, then retry." };
  const key = String(r.value ?? "").trim();
  return r.status === 0 && key ? { key } : { code: EXIT.NO_KEY, error: "The Cloudflare key is not in the vault (item CLOUDFLARE, field api_token): /start sets it up." };
}
function fromVault() {
  const r = spawnSync(process.execPath, [join(HERE, "vault", "vault.mjs"), "get", "CLOUDFLARE", "api_token"], { encoding: "utf8", windowsHide: true });
  return { status: r.status, value: String(r.stdout ?? "").trim() };
}

async function cf(base, key, path, method = "GET") {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, ok: res.status === 200 && json?.success === true };
}
const said = (r) => r.json?.errors?.[0]?.message ?? `HTTP ${r.status}`;
/** Reading Email Routing's settings and enabling it need the key's right "Zone · Zone Settings ·
 *  Edit" (3.4.31 / 2.5.10): a key made before it was in the lists is refused (403, Cloudflare's
 *  codes 10000 or 9109). The refusal then names that right. */
export const ZONE_SETTINGS_RIGHT = "Zone · Zone Settings · Edit";
const refused = (r) => r.status === 401 || r.status === 403 || (r.json?.errors ?? []).some((e) => e.code === 10000 || e.code === 9109);
const lacksRight = (r) => (refused(r) ? ` The Cloudflare key lacks the right "${ZONE_SETTINGS_RIGHT}": add it to the key (https://dash.cloudflare.com/profile/api-tokens, the key's line, Edit, then the Zone policy block), or enable Email Routing once in the dashboard (the domain, Email, Email Routing).` : "");

/** The zone's MX and routing settings: {zoneId, mx, settings} or {error}. */
async function read(base, key, domain) {
  const zones = await cf(base, key, `/zones?name=${encodeURIComponent(domain)}`);
  if (!zones.ok) return { error: `The zone could not be read at Cloudflare: ${said(zones)}` };
  const list = zones.json.result ?? [];
  if (list.length !== 1) return { error: list.length ? `Several Cloudflare zones are named ${domain} (several accounts): say which one.` : `No Cloudflare zone for ${domain}: connect the domain with /add-domain first.` };
  const zoneId = list[0].id;
  const mx = await cf(base, key, `/zones/${zoneId}/dns_records?type=MX&per_page=100`);
  if (!mx.ok) return { error: `The zone's mail servers could not be read: ${said(mx)}` };
  const settings = await cf(base, key, `/zones/${zoneId}/email/routing`);
  if (!settings.ok) return { error: `The zone's Email Routing settings could not be read: ${said(settings)}.${lacksRight(settings)}`, ...(refused(settings) ? { missingRight: ZONE_SETTINGS_RIGHT } : {}) };
  return { zoneId, mx: (mx.json.result ?? []).map((r) => String(r.content ?? "").toLowerCase()), settings: settings.json.result ?? {} };
}

async function main(argv, env = process.env) {
  const [verb, domain] = argv;
  if (!["status", "enable"].includes(verb) || !DOMAIN.test(String(domain ?? "")) || argv.length !== 2) {
    return { code: EXIT.USAGE, out: { ok: false, error: "Usage: email-routing.mjs status|enable <domain> (lower case, without www. or https://)." } };
  }
  const base = apiBase(env);
  const k = readKey(env, base);
  if (!k.key) return { code: k.code, out: { ok: false, error: k.error } };
  try {
    const before = await read(base, k.key, domain);
    if (before.error) return { code: EXIT.UNREADABLE, out: { ok: false, domain, error: before.error, ...(before.missingRight ? { missingRight: before.missingRight } : {}) } };
    const foreignMx = before.mx.filter((h) => !isRoutingMx(h));
    const state = { domain, enabled: before.settings.enabled === true, status: before.settings.status ?? null, foreignMx };
    if (verb === "status") return { code: EXIT.OK, out: { ok: true, ...state } };
    if (foreignMx.length) {
      return { code: EXIT.ELSEWHERE, out: { ok: false, ...state, error: `This domain receives its mail elsewhere (${foreignMx.join(", ")}): Email Routing would take its mail servers over. Nothing was changed.` } };
    }
    if (state.enabled) return { code: EXIT.OK, out: { ok: true, ...state, already: true } };
    const on = await cf(base, k.key, `/zones/${before.zoneId}/email/routing/enable`, "POST");
    if (!on.ok) return { code: EXIT.UNREADABLE, out: { ok: false, ...state, error: `Cloudflare refused to enable Email Routing: ${said(on)}.${lacksRight(on)}`, ...(refused(on) ? { missingRight: ZONE_SETTINGS_RIGHT } : {}) } };
    const after = await cf(base, k.key, `/zones/${before.zoneId}/email/routing`);
    if (!after.ok) return { code: EXIT.UNREADABLE, out: { ok: false, ...state, error: `Email Routing's settings could not be read back: ${said(after)}` } };
    const enabled = after.json.result?.enabled === true;
    return {
      code: enabled ? EXIT.OK : EXIT.UNREADABLE,
      out: { ok: enabled, domain, enabled, status: after.json.result?.status ?? null, already: false, foreignMx: [], ...(enabled ? {} : { error: "Cloudflare answered, but Email Routing does not read back as enabled." }) },
    };
  } catch (e) {
    return { code: EXIT.UNREADABLE, out: { ok: false, domain, error: `Cloudflare could not be reached: ${e.message}` } };
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
  const { code, out } = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}
