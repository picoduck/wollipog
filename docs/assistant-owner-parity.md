# Assistant Owner-Capability Parity

Refs #4468 and #4462. This is the first staged parity delivery, not full Assistant acceptance.

## Inventory and Gate

`assistant-owner-capabilities.json` records every registered route candidate in the session,
worktree, Project/Location, Machine, automation, Skill Library and connection families. The
inventory observes actual Fastify registration, including generated routes and shared-service
registrars. It records only route patterns and tool names, never requests, resource identifiers,
credentials or results. A new/removed route fails the audit contract test until classified.

Each exact route has one classification:

- `tools`: the equivalent Assistant operations are registered in production. Tests compare the
  names with the actual registry, not a second handwritten list of supposed registrations.
- `exclusion: human_authority`: the entry names the human authority involved and its supported
  authenticated owner path. Credentials, standing access changes, required approvals and Full
  Control first-message authority cannot be supplied by Assistant text.
- `exclusion: interactive_workspace_io`: terminal streams, in-session file/reference browsing,
  and transcript-sharing UI are conversation/workspace I/O rather than app administration.
  Launch or prompt a session to perform workspace work, or use the owner's interactive UI.
  This does not exempt lifecycle/recovery, Location registration, results or status management.
- `gap`: unresolved app-management parity or a route candidate needing further owner/protocol
  classification. A gap is never an allowed exclusion. This deliberately overinclusive audit also
  exposes session-credential-only protocol endpoints; those need explicit owner-counterpart
  classification rather than being silently discarded.
- `exclusion: session_protocol`: restricted to an explicit per-route allowlist, with production
  HTTP proof that an otherwise authorized owner receives a credential-specific 403. The original
  `POST /api/sessions/:id/waits` and `POST /api/sessions/:id/pull-request-watch` attest runtime
  progress/watch ownership and retain their exact registered read counterpart `session_watch_get`.
  The 49 campaign/review/residual protocol entries described below claim no owner equivalent.
  The audit rejects this classification for every other route. The original narrow extension was
  approved in clarification `workflow_37bd52c7276345768122bfe742ceadb6`; the controlling
  Orchestrator separately adjudicated the exact 30 and 19 additions. No classification allows
  an Assistant to impersonate a session from its `sessionId`.

No external technical limitation is claimed by this slice. The inventory supports such an entry
only with a concrete reason and supported remedy. The parent authorized staged delivery through
the recorded scope clarification; all remaining gaps block final #4468 acceptance.

Group 7 adds exactly the 30 campaign/review protocol routes enumerated in
`apps/control-plane/src/campaign-session-protocol.ts` to the `session_protocol` classification.
The controlling Orchestrator adjudicated these exact routes after the discovery report:
owner HTTP returns 403 because they require matching self/parent/Orchestrator credentials.
Unlike wait/watch writes, these entries make no equivalent-owner-tool claim. Historical
campaign-review-job and repository-addition protocol reads have no asserted owner equivalent;
their remedy is the genuine credential protocol. New legacy review-job creation stays retired.
Residual discovery adds exactly 19 further entries in that same file: runtime automation
proposals, Location-switch requests, issue closures, historical cross-model review jobs,
reviewer image/video delivery and attestations, and managed-worktree ref cleanup. Each has
its own credential-specific owner-403 production proof; media refusal tests do not establish
actual evidence inspection or production video readiness.

The inventory rejects every route outside the two original wait/watch entries and these 49
explicit entries. A production HTTP test exercises every added route with an authenticated owner
who can read the target session, requires the credential-specific 403 and no protocol-domain
effects, and checks every campaign classification against that verified set. There is no prefix
or category exemption. The two original wait/watch entries retain their exact registered
`session_watch_get` requirement. The 21 owner capabilities and 16 human-authority boundaries
are described in [Assistant Campaign and Review Management](assistant-campaign-management.md).

Run the audit contract and new behavior tests:

```sh
node --import tsx --test apps/control-plane/src/owner-management-inventory.test.ts apps/control-plane/src/assistant-owner-management.test.ts
```

Run the **strict acceptance gate**:

```sh
node --import tsx apps/control-plane/test-support/owner-parity-snapshot.ts --require-complete
```

The strict gate exits nonzero for any gap, absent tool registration, or undocumented exclusion.
It is intentionally **failing** at this staged delivery. Passing the audit contract tests means
the inventory detects missing coverage; it does not mean the strict acceptance gate passed.
The fixture starts only a new temporary test control plane/database with a reserved loopback
port and pricing-network access disabled, then closes it and removes its state. It never imports
the hosting database or inherits its registered SSH Machines or unrelated sessions.

Automation/skill PR #4477 is merged. Twenty exact owner-route entries now name its actual
production operations, including the machine-version read and its policy-only projection through
`skill_pin_get`. The production-composition test verifies these tools are registered alongside
owner/session operations. Automation update, enable and pause share the owner update service.
Remaining automation/skill candidates stay explicit gaps for the residual-parity work item;
merging this dependency does not establish complete Skill Library or automation parity.

