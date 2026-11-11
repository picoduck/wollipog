# Assistant Connection Contract

Refs #4463 and #4462. This foundation exposes discovery; the session/runner, automation/skill,
OpenClaw and event units add their operations to the same registry.

## Owner Management

Open **Settings → Network → Manage Assistant Connections**. Only an active organization owner
can load management controls. The dialog lists that owner's separately named connections on the
current server; switching servers or closing the dialog discards any credential shown in memory.

Create a connection with Full Access or exact allowed operations, all or selected projects, and
an explicit destructive-confirmation choice. Full Access defaults to no extra confirmation.
Inspect a connection to rename it, change grants, rotate its credential, permanently revoke it,
or refresh its latest activity. Selected-project grants exclude resources without a project;
discovery metadata is separately described in the registry contract below. Changes affect the
next authorization check, including queued work's execution check.

The dashboard sends the grant revision it inspected on every save. A stale save receives HTTP
409 and cannot overwrite a grant changed by another owner window. Refresh and inspect the current
grant before submitting again. API clients can send `expectedRevision` for the same compare-and-set
protection; legacy calls that omit it retain their explicit whole-grant replacement behavior.

Create and rotate return a credential once. It starts masked; use **Show Credential** or
**Copy Credential** to transfer it securely to the Assistant. **Dismiss Credential** removes it
from this dialog. It is never written to local/session storage or included in management reads.
Rotation immediately invalidates the old credential; revocation permanently disables the
connection. Both actions require a local confirmation in the owner UI. If a mutation's response
is lost, refresh and inspect its state before repeating it; a credential whose response was lost
can be replaced through explicit rotation.

IDs use a full-width selectable field with a copy control. If clipboard access is unavailable,
select the field and copy manually; credential copy failures offer Show Credential as the fallback.
Activity shows the Assistant identity and a readable target name, resolving current target titles
only when the owner still has access. Revoked grants remain available under Inspect Revoked Grants.

The Installation ID and Connection ID remain stable when display names change. Owners of the
personal installation organization can rename the shared installation; another organization's
owner can inspect that identity but cannot rename the shared server. Each organization owner can
rename only their own connections. Management metadata includes registered operation descriptions
and only projects that the authenticated owner can access.

The browser lifecycle test uses actual HTTP, Fastify and SQLite with synthetic owner
authentication. It does not prove configured OpenClaw, TLS, SSH or Discord interoperability.

## Identity and Transport

An Assistant connection has an immutable `id`, owner user and organization, editable display name,
current grant, monotonically increasing grant revision and revoked state. It is distinct from a
human device, session, campaign, runner credential or webhook secret. One Assistant can hold
several independently named/revocable connections, on one or several installations.

`POST /assistant/mcp` is stateless MCP Streamable HTTP (JSON-RPC 2.0; protocol 2025-06-18).
Use `Authorization: Bearer <Assistant credential>` on **every** request. Do not send credentials
in URLs or tool arguments. Configure OpenClaw with `transport: "streamable-http"`, a unique
server registry name and an Authorization header using its environment-reference facility.
Tool names are limited to 32 characters so OpenClaw's 30-character server prefix fits its
64-character full-name limit. GET streams and MCP sessions are unnecessary; GET/DELETE return 405.
The initialize response negotiates 2025-06-18; subsequent headers accept 2025-03-26 too.

Remote clients use the installation's normal HTTPS reverse proxy with TLS verification. This
endpoint does not infer authority from loopback, source address or session ancestry. The same
bearer/grant works locally and remotely. Deployment, DNS and proxy provisioning are separate.
The endpoint rejects foreign browser Origins. Existing device/session auth is unchanged.

Call `assistant_discover` to obtain `controlPlane.id` (existing database instance ID),
`controlPlane.name`, `connection.id`, current grant/revision and granted operation schemas.
IDs, never editable names or tool prefixes, distinguish connections and installations. The initial
installation display name is Wollipog and is editable through owner management.

No MCP session or cached tool catalog grants authority. Every tool call rechecks the credential,
grant, active owner's role and resource access. This first stateless adapter does not advertise
list-changed notifications: clients refresh tools/list after a grant change or reconnect; stale
schemas remain safe because execution always rechecks. Unknown versions receive upgrade guidance.

## Registration and Application Services

`apps/control-plane/src/assistant-connections.ts` exports `AssistantOperations`,
`AssistantOperation`, `AssistantConnection`, `AssistantCredential`, `AssistantGrant`,
`AssistantTarget`, `AssistantOperationReceipt` and `AssistantRefusal`.
`createAssistantOperations(db)` in `assistant-routes.ts` creates the registry and registers discovery.
`index.ts` composes one `assistantOperations` before `registerAssistantRoutes`.
Sibling units register on that instance, before listening; do not create a separate registry.

Register `{ name, description, inputSchema, resolveTarget, ownerCanAccess, execute }`:

- Validate arguments in the shared application service; schemas describe inputs to clients.
- Resolve target IDs and project placement from current server records, never trusted input.
- `ownerCanAccess` uses existing database/application access checks for the current HumanPrincipal.
  It must reload the target if ownership or placement can change. No descendant/campaign rule is
  applied merely because this is an Assistant. Preserve external OS/provider/protocol restrictions.
