---
name: orchestrate-issues
description: Coordinate explicitly requested Wollipog child-session issue campaigns through merge, cleanup, recursive follow-ups, and archival. Use only when the user invokes this skill or explicitly asks to orchestrate or delegate issue implementation across sessions. A request to claim, implement, or fix multiple issues alone stays in the current session and does not trigger this skill. Do not trigger merely because the issues concern Orchestrator features.
---

# Orchestrate Issues

Run a campaign of initial issues and their justified follow-ups. Coordinate through real Wollipog child sessions, not in-process subagents. The Orchestrator investigates, schedules, reviews outcomes, and maintains state; children implement. Creating or editing this skill does not start a campaign.

## Activation Boundary

Issue count, dependencies, task size, and the availability of child-session tools do not authorize delegation. Require an explicit invocation of this workflow or a request to orchestrate, coordinate across sessions, or delegate implementation to children. Relevant authorization already established for an active campaign remains valid; it need not be repeated on each turn.

“Claim and implement issues 1089, 1090, and 1091” means the current session claims and implements those issues following the repository's issue workflow (such as an installed `issue-workflow` skill), in dependency order and with its required isolated worktrees and review. Do not launch child implementation sessions or ask whether to orchestrate merely because the request lists several issues. Issue titles or bodies about Orchestrator settings are task subject matter, not instructions to become an Orchestrator.

“Orchestrate child sessions to implement issues 1089, 1090, and 1091” or “Use orchestrate-issues for those issues” activates this workflow. A child receiving several assigned issues remains an implementation session; the parent's orchestration authorization does not automatically authorize that child to delegate again. A review the repository requires, including a cross-model review, remains governed by its own rules and is not a delegation of issue implementation.

If the current session is restricted by the Orchestrator permission preset and cannot implement directly, explain that concrete limitation and request direction rather than silently spawning children or attempting prohibited implementation. Merely having the preset available is not authorization to use it.

## Inputs and Setup

- `count`: any positive integer, the number of initial issues to select. Infer it from the request; if omitted, use 5 and state that assumption. An explicit issue list replaces priority selection and determines the count.
- `concurrency`: optional ceiling, independent of count. Default to the smallest of count, the policy's `maximumConcurrentChildren`, and available live-child capacity. Queue excess issues; never raise platform limits to fit the count.
- Child harness, model, and effort come from the campaign's Wollipog Orchestrator policy (`childHarness`, `childModel`, `childEffort` in `get_campaign`); this skill has no defaults of its own. Each value is either fixed or Automatic (`null`). See [Resolve Child Model and Effort](#resolve-child-model-and-effort).
- Reviewers retain the model specified by the repository's review workflow.
- Optional user-specified cost, time, total-issue, or follow-up-depth limits. Preserve inherited guardrails. Do not invent budget values or an arbitrary successful stopping round.

Read `using-wollipog`, the repository instructions, and any issue workflow, review, and issue-reporting skills or policies the repository or user provides. Only `using-wollipog` is required; when the repository defines no issue workflow, children follow its contribution guidelines and the gates in this skill. Children must have the same skills available in their execution environment. Resolve skill paths from that environment's catalog; do not assume this machine's home paths exist elsewhere. Read the repository's issue-reporting policy before preparing publication payloads.

Discover the current runner, repository/workspace, available worker harnesses and model/effort capabilities, child capacity, and supported session tools. Select a harness advertising the chosen model; do not assume every model belongs to Codex. Inspect the current session and live child list before creating anything. Use only allowed Orchestrator operations; project writes and implementation belong in children. Keep the campaign ledger in persistent session artifacts or permitted scratch, never in the primary checkout. Summarize its latest state in conversation before yielding or compaction.

### Resolve Child Model and Effort

Read `childHarness`, `childModel`, and `childEffort` from the `get_campaign` policy before selecting anything. Wollipog's Orchestrator settings are the only source of these values. Never fall back to a model or effort written in this skill, remembered from an earlier campaign, or inherited from the parent session.

