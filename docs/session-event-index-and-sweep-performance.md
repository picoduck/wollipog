# Session Event Index and Sweep Performance

Issue #2776 measured the event indexes and the six frequent sweep families listed in the audit:
outbound events, timed reminders, Stop maintenance (every second), workflow recovery, command and
prompt retry, and background push retry (every five seconds). Their entry queries and supporting
expiration/resume/pruning queries are covered below. Measurements use disposable synthetic
databases; no live database or index is changed by either benchmark.

## Reproduction

From the repository root:

```sh
node --import tsx apps/control-plane/scripts/session-event-index-benchmark.ts
node --import tsx apps/control-plane/scripts/session-event-index-benchmark.ts --disk --dir /tmp
node --import tsx apps/control-plane/scripts/session-event-index-benchmark.ts --legacy-prefix
node --import tsx apps/control-plane/scripts/session-event-index-benchmark.ts --legacy-prefix --disk --dir /tmp
node --import tsx apps/control-plane/scripts/maintenance-sweep-benchmark.ts --memory
node --import tsx apps/control-plane/scripts/maintenance-sweep-benchmark.ts --dir /tmp
node --import tsx --test apps/control-plane/src/maintenance-indexes.test.ts
node --import tsx --test apps/control-plane/src/session-event-index-migration.test.ts apps/control-plane/src/session-tool-call-counter.test.ts
```

Each command prints JSON with exact index definitions or sweep SQL, parameters, query plans and
timings. The index benchmark defaults to five repetitions (`--repeats 1` gives a shorter smoke
run). By default it measures the seven retained event indexes. `--legacy-prefix` adds the retired
short prefix only to the disposable clone, reproducing the original eight-index comparison below.
All/none/each omitted/each alone configurations rotate order between repetitions. JSON
payloads and SQL statements are prepared outside insert timing; each sample warms up 400 inserts
and measures 2,000. Small payloads contain 128 bytes of text; large ones contain 40,960 bytes, plus
their JSON envelope. The mix is one quarter each agent message, tool call, tool update, and user
message, with structured agent spawns and parent tool IDs included. Existing history is 200,000
events across 2,000 session keys.

The event-only clone deliberately excludes FTS, counter triggers, serialization, artifact staging
and other `appendEvent` projection work. It measures index maintenance, not end-to-end ingest.
In memory, one transaction per sample isolates CPU work. On disk, WAL/NORMAL autocommits use the
default 1,000-page automatic checkpoint, without the production checkpoint worker. Setup, index
creation, cleanup and checkpoints before each sample are outside timing. `secure_delete` is ON
in every configuration. Choose a directory on the intended storage device; tmpfs hides disk costs.
Neither benchmark accepts an existing database path.

The sweep fixture has 200,000 real event rows, 2,000 session rows and 20,000 rows in each relevant
history table (2,000 Stop intents; 19,980 outbound deliveries). Sparse eligible and deferred cases
include due/expired commands, reminders and push retries, plus 20 orphan events, 20 expired
outbound leases, 20 old terminal deliveries, future retries and unexpired leases. Foreign-key
enforcement is disabled while generating synthetic maintenance references, then enabled for
measurement; correctness/upgrade tests use valid references throughout. The fixture captures SQL and arguments from actual DB
methods with empty results, then runs `EXPLAIN QUERY PLAN` and seven timed executions of each
statement in rolled-back transactions. It does not dispatch network deliveries. This records the
queries selected by the methods rather than duplicating their SQL in the plan tests.

## Event Index Measurements

Measured before implementation on Node 24.18.1, AMD Ryzen 9 7900X3D, local disk under concurrent
host load. Values are median per-repetition p50 in microseconds; they are diagnostic measurements,
not production latency guarantees. The disk run's large-payload p95 varied by milliseconds with
checkpoint/cache-spill and host I/O, so it cannot rank small differences reliably.

| Configuration | Small, Memory | 40 KiB, Memory | Small, Disk | 40 KiB, Disk |
| --- | ---: | ---: | ---: | ---: |
| All Eight Indexes | 7.99 | 54.83 | 41.80 | 135.34 |
| No Indexes | 1.67 | 23.48 | 16.36 | 85.67 |
| Without `agent_spawn_id` | 8.01 | 53.13 | 41.43 | 135.37 |
| Without `parent_tool_use_id` | 8.03 | 49.48 | 40.26 | 130.77 |
| Without `runner_seq` | 6.17 | 51.53 | 33.51 | 127.43 |
| Without `session` | 6.31 | 51.86 | 33.64 | 129.55 |
| Without `tool_call` | 7.73 | 53.92 | 38.59 | 135.03 |
| Without `tool_call_id` | 7.70 | 54.43 | 38.73 | 131.43 |
| Without `tool_update_id` | 7.42 | 51.39 | 39.41 | 132.46 |
| Without `turn_start` | 7.10 | 50.93 | 38.70 | 133.14 |
| Only `agent_spawn_id` | 1.85 | 25.43 | 16.84 | 89.51 |
| Only `parent_tool_use_id` | 2.20 | 41.37 | 17.27 | 107.38 |
| Only `runner_seq` | 3.16 | 25.85 | 22.59 | 92.95 |
| Only `session` | 3.10 | 25.08 | 22.46 | 92.80 |
| Only `tool_call` | 1.83 | 25.85 | 17.35 | 91.38 |
| Only `tool_call_id` | 1.83 | 25.12 | 17.03 | 91.39 |
| Only `tool_update_id` | 1.81 | 24.73 | 16.75 | 90.94 |
| Only `turn_start` | 1.79 | 25.04 | 17.11 | 91.53 |

