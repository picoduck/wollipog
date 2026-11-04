# Managed-Worktree Guard Verdict Worker

Issue #1738 moves the per-session verdict listener and its synchronous judge to a worker thread.
Moving only classification would leave socket acceptance and request framing on the runner's main
event loop, so an unrelated synchronous operation would still stall the sidecar. One shared worker
per runner/account host serves its session listeners. Each listener's closure owns exactly its
protection source, version channel, and guard-state directory. Routing identities travel only on
the private main/worker control port; socket requests cannot name another session or account.
Path sockets retain their owner-only directory, `0600` mode, inode
check, and sandbox exposure; Linux abstract sockets retain their per-session random 192-bit name.

The worker uses the existing `managedWorktreeGuardDecision` and `managedWorktreeGuardOutcome`.
Framing and envelope validation moved unchanged into `managed-worktree-guard-transport.ts`.
The sidecar still supplies the provider environment; the worker's environment is not the judge's
environment. File-mode sidecars do not change. Manager policy-hook requests use the existing
newline framing and relay back to main, where credential and circuit authority remains. Their
human-wait semantics do not change. Ordinary guard verdicts need no main-thread round trip.

## Current Protection Lists

Path sockets read their existing protection file for each request, without a cached list. Atomic
file replacement, removal, and the provisioning/refresh tripwire keep their existing semantics.

Abstract sockets never consult a file. Every mutation of the authoritative hook-settings memory
map publishes synchronously to a session-private MessagePort, including provisioning, seeding,
refresh, deletion, compromise, and reset. Before posting, the publisher increments a shared atomic
version counter. When that mutation returns, its update has been queued and its version published;
the next request needs no main-thread acknowledgement, even if main blocks immediately afterward.
The worker drains queued updates synchronously before reading the list, validates contiguous
versions and list shape, and requires its version to equal the shared counter. A missing list or
unknown version refuses. Versions never wrap or get reused. A final counter check before sending
the verdict rejects a list changed during classification. That check is the memory verdict's
linearization point: an overlapping later update belongs to the following call. A reader racing
publication may refuse rather than use the previous list. Published memory state stays in the
process and is never persisted to a provider-accessible file.

## Failure and Lifetime

Worker startup error, premature exit, a malformed control reply, or a 30-second startup timeout
prevents provisioning. A single listener's bind error refuses only that listener and preserves
its siblings. A worker failure closes **all** its listeners and outstanding connections and
invalidates all their self-test proofs. The next `ensure` waits for actual termination, creates
one replacement worker and re-proves each recovered listener. Session close destroys only that
listener's connections and waits for its close acknowledgement; a 30-second close timeout
terminates the shared worker. Whole-host shutdown terminates directly, so even a stuck judge
cannot prevent shutdown. Retired listeners stop posting relay routing frames before destroying
their sockets, including abandonment callbacks that run after the close acknowledgement. Both
paths abort affected relayed asks. A hung worker cannot disable the independent sidecar timeout.
There is no in-process fallback or allow-on-error path. As before, a transient accept error on a listener
that remains open drops the affected call without tearing down subsequent calls. Memory-list
validation uses the same document normalization/version as file mode, including optional pins.

The production sidecar timeout remains 30 seconds (`MANAGED_WORKTREE_GUARD_SOCKET_TIMEOUT_MS`);
its documented code contract treats a slower local read/classification as a stuck runner and
refuses. Before #1738, an unrelated main-loop stall could trigger that same refusal. The regression
test uses the same request path with a 500 ms timeout and a bounded synchronous child invocation
that blocks the parent event loop. On the original handler it failed after approximately 641 ms
with `the runner did not answer in time`; with the worker the child receives its verdict before
the parent can resume. Separate tests refresh memory and disk lists immediately before that block.

`managed-worktree-guard-worker.test.ts` compares a corpus of shell, edit, read, patch, malformed,
environment-expanded and branch-pinning cases against the shared in-process judge on both socket
forms. It also covers invalid versions, crashes, stalls, startup failures, separate account roots,
and the self-contained CJS worker used by the standalone runner. The release build embeds that
worker as the `wollipog/managed-worktree-guard-worker-v1` SEA asset. Development, compiled JS, and
SEA launches use the same worker entry and judge.

The implementation was measured with Node `24.18.1`, pnpm `11.9.0`, Wollipog CLI `0.34.0`
(protocol v235), and GitHub CLI `2.45.0`. Probes use throwaway provider homes and never launch a
provider or inspect a real account home.

## Retained Memory and Worker Bound

The initial per-session worker proposal was rejected at merge review because guard sockets stay
alive across completed turns, normally until session deletion or runner exit. It retained one V8
isolate per previously launched session. The final design retains one worker per host, independent
of session count; closing a session retains that bounded worker, and `closeAll` terminates it.
Tests create 30 concurrent listeners and require one worker, verify each source remains private,
and verify shared failure invalidates all proofs and creates only one replacement on recovery.

The actual worker entry, including its loaded judge and a completed verdict per listener, was
measured in a fresh Linux process for each build mode. These are process RSS increases above the
pre-listener baseline, in MiB; they include session state and allocator/GC variation and are not a
production memory ceiling. The source run uses tsx; the compiled run uses the bundled JS worker
without a TypeScript loader, matching the standalone worker asset.

| Design and Mode | 1 Session | 10 Sessions | 30 Sessions | Added Threads at 30 |
| --- | ---: | ---: | ---: | ---: |
| Initial Per-Session, Source | 19.0 | 178.1 | 528.9 | 30 |
| Initial Per-Session, Compiled JS | 15.2 | 122.3 | 360.0 | 30 |
| Shared, Source | 21.2 | 21.8 | 22.9 | 1 |
| Shared, Compiled JS | 14.8 | 15.6 | 23.1 | 1 |

Reproduce the current source measurement:

```sh
node --expose-gc --import tsx apps/runner/scripts/guard-worker-rss-benchmark.ts
```

For the compiled measurement, choose an empty temporary output directory and compile the benchmark
as ESM (so module-relative worker resolution stays valid) and its worker as self-contained CJS:

```sh
pnpm --dir apps/runner exec esbuild scripts/guard-worker-rss-benchmark.ts --bundle --platform=node --format=esm --outfile=/tmp/guard-rss/benchmark.mjs
pnpm --dir apps/runner exec esbuild src/managed-worktree-guard-worker.ts --bundle --platform=node --format=cjs --outfile=/tmp/guard-rss/managed-worktree-guard-worker.js
node --expose-gc /tmp/guard-rss/benchmark.mjs
```
