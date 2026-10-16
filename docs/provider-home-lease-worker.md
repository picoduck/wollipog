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

A refusal crosses the boundary as a fixed code, never as the registry's message, so no lock path
reaches the parent. The codes are distinct, and callers receive a `ProviderHomeLeaseError` carrying
the code:

- `busy`: the recorded process is alive, or a publication is in progress.
- `foreign_owner`: a stale lease from another runner or control plane whose recorded process is gone.
- `foreign_host`: a lease recorded on another host.
- `unavailable`: the helper is unavailable.
- `refusal`: everything else the registry cannot prove.

A foreign-owner lease is still never taken over automatically. Its text names that cause and the
safe options, instead of the generic "could not be proved" refusal.

Callers that release before shutdown (skill transactions, launch preparation, and a launch or skill
acquisition that became stale after its grant) use `acquire_reference`. The worker keeps the receipt's exact-entry
release for that completed acquisition, at most 1024 at once, and `release_reference` names the
acquisition by its id. Every handle is settled: a consumer that keeps its reference until shutdown
(a launch preparation, Agent TUI or fork whose processes were not proven gone, or an unfinished
adoption or restore) sends `retain_reference`, which frees only the handle. Only in-flight transactions and
open session, TUI and fork handles occupy the pool, however many launches a runner performs. Releasing by path would re-resolve the HOME, so a symlink retargeted in
between could drop another HOME's reference. The handle cannot be redirected: it drops only the
entry it joined, at most once. Path-based `release` remains only for the provider sign-in supervisor
(sign-in and removed-account cleanup), which is unchanged here.