All names above have the `idx_session_events_` prefix. These are the original eight-index baseline
measurements. The seven distinct access paths remain; only the redundant `tool_call` prefix is retired.
The unique runner-sequence index enforces replay idempotency; the others support event ordering,
turn starts, counter probes and child/attention projections. The parent-tool-use predicate adds
JSON work to all event kinds, but child-event queries explicitly depend on that index. Its raw
cost does not justify deleting a required access path.

The `tool_call` index is a prefix of `tool_call_id` with the same partial predicate. A supplemental
tool-call-only CPU experiment (seven trials in alternating order, 200,000 existing calls, 1,000
warmup and 4,000 measured inserts) found p50 9.61→7.55 microseconds small and 53.57→48.36 large when
omitting the prefix. Counter probes, distinct-ID reads and ordered sequence reads kept indexed
plans and identical results through the wider index. No production query pins the shorter prefix.

A second experiment exercised the real `appendEvent` API, including its counter triggers, FTS and
other projections, with foreign keys and `secure_delete` ON. It used 200,000 mixed historical events
across 2,000 real synthetic sessions, five alternating retained/omitted trials per mode, prepared
128-byte/40,960-byte text payloads, 200 warmup and 800 measured inserts, and one quarter each of the
four event kinds. Disk mode used production WAL/checkpoint behavior. Counter values for 1,000
sessions were independently checked against `COUNT(DISTINCT)` after each sample; ordered caller
results and foreign-key integrity matched in both configurations.

| Actual Append Workload | Median Trial p50, Retained → Omitted, µs |
| --- | ---: |
| Memory, Small | 39.15 → 33.85 |
| Memory, 40 KiB | 151.29 → 165.10 |
| Disk, Small | 122.94 → 93.18 |
| Disk, 40 KiB | 323.81 → 263.34 |

Small disk p50 improved in all five paired trials (3.71–41.94 µs), and small memory in four of five.
Both large workloads improved in only two of five paired trials. Cache, FTS, checkpoint and host
load confound the large medians; they do **not** demonstrate a reliable large mixed end-to-end
gain. Removal is justified by the identical prefix/predicate, preserved plans and results, isolated
tool-call CPU savings and repeatable small-workload benefit. It is not a universal ingest speedup.

## Redundant Prefix Migration

Schema initialization creates `idx_session_events_tool_call_id` before the legacy prefix is dropped.
The `DROP INDEX IF EXISTS idx_session_events_tool_call` runs in the existing `BEGIN IMMEDIATE`
counter-install transaction. A pre-counter database backfills through the wider equivalent index;
an existing counter is retained without recounting. Failure rolls back the DROP and counter changes,
allowing a healthy retry. Later opens do not recreate the prefix. All seven other event index
definitions, runner-sequence uniqueness and `secure_delete=ON` are preserved.

`session-event-index-migration.test.ts` constructs persisted legacy files directly through raw
SQLite before their first current-code open, covering both absence and presence of the wider index.
It checks old history/backfill, installed counters, repeated reopen without recounting, failed-startup
rollback/retry, distinct/duplicate/null/numeric IDs, row updates/deletes, transaction rollback and
session cascades. The existing generated counter-operation suite runs against the retained indexes.

The 200,000-event/2,000-session compatibility fixture captures SQL from the actual child caller
methods, installed counter-trigger subqueries and real first-open backfill. Exact results and order
match with and without the legacy prefix. Counter probes, backfill and distinct-count reads use
`idx_session_events_tool_call_id`; SQLite VM checks verify these counter queries do not fetch event
table columns even where SQLite omits the expression index's COVERING label. Child candidate and
projection queries retain their existing agent-spawn/tool-call/tool-update/parent-tool-use indexes.
Index scans of the eligible tool-call set for one-time backfill remain; no retained-table scan is
introduced into the per-insert probes.

## Sweep Plans and Timings

The additive sweep upgrade adds eight indexes on maintenance tables. Its separately measured
event-index migration retires only the redundant prefix described above.
The initial measurements preceded implementation. Review identified empty eligible sets in three
outbound scenarios, so the fixture was strengthened and the final baseline/installed comparison
below uses that same nonempty synthetic workload in memory, with seven rolled-back samples.
The baseline uses the original commit's DB methods; the installed run uses the actual migration.

