# Keeping box runners up to date

Boxes run the runner **binary deployed to them** (a Node SEA executable copied over SSH), not
this repo's source. Restarting your dev stack updates the *local* runner you launch from source,
but every box keeps whatever binary was last `scp`'d to `~/.agent-manager/agent-manager-runner`
— so after a protocol bump the fleet shows **outdated** badges until each box is redeployed.

## How staleness is detected

- Every runner reports its `protocolVersion` when it registers. The dashboard compares it to its
  own `PROTOCOL_VERSION` (`packages/protocol`) and badges older runners **outdated**.
- Each box row persists `deployed_version` — the sha256[:16] **content hash** of the binary last
  deployed — and `triple`, the platform detected on bootstrap (e.g. `aarch64-unknown-linux-gnu`).
  Both show on the box card (Deployed Binary). Content hashing, not `--version`, decides whether
  a redeploy is needed: launch-contract changes don't always change the version string.
- Downloaded binaries live under `~/.agent-manager/runner-bin/<release-tag>/`. Each has a manifest
  containing its repository, release tag, asset name, byte length, and full SHA-256. A missing,
  malformed, wrong-release, wrong-size, or wrong-hash manifest is diagnosed and downloaded again.
  New downloads additionally record that the digest was verified against GitHub's release-asset
  metadata. Existing schema-1 manifests and legacy-named exact-release caches remain readable for
  offline rollback. The old unversioned cache is deliberately ignored with a warning.
- A verified full digest is reused across boxes and through deploy comparison, avoiding repeated
  reads of the same large artifact. Managed retention keeps the current release plus one prior
  known-good release for rollback; older release directories are pruned only after a successful
  current resolution.

## Capability gates during rolling upgrades

The outdated badge is not the safety boundary. Commands that an old runner would ignore are gated
by the minimum protocol that introduced them, in both the dashboard and control plane:

Protocol v30 additionally persists Claude Code readiness and verified optional flags. A pre-v30
runner remains readable but has no structured Claude billing/PATH diagnosis; redeploy it before
relying on effort, auto-permission, or stream-image gates from the dashboard.

Protocol v31 adds optional recursive subagent usage/duration attribution and the normalized
`agent` tool kind. Old runners remain wire-compatible and their timelines still render, but may be
flat, lack rollups, or show Task as a generic tool. Redeploy/restart each runner before relying on
recursive agent trees; the existing outdated badge identifies runners that still need refresh.

Protocol v42 adds provider-aware weighted admission metadata and leases. During a rolling upgrade,
v41 and older runners still honor the box slot ceiling but do not claim provider quota slots; update
every process sharing one runner data directory before relying on an agent-specific quota.

Protocol v43 adds runner-owned bubblewrap policy diagnostics. Old runners do not understand or
enforce `executionIsolation`; redeploy every target before relying on the Linux/WSL write or network
boundary. Strict sessions fail before provider construction when bubblewrap is absent.

Protocol v44 adds bounded per-session provider-state retention diagnostics and cleanup reconciliation.
Older runners keep their existing transcript stores but do not journal failed cleanup, enforce the orphan
age/byte ceilings, retire the migrated shared leaf, or require a stable non-empty fork artifact.

Protocol v45 adds native macOS Seatbelt and Windows Job Object modes. Redeploy a macOS/Windows runner
before selecting either mode. Seatbelt is a write/network boundary; Windows Job Objects provide only
kill-on-close process-tree containment and reject `network: "deny"` rather than overclaiming isolation.

Protocol v46 adds the shared approval-kind and governance-audit vocabulary. Audit persistence is
control-plane-owned, but the protocol bump still requires runner redeployment before it can register
against a v46 control plane.

Protocol v47 moves cost and distinct-tool thresholds into the runner's normalized event path. A
crossing cancels the turn and holds queued prompts until `rearm_governance` arrives. Continue advances
the threshold by the original fixed allowance window rather than clearing it. Older runners retain
between-turn policy behavior, but redeploy before relying on active interruption or held-queue resume.

