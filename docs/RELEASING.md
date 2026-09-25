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

The runner SEA embeds fixed skill-adoption helpers compiled on the build host. macOS legs compile the
snapshot helper with `/usr/bin/clang`. Linux legs compile the no-replace rename helper
(`apps/runner/native/linux-skill-rename.c`) with `/usr/bin/cc -static`, which needs a C compiler and
the static C library; the `build-essential` packages the Linux legs install provide both. CI's
`--bundle-only` runner check compiles the same static helper on every pull request.

Each matrix job also publishes the **headless control plane**: the exact injected and signed
sidecar bytes are copied to `apps/control-plane/dist-bin/wollipog-control-plane-<triple>[.exe]`,
run natively with `--version` against `APP_RELEASE_VERSION`, compared byte for byte with the
desktop sidecar, uploaded, and digest-checked like the runner. This is the executable
`wollipog service install` runs on a server (see [headless deployment](./headless-deployment.md)).

After all six native jobs finish, a verification job builds the browser web bundle once
(`pnpm --filter @wollipog/web build`, PWA assets included) and uploads it as `wollipog-web.tar.gz`,
a tarball whose single top-level `web/` directory the control plane serves from beside its
executable or through `WOLLIPOG_WEB_DIST`. The job then downloads the 12 published runner assets,
the 6 control-plane executables, and the web bundle, requires all six runner pairs to have identical
SHA-256 digests, and uploads a lexically sorted `SHA256SUMS` covering all 19 names. It then compares
that manifest with GitHub's recorded asset digests and requires exactly 34 release assets: 14 desktop
bundles, 12 runner names, 6 control-plane executables, the web bundle, and the manifest. A release
signed for [in-place desktop updates](#in-place-desktop-updates), which is every tag run, adds 12
update signatures and `latest.json`, and the gate then requires exactly 47 release assets and the
exact `latest.json` bytes the job verified. A missing, extra, empty, malformed, or mismatched asset
fails the release workflow.
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

macOS bundles are **signed and notarized** with a Developer ID Application certificate when the
`APPLE_*` repository secrets are present: `APPLE_CERTIFICATE` (base64 p12), `APPLE_CERTIFICATE_PASSWORD`,
and `APPLE_SIGNING_IDENTITY` for signing, plus one notarization method. Preferred: an App Store
Connect API key as `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, and `APPLE_API_KEY_P8` (base64 of the
`.p8`). Fallback: the Apple ID trio `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), and
`APPLE_TEAM_ID`. The key is preferred because the notary service has answered app-specific-password
submissions with HTTP 500 for accounts that notarize fine with a key, and Apple's guidance for that
error is key-based authentication. The workflow exports the secrets only on the macOS legs and only
when the certificate secret is non-empty. A branch test dispatch without it still produces an
unsigned throwaway bundle instead of failing; a tag run without it fails, so a missing or deleted
secret cannot publish an unsigned release. When they are present, the Tauri bundler signs the app and both
Node sidecars with the hardened runtime and
[`entitlements.plist`](../apps/desktop/src-tauri/entitlements.plist) (the JIT subset V8 needs),
notarizes, and staples; a post-build step then requires `codesign --verify --deep --strict`,
`spctl --assess`, and a stapled ticket, so a signing or notarization failure fails the release rather
than publishing an unsigned macOS bundle. The macOS legs run under a 120-minute timeout (other
platforms 45) because the notary wait is unbounded on Tauri's side and a first submission has taken
over 40 minutes.

Windows bundles are **Authenticode signed** through Azure Artifact Signing. The Azure identity lives
in the `release` GitHub environment as six variables, not secrets: `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`,
and `ARTIFACT_SIGNING_PROFILE`. There is no client secret. The Windows legs run in that environment,
which admits only `v*` tags, and sign in with a GitHub OIDC token. The Entra app registration trusts
exactly one federated subject, and the repository emits GitHub's immutable subject format:
`repo:picoduck@299207909/wollipog@1287394723:environment:release`. The app holds the Artifact
Signing Certificate Profile Signer role on the signing account.

