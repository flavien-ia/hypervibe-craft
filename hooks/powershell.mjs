// hooks/powershell.mjs - The guard's reading of a PowerShell command line.
//
// Claude Code runs commands through a PowerShell tool on Windows, where it is the primary shell,
// and the desktop app's terminal runs a command line in the person's own PowerShell. The rules
// (rules.mjs) read POSIX shell: a `git push` reads the same in both, but a PowerShell line hides
// what it runs in ways a POSIX reading misses. This file reads the line as PowerShell runs it and
// writes out POSIX lines that run the same commands; decide() then judges them like any other
// line, and what this reading cannot follow is asked about, never let through. Checked against
// Windows PowerShell 5.1 on 25/10/2026:
// - a backslash is an ordinary character (`C:\x\scripts\db\db.mjs`), never an escape;
// - the backtick is the escape character, in a bare word as in double quotes (`` g`it push `` runs
//   git push, `` a`tb `` holds a tab), and at the end of a line it continues the line;
//   `` `u{69} `` is a character in PowerShell 7;
// - typographic quotes are quotes: `git ‘push’` is `git push`;
// - `$env:NAME`, `${env:NAME}` and a scoped `$script:x` are variables; `$x = 'push'` at the start
//   of a statement sets x, read through like `x=push`, and a value that is not written out as a
//   literal runs (`$v = git push`): it is judged as a command, and the variable keeps no value;
// - what a group runs is judged: `( )`, `$( )`, `@( )` (`a(b)` runs b), a script block `{ }`
//   (`ForEach-Object { git push }`, `if (...) { ... }`, `& { ... }`), a hashtable `@{ }`;
// - here-strings, comments (`#`, `<# #>`) and what follows `--%` are text;
// - PowerShell or cmd handed a command (`-Command`, `-c`, `-EncodedCommand`, decoded, `cmd /c`)
//   runs it, and so does Invoke-Expression: that command is read too, when the line writes it out;
// - Invoke-RestMethod and Invoke-WebRequest (and curl and wget, their aliases in Windows
//   PowerShell) are read as the curl that makes the same call (-Method, -Uri), for the rules on
//   the managed APIs;
// - Start-Process runs the program it names with its arguments: read as that command line.
// Asked about: a string run as a command that the line does not write out, commands PowerShell
// reads from its input, an encoded command that does not decode, a Start-Process whose program or
// arguments the line does not show, a program or a string run through .NET (`[Diagnostics.Process]`,
// `[ScriptBlock]::Create`), an unclosed quote, string, group or comment, a nesting deeper than
// MAX_DEPTH. A statement that starts with a string, a variable, a number or a group is an expression
// in PowerShell, its words data (`"git add -A" | Add-Content notes.txt` writes a line): never read as
// a command. Pure: no I/O, and no import of rules.mjs, which imports this file (guard-bash.mjs hands
// decide() in).

export const MAX_DEPTH = 8;

export const ASK_UNREAD =
  "This PowerShell command could not be read to the end (an unclosed quote, string, group or comment, or a nesting past what the guard reads), so what it would run cannot be told. Write it plainly, or confirm with the user first.";
export const ASK_EXPRESSION =
  "This PowerShell command runs a string as a command (Invoke-Expression) that the command line does not write out, so what it would run cannot be told. Write the command itself, or confirm with the user first.";
export const ASK_SHELL =
  "This hands PowerShell or cmd a command that the command line does not write out, so what it would run cannot be told. Write the command itself, or confirm with the user first.";
export const ASK_INPUT =
  "This starts PowerShell on commands it reads from its input, which the guard cannot read. Write the command itself, or confirm with the user first.";
export const ASK_ENCODED =
  "This PowerShell command is encoded (-EncodedCommand) and does not decode, so what it would run cannot be told. Write the command itself, or confirm with the user first.";