Protocol v53 adds the distinct `durable_session_command` envelope and runner-owned automation receipt
journal. Durable schedules fail closed against v52 and older runners: an older process cannot safely
execute a legacy inner command while ignoring its receipt contract. Redeploy and restart every runner
that may receive automations before relying on reconnect/restart retries. Existing interactive session
commands remain compatible, and legacy automation executions keep their prior at-most-once semantics.
All runner processes sharing one data directory must be upgraded together: v53 coordinates command
ownership with box-wide locks and process leases and establishes fsynced acceptance/provider-handoff
boundaries. A runner that reconnects as pre-v53 after work was claimed causes that work to fail closed.

Protocol v57 makes dashboard terminals detachable across runner transports and control-plane
restarts. The runner retains a bounded, sequence-addressed output tail and replays shell snapshots
followed by an authoritative inventory fence after registration. The control plane persists that
tail separately from session events and marks live v57 shells `reconnecting` during an outage.
Pre-v57 runners remain compatible with terminal open/input/close, but their processes resolve as
exited on disconnect because they cannot prove a surviving inventory; update before relying on
detach/reconnect recovery.

Protocol v76 carries ordinary prompts admitted during queued/starting launches through the durable
command journal. The command ID is also the runner queue ID and the canonical user-event identity,
so the dashboard can show one pending transcript bubble across reload, retry, live admission, and
history reconciliation without matching user text. Cancellation remains deliberately narrow: the
control plane may cancel only a persisted command that has never entered its send lane; after that,
the dashboard requires the exact ID in a current runner `session_queue` projection. Sent, accepted,
started, or offline queued work is never reported as cancelled without runner evidence. Terminal
failed/uncertain bubbles may be dismissed locally; dismissal retains the outcome tombstone while
scrubbing the stored prompt payload.

| Capability | Minimum protocol |
| --- | ---: |
| Find/adopt unmanaged agent sessions | 6 |
| Reprocess an adopted transcript | 8 |
| Browse the runner for a workspace directory | 10 |
| Load rich branch/worktree diffs | 12 |
| Stage or unstage individual hunks | 13 |
| Browse/read session files | 16 |
| Open a session terminal | 17 |
| Open a workspace in a host editor or file manager | 22 |
| Cancel a queued prompt | 23 |
| Rewind a worktree checkpoint | 25 |
| Fork a provider conversation | 28 |
| Accept retryable durable automation commands | 53 |
| Reconcile detachable terminal sessions and bounded history | 57 |

A missing protocol version is treated as **unknown**, not optimistically supported. Protocol
metadata itself arrived in v15, so the dashboard cannot prove which earlier commands such a runner
understands. Disabled controls and HTTP 409 responses name the required protocol and say to update
and restart, instead of waiting for a runner timeout.

## Native runners are externally managed

A native runner started from a shell or service is not a child of the dashboard. The dashboard must
not kill or replace a process it does not own, especially while it may hold active sessions. When a
native runner is outdated or does not report a protocol version, its card now explains the safe
manual sequence:

1. Let active work settle.
2. Update the source checkout or rerun the matching standalone runner installer.
3. Stop the existing process.
4. Relaunch it with the same config and service/shell command.

For a source checkout the common command is `pnpm runner --config runner.config.json`. Standalone
installs should rerun `scripts/install-runner.sh` or `scripts/install-runner.ps1`, then relaunch with
their existing arguments. A future managed-native-runner design may add start/stop ownership; this
release deliberately provides health and restart guidance without pretending the dashboard owns the
process.

### Standalone Installer Identity and Rollback

Fresh standalone installs now use these canonical locations:

- macOS/Linux: `~/.local/bin/wollipog-runner` and
  `~/.config/wollipog/runner.config.json`.
- Windows: `%LOCALAPPDATA%\Wollipog\wollipog-runner.exe` and the adjacent
  `runner.config.json`.

