# Targeted UI Streams and Bounded Delivery

The `/ui` WebSocket carries two classes of data:

- scoped metadata deltas used by board, sidebar, runner, run, and pod lists;
- high-volume session events, history resets, shell chunks, and pod context.

Current dashboards send a revisioned complete replacement `session_subscriptions` message containing
the session and pod ids needed by the active view. The control plane replies in writer order with the
exact authorized selection in `session_subscriptions_applied`. Session/run/pod navigation is
late-bound to the live store, so membership changes refresh the selection. Metadata remains global
within the authenticated principal's scope. The control plane filters requested ids through
authorization and rechecks access again at delivery time, but first skips clients that are not
subscribed so unrelated dashboards do not cause per-event authorization reads.

Subscription-update admission is shared by device/principal across reconnects and parallel sockets,
expires when idle, and has a bounded LRU key set. UI sockets themselves are capped per principal and
globally before the control plane constructs a scoped snapshot. This preserves multiple dashboard
tabs and one rolling-upgrade legacy client without allowing a single credential to multiply snapshot
memory, authorization reads, or independent writer queues without bound. A run is capped at the same
256-session limit as one live selection, so every accepted run remains recoverable.

Compatibility is additive. A dashboard that sends no subscription message receives the legacy
authorized stream. A current dashboard waits for the snapshot capability; an older control plane
does not advertise it, so the dashboard stays in legacy delivery and recovers history immediately.

Each client has one serialized writer. It bounds queued messages, queued UTF-8 bytes, and the
underlying WebSocket `bufferedAmount`. Unsent upserts for the same entity collapse even when durable
events are interleaved; the newest upsert moves after those lossless frames, preserving event order.
A client that exceeds a ceiling is removed immediately and closed with code `1013`, then its normal
browser reconnect obtains a fresh metadata snapshot. After the replacement acknowledgement, the UI
fetches durable event gaps from the runner sequence frozen before that replacement was sent; a live
post-ack event therefore cannot advance recovery past older outage gaps. A successful fetch advances
the cursor used by later run/pod metadata refreshes instead of replaying full histories. The control
plane increments a session event epoch whenever reprocess replaces a log and carries that epoch on
snapshots, session metadata, and reset frames, so a missed reset invalidates stale events and cursors.
Older control planes expose no epoch; current dashboards conservatively discard their bounded visible
event cache and recover it from zero after each legacy reconnect.

Shell output is deliberately ephemeral and cannot be gap-filled. After an abnormal disconnect, live
retained tails are labeled potentially incomplete instead of being presented as contiguous. On
reconnect the dock reloads the authoritative registry, drops dead tabs and queued interaction, and
does not create an unrequested replacement shell. An explicitly closing shell is tombstoned locally
until unmount so a registry row awaiting its exit echo cannot resurrect the tab, and reconciliation
clears input from the actual removed active shell before choosing a fallback. Completed tails remain
exact and are not relabeled.
Initial snapshot and history pagination remain separate follow-on slices; a single frame above the
hard delivery ceiling fails closed until those bounded pagination paths land.
