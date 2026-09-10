# Job: Dependency Bumps

Find dependencies that are outdated or carry known advisories, and assess what upgrading each one
would actually require.

## Ground Truth

- `pnpm outdated -r` for the version gap across every workspace package.
- `pnpm audit --json` for known advisories. Do not run `pnpm audit --fix`; it changes the tree.
- For the desktop crate, `cargo update --dry-run --manifest-path apps/desktop/src-tauri/Cargo.toml`
  for the version gap and `cargo audit` (run from `apps/desktop/src-tauri/`) for advisories. Do not
  trust `command -v cargo` alone: the toolchain lives in `~/.cargo/bin`, which non-interactive
  shells may not have on PATH. Check `ls ~/.cargo/bin/cargo` first and, if it exists,
  `export PATH="$HOME/.cargo/bin:$PATH"` before running. Only if that check comes back empty, fall
  back to comparing `Cargo.lock` against the crates.io API for the version gap, and state plainly
  that Rust advisories are UNKNOWN — the fallback has no advisory source, and an unknown must
  never read as a clean result. (The first run faced exactly this; the toolchain gap was closed on
  2026-08-26, and the first `cargo audit` immediately surfaced two high-severity advisories the
  fallback could not see. The next run then hit the PATH trap: `command -v` said "not found" with
  the toolchain installed, and the fallback would have discarded all three of its findings.)
- For each candidate, read the changelog or release notes between the installed and latest version
  and identify breaking changes concretely, rather than inferring risk from the version number.
  This step is also advisory discovery, not just risk assessment: for every outdated runtime
  dependency, check the upstream repository's own advisories
  (`gh api repos/<owner>/<repo>/security-advisories`) and read the release notes for "security".
  A clean `pnpm audit` is not evidence that a package has no advisory — it sees only the GitHub
  and npm advisory databases, and a repository-scoped advisory can be absent from both. On
  2026-09-09 `fastify` sat one patch behind four high-severity advisories with `pnpm audit`
  reporting zero at every severity and no Dependabot alert; the release notes were the only
  signal.

Cross-check against Dependabot: `gh pr list --label dependencies --state open`. A dependency with an
open Dependabot PR is already tracked and must not be reported again. The converse does not hold:
an absent Dependabot PR is not evidence that a dependency is current. Compare the open PR count per
ecosystem against `open-pull-requests-limit` in `.github/dependabot.yml`; a queue sitting at its
limit is indistinguishable from a broken updater, and the run that found the `fastify` gap found
nine outdated packages with no PR while the npm queue held exactly five.

## Gate

Rank by consequence, not by how far behind a version is:

1. security advisories, with severity and whether the vulnerable path is actually reachable from
   this repository's usage;
2. runtime dependencies with behavioral changes;
3. build and development tooling;
4. type-only and formatting-only updates.

For each, state the migration cost in specifics: which APIs changed, which files use them, whether
the change is mechanical. A major version bump with no usage of the changed APIs is low risk, and a
patch bump that alters default behavior is not.

## Known False Positives

A pinned version may be deliberate. Check for comments, `resolutions`, `overrides`, or an ADR
explaining the pin before reporting it as outdated. Peer-dependency warnings are frequently
unactionable and should not be reported as findings on their own.

## Report

Group by the ranking above. Lead with anything carrying a reachable advisory. For each: current
version, latest version, what changed, which files are affected, and the migration cost. Explicitly
list dependencies you skipped because Dependabot already covers them.
