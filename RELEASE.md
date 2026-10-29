# How a version is released

What happens between "the source changed" and "a machine installs the new
version", in the order it happens. The pipeline itself is a private script on
the maintainer's machine (it holds paths and a publication token); its steps
are not private, and this page exists so that what SECURITY.md says about
releases can be read against something. When a step changes, this page changes
in the same commit.

## The steps

1. **The recipes gate the release.** `node scripts/tests/run-all.mjs` runs every
   recipe of the plugin: the guardrail in both directions (what is refused, and
   what must go through), the managed rule blocks, the fences of the scaffolded
   agent, the claims of SECURITY.md checked against the code. A failure stops
   the release. No exception, and no release has ever shipped with one.
2. **The version is written in three manifests**: `plugin.json` (the source of
   truth), the manifest of the public marketplace, and the catalogue of the
   local marketplace the maintainer installs from. The three must agree.
3. **A changelog is generated** from the difference between the source and the
   version the platform currently serves (read from the platform, never from a
   local file), then written in French for the people who install the plugin.
4. **An archive is built** and kept in a private archive folder where every
   version stays. It carries the changelog.
5. **The public repository is a mirror.** `skills/`, `scripts/`, `templates/`,
   `hooks/` and the root files (`LICENSE`, the two READMEs, `SECURITY.md`, this
   page, `.mcp.json`, `MIGRATION.md`) are copied over it, its own manifest is
   bumped, the changelog goes at the top of `CHANGELOG.md`. A change merged on
   GitHub and not carried back into the source is overwritten by the next
   release: send patches or issues rather than pull requests, or expect the
   maintainer to port a merged one by hand.
6. **Commit and tag are signed** with the release key published in
   SECURITY.md (an SSH signature, git 2.34 and later). Without the key the
   release stops rather than shipping an unsigned tag among signed ones. The
   signatures of the tag and of the commit are verified locally, with
   `git verify-tag` and `git verify-commit`, **before** the push: a signature
   that does not verify is never pushed.
7. **Push**, then the tag's presence on the remote is checked.
8. **The platform ingests the version from the tag.** It downloads the tag's
   archive from GitHub, parses it (files, bilingual documentation, the list of
   commands), rebuilds the archive it will serve, stores that archive's
   SHA-256, and marks the version current. Every file must survive a UTF-8
   round trip, or the publication is refused: the plugin ships text only.
   Subscribers are never notified by the pipeline.
9. **The fingerprint goes to GitHub**, and GitHub is asked about the
   signature. The SHA-256 the platform computed is read back from
   `/api/plugin/current` and written in the release notes with the tagged
   commit; then the GitHub API is asked whether it holds the tag's signature
   valid (`verification.verified` with `reason: valid`). Anything else is
   reported in the release summary.
10. **What the release implies for the Enterprise harnesses** (two proprietary
    variants that share most of this code) is classified file by file and
    recorded, so that a fix made here is not silently missing there.

## What this does and does not prove

- A signed tag proves the **source tree** came from the maintainer. Anyone can
  check it without trusting GitHub's badge: the key and the command are in
  SECURITY.md.
- The archive a machine installs is **rebuilt by the platform** from that tag.
  Its fingerprint is what `/update-hypervibe` verifies, against the site that
  serves it, and what the release notes repeat. The tag does not sign that
  fingerprint: making it do so needs a reproducible build, which is future
  work, and this page will say so when it lands.
- The recipes run on the maintainer's machine, before the tag exists. Nothing
  here re-runs them on the published archive.

## Checking a release yourself

```bash
# The tag is the maintainer's (key in SECURITY.md)
git -c gpg.ssh.allowedSignersFile=allowed_signers verify-tag v<version>

# The archive you downloaded is the one the release notes describe
sha256sum hypervibe-<version>.zip
```

The release notes of every tag since v3.0.2 carry the SHA-256 of the served
archive and the SHA of the tagged commit. Tags up to v3.0.1 predate the key
and are not signed.
