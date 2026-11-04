# Wollipog v0.36.0

Wollipog v0.36.0 adds session artifact previews in chat, simplifies people, teams, instance and device management, and improves campaign decisions and runner recovery. These notes cover changes since v0.35.0.

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

Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v269; newer campaign and recovery capabilities require compatible runners. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.36.0 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.36.0/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Sessions and Artifacts

- View session images and videos directly in chat, open the artifact gallery, and use swipe navigation and zoom on phones. Artifact IDs cited in agent replies become previews that open the viewer.
- See a single queued message in its own row with a one-tap **Steer** action. Touch-screen message actions list **Copy Message** once.
- Choose the session role above the new-session options. Project selection survives refreshes and session actions.
- **Retry Turn** uses session restart continuity. Async questions survive automatic review notifications.

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
