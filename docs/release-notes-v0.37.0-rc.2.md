# Wollipog v0.37.0-rc.2 — Release Candidate

This second release candidate for v0.37.0 improves provider-account setup, campaign recovery, and Codex commands on Linux. These notes cover changes since [v0.37.0-rc.1](https://github.com/picoduck/wollipog/releases/tag/v0.37.0-rc.1), which introduced provider-account priority controls and configurable automation campaigns.

## Install the Prerelease

Download the desktop installer for your platform from this release’s assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This preference defaults off, including after manually installing a prerelease. Where supported, **Install and Restart** installs the offered update. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication:

```bash
wollipog update --release v0.37.0-rc.2
# For non-interactive upgrades:
wollipog update --release v0.37.0-rc.2 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate leaves v0.36.1 as latest stable.

## Provider Setup and Sessions

- Provider-account directory failures show structured diagnostics and recovery guidance. Linux profile-root maintenance is bounded, and runner diagnostics carry safe error details to the control plane.
- Adding a provider account keeps account setup above the New Session draft. SSH connection health is reported separately from provider setup readiness.
- Failed slash-command messages can be dismissed.
- Codex recognizes bubblewrap’s “create a new namespace” denial on Linux and uses an existing enclosing runner boundary when available. Ordinary commands and linked-skill reads can then run without repeated nested-sandbox escalation, preserving the enclosing network policy and approval controls.

## Campaigns and Reviews

- Unchanged issue-closure approvals survive unrelated updates and waits beyond thirty minutes. Campaign status reflects preserved closure bindings, and uncertain closure outcomes can be reconciled.
- Campaigns accept standing reports from failed children and admit verified failure follow-ups. Owner-named repository scope is honored exactly.
- Byte-identical UI evidence can reuse verified review receipts. Proven protocol-only renumbering does not consume review-round budgets.
- Runner command credential-home write separation is documented. The pinned Pi command-home operations boundary remains a prototype; this candidate does not establish its production readiness.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v362; new campaign and provider capabilities require compatible components. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.37.0-rc.2 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.37.0-rc.2/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.

This candidate remains a prerelease. Stable v0.37.0 requires a separate version-checked build and exact-commit regression certification; changing the prerelease flag cannot graduate the signed RC packages to stable. These changes do not establish unattended Full Control production readiness or waive human-owned approval gates.
