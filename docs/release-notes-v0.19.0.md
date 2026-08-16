# Wollipog v0.19.0 — Runner Ownership and Access Controls Release

Wollipog v0.19.0 makes concurrent installed, development, and remote runners safe under one OS
account, adds explicit Project and Location access controls, and fixes transcript and draft
reconstruction failures seen during real development sessions.

## Upgrade and Rollback Warning

Upgrade the control plane before upgrading standalone or remote runners. Protocol v77 adds an
authenticated, read-only control-plane identity attestation that the current runner requires before
it opens mutable local stores. A v0.19.0 runner refuses an older control plane that does not provide
this endpoint. Existing older runners can remain connected during the control-plane upgrade, but
they do not gain the new ownership isolation until they are upgraded.

The desktop bundle upgrades its embedded control plane and local runner together. An existing
markerless local runner remains offline after the first v0.19.0 start rather than claiming its state
silently. Stop every older Wollipog desktop and local-runner process, then choose **Reconnect This
Machine**. That explicit repair stops the desktop's managed child before launching once with legacy
adoption authority. Automatic saved-runner startup never adopts legacy state.

Before upgrading an existing populated runner data directory, stop every pre-v0.19.0 runner that
uses that directory or OS account and preserve its configuration and binary. A configured standalone
runner may then be started once with its otherwise unchanged command plus
`--adopt-legacy-data-dir`. Managed legacy SSH Machines use the explicit owner/admin adoption flow,
including the stop-all acknowledgement. Ambiguous legacy state is preserved and fails closed rather
than being claimed automatically.

Use retained v0.18.0 binaries and configuration as the rollback baseline. This repository did not
have a published v0.18.0 GitHub release when v0.19.0 was prepared, so verify that those artifacts are
available locally before upgrading if rollback is required. v0.18.0 predates runner owner markers
and can reopen the original shared data root from the preserved legacy bytes. It cannot discover a
secondary stable-owner namespace created by v0.19.0 or resume owner-scoped WSL provider or
checkpoint state created only after the upgrade. Those bytes are retained; roll forward to v0.19.0
to resume them.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities.
Remote-pairing users on v0.14.0 or earlier must upgrade the desktop before connecting; otherwise the
older desktop reports
`The address is not a Wollipog control plane.`

## Runner Ownership and Remote Execution

- Scope runner credentials and mutable data to a stable runner plus control-plane installation
  identity, preventing a development stack from overwriting an installed runner's callback
  credential or session state.
- Claim runner data roots before mutable stores open, serialize live ownership with durable leases,
  and require explicit adoption for populated markerless roots.
- Give newly managed SSH Machines isolated data roots and require an immutable, full-SHA-256-attested
  runner binary before credential issuance or launch.
- Preserve rollback markers and legacy bytes while owner-scoping new credentials, sessions,
  admission records, receipts, hooks, Conductor configuration, WSL worktrees, provider state, and
  checkpoint references.
- Reuse an exact healthy pre-attestation WSL worktree so upgrades do not strand uncommitted changes;
  missing or unexpected legacy paths fail closed for manual recovery.
- Add a redacted offline state doctor for inventory, checkpoint or WSL-state adoption, cleanup
  reconciliation, and reversible Conductor or WSL quarantine. Mutations require confirmation that
  every legacy runner is stopped.
- Serialize native mutable provider homes across control-plane owners until all provider process
  trees have exited. Incomplete or stale leases remain fail closed until an operator proves the home
  is unused and quarantines the lease.
- Isolate `dev:all` runner state from installed runners and from the source checkout.

## Project and Location Access

- Add explicit access-scope choices when creating Projects and Locations.
- Add authorized, preflighted post-creation scope management with exact affected-Project and session
  impact.
- Preserve the rule that a broader Project cannot expose a narrower private Location.
- Revalidate Project, Location, Machine, session, and team-membership relationships server-side and
  record attributable scope-change audits atomically.
- Keep viewers read-only, reject unauthorized cross-user creation, and filter preflight details so
  a shared Location cannot reveal private Project identities.
- Surface identity-loading failures without leaving Add Location permanently pending.

## Transcript and Composer Reliability

- Reassemble interleaved Codex App Server deltas by stable provider message ID and parent context,
  preserving one logical transcript row, stable row keys, scroll anchors, copy controls, and
  timestamps.
- Retain contiguous-only behavior for legacy streams without message IDs and bound open-message
  tracking across completion and structural boundaries.
- Prevent provider-accepted prompts or steering messages from reappearing as drafts after cleanup,
  storage-fallback, remount, or IndexedDB failure paths.
- Preserve newer in-flight edits while recovering only genuinely rejected submissions.

## Runner and Development Quality

- Raise the default runner capacity from 4 to 16 while preserving every explicit operator setting.
- Report an installed but signed-out Codex as unavailable, show the appropriate `codex login`
  guidance, and restore selection after rediscovery.
- Provide UUID generation on non-secure development origins and keep the control-plane-served web
  bundle current during `dev:all` without deleting the last-good build.

## Deliberate Boundaries

Native provider installation, login, configuration, cache, and transcript bytes remain
operator-owned. The provider-home lease serializes mutation but does not claim those bytes.
Direct WSL provider mode now fails closed because Windows-side process liveness cannot safely protect
the shared WSL home; use bwrap isolation or a dedicated distro or OS account. Standalone Agent TUI
attachment from a WSL session likewise requires a dedicated distro or account.

Legacy Conductor files, shared WSL roots, and unattributable provider state are not deleted
automatically. Inventory and back them up before using an explicit state-doctor adoption or
quarantine action. Desktop bundles remain unsigned, so operating systems may show an
unidentified-developer warning on first launch.

The release workflow builds all six supported native targets, publishes canonical and legacy runner
names, verifies each pair is byte-identical, and checks native `--version`. Its final job fails unless
the draft holds exactly 27 assets: 14 desktop bundles, 12 runner names, and `SHA256SUMS`, with GitHub
publisher digests matching the manifest. Publishing the verified draft remains a
manual operator step.
