# Wollipog v0.33.0

This release adds optional archived-history pruning, guided HTTPS remote access, and code
review through the session's runner. It also improves campaign recovery, session status,
composer history, and mobile questions. These notes cover changes merged since v0.32.0.

## Install and Update

Download the desktop installer for your platform from this release's assets, or use
**Check for Updates** in Settings → About. Supported desktop packages can install the update
with **Install and Restart**; `.deb` and `.rpm` installations link to the release for a manual
upgrade. This release uses the default stable update channel.

Headless installations can update after publication:

```bash
wollipog update
# To select this exact release, including in non-interactive upgrades:
wollipog update --release v0.33.0 --yes --json
```

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol advances from v222 to v223. Runner-mediated session code
review requires compatible components and an installed supported reviewer; updating only the
control plane does not provide it.

Codex Non-Interactive (`codex exec`) is retired. Existing sessions using that driver remain
readable, but cannot start, resume, or restart. Start a new session with Codex App Server to
continue. Runner configurations that explicitly select the retired driver must change to
`codex-app-server`.

Archived-history retention remains off by default. If enabled, it permanently removes older
archived transcript detail from the control plane after the configured threshold and a
24-hour delay. Review the preview and keep backups before enabling it. This is separate from
runner-side transcript storage.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.33.0 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients
may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Archived-History Retention

- Settings → Storage lets organization owners and admins enable Prune Archived History,
  choose a threshold from 7 to 3650 days, and preview eligible sessions before saving.
  Enabling pruning or shortening its threshold starts a 24-hour delay.
- Pruning keeps session records, prompts, final responses, usage evidence, and campaign-report
  proofs while removing older transcript detail, search rows, and eligible payload blobs.
  The archive and transcript explain when history has been pruned.
- Host operators can set an environment default; an organization's saved setting overrides it.

## Secure Remote Access

- Set Up Remote Access in Settings → Network, or `wollipog admin remote-access setup`, guides
  Tailscale Serve or existing HTTPS reverse-proxy setup, verifies this instance and its live
  connection, and saves the complete address for pairing links and QR codes.
- Existing listeners are preserved. Tailscale setup requires installed, signed-in tools and
  permission to manage Serve; it does not enable Funnel or change existing HTTP bind settings.
- Open Secure Dashboard preserves the selected session path when leaving an old HTTP bookmark.
  The HTTPS origin may need a fresh pairing link; saved desktop credentials are not migrated.

## Code Review and Campaign Recovery

- Sessions can request and inspect a cross-model review through their runner, including from
  provider sandboxes that cannot launch the review controller directly. Reviews bind the
  session's own open PR to its pushed head and return the report and ledger for adjudication.
- For Full Control campaigns, Campaign Status exposes durable, bounded recovery instructions
  and actionable exceptions. Unknown outcomes require inspection of the original receipt before
  retrying; recovery does
  not reset review limits, grant authority, or bypass human decisions.
- Orchestrator families remain active while child work is unsettled. Full Control preferences
  and preflight explain missing prerequisites; production launch remains blocked until the
  complete execution, review, media, evidence, and managed-usage path is verified. This release
  does not establish unattended Full Control readiness.

## Session Usability

- Press M in Sessions or session reading to mark a result reviewed. Ready for Review uses a
  dedicated purple status tone, and priority and resumed-session status stay current.
- Composer recall can retrieve prompts from transcript pages that have not been loaded.
- Mobile question cards have collapsed and fully expanded states, with clearer access to the
  full question and its answer controls.
- Child-session tools report each agent's supported permission modes and explain rejected
  mode choices. Agents receive shell-specific guidance, including zsh quoting rules.

## Runner Reliability

- The injected CLI can reach its runner through a FIFO relay from Codex's network-disabled
  sandbox, preserving the existing session-scoped management boundary.
- Historical Claude TaskStop receipts are reconciled with recovery guidance when background
  work has stopped but its recorded state is stale.
- Release more session, fork, Claude Code, ACP, and Agent TUI provider HOME references only
  after the owning process tree's exit is proven. Uncertain trees retain their references.
- Tighten managed-worktree command checks for heredocs and ancestor-path allowances, and keep
  same-head pull-request CI runs from cancelling each other.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is intended for publication as the latest stable release.
