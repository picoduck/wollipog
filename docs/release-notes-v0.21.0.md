# Wollipog v0.21.0 — Sessions, Skills, and Structured Interaction

Wollipog v0.21.0 makes long-running agent work easier to organize and revisit. Sessions can now be
archived, snoozed, and reopened from a paginated history; runners can receive centrally managed
agent skills; and Codex and Claude questions have richer, safer response controls. This release
also delivers extensive mobile, transcript, automation, and Stop-recovery improvements.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v84 to v91 through additive, capability-gated messages. Older runners can remain connected,
but correlated Stop recovery, expanded structured-question constraints, completion-aware reminders,
managed skills, and experiment-gated Conductor discovery require a current runner. The desktop
bundle upgrades its embedded control plane and local runner together.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.20.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.21.0 processes before restoring the backup
and starting the retained binaries. The v0.19.0 runner-ownership and legacy-adoption boundaries and
the v0.20.0 secure-transport requirements remain in force.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later
accept both the current and legacy service identities. Older clients may report
`The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Session Organization and Recovery

- Archive sessions only after a confirmed Stop, browse them through server-side pagination, and
  recover cleanly when Stop delivery or reconnect reconciliation fails.
- Snooze sessions until a chosen time or until the next authoritative agent response completes,
  with owner-scoped live updates and drafts preserved during background refreshes.
- Generate semantic session titles and distinguish lifecycle, attention, activity, and execution
  status so Inbox state is easier to interpret.
- Load earlier transcript activity automatically while preserving selection, scroll position,
  formatted response boundaries, and stable Inbox ordering.

## Managed Skills and Agent Interaction

- Manage agent skills in the dashboard and deploy the authoritative desired set to compatible
  machines, with runner-reported deployment state and fail-closed protocol gating.
- Render Codex structured questions with optional fields, free-text and secret inputs, multi-select
  cardinality, primitive format and range constraints, and explicit dismissal semantics.
- Support live Claude questions, surface rejected Stop operations, and fence delayed Stop results
  to the exact delivery attempt so stale acknowledgements cannot cross a retry boundary.
- Attach images accessibly from the composer and choose a per-device Enter-key behavior that swaps
  the Enter and modified-Enter send bindings.

## Automation, Experiments, and Mobile Usability

- Preserve automation session configuration and alternate execution targets through edits, and
  validate target configuration consistently before dispatch.
- Add an Experimental Settings section. Conductor-Led Work is now controlled solely by its
  device-local, default-off experiment setting and is advertised only across protocol v91 or newer.
- Redesign session-opening destinations and unify Inbox creation actions.
- Improve phone layouts, question scrolling, text-field focus, keyboard dismissal, transcript
  selection, status-notice interaction, Settings placement, and session action menus.

## Reliability and Release Gates

- Capture working-tree changes that race the final clean snapshot and keep Cancel resolution scoped
  to the exact structured request.
- Make asynchronous UI settling and virtual transcript measurement deterministic, including
  measurement commits before paint.
- Upgrade pinned GitHub Actions to Node 24 runtimes and retain hardened workflow permissions.

Desktop bundles remain unsigned, so operating systems may show an unidentified-developer warning
on first launch. The release workflow builds all six supported native targets. Its final
verification fails unless the draft holds exactly 27 assets:
14 desktop bundles, 12 runner names, and
`SHA256SUMS`, with canonical and compatibility runner names verified byte-identical and GitHub
publisher digests matching the manifest.
Publishing the verified draft remains a
manual operator step.
