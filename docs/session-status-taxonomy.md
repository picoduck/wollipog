# Session Status Taxonomy

Session status is multidimensional. A workflow column is organization only; it never changes or proves lifecycle, required attention, repository state, health, or background work. Surfaces should show the primary lifecycle or attention state and then any simultaneous secondary indicators.

## Canonical Matrix

| Dimension | Authoritative Input | Visible Label | Meaning |
| --- | --- | --- | --- |
| Activity | `status=queued` | **Queued** | Accepted but not yet starting. A `capacityWait` names the capacity boundary; a `queueHold` names the worktree or account handoff the accepted prompt waits behind, with its reason in `holds`. |
| Activity | `status=starting` | **Starting** | The runner is launching or initializing the provider. |
| Activity | `status=running` | **Running** | An agent turn is actively executing. |
| Activity | `status=input_required` | **Awaiting Input** | The current turn is paused for a person. Pair this with the concrete attention label when available. |
| Activity | `status=idle` | **Awaiting Prompt** | The reusable session has no executing turn and can accept another prompt. This says nothing about changes or review readiness. |
| Activity | `stopOperation.status=stop_pending` (falling back to `archiveStatus=stop_pending` for older control planes) | **Stopping** | A durable stop operation is in progress. |
| Activity | `status=completed` | **Completed** | The session ended normally. |
| Activity | `status=failed` | **Failed** | The provider or session ended in failure. |
| Activity | `status=stopped` | **Stopped** | A person stopped the session. |
| Attention | `pendingApproval.kind=question` and `recoveryReason=provider_restart` | **Recovery Required** | A structured question survived a provider restart but its original answer callback did not; dismiss the preserved question before continuing. |
| Attention | `pendingApproval.kind=question` without a recovery reason | **Answer Required** | The agent asked a structured question. |
| Attention | `pendingApproval.kind=authentication` | **Authentication Required** | Provider authentication is required. |
| Attention | Any other `pendingApproval` | **Approval Required** | A permission, policy, budget, or tool-limit decision is required. |
| Attention | `status=input_required` without a pending-action kind | **Input Required** | Neutral mixed-version fallback; the concrete action is unavailable. |
| Attention | Parent campaign `orchestratorCampaign.pendingRequests.human > 0` | **Needs Your Input** | One or more unresolved descendant requests are explicitly assigned to the human. This is independent of the parent lifecycle. |
| Agent Work | Parent campaign `orchestratorCampaign.pendingRequests.orchestrator > 0` | **Orchestrator Action** | One or more unresolved descendant requests are assigned to the Orchestrator. This is not human attention and does not enter human notification counts. |
| Attention | Explicit review-request evidence (reserved; no current producer) | **Review Requested** | Reserved for an authoritative review request. Workflow-column placement is not evidence. |
| Changes | Completed Git read with a known base and no working-tree or base-relative changes | **No Changes** | Git confirmed an empty change set. |
| Changes | Completed Git read with working-tree changes or commits ahead, without a confirmed base-plus-open-pull-request pairing | **Changes Present** | Git confirmed a real change set at the latest eligible quiescent boundary. |
| Changes | Confirmed commits ahead of base with an open pull request and a clean working tree | **Ready for Review** | The committed base-relative change set is reviewable. |
| Changes | Confirmed commits ahead of base with an open pull request and working-tree changes | **Ready for Review** + **Uncommitted Changes** | The committed change set is reviewable, while additional local work remains outside the pull request. Neither indicator replaces the other. |
| Changes | No completed Git read, unavailable repository, or stale/missing evidence | No badge | Never infer **Changes Present** or **Ready for Review** from lifecycle or Board column. |
| Workflow | `column` | Board column title only | Filing and organization; it does not alter any status dimension. |
| Health | Activity watchdog exceeds ten minutes | **Stalled** | A derived exceptional condition shown alongside lifecycle and attention. |
| Health | Session runner is offline | **Disconnected** | The authoritative runner connection is unavailable. |
| Health | History or connection recovery is active | Recovery-specific supporting text | Recovery does not rewrite lifecycle. |
| Background Work | `backgroundWorkState=running` | **Waiting on External Job** | Detached work is still pending externally. |
| Background Work | `backgroundWorkState=continuation_pending` | **Continuation Pending** | A continuation is durably pending. |
| Background Work | `backgroundWorkState=orphaned` | **Background Work: Orphaned** | Managed work needs recovery or authoritative re-observation. |
| Background Work | `backgroundDeliveries[].watchdogState=continuation_blocked` | **Result Blocked** | A finished job's result cannot be returned while a sibling job from the same turn has no terminal status; it asks for a step, unlike the self-progressing **Result Pending**. |
| Background Work | Listed job with `stalledSince` (no terminal status for over an hour) | **Stalled** job row | A report that the job may never end, not proof that it ended. |
| Background Work | Settled delivery or legacy `backgroundWorkState=resumed` | No current-status badge | Completion remains in the timestamped Background Work inventory instead of resembling live work. |

