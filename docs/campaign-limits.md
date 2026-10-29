# Campaign Limits

A human can establish an optional `control.boundary.budgetAuthority` for Full Control. It composes
with issue authority and evidence authority; it grants no filesystem, shell, network, integration,
scope, publication or review permission. Custom campaigns without a grant retain their existing
session limits. The foundation's authenticated owner, repository scope, policy revision CAS and
revocation checks apply. Only that authenticated human can change the envelope. Agent config,
ordinary prompts, defaults, replacements and restarts cannot mint it or erase its usage.

Protocol v218 supports optional cost, distinct tool-call, campaign-wide live descendant concurrency,
and accepted follow-up ceilings. Human Required rules and tighter user/session/organization limits
remain in force. Checkpoint amounts within a cost envelope are preauthorized notifications in the
projection; they do not produce repeated permission requests or authorize additional spending.
The preceding issue-authority contract is integrated before this feature is delivered on main.

## Durable Allocation and Accounting

`campaign_budgets`, `campaign_budget_members`, `campaign_budget_tool_calls`, and `campaign_budget_follow_ups` are a root-keyed
durable ledger. Root coordination, managed implementation/review workers, nested descendants,
replacement attempts and accepted follow-ups share it. Each session contributes its own monotonic
usage peak once. The recursive parent reservation charge is never added to that spend. Tool-call
identities are retained across history replacement, so replay is deduplicated and new calls still
consume allowance. Incomplete preauthorization tool history refuses protection. Transcript replacement or deletion cannot refund
previously observed peaks; this deliberately retains a conservative charge if history is lost or
cost is corrected downward. The UI calls it recorded spend, separate from the normal priced-cost
view with its billing provenance. A running Claude turn's open live estimate is added to its
worker's peak without being recorded, so the allowance, allocations and admission see a long turn
mid-turn, and settlement replaces the estimate with the provider total (#3196, see
`docs/usage-cost-aggregation.md`). Campaign Status says when recorded spend includes an estimate.

Outstanding allocations are the unspent portion of active workers' cumulative ceilings. Actual
usage plus outstanding reservations must fit the envelope. Admission and session insertion share
one SQLite transaction, so competing dispatches cannot reserve the same capacity. Deletion never
removes accounting rows. Terminal status and absent inventory do not release reservations. A
generation-bound runner checkpoint must cover durable final history and priced usage first;
usage, a completed receipt and reservation release commit together. Replay cannot release a
replacement's allocation. A cancellation without complete final usage retains its reservation.
The runner reports that checkpoint in its local history coordinates, and the control plane matches
it against the wire-projected history it hydrated.

