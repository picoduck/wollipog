# Campaign Issue Scope

Campaign issue authority is independent of the campaign work ledger. Initial explicit issue lists retain
their existing finite authorization. Epic wording and requests for an issue's children seed membership
proposals, never automatic authorization. An epic campaign cannot create delegated sessions until
its issue scope is authorized. Custom campaigns require the existing human approval.

Campaign Status exposes Authorized Issue Scope, revision, and recorded work outside authority. A campaign
owner can inspect an epic's umbrella and members, select candidates, and request exact additions/removals.
Native GitHub sub-issues and leading checklist issues in explicitly named member sections are candidates.
Dependencies, cross-repository members, and incidental references never grant authority. An incomplete or
oversized inspection fails closed; use an explicit set of up to 100 repository-qualified issues instead.

The root agent can use `get_campaign_issue_scope` and `request_campaign_issue_scope_change` to prepare the
same proposal after a human's prompt. Custom approval is human-owned; bounded Full Control admission
is described below. The exact payload includes the
expected revision, before list, additions, removals, affected assignments, and decisions that will be revoked.
Approval, persistence of the approving human/revision, and one-time consumption share one database
transaction. Pending/denied/stale/replayed requests cannot mutate scope. Changes to scope or affected work
require a fresh proposal. Removing an issue preserves history and assignments but removes issue authority.

