# Wollipog v0.17.0 - Round 2 Dogfooding Release

Wollipog v0.17.0 delivers the complete second dogfooding implementation round. It focuses on
durable transcript reading behavior, clearer high-frequency controls, exact Settings navigation,
and capability-gated Git visibility for both linked worktrees and primary repository sessions.

## Upgrade and Rollback

Upgrade desktop, control-plane, and standalone runner components together when practical. Protocol
v76 is rolling-upgrade-safe: older peers continue to use the legacy Git presentation, while v0.17.0
peers expose richer runner-observed facts. Primary-checkout Git mutations remain deliberately
disabled; only read-only status and summary operations are enabled outside linked worktrees.

Use v0.16.0 as the supported rollback release. The compatibility windows documented for v0.16.0
remain active: canonical and legacy runner asset names are still published, existing legacy
credentials and data roots remain readable at their established boundaries, and the repository,
bundle identifier, SSH-managed path, and `.agent-manager` data root are unchanged.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Remote-pairing
users on
v0.14.0 or earlier must upgrade the desktop before connecting to a v0.17.0 control plane;
otherwise the older desktop reports `The address is not a Wollipog control plane.` Existing
v0.16.0 clients and runners remain within the supported rolling-upgrade window.

## Transcript Reading and Navigation

- Restored stable Inbox preview paging and follow ownership so manual reading is not stolen by
  incidental layout, focus, or asynchronous history changes.
- Restored incomplete-history anchors across pagination and session changes, including deterministic
  nearest-event fallback when an exact event no longer exists.
- Added explicit Page Up, Page Down, and follow-latest shortcut hints across preview and expanded
  transcript modes, with consistent `Shift+G` and `End` behavior.
- Added a global **Shift+,** Settings shortcut and exact Escape return to the originating Inbox,
  Session, Project, or Usage route, while preserving input, IME, terminal, and nested-layer ownership.

## Interface Fixes

- Inset Session header actions from clipping boundaries at desktop and narrow widths.
- Show Usage buckets newest first through both database and presentation contracts.
- Separate editor preference selection from the explicit launch action and preserve focus during
  asynchronous launches.
- Keep flipped menus anchored to their triggers, including compact instance selection and short
  viewport behavior.
- Align Theme, Colour Scheme, and Density selectors on one value axis, with readable bounded menus
  and genuine Win32/Linux visual baselines.
- Stabilize Inbox title alignment independently of sender length and trailing activity signals.
- Clarify Project visibility consequences for new sessions, parallel runs, workflow workers, and
  organization-visible Conductor sessions without overstating later filing behavior.
- Present Claude permission modes and hook-governed outcomes truthfully, including active Plan and
  defensive Manual states.

## Git Visibility

- Added protocol v76 repository facts for exact primary or linked roots: branch and detached state,
  upstream and default-base divergence, staged/modified/untracked/conflict counts, repository
  operation, worktree kind, shallow/unborn state, and bounded shared remote-ref freshness.
- Added compact composer status and a pinned Git section with truthful loading, updating, failure,
  offline, unavailable, and non-repository states. Legacy clients retain their existing rendering.
- Added explicit **Refresh Git Status** without fetching. Remote freshness describes observed shared
  remote refs, not proof that a fetch occurred or that every remote is current.
- Added a visible-session, idle-only 60-second local status cadence for expanded sessions on
  protocol-v76 runners. Polling pauses while a turn is queued, starting, running, or awaiting input;
  hidden, offline, archived, and terminal no-repository sessions do not poll. Manual refresh still
  updates status plus pull-request/check summaries.
- Bounded review-queue Git summaries by execution path with rotating samples, typed terminal states,
  fail-closed porcelain handling, and exact repository-root authority.

## Deliberate Boundaries

Ignored-file counts remain deferred to avoid an expensive ignored-file scan. The app does not run
automatic `git fetch`, install filesystem watchers, or claim immediate mid-turn Git events. Dirty
categories may overlap and must not be summed as a unique file total. Desktop bundles remain
unsigned, so operating systems may show an unidentified-developer warning on first launch.

The release workflow builds all six supported native targets, publishes canonical and legacy runner
names, verifies each pair is byte-identical, and checks native `--version`. Its final job fails the
run unless the draft holds exactly 27 assets: 14 desktop bundles, 12 runner names, and
`SHA256SUMS` with publisher digests matching that manifest. Publishing the verified draft remains a
manual operator step.
