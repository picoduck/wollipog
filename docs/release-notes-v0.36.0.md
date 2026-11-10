# Wollipog v0.36.0

Wollipog v0.36.0 adds session artifact previews in chat, simplifies people, teams, instance and device management, and improves campaign decisions and runner recovery. These notes cover changes since v0.35.0, including the v0.36.0 release candidates and subsequent changes through #4354.

## Install and Update

Download the desktop installer for your platform from this release's assets. Existing desktop installations can discover this stable release in Settings → About and use **Install and Restart** where supported. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication:

```bash
wollipog update --release v0.36.0
# For non-interactive upgrades:
wollipog update --release v0.36.0 --yes --json
```

Plain `wollipog update` selects the latest stable release. This release replaces v0.35.0 as latest stable.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v331; newer campaign and recovery capabilities require compatible runners. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.36.0 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.36.0/docs/archived-history-retention.md#runner-logs-and-upgrades).

Automatic launches check the effective default provider account. If it is signed out or unavailable, select a ready account explicitly or repair the default. Existing Custom campaigns from before the scope-grant upgrade may pause until their epic seed is settled; review their scope and owner questions before resuming.

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Sessions and Artifacts

- View session images and videos directly in chat, open the artifact gallery, and use swipe navigation and zoom on phones. Artifact IDs cited in agent replies become previews that open the viewer.
- See a single queued message in its own row with a one-tap **Steer** action. Touch-screen message actions list **Copy Message** once.
- Choose the session role above the new-session options. Project selection survives refreshes and session actions.
- **Retry Turn** uses session restart continuity. Async questions survive automatic review notifications.

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

## People, Teams, Instances, and Devices

- Browse people, paired devices and teams in two-line rows, each opening one management dialog. Choose access levels from choice rows, confirm suspensions, and see reasons for suspended access.
- Rename a team in **Manage Team** with one **Save Changes** action. The initial owner is named **Owner** and prompted to set their name; owners and admins can rename themselves.
- Add, edit and re-pair instances from a shared dialog. Instance rows show one status and a primary action with additional actions in a menu.
- Pair this device from a dialog, and access re-pairing and instance management from the remote-instance banner. Pairing uses one title and a step indicator; reachability messages explain when other devices cannot connect.
- Recovery screens retain navigation and identify each failure with a specific title and next step. Member-directory updates reach dashboards without reconnecting.

## Campaign Decisions and Recovery

- Scope Full Control campaigns to the issues requested in the first message. Scope changes bind and revoke only affected work, and closure checks consider children whose follow-up lineage reaches the issue.
- Support preplanned fixed-by relationships for campaign closures. These relationships supplement delivery proof and do not grant merge or closure authority.
- Requesters and controlling Orchestrators can withdraw unconsumed workflow decisions. Pending human review requests can be withdrawn without stopping a child.
- Questions that merely mention tokens or permissions can reach their owner, while plural and widening permission grants remain refused. Server-side revocations identify the system and explain the reason.
- Preserve a publication's recommendation and allow Custom roots to publish their own reviewed drafts. Diagnose and recover dirty campaign worktrees, and reconcile completed commands in the same turn.

These changes do not establish unattended Full Control production readiness or waive human-owned decisions, evidence review, or managed-usage requirements.

## Campaign Scope, Locations, and Status

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

## Changes After rc.5

- Provider accounts are grouped, with default selection in focused editors.
- Recovering a branch during an approved location switch continues its existing worktree in place. Unlaunchable placements are refused before moving, and reused worktrees retain managed protection.
- Campaign Status groups work by repository and shows merge holds. Cross-repository follow-ups, forge inspection, video evidence review, and issue closures use a location of the target repository.
- Dependent merges wait for prerequisite delivery. Merge holds bind to the pull request and approved closures; consumed merges are watched until landing, and changed closures trigger dequeueing. Same-head re-enqueues and CLI admissions reconcile against recorded merge decisions.
- Nested owner-kept decisions appear in the root's waiting list. Owners can release a slot when retirement proof cannot free it; older runners without retirement proof keep the slot held.
- Late Claude steering acknowledgments reconcile, reconnect command receipt replay is paced, and delegated image review has separate admission checks.

## Runner Reliability

- Keep SSH runner harnesses available across updates, verify replacement readiness, and bound startup and shutdown waits.
- Keep runner frames connected through brief SQLite locks and group active registration snapshots.
- Lease the runner's provider HOME for non-launch provider processes and explain refused session agent credentials.
- Recognize additional inert command shapes and inspect quoted interpreter heredocs without shell expansion.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is published as the latest stable release.
