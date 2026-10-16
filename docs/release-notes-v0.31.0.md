# Wollipog v0.31.0

This release adds bounded campaign authority and allowances, live Claude usage for budget
controls, pull-request waiting without model turns, and a reorganized Settings experience.
It also improves session recovery, transcript reading, background-work status, and runner
reliability. These notes cover changes merged since v0.30.0.

## Install and Update

Download the desktop installer for your platform from this release's assets, or use
**Check for Updates** in Settings → About. Supported desktop packages can install the update
with **Install and Restart**; `.deb` and `.rpm` installations link to the release for a manual
upgrade. This release uses the default stable update channel.

Headless installations can update after publication:

```bash
wollipog update
# To select this exact release, including in non-interactive upgrades:
wollipog update --release v0.31.0 --yes --json
```

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol advances from v213 in v0.30.0 to v222. Older runners may
lack capabilities required for campaign authority, work-item assignment, live usage, and
pull-request waiting; upgrade them before using those features.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.31.0 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients
may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Campaign Authority, Allowances, and Agent Tools

- Eligible Full Control campaigns can resolve bounded workflow decisions within the human's
  recorded authorization. Issue scope, follow-up publication, and issue closure retain exact
  resource checks and typed decisions. Authentication, secrets, persistent permissions,
  governance changes, and unresolved mandatory human rules remain human-controlled.
- Campaign allowances persist across restarts and account for controlled native reviews.
  Failed child creation releases reservations, including failures while preparing prompt images.
- Record a child's campaign work item when it is created, so its attempt and assignment are
  available before the first prompt. Read-only descendant decision inspection and steering
  recovery give Orchestrators more useful evidence when supervising children.
- Wake Orchestrators for actionable campaign events with enough detail to act, and supervise
  campaigns through continuations instead of repeated model-driven polling.
- Agents, including Codex sessions, can wait for required pull-request checks and merge-queue
  outcomes without spending model turns. A rebuilt merge group keeps the wait active until
  GitHub reports the final queue outcome.

These controls do not grant unrestricted issue or merge authority. Availability depends on
compatible components and the recorded campaign policy; installed workflows and human approval
requirements still apply.

## Live Usage and Budget Controls

- Stream Claude Code usage during a running turn and account for interrupted turns. Session,
  daily, and campaign cost budgets and checkpoints can use the live estimate instead of waiting
  for the turn to finish.
- Interrupt a running Claude turn when its live estimate crosses the applicable budget.
- Preserve cached-input token buckets in runner snapshots so catch-up pricing is accurate,
  and label whether session token totals include cached input.

## Settings and Navigation

- Browse Settings through a selected section navigation, compact link tabs, and a phone section
  index. Sections use consistent bordered groups and setting rows with clearer control alignment.
- Find keyboard controls under Behavior → Input, alongside Transcript, Privacy, Agent Defaults,
  Session Titles, and Evidence. Existing keyboard links redirect to the new location.
- Edit each agent's defaults in a small dialog with one Save action. Set up agents and custom
  endpoints in dialogs with inline validation, and choose the session title source in one select.
- Save Orchestrator defaults from a save bar that appears when something changes, with errors
  shown beside their settings. Unavailable child-model choices explain the machine requirement.
- Edit navigation with fixed columns and a Show switch. Appearance groups display controls
  consistently, hides Sessions Layout on phones, and explains that motion follows the system.
- See the server used by this window in Network, copy its address, and follow the Instances link.
  About presents the Wollipog version, component version rows, Copy Version Info, and one desktop
  update status block with its primary action.
- Notifications explain blocked and enabling states. Experimental settings explain what turning
  a feature off does, including on phones. Failed setting switches retain focus while retrying,
  and number fields display five-digit values beside their units.

## Sessions, Transcripts, and Recovery

- Session rows and Board cards omit transcript previews and place the family chip beneath the
  status badge. Family working counts remain visible in medium-width lists.
- Ready for Review appears after a session stops working. Required answers are distinguished
  from reviewable results, and blocked background results are reported after their turn ends
  and the handoff allowance expires.
- Recover interrupted sessions after transient provider failures, see classified provider errors
  and exhausted background retries, and hold automatic turns after repeated identical rejections.
- Restore Codex steering from asynchronous answers, preserve long approval context, and keep
  rejected answers answerable. Turns wait until the Codex thread exists; initialization, fork,
  and archive requests have bounded waits.
- Load earlier history even from short transcripts, recover Jump to Latest after an empty opening
  race, and open new sessions without snapshot mode. Automatic diff expansion stays bounded when
  choosing files, and dismissing the Sessions skill notice preserves keyboard focus.
- Pause hidden dashboard polling, back off reconnects, and clear recovered automation polling
  or refresh errors, including refresh failures after an accepted write.

## Runner and Release Reliability

- Bound default session-event reads and migrate callers that previously requested unpaged history.
  Pace UI subscription updates under the server budget and retain bounded reconciliation diagnostics.
- Validate metadata-cache file identity, tolerate lease publication staging races, and close
  database connections when startup counter or child-charge initialization fails.
- Linux release builds move to Ubuntu 24.04 hosts while retaining a pinned Ubuntu 22.04 build
  userland, glibc 2.35 baseline, and WebKitGTK 4.1. Native compatibility checks cover both x64 and
  ARM64 packages; this host migration does not raise the Linux runtime baseline.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is intended for publication as the latest stable release.
