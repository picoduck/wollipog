# Assistant Work and Conversation Events

Refs #4467. This foundation extends the [Assistant connection contract](assistant-connections.md)
and [signed outbound transport](outbound-events.md). It implements protected correlation records,
tracked-work wakeups, current-authority checks, state reconciliation, an external receiver library,
and reply receipt primitives. It does not claim a configured OpenClaw/Discord installation or a
complete Discord sender. The production connector and session-management integration must use the
interfaces below; library tests do not establish their deployment or real Discord permissions.

## Ownership and Conversation Bindings

Only the connection's current organization owner can create a destination binding:

- `POST /api/assistant-connections/:id/destination-bindings`
- `GET /api/assistant-connections/:id/destination-bindings`
- `DELETE /api/assistant-connections/:id/destination-bindings/:bindingId`

The creation object contains `requesterId`, `accountId`, `conversationId`, `destination`, `agentId`,
`sessionKey` and `projects` (`all` or exact project IDs). These are private configuration, not
public examples to populate with real Discord identifiers. Store the response in protected runtime
configuration. Revocation is permanent; a new destination needs a new binding, never silent rerouting.

Channel and thread destinations use `channel:<channel-or-thread-id>` and the matching
`agent:<agentId>:discord:channel:<channel-or-thread-id>` key. DMs use `user:<peer-id>` with
`agent:<agentId>:discord:<accountId>:direct:<peer-id>` and require OpenClaw's
`session.dmScope: per-account-channel-peer`. Verify the generated DM key against the configured
OpenClaw version before enabling it. A mismatched key is refused, not replaced with a default channel.

Full Access describes the connection owner's Wollipog authority. It does not authenticate a Discord
sender or authorize everyone sharing a channel. The trusted connector must authenticate Discord
ingress, apply OpenClaw's DM pairing/allowlists, channel/guild allowlists, sender/role restrictions
and mention policy, then match the owner-issued requester binding. Model-supplied tool arguments
are not trusted ingress identity. Never put owner credentials into a shared-channel agent context.
The work-tracking MCP tools grant no session mutation authority.

## Work and Session Command Integration

`db.assistantWork` owns the SQLite records. Register its operations on the single Assistant registry
with `registerAssistantWorkOperations(db, assistantOperations)` before listening:

- `assistant_work_track`: `{sessionId, workId, bindingId, operationId?}` tracks an existing session.
- `assistant_work_read`: `{sessionId, workId}` returns current work and supported resolution paths.
- `assistant_work_reconcile`: `{projectId?, after?, limit?}` returns `{items,nextAfter}`.

Work IDs are client-generated canonical identifiers, unique per connection. Reusing an ID with
different session, binding or operation correlation is refused. Each result includes installation
and connection IDs. Use those IDs to distinguish named installations, never names or MCP prefixes.
The read grant is also required when tracking work; project grants and owner resource access are
checked from current session placement. Work snapshots contain no results or destination coordinates.
Deleting a source session leaves the minimal correlation as an unreadable identity tombstone.
It prevents a delayed event or a reused work ID from silently adopting another session/destination;
current authorization refuses access after the source is gone. No transcript or result is retained.

For #4464's receipt service:

1. Authorize the actual launch/prompt operation against the current connection and target. Obtain
   the requester identity from trusted ingress, not from model arguments.
2. Within `AssistantCommandReceipts.reserve(receipt, associate)`, call
   `db.assistantWork.reserveOrigin(connectionId, {commandId,workId,bindingId,requesterId,projectId?})`.
   This is a synchronous association and participates in the receipt savepoint. A throw rolls back
   receipt acceptance. Duplicate receipt reservation must never dispatch again.
3. On launch, pass server-only `assistantWorkOrigin: {connectionId,commandId}` to
   `ControlPlaneDb.createSession`. It attaches the reserved origin before staging `session.created`
   in the same transaction. Do not expose this internal input directly as an unauthenticated request
   field. For an existing session, use `attachAcceptedOrigin(origin,sessionId)` in the reservation
   transaction before dispatching the follow-up.
4. Recheck the actual operation and destination binding before runner dispatch. This origin helper
   does not replace command-service authorization, credential rotation checks, or runner receipts.
5. Reconcile an uncertain launch through its command receipt. Do not allocate another work or
   command ID because a hook, MCP response, or runner acknowledgement was lost.

