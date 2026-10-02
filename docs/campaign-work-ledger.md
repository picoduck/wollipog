# Campaign Work Ledger

The campaign work ledger is the durable, issue-level record of an Orchestrator campaign: what it
set out to do, who worked on each item and when, what was verified as delivered, and which
recommendations were accepted. It backs the Campaign Status panel (#2417) and the Orchestrator's own
bookkeeping. The wire types live in `packages/protocol/src/campaign-work-ledger.ts`; this document
is the normative description, and any later change to the contract changes this document in the
same pull request.

Protocol v196 introduces the contract. The `campaignWorkLedger` entry in
`RUNNER_CAPABILITY_MIN_PROTOCOL` gates the runner's ledger tools and CLI commands against the
connected **control plane** (as `sessionArtifactFileAttach` does), not against a runner.

## Principles

- **Recording work never grants authority.** Recording a plan, assigning an item, adjudicating a
  recommendation, or recording a publication state does not publish an issue, dispatch a child,
  merge a pull request, resolve or consume a typed workflow decision, widen the campaign's issue
  scope, or change its policy. Every existing gate is evaluated exactly as before.
- **Root-keyed.** Every row belongs to the root campaign. Each read and write first resolves the
  caller's campaign through `resolvedCampaignSessionId` (the same walk the projection uses, see
  #1462), so a nested Orchestrator records into the campaign it is counted in.
- **Observed and reported are different things.** Server-observed facts carry an observation time
  and a freshness. Orchestrator-reported stages carry their source session and report time. Neither
  is presented as the other.
- **Unavailable is not zero.** A measurement that was not collected is `unavailable` with a reason.
  A known zero is a known value.

## Entities

### Work Item (`cwi_…`)

One unit of committed or proposed campaign work, with or without an issue or a session.

| Field | Meaning |
| --- | --- |
| `key` | Stable Orchestrator-chosen identity, unique per campaign, used for idempotent upsert (`picoduck/wollipog#2417`, `plan:read-api`). |
| `issue` | Optional repository-qualified issue `{repository, number}`. |
| `title` | Optional display title. |
| `origin` | `original` (initial scope, issue or not) or `follow_up` (accepted from a recommendation). |
| `generation` | `0` for original scope; for a follow-up, one more than the highest generation among its origin items. |
| `dispatchState` | Orchestrator record for undispatched work: `planned` (known, not ready) or `queued` (ready, waiting for capacity or dependencies). |
| `queuePosition` | Optional recorded queue order. Lower is earlier. |
| `dependsOn` | Work item ids in the same campaign. |
| `commitment` | `committed`, `cancelled`, or `scope_removed`, with a reason (required for the latter two), time, and recording session. |
| `stage` | The latest reported stage, see below. |
| `blocker` | An optional recorded blocker: reason, responsible actor (`human`, `orchestrator`, `child`, `external`), and optional Request occurrence id. |
| `nextAction` | Optional Orchestrator note on what happens next. |

Cancelled and removed items stay in the ledger and the work list. They are never counted as
committed or delivered and are never silently erased.

### Recommendation

A recommendation extends the existing `orchestrator_campaign_follow_ups` row and keeps its id
(`followup_…`) and its server-side normalized repository/title deduplication. It gains:

- `originWorkItemIds`: one or more items it came from (consolidated recommendations may name
  several);
- `disposition`: `awaiting_adjudication`, `accepted`, `rejected`, `deferred`, or `duplicate`,
  with a reason, time, and adjudicating session. A row the server already deduplicated starts as
  `duplicate`; every other row starts as `awaiting_adjudication`;
- `publication`: `not_required`, `awaiting_publication`, or `published` — a record of whether an
  issue still has to be published, never a grant to publish one;
- `resultingIssue` and `resultingWorkItemId`.

### Attempt (`catt_…`)

One work item executed by one session. It records the start and end time, the end reason, the
history boundary (`eventEpoch`, `runnerHistoryEpoch`, `seq`) at each end, and a snapshot of the
session's title, harness, agent name, model, and effort taken at assignment.

- A session has at most one open attempt, and a work item has at most one open attempt.
- Assigning a session to another item closes the session's open attempt as `reassigned`.
- Assigning an item to another session closes the item's open attempt as `superseded`.
- A delivered work-item verification closes its attempt as `delivered`.
- The Orchestrator may close an attempt explicitly as `abandoned` or `failed`. Cancelling or
  removing an item closes its open attempt as `abandoned`.
- Repeating an assignment that is already open is a no-op and creates nothing.

### Work-Item Verification (`cwv_…`)

Records the work item, attempt, child, the exact report (seq, event epoch, digest, timestamp), the
verifying Orchestrator session (which may be nested), the outcome (`delivered` or `incomplete`), and
the time. It is recorded through `verify_campaign_child`'s optional `workItem`, after every existing
session-level verification check passes, against the child's open attempt on that item.

Unlike session-level child verification, a later execution of the same child does **not**
invalidate it: reassigning a child to item B leaves item A's verification, attempt, and accounting
intact.

### Reported Stage

`implementing`, `in_review`, `awaiting_checks`, `awaiting_approval`, `merge_queued`, `merged`, or
`cleanup`, with a note, pull-request references, the source session, and `reportedAt`. A reported
stage is display information. It never changes the primary state: `merged` does not make an item
delivered.

### Observed Facts

A server-observed fact is `fresh`, `stale` (last value with its observation time), or
`unavailable{reason}`. An unavailable fact never implies a favourable value; it may carry the last
value seen for display only.

- **Session status** of the open attempt's session: status, archived, held, and pending request
  count. A deleted session is `unavailable{session_deleted}`; the attempt snapshot remains.
- **Forge facts** (slice 8): see Forge Status Scope.

## Derived Primary State

Each item has exactly one primary state, derived on read by a pure function of the item record, its
attempts, the observed status of the open attempt's session, its dependencies' derived states, and
its verifications. The state is never stored. The first matching rule wins:

1. `commitment` is `cancelled` → **cancelled**; `scope_removed` → **removed**.
2. The item's latest attempt has a `delivered` verification → **delivered**. Opening a new attempt
   on a delivered item reopens it visibly.
3. The item has an open attempt:
   1. a recorded blocker → **blocked** (`recorded_blocker`);
   2. the session is deleted → **blocked** (`attempt_session_unavailable`);
   3. the session is held, failed, or stopped, or archived without a delivered verification →
      **blocked** (`attempt_session_held`, `attempt_session_failed`, `attempt_session_stopped`);
   4. the session is `input_required` or has a pending request → **waiting**
      (`attempt_session_input_required`, `attempt_session_pending_decision`);
   5. the session is `idle` or `completed` → **waiting** (`attempt_awaiting_verification`): the
      Orchestrator owes a verification;
   6. otherwise (`queued`, `starting`, `running`) → **running**.
4. The item has no open attempt:
   1. a recorded blocker → **blocked** (`recorded_blocker`);
   2. a dependency is `blocked`, `cancelled`, or `removed` → **blocked** (`dependency_blocked`); a
      dependency cycle is treated the same way;
   3. `dispatchState` is `queued` → **queued** (also `dependency_unfinished` when a dependency is
      unfinished);
   4. otherwise → **planned**.

`delivered` therefore requires a work-item verification with outcome `delivered`. An idle session,
a closed issue, a successful command, a reported `merged` stage, or a pull request in the merge
queue never sets it.

The unfinished states are `planned`, `queued`, `running`, `waiting`, and `blocked`. Accepted work
waiting on dependencies or approvals stays unfinished.

## Orchestrator Operations

All operations are available only to the Orchestrator role through MCP tools (`ORCHESTRATOR_TOOLS`
and `PARENT_CONTROL_TOOLS`), the `wollipog` CLI, and routes listed in `ORCHESTRATOR_API_ROUTES`. Each
resolves the root campaign, refreshes the root and the caller's session, and increments the ledger
`revision`. Requests over the bounds in `CAMPAIGN_WORK_LEDGER_LIMITS` are refused, not truncated.

| Operation | Effect |
| --- | --- |
| `record_campaign_plan {items[], planComplete}` | Idempotent upsert by `key`, at most 100 items per call. Supplied fields replace; omitted fields are unchanged. Dependencies are named by key, within the call or already recorded. It never changes commitment, attempts, or verification. |
| `update_campaign_work_item {workItemId, …}` | Title, issue, dispatch state, queue position, dependencies, commitment, stage, blocker, next action, and `endAttempt {reason: abandoned \| failed}`. `null` clears. |
| `assign_campaign_work_item {workItemId, childSessionId}` | Opens an attempt; closes earlier open attempts as described above. The child must be a campaign descendant visible to the caller. |
| `verify_campaign_child {…, workItem?: {id, outcome}}` | Existing verification, plus a work-item verification for the child's open attempt on that item. Without `workItem`, no item becomes delivered. |
| `record_campaign_follow_up {…, originWorkItemIds?}` | Existing deduplicated recording, plus origin items. |
| `adjudicate_campaign_recommendation {recommendationId, disposition, reason, resultingWorkItemKey?, resultingIssue?, publicationRequired?}` | Records a disposition. `accepted` creates or links a `follow_up` work item. `duplicate` may link the existing item it duplicates. Re-adjudication replaces the previous disposition; it does not cancel a previously created item, which the Orchestrator does explicitly. |
| `get_campaign_work_items` | The Orchestrator's paginated read of its own campaign: summary, a page or one item's detail, and optionally recommendations. |

None of these operations admits a child, sends a prompt, publishes or closes an issue, merges,
deletes a branch, approves or consumes a workflow decision, or changes a policy, owner, budget,
guardrail, or issue scope. Tests assert that typed gates behave identically with and without
ledger records.

## Read API

- **Summary** (`OrchestratorCampaignProjection.work`, `CampaignWorkSummary`): `revision`,
  `planState`, coverage, committed/delivered/original/follow-up/cancelled/removed counts,
  per-state counts, recommendation counts by disposition, outstanding verification, adjudication,
  publication, and cleanup obligations, campaign `elapsed`, and (slice 6) `cost`. It stays small
  enough to ride on existing session updates. Any ledger write re-sends the root session.
- **Plan state**: `not_recorded` until the first `record_campaign_plan`; `partial` while the latest
  plan call said `planComplete: false`; `recorded` after `planComplete: true`. Coverage separately
  counts campaign children that have no attempt on any item and flags campaigns whose history
  predates the ledger.
- **Membership** (`SessionView.campaignMembership`): for a campaign descendant, the root
  `campaignSessionId` and the current work item and attempt, or null.
- **Endpoints** (slice 5), where `:id` may be the root or any member:
  - `GET /api/sessions/:id/campaign/summary`
  - `GET /api/sessions/:id/campaign/work-items?cursor&limit&origin&state&sort` returns a
    `CampaignWorkItemsPage`. The default filter is `unfinished`, the default sort is `queue`
    (queue position, then creation). The cursor is opaque and bound to the filter, sort, and
    revision; a cursor from another revision returns `409 {code: "revision_changed", revision}` and
    the client restarts from the first page.
  - `GET /api/sessions/:id/campaign/work-items/:itemId` returns a `CampaignWorkItemDetailResponse`.

## Authorization and Cost Visibility

- A human principal needs `canAccessSession(root)` to read the summary, list, or details.
- An Orchestrator agent may read and write only its own resolved campaign. Children and other
  agents have no ledger access.
- Cost follows the existing session-cost rule, which is session access. A per-attempt cost is shown
  only when the principal can access that attempt's session (or the session was deleted and the
  principal can access the root). A campaign bucket is `unavailable{not_authorized}` when the
  principal cannot access every session contributing to it.

