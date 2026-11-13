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

## Remaining for #4546

This slice does not retire a native provider that outlived the runner. A surviving provider can
keep its provider-HOME lease busy; the launch then refuses, starts no replacement provider, and
restores the owner's recovery action. An unleased surviving process also has no session-bound
retirement proof in this slice. No unproven PID is signalled and no lease record is removed.
Safe retirement requires a durable, owner-only record binding the provider process to this
session, with fresh process-identity verification before signalling. That remains a second slice
of the original issue; the issue must stay open until it is delivered and verified.
