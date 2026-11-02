# Node Critical-Path Measurement: November 2, 2026

Refs #3627. Implementation PR #3643 merged as
`85044bee2a50e1d817d6886f3fb632f21d5c9c8b`.
This expanded census supersedes the original four-window sample. It covers all
identified natural runs created in the half-open UTC window
**[2026-10-24T04:01:00Z, 2026-11-02T12:00:00Z)**, rather than extrapolating
from the short sample. Collection completed at 2026-11-02T16:15:02.626Z.

## Collection and Completeness

| Event | First Attempts | Pass/Fail/Cancel/Skip/Unfinished/Unknown | Complete Consumption | Rerun Attempts |
| --- | ---: | --- | ---: | ---: |
| pull_request | 639 | 291/44/225/79/0/0 | 338/639 | 38 |
| merge_group | 315 | 236/30/49/0/0/0 | 280/315 | 2 |
| rolling | 221 | 147/16/58/0/0/0 | 168/221 | 1 |
| push | 11 | 7/1/3/0/0/0 | 11/11 | 0 |

The [content-safe source projection](ci-node-measurement-2026-11-02.json)
retains every attempt identity, event/outcome, API SHA, window, job IDs,
Node job/step durations, complete and measured runner-minutes, missing timing,
and non-PR CI workflow blobs. It contains no logs, user content, titles,
runner identities, inputs or artifacts. Rolling targets parsed from the fixed
run-name format are labelled as such; dispatch SHA alone is not checkout proof.

Natural traffic only: no workflow was dispatched, rerun, cancelled or configured
to collect evidence. First attempts and reruns are separate. Cancelled, skipped,
unfinished and unmeasured work are distinct. Rerun consumption is unmeasured
because copied successful jobs cannot establish rerun resource use. Complete
consumption excludes any attempt with missing job timing. Measured partial work
remains a lower bound, never zero consumption or successful full coverage.
Admission uses the run listing's original creation time (`runCreatedAt`);
`createdAt` retains the exact attempt API's timestamp. Reruns are observed
as of collection, including run 41438869407 attempt 2 created at 12:23:28 UTC
on November 2, after the run-creation window ends. It is not included in any
first-attempt latency or consumption comparison.
Seven rolling first attempts are forge-successful but have no Node jobs:
40268865346, 40616573048, 40723156892, 41024948634, 41226152624,
41243655578 and 41287638686. They executed only admission/control work and
are excluded from passing-validation timing tables, while their forge outcomes
and observed control-job consumption remain in the census. No full-coverage
success is inferred. Passing-validation rows require the complete expected
Node inventory (one job or three shards) and successful Unit Tests steps.

Collection used existing `listRuns`, `listJobs` and `attemptRecord` from
`scripts/merge-queue-wait-report.mjs`, with `cachedApi` from
`scripts/ci-runner-occupancy.mjs`. The requested range was split into contiguous
24-hour listing windows, followed by local half-open filtering and run-ID
deduplication. CI listings separately selected PR, group and historical push;
push was restricted to main. Rolling listings selected
`main-rolling-validation.yml`, `workflow_dispatch`, branch main. Pagination
was bounded to ten pages of 100 per listing and ten attempts per run. No listing
or attempt bound was reached. Exact per-attempt jobs were paginated; all job
listing truncation flags are retained in the projection.

Completed responses were cached on disk. A timeout resumed from cache. Later
GitHub returned HTTP 403 with job-response headers showing 5,000 used, zero
remaining at 15:32:12 UTC, despite the separate rate-limit endpoint reporting
remaining allowance. Reads stopped until its 15:58:49 reset. The resumed collector
serialized network reads, waited 500ms between them and checked every response's
quota headers, stopping below a 1,500-request reserve (stricter than 1,000).
No alternative credentials or settings were used. The final resumed pass made
101 data API calls and reused 42 cached responses,
in addition to checkpointed attempts. Quota checks are not in those counters;
these are pass-level statistics, not the total request cost of failed/resumed collection.

## Comparison Boundaries

