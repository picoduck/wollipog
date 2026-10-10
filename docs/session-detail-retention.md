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

### Removed Loading Children

The first current merge-group validation (`138b216bb7140b9ca411ac7b226a0d84417f6ca1`,
run `38085980527`, shard 5 job `114312443608`) found a node spread of 23, above the unchanged
limit of 20. Its strong and weak detached-preview assertions passed; the listener assertion was
not reached in that attempt. The automatic retry passed, but `failOnFlakyTests` correctly made
the job fail. The run listed zero uploaded artifacts, so its original per-cycle measurements and
retry attachment cannot be recovered from that listing. The exact 23-node breakdown is unknown.

An unchanged local reproduction of that pinned group passed with 821–838 nodes, zero preview
roots and 344 listeners. Its early/final forced-GC snapshots expose a separate bounded owner:
the live `.detail-scroll` viewport's ResizeObserver callback closes over `useFollowTail`'s
`observed` Set, which still contains a detached transcript-loading skeleton. The early graph has
18 detached skeleton nodes; the final graph loses those and gains one attached text node, matching
the 17-node endpoint difference. The Set only added direct children and did not release removed
ones. This proves the local owner, without inferring the unavailable CI series from it.

The additional fix reconciles those observations when children change: it unobserves and deletes
removed direct children, retains viewport/current-child observation, and clears the Set on cleanup.
The same group bundle with only that hook overlaid passes ten cycles at 820–821 nodes, zero roots
and 344 listeners. Both early and final snapshots have no detached skeleton. The before bundle
fingerprint is `be1d839bbee8748dcb991e1e7652ba0956f77d76de6e0e4a48854f142238188c`; the overlay is
`dc1409ccbeb6bce8d916857c14f67c419c64e38b847f3c058ef599e8186a6b6b`. The actual group's parent
`771dedaaa706f03013c33915a4293455f903dcb9` independently reproduces the original width-state
owner, two retained previews and listeners increasing from 353 to 362.

The observer lifecycle test fails on the old hook and verifies removed-child release, replacement
content/viewport observation, session replacement and StrictMode cleanup. Follow/resize/scroll
behavior and current-turn opening are preserved. Thresholds, retries, timeouts, ordinary CI
admission and flaky-test enforcement are unchanged. Future attempts emit synthetic primitive
source/engine/browser/retry metadata and counters before assertions; retry captures use separate
directories so a passing attempt cannot replace the failed series. The original CI failure and all
earlier measurements remain historical evidence.

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
838 and listener count is exactly 344. The normal V8 heap still grows, with ten-cycle slopes
declining from 143,220 to 85,494 to 38,709 bytes per cycle. This series alone does not prove a heap
plateau. The subsequent allocation diagnosis below separates compilation and inspection from
session-resource retention; the failed reference runs and this raw series remain intact.

## Remaining Heap Allocation Diagnosis

A second run captures forced-GC snapshots after the two warm-up cycles and after 60 measured
cycles in the **same browser process**, comparing node IDs rather than treating every late object
as newly retained. DOM stays at 821–838 nodes, listeners at 344, and detached previews at zero.
`JSHeapUsedSize` goes from 11,736,636 to 15,085,372 bytes. Its ten-cycle points are 13,157,808,
14,014,396, 14,390,328, 14,494,428, 14,713,224 and 15,085,372 bytes: ordinary V8 compilation has
not finished warming up even at this duration.

The snapshot's new-minus-lost **shallow** bytes identify the owners:

| Group | Net Shallow Bytes | Strong Owner Path / Evidence |
| --- | ---: | --- |
| V8 `InstructionStream` | 1,929,280 | Live module function → `Code` → `instruction_stream` |
| V8 `TrustedByteArray` | 615,276 | Live module function → `Code` → `deoptimization_data` → `ProtectedFixedArray` |
| V8 `ProtectedFixedArray` | 260,436 | Compiled function deoptimization metadata |
| Native V8 `WeakArrayList` | 240,336 | Strong root list → `no_undetectable_objects_protector` → `PropertyCell.dependent_code` |
| Blink network resource records | 461,088 | C++ persistent root → `DevToolsSession` → `InspectorNetworkAgent` → `NetworkResourcesData` |
| `PerformanceResourceTiming` | 26,384 | `Performance` → native performance-entry buffer |
| Plain JS `Object` | 28,604 | Representative React hook state is reachable from a live Inbox row's fiber; old fork/focus contexts retain JS state with cleared DOM refs |
| Probe `WeakRef` | 8,640 | `Window.__retiredPreviews`; 540 additional weak references, with no strong retired root |

