# Security

Hypervibe is a set of skills and scripts that an AI agent loads on its own and
runs with your permissions. That is worth being explicit about, because it is a
category with a real attack surface: OWASP published the
[Agentic Skills Top 10](https://owasp.org/www-project-agentic-skills-top-10/)
v1.0 in August 2026, after a campaign that pushed over a thousand malicious
skills reporting to a single command-and-control address.

This page says what this plugin is, what it refuses to do, and how to check that
what you installed is what was published.

## What the plugin is made of

- **Text only, and that is enforced at publication.** Every file is Markdown,
  JavaScript or a template. The publishing pipeline round-trips each file
  through UTF-8 and **refuses the release** if any file is binary, rather than
  shipping something nobody can read.
- **No `package.json`, so no dependencies and no install script.** Adding the
  plugin puts text files on disk and nothing else: nothing is fetched, nothing
  runs, no `postinstall` fires. The scripts use the Node standard library and
  command-line tools that live outside the plugin. Putting those tools on the
  machine is a separate and visible step, described in the next section.
- **The plugin never grants itself permissions.** It writes nothing to your
  `settings.json`, so it cannot widen what the assistant is allowed to do:
  skills run with the tools your session already allows, and every shell
  command they run still goes through the guardrail below.
- **One MCP server, [context7](https://context7.com), over HTTP.** It serves
  library documentation. Nothing is installed locally to reach it, and its
  answers are treated like any other external content (see below).

## What `/start` installs

The plugin installs nothing on its own. Its first command, `/start`, does: it
prepares the machine so that everything else works. That is where Hypervibe
touches your system the most, so here is the whole list.

Installed **without asking**, because nothing works without them:

- **Node.js, Git and pnpm**, through your system package manager (winget on
  Windows, Homebrew on macOS, itself installed from its official script if
  missing). On Windows, winget is downloaded from the `microsoft/winget-cli`
  releases when absent.
- **gitleaks** (about 10 MB, from the project's GitHub releases, checked
  against the `checksums.txt` of the same release before it is installed),
  plus a global git hook and a `~/.gitleaks.toml`. It scans every commit, in
  every repository on the machine, and blocks one that carries a secret.
- **The Bitwarden CLI**, for the key vault. On macOS through Homebrew, which
  verifies what it installs. Elsewhere `vault.bitwarden.com` only redirects to
  the GitHub release of `bitwarden/clients`, which publishes no checksum: the
  installer resolves that redirect itself, refuses any target outside the
  official release, and records the version it names. That proves where the
  file came from, not that it is intact.

Those change two system settings: your user `PATH`, so the tools are findable
(never through `setx PATH`, which corrupts it), and `git config --global
core.hooksPath`, to wire the secret scan.

Installed **only after you agree**: the GitHub, Vercel and Cloudflare CLIs.
`/start` shows the list and waits for an answer. Later, if you connect a
Cloudflare account, it also provisions one shared scheduled worker on it.

**What that shared worker holds.** One worker per account carries the
scheduled jobs of every project (crons, database backups, quota watch): a
single cron slot, one registry under version control in `~/.hypervibe-jobs/`,
one place to rotate. To do that job it holds account-level keys, not
project-level ones: the Neon API key, the Cloudflare token, the email key, and
one `CRON_SECRET` per project. The blast radius of that folder leaking is
therefore every project on the account. It lives in your home directory,
outside any repository, and the gitleaks hook covers it like the rest; its own
control plane answers only to a bearer token and discloses nothing without it.

None of this is hidden: every command runs in front of you in the chat, and you
can stop at any point.

## Guardrails

Irreversible operations are guarded mechanically, not merely discouraged in
prose. A `PreToolUse` hook, on `Bash` and on `Monitor` (the other tool that
runs shell commands), refuses a sweeping `git add -A` and destructive SQL, and
asks for your confirmation before a push, a direct production deploy, a worker
deploy (also when one of the plugin's own scripts would do it), a schema push,
cloud deletions, a change of a domain at its registrar (its nameservers, or the
records the registrar keeps), the revocation of a project's own sending key by
the plugin's script (`email-key.mjs revoke`), a hard reset, or the opt-in that
lets a checkout's versioned git hooks run. It asks the same on the forge's command line: before a merge
into the main branch or a deployment run again (both publish), and before what
deletes, exposes or moves something there (a repository deleted, renamed, created
or made public, or transferred, a release or a secret removed, an access deleted), however
gh is told to: the repository option before the verb, or the same gesture through
its API. The rules never see the
raw head of a command: `sudo`, `command`, `env`, `time`, a launcher (`npx`,
`pnpm dlx`), a version pin, an absolute path, a subshell or a `sh -c` payload
are stripped or unfolded first, so a shape the rules did not foresee does not
hide what they forbid. A function's body is read like a block, whether the
function is written over several lines or on one (`f() { git push; }; f`,
`function f { ... }`), called or not (outside review, 3.4.13). `xargs` is
unfolded too, with the line it rebuilds from
its input when that input is on the command line, and so are `find -exec`,
`timeout`, `stdbuf`, `caffeinate`, and macOS's `arch`, `xcrun`, `taskpolicy`,
`sandbox-exec` and `script`. A launcher's options are read the way the tool
reads them: a long option by its prefix, its value after `=` or in the next
word, and `env -S` hands over a whole command (outside review, 3.3.2). Braces
are expanded as the shell expands them before anything runs: `git add {.,.}`
is `git add . .` (outside review, 3.3.4). Each word is kept once, so `.{,}`
repeated is `.` again, and a command whose braces unfold past what the guard
reads is asked about rather than let through (outside review, 3.3.5).
A script's path kept in a variable is read through it when the command line
itself sets that variable (`X=".../register.mjs"`, then `node "$X" --kind ping`):
the rules on the plugin's scripts see the script that runs, under every value
the line gave the variable. An API's address kept in a variable is read through it
the same way (`CF="https://api.cloudflare.com/client/v4"`, then
`curl -X DELETE "$CF/zones/..."`), on one line or two (outside review, 3.4.11),
and inside a config curl reads from its standard input too
(`echo "url = \"$CF/zones/...\"" | curl -K -`, outside review, 3.4.13).
A command's own words kept in a variable the line sets are read as the shell
spells them out: `G=git; $G push --force origin main` is a push, and
`A=-A; git add $A` is `git add -A` (outside review, 3.4.14).
The body of a heredoc whose delimiter is quoted (`<<'EOF'`) is read as written,
as the shell hands it over: it replaces no variable there (outside review, 3.4.14).
A flag that spares a question (a dry run)
spares it only when the command reads it as that flag: a word of its own, not
inside a quoted value, not taken as the value of the option before it, not
switched off further on (`git push --dry-run --no-dry-run` is a push), and never
next to a substitution. On the clock's own scripts a flag counts when the script
reads it as set, and one it does not read spares nothing
(`register.mjs --dry-run` asks).
A word is read as the shell hands it over, whatever its quotes or backslashes
(`git "push"`, `git add \-A`, `git $'push'`), and git's own options the way git
reads them: by any unambiguous prefix (`--al` is `--all`, `--har` is `--hard`),
wherever they stand among the options (`git reset HEAD~1 --hard`,
`git commit -m x -a`).
The full table is in the README.

Two properties matter here:

- **Fail-open.** The hook runs before every shell command. If it ever fails, it
  lets the command through and says so on stderr: a seatbelt, not an airlock.
  It loads its rules inside that net: a file missing beside it leaves the other
  rules in force and names the one that is off.
- **The scripts carry their own checks.** A hook only sees a command line, so
  `run-sql.mjs` refuses `DROP`/`TRUNCATE` without `--destructif`, and
  `execute-deletions.mjs` requires the project name typed again. On a host
  without hooks (Codex included) those checks still refuse by default; but the
  `--destructif` flag that lifts the refusal is confirmed by a human only where
  the hook exists. Without a hook, passing the flag runs the statement: treat
  the flag as the confirmation, because nothing else will ask.

One frontier is chosen, not missed: the hook judges what a command line shows,
substitutions included, not what they will print. `bash <<< "$(...)"`, a variable
expanded as a command when the line does not set it, a downloaded script run as
it arrives: these commands only exist at run time, and the scripts' own checks
are what hold there.

Both directions are tested (`node hooks/test-hooks.mjs`): that a forbidden
command is refused, **and** that a legitimate one goes through. A guardrail that
blocks everything looks exactly like one that works.

## External content is data

Skills fetch documentation, API responses and web pages. All of it is treated as
material to analyse, never as instructions to follow, whoever it claims to come
from. Fetched content never triggers a command, an install, an email, a database
write, or an edit to `CLAUDE.md`, hooks or settings. An MCP server has no
privileged status: it returns third-party content like any other fetch. When an
injection attempt is detected, the rule is to stop and show you the source and
the excerpt, not to handle it silently.

The same applies to what the plugin **generates**. An agent scaffolded through
`/add-automation` reads untrusted content, holds private data and can send things
out, which is precisely the combination indirect prompt injection needs. So:

- it may only email addresses in `AGENT_MAIL_ALLOWLIST` (empty by default: it
  sends nothing until you decide who it may write to);
- it may only POST/PUT to hosts in `AGENT_FETCH_WRITE_HOSTS` (empty by default:
  it reads anything, writes nowhere); towards every other host the URL itself
  is bounded in length, because a long `GET ?d=...` carries data out as well as
  a POST does;
- redirects are resolved one hop at a time and each target goes through the
  same SSRF guard as the first URL (a `302` towards a private address is the
  classic way around a check that only looked at the starting point), and a
  redirected write is never followed;
- fetched bodies come back wrapped in a marker drawn at random for that call, so
  the model can tell the frame from the payload, and a page written earlier
  cannot forge the frame.

The allowlists come first and the framing second, on purpose: framing
(*spotlighting*) sharply reduces injection success but does not eliminate it.

## Secrets

Global keys live in a Bitwarden vault, and are typed into an OS window that the
assistant never sees. They are never printed in the chat, never committed, never
written to a file. Project secrets stay in the project's `.env` and in Vercel.
The email account's key is a global key that never goes into a project: each
project holds a sending key of its own (made by Resend's API, limited to
sending, and to the project's domain once verified; made by hand at Brevo,
under the project's name), so one `.env` seen or leaked exposes that project's
sending, never the whole account. Until 3.4.16 `/add-email` copied the
account's key into every project.
A secret the plugin writes or sends (a generated key, a key typed into the
masked window, a connection string, the key an API call carries) goes from
command to command on the standard input: never on a command line, where
anything running on the machine can read it, and never through the
conversation. curl gets its key as a config line on its standard input
(`printf 'header = ...' | curl --config -`), and the Vercel CLI of a workflow
from its environment. Until 3.3.3 four setup scripts, the OpenRouter key and a
few skills broke that line; until 3.3.5 two scripts still handed the Cloudflare
token to curl as an argument, and until 3.3.6 the skills' own commands did the
same through a shell variable, which the shell expands before curl starts. A
recette now reads every command the plugin ships (skills, scripts, templates),
shell variables included.
A global git hook (gitleaks, installed by `/start`) blocks any commit containing
a detected secret. The same global hooks can hand over to a repository's own
`.hooks/pre-commit` and `.hooks/pre-push` (that is how the recette installed by
`/add-test` runs before every push), but only in a checkout that opted in:
`git config hypervibe.hooks true`, a local value that `/add-test` sets and that
a clone never carries. Git does not version its hooks precisely so that cloning
a repository can never execute code, and a chain that ran any repository's
versioned hooks had reopened that door on every machine set up by `/start`
(3.1.0 to 3.1.4, reported privately by an outside reader). Since 3.1.5 a clone
that ships hooks is announced on stderr at its first commit or push, never run,
and `/start`, `/add-test` and `/update-hypervibe` all replace the older block on
an existing machine.

An unlocked vault stays open six hours, and then it is really locked: `bw lock`
runs with the session in its environment, never on its command line, and the
session's file is removed, so a token copied in the meantime stops opening the
vault. The lock is scheduled at the unlock in the system's own scheduler (a
one-time task on Windows, caught up at the next sign-in; a launchd agent on
macOS; systemd-run or at on Linux), the first read after the six hours does it
too, and so does the start of a Claude Code session, for a computer that was
off at that time. A lock only ends the session it was made for, never a newer
one. Outside Windows, the session's file is readable by its owner alone (0600). Until 3.4.16 the session lasted twelve hours and only the plugin's scripts
refused an older one: nothing ran `bw lock`, and the token kept opening the
vault to any program of the machine until the next unlock (security audit of
23/10/2026).

## Verifying what you installed

Each published version has a SHA-256 fingerprint, shown on the download page and
attached to the corresponding GitHub release. `/update-hypervibe` computes the
hash of what it downloaded and **refuses to install** on a mismatch.

Its limit, stated plainly: a fingerprint published by the same site that serves
the file proves the transfer was intact, not that the site is honest. The GitHub
release is the second channel; compare the two if it matters to you. The source
is public at
[flavien-ia/hypervibe-harness](https://github.com/flavien-ia/hypervibe-harness)
under Apache 2.0.

**Signed releases.** A second channel is only independent if it cannot be forged
by whoever holds the first one, so every release tag, and every commit, pushed
to the public repository since September 2026 is signed with a dedicated SSH key
(SSH signatures, supported by git 2.34 and later, shown as "Verified" on GitHub).
Tags up to `v3.0.1` predate the key and carry no signature. The public key:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAqVH7FUXHPiorT/puz89VLIE9MvFuYIINFqIBG+erLm hypervibe-release-signing
```

Fingerprint `SHA256:qWsAcOEF4w8wq59032/C2WI7fcd419uOrz4ZD3/Trrc`. To check a tag yourself,
without relying on GitHub's badge:

```bash
echo 'flavien@chervet.fr namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAqVH7FUXHPiorT/puz89VLIE9MvFuYIINFqIBG+erLm' > allowed_signers
git -c gpg.ssh.allowedSignersFile=allowed_signers verify-tag v<version>
```

A tag that fails this check, or a new tag without a signature, is not a release
of ours, whatever the repository says. What the signature covers is the source
tree: the archive served by hypervibe.fr is rebuilt from that tag, and its
fingerprint lives in the release notes, which the tag does not sign. Should the
key ever be replaced, the new one will be announced here with the old one kept
alongside it, so that older tags stay verifiable. The release procedure itself
(what runs before a tag exists, what is verified before the push, how the
fingerprint is produced) is written down in [RELEASE.md](RELEASE.md): the
pipeline is a private script, its steps are not.

## Reporting a vulnerability

Write to **contact@hypervibe.fr** rather than opening a public issue. Include what
you did, what happened, and the version (`.claude-plugin/plugin.json`). You will
get an answer.
