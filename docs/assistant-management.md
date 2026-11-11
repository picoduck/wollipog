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
`skill_removal_history`, including versions, assignments, policies and provenance; removed content
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

## Verification and Remaining Integration Work

`assistant-management.test.ts` uses the real Fastify MCP route and SQLite application services.
It covers broad skill access, scoped refusal, metadata/version conflicts, retry receipts,
assignment impact with offline state, automation creation/configuration/control/removal, and
confirmation/uncertain-delivery behavior. Runner transport is mocked; these are automated
integration tests, not real OpenClaw, Discord, remote-host or SSH evidence. Existing skill route
tests verify owner API behavior after extraction.

Pending delivery dependencies: the shared receipt module must land with the session-management
unit, and the implemented grant policy must land with the connection unit. Scheduled campaign automation
authoring currently encounters the existing sole-human-author requirement; Assistant parity for
that surface remains an explicit implementation gap until its shared runtime is extended and
verified. Regular session/workflow automations use their shared owner services. Remote proxy/TLS,
provider login, Discord setup and unavailable machines remain external integration prerequisites;
they must be verified by the campaign acceptance unit without treating mocks as real delivery.