Session and attention changes advance durable per-work revisions independently of webhooks. After
reconnect, page all current work, follow `nextAfter` even on an empty filtered page, and compare
revisions with the connector's durable progress. Cursors represent metadata-only positions, never
caller-chosen IDs from filtered-out work. Start another sweep from the beginning to observe changed
state on older rows. Selected-project grants must pass an allowed `projectId`;
every returned item also passes its current source and destination checks. Revoked/unreadable items
are omitted; omission does not authorize a private reply or mean that execution failed.

This is current-state recovery, not an unlimited historical event stream. Paused subscriptions can
miss transient states. Current pending attention and final state remain recoverable. Preventing
duplicate commands depends on command identity/receipts and never on wakeup ordering or completeness.
Each connection may hold at most 100 work correlations for one session, bounding a single wakeup's
work references. Reuse a work ID for the same accepted work rather than creating one per retry.

## Connection-Owned Subscriptions

The owner creates and lists subscriptions through:

- `POST /api/assistant-connections/:id/event-subscriptions`
- `GET /api/assistant-connections/:id/event-subscriptions`

Creation takes `callbackUrl` and lifecycle `eventKinds`: `session.created`, `session.input_required`,
`session.idle`, `session.completed`, `session.failed` and `session.stopped`. Other kinds are refused
for this transport before subscription creation. The service sets the Assistant connection
scope and disables content options. The response returns the signing secret once; keep it separate
from the Assistant bearer and OpenClaw hook token. Detail, delivery-journal, rotate, resume and
revoke routes are under `/api/assistant-connections/:id/event-subscriptions/:subscriptionId`
(GET, GET `/deliveries`, POST `/rotate`, POST `/resume`, DELETE). They check the exact connection
owner and work for non-personal organizations too. Owner views expose the configured exact private
address set for inspection; events and journals never include it. Connection-owned subscriptions are excluded
from the project/automation UI list. Ordinary session credentials and Assistant bearer credentials
cannot configure standing callback authority.

Only tracked, currently authorized work matches an Assistant subscription. Its envelope includes
`assistant: {controlPlaneId,connectionId,work:[{workId,revision,attentionRevision}]}` alongside the
minimal lifecycle fields. It excludes automation parameters, session names, question titles,
transcripts and results. The existing signature, event ID, lease, bounded retry, pending limit,
redirect refusal and journal retention semantics still apply. The worker rechecks current owner,
grant, source placement and binding after DNS resolution and before transport. Connection change
notifications cancel active work promptly; live checks remain authoritative after missed hints or
restart. Revocation clears subscriptions and pending delivery bodies.
Locally unauthorized deliveries are dropped and their bodies cleared; they do not count as callback
failures or pause delivery for other authorized work on the connection.

Attention notices use `assistant_work_read` to retrieve current occurrence/request coordinates and
relative paths into the supported Wollipog session/attention UI. Resolve paths only against the
owner-configured installation origin. A notification is not an approval. Required owner approvals
stay on their supported authenticated Wollipog path; an ordinary Discord reply never supplies one.
Direct pending updates and reconnect/status observations share a durable occurrence key, so the
same attention occurrence does not produce an additional wake through each producer.

## Local and Remote Transport

The narrow receiver is in `apps/control-plane/src/assistant-event-receiver.ts`. Run it beside the
external Assistant in a separately authorized process with its own protected SQLite database, not
inside a hosted agent session or by restarting the hosting stack. This foundation exports library
composition; it does not install or start a daemon.

Create a Fastify instance, install `AssistantEventInbox` on that database, then register
`registerAssistantEventReceiver` with the exact installation, connection, subscription, current
signing-secret lookup and inbox. It accepts signed raw bytes at `POST /wollipog/events`, verifies
the existing `x-wollipog-*` signature and clock-skew contract, and responds 202 only after durable
acceptance. Configure SQLite durability and protect its file, WAL and backups. Event identity is
scoped by installation and subscription; changed bytes with a reused ID conflict. Signature and
current-secret checks happen before duplicate lookup, including after key revocation.

Use literal-loopback HTTP for a receiver on the control-plane host, or HTTPS with normal certificate
verification for a remote receiver. OpenClaw's built-in MCP Events signature format is incompatible;
do not point this transport directly at that plugin. The receiver calls the dedicated-bearer
`/hooks/agent` interface instead. Restrict OpenClaw hook agent IDs and session-key prefixes.

