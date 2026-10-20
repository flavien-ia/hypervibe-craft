// hooks/rules.mjs - The decision function behind the Bash guardrail.
//
// Why a hook and not a rule in CLAUDE.md: a written rule is a probabilistic
// influence competing with everything else in the context. It was measured, on
// a user's own transcripts, to change nothing at all: a week after the rule was
// added, the forbidden pattern still accounted for 17 of 40 failing calls. The
// hook changed the behaviour immediately, for a mechanical reason: the call
// cannot happen, and the model gets told what to do instead.
//
// Two decisions, and the difference matters:
//   deny -> there is no legitimate use here, and there is a correct alternative
//           we can name. The model reads the reason and takes the other path.
//   ask  -> the action is legitimate, but it is irreversible or outward-facing,
//           so a human confirms. Consent lives in the conversation, which a
//           hook cannot read: blocking outright would also block the push that
//           follows the user's "yes". In a non-interactive session `ask` fails
//           closed, which is the safe direction.
//
// Deliberately short. Every extra pattern brings the guardrail closer to the
// one that blocks everything, and a guardrail that cries wolf gets bypassed.
// Style and architecture stay in CLAUDE.md, where they belong.

// The SQL check lives beside run-sql.mjs, which applies it too. Loaded inside a safety net:
// a hooks/ folder copied alone must keep every other rule and say that this one is off,
// rather than fail to load and let everything through (outside review, 3.2.6). Without the
// file, run-sql.mjs cannot run either, so rule 6 has nothing left to guard.
let statementsDestructrices = null;
try {
  ({ statementsDestructrices } = await import("../scripts/db/sql-guard.mjs"));
} catch (e) {
  process.stderr.write(
    `[Hypervibe] the SQL rule of the guard is off, scripts/db/sql-guard.mjs could not be loaded: ${
      e instanceof Error ? e.message : String(e)
    }\n`,
  );
}

/** Reads a command line the way a shell would, as far as judging it needs: the segments
 *  it runs one after the other (split on newlines, `;`, `&`, `&&`, `||`, `|`), each
 *  without its substitutions, and what those substitutions run, as command lines of
 *  their own. What is text stays text, and what runs is found wherever it hides:
 *  - single quotes make everything literal; inside double quotes an apostrophe is an
 *    ordinary character and `$(...)` still runs (`"l'accord $(git push)"` is a push:
 *    the apostrophe hid it until an outside review of 3.1.9);
 *  - `$(...)`, backticks and process substitutions `<(...)` `>(...)` run their content
 *    (the last two walked past every rule until the same review);
 *  - a heredoc's body is data: a commit message written through
 *    `git commit -m "$(cat <<'EOF' ...)"` that mentions `git add -A` is not a sweep (it
 *    was refused on 3.1.9). With an unquoted delimiter the body still expands `$(...)`
 *    and backticks, which are judged;
 *  - a comment runs to the end of its line, apostrophes included;
 *  - a backslash makes the next character literal (`\$(x)` in a commit message runs
 *    nothing), and at the end of a line it continues the command;
 *  - what a segment reads on its standard input when the command line writes it (a
 *    heredoc's body, a here-string's word) stays with that segment (`stdin`), and so do
 *    the commands of the `<(...)` it takes as files (`procIn`) and whether a pipe feeds
 *    it (`piped`). Data for most commands, but the SCRIPT of a shell that reads one:
 *    `bash <<'EOF'` runs its body (outside review, 3.2.4).
 *  Returns [{ text, inner, stdin, procIn, piped }] in the order a shell would run them. */
export function readCommandLine(command) {
  return scanShell(String(command), 0, null).parts;
}

/** The segments alone, as text, for anything that only needs to split. */
export function segments(command) {
  return readCommandLine(command).map((part) => part.text);
}

// A heredoc delimiter ends at a blank or at a character the shell treats as an operator.
const WORD_END = /[\s;&|<>()]/;

/** The index of the backtick closing the one at `start` (or the end of `src`). */
function closingBacktick(src, start) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === "`") return i;
  }
  return src.length;
}

/** A substitution opened at `start` (on `$(`, `<(` or `>(`): its content, and the index
 *  right after it. Read by the same scanner, so the quotes, heredocs and nesting inside
 *  are understood, and the parenthesis that closes it is the right one. */
function readSubstitution(src, start) {
  const sub = scanShell(src, start + 2, ")");
  return { content: src.slice(start + 2, sub.closed ? sub.end - 1 : src.length), end: sub.end };
}

/** A double-quoted string opened at `start`: its text (without what its substitutions
 *  run) and the substitutions found in it. An apostrophe is an ordinary character here. */
function readDoubleQuoted(src, start) {
  let text = '"';
  const inner = [];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      text += src.slice(i, i + 2);
      i += 2;
    } else if (c === '"') {
      return { text: `${text}"`, inner, end: i + 1 };
    } else if (c === "$" && src[i + 1] === "(") {
      const sub = readSubstitution(src, i);
      inner.push(sub.content);
      i = sub.end;
    } else if (c === "`") {
      const end = closingBacktick(src, i);
      inner.push(src.slice(i + 1, end));
      i = end + 1;
    } else {
      text += c;
      i += 1;
    }
  }
  return { text, inner, end: src.length };
}

/** The `<<` or `<<-` operator at `start`, and its delimiter. A quote or a backslash
 *  anywhere in the delimiter makes the body literal, as in a shell. */
function readHeredocOperator(src, start) {
  let i = start + 2;
  const stripTabs = src[i] === "-";
  if (stripTabs) i += 1;
  while (src[i] === " " || src[i] === "\t") i += 1;
  let delim = "";
  let quoted = false;
  while (i < src.length && !WORD_END.test(src[i])) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const close = src.indexOf(c, i + 1);
      const stop = close < 0 ? src.length : close;
      delim += src.slice(i + 1, stop);
      quoted = true;
      i = stop + 1;
    } else if (c === "\\") {
      delim += src[i + 1] ?? "";
      quoted = true;
      i += 2;
    } else {
      delim += c;
      i += 1;
    }
  }
  return { delim, quoted, stripTabs, end: Math.min(i, src.length) };
}

/** What a stretch of text expands, quotes being literal there (the body of a heredoc
 *  whose delimiter is unquoted): its `$(...)` and its backticks. */
function expansions(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
    } else if (c === "$" && text[i + 1] === "(") {
      const sub = readSubstitution(text, i);
      found.push(sub.content);
      i = sub.end;
    } else if (c === "`") {
      const end = closingBacktick(text, i);
      found.push(text.slice(i + 1, end));
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return found;
}

/** The body of a heredoc, from `start` to its delimiter line (or the end): its text, the
 *  standard input of the segment that opened it, and what it expands when the delimiter
 *  is unquoted. */
function readHeredocBody(src, start, { delim, quoted, stripTabs }) {
  const lines = [];
  let i = start;
  while (i < src.length) {
    const nl = src.indexOf("\n", i);
    const raw = src.slice(i, nl < 0 ? src.length : nl).replace(/\r$/, "");
    const line = stripTabs ? raw.replace(/^\t+/, "") : raw;
    i = nl < 0 ? src.length : nl + 1;
    if (line === delim) break;
    lines.push(line);
  }
  const text = lines.join("\n");
  return { text, inner: quoted ? [] : expansions(text), end: i };
}

/** The word a here-string reads (`<<< word`): as the scanner keeps it in the segment's
 *  text (a substitution never stays in the text), what the command receives (quotes and
 *  escapes removed), and what its substitutions run. */
function readWord(src, start) {
  let i = start;
  while (src[i] === " " || src[i] === "\t") i += 1;
  let text = src.slice(start, i);
  let value = "";
  const inner = [];
  while (i < src.length && !WORD_END.test(src[i])) {
    const c = src[i];
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const stop = close < 0 ? src.length : close;
      value += src.slice(i + 1, stop);
      text += src.slice(i, stop + 1);
      i = stop + 1;
    } else if (c === '"') {
      const quoted = readDoubleQuoted(src, i);
      const closed = quoted.text.length > 1 && quoted.text.endsWith('"');
      value += quoted.text.slice(1, closed ? -1 : undefined).replace(/\\([$`"\\])/g, "$1");
      text += quoted.text;
      inner.push(...quoted.inner);
      i = quoted.end;
    } else if (c === "\\") {
      value += src[i + 1] ?? "";
      text += src.slice(i, i + 2);
      i += 2;
    } else if (c === "$" && src[i + 1] === "(") {
      const sub = readSubstitution(src, i);
      inner.push(sub.content);
      i = sub.end;
    } else if (c === "`") {
      const end = closingBacktick(src, i);
      inner.push(src.slice(i + 1, end));
      i = end + 1;
    } else {
      value += c;
      text += c;
      i += 1;
    }
  }
  return { text, value, inner, end: Math.min(i, src.length) };
}

/** Scans `src` from `start` until an unbalanced `closer` (")" for a substitution) or the
 *  end. Returns the parts met, where it stopped, and whether the closer was found. */
function scanShell(src, start, closer) {
  const parts = [];
  let text = "";
  let inner = [];
  let stdin = [];
  // Per input of `stdin`: whether the shell reads nothing into it (a heredoc with a quoted delimiter).
  let literal = [];
  let procIn = [];
  let piped = false;
  let pending = [];
  let depth = 0;
  let i = start;
  // `feeds`: the segment being closed pipes its output into the next one (`|`, `|&`).
  const cut = (feeds = false) => {
    const runs = inner.map((x) => x.trim()).filter(Boolean);
    const pushed = Boolean(text.trim() || runs.length || stdin.length || procIn.length);
    if (pushed) parts.push({ text: text.trim(), inner: runs, stdin, literal, procIn, piped });
    text = "";
    inner = [];
    stdin = [];
    literal = [];
    procIn = [];
    // A pipe followed by a newline still feeds the command on the next line.
    piped = pushed ? feeds : piped || feeds;
  };
  const atWordStart = () => i === start || /[\s;&|()]/.test(src[i - 1]);
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "\\") {
      text += next === "\n" ? " " : src.slice(i, i + 2);
      i += 2;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const stop = close < 0 ? src.length : close + 1;
      text += src.slice(i, stop);
      i = stop;
    } else if (c === '"') {
      const quotedText = readDoubleQuoted(src, i);
      text += quotedText.text;
      inner.push(...quotedText.inner);
      i = quotedText.end;
    } else if (c === "#" && atWordStart()) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if ((c === "$" || c === "<" || c === ">") && next === "(") {
      const sub = readSubstitution(src, i);
      inner.push(sub.content);
      if (c === "<") procIn.push(sub.content);
      i = sub.end;
    } else if (c === "`") {
      const end = closingBacktick(src, i);
      inner.push(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === "(" && next === "(" && atWordStart()) {
      // An arithmetic command, `(( x = 1 << 2 ))`: text, and its `<<` opens no heredoc.
      const close = src.indexOf("))", i + 2);
      const stop = close < 0 ? src.length : close + 2;
      text += src.slice(i, stop);
      i = stop;
    } else if (c === "<" && next === "<" && src[i + 2] === "<") {
      // A here-string: the word after it is the segment's standard input.
      const word = readWord(src, i + 3);
      text += `<<<${word.text}`;
      inner.push(...word.inner);
      stdin.push(word.value);
      literal.push(false);
      i = word.end;
    } else if (c === "<" && next === "<") {
      const operator = readHeredocOperator(src, i);
      // The body comes after the line: remember which segment it feeds.
      if (operator.delim) pending.push({ ...operator, part: parts.length });
      text += src.slice(i, operator.end);
      i = operator.end;
    } else if (c === "\n") {
      cut();
      i += 1;
      // The bodies of the heredocs opened on that line come right after it, each one the
      // standard input of the segment that opened it.
      for (const operator of pending) {
        const body = readHeredocBody(src, i, operator);
        const runs = body.inner.map((x) => x.trim()).filter(Boolean);
        const owner = parts[operator.part] ?? parts[parts.length - 1];
        if (owner) {
          owner.inner.push(...runs);
          owner.stdin.push(body.text);
          owner.literal.push(operator.quoted);
        } else if (runs.length) {
          parts.push({ text: "", inner: runs, stdin: [body.text], literal: [operator.quoted], procIn: [], piped: false });
        }
        i = body.end;
      }
      pending = [];
    } else if (c === "(") {
      depth += 1;
      text += c;
      i += 1;
    } else if (c === ")" && closer === ")" && depth === 0) {
      cut();
      return { parts, end: i + 1, closed: true };
    } else if (c === ")") {
      if (depth > 0) depth -= 1;
      text += c;
      i += 1;
    } else if (c === ";") {
      cut();
      i += 1;
    } else if (c === "|" && src[i - 1] !== ">") {
      // `|` and `|&` feed the next segment; `||` runs it only when this one fails.
      cut(next !== "|");
      i += next === "|" || next === "&" ? 2 : 1;
    } else if (c === "&" && next === "&") {
      cut();
      i += 2;
    } else if (c === "&" && next !== ">" && src[i - 1] !== ">" && src[i - 1] !== "<") {
      cut(); // a command sent to the background: the next one runs all the same
      i += 1;
    } else {
      text += c;
      i += 1;
    }
  }
  cut();
  return { parts, end: src.length, closed: false };
}

/** Drops leading environment assignments (`FOO=1 git push`) so the command
 *  itself can be matched, and reports the ones we care about. */
function withoutEnv(segment) {
  const env = new Map();
  let rest = segment;
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s+/.exec(rest);
    if (!m) break;
    env.set(m[1], m[2]);
    rest = rest.slice(m[0].length);
  }
  return { env, rest };
}