Source maps resolve the largest new instruction stream (snapshot ID 674593, 181,824 shallow bytes)
to `InboxView` (`InboxView.tsx:191`, minified `Iwe`). Its function closure ID 157187 exists in both
snapshots. The same function's 71,812-byte `TrustedByteArray` is deoptimization data, not a session
transcript. Another 35,392-byte instruction stream belongs to `useFollowTail`
(`useFollowTail.ts:195`, `ate`); its closure ID 196361 also predates the measured cycles. The V8 code
category grows by 2,994,560 shallow bytes overall. These are compiled code/metadata attached to
existing functions, not hundreds of surviving SessionDetail render contexts.

The 1,601 net additional network records are explicitly owned by the inspector, not application
response caches. Performance timing entries increase from 57 to 251 native snapshot objects.
Neither native Blink group should be added to `JSHeapUsedSize`. Snapshot shallow sizes also differ
from retained sizes and the performance counter's accounting; the table is an allocation/owner
diagnosis, not a byte-for-byte reconciliation of that counter.

Application object shallow totals are 809,704 bytes early and 858,168 bytes late; closures increase
by 7,656 bytes. In the separate 30-cycle snapshot, those totals are 864,072 and 433,968 bytes,
versus 858,168 and 432,636 at 60 cycles. Large SessionDetail render contexts number 9 early, 12
in that 30-cycle run, and 13 at 60, rather than growing once per navigation. These small differences
include live/alternate React state and bounded surviving action contexts. The width ref releases
their DOM ownership; this change does not discard memoized session data or selectors.

A causal control uses the identical production bundle with Chromium `--js-flags=--jitless`, keeping
the same sessions, navigation, GC, weak-root recording and DOM assertions. After 30 measured cycles,
heap is 7,016,648 → 7,132,876 bytes, with cycle 10/20/30 at 7,131,008 / 7,124,884 / 7,132,876 bytes.
The last 20 cycles add only 1,868 bytes, while DOM/listeners remain 821–838/344 and roots remain zero.
V8 code shallow growth falls to 34,472 bytes; inspector network/native records still grow. This
isolates compilation as the normal-run heap-growth driver and shows a stable application-resource
level after warm-up. It does **not** claim that the normal-V8 raw heap series already plateaued.
The control supplements the ordinary production run; it never replaces or relaxes its assertions.

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

# Causal control after diagnosing V8 compiled-code ownership; the bundle stays identical.
SESSION_RETENTION_JITLESS=1 SESSION_RETENTION_CYCLES=30 \
SESSION_RETENTION_EVIDENCE_DIR=/absolute/private/jitless-evidence \
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

`measurements.json` records source revision/dirty state, engine mode, browser version, retry index,
asset fingerprint, every sample,
heap trend and a shortest strong GC-root path when detached previews exist. `early.heapsnapshot`
and `final.heapsnapshot` keep the raw before/after graphs when an evidence directory is configured,
and `desktop.png` shows the synthetic surface. The heap analyzer uses only
the graph's primitive node/edge arrays outside the browser and excludes weak edges. The in-page
probe holds only a WeakSet and unique WeakRefs, returns scalar counts and never holds a remote
DOM handle. It does not reset counters or delete retired refs to hide growth.

The browser regression requires zero distinct detached previews in the final heap, zero observed
retired weak roots throughout, native node spread of at most 20, and listener spread of at most 2.
The small node spread accommodates bounded transient UI; the zero-root checks independently
reject the old retained subtree. Unit coverage verifies width reporting, zero-width semantics,
reporter replacement, body replacement, observer disposal, and StrictMode/remount behavior.
