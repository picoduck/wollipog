# Campaign Issue Scope

Campaign issue authority is independent of the campaign work ledger. The issues a Custom campaign's
first message names keep their finite authorization (`issueNumbers`), but only the Custom
Orchestrator's checked proposal grants them (#4259, #4282). An epic a Custom campaign's first message
names seeds membership proposals, never automatic authorization. An epic campaign cannot create
delegated sessions until its issue scope is authorized. Custom campaigns require the existing human
approval.

Neither comes from a regular expression, a grammar or a server reading of the text (#4104, #4259,
#4282, see [Custom Epic Seed](decision-model.md#custom-epic-seed-issue_scope_seed-4104)). A first
message that writes a digit string gets a pending seed (`issueScopeSeed`) awaiting the Orchestrator's
proposal, and delegation waits while it is pending (`seed_proposal_required`). The first message is
the launch prompt or, for a campaign launched without one, the person's first prompt; any other first
message is recorded as `none`, so no later message counts as the first. The Orchestrator proposes the
issues the message asks for, deterministic floors bind them to the message, and the typed constraint
check (`scope_check`) against the person's own words then decides it:

| Checked Proposal | Seed | Issue Numbers | Delegation |
|---|---|---|---|
| Admitted: one issue the runner reads members for | `seeded`: the issue is `issueScopeProposalEpic`, and the scope inspection starts from its members | None | Waits for the person's scope approval |
| Admitted: issues (one issue without members included), each one the runner reads as an issue of the campaign repository, from a message the owner wrote | `none` | The proposed issues | Proceeds |
| Admitted: no issues (the message names none to work on) | `none` | None | Proceeds |
| Refused by a floor or the check | Still `pending`: the Orchestrator revises | None | Waits |
| Uncertain or failed, a fourth distinct check, an older root runner, or issues from a message the owner didn't write | `owner`: no seed | None | Waits for the person's scope approval |

The model may only narrow or confirm. The floors run first, with no model call: a number the message
doesn't write (as digits, inside a `#`-written range, or inside a bare-digit range right after "issue"
or "issues"), another repository's issue, a pull request or an issue the Orchestrator chose is refused,
granting no part of the proposal. The check always runs, so an empty proposal or one that adds every
referenced issue can't skip it.

`createSession` is synchronous and the proposal comes later, so a campaign is created with no issue
numbers. Until the proposal is admitted, delegation waits and every GitHub write on an issue takes the
person's ordinary approval path. Enabling Full Control waits for a pending seed.

