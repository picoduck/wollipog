# Releasing

Desktop bundles are built by CI, not by hand. The [`Release`](../.github/workflows/release.yml)
workflow builds the per-platform control-plane and local-runner **sidecars** plus the **Tauri bundle** on a native
runner for each OS/arch, then uploads them all to a single **draft** GitHub release.

Why native runners (and not one cross-build machine): the sidecar is a Node Single-Executable
that **embeds the host's Node runtime**, so it can't be cross-compiled —
[`build-sidecar.mjs`](../apps/desktop/scripts/build-sidecar.mjs) refuses a build whose arch differs
from the host. Each target therefore builds on a matching runner.

| Runner            | Target triple                | Bundles                     |
| ----------------- | ---------------------------- | --------------------------- |
| `macos-14`        | `aarch64-apple-darwin`       | `.dmg`, `.app.tar.gz`       |
| `macos-15-intel`  | `x86_64-apple-darwin`        | `.dmg`, `.app.tar.gz`       |
| `windows-latest`  | `x86_64-pc-windows-msvc`     | `.msi`, NSIS `.exe`         |
| `windows-11-arm`  | `aarch64-pc-windows-msvc`    | `.msi`, NSIS `.exe`         |
| `ubuntu-22.04`    | `x86_64-unknown-linux-gnu`   | `.deb`, `.rpm`, `.AppImage` |
| `ubuntu-22.04-arm`| `aarch64-unknown-linux-gnu`  | `.deb`, `.rpm`, `.AppImage` |

These six triples are the exhaustive supported native release set, not examples. A standalone
`pnpm --filter @wollipog/runner build:binary` invocation may set `TARGET_TRIPLE` only to one of
these six values, and the desktop sidecar accepts the same closed set through
`TAURI_ENV_TARGET_TRIPLE`. Both producers reject an unsupported triple or a supported triple built
on the wrong OS/architecture because a Node SEA embeds its build host's runtime.

Each desktop bundle contains the matching local-runner sidecar for one-click setup. Each matrix job
also builds a **standalone runner binary** as `wollipog-runner-<triple>[.exe]` (a Node SEA via
[`apps/runner/scripts/build-binary.mjs`](../apps/runner/scripts/build-binary.mjs)), then copies those
finished bytes to the compatible `agent-manager-runner-<triple>[.exe]` alias. Injection and macOS
signing happen only once, before the copy, so each pair is byte-identical. Both names run `--version`
natively before upload.

After all six native jobs finish, a verification job downloads the 12 published runner assets,
requires all six pairs to have identical SHA-256 digests, and uploads a lexically sorted
`SHA256SUMS` covering both names. It then compares that manifest with GitHub's recorded asset
digests and requires exactly 27 release assets: 14 desktop bundles, 12 runner names, and the
manifest. A missing, extra, empty, malformed, or mismatched runner asset fails the release workflow.
Because GitHub's release-by-tag endpoint does not expose drafts, this final gate resolves exactly one
draft from the paginated release collection, fetches every page of its asset endpoint by immutable
numeric release ID, and retries both transient API errors and not-yet-converged verification
failures under strict shell. It also verifies the non-empty `SHA256SUMS` asset's publisher digest
against the exact local manifest bytes before accepting any checksum entry.
Consumers prefer the canonical name and retain the legacy fallback for rollback. This asset rename
does not change the SSH-managed remote executable path (`~/.agent-manager/agent-manager-runner`) or
the runner's durable `~/.agent-manager` data root. Standalone installers use canonical local paths
and maintain a legacy executable alias as described in the runner update guide.

The control plane and both standalone runner installers verify GitHub's release-asset SHA-256
before cache or install promotion. The POSIX installer uses the platform's SHA-256 utility and
retains dependency-free atomic staging; `SHA256SUMS` is an additional dual-publish and
release-inventory artifact rather than a prerequisite for secure installation. When the manifest is
present, the POSIX installer binds both downloads to the same resolved tag, requires one exact entry
for the selected asset, and cross-checks it before atomic promotion; its authenticated path applies
the same rules through `gh`. This keeps v0.15.0 and other publisher-digest-verified pre-manifest
releases installable. A successful legacy fallback emits the same value-free migration warning and
records a release-scoped marker under the existing config directory, so reinstalling one release
stays quiet while the first fallback from a later release warns again. Canonical selection is
silent, and the long-running control-plane path persists its own release-scoped marker. The
evidence required before deleting fallback support is defined in
[Legacy Asset Removal Gate](./runner-updates.md#legacy-asset-removal-gate).

Bundles are currently **unsigned** (first launch shows an "unidentified developer" warning).
Signing/notarization slots are stubbed in the workflow `env:` for later.

## One-line install

End users install via the scripts in [`scripts/`](../scripts) (documented in the README's
"Install (prebuilt)" section): `install.sh` / `install.ps1` for the desktop app and
`install-runner.sh` / `install-runner.ps1` for the runner. They resolve assets from the GitHub
API's **latest published** release, so they only work once a release is **published** (not while
it is still a draft), and the runner one-liners need a release built **after** the runner-binary
step landed (v0.4.0 shipped app bundles only).