Times below are forge merge times, not author/committer timestamps. Each creates
a separate landing-era cohort in the tables and source projection. Merge-group
and rolling timing tables additionally use the exact `ci.yml` blob at the run's
API SHA, read from local Git where available and otherwise bounded Contents API
reads (316 distinct source SHAs). This prevents integration heads testing queued
changes before landing from being assigned an old workflow solely by date.
PR API SHA is its head, not the tested merge revision; its table is explicitly
a time stratification with observed job shape, not exact workflow equivalence.

| Boundary (UTC) | Commit | Effect |
| --- | --- | --- |
| Oct 24 02:50:17, before window | f6865fdf83db979eef6c7598e0112c04fd32deba (#3650/#3649) | Browser apt-package cache; changes total resource/setup comparison, not Node decoder setup |
| Oct 24 15:10:55 | 11de60a49e1fb14462cdeff25a8053303b6469de (#3652) | Advisory selection; Node scheduling entry point retained |
| Oct 24 16:29:27 | 074da66e914728cc51490b0b21928bd1246e6153 (#3656) | PR routing/dependencies, full groups retained |
| Oct 24 21:59:24 | 6df9e76966d9740c1582d2b5d280190e455873ba (#3657) | Pending rolling-worker behavior and competing demand |
| Oct 25 18:13:40 | aeca0addbbb154ddfdab8565f0169e0a0d8a1da5 (#3666) | Explicit rolling health wake/control overhead |
| Oct 25 20:12:13 | b0b1313e420df3f537c4abf5a080ff978f6b65f6 (#3668) | Retires main-push CI; rolling workers become main evidence |
| Oct 26 15:24:35 | 5f6743109ea487503f08a701c10714c7b702b937 (#3677) | Disabled regression-admission advisory |
| Oct 28 11:19:16 | 1928fa43ae106535c0329125fa432773372d10e8 (#3746) | Disabled fast-group gate/dependency, full coverage retained |
| Oct 29 04:43:00 | 32b0b9728cea5ce8ad5d48096b11764e747edc75 (#3745) | Adds delegated recovery job; more total runner work |
| Oct 30 22:58:06 | a31add655643876c93487957dc0be552f9b9b811 (#3850) | Codex nested-sandbox fallback and added tests; no ci.yml change |
| Oct 31 03:13:56 | 7ec02432e4819da7436bf065b75f8c35452828bf (#3866/#3770) | Three full Node shards; separate typecheck/bundles, explicit step budgets |
| Nov 2 07:36:49 | e8f167b674e4b9a39e1fddfe65334dfdc9142628 (#3996) | Packaged runner verification adds bundle work; typecheck job budget 35→38min |

The bubblewrap configuration script last changed at
`9d74b0e378b56eb291e47f678100471bc3ac8412` (#3211, October 14),
before this window. Its bytes did not change during the census. Sharding moved
the same decoder/bubblewrap installation and verification into each Node shard;
this duplicates setup and changes resource totals. The later sandbox fallback
changes test workload and is split by landing time even though CI's blob did
not change. The unchanged .nvmrc selects Node major 24, not a fixed minor/patch;
engine updates are another confounder. Test count,
application code, dependencies and isolated-file startup still evolve within
each configuration cohort. A shared workflow blob is not an identical suite.

All post-implementation group configurations are post-#3650 cache, whereas the
October 22 baseline and October 23 profile predate it. There is no pre-cache
post-merge group cohort in the requested window. Browser install/cache effects
must not be attributed to Node scheduling. PR branches can retain older workflow
snapshots. No hit/miss inference or setup speedup is made from creation time.

## AC 3: Natural Execution, Wait and Resource Comparison

Minutes are elapsed, not billed. Each cell is **p50/p90 (measured n)** using
the existing report's nearest-rank quantile. For the combined job, execution
is `Typecheck, Unit Tests & Bundles`; after sharding it is the maximum of
observed Node shard execution times per run. Step and wait similarly use
within-run maximums, not a sum or an end-to-end critical-path latency. Shard
queues need not overlap; adding these independent maxima is invalid. Runner
minutes sum all measured jobs; complete totals include advisory/control jobs.
The complete all-outcome counts above disclose selection loss before the
**passing-only** comparison tables below. Cancelled near-limit observations
are censored work, not fast successful executions.

| Reference | Node Job Execution | Unit Tests Step | Node Wait | All-Job Runner-Minutes |
| --- | --- | --- | --- | --- |
| Baseline 75 groups, all outcomes | 26.8/29.2 (73) | 23.7/25.7 (73) | 0.3/18.6 | 173.0/185.3 (73) |
| Baseline 65 passing groups | See original baseline | See original baseline | See original baseline | 172.983/184.500 (65) |
| Oct 23 single passing profile group | 30.267 (1) | 26.517 (1) | 0.033 (1) | 187.717 (1) |

Reference sources: [October 22 baseline](ci-baseline-2026-10-22.md) and
its JSON, window [2026-10-20T00:00:00Z, 2026-10-22T00:00:00Z);
[October 23 profile](ci-node-profile-2026-10-23.json), run 39896139030,
attempt 1, job 120226938449, window
[2026-10-23T03:39:00Z, 2026-10-23T03:40:00Z).

### Exact Workflow Configuration: Groups and Rolling Workers

Configuration labels are the main commit introducing the matching ci.yml blob,
not the tested suite SHA. The two custom-source heads with blob
`5ce64a237c6621b0835a2d20ef0f35b53d5d3b19` combine delegated recovery
with an older gate inventory and remain a separate cohort. Rolling CI is a
local reusable-workflow call at the dispatch source SHA; target checkout can
differ. This table is workflow-source provenance, not full-main certification.

| Event / Configuration | All First Attempts / Pass/Fail/Cancel/Skip/Unfinished/Unknown | Passing n | Node Job | Node Step | Node Wait | All-Job Runner-Minutes |
| --- | --- | ---: | --- | --- | --- | --- |
| merge_group / f6865fdf8 | 1 / 1/0/0/0/0/0 | 1 | 28.233/28.233 (1) | 24.533/24.533 (1) | 0.033/0.033 (1) | 183.517/183.517 (1) |
| merge_group / 11de60a49 | 1 / 1/0/0/0/0/0 | 1 | 29.933/29.933 (1) | 26.000/26.000 (1) | 0.033/0.033 (1) | 171.167/171.167 (1) |
| merge_group / 074da66e9 | 9 / 8/1/0/0/0/0 | 8 | 24.450/30.550 (8) | 21.183/26.767 (8) | 0.033/8.100 (8) | 178.617/188.117 (8) |
| merge_group / b0b1313e4 | 11 / 8/2/1/0/0/0 | 8 | 21.250/30.950 (8) | 18.350/26.817 (8) | 0.033/24.700 (8) | 172.433/191.583 (8) |
| merge_group / 5f6743109 | 69 / 46/7/16/0/0/0 | 46 | 30.883/31.933 (46) | 26.850/27.883 (46) | 0.450/24.083 (46) | 179.883/194.733 (46) |
| merge_group / custom-5ce64a237 | 2 / 0/1/1/0/0/0 | 0 | —/— (0) | —/— (0) | —/— (0) | —/— (0) |
| merge_group / 1928fa43a | 30 / 21/4/5/0/0/0 | 21 | 31.950/33.833 (21) | 27.867/29.550 (21) | 2.183/40.667 (21) | 192.017/203.567 (21) |
| merge_group / 32b0b9728 | 89 / 61/8/20/0/0/0 | 61 | 32.667/34.617 (61) | 28.917/30.617 (61) | 0.033/2.217 (61) | 192.867/203.917 (61) |
| merge_group / 7ec02432e | 88 / 78/6/4/0/0/0 | 78 | 11.967/13.283 (78) | 11.333/12.467 (78) | 0.033/0.200 (78) | 201.833/215.050 (76) |
| merge_group / e8f167b67 | 15 / 12/1/2/0/0/0 | 12 | 12.833/13.300 (12) | 12.250/12.683 (12) | 0.033/0.200 (12) | 208.550/216.433 (12) |
| rolling / f6865fdf8 | 2 / 2/0/0/0/0/0 | 2 | 25.133/31.133 (2) | 21.800/27.133 (2) | 0.033/0.033 (2) | 161.817/190.483 (2) |
| rolling / 11de60a49 | 1 / 1/0/0/0/0/0 | 1 | 29.267/29.267 (1) | 25.550/25.550 (1) | 0.033/0.033 (1) | 193.850/193.850 (1) |
| rolling / 074da66e9 | 8 / 8/0/0/0/0/0 | 8 | 29.300/31.100 (8) | 25.467/27.117 (8) | 0.033/0.033 (8) | 180.750/199.033 (8) |
| rolling / b0b1313e4 | 8 / 5/1/2/0/0/0 | 4 | 21.067/31.250 (4) | 18.000/27.300 (4) | 0.017/1.517 (4) | 170.300/177.850 (4) |
| rolling / 5f6743109 | 42 / 25/6/11/0/0/0 | 24 | 30.800/32.200 (24) | 26.850/27.767 (24) | 0.533/15.417 (24) | 185.417/195.950 (24) |
| rolling / 1928fa43a | 22 / 13/0/9/0/0/0 | 12 | 30.483/33.833 (12) | 26.700/29.083 (12) | 0.200/38.850 (12) | 195.617/205.717 (12) |
| rolling / 32b0b9728 | 57 / 38/3/16/0/0/0 | 37 | 29.050/34.467 (37) | 25.583/30.517 (37) | 0.033/0.333 (37) | 198.850/209.200 (37) |
| rolling / 7ec02432e | 73 / 50/5/18/0/0/0 | 47 | 11.383/13.083 (47) | 10.817/12.500 (47) | 0.033/0.050 (47) | 203.433/214.583 (46) |
| rolling / e8f167b67 | 8 / 5/1/2/0/0/0 | 5 | 13.067/13.150 (5) | 12.383/12.483 (5) | 0.050/0.150 (5) | 214.083/230.167 (5) |
| push / f6865fdf8 | 2 / 1/0/1/0/0/0 | 1 | 27.883/27.883 (1) | 24.150/24.150 (1) | 0.033/0.033 (1) | 181.750/181.750 (1) |
| push / 11de60a49 | 1 / 1/0/0/0/0/0 | 1 | 30.617/30.617 (1) | 26.567/26.567 (1) | 0.033/0.033 (1) | 171.083/171.083 (1) |
| push / 074da66e9 | 8 / 5/1/2/0/0/0 | 5 | 30.650/31.417 (5) | 26.700/27.350 (5) | 0.033/0.150 (5) | 181.900/192.767 (5) |

### Separate Typecheck and Bundles After Sharding

The historical combined job no longer exists in these configurations. Passing
first attempts only; the separate typecheck/bundles job's execution and wait
are retained rather than silently attributed to Node shard execution.

| Event / Configuration | Typecheck Job Execution p50/p90 (n) | Typecheck Wait p50/p90 (n) |
| --- | --- | --- |
| merge_group / 7ec02432e | 3.667/3.917 (78) | 0.033/0.067 (78) |
| merge_group / e8f167b67 | 3.333/3.967 (12) | 0.033/0.033 (12) |
| rolling / 7ec02432e | 3.700/3.917 (47) | 0.033/0.033 (47) |
| rolling / e8f167b67 | 3.833/3.883 (5) | 0.033/0.050 (5) |

### Landing-Era Stratification

These are independently split by the named change boundaries, including
rolling-control and sandbox changes that share CI blobs. This is a date-based
context view, not a claim that every branch already contains that landed code.
The first era starts at the requested window; each era ends at the next boundary.
Passing first attempts only; n=0 retains missing timing rather than a zero gain.

| Event / Era | All First Attempts / Pass/Fail/Cancel/Skip/Unfinished/Unknown | Passing n | Node Job | Node Step | Node Wait | All-Job Runner-Minutes |
| --- | --- | ---: | --- | --- | --- | --- |
| merge_group / cache | 2 / 2/0/0/0/0/0 | 2 | 28.233/29.933 (2) | 24.533/26.000 (2) | 0.033/0.033 (2) | 171.167/183.517 (2) |
| merge_group / selection | 1 / 1/0/0/0/0/0 | 1 | 21.917/21.917 (1) | 18.833/18.833 (1) | 0.033/0.033 (1) | 169.183/169.183 (1) |
| merge_group / routing | 4 / 3/1/0/0/0/0 | 3 | 25.433/30.550 (3) | 22.000/26.767 (3) | 0.033/0.033 (3) | 187.217/188.117 (3) |
| merge_group / pending-worker | 4 / 4/0/0/0/0/0 | 4 | 24.450/28.500 (4) | 21.183/24.783 (4) | 0.033/8.100 (4) | 178.617/186.383 (4) |
| merge_group / health-wake | 1 / 1/0/0/0/0/0 | 1 | 21.250/21.250 (1) | 18.350/18.350 (1) | 0.017/0.017 (1) | 164.483/164.483 (1) |
| merge_group / rolling-cutover | 15 / 10/2/3/0/0/0 | 10 | 24.900/30.950 (10) | 21.500/26.850 (10) | 0.050/19.150 (10) | 178.867/191.583 (10) |
| merge_group / admission-shadow | 67 / 44/8/15/0/0/0 | 44 | 30.883/31.933 (44) | 26.833/27.883 (44) | 0.450/24.083 (44) | 179.883/194.733 (44) |
| merge_group / gate-disabled | 33 / 22/4/7/0/0/0 | 22 | 31.500/33.833 (22) | 27.483/29.550 (22) | 2.183/40.667 (22) | 185.667/203.567 (22) |
| merge_group / delegated-recovery | 72 / 53/7/12/0/0/0 | 53 | 33.133/34.617 (53) | 29.367/30.617 (53) | 0.033/2.150 (53) | 193.233/203.917 (53) |
| merge_group / sandbox-fallback | 17 / 9/1/7/0/0/0 | 9 | 27.017/34.767 (9) | 23.683/30.817 (9) | 0.033/0.033 (9) | 193.033/211.683 (9) |
| merge_group / sharded | 86 / 76/6/4/0/0/0 | 76 | 11.967/13.167 (76) | 11.333/12.433 (76) | 0.033/0.200 (76) | 201.833/215.050 (74) |
| merge_group / packaged-runner | 13 / 11/1/1/0/0/0 | 11 | 12.833/13.133 (11) | 12.250/12.450 (11) | 0.033/0.200 (11) | 208.717/216.433 (11) |
| pull_request / cache | 8 / 1/2/0/5/0/0 | 1 | 24.683/24.683 (1) | 21.233/21.233 (1) | 0.033/0.033 (1) | 155.733/155.733 (1) |
| pull_request / selection | 3 / 1/0/0/2/0/0 | 1 | 20.950/20.950 (1) | 18.067/18.067 (1) | 0.033/0.033 (1) | 159.700/159.700 (1) |
| pull_request / routing | 7 / 2/1/0/4/0/0 | 2 | 30.283/30.717 (2) | 26.517/26.783 (2) | 0.033/0.033 (2) | 170.367/186.167 (2) |
| pull_request / pending-worker | 20 / 9/0/7/4/0/0 | 9 | 27.450/30.567 (9) | 23.833/26.583 (9) | 1.817/19.083 (9) | 181.383/188.867 (9) |
| pull_request / health-wake | 2 / 1/0/0/1/0/0 | 1 | 27.517/27.517 (1) | 23.900/23.900 (1) | 0.033/0.033 (1) | 176.350/176.350 (1) |
| pull_request / rolling-cutover | 60 / 27/7/11/15/0/0 | 27 | 30.417/31.400 (27) | 26.650/27.467 (27) | 16.717/98.783 (27) | 176.683/190.100 (27) |
| pull_request / admission-shadow | 102 / 45/8/37/12/0/0 | 45 | 30.967/31.917 (45) | 26.867/27.867 (45) | 26.317/126.100 (45) | 180.500/193.333 (45) |
| pull_request / gate-disabled | 71 / 30/4/17/20/0/0 | 30 | 31.417/33.417 (30) | 27.567/29.350 (30) | 32.633/68.667 (30) | 189.283/202.550 (30) |
| pull_request / delegated-recovery | 137 / 67/9/51/10/0/0 | 67 | 29.750/34.567 (67) | 26.133/30.483 (67) | 0.033/18.567 (67) | 193.483/205.633 (67) |
| pull_request / sandbox-fallback | 13 / 5/2/6/0/0/0 | 5 | 23.367/34.717 (5) | 20.483/30.783 (5) | 0.033/0.033 (5) | 200.200/214.417 (5) |
| pull_request / sharded | 204 / 96/10/92/6/0/0 | 96 | 11.883/13.233 (91) | 11.133/12.517 (96) | 0.050/10.067 (94) | 200.667/215.417 (88) |
| pull_request / packaged-runner | 12 / 7/1/4/0/0/0 | 7 | 13.033/13.133 (7) | 12.350/12.500 (7) | 0.133/0.217 (7) | 201.983/222.517 (7) |
| rolling / cache | 2 / 2/0/0/0/0/0 | 2 | 25.133/31.133 (2) | 21.800/27.133 (2) | 0.033/0.033 (2) | 161.817/190.483 (2) |
| rolling / selection | 1 / 1/0/0/0/0/0 | 1 | 29.267/29.267 (1) | 25.550/25.550 (1) | 0.033/0.033 (1) | 193.850/193.850 (1) |
| rolling / routing | 3 / 3/0/0/0/0/0 | 3 | 30.200/31.100 (3) | 26.483/27.117 (3) | 0.033/0.033 (3) | 184.167/199.033 (3) |
| rolling / pending-worker | 4 / 4/0/0/0/0/0 | 4 | 29.300/30.950 (4) | 25.467/27.067 (4) | 0.033/0.033 (4) | 180.750/196.850 (4) |
| rolling / health-wake | 1 / 1/0/0/0/0/0 | 1 | 28.717/28.717 (1) | 25.083/25.083 (1) | 0.033/0.033 (1) | 165.350/165.350 (1) |
| rolling / rolling-cutover | 8 / 5/1/2/0/0/0 | 4 | 21.067/31.250 (4) | 18.000/27.300 (4) | 0.017/1.517 (4) | 170.300/177.850 (4) |
| rolling / admission-shadow | 42 / 25/6/11/0/0/0 | 24 | 30.800/32.200 (24) | 26.850/27.767 (24) | 0.533/15.417 (24) | 185.417/195.950 (24) |
| rolling / gate-disabled | 22 / 13/0/9/0/0/0 | 12 | 30.483/33.833 (12) | 26.700/29.083 (12) | 0.200/38.850 (12) | 195.617/205.717 (12) |
| rolling / delegated-recovery | 52 / 35/3/14/0/0/0 | 34 | 29.050/34.450 (34) | 25.583/30.467 (34) | 0.033/0.333 (34) | 199.450/209.200 (34) |
| rolling / sandbox-fallback | 5 / 3/0/2/0/0/0 | 3 | 27.600/34.700 (3) | 24.267/30.783 (3) | 0.033/0.033 (3) | 193.050/198.150 (3) |
| rolling / sharded | 73 / 50/5/18/0/0/0 | 47 | 11.383/13.083 (47) | 10.817/12.500 (47) | 0.033/0.050 (47) | 203.433/214.583 (46) |
| rolling / packaged-runner | 8 / 5/1/2/0/0/0 | 5 | 13.067/13.150 (5) | 12.383/12.483 (5) | 0.050/0.150 (5) | 214.083/230.167 (5) |
| push / cache | 2 / 1/0/1/0/0/0 | 1 | 27.883/27.883 (1) | 24.150/24.150 (1) | 0.033/0.033 (1) | 181.750/181.750 (1) |
| push / selection | 1 / 1/0/0/0/0/0 | 1 | 30.617/30.617 (1) | 26.567/26.567 (1) | 0.033/0.033 (1) | 171.083/171.083 (1) |
| push / routing | 3 / 3/0/0/0/0/0 | 3 | 29.933/31.267 (3) | 26.250/27.100 (3) | 0.033/0.150 (3) | 181.900/192.767 (3) |
| push / pending-worker | 4 / 2/0/2/0/0/0 | 2 | 30.650/31.417 (2) | 26.700/27.350 (2) | 0.017/0.033 (2) | 178.217/184.467 (2) |
| push / health-wake | 1 / 0/1/0/0/0/0 | 0 | —/— (0) | —/— (0) | —/— (0) | —/— (0) |

The census supplies the missing multi-run comparison across the entire requested
range, with explicit workflow generations rather than a pooled scheduler
speedup. The tables show the observed medians, tails and consumption; none is
a controlled estimate of #3643's causal effect. PR, group and rolling outcomes
are not interchangeable. Later sharding lowers per-job execution while adding
runner/setup demand; added jobs change total consumption. Queue wait reflects
competing demand and cannot be credited to file ordering without evidence.

### Timeouts and Other Incomplete Work

Groups [41133385707](https://github.com/picoduck/wollipog/actions/runs/41133385707)
and [41127454648](https://github.com/picoduck/wollipog/actions/runs/41127454648)
have jobs 124329732510/124309558814 lasting 35.317/35.333 minutes.
Their check-run annotations explicitly report exceeding 35 minutes. Unit Tests
passed in 31.600/31.450 minutes before later job cancellation. Those outcomes
cannot count as successful full checks. This is the known #3770 mode,
subsequently addressed by the three-shard split; other cancellations are not
automatically called timeouts. The full source projection preserves cancelled
jobs and executed steps, including incomplete work excluded from passing tables.

The initial four safe timing projections remain the bounded per-file evidence;
the expanded census uses job/step metadata, not bulk raw logs or test inputs.
The data does not establish a cheap verified improvement worth implementing
in this measurement pass. Existing #3770 is the duplicate for the observed
timeout regression.

## AC 2 and AC 5: Current Discovery and Fast Readiness

Verified on freshly fetched main `191fa4e5dc025110fd389d008e0d5902cf4bac5c`:

- `discoverNodeTests()` found 1,281 files using the original six root-command
  globs and native dependency exclusion. `full` contains each exactly once;
  22 fast plus 1,259 remaining files have disjoint union equal to full.
- The three CI shards contain 427/427/427 files and their unique union is
  exactly those 1,281 files. Execution is dynamically discovered, not filtered
  through the historical inventory. New files still default to remaining/full.
- The two original inventory paths absent on main are
  `apps/runner/src/campaign-review-jobs.test.ts` and
  `apps/runner/src/session-review-jobs.test.ts`, deleted by review-job retirement
  `267eb4b2b` (#3780), not excluded by the partition. This is current discovery
  equivalence, not a claim the repository never retired any assertions.
- `node --import tsx --test scripts/node-test-plan.test.mjs`: 8/8 passed,
  no skips. These exercise discovery, unknown files, sharding and native process
  exit/timeout/cleanup behavior.
- `node scripts/test-node.mjs --suite fast --test-timeout=300000`:
  231/231 passed, zero skips/cancellations, native duration **0.349 seconds**,
  Linux Node 24.18.1, default native concurrency. This is the initial 22-file
  partition, not later v2/v3 candidates or a hosted measurement. The original
  profile delivered 201 tests in 1.020s (Node 24) / 1.628s (Node 22.13), locally.

The initial fast partition's actual local duration and readiness limitations
are demonstrated. A standalone hosted fast duration and its queue wait remain
**unmeasured**: sampled admitted workflows run full coverage, not a separate
fast job. No fast policy activation or 15-minute readiness claim follows.

In early PR job 120800982194, the safe profile identifies delegated media
integration 263.566s, provider-home lease checkpoint 187.938s, sessions 187.073s
and prepared-media integration 149.612s. On rolling worker 41442063631,
the corresponding largest file totals include delegated media 379.372s,
sessions 164.762s, prepared-media integration 226.936s and lease checkpoint
217.615s. These are summed outermost test/suite durations, not file wall time
or CPU demand. Known paths resolve against the published profile's file hashes.
The top-20 projection leaves other import/startup costs unmeasured.
Real database/media/process coverage, shard imbalance, browser execution and
runner waits remain bottlenecks. No verified cheap improvement is established.

## Delivery Assessment

- AC 1: original profile/inventory delivered; the complete-window projection
  now preserves the natural-run source identities and measurements.
- AC 2: met for main's discovered set at the explicit verified snapshot above;
  subsequent application changes are not implicitly recertified.
- AC 3: full-window measurement/comparison delivered. No causal or universal
  scheduling gain is claimed. Suite growth, workflow changes, censored timeouts,
  runner variability and resource competition limit attribution.
- AC 4: this pass changes documentation only; original boundary preservation
  remains implementation evidence, with the focused 8/8 contracts confirmed.
- AC 5: initial fast actual local duration and bottlenecks delivered; a separate
  hosted-fast duration/wait remains unmeasured. No sampled full run is substituted
  for a standalone fast run and no v2/v3 candidate is conflated with the initial
  partition. Full coverage remains required pending separately authorized rollout.

Issue closure belongs to the parent campaign. No follow-up issues recommended;
the observed timeout mode duplicates #3770 rather than a new optimization task.