## Retention

- Ledger rows are keyed by the root campaign with `ON DELETE CASCADE`: deleting the root deletes
  its ledger, as the existing explicit-deletion behaviour does.
- Child-session references (attempt session, verification child, recording or verifying
  Orchestrator, recommendation origin) are `ON DELETE SET NULL` and keep the snapshots described
  above, so archiving or deleting a child preserves item history, verification, and accounting.
- The existing follow-up rows' cascade on origin-session delete changes to `SET NULL` (table
  rebuild) so a recommendation outlives the child that made it.
- Event pruning does not touch the ledger: attempts store history boundaries, not events, and usage
  attribution (slice 6) is persisted as usage arrives.
- Usage attribution rows follow the existing usage retention policy for their bucket granularity.

## Time Metrics

| Metric | Definition |
| --- | --- |
| Campaign Elapsed | Root creation to verified campaign completion, or now while unfinished. Never a sum of item durations: two concurrent ten-minute items take about ten minutes. |
| Item Elapsed | First attempt start to the delivered verification, or now while unfinished, including intervening waits. Planned items without an attempt show their recorded age instead. |
| Queue Time | Recorded intervals in which the item was `queued`. |
| Waiting Time | Recorded intervals in which the item was `waiting` or `blocked`. |
| Active Time | Recorded intervals within an attempt while its session was running. |