Private-network callbacks are opt-in per Assistant subscription. The authenticated owner's creation
request may include `privateAddresses`, one to eight exact IP addresses in RFC1918, CGNAT/tailnet,
or IPv6 ULA space. The persisted URL fixes scheme, host, port and path. HTTPS remains mandatory;
all DNS answers must match that exact set on every attempt and the selected address is pinned.
There are no wildcard/CIDR, redirect, global environment or Assistant self-service exceptions.
Loopback, link-local/metadata, multicast/reserved and mapped-address exceptions remain refused.
If addresses change, revoke and recreate the target with owner review. Public callbacks retain
their original restrictions. This configuration adds no inbound reachability or TLS provisioning.

## Receiver, Hook and Reply State Machines

The connector drains the inbox's bounded `pending()` pages. `dispatchAssistantWake` requires a
trusted preparation step that reads the current work, checks its binding against protected local
configuration, and rechecks live Discord account/channel/thread/DM access. Its final synchronous
recheck must cover connection/binding changes during preparation. A stale or unavailable permission
check blocks progress; it never falls back to a shared channel. Keep these checks outside the model.

The durable wake states are `pending → dispatching → accepted|uncertain`. Reservation precedes
HTTP. `dispatching` after a crash is also uncertain. A run ID confirms hook admission only, not
execution or Discord delivery. A missing/malformed response remains uncertain and is not blindly
replayed after OpenClaw's in-memory replay cache resets. Reconcile command receipts and current work
first. The tested hook client supplies an idempotency key and the explicit bound agent/account/
conversation, and sets `deliver:false` to keep automatic model replies outside the receipt boundary.
The dedicated agent's tool policy must also prevent direct Discord/message-tool sends that bypass
the trusted sender. Do not enable result delivery until that policy and the sender integration are
verified; `deliver:false` alone does not constrain arbitrary tools an agent already possesses.

The Discord sender must be wired separately to the trusted connector. Before rendering and again
before sending, recheck current source access, requester binding and live destination access.
Use the reply-intent service with a logical work revision:

1. `beginReply` durably changes a new intent to uncertain before entering Discord. Only a returned
   `state:"send"` permits a new send. Existing uncertain/confirmed intents never authorize another.
2. Capture an actual Discord message ID. `confirmReply` records it after current authorization;
   HTTP success, hook run IDs and model assertions cannot substitute for a message receipt.
3. If a send response is lost, reconcile through Discord-supported message lookup or retain the
   uncertain state for explicit review. Do not promise exactly-once delivery or resend by default.

The current foundation exposes these as service primitives, not model-callable tools: a model must
not forge confirmed sends. A remote production sender still needs an authenticated connector receipt
transport and actual Discord permission/reconciliation integration. Those are remaining #4467 work,
not evidence supplied by this foundation.

## Verification Boundary

For operations, answer three separate questions: did the control plane stage/deliver a wakeup,
did the receiver durably accept/admit it, and did Discord return a message receipt? The existing
subscription journal answers the first. The receiver's structured `assistant_event_ingress` logs
carry request ID, hashed event correlation, entry point, bounded reason, duplicate flag and duration;
its inbox/wake tables answer the second. Reply intent state answers the third. Never infer a later
step from an earlier success. Alerting/production traffic evidence remains pending deployment.

If delivery stalls, inspect subscription state/pause reason and its bounded journal first, then
the matching receiver fingerprint and inbox/wake state. Invalid signatures require configuration/
key review; conflicting event identity requires reconciliation. A dispatching or uncertain wake,
or uncertain reply, requires receipt readback before any retry. Never attach raw database rows,
receiver configuration, hook bodies, signing keys or private destination coordinates to diagnostics.

Automated tests use synthetic identities, real SQLite reopen, Fastify request handling, and real
loopback HTTP against a fixture hook. They cover signature failures, stale timestamps, restart
deduplication, conflicting event IDs, wrong connections, uncertain hook admission, reply receipt
fences, binding/grant revocation during DNS, and exact-address network exceptions. They do not prove
OpenClaw execution, live Discord access changes, remote TLS, multiple machines, SSH execution or the
full Discord request/response workflow. Model authentication, Discord bot configuration, Assistant
credentials and authorized test destinations must be configured through the owner's supported paths
before real acceptance can be recorded. Never replace unavailable integration evidence with mocks.