The installer also refreshes a byte-identical executable at the former command path:
`~/.local/bin/agent-manager-runner` on macOS/Linux or
`%LOCALAPPDATA%\AgentManager\agent-manager-runner.exe` on Windows. Existing services and saved
commands can therefore keep using the old path during the compatibility window. POSIX replacement
is atomic. Windows uses an atomic file replacement when the old alias is unlocked; if a running
legacy process holds it open, the installer preserves the complete old alias, finishes canonical
setup, and warns the operator to stop that process and rerun the installer. The runner's
durable `~/.agent-manager` data root, the SSH-managed
`~/.agent-manager/agent-manager-runner` path, the desktop bundle identifier, and repository slug
are separate identities and are unchanged.

Configuration is not copied between identities because it can contain a runner credential. When a
canonical config already exists it wins. Otherwise, if the former installer config exists, the
installer leaves it byte-for-byte in place, continues to print a start command that uses it, and
emits a path-only warning once. A fresh config is created at the canonical location only when
neither config exists. Moving an existing config is an explicit operator action that should include
credential rotation; the installer never duplicates that secret-bearing file. Fresh POSIX configs
are created with mode 0600 inside a mode-0700 canonical config directory.

Rollback stays symmetric during the window. A service that still names the legacy alias receives
the newly verified binary on each current installer run after it releases any Windows executable
lock; a locked invocation leaves the prior complete alias usable and reports the required retry.
Running an older installer can replace the
legacy alias without deleting the canonical binary or either config, so the old service command can
be restored independently. Do not remove the executable alias until all supported service templates
and documented commands use `wollipog-runner`, at least two stable releases have installed both
paths, and an upgrade/downgrade audit shows no supported rollback depends on the old command. Do not
remove legacy-config selection merely because time elapsed; it requires an explicit credential
reissue migration plus upgrade and rollback evidence that no supported install still relies on the
former location.

SSH-managed boxes use a different, explicit ownership policy: the remote runner is the command of a
dashboard-owned SSH tunnel and stops when that SSH process stops. Auto-reconnect starts a fresh
bootstrap; it does not keep work executing during a disconnect. See
[SSH runner lifecycle and durable-service design](./ssh-runner-lifecycle.md) for the shipped
guarantees and the gated design for an optional unattended service mode.

## One-click update (the Update runner button)

Every SSH-managed machine card exposes **Update runner**
(`POST /api/boxes/:id/update-runner`). It:

1. Detects the machine's current platform instead of trusting stale saved metadata.
2. Resolves and hashes the dashboard's exact candidate for that platform, **bypassing only the
   managed download cache**:
   `$WOLLIPOG_RUNNER_BIN_DIR` → `apps/runner/dist-bin` (explicit development overrides) → re-download
   from the **exact release embedded in this packaged control plane**. The release workflow injects
   that tag (normally `v<app-version>`; manual test releases inject their unique test tag).
   Each location is checked for `wollipog-runner-<triple>` first and the compatible
   `agent-manager-runner-<triple>` name second. A release falls back only when its metadata proves
   the canonical asset is absent; checksum or download failure never downgrades to the legacy name.
   An actual legacy selection emits a value-free migration warning. The control plane persists a
   release-scoped marker in its managed cache so repeated box updates and process restarts do not
   spam the same warning. Canonical selection emits no migration warning.
3. Compares that candidate with the build identity recorded for the machine. If they match, the UI
   reports **Already current** with the build hash and source; the healthy runner is not restarted.
4. If they differ, checks for active sessions and starts the normal reconnect/bootstrap path.
   Bootstrap copies and relaunches the runner by content hash. Progress then streams over the live
   socket (`deploying → online`).

The request fails with HTTP 409 rather than interrupting any non-terminal session. Let runner work
settle first, or explicitly repeat the API request with `{ "force": true }` when interruption and
snapshot-based recovery are acceptable.

