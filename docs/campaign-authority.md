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
elicitation is a separate source that never counts as verified planning. These values come from the
bridge method, never from agent-written question input. Missing or contradictory source metadata
fails closed: it never proves intent or a bounded effect. A typed implementation decision derives
provenance from its validated server route.

Verified planning about an authentication feature can delegate. Secret/email form fields, requests
to supply or disclose real credentials, interactive sign-in, identity administration, increased
access, reviewer escalations and guardrails remain protected. Text screening is conservative
additional evidence; a claim that something is implementation work cannot override protected fields
or an external form's provenance. Provider enforcement remains a separate boundary. Under Full
Control "protected" no longer means "asks the Human"; see [Full Control Without Prompts](#full-control-without-prompts).

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
cwd/path evidence and Git command flags cannot prove those effects, so Full Control never treats a
generic Git permission request as a bounded effect (class `git_execution_without_bounded_effect_proof`).
Current independently authorized policy and provider enforcement still apply. Explicit network
or provider permission-expansion envelopes stay protected even for otherwise recognized code
operations. Existing independently authorized routine policies retain their own enforcement.
Codex provides command cwd in its approval envelope. Claude's native control
channel does not provide a reliable cwd for relative Bash commands; absolute bounded operations
can qualify, and relative commands without that proof are class
`relative_shell_commands_without_verified_cwd`. Existing
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
no bounded suggested answer, ambiguous recommendations or invalid cardinality are dismissed (class
`root_forms_without_suggested_answers`). A real NDJSON fixture verifies that both callbacks settle and the provider
continues. No stopped-provider recovery is introduced here; that remains #2938.
Human mode admission also attempts existing eligible parked root occurrences. If delivering a
standing response fails, the exact request carries `standingAdmissionFailure` and is disclosed as
`provider_delivery_unavailable`, with human attention, rather than an unreachable self-owned card.

Only `allow_once` options can grant tool access through Full Control. Unknown, disabled, built-in
and Human Required rules cannot be admitted to `delegatablePolicyIds`; an ordinary ask left out of
that list is still an Orchestrator decision (class `undelegated_policy_asks`), while a listed one
carries no class. `conditions.humanRequired: true` is valid only for ask rules and prevents
delegation, including an otherwise matching workflow command admission. A hard deny always wins.
Current rules are checked again before an agent resolves a tool approval. Current Human Required,
deny, unknown and withdrawn asks also feed every request projection, so ownership cannot lag a
policy edit. Persistent options never become eligible.

Supported trusted workflow paths remain separate from generic shell-effect classification. A typed
PR merge requires its exact resource snapshot, review/CI and current policy gates. Its consumption
still arms the exact canonical command and waits for correlated provider
evidence. Its matching one-time tool request consumes that grant without a redundant human gate.
Human Required asks and hard denies cannot be bypassed by an armed grant. No broader shell grant
is created; a changed or replayed command needs a new occurrence.

Codex's separate permissions API returns a session-wide grant. Its normalized operation records
that lifetime, so an offered `allow_once` label cannot make it eligible for Full Control admission;
Full Control declines it.

## Full Control Without Prompts

Under Full Control the campaign never prompts the person (#2940). Every class preflight once listed
as Human Required now has a fixed owner, and every change applies only while the root's own current
Full Control boundary is valid: a stale boundary routes the request as `outside_boundary`, and a
revocation restores Custom behavior at once. Custom mode is unchanged. Runner guardrails, cost and
tool-call limits are budget authority, not request classes, and still pause for the Human; so does a
root standing response the runner could not receive (`provider_delivery_unavailable`).

| Class | Child | Root (parked) |
| --- | --- | --- |
| `secrets_and_sign_in`, `provider_access_expansion`, `persistent_permissions` | Declined | Declined |
| Any tool effect not attested inside the session's own worktree (a target or cwd outside it, an escaping symlink, globs, scripts, interpreters, Git, partial or pre-v230 evidence) | Declined | Declined |
| `external_elicitation` and other forms | Orchestrator decides once | Declined |
| `unverified_tool_effects`, `script_execution_without_bounded_effect_proof` with every target inside the worktree | Orchestrator decides once | Declined |
| `root_forms_without_suggested_answers` | Not applicable | Dismissed |
| `undelegated_policy_asks` (every target inside the worktree) | Orchestrator decides once | Declined |
| `human_required_rules` (marked Human Required, or built in) | Human | Human |

A declined occurrence has owner `orchestrator`, basis `standing_decline` and `disposition: "decline"`.
The server answers it itself with its one-time reject, or a dismissal for a question or sign-in
card; the Orchestrator may decline it too, but no one acting for the campaign can approve or answer
it. A credential question asked as a typed implementation question creates no decision at all. A
request offering no one-time allow is never converted into anything else: it is declined.

The worktree allowlist decides whether a tool effect can be approved at all. No denylist can name
every credential store, and no runner isolation mode hides those stores from a child: bwrap binds
`/` read-only, Seatbelt allows file reads and provider mode has no sandbox. So the Orchestrator may
allow a child's tool request once only when the runner produced complete filesystem evidence and
attests (v230 `filesystem.containment`) that every resolved real target, and the resolved cwd, lies
inside that session's own canonical worktree root, the root the server knows for it. Anything else
is a plain standing decline (reason `unresolved_effects`) for root and child: a target outside the
worktree, a symlink whose real path leaves it, a glob, script, interpreter, Git command, unparsed
input, partial evidence, or evidence from a runner older than v230 (whose containment claim is
ignored). Approvability never depends on a missing credential flag. A child is told once per
revision, content-safely, to retry with explicit file paths inside its worktree, and the campaign
policy states the same rule for the root. A parked root cannot judge its own request, so it allows
once only a verified bounded effect inside its worktree, answers with its own suggested choice, and
declines the rest.

The runner attests a target only when its identity provably stays inside the worktree, and fails
closed on anything it cannot attest: a `..` segment (never lexically collapsed, because the kernel
resolves it after the symlinks before it), a symlinked parent or final target whose real path
leaves the worktree, an existing file with more than one hard link (for reads and every mutation,
since editing the alias edits the external inode), anything that is not a regular file or, for a
file to be created, a directory (FIFOs, sockets, devices), `/proc`, `/dev` and `/sys` paths and
magic links, a target on another device than the worktree root or below a mount point inside it
(read from `/proc/self/mountinfo`, so a same-device bind mount is caught too), and any Windows
path (junctions, reparse points and short names are not modelled). Real paths are compared
exactly, so a case-insensitive alias on macOS can only fail. Each target records its `dev:ino`, and
the pre-approval recheck re-runs the same resolver, so a swapped inode, a new hard link or a new
mount cannot reuse the evidence; the window between that recheck and execution remains.

Credential screens remain as defense in depth: a hit is `secrets_and_sign_in` blocked work rather
than a plain decline. They match the command text and the runner-resolved real paths by name
(`.codex`, `.claude`, `.claude.json`, `.ssh`, `.aws`, `.azure`, `.env*`, `.config/gh`,
`.config/gcloud`, `.config/op`, `.kube`, `.pgpass`, `.gnupg`, `.password-store`,
`.terraform.d/credentials*`, `.git-credentials`, `.netrc`, `.docker`, keychains, keyrings,
`auth.json`, `.credentials.json`, among others), and the runner marks a target `credentialStore`
when its real path is inside a directory it knows holds credentials: its data directory except the
managed worktree root, managed profile homes, configured account homes, the default provider homes,
each session's provider credential home, and the provider config directories in the runner's, each
agent's (indirections resolved) and each session's environment.

Each standing response is sent at most once. A durable fence is claimed before the response is
sent and released only when the send provably did not happen, so a card that a repeated snapshot, a
reconnect or a restart restores is never answered twice. A sign-in card is fenced by its stable
recovery request id, because runner startup rebuilds it with a fresh occurrence id; the runner
completes an accepted Dismiss Recovery itself once an interrupted provider turn settles, rather than
refusing it. The accepted intent is written durably on the runner before any wait and never
expires: a runner that stops at any point after accepting it, including during the first wait,
completes it on restart instead of re-raising the card. That durable dismissal is a v230 runner
capability (`durableAuthDismissal`). An older runner refuses Dismiss Recovery while the turn settles
and keeps the card; it still gets exactly one fenced dismissal, never a re-send, and the sign-in
stays content-safe blocked work (logged as `campaign_auth_dismissal_runner_upgrade_required`) until
the runner is updated. Nobody is prompted. Requests restored by runner registration, runtime
snapshots and history hydration get the same standing response as live ones; an Orchestrator's own
explicit decline is a separate single action.

The credential, access and lasting-grant declines become content-safe blocked work in Campaign
Status (reason `request_declined`, action `continue_without_request`), so unrelated work continues
and the person can see it without being asked. The record stores only the class and a hashed first
occurrence: one record per session and class, a redelivered occurrence counts once, it is never
dispatched or offered for override, and a verified child report or a revocation settles it.

Evidence follows the same rule. With UI Evidence Approval inside the boundary, the Orchestrator owns
every UI evidence decision, including video without a certified media reviewer, external links and
an Orchestrator whose client cannot view images. It is delivered only the child's own inspectable
screenshots, and approval still needs a receipt for every item, so it asks the child for screenshots
attached as Session artifacts or denies the claim as unproven. Certified delegated video review
still applies when available, and operator-enabled frame review derives a short video's frames for
the boundary's UI Evidence Approval exactly as it does for a Custom saved Orchestrator owner; the
root's own saved owner plays no part (#1321). Ownership the Orchestrator holds only because Full Control kept a
decision from the Human can deny, never approve: an approval needs every evidence route (screenshot
review, operator-enabled frame review, the certified media-only reviewer) directly available to the
Orchestrator when it resolves, and an approved decision stays consumable only while they still are,
so frame review switched off or moved to another controller, or a media reviewer whose disclosures
changed, revokes it. An authorization that leaves UI Evidence Approval out keeps evidence with the
Human.

Operators can inspect `authorityEvaluation` to answer why a request has its owner. The structured
`campaign_authority_evaluated` event identifies the occurrence, entry point, operation and reason;
`campaign_control_changed` identifies the human authorizer, new revision and revocation count.
Neither event logs question text, shell input, answers or objective text. Existing workflow audit
records and occurrence status show whether a revoked grant could be consumed.

## Separate Enforced Contracts

Scope changes and issue closure require a separate optional `boundary.issueAuthority` contract,
described in [Campaign Issue Scope](campaign-issue-scope.md). Listing their operation without that
human-established contract keeps them human-owned. Its protocol-v217 lineage, publication,
delivery and scope-revision checks compose with this resolver. Campaign spending/allocations are #2936. UI evidence
still requires the existing compatible provider, exact artifact ownership/digests and server-recorded
review receipts; external or unsupported evidence keeps its human fallback. Production evidence
review is #1321. Native TUI, legacy Codex exec, Pi/ACP and external elicitation cannot claim Full
Control support. Hook asks without trusted implementation/tool provenance retain human ownership.