A scope change binds and revokes only what depends on the issues it adds or removes (#3915). Its
snapshot binds every live child except those the work ledger proves unrelated to all of those issues,
by the rule issue closures use (#3914), so progress by an unrelated child never makes a pending request
stale, while a change to a child assigned to an added or removed issue does. Approval revokes exactly
the decisions the snapshot lists: a closure of an added or removed issue (or of another repository),
every follow-up publication and follow-up admission (they count against the issue capacity every
change moves), the root's own decisions, and every decision of a child without that proof. Other
closures, merges, evidence reviews and questions stay as they were and are still re-evaluated when
resolved or consumed. A closure bound to an earlier scope revision still executes when every later
revision was written by a consumed scope decision that left its issue alone; the control plane then
dispatches it at the revision it has just synchronized to the runner, whose own scope, issue, bounded
authority and mutation-fence checks apply unchanged at that revision. If scope moved again while it
was synchronizing, execution refuses without consuming the approval, and a retry synchronizes first. An armed merge survives
a change that only adds issues; one a removal revokes can still be reconciled, which only records a
forge-proven merge at the approved head. A person's approval under Full Control re-authorizes the
boundary every decision was evaluated under, so it still revokes all of them.

Protocol v208 capability-gates the complete operation before any update. Active Orchestrator participants
must share the campaign runner and repository workspace; finish or move incompatible participants first.
The control plane persists the authoritative policy on matching Orchestrator members and records an empty scope at the same revision on retired participants in another repository workspace. Restarts and provider launches independently preserve the repository boundary. The runner stores the
scope revision and updates live Claude permission classification, then restores it on reconnect/restart.
Closure inspection and execution are fenced against both repository and scope revision. Synchronization
failure is recoverable by reconnecting/updating the runner; closure remains refused until synchronization.
GitHub credentials, governance, and the independent exact issue-closure decision remain authoritative;
Custom closure approval is human-owned.

Campaign GitHub operations support validated local and SSH host targets belonging to the runner.
Container and cloud placements are unsupported. A target refusal is reported separately from origin
or GitHub authentication failures; `campaign_issue_scope_refused` logs its operation, request and
session identifiers with the fixed `unsupported_execution_target` reason, without command output.

Operational questions: which human approved the change, which revision is authoritative, and did every
active participant synchronize? Workflow audit plus `campaign_issue_scope_approved`,
`campaign_issue_scope_synchronized`, and `campaign_issue_scope_sync_pending` answer these with session,
occurrence, and revision identifiers, without logging prompts, credentials, or issue bodies.

## GitLab Repositories

Protocol v249 (`gitlabCampaignIssues`, #3539) extends issue scope and issue closure to a GitLab origin.
The campaign repository is the host-qualified project in lower case, `<host>/group[/subgroup…]/project`,
and the runner reads it with the session's own `glab` login, always naming the host. The control plane
refuses GitLab scope inspection, proposals, approval and closure while any participating Orchestrator
runner is older than v249.

- **Epics are checklists.** A GitLab umbrella is an ordinary issue of the same project; its members are
  the leading checklist entries under the named member headings, written as `#N` or as
  `http(s)://<host>/<project>/-/issues/N` of the same project. GitLab epics, issue links and work-item
  children are never read, so GitLab candidates have no `sub_issue` source.
- **Closure evidence.** Open merge requests of the project that GitLab relates to the issue, that close
  it on merge, or that mention it (`#N` or the issue address) are conflict evidence. Any list that
  reaches its 100-row read is a refusal. Delivery proof requires each merge request merged at the
  verified head into the default branch, with its merge (or squash) commit contained in that branch.
- **Closing.** A `completed` closure posts the supplied comment as a note, if any, then closes the
  issue. A `not_planned` closure first posts `Closed as not planned: <explanation>`, followed by the
  comment when one was supplied, then closes the issue; the decision still records `not_planned`.
  Neither mutation is retried; a failure after either is reported as uncertain.
- **Publication stays GitHub-only.** Follow-up issue publication refuses a GitLab repository with
  "Campaign issue publication supports GitHub repositories only".

## Bounded Full Control Issue Authority

The authenticated human admission may additionally establish `control.boundary.issueAuthority`:

```typescript
{
  epics: number[],              // Exact intended umbrella issues in the authorized repository
  relatedFollowUps: boolean,    // Evidence-based work related to authorized origin issues
  maxIssues: number,            // Maximum current scope plus reserved publication slots (1–100)
  closureReasons: ("completed" | "not_planned")[]
}
```

Omission preserves human scope/closure ownership, including older Full Control boundaries. This
contract requires protocol v217 on every participant. It does not expand the repository, objective,
operation list, provider permissions or aggregate spending limits. Only authenticated human
admission may establish or enlarge it. Nested Orchestrators inherit the root boundary and cannot
shadow it or admit their own scope. Initial authorized scope may be empty when the human establishes
an intended epic; member resolution then populates that scope through an exact decision.

Authenticated human proposals remain human-owned and do not require agent lineage. A human can
narrow or expand issue scope directly; that fresh human revision invalidates the prior standing
boundary and revokes its grants. The runner still durably stores the authoritative scope, disabling
stale standing authority locally until it is reauthorized. Human scope and closure routes remain
available. A closure outside delegated reasons, or without complete machine delivery/disposition
proof, produces a human-owned exact decision instead of silently authorizing an agent.

Scope proposals carry `lineage: {kind: "epic", epic}` for freshly inspected native/checklist members
of a human-authorized epic, or `{kind: "follow_up", publicationOccurrenceId}` for one verified
published issue. Dependencies, incidental references and cross-repository links remain excluded.
A follow-up publication is either a bounded grant, which carries its own `issueAdmission`, or one a
person approved as a human-owned decision. The second kind counts only when that person's recorded
approval of the exact payload names the boundary's author or a campaign owner: the root session's
owning user, a member of its owning team or, for an organization-owned campaign, an active owner or
admin of that organization. It must also be tied to the current objective: either it was made at or
after the current boundary's `authorizedAt`, or the boundary the server recorded with that approval
(its author and objective digest, written into the resolving audit, never taken from a request)
matches the current boundary's, so a Human scope approval that re-mints the boundary with the same
author and objective keeps it valid. A changed objective or author, or an approval from before this
record existed that precedes the current authorization, is refused as
`publication_approved_under_earlier_boundary` and leaves the change to fresh human scope review.
Such a publication carries no recommendation claim, so the server binds
it to the one accepted, non-duplicate recommendation in this campaign that records the published
issue as its result and has the payload's title subject. Every other check applies to both kinds:
consumed, controlled by the root, in its repository, never used to admit an issue before, origins
still in scope, published payload matching exactly, and scope plus reservations within `maxIssues`.
The admission evidence names which kind it was. Each Orchestrator refusal returns a fixed sentence
and a bounded `code`, such as `publication_approver_not_owner`, `origin_outside_scope` or
`lineage_missing`. A campaign owner can still propose any change from Campaign Status.
The server binds lineage evidence, rationale, expected revision, affected assignments, related
active children and affected grants into the snapshot. Root standing authorization resolves and
consumes that exact occurrence atomically; the grants it lists and their evidence receipts are
revoked in the same transaction. Agent disposition records name the acting session, occurrence and boundary
revision separately from the original authorizing human and timestamp. Scope revisions advance the
bounded contract without altering its objective, permitted effects or limits. Custom approval still
establishes new human provenance and invalidates an older Full Control boundary.

For related publication, record and adjudicate a unique recommendation with authorized origin work
items. Submit its `recommendationId` with the exact sanitized repository/title/body/labels through
the usual workflow request. The root or a member whose gates the root controls, usually the child
that drafted it, may request it; inspection and consumption run as the root. Titles compare without
one leading issue-form type tag such as `[Bug]: `, and the duplicate search uses that subject, so
an older untagged issue is still found. Every bounded publication is admitted and consumed only
through a runner that reports this subject search and comparison. The server verifies accepted lineage and scope
capacity. When it cannot admit the request, the decision goes to the person, and its
`authorityEvaluation.admissionFailure` names the failed condition (for example `title_mismatch`,
`capacity_exhausted` or `inspection_failed`, or `no_issue_boundary` in a Custom campaign), which
the server also logs. That decision stores the snapshot exactly as requested, including its
`recommendationId`, so the person's card shows it and the requester consumes the same snapshot it
sent. A named recommendation never makes a publication bounded: only the server's own
`issueAdmission` does, and a person-approved publication's name binds scope only to a
recommendation whose repository and title subject also match the payload.

In a Custom campaign the root may also request publication of a draft it wrote itself, through the
same request, get and consume workflow. That decision is always the campaign owner's, even when the
saved Parent Control policy delegates follow-up publication: only the campaign owner can approve or
deny it, never the root or another member. The root then consumes the unchanged approved snapshot
immediately before publishing. A Full Control root, an Orchestrator nested under another one, and a
child's publication resolve exactly as before. The runner
screens public content against the issue-reporting format and inspects both open and closed search
results plus the newest issues. Incomplete or duplicate evidence refuses admission. This supplements
the exact payload review; it never rewrites content or proves arbitrary prose is free of private data.
Fresh duplicate and lineage checks repeat immediately before one-shot consumption. Consumed
publication grants remain reserved until the verified issue enters scope, and cannot be reissued.
Only a consumed scope decision carrying server-verified publication lineage settles that reservation;
editing a recommendation's resulting issue never frees capacity.
Publication admission also retains the original human and objective digest. A compatible renewed
boundary can admit that already-published issue under its current relationship, origins and limits;
this never republishes it. Reauthorization counts outstanding reservations. A human scope approval
can settle an older publication only after the server independently verifies the exact issue payload.
Each publication occurrence settles through scope once, even if another issue copies its payload.
Settlement currently requires the publication's original title, body and label set. Editing that
payload before settlement leaves its slot reserved, including after a human scope addition;
restore the exact payload before verification or have the human account for the outstanding slot.
The system cannot infer a publication receipt from an edited tracker issue or a ledger claim.
After publication, read back the exact payload, record the resulting issue on its recommendation,
then propose the scope addition against that publication occurrence. Recording it is one
`adjudicate_campaign_recommendation` call with `disposition: accepted`, a reason and
`resultingIssue`; without `resultingWorkItemKey` it links the work item the earlier acceptance
created rather than creating another, the recommendation then reads `published`, and its
publication obligation clears. This applies to bounded and person-approved publications alike, in
Custom and Full Control campaigns. Ledger acceptance alone grants neither publication nor scope.

Completed delegated closure requires a delivered work-item verification with an exact report digest
and fresh observed PR evidence. The root's verification attests delivery against acceptance criteria;
the runner independently verifies actual merges at the verified heads into the repository's default
branch and containment of every merge commit there. An enqueued PR, a reported stage, missing report,
stale forge fact, feature-branch merge or open related PR refuses closure. Not-planned closure requires
a recorded cancellation/scope-removal rationale with no active attempt; an optional rejected/duplicate
recommendation must reference the affected work. Both reasons must be in the human-established contract.
A delegated closure is still created `pending`: the root approves it itself with
`resolve_descendant_workflow_decision` and its own session ID (the server rechecks the standing
authorization there), then executes it with `close_github_issue`. Executing it while pending refuses
with that exact step; a pending human-owned closure refuses with a statement that a person must
approve it. Approval at creation was considered and rejected, because it would bypass the
resolution-time authority recheck and start the 30-minute expiry before the root acts.
Existing issue/PR inspection, audience, assignment digests, exact snapshot, expiry, scope synchronization,
guardrails, durable dispatch fence and uncertain-result reconciliation continue to apply. Changed
delivery/disposition invalidates execution. Inspect uncertain outcomes; never replay a close or comment.
At the runner mutation fence, bounded closure rechecks its synchronized authority contract and
launch identity after forge inspection. A change refuses the close before recording an attempt;
`campaign_issue_closure_authority_changed` identifies the request, occurrence and revisions without
logging the issue payload or authority contents.

Operational questions: why was this admission refused, who established its boundary, and which
scope revision was applied? `campaign_issue_admission`, `campaign_authority_evaluated`, and
`campaign_issue_scope_approved` provide entry point, request/occurrence, owner, reason and revision
fields; workflow audit and stored scope disposition retain the distinct human/agent identities.
No issue bodies, comments, prompts or credentials enter these diagnostic events.

### Execution-Target Refusal Reasons

Scope inspection, proposal inspection and synchronization retain the generic
`unsupported_execution_target` failure for older peers and may add a bounded
`targetFailureReason`: `runner_mismatch`, `unsupported_adapter`, `workspace_mismatch`,
`filesystem_mismatch`, `stale_network_policy` or `unsupported_host_boundaries`.
The control plane maps recognized reasons to fixed recovery guidance; unknown or
absent reasons keep the generic safe diagnostic. It never displays runner error text.
Older control planes ignore the optional refinement and keep the existing refusal.

The `campaign_issue_scope_refused` log includes the same reason alongside its
operation (`entryPoint`), request and session correlation fields. No placement values
or command output are added. These diagnostics do not modify saved placement,
runner isolation, scope authority or closure approval requirements.
