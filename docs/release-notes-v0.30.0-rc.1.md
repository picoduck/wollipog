# Wollipog v0.30.0-rc.1 — Release Candidate

This prerelease previews the next Wollipog release, including a redesigned Skills library,
clearer session navigation, account and plugin fixes, and more reliable question delivery.
It is intended for people who choose to try an early version and report problems.

## Install the Prerelease

Download the desktop installer for your platform from this release's assets. Headless installations
can select this exact release after it is published:

```bash
wollipog update --release v0.30.0-rc.1
# For non-interactive upgrades:
wollipog update --release v0.30.0-rc.1 --yes --json
```

Plain `wollipog update` continues to select the latest stable release. Publishing this prerelease
does not replace v0.29.1 as the latest stable release.

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to this
release. The runner protocol advances from v192 in v0.29.1 to v195. Older runners may lack
capabilities required by new features; upgrade them before using those features.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.29.1 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.30.0-rc.1 processes before restoring the
backup and starting the retained binaries. Headless upgrades verify downloads and restart the
services, and restore the previous executables and dashboard bundle if verification or startup
fails. That automatic rollback does not replace a backup of application data.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Skills and Session Navigation

- Browse Skills through linkable routes, filter consistent rows, and review the library's
  attention items from its overview.
- Review imports and edited copies with highlighted diffs, numbered versions, deployment impact,
  and confirmations that name the machines and agents affected.
- See skill provenance and files, manage direct and group assignments together, and control
  automatic skill updates with a switch.
- Use a compact desktop layout, an optional labeled navigation rail, a labeled phone tab bar,
  and grouped search with recent sessions and commands.
- Read one session status in the bar, with attention first, and a pinned summary beside the
  transcript or in a drawer on smaller screens.
- Return to following output with a floating **Jump to Latest** control. Transcript Markdown,
  tables, and code blocks use consistent typography and code headers.
- Review working sessions before quitting the desktop app or restarting it for an update.

## Accounts and Reliability

- Preserve Claude and Codex history across account switches, and improve plugin availability
  across managed accounts.
- Let users opt in to sharing Claude project memory.
- Keep runner heartbeats responsive during provider-home storage work and recover abandoned
  provider-home leases more reliably.
- Improve async question answer steering, recovery of unsubmitted answers, and successive
  attention wakeups.
- Keep session MCP connections available while credentials are pending and recover manager hooks
  when a restarted session distrusts its worktree guard.
- Allow Orchestrators to close GitHub issues with human approval.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
