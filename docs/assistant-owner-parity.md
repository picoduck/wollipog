# Assistant Owner-Capability Parity

Refs #4468 and #4462. The integrated owner-capability audit has zero gaps. Live workflow
acceptance remains separate from this automated API/service coverage.

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

The owner has now selected full parity within this campaign. The #4468 main item owns groups 1–2,
the shared audit and gate, and later REAL acceptance runs. Separate campaign work items own groups
3–7. Their delivery is required before #4468 and #4462 can be completed. Staging controls PR size;
it does not waive a remaining blocker.

## Sibling Registration Contract

1. **Name and source.** Use a short, unique `snake_case` operation name, at most 32 characters.
   Keep each group's registrations in its own module and register it in the production composition.
   Cite the exact owner route as `METHOD /api/.../:parameter` in an exported route-to-tool mapping
   or beside the registration. Call the same application service or extracted shared handler as
   that route. Document any equivalent canonical read adapter; a matching name alone is not parity.
   Do not inject HTTP, impersonate a human/session credential, or invent parent/child ancestry.
2. **Current authority.** Resolve the live target and check the connection's current operation and
   Project grants plus the granting owner's current access. Check all affected source/destination
   resources. Installation-wide management must not acquire access by accepting a Project label.
   Recheck after asynchronous reads and before later effects; never return private data after a
   grant is narrowed. Preserve the shared owner's validation, visibility, lifecycle and recovery
   rules. An app-management confirmation never replaces an existing typed human approval.
3. **Mutation identity.** Require a caller-stable command ID and reuse
   `AssistantCommandReceipts` from `assistant-command-receipts.ts`, in the connection's existing
   namespace. Session/owner/status tools call it `commandId`; the delivered automation/skill tools
   call it `operationId`. Preserve published schemas rather than silently renaming them. Both use
   that value in the same durable receipt store; `command_get` looks it up as `commandId`.
   Bind installation, connection, operation, canonical argument digest, grant revision
   and resolved target. Reserve before the effect. After current authorization, reconcile an
   existing receipt through `reserve`'s operation/digest check before recomputing effects that may
   already have removed the resource. A duplicate never redispatches; accepted/uncertain delivery
   requires `command_get` and resource recovery. Retain content-free verdicts/references, not raw
   errors, credentials or private response bodies. Service acceptance is not lifecycle completion.
4. **Destructive confirmation.** Honor the current `destructiveConfirmation` policy. Under
   `confirm`, return an authorized preview without reserving or dispatching; bind the exact
   arguments, target and affected scope, operation, connection and grant revision using
   `AssistantCommandConfirmations`. Repeat the unchanged caller command ID and arguments with
   `confirmationId`, using the operation's existing ID parameter name.
   Consume the one-shot confirmation inside the receipt reservation's same savepoint before any
   effect. Changed/expired/used previews fail closed. Under `none`, the current standing grant
   applies; other mandatory human gates still apply. Never expose inaccessible affected IDs in
   a preview or silently act on resources filtered out of it.
5. **Audit transition.** Merge main before review. Edit only your assigned group's exact entries
   in `assistant-owner-capabilities.json`. Keep every unresolved entry as a `gap` whose reason
   begins `NOT-YET-SUPPORTED blocker:`. Replace it with `{"tools":["actual_registered_name"]}`
   only when the production registry contains the operation and tests exercise the equivalent
   owner behavior, current-grant refusal and, for writes, receipt replay/uncertainty and applicable
   confirmation behavior. A sibling PR or planned tool is not delivered coverage. Preserve all
   other groups' classifications. Do not delete a candidate or turn a remaining gap into an
   exclusion. Route removal or a newly discovered human gate needs explicit coordinated audit
   handling; it is not a reason to hide an unresolved app-management operation.

The audit stays a single JSON object, **one exact route entry per physical line**, sorted by route
key using JavaScript's default string order. Values stay compact on their own line. Run:

```sh
node scripts/format-assistant-owner-capabilities.mjs
node scripts/format-assistant-owner-capabilities.mjs --check
node --import tsx --test apps/control-plane/src/owner-management-inventory.test.ts
```