The workflow downloads the Artifact Signing client pinned by version and SHA-256, and signs with the
x64 `signtool` and the client's x64 dlib. The client ships no ARM64 build, so the ARM64 leg installs
an x64 .NET 8 runtime and signs under emulation. Signing happens in two places, both through
[`windows-authenticode.mjs`](../apps/runner/scripts/windows-authenticode.mjs):

- The runner and control-plane build scripts sign each Node SEA immediately after injection, before
  the legacy runner alias, the headless control plane, and the Tauri sidecar copies are made. Tauri
  skips sidecars that already verify as signed, so every copy stays byte-identical.
- A build-time Tauri config overlay points `bundle.windows.signCommand` at the same script, which
  signs the app executable, the MSI, the NSIS installer, and its uninstaller. The overlay exists only
  in CI, so local Windows builds are unsigned and need no Azure access.

A post-build step unpacks the MSI and requires a valid, timestamped signature from a single
certificate subject on every shipped executable, both installers, and the standalone runner and
control-plane assets. A run that requires signing, meaning a tag run or a dispatch with the signing
option selected, fails without the signing variables. Only a branch test dispatch without that option
builds unsigned bundles. Artifact Signing issues no EV certificates,
so SmartScreen can still warn until the certificate's download reputation builds.

## In-place desktop updates

