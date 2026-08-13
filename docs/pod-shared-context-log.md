# Pod shared context log

Roadmap slice 9.2 gives each collaboration pod a durable huddle transcript. It follows the session
event-log pattern one level up while keeping the control plane as the relay and every member in its
own runner-owned worktree.

## Immutable entry model

`pod_context_entries` assigns a monotonically increasing sequence inside one SQLite immediate
transaction. Each entry stores bounded UTF-8 content and a frozen source record:

- human notes retain the authenticated device id (or `local` for the authenticated local-bootstrap
  principal);
- member output retains session id, title, agent label, and the exact first/last source sequence;
- source session rename or deletion cannot rewrite or erase the copied attribution;
- selecting the same member output range again is idempotent.

The control plane accepts member output only after its turn settles. It copies top-level
`agent_message` content after the latest user turn directly from durable session events; browsers
cannot forge another member's output or attribution. Notes and member outputs are capped at 64 KiB.

## Hydration and live delivery

`GET /api/pods/:id/context` returns the newest bounded page in ascending display order. A stable
`beforeSeq` cursor loads older pages, up to 200 entries per request. Newly appended entries stream
as `pod_context_entry` websocket deltas and merge by immutable id/sequence. The web store retains
context only for the open pod, avoiding a portfolio-wide transcript cache.

## Context relay and receipts

A relay may contain a new human note, up to 16 explicitly ordered log entries, or both. The service
verifies every entry belongs to the pod, bounds the composed prompt at 32 KiB, and preflights all
targets before writing the note or sending a prompt. The existing worktree, terminal, guardrail,
membership, and runner-liveness checks remain intact.

Runner delivery is not a distributed transaction. If a socket disappears between member sends,
the response records one `delivered` or `failed` receipt per exact target and returns every
successfully updated session. The huddle note remains durable, so the operator can retry only the
failed target instead of unknowingly duplicating successful turns.

## Deliberate next boundary

This slice is explicit and human-directed: it never automatically copies agent output or wakes a
member. The follow-up `codex/pod-orchestration-controls` slice adds roles, arbitration, conservative
per-member token ceilings, deterministic attributed summaries, exact-output loop detection, and
durable stop caps on top of this log. Shared-workspace editing still waits for a reviewed locking or
merge/reconcile design.
