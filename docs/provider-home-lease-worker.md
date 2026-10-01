# Provider HOME Lease Worker

The runner owns one lazy, serialized worker for its complete private provider-HOME registry.
Initialization, helper compilation/probing, verification, hashing, migration, acquisition,
completion and release run there. Moving only the native subprocess would leave seconds of
JavaScript verification on the heartbeat event loop. The worker shares the runner's OS PID;
native POSIX actual-parent checks and Windows process creation-time checks still refer to the
runner. Worker-thread death does not prove that the runner or its providers died.

Control messages contain a bounded HOME/provider selection and scalar results. Canonical records,
native manifests and private acquisition/completion tokens stay inside the worker. Source launches
load the fixed sibling module through the project's loader; compiled launches load the fixed JS
entry. SEA builds embed a separate, self-contained worker asset and the existing native helper.
No agent RPC, configuration or CLI mode can select worker code or enlarge its limits.

| Limit | Value |
| --- | ---: |
| Pending requests, including the active unacknowledged receipt | 64 |
| Control request | 64 KiB |
| Scalar response | 4 KiB |
| Enqueue-to-terminal deadline | 300 seconds |
| Existing helper compile / execution probe | 30 / 10 seconds |
| Existing native transaction / fence wait | 120 / 10 seconds |
| Heartbeat regression bound under normal OS scheduling | 500 ms late |

The existing record, byte, native IPC, migration and retirement budgets remain unchanged.
The heartbeat interval, initial-pong grace and missed-pong termination thresholds remain unchanged.
The dispatch bound does not promise hard real-time behavior when the OS deschedules the runner.

Each operation has a fresh UUID in a single worker epoch. Execution produces a receipt; the parent
checks its identity, deadline and lifecycle before acknowledging it; only the matching terminal
reply resolves the caller. The worker cannot process another operation while that receipt is
unacknowledged. Cancelled queued work never executes. Cancellation before acknowledgement unwinds
that acquisition's exact private reference. Cancellation crossing an already sent acknowledgement
requires an exact compensating receipt before subsequent work can execute. A retargeted HOME alias
cannot redirect cancellation to a different registry entry. Callers repeat launch-generation,
account, TUI and skill-authorization checks after their awaits.

The launch-preparation adapter also awaits account-HOME ownership before plugin inheritance and
guard preparation. Its seven callers cover ordinary launch, authentication inspection/account
selection, temporary-provider and Pi forks, automatic authentication revalidation, explicit
recovery and recovery of another session sharing the scope. Each wait retains its launch epoch,
credential identity and, where applicable, exact recovery card/request or fork target reservation.
Cancelled or stale preparation cannot continue into plugin writes, probes or provider launch.
The existing automatic-revalidation timeout cancels only its pending wait and keeps its unknown
result. Cancelling or dismissing recovery aborts the exact pending preparation; unrelated failures
still propagate through the existing error handling.

A missing, late, malformed, duplicate or mismatched completion, failed cancellation unwind, worker
error or unexpected exit poisons the lane. It rejects further work, retains canonical evidence and
never transparently creates another registry to reconstruct private authority. Terminating a worker
does not imply rollback or release. Recovery requires the existing runner lifecycle and native
owner/liveness proofs. Shutdown first closes acquisition admission; after provider, login and TUI
trees have been reaped, it awaits complete release. Unproved release reports false and retains proof.

Content-free `provider_home_worker_operation` logs correlate an epoch/request UUID with method,
queue wait, operation duration and outcome. `provider_home_worker_unavailable` reports the poisoned
epoch and fixed reason. Existing checkpoint/release diagnostics remain available. These logs never
carry HOME paths, provider environment values, manifests or private completion tokens, and logging
failure cannot change ownership.

## Measured Responsiveness

The regression fixture executes the actual production `startHeartbeat` function with an isolated
socket sink and immediate pong. It measures dispatch inter-gap minus interval with
`performance.now()`, separately from the lease operation's elapsed duration. Fixture preparation
precedes measurement. The maximal migration starts after 9,900 ms of asynchronous timer setup,
placing the first unchanged 10-second heartbeat due time inside the pending operation even on
machines that finish migration in less than 10 seconds. Setup overshoot or no dispatch strictly
between operation start and completion fails sampling explicitly. Setup and post-work dispatches
cannot satisfy that proof; the original dispatch timestamps remain intact for the 500 ms bound.
The heartbeat callback SHA-256 is
`fe29eb1bc6a221ecd6c271b510fe6035baf8e89f6299a356e3b48ce55f8d88c6`.

Linux / Node 24.18.1 measurements on a local development filesystem:

| Workload | Before: operation / heartbeat delay | Worker: operation / heartbeat delay |
| --- | --- | --- |
| Cold initialization, acquisition and release | 726 / 649 ms | 395 / 3.03 ms |
| Maximal 4,090 legacy transitions, 3,300 padding bytes each | 99,016 / 89,240 ms (10-second heartbeat) | 47,880 / 1.23 ms (10-second heartbeat) |
| Release with a reader holding the permanent fence for 1.5 seconds | 1,364 / 1,286 ms | 1,312 / 3.69 ms |
| SIGKILL at `candidate-durable`, then proved recovery and release | 685 / 605 ms | 481 / 6.15 ms |
| Fixed helper initialization/probe failure before HOME mutation | Not measured | 365 / 2.25 ms |

The actual source daemon, using SessionManager skill reconciliation and a loopback WebSocket peer,
measured a 426 ms cold operation and 0.81 ms maximum heartbeat delay. The actual packaged SEA daemon
processed the maximal migration in 78,580 ms while seven normal 10-second heartbeats were at most
0.70 ms late, with the broader native regression suite running concurrently. Both daemon fixtures refused a second live owner without changing evidence, recovered
after the first runner was killed, and proved graceful shutdown release. These are local Linux
results; macOS and Windows results come from the platform jobs, rather than inference from Linux.

## Verification Matrix

`provider-home-lease-async.test.ts` exercises real worker cancellation before/after acknowledgement,
alias retargeting, worker loss, live-parent refusal and generated reference-count sequences.
`provider-home-lease-worker-protocol.test.ts` injects invalid identities, phases, changed receipts,
loss, deadlines and queue saturation. `provider-home-lease-heartbeat.test.ts` covers maximal migration,
cold/failure paths, actual fence contention and killed-runner recovery. Existing native, portable,
checkpoint and I/O suites retain the ownership, durability and private-token proofs.
`session-manager-lease-preparation.test.ts` executes the production plugin ownership phase with
isolated controllers, including stale card/account/epoch checks, recovery cancellation, the
automatic timeout and unrelated-error preservation. The fork integration tests defer both
preparation paths and verify source/target deletion, epoch and credential replacement before any
temporary provider is constructed; existing plugin argument assertions remain in place.

The Platform Isolation matrix runs Linux, macOS and both Windows images. It runs the focused source
tests and `verify-provider-home-worker-binary.mjs --source`, then builds the real native SEA and runs
the same daemon fixture with `--packaged`. The daemon fixture launches no live provider and uses
private temporary HOME, configuration and data roots. Linux can additionally use `--maximal` with a
packaged binary to measure normal heartbeat delivery through the entire shipped path.