A concurrency slot is separate from a reservation (#2940). A worker holds a slot until its provider
has retired. A terminal status alone is not proof: a runner reports a Stop as soon as it begins
closing the provider. The runner sends its final checkpoint only after retirement, so that
checkpoint, or a reconnect inventory without the session, releases the slot after a Stop,
verification with Stop and Archive, archival or provider exit, without reloading history and even
when its final usage has not settled yet. A pending, provisional or unretired stop keeps the slot.
Its unspent reservation stays outstanding until its usage settles. Every campaign read settles ended workers whose hydrated history covers
their checkpoint, so a campaign that held slots or reservations for already-ended workers is
repaired on its next read or startup without changing its allowance.

`allocate_campaign_budget` (CLI `campaign allocate --input '<json>'`) changes an existing managed
worker's absolute cumulative limits, for example `{"sessionId":"s_worker","costUsd":12,"toolCalls":300}`.
The exact authenticated Orchestrator must resolve to the same root and be allowed to read the
worker. This operation cannot enlarge the immutable envelope, exceed an original tighter session
ceiling or reduce already spent usage. It needs no additional human confirmation. Live reservations
cannot be reduced until cancellation/completion settles; redistributing them sooner would reuse
capacity held by a provider with asynchronous configuration delivery. Failed delivery retains its
reservation conservatively. Reconnect reuses durable allocations rather than minting a new lease.
Registration redelivers the existing generation and absolute limits, including to terminal workers
whose first allocation was missed. Terminal delivery returns final evidence without resuming a
recovery queue. A definitively unsent restart restores the prior generation and pending checkpoint;
an ambiguous or accepted dispatch keeps its new generation fenced.

Accepting a unique follow-up work item consumes one durable count in the same transaction as the
ledger disposition. Duplicate acceptance is idempotent. Rejection, deletion or later cancellation
does not refund accepted work, and preexisting follow-ups count when the human establishes limits.
Publishing and admitting follow-up work still require their own authority contracts and gates.

## Unsupported Accounting and Overshoot

Only managed Claude Code and Codex App Server workers can enter a protected campaign. Session cost
protection requires an available rate for the exact selected model. Native TUI, adopted/unmetered
launches, Codex Exec and unadmitted external reviewer subprocesses are unsupported. Under a cost
ceiling, mixed priced and unpriced records stop further protected admission, rather than displaying
unknown cost as zero. Without a cost ceiling (#2940) unpriced usage, live or settled, stops nothing:
the campaign keeps counting tool calls, any tool-call ceiling stays enforced, final usage settles at
its recorded cost, and the projection reports `costAccounting: "unavailable"`. That availability is
durable: the campaign records the first unpriced record, settled or live, and never clears it, so
deleting an unpriced member cannot make the total read as priced. Controlled and media
review jobs keep refusing unpriced settlement, because each reserves its own cost bound. Cost
checkpoints need a cost ceiling; a launch naming checkpoints without one is refused. An
exhausted, revoked or accounting-unavailable envelope cannot be reset by toggling mode or restart.

Production reviewer adapters call `SessionsService.campaignBudgetWorkerPreflight(campaignId, worker)`.
`{kind:"managed",sessionId}` must identify an already admitted same-root worker with available
allowance. `{kind:"external"}` always refuses with an explicit unsupported-readiness explanation.
A manual cross-model review launched by a shell is **not** trustworthy aggregate accounting and
must never be used as proof that a bounded production path is unattended-ready. This API does
not intercept arbitrary shell subprocesses or turn their cost into managed usage; such launches
are outside the supported protected-worker contract. Provider child usage already included in a
parent total is not billed twice; independently reported managed sessions count separately.

## Review Sessions and Historical Review Jobs

Campaign members use `request_review_session` (`wollipog review session run`) for their own
pushed PR. Admission reserves campaign allowance and actual managed Session usage settles against
it, including unsuccessful attempts. The reviewer's exact harness/model/effort, read-only snapshot
and round/attempt limits remain enforced. Review approval grants no human approval, merge authority
or passing checks. Optional review-session citations at merge gates are verified by the server.

Protocol 246 retires the older bridge and campaign review job tools, CLI commands and native
executors. Follow the [upgrade order](./agent-control.md#retired-review-jobs): drain with the prior
runner, upgrade the control plane, then upgrade the runner. New runners explicitly refuse older
control planes and unfinished or unverified legacy execution. Drained terminal unpriced receipts
permit upgrade and replay unchanged; they retain unknown costs and reservations. Reconnect never redispatches a legacy
job. Cancellation does not refund possible launched usage.

Historical campaign job ledgers, immutable dispatch-owner daily costs, receipts and archive reads
remain. Only authenticated owning-runner updates can settle them; duplicate receipts cannot charge
again, and old charges survive root/worker deletion. Missing or unpriced usage remains unavailable
with its reservation retained. No agent supplies a cost JSON assertion or repairs accounting by
deleting state. A human must replace an obsolete `budgetAuthority.controlledReview` boundary;
retirement grants no new authority, profile, budget, sign-in or provider access.

The removed executors make extra unsandboxed admission-context recording for legacy jobs moot.
Current review sessions retain their own admission and usage evidence.

Managed evidence workers retain the active preflight snapshot (including dispatch generation).
After normal terminal usage settlement, `campaignBudgets.completedAttestation(sessionId)` returns
an immutable server receipt/digest for historical quality proof. It grants no new admission,
media access, verdict submission or owner resolution. Current owner, boundary, source, scope,
expiry, revocation and applicable action allowance must still be checked separately.

Reaching an allocation stops its worker without repeatedly asking to continue. Reaching an
aggregate ceiling, losing pricing, or revoking the grant stops protected participants and reports
incomplete work. Admission resumes only where existing authorized allowance remains and the
worker has a valid reservation. Session guardrails and organization daily limits may stop it sooner.

These are admission limits with best-effort cancellation, **not a hard monetary cap**. Provider
usage arrives after work has begun; cancellation and reconnect take time, in-flight requests may
finish, and token-rate estimates may differ from the final invoice. Previously admitted work can
overshoot. Nothing here can guarantee cancellation of an unmetered external process.

## Diagnostics

Campaign Status distinguishes Campaign Allowance, Session Limits, Recorded Campaign Spend,
Outstanding Allocations and Unallocated Allowance. `get_campaign` returns the same budget view
and accounting policy. Cost-bearing budget details are omitted when the root's audience cannot
read every contributing worker, preserving existing cost visibility.

Structured events `campaign_budget_allocation` and `campaign_budget_admission_stopped` identify
the campaign root and worker. To investigate an incomplete campaign, read `budget.state` and
`budget.reason`, then compare recorded spend, outstanding capacity and the worker's allocation.
Do not raise an envelope from an agent or acknowledge unpriced usage as zero.