Discord/work PR #4479 is merged. Production now builds the session/work registry through
`createAssistantManagement`, preserving its authenticated Discord-origin seam and sharing the
same command-receipt store with automation, skill and owner-management operations. The inventory
test checks all these registration families, including `assistant_work_track`,
`assistant_work_read` and `assistant_work_reconcile`. These work tools track existing authorized
work, read attention coordinates and recover missed updates; they do not establish destination
authority or approve pending human gates.

The two new owner APIs for issuing/revoking Discord connector credentials are explicitly
human-authority entries in the audit. The five `/assistant/discord/...` endpoints are the
credential-scoped connector protocol, not owner management routes: command dispatch/receipt
reconciliation and work list/read/reply receipts. They require both current Assistant and connector
credentials, and do not substitute for missing owner management capabilities. Connection binding,
subscription and delivery observability remain their existing explicit gaps. The inventory now
contains 301 owner-route candidates. PR #4476 also added installation renaming; its new audit
entry is an explicit app-management gap, not a human-authority exclusion. The 199 unresolved
candidates still block full acceptance and include this connection-management follow-on.

## Delivered Operations

All mutation tools take a stable `commandId`; use `command_get` after a lost response. Arguments
are hashed and the receipt is reserved before the shared service executes. Repeated IDs never
redispatch, including after uncertain results. IDs are installation/connection scoped. Read current
resources through their authorized read tools; receipts contain no cached private response body.

| Family | Operations |
| --- | --- |
| Session Configuration | `session_config_get`, `session_config` (model, effort, service tier), `session_title` |
| Lifecycle Recovery | `session_retry_stop`, `session_cancel`, `session_unarchive`, `session_unarchive_restart`, `session_job_stop`, `session_hold_release`, `session_pending_resolve` |
| Steering Recovery | `steering_list`, `steering_get`, `steering_resolve` |
| Worktrees | `worktree_get`, `worktree_create`, `worktree_attach`, `worktree_select`, `worktree_discard`, `worktree_retry_setup`, `worktree_generate_setup` |
| Projects | `project_create`, `project_update`, `project_delete`, `project_notice_dismiss`, `project_archive_sessions` |
| Locations | `location_add`, `location_create`, `location_move`, `location_remove`, `location_rename`, `location_default`, `location_setup_get`, `location_setup_generate` |
| Machine Capacity | `runner_capacity_get`, `runner_capacity` |

Project/Location tools use `projectId`, optional `locationId` for exact Location routes, and
`payload` with the corresponding owner API fields. Location moves carry the source `locationId`
in `payload` and require both source and destination project grants. Installation-wide creation
and Machine capacity require an all-project grant; they cannot be reached by inventing a project
label. Capacity changes carry `configuredUnits` and `expectedRevision`; reread on a conflict.
With selected-project grants, `location_add` may link only an exact runner/workspace already
reachable through a currently granted Project. `location_create` registers an arbitrary Machine
folder and requires all projects; the check runs before directory inspection and again before
registration. The owner can instead add a Location through Project settings without expanding
the Assistant grant. Adding an excluded workspace to an allowed Project cannot manufacture access.
Session configuration keeps permission, budget and guardrail changes on authenticated owner paths.
Ordinary configuration does not impersonate human campaign authority or restore a stale boundary.
Project `childSessionDefaults` also changes persistent child budget/tool guardrails and remains on
authenticated owner Project settings. Resource `owner` selection remains on the owner access-scope
path; an Assistant create inherits the granting owner's ordinary default organization scope.

Destructive deletion/removal, archive/Stop/cancel, job/hold release, and pending/steering recovery
honor `destructiveConfirmation`. Under `confirm`, first inspect the target/affected-scope preview,
then repeat unchanged arguments and command ID with its short-lived `confirmationId`. A changed
grant or affected scope invalidates the preview. Confirmation consumption and receipt reservation
share a transaction. Under `none`, standing authority applies without another approval.
Location move/remove previews bind the current source Location, its Project and its affected
sessions. An inaccessible affected session causes a content-free refusal before any preview,
rather than exposing its identity or confirming an unseen effect.

## Recovery and Evidence

The owner HTTP and Assistant adapters share extracted Project/Location and capacity services and
the same worktree runner path. Validation, resource ownership, campaign boundary settlement,
notifications, offline/protocol refusals, dirty-worktree preservation and managed retirement stay
in those services. Creating a Location rechecks authority after asynchronous directory inspection,
before registering the workspace. Current-source access is checked again before returning private
results from asynchronous operations.

`succeeded` means the application service accepted the command, not that a provider finished,
capacity was released, a worktree retired, or a skill reached a Machine. `accepted`/`uncertain`
never permits blind replay or failover to another installation. After project deletion,
`command_get` returns only the content-free verdict under current operation/original-project
access. Preserve dirty/unpushed work and follow the runner's concrete recovery message.

Coverage uses actual SQLite, Fastify MCP, HTTP owner adapters and shared application services,
with synthetic owner credentials and fixture runner transport. The inventory boots the actual
production composition in an isolated test process. This is **automated/mocked execution evidence**,
not real OpenClaw model use, Discord delivery, SSH execution, remote TLS or hosting deployment.
Those remain Phase 2b. No rendered application UI changes in this slice.
