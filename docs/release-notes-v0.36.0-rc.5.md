# Wollipog v0.36.0-rc.5 — Release Candidate

This fifth release candidate for Wollipog v0.36.0 includes the previous candidates and changes on main through commit `2e9b5e900fad079835deb41ec916f7149dd7561e` (#4302). The additions below cover changes since v0.36.0-rc.3; see the [previous candidate’s notes](https://github.com/picoduck/wollipog/releases/tag/v0.36.0-rc.3) for earlier v0.36.0 changes.

The rc.4 tag was not published because GitHub retired its Apple Silicon build runner. This candidate uses the supported macOS 15 ARM64 runner and rebuilds the complete signed release inventory. Its embedded macOS C helpers explicitly target macOS 14.0, with the native build checking their recorded minimum OS before packaging.

## Install the Prerelease

Download the desktop installer for your platform from this release's assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This preference defaults off, including after manually installing a prerelease. Where supported, **Install and Restart** installs the offered update. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication:

```bash
wollipog update --release v0.36.0-rc.5
# For non-interactive upgrades:
wollipog update --release v0.36.0-rc.5 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate does not replace v0.35.0 as latest stable.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v317; newer campaign and recovery capabilities require compatible runners. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.36.0-rc.5 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.36.0-rc.5/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

Automatic launches check the effective default provider account. If the default is signed out or unavailable, choose a ready account explicitly or repair the default. Older control planes connected to a v317 runner see an unavailable default as an unavailable agent; upgrade the control plane first.

Existing Custom campaigns created before the scope-grant upgrade may pause until their epic seed is settled. Review the campaign's scope and any owner question before resuming work.

## Changes Since rc.3

- Campaign scope proposals can name issues in any boundary repository, and re-authorizing or enabling Full Control preserves the campaign’s repositories.
- Campaign boundaries can include verified repositories across a project. Campaign Status shows repository-qualified issue scope, boundary evidence, capabilities, and rules that require a person. An Orchestrator can ask its owner to add a project repository.
- Full Control and Custom scope proposals use checked grants, deterministic constraints, and typed Decision Model questions. Owners can adjust selection counts and approve scope additions; owner questions support free-form answers and appear as **Needs Your Input**.
- Decision Model settings and audit details expose the checks used for scope, credential screening, follow-up relatedness, and closure reasons. Human-owned gates remain with their owner.
- Sessions can continue at an approved location on the same machine when a task belongs to another repository. Project locations can be renamed, and the composer’s **@** picker supports fuzzy folder matching.
- Campaign and session status more clearly distinguish active work, deliberate waits, stalled work, completed campaigns, and cleanup. Oversized turn diffs no longer make session history unreadable.
- Runner recovery requires proof that a previous process is gone before releasing capacity. Background continuations recover after worktree retirement, and sandboxed providers receive a writable temporary directory.
- Full Control campaigns can merge in repositories without required checks only after all reported checks pass, using compatible runners (protocol v315 or later).
- Pull request summaries count the latest run of each check. Merged branches are rechecked for cleanup, GitLab merge decisions verify closing patterns, and concurrent campaign reviews share the remaining allowance.
- Usage pricing identifies its rate source without exposing credentials. CI and regression coverage include recovery, retention, workspace search, skill restoration, and release diagnostics.

These changes do not establish unattended Full Control production readiness or waive human-owned decisions, evidence review, or managed review limits. This candidate remains a prerelease and does not replace v0.35.0 as latest stable.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
Stable v0.36.0 requires a separate version-checked build and exact-commit regression certification; changing this release's prerelease flag cannot graduate the signed RC packages to stable.
