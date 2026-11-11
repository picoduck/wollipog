# Assistant Connection Observability and Recovery

Refs #4468. These operations use the same connection-management service as the authenticated
owner HTTP routes and the same durable command-receipt store as session management.

| Operation | Purpose |
| --- | --- |
| `connection_list` | List this granting user's connections in the current organization, installation metadata, operation inventory and accessible projects. |
| `connection_activity` | Read an owned connection's latest 100 operation outcomes, with current-access target labels and no arguments/results. |
| `dest_list` | Inspect existing requester/destination bindings, including revocation state. |
| `sub_list` | List active/non-revoked subscription metadata for an owned connection. |
| `sub_get` | Inspect one owned subscription, its state, pause reason and callback configuration. |
| `delivery_list` | Inspect up to 100 recent content-minimized delivery-journal entries. |
| `delivery_resume` | Resume an existing owner's callback through the existing outbound service. |
| `install_name` | Rename the installation, under the same personal-organization restriction as the owner app. |

These are installation-wide connection-management operations: the caller needs an all-project
grant and the exact operation (or all operations). A caller-supplied project label cannot turn
this metadata into a selected-project read. The granting user and organization must own every
target connection; organization ownership alone cannot inspect another user's connections.
Current credentials, active owner authority and operation/project grants are rechecked on every
call and before returning data. The tools do not alter their own standing authority.
`delivery_list` replaces stored free-form transport diagnostics with fixed codes:
`callback_http_error` when an HTTP status was recorded, otherwise `delivery_transport_or_policy_error`.
Use status, attempt count and retry time for model-side triage; raw host/TLS details stay on the
authenticated owner's delivery-journal path.

Connections and activity may describe a revoked target connection, for diagnosis. Destination,
subscription and delivery inspection/resume require a non-revoked target connection. Subscription
IDs are checked against the exact connection, including for delivery reads and resume. Signing
keys and Assistant/connector bearer credentials never appear in these responses or receipts.
Destination metadata is private; use the ordinary authenticated MCP connection, not a shared
Discord conversation. The binding-scoped Discord ingress still does not expose these tools.

## Resume and Reconcile

Inspect `sub_get`, then `delivery_list` to distinguish paused callbacks, retryable deliveries and
terminal dropped/failed records. `delivery_resume` takes `connectionId`, `subscriptionId` and a
stable `commandId`. Resuming changes the existing subscription's state to active and clears its
pause/failure counter. It does not change the callback URL, event kinds, private-network exception,
signing credential, grant or destination binding, and does not replay terminal deliveries.
The existing sender still checks current work/source authority and its network restrictions.
Events observed while paused are not recreated by resume. Use `assistant_work_reconcile` to
recover current authorized work state after a pause, missed callback or receiver outage.

Under `destructiveConfirmation: confirm`, resume first returns a bounded preview and expiring
`confirmationId`. Repeat unchanged arguments and the same command ID with that ID. The preview
binds the current grant revision and subscription configuration/state; a changed preview refuses
without reserving a command. Confirmation consumption and command reservation share a savepoint.
Under `none`, the existing standing grant suffices. Installation renaming is not destructive.

Mutation receipts contain request digests and resource coordinates, never cached private response
bodies or raw errors. After a lost response, use `command_get` and the authorized read tools.
Repeating a command ID reconciles the receipt and never resumes/renames again, including after
restarts or uncertain errors. `succeeded` means the application accepted the state change; it does
not prove a webhook arrived, an OpenClaw run executed, or Discord received a message. Pending
delivery resumes through the existing scheduler; inspect later journal state for actual progress.
Connection activity records completion/refusal of the tool call; inspect the durable command
receipt to distinguish an accepted application change from an uncertain service outcome.
After the target connection is revoked, `command_get` can still return this caller's content-free
resume verdict, requiring the original operation, all-project grant and exact target ownership.
It returns no revoked connection metadata and cannot authorize another resume.

## Human Authority Paths

The audit retains exact human-authority reasons and remedies for connection creation/configuration,
rotation/revocation, destination-binding creation/revocation, subscription creation/rotation/revocation,
and Discord connector-credential issuance/revocation. Those actions establish or remove standing
access, select recipients/private-network exceptions, or issue signing/bearer credentials. Use the
corresponding authenticated owner API in Assistant Connections; no model argument grants approval.
Resume is recovery under existing authority, so it has a tool instead of an authority exclusion.

## Evidence

The regression suite exercises SQLite, owner HTTP adapters, MCP, current grants, source ownership,
confirmation fencing, durable duplicate/uncertain receipts and reopening a persisted database.
It uses synthetic identities and credentials. This is automated/mocked evidence, not real
OpenClaw model, Discord, remote-host or SSH execution. The production inventory test checks the
actual entrypoint registers every group-5 tool. Other parity groups remain acceptance blockers
until their own exact audit entries are delivered; this slice changes only connection-family entries.
