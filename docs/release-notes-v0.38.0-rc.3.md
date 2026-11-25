# Wollipog v0.38.0-rc.3 — Release Candidate

The third release candidate for v0.38.0 improves Antigravity worktree switching, owner decisions, and campaign handoffs. These notes cover changes since [v0.38.0-rc.2](https://github.com/picoduck/wollipog/releases/tag/v0.38.0-rc.2).

## What Changed

- Antigravity sessions can use Auto Mode and Full Permissions Mode. Switching to a different worktree starts a fresh Antigravity conversation with a handoff from the previous conversation. This release also fixes Antigravity terminal commands in managed Linux worktrees.
- Wollipog checks whether the agent supports managed worktrees before creating one and keeps failed relaunches recoverable.
- Standalone sessions can ask their owner structured questions and request approvals. Dismissing an owner question now requires an explicit action.
- Wollipog refuses Codex merge admissions when it cannot establish the evidence needed to verify the merge authorization.
- Campaign handoffs appear as status updates and support keyboard actions in the Inbox and the session request dock.

## Install the Prerelease

Download the desktop installer for your platform from the release assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This setting defaults off. The desktop app links to the release page for `.deb` and `.rpm` installations.

Headless installations can select this version with `wollipog update --release v0.38.0-rc.3`. Plain `wollipog update` continues to select the latest stable release.

## Upgrade and Rollback

Upgrade the control plane before standalone or remote runners. Before upgrading, stop processes that share a mutable data directory and back up the control-plane database, runner data, and configuration. Retain the previous binaries. To roll back, stop the candidate processes, restore the backup, and start the previous binaries.

If your organization has archived-history retention enabled, capable runners trim full logs after completed control-plane pruning, including for previously pruned sessions. Back up the runner data or disable the policy before upgrading if you need to preserve full logs. Reprocess cannot restore trimmed logs, and older runners refuse manifest format 2. See [Archived-History Retention](https://github.com/picoduck/wollipog/blob/v0.38.0-rc.3/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane advertises the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` Upgrade those clients before connecting.

## Release Assets

The base draft holds exactly 34 assets across the six supported native targets: 14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the `wollipog-web.tar.gz` dashboard bundle, and `SHA256SUMS`. The signed prerelease adds 12 updater signatures and `latest.json`, bringing the total to 47 assets. Publishing the verified draft remains a manual operator step.
