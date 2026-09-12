# Wollipog v0.24.0 — Capacity Controls, Safer Worktrees, and Sharper Sessions

Wollipog v0.24.0 adds live, per-machine runner capacity controls and searchable shared choices for
starting sessions. It also strengthens worktree ownership and cleanup, makes queued and background
work recover more reliably, and improves session readability across phone, tablet, and desktop
layouts.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v130 to v133 through additive, capability-gated messages. A current runner is required for
forge-verified merged-worktree cleanup, control-plane-authoritative per-machine capacity, and
attaching registered worktrees outside configured Project Locations with an explicit isolation
notice. Older runners remain connectable but omit these capabilities and their diagnostics.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.23.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.24.0 processes before restoring the backup
and starting the retained binaries.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Live Machine Capacity

- Configure runner capacity per Machine and apply revisions live without restarting the runner.
- Report active leases, queued demand, and the exact admission bottleneck so constrained Machines
  explain why work is waiting.
- Preserve capacity across registration and restart while rejecting stale revisions and invalid
  limits.
- Keep session and automation admission consistent when capacity changes during queued work.

## Faster, Clearer Session Creation

- Move Location, Harness, Machine, Workspace, and Target selection onto shared searchable choice
  controls with keyboard navigation and consistent adoption behavior.
- Carry parent Projects into agent-created and ad-hoc child sessions so related work stays grouped.
- Separate session-naming preparation from provider-generation time, preventing normal startup
  variance from consuming the naming budget.
- Keep both permission presets visible, prevent short menus from clipping on touch devices, and
  focus filtered Sessions directly from search with Enter.

## Worktree Safety and Cleanup

- Re-prove a session worktree before provider launches, shells, Native TUI access, Files browsing,
  searches, and workspace references, while sharing one fresh proof across overlapping reads.
- Attach registered worktrees even when they live outside configured Project Locations, with a
  content-free notice describing whether the live process can already write there.
- Safely discard forge-verified merged worktrees after their remote branch and local upstream are
  gone, without racing launch or metadata updates.
- Recover interrupted WSL cleanup proofs, bound alias discovery, pin orphan proof descriptors, and
  retain ambiguous filesystem state rather than deleting it.

## Recovery, Automation, and Provider Behavior

- Resume queued messages once a Stop turn settles instead of leaving accepted work stranded.
- Keep Claude background work correctly attributed across worktree rebinds and preserve
  provider-initiated turn ownership.
- Bound an undeliverable automation execution by its own cadence so one unreachable target cannot
  hold later scheduled work indefinitely.
- Clarify background delivery states and keep offline reply focus in the composer.
- Move checkpoint actions onto the turns they affect and restore readable recovery echoes.

## Responsive Sessions and Usage

- Give phone session cards a stable height, keep relative time on one line, and preserve visible
  agent identity under crowded status signals.
- Switch to the stacked session-card layout at the tablet breakpoint so branch state remains
  readable before the phone layout is needed.
- Verify the status strip against its measured width budget and center usage around live output
  with consistent provenance for free sessions.
- Derive context-window capacity in one shared place and expose Native TUI availability only when
  the runner can prove the required provider contract.

## Test and Compatibility Reliability

- Shard the browser suite across four runners and add end-to-end coverage for session choices,
  capacity, background work, attention, usage, and responsive layouts.
- Compute the production browser floor from the CSS the application actually ships, distinguishing
  required features from safe visual degradation.
- Prevent ConPTY argv tests and timer-owning DOM tests from racing their own cleanup, and keep
  UI tests from accidentally contacting the live control plane.

Desktop bundles remain unsigned, so operating systems may show an unidentified-developer warning
on first launch. The release workflow builds all six supported native targets. Its final
verification fails unless the draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`, with canonical and compatibility runner names verified byte-identical, each headless
control plane verified byte-identical to its desktop sidecar, and GitHub publisher digests matching
the manifest. Publishing the verified draft remains a manual operator step.
