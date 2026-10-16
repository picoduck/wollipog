# Wollipog v0.32.0

This release makes saved agent choices consistent across machines, shows where child models
can run, and improves keyboard navigation and transcript reading. It also strengthens managed
worktree protection on native Linux and improves provider cleanup and SSH recovery. These
notes cover changes merged since v0.31.0.

## Install and Update

Download the desktop installer for your platform from this release's assets, or use
**Check for Updates** in Settings → About. Supported desktop packages can install the update
with **Install and Restart**; `.deb` and `.rpm` installations link to the release for a manual
upgrade. This release uses the default stable update channel.

Headless installations can update after publication:

```bash
wollipog update
# To select this exact release, including in non-interactive upgrades:
wollipog update --release v0.32.0 --yes --json
```

## Upgrade and Rollback Guidance

Upgrade the control plane before standalone or remote runners, and update all components to
this release. The runner protocol remains v222, as in v0.31.0. Protocol compatibility alone
does not provide the fixes in this release; update runners to receive them.

Safari 16.4 is now the minimum supported Safari version. Browser compatibility checks also
hold emitted JavaScript to that floor, including regular-expression syntax.

On native Linux, launching a provider in a selected runner-managed worktree now requires
`bwrap`, including in Provider isolation mode. Launch fails if that boundary cannot be
established. The worktree root and Git registration are protected while its file contents
remain writable. Default build caches and provider state remain writable, but custom HOME
writes may need to move inside the worktree or another authorized scratch directory. ACP
providers in this selected-worktree Provider mode are not supported. Creating a sibling
worktree requires selecting it and relaunching before editing; Git operations that change
protected shared configuration, including setting an upstream with `git push -u`, can fail
inside the boundary. Use Wollipog's managed worktree operation to create worktrees.

Claude background work in that native Linux managed-worktree Provider mode survives ordinary
provider turns and resumes, but is killed if the runner dies or restarts; unfinished results
cannot be recovered. Other platforms and attached worktrees retain their existing boundaries.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the previous release's binaries and configuration.
If rollback is required, stop all v0.32.0 processes before restoring the backup and starting
the retained binaries. Headless upgrades verify downloads and restart services, restoring the
previous executables and dashboard bundle if verification or startup fails. That automatic
rollback does not replace a backup of application data.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients
may report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Agent Choices Across Machines

- Saved Agent Harness defaults and newly created campaigns' fixed Child Harness settings
  identify the same harness across machines, even when local agent IDs differ. Existing
  campaigns retain their original exact-agent matching behavior.
- Orchestrator settings show which connected machines support the saved Child Model and
  Effort, and warn when a model alias resolves differently between machines. Campaign tools
  expose the local agents and machine support needed to choose a valid child launch.
- New sessions use Codex App Server. Codex Non-Interactive remains available only for
  restarting existing exec sessions, rather than as a new-session choice.
- Setup, automation, campaign, and role-change errors use clearer installation and machine
  language, with fewer internal protocol numbers.

## Keyboard Navigation and Transcript Reading

- Browser Back and Forward respect unsaved editor changes, preserving the opportunity to
  save or discard work before leaving.
- The Snooze dialog supports keyboard-only selection: Enter activates a focused time tile,
  and typing begins a custom entry.
- Long composer questions scroll within the available space, keeping their answer controls
  accessible.
- Touch history gestures keep transcript following paused while reading older messages.

## Runner Reliability and Protection

- Expand managed-worktree command checks and enforce the native Linux worktree boundary
  described above. Protected Claude providers use a supervised namespace with bounded
  cancellation and cleanup, while background output remains available across provider turns.
- Keep multiline Codex authentication diagnostics out of durable stderr records and clean up
  resources owned by interrupted inference probes.
- Release skill-transaction and short-lived provider-process HOME references after their
  ownership and process-exit checks succeed. Uncertain or surviving process trees retain
  their references; foreign-owner refusals explain the recovery options more clearly.
- Recover SSH tunnel port conflicts between control planes by selecting and persisting an
  available port instead of repeatedly retrying the conflicting one.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
This release is intended for publication as the latest stable release.
