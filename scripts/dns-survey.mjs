#!/usr/bin/env node
// dns-survey.mjs - What a domain's current DNS carries, read before /add-domain hands the domain to
// its Cloudflare zone, and what of it the zone lacks (3.4.11). The nameserver switch hands the
// WHOLE domain to the zone, and a zone created through Cloudflare's API starts empty (Cloudflare's
// scan of the existing records only runs in its dashboard): until 3.4.11 a domain that received
// mail stopped receiving it at propagation, its MX never carried over (outside review of 3.4.10).
//
//   node dns-survey.mjs <domain>            read: what the current DNS carries, and what the zone lacks
//   node dns-survey.mjs <domain> --copy     the same, then writes what the zone lacks, and reads again
//
// Read through public DNS (Google's resolver, Cloudflare's as a fallback), which still answers from
// the current nameservers until the switch:
//   - mail, carried when missing: the MX, every TXT of the domain itself (SPF, verifications), the
//     DMARC record, the DKIM keys under the selectors the main providers use, and the names mail
//     clients look up (autodiscover, autoconfig);
//   - other common names (www excepted, the site's own records come from the host), carried too,
//     unless the domain answers ANY name (a wildcard, usually the registrar's parking): then only
//     said, never carried.
// A DKIM key under a selector nobody can guess, SRV records, and names outside the list cannot be
// read this way: `dkimUnknown` and `notes` say it, for the person to check with their provider.
//
// Exit codes: 0 nothing the zone lacks (after --copy: everything written and read back), 1 a read
// failed (never taken for "nothing there"), 2 the zone lacks records (not written, or a write
// refused), 3 the vault is locked or its session expired, 4 no Cloudflare key in the vault, 5 usage.
// One JSON object on stdout, never a key.
//
// Recettes only: HYPERVIBE_DOH_URL and HYPERVIBE_CLOUDFLARE_API, fakes on the loopback (anything
// else is ignored); with the latter, and only then, the key may come from CLOUDFLARE_API_TOKEN.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
const RESOLVERS = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const EXIT = { OK: 0, UNREADABLE: 1, MISSING: 2, LOCKED: 3, NO_KEY: 4, USAGE: 5 };

const TYPES = { 1: "A", 5: "CNAME", 15: "MX", 16: "TXT", 28: "AAAA" };
/** The DKIM selectors of the main mail providers (Google, Microsoft 365, Zoho, Proton, Fastmail,
 *  iCloud, Gandi, IONOS, Mailchimp, SendGrid, Mailjet, Brevo, Resend, and the usual defaults). */
export const DKIM_SELECTORS = [
  "google", "selector1", "selector2", "default", "dkim", "mail", "k1", "k2", "k3", "s1", "s2", "smtp",
  "zoho", "zmail", "protonmail", "protonmail2", "protonmail3", "fm1", "fm2", "fm3", "sig1", "gm1",
  "gm2", "gm3", "s1-ionos", "s2-ionos", "mailjet", "brevo", "resend", "mandrill", "mx", "pic", "krs",
];
/** Names mail clients look up, carried with the mail. */
const MAIL_NAMES = ["autodiscover", "autoconfig"];
/** Other common names, carried unless the domain has a wildcard. */
export const COMMON_NAMES = [
  "mail", "webmail", "smtp", "imap", "pop", "blog", "shop", "boutique", "store", "app", "api", "docs",
  "status", "cdn", "static", "media", "news", "newsletter", "email", "link", "click", "track", "go",
  "ftp", "cpanel", "admin", "portal", "help", "support", "booking",
];

