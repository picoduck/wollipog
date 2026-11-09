# Wollipog v0.36.1

Wollipog v0.36.1 improves child-session questions, simplifies provider account management, and recovers transient Claude reviewer discovery failures. These notes cover changes since v0.36.0.

## Install and Update

Download the desktop installer for your platform from this release’s assets. Existing desktop installations can discover this stable release in Settings → About and use **Install and Restart** where supported. `.deb` and `.rpm` installations link to the release page.

Headless installations can select this release after publication:

```bash
wollipog update --release v0.36.1
# For non-interactive upgrades:
wollipog update --release v0.36.1 --yes --json
```

Plain `wollipog update` selects the latest stable release. This release replaces v0.36.0 as latest stable.

## Child Clarifications

- Child-session clarification requests appear as questions with suggested answers and a free-text answer field, including in campaign status.
- Answers preserve access checks and validation. Answering a clarification grants no action authority; action approvals retain their existing gates.

## Provider Accounts

- Manage provider accounts in compact rows grouped by provider, with one **Add Account…** action.
- Use **Set as Default** and **Clear Default** in account menus. Defaults apply to new sessions; an explicit session account still takes precedence.
- Expand **Usage Details** for usage windows and reset times, and manage server access through **Account Access…**.
- The usage-limit switch remains independent of account defaults. Priority ordering and automatic usage balancing are not included.

## Reviewer Recovery

- Retry transient Claude capability-discovery failures automatically, with up to two additional discovery passes before normal periodic discovery resumes.
- Explain review refusals with the discovery, account, trust, or model-and-effort diagnosis. After capability recovery, retry the refused review request.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to this release. The runner protocol is v332; child clarification support requires compatible components. Updating only the control plane does not install runner capabilities or a reviewer.

Before upgrading, stop processes sharing a mutable data directory and back up the control-plane database and runner data. Retain the previous binaries and configuration. To roll back, stop all v0.36.1 processes before restoring the backup and starting the previous binaries. Headless update rollback of executables and the dashboard does not replace a data backup.

Runner-log retention remains active for organizations that have archived-history retention enabled: capable runners trim full logs after completed control-plane pruning, including previously pruned sessions. Off remains off. Back up runner data or disable the policy before upgrading if full logs must be retained. Reprocess cannot restore trimmed logs. Older runners refuse manifest format 2; rollback requires restoring pre-upgrade runner data with the older binaries. See [archived-history retention](https://github.com/picoduck/wollipog/blob/v0.36.1/docs/archived-history-retention.md#runner-logs-and-upgrades).

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is published as the latest stable release.
