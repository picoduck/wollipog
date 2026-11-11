# Assistant Automation and Skill Management

Refs #4465 and #4462. These operations extend the same `/assistant/mcp` registry described in
[Assistant Connections](assistant-connections.md). The owner UI and Assistant adapters share
`AutomationsService`, `skills-management.ts` and `skill-version-policy-management.ts`; session
automation proposals and their exact human approval contract are unchanged.

## Operation Coverage

| Tool | Inputs and Behavior |
| --- | --- |
| `auto_list` | Accessible automations, with latest execution status |
| `auto_get` | `automationId`; configuration, revision, executions, audit events, affected targets |
| `auto_create` | `payload`: complete owner API `AutomationSpec` |
| `auto_update` | `automationId`, numeric `expectedRevision`, complete `payload` |
| `auto_enable`, `auto_pause` | `automationId`, numeric `expectedRevision`; enable/resume or pause |
| `auto_delete` | `automationId`, numeric `expectedRevision`; retains execution/audit records |
| `skill_list` | Accessible installation Skill Library entries |
| `skill_get` | `skillId`; metadata, latest content, assignments, revision and affected targets |
| `skill_create` | `payload`: `name`, `files`, optional `description`, `groupId`, `note` |
| `skill_update` | `skillId`, `expectedRevision`; `payload`: optional `description`, `groupId` |
| `skill_version_add` | `skillId`, `expectedRevision`; `payload`: `files`, optional `note` |
| `skill_versions` | `skillId`, optional `before`; immutable paginated history |
| `skill_version_get` | `skillId`, `versionId`; historical and current content |
| `skill_restore` | `skillId`, `expectedRevision`; `payload`: `versionId`, `expectedLatestVersionId`, optional `expectedDeploymentImpact` |
| `skill_remove` | `skillId`, `expectedRevision`; remove desired library entry, retaining internal history |
| `skill_assign` | `skillId`, `expectedRevision`; `payload`: `scopeKind` (`instance` or `runner`), `runnerId` for runner scope, `agentSelector`, optional `invocation` |
| `skill_assign_update` | `assignmentId`, `expectedRevision`; `payload`: optional `enabled`, `agentSelector`, `invocation` |
| `skill_unassign` | `assignmentId`, `expectedRevision`; remove only that assignment |
| `skill_pin_get` | `skillId`, `runnerId`, optional `versionId`; machine policy and proposed content |
| `skill_pin_set` | `skillId`, `runnerId`, `expectedRevision`; `payload`: `versionId` or null for track-latest, machine `expectedRevision` or null, `expectedLatestVersionId` |
| `skill_deployments` | `skillId`; desired versus last reported state, machine online status and deployment scope |

All mutations also require a caller-generated `operationId`. Supply skill `expectedRevision` as the
opaque string from `skill_get` or a successful mutation. It covers metadata, latest version,
assignments, group deployment impact and machine pins, with a persistent per-skill write counter
that detects same-timestamp change/revert races; it is not a wall-clock timestamp.
Conflicting edits refuse before writing. Normal update/restore creates or preserves immutable
versions. Library removal preserves a private internal historical snapshot in
`skill_removal_history` and row-based `skill_removed_records`, including versions, assignments,
policies and provenance; removal copies records within SQLite without aggregating all version
content into application memory. Removed content
is not exposed through live-resource tools.

`payload` is the corresponding owner API request body, never a bearer credential. Automation
configuration includes name, cron, timezone, enabled, action, misfire/runner/concurrency policies,
finite limits and notification routing. The shared owner validators remain authoritative.

## Authority and Confirmation

Current connection and owner authority are checked before each write. Automation authorization
checks primary and alternate Machine/workspace targets, current Project Location records, and
the current placement of prompt-session targets. A caller cannot label another project's
workspace with an allowed project ID. Lists filter inaccessible records.

Skill Library entries have installation ownership rather than project placement. Selected-project
grants therefore return an empty skill list and refuse skill mutations/reads; the owner must grant
all projects plus the desired skill operations to manage installation resources. This is an
explicit grant boundary, not a session ancestry restriction. Runner assignments and pins also use
the owner's existing machine access and skill audience containment rules.

