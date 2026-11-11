# Assistant Session Management

Refs #4464 and #4462. These tools register on the Assistant connection MCP registry described in
`assistant-connections.md`. They invoke the owner's existing database projections and session
application service. They do not manufacture a session credential, parent relationship or campaign.

## Tool Inventory

| Tool | Behavior |
| --- | --- |
| `project_list` | Authorized projects, including hidden projects, and current Locations |
| `runner_list` | Authorized runner status and actual agent capabilities, with local/SSH Locations |
| `session_list` | Authorized sessions across projects; `archived: true` includes archived sessions |
| `session_get` | Current status, preview, attention, holds and stop recovery state |
| `session_messages` | Bounded transcript text/response boundaries, excluding nested tool messages |
| `session_launch` | Launch in `locationId` with `agentId`, optional prompt/title/config/worktree choice |
| `session_prompt` | Send `text` to any authorized `sessionId` |
| `session_stop` | Existing service's durable Stop intent and lifecycle checks |
| `session_restart` | Existing restart service; optional `unarchive` and `waitForProviderHome` |
| `session_archive` | Existing stop-before-archive service |
| `command_get` | Lookup a command under current connection, operation and source access |

Mutation tools require a stable caller-generated `commandId`. Full Access covers unrelated sessions
and multiple projects. Selected-project grants filter list entries and enforce current placement on
reads/mutations/receipt lookup. Runner responses explicitly select safe fields and omit agent
commands, environment maps, provider logins and credentials. Client network address is not authority.
Local and SSH Locations use the same runner protocol transport and lifecycle application service.

## Commands and Lost Responses

1. Generate and retain a command ID before making a mutation request.
2. The server reserves `(connectionId, commandId)` with a canonical request digest, operation,
   installation, grant revision, target and timestamps **before** invoking the application service.
3. The response contains a receipt. `succeeded` means the application service accepted the command;
   it does not prove the runner finished execution, Stop released capacity, or archive completed.
   Read the session and follow its existing lifecycle recovery guidance.
4. After a lost response, call `command_get` first. Reusing the same command never dispatches it
   again, even if the receipt says `accepted` or `uncertain`. Changed operation/arguments with the
   same ID are refused. A different command ID represents new work, never a transport retry.
5. An `accepted` receipt left by interruption may have executed partially or completely. An
   `uncertain` receipt records an unexpected service failure with an unknown outcome. Inspect the
   target and existing owner command/lifecycle recovery paths; neither state authorizes replay.

The store persists no prompt text, raw exception or private result body. `resourceId` and
`resultReference` identify the service resource when known. Current private results are read from
their source, not cached in an old command response. If a source moves outside the connection's
projects, receipt lookup is refused too. Revocation and rotation take effect through the existing
connection checks. Runner capability refusals preserve their structured requirement, and lifecycle
refusals preserve the application service's concrete cause plus its owner's recovery path.

The owner's current `grant.destructiveConfirmation` applies to Stop and Archive. Under `confirm`,
the first call returns `confirmationRequired`, a target preview, `confirmationId` and `expiresAt`,
without reserving or dispatching a command. Review the target, then repeat unchanged arguments and
the same command ID with that confirmation ID within five minutes. Confirmations bind connection,
grant revision, operation, current project placement and argument digest, and are one-shot.
Consumption shares the command reservation's transaction. A grant/target/argument change or expiry
requires a fresh preview. Existing accepted command IDs always reconcile without dispatch, even
after a confirmation expires. Under `none`, the existing direct command behavior applies.

There is deliberately no claim of exactly-once runner execution. The reservation prevents blind
redispatch from the Assistant transport; existing runner outboxes/receipts govern execution.
A crash between service dispatch and receipt settlement can leave the result resource unknown.

## Extension for Work Tracking

`assistant-command-receipts.ts` exports the generic `AssistantCommandReceipts` store and
`assistantRequestDigest`. `install(db.raw())` creates the table idempotently. `reserve(input,
associate?)` returns `{created, receipt}`; a duplicate must never dispatch. The synchronous trusted
`associate(receipt)` callback shares the reservation's SQL savepoint: a work-origin claim and the
command reservation commit or roll back together. `get` reconciles; `settle` records a terminal
outcome without overwriting an existing terminal outcome. Callers own authorization and must use
the current Assistant registry authorization before exposing a receipt.

`registerAssistantSessionOperations(operations, db, svc, hooks?)` accepts
`hooks.associateCommand(args, receipt)` for the work tracking unit. It runs inside that same
savepoint before service dispatch. The hook must validate any `workOriginId` against the connection,
requester/destination and target, use the same database, and perform no async or external effects.
Without the hook, tools refuse `workOriginId` explicitly. This extension is not an implementation
of Discord authorization, destination bindings or durable outbound delivery.

The typed `hooks.authenticatedOrigin(receipt)` extension supplies `{requesterId,workId,bindingId}`
from trusted connector ingress, bound to the receipt's connection, operation, exact argument digest
and resolved target. It must authenticate ingress outside the model. It receives no model-authored
requester identity, and the implementation never copies requester fields from tool arguments.
Returning null with an explicit `workOriginId` refuses the command without retaining a reservation.

When that extension supplies an origin, the reservation callback invokes
`db.assistantWork.reserveOrigin(connectionId, {commandId, ...authenticatedOrigin, projectId})` on
the same SQLite savepoint. The project is the server-resolved Location's project, also passed
explicitly to the launch service so launch defaults cannot select a different project. Follow-ups
call `attachAcceptedOrigin` inside reservation, before prompt dispatch. Launches pass only
`assistantWorkOrigin: {connectionId,commandId}` through server-only `SessionsService.createSession`
context into `NewSessionInput`; #4467's database transaction consumes it before `session.created`.
This is never taken from `CreateSessionRequest` JSON. The small structural interface is in
`assistant-work-origin.ts`, allowing the session-management PR to land before #4467. If the work
store is absent, authenticated correlated commands fail closed. Production composition must install
the trusted ingress callback; the default MCP registration does not pretend to authenticate Discord.

## Evidence Limits

Automated coverage uses real SQLite, Fastify MCP and `SessionsService`, with a fixture runner
transport. It exercises unrelated sessions, multiple projects, local/SSH Location selection,
deduplication, interrupted delivery, live revocation and moved-source access. The fixture named SSH
is not a real SSH connection. OpenClaw, Discord, remote TLS and real SSH acceptance remain the
integration unit's work; these tests do not establish those outcomes. No web UI is changed here.
