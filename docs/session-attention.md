# Session Follow-Up

Session list views carry a versioned `attention` projection from the control plane. It contains
human-owned action occurrences with canonical request ranks and stable occurrence times, meaningful
work time, the latest live result revision and its owner, and the receiving user's exact result
acknowledgment. Sorting never loads transcripts. Lifecycle, unread state, stalls, and board placement
remain independent.

The default order is Needs Your Input, Ready for Review, Working, then Quiet. Requests use canonical
priority and oldest occurrence first; results use newest result first; Working and Quiet use newest
meaningful work time and session ID. Pins lead within a group. Families stay parent first and use
their strongest human follow-up; due reminders surface below concrete human input. Existing snooze
visibility, wake rules, and interaction-held ordering remain in force.

Only live top-level final agent output, or a response-completed boundary following live streamed
output, creates a result. Tool events, deltas, heartbeats, historical imports and transcript cache
hydration do not create review work. Live history-gap receipts use the same durable revision as
subsequent projection, and replay cannot replace a newer result. Status transitions, final output,
user instructions and request occurrences advance meaningful time; repeated snapshots do not.

`POST /api/sessions/:id/result/acknowledge` requires a visible session, an authenticated human and the
exact current result revision. The database compares that revision while writing the acknowledgment
for the current user. Body-supplied identities are ignored. Accepted human prompts and steering
instructions may carry `reviewedResultRevision`; a concurrent new result cannot be consumed by the
old revision. Opening a session or changing unread state does not acknowledge it. Shared mutation
responses omit the viewer's acknowledgment, so clients preserve their last scoped value until a
fresh scoped read or live update replaces it.

Descendant results belong to the outermost durable Orchestrator until an explicit exact-revision
handoff. The controller's session credential or its human owner may invoke
`POST /api/sessions/:id/result/handoff`; the CLI exposes `session handoff-result ID --revision REV`
and MCP exposes `handoff_session_result`. A newer report needs another handoff. Human-owned requests
and escalations continue to follow existing durable request ownership. Recoverable child failures
remain controller work unless explicitly escalated. These operations change presentation only:
they never grant execution permission, resolve a request, or consume an approval.

The additive migration creates empty durable projection, receipt and per-user acknowledgment tables.
Existing transcript history is deliberately not backfilled into outstanding results; old sessions
start with no presumed review work and creation time as a stable recency fallback. Reloads and
transcript-cache replacement retain live results and acknowledgments. Explicit transcript reprocessing
resets the projection. Older peers lacking the summary use pending request ownership and lifecycle
conservatively, without interpreting idle/Review placement as a result or fetching transcripts.
