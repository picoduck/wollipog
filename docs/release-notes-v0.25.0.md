# Wollipog v0.25.0 — Parent Control, Smarter Capacity, and Faster Navigation

Wollipog v0.25.0 adds opt-in Parent Control for handling descendant questions and approvals,
expands the orchestrator preset into a practical planning environment, and makes the New Session
flow keyboard-first. It also separates active-turn and resident-process capacity, safely parks
eligible idle providers under pressure, and improves recovery when background or descendant work
loses its expected result.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v133 to v136 through additive, capability-gated messages. Current runners are required for
durable missing-result recovery, multidimensional capacity reporting and idle-process parking, and
Parent Control of descendant requests. Older runners remain connectable but omit these capabilities
and fail closed when delegated resolution would require protocol-v136 identity and provenance.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.24.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.25.0 processes before restoring the backup
and starting the retained binaries.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Parent Control and Orchestration

- Let a human explicitly allow a supervising session to answer descendant questions, or questions
  and approvals, without giving child sessions authority to enable or broaden that delegation.
- Bind every delegated request to a control-plane occurrence identity and record which parent
  resolved it, preventing reused provider request IDs from targeting the wrong prompt.
- Harden descendant discovery, request polling, runner-offline handling, and late-resolution races
  so lost or terminal work fails closed instead of hanging the parent indefinitely.
- Expand the orchestrator preset with read-only project context, live web research, bounded shell
  inspection, GitHub issue coordination, and session-private scratch space while keeping project
  writes and implementation tools unavailable.

## Capacity and Resumable Sessions

- Separate Active Turns, Resident Process Units, Retained Resumable Sessions, and Parked Sessions
  so operators can see the resource that actually blocks new work.
- Add an optional active-turn limit spanning foreground turns and runner-authoritative detached
  work, while leaving durable retained-session capacity explicitly unlimited.
- Add opt-in `park_when_needed` behavior that retires the oldest eligible idle provider process
  when resident capacity is needed, then safely resumes its established provider conversation.
- Keep approvals, questions, authentication recovery, background work, queued commands, shells,
  and unresumable providers protected from pressure parking.
- Bound high-cardinality capacity diagnostics while retaining actionable examples for every
  represented blocker and accounting for omitted waiters.

## Keyboard-First Sessions and Inbox

- Turn New Session into a keyboard-first form with unified searchable Project and Agent choices,
  predictable Enter behavior, stable focus, and clearer selection state.
- Keep Active and Snoozed Sessions mutually exclusive while leaving urgent snoozed requests visible
  and actionable in the Snoozed view.
- Add session pin actions to context menus, tighten selection and touch affordances, and hide
  desktop-only shortcuts on mobile.
- Scope numeric and bare-key shortcuts to the Sessions grid, reveal selected Inbox rows after
  collapsing groups, and recover focus after keyboard navigation.

## Recovery, Providers, and Worktrees

- Record a durable terminal boundary when an accepted background continuation ends without a
  complete assistant result, keeping audit evidence separate from the user's acknowledgement.
- Stabilize provider account identity across recovery and preserve exact background and descendant
  request ownership through reconnects.
- Harden Seatbelt additional-root canonicalization and attach notices across symlink retargeting.
- Bound missing-upstream pull-request discovery, cron timezone searches, timezone caches, and hung
  descendant request polls.

## Operator Experience and Reliability

- Add concise `wollipog doctor`, `wollipog update`, and `wollipog pair` aliases plus topic-oriented
  `wollipog help` guidance for common host-management workflows.
- Improve colour-scheme, font, geometry, session-board, capacity, Parent Control, and mobile Inbox
  coverage across unit and browser tests.
- Upgrade React Markdown, Playwright, Node types, WebSocket, Tauri, Tokio Tungstenite, Serde, UUID,
  libc, and related desktop dependencies.

Desktop bundles remain unsigned, so operating systems may show an unidentified-developer warning
on first launch. The release workflow builds all six supported native targets. Its final
verification fails unless the draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`, with canonical and compatibility runner names verified byte-identical, each headless
control plane verified byte-identical to its desktop sidecar, and GitHub publisher digests matching
the manifest. Publishing the verified draft remains a manual operator step.