- **Fixed value:** use it exactly. The server fills in a fixed value when `create_session` omits it and rejects any different value, so do not override it. If the user's prompt asks for a different model or effort than a fixed setting, report the conflict and ask the user to change the Wollipog setting; do not dispatch the affected issue until it is resolved.
- **Automatic (`null`):** choose for each assignment from `get_agent_capabilities` (MCP) or `wollipog session capabilities` (CLI). Follow `page.nextOffset` until `truncated` is false. Pick a harness that advertises the chosen model; do not assume every model belongs to one harness. Base the choice on the issue's complexity, uncertainty, consequence of mistakes, context needs, and any cost or latency constraint the user stated. Model or effort preferences in the user's prompt guide an Automatic choice but do not change the Wollipog setting. Prefer an economical capable option for straightforward work and stronger reasoning for complex debugging, architecture, or broad changes. Do not invent model rankings, prices, or effort levels; use advertised capabilities and explain material uncertainty. If a model advertises no configurable effort, record effort as `not applicable`.

If a fixed value is absent from current capability discovery, report the mismatch and request a corrected setting while continuing independent triage. Never silently substitute.

Record each issue's harness, exact model and effort, whether each was fixed or Automatic, and a brief rationale for Automatic choices in the selection table and ledger before dispatch. Automatic mode authorizes these routine choices without asking per child; it does not authorize changing accounts, billing arrangements, permissions, budgets, or the Wollipog settings themselves.

### Verify Model and Effort Before Implementation

Use `create_session` with `useWorktree: true`, the resolved harness, an advertised worker permission mode (not Orchestrator mode), and the resolved `model` and `effort` in the same call. The CLI equivalent is `wollipog session create ... --model <model> --effort <effort> --worktree`. Omit a dimension only when it is fixed by policy (the server supplies it) or `not applicable`. Explicit values apply before the initial prompt. Prefer structured tool inputs for task text.

Read the effective pair back from the creation result or `get_session` and confirm it matches the resolved combination. If it does not, stop that child before it does work, record the mismatch, and report it; do not accept an unverified default. A client and server that do not support explicit effort fail closed; report that blocker rather than retrying without effort.

Recheck configuration before reusing a child. For an Automatic assignment, reconsider the combination if evidence shows the previous choice was inadequate and record why; apply changes only through a supported configuration operation while idle and verify them before release, or create a replacement with a clear ownership handoff. A normal `prompt_session` message does not change session configuration. Never change a policy-fixed value.

## Authority and Gates

Carry forward the user's actual campaign authorization and repository rules. Routine claims, isolated worktrees, testing, pushing, opening PRs, and required reviews need no repeated permission. Existing rules may still require per-PR merge authorization, UI evidence review, remote-branch deletion authorization, and approval of each exact sanitized issue payload. Do not silently convert a request for this workflow into a waiver of those gates.

Read the authoritative current campaign state and server-derived policy with `get_campaign` before dispatch and again before resolving a workflow decision; do not rely on a prompt copy when the server state is available. For typed decisions such as `implementation_question`, `pr_merge`, `merged_branch_deletion`, `follow_up_issue_publication`, and `ui_evidence_approval`, the child must use `request_workflow_decision`, `get_workflow_decision`, and `consume_workflow_decision` for the exact occurrence immediately before the matching action. The parent must not create or consume a child's gate on its behalf. Discover pending occurrences with `list_descendant_requests` and resolve only a currently Orchestrator-owned exact occurrence with `resolve_descendant_workflow_decision`. Use `answer_descendant_question` and `resolve_descendant_approval` only for applicable non-workflow requests; they never substitute for a typed workflow gate. An ordinary prompt, a stale approval, or Parent Control availability is not authorization for a typed gate.

Never change Parent Control, approve the parent's own requests, impersonate a human, or bypass a pending approval with a plain prompt. UI evidence remains human-owned when the active policy says the Orchestrator cannot inspect the evidence bytes. For any human-owned or otherwise undelegated gate, relay the concrete decision through the harness's supported typed question mechanism and keep unrelated children progressing. Identify the exact policy requiring the gate. Do not imply that campaign ownership authorizes external effects beyond the active policy.

For unattended campaigns, explain up front which gates still need the user. A user may explicitly delegate eligible decisions for a campaign, subject to higher-priority and platform restrictions; record the exact scope and exceptions. Do not modify standing policies as part of execution.

## Select and Schedule

