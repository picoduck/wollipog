# Campaign Authority

The server resolves typed workflow decisions and normalized provider requests through
`resolveCampaignAuthority`. Its result includes an owner, operation, basis, reason, and (in Full
Control) the exact boundary revision. Request listings and persisted workflow records expose that
evaluation. It is diagnostic information, never a caller-supplied grant.

## Persisted Contract

`OrchestratorCampaignPolicy.control` is optional. Omission or `{ mode: "custom" }` preserves the
existing Parent Control and five independently configured workflow owners. Selecting the
Orchestrator role alone does not authorize Full Control.

Full Control uses this server-owned contract:

```typescript
{
  mode: "full_control",
  boundary: {
    version: 1,
    revision: number,
    issueScopeRevision: number,
    repository: string,
    objective: string,
    authorizedByUserId: string,
    authorizedAt: number,
    operations: CampaignAuthorityOperation[],
    delegatablePolicyIds: string[]
  }
}
```

The boundary revision equals the campaign's workflow policy revision. Its repository and scope
revision must match the persisted human-authorized issue scope. The server constructs provenance
from the authenticated human principal, rather than accepting authorizer fields from JSON.
`SessionsService.setCampaignControl` is the internal human admission operation for the later launch
integration. It verifies ownership, root ancestry, expected revision, provider support, and eligible
policy asks before updating anything. There is no agent-facing mode setter or launch UI in this
foundation. Launch integration is tracked in #2940.

Mode changes atomically advance the policy revision, revoke pending and approved grants, retire
their durable resumes, and revoke evidence receipts. Changed scope or policy revisions cannot keep
old Full Control authority alive. Nested Orchestrators inherit the root contract; their snapshots
cannot shadow the current root. Child creation overrides cannot supply `control`.

## Request Evaluation

Full Control requires protocol v215 and a managed Claude Code or Codex App Server path. Unsupported
providers and older runners fail preflight explicitly; they are never granted wider provider
permissions. This mode does not change the selected harness, model, effort, filesystem isolation,
integrations, execution target or completion preference.

The normalized provider bridge stamps `requestSource`. Codex `requestUserInput` and Claude
`AskUserQuestion` are planning-question sources; command approvals are tool sources; external MCP
elicitation is a separate source that remains human-owned. These values come from the bridge
method, never from agent-written question input. Missing or contradictory source metadata fails
closed. A typed implementation decision derives provenance from its validated server route.

Verified planning about an authentication feature can delegate. Secret/email form fields, requests
to supply or disclose real credentials, interactive sign-in, identity administration, increased
access, reviewer escalations and guardrails remain protected. Sensitive tool inputs and ambiguous
sensitive forms remain human-owned. Text screening is conservative additional evidence; a claim
that something is implementation work cannot override protected fields or an external form's
provenance. Provider enforcement remains a separate boundary.

Tool intent comes from the concrete normalized provider operation, never its display reason.
Recognized native file inspection/edits and bounded `cat` reads require the campaign workspace binding and a verified directory or absolute bounded
target. Unrelated targets, composed shell commands, unknown effects and missing operation metadata
stay human-owned. The runner constructs `operation.filesystem` using filesystem metadata, ignoring
provider-authored evidence claims. Both lexical and canonical targets must stay in the repository;
source symlinks pointing outside it, dangling links and inaccessible targets fail closed. Reads
require an existing regular file; shell patterns, expansion and comment characters cannot name
bounded targets. Only native file mutations may prove a missing target through its canonical
parent directory. A delegated
callback rechecks the canonical evidence before granting it and cancels changed targets. This is
additional evidence, rather than a replacement for provider filesystem enforcement at execution.
Repository script commands such as test/typecheck/build do not prove their effects: their code is
editable by the agent, and a proved cwd is insufficient to authorize that execution outside the
provider's existing constraints. They remain unverified tool-effect exceptions. All Git commands
also remain unverified: repository configuration can run fsmonitor, textconv, clean filters, pagers
and other helpers, including clean filters when external diff and textconv are disabled. Canonical
cwd/path evidence and Git command flags cannot prove those effects. Preflight reports
`git_execution_without_bounded_effect_proof`; Full Control never settles a generic Git permission
request automatically. Current independently authorized policy and provider enforcement still
apply; a remaining request is human-owned with `outside_boundary` (or its stronger current
policy/protection reason). Explicit network
or provider permission-expansion envelopes stay protected even for otherwise recognized code
operations. Existing independently authorized routine policies retain their own enforcement.
Codex provides command cwd in its approval envelope. Claude's native control
channel does not provide a reliable cwd for relative Bash commands; absolute bounded operations
can qualify, and relative commands without that proof are disclosed preflight exceptions. Existing
routine policies and Guardian retain their own enforcement; their existence alone is not effect
proof for Full Control.