export const ASK_START =
  "This starts a program (Start-Process) whose name or arguments the command line does not show, so what it would run cannot be told. Write them out, or confirm with the user first.";
export const ASK_DOTNET =
  "This runs a program or a piece of code through .NET (System.Diagnostics.Process, a script block built from a string), which the guard does not read. Run the command itself, or confirm with the user first.";

/** .NET's own ways to run a program or a string as code, which no reading of the words follows. */
const DOTNET_RUNS = /Diagnostics\.Process|ProcessStartInfo|\[\s*(?:System\.Management\.Automation\.)?ScriptBlock\s*\]\s*::\s*Create|NewScriptBlock|InvokeScript|InvokeCommand\s*\.\s*Invoke/i;

const SINGLE_QUOTES = "'‘’‚‛";
const DOUBLE_QUOTES = '"“”„';
const ESCAPES = { 0: "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const BLANKS = " \t\f\v\xa0";
/** The character a decoder puts where the bytes were not text. */
const REPLACEMENT = String.fromCharCode(0xfffd);

class Unreadable extends Error {}

// ── The words, as PowerShell reads them ─────────────────────────────────────
// Items: { t: "sep", v } (a statement ends: newline, `;`, `|`, `||`, `&&`, `&`), { t: "redir", v },
// { t: "raw", v } (what follows `--%`), { t: "word", parts }. A part: { k: "lit", v }, { k: "sq", v }
// (single-quoted), { k: "dq", parts } (double-quoted, its own lit, var and group parts),
// { k: "var", name }, { k: "splat", name }, { k: "group", items } (what runs inside).

function lexer(src) {
  let i = 0;

  /** At a `$`: a variable or a subexpression, as a part, or null for a lone `$`. */
  function dollar(depth) {
    const n = src[i + 1];
    if (n === "(") {
      i += 2;
      return { k: "group", items: items(")", depth + 1) };
    }
    if (n === "{") {
      let j = i + 2;
      let name = "";
      while (j < src.length && src[j] !== "}") {
        if (src[j] === "`" && j + 1 < src.length) j += 1;
        name += src[j];
        j += 1;
      }
      if (j >= src.length) throw new Unreadable();
      i = j + 1;
      return { k: "var", name: name.replace(/^[A-Za-z]+:(?=.)/, "") };
    }
    const m = /^(?:[A-Za-z]+:)?([A-Za-z0-9_]+)|^([$^?])/.exec(src.slice(i + 1, i + 256));
    if (!m) return null;
    i += 1 + m[0].length;
    return { k: "var", name: m[1] ?? m[2] };
  }

  /** At a backtick: the character it stands for, or "" for a line continuation (a blank). */
  function escape() {
    const n = src[i + 1];
    if (n === undefined) {
      i += 1;
      return "";
    }
    if (n === "\n" || n === "\r") {
      i += n === "\r" && src[i + 2] === "\n" ? 3 : 2;
      return null;
    }
    if (Object.hasOwn(ESCAPES, n)) {
      i += 2;
      return ESCAPES[n];
    }
    const u = /^u\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 1, i + 12));
    if (u) {
      i += 1 + u[0].length;
      return String.fromCodePoint(Math.min(parseInt(u[1], 16), 0x10ffff));
    }
    i += 2;
    return n;
  }

  /** The parts of a double-quoted text up to its closer (a quote, or the end of a here-string). */
  function expandable(end, depth) {
    const parts = [];
    let text = "";
    const flush = () => {
      if (text) parts.push({ k: "lit", v: text });
      text = "";
    };
    while (i < src.length) {
      const d = src[i];
      if (end === "quote" && DOUBLE_QUOTES.includes(d)) {
        if (DOUBLE_QUOTES.includes(src[i + 1])) {
          text += d;
          i += 2;
          continue;
        }
        i += 1;
        flush();
        return parts;
      }
      if (d === "`") {
        const c = escape();
        text += c === null ? "\n" : c;
        continue;
      }
      if (d === "$") {
        const p = dollar(depth);
        if (p) {
          flush();
          parts.push(p);
          continue;
        }
      }
      text += d;
      i += 1;
    }
    if (end === "quote") throw new Unreadable();
    flush();
    return parts;
  }

  /** A here-string at `@'` or `@"`, or null when the text there is not one. */
  function hereString(depth) {
    const open = /^@(['‘’‚‛"“”„])[ \t]*\r?\n/.exec(src.slice(i, i + 64));
    if (!open) return null;
    const literal = SINGLE_QUOTES.includes(open[1]);
    const start = i + open[0].length;
    const closer = new RegExp(`\\r?\\n[ \\t]*[${literal ? SINGLE_QUOTES : DOUBLE_QUOTES}]@`, "g");
    closer.lastIndex = start - 1;
    const m = closer.exec(src);
    if (!m) throw new Unreadable();
    const body = src.slice(start, m.index);
    const after = m.index + m[0].length;
    if (literal) {
      i = after;
      return { k: "sq", v: body };
    }
    // The body is read as a double-quoted text that ends where the body ends: its own quotes are
    // characters, its backticks and `$` are read.
    const inner = lexer(body).body(depth);
    i = after;
    return { k: "dq", parts: inner };
  }

  function items(closer, depth) {
    if (depth > MAX_DEPTH) throw new Unreadable();
    const out = [];
    let word = null;
    const end = () => {
      if (word) out.push({ t: "word", parts: word });
      word = null;
    };
    const part = (p) => {
      if (!word) word = [];
      word.push(p);
    };
    const lit = (s) => {
      if (!word) word = [];
      const last = word.at(-1);
      if (last && last.k === "lit") last.v += s;
      else word.push({ k: "lit", v: s });
    };
    while (i < src.length) {
      const c = src[i];
      if (closer && c === closer) {
        end();
        i += 1;
        return out;
      }
      if (c === ")" || c === "}") throw new Unreadable();
      if (BLANKS.includes(c)) {
        end();
        i += 1;
        continue;
      }
      if (c === "\r" || c === "\n") {
        end();
        out.push({ t: "sep", v: "\n" });
        i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (c === ";" || c === "|" || c === "&") {
        end();
        const two = src[i + 1] === c && c !== ";";
        out.push({ t: "sep", v: two ? c + c : c });
        i += two ? 2 : 1;
        continue;
      }
      if (c === "#" && !word) {
        while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i += 1;
        continue;
      }
      if (c === "<" && src[i + 1] === "#" && !word) {
        const close = src.indexOf("#>", i + 2);
        if (close < 0) throw new Unreadable();
        i = close + 2;
        continue;
      }
      if (c === ">" || c === "<" || (!word && "123456*".includes(c) && src[i + 1] === ">")) {
        end();
        const m = /^[1-6*]?(?:>>?|<)(?:&[12])?/.exec(src.slice(i, i + 6));
        out.push({ t: "redir", v: m[0] });
        i += m[0].length;
        continue;
      }
      if (c === "`") {
        const s = escape();
        if (s === null) end();
        else lit(s);
        continue;
      }
      if (c === "@") {
        const here = hereString(depth);
        if (here) {
          part(here);
          continue;
        }
        if (src[i + 1] === "(" || src[i + 1] === "{") {
          const close = src[i + 1] === "(" ? ")" : "}";
          i += 2;
          part({ k: "group", items: items(close, depth + 1) });
          continue;
        }
        const splat = !word && /^@([A-Za-z0-9_]+)/.exec(src.slice(i, i + 256));
        if (splat) {
          i += splat[0].length;
          part({ k: "splat", name: splat[1] });
          continue;
        }
      }
      if (c === "(" || c === "{") {
        i += 1;
        part({ k: "group", items: items(c === "(" ? ")" : "}", depth + 1) });
        continue;
      }
      if (SINGLE_QUOTES.includes(c)) {
        i += 1;
        let v = "";
        for (;;) {
          if (i >= src.length) throw new Unreadable();
          const d = src[i];
          if (SINGLE_QUOTES.includes(d)) {
            if (SINGLE_QUOTES.includes(src[i + 1])) {
              v += d;
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          v += d;
          i += 1;
        }
        part({ k: "sq", v });
        continue;
      }
      if (DOUBLE_QUOTES.includes(c)) {
        i += 1;
        part({ k: "dq", parts: expandable("quote", depth) });
        continue;
      }
      if (c === "$") {
        const p = dollar(depth);
        if (p) {
          part(p);
          continue;
        }
      }
      // `--%`: the rest of the statement goes to the program as typed, PowerShell reads none of it.
      if (c === "-" && !word && src.startsWith("--%", i) && (i + 3 >= src.length || /\s/.test(src[i + 3]))) {
        i += 3;
        let rest = "";
        while (i < src.length && !"\r\n|".includes(src[i])) rest += src[i++];
        out.push({ t: "raw", v: rest });
        continue;
      }
      lit(c);
      i += 1;
    }
    if (closer) throw new Unreadable();
    end();
    return out;
  }

  return {
    items: () => items(null, 0),
    body: (depth) => {
      if (depth > MAX_DEPTH) throw new Unreadable();
      return expandable("end", depth);
    },
  };
}

/** A PowerShell command line as items (see above); throws Unreadable. */
function lex(src) {
  return lexer(src).items();
}

// ── What a word is ──────────────────────────────────────────────────────────

/** The text of a part when the command line writes it out, or null. */
function partValue(p) {
  if (p.k === "lit" || p.k === "sq") return p.v;
  if (p.k === "dq") {
    let v = "";
    for (const q of p.parts) {
      if (q.k !== "lit") return null;
      v += q.v;
    }
    return v;
  }
  return null;
}

/** The text a word holds when the command line writes it out, or null. */
export function wordValue(word) {
  let v = "";
  for (const p of word.parts) {
    const x = partValue(p);
    if (x === null) return null;
    v += x;
  }
  return v;
}

// ── The POSIX line that runs the same commands ──────────────────────────────

const BARE = /^[A-Za-z0-9_@%+=:,./~^*?[\]!-]+$/;

function posixName(name) {
  const n = String(name).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(n) ? `_${n}` : n || "_";
}

/** A literal text as one POSIX word: a backslash becomes a slash (a path's separator). */
function posixLiteral(text) {
  const t = text.replace(/\\/g, "/");
  if (t && BARE.test(t)) return t;
  return `'${t.replace(/'/g, "'\\''")}'`;
}

/** A literal text inside POSIX double quotes. */
function insideDouble(text) {
  return text.replace(/\\/g, "/").replace(/["$`]/g, (c) => `\\${c}`);
}

function posixPart(p, depth) {
  if (p.k === "lit" || p.k === "sq") return insideDouble(p.v);
  if (p.k === "dq") return p.parts.map((q) => posixPart(q, depth)).join("");
  if (p.k === "var" || p.k === "splat") return `\${${posixName(p.name)}}`;
  if (p.k === "group") return `$(${posixItems(p.items, depth + 1)})`;
  return "";
}

function posixWord(word, depth) {
  const v = wordValue(word);
  if (v !== null) return posixLiteral(v);
  if (word.parts.length === 1 && (word.parts[0].k === "var" || word.parts[0].k === "splat")) return `\${${posixName(word.parts[0].name)}}`;
  return `"${word.parts.map((p) => posixPart(p, depth)).join("")}"`;
}

const TYPE_LITERAL = /^(?:\[[^\]]*\])*$/;
const ASSIGNING = /^(?:\?\?|[-+*/%])?=(?!=)/;

/** `$x = <value>` (or `$env:X = `, `[int]$x = `, `$x += `) at the start of a statement: the name,
 *  whether it is a plain `=`, and the items of the value (its words and redirections), or null. */
function assignment(list) {
  const at = list.findIndex((x) => x.t === "word");
  if (at !== 0) return null;
  const first = list[0].parts;
  let k = 0;
  while (k < first.length && first[k].k === "lit" && TYPE_LITERAL.test(first[k].v)) k += 1;
  if (first[k]?.k !== "var") return null;
  const name = first[k].name;
  let rest = first.slice(k + 1);
  let after = 1;
  if (!rest.length) {
    if (list[1]?.t !== "word") return null;
    rest = list[1].parts;
    after = 2;
  }
  if (rest[0]?.k !== "lit") return null;
  const m = ASSIGNING.exec(rest[0].v);
  if (!m) return null;
  const tail = rest[0].v.slice(m[0].length);
  const parts = [...(tail ? [{ k: "lit", v: tail }] : []), ...rest.slice(1)];
  return { name, plain: m[0] === "=", value: [...(parts.length ? [{ t: "word", parts }] : []), ...list.slice(after)] };
}

/** A program's name as Windows finds it: `C:\Program Files\Git\cmd\git.exe` runs `git`. */
function programName(value) {
  if (!/[\\/]|\.(?:exe|cmd|bat|com)$/i.test(value)) return value;
  return value.replace(/^.*[\\/]/, "").replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

/** Whether a statement is a command (PowerShell's command mode) rather than an expression: its first
 *  word starts with a name, a path or a dot. A string, a variable, a number, a type or a group first
 *  makes an expression, whose words are data: in `'git push' | Set-Content x` nothing runs
 *  `git push` (what its groups run is judged still). The call operator `&` before a statement makes
 *  it a command whatever comes first (`& 'git' push`). */
function commandMode(list) {
  const first = list.find((x) => x.t === "word");
  if (!first || first !== list[0]) return false;
  const p = first.parts[0];
  if (p.k !== "lit") return false;
  return !/^(?:[0-9][0-9.]*(?:\.\.|$)|\[|-)/.test(p.v);
}

function posixRest(x, depth) {
  if (x.t === "word") return posixWord(x, depth);
  if (x.t === "redir") return x.v.startsWith("*") ? x.v.slice(1) : x.v;
  return x.v.replace(/\\/g, "/").replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, "${$1}");
}

function posixStatement(list, depth, called) {
  if (!list.length) return "";
  const a = assignment(list);
  if (a) {
    const name = posixName(a.name);
    const words = a.value.filter((x) => x.t === "word");
    const single = a.value.length === words.length && words.length <= 1 ? (words.length ? wordValue(words[0]) : "") : null;
    if (a.plain && single !== null) return `${name}=${posixLiteral(single)}`;
    return `${name}=$(${posixStatement(a.value, depth, false)})`;
  }
  if (!called && !commandMode(list)) return `: ${list.map((x) => posixRest(x, depth)).join(" ")}`;
  const head = list[0];
  const value = head.t === "word" ? wordValue(head) : null;
  const first = value !== null ? posixLiteral(programName(value)) : posixRest(head, depth);
  return [first, ...list.slice(1).map((x) => posixRest(x, depth))].join(" ");
}

/** The statements of a list of items, each with the separator that ends it. */
function statements(list) {
  const out = [];
  let current = [];
  for (const x of list) {
    if (x.t === "sep") {
      out.push({ items: current, sep: x.v });
      current = [];
    } else current.push(x);
  }
  out.push({ items: current, sep: null });
  return out;
}

function posixItems(list, depth) {
  let out = "";
  let called = false;
  for (const { items, sep } of statements(list)) {
    out += posixStatement(items, depth, called) + (sep === null ? "" : sep === "\n" ? "\n" : ` ${sep} `);
    // `&` with nothing before it is the call operator: what follows is a command.
    called = !items.length && sep === "&";
  }
  return out.trim();
}

// ── The commands that run another command ───────────────────────────────────

/** A command's name, as the rules compare it: lower case, no path, no `.exe`. */
function commandName(value) {
  return String(value ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/** The options of PowerShell's own command line that take a value. */
const PWSH_VALUED = [
  "executionpolicy", "ep", "windowstyle", "version", "psconsolefile", "inputformat", "outputformat",
  "configurationname", "configurationfile", "workingdirectory", "wd", "settingsfile", "custompipename",
  "encodedarguments", "ea",
];

/** A program's command line, read two ways, since the program parses it itself: as typed (the words
 *  joined, a shell's own syntax read from there: cmd's `^` and `%NAME%`) and word by word (each word
 *  one argument, the program by its bare name: `"C:\Program Files\Git\cmd\git.exe" push` is
 *  `git push`). Reading more can only ask more. */
export function nativeLines(values) {
  const typed = values.join(" ").replace(/\^(.)/g, "$1").replace(/\\/g, "/").replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, "${$1}");
  const byWord = [posixLiteral(programName(values[0])), ...values.slice(1).map(posixLiteral)].join(" ");
  return typed === byWord ? [typed] : [typed, byWord];
}

/** What PowerShell (or cmd) is handed to run, from its words' values (null: not written out):
 *  { lines } command lines in cmd's syntax, { ps } a PowerShell command line, { ask } a reason, or
 *  null when it runs nothing the line shows (a script file, an interactive shell). */
export function launched(values) {
  const name = commandName(values[0]);
  if (name === "cmd") {
    for (let k = 1; k < values.length; k += 1) {
      const v = values[k];
      if (v === null) return { ask: ASK_SHELL };
      const m = /^\/([ck])(.*)$/i.exec(v);
      if (m) {
        const rest = [m[2], ...values.slice(k + 1)].filter((x) => x !== "");
        if (rest.some((x) => x === null)) return { ask: ASK_SHELL };
        return rest.length ? { lines: nativeLines(rest) } : null;
      }
      if (!/^\//.test(v)) return null;
    }
    return null;
  }
  if (name !== "powershell" && name !== "pwsh") return null;
  for (let k = 1; k < values.length; k += 1) {
    const v = values[k];
    if (v === null) return { ask: ASK_SHELL };
    const opt = /^(?:--?|\/)([A-Za-z]+)(?::(.*))?$/.exec(v);
    if (!opt) {
      // A first word that is not an option: the command for Windows PowerShell, a script file for
      // PowerShell 7.
      if (name === "pwsh") return null;
      const rest = values.slice(k);
      if (rest.some((x) => x === null)) return { ask: ASK_SHELL };
      return rest.join(" ").trim() === "-" ? { ask: ASK_INPUT } : { ps: rest.join(" ") };
    }
    const o = opt[1].toLowerCase();
    if ("command".startsWith(o) || o === "commandwithargs" || o === "cwa") {
      const rest = [...(opt[2] !== undefined ? [opt[2]] : []), ...values.slice(k + 1)];
      if (rest.some((x) => x === null)) return { ask: ASK_SHELL };
      const payload = rest.join(" ");
      return payload.trim() === "-" ? { ask: ASK_INPUT } : { ps: payload };
    }
    if ("encodedcommand".startsWith(o) || o === "ec") {
      const b64 = opt[2] ?? values[k + 1];
      if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return { ask: ASK_ENCODED };
      const text = Buffer.from(b64, "base64").toString("utf16le");
      if (!text.trim() || text.includes(REPLACEMENT) || text.includes("\0")) return { ask: ASK_ENCODED };
      return { ps: text };
    }
    if ("file".startsWith(o)) return null;
    if (opt[2] === undefined && PWSH_VALUED.some((x) => x.startsWith(o))) k += 1;
  }
  return null;
}

/** The web cmdlets, by the names that reach them. */
const WEB = new Set(["invoke-restmethod", "irm", "invoke-webrequest", "iwr"]);
/** A PowerShell parameter of a web cmdlet, in the form curl's alias is given it. */
const WEB_PARAMETER = /^-(?:uri|method|custommethod|body|headers|contenttype|outfile|infile|usebasicparsing|form|websession|sessionvariable|usedefaultcredentials)$/i;
/** The parameters of the web cmdlets that take a value, so that a value is never taken for the address. */
const WEB_VALUED = [
  "body", "headers", "contenttype", "outfile", "infile", "websession", "sessionvariable", "credential",
  "useragent", "timeoutsec", "maximumredirection", "proxy", "proxycredential", "certificatethumbprint",
  "certificate", "transferencoding", "form", "token", "authentication", "maximumretrycount",
  "retryintervalsec", "sslprotocol", "httpversion", "statuscodevariable", "responseheadersvariable",
  "connectiontimeoutseconds", "operationtimeoutseconds",
];

/** The curl that makes the call a web cmdlet makes, or null when the statement is no such call. */
function webCall(values) {
  const name = commandName(values[0]);
  const alias = name === "curl" || name === "wget";
  if (!WEB.has(name) && !(alias && values.some((v) => typeof v === "string" && WEB_PARAMETER.test(v)))) return null;
  let method = "GET";
  let uri;
  for (let k = 1; k < values.length; k += 1) {
    const v = values[k];
    const opt = typeof v === "string" ? /^-([A-Za-z]+)(?::(.*))?$/.exec(v) : null;
    if (!opt) {
      if (uri === undefined) uri = v;
      continue;
    }
    const o = opt[1].toLowerCase();
    const value = opt[2] !== undefined ? opt[2] : values[k + 1];
    const takes = opt[2] === undefined;
    if ((o.length >= 2 && "method".startsWith(o)) || o === "custommethod") {
      method = value;
      if (takes) k += 1;
    } else if (o === "uri" || o === "ur") {
      uri = value;
      if (takes) k += 1;
    } else if (WEB_VALUED.some((x) => x === o || (o.length >= 3 && x.startsWith(o)))) {
      if (takes) k += 1;
    }
  }
  const quote = (x, variable) => (typeof x === "string" ? posixLiteral(x) : `"\${${variable}}"`);
  return `curl -X ${quote(method, "METHOD")} ${quote(uri ?? null, "URI")}`;
}

/** The parameters of Start-Process that take a value, besides the program and its arguments. */
const START_VALUED = ["workingdirectory", "verb", "windowstyle", "redirectstandardinput", "redirectstandardoutput", "redirectstandarderror", "credential", "environment"];

/** The command lines Start-Process runs ({ lines }, see nativeLines) or a reason to ask ({ ask }), or
 *  null when the statement is not one. */
function startProcess(values) {
  const name = commandName(values[0]);
  if (name !== "start-process" && name !== "saps" && name !== "start") return null;
  let file;
  let args;
  const positional = [];
  for (let k = 1; k < values.length; k += 1) {
    const v = values[k];
    const opt = typeof v === "string" ? /^-([A-Za-z]+)(?::(.*))?$/.exec(v) : null;
    if (!opt) {
      positional.push(v);
      continue;
    }
    const o = opt[1].toLowerCase();
    const value = opt[2] !== undefined ? opt[2] : values[k + 1];
    const takes = opt[2] === undefined;
    if ("filepath".startsWith(o) || o === "path" || o === "pspath" || o === "lp") {
      file = value;
      if (takes) k += 1;
    } else if ((o.length >= 1 && "argumentlist".startsWith(o)) || o === "args") {
      args = value;
      if (takes) k += 1;
    } else if (START_VALUED.some((x) => x === o || (o.length >= 3 && x.startsWith(o)))) {
      if (takes) k += 1;
    }
  }
  if (file === undefined) file = positional.shift();
  if (args === undefined && positional.length) args = positional.shift();
  if (file === undefined || file === null || args === null || positional.includes(null)) return { ask: ASK_START };
  const list = typeof args === "string" ? args.split(",").map((x) => x.trim()).filter(Boolean) : [];
  return { lines: nativeLines([file, ...list]) };
}

/** What a list of items runs beyond its own words: { lines, asks }, gathered in `out`. */
function launches(list, depth, out) {
  const all = statements(list);
  for (let s = 0; s < all.length; s += 1) {
    const words = all[s].items.filter((x) => x.t === "word");
    for (const w of words) for (const p of w.parts) visitGroups(p, depth, out);
    if (!words.length) continue;
    // The call operator `&` is a separator in the items: the statement starts after it.
    const values = words.map(wordValue);
    const name = commandName(values[0]);
    if (name === "iex" || name === "invoke-expression") {
      const rest = values.slice(1).filter((v, k) => !(k === 0 && typeof v === "string" && /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(v)));
      if (rest.length === 1 && typeof rest[0] === "string") read(rest[0], depth + 1, out);
      else out.asks.add(ASK_EXPRESSION);
      continue;
    }
    const shell = launched(values);
    if (shell?.ask) out.asks.add(shell.ask);
    else if (shell?.ps !== undefined) read(shell.ps, depth + 1, out);
    else if (shell?.lines) out.lines.push(...shell.lines);
    const web = webCall(values);
    if (web) out.lines.push(web);
    // The program Start-Process runs gets its command line as a program does: read as one.
    const start = startProcess(values);
    if (start?.ask) out.asks.add(start.ask);
    else if (start?.lines) out.lines.push(...start.lines);
  }
}

function visitGroups(p, depth, out) {
  if (p.k === "group") launches(p.items, depth + 1, out);
  else if (p.k === "dq") for (const q of p.parts) visitGroups(q, depth, out);
}

function read(text, depth, out) {
  if (depth > MAX_DEPTH) {
    out.asks.add(ASK_UNREAD);
    return;
  }
  let list;
  try {
    list = lex(String(text));
  } catch (e) {
    if (!(e instanceof Unreadable) && !(e instanceof RangeError)) throw e;
    out.asks.add(ASK_UNREAD);
    return;
  }
  out.lines.push(posixItems(list, depth));
  launches(list, depth, out);
  if (DOTNET_RUNS.test(text)) out.asks.add(ASK_DOTNET);
}

/** A PowerShell command line read as PowerShell runs it: the POSIX lines that run the same commands
 *  (`lines`, the line itself first) and the reasons to ask that this reading met (`asks`). */
export function readPowerShell(command) {
  const out = { lines: [], asks: new Set() };
  read(String(command ?? ""), 0, out);
  return { lines: out.lines, asks: [...out.asks] };
}

/** The guard's verdict on a PowerShell command line: the worst of decide() on every line this reading
 *  writes out, and of what it asks about; a refusal outranks a question. With `posix`, the line is
 *  also judged as a POSIX shell reads it: for a terminal whose shell may be either (the desktop app's
 *  terminal runs PowerShell on Windows, a login shell over SSH). Never for PowerShell alone: read as
 *  POSIX, `"git add -A" | Add-Content notes.txt`, which writes a line of text, is a sweeping stage. */
export function decidePowerShell(command, decide, { posix = false } = {}) {
  let worst = null;
  const keep = (v) => {
    if (v && (!worst || (worst.decision === "ask" && v.decision === "deny"))) worst = { decision: v.decision, reason: v.reason };
  };
  if (posix) keep(decide(command));
  const { lines, asks } = readPowerShell(command);
  for (const line of lines) keep(decide(line));
  for (const reason of asks) keep({ decision: "ask", reason });
  return worst;
}