If candidate resolution fails, the request returns the exact error and the box keeps its current
runner — nothing is marked failed. A `started` response means deployment has begun; the card's
connection status, runner version, and protocol are the completion signal.

For a private repository, launch the control plane with `GH_TOKEN` or `GITHUB_TOKEN` scoped to
`Contents: read`. The token is used only against `api.github.com`, is stripped before asset-CDN
redirects, and is never logged or written to the cache manifest. Without credentials, the error
names the exact tag and asset and directs the operator to authenticated or local staging options.

## When Update Runner can't help

If **Update runner** reports **Already current** while the runner protocol is still outdated, the
best binary the dashboard can resolve is itself older than the dashboard — no matching release or
staged development build with the new protocol exists yet for that platform. The card's hint names
the preferred artifact to produce: `wollipog-runner-<triple>`. Current builds emit that canonical
name plus a byte-identical `agent-manager-runner-<triple>` rollback alias; consumers retain the
legacy fallback throughout the compatibility window. Two ways to supply it:

The POSIX installer verifies GitHub's publisher digest for either name and, when `SHA256SUMS` is
present, cross-checks its one exact entry from the same release tag. It warns once after a successful
legacy fallback per release, using a release-scoped marker while keeping the emitted warning free of
the repository, tag, target, path, and credential values. Publishing the legacy alias remains
required until every item in the removal gate below has evidence.

- **Publish a release** whose assets include the per-platform runner binaries (see
  `.github/workflows/release.yml`; the tag must match the version fields).
- **Rebuild locally and stage it** where the resolver looks first:

  ```bash
  # On a machine (or WSL2 distro) matching the box's triple — SEA needs Node 24:
  export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
  pnpm install
  TARGET_TRIPLE=aarch64-unknown-linux-gnu pnpm --filter @wollipog/runner build:binary
  # Stage where Update runner will find it — a dev-staged dir, NOT the cache:
  #   copy dist-bin/wollipog-runner-<triple> into $WOLLIPOG_RUNNER_BIN_DIR
  #   (the byte-identical dist-bin/agent-manager-runner-<triple> alias supports rollback)
  #   (or leave it in apps/runner/dist-bin when the dashboard runs from this repo)
  ```

  **Don't stage into `~/.agent-manager/runner-bin` for this flow**: that directory is a managed,
  release-identified download cache. Entries without a matching manifest are deliberately ignored.
  Put operator-built binaries in `$WOLLIPOG_RUNNER_BIN_DIR` (or `apps/runner/dist-bin`) instead.

  Cross-compiling SEA binaries is not supported — build on (or in a VM/WSL2 of) the target
  platform. Then choose **Update runner** and the new hash deploys.

## Legacy Asset Removal Gate

The fallback is intentionally installable for the published v0.15.0 legacy-only release. Its local
warning is an operator migration signal, not telemetry, and contains no repository, tag, target,
path, or credential value. Do not infer fleet migration from silence in a single process.

Remove `agent-manager-runner-*` consumption only in a separately reviewed cleanup after all of the
following evidence exists:

1. Two consecutive published stable releases (the supported current release and its supported
   rollback predecessor) contain `wollipog-runner-<triple>[.exe]` plus the publisher checksum entry
   for every one of the six release targets.
2. The release inventory gate and all six native `--version` checks pass for both releases, and the
   POSIX installer, Windows installer, control-plane resolver, and desktop bridge smoke tests prove
   canonical selection without a migration warning.
3. The minimum supported packaged control-plane release no longer embeds v0.15.0 or any other
   legacy-only runner release tag, and the documented rollback window for those releases has ended.
4. A deliberate legacy-only fixture still installs with exactly one value-free warning immediately
   before removal, proving the fallback was observable rather than silently abandoned.

Until every item is recorded in release evidence, keep canonical-first selection, the fail-closed
no-downgrade rule, the warning, and the legacy fallback together.