Queue, Waiting, and Active Time come from durable status intervals (slice 6), kept independent of
the event cache. Time before interval recording began is `unavailable{history_unavailable}`, never
zero.

## Usage Attribution (Slice 6)

Attribution is written in the same transaction as `recordUsageDeltaInTransaction`, so each usage
record is counted exactly once and survives replay, epoch replacement, and event pruning. A delta
goes to:

1. the session's open attempt;
2. otherwise **coordination**, when the session is the root or a nested Orchestrator;
3. otherwise **unattributed**.

Snapshot residuals go to the attempt open at observation time. Provider-subagent usage stays
excluded, as session totals already exclude it. Cost provenance keeps `providerReported`,
`modelPriced`, `unpriced`, and `unpricedRecords`; labels distinguish provider-reported amounts,
estimated API cost, partially priced usage, and unavailable data. Usage recorded before attribution
existed is reported through `attributedSince` and makes affected buckets `partial`.

Budgets show their actual scope: a parent-session budget is never presented as a campaign-wide
budget. Forecasts and ETA are out of scope.

## Forge Status Scope (Slice 8)

- **Forge:** GitHub only, read on a runner through its existing `gh` login. The control plane
  stores no forge credentials.
- **Data:** pull-request state, head SHA, review decision, check rollup, and merge-queue entry, only
  for pull requests referenced by the campaign's work items.