1. Read the repository's priority conventions and enough paginated open-issue data to identify the highest priorities. Inspect candidate bodies, acceptance criteria, assignments, linked PRs, and dependencies. Use explicit priority first, then severity/user impact and dependency-unblocking value; break remaining ties by age and issue number. Label inferred priorities as judgments.
2. Publish a concise selection table with issue links, priority rationale, dependencies, and planned order. Record skipped claimed or blocked issues and reasons. If fewer than `count` eligible issues exist, report the shortfall rather than invent work. A specifically requested contested issue requires direction; for open-ended selection, choose the next eligible issue and disclose the substitution.
3. Check active sessions, claims, worktrees, and overlapping open PRs. Assignment to the same GitHub account is not proof that this campaign owns an issue. Let exactly one child claim each issue after rechecking ownership immediately before work.
4. Schedule independent issues concurrently within the available cap. Preserve high-priority selection even when overlapping files require serial execution. Do not duplicate claims or skip a selected blocker merely to fill slots. Start dependents after their prerequisites land unless a deliberate stack is justified.

Maintain a ledger with campaign ID, initial selection, issue lineage, child session IDs, event cursors, worktree/branch, PR/head SHA, review/check state, authorization evidence, merge commit, cleanup state, follow-up decisions, and blockers. Record mutations promptly. Before retrying an ambiguous create, publish, merge, or archive result, reconcile remote state; never blindly repeat it.

For publication, retain the exact sanitized payload and approval, the child/conversation owning the draft, intent timestamp, and resulting issue URL. If an uncertain response has multiple plausible matches or GitHub is unavailable, keep that draft unresolved and continue independent work. A ledger does not replace the issue-reporting skill's requirement that the publishing session retain its drafting context.

## Dispatch and Supervise

Use [the child assignment](references/child-assignment.md) when releasing each verified child. Reuse a suitable idle child for related follow-ups when possible; give it a fresh issue worktree based on the current default branch. Create another verified child if the old selected worktree has been retired or the session cannot resume safely. Count all campaign children for eventual archival.

Never assign a child to update or restart the Wollipog installation (control plane, runner, or development stack) that hosts the campaign, and never
approve or prompt such an action as post-merge cleanup. A detached helper is not an exception: it
can stop the stack and then fail, leaving the parent and every child unable to recover it. Children
report the merge commit and the currently deployed commit; making them match is an explicit handoff
to a human terminal or another operator proven to be outside the target stack. If the Orchestrator
itself is hosted by that stack, it must make the same handoff rather than executing the restart.

Idle children may still consume live capacity. If one cannot be safely reused, persist and adjudicate its report, verify it has no outstanding work or decisions, and stop it to release its slot before launching a replacement or the next queued issue. Verify the stop completed. Keep its history and include it in final archival; do not wait for whole-campaign convergence to free an otherwise exhausted pool.

After dispatch, actively supervise the whole campaign. Repeatedly check `list_descendant_requests`, consume each child's incremental events from its recorded cursor, and inspect current status for every live campaign child. Resolve only currently Orchestrator-owned exact typed decisions with `resolve_descendant_workflow_decision` under the latest `get_campaign` policy. Use bounded `wait_session` or CLI waits, including `idle` where supported, and rotate fairly among children so one silent, CI-waiting, or blocked child cannot starve the others. Read complete result messages, not just truncated previews, record updated cursors and decisions promptly, and keep the user updated during long waits.

Continue safe work in other children while one child waits at a human-owned gate or on a prerequisite. A single empty descendant-request list, one idle child, or a dependent waiting on a prerequisite is not campaign completion and is not by itself a reason to end the turn. Do not end the turn while authorized campaign work remains unless verified durable wake-up supervision is actually active, the user explicitly pauses or stops the campaign, or no further safe progress is possible pending human intervention. Do not claim background monitoring unless an active wait loop is running or a durable wake-up mechanism has been verified; this skill alone cannot create cross-turn wakeups. An explicit dispatch-only request remains dispatch-only, and a paused campaign remains paused: do not broaden either scope into continued execution.

`idle`, `completed`, and a successful enqueue are not issue completion. Independently verify the PR is merged into its intended base, the acceptance criteria are delivered, tracker updates are present, and cleanup is accounted for. If a slice leaves acceptance criteria incomplete, schedule the remaining work under that issue; do not hide it as optional follow-up work. Keep the exact review, check, and authorization snapshot rules from the repository's issue workflow.

