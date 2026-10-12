# Campaign Limits

A human can establish an optional `control.boundary.budgetAuthority` for Full Control. It composes
with issue authority and evidence authority; it grants no filesystem, shell, network, integration,
scope, publication or review permission. Custom campaigns without a grant retain their existing
session limits. The foundation's authenticated owner, repository scope, policy revision CAS and
revocation checks apply. Only that authenticated human can change the envelope. Agent config,
ordinary prompts, defaults, replacements and restarts cannot mint it or erase its usage.

Protocol v217 supports optional cost, distinct tool-call, campaign-wide live descendant concurrency,
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
view with its billing provenance.

Outstanding allocations are the unspent portion of active workers' cumulative ceilings. Actual
usage plus outstanding reservations must fit the envelope. Admission and session insertion share
one SQLite transaction, so competing dispatches cannot reserve the same capacity. Deletion never
removes accounting rows. Terminal settlement releases unspent capacity, but late reported spend
continues raising the recorded charge. A Stop remains outstanding until the runner confirms
terminal or absent state; sending a cancellation frame alone does not release capacity.

`allocate_campaign_budget` (CLI `campaign allocate --input '<json>'`) changes an existing managed
worker's absolute cumulative limits, for example `{"sessionId":"s_worker","costUsd":12,"toolCalls":300}`.
The exact authenticated Orchestrator must resolve to the same root and be allowed to read the
worker. This operation cannot enlarge the immutable envelope, exceed an original tighter session
ceiling or reduce already spent usage. It needs no additional human confirmation. Live reservations
cannot be reduced until cancellation/completion settles; redistributing them sooner would reuse
capacity held by a provider with asynchronous configuration delivery. Failed delivery retains its
reservation conservatively. Reconnect reuses durable allocations rather than minting a new lease.

Accepting a unique follow-up work item consumes one durable count in the same transaction as the
ledger disposition. Duplicate acceptance is idempotent. Rejection, deletion or later cancellation
does not refund accepted work, and preexisting follow-ups count when the human establishes limits.
Publishing and admitting follow-up work still require their own authority contracts and gates.

## Unsupported Accounting and Overshoot

Only managed Claude Code and Codex App Server workers can enter a protected campaign. Codex cost
protection requires an available rate for the exact selected model. Native TUI, adopted/unmetered
launches, Codex Exec and external reviewer subprocesses are unsupported. Mixed priced and unpriced
records stop further protected admission, rather than displaying unknown cost as zero. An
exhausted, revoked or accounting-unavailable envelope cannot be reset by toggling mode or restart.

Production reviewer adapters call `SessionsService.campaignBudgetWorkerPreflight(campaignId, worker)`.
`{kind:"managed",sessionId}` must identify an already admitted same-root worker with available
allowance. `{kind:"external"}` always refuses with an explicit unsupported-readiness explanation.
A manual cross-model review launched by a shell is **not** trustworthy aggregate accounting and
must never be used as proof that a bounded production path is unattended-ready. This API does
not intercept arbitrary shell subprocesses or turn their cost into managed usage; such launches
are outside the supported protected-worker contract. Provider child usage already included in a
parent total is not billed twice; independently reported managed sessions count separately.

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
