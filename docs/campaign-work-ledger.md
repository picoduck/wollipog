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
| `generation` | `0` for original scope; for a follow-up, one more than the highest generation among its origin items, or `1` when the recommendation names no origin item (for example, one recorded before the ledger existed). |
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

- **Session status** of the latest attempt's session: status, archived, held, and pending request
  count. A deleted session is `unavailable{session_deleted}`; the attempt snapshot remains.
- **Cleanup** (slice 5) of the latest attempt's session: each worktree as `pending`, `deferred`,
  `refused` (the existing campaign cleanup vocabulary, with its reason) or `retired`.
- Read API, Observed Facts in Details, describes freshness.
- **Forge facts** (slice 8): see Forge Status.

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
   3. the session is held, failed, stopped, or archived (without a delivered verification, by
      rule 2) → **blocked** (`attempt_session_held`, `attempt_session_failed`,
      `attempt_session_stopped`, `attempt_session_archived`, checked in that order);
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
resolves the root campaign. Each mutating operation that changes the ledger refreshes the root and
the caller's session and increments the ledger `revision` exactly once; a no-op repeat changes
nothing. Reads, including `get_campaign_work_items`, never increment the revision, so they cannot
invalidate another reader's cursor. Requests over the bounds in `CAMPAIGN_WORK_LEDGER_LIMITS` are
refused, not truncated.

| Operation | Effect |
| --- | --- |
| `record_campaign_plan {items[], planComplete}` | Idempotent upsert by `key`, at most 100 items per call. Supplied fields replace; omitted fields are unchanged. Dependencies are named by key, within the call or already recorded. It never changes commitment, attempts, or verification. |
| `update_campaign_work_item {workItemId, …}` | Title, issue, dispatch state, queue position, dependencies, commitment, stage, blocker, next action, and `endAttempt {reason: abandoned \| failed}`. `null` clears. |
| `assign_campaign_work_item {workItemId, childSessionId}` | Opens an attempt; closes earlier open attempts as described above. The child must be a descendant of the calling Orchestrator (the same scope `verify_campaign_child` uses) and visible to it. Cancelled or removed items cannot be assigned until recommitted. |
| `verify_campaign_child {…, workItem?: {id, outcome}}` | Existing verification, plus a work-item verification for the child's open attempt on that item. Without `workItem`, no item becomes delivered. |
| `record_campaign_follow_up {…, originWorkItemIds?}` | Existing deduplicated recording, plus origin items. |
| `adjudicate_campaign_recommendation {recommendationId, disposition, reason, resultingWorkItemKey?, resultingIssue?, publicationRequired?}` | Records a disposition. `accepted` creates or links a `follow_up` work item. `duplicate` may link the existing item it duplicates. Re-adjudication replaces the previous disposition; it does not cancel a previously created item, which the Orchestrator does explicitly. |
| `get_campaign_work_items` | The Orchestrator's paginated read of its own campaign: summary, a page or one item's detail, and optionally recommendations. |

None of these operations admits a child, sends a prompt, publishes or closes an issue, merges,
deletes a branch, approves or consumes a workflow decision, or changes a policy, owner, budget,
guardrail, or issue scope. Tests assert that typed gates behave identically with and without
ledger records.

### Storage

The storage slice adds `campaign_work_ledgers` (revision and plan state), `campaign_work_items`,
`campaign_work_item_dependencies`, `campaign_work_attempts`, `campaign_work_verifications`,
`campaign_recommendation_origins`, and `campaign_recommendation_dispositions`
(`apps/control-plane/src/campaign-work-ledger-store.ts`). Partial unique indexes enforce one open
attempt per item and per session. Dependency cycles are refused at write time; the derivation still
treats a cycle or a missing dependency as blocking. The derived-state function lives in
`apps/control-plane/src/campaign-work-state.ts` for the Read API to reuse.

Orchestrator routes, all limited to the matching Orchestrator credential and listed in
`ORCHESTRATOR_API_ROUTES`:

- `POST /api/sessions/:id/orchestrator-campaign/plan`
- `GET /api/sessions/:id/orchestrator-campaign/work-items[?cursor&limit&origin&state&sort&includeRecommendations]`
- `GET /api/sessions/:id/orchestrator-campaign/work-items/:itemId`
- `POST /api/sessions/:id/orchestrator-campaign/work-items/:itemId` (update)
- `POST /api/sessions/:id/orchestrator-campaign/work-items/:itemId/assign`
- `POST /api/sessions/:id/orchestrator-campaign/recommendations/:recommendationId/adjudicate`