Eligible descendant decisions have basis `campaign_delegation`. Eligible root decisions have basis
`standing_authorization`: the human has already authorized the operation inside the persisted
boundary. Roots can resolve and consume those exact occurrences through the same bounded request
surface, but cannot create authority by approving an unrelated request. Audience, root ancestry,
snapshot digest, current revision, supersession, stop/restart revocation and one-shot consumption
remain enforced.

Synchronous root provider requests cannot wait for the parked root model to answer itself. The
server resolves eligible one-time repository operations from the standing authorization and
answers verified root choice forms using the root's recommended choice (or first offered
assumption). It records a system resolution, rather than an agent-created grant. Root forms with
no bounded suggested answer, ambiguous recommendations or invalid cardinality are disclosed
human exceptions. A real NDJSON fixture verifies that both callbacks settle and the provider
continues. No stopped-provider recovery is introduced here; that remains #2938.
Human mode admission also attempts existing eligible parked root occurrences. If delivering a
standing response fails, the exact request carries `standingAdmissionFailure` and is disclosed as
`provider_delivery_unavailable`, with human attention, rather than an unreachable self-owned card.

Only `allow_once` options can grant tool access through Full Control. A policy ask additionally
requires its exact rule ID in the human-authorized `delegatablePolicyIds` list. Unknown, disabled,
built-in and Human Required rules cannot be admitted to that list. `conditions.humanRequired: true`
is valid only for ask rules and prevents delegation, including an otherwise matching workflow
command admission. A hard deny always wins. Current rules are checked again before an agent
resolves a tool approval. Current Human Required, deny, unknown and withdrawn asks also feed every
request projection, so ownership cannot lag a policy edit. Persistent options never become eligible.

Supported trusted workflow paths remain separate from generic shell-effect classification. A typed
PR merge requires its exact resource snapshot, review/CI and current policy gates. Its consumption
still arms the exact canonical command and waits for correlated provider
evidence. Its matching one-time tool request consumes that grant without a redundant human gate.
Human Required asks and hard denies cannot be bypassed by an armed grant. No broader shell grant
is created; a changed or replayed command needs a new occurrence.

Codex's separate permissions API returns a session-wide grant. Its normalized operation records
that lifetime, so an offered `allow_once` label cannot make it eligible for Full Control admission.

Operators can inspect `authorityEvaluation` to answer why a request has its owner. The structured
`campaign_authority_evaluated` event identifies the occurrence, entry point, operation and reason;
`campaign_control_changed` identifies the human authorizer, new revision and revocation count.
Neither event logs question text, shell input, answers or objective text. Existing workflow audit
records and occurrence status show whether a revoked grant could be consumed.

## Separate Enforced Contracts

Scope changes and issue closure require a separate optional `boundary.issueAuthority` contract,
described in [Campaign Issue Scope](campaign-issue-scope.md). Listing their operation without that
human-established contract keeps them human-owned. Its protocol-v216 lineage, publication,
delivery and scope-revision checks compose with this resolver. Campaign spending/allocations are #2936. UI evidence
still requires the existing compatible provider, exact artifact ownership/digests and server-recorded
review receipts; external or unsupported evidence keeps its human fallback. Production evidence
review is #1321. Native TUI, legacy Codex exec, Pi/ACP and external elicitation cannot claim Full
Control support. Hook asks without trusted implementation/tool provenance retain human ownership.
