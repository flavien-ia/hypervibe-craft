#!/usr/bin/env node
// Tells the participant's Hypervibe training space that /start succeeded,
// so the installation checklist ticks itself. Only runs with the personal
// code shown in the training module: without it, nothing is sent.
// Exit codes: 0 reported, 2 code refused, 1 network or server error.
const i = process.argv.indexOf("--code");
const code = i > -1 ? process.argv[i + 1] : "";
if (!/^hvi-[A-Za-z0-9-]{1,64}-[A-Za-z0-9_-]{22}$/.test(code ?? "")) {
  console.log(JSON.stringify({ result: "invalid-code" }));
  process.exit(2);
}
const url =
  process.env.HYPERVIBE_PREPARATION_URL ??
  "https://app.hypervibe.fr/api/preparation/installation";
try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.ok) {
    console.log(JSON.stringify({ result: "reported" }));
    process.exit(0);
  }
  console.log(JSON.stringify({ result: res.status === 400 ? "refused" : "error", status: res.status }));
  process.exit(res.status === 400 ? 2 : 1);
} catch (e) {
  console.log(JSON.stringify({ result: "error", message: String(e?.message ?? e) }));
  process.exit(1);
}