The `wollipog campaign plan|update-item|assign|adjudicate|work-items` commands call the same tools.
Recording a follow-up and recording a work-item verification are ledger writes and increment the
revision. Observed changes increment it too, as Observed Invalidation describes. Until cost
attribution lands, the `cost` sort falls back to queue order.

## Read API

- **Summary** (`OrchestratorCampaignProjection.work`, `CampaignWorkSummary`): `revision`,
  `planState`, coverage, committed/delivered/original/follow-up/cancelled/removed counts,
  per-state counts, recommendation counts by disposition, outstanding verification, adjudication,
  publication, and cleanup obligations, campaign `elapsed`, and (slice 6) `cost`. It stays small
  enough to ride on existing session updates. Any ledger write re-sends the root session. Only the
  root's own view carries it: a nested Orchestrator's projection omits `work`, because a reader of
  the nested session may not be allowed the root; that session reads the summary as a member, through
  the root-authorized routes.
- **Plan state**: `not_recorded` until the first `record_campaign_plan`; `partial` while the latest
  plan call said `planComplete: false`; `recorded` after `planComplete: true`. Coverage separately
  counts campaign children that have no attempt on any item and flags campaigns whose history
  predates the ledger.
- **Membership** (`SessionView.campaignMembership`): for a campaign descendant, the root
  `campaignSessionId` and the current work item and attempt, or null. A nested Orchestrator is a
  member of the root campaign; the root itself carries no membership. The current item and attempt
  are the session's open attempt in the root's ledger.
- **Endpoints** (slice 5), where `:id` may be the root or any member:
  - `GET /api/sessions/:id/campaign/summary` returns a `CampaignWorkSummaryResponse`
    (`{campaignSessionId, summary}`).
  - `GET /api/sessions/:id/campaign/work-items?cursor&limit&origin&state&sort` returns a
    `CampaignWorkItemsPage`. The default filter is `unfinished`, the default sort is `queue`
    (queue position, then creation). The cursor is opaque and bound to the filter, sort, and
    revision; a cursor from another revision returns `409 {code: "revision_changed", revision}` and
    the client restarts from the first page.
  - `GET /api/sessions/:id/campaign/work-items/:itemId` returns a `CampaignWorkItemDetailResponse`.
  - `GET /api/sessions/:id/campaign/recommendations?cursor&limit&disposition` returns a
    `CampaignRecommendationsPage`: recommendations awaiting adjudication or publication, and
    accepted, rejected, deferred, and duplicate proposals. The default filter is `all`, ordered
    awaiting adjudication first, then newest first. Cursor and `revision_changed` rules match the
    work-item list.

### Summary Cost

The summary is built inside the root's campaign projection, so it is recomputed on every upsert of
the root. It is therefore cached per campaign under a key made of
the ledger revision and the observed status of every open attempt's session, which together
determine everything the ledger part of the summary derives. Checking the key costs one query plus
one observation per open attempt (bounded by the live-child limit); only a changed key reads the
whole ledger. Coverage and completion are read fresh in a few indexed queries. A campaign with no
ledger row (every campaign from before the ledger, until its first write) has no items or attempts,
so its summary costs one lookup and one follow-up count: all children are untracked, their history
predates the ledger, and earlier follow-ups count as awaiting adjudication or duplicate. Nothing is cached
inside a transaction, because a rolled-back write could otherwise leave a cached summary under a
revision number a later write reuses.

### Observed Invalidation

A work item's state reads the observed status of its open attempt's session, so a child going idle,
failing, being held, archived, or raising a request moves an item without any ledger write. Readers
bind cursors and reloads to the revision, so such a change must produce a new revision. The chosen
mechanism (`apps/control-plane/src/campaign-work-observation.ts`):

- Every session upsert the hub broadcasts is checked with one indexed lookup for an open attempt.
  Sessions without one cost nothing more.
- For an attempt session, the observation (status, archived, held, pending request count) is
  compared with what this process last observed for that attempt. An unchanged observation does
  nothing. An attempt not yet observed by this process counts as changed once, since it may have
  changed after assignment or across a restart.
- Changes are coalesced per campaign for one second: a burst of child status changes costs one
  revision increment and one refresh of the root, the only view that carries the summary.
  Re-sending it does not feed back into another increment.
- Deleting an attempt's session (open or closed) increments the revision in the database itself (a
  trigger on the foreign key's `SET NULL`), whichever deletion path ran, and queues the campaign in
  `campaign_work_deleted_attempt_sessions`. Every session removal the hub broadcasts drains that
  queue, so the root is refreshed even when this process never observed the attempt and the
  deleted session's ancestry is gone.