For failures, inspect evidence and resume from the last verified step. Retry transient provider failures with backoff; stop repeating identical non-transient failures and report the specific blocker. Do not replace children while their ownership or mutation outcome is uncertain. A guardrail or required decision pauses affected work; it is not success or a reason to archive unfinished sessions.

## Review and Execute Follow-Ups

After a child's issue reaches verified delivery and branch-cleanup accounting, inspect its Recommended Follow-Ups and the evidence behind each proposal. Collect every proposal in the ledger, including ones later rejected.

Accept only observed defects, unmet requirements, concrete review risks, or deliberately deferred work with testable scope. Independently agree with the evidence and value; do not rubber-stamp the child's list. Reject speculative polish or general refactors with a brief reason. Children must remain candid; never ask them to suppress valid findings to terminate the campaign.

Search open and closed issues, newly created issues, active PRs, and this campaign's pending drafts. Consolidate duplicates across children and record parent-issue lineage. Reuse a matching unresolved issue when appropriate; an already fixed match adds no work. A recurring proposal without new evidence is a convergence warning, not a new issue.

Record each proposal with `record_campaign_follow_up` before acting on it. When the campaign's follow-up policy is Recommend Only, or the disposition is `recommend_only_stop` or `duplicate_stop`, stop at reporting: list the recommendation for the user and do not publish or dispatch it. Only `requires_typed_gates` under Execute Approved continues to the steps below, and that disposition is not itself approval.

For accepted new work, prepare the exact sanitized repository, title, body, and labels following the repository's issue-reporting skill or policy (for example `.github/ISSUE_REPORTING.md`), or GitHub's issue forms when none exists. Obtain the publication authorization required by the active policy. If authorized parent publication is unavailable in the Orchestrator tool boundary, have the child that owns the draft publish it after the exact authorization; do not escape the boundary. Recheck duplicates immediately before creation and verify the published issue by reading it back. Link it from the originating issue.

Queue each accepted, published or existing unresolved follow-up, prioritizing dependencies and impact. Dispatch it through the same claim, fix, review, merge, cleanup, and follow-up cycle. Continue through any number of generations. Do not backfill unrelated tracker issues after the initial selection; descendants of accepted work define the campaign's continuing scope.

If follow-ups continually expand into new product scope, recur after purported fixes, or exceed a user-specified limit, report the lineage and concrete remaining work and seek direction. Do not silently impose a round limit, declare convergence, or discard recommendations.

## Finish and Archive

The campaign converges only when every selected and accepted issue is delivered, every child's latest follow-up report has been adjudicated, no accepted follow-up awaits publication or execution, and no PR, review, approval, or implementation task remains pending. Rejected or already-resolved proposals need recorded reasons; raw recommendations need not be empty if none remain actionable after review.

Before archival, save final child reports and verify remote branches are gone or retained for an explicitly documented dependency. Never delete a branch merely because a PR entered the merge queue. Retained branches or unresolved delivery obligations prevent reporting full completion.

Verify each finished child with `verify_campaign_child`, using its exact completed report event sequence, after its follow-ups are recorded. Under the campaign's Retain completion policy, leave verified children unarchived and report them as retained. Only under Stop and Archive, where verification starts the durable stop/archive lifecycle, archive only this campaign's descendants using Wollipog's supported lifecycle operations; archive itself supports stop-before-archive. Verify `archived: true` and absence of pending/failed stop or archive state; an accepted request is not completed archival. Never archive the parent or unrelated sessions.

Retire runner-owned worktrees only through Wollipog discard/reconciliation. Active worktree retention before provider exit is an expected deferral. After children stop, verify reconciliation or use authorized descendant discard; inspect any remaining local branches and remove only verified merged campaign branches through supported cleanup. Preserve dirty or unpushed work and report it. Serialize shared-checkout refreshes and enforce the hosting-stack restriction above; neither the hosted parent nor any child may perform the deployment restart.

Finish with the initial and follow-up issue/PR links, delivered results, rejected/duplicate follow-up reasons, verified archived session count, and cleanup results. Clearly distinguish convergence from an interrupted or blocked campaign. Do not claim complete cleanup if resources remain unexpectedly retained.