| Query | Baseline → Installed, ms | Installed Plan |
| --- | ---: | --- |
| Workflow Deadlines | 0.949 → 0.017 | `deadline_active` range, no sort |
| Timed Reminders | 0.025 → 0.025 | `reminders_due` range plus session PK |
| Pending Stops | 0.058 → 0.003 | Eligible `stop_intents_pending` index |
| Due Command Runners / Batches | 0.008 / 0.024 → 0.007 / 0.024 | Due-time range / runner-state range |
| Command Expiration IDs | 3.483 → 0.010 | Covering state/expiry range |
| Command Expiration Updates | 1.072 / 1.466 → 0.057 / 0.180 | State/expiry range |
| Prompt Retry | 0.056 → 0.055 | Due range plus session PK |
| Prompt Expiration | 0.116 → 0.087 | Active expiry range |
| Prompt Terminal Pruning | 3.858 → 0.349 | Terminal expiry range, indexed continuation probes |
| Held / Settled Resume and Restart Notices | 0.000–0.006 → 0.000–0.006 | Compact partial indexes plus PK joins |
| Campaign Discovery | 0.189 → 0.182 | Parent-session index |
| Background Push Expiration / Retry | 0.047 / 0.027 → 0.047 / 0.027 | Active partial index / due range |
| Outbound Lease Recovery | 0.607 → 0.089 | Delivering-only lease range |
| Outbound Retry | 1.539 → 0.040 | Due range then subscription PK, ordered and limited |
| Outbound Delivery Retention | 1.497 → 0.088 | Terminal updated-at range |
| Outbound Orphan Cleanup | 3.860 → 0.049 | Event PKs from maintained orphan set |

The plan test rejects scans of retained tables. `SCAN ... USING INDEX` remains intentional for
small partial indexes whose entire eligible set must be visited (held resumes, pending Stops and
active push expiration). No retained-history table scan is needed. Some due queries still sort
their eligible rows to preserve existing ordering; they do not sort retained terminal history.
These additions do not promise constant cost when the amount of eligible work itself grows.

Adding an index can also change other query plans. A supplemental fixture with 20,000 active
commands distributed over 20 runners (20 due commands per runner) exposed an introduced planner
regression: the new expiration index was chosen for each runner's retry batch, examining active
commands from every runner. Its p50 was 2.74 ms versus 0.17 ms before that index. Pinning the
existing runner/state outbox index restores 0.18 ms and the same ordered results. Global due-runner
discovery now uses the existing due-time index: 0.07 ms versus 2.74 ms through the new expiration
index (3.23 ms before it). Expiration keeps its new matching index. The large-fixture test guards
these distinct access paths and verifies both per-runner ordering and the complete due-runner set.

## Migration and Write Cost

`installMaintenanceIndexes` runs after older column migrations. Index creation, orphan-table and
trigger installation, and the initial orphan anti-join backfill commit in one transaction. The
projection table's existence marks completion, so later opens do not scan outbound history again.
An interrupted upgrade rolls back all of this and can retry safely.

An event insert initially adds its ID to `outbound_event_orphans`; a delivery insert removes it.
Deleting or moving the last delivery restores the old event ID only if the event still exists.
This keeps event/session cascades from recreating a dangling reference; deleting a subscription
correctly makes its now-unreferenced events eligible. Status-only delivery updates do not run the
event-ID trigger. The projection and normal retention deletes are atomic with compaction. Retry
keeps the existing next-attempt, creation-time and delivery-ID order, capacity limit, subscription
filters and lease recovery semantics.

A seven-repetition event-plus-delivery insert check measured the candidate indexes/triggers at
128-byte and 16-KiB payloads, with 400 warmup and 1,600 measured inserts in rolled-back transactions.
In-memory median p50 was 10.36/22.07→19.24/31.09 microseconds, about 9 microseconds of extra CPU work
per outbound event plus delivery. Disk medians were 9.83/32.56→80.38/134.77 microseconds under
concurrent I/O; that variance reinforces the separation of CPU and disk measurements. None of
these triggers or indexes is on `session_events`.

The installed migration was also checked through the real `recordOutboundPullRequestOpened`
method with valid references and foreign keys ON: seven rolled-back trials of 400 warmup and
1,600 timed calls, settling each generated delivery outside the timed call so the outbox limit
does not change the workload. Median p50 was 357.95→389.55 microseconds, p95 623.04→810.00. This
includes subscription/session lookups, envelope serialization and queue bookkeeping; it is
distinct from the isolated insert measurement above. Event index definitions and secure-delete
settings were identical before and after installing the migration.

Correctness coverage includes nonempty orphan sets, multiple deliveries, reassignment, rollback,
replacement, session/subscription/event cascades, legacy content preservation, replay uniqueness,
one-time backfill, repeated reopen and interrupted migration. `secure_delete` remains ON.
