# Wollipog v0.18.0 - Session Workspace and Migration Release

Wollipog v0.18.0 delivers the session-view redesign and the migration-readiness work completed
since v0.17.0. It makes active work easier to understand, strengthens pinned session context, and
adds a reviewed manual path for moving complete development state to another Machine without
mistaking a visible transcript for a resumable provider session.

## Upgrade and Rollback

Upgrade desktop, control-plane, and standalone runner components together when practical. Protocol
v76 is unchanged from v0.17.0, so the existing rolling-upgrade boundary remains in force. Use
v0.17.0 as the supported rollback release.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Remote-pairing
users on v0.14.0 or earlier must upgrade the desktop before connecting to a v0.18.0 control plane;
otherwise the older desktop reports `The address is not a Wollipog control plane.` Existing
v0.17.0 clients and runners remain within the supported rolling-upgrade window.

## Session Workspace

- Reworked the Session header into a unified workspace bar with Project breadcrumbs and clearer
  session identity, status, action, and navigation ownership.
- Replaced the old active-turn strip with a compact working indicator and improved progress,
  cancellation, feedback, and responsive behavior.
- Reorganized pinned summary content and Git disclosure so important context remains readable
  without crowding the transcript.
- Strengthened browser coverage for narrow layouts, active turns, stop behavior, Git visibility,
  session actions, and Command Inbox composition.

## Development Machine Migration

- Added a reviewed cold-move runbook covering complete Git metadata and checkpoint refs, all
  registered worktrees, Wollipog databases and artifacts, runner data roots and receipts, provider
  session stores, desktop or development-browser state, and native plus WSL configuration.
- Require a quiescent snapshot and exact repository, runner-data, and worktree paths when claiming
  provider-native session continuity. Path-incompatible restores must be labeled transcript-only or
  use an explicitly tested provider fork/migration.
- Document packaged versus development startup, worktree repair, credential activation, explicit
  device revocation, source-state destruction, and split-brain prevention.
- Record IDEA-015 for a first-class future ownership-transfer workflow with a server lease,
  destination preflight, execution epochs, capability-aware Resume/Fork/Transcript Only outcomes,
  encrypted export/import, rollback, and source fencing.

## Deliberate Boundaries

v0.18.0 documents and validates the manual cold-move procedure; it does not yet implement automatic
host-to-host transfer. A raw live copy is not safe while Wollipog, a runner, a provider continuation,
or external jobs are active. Desktop bundles remain unsigned, so operating systems may show an
unidentified-developer warning on first launch.

The release workflow builds all six supported native targets, publishes canonical and legacy runner
names, verifies each pair is byte-identical, and checks native `--version`. Its final job fails the
run unless the draft holds exactly 27 assets: 14 desktop bundles, 12 runner names, and
`SHA256SUMS` with publisher digests matching that manifest. Publishing the verified draft remains a
manual operator step.