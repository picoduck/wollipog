# Session Status Taxonomy

Session status is multidimensional. A workflow column is organization only; it never changes or proves lifecycle, required attention, repository state, health, or background work. Surfaces should show the primary lifecycle or attention state and then any simultaneous secondary indicators.

Every label below comes from one vocabulary in the web client, `statusMeta(domain, value)` (docs/design-system.md §11.2), and renders as the one `.status` badge recipe with a tone. No surface keeps its own label table.

## Canonical Matrix

| Dimension | Authoritative Input | Visible Label | Meaning |
| --- | --- | --- | --- |
| Activity | `status=queued` | **Queued** | Accepted but not yet starting. A `capacityWait` names the capacity boundary; a `queueHold` names the worktree or account handoff the accepted prompt waits behind, with its reason in `holds`. |
| Activity | `status=starting` | **Starting** | The runner is launching or initializing the provider. |
| Activity | `status=running` | **Running** | An agent turn is actively executing. |
| Activity | `status=input_required` | **Awaiting Input** | The current turn is paused for a person. When an attention label is shown it replaces this one: attention outranks lifecycle, and a surface says a session needs the user once. |
| Activity | `status=idle` | **Awaiting Prompt** | The reusable session has no executing turn and can accept another prompt. This says nothing about changes or review readiness. |
| Activity | `stopOperation.status=stop_pending` (falling back to `archiveStatus=stop_pending` for older control planes) and the session's runner is online | **Stop Pending** | A durable stop operation is being delivered. The badge pulses. |
| Activity | The same pending Stop while the session's runner is offline | **Stop Waiting for Runner** | The Stop is still pending and runtime capacity may still be held, but nothing is delivered until the runner reconnects, so it is neutral and does not pulse. It returns to **Stop Pending** on reconnect. |
| Activity | `stopOperation.status=stop_failed` | **Stop Failed** | The durable stop operation failed; the failure message is the badge's tooltip and Retry Stop recovers it. |
| Activity | `status=completed` | **Completed** | The session ended normally. |
| Activity | `status=failed` | **Failed** | The provider or session ended in failure. |
| Activity | `status=stopped` | **Stopped** | A person stopped the session. |
| Attention | `pendingApproval.kind=question` and `recoveryReason=provider_restart` | **Recovery Required** | A structured question survived a provider restart but its original answer callback did not; dismiss the preserved question before continuing. |
| Attention | `pendingApproval.kind=question` without a recovery reason | **Answer Required** | The agent asked a structured question. |
| Attention | `pendingApproval.kind=authentication` | **Authentication Required** | Provider authentication is required. |
| Attention | Any other `pendingApproval` | **Approval Required** | A permission, policy, budget, or tool-limit decision is required. |
| Attention | `status=input_required` without a pending-action kind | **Input Required** | Neutral mixed-version fallback; the concrete action is unavailable. With no pending request at all, the session is held between turns: after the provider rejected two turns in a row with the same error, the runner holds automatic turns until a person sends a message or restarts the session (#3100). It is also held when the automatic turn that returns finished background results failed to start three times in a row before the provider accepted it: the runner stops retrying, keeps the results owed, and the timeline shows **Background Results Held**; Restart, or a person's message the provider accepts, delivers them (#3542). No turn is working, so no Working row shows, and Retry Turn is available. |
| Attention | Parent campaign `orchestratorCampaign.pendingRequests.human > 0` | **Needs Your Input** in the Sessions list; **N Child Requests** in the session's status | One or more unresolved descendant requests are explicitly assigned to the human. This is independent of the parent lifecycle. The session bar's Session Status and the session's badges show it as one warning condition, "8 Child Requests" (#2206). |
| Agent Work | Parent campaign `orchestratorCampaign.pendingRequests.orchestrator > 0` | None; counted in the Requests panel | One or more unresolved descendant requests are assigned to the Orchestrator. This is not human attention, does not enter human notification counts, and has no status of its own: the Requests panel lists them under **Orchestrator Is Handling** (#2206). |
| Attention | Explicit review-request evidence (reserved; no current producer) | **Review Requested** | Reserved for an authoritative review request. Workflow-column placement is not evidence. |
| Workflow | `column` | Board column title only | Filing and organization; it does not alter any status dimension. An at-rest Full Control root whose server-derived column is Review moves by its campaign state instead (#2938): Campaign Active to Running, Campaign Complete and Complete, Needs Cleanup to Done. See the projection rules. |
| Health | Transcript silence or elapsed time alone | None | No session health state is derived from silence or a clock (#4193). A deliberate wait reads as one of the Wait conditions below, and only the server's report that its liveness contract broke turns it into a warning. |
| Health | Session runner is offline | **Disconnected** | The authoritative runner connection is unavailable. |
| Health | History or connection recovery is active | Recovery-specific supporting text | Recovery does not rewrite lifecycle. |
| Wait | `waits[]` entry with `health=healthy` and `target.kind=session`, `target.child=true`, while `status=running` or `status=input_required` | **Waiting on Children** | A `wait_session` call on a descendant is in progress and keeps its liveness contract (docs/agent-control.md, Tracked Waits). Info tone, a secondary condition beside lifecycle. |
| Wait | The same healthy entry with `target.child=false` | **Waiting on Session** | A `wait_session` call on a session that is not a descendant is in progress and keeps its contract. |
| Wait | The same healthy entry with `target.kind=pull_request` | **Waiting on Pull Request** | A `wait_pull_request` call is in progress and keeps its contract. One label shows for the oldest healthy wait; its description counts any others. |
| Wait | Any `waits[]` entry with `health=stalled`, while `status=running` or `status=input_required` | **Wait Stalled** | The control plane reported that the wait's contract broke; `stalledReason` (`progress_lost`, `target_missing`, `target_reached` or `deadline_passed`) names which part. Warning tone, shown ahead of a healthy wait. The client compares no clock. It is not a request and adds to no attention count. |
| Wait | `pullRequestWatch.state=watching`, session not terminal | **Waiting on Merge Queue** | The session is parked on a pull request in the merge queue (#4071) and wakes when it merges, leaves the queue or its head moves. Info tone. A disconnected runner shows **Disconnected** separately. |
| Wait | `pullRequestWatch.state=fired` and `pullRequestWatch.continuation` is `none`, `held`, `delivering` or `uncertain`, session not terminal | **Merge Queue Wake Pending** | The watch ended and its wake prompt has not reached the session yet. Neutral tone. |
| Wait | `pullRequestWatch.state=lost`, session not terminal | **Merge Queue Watch Lost** | Wollipog stopped watching the pull request; `pullRequestWatch.reason` gives why when present. Warning tone, ranked with recovery conditions; not a request. |
| Background Work | `backgroundWorkState=running` | **Waiting on External Job** | Detached work is still pending externally. |
| Background Work | `backgroundWorkState=continuation_pending`, `backgroundFollowUp.state=queued` | **Follow-Up Queued** | Background results need an automatic follow-up turn. Neutral, without a pulse; no corresponding turn is executing. |
| Background Work | `backgroundFollowUp.state=running` and `status=running`, runner online | **Running** | The runner matched the executing turn to the pending background results. An unrelated running turn does not imply the follow-up is executing. |
| Background Work | `backgroundFollowUp.state=blocked`, runner online | **Follow-Up Blocked** | A known budget, governance, input, recovery, or worktree condition prevents the follow-up from starting. Details explain the blocker. |
| Background Work | `backgroundWorkState=continuation_pending`, execution facts unavailable or runner offline | **Follow-Up Pending** | Neutral compatibility fallback; no claim that a turn is executing. |
| Background Work | `backgroundWorkState=orphaned` | **Background Work Lost** (the job row reads **Lost**) | Managed work needs recovery or authoritative re-observation. The wire value is unchanged; "Orphaned" is retired from visible text and accessible names. |
| Background Work | `backgroundDeliveries[].watchdogState=continuation_blocked` | **Result Blocked** | A finished job's result cannot be returned while a sibling job from the same turn has no terminal status. **Acknowledge** clears the currently reported blocked-result alerts from status and reminders while keeping their jobs, held results and execution barriers intact. Background Work retains **Acknowledged** entries; a newly blocked result raises fresh attention (#3408). Reported only once the parent turn has ended and the result has waited an hour (`BACKGROUND_HANDOFF_WAIT_MAX_MS`); until then the receipt has no watchdog state and the session reads **Waiting on External Job** (#3073). |
| Background Work | Job without a terminal status that the connected runner lists (`sourcePresent`), while `backgroundWorkState` is `running` or `continuation_pending` and the runner supports the job inventory | **Running** job row | The job's liveness contract holds, so it reads Running at any age: managed jobs declare no deadline, and elapsed time alone never changes a job's state (#4253). When a queued handoff waits on the job past its bound (`queueHold.endsAt`), the runner ends it and it becomes a killed job row. |
| Background Work | Job without a terminal status where that evidence is gone: the runner stopped listing it, is offline or predates the inventory, or the session's background work is no longer current | **Unverified** job row | Neutral, with a hollow dot. No claim that the job is running or that it ended. |
| Background Work | Job the runner still lists while `backgroundWorkState=orphaned` | **Lost** job row | A runner restart orphaned the job; it needs recovery or authoritative re-observation. |
| Background Work | `stalledSince` on a listed job without a terminal status, set once `BACKGROUND_JOB_STALL_MS` (one hour) has passed since it was registered | None; no surface shows it as a badge | A control-plane fact for campaign safety, not a status. Past the bound the job no longer counts as a campaign child's wait (`campaignChildWait`, `sessionsWithLiveBackgroundJobs`), so a monitor that never fires cannot hide a finished report. The job row keeps the state the rows above give it. |
| Background Work | Settled delivery or legacy `backgroundWorkState=resumed` | No current-status badge | Completion remains in the timestamped Background Work inventory instead of resembling live work. |

Changes are facts, not a status dimension (docs/design-system.md §11.2): the Pinned Summary's Git
section states the change counts, the commit action, the pull request with its state, and its
checks (#2160). No session surface shows a Changes badge.

## Projection Rules

- Show **Running** only for `status=running`. Counts labeled **Running** use that same predicate; **Queued** and **Starting** have separate counts.
- Show lifecycle and attention together when both apply, except that an attention label replaces **Awaiting Input** rather than repeating it. Do not replace **Running**, **Awaiting Prompt**, or another lifecycle fact with a workflow-column interpretation.
- An at-rest Full Control root's campaign state comes from the server (`fullControlCampaignStatus`, or the campaign projection) and is never derived from a column or a clock (#2938):
  - Its Sessions row, Board card, session header and the Sessions preview bar show **Campaign Active**, **Campaign Complete** or **Complete, Needs Cleanup** in place of **Awaiting Prompt**, because the person owes such a root no prompt (#4369). One projection decides this for every surface, so they always agree. Beside **Completed**, the campaign state is the secondary.
  - A row or card whose children still work keeps **Children Working** (or **Child Work Pending**) as its secondary, beside the campaign state.
  - **Campaign Stuck** needs a person, so every surface keeps **Awaiting Prompt** and shows **Campaign Stuck** as the secondary, ahead of **Ready for Review**.
  - The replacement changes only the label shown. The session's `status`, filters and counts keep reading the lifecycle.
  - On the Board, a root whose column the server derived as Review moves to Running while its campaign is Active, and to Done once it is Complete or Complete, Needs Cleanup.
  - Campaign Stuck, Waiting for You, the older Blocked and Complete with Handoffs, a Custom campaign and any descendant keep the server's column and header. So do a failed or stopped root, a request or human-owned campaign request, a pending Stop, a fired reminder, and a column outside Review that the person filed by hand. (A summary row does not say whether Review was filed by hand or derived, so a root filed in Review still moves.) Live work, background work, a wait and a disconnected machine also keep the labels these surfaces showed before.
  - A control plane that sends no campaign status keeps today's column and labels on every surface.
- Keep compact visible labels and accessible names on the same Title Case terminology. Descriptions and notifications use sentence case.
- Unknown lifecycle values use **Status Unavailable**. An undifferentiated legacy input state uses **Input Required**. Missing Git or background fields produce no affirmative claim.
- Refreshes, reconnects, and session transitions replace the relevant dimension independently; they must not synthesize a change in another dimension.
- A campaign parent can be **Awaiting Prompt** while also showing **N Child Requests**. Descendant request ownership comes from durable request and policy state, never from lifecycle or prose. Human-owned campaign requests participate in the parent's Inbox, reminders, push, and browser notifications. Orchestrator-owned requests remain visible as agent work but do not notify the human.
- Current clients group the parent's Requests panel by **Waiting for You** and **Orchestrator Is Handling** with exact request counts. Older projections that omit `pendingRequests` retain the neutral descendant summary; missing ownership data must not invent human attention.
- Managed background indicators open the **Background Work** inventory. Job lifecycle, continuation delivery, and notification delivery are separate fields; offline or stale non-terminal evidence reads **Unverified**, with a hollow dot. A subagent that is no longer reachable reads **Lost**.
- A session with several pending requests shows one attention term per kind, each with its count when more than one ("**Answer Required** 2 · **Approval Required**"), in priority order: Recovery, Authentication, guardrail pauses, Answer, Approval. Session headers may still roll these up into an "N Actions Required" count. A parent session's Inbox row and Board card also carry a family rollup of its child sessions ("4 Children · 2 Awaiting Input"), which is a count of children, not an attention term of the parent's own.
- Authoritative running, follow-up-pending, and lost background work stays visible in Inbox rows and expanded Session headers alongside lifecycle. Mobile headers reserve a full-width line for it before the measured lifecycle/action line; passive badges may overflow, but background work never requires opening the status popover. Settled work adds no current-status line.

## Surface Contract

Protocol v240 adds display-only `backgroundFollowUp` facts to negotiated runtime and reconnect
snapshots, persisted in both full and compact session projections. Background Work details show
the durable queue time and age when supplied, and whether an automatic retry timer is armed.
Elapsed time never authorizes a retry or establishes failure. Missing facts clear old execution
claims; offline facts are unverified. Pending badges clear after delivery settles, while receipts
remain historical. These presentation facts do not change execution, spending, approval, or
at-most-once submission protections.

Inbox rows, session headers, the pinned summary, Board cards, Run member columns, Pod member rows, archives, filters, counts, notifications, and mobile layouts consume these terms. A surface omits a dimension when it lacks authoritative evidence, but it must never substitute workflow placement or another dimension as proof.