/** Where DNS is read: Google's resolver then Cloudflare's, or a recette's fake on the loopback. */
export function resolvers(env = process.env) {
  return env.HYPERVIBE_DOH_URL && LOOPBACK.test(env.HYPERVIBE_DOH_URL) ? [`${env.HYPERVIBE_DOH_URL}/resolve`] : RESOLVERS;
}
/** The Cloudflare API's base: Cloudflare's, or a recette's fake on the loopback. */
export function apiBase(env = process.env) {
  return env.HYPERVIBE_CLOUDFLARE_API && LOOPBACK.test(env.HYPERVIBE_CLOUDFLARE_API) ? `${env.HYPERVIBE_CLOUDFLARE_API}/client/v4` : CLOUDFLARE;
}

/** The Cloudflare key: from the environment only with a recette's loopback API, from the vault
 *  otherwise (`vault` reads one field; a recette gives its own). {key} or {code, error}. */
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

const fqdn = (name) => String(name ?? "").toLowerCase().replace(/\.$/, "");
/** A TXT value as text: its quoted strings joined (a long DKIM key comes in several), or as given. */
export function txtText(data) {
  const s = String(data ?? "").trim();
  if (!s.startsWith('"')) return s;
  const parts = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  return parts.length ? parts.join("") : s;
}
/** One record as compared between public DNS and the zone. */
export function keyOf(r) {
  const content = r.type === "TXT" ? txtText(r.content) : r.type === "MX" || r.type === "CNAME" ? fqdn(r.content) : String(r.content).toLowerCase();
  return `${r.type} ${fqdn(r.name)} ${r.type === "MX" ? `${Number(r.priority)} ` : ""}${content}`;
}

/** One question to ONE resolver: {ok, records} (records of the name asked, a CNAME at that name
 *  kept as the CNAME), or {ok: false} when it did not answer. NXDOMAIN is an answer: no records. */
async function askAt(base, name, type) {
  try {
    const res = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false };
    const json = await res.json();
    if (json.Status !== 0 && json.Status !== 3) return { ok: false };
    const answers = (json.Answer ?? []).filter((a) => fqdn(a.name) === fqdn(name));
    const cname = answers.find((a) => a.type === 5);
    const pick = cname ? [cname] : answers.filter((a) => TYPES[a.type] === type);
    return {
      ok: true,
      records: pick.map((a) => {
        const t = TYPES[a.type];
        if (t === "MX") {
          const [priority, ...target] = String(a.data).trim().split(/\s+/);
          return { name: fqdn(name), type: t, priority: Number(priority), content: fqdn(target.join(" ")), ttl: a.TTL };
        }
        return { name: fqdn(name), type: t, content: t === "TXT" ? txtText(a.data) : t === "CNAME" ? fqdn(a.data) : String(a.data).trim(), ttl: a.TTL };
      }),
    };
  } catch {
    return { ok: false };
  }
}

/** One public DNS question, to the first resolver that answers: {ok, records}, or {ok: false} when
 *  none did. */
async function ask(resolverList, name, type) {
  for (const base of resolverList) {
    const r = await askAt(base, name, type);
    if (r.ok) return r;
  }
  return { ok: false };
}

/** The same question to EVERY resolver, where an absence counts only once all of them say it: a
 *  record any of them answers is the name's. A resolver may keep a name's absence in its cache for
 *  the zone's negative TTL after the name was made: on 20/10/2026, one of Google's caches answered
 *  NXDOMAIN, survey after survey, for a record its other caches and another resolver already
 *  served, and what the survey misses, the switch loses (3.4.15). */
async function askEverywhere(resolverList, name, type) {
  const answers = await Promise.all(resolverList.map((base) => askAt(base, name, type)));
  const read = answers.filter((a) => a.ok);
  if (!read.length) return { ok: false };
  const found = read.filter((a) => a.records.length);
  if (!found.length) return read[0];
  return { ok: true, records: [...new Map(found.flatMap((a) => a.records).map((r) => [keyOf(r), r])).values()] };
}

