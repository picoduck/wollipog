# Usage and cost aggregation

The Usage view reports content-free token and cost aggregates for the organization scopes a signed-in human member can currently access. It is designed for fleet accounting and retention planning, not provider billing reconciliation.

## Accounting semantics

- Parentless `token_usage` events contribute input tokens, output tokens, and cost. Subagent usage carrying `parentToolUseId` is excluded so a parent total and its children cannot be charged twice.
- Each record is split into five token buckets: uncached input, cached input, cache creation, output, and reasoning. Reasoning is a subset of output and is never added on top of it. Codex reports input inclusive of the cached portion, so the control plane derives uncached input per driver; Anthropic already reports the uncached part.
- A provider-reported cost is used unchanged and recorded as `providerReported`. When the provider bills opaquely (Codex), the record is priced from the model rate table at ingestion, bucket by bucket, and recorded as `modelPriced`. A model absent from the table, a bare family alias such as `opus`, or a synthetic model leaves the record `unpriced`: its tokens count, its cost is a lower bound, and the bucket's `unpricedRecords` says how many records were affected. A figure that mixes provenance reports the weakest.
- `cacheSavingsUsd` is what cached input would have cost at the full input rate minus what it cost. When a rate entry omits cache prices they are derived from the input rate at the standard ratios (reads at 0.1×, writes at 1.25×).
- Buckets key on the provider-resolved model id when the runner reported one, falling back to the configured model, so a session that switches models attributes later turns to the new model.
- Event cost is accumulated with a sub-micro-USD remainder and persisted to buckets as integer micro-USD. Runner cumulative snapshots reconcile only positive missing residuals.
- `usage_session_state` is the durable replay watermark. Indexed history at or below its `(history epoch, covered sequence)` is a no-op; an uncovered contiguous suffix contributes once.
- The first known runner-history epoch adopts a legacy unknown epoch without discarding its coverage. A later known-to-known epoch change is treated as replacement history and waits for an authoritative cumulative snapshot before charging a residual.
- A snapshot does not identify when an unseen cumulative prefix accrued. Its positive residual is therefore attributed to control-plane observation time instead of fabricating historical precision.
- The upgrade cutover seeds existing lifetime session totals only as watermarks. It creates no historical buckets, so the dashboard explicitly displays its coverage start.

Usage bucket writes, replay-watermark updates, accepted event persistence, and session budget totals share the same SQLite transaction. Aggregate retention never deletes transcripts, audit records, provider state, or session budget totals.

## Authorization and privacy

Every bucket freezes the session's organization and owner scope at observation time. Queries apply organization, current membership, owner scope, and requested dimension filters inside SQLite before aggregation. Owners and admins can see all scopes in their organization; other members see organization-owned rows, their user-owned rows, and rows owned by teams they currently belong to.

Team deletion is blocked while retained usage refers to its ID. This prevents a deleted identifier from being recreated with different members who could inherit the former team's history.

The HTTP surface accepts human principals only. Conductor credentials, including organization-wide conductors, receive `403`. Retention changes require an organization owner or admin.

Stored and returned aggregates deliberately exclude session IDs, prompts, paths, tool inputs, event bodies, environment values, and authentication data. Dimensions are bounded runner, workspace, agent, driver, and model identifiers. Breakdowns return at most 20 named values plus `Other`; time series are capped by the supported retention window. A short-circuiting admission probe bounds matched rows before one materialized SQL pass produces all summaries; queries matching more than 100,000 retained dimensional rows fail with a request to narrow the range or dimensions.

## Retention and query precision

Each organization has independent settings:

- hourly buckets: 1-90 days;
- daily buckets: 30-3650 days, and never shorter than hourly retention.

Maintenance uses the trusted control-plane clock. Runner event timestamps select observation buckets but cannot trigger maintenance or prune another organization's data.

