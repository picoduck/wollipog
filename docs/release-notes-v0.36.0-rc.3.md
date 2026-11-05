# Wollipog v0.36.0-rc.3 — Release Candidate

This third release candidate for Wollipog v0.36.0 includes the previous candidates and changes merged through #4177. The additions below cover changes since v0.36.0-rc.2; see the [previous candidate’s notes](https://github.com/picoduck/wollipog/releases/tag/v0.36.0-rc.2) for earlier v0.36.0 changes.

## Install the Prerelease

Download the desktop installer for your platform from this release's assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This preference defaults off, including after manually installing a prerelease. Where supported, **Install and Restart** installs the offered update. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication:

```bash
wollipog update --release v0.36.0-rc.3
# For non-interactive upgrades:
wollipog update --release v0.36.0-rc.3 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate does not replace v0.35.0 as latest stable.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v284; newer campaign and recovery capabilities require compatible runners. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.36.0-rc.3 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.36.0-rc.3/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

Automatic launches now check the effective default provider account, rather than accepting any signed-in account. If the default is signed out or unavailable, choose a ready account explicitly or repair the default. Older control planes connected to a v284 runner see an unavailable default as an unavailable agent; upgrade the control plane first.

## Changes Since rc.2

- Phone navigation stays anchored when scrolling Usage tables and pages with hidden content.
- Runner reconnects pace session queue projections through acknowledgments, reducing frame bursts while retaining runtime metadata and queue updates.
- Wollipog can execute an approved GitHub merge enqueue or merged-branch deletion through the requesting session's forge login. Actions remain bound to the approved head and resource snapshot; uncertain enqueues require reconciliation. Campaigns track merged branches until cleanup or an explicit handoff.
- Full Control authority checks consistently require the runner capability floor. Upgrade runners before relying on the new forge-action capability.
- Merged issue-closure deliveries can be confirmed without buffering comparison patches.
- Dependency and CI updates improve validation selection and release diagnostics. The desktop CLI remains below 2.12.3 while prerelease RPM bundling compatibility is unresolved.

These changes do not establish unattended Full Control production readiness or waive human-owned decisions, evidence review, or managed review limits. This candidate remains a prerelease and does not replace v0.35.0 as latest stable.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
Stable v0.36.0 requires a separate version-checked build and exact-commit regression certification; changing this release's prerelease flag cannot graduate the signed RC packages to stable.