/** `fn` over `items`, `limit` at a time, the results in the items' order. */
async function inBatches(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** What the domain's current DNS carries: {ok, wildcard, mail, names, dkimFound, unread}. A null
 *  MX (`0 .`, "this domain takes no mail") is not a mail server. */
export async function survey(domain, env = process.env) {
  const rs = resolvers(env);
  const unread = [];
  const mail = [];
  const names = [];
  // Every resolver for each question: one resolver's absence is not the name's (3.4.15).
  const asked = async ([name, type]) => {
    const r = await askEverywhere(rs, name, type);
    if (!r.ok) unread.push(`${type} ${name}`);
    return r.ok ? r.records.filter((x) => x.content !== "") : null;
  };
  const head = await inBatches([[domain, "MX"], [domain, "TXT"], [`_dmarc.${domain}`, "TXT"]], 3, asked);
  for (const records of head) mail.push(...(records ?? []));
  const dkim = await inBatches(DKIM_SELECTORS.map((s) => [`${s}._domainkey.${domain}`, "TXT"]), 8, asked);
  const dkimFound = DKIM_SELECTORS.filter((_, i) => dkim[i]?.length);
  for (const records of dkim) mail.push(...(records ?? []));
  const probe = await ask(rs, `hv-${randomBytes(6).toString("hex")}.${domain}`, "A");
  if (!probe.ok) unread.push(`A *.${domain}`);
  const wildcard = Boolean(probe.ok && probe.records.length);
  const all = [...MAIL_NAMES, ...COMMON_NAMES];
  const v4 = await inBatches(all.map((n) => [`${n}.${domain}`, "A"]), 8, asked);
  // A name that is a CNAME has no AAAA of its own: asked only for the others.
  const v6 = await inBatches(all.map((n, i) => (v4[i] && !v4[i].some((x) => x.type === "CNAME") ? [`${n}.${domain}`, "AAAA"] : null)), 8, (q) => (q ? asked(q) : []));
  all.forEach((n, i) => (MAIL_NAMES.includes(n) ? mail : names).push(...(v4[i] ?? []), ...(v6[i] ?? [])));
  // Under a wildcard, a name that answers like any other name is the wildcard: not the domain's own.
  const fromWildcard = (r) => wildcard && probe.records.some((p) => p.type === r.type && p.content === r.content);
  const dedupe = (list) => [...new Map(list.map((r) => [keyOf(r), r])).values()];
  return {
    ok: unread.length === 0,
    wildcard,
    mail: dedupe(mail.filter((r) => !(MAIL_NAMES.some((n) => r.name === `${n}.${domain}`) && fromWildcard(r)))),
    names: dedupe(names.filter((r) => !fromWildcard(r))),
    dkimFound,
    unread,
  };
}

/** One Cloudflare call: {status, json}. */
async function cf(base, key, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers: { Authorization: `Bearer ${key}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}
const said = (r) => r.json?.errors?.[0]?.message ?? `HTTP ${r.status}`;

/** The domain's zone, by its name: {id} or {error}. Several zones of that name (several accounts)
 *  is refused: which one the switch hands the domain to cannot be guessed. */
async function zoneOf(base, key, domain) {
  const r = await cf(base, key, `/zones?name=${encodeURIComponent(domain)}`);
  if (r.status !== 200 || r.json?.success !== true) return { error: `The zone could not be read at Cloudflare: ${said(r)}` };
  const zones = r.json.result ?? [];
  if (zones.length === 0) return { error: `No Cloudflare zone for ${domain}: create it first (/add-domain, Step 5).` };
  if (zones.length > 1) return { error: `Several Cloudflare zones are named ${domain} (several accounts): say which one before going on.` };
  return { id: zones[0].id };
}
/** Every record of the zone, page after page: {records} or {error}. */
async function zoneRecords(base, key, zoneId) {
  const out = [];
  for (let page = 1; page <= 50; page += 1) {
    const r = await cf(base, key, `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
    if (r.status !== 200 || r.json?.success !== true) return { error: `The zone's records could not be read: ${said(r)}` };
    out.push(...(r.json.result ?? []));
    if (page >= (r.json.result_info?.total_pages ?? 1)) return { records: out };
  }
  return { error: "The zone has more records than this survey reads." };
}
/** A record as Cloudflare takes it: a TXT quoted, cut in strings of 255 characters at most. */
export function asCloudflare(r) {
  const body = { type: r.type, name: r.name, ttl: 3600 };
  if (r.type === "MX") return { ...body, content: r.content, priority: r.priority };
  if (r.type === "TXT") {
    const text = r.content;
    const chunks = [];
    for (let i = 0; i < text.length; i += 255) chunks.push(text.slice(i, i + 255));
    return { ...body, content: chunks.map((c) => `"${c.replace(/["\\]/g, (m) => `\\${m}`)}"`).join(" ") };
  }
  return { ...body, content: r.content, proxied: false };
}

async function main(argv, env = process.env) {
  const [domain, ...rest] = argv;
  const copy = rest.includes("--copy");
  if (!DOMAIN.test(String(domain ?? "")) || rest.some((a) => a !== "--copy")) return { code: EXIT.USAGE, out: { ok: false, error: "Usage: dns-survey.mjs <domain> [--copy] (the domain in lower case, without www. or https://)." } };
  const found = await survey(domain, env);
  const base = apiBase(env);
  const read = readKey(env, base);
  if (!read.key) return { code: read.code, out: { ok: false, domain, error: read.error, found } };
  const zone = await zoneOf(base, read.key, domain);
  if (!zone.id) return { code: EXIT.UNREADABLE, out: { ok: false, domain, error: zone.error, found } };
  const lacking = async () => {
    const z = await zoneRecords(base, read.key, zone.id);
    if (z.error) return z;
    const have = new Set(z.records.map(keyOf));
    return { missing: [...found.mail, ...found.names].filter((r) => !have.has(keyOf(r))) };
  };
  let now = await lacking();
  if (now.error) return { code: EXIT.UNREADABLE, out: { ok: false, domain, error: now.error, found } };
  const copied = [];
  const failed = [];
  if (copy && found.ok) {
    for (const r of now.missing) {
      const w = await cf(base, read.key, `/zones/${zone.id}/dns_records`, { method: "POST", body: asCloudflare(r) });
      if (w.status === 200 && w.json?.success === true) copied.push(r);
      else if ((w.json?.errors ?? []).some((e) => e.code === 81057 || e.code === 81058)) copied.push(r);
      else failed.push({ record: r, error: said(w) });
    }
    now = await lacking();
    if (now.error) return { code: EXIT.UNREADABLE, out: { ok: false, domain, error: now.error, found, copied, failed } };
  }
  const mx = found.mail.some((r) => r.type === "MX");
  const sends = found.mail.some((r) => r.type === "TXT" && r.name === domain && /^v=spf1\b/i.test(r.content));
  const out = {
    ok: found.ok && now.missing.length === 0,
    domain,
    receivesMail: mx,
    wildcard: found.wildcard,
    found: { mail: found.mail, names: found.names },
    missing: now.missing,
    copied,
    failed,
    dkimFound: found.dkimFound,
    dkimUnknown: (mx || sends) && found.dkimFound.length === 0,
    unread: found.unread,
    notes: [
      "Read through public DNS: a DKIM key under a selector of its own, SRV records and names outside the surveyed list are not seen.",
      ...(found.wildcard ? ["The domain answers any name (a wildcard, usually the registrar's parking): the common names it answers are not carried."] : []),
      ...(copy && !found.ok ? ["Some names could not be read: nothing was written, read again before switching."] : []),
    ],
  };
  if (!found.ok) return { code: EXIT.UNREADABLE, out: { ...out, ok: false, error: "Some names could not be read: nothing can be concluded about them." } };
  return { code: out.missing.length ? EXIT.MISSING : EXIT.OK, out };
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