## Projection Rules

- Show **Running** only for `status=running`. Counts labeled **Running** use that same predicate; **Queued** and **Starting** have separate counts.
- Show lifecycle and attention together when both apply. Do not replace **Running**, **Awaiting Prompt**, or another lifecycle fact with a workflow-column interpretation.
- Show change state only after a successful Git observation, and suppress retained observations while a turn is queued, starting, running, or awaiting input. A Review-column session with no observation has no change badge.
- Review readiness and uncommitted work coexist. Keep **Ready for Review** for the confirmed committed change set and add **Uncommitted Changes** for working-tree changes; never imply that those local changes are included in the pull request.
- Keep compact visible labels and accessible names on the same Title Case terminology. Descriptions and notifications use sentence case.
- Unknown lifecycle values use **Status Unavailable**. An undifferentiated legacy input state uses **Input Required**. Missing Git or background fields produce no affirmative claim.
- Refreshes, reconnects, and session transitions replace the relevant dimension independently; they must not synthesize a change in another dimension.
- A campaign parent can be **Awaiting Prompt** while also showing **Needs Your Input** or **Orchestrator Action**. Descendant request ownership comes from durable request and policy state, never from lifecycle or prose. Human-owned campaign requests participate in the parent's Inbox, reminders, push, and browser notifications. Orchestrator-owned requests remain visible as agent work but do not notify the human.
- Current clients group the parent request panel by **Needs Your Input** and **Orchestrator Action** with exact request counts. Older projections that omit `pendingRequests` retain the neutral descendant summary; missing ownership data must not invent human attention.
- Managed background indicators open the **Background Work** inventory. Job lifecycle, continuation delivery, and notification delivery are separate fields; offline or stale non-terminal evidence reads **Status Unverified**.
- A session with several pending requests shows one attention term per kind, each with its count when more than one ("**Answer Required** 2 · **Approval Required**"), in priority order: Recovery, Authentication, guardrail pauses, Answer, Approval. Session headers may still roll these up into an "N Actions Required" count. A parent session's Inbox row and Board card also carry a family rollup of its child sessions ("4 Children · 2 Awaiting Input"), which is a count of children, not an attention term of the parent's own.
- Authoritative running, continuation-pending, and orphaned background work stays visible in Inbox rows and expanded Session headers alongside lifecycle. Mobile headers reserve a full-width line for it before the measured lifecycle/change/action line; passive change badges may overflow, but background work never requires opening the status popover. Settled work adds no current-status line.

## Surface Contract

Inbox rows, session headers, the pinned summary, Board cards, Run member columns, Pod member rows, archives, filters, counts, notifications, and mobile layouts consume these terms. A surface omits a dimension when it lacks authoritative evidence, but it must never substitute workflow placement or another dimension as proof.
