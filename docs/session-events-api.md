# Session Events API and Migration

`GET /api/sessions/:id/events` always returns a cached page. The default `limit` is **200 events**;
an explicit limit must be an integer from 1 through 200. Forward pages return the oldest events
whose control-plane sequence is greater than `after` (default 0), in ascending order.
Omitting `limit` no longer waits for hydration or returns the entire history. Existing explicit
forward, backward and current-turn readers keep their paging semantics.

The first request may omit `eventEpoch` to read the current generation. Every subsequent request
must carry the returned `eventEpoch` to keep its cursor attached to that generation. A replaced
history returns HTTP 409 with `code: "stale_event_epoch"`; discard the collected old generation
and restart from `after=0` without the old epoch. Invalid cursors, limits and incompatible paging
options return HTTP 400 with `code: "invalid_history_page"`. Missing sessions return HTTP 404.

For a complete forward traversal:

1. Request `/api/sessions/ID/events?after=0&limit=200`.
2. Process `events` in order. Set the next `after` to `nextAfter`, and pin `eventEpoch`.
3. While `hasMoreCached` is true, request the next page immediately.
4. When `hasMoreCached` is false but `cacheComplete` is false, the cached prefix has not reached
   the runner's known tail. Wait briefly and retry from the returned cursor; an empty page retains
   that cursor. Keep a caller-owned deadline or cancellation signal, especially if the runner is
   offline. Do not treat a short or empty incomplete page as the end.
5. Stop only when `hasMoreCached` is false and `cacheComplete` is true.

Example response (the identifiers and payload are illustrative):

```json
{
  "events": [{"id": 41, "sessionId": "s_example", "seq": 200, "ts": 1, "payload": {"kind": "agent_message", "text": "Example"}}],
  "eventEpoch": 3,
  "nextAfter": 200,
  "hasMoreCached": true,
  "cacheComplete": false
}
```

The cursor is an event sequence, not a row offset or count. Use `nextAfter` even when sequences
have gaps. Completeness is a point-in-time fact about the known runner tail; live events can arrive
after a completed traversal. Pagination is not a frozen snapshot of a running session.

To read the newest ordinary window, use `direction=backward&limit=200` without `after`. For older
pages, carry the returned `nextBefore` as `before` with the same `eventEpoch` while
`hasMoreOlder` is true. An incomplete cached tail may be older than the actual runner tail;
re-read the opening window after hydration catches up. Optional `align=turn` and
`opening=current-turn` retain their existing bounded turn-alignment and preview behavior and may
include additional rows within their separate alignment caps; they are not whole-log reads.

## Migrating Consumers

Upgrade installed CLI/MCP readers **before rolling out this control-plane change**. Runner
protocol 222 introduces the reader that never requests the old whole-history fallback.
Older readers can otherwise slice events 171–200 from a bounded first page and wrongly present
them as the newest window of a much longer log if a later completeness probe succeeds.

The server rejects that identifiable legacy fallback (`after` present, no `limit`, and no
`eventEpoch`) from an authenticated agent session whose credential's runner is below protocol 222,
with HTTP 426, `code: "session_event_reader_upgrade_required"`, and runner-upgrade guidance.
The capability comes from the authenticated actor's registered runner, never a request header
or the runner hosting the target session. Ordinary default requests, epoch-pinned continuation,
and explicit paged reads remain available. This guard never restores a whole-log response.

Paired-device CLI calls and other external API consumers authenticate as humans and cannot be
identified as an old installed reader from their event request alone. Upgrade those CLI binaries
and migrate scripts before upgrading the control plane; the server still returns the normal
bounded default to human-principal HTTP consumers. A reader that expects one response to be the
whole log is incompatible regardless of its credentials. Deployment remains an operator action.
Restart any externally managed or surviving MCP/provider processes launched before the reader
upgrade before rolling out the control plane; replacing an installed binary does not replace an
already-running reader process. Normal managed runner shutdown disposes its providers and MCP
descendants, but the runner's newly registered protocol alone cannot certify an external survivor.

Scripts that used one missing-limit response as the complete transcript must implement the forward
traversal above. Merely adding `limit=200` and retaining only the first response truncates history.
Readers that only need a recent window should explicitly use the backward mode.

The CLI and MCP tools retain their own defaults (30 events, maximum 100) and bounded outputs.
`wollipog session events ID --after 0 --limit 100 --json` corresponds to MCP
`get_session_events({sessionId: ID, after: 0, limit: 100})`. Continue with the returned `lastSeq`
and `eventEpoch` while `hasMore` is true. `historyIncomplete: true` means retry later even if no
rows arrived; without an `after` cursor, repeat the newest-window read after hydration completes.
These tools no longer fall back to an unpaged HTTP request to wait for the full log. When talking
to old control planes that ignore paging, the compatibility reader still slices their legacy
response locally; update those control planes to obtain server-side bounds.

Repository callers that need complete history (including agent-question test fixtures) now drain
bounded pages and pin the epoch. The unused unpaged web client method has been removed.
Missing-limit event requests also use the normal browser and desktop request deadlines because
they no longer wait for whole-history hydration.
