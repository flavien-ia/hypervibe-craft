// _fake-net.mjs - Loaded into a script a recette launches (NODE_OPTIONS --import): `fetch` answers
// from a scenario instead of the network, and refuses every address the scenario does not name.
//
// HV_RECETTE_NET holds the scenario, in JSON: [[<address prefix>, <answer>], ...]. The first prefix
// the address starts with wins, so the more specific one comes first. An answer is
// {status, body} (the body sent back as JSON), {status, text} (sent back as written, for an
// answer that is not one JSON document, like Vercel's billing charges in JSON lines), or "reseau"
// for a network that fails. A third element, {header, value}, keeps an entry for the requests
// that carry that header with that value (R2's EU buckets: same address, `cf-r2-jurisdiction: eu`).
// HV_RECETTE_NET_LOG, when set, receives one JSON line per request: its method and its address,
// never a header (a key travels in them, even a recette's).
//
// An address outside the scenario fails like a network that is down: a recette that launches a
// script under this file reaches nothing beyond it, whatever the script would have called.
import { appendFileSync } from "node:fs";

let scenario = [];
try {
  scenario = JSON.parse(process.env.HV_RECETTE_NET || "[]");
} catch {
  scenario = [];
}
const LOG = process.env.HV_RECETTE_NET_LOG;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  const method = String(init?.method || input?.method || "GET").toUpperCase();
  if (LOG) {
    try {
      appendFileSync(LOG, `${JSON.stringify({ method, url })}\n`);
    } catch {
      // The request is answered all the same; the recette that reads the log will say what is missing.
    }
  }
  const sent = new Headers(init?.headers ?? input?.headers ?? {});
  const hit = Array.isArray(scenario)
    ? scenario.find(([prefix, , when]) => url.startsWith(prefix) && (!when || sent.get(when.header) === when.value))
    : undefined;
  const answer = hit ? hit[1] : "hors-scenario";
  if (answer === "reseau" || answer === "hors-scenario" || typeof answer !== "object" || answer === null) {
    throw new TypeError(`fetch failed (recette: ${answer === "reseau" ? "network down" : "address outside the scenario"})`);
  }
  return new Response(typeof answer.text === "string" ? answer.text : JSON.stringify(answer.body ?? {}), {
    status: answer.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
};
