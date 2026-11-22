# Wollipog v0.38.0-rc.1 — Release Candidate

This first release candidate for v0.38.0 adds Google Antigravity sessions, redesigns the Assistant experience, and reduces repeated control-plane work. These notes cover changes since [v0.37.1](https://github.com/picoduck/wollipog/releases/tag/v0.37.1).

## Install the Prerelease

Download the desktop installer for your platform from the release assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This setting defaults off. Where supported, **Install and Restart** applies the update. The desktop app links to the release page for `.deb` and `.rpm` installations.

Headless installations can select the candidate with `wollipog update --release v0.38.0-rc.1`. Plain `wollipog update` continues to select the latest stable release.

## Google Antigravity

- Set up a managed Google Antigravity CLI from Connections, then install or update it from the same place.
- Start Google Antigravity sessions on compatible runners through ACP. Session setup and transcripts surface provider availability and errors.

## Assistants

- The Assistants list works as an inbox, and you can start a thread by sending its first message.
- Requests appear above the composer, with details and delegated decisions available in the thread panel. Recovery notices and action receipts appear in the transcript.
- Thread settings and spending details have dedicated views. Connection settings have their own pages, and Assistant threads fit smaller phone screens.
- Model choices are grouped by family, queued messages stay inside the composer, and Markdown renders as replies stream.

## Performance and Reliability

- Session WebSocket updates send less repeated data. Campaign views reuse expensive reads, and descendant-request polling limits its work to pending approvals.
- The control plane uses a larger SQLite page cache and performs less work during prompt retry maintenance.

## Upgrade and Rollback

Upgrade the control plane before standalone or remote runners. Use matching component versions for new capabilities. Before upgrading, stop processes that share a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop the candidate processes, restore the backup, then start the previous binaries.

For organizations with archived-history retention enabled, capable runners trim full logs after completed control-plane pruning, including for previously pruned sessions. Back up the runner data or disable the policy before upgrading if you need to preserve full logs. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.38.0-rc.1/docs/archived-history-retention.md#runner-logs-and-upgrades).

The release includes desktop, standalone runner, and headless control-plane builds for all six supported native targets, plus the dashboard bundle, checksums, and signed desktop updater assets. A stable v0.38.0 requires its own versioned build.
