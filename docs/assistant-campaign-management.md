# Assistant Campaign and Review Management

Refs #4468. Group 7 exposes owner campaign inspection and review management through the same
non-HTTP application operations as the owner API. It does not grant an Assistant a session
credential, campaign role, approval vote, or authority to change standing policy.

| Tools | Owner Capability |
|---|---|
| `campaign_summary`, `campaign_decisions`, `campaign_scope`, `campaign_recs` | Campaign status, decision usage, authorized issue scope and recommendations |
| `campaign_items`, `campaign_item`, `campaign_forge_refresh` | Work ledger and bounded forge status refresh |
| `campaign_behavior` | Read current campaign behavior and compatible choices |
| `desc_request_list` | Read the owner's visible descendant requests and recovery advice |
| `decision_list`, `decision_get` | Inspect workflow decision occurrences without resolving them |
| `review_list`, `review_get` | Inspect controlled review sessions and validated outcomes |
| `review_find_list`, `review_find_add`, `review_find_set`, `review_find_send` | Inspect, create, update and send inline review findings |
| `campaign_branch_clean` | Execute existing approved merged-branch deletions |

All operations take `sessionId`. Exact-resource operations also take `itemId`, `occurrenceId`,
`reviewSessionId` or `findingId`. Read operations accept `query` with the owner API's bounded
pagination/filter fields. Finding mutations accept `payload` with the owner API fields and a
client-generated `commandId`. Branch cleanup takes `commandId` without a payload.

## Current Access and Recovery

Every call intersects the granting owner's current application access with the connection's
current operation and Project grants. No model-supplied actor, ancestry, Project label or
credential can establish access. The shared projections preserve the owner's narrower
descendant, cost and forge-runner visibility. A selected-Project connection cannot read a
campaign aggregate that embeds sessions or detached ledger attempts outside those Projects;
it receives a content-free refusal. Use a connection with the appropriate existing grant or
the owner's Campaign Status rather than interpreting a partial aggregate as complete.

Asynchronous operations recheck credentials, grant revision, resource placement and owner
access before later effects or returning private results. Rotation, revocation or a changed
grant fences the in-flight request. Cleanup rechecks before each deletion, and the existing
forge action still validates the exact approved decision, digest, merged head and dependent
pull requests. Cleanup never approves a branch deletion or other action.

Finding add/update/send and branch cleanup reserve durable command receipts before dispatch.
An existing `commandId` reconciles the original request and never dispatches it again; changing
its arguments is refused. Receipts store identity, argument digest and verdict, not finding
text, provider errors or private result bodies. Inspect `command_get` and current state after
an accepted or uncertain outcome. A known service success retains its receipt even if access
changes before the response; private results remain withheld.

Campaign behavior capability choices and installation counts also intersect the current runner
access of the connection's granted Projects; the owner HTTP view retains the owner's full catalog.
A known authority refusal before any service effect settles the reserved command as `failed`
and returns an MCP error with refused activity. Once a service effect could have started, an
unknown or partial outcome remains `uncertain`; it is never relabeled safe to redispatch.

When `destructiveConfirmation` is `confirm`, finding resolve/dismiss and branch cleanup return
an affected-scope preview. Repeat unchanged arguments and command ID with the short-lived
`confirmationId`. Finding revisions, deletion decision snapshots and grant revisions bind the
preview. Confirmation consumption and command reservation share a transaction. Finding bundle
sends ordinary review instructions; it does not approve them. The owner service refuses local
status changes to remote-owned findings and retains the remote forge remedy.

## Human Authority and Session Protocol

Credential-screen classification, human issue-scope proposals, campaign behavior changes,
cost allocations, control changes, follow-up limits, Location inclusion, selection counts and
manual provider-slot attestation remain explicit human-authority audit entries with supported
owner/runtime remedies. The human scope-proposal branch supplies privileged provenance even
though it creates a typed decision before any scope change. An Assistant cannot assert that
provenance. Bounded allocations by a genuine Orchestrator remain subject to a separately
human-established envelope.

Owner HTTP reads are distinct from session runtime protocol. Matching session credentials
continue to own their workflow request/consume/execute/reconcile, review request/cancel,
Orchestrator ledger and evidence-review protocol. The retired campaign-review-job creation
service stays retired; historical job and repository-addition reads have no claimed owner
equivalent. No Assistant tool may impersonate those credentials.

## Residual Owner Capabilities

Integration retains the status aliases `campaign_status`, `campaign_recommendations`,
`request_list` and `review_findings` through these same current-grant-constrained services.
Overlapping canonical names register once. Protocol-only campaign and historical review-ledger
aliases are not registered; their credential boundaries and genuine-runtime remedies stay explicit.

The residual audit adds three tools. `governance_audit` reads the owner's bounded session audit
(`query.limit`, 1–500, and optional `query.before`); it cannot change governance. `session_git`
calls the same shared operation as owner HTTP, accepting exactly the existing parser's eleven
actions in `payload`: status, summary, diff, request_diff, commit, open_pr, stage_hunk, stage_lines,
discard_file, github_review_sync and forge_review_sync. No arbitrary command or runner-protocol
extra is accepted. Local mutations and review reconciliation require `commandId` and durable
receipts. Discard honors `destructiveConfirmation`, binding the diff hash, file and current
worktree/runner placement. Existing busy-session, managed-worktree, capability, stale-selection,
runner deadline and review-result validation remain shared. A timeout can leave an uncertain
receipt; inspect it and current state instead of redispatching.

`prompt_image_add` accepts `sessionId`, `commandId` and optional `sourceArtifactId`. The source
is an opaque existing image artifact reference, and both source and destination require current
owner, operation and Project access. For a new image, a client sends allowed raw image bytes to
`POST /assistant/sessions/:sessionId/prompt-images/:commandId` using its current Assistant bearer.
Authorization runs before body parsing, cross-origin browser requests are refused, and the
endpoint dispatches the same operation. It takes no filesystem path or base64 model argument.
The existing prompt-image service enforces MIME/signature/size, content-addressed storage,
deduplication and prepared-image retention. Responses and receipts contain opaque metadata and
artifact references; receipt identity binds MIME, byte count and SHA-256, never stored image
bytes. Reusing a command with different bytes is refused.

Seven residual routes remain human-authority exclusions: authentication recovery, raw provider
account choices, logout, account switching, Parent Control mode/policy and the configured policy
hook. Raw account choices expose account IDs/labels and authentication/usage context; use the
separate opaque preview tool for harness selection. Governance *reads* are an owner capability;
governance changes and lasting delegation remain human-only.

Nineteen additional exact session-protocol routes cover genuine runtime automation proposals,
Location-switch requests, issue closures, historical cross-model review jobs, reviewer media
delivery/acknowledgment/verdict, and managed ref cleanup. Every route has its own isolated
production owner-403 proof. These are credential boundaries, not tool equivalents, and the
retired review bridge stays retired. A refusal test establishes no production media-delivery or
video-readiness claim.

## Verification Limits

Tests use actual SQLite, Fastify HTTP/MCP, application services, command receipts and synthetic
owners with fixture runner transport. This is automated/mocked integration evidence. It does
not prove live OpenClaw model use, Discord delivery, SSH execution, remote TLS or deployment
of the hosting stack. The exhaustive audit continues to reject unresolved routes; a passing
inventory contract test alone does not establish full #4468 acceptance.
