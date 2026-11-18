# Wollipog v0.37.0-rc.3 — Release Candidate

This third release candidate for v0.37.0 adds Assistant threads and expands assistant management, improves campaign recovery and approvals, and simplifies navigation. These notes cover changes since [v0.37.0-rc.2](https://github.com/picoduck/wollipog/releases/tag/v0.37.0-rc.2).

## Install the Prerelease

Download the desktop installer for your platform from this release’s assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This preference defaults off, including after manually installing a prerelease. Where supported, **Install and Restart** installs the offered update. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication:

```bash
wollipog update --release v0.37.0-rc.3
# For non-interactive upgrades:
wollipog update --release v0.37.0-rc.3 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate leaves v0.36.1 as latest stable.

## Assistants and Workspace Access

- An **Assistants** section directly after Sessions provides persistent Wollipog Assistant threads, with owner confirmations shown in the thread. Destructive operations ask the owner for confirmation and include a summary of their effects.
- Assistant connections gain owner controls, delivery recovery, durable updates, and management tools for sessions, machines, workspaces, campaigns, reviews, automations, and skills. OpenClaw integration includes isolated profiles and Discord work origins. The remaining real-provider acceptance matrix is documented; this candidate does not claim complete production validation of every integration.
- Threads can create projects private to their owner. Workspace access can be chosen when adding a workspace and changed from its machine.
- Approval cards and long thread titles fit more comfortably in lists. Model pickers distinguish otherwise colliding names, and ended sign-ins have clearer recovery.

## Campaigns, Reviews, and Merge Queues

- Campaigns can pause and resume, preserve independent owner approvals across scope changes, return owner-kept resources to the Orchestrator, and complete batched follow-up approvals.
- Recovery preserves verified child reports, reconciles removed worktrees, delivers owed closure reports after roots end, and provides owner recovery after runner restarts.
- Campaign Status is collapsible and navigable. Full Control root rows show campaign state, and scope cards show settled decisions and owner classification.
- Pull request summaries and the Inbox show merge-queue state. Gated merge actions, durable CI waits, and stalled-queue notifications improve progress tracking.
- Hosted reviews use base-commit repository review criteria and support managed contributor review. GitLab diffs load through the paginated API.

## Retired Features

Pods, Workflow Runs, workflow automation actions, and Multi-Agent Runs have been removed. Use Sessions, Assistant threads, and Orchestrator campaigns for ongoing work. Existing workflow-based automations are disabled during migration, and unfinished workflow executions are marked failed. Workflow definitions and run grouping data are removed; preserve a database backup before upgrading. Bookmarks under `/pods` or `/runs` show Page Not Found with a Back to Sessions action. Retired creation tools are no longer available.

## Runner Reliability

Provider-account setup handles trusted group-writable roots and config-less runner data directories more reliably. Runner restart recovery retains process ownership and tightens survivor cleanup. Campaign continuations respect their allocations, and default campaign capacity reserves room for concurrent reviews.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v387; new campaign and provider capabilities require compatible components. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.37.0-rc.3 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.37.0-rc.3/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.

This candidate remains a prerelease. Stable v0.37.0 requires a separate version-checked build and exact-commit regression certification; changing the prerelease flag cannot graduate the signed RC packages to stable. These changes do not establish unattended Full Control production readiness or waive human-owned approval gates.
