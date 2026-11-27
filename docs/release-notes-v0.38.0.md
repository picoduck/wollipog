# Wollipog v0.38.0

Wollipog v0.38.0 adds Google Antigravity sessions, redesigns Assistant threads, and makes owner decisions available in standalone sessions. This stable release covers changes since [v0.37.1](https://github.com/picoduck/wollipog/releases/tag/v0.37.1), including all three v0.38.0 release candidates and the changes that followed.

## Google Antigravity

- Install and update the managed Google Antigravity CLI from Connections, then run Antigravity sessions on compatible runners through ACP.
- Choose reasoning effort in Agent Defaults and use Auto Mode or Full Permissions Mode where available. Structured Antigravity forms appear as questions in Wollipog. The dashboard can show Antigravity subscription usage and AI credits.
- Switching managed worktrees starts a fresh Antigravity conversation with a handoff from the previous one. Auto Mode carries across the relaunch, and a failed relaunch remains recoverable. Terminal commands now work in managed Linux worktrees.

## Assistants and Campaigns

- Open a thread from the Assistants inbox or start one with the **New Thread** dialog. Edit Assistant settings in place and use threads on smaller phones.
- Respond to requests above the composer, inspect delegated decisions in the thread panel, and see action receipts and recovery notices in the transcript.
- Launch or schedule campaigns from an Assistant. Custom campaigns can omit a budget, and child reasoning effort can be set to **Automatic**. Scheduled campaign previews show the effective configuration.
- Follow the **Latest** model in a compatible family across launch settings. **Effort** and **Speed** have separate selectors.
- Standalone sessions can ask their owner structured questions and request approvals. Dismissing an owner question takes an explicit action. Campaign handoffs appear as status updates with keyboard actions in the Inbox and request dock.

## Reliability

- Session WebSocket updates send less repeated data. Campaign views reuse projection reads, descendant polling focuses on pending approvals, and prompt retry maintenance performs less work.
- Streamed timeline rows keep their positions as content grows. Registered Locations stay eligible after runner inventory refreshes.
- Authenticated headless updates preserve executable permissions when staging downloads.
- Wollipog refuses Codex merge requests when it cannot verify the evidence required for merge authorization.

## Install and Update

Download the desktop installer for your platform from the release assets. Existing installations can check **Settings → About** and use **Install and Restart** where supported. The desktop app links to the release page for `.deb` and `.rpm` installations.

Headless installations can run `wollipog update --release v0.38.0`. Plain `wollipog update` selects the latest stable release. The assets include desktop bundles, standalone runners, headless control-plane binaries, and the dashboard bundle.

## Upgrade and Rollback

Upgrade the control plane and its dashboard first, then update standalone and remote runners. Use matching component versions for new capabilities. Standalone owner questions and approvals require protocol v412 or later on the runner and control plane. Before upgrading, stop writers and back up the control-plane database, any separate artifact store, and runner data and configuration. Keep the previous binaries and dashboard bundle. To roll back, stop the upgraded processes, restore the backup, and start the previous binaries and dashboard.

Where archived-history retention is enabled, capable runners trim full logs after completed control-plane pruning, including for previously pruned sessions. Back up runner data or disable the policy before upgrading if you need to retain full logs. **Reprocess** cannot restore a trimmed log. Older runners refuse manifest format 2 and need the pre-upgrade runner data for rollback. [Archived-history retention](https://github.com/picoduck/wollipog/blob/v0.38.0/docs/archived-history-retention.md#runner-logs-and-upgrades)

The control plane advertises the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy identities. If an older client reports `The address is not a Wollipog control plane.`, update the client before connecting.

## Release Assets

The workflow builds all six supported native targets. The base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and `SHA256SUMS`. The signed release adds 12 updater
signatures and `latest.json` for 47 assets. Publishing the verified draft remains a manual operator step.
