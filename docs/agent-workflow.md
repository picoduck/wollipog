# Contributor Campaign Workflow

Read `AGENTS.md`, the shipped `using-wollipog` authority reference, applicable installed issue and
review workflows, and `.github/ISSUE_REPORTING.md`. Repository workflows belong here and under
`.agents/`; shipped `skills/` must remain usable in other projects. Run
`pnpm generate:built-in-skills` whenever shipped skills change and commit its generated module.

## Preflight and External Rules

Read `IMPLEMENTATION.md` before changing code. Root `REVIEW.md` supplies repository-specific
engineering criteria. Hosted reviews load its regular Git blob from the forge-reported base
commit into the review prompt, recording the source commit and SHA-256 of its exact contents.
For GitLab this is the merge request's pinned diff base. Missing guidance preserves the default
contract; unreadable, non-text, non-regular or over-64-KiB guidance refuses snapshot preparation
rather than silently dropping criteria. The PR's own guidance edits are reviewed as code changes,
not applied as criteria. Criteria cannot change the fixed reviewer contract or approval gates.
The shared cross-model-review skill and standalone controller are maintained in dev-box-setup.
For a stacked PR, the source is its target branch's base commit, which may itself be unmerged;
it is not proof that those criteria have passed review. Review the parent against its own base
before landing the stack. Invalid base guidance also refuses a PR that repairs that file: a head
edit cannot bypass the base policy. The runner log records the specific `REVIEW.md` error; the
protocol reports the existing generic snapshot refusal. Repair requires the repository's existing
authorized recovery process. Pure base-merge equivalence checks do not launch a reviewer or load
criteria and retain their existing behavior.

Record the managed worktree/branch/base, campaign assignment, effective harness/model/effort,
Custom or Full Control mode, human-established boundary and revisions, exact decision owners,
compatibility, Human Required exceptions, evidence hosting/retention and reviewer provider/model.
Recheck claims, dependencies and overlapping PRs before implementing in the isolated worktree.
Never overwrite a dirty primary checkout or update a checkout hosting the live stack.