- `execute` invokes the existing application service with explicit Assistant attribution
  (`context.connection.id`, `context.connection.revision`, installation `db.instanceId()`). The
  supplied owner principal is the authority ceiling, not the action's attribution.
- Before dispatching queued mutations, **await `context.recheck()`**. It reloads target placement,
  current credential, grant and owner/resource authority. Dispatch without another asynchronous gap.
  Long-lived jobs must carry identity and recheck at every later authorization boundary.
- `metadata: true` is reserved for installation/connection metadata, never resource reads or
  mutations. Selected-project grants otherwise refuse unprojected targets. List operations must
  filter each result using current project and owner access rather than returning global data.

Full Access is `{operations: "all", projects: "all"}`; selected-project Full Access uses an exact
project list. `all` includes future registrations. Narrow grants list exact operation names.
There is no Assistant-only denylist. The owner cannot delegate authority they no longer possess;
loss of active organization-owner status disables the connection until restored/recreated.
Only the issuing owner can configure, rotate, revoke or read connection activity through
`/api/assistant-connections`; Assistant credentials never reach these owner-only APIs.

`grant.destructiveConfirmation` is owner-selectable `"none" | "confirm"`; omitted create inputs
normalize to `"none"`, including Full Access. Configure preserves the current policy when this
field is omitted; changing `"confirm"` to `"none"` requires an explicit value. Read current policy through
`db.assistantConnections.destructiveConfirmation(connectionId)` immediately before destructive
execution or preview. Under `"confirm"`, sibling services must implement an Assistant preview and
short-lived confirmation ID bound to the connection, operation and exact target/arguments; a stale
or changed grant requires rechecking. This slice exposes the policy/accessor, not destructive
operations or confirmation persistence. The owner can change the field through the configure API.

## Operation Inventory Responsibilities

Discovery is implemented here. The following families must register through this contract and
reuse shared services; they are pending, **not silently excluded from Full Access**:

| Unit | Required Management Surface |
| --- | --- |
| #4464 | Existing/unrelated sessions: list/read, create, prompt, configure, stop/restart, archive; runner/workspace/project discovery and management, including SSH runners and other projects |
| #4465 | Automation and schedule creation/configuration/control; skill discovery/read/update and synchronization |
| #4467 | Connection-owned subscriptions, work/correlation records, results and attention events |
| #4468 | Inventory parity and complete local/remote, multiple-connection acceptance verification |

When an existing management capability is unsupported, expose an explicit inventory limitation
and technical remedy rather than hiding it behind a generic Assistant restriction. Service-specific
permission/protocol checks remain authoritative. No existing agent-control route allowlist should
be reused as the Assistant inventory.

## Background Delivery, Revocation and Mutation Receipts

`AssistantOperations.authorize(connectionId, operationName, resolvedTarget)` checks current grants,
active owner and the registered resource-access rule for background deliveries and result reads.
Use server-resolved resource placement; no bearer secret needs to be retained in a queued record.
`db.assistantConnections.onChange(listener)` returns an unsubscribe function. Configure, rotate
and revoke emit this cleanup hint after persistence; #4467 can cancel pending delivery leases.
Listeners are best-effort hints, not authority. Restart/missed notifications require the same live
check before delivery. Listener exceptions cannot undo a committed change or hide a rotated secret.

`AssistantOperationReceipt` defines the sibling mutation persistence contract: installation ID,
connection ID, client operation ID, operation name, argument digest, grant revision, resolved target,
status (`accepted`, `running`, `succeeded`, `failed`, `uncertain`) and optional resulting resource ID.
#4464 must persist and deduplicate per connection/operation ID before launch or prompt dispatch,
reject ID reuse with another argument digest, and expose authorized lookup/reconciliation. A timeout
or expired MCP session never proves a mutation failed and must not trigger automatic replay.
This PR defines the type; it does not claim durable mutation receipt implementation.

Activity contains connection ID, authorizing grant revision, operation, resolved target, timestamp
and outcome. Retention keeps the latest 1,000 entries per connection (the activity API shows 100);
older entries are removed on insertion. No arguments, bearer credentials, token hashes or exception text are recorded.
Operation services must return secret-free errors distinguishing unavailable runners/peers and
unsupported versions. Generic unexpected errors disclose no internal exception text.

## Verification and Test Setup

For isolated integration tests use `ControlPlaneDb.open(":memory:")`, its
`localIdentityContext()` / `operatingHumanPrincipal()`, then
`db.assistantConnections.create(owner, name, grant)`; pass the returned one-time token as an
Authorization header to the real registered Fastify routes. Production issuance requires the
existing authenticated owner's device/bootstrap request. Secrets are random, shown only by
create/rotate replies with no-store, and persisted only as SHA-256 hashes.

Focused coverage in `assistant-connections.test.ts` exercises broad/scoped authorization, live
queued checks, rotation/revocation, independent connections and separation from human/session
credentials, using real Fastify and SQLite with fixture human authentication. OpenClaw, remote
TLS, SSH operations and Discord end-to-end behavior require the later units' real integration
evidence; these automated tests do not substitute for it.
