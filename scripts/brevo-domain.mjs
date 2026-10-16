#!/usr/bin/env node
// brevo-domain.mjs - A sending domain at Brevo, for _dns-brevo (3.4.13). Brevo changed what it
// hands out: `dkim_record` is now null, the signature goes through two CNAMEs (brevo1._domainkey and
// brevo2._domainkey, pointing at names Brevo gives: they are read from its answer, never built), and
// it refuses to authenticate a domain that has no DMARC record (400). Until 3.4.13 the skill wrote
// three TXT records from a list of its own: the DKIM part was lost, and authentication failed.
//
//   node brevo-domain.mjs records <domain>
//        the domain at Brevo, created when the account does not have it yet, then read:
//        {ok, domain, created, authenticated, records: [{key, type, name, value}]}, every entry
//        of its dns_records that is not null, each with ITS type
//   node brevo-domain.mjs publish <domain>
//        each record written in the domain's Cloudflare zone with its type, never proxied. One
//        already there is kept. A DMARC record already there is kept as it is: never a second one
//        (two DMARC records cancel the policy), never a stricter policy. A record of the same name
//        with another value is not overwritten: it is said, in `conflicts`.
//        {ok, written, kept, conflicts}
//   node brevo-domain.mjs authenticate <domain> [--attempts N]
//        asks Brevo to check the records, waiting 15 s before the first attempt and 30 s between
//        the next ones (N = 4 by default): {ok, authenticated, attempts, error?}
//   node brevo-domain.mjs sender <email> [--name <name>]
//        the sender at Brevo, created when the account has none for this address:
//        {ok, email, created, active}
//   node brevo-domain.mjs test <domain> --from <email> --to <inbox>
//        a test message, whose subject carries a code to find it: {ok, code, messageId}
//   node brevo-domain.mjs account-key <domain> [--publish]
//        the account's own DKIM key (selector `mail`), read in public DNS on the account's other
//        authenticated domains; with --publish, written in this domain's zone. The key itself is
//        never printed: {ok, found, from, written}
//
// Exit codes: 0 done, 1 a call failed or a provider refused (its words in `error`), 3 the vault is
// locked or its session expired, 4 a key is missing from the vault, 5 usage. One JSON object on
// stdout, never a key.
//
// Recettes only: HYPERVIBE_BREVO_API, HYPERVIBE_CLOUDFLARE_API and HYPERVIBE_DOH, fakes on the
// loopback (anything else is ignored); with them, and only then, the keys may come from
// BREVO_API_KEY and CLOUDFLARE_API_TOKEN, and the waits are skipped.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BREVO = "https://api.brevo.com/v3";
const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
const DOH = "https://cloudflare-dns.com/dns-query";
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EXIT = { OK: 0, FAILED: 1, LOCKED: 3, NO_KEY: 4, USAGE: 5 };
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** The APIs' bases: the real ones, or a recette's fakes on the loopback. */
export function bases(env = process.env) {
  const local = (name) => (env[name] && LOOPBACK.test(env[name]) ? env[name] : null);
  return {
    brevo: local("HYPERVIBE_BREVO_API") ? `${env.HYPERVIBE_BREVO_API}/v3` : BREVO,
    cloudflare: local("HYPERVIBE_CLOUDFLARE_API") ? `${env.HYPERVIBE_CLOUDFLARE_API}/client/v4` : CLOUDFLARE,
    doh: local("HYPERVIBE_DOH") ? `${env.HYPERVIBE_DOH}/dns-query` : DOH,
  };
}

