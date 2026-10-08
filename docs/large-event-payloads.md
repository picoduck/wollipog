# Large session-event payloads

The runner remains the authoritative, rolling-compatible source of session history and continues
to record complete inline events. The control plane externalizes large text fields as they enter its
cache so SQLite rows, initial history responses, and live WebSocket frames carry only a bounded
preview plus immutable artifact references.

## Eligible fields and limits

The control plane applies this boundary to `tool_call.text`, `tool_call_update.text`,
`command_output.text`, `stderr.text`, and `file_edit.diff`:

- Values of at most 16 KiB of UTF-8 remain inline.
- Larger values become a UTF-8-safe head/tail preview of at most 16 KiB and one to four ordered
  references. A reference records artifact id, canonical MIME type, UTF-8 encoding, exact byte
  length, and lowercase SHA-256.
- Each immutable artifact chunk is at most 8 MiB; the complete referenced value is at most 32 MiB.
  Text uses `text/plain` test-log artifacts and diffs use `text/x-diff` patch artifacts.
- Chunk boundaries never split a UTF-8 code point. Concatenating the verified chunks reproduces the
  exact original bytes.

The transformation covers live events, indexed single-event ingestion, indexed history pages,
legacy history hydration, legacy reprocess results, and a one-row-at-a-time startup migration of
older inline SQLite events. It is additive: an older web client ignores the references and still
renders the preview, while old runners continue to send their established inline event shape.

## Failure and lifecycle behavior

Artifact publication happens before the event cache write. Hashing, writing, and flushing the
chunks run on the thread pool, not the control plane's event loop: a chunk becomes durable first,
and only then do its artifact rows and the event row commit, in one synchronous step. Until then,
later live events of the same session wait behind it in arrival order; other sessions' events,
HTTP requests, and dashboard frames keep flowing. History pages and reprocess results stage their
large payloads the same way before their synchronous append. If more than 64 MiB of large live
payloads are waiting, the runner connection's next frames wait too, so a slow disk applies
backpressure rather than growing memory.

If artifact storage is unavailable, the control plane retains the original inline event rather
than dropping or truncating the only copy; its diagnostic names only the session and event kind.
If the later event append loses a race or fails, newly created artifacts are removed immediately;
a live event whose append fails after staging re-reads the session from the runner's history.
Startup removes crash-window event artifacts that no committed event references.

`pnpm benchmark:event-payload [--dir <path>]` measures how long a 16 KiB to 1 MiB payload blocks
the event loop and how long another session's events wait behind a stream of large ones. Run it on
the disk that holds the database. On a local NVMe SSD (ext4):

| Measurement                                          | Written on the event loop | Staged off it          |
| ---------------------------------------------------- | ------------------------- | ---------------------- |
| Event-loop stall per 16 KiB–1 MiB payload, p50 / p95 | 21–35 ms / 22–41 ms       | 0.4 ms / 0.8 ms        |
| Other session's event delivery, p50 / p95 / max      | 88 ms / 232 ms / 404 ms   | 0.8 ms / 18 ms / 28 ms |

The stream case sends a 1 MiB output every 25 ms in one session and a small message every 2 ms in
another. The remaining tail is SQLite's automatic WAL checkpoint, which flushes on the event loop
every 1,000 WAL pages whatever the event size; with checkpoints suspended, the other session's
delivery is 0.95 ms at p95.

Event-only artifacts are session-scoped. Clearing or replacing cached history, changing the
runner's history generation, deleting a session, box, or runner, and reprocessing a transcript all
remove their event-only metadata. The shared content-addressed blob is reclaimed only after its
last artifact reference disappears. The runner source log is deliberately unchanged, so the
control-plane cache can always be rebuilt.

## Browser loading and integrity

Timeline rows render the inline preview without fetching artifact bytes. **Load Full Output** or
**Load Full Diff** performs an authenticated same-origin artifact export for each ordered chunk.
Before rendering, the browser validates the reference shape/count, expected MIME type, exact Blob
length, SHA-256, aggregate size, and strict UTF-8 decoding. Missing, reordered, truncated, tampered,
or wrongly typed chunks fail closed and expose a retry action.

Loaded text lives only in the mounted virtualized row. Hiding it, replacing its references, or
unmounting the row releases the text and fences any pending fetch from updating discarded state.
Raw event artifacts are unredacted source data and inherit the same paired-device/session
authorization and private no-store response boundary as other workflow artifacts.

See [content-addressed artifact storage](./artifact-blob-storage.md) and
[authenticated raw artifact exports](./artifact-exports.md) for storage, backup, and authorization
details.
