# Pod orchestration controls

Roadmap slice 9.3 adds bounded automatic coordination on top of the durable pod context log. It
does not give agents a second transport or shared filesystem. The control plane remains the only
relay, every member stays in its isolated worktree, and every automatic wake is an ordinary durable
session turn.

## Roles and arbitration

Each member has a durable `lead`, `worker`, or `reviewer` role plus an optional context-budget
override. New pods assign the oldest/first member as lead and every other member as a worker; legacy
pods migrate the oldest surviving member to lead deterministically. Roles and budgets cannot change
while an automatic cycle is running.

The policy offers four explicit modes:

- `manual` preserves the phase-1/2 behavior and never wakes a member automatically;
- `round_robin` advances through durable membership order and may start at an explicitly selected
  member;
- `lead_driven` starts at the single lead, alternates every non-lead result back through the lead,
  and rotates workers/reviewers after each lead turn;
- `event_triggered` starts at an explicitly selected non-lead, wakes the single lead when that
  member settles, then pauses for a human after the lead's decision turn.

Lead-driven and event-triggered policies require exactly one lead. Automatic cycles also require an
idle, online, non-terminal member with an active isolated worktree and no pending human decision.
Manual relay is disabled while a cycle is running so an operator cannot accidentally overlap two
control-plane turns.

## Per-member context selection and summaries

Every member stores the highest pod-context sequence represented in a successfully delivered
automatic prompt. The next prompt reads only newer entries, using a bounded 500-entry scan. Newest
entries receive exact JSON records; older entries are represented by a deterministic range/count
summary plus as many newest attributed excerpts as fit in the summary reserve. A truncated database
window is still represented by its complete sequence range before the member cursor advances.

Budgets are conservative across heterogeneous providers: one UTF-8 byte counts as one estimated
token. The pod default and per-member overrides range from 4,096 to 32,768 estimated tokens, so the
largest automatic prompt is also bounded at 32 KiB. Summary space is independently bounded and
cannot exceed half the prompt budget. JSON string escaping keeps header-shaped member output inside
its real attributed content field; manual relay now uses the same unambiguous record shape.

## Durable lifecycle and stop conditions

`pod_orchestration` stores the active policy and cycle state. `pod_orchestration_steps` records every
dispatch before delivery, exact target/trigger identity, selected context ids, summarized sequence
range, estimated tokens, captured output entry, status, and error. A delivered member output is
server-copied into the immutable huddle log before the step settles.

Automatic advance stops or pauses on every explicit boundary:

- the configured 1–100 turn cap;
- the configured 2–5 occurrences of an exact Unicode-normalized output in one cycle;
- terminal members, missing membership/worktrees, offline runners, or delivery failure;
- a settle-time governance/approval card, after preserving the completed output;
- event-triggered lead completion, pod closure/membership loss, or operator stop;
- control-plane restart while a dispatch is uncertain.

A restart never replays an uncertain prompt. It marks the in-flight step failed and pauses the cycle
for an explicit human restart. Stopping auto-advance does not cancel a turn that already reached a
runner; that member can finish normally and its latest result can still be shared manually.

## Remaining pod boundary

Phase 4 shared-workspace collaboration remains separate. Roles and message arbitration do not grant
filesystem concurrency. A reviewed lock/lease protocol or isolated-worktree merge/reconcile design
must land before multiple pod members can edit one workspace.