/** A key: from the environment only with a recette's loopback API, from the vault otherwise. */
export function readKey(which, env = process.env, b = bases(env), vault = fromVault) {
  const spec = which === "brevo"
    ? { real: BREVO, base: b.brevo, env: "BREVO_API_KEY", item: "BREVO", field: "api_key", label: "Brevo" }
    : { real: CLOUDFLARE, base: b.cloudflare, env: "CLOUDFLARE_API_TOKEN", item: "CLOUDFLARE", field: "api_token", label: "Cloudflare" };
  if (spec.base !== spec.real) return env[spec.env] ? { key: env[spec.env] } : { code: EXIT.NO_KEY, error: `No ${spec.label} key.` };
  const r = vault(spec.item, spec.field);
  if (r.status === 2 || r.status === 3) return { code: EXIT.LOCKED, error: "The vault is locked (or its session expired): open it, then retry." };
  const key = String(r.value ?? "").trim();
  return r.status === 0 && key ? { key } : { code: EXIT.NO_KEY, error: `The ${spec.label} key is not in the vault (item ${spec.item}, field ${spec.field}).` };
}
function fromVault(item, field) {
  const r = spawnSync(process.execPath, [join(HERE, "vault", "vault.mjs"), "get", item, field], { encoding: "utf8", windowsHide: true });
  return { status: r.status, value: String(r.stdout ?? "").trim() };
}

async function call(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}
const brevoSaid = (r) => r.json?.message ?? `HTTP ${r.status}`;
const cfSaid = (r) => r.json?.errors?.[0]?.message ?? `HTTP ${r.status}`;

/** Brevo's dns_records, every entry that is not null, each with its own type and full name. */
export function recordsOf(domain, dnsRecords) {
  const out = [];
  for (const [key, r] of Object.entries(dnsRecords ?? {})) {
    if (!r || typeof r !== "object" || !r.type || !r.value) continue;
    const host = String(r.host_name ?? "@").trim();
    const name = host === "@" || host === "" ? domain : host.endsWith(`.${domain}`) || host === domain ? host : `${host}.${domain}`;
    out.push({ key, type: String(r.type).toUpperCase(), name, value: String(r.value).trim() });
  }
  return out;
}
const isDmarc = (r) => r.type === "TXT" && /^_dmarc\./i.test(r.name);
const isDkimKey = (r) => r.type === "TXT" && /\._domainkey\./i.test(r.name);
/** A DMARC record this script writes stays at p=none, whatever Brevo suggests: a stricter policy
 *  is for after a test that passed, and the user's choice. */
export const dmarcAtNone = (value) => String(value).replace(/\bp\s*=\s*(?:quarantine|reject)\b/i, "p=none");
/** What a record shows of itself: a DKIM key is never printed, public or not. */
const shown = (r) => (isDkimKey(r) ? { ...r, value: "(DKIM key, not shown)" } : r);
const sameValue = (a, b) => String(a).replace(/^"|"$/g, "").replace(/\.$/, "").trim().toLowerCase() === String(b).replace(/^"|"$/g, "").replace(/\.$/, "").trim().toLowerCase();

async function brevoDomain(b, key, domain) {
  const headers = { "api-key": key };
  let created = false;
  let r = await call(`${b.brevo}/senders/domains/${encodeURIComponent(domain)}`, { headers });
  if (r.status === 404) {
    const c = await call(`${b.brevo}/senders/domains`, { method: "POST", headers, body: { name: domain } });
    if (c.status !== 201 && c.status !== 200) return { error: `Brevo refused to create the domain: ${brevoSaid(c)}` };
    created = true;
    r = await call(`${b.brevo}/senders/domains/${encodeURIComponent(domain)}`, { headers });
  }
  if (r.status !== 200 || !r.json) return { error: `The domain could not be read at Brevo: ${brevoSaid(r)}` };
  return { created, authenticated: r.json.authenticated === true, records: recordsOf(domain, r.json.dns_records) };
}

/** The records as this script prints them. */
function printable(d) {
  return { ...d, records: d.records.map(shown) };
}