Short-lived provider processes release their reference once their process tree is proven gone (#3238). This covers:

- account-authentication and account-switch status commands;
- Codex subscription-usage probes;
- session-naming helpers.

Each process reports a proof when it finishes. The proof is true only when the process's POSIX boundary terminated every process it tracks and found no survivor. The boundary tracks processes through parent links and the inherited environment marker. The consumer releases its reference only if every proof is true. A run that started no process also releases.

This is the same proof runner shutdown already relies on before releasing every lease, so early release is exactly as strong as shutdown release. It shares one known limit. A helper that detaches with a scrubbed environment before its parent link is observed, or whose environment cannot be read, is invisible to the boundary. Closing that gap needs kernel containment, such as a Linux subreaper or cgroup.

A surviving, unknown or unprobeable descendant keeps the reference until shutdown. So does a spawn without a POSIX boundary, where only the root's exit is observable: native Windows (whose kill-on-close Job is not verified), WSL, and remote spawns.

Session providers and temporary fork providers work the same way per driver instance. Each launch takes its own handle, kept in a map keyed by the driver instance, and the instance settles it exactly once when it ends. Every path that ends an instance outside runner shutdown settles it: stop, idle parking, restart, delete, recovery, role conversion, account switch, worktree rebind, a failed initialization and fork cleanup.

The proof comes from `ProviderProcessLedger` (spawn.ts), which records every process the instance starts:

- A child spawned with the ledger's owner is covered by the owner's POSIX boundaries, which stay registered until proven gone.
- Any other child is proven individually. A child without an owner (a per-turn probe, say) has its boundary terminated when it closes, so its proof is settled then: a true result drops it from the ledger, and a false one makes every later proof false. Children therefore do not accumulate over a long session.
- A Claude virtual provider (the protected `bwrap` launch) has no boundary of its own; its namespace is the unit of proof, described below.
- A child without a boundary, or any untracked work the instance has run, makes the proof false. The Codex MCP inventory and permission-profile probes run outside a boundary and kill only their own process group, so a descendant that left the group could outlive them. A driver that ran one keeps its reference until shutdown.
- Proving seals the ledger, so the instance can start nothing afterwards.

How an instance ended decides which proof it gets:

- **Disposed:** the killing proof, which ends survivors as disposal already started to.
- **Exited on its own:** the non-killing proof, so live background work is left for orphan recovery and the reference is kept.
- **Disposal threw:** kept.

A failed construction keeps the reference if a constructor ran, and releases it otherwise. During shutdown nothing is settled per instance; `close()` releases every reference after the global reaping proof.

Session and Agent TUI handles live as long as their sessions and terminals. A runner with 512 open session and TUI handles together gives later launches and TUIs a plain reference until shutdown, so the worker's 1024-handle pool stays free for transactions and probes.

Codex exec, Pi, Codex app-server, Claude Code and ACP prove their trees.

**Launch preparation** takes its account-HOME reference in the `index.ts` adapter, for a plugin-provider session with a credential home whose context is native and whose target is the host. The reference is a transaction-scoped handle, so it does not count against the 512-handle budget. The caller of `prepareLaunch` owns it and passes it as `providerHome`, next to `isCurrent` and `signal`. Everything that runs under it reports there: the adapter's plugin inheritance and Codex guard, the launch's authentication preflight, and the status command of each authentication caller, through the same process observer as the account probes. The handle is settled exactly once, on those proofs:

- **Ordinary launch:** settled once the driver's own reference holds the HOME, just before the driver is constructed. That includes the null reference of a launch that needs no shared lease, or one past the handle budget, which holds a plain reference. Every earlier exit settles it on the way out: a stale launch, an authentication refusal, a failed transcript transfer, an isolation failure, a refused worktree lease and a failed driver acquisition.
- **Authentication inspection, account selection, automatic revalidation and explicit recovery:** settled in a `finally` once their status command has finished, with its proofs. A revalidation that timed out still settles when its work ends. A sign-in during explicit recovery runs under the login supervisor's own lease.
- **Recovery of another session sharing the scope:** settled right after its preparation, since nothing else runs under it.
- **Temporary-provider and Pi forks:** settled once the temporary driver's own reference is held, or when the fork gives up before that.

The reference is released only when nothing ran unprovably and every reported process tree is proven gone. A preparation that ran nothing, including one cancelled or gone stale after the grant, also releases. These keep it until shutdown:

- A Codex launch that reached the guard. Its hook inventory spawns a real Codex app-server outside any boundary, so the adapter marks the preparation unprovable before it starts. Tracking that probe is deferred to #3340.
- A plugin inheritance that threw partway, since the HOME may be half-written.
- A status command whose tree was not proven gone, or one run by an injected command runner.

Runner shutdown settles nothing per preparation; `close()` releases every reference after the global reaping proof. Sessions that take no preparation reference, because they have no credential home, are unchanged.

**Agent TUIs** hold their reference from the grant until the TUI has ended. The launch preparation owns it first, then the shell open path, then the opened terminal:

- When the TUI process closes or fails to start, `ShellManager` reports its tree proof once: on native Linux the TUI's ownerless POSIX boundary, terminated at close, decides; a Windows ConPTY process always reports false. The reference is released only for a true proof. Explicit close, session close and worktree retirement end in that same close event, so they settle the same way.
- A preparation or open that fails after the grant settles with no TUI process: it releases, unless a probe already ran outside a boundary.
- A Codex TUI keeps its reference until shutdown even when its own tree is proven gone. Its preparation runs the permission-profile proof, the hook inventory and, for the Orchestrator TUI, the MCP inventory, all outside any boundary. Tracking those probes is deferred to a follow-up.
- Windows native and WSL TUIs keep theirs too, since neither has a tree proof, and so does a false or failed proof.
- Runner shutdown settles nothing per TUI; `close()` releases every reference after the global reaping proof.

**Claude forks** take an exact-entry reference for the target fork (isolated to the new worktree), whichever client runs the fork: the live driver or a temporary one. The live client's ledger is never asked to prove, because proving would seal it. Instead `forkSession` reports the fork bootstrap's own tree proof through an optional process observer once the bootstrap has finished. The bootstrap has an ownerless boundary terminated at close. The reference is released only when that proof arrived and is true. A false proof, or none at all (a driver without the observer, or a bootstrap that never spawned), keeps it. A fork refused before `forkSession` was called releases it, since nothing was started.

**Claude Code** records its one-shot and persistent provider spawns under the ledger's owner, and its resume and fork accounting probe without one, so the probe is proven on its own.

- **Graceful stop:** `dispose()` gives a persistent provider its EOF grace window, then kills it, and only then ends the owner's survivors. The killing proof waits for those same retirements first, so it never cuts the grace window short.
- **Protected namespace:** when the provider runs inside its `bwrap` namespace, the namespace counts as gone only when it closed after the runner's TERMINATE frame, without the SIGKILL fallback, and its task root was removed. A SIGKILLed outer process can close a moment before the kernel has finished tearing down the PID namespace, and a namespace that closed on its own proves nothing about the work it hosted, so both keep the reference.
- **Namespace disposal:** the killing proof starts or joins the namespace's disposal. The non-killing proof only checks that the namespace already ended that way, so a live namespace, such as one with retained background tasks, keeps the reference.

**ACP** records its agent process without an owner, so the agent's survivors are still terminated when it closes and the agent is proven on its own. Each client terminal keeps its own owner, so releasing one terminal never ends another's retained work. The terminal service records how each terminal's tree ended, whether by kill, release or disposal (a command that exited on its own keeps its retained work until one of those). Once the service is disposed, the terminals count as gone only when every recorded ending proved its tree gone; a false result stays false. The ACP proof is the agent's proof and the terminals' proof together.

Both drivers keep the reference for Windows, WSL, container and cloud launches, for a spawn without a pid, and for a terminal without a POSIX boundary.

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
automatic timeout and unrelated-error preservation. It also runs the production Codex guard phase,
which marks the preparation unprovable before the hook inventory starts.
`session-provider-lease-release.test.ts` and `provider-process-lease-release.test.ts` settle the
preparation reference through the ordinary launch and the inspection, recheck, automatic revalidation
and sibling recovery callers. The fork
integration test settles it after the temporary driver's own reference. The fork integration tests defer both
preparation paths and verify source/target deletion, epoch and credential replacement before any
temporary provider is constructed; existing plugin argument assertions remain in place.

The Platform Isolation matrix runs Linux, macOS and both Windows images. It runs the focused source
tests and `verify-provider-home-worker-binary.mjs --source`, then builds the real native SEA and runs
the same daemon fixture with `--packaged`. The daemon fixture launches no live provider and uses
private temporary HOME, configuration and data roots. It runs these steps:

1. An idle runner releases the HOME after its skill transaction.
2. A second live runner then acquires the same HOME.
3. A separate holder process with the runners' owner and its own live PID takes the HOME; the
   second runner's sync is refused, and the journal is unchanged.
4. After the holder is killed, that runner recovers, then releases on graceful shutdown. Linux can additionally use `--maximal` with a
packaged binary to measure normal heartbeat delivery through the entire shipped path.