- A ledger write, or a delivered verification, that opens, closes, or replaces a session's open
  attempt also re-sends that session, whose `campaignMembership` names it.
- Startup settlement stops every mid-flight session without the hub seeing it, so right after it
  every campaign with an open attempt gets one new revision; no cursor from before a restart stays
  valid.
- A campaign that has never recorded ledger state has no revision to move and no cursor to
  invalidate.
- A stored forge fact (slice 8) whose value or availability changes schedules the same coalesced
  revision and root refresh. A read that only renews the observation time moves nothing.

The revision therefore counts ledger writes and observed changes; reads still never move it. The
alternative of leaving observations out of the revision was rejected because a list stitched across
an observed change could show one item in two states.

### Observed Facts in Details

Details observe the **latest** attempt's session, open or closed, so a delivered item still shows
that its child was archived and whether its worktrees were retired. The derived state still reads
only the open attempt.

- **Freshness**: a fact is `fresh` (observed now) while the session's runner is connected, and
  `stale` with the session row's last update time otherwise. A deleted session is
  `unavailable{session_deleted}` for both facts.
- **Session**: status, archived, held (the existing holds), and pending requests (typed workflow
  decisions plus provider requests).
- **Cleanup**: each worktree the session holds, in the existing campaign cleanup vocabulary
  (`pending` with the existing reason, or a recorded `deferred` or `refused`), plus `retired` for a
  worktree the cleanup records name but the session no longer holds. A live session's worktrees read
  `pending` with "the session archive is still pending".
- **Forge facts** (slice 8): `observed.pullRequests`, one fact per pull request the item's reported
  stage names, in that order, or an empty list when it names none. See Forge Status.
- Time and cost fields stay omitted until slice 6.

## Authorization and Cost Visibility

- A human principal needs `canAccessSession(root)` to read the summary, list, or details. A human
  who cannot access `:id` itself receives `404`; one who can access a member but not its root
  receives `403`. A session outside every campaign receives `404`.
- An Orchestrator agent may read and write only its own resolved campaign: the browser routes are
  in `ORCHESTRATOR_API_ROUTES` and refuse with `403` unless the credential's session resolves to the
  same root as `:id`. A nested Orchestrator's campaign is the root. Children and other agents have
  no ledger access (the routes are not in the general agent allowlist).
- The summary on the root's own view follows the same rule wherever that view is served: session
  reads, lists, and live upserts (through `withSessionCommandPermissions`, whose shared-payload key
  includes whether the summary is present), and every other agent-bound API body, such as the view a
  session command returns, through the same response hook that narrows held children. An agent sees
  `work` only when its credential is an Orchestrator resolving to that campaign; every other agent,
  including an ordinary session that is the root's parent, receives the projection without it.
- Cost follows the existing session-cost rule, which is session access. A per-attempt cost is shown
  only when the principal can access that attempt's session (or the session was deleted and the
  principal can access the root). A campaign bucket is `unavailable{not_authorized}` when the
  principal cannot access every session contributing to it.
- **Forge facts** (slice 8) need more than campaign access. They are read through the `gh` login of
  the runner hosting the root campaign, so a human also needs access to that runner
  (`canAccessRunner`); a shared campaign never extends a personal runner owner's GitHub visibility.
  Everyone else receives each fact as `unavailable{not_authorized}`, with no last value, while the
  pull-request references and the reported stage stay visible to every campaign reader. An agent
  reads them only as the campaign's own Orchestrator (the credential rule above). The on-demand
  refresh route follows the same rule and refuses with `403` before any forge read, so a reader who
  may not see the facts cannot cause one. Forge facts are never part of a session view or the
  summary, so no shared hub payload, cached summary, or command response carries them.
- The browser routes apply this rule to whatever cost the ledger carries
  (`apps/control-plane/src/campaign-status-routes.ts`). Until slice 6 fills cost in there is none to
  hide. The summary that rides on the root's session view is broadcast to everyone who can access
  the root, so when slice 6 adds `cost` there it must either keep that cost to buckets every reader
  of the root may see or move it to the summary route; and the `cost` sort must not order by a cost
  the reader cannot see.

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

Queue, Waiting, and Active Time come from durable intervals recorded by slice 6, kept independent
of the event cache:

- **Work-item intervals**: every change of an item's dispatch state, commitment, and open attempt
  is recorded as a per-item interval, so the waits from `planned` to `queued` to the first attempt
  are measurable even though no session exists yet.