- **Refresh:** on demand while the panel is visible, plus a bounded background refresh for
  unfinished items.
- **Freshness:** an observation becomes `stale` after a fixed age. When `gh` is missing,
  unauthenticated, offline, or the forge is unsupported, the fact is `unavailable` with that reason.
  Unavailable data never implies passing checks.

## Compatibility

- Control planes before v196 omit `OrchestratorCampaignProjection.work` and
  `SessionView.campaignMembership`. Clients present that absence as an availability explanation,
  never as an empty or unrecorded plan. A v196 control plane always sends `work` for an
  Orchestrator, with `planState: "not_recorded"` when nothing was recorded.
- The browser needs no separate UI protocol constant: the presence of `work` is the capability
  signal, and the control plane accepts every browser version.
- Optional fields owned by later slices (`cost`, `times`, `attemptCosts`, `observed.pullRequests`)
  mean "not collected here" when omitted.

## Deviations From the Posted Plan

The [campaign plan](https://github.com/picoduck/wollipog/issues/2417#issuecomment-5961353699) is the
starting contract. This document refines it as follows:

1. **`dispatchState`** (`planned` | `queued`) is an explicit recorded field. The plan derived both
   states from "the Orchestrator's record" without naming the field.
2. **Queued versus blocked dependencies.** The plan listed unmet dependencies both under `queued`
   and under `blocked`. Here an unfinished dependency leaves the item `queued` (or `planned`), and
   only a `blocked`, `cancelled`, `removed`, or cyclic dependency makes it `blocked`.
3. **`endAttempt`** on `update_campaign_work_item` lets the Orchestrator close an attempt as
   `abandoned` or `failed`; the plan named those end reasons but no operation produced them.
   Cancelling or removing an item closes its open attempt as `abandoned`.
4. **`superseded`** means the item moved to another session; **`reassigned`** means the session
   moved to another item.
5. **Delivered requires the latest attempt's verification**, so reassigning a delivered item
   reopens it visibly instead of leaving it delivered.
6. **Plan dependencies use keys** (`dependsOnKeys`), because ids do not exist before the first
   upsert; `update_campaign_work_item.dependsOn` uses ids.
7. **Recommendation publication** defaults to `awaiting_publication` for accepted work until an
   issue is recorded, unless the adjudication says `publicationRequired: false`.
8. **Metrics carry availability** (`CampaignMetric`: `known`, `partial`, `unavailable`) per bucket,
   rather than one `coverage` field for the whole cost summary.
9. **`publication` obligations** are counted in the summary alongside verification, adjudication,
   and cleanup.
10. **No UI protocol constant**: see Compatibility.
11. **Capability ordering.** v196 is assigned with the contract, before the operations land. A
    control plane built between the contract and the storage slice advertises v196 without the
    operations, so the runner's ledger tools receive `404` from it. If a release ships in that
    state, the storage slice bumps the version again and moves the capability to it.
