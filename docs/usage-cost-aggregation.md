# Usage and cost aggregation

The Usage view reports content-free token and cost aggregates for the organization scopes a signed-in human member can currently access. It is designed for fleet accounting and retention planning, not provider billing reconciliation.

## Accounting semantics

- Parentless `token_usage` events contribute input tokens, output tokens, and cost. Subagent usage carrying `parentToolUseId` is excluded so a parent total and its children cannot be charged twice.
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

## API

`GET /api/usage` accepts:

- `days`: a whole number within daily retention;
- `granularity`: `hour` or `day` (hour must fit hourly retention);
- optional `runnerId`, `workspaceId`, `agentId`, and `driver` filters.

`PUT /api/usage/retention` accepts integer `hourlyDays` and `dailyDays` values within the bounds above. Shortening retention is destructive only for aggregate buckets; the UI requires confirmation and states which records are unaffected.

The Usage view provides accessible summary terms, a canonical UTC table, bounded dimension breakdowns, coverage and privacy notices, and responsive range/retention controls. Range requests are generation-guarded so a slower earlier response cannot relabel stale totals as a newer period.