Public one-liners cannot read a script from a private repository. For private installs, authenticate
GitHub CLI (`gh auth login`, or `GH_TOKEN` with `Contents: read`), clone the repository with
`gh repo clone`, and run the appropriate script locally. If the unauthenticated release API returns
401/404, all four installers automatically fall back to authenticated GitHub CLI operations. Both
runner installers use raw `gh api` release metadata so GitHub's publisher digest survives;
desktop installer metadata paths use `gh release view`, and asset bytes use `gh release download`.
This keeps credentials in GitHub CLI instead of placing tokens in shell history or download URLs.

Each release matrix leg resolves the matching draft-or-published release ID, reads its uploaded
runner back from raw REST metadata, requires a full `sha256:` publisher digest, and compares that
digest with the locally built bytes. The lookup and digest check retry briefly while GitHub
finalizes release metadata, then fail the release rather than publishing a runner whose
compatibility consumers cannot verify.

## Keep the version in sync

The release version lives in the places below. **All six are gated** before matrix builds start.
The control-plane value pins remote runner resolution to the packaged app's matching release; the
runner value is reported via `--version`, register metadata, and the startup log.

| File                                          | Field         | Gated by preflight? |
| --------------------------------------------- | ------------- | ------------------- |
| `apps/desktop/src-tauri/tauri.conf.json`      | `version`     | yes |
| `apps/desktop/src-tauri/Cargo.toml`           | `package.version` (also updates `Cargo.lock`) | yes |
| `apps/desktop/package.json`                   | `version`     | yes |
| `package.json` (repo root)                    | `version`     | yes |
| `apps/control-plane/src/release-version.ts`   | `APP_RELEASE_VERSION` | yes |
| `apps/runner/src/version.ts`                  | `VERSION` | yes |

Bump all of them to the same `X.Y.Z`, commit, then tag `vX.Y.Z` (the leading `v` is what the
workflow triggers on, and `X.Y.Z` must equal the `tauri.conf.json` version). A `preflight` job
strips the leading `v` and compares it against all six fields, failing the whole run before any
matrix build if they disagree. The resolved tag is also compiled into the control-plane sidecar,
including the unique tag used by a manual test release.

## Cut a release

```bash
# 1. Bump the six version fields above to the new X.Y.Z, commit, merge to main.
# 2. Tag the release commit and push the tag:
git tag vX.Y.Z
git push origin vX.Y.Z
```

The push triggers the workflow. When all six matrix jobs and the final runner-release verification are green, open the draft release on
GitHub, replace the generic draft body with release notes, review upgrade behavior and known
limitations, sanity-check the exact 27-asset inventory and `SHA256SUMS`, and **Publish**. A pre-release suffix (`vX.Y.Z-rc.1`) is marked
as a GitHub pre-release automatically.

## Test build without tagging

Actions → **Release** → **Run workflow**, and pick the branch (or tag) to build from the ref
dropdown. A branch run produces a unique throwaway draft tagged `v0.0.0-test.<run-number>` (so
repeated runs never collide), built from that branch's HEAD — delete it afterward. Nothing is
published. (Selecting a real tag instead runs the same version-checked path as a tag push.)

## Companion CI

Hosted checks do not run while a pull request is a draft. Move the pull request to **Ready for
Review** only after implementation and local review are complete so the final PR state consumes one
runner cycle instead of one cycle per push.

The automatic checks are intentionally layered:

- [`ci.yml`](../.github/workflows/ci.yml) runs the Ubuntu `typecheck`, unit tests, browser end-to-end
  tests, and a fast `--bundle-only` control-plane check on ready PRs and `main` pushes. Documentation-
  only changes are ignored.

- [`platform-isolation.yml`](../.github/workflows/platform-isolation.yml) runs the focused runner
  isolation tests on Windows and macOS only when `apps/runner` changes.
- [`desktop-native.yml`](../.github/workflows/desktop-native.yml) runs Rust formatting, tests, and
  Clippy on Linux x64 and Windows x64 only when the Tauri source changes. The Windows job preserves
  coverage for the native credential-store integration.
- [`release.yml`](../.github/workflows/release.yml) retains the complete six-platform native build
  matrix for tags and explicit manual verification.

All three PR workflows can also be started manually from the Actions page.

Before merging, verify that every required check applies to the pull request's current head commit.
Configure the `main` ruleset to require those checks, resolved review conversations, and a pull
request while blocking force pushes and branch deletion. A skipped workflow result does not prove
that the current head was tested.
