# Wollipog v0.30.0

This stable release brings the v0.30.0 candidates to the default update channel, with the
changes merged since RC2. Since v0.29.1, Wollipog gains a redesigned Skills library, clearer
session lists and request cards, Campaign Status, more flexible terminals, and improvements
to streaming, runner reliability, costs, and headless upgrades.

## Install and Update

Download the desktop installer for your platform from this release's assets, or use
**Check for Updates** in Settings → About. This release is offered on the default stable
channel and is newer than both v0.30.0 release candidates. Supported desktop packages can
install it with **Install and Restart**; `.deb` and `.rpm` installations link to the release
for a manual upgrade.

Headless installations can update to the latest stable release after publication:

```bash
wollipog update
# To select this exact release, including in non-interactive upgrades:
wollipog update --release v0.30.0 --yes --json
```

**Pre-Release Updates** in Settings → About remains an optional desktop preference, off by
default. Enabling it allows future prereleases as well as stable releases; it is not required
to receive v0.30.0. Headless installations can select an explicit prerelease tag with
`wollipog update --release <tag>`.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol advances from v192 in v0.29.1, v195 in v0.30.0-rc.1, and
v212 in v0.30.0-rc.2 to v213. Older runners may lack capabilities required by new features;
upgrade them before using those features.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.30.0 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients
may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Sessions, Requests, and Transcript Reading

- Browse Sessions with consistent rows, group tabs, search counts, and an optional Preview Right
  layout on wider screens. Pinned sessions appear first within each list. The phone Board shows
  one column at a time and opens on the first column that needs attention.
- Load the Inbox with less startup JavaScript by loading secondary views and dialogs when opened.
  On phones, arriving notices keep the top session rows in place instead of pushing them down.
- Answer questions, permissions, policy requests, and workflow decisions on request cards docked
  above the composer. Step through question forms, enter custom answers, expand long questions,
  and return to where a question was asked. Recover eligible non-secret question drafts and
  completed steps across reloads.
- Keep the question header visible after collapsing a long question, preserve other saved drafts
  when one answer exceeds the storage budget, and keep question controls clear when More Requests
  is open.
- See who resolved a question, permission, or sign-in request in Decision History. Review UI
  evidence through named tiles or a viewer with previous and next navigation and review progress.
- Edit queued messages in the composer, see queued work as an expandable count, retry failed
  turns, and use clearer confirmations for rewind, fork, recovery, and handoff.
- Read long transcripts with steadier scroll positions, responsive streaming, and clearer work
  steps and exit codes. Session opening no longer waits for stream admission; loading, reconnecting,
  and history failures have explicit states. Authoritative recent history appears while older
  cached history hydrates.
- Return to following output with a floating **Jump to Latest** control. Transcript Markdown,
  tables, and code blocks use consistent typography and code headers.
- Use Claude's advertised slash commands and see explanations for unavailable commands. Unknown
  commands offer close matches or the option to send them as text.

## Campaign Status and Session Tools

- Track campaign work items, assignments, acceptance evidence, child verification, pull-request
  state, elapsed time, and cost in Campaign Status. Missing historical cost is identified as a
  lower bound, and stale or unavailable GitHub information is labeled.
- Convert existing sessions between Standard and Orchestrator roles and manage guardrails and
  Orchestrator controls in dedicated dialogs. Orchestrators can close GitHub issues with human
  approval.
- Open session tools in a panel that can expand to fill the content area and overlays the chat
  when space is tight. Details open as pages within the tool.
- Browse Background Work as named jobs grouped by the turn that started them. Open a job's
  detail page to inspect its status and result delivery, or stop that job after a confirmation
  that names it. Missing, blocked, pending, and lost results show a notice with the relevant action.
- Review changed files with sticky file headers, a commit bar, finding authors, and explicit line
  selection. Find files with Ctrl/Cmd+P and inspect them in a viewer with syntax highlighting.
- Browse artifacts with kind labels, previews, download menus, and clear loading or blocked-page
  states. Side Chat shows one context line, a composer with Send and Stop Turn, and clear starting,
  ended, and error states. It can insert a reply into the draft with Undo and opens with Ctrl/Cmd+;.
- Choose **Bottom Dock** or **Right Panel** in **Terminal Placement**, or move the terminal from
  its menu without restarting running shells. Terminal tabs retain scrollback and search state
  when reopened. On phones, the terminal opens as a sheet that follows the keyboard.
- Open a worker's detail page in Agents to inspect its status, facts, nested workers, activity,
  and pending request. The Agents notice counts workers who need attention and offers
  **Review in Session**. Offline active workers are shown as unverified.

## Skills, Accounts, and Navigation

- Browse Skills through linkable routes, filter consistent rows, and review attention items
  from the library overview.
- Review imports and edited copies with highlighted diffs, numbered versions, deployment impact,
  and confirmations that name the machines and agents affected. Inspect provenance and files,
  manage direct and group assignments together, and control automatic skill updates with a switch.
- Use a compact desktop layout, an optional labeled navigation rail, a labeled phone tab bar,
  and grouped search with recent sessions and commands. A pinned summary stays beside the
  transcript or opens in a drawer on smaller screens.
- Preserve Claude and Codex history across account switches, improve plugin availability across
  managed accounts, and opt in to sharing Claude project memory.
- Review working sessions before quitting the desktop app or restarting it for an update.

## Reliability, Costs, and Headless Updates

- Keep active runner replay connections alive while queued traffic is processed. History
  compaction, metadata flushes, database checkpoints, and provider-home storage work avoid
  blocking runner heartbeats. Runner session writer locks are atomic across processes.
- Preserve known earlier history through reconnects and incomplete live tails, and keep streaming
  updates from forcing unrelated session views to render.
- Correct cumulative Claude costs, recover historical cost records, and improve Codex request
  pricing and child-model attribution. Missing request pricing context is disclosed.
- Preserve skill inventories and manual sync correlation when reconciliation or connections are
  replaced, and improve Codex sign-in and launcher argument handling.
- Recover abandoned provider-home leases, keep session MCP connections available while credentials
  are pending, and recover manager hooks when a restarted session distrusts its worktree guard.
- Protect headless dashboard assets from interrupted installs and retries, separate public dashboard
  files from private data roots, and bound download staging across interrupted attempts.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is published as the latest stable release.
