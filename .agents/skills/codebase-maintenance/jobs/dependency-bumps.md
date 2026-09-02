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

Cross-check against Dependabot: `gh pr list --label dependencies --state open`. A dependency with an
open Dependabot PR is already tracked and must not be reported again.

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