/** The quoted payload of a command, unquoted. Used to look at the command
 *  string a shell is handed (`sh -c "..."`), not at the shell that runs it. */
function quotedPayloads(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/** `git -C <dir> add -A` is still `git add -A`. Git accepts global options
 *  before the subcommand (-C <dir>, -c key=val, --git-dir=..., --no-pager):
 *  strip them so the subcommand sits right after `git`, whatever precedes it.
 *  Without this, `git -C "$DIR" push` slipped past every pattern: found on the
 *  plugin's own release skill, which pushes exactly that way. */
function normaliseGit(seg) {
  const m = /^git\s+/.exec(seg);
  if (!m) return seg;
  let rest = seg.slice(m[0].length);
  const option =
    /^(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|exec-path)=\S+|--no-pager|--no-replace-objects|--literal-pathspecs|--bare)\s+/;
  let o;
  while ((o = option.exec(rest)) !== null) rest = rest.slice(o[0].length);
  return `git ${rest}`;
}

/** `npx vercel --prod` is still `vercel --prod`. A one-shot runner (npx, bunx,
 *  pnpm dlx, yarn dlx, pnpm exec) only prefixes the real command: strip it,
 *  and its own flags, so the rules below see the tool they name. Found by an
 *  outside reader on 2.9.5: `pnpm dlx vercel --prod` walked past rule 3, and
 *  it is the very form the plugin recommends elsewhere. */
function withoutLauncher(seg) {
  const m =
    /^(?:npx|bunx|(?:pnpm|yarn)\s+(?:dlx|exec))\s+(?:(?:-y|-q|--yes|--quiet|--silent|-p\s+\S+|--package[= ]\S+)\s+)*/.exec(
      seg,
    );
  return m ? seg.slice(m[0].length) : seg;
}

/** `wrangler@latest deploy` is `wrangler deploy`: a version pin on the head
 *  token is dropped, a scoped package (`@scope/pkg`) keeps its `@`. Found by
 *  an outside reader on 3.0.4: `withoutLauncher` alone left it unmatched. */
function withoutVersion(seg) {
  return seg.replace(/^([^@\s]+)@[^\s/]+(?=\s|$)/, "$1");
}

/** The launchers that run the command after them unchanged, and how each one reads its
 *  options, the way getopt reads them: `value`, the short options that take a value (attached,
 *  `-n5`, or in the next word, `-n 5`); `optional`, those whose value can only be attached
 *  (`sudo -h`); `long`, the long options, a trailing `=` marking those that take a value
 *  (after `=`, or in the next word), each accepted by any unambiguous prefix (`--sig` is
 *  `--signal`); `split`, the options whose value is itself the command (`env -S "git push"`);
 *  `operands`, the words between the options and the command (the duration of `timeout`).
 *  They all stop reading options at the first word that is not one. Reading only some forms let
 *  `timeout --signal KILL 60 git push`, `sudo --user root git push` and `env -C /tmp git push`
 *  through (outside review, 3.3.2, and the rest of the family measured then). */
const LAUNCHERS = {
  sudo: {
    value: "aCcDgpRrTtUu",
    optional: "h",
    long: [
      "askpass", "auth-type=", "background", "bell", "chdir=", "chroot=", "close-from=",
      "command-timeout=", "edit", "group=", "help", "host=", "list", "login", "login-class=",
      "no-update", "non-interactive", "other-user=", "preserve-env", "preserve-groups", "prompt=",
      "remove-timestamp", "reset-timestamp", "role=", "set-home", "shell", "stdin", "type=",
      "user=", "validate", "version",
    ],
  },
  doas: { value: "aCu" },
  env: {
    value: "CLPSUu",
    long: [
      "block-signal", "chdir=", "debug", "default-signal", "help", "ignore-environment",
      "ignore-signal", "list-signal-handling", "null", "split-string=", "unset=", "version",
    ],
    split: ["S", "split-string"],
    dash: true,
  },
  nice: { value: "n", long: ["adjustment=", "help", "version"], number: true },
  time: { value: "fo", long: ["append", "format=", "help", "output=", "portability", "quiet", "verbose", "version"] },
  timeout: {
    value: "ks",
    long: ["foreground", "help", "kill-after=", "preserve-status", "signal=", "verbose", "version"],
    operands: 1,
  },
  stdbuf: { value: "eio", long: ["error=", "help", "input=", "output=", "version"] },
  caffeinate: { value: "tw" },
  nohup: { long: ["help", "version"] },
  exec: { value: "a" },
  setsid: { long: ["ctty", "fork", "help", "version", "wait"] },
  // macOS (outside review, 3.3.4). `arch` reads whole words after one dash: an architecture
  // (`-arm64`, `-x86_64`), or `-arch <name>`, `-d <name>`, `-e <name=value>`.
  arch: { words: { arch: true, d: true, e: true }, anyDash: true },
  // `xcrun` runs the tool it names; `--find` only prints its path. Its long options are also
  // written after a single dash (`-sdk macosx`).
  xcrun: {
    value: "f",
    long: [
      "find=", "help", "kill-cache", "log", "no-cache", "run", "sdk=", "show-sdk-build-version",
      "show-sdk-path", "show-sdk-platform-path", "show-sdk-platform-version", "show-sdk-version",
      "toolchain=", "verbose", "version",
    ],
    singleDashLong: true,
  },
  // macOS (outside review, 3.3.5). `taskpolicy` runs its program under a policy (`-p <pid>` only
  // changes a running process: nothing follows it). `sandbox-exec` runs its command in a profile.
  // `script` records a terminal: on macOS its first operand is the file and the rest the command
  // it runs; on Linux the command comes in -c, a command line of its own.
  taskpolicy: { value: "ctldgp" },
  "sandbox-exec": { value: "fnpD" },
  script: {
    value: "tTIOBmEoc",
    long: [
      "append", "command=", "echo=", "flush", "force", "help", "log-in=", "log-io=", "log-out=",
      "log-timing=", "logging-format=", "output-limit=", "quiet", "return", "timing", "version",
    ],
    split: ["c", "command"],
    operands: 1,
  },
};
LAUNCHERS.gtimeout = LAUNCHERS.timeout;

/** The segment after a launcher and its options (see LAUNCHERS), or null when the segment
 *  does not start with one. */
function afterLauncher(seg) {
  const list = words(seg);
  const spec = list.length ? LAUNCHERS[list[0].value] : null;
  if (!spec) return null;
  const rest = (from, head = []) => [...head, ...list.slice(from).map((x) => x.raw)].join(" ");
  const bare = (o) => o.replace(/=$/, "");
  const long = spec.long ?? [];
  let i = 1;
  while (i < list.length) {
    const v = list[i].value;
    if (v === "--") {
      i += 1;
      break;
    }
    if ((v === "-" && spec.dash) || (spec.number && /^-\d+$/.test(v))) {
      i += 1;
      continue;
    }
    // Options that are whole words after a single dash (`arch -arch arm64`, `xcrun -sdk
    // macosx`): read as the launcher reads them, never letter by letter.
    if (/^-[^-]/.test(v)) {
      const name = v.slice(1);
      if (spec.words && Object.hasOwn(spec.words, name)) {
        i += spec.words[name] ? 2 : 1;
        continue;
      }
      const single = spec.singleDashLong && name.length > 1 ? long.find((o) => bare(o) === name) : null;
      if (single) {
        i += single.endsWith("=") ? 2 : 1;
        continue;
      }
      if (spec.anyDash) {
        i += 1;
        continue;
      }
    }
    if (/^--[^=]/.test(v)) {
      const eq = v.indexOf("=");
      const name = eq < 0 ? v.slice(2) : v.slice(2, eq);
      const prefixed = long.filter((o) => bare(o).startsWith(name));
      const opt = long.find((o) => bare(o) === name) ?? (prefixed.length === 1 ? prefixed[0] : null);
      i += 1;
      if (opt && spec.split?.includes(bare(opt))) {
        return eq >= 0 ? rest(i, [v.slice(eq + 1)]) : rest(i + 1, [list[i]?.value ?? ""]);
      }
      if (opt?.endsWith("=") && eq < 0) i += 1;
      continue;
    }
    if (/^-./.test(v)) {
      i += 1;
      for (let j = 1; j < v.length; j += 1) {
        if (spec.optional?.includes(v[j])) break;
        if (!spec.value?.includes(v[j])) continue;
        const attached = v.slice(j + 1);
        if (spec.split?.includes(v[j])) return attached ? rest(i, [attached]) : rest(i + 1, [list[i]?.value ?? ""]);
        if (!attached) i += 1;
        break;
      }
      continue;
    }
    break;
  }
  return rest(i + (spec.operands ?? 0));
}

/** Where a command hides. `sudo git add -A`, `/usr/bin/git add -A`,
 *  `command git add -A`, `(git add -A && ...)`, `{ git add -A; }`,
 *  `if x; then git add -A; fi`: one family, and the family is infinite, so
 *  a pattern per shape never closes it (outside review, 3.0.4). The rules
 *  therefore never see the raw head of a segment: the openers a shell
 *  swallows are peeled off, the prefixes that run the rest unchanged are
 *  dropped with their own options, a quoted or backslashed head is
 *  unquoted, a launcher and a version pin go, and a path is reduced to its
 *  binary. Repeated until nothing changes, because the shapes stack
 *  (`sudo env FOO=1 /usr/bin/git ...`). The assignments met on the way are
 *  collected: the escape prefixes are read from them. */