Protocol-v220 clients can pass `campaignWorkItemId` at child creation. Verify the actual tool
schema as well as the runner version. If the active host lacks this input, a Custom campaign may
create a read-only bootstrap child, verify its effective configuration, bind the original work
item through the supported assignment operation, and select its dedicated worktree based on the
fetched remote default branch before releasing implementation. A bootstrap prompt is not a
recorded work-item assignment.
Do not claim atomic creation, omit required protected admission, or update the hosting stack to
make an unavailable interface appear. Report an unsupported mandatory path during preflight.
Full Control launches with no preflight form or question (#2940), so the root Orchestrator posts
this preflight as its first report, after `get_campaign` and before its first child: objective and
issue scope, permitted follow-ups and operations, limits, evidence destination and reviewer
provider, Human Required exceptions, unsupported or degraded capabilities, and each unresolved
mandatory human rule with its exact source and typed route to the owner. It asks nothing and waits
for nobody; the shipped authority reference lists what it names.

A root's question to its owner, whatever its topic, must be an Owner Question through
`request_owner_decision` with `kind: "question"`, never only prose. Never end a turn with a blocker
that needs the owner without a typed request or a recorded handoff naming the reason and next
action. Decide Orchestrator-owned implementation questions and follow-up acceptance, rejection or
deferral yourself. On settlement, human handoffs reach the Inbox in one server-maintained question;
external handoffs are listed alongside them but do not trigger a question alone. Its answer grants
no authority. Housekeeping without human handoffs stays informational.

Installed or user-authored workflows are independent instructions. Name any unresolved mandatory
human rule with its exact file, quoted requirement and affected action before proceeding to that
gate. For example, an installed third-party workflow may require consent to a disputed scope change,
external private-bucket uploads or human evidence review; an installed issue-reporting skill may
require user payload review. Those instructions are not changed by this repository's Full Control
policy. Do not edit installed skills or live provider configuration to remove the conflict.
Explicitly authorized repository policy alignment must itself pass normal review and merge gates.
Committed wording never overrides the current session's higher-priority instructions.

When such a rule keeps a gate for a person, the gate reaches the owner as a typed request, never
only as prose (#4137):

- The child still files the exact typed decision, such as `pr_merge`, with
  `request_workflow_decision` and names the rule in `ownerRule` (`source`: the file; `quote`: the
  requirement, on one line), or with `wollipog decision request ... --owner-rule-source <path>
  --owner-rule-quote <text>`. The occurrence is created human-owned (`owner_kept`) unless an authenticated campaign-scoped personal-rule approval applies, reaches the owner's Inbox and Campaign Status under Waiting for You with the rule, and
  later requests for the same resource stay the owner's. The rule only narrows authority.
- The root hands any occurrence already filed without the rule to the owner with
  `hand_workflow_decision_to_owner`.
- For a gate with no typed category, the root uses `request_owner_decision` with `kind: "approval"`.
- For a design choice, clarification or preference, the root asks an Owner Question:
  `request_owner_decision` with `kind: "question"`, answered in the owner's own words.
- Nobody ends a turn with such a gate only in prose.

Child clarifications use `implementation_question` with `kind: "question"` (protocol v332).
They accept suggested options and free text through the ordinary question interface and preserve
the occurrence's current owner and credential screen. Their answers grant nothing; do not consume
them as action approvals. Missing `kind` preserves legacy approval behavior, not a compatibility
fallback for unsupported peers.

## Worktree Bases and Checkout Maintenance

Create new issue worktrees with `wollipog worktree create --branch <branch>` and omit `--base`.
Wollipog fetches the remote default branch and uses it as the base, independently of the primary
checkout's HEAD. Use an explicit base for intentional stacks or another task-specific starting
point; that path uses the supplied ref without the default-branch fetch, so verify its freshness
when the task requires it. Resuming an existing worktree preserves its work rather than rebasing
it automatically.

Do not pull or fast-forward the primary checkout as post-merge cleanup. Delivery requires the
verified merge, tracker updates, and appropriate session-owned cleanup, not a current local
`main`. Do not report a stale primary checkout or the sandbox's refusal to update it as an
unfinished delivery step.

Primary-checkout maintenance is a separate, explicitly requested operation. Preserve local work
and check whether a running process uses the checkout before updating it; never update a checkout
hosting the live stack. Runtime updates remain a separately authorized deployment operation.

For reviews, maintenance sweeps, or tools that read the primary checkout directly, establish the
required baseline explicitly. Fetch the remote default branch and inspect its files, or run code
in a separate worktree pinned to the required commit. Record that commit and do not assume the
primary checkout is current or change it merely to obtain fresh input.

## Protocol Version Claims

Parallel campaigns often claim protocol versions at the same time. `PROTOCOL_VERSION` is the
highest entry of the ledger in `packages/protocol/src/protocol-version.ts`, and each version has
its own `// vN slot` anchor (#975). Claim a version by inserting its entry directly below that
anchor; see the Protocol Version section of `AGENTS.md`. Claims of different versions merge
without a conflict, and a claim of a version someone else already took conflicts immediately.

Versions must still land in increasing order, because a runner at version N is assumed to
support everything up to N. Before choosing a number, check main and every open pull request's
claim. Before requesting a merge and again before enqueueing, run `pnpm check:protocol-version`
against freshly fetched main. CI runs the same check on the pull request's merge commit and on
each merge-group commit. If the claim is no longer greater than the commit it lands on, renumber
to the version the check names. A pull request that claims no version is never affected. A renumber
changes the pull request's own diff, so its next review round counts against the epoch's budget,
even when it arrives inside a merge of main. A merge that keeps a claim above main needs no renumber.

## Decisions and Delivery

Before the first dispatch, the root may declare completion relationships in `record_campaign_plan`
using `fixedBy: [{ issue: { repository, number }, workItemKeys: ["unit:a", "unit:b"] }]`.
The target issue must already be in the human-established scope; every key must name an item in
this campaign (including items in the same plan call). Record all required units together. These
relationships are immutable and cannot be added after dispatch, including after an attempt ends.
They supplement the target issue's own work items, including items recorded later; every own item
still needs its existing completion proof. They grant no scope or delivery authority: every cited unit must remain in scope and independently
pass delivery, report verification and exact merged-PR checks before the completed closure can be
Orchestrator-owned. Missing proof retains human ownership with a server-derived delivery gap.
Existing closure requests never gain authority retroactively. Issues without relationships retain
their own-work-item behavior. Epic prose and other agent-written text cannot create a relationship;
this implementation supports the recorded-plan source. Clients need protocol 268 to send `fixedBy`;
older servers keep such closures human-owned. Do not update the hosting stack to gain support.

An in-scope epic has a second source, its members, and needs no plan. When a completed closure of
an issue without a fixed-by plan fails its own-work proof, the runner reads the issue's members on
the forge at request time from the sources scope admission accepts (GitHub sub-issues and the
epic body's member checklist), never from agent text, and binds that read into the closure. The
closure is Orchestrator-owned when every member is in the campaign's scope and closed as
completed, and every work item of the epic itself is either delivered under the existing proof or
server-derived epic tracking work. A tracking item has no open attempt, delivered attempt,
verification, delivery, PR or recorded delivery-stage activity; ended tracking attempts alone do
not disqualify it. Titles do not establish this fact. Incomplete migrated history retains ordinary
delivery proof. Anything else keeps the closure human-owned and names the
member: open (`epic_member_open`; close it through its own closure request first, then ask again),
closed another way, outside scope (including a member added after launch that scope never
admitted), or unreadable. An epic never closes while a member is open on the forge, even one whose
own closure would pass. If a member joins, leaves or changes state before execution, the runner
refuses the approval with `epic_members_changed`. A tracking item of an epic closed this way no
longer holds the campaign's completion, so the root need not mark it `scope_removed`. Campaign
Status uses the same tracking predicate and closure receipt for item states, counts and recovery.
An item with delivery activity or an open attempt still needs its own delivery. Not-planned closures, issues with a fixed-by
plan and issues without members are unchanged. The member read needs runner protocol 278 and a
GitHub repository; the expanded tracking rule needs a control plane with the tracking history. Elsewhere the epic keeps the
own-work proof and its closure stays human-owned.

Custom preserves existing user approval rules. Full Control delegates an eligible exact decision
only when the server-established human boundary, current occurrence owner and repository rules
permit it. Use request/get/consume with unchanged resources immediately before acting. Human
Required, authentication, secrets, persistent permissions, provider access expansion, governance
changes, guardrail changes and budget increases remain human-only. A separate budget boundary may
permit bounded worker reservations/allocations; never expand allowances or use unmetered workers.

For issue publication follow `.github/ISSUE_REPORTING.md` and the contributor reporting skill:
retain the drafting context, exact sanitized payload, fresh duplicate checks and verified readback.
Follow-up recommendations go to the parent for recording and deduplication before anyone acts.
One relatedness refusal is not a precedent for deferring other follow-ups; evaluate each on its
own evidence. With runner protocol 351, a specific GitHub Actions job URL
(`/actions/runs/RUN/job/JOB`) in the sanitized publication payload is only a lookup hint. The
server matches the origin item's recorded PR to a head admitted for
that item's child through a valid completed review session or consumed merge gate. Its runner reads GitHub to
prove a failed merge-group run with that PR/head queue ref and ancestry, or a failed required check
whose run names that PR/head. The exact job must belong to that run and point to the exact failed
check run; cancelled, skipped and passing jobs/checks do not qualify. The sanitized title or body
must contain the check name verbatim, compared server-side to the name the runner reads from the
forge. Only relatedness skips the Decision Model. Structural floors and
safe-payload/duplicate inspection remain mandatory. Unknown ownership, unrelated/passing runs,
unreadable evidence and older runners retain the ordinary check and its existing outcomes.
The server-created admission records `failed_campaign_run` with the exact PR/head/run/job/check id
and forge-read check name, or
`decision_model`. Requesters on older runners retain their original snapshot shape and the model
basis remains in the admission log. Lookup has a shared 20-second deadline, with at most five seconds
per read; a failed read immediately returns to the ordinary check. No agent-written claim or
supplied admission can establish this basis. This proves the follow-up names a real failed check
of the campaign's own PR, not causality. The Orchestrator's accept/adjudicate step and exact-payload
publication review remain the semantic gate; all structural floors remain required.
Scope and closure use their dedicated exact typed routes. Current hosts without eligible issue
authority retain human review even when the campaign requests Full Control. Use non-closing PR
references in campaigns so merge cannot bypass the closure gate: write "Refs #N", and never put
close, fix or resolve (any tense, even negated as in "does not close" or hyphenated as in
"auto-close") directly before an issue reference that must stay open, in a PR description, title or
commit message. Code spans do not close an issue, but paraphrase rather than rely on them. Check a
draft with `wollipog pr closures --file <draft>` and an open PR with `wollipog pr closures <url>`. A
`pr_merge` decision is refused unless its `intendedClosures` lists exactly what the merge would close
(#3713). The rule covers GitLab merge requests too (#3762), whose closing pattern is wider: it also
accepts implement and "-ing" forms ("closing", "implements"), closes every reference in a list after
one keyword, reads code and the title, and may differ per instance, so GitLab's own list of the issues
a merge request closes decides where it disagrees with Wollipog's match. Delivery comments compare every
acceptance criterion and cite the actual merge commit; report remaining original work candidly.

An approved issue closure does not expire on age alone. Execution rechecks its payload digest,
issue scope, policy revision, authority, bound child work, delivery proof and forge evidence.
A changed binding refuses the approval; the refusal identifies the condition that changed.
Human-owned closures remain human-owned. Offline runners and temporary evidence-read failures
retain their existing retry and recovery rules; an approval is never proof of forge execution.

An uncertain consumed issue closure is recovered by the server's read-only forge reconciliation
(runner protocol 355+). It never repeats the comment or closure. The issue must read closed with
the approved state reason and a unique exact-body comment by the runner's forge login, posted
after consumption. Incomplete, ambiguous or unreadable evidence leaves an Owner Question naming
the issue and original occurrence. Answering or dismissing it acknowledges the uncertainty and
clears recovery bookkeeping; it grants no new closure authority and leaves the recorded outcome
uncertain. A lost reconciliation read also goes to that question rather than being replayed.
The ordinary sweep discovers pre-upgrade uncertain closures; no agent assertion settles them.
Temporary runner disconnects and upgrades preserve the read opportunity for five minutes before
falling back to the owner's actionable question. A repository removed from the campaign goes to
that question immediately. Unavailable transport never repeats a closure or comment.

Use `wollipog review session run` (MCP `request_review_session`) for your own pushed PR's required
cross-model review, including from an isolated campaign child. Follow the shipped `using-wollipog`
skill: provide the brief, let the completion continuation arrive when idle, read the full verdict
and report, adjudicate findings, and push fixes before delta rounds. A rewritten head starts a new
review epoch. One plain merge of the moved base branch directly on the last valid head, changing
nothing outside its conflict blocks, gets a reviewed round that does not use the epoch's budget. If
that head was upvoted and the merge leaves the pull request's own diff byte-identical, the run records
an equivalence and no reviewer runs (protocol 277, #4075; the proof is in `docs/agent-control.md`).
Anything the runner cannot prove counts against the budget: a second merge before the first one's
review, any commit after the merge, and any edit outside a conflict block, including a protocol
renumber's changes to the ledger, capability floors, comments or docs. Those change the pull
request's own diff, so a review has to cover them. Exhausted rounds require the exact
`review_round_extension` decision; its
default owner is human. Full Control owns it only within a server-enforced cap per pull request of
the run's configured round budget once more (the owner approved this change to the #3369 decision);
past the cap it is the person's. With protocol 232 or later, campaign review
sessions reserve allowance before launch and record actual Session usage against it. Exhausted,
stopped or unavailable allowances refuse admission with a reason; original human cost ceilings
still apply across attempts. The older bridge and controlled campaign review jobs are retired.
Upgrade unsupported peers; never use a native subprocess to bypass an admission or budget refusal.

Run the required cross-model review using the installed workflow's exact reviewer model/effort,
read-only contract, attempt limits and private ledger. Independently adjudicate every finding.
Delegated review does not permit extra attempts after an exhausted limit or treating an invalid
attempt as valid. External unmetered reviewers are unsupported for production admission when
managed budget reservations are required; do not disguise an ordinary CLI review as accounted work.

Hosted review sessions preserve the required harness/model/effort, read-only snapshot, coverage
contract and attempt limits. Native reviewer subprocesses outside managed Session accounting remain
unaccounted for protected admission; disclose their actual raw cost and invalid attempts. Retirement
adds no native fallback or paid-launch authority. Drain historical jobs with their prior runner and
follow the control-plane-first transition in `docs/agent-control.md`; never update the hosting stack
from this session. Old grants and unknown charges require their existing human/accounting recovery.

Before merge, verify the reviewed head equals the pushed head and required CI passed on that SHA.
The required check is `Typecheck, Test & Sidecar Bundle`; an empty required list into `main` with
an active workflow is pending. Merge groups run full regression: the fast merge-group gate and
regression admission are disabled, and activating them needs the separate human approvals in
`docs/fast-gate-activation-proposal.md`. Agents never set `CI_MERGE_GROUP_GATE`,
`CI_REGRESSION_ADMISSION`, `CI_PR_SUITE_ROUTING` or `CI_PR_BROWSER_ROUTING`, or change the ruleset. Draft-skipped and absent runs need repair. Inspect dependencies and
direct stacked children. Request the exact typed merge decision and arm/execute the canonical
`gh pr merge URL --squash --match-head-commit SHA` command; never use `--delete-branch` on enqueue.
Wait for merge-group CI and actual `MERGED` state. Obtain a separate typed branch-deletion approval
after merge and after preserving/retargeting stacked dependents. Retire managed worktrees through
Wollipog; report provider-exit deferrals. Parent verification, rather than idleness, attests delivery.

## Child Worktree Inspection Recovery

For a failed child, use `verify_campaign_child` with its exact last completed top-level report.
The report must still stand: a newer completed report, a real later prompt or a later campaign
assignment supersedes it. A system notice that produced no completed response does not supersede
it only when durable server-recorded command provenance proves it was an informational restart
notice. Decision resumes, review continuations, PR-watch wakes and campaign continuations can
carry work, so they still supersede reports. Unknown legacy
provenance fails closed; notice-looking text is never proof. An active work-carrying command
without a correlated earlier user message remains unresolved, even if staged or sent before the
report: the runner may have queued it without starting its assigned work. Stage/send positions
and CP/runner timestamps are never proof of delivery. A confirmed stopped child follows
the same rule. A provisional stop still needs the runner's confirmation.

`record_campaign_work_item_delivery` accepts that report inside its attempt, including an attempt
ended as failed, and records delivery independently of session verification and archival. Failure
alone never counts as delivery. With no standing report, end the failed attempt and dispatch a
successor. Once a later attempt independently delivers the item and its child's current report is
verified, the earlier failed child no longer counts as unverified campaign work. This applies only
when every one of its attempts is ended and covered by a verified successor; open decisions or
descendants still block settlement. It does not invent a report attestation for the failed child.
Archive the failed session through the normal lifecycle. Preserved worktrees remain cleanup;
never make throwaway commits, delete uncommitted files or create a replacement child solely to
clear the campaign's status. Worktree inspection and retirement keep their independent checks.

`verify_campaign_child` inspects managed worktrees before Stop and Archive. A refusal names the
child, the worktree's position in its deduplicated managed-path inventory, and the first 12 hex
characters of SHA-256 of the stored path. Match this against `get_session` worktrees (excluding
attached worktrees, with a legacy selected path appended if absent). Paths and raw runner errors
are omitted from inspection-failure diagnostics; the request ID correlates a dispatched status
request with runner diagnostics.

- `unsupported_capability`: the reported runner protocol is below the existing inspection gate;
  use the returned required/reported protocol fields to arrange an operator-managed runner update.
- `capability_unproven`: the runner's protocol is unknown; reconnect and inspect registration
  before diagnosing it as outdated.
- `runner_offline` or `timeout`: restore connectivity or investigate the status request timing out.
- `runner_error`: inspect runner status-request diagnostics; no update is presumed.
- `invalid_response:<reason>`: restore valid status data after checking runner/control-plane
  compatibility. Reasons distinguish missing status, invalid counts/flags/file lists, and
  inconsistent summaries. A valid truncated file list still refuses dirty worktrees.

Missing proof records neither verification nor archival and never starts retirement. Preserve
worktrees during recovery. Retry verification with the same completed report once inspection is
restored; do not repeat delivery or merge. Successful verification resumes the existing managed
retirement operation, which independently checks delivery and ownership. Do not alter an old
child's cleanup state to bypass inspection. A hosted agent must hand any hosting-stack update to
a separately authorized outside operator; merging this diagnostic change does not deploy it or
prove recovery of a historical runner failure.

## Evidence and Hosting

Follow explicit task/project hosting requirements and Artifact Uploads preferences. Full Control
does not authorize arbitrary uploads. A separate human-established evidence boundary narrows task,
private Session artifact destination, retention and exact reviewer provider/model; it never changes
UI Evidence Approval ownership. Initial human approval must cover hosting and provider disclosure.
Missing authority retains existing upload rules. Do not invent external storage, credentials or a
privileged fetch of a child-supplied URL to make review succeed.

Attach completed captures from disk and preserve returned artifactId/mediaType/sizeBytes/sha256.
Every item needs exact-byte reviewer delivery, receipts and a verdict; attachment alone is not
inspection. External or unsupported evidence routes to a human. Changed captures need new review.
Production video requires complete-manifest/all-frame model delivery, a temporal verdict and
managed worker/cost proof. Offline preparation and short-frame experiments do not establish this.
Missing proof remains a blocker, not a claim of production support.

The hosting-stack restriction remains absolute for a hosted agent, including detached helpers.
Deployment is a separately authorized handoff to an operator proven to be outside that stack.
Do not refresh primary main while its file watcher would deploy code. Report the deployed commit
when known; a merge does not prove deployment.


### Personal Instructions in Full Control

For the authenticated, campaign-scoped personal-rule Owner Approval alternative (v364), follow
[Personal Instructions in Full Control](../skills/using-wollipog/references/campaign-authority.md#personal-instructions-in-full-control).
Never infer authorship from a path. Repository rules, installed skills, Human Required rules,
Custom and unverifiable sources retain their human gates. The root first reports every exact
rule set aside, its source/quote, categories and approval occurrence; report later confirmations
before relying on them. Each action still requires its own exact typed approval and consumption.