Once an admitted proposal grants issue numbers, the control plane stores them and delivers them to the live
Orchestrator (#4269): it sends the campaign's runner a `campaign_issue_scope` `grant_issue_numbers`
operation naming the campaign session and the granted numbers. The runner sets them on the live
launch policy, which the Claude Code routine-write classifier reads on each ask, and on the stored
launch metadata, which its issue-closure checks read, so neither needs a relaunch. A provider still
launching adopts them before it starts, including a restart (of a stopped session, too) whose spec
predates the grant: the runner remembers each grant it applied and re-applies it wherever a launch
rebuilds its metadata, but only to a policy holding no issue numbers and no issue scope. The next
launch carries the same numbers from the control plane. Only Claude Code classifies issue writes this way; other harnesses ask for each write.

The delivery can only fill an empty grant with numbers this control plane already granted:

- The control plane sends it only to the campaign's own root Orchestrator, only while that session
  holds exactly the granted numbers and no `issueScope`, and never to a stopped, failed, completed or
  archived session, to a member, or to another campaign's session.
- The runner refuses it again (`grantRefusal`) for a session already holding other issue numbers or
  any `issueScope`, one with no live or launching provider, a grant naming another campaign than the
  addressed session, or malformed numbers. A delivery of the numbers the session already holds is a
  no-op (`unchanged`).
- It names no repository, revision, scope or operation, so it can't widen a scope, raise a ceiling,
  change a repository or grant an operation. An authoritative scope keeps the `synchronize` path.
- Only a v302 runner (`campaignIssueNumberGrant`) is sent it. An older runner, a disconnected one, or
  a failed delivery keeps the earlier behavior: the stored numbers reach the provider at its next
  launch, and its routine writes on them take the person's approval path until then.

Only a message the server knows the campaign's owner wrote grants issues: the owner's create request,
whose issues carry the launch provenance (`issueNumbersSource: "human_launch_request"`) that Full
Control enable trusts, or the owner's first prompt after an empty launch, whose issues don't. Any other
first message is left with the owner when its admitted proposal names issues: a first prompt from
someone else, a staged automation launch, or a recorded transcript message whose author was never
stored (a restart or a pre-upgrade campaign). A proposal for one of those can still seed an epic,
which waits for the owner's scope approval anyway.

A seed awaiting the Orchestrator's proposal survives a control-plane restart: the restarted
Orchestrator proposes as before. Only a pre-#4282 reading left pending with no reading in flight
settles as `owner`, with its reading recorded as failed. A message without digits needs no proposal,
makes no Decision call and grants nothing. Existing campaigns keep the issue numbers they already hold.

A Custom campaign whose first message was recorded before the seed existed has no seed: the build
before #4216 held it by matching that message against a regular expression on every check, and stored
nothing. So that it doesn't lose its hold on upgrade (#4258), its recorded first message gets the seed
it would get now. That happens the first time it tries to delegate, its issue scope is read, or it is
restarted (#4259, in place of the restart's old issue-list backfill), through the same proposal, check
and table. Nothing is matched against the text. A later message never counts as the first.

Approving a scope needs at least one issue, and a campaign whose message names none would otherwise
wait forever. So the owner may also release an `owner` seed: **Continue Without an Epic** on its
Epic Seed row in Campaign Status (the classification route, `orchestrator`). The seed becomes `none`.
Releasing seeds, scopes and grants nothing, and a `seeded` epic cannot be released. Once a scope is
approved, the seed holds nothing: its row reads as approved (`scoped` in the decisions response) and
offers no release.

Campaign Status exposes Authorized Issue Scope, revision, and recorded work outside authority. A campaign
owner can inspect an epic's umbrella and members, select candidates, and request exact additions/removals.
Native GitHub sub-issues and leading checklist issues in explicitly named member sections are candidates.
Dependencies, cross-repository members, and incidental references never grant authority. An incomplete or
oversized inspection fails closed; use an explicit set of up to 100 repository-qualified issues instead.
Under Full Control, recorded work outside authority is never dispatched, and a merge that would close
an unscoped issue needs the campaign owner (see [What the Scope Bounds Under Full Control](#what-the-scope-bounds-under-full-control)).

While the campaign runner is disconnected, Campaign Status shows the saved membership and revision
without a runner call, offers **Refresh Scope**, and checks again every ten seconds while the tab is
visible, so a mounted panel recovers after reconnection at the same revision (#2664). A legacy campaign
saved without a repository shows its numbers under a **Not Verified** repository and is never assigned a
guessed one. Recorded work with a saved number is listed as awaiting repository verification, not as
outside the scope; only a number outside the saved list, or another repository than a known one, is a
confirmed mismatch. None of this grants authority: reconnection, repository verification and the
existing scope and closure approvals still apply.

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
boundary every decision was evaluated under, so it still revokes all of them. Its re-mint moves the
policy revision those decisions are bound to, so reconciliation accepts that one change for an
armed merge the approval revoked: the scope decision consumed at the revocation, naming the
occurrence, under the same policy revision; exactly one revision bump since; and the re-minted
boundary still current and still giving the Orchestrator the merge. Any later policy change, any
other revocation, or an approval that was never armed stays terminal.

Protocol v208 capability-gates the complete operation before any update. Every active Orchestrator
participant must run in a Location of one of the campaign's repositories (#4118); finish or move
incompatible participants first. A participant outside the launch repository needs a v313 runner.

## Repository-Qualified Scope

The scope holds `{ repository, number }` pairs (`issues`) across the campaign's repositories: a Full
Control boundary's entries, or for Custom its launch repository and any its owner approved adding.
`owner/app#5` and `owner/api#5` are separate entries with separate authority. `repository` and
`issueNumbers` stay as the launch repository's part for older clients and runners. A scope saved before
#4118 reads as its numbers in its repository, at the same revision; nothing is rewritten and no
approval is invalidated. A legacy campaign with no saved repository stays unverified (#2664).

- **Changes.** `request_campaign_issue_scope_change` accepts refs in any campaign repository. A ref in
  any other repository is refused with the fixed code `repository_outside_boundary`, decided from the
  stored boundary before any runner call. Its sentence tells the Orchestrator to ask the owner to
  include a Project Location of that repository, then retry; otherwise to report that the work needs a
  repository with no Location in the Project. The launch repository's part is verified through the
  campaign runner as before. Each other repository's part is verified through the first online Location
  in its boundary entry, never through the root's runner, and the Location must still answer as that
  repository. If any repository has no Location online, the whole request is refused naming it and
  nothing changes. The approval snapshot keeps the launch repository's numbers at the top level and
  lists every other repository the scope holds or the change touches under `otherRepositories`.
- **Orchestrator proposals.** An Orchestrator's scope proposal (#4282) may add issues in any campaign
  repository. Each other repository's issues are read through its first online Location with their
  state, labels and title (a v318 runner; an older one is refused by name), and each floor answers for
  the issue's own repository: already in scope, held by another campaign, a pull request, closed, a
  Human Required label. An owner-named issue must be written for its own repository: a bare `#12` means
  the launch repository only, so another repository's needs `owner/repo#12` or its URL. The same number
  in two repositories is two issues everywhere, including the constraint check's questions.
- **A repository the owner names.** `proposal.repositoryName` carries the message's own words for a
  repository the Orchestrator says the work is limited to. The words must appear in the owner's message
  as whole words (`repository_name_not_in_message`): "api" is not written in "rapidly". The server, not a
  model, resolves them against the boundary: the full name, the name without the owner, or a Location's
  name, ignoring case, a leading "the" and a trailing "repo" or "repository". One match binds every issue
  to that repository (`repository_constraint_mismatch`). That proves what the name is, not what the owner
  meant by it, so it is still the Orchestrator's claim: the `repository_limit` question asks the Decision
  Model whether the message limits the work to it, rather than excluding or only mentioning it, and a
  named repository never takes the no-model path. The admitted initial scope records the limit as
  `repositoryLimit`, and a later addition outside it is refused, whether it names a repository or not. No
  match or several grants nothing: the proposal becomes the owner's one approval
  (`repository_name_unresolved`) with no model call.
- **Admission.** Maximum Issues counts issues across all repositories. Epic lineage admits only the
  launch repository's epic members, and follow-up lineage only a publication in the launch repository,
  until cross-repository follow-ups (#4119) and repository-qualified epics land.
- **Participants.** The root holds the whole scope. Every other Orchestrator participant, and its runner,
  holds only its own Location repository's numbers in the earlier one-repository shape, so a number is
  never read in the wrong repository. A retired participant in no campaign repository records the
  revision with no numbers. Restarts and provider launches independently preserve that boundary. The runner stores the
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

## What the Scope Bounds Under Full Control

Under Full Control the issue scope bounds what the Orchestrator may deliver and close on its own,
whatever route a closure takes (#4062). Recording a work item for an unscoped issue stays allowed, and
Campaign Status lists it as recorded work outside authority, but:

- Dispatching a child on it is refused: `create_session` with that `campaignWorkItemId`, and
  `assign_campaign_work_item`, both fail with a message naming the issue and the scope route
  (`request_campaign_issue_scope_change`). A refused scope change cannot be routed around by
  recommitting the item and dispatching it again; only the campaign owner can then add the issue.
  An item that tracks no issue is unaffected.
- A merge that would close an issue outside the current scope is never Orchestrator-owned. A
  `pr_merge` whose `intendedClosures` name such an issue is refused before any decision is created,
  and the refusal names each one; write "Refs #N" for an issue that must stay open, or add the issue
  to the scope first. On a current runner the declared closures are exactly what the forge would
  close: for GitHub (v242, #3713) its closing keywords and linked issues; for GitLab (v295, #3762)
  its closing pattern on the description and GitLab's own `closes_issues` list. The runner reads
  them before the request and again before arming, and any difference, or a forge it cannot read, is
  refused. A merge whose closures are all in scope, or that closes nothing, keeps its ownership: a
  GitLab merge is then owned exactly like a GitHub one.
- A merge whose closures nothing reads is never assumed to close nothing. A GitHub merge from a
  runner older than v242, and a GitLab merge from a runner older than v295, are human-owned
  (`unverified_closures`) whatever they declare, and their decision cards say "Not checked": an
  unread pull request that declares an in-scope closure could still close an unscoped issue. A
  declared unscoped closure is still refused, as above.
- Retargeting a work item that has an open attempt at an issue outside the scope, through
  `record_campaign_plan` or `update_campaign_work_item`, is refused like a dispatch. Linking an accepted follow-up's published issue to its item stays allowed, because that
  record must precede the issue's scope addition; its merge still cannot close the issue unscoped.
- Ownership follows the current scope. A merge is evaluated again when it is approved, when it is
  consumed, and once more after the arming read of GitHub against the controller as it is then. A
  scope that no longer names a closing issue revokes the merge, and a new request for it is refused.

Custom campaigns keep their saved owners for both dispatch and merges.

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
`epic_not_authorized`. A campaign owner can still propose any change from Campaign Status.

### Owner Approval of Additions Without Lineage (#4267)

An Orchestrator proposal that adds issues without any lineage, and that no scope grant review takes
(below), is not refused. It becomes exactly one pending, human-owned `campaign_issue_scope` request
whose snapshot carries a server-derived `ownerReview: { cause: "lineage_missing" }`, with the exact
additions, any removals and the Orchestrator's `explanation`. That is the route for an issue the
owner asks for in conversation after launch: the owner approves or denies the proposal in one step
from their Inbox or from Campaign Status's **Waiting for You**, where it is listed as a Scope
Approval, instead of retyping it.

- When the scope plus the slots consumed publications still hold would exceed the campaign's issue
  limit, the request states the Maximum Issues increase it needs as `ownerReview.maxIssuesIncrease: { from, increase }`.
  Approving it applies the additions and re-mints the boundary with Maximum Issues raised from
  `from` by exactly `increase`; denying applies neither. The Follow-Up Limit does not change. A
  proposal that would need more than the 100-issue ceiling is still refused as `capacity_exhausted`,
  and so is a lineage-bearing proposal over the limit. Pending and approved publications are not
  counted, because the owner's approval revokes them, exactly as its resolution counts the limit.
- Proposing the same additions and removals at the same scope revision while the request is pending
  returns that same occurrence, whatever the explanation now says.
- Only the owner can approve it, as any human-owned scope request: an Orchestrator can neither
  resolve nor consume it, and an agent cannot supply an `ownerReview` or a larger increase itself.
  Approval still revokes and lists every outstanding decision (#3915). If Maximum Issues moved since
  the request (any boundary change revokes it anyway), approving it is refused as stale and applies
  nothing.

Epic, follow-up and selection lineage, the selection review below and Custom campaigns are unchanged.

When the owner's first message asked the campaign to choose issues (a scope grant with a selection,
#4102), the Orchestrator proposes the issues it chose with `lineage: {kind: "selection"}` and its
ranking as the `explanation` (#4103); under such a grant a proposal without lineage takes the same
route, and selection lineage under a grant without a selection is refused as `selection_not_granted`.
A selection proposal adds issues only (`selection_additions_only`). Deterministic floors then run in
order, and the first that fails refuses the proposal with its code and no Decision Model call:

1. `repository_outside_boundary`: every addition is in a repository in the campaign's boundary.
2. `not_an_issue`, `issue_not_open`: a v291 runner reads each number with `facts` and reports it as
   an open issue, not a pull request.
3. `already_in_scope`: none is in this scope.
4. `other_campaign_scope`: no other active root campaign names it in its scope or holds a committed
   work item for it.
5. `selection_count_exhausted`, `capacity_exhausted`: the issues applied selection changes already
   added plus this proposal stay within the grant's selection count, counted once and never given
   back by a removal, and the scope plus publication reservations stay within Maximum Issues.
6. `human_required_label`: no enabled Human Required ask rule with `conditions.issueLabels` (matched
   case-insensitively, narrowed only by organization, machine, workspace and agent selectors) names
   one of the issue's labels. Such a rule never matches a tool request.

A runner older than v291 reports no facts, so floors 2 and 6 stay unverified and the proposal goes to
the owner as `grantReview.cause: "selection_unverified"`, with no model call.

A proposal that passes every floor gets the Decision Model's `scope_review` (`docs/decision-model.md`):

- `admit`: the server sets `issueAdmission` from the evidence (the review occurrence, the digest of
  the grant it read, the verdict) and records it as `selectionReview`. The scope change is then
  Orchestrator-owned and applied like an epic-lineage admission, with no human step.
- `refuse`: the proposal is refused as `selection_refused`, with the model's reason in
  `errorDetails.reason`. No request is created; the Orchestrator may propose another issue.
- `uncertain`, retries exhausted or a non-transient failure: exactly one owner-owned scope approval
  with `grantReview.cause` `selection_uncertain` or `selection_failed`, its `reviewOccurrenceId`, and
  the uncertain reason or failure class beside the proposal, its rationale and the grant. Approving it
  revokes every outstanding decision, as every human Full Control scope approval does (#3915).

One review covers the campaign, the scope revision, the grant and the set of additions. Repeating the
same additions at the same revision, whatever the rationale says, returns the same verdict, the same
owner request or the same scope change: a retry can neither admit twice nor ask the owner twice, and
a reworded rationale is not a second review. Campaign Status lists every reviewed proposal in
Decision Model Checks with its issues, rationale, verdict, reason and outcome.

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
capacity. Under a Full Control issue boundary, a failure the requester can correct in one step
(`title_mismatch`, `recommendation_not_found`, `recommendation_not_accepted` or
`recommendation_spent`) is refused: a 409 whose `code` names the failure and whose fixed sentence
says how to correct the request. No decision is created, nobody is asked and nothing is granted. A
member's refusal is recorded for the root as an Orchestrator-owned `reformulate_request` recovery
record (`correctable_refusal`, with its `admissionFailure`), which wakes the root like other child
requests needing it; the member's next request for that recommendation, or its verified report,
settles it. When the server cannot admit the request for any other reason, the decision goes to the
person, and its `authorityEvaluation.admissionFailure` names the failed condition (for example
`capacity_exhausted`, `unsafe_payload`, `origin_outside_scope` or `inspection_failed`, or
`no_issue_boundary` in a Custom campaign), which the server also logs. Under an issue boundary every
person-owned publication carries one, with its fixed sentence in `admissionMessage`: a request that
names no recommendation records `recommendation_missing`, and its sentence tells the requester that
naming the accepted recommendation would let the Orchestrator review it. `capacity_exhausted` names
Maximum Issues and the owner's route to raise it. Campaign recovery reports these decisions as
`publication_not_admitted` with the recorded failure, not as a boundary enlargement. That decision stores the snapshot exactly as requested, including its
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

### Closure Proof Gaps

A completed or not-planned closure of an in-scope issue that the boundary delegates, but that fails
the proof above, keeps the person-owned route (#4058). Its authority reason is
`closure_proof_incomplete` rather than `outside_boundary`, and the server records what failed in
the snapshot's `deliveryGaps`. `deliveryFailure` holds their compact line,
`code[:workItemId][:#n,#m]` joined by `; `. The `request_github_issue_closure` response adds
`proofGaps`: the same gaps, each with a fixed `action` and a derived `summary`, and a sentence
saying a person now decides the request. A request whose gaps are fixed passes the proof, so it is
Orchestrator-owned and supersedes the person's pending request for the same issue.

| Gap | Action |
| --- | --- |
| `open_related_pull_requests` (numbers) | `wait_for_pull_requests`: each must merge or close |
| `attempt_awaiting_verification` (item) | `verify_child`: `verify_campaign_child` with that item |
| `attempt_open` (item) | `finish_attempt`: wait and verify, or end the attempt |
| `no_work_item`, `no_delivered_verification`, `work_item_not_delivered` (item) | `deliver_work_item` |
| `no_merged_delivery_pull_request`, `pull_request_outside_repository` (item) | `record_delivery_pull_requests`: the item's reported stage |
| `unmerged_pull_request` (item, numbers) | `wait_for_pull_requests` |
| `stale_pull_request`, `delivery_merge_unconfirmed` (item, numbers) | `request_again` |
| `disposition_unverified` (item when it has one) | `record_disposition` |
| `comment_unsafe` | `revise_comment` |
| `missing_work_item`, `work_item_outside_scope` (item), `delivery_not_verified_at_exact_head` (item, numbers), `fixed_by_completion_only`, `delivery_unverified`, `reason_unconfirmed` | `person_decides` |

Gaps name what failed; they never admit anything. They are derived from the same ledger, merge
gates and forge facts as the proof, which does not read them, and every failed proof has at least
one (`delivery_unverified` when nothing more specific applies). A merge the runner never confirmed
is named only when nothing else failed, since the runner is asked only then. `outside_boundary`
still covers a stale boundary, another repository, an issue outside the scope, a reason or
operation the boundary does not delegate (whose `deliveryFailure` reads `outside_boundary`, with no
gaps), and an admission bound to another boundary revision.

**A timeline-only reference keeps blocking.** The runner relates an open pull request to the issue
by closing reference, by a mention in its title or body, or by GitHub's `cross-referenced`
timeline event. GitHub keeps that event after the mention is edited out, so a sibling PR that no
longer mentions the issue and has no closing reference still blocks delegated closure until it
merges or closes. This is deliberate: the timeline event is the only record the forge keeps of
the relation, the snapshot does not carry the PR's body to re-check, and a body can be edited back
at any moment. Treating an edited-out mention as unrelated would let an agent's edit remove a
proof condition. The gap names each such PR and says it blocks until it merges or closes; the
person-owned route stays available meanwhile.

### Decision Model Checks on Follow-Ups and Closures (#4104)

Two judgments the Orchestrator used to make alone are checked against the owner's request by the
Decision Model (`docs/decision-model.md`). Each runs only after the deterministic floor above has
admitted the request, never reads its text any other way, and may only refuse.

- **Follow-up relatedness** (`follow_up_relatedness`). After a bounded publication passes its
  structural floor (an accepted recommendation, origins in scope, capacity, a safe payload), the
  model reads the owner's own words, what their grant covers, the origin work and the follow-up.
  - `related`: the publication proceeds as before.
  - `unrelated`: it is refused back to the requester as the correctable `unrelated_follow_up` (a 409,
    nothing created), with the model's reason appended to the fixed sentence.
  - `uncertain`, or a failed check: the publication becomes the person's with the admission failure
    `relatedness_unconfirmed`.
- **Closure-reason choice** (`closure_reason`). For a closure whose proof rests on a disposition rather
  than delivery (a `not_planned` closure, or one naming a recommendation), after the proof passes,
  the model reads the issue, the stated reason and explanation, and the dispositions the campaign
  recorded.
  - `fits`: the closure proceeds as before.
  - `does_not_fit`: the request is refused (a 409, nothing created) with the model's reason.
  - `uncertain`, or a failed check: the closure becomes the person's with the gap
    `reason_unconfirmed` (`person_decides`).
  A closure proven by delivery or by its epic's members is not a choice of reason and is not checked;
  a closure with no proof keeps the human fallback above without a model call.

A refusal, an uncertain verdict or a failure sticks to the server-owned subject: the recommendation,
or the issue and the stated reason. A later request for the same subject with reworded text inherits
that outcome without a new model call, so rewording never buys a second verdict; the person deciding
the affected request is the only way past it. Checks of one subject run one at a time, so a request
sent while another is still being checked waits and inherits its outcome, and a confirmation never
outranks a refusal recorded for the same subject meanwhile. Each check's verdict, reason and failure class appear
in Campaign Status under Decision Model Checks, beside the follow-up or closure it affected.

### Closure Request Refusals

`request_github_issue_closure` tells three refusals apart before it does anything else (#3382). Each
returns a fixed sentence and an `errorDetails.code`, which the HTTP body carries as `code`:

- `issue_closure_request_invalid` (400): the request is malformed. `fields` lists each missing or
  invalid field (`requestId`, `issue`, `reason`, `explanation`, `evidence`, `comment`), whatever the
  scope holds.
- `campaign_issue_scope_missing` (403): the request is well formed, but the campaign has no
  authorized issue scope, absent or empty.
- `campaign_issue_outside_scope` (403): the request is well formed, but the issue is not in a
  non-empty scope. The sentence names the scope's revision, repository and up to 20 of its issues.

Both scope refusals carry `issue`, `scopeRevision` and `recovery`, and name the supported route to
add the issue:

- `owner_scope_review_or_proposal`: a campaign owner adds it in Campaign Status under Issue Scope,
  or the root proposes it with `request_campaign_issue_scope_change` for a person to approve. This
  is also the route under Full Control issue authority when the first message's scope grant failed
  or was uncertain, where an addition without lineage is the owner's one typed approval.
- `owner_scope_review_or_lineage`: under Full Control issue authority without a scope grant review,
  the root's proposal is admitted only with the lineage that authority accepts (see
  [Bounded Full Control Issue Authority](#bounded-full-control-issue-authority)); otherwise only a
  campaign owner can add the issue.
- `owner_scope_review_or_selection`: under Full Control issue authority with a scope grant that asked
  the campaign to choose issues, the root may also propose the issue as one of those choices. The
  grant's count and floors and the Decision Model's `scope_review` then admit it, refuse it or leave
  it to the owner, as described under the selection route above.
- `unavailable`: no one can change the scope right now, and the sentence says why: a participating
  runner below the scope-change protocol, or an active Orchestrator participant in another
  repository workspace. The root leaves the issue open and reports it.

A scope refusal reads saved state only. It does not synchronize scope, inspect the issue, create a
decision, post a comment or close anything, and it logs `campaign_issue_closure_refused` with the
session, request, issue, reason, scope revision and recovery. Neither refusal grants or widens any
authority. A scope change and the closure stay separate decisions. Once the issue is in scope, the
closure is requested again and takes the existing closure decision under the owner current policy
assigns, with every inspection, revision, synchronization, conflict and replay check unchanged.

### Closure Refusal Reasons

A `refused` closure result always carries `refusal` (#4059): a `reason`, the related PRs it names,
the runner's sanitized and bounded message when there is one, `forgeWritten: false`,
`nextStep: "request_new_closure"`, and a derived `summary`. Every refusal precedes the runner's
mutation fence, so nothing was written; the approval is consumed and closing needs a new request,
whose snapshot carries `previousRefusal` so its reviewer sees why the last approval was used up.
Reasons are `repository_changed`, `issue_changed`, `related_pull_requests_changed`,
`closing_reference_changed`, `forge_evidence_changed`, `related_pull_request_open`,
`delivery_changed`, `campaign_authority_changed`, `mutation_fence_unavailable`,
`evidence_unavailable`, `runner_failed`, `runner_unreachable` and `unspecified` (a runner that
predates reasons). An `ok: false` runner reply without a classification records `runner_failed`.

The forge digest binds the issue's identity, contents, `updatedAt`, labels and assignees, and each
related open PR's number, address and closing reference to the issue. A related PR's title, body,
head and `updatedAt` are not bound: a push, a merge from the default branch or a body edit keeps an
approval unless it changes whether the PR relates to the issue or closes it, which refuses with the
PR named. A snapshot that an older runner took while related PRs were open was digested the old
way, so an upgraded runner refuses it as `forge_evidence_changed`, or names a set change; a snapshot
without related PRs digests the same either way.

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