Maintenance transactionally rolls expired UTC hours into UTC days before deleting those hours, then prunes expired daily buckets and advances the advertised coverage frontier. Late hourly observations are added to the existing daily rollup on the next maintenance pass. If retention is later expanded, the service never claims coverage for data that shortening permanently deleted. A query overlapping already-rolled hours automatically returns a complete daily series instead of silently undercounting.

## Cost governance

Three control-plane guardrails read the ledger; none needs runner support.

- **Checkpoints.** `SessionConfig.costCheckpointsUsd` is an ascending list of amounts below the hard budget. When the session's cost first crosses the next unapproved checkpoint the session parks with a `cost_checkpoint` card. Continue records that checkpoint as approved, so it never asks again and the following checkpoint becomes the rule; Stop ends the turn without recording it, so the same checkpoint asks again on the next turn that crosses it.
- **Fail closed on unpriced usage.** A session with a budget or checkpoints whose recorded usage has tokens but no price (no provider cost and no rate) parks with a `cost_unpriced` card instead of comparing the budget against zero forever. Continue acknowledges it for the session.
- **Per-user daily budget.** `PUT /api/usage/daily-budget` (owner or admin) sets one amount per user for the organization; `GET /api/usage/daily-budget` reads it. A user-owned session whose owner has spent that much today, summed from the owner-scoped buckets in UTC days, parks with a `daily_budget` card. Its Continue option re-checks the allowance and clears only once the day rolled over or the budget was raised; Stop ends the turn. `GET /api/usage/users` returns today, 7-day, and 30-day spend per user: every user for owners and admins, only the caller for other members. Organization- and team-owned sessions carry no personal allowance.

Precedence when several rules trip at once: daily budget, unpriced, next checkpoint, budget, tool-call limit.

## Model rate table

The control plane loads per-token rates from a public price list (LiteLLM's `model_prices_and_context_window.json` by default) once a day, caches the document beside the database, and serves the cached copy when a refresh fails. `CONTROL_PLANE_USAGE_PRICING_URL` overrides the source or, set to `off`, disables outbound fetches entirely; `CONTROL_PLANE_USAGE_PRICING_CACHE` overrides the cache path. Every `GET /api/usage` response carries `pricing` with the table's status (`fresh`, `cached`, or `unavailable`), source, fetch time, and known-model count. Rates are applied at ingestion only; recorded buckets are never re-priced.

## API

`GET /api/usage` accepts:

- `days`: a whole number within daily retention;
- `granularity`: `hour` or `day` (hour must fit hourly retention);
- optional `runnerId`, `workspaceId`, `agentId`, and `driver` filters.

The response carries `totals`, `series`, `seriesByDriver` (the same buckets split per driver, for the driver-stacked chart and the Day table), and the `byDriver`, `byAgent`, `byRunner`, and `byModel` breakdowns. Every amount includes the five token buckets, `costUsd`, `cacheSavingsUsd`, `costSource`, `unpricedRecords`, and `processedTokens`.

`processedTokens` is derived per ledger row, where the driver is known, and summed: Codex reports input inclusive of its cache reads, so its rows count input plus cache creation plus output; every other driver counts input plus cached input plus cache creation plus output. Deriving it from summed buckets after the fact cannot tell those shapes apart in a mixed aggregate, so the per-row derivation is what keeps the headline, the driver rows, the chart, and the tables in agreement.

`POST /api/usage/pricing/refresh` refetches the rate table ahead of its TTL (bounded by a one-minute floor) and returns the new `pricing` status.

`PUT /api/usage/retention` accepts integer `hourlyDays` and `dailyDays` values within the bounds above. Shortening retention is destructive only for aggregate buckets; the UI requires confirmation and states which records are unaffected.

The Usage view provides accessible summary terms, a canonical UTC table, bounded dimension breakdowns, coverage and privacy notices, and responsive range/retention controls. Range requests are generation-guarded so a slower earlier response cannot relabel stale totals as a newer period.