- **Session status intervals**: per session, for the time an attempt is open.

Time before interval recording began is `unavailable{history_unavailable}` (or `partial` when only
part of the span is covered), never zero.

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

## Forge Status (Slice 8)

Server-observed review, check, and merge-queue facts for the pull requests a campaign's work items
name. The implementation is `apps/control-plane/src/campaign-forge-observations.ts` (storage,
derivation, refresh) and `apps/runner/src/campaign-forge-status.ts` (the read).

- **Supported forge:** GitHub (github.com) only. A repository that is not a GitHub `owner/name`
  is `unavailable{forge_unsupported}` and is never put in a query.
- **Credentials:** the control plane stores no forge credential and never sees a token. It asks the
  runner hosting the **root campaign session** to read, and that runner runs `gh api graphql
  --hostname github.com` in the root Orchestrator's own repository context (its agent context and
  repository path, as the Orchestrator itself would run `gh`), so the credential is wherever that
  `gh` keeps its login (`gh auth status`; `GH_TOKEN`/`GITHUB_TOKEN` in that environment, or `gh`'s
  own configuration). A root whose repository is not runner-local is `forge_unsupported`.
- **What is read:** only the pull requests named by work items' reported stages
  (`stage.pullRequests`), never a search. For each: state, draft, head SHA, base branch, review
  decision, the check rollup of every check on the head (from GitHub's own rollup state, with
  counts), the rollup of only the checks the base branch requires for that pull request, the
  merge-queue entry (state and position), and the merge commit. One GraphQL call reads a batch of up
  to `refsPerRequest` (16). Only these status fields cross from the runner; a failure crosses as a
  fixed reason, never as `gh` output.
