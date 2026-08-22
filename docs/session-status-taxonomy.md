# Session Status Taxonomy

Session status is multidimensional. A workflow column is organization only; it never changes or proves lifecycle, required attention, repository state, health, or background work. Surfaces should show the primary lifecycle or attention state and then any simultaneous secondary indicators.

## Canonical Matrix

| Dimension | Authoritative Input | Visible Label | Meaning |
| --- | --- | --- | --- |
| Activity | `status=queued` | **Queued** | Accepted but not yet starting. |
| Activity | `status=starting` | **Starting** | The runner is launching or initializing the provider. |
| Activity | `status=running` | **Running** | An agent turn is actively executing. |
| Activity | `status=input_required` | **Awaiting Input** | The current turn is paused for a person. Pair this with the concrete attention label when available. |
| Activity | `status=idle` | **Awaiting Prompt** | The reusable session has no executing turn and can accept another prompt. This says nothing about changes or review readiness. |
| Activity | `archiveStatus=stop_pending` | **Stopping** | A durable stop-before-archive operation is in progress. |
| Activity | `status=completed` | **Completed** | The session ended normally. |
| Activity | `status=failed` | **Failed** | The provider or session ended in failure. |
| Activity | `status=stopped` | **Stopped** | A person stopped the session. |
| Attention | `pendingApproval.kind=question` | **Answer Required** | The agent asked a structured question. |
| Attention | `pendingApproval.kind=authentication` | **Authentication Required** | Provider authentication is required. |
| Attention | Any other `pendingApproval` | **Approval Required** | A permission, policy, budget, or tool-limit decision is required. |
| Attention | `status=input_required` without a pending-action kind | **Input Required** | Neutral mixed-version fallback; the concrete action is unavailable. |
| Attention | Explicit review-request evidence | **Review Requested** | Reserved for an authoritative review request. Workflow-column placement is not evidence. |
| Changes | Completed Git read with a known base and no working-tree or base-relative changes | **No Changes** | Git confirmed an empty change set. |
| Changes | Completed Git read with working-tree changes or commits ahead of base | **Changes Present** | Git confirmed a real change set, including while another dimension says Running or requires attention. |
| Changes | Confirmed commits ahead of base with an open pull request | **Ready for Review** | The current defensible review-readiness signal. |
| Changes | No completed Git read, unavailable repository, or stale/missing evidence | No badge | Never infer **Changes Present** or **Ready for Review** from lifecycle or Board column. |
| Workflow | `column` | Board column title only | Filing and organization; it does not alter any status dimension. |
| Health | Activity watchdog exceeds ten minutes | **Stalled** | A derived exceptional condition shown alongside lifecycle and attention. |
| Health | Session runner is offline | **Disconnected** | The authoritative runner connection is unavailable. |
| Health | History or connection recovery is active | Recovery-specific supporting text | Recovery does not rewrite lifecycle. |
| Background Work | `backgroundWorkState=running` | **Waiting on External Job** | Detached work is still pending externally. |
| Background Work | `backgroundWorkState=continuation_pending` | **Continuation Pending** | A continuation is durably pending. |
| Background Work | Other tracked/untracked delivery states | Existing specific background label | Background state remains independent of foreground activity. |

## Projection Rules

- Show **Running** only for `status=running`. Counts labeled **Running** use that same predicate; **Queued** and **Starting** have separate counts.
- Show lifecycle and attention together when both apply. Do not replace **Running**, **Awaiting Prompt**, or another lifecycle fact with a workflow-column interpretation.
- Show change state only after a successful Git observation. A Review-column session with no observation has no change badge.
- Keep compact visible labels and accessible names on the same Title Case terminology. Descriptions and notifications use sentence case.
- Unknown lifecycle values use **Status Unavailable**. An undifferentiated legacy input state uses **Input Required**. Missing Git or background fields produce no affirmative claim.
- Refreshes, reconnects, and session transitions replace the relevant dimension independently; they must not synthesize a change in another dimension.

## Surface Contract

Inbox rows, session headers, the pinned summary, Board cards, Run member columns, Pod member rows, archives, filters, counts, notifications, and mobile layouts consume these terms. A surface omits a dimension when it lacks authoritative evidence, but it must never substitute workflow placement or another dimension as proof.
