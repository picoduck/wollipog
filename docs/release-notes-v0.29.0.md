# Wollipog v0.29.0 — Design System, Default Accounts, and Safer Worktrees

Wollipog v0.29.0 moves the interface onto one shared design system, so buttons, menus, dialogs,
tabs, tables, notices, and status badges look and behave the same across the app and on phones.
Machine owners can now choose default Claude and Codex accounts for new sessions. Managed worktree
protection, signed Automation triggers, Orchestrator campaign views, and manager policy hook
registration are also more reliable.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. The runner protocol stays at
v192, so v0.28.0 runners and control planes remain compatible with this release. Current runners are
needed for the managed worktree and policy hook fixes below.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.28.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.29.0 processes before restoring the backup
and starting the retained binaries. Default account choices saved on v0.29.0 are not applied after a
rollback.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

Desktop apps from v0.28.0 offer this release through Settings → About once it is published.

## One Design System

- Give form controls the app font and a neutral focus ring, and put buttons, inputs, selects, and
  segmented controls on one height scale with a consistent touch target.
- Build every menu, dialog, tab set, segmented control, row, and table from one shared component
  each. Dialogs open as bottom sheets on phones, and confirmations carry action titles and short
  bodies.
- Replace the title-only top bar with a page header, a single left-aligned page container, and a
  shared detail bar.
- Use one vocabulary and one badge style for every status, keep status badges from stretching
  across phone card headers, and give notices, empty states, and toasts one shared component each.
- Pause toast timers while a phone menu hides the toast stack.

## Accounts and Connectivity

- Let machine owners set a default Claude and Codex account for new sessions on each machine. A
  saved default whose account disappears stays visible as a conflict instead of silently falling
  through to another subscription.
- Add **Retry Now** to the offline banner, and show developer connection hints only in development
  builds.

## Safer Worktrees and Automations

- Refuse PowerShell `Move-Item` and its aliases when they would move a managed worktree, alongside
  the existing `mv` protection.
- Parse `env` assignment arguments correctly in managed worktree protection, and refuse commands
  whose meaning depends on ambiguous variable expansion.
- Dispatch a valid signed trigger received before an Automation's first scheduled run instead of
  leaving it pending.

## Orchestration and Governance

- List only the held children a reader can open when showing an Orchestrator's campaign, both in
  the app and in API responses.
- Re-send manager policy hook credential registrations that the control plane has not acknowledged,
  so policy hooks recover without a runner restart.

## Session Usability and Accessibility

- Keep the composer focused on the first tap of the Plan pill and attachment remove buttons, and
  keep keyboard focus in the composer when either removes itself.
- Keep the reading position when an earlier row grows while a streamed row is anchored, and keep the
  session-return anchor the only scroll owner on iOS.
- Keep the resize separator's keyboard focus visible in forced-colors mode.
- Title Case the Session, Run, Pod, and Activity placeholder headings.

The release workflow builds all six supported native targets. Its base draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`. A signed tag run adds 12 updater signatures and `latest.json` for exactly 47 assets.
The final workflow verifies inventory, signatures, byte-identical compatibility copies, and
publisher digests. Publishing the verified draft remains a manual operator step.
