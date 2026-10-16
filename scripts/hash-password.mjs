#!/usr/bin/env node
// Hash a password with Node's native scrypt.
//
// Why scrypt and not bcrypt: bcrypt hashes contain `$` which breaks shell piping
// and env var handling (Vercel env add corrupts `$`-containing values). scrypt
// hashes are plain `salt:hash` hex strings, fully shell-safe.
//
// Usage:
//   Hash a password supplied via stdin (secure - never appears in `ps` / argv):
//     printf '%s' "Admin1234!" | node hash-password.mjs
//
//   Generate a random password AND hash it:
//     node hash-password.mjs --generate [--length N] [--format alphanumeric|base64url]
//
// Defaults for --generate:
//   --length   24
//   --format   alphanumeric
//
// Output:
//   - Hashing from stdin: the hash on stdout as `salt:hash` (hex:hex), no trailing newline.
//   - --generate: two lines on stdout:
//       password=<plain password>
//       hash=<salt:hash>
//     The caller is responsible for (a) feeding the `hash` to `_push-env-vars`, and
//     (b) handing the plain `password` to the person WITHOUT the conversation: never run
//     --generate where an agent reads its output. A production admin password goes through
//     admin-password.mjs, which writes it in a file of the person's downloads folder (3.4.13).
//
// Imported (3.4.13): hashPassword(password) and generatePassword({length, format}), the same
// two functions, for admin-password.mjs.
//
// Security:
//   - Never persists the plain password or the hash to disk.
//   - Never echoes the password - the caller pipes it in via stdin.
//   - scrypt parameters: 16-byte salt, keylen=64 bytes, Node defaults otherwise.

import { scryptSync, randomBytes } from "node:crypto";

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function generatePassword({ length = 24, format = "alphanumeric" } = {}) {
  if (!Number.isFinite(length) || length < 8) throw new Error(`--length must be >= 8 for passwords (got ${length})`);
  if (format === "alphanumeric") {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const maxByte = Math.floor(256 / alphabet.length) * alphabet.length;
    let out = "";
    while (out.length < length) {
      const bytes = randomBytes(length * 2);
      for (let i = 0; i < bytes.length && out.length < length; i++) {
        if (bytes[i] < maxByte) out += alphabet[bytes[i] % alphabet.length];
      }
    }
    return out;
  }
  if (format === "base64url") {
    // Generate enough bytes then slice to requested char length
    return randomBytes(length * 2).toString("base64url").slice(0, length);
  }
  throw new Error(`Unsupported --format for --generate: ${format} (use alphanumeric or base64url)`);
}

function cli(args) {
  let generate = false;
  let length = 24;
  let format = "alphanumeric";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--generate") generate = true;
    else if (args[i] === "--length" && args[i + 1]) length = parseInt(args[++i], 10);
    else if (args[i] === "--format" && args[i + 1]) format = args[++i];
    else {
      console.error(`Unknown arg: ${args[i]}`);
      process.exit(1);
    }
  }

  if (generate) {
    let password;
    try {
      password = generatePassword({ length, format });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    const hash = hashPassword(password);
    process.stdout.write(`password=${password}\nhash=${hash}\n`);
    process.exit(0);
  }

  // Read password from stdin
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk.toString();
  });
  process.stdin.on("end", () => {
    // Strip trailing newline (common when piped with `echo` or heredoc-string `<<<`)
    const password = input.replace(/\r?\n$/, "");
    if (!password) {
      console.error("No password provided on stdin");
      process.exit(1);
    }
    process.stdout.write(hashPassword(password));
  });
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
if (launchedDirectly()) cli(process.argv.slice(2));
