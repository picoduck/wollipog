# Wollipog v0.35.0-rc.2 — Release Candidate

This second candidate for v0.35.0 builds on rc.1 with account recovery, campaign controls,
GitLab issue tools, and session browsing and lifecycle fixes. These notes describe changes
since v0.35.0-rc.1; see the [first candidate notes](https://github.com/picoduck/wollipog/releases/tag/v0.35.0-rc.1)
for the earlier v0.35.0 changes.

## Install the Prerelease

Download the desktop installer for your platform from this release's assets. To receive
prerelease update offers in the desktop app, enable **Pre-Release Updates** in Settings → About.
This preference defaults off, including after installing a prerelease manually.

Headless installations can select this exact release after publication:

```bash
wollipog update --release v0.35.0-rc.2
# For non-interactive upgrades:
wollipog update --release v0.35.0-rc.2 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate
does not replace v0.34.0 as the latest stable release.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol advances beyond v228, which v0.34.0 used. New review,
campaign, recovery, and retention features require compatible runners; updating only the
control plane does not supply runner capabilities or install a reviewer.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.35.0-rc.2 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

**Runner-log retention changes in this candidate.** Organizations with archived-history retention
already enabled automatically trim capable runners after completed control-plane pruning,
including sessions pruned before the upgrade, without a new switch or another 24-hour arming
delay. Off remains off. Preserve a runner data backup or disable the organization policy before
upgrading if full logs must be retained. Reprocess cannot restore a trimmed full log. Manifest
format 2 is intentionally refused by older runners: rollback requires stopping the runner and
restoring pre-upgrade runner data with the old binaries. See
[archived-history retention](https://github.com/picoduck/wollipog/blob/v0.35.0-rc.2/docs/archived-history-retention.md#runner-logs-and-upgrades).

Managed provider profiles retain their compatibility boundary: a profile-bearing HOME cannot
be used by a control plane older than protocol v225. Adoption and access grants remain explicit;
recovering a lease does not authorize another control plane to use the account.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients
may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Accounts and Provider Sessions

- Set up managed provider profiles and recover existing profiles from refused sessions. Busy
  provider accounts can wait for availability, and recovery is offered from refused agent TUIs.
  Device-code sign-in cards include **Copy Device Code**.
- Copy an existing Codex API-key sign-in into a new managed profile. Removing an account explains
  that the stored sign-in is retained.
- Restarted Claude sessions resume conversations. Ordinary agent TUIs use the session's provider
  account, structured sessions lease the provider HOME where the provider writes, and account
  configuration publications are fenced against competing writers.
- Codex children can run commands when their sandbox cannot nest inside the runner's sandbox.
  Provider compatibility includes Pi 1.4.0 RPC handling and updated Codex request handling.

## Campaigns and Reviews

- People can change a running Orchestrator's child harness, model, effort, follow-up threshold,
  and completion settings. Personal reviewer choices and round budgets can be configured.
- Campaign tools support closing and scoping GitLab issues; review sessions support GitLab merge
  requests. Legacy review jobs have been retired in favor of review sessions.
- Full Control handles eligible closure and implementation questions without waiting on its own
  unanswered questions. Human scope changes and revocations remain enforced. Follow-up publication
  and closure checks bind prompt identity and content and recheck forge state.
- Codex review sessions exclude repository skills. These changes do not establish unattended
  Full Control production readiness; complete execution and evidence paths still need verification.

## Session Browsing and Lifecycle

- Archived Sessions uses a search-first toolbar, a filters sheet, and fixed two-line rows.
  Returning from a session restores the archive browsing context.
- Touch screens regain one-tap copying of user messages. Session previews center transcripts like
  open sessions, and full-area empty states are centered in the space they fill.
- Worktree switches show their relaunch state and automatically continue the session afterward.
- Handoff holds show outstanding work, start times, and full counts, exclude ended jobs, and offer
  **Proceed Now**. Terminated background jobs remain ended after provider relaunch.
- Side chats stay alive until their first message and stop when their parent is archived.
- Sessions record who launched them so per-user settings and budgets apply. Artifact upload
  preferences also apply to personal-organization sessions.

## Reliability and Dependencies

- Runner registration avoids full session scans, batches queued runtime updates, and commits
  heartbeats without a WAL flush, reducing database work on frequent runner activity.
- Secret fields stay out of the DOM, and password controls reject value props. Dependencies
  include patched transitive fast-uri and zod releases plus Tauri updates.
- Shared SSH reconnect handling, bounded bundled-runner setup waits, and clearer rejected async
  question feedback improve recovery and diagnostics.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is intended for publication as a prerelease, never as the latest stable release.
