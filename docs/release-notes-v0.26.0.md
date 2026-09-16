# Wollipog v0.26.0 — Durable Recovery, Verified Agents, and Clearer Requests

Wollipog v0.26.0 makes Orchestrator wake-ups and approved merge reconciliation durable across
restarts, preserves prompts through provider authentication recovery, and verifies configured
agents before offering them for new work. It also shows active subscription accounts, improves
request and evidence-review surfaces, and adds faster, safer reminder scheduling.

## Upgrade and Rollback Guidance

Upgrade the control plane before upgrading standalone or remote runners. Runner protocol advances
from v148 to v154 through additive, capability-gated messages. Current runners are required for
durable campaign continuations, restart-safe workflow-action reconciliation, active subscription
account labels, and evidence-backed agent availability. Older runners remain connectable but omit
these capabilities and fail closed where durable proof or verified availability is required.

Before upgrading, stop Wollipog processes that share a mutable data directory and back up the
control-plane database and runner data. Retain the v0.25.0 binaries and configuration as the
rollback baseline. If rollback is required, stop all v0.26.0 processes before restoring the backup
and starting the retained binaries.

The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may
report `The address is not a Wollipog control plane.` and must be upgraded before connecting.

## Durable Orchestration and Merge Reconciliation

- Resume idle Orchestrators when durable campaign events add work, using idempotent continuation
  commands with bounded retries, missing-result recovery, and monotonic database ordering.
- Reconcile an exact approved pull-request merge that already succeeded without replaying the
  command, using provider history, runner receipts, and independent forge proof of the approved
  head.
- Preserve reconciliation evidence across runner, session, and App Server restarts through ordered
  durable events and a narrowly validated Codex rollout fallback.
- Keep runner-owned and provider-owned turn identities distinct, translate persisted history
  coordinates through the negotiated projection, and share one replay fence across live and
  recovered consumption.
- Fail closed on stale policy, changed ancestry or authority, mismatched heads, failed or duplicate
  commands, wrong ordering, ambiguous history, mixed versions, or reused evidence.

## Authentication and Prompt Recovery

- Preserve known-undelivered prompt text, image references, slash commands, configuration, and FIFO
  position while provider authentication is blocked, then replay exactly once after revalidation.
- Let operators retry definitively undelivered prompts under a fresh durable identity or dismiss
  retained prompts with a tombstone that prevents later redelivery.
- Project retained authentication recovery as an actionable request even when the original command
  handles are gone, while resolving it automatically if every handle returns.
- Store provider-account evidence under a stable runner-local key rather than the rotating runner
  transport credential, with fail-closed migration and malformed-key handling.
- Capture provider-initiated Claude wake-ups without turning lifecycle-only notifications into
  stranded turns.

## Verified Agents and Subscription Usage

- Probe configured ACP agents with a bounded, side-effect-free initialization handshake in their
  declared execution context before advertising them as available.
- Distinguish Verified, Unavailable, and legacy Unverified agents with fixed content-safe guidance,
  and fail closed across session, workflow, handoff, naming, model, usage, and external-session
  selectors when availability is not proven.
- Show bounded active-account labels and correctly branded plans for Codex and Claude subscription
  sources without using those labels as identity or authorization keys.
- Keep subscription snapshots isolated by runner source, discard stale account data after account
  changes, and show account-wide Codex limits before model-specific buckets in stable order.

## Requests, Evidence, and Reminders

- Route standalone approvals into the canonical request surface while preserving request position,
  focus, worker attention, and fallback behavior across responsive layouts.
- Keep evidence-review actions reachable at every viewport without losing child-session context.
- Add keyboard-friendly reminder schedule suggestions, clearer source and validation feedback, and
  consistent preset and exact-date selection.
- Create a new reminder directly from a preserved conflict draft when the original reminder no
  longer exists.

## Reliability and Compatibility

- Accept insignificant whitespace before release assets in the POSIX runner installer while
  retaining exact asset-name and digest validation.
- Keep campaign continuation retention stable across clock rollback and prevent duplicate delivery
  after retry or restart.
- Expand control-plane, runner, browser, and integration coverage for recovery, governance,
  availability, subscription attribution, responsive requests, and reminder conflicts.

Desktop bundles remain unsigned, so operating systems may show an unidentified-developer warning
on first launch. The release workflow builds all six supported native targets. Its final
verification fails unless the draft holds exactly 34 assets:
14 desktop bundles, 12 runner names, 6 headless `wollipog-control-plane-<triple>` executables, the
`wollipog-web.tar.gz` dashboard bundle, and
`SHA256SUMS`, with canonical and compatibility runner names verified byte-identical, each headless
control plane verified byte-identical to its desktop sidecar, and GitHub publisher digests matching
the manifest. Publishing the verified draft remains a manual operator step.