function normalise(raw) {
  const env = new Map();
  const cut = [];
  let s = raw.trim();
  for (let round = 0; round < 16; round += 1) {
    const before = s;
    // Braces first, as the shell expands them before anything runs: `{git,} add .` is
    // `git add .`, and an opener `{` stripped first would have hidden it.
    s = expandBraces(s, cut);
    // A word is read as the shell hands it over, whatever its quotes: `git "push"` is `git push`.
    s = plainWords(s);
    // A function written on one line (`f() { git push; }; f`, `function f { ... }`, `f() ( ... )`,
    // zsh's `() { ... }`): its header is no command, and the body behind it went unread. Peeled
    // here, the body is read as any block is, called or not, like that of a function written over
    // several lines, whose lines are segments of their own (outside review of the 3.4.13).
    s = s.replace(/^(?:function(?:\s+[^\s(){};|&<>]+)?(?:\s*\(\s*\))?(?=[\s({]|$)|[^\s(){};|&<>=]*\s*\(\s*\))\s*/, "");
    // Openers and keywords a shell swallows before the command itself, and
    // the closers of the same blocks at the end.
    s = s.replace(/^(?:[({]\s*|(?:then|do|else|elif|if|while|until)\s+|!\s+)/, "");
    // A `)` closes a subshell even attached (`(git add -A)`); a `}` closes a group only as
    // a word of its own (`{ git add -A; }`). Attached, it belongs to a word: the `{}` that
    // `xargs -I{} git add {}` fills in, read as a closer, left `git add {` (outside review, 3.3.2).
    s = s.replace(/(?:[\s;]*\)|(?:^|[\s;]+)\})+$/, "");
    // A whole segment in quotes (`eval "git push"`) is the command it quotes.
    s = s.replace(/^(["'])(.*)\1$/, "$2");
    // `FOO=1 git push`: assignments carry the escape prefixes, keep them.
    const e = withoutEnv(s);
    for (const [k, v] of e.env) env.set(k, v);
    s = e.rest;
    // Prefixes that run the rest unchanged, read with their options as they read them.
    const launched = afterLauncher(s);
    if (launched !== null) s = launched;
    s = s.replace(/^(?:command(?:\s+-p)?|builtin|eval)\s+/, "");
    // A quoted or escaped head: `"git" push`, `\git push`.
    s = s.replace(/^(["'])([^"'\s]+)\1(?=\s|$)/, "$2").replace(/^\\(?=\S)/, "");
    // A launcher, a version pin, a path: `npx wrangler@latest deploy`,
    // `/usr/bin/git push`, `./node_modules/.bin/vercel --prod`.
    s = withoutVersion(withoutLauncher(s));
    s = s.replace(/^(?:[A-Za-z]:)?[^\s"'=]*\/(?=[^\s/]+(?:\s|$))/, "");
    s = normaliseGit(s);
    if (s === before) break;
  }
  return { env, seg: s.trim(), unread: cut.length > 0 };
}

/** Brace expansion, as the shell does it before running a command: `git add {.,.}` is
 *  `git add . .`, `git add -{A,A}` is `git add -A -A`, `{git,} add .` is `git add .`. The
 *  refused word never appears as typed, the same gesture as `:/` (outside review, 3.3.4). The
 *  expansion is lexical and deterministic, so it is within the reader's reach, done as the shell
 *  does it: an unquoted, unescaped `{...}` with a comma at its top level, or a sequence
 *  (`{a..c}`, `{1..3}`), never `${...}`, never an assignment word; an empty word it leaves is
 *  dropped. `git add src/{a,b}.ts` still passes, and a quoted `'{.,.}'` is a name. Every
 *  word is kept once while it unfolds: a duplicate changes nothing to the rules, and `.{,}`
 *  repeated is `.` again. What still unfolds past BRACE_LIMIT words is left as typed, and put in
 *  `cut`: the command is then asked about, because a word the guard could not unfold is not a word
 *  with nothing in it (outside review, 3.3.5: thirteen `{,}` made `git add .` pass). A sequence
 *  too long to unfold stays a name: its words are numbers, never a refused one. */
const BRACE_LIMIT = 4096;
const BRACE_ROUNDS = 256;
function expandBraces(seg, cut = null) {
  if (!seg.includes("{")) return seg;
  const out = [];
  for (const w of words(seg)) {
    if (!w.raw.includes("{") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.raw)) {
      out.push(w.raw);
      continue;
    }
    const unfolded = braceWords(w.raw);
    if (unfolded === null) {
      cut?.push(w.raw);
      out.push(w.raw);
    } else {
      out.push(...unfolded.filter((x) => x !== ""));
    }
  }
  return out.join(" ");
}

/** The words one word expands to, braces expanded first to last, nested ones included, each
 *  word kept once. null when it does not unfold within BRACE_LIMIT words and BRACE_ROUNDS rounds. */
function braceWords(raw) {
  let results = [raw];
  for (let round = 0; round < BRACE_ROUNDS; round += 1) {
    let changed = false;
    const next = [];
    const seen = new Set();
    const add = (w) => {
      if (seen.has(w)) return;
      seen.add(w);
      next.push(w);
    };
    for (const r of results) {
      const b = firstBrace(r);
      if (!b) {
        add(r);
        continue;
      }
      changed = true;
      for (const item of b.items) add(`${r.slice(0, b.open)}${item}${r.slice(b.close + 1)}`);
      if (next.length > BRACE_LIMIT) return null;
    }
    results = next;
    if (!changed) return results;
  }
  return results.some((r) => firstBrace(r)) ? null : results;
}

/** Which characters of a word are quoted or escaped, and so never part of an expansion. */
function literalMask(r) {
  const mask = new Array(r.length).fill(false);
  let i = 0;
  while (i < r.length) {
    if (r[i] === "\\") {
      mask[i] = true;
      if (i + 1 < r.length) mask[i + 1] = true;
      i += 2;
    } else if (r[i] === "'") {
      const close = r.indexOf("'", i + 1);
      const stop = close < 0 ? r.length - 1 : close;
      for (let k = i; k <= stop; k += 1) mask[k] = true;
      i = stop + 1;
    } else if (r[i] === '"') {
      let j = i + 1;
      while (j < r.length && r[j] !== '"') j += r[j] === "\\" ? 2 : 1;
      const stop = Math.min(j, r.length - 1);
      for (let k = i; k <= stop; k += 1) mask[k] = true;
      i = stop + 1;
    } else {
      i += 1;
    }
  }
  return mask;
}

/** The first brace of a word the shell expands: where it opens and closes, and its items. */
function firstBrace(r) {
  const lit = literalMask(r);
  for (let open = 0; open < r.length; open += 1) {
    if (r[open] !== "{" || lit[open] || (open > 0 && r[open - 1] === "$" && !lit[open - 1])) continue;
    let depth = 0;
    const commas = [];
    for (let k = open; k < r.length; k += 1) {
      if (lit[k]) continue;
      if (r[k] === "{") depth += 1;
      else if (r[k] === "," && depth === 1) commas.push(k);
      else if (r[k] === "}") {
        depth -= 1;
        if (depth > 0) continue;
        if (commas.length) {
          const items = [];
          let from = open + 1;
          for (const c of commas) {
            items.push(r.slice(from, c));
            from = c + 1;
          }
          items.push(r.slice(from, k));
          return { open, close: k, items };
        }
        const seq = braceSequence(r.slice(open + 1, k));
        if (seq) return { open, close: k, items: seq };
        break;
      }
    }
  }
  return null;
}

/** `{1..5}`, `{a..e}`, with an optional step (`{1..9..2}`): the words of a sequence. */
function braceSequence(body) {
  const m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body) ?? /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  if (!m) return null;
  const numeric = /^-?\d/.test(m[1]);
  const a = numeric ? Number(m[1]) : m[1].charCodeAt(0);
  const b = numeric ? Number(m[2]) : m[2].charCodeAt(0);
  const step = Math.abs(Number(m[3] ?? 1)) || 1;
  const out = [];
  for (let x = a; a <= b ? x <= b : x >= b; x += a <= b ? step : -step) {
    out.push(numeric ? String(x) : String.fromCharCode(x));
    if (out.length > BRACE_LIMIT) return null;
  }
  return out;
}

/** The words of a segment, each as typed (`raw`) and as the command receives it (`value`:
 *  quotes and escapes removed). */
function words(seg) {
  const out = [];
  let i = 0;
  while (i < seg.length) {
    while (i < seg.length && /\s/.test(seg[i])) i += 1;
    if (i >= seg.length) break;
    let raw = "";
    let value = "";
    while (i < seg.length && !/\s/.test(seg[i])) {
      const c = seg[i];
      if (c === "'") {
        const close = seg.indexOf("'", i + 1);
        const stop = close < 0 ? seg.length : close;
        value += seg.slice(i + 1, stop);
        raw += seg.slice(i, stop + 1);
        i = stop + 1;
      } else if (c === '"') {
        let j = i + 1;
        while (j < seg.length && seg[j] !== '"') j += seg[j] === "\\" ? 2 : 1;
        value += seg.slice(i + 1, Math.min(j, seg.length)).replace(/\\([$`"\\])/g, "$1");
        raw += seg.slice(i, j + 1);
        i = j + 1;
      } else if (c === "$" && seg[i + 1] === "'") {
        // An ANSI-C string, `$'...'`: its escapes are read as the shell reads them.
        let j = i + 2;
        while (j < seg.length && seg[j] !== "'") j += seg[j] === "\\" ? 2 : 1;
        value += ansiC(seg.slice(i + 2, Math.min(j, seg.length)));
        raw += seg.slice(i, j + 1);
        i = j + 1;
      } else if (c === "$" && seg[i + 1] === '"') {
        // A localised string, `$"..."`: the double-quoted string it is.
        raw += c;
        i += 1;
      } else if (c === "\\") {
        value += seg[i + 1] ?? "";
        raw += seg.slice(i, i + 2);
        i += 2;
      } else {
        value += c;
        raw += c;
        i += 1;
      }
    }
    out.push({ raw, value });
  }
  return out;
}

// A redirection as typed: `> out`, `2>&1`, `&> log`, `< in`, a heredoc operator with its
// delimiter, a here-string with its word. Alone, its target is the next word.
const REDIRECTION = /^(?:\d*|&)(?:<<<|<<-?|<>|>>|>\||>&|<&|>|<)/;

function redirection(raw) {
  const m = REDIRECTION.exec(raw);
  return m ? { alone: m[0].length === raw.length } : null;
}

/** The words that are arguments, redirections and their targets left out. */
function operandsOf(list) {
  const out = [];
  for (let w = 0; w < list.length; w += 1) {
    const r = redirection(list[w].raw);
    if (r) {
      if (r.alone) w += 1;
      continue;
    }
    out.push(list[w]);
  }
  return out;
}

/** `\n` and `\t` as `echo -e` and `printf` would print them. Read that way whatever the
 *  flags: judging a script as more lines than it has can only ask more, never less. */
function escapesOf(text) {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/** What segment `k` prints, when the command line says it: `echo` or `printf` of literal
 *  words, `cat` of its heredoc or here-string, and what `cat` or `tee` pass through from
 *  the segment piped into them. null when it cannot be read from the command line (a
 *  file, a program, the network): nothing can be judged then. */
function producedBy(parts, k, depth = 0) {
  const part = parts[k];
  if (!part || depth > 8) return null;
  const list = words(normalise(part.text).seg);
  const head = list[0]?.value;
  const args = operandsOf(list.slice(1)).map((w) => w.value);
  if (head === "echo") {
    while (args.length && /^-[neE]+$/.test(args[0])) args.shift();
    return escapesOf(args.join(" "));
  }
  if (head === "printf") {
    if (args[0] === "--") args.shift();
    // Everything it could print, the format and its arguments alike.
    return args.map(escapesOf).join("\n");
  }
  const passesInput = (head === "cat" && args.every((a) => a === "-")) || head === "tee";
  if (!passesInput) return null;
  if (part.stdin.length) return part.stdin.join("\n");
  return part.piped ? producedBy(parts, k - 1, depth + 1) : null;
}

/** What a command line prints (the content of a `<(...)`): the output of the last segment
 *  of each of its pipelines, when every one of them can be read. */
function outputOf(commandLine) {
  const parts = readCommandLine(commandLine);
  const printed = [];
  for (let k = 0; k < parts.length; k += 1) {
    if (parts[k + 1]?.piped) continue;
    const out = producedBy(parts, k);
    if (out === null) return null;
    printed.push(out);
  }
  return printed.length ? printed.join("\n") : null;
}

const SHELLS = /^(?:sh|bash|zsh|dash|ksh|mksh|fish)$/;
const SOURCING = /^(?:source|\.)$/;
const FROM_STDIN = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

/** The scripts a shell segment runs from elsewhere than a `-c` string: its standard input
 *  (a heredoc, a here-string, what a pipe brings) or the `<(...)` given as its script
 *  file; `source` and `.` likewise. Returns the scripts that can be read, [] when none can
 *  (a script file, a program's output), and null when the segment is no such command. */
function scriptsOf(parts, k, seg) {
  const list = words(seg);
  const head = list[0]?.value ?? "";
  const shell = SHELLS.test(head);
  if (!shell && !SOURCING.test(head)) return null;
  let readsStdin = false;
  let script = null;
  const rest = list.slice(1);
  for (let w = 0; w < rest.length; w += 1) {
    const r = redirection(rest[w].raw);
    if (r) {
      if (r.alone) w += 1;
      continue;
    }
    const v = rest[w].value;
    if (shell && /^[-+][A-Za-z]/.test(v)) {
      if (/^-[A-Za-z]*c/.test(v)) return null; // a -c string: read by the rule above
      if (/^-[A-Za-z]*s/.test(v)) readsStdin = true;
      if (/^[-+][oO]$/.test(v)) w += 1; // `-o pipefail`
      continue;
    }
    if (shell && v.startsWith("--")) {
      if (/^--(?:rcfile|init-file)$/.test(v)) w += 1;
      continue;
    }
    script = v;
    break;
  }
  const part = parts[k];
  const fromInput = () => {
    if (part.stdin.length) return part.stdin;
    const piped = part.piped ? producedBy(parts, k - 1) : null;
    return piped === null ? [] : [piped];
  };
  if (script === null && part.procIn.length) {
    const printed = outputOf(part.procIn[0]);
    return printed === null ? [] : [printed];
  }
  if (script === null) return shell ? fromInput() : [];
  if (FROM_STDIN.test(script) || readsStdin) return fromInput();
  return [];
}

/** The command lines `find` runs through `-exec`, `-execdir`, `-ok` or `-okdir`: the words
 *  after the action, up to its `;` or `+`, as written (`{}` stays: what it names cannot be read
 *  from the command line). `find . -exec git push \;` is a push (outside review, 3.3.1). */
function findCommands(seg) {
  const list = words(seg);
  const out = [];
  for (let w = 1; w < list.length; w += 1) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(list[w].value)) continue;
    const parts = [];
    let k = w + 1;
    for (; k < list.length && list[k].value !== ";" && list[k].value !== "+"; k += 1) parts.push(list[k].raw);
    if (parts.length) out.push(parts.join(" "));
    w = k;
  }
  return out;
}

/** The command lines `xargs` would run: the command after its options, with what the
 *  segment piped into it prints when the command line says it (`producedBy`), put in place
 *  of the replacement string (`-I{}`, `-i`, `--replace`) or appended as arguments. Without
 *  a readable input, the command as written: `xargs git push` is still a push. */
function xargsCommands(parts, k, seg) {
  const list = words(seg);
  let replace = null;
  let bsdJ = false;
  let fromFile = false;
  let nul = false;
  let w = 1;
  for (; w < list.length; w += 1) {
    const v = list[w].value;
    if (v === "--") {
      w += 1;
      break;
    }
    if (!v.startsWith("-") || v === "-") break;
    // GNU's options, and BSD's (macOS): -J replaces like -I, -R and -S take a value. Unknown to
    // the reader, a value would become the command (outside review, 3.3.1).
    if (/^-[IEdnLPsaJRS]$/.test(v) || /^--(?:max-args|max-lines|max-procs|max-chars|delimiter|arg-file|eof|process-slot-var)$/.test(v)) {
      if (v === "-I" || v === "-J") replace = list[w + 1]?.value ?? null;
      if (v === "-J") bsdJ = true;
      if (v === "-a" || v === "--arg-file") fromFile = true;
      w += 1;
      continue;
    }
    if (v.startsWith("-I") || v.startsWith("-J")) replace = v.slice(2);
    if (v.startsWith("-J")) bsdJ = true;
    else if (/^-i/.test(v)) replace = v.slice(2) || "{}";
    else if (/^--replace(?:=|$)/.test(v)) replace = v.includes("=") ? v.slice(v.indexOf("=") + 1) : "{}";
    else if (/^(?:-a.|--arg-file=)/.test(v)) fromFile = true;
    if (v === "-0" || v === "--null" || /^-[^-]*0/.test(v)) nul = true;
  }
  const command = list
    .slice(w)
    .map((x) => x.raw)
    .join(" ");
  if (!command) return [];
  const part = parts[k];
  let input = null;
  if (!fromFile) {
    if (part.stdin.length) input = part.stdin.join("\n");
    else if (part.piped) input = producedBy(parts, k - 1);
  }
  if (input === null) return [command];
  if (replace) {
    const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    const items = (nul ? input.split("\0") : input.split("\n").map((l) => l.trim())).filter(Boolean);
    const withWord = (sub, item) =>
      list
        .slice(w)
        .map((x) => (x.value === replace ? sub : x.raw.split(replace).join(item)))
        .join(" ");
    if (bsdJ) {
      // BSD -J: the input's ARGUMENTS take the replacement's place (its words, or each item of
      // -0 as one argument): `echo push origin main | xargs -J % git %` is `git push origin main`.
      const args = nul ? items.map(quote).join(" ") : input.split(/\s+/).filter(Boolean).join(" ");
      return [withWord(args, args)];
    }
    // -I, -i, --replace: each line becomes ONE argument where the replacement is a whole word
    // (`xargs -0 -I % bash -c %` hands the whole line to `-c`). Judged under both readings, as
    // that one argument and as its words: the worse verdict wins, a question too many costs less
    // than a push let through.
    const lines = items.flatMap((item) => [withWord(quote(item), item), withWord(item, item)]);
    return lines.length ? lines : [command];
  }
  const args = input.split(/\s+/).filter(Boolean).join(" ");
  return [args ? `${command} ${args}` : command];
}

/** `git add` given a pathspec that means the whole tree: `.`, `*`, or the top magic with
 *  nothing after it (`:/`, `':(top)'`), which from a subfolder stages MORE than the refused
 *  `.` does (outside review, 3.2.4); or nothing but exclusions (`':!secret'`), which stage
 *  everything else. */
function sweepingPathspecs(seg) {
  if (!/^git\s+add\b/.test(seg)) return false;
  const specs = [];
  let options = true;
  for (const w of operandsOf(words(seg).slice(2))) {
    if (options && w.value === "--") {
      options = false;
      continue;
    }
    if (options && w.value.startsWith("-")) continue;
    specs.push(w.value);
  }
  if (!specs.length) return false;
  const kinds = specs.map(pathspecKind);
  return kinds.includes("whole") || kinds.every((kind) => kind === "exclude");
}

/** "whole", "exclude" or "part", from git's pathspec magic: the short form (`:/`, `:!x`,
 *  `:^x`) and the long one (`:(top,glob)x`). */
function pathspecKind(spec) {
  let rest = spec;
  let top = false;
  let exclude = false;
  const long = /^:\(([^)]*)\)/.exec(rest);
  if (long) {
    const magic = long[1].split(",").map((x) => x.trim().toLowerCase());
    top = magic.includes("top");
    exclude = magic.includes("exclude");
    rest = rest.slice(long[0].length);
  } else if (rest.startsWith(":")) {
    let j = 1;
    for (; j < rest.length && "/!^".includes(rest[j]); j += 1) {
      if (rest[j] === "/") top = true;
      else exclude = true;
    }
    if (rest[j] === ":") j += 1;
    rest = rest.slice(j);
  }
  if (exclude) return "exclude";
  const everything = top ? ["", ".", "./", "*", "./*"] : [".", "./", "*", "./*"];
  return everything.includes(rest) ? "whole" : "part";
}

// ── A word, as the shell hands it over ──────────────────────────────────────
// The rules name a command's words (`git push`, `git add -A`, `git reset --hard`) and read them in
// the segment's text. A word the shell hands over unchanged but that is not typed bare walked
// past every one of them: `git "push"`, `git add '-A'`, `git add \-A`, `git pu"sh"`,
// `git $'push'` (found while rewriting the rules, 3.3.10; they had read text since their first version).
// So before any rule runs, a word whose value is plain (the letters, digits and punctuation of a
// command, an option, a path or a ref) is written as its value. A word that carries a blank, a
// quote, a `$` or a glob stays as typed: it is a value, or something the shell will expand, and
// the rules that read values (a commit message, a SQL statement, a payload) still find it quoted.
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,.\/~^-]+$/;

/** A segment with each plain word written as the command receives it. */
function plainWords(seg) {
  const list = words(seg);
  const dressed = (w) => w.raw !== w.value && PLAIN_WORD.test(w.value);
  return list.some(dressed) ? list.map((w) => (dressed(w) ? w.value : w.raw)).join(" ") : seg;
}

/** What an ANSI-C string (`$'...'`) holds once the shell has read its escapes: `$'\x70ush'` is
 *  `push`. */
function ansiC(body) {
  const simple = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  return body.replace(/\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|c([\s\S])|([\s\S]))/g, (whole, hex, u4, u8, octal, control, one) => {
    if (hex ?? u4 ?? u8) return String.fromCodePoint(Math.min(parseInt(hex ?? u4 ?? u8, 16), 0x10ffff));
    if (octal) return String.fromCharCode(parseInt(octal, 8) & 0xff);
    if (control) return String.fromCharCode(control.toUpperCase().charCodeAt(0) ^ 0x40);
    return simple[one] ?? one;
  });
}

// ── An option, as git reads it ──────────────────────────────────────────────
// Git takes a long option by any unambiguous prefix (`--al` is `--all`, `--har` is `--hard`,
// `--forc` is `--force`), and an option wherever it stands among the arguments
// (`git reset HEAD~1 --hard`, `git commit -m x -a`, `git clean . -f`). The rules read `--all`,
// `--hard`, `--force` in full, and right after the subcommand: each of the forms above staged
// everything, discarded work or deleted files with no refusal and no question (same finding).

/** The arguments of `git <subcommand>` that can be options: what follows the subcommand, up to
 *  a `--`. Null when the segment is not that subcommand. */
function gitOptions(seg, subcommand) {
  if (!new RegExp(`^git\\s+${subcommand}(?:\\s|$)`).test(seg)) return null;
  const args = operandsOf(words(seg))
    .slice(2)
    .map((w) => w.value);
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
}

/** `git add` told to stage everything by an option: `-A`, `-u`, a cluster that carries one of
 *  them, `--all`, `--update`, or a prefix git takes for one of those. */
const addSweeps = (seg) => (gitOptions(seg, "add") ?? []).some((w) => /^-[a-zA-Z]*[Au][a-zA-Z]*$/.test(w) || /^--(?:a(?:ll?)?|u(?:p(?:d(?:a(?:te?)?)?)?)?)$/.test(w));

/** The options of `git commit` that take their value in the next word. */
const COMMIT_VALUED = ["--message", "--file", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--author", "--date", "--template", "--cleanup", "--trailer", "--pathspec-from-file"];

/** `git commit` told to stage every tracked change on its way (`-a`, `--all`), as git reads it:
 *  among its options, in a cluster before any letter that takes a value (`-am` is `-a -m`, `-ma`
 *  is the message "a"), and never the value of the option before it (`-m -a` is a commit whose
 *  message is "-a"). */
function commitSweeps(seg) {
  const options = gitOptions(seg, "commit");
  if (!options) return false;
  for (let i = 0; i < options.length; i += 1) {
    const w = options[i];
    if (w === "--all") return true;
    if (w.startsWith("--")) {
      // A long option that takes a value takes the next word, unless it carries it after `=`.
      if (!w.includes("=") && w.length > 3 && COMMIT_VALUED.some((o) => o.startsWith(w))) i += 1;
    } else if (/^-[a-zA-Z]/.test(w)) {
      for (let k = 1; k < w.length; k += 1) {
        if (w[k] === "a") return true;
        // `-S` and `-u` take their value attached; the others take the rest of the word, or
        // the next word when nothing follows the letter.
        if ("Su".includes(w[k])) break;
        if ("mFCct".includes(w[k])) {
          if (k === w.length - 1) i += 1;
          break;
        }
      }
    }
  }
  return false;
}

/** `git reset` told to discard the working tree: `--hard`, `--merge`, or a prefix git takes. */
const resetDiscards = (seg) => (gitOptions(seg, "reset") ?? []).some((w) => /^--(?:h(?:a(?:rd?)?)?|me(?:r(?:ge?)?)?)$/.test(w));

/** `git clean` told to delete: `-f`, a cluster that carries it, `--force` or a prefix of it. */
const cleanForces = (seg) => (gitOptions(seg, "clean") ?? []).some((w) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(w) || /^--f(?:o(?:r(?:ce?)?)?)?$/.test(w));

/** `git checkout` or `git restore` given a pathspec that means the whole tree (`.`, `*`, `:/`):
 *  every uncommitted change of the tree goes, whatever comes before it (`git checkout HEAD -- .`,
 *  `git restore -SW .`). */
function restoresWholeTree(seg) {
  if (!/^git\s+(?:checkout|restore)(?:\s|$)/.test(seg)) return false;
  return operandsOf(words(seg))
    .slice(2)
    .some((w) => !w.value.startsWith("-") && pathspecKind(w.value) === "whole");
}

// ── A flag that spares a question ───────────────────────────────────────────
// A dry-run push publishes nothing, a blank run of one of the clock's scripts changes nothing:
// those pass. But only when the command READS the flag as that flag. Looked
// for in the segment's text, it was found where the command does not read it: inside a quoted
// value (`--url "x --dry-run y"`), as part of another word (`main:x--dry-run` is a branch),
// taken as the value of the option before it (`git push --repo --dry-run origin main` pushes),
// or switched off further on (`git push --dry-run --no-dry-run` pushes too). Each spared the
// question for a real run (found while rewriting the rules, 3.3.10; the push rule had read its
// flag that way since its first version). So a flag counts as a word of its own, as the command receives it,
// where the command's own reading of its options makes it that flag, and never in a segment
// that carries a substitution: the scanner takes what a substitution runs out of the text, and
// `--dry-run$(echo x)` would be left reading `--dry-run`.

/** The words a command receives, redirections and their targets left out; `unread` when one of
 *  them is not on the command line (a variable): it could be anything, the option that takes
 *  the flag as its value included. */
function argumentsOf(seg) {
  const list = operandsOf(words(seg));
  return { args: list.map((w) => w.value), unread: list.some((w) => /[$`]/.test(w.raw.replace(/'[^']*'/g, ""))) };
}

/** The options of `git push` that take no value: `--dry-run` right after one of them is still
 *  an option. After any other option (`-o`, `--repo`, `--receive-pack`, `--exec`, an
 *  abbreviation of one of them) it may be that option's value, and it is not counted. */
const PUSH_VALUELESS = new Set(["--all", "--atomic", "--branches", "--delete", "--dry-run", "--follow-tags", "--force", "--force-if-includes", "--force-with-lease", "--mirror", "--porcelain", "--progress", "--prune", "--quiet", "--set-upstream", "--tags", "--thin", "--verbose", "-4", "-6", "-d", "-f", "-n", "-q", "-u", "-v"]);

/** Whether a `git push` is a dry run as git reads it: `--dry-run` among its options, a word of
 *  its own, not the value of the option before it, and never switched off (git reads the last
 *  of `--dry-run` and `--no-dry-run`, and takes either by any unambiguous prefix). */
function pushIsDryRun(seg) {
  const { args, unread } = argumentsOf(seg);
  if (unread) return false;
  const rest = args.slice(args.indexOf("push") + 1);
  const end = rest.indexOf("--");
  const options = end < 0 ? rest : rest.slice(0, end);
  if (options.some((w) => /^--no-d/.test(w))) return false;
  return options.some((w, i) => w === "--dry-run" && (i === 0 || !options[i - 1].startsWith("-") || options[i - 1].includes("=") || PUSH_VALUELESS.has(options[i - 1])));
}

/** The options of `git config` that take no value. */
const CONFIG_VALUELESS = new Set(["--local", "--global", "--system", "--worktree", "--bool", "--int", "--bool-or-int", "--path", "--expiry-date", "--no-type", "--null", "-z", "--name-only", "--show-origin", "--show-scope", "--show-names", "--includes", "--no-includes", "--fixed-value", "--all", "--regexp"]);

/** Whether a `git config` segment only reads or removes the key found at `key`, as git reads
 *  it. A subcommand (`get`, `unset`, `list`) is the first word after `config`; an option
 *  (`--get`, `--unset`, `--list`...) is a word of its own before the key that is not the value of
 *  the option before it: `git config --comment --unset hypervibe.hooks true` SETS the key, with
 *  "--unset" as its comment. */
function configOnlyReads(seg, key) {
  const before = operandsOf(words(seg.slice(0, key.index))).map((w) => w.value);
  const options = before.slice(before.indexOf("config") + 1);
  if (/^(?:get|unset|list)$/.test(options[0] ?? "")) return true;
  return options.some((w, i) => /^--(?:get(?:-all|-regexp)?|unset(?:-all)?|list)$/.test(w) && (i === 0 || !options[i - 1].startsWith("-") || options[i - 1].includes("=") || CONFIG_VALUELESS.has(options[i - 1])));
}

/** Whether a wrangler command is a dry run as wrangler reads it: `--dry-run` once, a word of its
 *  own before any `--`, with no value after it (`--dry-run false`), and no other spelling around
 *  that switches it off (`--no-dry-run`, `--dry-run=false`, `--dryRun=false`). */
function wranglerIsDryRun(seg) {
  const { args, unread } = argumentsOf(seg);
  if (unread) return false;
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  const about = options.filter((w) => /dry-?run/i.test(w));
  if (about.length !== 1 || about[0] !== "--dry-run") return false;
  return !/^(?:true|false|0|1|yes|no|on|off)$/i.test(options[options.indexOf("--dry-run") + 1] ?? "");
}

// ── The flags of the clock's own scripts ────────────────────────────────────
// ensure.mjs, worker-check.mjs, register.mjs and migrate-live.mjs read their flags through one
// parser (parseFlags, scripts/shared-worker/_lib.mjs): `--name value`, `--name=value`, a bare
// `--name` is true, the last one given wins, and a script takes a flag as set when its value is
// not empty. The rules read the same flags the same way, from the words the script receives. A
// flag looked for in the text spared the question for runs the script did not read as blank
// (`--dry-run ""`, `--no-deploy --no-deploy=`, a flag inside a quoted value), and a flag no
// script reads spared it too (found while rewriting the rules, 3.3.10).

/** The flags a script reads in the words that follow its path, as its own parser reads them.
 *  Null when one of those words is not on the command line (a variable): it could be anything,
 *  a flag given again with an empty value included. */
function scriptFlags(seg, launched) {
  const list = operandsOf(words(seg.slice(launched[0].length)));
  if (list.some((w) => /[$`]/.test(w.raw.replace(/'[^']*'/g, "")))) return null;
  const argv = list.map((w) => w.value);
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return flags;
}

/** The shape of an email address, the same one the licence server and the organisation's
 *  dashboard accept. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The value `git config` is given for a key found at `key` in the segment: undefined when
 *  none (a read), null when it cannot be read from the command line (a variable, a
 *  substitution), the literal value otherwise. */
function configValue(seg, key, inner) {
  const after = operandsOf(words(seg.slice(key.index + key[0].length)));
  if (!after.length) return inner.length ? null : undefined;
  const word = after[0];
  if (/^["']?\$/.test(word.raw)) return null;
  return word.value.trim();
}

/** The management APIs the plugin's own scripts call. test-hooks.mjs checks that every one
 *  of them is here: the rule then covers what the harness knows how to operate, without
 *  being reopened provider by provider (outside review, 3.2.5). */
export const MANAGED_API_HOSTS = [
  "console.neon.tech",
  "api.vercel.com",
  "api.cloudflare.com",
  "api.github.com",
  "api.render.com",
  "api.upstash.com",
  "api.stripe.com",
  "api.brevo.com",
  "api.resend.com",
  "api.bitwarden.com",
  "api.bitwarden.eu",
  "www.googleapis.com",
];
// Where a PUT or a PATCH overwrites what exists (a project's settings, a DNS record, a
// branch): elsewhere the plugin's skills PUT to create (a site in Search Console, a sender).
const OVERWRITING_API_HOSTS = ["console.neon.tech", "api.vercel.com", "api.cloudflare.com"];

/** The registrars the plugin's skills operate (the sub-skills /add-domain hands a domain's
 *  nameservers to), and how each one says a change. A change there moves a whole domain, its
 *  site and its mail: its nameservers, or the records the registrar keeps for it. Most of them
 *  say it with the method (anything but a read); Porkbun answers every call, reads included, to
 *  a POST and names the change in its address; Namecheap takes even a change as a GET, the
 *  operation in its `Command`. These calls went unasked until 3.4.11: the check that keeps the
 *  hosts above complete read the plugin's scripts, and the registrars are called from its
 *  skills (outside review, 3.4.10). */
export const REGISTRAR_APIS = [
  { host: "api.lws.net" },
  { host: "developers.hostinger.com" },
  { host: "api.gandi.net" },
  { host: "eu.api.ovh.com" },
  { host: "ca.api.ovh.com" },
  { host: "api.us.ovhcloud.com" },
  { host: "api.hosting.ionos.com" },
  { host: "api.infomaniak.com" },
  { host: "api.porkbun.com", change: /api\.porkbun\.com\/api\/json\/v3\/(?:domain\/(?:update|create|add|delete)|dns\/(?:create|edit|delete)|[^\s"']*\$)/i },
  { host: "api.namecheap.com", change: /\bCommand=(?:["']?\$|["']?namecheap\.[a-z.]*\.(?:set|create|update|delete|renew|reactivate|transfer))/i },
];

// curl's long options that take a value, read so that the value is never taken for an option.
const CURL_LONG_VALUED = new Set([
  "request", "config", "data", "data-raw", "data-binary", "data-ascii", "data-urlencode", "json", "form", "form-string",
  "upload-file", "header", "user-agent", "referer", "output", "write-out", "user", "cookie", "cookie-jar", "url",
  "max-time", "connect-timeout", "retry", "retry-delay", "retry-max-time", "cacert", "cert", "key", "proxy", "resolve",
  "connect-to", "oauth2-bearer", "variable", "output-dir", "dump-header", "trace", "trace-ascii", "limit-rate", "range",
]);

// curl's short options that take a value, attached (`-XDELETE`) or in the next word.
const CURL_VALUED = "AbcCdDEeFHKmoPQrTtuUwXxyYz";

/** What printf prints: its format filled with its arguments, and reused while arguments remain
 *  (bounded), as the shell's printf does. */
function printfFilled(args) {
  const [format = "", ...values] = args;
  const spec = /%(%|[-+ #0-9.*]*[a-zA-Z])/g;
  const takes = [...format.matchAll(spec)].some((m) => m[1] !== "%");
  let v = 0;
  let out = "";
  for (let round = 0; round < 64; round += 1) {
    out += format.replace(spec, (m, s) => (s === "%" ? "%" : (values[v++] ?? "")));
    if (!takes || v >= values.length) break;
  }
  return escapesOf(out);
}

/** Whether all segment `k` reads on its standard input is the body of heredocs whose delimiter is
 *  quoted (`<<'EOF'`): the shell reads nothing into such a body, nor does the guard (outside review
 *  of the 3.4.14: it was read through the line's variables, a question too many). */
function fedLiterally(parts, k) {
  const part = parts[k];
  return Boolean(part?.stdin.length) && part.literal?.length === part.stdin.length && part.literal.every(Boolean);
}

/** What segment `k` reads on its standard input, when the command line says it: a heredoc,
 *  a here-string, or what the segment piped into it prints (a printf read both filled and as
 *  written). null otherwise: a file or a program is not read. */
function fedInput(parts, k) {
  const part = parts[k];
  if (!part) return null;
  if (part.stdin.length) return part.stdin.join("\n");
  if (!part.piped) return null;
  const printed = producedBy(parts, k - 1);
  if (printed === null) return null;
  const before = words(normalise(parts[k - 1].text).seg);
  if (before[0]?.value !== "printf") return printed;
  const args = operandsOf(before.slice(1)).map((w) => w.value);
  if (args[0] === "--") args.shift();
  return `${printfFilled(args)}\n${printed}`;
}

/** A text a command line prints for another command (a curl config it feeds on standard input),
 *  read as the shell hands it over: each variable the line set replaced by its values, as the shell
 *  expands them in an echo's double quotes, a printf's arguments and a heredoc's body. The text as
 *  printed comes first, then every reading of it, READINGS at most (outside review of the 3.4.13:
 *  an address built on `$CF` inside the config passed). */
function readingsOfText(text, vars) {
  if (!vars.size || !text.includes("$")) return [text];
  let acc = [""];
  let last = 0;
  for (const m of text.matchAll(variables())) {
    const name = m[1] ?? m[2];
    if (!vars.has(name)) continue;
    const before = text.slice(last, m.index);
    const next = [];
    for (const a of acc) for (const v of vars.get(name)) if (next.length < READINGS) next.push(a + before + v);
    acc = next;
    last = m.index + m[0].length;
  }
  return last ? [text, ...acc.map((a) => a + text.slice(last))] : [text];
}

/** The methods a curl config sets, one option per line as curl reads it: `request = "DELETE"`,
 *  `request: PUT`, `--request PATCH`, `-X DELETE`, grouped (`-sXDELETE`). */
function configMethods(config) {
  const out = [];
  for (const line of config.split("\n")) {
    const m =
      /^\s*(?:--)?request\b\s*[=:]?\s*["']?([A-Za-z]+)/.exec(line) ??
      /^\s*-[A-Za-z]*X\s*["']?([A-Za-z]+)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** A raw curl that destroys at a managed API (DELETE), or overwrites where that can lose
 *  data or take a site down (PUT, PATCH). Its options are read as curl reads them, grouped
 *  short ones included (`-sX DELETE`, `-sXDELETE`), and so is a config it takes on its
 *  standard input when the command line says what it is (`printf '...' | curl --config -`, a
 *  heredoc): that is how the plugin's skills give curl a key off the command line, and a
 *  method or an address can ride in it just the same (outside review, 3.3.6). A config read
 *  from a file is not read, like a script file: this guard reads commands, not files. */
function destructiveApiCall(seg, parts = [], k = -1, vars = new Map()) {
  if (!/^curl\s/.test(seg)) return false;
  const list = operandsOf(words(seg).slice(1)).map((w) => w.value);
  const methods = [];
  let configFromInput = false;
  for (let w = 0; w < list.length; w += 1) {
    const v = list[w];
    const long = /^--(request|config)(?:=(.*))?$/.exec(v);
    if (long) {
      const value = long[2] ?? list[++w] ?? "";
      if (long[1] === "request") methods.push(value);
      else if (FROM_STDIN.test(value)) configFromInput = true;
      continue;
    }
    if (!/^-[^-]/.test(v)) continue;
    for (let c = 1; c < v.length; c += 1) {
      if (!CURL_VALUED.includes(v[c])) continue;
      const value = c + 1 < v.length ? v.slice(c + 1) : (list[++w] ?? "");
      if (v[c] === "X") methods.push(value);
      if (v[c] === "K" && FROM_STDIN.test(value)) configFromInput = true;
      break;
    }
  }
  let text = seg;
  const config = configFromInput ? fedInput(parts, k) : null;
  // The config as printed, then as the shell prints it, through the variables the line set.
  for (const reading of config === null ? [] : readingsOfText(config, fedLiterally(parts, k) ? new Map() : vars)) {
    text += `\n${reading}`;
    methods.push(...configMethods(reading));
  }
  // As written anywhere on the line too, as before: reading more can only ask more.
  const written = /(?:-X|--request)[\s=]*["']?(DELETE|PATCH|PUT)\b/i.exec(text)?.[1];
  if (written) methods.push(written);
  const method = ["DELETE", "PATCH", "PUT"].find((m) => methods.some((x) => x.toUpperCase() === m));
  if (!method) return false;
  const hosts = method === "DELETE" ? MANAGED_API_HOSTS : OVERWRITING_API_HOSTS;
  return hosts.some((host) => new RegExp(`https?://${host.replace(/\./g, "\\.")}(?=[/:?"'\\s]|$)`, "i").test(text));
}

/** A raw curl that changes a domain at its registrar (REGISTRAR_APIS). Its options are read as
 *  curl reads them, like destructiveApiCall: the method it is given (`-X`, `--request`, a config
 *  on its standard input), or the one its options make (data sends a POST, unless `-G` makes it
 *  a query; `-T` uploads, a PUT). A method the command line does not show (`-X "$M"`) is taken
 *  for a change: this guard cannot read it, and the domain is too much to lose on a guess. */
function registrarChange(seg, parts = [], k = -1, vars = new Map()) {
  if (!/^curl\s/.test(seg)) return false;
  const list = operandsOf(words(seg).slice(1));
  const methods = [];
  let configFromInput = false;
  let data = false;
  let get = false;
  let upload = false;
  for (let w = 0; w < list.length; w += 1) {
    const v = list[w].value;
    const long = /^--([a-z0-9-]+)(?:=([\s\S]*))?$/.exec(v);
    if (long) {
      const name = long[1];
      const value = CURL_LONG_VALUED.has(name) ? (long[2] ?? list[++w]?.value ?? "") : null;
      if (name === "request") methods.push(value);
      else if (name === "config" && FROM_STDIN.test(value)) configFromInput = true;
      else if (/^(?:data(?:-raw|-binary|-ascii|-urlencode)?|json|form(?:-string)?)$/.test(name)) data = true;
      else if (name === "upload-file") upload = true;
      else if (name === "get") get = true;
      continue;
    }
    if (!/^-[^-]/.test(v)) continue;
    for (let c = 1; c < v.length; c += 1) {
      if (v[c] === "G") {
        get = true;
        continue;
      }
      if (!CURL_VALUED.includes(v[c])) continue;
      const value = c + 1 < v.length ? v.slice(c + 1) : (list[++w]?.value ?? "");
      if (v[c] === "X") methods.push(value);
      else if (v[c] === "K" && FROM_STDIN.test(value)) configFromInput = true;
      else if (v[c] === "d" || v[c] === "F") data = true;
      else if (v[c] === "T") upload = true;
      break;
    }
  }
  let text = seg;
  const config = configFromInput ? fedInput(parts, k) : null;
  for (const reading of config === null ? [] : readingsOfText(config, fedLiterally(parts, k) ? new Map() : vars)) {
    text += `\n${reading}`;
    methods.push(...configMethods(reading));
    if (/^\s*-?-?(?:data(?:-raw|-binary|-ascii|-urlencode)?|json|form(?:-string)?)\b/m.test(reading)) data = true;
  }
  const registrar = REGISTRAR_APIS.find(({ host }) => new RegExp(`https?://${host.replace(/\./g, "\\.")}(?=[/:?"'\\s]|$)`, "i").test(text));
  if (!registrar) return false;
  if (registrar.change) return registrar.change.test(text);
  if (methods.length) return methods.some((m) => !/^(?:GET|HEAD)$/i.test(m));
  return upload || (data && !get);
}

/** The SQL a run-sql.mjs call is about to run, read as the script reads its arguments: the
 *  first one that is neither a flag nor the value of --conn. */
function sqlOf(seg) {
  const list = operandsOf(words(seg));
  const at = list.findIndex((w) => /run-sql\.mjs$/.test(w.value));
  if (at < 0) return quotedPayloads(seg).join(" ");
  for (let a = at + 1; a < list.length; a += 1) {
    const v = list[a].value;
    if (v === "--conn") {
      a += 1;
      continue;
    }
    if (v.startsWith("--")) continue;
    return v;
  }
  return "";
}

const DENY = "deny";
const ASK = "ask";

// ── A script's path kept in a variable ──────────────────────────────────────
// `X=".../scripts/shared-worker/register.mjs"` on a line of its own, then `node "$X" --kind ping`:
// the rules on the plugin's scripts name the script a runtime launches, and a path kept in a
// variable hid it from every one of them (found while rewriting the rules, 3.3.10). It is read
// through the variable. Only what the command line itself shows, read as the shell does:
//   - an assignment that is a segment of its own (`X=...`, `export X=...`). A prefix (`X=1 cmd`)
//     sets nothing for the words of that command, which the shell expands first, nor after it;
//   - EVERY value a name was given is kept, not the last one: which one holds when the script
//     runs depends on what ran before (`false && X=...`), and a rule that asks must ask for any;
//   - a value the line does not show (a substitution's output, `read`, a loop) stays unread, as
//     before: this guard reads commands, it does not run them.
const DECLARING = /^(?:export|readonly|local|declare|typeset)$/;
const RUNTIMES = /^(?:node|bun|deno|tsx)$/;
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
/** A fresh expression for each reading, never VARIABLE itself: a shared /g expression keeps its
 *  position (lastIndex) from one reading to the next, and matchAll() starts from it. A long word
 *  read earlier on the line made the `$CF` of a config fed to curl skipped, and a DELETE at
 *  Cloudflare passed (outside review of the 3.4.14). */
const variables = () => new RegExp(VARIABLE.source, "g");
/** How many readings of one script word are judged: past it, the first ones. */
const READINGS = 16;

/** The assignments a segment makes when it is nothing else: [[name, the value as typed]]. */
function assignmentsOf(outer) {
  const list = words(outer.trim());
  if (!list.length) return [];
  let from = 0;
  if (DECLARING.test(list[0].value)) {
    from = 1;
    while (from < list.length && /^-/.test(list[from].value)) from += 1;
  }
  const out = [];
  for (const w of list.slice(from)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(w.raw);
    if (!m) return [];
    out.push([m[1], w.raw.slice(m[0].length)]);
  }
  return out;
}

/** What a word is once the shell has read it: its quotes removed, and each variable the command
 *  line set replaced by its values (one reading per value, READINGS at most). A `$` between
 *  single quotes is a character; a variable the line did not set stays as typed.
 *  `read`: whether one of those variables was found in it. */
function valuesOf(raw, vars) {
  let acc = [""];
  let read = false;
  const add = (text) => {
    acc = acc.map((a) => a + text);
  };
  // A `$name` or `${name}` at `i`, replaced when the line set it: the index after it.
  const at = variables();
  const variable = (i) => {
    at.lastIndex = i;
    const m = at.exec(raw);
    if (!m || m.index !== i) return null;
    const name = m[1] ?? m[2];
    if (vars.has(name)) {
      read = true;
      const next = [];
      for (const a of acc) for (const v of vars.get(name)) if (next.length < READINGS) next.push(a + v);
      acc = next;
    } else add(m[0]);
    return i + m[0].length;
  };
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'") {
      const close = raw.indexOf("'", i + 1);
      const stop = close < 0 ? raw.length : close;
      add(raw.slice(i + 1, stop));
      i = stop + 1;
    } else if (c === '"') {
      i += 1;
      while (i < raw.length && raw[i] !== '"') {
        const after = raw[i] === "$" ? variable(i) : null;
        if (after !== null) i = after;
        else if (raw[i] === "\\" && /[$`"\\]/.test(raw[i + 1] ?? "")) {
          add(raw[i + 1]);
          i += 2;
        } else {
          add(raw[i]);
          i += 1;
        }
      }
      i += 1;
    } else if (c === "\\") {
      add(raw[i + 1] ?? "");
      i += 2;
    } else {
      const after = c === "$" ? variable(i) : null;
      if (after !== null) i = after;
      else {
        add(c);
        i += 1;
      }
    }
  }
  return { values: acc, read };
}

/** A value as one word no shell reads anything into: between single quotes, or, when it holds
 *  one, between double quotes with what they would read escaped. */
const asWord = (value) => (value.includes("'") ? `"${value.replace(/[\\"$`]/g, "\\$&")}"` : `'${value}'`);
/** An unquoted variable alone in its word (`$C`, `${C}`): the shell splits its value into words. */
const BARE_VARIABLE = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;

/** A segment read through the variables the command line set, EVERY word of it: its readings
 *  (READINGS at most, each word written out as one word no shell reads anything into), or null
 *  when none of its words names one of them. An API's address kept in a variable
 *  (`CF="https://api.cloudflare.com/client/v4"; curl -X DELETE "$CF/zones/..."`) hid the host from
 *  the rules on raw calls, which read the curl line as typed: the call walked past them, on one
 *  line as on two (outside review of the 3.4.11). Read like a script's path since 3.3.10. */
function wordsThroughVariables(seg, vars) {
  if (!vars.size || !seg.includes("$")) return null;
  let readings = [[]];
  let read = false;
  for (const w of words(seg)) {
    const r = valuesOf(w.raw, vars);
    if (r.read) read = true;
    // An unquoted variable alone in its word becomes the words its value splits into, as the shell
    // splits it (`C="git push --force origin main"; $C`).
    const split = BARE_VARIABLE.test(w.raw);
    const forms = r.read ? r.values.map((v) => (split ? v.split(/\s+/).filter(Boolean).map(asWord).join(" ") : asWord(v))) : [w.raw];
    const next = [];
    for (const acc of readings) for (const form of forms) if (next.length < READINGS) next.push([...acc, form]);
    readings = next;
  }
  return read ? readings.map((list) => list.join(" ")) : null;
}

/** The lines a runtime's segment runs once its script's path is read through the variables the
 *  command line set, or null when its script names none of them. */
function throughVariables(seg, vars) {
  if (!vars.size || !seg.includes("$")) return null;
  const list = words(seg);
  if (list.length < 2 || !RUNTIMES.test(list[0].value)) return null;
  // The script: the first word after the runtime that is neither one of its options nor `run`.
  let at = 1;
  while (at < list.length && (/^-/.test(list[at].value) || (at === 1 && list[at].value === "run"))) at += 1;
  if (at >= list.length) return null;
  const { values, read } = valuesOf(list[at].raw, vars);
  if (!read) return null;
  return values.map((path) => [...list.slice(0, at).map((w) => w.raw), asWord(path), ...list.slice(at + 1).map((w) => w.raw)].join(" "));
}

/**
 * @param {string} command  the Bash command Claude is about to run
 * @param {Map<string, string>} [inherited]  the assignments met before a nested command line
 * @param {Map<string, Set<string>>} [vars]  the variables the command line set so far (see above)
 * @param {boolean} [carried]  the line was rewritten from a segment that carried a substitution
 * @returns {{decision: "deny"|"ask", reason: string} | null}
 */
// ── gh, read as gh reads it ──────────────────────────────────────────────────────────────────
// gh finds its command the way its command library does: a word that starts with `-` is an
// option wherever it stands, and a lone option it does not know takes the next word as its value
// unless it carries one (`--repo=x`, `-Rx`). So `gh pr -R octo/demo merge 12` is `gh pr merge`,
// and the rules read the group and the verb there, never in the text right after `gh`: until
// 3.4.9 the repository option written before the verb walked past every rule (outside review,
// 3.4.8). Two readings are kept, the option taking the next word and not taking it: a gesture
// either one finds is asked about.

/** gh's words after `gh`, a reading of the group, the verb and the operands per way of reading
 *  an option gh may not know; null when the segment is not gh. */
function ghWords(seg) {
  if (!/^gh(?:\s|$)/.test(seg)) return null;
  const { args, unread } = argumentsOf(seg);
  const rest = args.slice(1);
  const positionals = (greedy) => {
    const out = [];
    for (let i = 0; i < rest.length; i += 1) {
      const w = rest[i];
      if (w === "--") {
        out.push(...rest.slice(i + 1));
        break;
      }
      if (/^-/.test(w) && w.length > 1) {
        // `--name value` and `-n value`: the value goes with the option (gh's way of finding its
        // command); `--name=value`, `-nvalue` and a cluster carry theirs.
        if (greedy && !w.includes("=") && (/^--[^-]/.test(w) || w.length === 2) && !GH_VALUELESS.has(w)) i += 1;
        continue;
      }
      out.push(w);
    }
    return out;
  };
  return { args: rest, readings: [positionals(true), positionals(false)], unread };
}

/** The options of gh that take no value, written before a verb in the wild. */
const GH_VALUELESS = new Set(["-h", "--help"]);

/** Whether `gh <group> <verb>` is what one of the readings runs. */
function ghRuns(gh, group, verbs) {
  return gh.readings.some((p) => p[0] === group && verbs.includes(p[1]));
}

/** `gh api`, read as gh reads it: its method in every spelling gh takes (`-X DELETE`,
 *  `-XDELETE`, `-X=DELETE`, `-iX DELETE`, `--method DELETE`, `--method=DELETE`), POST when
 *  fields or an input are given without one, its endpoint without host, leading slash or query,
 *  and its fields as typed (`-f`, `-F`, `--field`, `--raw-field`). `methodUnread` when the
 *  method is not on the command line (a variable). */
const API_VALUED_SHORT = new Set(["X", "f", "F", "H", "p", "q", "t"]);
const API_VALUED_LONG = new Set(["--method", "--raw-field", "--field", "--header", "--preview", "--jq", "--template", "--input", "--hostname", "--cache"]);
function ghApi(gh) {
  if (!gh.readings.some((p) => p[0] === "api")) return null;
  const args = gh.args;
  const start = args.indexOf("api");
  let method = null;
  let methodUnread = false;
  let endpoint = null;
  let input = false;
  const fields = [];
  const take = (name, value) => {
    if (name === "-X" || name === "--method") {
      method = String(value ?? "").toUpperCase();
      if (/[$`]/.test(String(value ?? ""))) methodUnread = true;
    } else if (["-f", "-F", "--field", "--raw-field"].includes(name)) fields.push(String(value ?? ""));
    else if (name === "--input") input = true;
  };
  for (let i = start + 1; i < args.length; i += 1) {
    const w = args[i];
    if (w === "--") {
      endpoint ??= args[i + 1] ?? null;
      break;
    }
    if (/^--./.test(w)) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      let value = eq < 0 ? null : w.slice(eq + 1);
      if (value === null && API_VALUED_LONG.has(name)) {
        value = args[i + 1] ?? "";
        i += 1;
      }
      take(name, value);
      continue;
    }
    if (/^-./.test(w)) {
      // A cluster: letters that take no value (`-i`), then at most one that takes the rest of
      // the word, an `=` before it dropped, or the next word.
      for (let c = 1; c < w.length; c += 1) {
        if (!API_VALUED_SHORT.has(w[c])) continue;
        let value = w.slice(c + 1).replace(/^=/, "");
        if (value === "") {
          value = args[i + 1] ?? "";
          i += 1;
        }
        take(`-${w[c]}`, value);
        break;
      }
      continue;
    }
    endpoint ??= w;
  }
  const path = String(endpoint ?? "")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return { method: method ?? (fields.length || input ? "POST" : "GET"), methodUnread, path, fields };
}

const REPO_PATH = "repos/[^/]+/[^/]+";
/** A field that makes a repository public, or renames it. */
const exposesOrRenames = (fields) => fields.some((f) => /^visibility=public$/i.test(f) || /^private=false$/i.test(f) || /^name=./.test(f));

/** A repository created through the API, and public. GitHub makes it public unless the body says
 *  otherwise: `private` defaults to false for POST user/repos and POST orgs/{org}/repos (REST
 *  reference, version 2026-03-10, read on 12/10/2026; found by Bastien Detraz on 10/10/2026, where
 *  the rule asked only when "public" was written out). So a creation asks unless it says private:
 *  `private=true`, or, for an organisation's (the only one of the two that documents
 *  `visibility`), a visibility of private or internal. A `visibility=public` asks whatever else is
 *  said; a body sent from a file (`--input`) cannot be read here, and asks. */
function createsPublicRepo(api) {
  if (api.method !== "POST") return false;
  const where = /^(user|orgs\/[^/]+)\/repos$/.exec(api.path);
  if (!where) return false;
  const visibility = api.fields.map((f) => /^visibility=(.*)$/i.exec(f)?.[1]).filter((v) => v !== undefined).map((v) => v.toLowerCase());
  if (visibility.includes("public")) return true;
  if (where[1] !== "user" && visibility.length && visibility.every((v) => v === "private" || v === "internal")) return false;
  return !api.fields.some((f) => /^private=true$/i.test(f));
}

/** What publishes on the forge, read on `gh`'s own words: a pull request merged (on these
 *  projects the main branch is production), a deployment run again, and the same through the
 *  API (`PUT .../pulls/N/merge`, `POST .../merges`, `POST .../actions/runs/N/rerun`). */
function forgePublishes(seg) {
  const gh = ghWords(seg);
  if (!gh) return false;
  if (ghRuns(gh, "pr", ["merge"]) || ghRuns(gh, "run", ["rerun"])) return true;
  const api = ghApi(gh);
  if (!api || api.method === "GET") return false;
  if (new RegExp(`^${REPO_PATH}/pulls/[^/]+/merge$`).test(api.path)) return true;
  if (new RegExp(`^${REPO_PATH}/merges$`).test(api.path)) return true;
  return new RegExp(`^${REPO_PATH}/actions/(?:runs/[^/]+/(?:rerun|rerun-failed-jobs)|jobs/[^/]+/rerun)$`).test(api.path);
}

/** What destroys, exposes or moves something on the forge, read on `gh`'s own words: a
 *  repository deleted, renamed, made public (an edit, or a creation) or transferred, a release
 *  deleted, a secret or a variable removed, whatever the API is asked to DELETE (an access, a
 *  member, a branch, an invitation), and a repository made public or renamed through the API. A
 *  method the command line does not show (a variable) is asked about too. */
function forgeDestroys(seg) {
  const gh = ghWords(seg);
  if (!gh) return false;
  if (ghRuns(gh, "repo", ["delete", "rename"])) return true;
  if (ghRuns(gh, "release", ["delete", "delete-asset"])) return true;
  if (ghRuns(gh, "secret", ["delete", "remove"]) || ghRuns(gh, "variable", ["delete", "remove"])) return true;
  const { args } = gh;
  if (ghRuns(gh, "repo", ["edit"]) && args.some((w, i) => /^--visibility=public$/i.test(w) || (w === "--visibility" && /^public$/i.test(args[i + 1] ?? "")))) return true;
  if (ghRuns(gh, "repo", ["create"]) && args.some((w) => /^--public(?:=(?:true|t|1))?$/i.test(w))) return true;
  const api = ghApi(gh);
  if (!api) return false;
  if (api.method === "DELETE" || api.methodUnread) return true;
  if (/(?:^|\/)transfer$/.test(api.path)) return true;
  if (api.method !== "GET" && new RegExp(`^${REPO_PATH}$`).test(api.path) && exposesOrRenames(api.fields)) return true;
  return createsPublicRepo(api);
}

export function decide(command, inherited = new Map(), vars = new Map(), carried = false) {
  if (!command || typeof command !== "string") return null;

  let worst = null;
  const keep = (decision, reason) => {
    if (!worst || (worst.decision === ASK && decision === DENY)) {
      worst = { decision, reason };
    }
  };

  const parts = readCommandLine(command);
  for (let index = 0; index < parts.length; index += 1) {
    const { text: outer, inner } = parts[index];
    // A substitution in the segment: the scanner took what it runs out of the text, so the words
    // left may not be the words the command receives. No flag spares a question then.
    const substituted = carried || inner.length > 0;
    // What a substitution runs is judged first, as a command line of its own;
    // the segment is then read without it (`x=$(git push)` leaves `x=`).
    const { env, seg, unread } = normalise(outer);
    for (const [k, v] of inherited) if (!env.has(k)) env.set(k, v);
    for (const payload of inner) {
      // A substitution runs in a shell that inherits the variables set so far.
      const verdict = decide(payload, env, vars);
      if (verdict) keep(verdict.decision, verdict.reason);
    }
    // A segment that only sets variables: their values are kept for the scripts launched after
    // it. Not when a substitution wrote the value: the line does not show what it prints.
    if (!inner.length) {
      for (const [name, typed] of assignmentsOf(outer)) {
        // A value built on a variable already read is read through it (`B="$A/register.mjs"`).
        const { values } = valuesOf(typed, vars);
        if (!vars.has(name)) vars.set(name, new Set());
        for (const value of values) if (vars.get(name).size < READINGS) vars.get(name).add(value);
      }
    }
    // A brace the guard could not unfold (past BRACE_LIMIT words): what it stages or pushes
    // cannot be read, so it is asked about rather than let through (outside review, 3.3.5).
    if (unread) {
      keep(ASK, "This command unfolds its braces past what the guard reads, so what it would run cannot be told. Write the words out, or confirm with the user first.");
    }
    if (!seg) continue;

    // A runtime launching a script whose path the command line put in a variable: judged as the
    // line it runs, the path written out (every reading of it, see above). The lines are judged
    // on their own, without the variables: what is left in them is as typed.
    const written = throughVariables(seg, vars);
    if (written) {
      for (const line of written) {
        const verdict = decide(line, env, undefined, substituted);
        if (verdict) keep(verdict.decision, verdict.reason);
      }
      continue;
    }
    // Any other segment whose words the command line put in variables: judged also as the line the
    // shell runs, every reading of it, on its own. `X=push; git $X --force`, `G=git; $G push`,
    // `C="git push --force origin main"; $C` and `A=-A; git add $A` walked past every rule on the
    // words, which read the segment as typed (outside review of the 3.4.14). The segment is then
    // read as typed, as before: reading more can only ask more.
    const spelled = wordsThroughVariables(seg, vars);
    if (spelled) {
      for (const line of spelled) {
        const verdict = decide(line, env, undefined, substituted);
        if (verdict) keep(verdict.decision, verdict.reason);
      }
    }

    // `xargs` runs the command that follows its options, with what its input brings:
    // `echo main | xargs git push origin` is a push, and `echo 'git push' | xargs -I{} bash
    // -c '{}'` rebuilds the line it runs, one step further than `tee` (outside review,
    // 3.2.6). Judged as xargs would build it when the input is on the command line, and as
    // written otherwise.
    // `find -exec` runs its command for every file found: judged as written.
    if (/^find(?:\s|$)/.test(seg)) {
      const commands = findCommands(seg);
      if (commands.length) {
        for (const line of commands) {
          const verdict = decide(line, env, vars);
          if (verdict) keep(verdict.decision, verdict.reason);
        }
        continue;
      }
    }

    if (/^xargs(?:\s|$)/.test(seg)) {
      for (const line of xargsCommands(parts, index, seg)) {
        const verdict = decide(line, env, vars);
        if (verdict) keep(verdict.decision, verdict.reason);
      }
      continue;
    }

    // A shell handed a command string runs it: `sh -c "git push"` is a push,
    // `bash -lc "git add -A && git push"` is both. The payload is a command
    // line of its own and goes through the same decision, with the
    // assignments met on the way (an escape prefix is typed outside the
    // quotes, where the caller can see it).
    if (
      /^(?:sh|bash|zsh|dash|ksh|fish)\s/.test(seg) &&
      /^\S+(?:\s+-[A-Za-z-]+)*\s+-[A-Za-z]*c[A-Za-z]*\s/.test(seg)
    ) {
      for (const payload of quotedPayloads(seg)) {
        const inner = decide(payload, env, vars);
        if (inner) keep(inner.decision, inner.reason);
      }
      continue;
    }

    // A shell that reads its script from elsewhere runs it just the same: `bash <<'EOF'`
    // runs the heredoc's body, `bash <<< '...'` its word, `echo '...' | bash` what the echo
    // prints, `bash <(echo ...)` what the substitution prints. A heredoc's body is data for
    // every other command, and the scanner reads it as such; here it IS the script, and it
    // goes through the same decision (outside review, 3.2.4: once the scanner stopped
    // cutting heredoc bodies into segments, `bash <<'EOF'` then `git push` walked past).
    // Where the script cannot be read from the command line (a file, curl, a program),
    // nothing is judged: this guard reads commands, it does not run them.
    // That frontier is chosen, not missed: `bash <<< "$(echo git push)"` runs what the
    // substitution PRINTS. The substitution itself is judged (an echo, nothing to say), its
    // output is not, because it only exists at run time, like a variable expanded as a
    // command when the line does not set it (3.4.15), or a downloaded script. The scripts'
    // own checks hold beyond it (outside review, 3.2.6).
    const scripts = scriptsOf(parts, index, seg);
    if (scripts !== null) {
      for (const script of scripts) {
        const verdict = decide(script, env, vars);
        if (verdict) keep(verdict.decision, verdict.reason);
      }
      continue;
    }

    // 1. Sweeping stage. No legitimate use in a repository where another
    //    session may be working, and the alternative is one word longer.
    //    One documented exception: an operation that restructures the whole
    //    tree (monorepo conversion) after a `git status` proved nothing
    //    foreign is pending. The prefix makes that intent explicit and
    //    visible in the command itself.
    //    `git add :/` and `git add ':(top)'` are the same sweep, and from a
    //    subfolder they take MORE than the refused `.` (outside review, 3.2.4).
    //    The prefix is documented in the README and in the skills that need
    //    it, and deliberately NOT in the reason below: that text is read by
    //    the model, which is also who can type the prefix. A refusal that
    //    names its own bypass is bypassed by its reader (outside review,
    //    2.9.5). Same for the push rule.
    //    The options are read as git reads them (see "An option, as git reads it"): by a
    //    prefix, in a cluster, wherever they stand, and never when they are another option's
    //    value (`git commit -m -a` is a commit whose message is "-a").
    if (addSweeps(seg) || sweepingPathspecs(seg) || commitSweeps(seg)) {
      if (env.get("HYPERVIBE_GUARD_ALLOW_SWEEP") === "1") continue;
      keep(
        DENY,
        "Sweeping stage refused: on 2026-08-17 it swept another session's uncommitted work into a commit. Stage nominatively instead: `git add <file> [<file>...]`, then `git commit -m ...`. Check `git status --short` first if you are unsure what is pending.",
      );
      continue;
    }

    // 2a. Pushing past the pre-push hook. Since /add-test, that hook is the
    //     project's recette (tests + every feature verified): skipping it is
    //     exactly what the guard exists to prevent, and the alternative is
    //     always the same, complete the recette. No env escape here: the
    //     push rule below already has one for the cases where a push is
    //     legitimately automated, and none of them needs to skip the hook.
    //     Under every spelling git takes (`--no-veri` is `--no-verify`), and when the hooks'
    //     folder is changed for the one command (`git -c core.hooksPath=... push`).
    if (/^git\s+(-\S+\s+)*push\b/.test(seg) && (/--no-veri(?:fy?)?\b/.test(seg) || /\bcore\.hookspath\s*=/i.test(outer))) {
      keep(
        DENY,
        "Pushing past the pre-push hook (--no-verify, or a hooks folder changed for the one command) skips the project's recette (tests and cahier de recette). Run `pnpm test` and `node scripts/check-recette.mjs`, complete what they report, then push normally.",
      );
      continue;
    }

    // 2. Pushing publishes. The user's consent lives in the conversation.
    //    A dry run publishes nothing, when it is one as git reads it (see "A flag that spares
    //    a question").
    if (/^git\s+(-\S+\s+)*push\b/.test(seg) && (substituted || !pushIsDryRun(seg))) {
      if (env.get("HYPERVIBE_GUARD_ALLOW_PUSH") === "1") continue;
      keep(
        ASK,
        "A push publishes. Confirm with the user first (a standing agreement stated in chat counts).",
      );
      continue;
    }

    // 2b. The forge's command line. A merge into the main branch publishes (on these projects
    //     the main branch is production), and so does running a deployment again: the same
    //     question as a push, which the guard asked while `gh pr merge` walked past (lot 7
    //     inventory, 06/10/2026). And what destroys, exposes or moves something on the forge
    //     (forgeDestroys). Reads pass, and so do the gestures that create or write
    //     (`gh pr create`, `gh secret set`, `gh workflow run`).
    if (forgePublishes(seg)) {
      keep(
        ASK,
        "A merge into the main branch publishes (on these projects the main branch is production), and so does running a deployment again. Confirm with the user first (a standing agreement stated in chat counts).",
      );
      continue;
    }
    if (forgeDestroys(seg)) {
      keep(
        ASK,
        "This deletes, exposes or moves something on the forge (a repository, a release, a secret, an access, a branch or an invitation, a repository renamed, or code made public). Say exactly what is targeted, by name, and confirm with the user.",
      );
      continue;
    }

    // 3. Deploying straight to production, bypassing the git history.
    //    `--target production` is Vercel's own long form of `--prod`, and
    //    `vercel build --prod` builds locally and deploys nothing: not a
    //    deploy, so not a question (outside review, 3.0.4).
    if (
      /^vercel\b/.test(seg) &&
      !/^vercel\s+build\b/.test(seg) &&
      (/--prod\b/.test(seg) ||
        /--target[= ]production\b/.test(seg) ||
        /^vercel\s+(promote|rollback)\b/.test(seg))
    ) {
      keep(
        ASK,
        "Production deploys normally go through `git push` on the main branch. A direct deploy needs the user's explicit confirmation.",
      );
      continue;
    }

    // 3b. Deploying a Cloudflare worker, or writing one of its secrets. The
    //     shared clock holds account-level keys for every project (Neon,
    //     Cloudflare, email): a deploy publishes code that runs with them, a
    //     `secret put` rewrites one. The plugin's own scripts drive wrangler
    //     from Node (ensure.mjs, register.mjs), which the hook does not see and
    //     which sit behind their skills' confirmations; this covers the model
    //     reaching for wrangler directly (outside review, 2.9.5).
    //     A `--dry-run` deploys nothing, like `git push --dry-run` above, when it is one as
    //     wrangler reads it.
    if (
      /^wrangler\s+(deploy|publish|versions\s+deploy|secret\s+(put|bulk))\b/.test(seg) &&
      (substituted || !wranglerIsDryRun(seg))
    ) {
      keep(
        ASK,
        "Deploying a worker or writing one of its secrets touches code that runs with the account's keys. Confirm with the user first.",
      );
      continue;
    }

    // 4. Schema push. On this stack the local database IS production.
    //    Escape hatch, but NOT the same shape as the push and sweep ones: the
    //    hook cannot tell a throwaway database (a demo built live on stage)
    //    from production, and a prefix typed by the model in the command would
    //    let the model decide that. So this exception is read from the
    //    environment Claude Code was launched in, set by a human before the
    //    session, never from the command line (outside review, 3.1.4).
    //    Documented in the README, never in the reason below, which the model
    //    reads.
    //    The monorepo form (`pnpm --filter web db:push`, `pnpm -r db:push`) is
    //    the one _convert-to-turborepo generates: same push, same question.
    if (
      /(^|\s)(pnpm|npm|yarn)\s+(?:(?:--filter(?:=\S+|\s+\S+)|-F\s+\S+|-r|--recursive|-w|--workspace(?:=\S+|\s+\S+)?|--prefix(?:=\S+|\s+\S+)|-C\s+\S+|--dir\s+\S+)\s+)*(?:run\s+)?db:push\b/.test(seg) ||
      /drizzle-kit\s+push\b/.test(seg)
    ) {
      if (process.env.HYPERVIBE_GUARD_ALLOW_DB_PUSH === "1") continue;
      keep(
        ASK,
        "A schema push writes to the live database (on this stack the local one IS production). First run the plugin's scripts/neon/schema-drift.mjs from the folder holding drizzle.config (read-only): exit 3 lists the tables and columns the push would drop or truncate. Then confirm with the user, and make sure the change is additive or migrated.",
      );
      continue;
    }

    // 5. Cloud deletions. /delete-project already double-confirms; this covers
    //    the script being reached any other way. Only when a runtime LAUNCHES
    //    it: `cat` or `grep` on the file is a read, and asking there is the
    //    same wolf rule 6 stopped crying on 3.0.1 (outside review, 3.0.4).
    if (/^(?:node|bun|deno|tsx)\s/.test(seg) && /execute-deletions\.mjs/.test(seg)) {
      keep(
        ASK,
        "Irreversible cloud deletions (Vercel, Neon, R2, DNS, and the GitHub repository /bootstrap created for the project). This runs only inside /delete-project, after its explicit double confirmation.",
      );
      continue;
    }

    // 5b. A raw call that destroys or rewrites at a provider this plugin operates (DELETE,
    //     and PUT or PATCH where they overwrite): a project, a database branch with its data,
    //     a DNS record, a key in service. The harness has scripts for these, which check the
    //     provider's answers; a bare curl does not. First written for the database provider
    //     alone, now every management API the plugin's own scripts call (outside review,
    //     3.2.5: a Vercel project and a Cloudflare DNS record went unasked). Reads (GET) and
    //     creations (POST) pass.
    //     An address the command line put in a variable is read through it: the call is judged as
    //     typed AND as the shell will run it (outside review of the 3.4.11), the config the line
    //     feeds curl on its standard input included (outside review of the 3.4.13).
    const apiReadings = /^curl\s/.test(seg) ? [seg, ...(wordsThroughVariables(seg, vars) ?? [])] : [seg];
    if (apiReadings.some((s) => destructiveApiCall(s, parts, index, vars))) {
      keep(
        ASK,
        "This call deletes or rewrites something at a provider the plugin manages (a project, a database and its data, a DNS record, a key in service). Say exactly what is targeted, by name, and confirm with the user. Prefer the plugin's scripts, which check the provider's answers.",
      );
      continue;
    }

    // 5c. A change at a domain's registrar: its nameservers, or the records the registrar keeps
    //     for it. The whole domain moves with it, its site and its mail, and a rewrite at
    //     Cloudflare already asked (5b) while this, heavier, passed (outside review, 3.4.10).
    //     Reads pass, as each registrar says them (REGISTRAR_APIS).
    if (apiReadings.some((s) => registrarChange(s, parts, index, vars))) {
      keep(
        ASK,
        "This call changes a domain at its registrar (its nameservers, or the records the registrar keeps for it): the whole domain moves with it, its site and its mail. Say which domain and what changes, and confirm with the user.",
      );
      continue;
    }

    // 6. Destructive SQL. The hook only sees the command line, so run-sql.mjs
    //    carries the same check for SQL passed by file or heredoc.
    //    Only when a runtime LAUNCHES the script: `grep "DROP" run-sql.mjs` is
    //    a read, and it used to be refused because the segment carried the
    //    file name and a quoted keyword (outside review, 2.9.5). Exactly the
    //    wolf the note at the top of this file says to avoid.
    if (statementsDestructrices && /^(?:node|bun|deno|tsx)\s/.test(seg) && /run-sql\.mjs/.test(seg)) {
      // The SAME check as run-sql.mjs, read from the same file (scripts/db/sql-guard.mjs).
      // This rule used to keep its own expressions and to look inside the string literals the
      // script neutralises: an INSERT that logged the words 'DROP TABLE' was refused here and
      // run there, and a refusal of a harmless statement teaches the --destructif flag, the
      // one thing it must never teach (outside review, 3.2.5). test-hooks.mjs still replays
      // both, statement by statement.
      const found = statementsDestructrices(sqlOf(seg));
      const destructive = found.some((what) => !/sans WHERE/.test(what));
      const unbounded = found.some((what) => /sans WHERE/.test(what));
      // run-sql.mjs accepts both spellings of the flag; so does this rule,
      // or the alias its own usage documents is refused with a message that
      // tells the user to do what they just did (outside review, 3.0.4).
      const flagged = /--destructi(?:f|ve)\b/.test(seg);
      if (destructive && !flagged) {
        keep(
          DENY,
          `Destructive SQL refused (${found.join(", ")}), by the same check run-sql.mjs makes: outside string literals, whatever the object. If it is genuinely intended, re-run the same command with the \`--destructif\` flag, which will ask the user to confirm.`,
        );
        continue;
      }
      // The flag switches the script's own guard off, so a person confirms
      // EVERY flagged run, whatever this rule could read of the SQL: a "$SQL"
      // variable, a file or a DO block show it nothing, and "nothing seen"
      // must never mean "nothing to ask".
      if (flagged || destructive || unbounded) {
        keep(
          ASK,
          flagged
            ? "This run-sql.mjs call carries `--destructif`, which turns the script's own guard against destructive SQL off. Show the user the exact SQL about to run and the database it reaches, and confirm."
            : "This statement rewrites or removes rows without a WHERE clause, or drops an object. Confirm with the user, and consider adding a WHERE clause.",
        );
        continue;
      }
    }

    // 7. Discarding uncommitted work, possibly someone else's. Options read as git reads them,
    //    and a path that means the whole tree wherever it stands (`git checkout HEAD -- .`).
    if (resetDiscards(seg) || restoresWholeTree(seg) || cleanForces(seg)) {
      keep(
        ASK,
        "This discards uncommitted work, which may belong to another session running in the same repository. Prefer a targeted restore (`git restore <file>`), or confirm.",
      );
      continue;
    }

    // 8. Trusting a checkout's versioned git hooks. `git config
    //    hypervibe.hooks true` lets the .hooks/* of THIS clone run on this
    //    machine: code that arrived with a clone. A person decides that, per
    //    checkout. The hook's own notice reaches the model in the output of a
    //    commit, so the model must not be the one typing the opt-in (outside
    //    review, 3.1.6). Reads and the removal of the opt-in (`--unset`, or a
    //    value git reads as false) stay free.
    //    Git reads key names case-insensitively (`HYPERVIBE.HOOKS` sets the
    //    same value), so does the match; and a read is a read only when its
    //    option or subcommand comes BEFORE the key, not in a trailing comment
    //    (outside review, 3.1.8).
    const trustKey = /^git\s+config\b/.test(seg) ? /\bhypervibe\.hooks\b/i.exec(seg) : null;
    const trustRead = trustKey !== null && !substituted && configOnlyReads(seg, trustKey);
    // What is written decides: a value git reads as false withdraws the agreement, and the
    // key given alone is a read. A value that can be true asks, and so does one this hook
    // cannot read (a variable, a substitution). Outside review, 3.2.5: `false` asked,
    // although the comment above promised that the removal stays free.
    const trustValue = trustKey !== null && !trustRead ? configValue(seg, trustKey, inner) : undefined;
    const trustWrite = trustValue === null || (typeof trustValue === "string" && !/^(?:false|no|off|0|)$/i.test(trustValue));
    if (
      trustWrite ||
      (/^(?:node|bun|deno|tsx)\s/.test(seg) && /ensure-hooks-chain\.mjs/.test(seg) && /--trust\b/.test(seg))
    ) {
      keep(
        ASK,
        "Trusting this checkout's versioned git hooks means running code that arrived with a clone. A person decides that, per checkout: confirm with the user first.",
      );
      continue;
    }

    // 8b. An author address that is not an address. Every commit carries user.email in its
    //     header, and a push publishes it: on 22/09/2026 a machine's user.email held what
    //     looked like a password, and the Team licence had sent it to the server. A literal
    //     value that is not an address is refused; a variable, which this hook cannot read,
    //     is not. The refusal never repeats the value.
    const emailKey = /^git\s+config\b/.test(seg) ? /(?:^|\s)user\.email(?=\s|$)/i.exec(seg) : null;
    if (
      emailKey !== null &&
      (substituted || !configOnlyReads(seg, emailKey))
    ) {
      const address = configValue(seg, emailKey, inner);
      if (typeof address === "string" && !EMAIL_SHAPE.test(address)) {
        keep(
          DENY,
          "git's user.email must be an email address (a throwaway test repository can use `test@example.com`): it goes into the header of every commit, and a push publishes it. For a real identity, ask the user which address they sign their commits with (never a password), then set it with `git config --global user.email <address>`.",
        );
        continue;
      }
    }

    // 9. Redeploying the shared clock through one of the plugin's own
    //    scripts. ensure.mjs and worker-check.mjs end in `wrangler deploy`
    //    (rule 3b) when the worker is behind: same code, same keys, same
    //    question. Their --dry-run says whether a deploy would happen and
    //    changes nothing, so it stays free (outside review, 3.1.6), and so does
    //    --no-deploy: when the script reads the flag as set (see "The flags of
    //    the clock's own scripts"), never on the text alone.
    //    Matched on the script's name after the launcher when it comes bare:
    //    `cd scripts/shared-worker && node ensure.mjs` is the same run
    //    (outside review, 3.1.8). A path says where the script lives, and only
    //    the shared worker's folder is the clock: another project's
    //    `scripts/setup/ensure.mjs` is not (outside review, 3.1.9).
    //    `bun run` and `deno run` launch the script that follows `run`.
    const launched = /^(?:node|bun|deno|tsx)\s+(?:run\s+)?(?:-\S+\s+)*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(seg);
    const launchedPath = launched ? (launched[1] ?? launched[2] ?? launched[3]).replace(/^\.[\\/]/, "") : "";
    const launchedBase = launchedPath.split(/[\\/]/).pop();
    const sharedClock = !/[\\/]/.test(launchedPath) || /shared-worker[\\/][^\\/]+$/.test(launchedPath);
    // The flags as the script reads them; none counts in a segment that carries a substitution.
    const flags = launched && !substituted ? scriptFlags(seg, launched) : null;
    const on = (name) => flags !== null && Boolean(flags[name]);
    if (
      /^(?:ensure|worker-check)\.mjs$/.test(launchedBase) &&
      sharedClock &&
      !on("dry-run") &&
      !on("no-deploy")
    ) {
      keep(
        ASK,
        "This can redeploy the shared clock, code that runs with the account's keys. Run it with --dry-run first to see whether a deploy is needed, and confirm with the user before the real run.",
      );
      continue;
    }

    // 9 bis. The plugin's other scripts that redeploy the shared clock: register.mjs (every
    //    change of the registry ends in `wrangler deploy`, after bringing worker.js up to the
    //    plugin's version; its --rotate-secret is a `secret put`, rule 3b), migrate-live.mjs, and
    //    db-backup-remove-target.mjs from /delete-project. SECURITY.md promises a question before a
    //    worker deploy "also when one of the plugin's own scripts would do it": until 3.3.9 only
    //    the two above asked. What deploys nothing stays free, as each script reads it:
    //    register.mjs --list (it only lists, whatever else is given), and --no-deploy on
    //    register.mjs and migrate-live.mjs (the registry on this machine, nothing sent), except
    //    with --rotate-secret, which writes the secret whatever else is given. Nothing else
    //    spares the question: until 3.3.10 --dry-run did, which none of the three reads, and so
    //    did --decommission-confirme, which nothing reads at all; db-backup-remove-target.mjs
    //    has no blank run.
    const clockScript =
      (/^(?:register|migrate-live)\.mjs$/.test(launchedBase) && sharedClock) ||
      (launchedBase === "db-backup-remove-target.mjs" && (!/[\\/]/.test(launchedPath) || /delete-project[\\/][^\\/]+$/.test(launchedPath)));
    // register.mjs reads its modes in this order: --list, --remove with --name, --rotate-secret.
    const rotates = !on("list") && !(on("remove") && on("name")) && on("rotate-secret");
    const deploysNothing =
      (launchedBase === "register.mjs" && (on("list") || (on("no-deploy") && !rotates))) ||
      (launchedBase === "migrate-live.mjs" && on("no-deploy"));
    if (clockScript && !deploysNothing) {
      keep(
        ASK,
        "This redeploys the shared clock (its registry, and its code when it is behind the plugin), code that runs with the account's keys. Confirm with the user before the run.",
      );
      continue;
    }

    // 9 ter. The plugin's own OVH script (3.4.11), which signs its calls in its own process:
    //    set-nameservers moves a domain, like a raw call of rule 5c; check and nameservers only
    //    read. A verb the command line does not show asks.
    if (launchedBase === "registrar-ovh.mjs") {
      const verb = operandsOf(words(seg.slice(launched[0].length)))[0];
      if (!verb || /[$`]/.test(verb.raw) || !/^(?:check|nameservers)$/.test(verb.value)) {
        keep(
          ASK,
          "This changes a domain's nameservers at OVH: the whole domain moves with it, its site and its mail. Say which domain and which nameservers, and confirm with the user.",
        );
        continue;
      }
    }
  }

  return worst;
}
