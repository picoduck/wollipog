# Transcript Readability and Recovery Contract

The authenticated dashboard treats transcript presentation as a projection of two separate facts:
the bounded event cache and the recovery state for that cache's current event epoch. An empty array
is not proof of an empty transcript while the control plane is still hydrating runner-owned history.

## Opening window

Opening a session reads a bounded window at the **tail** of its cached history — one request for the
newest events, whatever the session's length — rather than walking the log forward from its first
event. `GET /api/sessions/:id/events?direction=backward` serves that window and its older pages;
`before` carries the reader's cursor and `hasMoreOlder` reports whether older cached rows remain.
Older turns load only when the reader asks for them through **Load Earlier Activity**, never in the
background, so a transcript cannot shift under someone who did not reach for it.

Recovery cursors stay contiguous *within* the loaded window. The events below its base are
deliberately absent, so contiguity is measured from the window base; measuring from zero would
collapse the published cursor and send the next recovery back to the start of the log.

Two loads keep the forward chain. A reconnect gap is owned by the forward cursor frozen at
subscription time, and a session whose reader has a saved position keeps loading the history that
restoring that position depends on — the position can sit below the window, and the transcript list
cannot yet restore an anchor against a windowed history. A control plane without backward reads is
detected from the response shape and falls back to the forward chain unchanged.

## Recorded timestamps and duration

Session events already carry a runner-recorded timestamp. User and assistant timeline items retain
the first relevant event timestamp and expose it through a semantic `<time>` element. Visible and
accessible copy calls it “Recorded” rather than “sent” or “received”: adopted transcripts can be
persisted with import-time timestamps when the provider's original timestamp is unavailable.

Turn duration follows a strict evidence hierarchy:

1. A finite, non-negative duration on the parentless top-level token-usage event is provider
   reported and displays without qualification.
2. If provider duration is absent, a parentless terminal usage event can close the active user turn.
   The non-negative event-time delta displays with `~` and the tooltip “Approximate runner-recorded
   activity span.”
3. Missing terminal usage, non-finite values, clock skew, imported incomplete history, and old
   runner/provider paths show no duration. The UI never substitutes time until the next prompt.

Attributed subagent usage remains attached to its spawning agent tool and does not close or mutate a
top-level user turn.

## Copy boundaries

- User-message copy uses the stored prompt text. Attachments are not serialized into clipboard text.
- Assistant-message copy uses the stored Markdown source, not rendered HTML or `textContent`.
- Fenced-code copy recursively joins renderer children, including syntax-highlight spans, and removes
  only ReactMarkdown's one presentation newline. Inline code has no copy action.
- Actions have contextual accessible names, fixed-size success/failure feedback, timer cleanup on
  unmount, and the existing plain-HTTP focus-restoring clipboard fallback.
- Raw provider errors, credentials, capability fragments, and public-share secrets are never added
  to copy or retry metadata.

## Honest history presentation

Each relevant session has recovery metadata fenced by its current `eventEpoch`, snapshot/socket
generation, and subscription revision:

- `everComplete`: one bounded recovery chain reached its authoritative final page.
- `refreshing`: initial hydration or reconnect gap recovery is in flight.
- `error`: the most recent history GET failed.

The state is pruned with event caches on navigation, membership changes, session/run/pod removal, and
generation reset. Stale old-epoch pages and failures are ignored.

Presentation is deterministic:

| Cache/recovery state | Presentation |
| --- | --- |
| Empty, never complete, connected | Bounded loading skeleton |
| Empty, completed | “No Activity Yet,” even while a reconnect refresh runs |
| Content present | Timeline remains mounted during refresh, failure, or disconnect |
| Never complete and offline/unauthorized | Reconnect or pairing-specific unavailable state |
| GET failure | Safe history-recovery Retry; no prompt replay |

Run and pod member columns use the same per-session state. Fleet recovery reports each member's start
and failure independently, preserves its concurrency ceiling and fair rotation, and retries transient
history reads without blocking later members.

## Compatibility and privacy

This slice is web/store-only. It does not change protocol version, runner persistence, control-plane
database schema, or public transcript schema v1. Public shares continue stripping operational event
timestamps and provider metadata. Older control planes remain on the one-response legacy recovery
path; older or incomplete transcripts simply omit duration.
