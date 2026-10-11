# Wollipog v0.30.0-rc.2 — Release Candidate

This second candidate for v0.30.0 includes the changes merged since v0.30.0-rc.1:
redesigned session lists and request cards, Campaign Status, clearer review and file tools,
smoother streaming and scrolling, and improvements to runner and upgrade reliability.
It is intended for people who choose to try an early version and report problems.

## Install the Prerelease

Download the desktop installer for your platform from this release's assets. To receive
prerelease update offers in the desktop app, enable **Pre-Release Updates** in Settings → About.
This preference defaults off, including after installing a prerelease manually.

Headless installations can select this exact release after it is published:

```bash
wollipog update --release v0.30.0-rc.2
# For non-interactive upgrades:
wollipog update --release v0.30.0-rc.2 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this candidate
does not replace v0.29.1 as the latest stable release.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol advances from v195 in v0.30.0-rc.1, and v192 in v0.29.1,
to v212. Older runners may lack capabilities required by new features; upgrade them before
using those features.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.30.0-rc.2 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients
may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Sessions, Requests, and Transcript Reading

- Browse Sessions with consistent rows, group tabs, search counts, and an optional Preview Right
  layout on wider screens. The phone Board shows one column at a time and opens on the first
  column that needs attention.
- Load the Inbox with less startup JavaScript by loading secondary views and dialogs when opened.
  On phones, arriving notices keep the top session rows in place instead of pushing them down.
- Answer questions, permissions, policy requests, and workflow decisions on request cards docked
  above the composer. Step through question forms, enter custom answers, expand long questions,
  and return to where a question was asked. Recover eligible non-secret question drafts and
  completed steps across reloads.
- Keep the question header visible after collapsing a long question, and preserve other saved
  question drafts when one answer exceeds the storage budget.
- See who resolved a question, permission, or sign-in request in Decision History. Review UI
  evidence through named tiles or a viewer with previous and next navigation and review progress.
- Edit queued messages in the composer, see queued work as an expandable count, retry failed
  turns, and use clearer confirmations for rewind, fork, recovery, and handoff.
- Read long transcripts with steadier scroll positions, responsive streaming, and clearer work
  steps and exit codes. Session opening no longer waits for stream admission; loading, reconnecting,
  and history failures have explicit states.
- Use Claude's advertised slash commands and see explanations for unavailable commands. Unknown
  commands offer close matches or the option to send them as text.

## Campaign Status and Session Tools

- Track campaign work items, assignments, acceptance evidence, child verification, pull-request
  state, elapsed time, and cost in Campaign Status. Missing historical cost is identified as a
  lower bound, and stale or unavailable GitHub information is labeled.
- Convert existing sessions between Standard and Orchestrator roles and manage guardrails and
  Orchestrator controls in dedicated dialogs.
- Open session tools in a panel that can expand to fill the content area and overlays the chat
  when space is tight. Details open as pages within the tool.
- Browse Background Work as named jobs grouped by the turn that started them. Open a job's
  detail page to inspect its status and result delivery, or stop that job after a confirmation
  that names it.
- Review changed files with sticky file headers, a commit bar, finding authors, and explicit line
  selection. Find files with Ctrl/Cmd+P and inspect them in a viewer with syntax highlighting.
- Browse artifacts with kind labels, previews, download menus, and clear loading or blocked-page
  states. Side Chat shows one context line, a composer with Send and Stop Turn, and clear starting,
  ended, and error states. It can insert a reply into the draft with Undo and opens with Ctrl/Cmd+;.
- Use a terminal dock with shell tabs, search match counts, previous and next navigation, a visible
  resize grip, and scroll positions retained across tabs. Closing and reopening the dock preserves
  its terminals, scrollback, and search state. The Agents roster groups workers and shows offline
  active workers as unverified.

## Reliability, Costs, and Headless Updates

- Keep active runner replay connections alive while queued traffic is processed. History
  compaction, metadata flushes, and database checkpoints avoid blocking the event loop, and runner
  session writer locks are atomic across processes.
- Preserve known earlier history through reconnects and incomplete live tails, and keep streaming
  updates from forcing unrelated session views to render.
- Correct cumulative Claude costs, recover historical cost records, and improve Codex request
  pricing and child-model attribution. Missing request pricing context is disclosed.
- Preserve skill inventories and manual sync correlation when reconciliation or connections are
  replaced, and improve Codex sign-in and launcher argument handling.
- Protect headless dashboard assets from interrupted installs and retries, separate public dashboard
  files from private data roots, and bound download staging across interrupted attempts.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is published as a prerelease.
