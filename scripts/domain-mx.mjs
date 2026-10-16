#!/usr/bin/env node
// domain-mx.mjs - A domain's mail servers, read in public DNS (3.4.13): whether its addresses are
// relayed by Cloudflare's Email Routing (route1.mx.cloudflare.net and its siblings) rather than kept
// in real mailboxes. Read with no key at all, so that the contact page can ask it in any harness (a
// collaborator holds no key of the organisation's zone) and without opening the vault.
//
//   node domain-mx.mjs <domain>
//        {ok, domain, mx: [hosts by priority], relayed}
//
// Exit codes: 0 read (a domain with no mail server is a reading: mx [], relayed false), 1 DNS could
// not be read (its words in `error`), 5 usage. One JSON object on stdout.

import { promises as dns } from "node:dns";

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const EXIT = { OK: 0, UNREADABLE: 1, USAGE: 5 };

/** Email Routing's own mail servers. */
export const isRoutingMx = (host) => /^route\d+\.mx\.cloudflare\.net\.?$/i.test(String(host ?? ""));

/** The domain's mail servers; `resolve` stands in for the DNS in recettes. */
export async function mxOf(domain, resolve = (d) => dns.resolveMx(d)) {
  try {
    const list = await resolve(domain);
    const mx = [...list].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((r) => String(r.exchange ?? "").toLowerCase().replace(/\.$/, ""));
    return { ok: true, domain, mx, relayed: mx.length > 0 && mx.every(isRoutingMx) };
  } catch (e) {
    if (e?.code === "ENODATA" || e?.code === "ENOTFOUND") return { ok: true, domain, mx: [], relayed: false };
    return { ok: false, domain, error: `The domain's mail servers could not be read in DNS (${e?.code ?? e?.message}).` };
  }
}

export async function main(argv, resolve) {
  const [domain] = argv;
  if (argv.length !== 1 || !DOMAIN.test(String(domain ?? ""))) {
    return { code: EXIT.USAGE, out: { ok: false, error: "Usage: domain-mx.mjs <domain> (lower case, without www. or https://)." } };
  }
  const out = await mxOf(domain, resolve);
  return { code: out.ok ? EXIT.OK : EXIT.UNREADABLE, out };
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
