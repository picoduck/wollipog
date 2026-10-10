# Session Detail Retention

Issue #2772's historical leak and the remaining current-main ownership have different release
boundaries. Both were reproduced with nine complete synthetic transcripts in a production Chromium
build, two warm-up navigation cycles, ten measured cycles and forced GC after each cycle. The same
current synthetic control plane served all reference bundles. No hosting stack or real session data
was used.

## Retainer Proof

At `67165338ea3e120e2958ca57ad89134f1631c27f`, a strong heap path from a live Inbox row passes through
its React props/Inbox callback context to `previewForkControls.fork`. That SessionDetail closure's
outer context contains an inline `onExpand` (some paths use `onPreviousSession`) supplied by Inbox.
It reaches the previous Inbox render's `previewForkControls.fork`, repeating through earlier
mounted sessions. At the end, `composerRetryRef.current.send` reaches the SessionDetail render
context's `detailBody` state: a detached `.detail-body` whose native parent links retain the entire
`.session-detail.preview` subtree. Event-listener growth is a consequence of retaining those DOM
subtrees; a missing global-listener cleanup was not the cause.

The historical snapshot has 109 distinct detached preview roots after 12 total cycles. The weak
probe begins after the initial automatically selected preview, so it observes 108 of those roots.

The delivered commit `9cf8680d82cc45a08dc79b0876773eca53e75052` (PR #2887) replaces Inbox's inline
surface callbacks with `useStableCallbacks` and memoizes SessionDetail. The forwarding callback
reads the latest committed callback through a ref, breaking the recursive chain into prior Inbox
contexts. A direct comparison against its parent `6ba0d7e079d6788533034e067e31da1b550c27af` proves
the change: growing detached roots become two bounded roots. This release was already delivered
before the work for #2772.

On the assigned base `7b53f581f8cca6f9cbccb78d539b82a9d59ad64c`, live Inbox callbacks/effect cleanups
can still retain an older fork-control context. Its path passes through
`restorePendingComposerFocusRef.current` to the old SessionDetail render context and the same
DOM-valued `detailBody` state. The root count plateaus at two; it is not the historical linear leak.

The #2772 change removes that final strong DOM ownership. `useBodyWidth` stores the body only in a
mutable ref, clears it synchronously when React detaches the callback ref, and disconnects/clears
its observer. Its render state is an attachment number, not a DOM node. Even if an action callback
survives, it can no longer reach a detached body. Widths still report in layout initially and through
ResizeObserver afterward, using the latest reporter and ignoring zero-width hidden bodies.
Session selectors, streaming selectors, hydration, cancellation, current-turn opening, paging,
focus and shortcut behavior are unchanged.

## Measurements

Counts are Chromium `Memory.getDOMCounters`, including native DOM nodes and listeners after GC.
Heap is `Performance.getMetrics`'s `JSHeapUsedSize`. MiB uses 1,048,576 bytes. Reference builds
intentionally fail the zero-detached-root regression; their metrics and strong heap paths are saved
before the assertions.

| Source | Measured Cycles | Nodes, First → Last | Listeners, First → Last | Distinct Detached Preview Roots at End | Heap MiB, First → Last |
| --- | ---: | ---: | ---: | ---: | ---: |
| Historical `67165338e` | 10 | 2,469 → 10,880 | 431 → 971 | 109 | 10.79 → 16.09 |
| Stable-callback parent `6ba0d7e0` | 10 | 3,082 → 13,833 | 515 → 1,325 | 109 | 11.51 → 17.40 |
| Delivered `9cf8680d8` | 10 | 1,074 → 1,068 | 362 → 362 | 2 | 10.70 → 12.41 |
| Assigned base `7b53f581f` | 10 | 956 → 1,068 | 353 → 362 | 2 | 11.21 → 12.57 |
| Base + Width Ref Fix | 30 | 838 → 821 | 344 → 344 | 0 | 11.20 → 13.75 |

All 31 fixed-run samples have zero retired weak roots. Native node count stays between 821 and
838 and listener count is exactly 344. The heap still grows, with ten-cycle slopes declining from
143,220 to 85,494 to 38,709 bytes per cycle. This observation does not prove a heap plateau or
identify the remaining allocations; the DOM release claim is supported by the distinct-root
snapshot, weak-reference probe and raw DOM/listener measurements, not a heap-counter reset.

The aggregate SHA-256 of the fixed production JavaScript assets is
`cc8b8a84dc50c99040de9c779d73576ab550a1b4d228b088f7c8cb36875383b2`. The archived historical,
stable-parent and stable-child bundle fingerprints are recorded in each measurement JSON.

## Reproduction

```sh
SESSION_RETENTION_EVIDENCE_DIR=/absolute/private/path \
  pnpm exec playwright test --config playwright.retention.config.ts

# Optional longer measurement; accepted values are 10 through 100.
SESSION_RETENTION_CYCLES=30 SESSION_RETENTION_EVIDENCE_DIR=/absolute/private/path \
  pnpm exec playwright test --config playwright.retention.config.ts

# Compare browser source from an isolated reference checkout/archive.
SESSION_RETENTION_REFERENCE_ROOT=/absolute/reference/source \
SESSION_RETENTION_REFERENCE_SHA=67165338ea3e120e2958ca57ad89134f1631c27f \
SESSION_RETENTION_EVIDENCE_DIR=/absolute/private/reference-evidence \
  pnpm exec playwright test --config playwright.retention.config.ts
```

Reference source needs its own workspace package resolution, especially `@wollipog/protocol`.
Symlinking the whole current web `node_modules` incorrectly compiles an old UI with the new
protocol constant: it advertises paged-snapshot support absent from its Store and displays no
sessions. Link external dependencies individually while resolving that workspace package to the
reference source. Do not treat such a handshake failure as a retention result.

The probe serves an isolated production bundle, creates a fresh synthetic database and local
credential, and terminates only its own control-plane process. All nine virtualized rows fit in
the fixed 1280 × 1600 viewport. Every selected preview must display its own prompt and finish
virtual measurement. The 2.1-second settle period covers Inbox's 1.5-second seen dwell and pending
reader frames; it is test instrumentation, not a product delay. Two warm-up cycles precede
measurement. Playwright tracing is disabled because its DOM snapshots/observers introduce an
additional owner.

`measurements.json` records source revision/dirty state, asset fingerprint, every sample, heap
trend and a shortest strong GC-root path when detached previews exist. `final.heapsnapshot` keeps
the full raw graph, and `desktop.png` shows the synthetic surface. The heap analyzer uses only
the graph's primitive node/edge arrays outside the browser and excludes weak edges. The in-page
probe holds only a WeakSet and unique WeakRefs, returns scalar counts and never holds a remote
DOM handle. It does not reset counters or delete retired refs to hide growth.

The browser regression requires zero distinct detached previews in the final heap, zero observed
retired weak roots throughout, native node spread of at most 20, and listener spread of at most 2.
The small node spread accommodates bounded transient UI; the zero-root checks independently
reject the old retained subtree. Unit coverage verifies width reporting, zero-width semantics,
reporter replacement, body replacement, observer disposal, and StrictMode/remount behavior.