- **Fail closed:** a check counts as passing only on GitHub's known-good results. No required check
  reported is `none` (GitHub's ambiguous "no required checks reported"), never passing. A required
  check that has not reported yet has no entry at all, and branch rulesets are not readable through
  this query, so the required checks seen read `passing` only when GitHub's own `mergeStateStatus`
  is `CLEAN`, `HAS_HOOKS`, or `UNSTABLE` (nothing required is missing); otherwise, including while
  GitHub still computes it, they read `unknown`. A seen failure or pending check is reported as
  such. When more checks exist than one read covers (100) and none of those seen failed, the
  required rollup is `unknown` too.
- **Refresh:** on demand, `POST /api/sessions/:id/campaign/work-items/:itemId/forge-refresh`, which
  the panel sends when an item's details open and every 60 seconds while they stay open; it waits
  at most 20 seconds and returns the item's facts (`CampaignForgeRefreshResponse`). In the
  background, every `backgroundTickMs` (1 minute) the control plane reads the pull requests of
  **unfinished** items whose last successful read is older than `backgroundIntervalMs` (5 minutes),
  oldest first, at most `backgroundRefsPerTick` (32) per pass, skipping a pull request last seen
  merged or closed (on-demand reads still refresh it) and campaigns whose root is archived.
- **Bounds:** one pull request is read at most once per `minIntervalMs` (30 seconds) whoever asks;
  a read already in flight is shared; at most `concurrentRequests` (2) runner requests run at once,
  a bounded queue sits behind them, and past it new reads are dropped (their facts keep aging).
  Reads run off the session-update path: a slow or hung `gh` (30-second runner timeout,
  `requestTimeoutMs` 45 seconds) never delays a session update.
- **Freshness:** each pull request stores its last successful value with its observation time and,
  separately, the latest failure. A fact is `fresh` until it is `staleAfterMs` (10 minutes) old,
  then `stale` with that value and time. The browser applies the same age, so a page that has not
  refetched never shows an old answer as current, and every stale value reads "Last Seen …".
- **Unavailable:** the latest read failed, or nothing can be read. A stored last value travels only
  as `lastValue`/`lastObservedAt` for history; the panel shows its time, never its values.

| Reason | Meaning |
| --- | --- |
| `not_observed` | The runner is reachable but this pull request has not been read yet. |
| `runner_disconnected` | Nothing was ever read and the root's runner is disconnected. |
| `runner_unsupported` | The root's runner predates `campaignForgeStatus` (protocol v198) and is never asked. |
| `forge_cli_missing` | The runner has no `gh` executable. |
| `forge_unauthenticated` | `gh` is not signed in to github.com, or GitHub refused its credentials. |
| `forge_unreachable` | GitHub could not be reached (offline, DNS, proxy, or timeout). |
| `forge_unsupported` | Not a GitHub repository, or the root's repository is not runner-local. |
| `forge_not_found` | The repository or pull request does not exist, or the runner's `gh` login cannot see it. |
| `forge_rate_limited` | GitHub's API rate limit for that login is exhausted. |
| `forge_error` | Any other failure, or an answer that does not validate. |
| `not_authorized` | The reader may read the campaign but not the observing runner (see Authorization). |

A read that never completes (the runner disconnected or timed out mid-request) changes nothing: the
facts keep their last state and age into `stale`. Unavailable and stale data never imply passing,
approved, or merged, and no observed fact changes the primary state: an observed merged pull request
does not make an item delivered.

**Retention:** observations are keyed by the root campaign with `ON DELETE CASCADE` and hold status
data only.

## Compatibility

- Control planes before v196 omit `OrchestratorCampaignProjection.work` and
  `SessionView.campaignMembership`. Clients present that absence as an availability explanation,
  never as an empty or unrecorded plan. A control plane with the Read API always sends `work` on a
  root campaign Orchestrator's own view, with `planState: "not_recorded"` when nothing was recorded,
  and `campaignMembership` on every descendant, nested Orchestrators included.
- The browser needs no separate UI protocol constant: the presence of `work` is the capability
  signal, and the control plane accepts every browser version.
- Optional fields owned by later slices (`cost`, `times`, `attemptCosts`, `observed.pullRequests`)
  mean "not collected here" when omitted.
- Protocol v198 adds `campaign_forge_observe` / `campaign_forge_observe_result` behind the
  `campaignForgeStatus` capability. The control plane never sends it to an older runner; that
  campaign's facts read `unavailable{runner_unsupported}`. An older control plane omits
  `observed.pullRequests`, which the panel shows as "This server does not observe it", and has no
  refresh route.

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
10. **No UI protocol constant**: see Compatibility. Reads never increment the revision.
11. **Capability ordering.** v196 is assigned with the contract, before the operations land. A
    control plane built between the contract and the storage slice advertises v196 without the
    operations, so the runner's ledger tools receive `404` from it. If a release ships in that
    state, the storage slice bumps the version again and moves the capability to it.
12. **Additions requested at contract review**: an item-level `observed.cleanup` fact, a browser
    `campaign/recommendations` page, and per-item work-item intervals as the Queue Time source.
13. **Assignment scope** is the calling Orchestrator's own descendants, matching verification,
    rather than any descendant of the root campaign.
14. **A server-deduplicated recommendation** can only be adjudicated as `duplicate`; the canonical
    recommendation it duplicates carries the decision.
15. **Accepted linkage** may name only a `follow_up` item, and never one that already tracks a
    different issue; an original-scope match is adjudicated as `duplicate`.
16. **Repeated verification** of the same child, report, and outcome on an item's latest attempt
    returns the existing record without a write, so a retried `verify_campaign_child` is a no-op.
17. **Stale cursors** return `409 {error, code: "revision_changed", revision}` on the Orchestrator
    route as well, through the shared refusal body.
18. **Observed changes move the revision** (slice 5), coalesced per campaign; see Observed
    Invalidation. The posted plan said only that ledger writes bump it.
19. **Details observe the latest attempt**, not only an open one, so delivered items keep showing
    their child's archive and cleanup state.
20. **The summary route** returns `{campaignSessionId, summary}` (`CampaignWorkSummaryResponse`), so
    a member's reader learns the root it resolved to.
21. **No new protocol version for slice 5.** The browser detects the Read API by the presence of
    `work` on the projection, and no runner consumes these routes.
22. **Only the root's view carries `work`.** The posted plan put the summary on the projection
    every campaign view embeds; a nested Orchestrator's reader may not be allowed the root, so its
    view omits the summary and reaches it through membership.
23. **Forge facts follow the stage's pull requests** (slice 8). The plan said "PR refs recorded with
    reported stages and work-item links"; the ledger records pull requests only on the reported
    stage, so those are the ones observed.
24. **Forge visibility needs runner access** (slice 8, an implementation decision at claim time):
    campaign access plus access to the runner whose `gh` reads the facts; see Authorization.
25. **Check rollups are objects** (slice 8): `checks` and `requiredChecks` carry a state (`passing`,
    `failing`, `pending`, `none`, `unknown`) and counts, replacing the contract's single `checks`
    string, and the merge-queue state is GitHub's own vocabulary.
26. **More unavailable reasons** (slice 8): `not_authorized`, `not_observed`, `runner_disconnected`,
    `runner_unsupported`, `forge_cli_missing`, `forge_not_found`, and `forge_rate_limited` join the
    contract's forge reasons.
