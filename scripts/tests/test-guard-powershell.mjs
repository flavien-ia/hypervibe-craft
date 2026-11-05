#!/usr/bin/env node
// test-guard-powershell.mjs - Le garde-fou lit aussi PowerShell et le terminal de l'application
// (3.4.26 / 2.5.3).
//
// Jusqu'à la 3.4.25 / 2.5.2, hooks.json ne branchait le garde-fou que sur Bash et Monitor : sous
// Windows, où PowerShell est l'outil de commande principal de Claude Code, un push ou une commande
// encodée passait sans question. Le crochet est appelé ici comme Claude Code l'appelle (le JSON sur
// l'entrée standard), sans réseau.
//
//   node scripts/tests/test-guard-powershell.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}

const dossier = mkdtempSync(join(tmpdir(), "hv-guard-ps-"));
function garde(tool, input) {
  const r = spawnSync(process.execPath, [join(ROOT, "hooks", "guard-bash.mjs")], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: dossier, hook_event_name: "PreToolUse" }),
    encoding: "utf8",
  });
  let decision = null;
  try {
    decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  } catch {
    decision = r.stdout.trim() ? "illisible" : null;
  }
  return { code: r.status, decision, stderr: r.stderr };
}

try {
  const hooks = readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8");
  check("hooks.json branche le garde-fou sur les quatre outils", /"matcher": "Bash\|Monitor\|PowerShell\|mcp__terminal__run_in_terminal"/.test(hooks));

  const bash = garde("Bash", { command: "git push origin main" });
  check("Bash : un push demande, comme avant", bash.decision === "ask", JSON.stringify(bash));
  const ps = garde("PowerShell", { command: "git push origin main" });
  check("PowerShell : le même push demande", ps.decision === "ask", JSON.stringify(ps));
  const term = garde("mcp__terminal__run_in_terminal", { command: "git push origin main" });
  check("terminal de l'application : le même push demande", term.decision === "ask", JSON.stringify(term));
  const enc = garde("PowerShell", { command: "powershell -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==" });
  check("PowerShell : une commande encodée, illisible, demande", enc.decision === "ask", JSON.stringify(enc));
  const lecture = garde("PowerShell", { command: "Get-ChildItem -Force" });
  check("PowerShell : une lecture passe sans question", lecture.decision === null && lecture.code === 0, JSON.stringify(lecture));
  const autre = garde("Read", { file_path: "x" });
  check("un outil qui ne lance pas de commande n'est pas lu", autre.decision === null && autre.code === 0, JSON.stringify(autre));
  const vide = garde("PowerShell", {});
  check("PowerShell sans commande : rien de décidé, le dit, laisse passer", vide.decision === null && vide.code === 0 && /no command/.test(vide.stderr), JSON.stringify(vide));
} finally {
  rmSync(dossier, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} verifications`);
process.exitCode = failures ? 1 : 0;
