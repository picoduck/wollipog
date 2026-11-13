# Native Orchestrator Recovery After Runner Restart

A native provider can outlive the runner that launched it. The replacement runner cannot adopt
that provider's loaded guard socket, in-memory policy state or credential transport. Startup
therefore records nonterminal native Orchestrators as recovery candidates. After registration with
a capable control plane, its authoritative root list identifies which need one durable **Relaunch
Orchestrator After Runner Restart** action. Other existing recovery blocks retain their own actions.
This conservative rule also covers idle native Orchestrators: their former TUI registry is gone,
so startup cannot prove they have no surviving provider.

The action appears in the owner's Inbox and Campaign Status. **Relaunch Orchestrator** uses the
ordinary restart path, including its launch checks, fresh credential and guard provisioning,
budget enforcement and revocation of unconsumed decisions. A continuation asks the root to read
its campaign and pending descendant requests and reconcile uncertain outcomes before retrying.
Existing budget or policy blocks still apply to this continuation.

Only an authenticated human can invoke the card. The session credential cannot use it to restart
itself. Ordinary prompts, recovered provider answers and automatic background recovery cannot
bypass the card. Children retain their existing recovery through their controlling Orchestrator.
An offline relaunch keeps the action pending; repeated startup reconciliation keeps its identity.
A failed launch restores that action, unless Stop, deletion, a newer launch, or a more specific
recovery block superseded it. Prompts accepted by an owner-admitted launch use its existing
generation-owned queue; an unadmitted prompt cannot clear the recovery fence.
Both peers must support protocol 366. Older runners and older control planes retain the existing
manual Stop and Restart behavior. Only roots named by the control plane receive this action;
nested Orchestrators retain recovery through their controller.

The guard continues to refuse calls while its original endpoint is unserved or its protection
state is missing. Recovery never adopts a socket address from provider input, persists an abstract
socket name, or permits an unchecked call.

For diagnosis, inspect the session's pending `runner_recovery` request and Campaign Status's human
request count. Runner logs emit `runner_restart_recovery_required` once per new recovery request,
with `entryPoint: startup_reconciliation` and its session/request IDs. Successful owner invocation
records the normal restart and a governance resolution audit. Socket addresses and credentials
are absent from these records.

Tests use an inert native provider process, temporary runner state and real verdict sockets;
they replace the in-process runner services while keeping the provider alive. This verifies the
lost binding, fail-closed verdict transport, durable action and owner-only service restart. It is
not a live-stack restart or an installed-provider end-to-end rehearsal.

## Startup Retirement of Recorded Providers

On Linux, runner-owned native structured provider launches and Native TUI controllers publish
owner-only process ownership under the runner's private `provider-processes-v1` directory.
The enclosing data-directory lease is acquired for the attested runner/control-plane identity
before any retirement is considered; foreign data-directory ownership is never adopted here.
An admission intent is durable before spawn; the runner captures its child's kernel start time
synchronously before the event loop can reap and recycle it. Every record binds one process to
its session, this runner's identity and its random startup generation. Partial records never
authorize a signal. The records and their fields are never logged or projected to the provider.

Before startup registration admits any commands, the new runner examines prior-generation
records belonging to this same runner and OS user. A still-live recording runner, the current
generation, unknown/legacy evidence, changed private-file permissions or unverifiable identity
never authorize a signal. Unreadable or foreign records are retained. The native worker opens
a pidfd first, then checks boot,
start time, user and prior-runner liveness before signalling through that handle. PID reuse can
therefore never redirect a signal to its replacement. A graceful TERM/CONT gets a short grace
period, followed by KILL through the same handle if necessary; kernel exit must be observed.
The worker never sends a signal through a numeric PID. Startup work has record and elapsed-time
bounds; anything beyond them is retained.

Failed launches release their own admission intents on synchronous abort or child close, even
when spawn supplied no PID. Startup can prune a private, valid intent from a dead prior runner
without signalling anything, and can recover a complete `.pending` publication interrupted
before its rename. Obsolete records whose exact process identity is proved gone are pruned too.
Pruning journal metadata never removes the independent HOME lease evidence or admits a signal.

Deploying this version retires proven recorded orphan providers at the next runner startup.
A version that has never recorded ownership cannot supply retrospective proof: existing unrecorded providers are left
untouched. Other platforms retain the existing behavior until an equivalent kernel primitive is
implemented. Unrecorded descendants and ambiguous survivors continue to block HOME recovery.
Only the recorded root is signalled: unrecorded tool children in the same or another process
group can survive its retirement and intentionally keep the owner relaunch blocked. This does not delete
lease evidence, exclude processes from the production scan or weaken its
complete-tree standard. No agent management route invokes startup retirement.

Retiring a root's provider does not restart it. The owner's action above still admits its fresh
credential/guard and continuation. Children continue through their Orchestrator. A failed HOME
proof preserves the existing refusal and recovery card.

Startup retirement was chosen over an owner-cohort action because HOME lease evidence covers
all providers launched by the old runner. Retiring only one clicked root can leave its relaunch
blocked by another session's orphan. Independently retiring every proven old provider restores
the existing startup assumption that prior runtime has ended, without adding a broad human
action or changing unknown-survivor authority. This decision does not authorize deployment or
restart of the stack hosting an agent.

Runner logs emit `provider_startup_retirement` with retired/retained/pruned counts and retired session
IDs only. Fixture tests cover independent orphan sessions, unknown survivors, PID identity
mismatch, foreign ownership, current generation, private-file permissions, and owner recovery.
The combined HOME/guard/credential rehearsal requires an unremapped host root: the existing
lease bootstrap intentionally rejects a filesystem root owned by a foreign remapped UID. It
must run without that skip in CI; this is not a live-stack restart.