Full Access uses the owner's standing grant without an operation-by-operation approval. With
`destructiveConfirmation: "confirm"`, deletes/unassign return affected scope and a five-minute
`confirmationId`. Repeat the same operation and `operationId` with that ID. Changed arguments,
grant revision or deployment impact invalidate the preview. Confirmation is an Assistant-side
interaction; it cannot create owner approval or expand standing authority. A control-plane restart
invalidates pending confirmations safely.

Assistant-authored automations retain a durable binding to the connection, granting owner and
authorizing operation. Each scheduled campaign occurrence checks the current grant and owner at
admission, after repository inspection, and immediately before durable command delivery/retry.
The occurrence retains its original Assistant identity even after another connection re-authorizes
the schedule. Revocation, narrowed operations/projects, lost owner authority or lost target access
refuse with an `assistant_*` reason and an owner-controlled remedy. Previously sent commands whose
acknowledgment may have been lost become uncertain; they are never reported as safely unsent.
`auto_get.assistantAuthorizations` exposes the secret-free occurrence audit (Assistant, owner,
grant revision, operation and outcome). Ordinary human-author and session-proposal rules remain
unchanged. The owner directed this scheduled-campaign extension through the campaign parent.

Skill impact reports potentially affected machines within the skill's ownership audience, including
offline targets. Reported state is the last runner report, not a promise that an offline machine
has synchronized. Shared push-on-change logic sends the desired state to online compatible runners;
normal reconnect synchronization handles offline targets. Machine pinning preserves existing
protocol/capability checks.

## Retry and Delivery Semantics

Mutations reserve in the shared `AssistantCommandReceipts` store before dispatch, keyed by
connection and operation ID. Reusing an ID with different arguments refuses. A duplicate returns
the durable receipt, without repeating a write or returning cached private content. Inspect the
result resource through its normal authorized read tool. After resource deletion, reconcile via the
shared command-receipt lookup rather than replaying the resource mutation. Accepted or uncertain
receipts require reconciliation and never imply that a timeout undid a mutation. Receipt rows and
activity records contain identifiers/digests, not skill content, prompts, credentials or raw errors.

## Operational Evidence

The existing HTTP request logging and automation lifecycle events remain the transport and timing
signals; these tools add no new HTTP endpoint or external dependency. The indexed occurrence audit
answers three operational questions without logging request bodies:

- Why did a scheduled Assistant action refuse? Read the execution's named error and the matching
  `auto_get.assistantAuthorizations` row by execution ID.
- Which Assistant, owner and live grant authorized it? Read the connection ID, owner ID, operation
  and grant revision in that row; inspect the owner's current connection settings for the remedy.
- Could a retry have reached the runner? Inspect the execution's durable command state and its
  command receipt. `uncertain` means delivery may already have happened; an authority refusal stops
  further sends rather than inventing proof that an earlier send did not arrive.

The automated tests induce these refusals, inspect the persisted audit and assert that credentials
are absent. They verify telemetry shape and attribution under mocked transport, not production
traffic or a live runner/provider.

## Verification and Remaining Integration Work

`assistant-management.test.ts` uses the real Fastify MCP route and SQLite application services.
It covers broad skill access, scoped refusal, metadata/version conflicts, retry receipts,
assignment impact with offline state, automation creation/configuration/control/removal, and
confirmation/uncertain-delivery behavior. Runner transport is mocked; these are automated
integration tests, not real OpenClaw, Discord, remote-host or SSH evidence. Existing skill route
tests verify owner API behavior after extraction.

The shared receipt module comes from the delivered session-management unit, and the grant policy
comes from the delivered connection unit. Scheduled campaign tests
exercise the real shared campaign admission, database, allowance and durable outbox, with mocked
repository inspection and runner transport; they do not launch a real provider. Regular
session/workflow automations use their shared owner services. Remote proxy/TLS,
provider login, Discord setup and unavailable machines remain external integration prerequisites;
they must be verified by the campaign acceptance unit without treating mocks as real delivery.
