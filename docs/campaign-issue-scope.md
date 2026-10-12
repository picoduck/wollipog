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
Outstanding action decisions are revoked conservatively on any approved scope change.

Protocol v208 capability-gates the complete operation before any update. Active Orchestrator participants
must share the campaign runner and repository workspace; finish or move incompatible participants first.
The control plane persists the authoritative policy on matching Orchestrator members and records an empty scope at the same revision on retired participants in another repository workspace. Restarts and provider launches independently preserve the repository boundary. The runner stores the
scope revision and updates live Claude permission classification, then restores it on reconnect/restart.
Closure inspection and execution are fenced against both repository and scope revision. Synchronization
failure is recoverable by reconnecting/updating the runner; closure remains refused until synchronization.
GitHub credentials, governance, and the independent exact issue-closure decision remain authoritative;
Custom closure approval is human-owned.

Operational questions: which human approved the change, which revision is authoritative, and did every
active participant synchronize? Workflow audit plus `campaign_issue_scope_approved`,
`campaign_issue_scope_synchronized`, and `campaign_issue_scope_sync_pending` answer these with session,
occurrence, and revision identifiers, without logging prompts, credentials, or issue bodies.

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
contract requires protocol v216 on every participant. It does not expand the repository, objective,
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
The server binds lineage evidence, rationale, expected revision, affected assignments, active
children and outstanding grants into the snapshot. Root standing authorization resolves and
consumes that exact occurrence atomically; all incompatible grants and evidence receipts are revoked
in the same transaction. Agent disposition records name the acting session, occurrence and boundary
revision separately from the original authorizing human and timestamp. Scope revisions advance the
bounded contract without altering its objective, permitted effects or limits. Custom approval still
establishes new human provenance and invalidates an older Full Control boundary.

For related publication, record and adjudicate a unique recommendation with authorized origin work
items. Submit its `recommendationId` with the exact sanitized repository/title/body/labels through
the usual workflow request. The server verifies accepted lineage and scope capacity; the runner
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
then propose the scope addition against that publication occurrence. Ledger acceptance alone grants
neither publication nor scope.

Completed delegated closure requires a delivered work-item verification with an exact report digest
and fresh observed PR evidence. The root's verification attests delivery against acceptance criteria;
the runner independently verifies actual merges at the verified heads into the repository's default
branch and containment of every merge commit there. An enqueued PR, a reported stage, missing report,
stale forge fact, feature-branch merge or open related PR refuses closure. Not-planned closure requires
a recorded cancellation/scope-removal rationale with no active attempt; an optional rejected/duplicate
recommendation must reference the affected work. Both reasons must be in the human-established contract.
Existing issue/PR inspection, audience, assignment digests, exact snapshot, expiry, scope synchronization,
guardrails, durable dispatch fence and uncertain-result reconciliation continue to apply. Changed
delivery/disposition invalidates execution. Inspect uncertain outcomes; never replay a close or comment.

Operational questions: why was this admission refused, who established its boundary, and which
scope revision was applied? `campaign_issue_admission`, `campaign_authority_evaluated`, and
`campaign_issue_scope_approved` provide entry point, request/occurrence, owner, reason and revision
fields; workflow audit and stored scope disposition retain the distinct human/agent identities.
No issue bodies, comments, prompts or credentials enter these diagnostic events.
