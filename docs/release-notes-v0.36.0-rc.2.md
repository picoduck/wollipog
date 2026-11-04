# Wollipog v0.36.0-rc.2 — Release Candidate

This second release candidate for Wollipog v0.36.0 includes the first candidate and all changes merged through #4080. The additions below cover changes since v0.36.0-rc.1; see the [first candidate's notes](https://github.com/picoduck/wollipog/releases/tag/v0.36.0-rc.1) for earlier v0.36.0 changes.

## Install the Prerelease

Download the desktop installer for your platform from this release's assets. To receive prerelease update offers, enable **Pre-Release Updates** in Settings → About. This preference defaults off, including after manually installing a prerelease. Where supported, **Install and Restart** installs the offered update. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication:

```bash
wollipog update --release v0.36.0-rc.2
# For non-interactive upgrades:
wollipog update --release v0.36.0-rc.2 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate does not replace v0.35.0 as latest stable.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v283; newer campaign and recovery capabilities require compatible runners. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.36.0-rc.2 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.36.0-rc.2/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

Automatic launches now check the effective default provider account, rather than accepting any signed-in account. If the default is signed out or unavailable, choose a ready account explicitly or repair the default. Older control planes connected to a v283 runner see an unavailable default as an unavailable agent; upgrade the control plane first.

## Usage and Cost

- Explore usage by day, model, agent, machine, and person from one tab row. The chart uses a full time axis, marks periods without recorded data, avoids overlapping labels, and shows average and peak usage with accessible agent colors.
- Subscription accounts show what remains and when each limit resets. Daily budget controls and usage history move into a Budget and History dialog.
- Empty, loading, error, and missing-data views offer clearer next actions. The toolbar follows the main column width, and rate-refresh failures include details.
- Resumed Claude Code sessions use the running CLI's version for turn accounting. Turns billed only as a running total appear as uncertain in cost views.

## Sessions and Navigation

- Go to File supports fuzzy matching and retains the runner's best results. Each side-panel tool has its own keyboard shortcut.
- Orchestrator and review sessions have role icons. Nested reviews and grandchildren appear one level below their parent in the session list.
- The phone app bar uses a compact plus action. A crashed tabbed page retains its header height.
- Owners can remove a workspace from a machine.

## Campaign Decisions, Reviews, and Recovery

- Sessions can park while a pull request is queued and wake once on its outcome. Timed-out session waits return compact status, and waiting children no longer repeatedly wake their Orchestrator.
- Full Control launch scoping recognizes issue ranges and reserves derived issue capacity for target epics' members; explicit ceilings stay fixed.
- Full Control campaigns can finish with explicit handoffs. An in-scope epic can close from verified, completed members, while dispatch and merge-based closure remain restricted to authorized issues.
- Human-owned publication decisions survive repeated requests and routine pull-request activity. Refused closures explain the gap; correctable follow-up publication failures return to the requesting child.
- Full Control roots can hand retained decisions to the owner, and messages identify when Full Control dismissed an agent's question. Reviewer refusals name the configured grant involved.
- Delegated reviewers can inspect child UI evidence images. Base-branch merges no longer exhaust review rounds; Full Control extensions remain capped.
- Same-head re-enqueues reconcile merge decisions. Reassigning a work item to its existing child clears stale handoffs, and intentional worker stops are distinguished from denials during recovery.

## Runner Reliability

- Concurrent SSH runners isolate native provider discovery.
- Bounded workspace searches skip node_modules. Cleanup records replay once at startup, legacy staging inspection scales linearly, and reclaimed session command receipts retain ownership.
- Claude Code's Wollipog MCP configuration gives long waits a per-server limit. The shell guard refuses parameter operators it cannot inspect safely.
- Clean worktrees can retire when their tip was an earlier head of a merged pull request.

These changes do not establish unattended Full Control production readiness or waive human-owned decisions, evidence review, or managed review limits. This candidate remains a prerelease and does not replace v0.35.0 as latest stable.