async function zoneOf(b, key, domain) {
  const r = await call(`${b.cloudflare}/zones?name=${encodeURIComponent(domain)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (r.status !== 200 || r.json?.success !== true) return { error: `The zone could not be read at Cloudflare: ${cfSaid(r)}` };
  const list = r.json.result ?? [];
  if (list.length !== 1) return { error: list.length ? `Several Cloudflare zones are named ${domain}: say which one.` : `No Cloudflare zone for ${domain}: connect the domain with /add-domain first.` };
  return { zoneId: list[0].id };
}

async function existing(b, key, zoneId, type, name) {
  const r = await call(`${b.cloudflare}/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=100`, { headers: { Authorization: `Bearer ${key}` } });
  if (r.status !== 200 || r.json?.success !== true) return { error: `The zone's ${type} records for ${name} could not be read: ${cfSaid(r)}` };
  return { list: r.json.result ?? [] };
}

async function write(b, key, zoneId, rec) {
  const r = await call(`${b.cloudflare}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: { type: rec.type, name: rec.name, content: rec.value, ttl: 3600, proxied: false },
  });
  if (r.status === 200 && r.json?.success === true) return {};
  if (r.json?.errors?.some((e) => e.code === 81057 || e.code === 81058)) return { kept: true };
  return { error: `Cloudflare refused ${rec.type} ${rec.name}: ${cfSaid(r)}` };
}

/** Publishes Brevo's records in the zone. */
async function publish(b, keys, domain) {
  const d = await brevoDomain(b, keys.brevo, domain);
  if (d.error) return { code: EXIT.FAILED, out: { ok: false, domain, error: d.error } };
  const z = await zoneOf(b, keys.cloudflare, domain);
  if (z.error) return { code: EXIT.FAILED, out: { ok: false, domain, error: z.error } };
  const written = [];
  const kept = [];
  const conflicts = [];
  for (const rec of d.records) {
    // A DMARC record: any one already there stands, whatever its policy, and nothing is added.
    const sameName = await existing(b, keys.cloudflare, z.zoneId, rec.type === "CNAME" ? "CNAME" : "TXT", rec.name);
    if (sameName.error) return { code: EXIT.FAILED, out: { ok: false, domain, written, kept, conflicts, error: sameName.error } };
    if (isDmarc(rec)) {
      const dmarc = sameName.list.filter((x) => /^"?v=DMARC1/i.test(String(x.content ?? "")));
      if (dmarc.length) {
        kept.push({ key: rec.key, name: rec.name, note: "a DMARC record was already there: kept as it is" });
        continue;
      }
      rec.value = dmarcAtNone(rec.value);
    } else if (sameName.list.some((x) => sameValue(x.content, rec.value))) {
      kept.push({ key: rec.key, name: rec.name });
      continue;
    } else if (rec.name !== domain && sameName.list.length) {
      // One value per name, but at the domain's root (where TXT records live side by side): another
      // value there is the user's to settle, never overwritten, never doubled (two DKIM keys under
      // one selector, two CNAMEs).
      conflicts.push({ key: rec.key, name: rec.name, expected: isDkimKey(rec) ? "(DKIM key)" : rec.value, found: sameName.list.map((x) => (isDkimKey(rec) ? "(another value)" : x.content)) });
      continue;
    }
    // A CNAME beside other records of the same name is refused by DNS: said, not forced.
    if (rec.type === "CNAME") {
      const txt = await existing(b, keys.cloudflare, z.zoneId, "TXT", rec.name);
      if (txt.error) return { code: EXIT.FAILED, out: { ok: false, domain, written, kept, conflicts, error: txt.error } };
      if (txt.list.length) {
        conflicts.push({ key: rec.key, name: rec.name, expected: rec.value, found: txt.list.map((x) => `TXT ${String(x.content).slice(0, 40)}`) });
        continue;
      }
    }
    const w = await write(b, keys.cloudflare, z.zoneId, rec);
    if (w.error) return { code: EXIT.FAILED, out: { ok: false, domain, written, kept, conflicts, error: w.error } };
    (w.kept ? kept : written).push({ key: rec.key, type: rec.type, name: rec.name });
  }
  return { code: conflicts.length ? EXIT.FAILED : EXIT.OK, out: { ok: !conflicts.length, domain, written, kept, conflicts, ...(conflicts.length ? { error: "A record of the same name holds another value: nothing was overwritten." } : {}) } };
}

const pause = (ms, env) => (bases(env).brevo === BREVO ? new Promise((ok) => setTimeout(ok, ms)) : Promise.resolve());

async function authenticate(b, key, domain, attempts, env) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    await pause(i === 0 ? 15000 : 30000, env);
    const r = await call(`${b.brevo}/senders/domains/${encodeURIComponent(domain)}/authenticate`, { method: "PUT", headers: { "api-key": key } });
    const read = await call(`${b.brevo}/senders/domains/${encodeURIComponent(domain)}`, { headers: { "api-key": key } });
    if (read.status === 200 && read.json?.authenticated === true) return { code: EXIT.OK, out: { ok: true, domain, authenticated: true, attempts: i + 1 } };
    last = r.status >= 400 ? brevoSaid(r) : "the records are not seen yet";
  }
  return { code: EXIT.FAILED, out: { ok: false, domain, authenticated: false, attempts, error: `Brevo did not authenticate the domain: ${last}` } };
}

async function sender(b, key, email, name) {
  const headers = { "api-key": key };
  const list = await call(`${b.brevo}/senders`, { headers });
  if (list.status !== 200) return { code: EXIT.FAILED, out: { ok: false, email, error: `The senders could not be read at Brevo: ${brevoSaid(list)}` } };
  const found = (list.json?.senders ?? []).find((s) => String(s.email).toLowerCase() === email.toLowerCase());
  if (found) return { code: EXIT.OK, out: { ok: true, email, created: false, active: found.active === true } };
  const c = await call(`${b.brevo}/senders`, { method: "POST", headers, body: { name, email } });
  if (c.status !== 201 && c.status !== 200) return { code: EXIT.FAILED, out: { ok: false, email, error: `Brevo refused to create the sender: ${brevoSaid(c)}` } };
  const again = await call(`${b.brevo}/senders`, { headers });
  const now = (again.json?.senders ?? []).find((s) => String(s.email).toLowerCase() === email.toLowerCase());
  return { code: EXIT.OK, out: { ok: true, email, created: true, active: now?.active === true } };
}

async function testMessage(b, key, domain, from, to) {
  const code = randomBytes(3).toString("hex");
  const r = await call(`${b.brevo}/smtp/email`, {
    method: "POST",
    headers: { "api-key": key },
    body: {
      sender: { email: from, name: domain },
      to: [{ email: to }],
      subject: `Hypervibe: signature test for ${domain} (${code})`,
      textContent: `Test message sent by Hypervibe to check how ${domain} signs its mail. Code: ${code}.`,
    },
  });
  if (r.status !== 201 && r.status !== 200) return { code: EXIT.FAILED, out: { ok: false, domain, error: `Brevo refused the test message: ${brevoSaid(r)}` } };
  return { code: EXIT.OK, out: { ok: true, domain, code, messageId: r.json?.messageId ?? null } };
}

/** The account's own DKIM key (selector `mail`), as published on its other authenticated domains. */
async function accountKey(b, keys, domain, doPublish) {
  const list = await call(`${b.brevo}/senders/domains`, { headers: { "api-key": keys.brevo } });
  if (list.status !== 200) return { code: EXIT.FAILED, out: { ok: false, domain, error: `The account's domains could not be read at Brevo: ${brevoSaid(list)}` } };
  const others = (list.json?.domains ?? []).filter((d) => d.authenticated === true && d.domain_name && d.domain_name !== domain).map((d) => d.domain_name);
  let value = null;
  let from = null;
  for (const other of others) {
    const r = await call(`${b.doh}?name=mail._domainkey.${encodeURIComponent(other)}&type=TXT`, { headers: { accept: "application/dns-json" } });
    const txt = (r.json?.Answer ?? []).filter((a) => a.type === 16).map((a) => String(a.data).replace(/"\s*"/g, "").replace(/^"|"$/g, ""));
    const dkim = txt.find((t) => /(^|;)\s*p=[A-Za-z0-9+/=]{40,}/.test(t));
    if (dkim) {
      value = dkim;
      from = other;
      break;
    }
  }
  if (!value) return { code: EXIT.OK, out: { ok: true, domain, found: false, from: null, written: false, checked: others } };
  if (!doPublish) return { code: EXIT.OK, out: { ok: true, domain, found: true, from, written: false } };
  const z = await zoneOf(b, keys.cloudflare, domain);
  if (z.error) return { code: EXIT.FAILED, out: { ok: false, domain, found: true, from, error: z.error } };
  const name = `mail._domainkey.${domain}`;
  const there = await existing(b, keys.cloudflare, z.zoneId, "TXT", name);
  if (there.error) return { code: EXIT.FAILED, out: { ok: false, domain, found: true, from, error: there.error } };
  if (there.list.some((x) => sameValue(x.content, value))) return { code: EXIT.OK, out: { ok: true, domain, found: true, from, written: false, already: true } };
  if (there.list.length) return { code: EXIT.FAILED, out: { ok: false, domain, found: true, from, error: `${name} already holds another key: nothing was overwritten.` } };
  const w = await write(b, keys.cloudflare, z.zoneId, { type: "TXT", name, value });
  if (w.error) return { code: EXIT.FAILED, out: { ok: false, domain, found: true, from, error: w.error } };
  return { code: EXIT.OK, out: { ok: true, domain, found: true, from, written: !w.kept } };
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv, env = process.env) {
  const [verb, subject] = argv;
  const usage = { code: EXIT.USAGE, out: { ok: false, error: "Usage: brevo-domain.mjs records|publish|authenticate|account-key <domain>, sender <email> [--name <name>], test <domain> --from <email> --to <inbox> (see the header of this file)." } };
  const byDomain = ["records", "publish", "authenticate", "test", "account-key"];
  if (byDomain.includes(verb) && !DOMAIN.test(String(subject ?? ""))) return usage;
  if (verb === "sender" && !EMAIL.test(String(subject ?? ""))) return usage;
  if (![...byDomain, "sender"].includes(verb)) return usage;
  if (verb === "test" && (!EMAIL.test(String(option(argv, "--from") ?? "")) || !EMAIL.test(String(option(argv, "--to") ?? "")))) return usage;
  const b = bases(env);
  const keys = {};
  const need = ["publish", "account-key"].includes(verb) ? ["brevo", "cloudflare"] : ["brevo"];
  for (const which of need) {
    const k = readKey(which, env, b);
    if (!k.key) return { code: k.code, out: { ok: false, error: k.error } };
    keys[which] = k.key;
  }
  try {
    if (verb === "records") {
      const d = await brevoDomain(b, keys.brevo, subject);
      return d.error ? { code: EXIT.FAILED, out: { ok: false, domain: subject, error: d.error } } : { code: EXIT.OK, out: { ok: true, domain: subject, ...printable(d) } };
    }
    if (verb === "publish") return await publish(b, keys, subject);
    if (verb === "authenticate") {
      const n = Number(option(argv, "--attempts") ?? 4);
      return await authenticate(b, keys.brevo, subject, Number.isInteger(n) && n > 0 && n <= 8 ? n : 4, env);
    }
    if (verb === "sender") return await sender(b, keys.brevo, subject, String(option(argv, "--name") ?? subject.split("@")[1]));
    if (verb === "test") return await testMessage(b, keys.brevo, subject, option(argv, "--from"), option(argv, "--to"));
    return await accountKey(b, keys, subject, argv.includes("--publish"));
  } catch (e) {
    return { code: EXIT.FAILED, out: { ok: false, error: `A provider could not be reached: ${e.message}` } };
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