The desktop app updates itself from the **latest published** release
([#1646](https://github.com/picoduck/wollipog/issues/1646)). It reads
`https://github.com/picoduck/wollipog/releases/latest/download/latest.json`, which GitHub never
resolves to a draft or a prerelease, and it never offers a prerelease to a stable build. Settings →
About shows the running version, whether a newer release exists, and an **Install and Restart**
button. Installing restarts the app, so it goes through the same work-in-flight guard as closing the
window. `.deb` and `.rpm` installs, and any build without an update key, report the new release and
link to its page instead of installing. `WOLLIPOG_DISABLE_UPDATE_CHECK=1` in the app's environment
turns off every update request; the **Check for Updates Automatically** switch turns off only the
background check.

Update packages carry a second signature, separate from Developer ID and Authenticode: a minisign
signature made with the **update key**. The app verifies it against the public key compiled into the
build, and requires the signature to name the version `latest.json` announces, so an altered
manifest cannot pair a new version number with an older package. The packages are the macOS
`.app.tar.gz`, the Windows MSI and NSIS installers, and the Linux AppImage, `.deb`, and `.rpm`; each
gets a `.sig` beside it.

| Name                                 | Kind                | Holds |
| ------------------------------------ | ------------------- | ----- |
| `TAURI_UPDATER_PUBLIC_KEY`           | repository variable | The public key every current build trusts, as `tauri signer generate` writes it (base64). |
| `TAURI_SIGNING_PRIVATE_KEY`          | repository secret   | The matching private key file's contents. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | repository secret   | Its password. |
| `TAURI_UPDATER_NEXT_PUBLIC_KEY`      | repository variable | Empty, except during a key rotation. |

The `preflight` job fails a tag run unless the public key and the private key are both configured,
and fails any run where only one is. A branch test dispatch without them builds a release with no
update assets. A build-time config overlay passes the public key to the bundler and turns on update
artifacts, so local builds never need the private key. After every native leg has uploaded, the
verification job downloads each update package and its `.sig`, checks the key ID, the signature, the
signed trusted comment, the signed file name, and the signed version against
`TAURI_UPDATER_PUBLIC_KEY`, and only then writes and uploads `latest.json`
([`desktop-update-manifest.mjs`](../scripts/desktop-update-manifest.mjs)). The bundler only warns
when the private key does not match the public key, so this check is what stops such a release. It
fails while the release is still a draft. `tauri-action`'s own `latest.json` is disabled because
each of the six parallel legs rewrites it and they drop each other's platforms.

### Create and Back Up the Update Key

```bash
pnpm --filter @wollipog/desktop tauri signer generate -w ~/wollipog-updater.key   # prompts for a password
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/wollipog-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD                                   # prompts
gh variable set TAURI_UPDATER_PUBLIC_KEY < ~/wollipog-updater.key.pub
```

GitHub secrets cannot be read back, so the key file and its password must also be stored outside
GitHub before the local copy is deleted: in the maintainers' password manager, plus an offline copy.
Keep the password apart from the key file. Anyone holding both can publish updates that every
installed app accepts.

### Rotate the Update Key

An installed app trusts only the key it was built with, so a rotation takes one transitional
release:

1. Generate the new key pair and back it up as above. Set `TAURI_UPDATER_NEXT_PUBLIC_KEY` to the new
   public key. Leave the two secrets and `TAURI_UPDATER_PUBLIC_KEY` on the current key.
2. Cut a release. The current key signs it, so installed apps accept it, and it embeds the new public
   key. The preflight log carries a notice saying so.
3. After that release is published, move `TAURI_SIGNING_PRIVATE_KEY`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `TAURI_UPDATER_PUBLIC_KEY` to the new key, and clear
   `TAURI_UPDATER_NEXT_PUBLIC_KEY`. Every later release is signed with the new key.

An app that skips the transitional release keeps the old key and cannot verify any later release.
It reports the update as unverifiable, and the user reinstalls once from the release page.

### If the Key Is Lost or Leaked

- **Lost** (no backup): no installed app will accept anything signed with a new key. Generate a new
  key, set all three values, and publish. Installed apps keep reporting that a newer release exists,
  but every user has to install that release once by hand. The one-line installers work, because
  they check GitHub's digest rather than the update key.
- **Leaked**: anyone holding the key can sign packages that installed apps accept, if they can also
  serve those apps a manifest. Rotate straight away, and publish the transitional release, so that
  installed apps move off the leaked key.

The first release that includes the updater can only be installed by hand. Earlier apps have no
updater and cannot find it.

## One-line install

End users install via the scripts in [`scripts/`](../scripts) (documented in the README's
"Install (prebuilt)" section): `install.sh` / `install.ps1` for the desktop app and
`install-runner.sh` / `install-runner.ps1` for the runner (`install-runner.sh --control-plane` also
installs the headless control plane and dashboard bundle for `wollipog service install`). They resolve assets from the GitHub
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
limitations, sanity-check the exact 47-asset inventory, `SHA256SUMS`, and `latest.json`, and
**Publish**. Publishing is also what makes the release visible to installed apps. A pre-release suffix (`vX.Y.Z-rc.1`) is marked
as a GitHub pre-release automatically.

After publishing, reconcile the repository's security advisories with the release. For every
published advisory whose `patched_versions` is empty, check whether the tagged commit contains the
fix (`git merge-base --is-ancestor <fix-commit> vX.Y.Z`) and, if it does, set the patched version
to `X.Y.Z` on the advisory (Security tab, or
`gh api -X PATCH repos/picoduck/wollipog/security-advisories/<GHSA-id>` with the `vulnerabilities`
array). An advisory published from a private fork does not learn about the release on its own:
GHSA-7w29-232x-g886 shipped its fix in v0.23.0 and still advertised "no patched version" two days
later, until a maintenance sweep noticed.

```bash
gh api repos/picoduck/wollipog/security-advisories \
  --jq '.[] | select(.state == "published") | select(any(.vulnerabilities[]; .patched_versions == null)) | .ghsa_id'
```

## Test build without tagging

Actions → **Release** → **Run workflow**, and pick the branch (or tag) to build from the ref
dropdown. A branch run produces a unique throwaway draft tagged `v0.0.0-test.<run-number>` (so
repeated runs never collide), built from that branch's HEAD — delete it afterward. Nothing is
published. (Selecting a real tag instead runs the same version-checked path as a tag push.)

A branch run signs update packages and uploads `latest.json` whenever the update key is configured.
Installed apps never see it, because a draft is never the latest release. A branch run builds
unsigned Windows bundles by default. To test Windows signing, select **Sign the
Windows test build through Azure Artifact Signing** and first add that branch as a temporary branch
rule on the `release` environment; remove the rule after the run. Without the rule GitHub refuses to
start the Windows legs.

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