The formatter changes layout only. It never discovers routes or invents registrations/exclusions.
During conflicts, retain each group's intended exact entry, then run the formatter; do not replace
the whole audit with one side. Run your behavior tests as well as the audit contract test. The
strict gate below must eventually pass with no class-4 entries before final campaign acceptance;
an ordinary audit-contract pass while gaps remain is not acceptance evidence.

Run the audit contract and new behavior tests:

```sh
node --import tsx --test apps/control-plane/src/owner-management-inventory.test.ts apps/control-plane/src/assistant-owner-management.test.ts
```

Run the **strict acceptance gate**:

```sh
node --import tsx apps/control-plane/test-support/owner-parity-snapshot.ts --require-complete
```

The strict gate exits nonzero for any gap, absent tool registration, or undocumented exclusion.
After integrating all parity groups it reports `303` exact routes, `202` registered tools and
`0` gaps. Passing the audit contract alone still does not establish strict acceptance; run the
actual production-composition command above.
The fixture starts only a new temporary test control plane/database with a reserved loopback
port and pricing-network access disabled, then closes it and removes its state. It never imports
the hosting database or inherits its registered SSH Machines or unrelated sessions.

Automation/skill PR #4477 is merged. Twenty exact owner-route entries now name its actual
production operations, including the machine-version read and its policy-only projection through
`skill_pin_get`. The production-composition test verifies these tools are registered alongside
owner/session operations. Automation update, enable and pause share the owner update service.
The group-6 [automation and Skill Library parity delivery](assistant-skill-parity.md) registers
the remaining ordinary management paths and documents four exact human-authority routes. Its
group-specific gate checks actual production registration and refuses remaining group-6 gaps.
The integrated global strict gate also verifies the other delivered groups.

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
credentials, and do not substitute for owner management capabilities. The inventory now
contains 303 owner-route candidates. PR #4476 also added installation renaming; it was recorded
as an explicit app-management gap. Merged PR #4497 now delivers `install_name` along with
connection, binding, subscription and delivery diagnostics/recovery operations. All eight exact
route mappings and its refined credential/standing-authority exclusions are preserved beside
the status mappings. These shared registrations use the same receipt store. All initially
unresolved candidates are now mapped or explicitly classified. Establishing or changing
credentials, grants, bindings and subscription
configuration retains human authority.

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

## Status, Results and Read Status

The integrated status slice retains its supported owner reads and results, including the
three reminder tools already delivered with session content. Overlapping campaign/review names
register once through the campaign service; four supported status aliases use that same service.
The HTTP adapter and Assistant
adapter execute the same explicit application handlers, with a current owner principal. They do
not inject HTTP, fabricate a session credential, or borrow an Orchestrator's ancestry. HTTP auth
and agent-only mutation routes retain their existing gates. The shared HTTP adapter preserves
response headers, including `no-store`. MCP applies the same shared reader-specific projections.

| Purpose | Operations |
| --- | --- |
| Status and History | `session_status`, `session_lookup`, `session_archive_list`, `session_usage`, `session_events`, `session_history`, `session_children`, `worktree_ops` |
| Results | `result_ack`, `result_handoff`, `result_blocked_ack`, `result_missing_ack`, `result_retry_ack` |
| Reminders | `reminder_get`, `reminder_set`, `reminder_remove` |
| Review Reads | `review_list`, `review_get`, `review_findings`, `review_jobs`, `review_job`, `review_job_artifacts` |
| Request Reads | `decision_list`, `decision_get`, `request_list` |
| Campaign Reads | `campaign_status`, `campaign_decisions`, `campaign_items`, `campaign_item`, `campaign_recommendations`, `campaign_scope`, `campaign_behavior` |

Use `sessionId` plus the exact route coordinate (`reviewSessionId`, `jobId`, `occurrenceId`,
`itemId` or `continuationId`) where required. `session_lookup` accepts opaque IDs directly; a
supplied `query.id` must match the authorized `sessionId`. Optional `query` carries the owner
API's string-valued cursors, epochs and filters. Numeric paging values are strings in `query`.
The shared handlers keep their limits and stale-cursor refusals. `session_events` exposes full
authorized event pages; `session_messages` remains the bounded text-only projection. Preserve
`cacheComplete`/epoch information and do not treat partial history as the full result.

Mutations also take `commandId` and the owner's request fields in `payload`. `result_ack` and
`result_handoff` require an exact `payload.revision`; acknowledgement affects only the granting
owner's presentation state and grants no approval or execution authority. Handoff requires that
owner to own the controlling Orchestrator, with both sessions covered by the current grant.
For blocked results, supply `payload.targets` containing exact `parentTurnId`/`revision` pairs;
missing-result and retry-exhaustion acknowledgements use their exact `continuationId`. The shared
service refuses an absent or non-terminal delivery. These actions never resubmit background work.

The reminder operations retain their published session-content schemas: `reminder_set` takes the
owner schedule fields in `reminder`; `reminder_remove` takes top-level `reminderId` and numeric
`revision`; `reminder_get` returns `{reminder}` directly. They are registered once, reuse the same
owner services/receipts, and are not renamed or shadowed by the status adapter. A reminder belongs
to the granting user, including in a shared organization; another user's reminder is never read
or changed. Timed and Someday schedules use the same owner validation. All status-slice
mutations honor the connection's destructive-confirmation policy, including reminder replacement.
Receipt reconciliation precedes recomputing effects, so an already completed removal remains
reconcilable after its reminder disappears. Accepted/uncertain commands are never redispatched.

Archive project constraints apply inside the shared database query before pagination and facet
computation. Each returned row also checks its embedded campaign contributors against the current
project grant; metadata admission never authorizes a session view. Status operations and mutation
previews/responses refuse disclosure if any contributing root, descendant or retained attempt
session is outside the current grant. Authority is checked again after asynchronous work;
narrowing a grant while history loads withholds the response. A completed mutation still retains
its receipt when a newly excluded contributor prevents returning its session body. Campaign
reads retain owner cost/forge visibility rules and do not create proposals, expand scope, resolve
decisions, start reviews or act on approvals.

Work-item list query fields use the same allowlist/parser on HTTP and Assistant paths. Blocked-result
acknowledgement logs preserve the HTTP request logger and its request id; Assistant logs identify
the Assistant entry point, operation and command id. Payloads and result content are not logged.

`decision_get` also reads the exact stored status of automation proposals and Location switch
requests. Their existing owner read adapters select the same session-bound
workflow-decision row; the common service also performs proposal expiry and attaches verified
merge-review evidence where relevant. No proposal-specific execution path is exposed. Campaign
inspection uses the owner-facing `campaign_status` and detail reads. The six initial aliases
`campaign_get`, `campaign_work_items`, `campaign_work_item`, `campaign_review_jobs`,
`campaign_review_job` and `campaign_review_report` are absent: their HTTP routes require the
matching session credential and the approved audit classifies them as session protocol with no
owner equivalent. Historical review-ledger and repository-addition reads retain that boundary;
the retired reviewer bridge stays retired. Production tests prove these aliases are unregistered
and every protocol route refuses an otherwise authorized owner credential.

All seven parity groups and the residual classification are integrated in the audit. Zero gaps
remain; every route names actual production tools or an explicitly justified exclusion. The
session-work, automation/Skill Library, connection, Machine/workspace, and campaign registry
guards remain active. This is not a claim that a live provider, Discord, SSH runner, or evidence
reviewer completed the workflow; those require separate integration evidence.

The production-composition scenario boots a fresh loopback control plane and synthetic database,
then compares owner HTTP responses with Assistant reads and exercises actual MCP transport,
acknowledgements, background recovery, reminders, confirmations, receipts and project restrictions.
Fault-injection tests separately cover a grant narrowed during a read and an uncertain service
response. These are **AUTOMATED/MOCKED** acceptance evidence at the runner/provider boundary.
They do not establish REAL OpenClaw model use, Discord delivery, SSH execution, remote TLS or
hosting deployment. No application UI is changed, so this slice has no screenshot claim.
