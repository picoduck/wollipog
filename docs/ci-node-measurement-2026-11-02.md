# Node Critical-Path Measurement: November 2, 2026

Refs #3627. Scheduling implementation: PR #3643, merge
`85044bee2a50e1d817d6886f3fb632f21d5c9c8b`. This observational measurement
does not establish a causal speedup or activate reduced coverage.

## Method and Cohorts

All windows are half-open UTC run-creation windows, deliberately bounded rather
than a census of the intervening days. Only natural traffic was read; no CI was
dispatched, rerun, cancelled or configured for collection. Collection was on
November 2. Units are elapsed minutes, not billed consumption. Quantiles use
the existing report's nearest-rank method; missing values never become zero.

| Window | PR First Attempts (Pass/Fail/Cancel/Skip) | Group First Attempts | Historical Main Push | Rerun Attempts |
| --- | --- | --- | --- | --- |
| [2026-10-24T06:00:00Z, 2026-10-24T12:00:00Z) | 1/0/0/0 | 0 | 0 | 0 |
| [2026-10-24T12:00:00Z, 2026-10-25T00:00:00Z) | 3/3/0/10 | 6/1/0/0 | 5/0/1/0 | 3 PR, passing |
| [2026-10-30T18:00:00Z, 2026-10-30T22:00:00Z) | 10/1/12/0 | 7/1/4/0 | 0 | 1 PR, passing |
| [2026-11-02T09:00:00Z, 2026-11-02T13:00:00Z) | Not sampled | Not sampled | Rolling workers: 4/1/3/0 | 0 |

No unfinished or unknown run outcomes were observed. Ten skipped PRs in the
October 24 afternoon cohort have unmeasured consumption. October 30 has ten PR
and two group first attempts with incomplete consumption. Three rolling
cancellations have no jobs and unmeasured consumption, not zero consumption.
Reruns remain separate; copied successful jobs cannot establish rerun resource
use. The historical main-push rows are retained only as historical context;
**current main evidence comes from rolling workers**, never retired push CI.

The first three windows use `scripts/merge-queue-wait-report.mjs --all-events
--repo picoduck/wollipog --since START --until END --json` with authenticated
read-only API access. Run/job/history pagination was complete under the report's
ten pages of 100 and ten-attempt limits; no attempt cap was reached.

For rolling workers, the report's CI-only run listing cannot select the worker
workflow. A bounded REST listing of `main-rolling-validation.yml`, `event=workflow_dispatch`,
`branch=main`, `created=>=2026-11-02T09:00:00Z`, `per_page=100` was filtered
locally to the stated half-open window. Its response contained fewer than 100
runs and was not truncated. Each exact attempt and its paginated jobs were read
through `cachedApi` from `scripts/ci-runner-occupancy.mjs` (17 API calls),
`listJobs` and `attemptRecord` from the merge-queue report. Caller-prefixed job
names were retained. All job listings were complete. No rolling critical-path
metric that requires an unprefixed aggregator is used here.

Four selected jobs were read through the bounded content-safe `readTimingLog`
projection (which uses `scripts/ci-timing.mjs`); all were measured, untruncated.
Raw logs, test titles, inputs, runner identities and artifacts are not retained.
Reliability evidence is run/step outcomes plus safe reporter counts, not a claim
of root cause or a retry-success flake rate. A repository-wide occupancy census
was not collected; job wait does not prove saturation or explain its cause.

## AC 3: Execution, Wait and Runner-Minutes

All p50/p90 pairs below are minutes. The Node job is the historical
`Typecheck, Unit Tests & Bundles`; the step is `Unit Tests`.

| Cohort | Node Job | Unit Tests Step | Node Runner Wait | Complete All-Job Runner-Minutes |
| --- | ---: | ---: | ---: | ---: |
| Baseline, 75 groups, all outcomes | 26.8/29.2 (73 measured) | 23.7/25.7 (73) | 0.3/18.6 | 173.0/185.3 (73) |
| Oct 23 profile, one passing group | 30.267 | 26.517 | 0.033 | 187.717 |
| Oct 24 morning PR, one passing | 24.683 | 21.233 | 0.033 | 155.733 |
| Oct 24 afternoon PR, three passing | 30.283/30.717 | 26.517/26.783 | 0.033/0.033 | 170.367/186.167 |
| Oct 24 afternoon groups, seven all outcomes | 25.433/30.550 | 22.000/26.767 | 0.033/0.033 | 183.483/188.117 |
| Oct 24 afternoon groups, six passing | 25.433/30.550 | 22.000/26.767 | 0.033/0.033 | 177.367/188.117 |
| Oct 30 PR, ten passing | 28.050/34.733 | 24.717/30.817 | 0.033/0.033 | 196.500/205.100 |
| Oct 30 groups, seven passing | 34.283/34.850 | 30.267/30.883 | 0.033/0.050 | 191.117/200.600 |

The baseline is [October 22](ci-baseline-2026-10-22.md), window
`[2026-10-20T00:00:00Z, 2026-10-22T00:00:00Z)`, with raw source identities in
its JSON. Its 65 passing groups consumed 172.983/184.500 runner-minutes;
compare with the passing-only rows above rather than mixing outcome cohorts.
The [profile](ci-node-profile-2026-10-23.json) identifies run 39896139030,
attempt 1, job 120226938449, window
`[2026-10-23T03:39:00Z, 2026-10-23T03:40:00Z)`.

The early seven-group comparison has a lower Node median, a higher p90 and
higher runner-minutes than the all-outcome baseline. It supplies the previously
missing multiple-natural-run comparison, **not evidence of a consistent gain**.
October 30 is worse again and cannot be attributed solely to the scheduling
change. Suite growth, runner variability, code/workflow changes, different
traffic and small samples confound comparisons. PR API head SHA is not the
tested merge SHA; the source table labels it accordingly.

The #3649 apt cache (`f6865fdf83db979eef6c7598e0112c04fd32deba`) preceded
the implementation merge; these post-merge group samples are post-cache.
The baseline/profile predate it. Historical PR workflows can use older base
snapshots, so creation date alone cannot certify their install configuration.
No setup reduction is attributed to Node scheduling or cache hits without
exact workflow/cache evidence. The original delivery's pre-cache PR and
post-cache merge-group observations remain separate, not a paired experiment.

October 30 groups [41133385707](https://github.com/picoduck/wollipog/actions/runs/41133385707)
and [41127454648](https://github.com/picoduck/wollipog/actions/runs/41127454648)
have Node jobs 124329732510 and 124309558814 lasting 35.317 and 35.333 minutes.
Both check-run annotation endpoints explicitly report exceeding the 35-minute
maximum. Their Unit Tests steps passed in 31.600 and 31.450 minutes, but the jobs
were cancelled later: partial successful tests are not successful full checks.
Other cancellations are not automatically classified as timeouts. This is the
already-reported #3770 failure mode, subsequently addressed by sharding.

## Later Rolling Main: Separate Workflow Generation

The #3770 work landed as `09997164ade5a6ff6cb91ee7afb2c8e38dedfcec`
and `7ec02432e4819da7436bf065b75f8c35452828bf`. The old combined job no
longer exists in these workers. Typecheck/bundles and three full Node shards
run separately. These observations must not be presented as #3643's speedup.

| Passing Worker | Typecheck Job Execution / Wait | Node Shards' Execution (1,2,3) | Unit Tests Steps (1,2,3) | Node Wait (1,2,3) | All-Job Runner-Minutes |
| --- | ---: | --- | --- | --- | ---: |
| 41424595682 | 3.883 / 0.033 | 13.067,11.650,9.717 | 12.383,10.900,9.083 | 0.033,0.033,0.033 | 192.133 |
| 41426035318 | 3.850 / 0.033 | 10.550,8.150,10.833 | 9.900,7.300,10.267 | 0.050,0.033,0.033 | 214.083 |
| 41436903084 | 3.833 / 0.033 | 13.150,8.283,10.667 | 12.483,7.733,9.917 | 0.033,0.033,0.117 | 230.167 |
| 41442063631 | 2.633 / 5.550 | 12.800,8.083,10.417 | 12.217,7.533,9.850 | 2.633,1.717,4.017 | 211.283 |

Counts include worker admission/health/control jobs as well as validation.
Thus runner totals differ structurally from old standalone CI. The failing
worker 41431599192 has a failing shard-1 Unit Tests step (12.617 minutes),
not a timeout or passing sample. Cancelled workers 41441503277, 41436698548,
41431323511 had no jobs. No 35-minute cancellation appears in this rolling window.
Run titles supply target identities; the three safe Node summaries for
41442063631 independently agree on tested/workflow SHA
`516115d1df575aed79d9c1e8c09727acda298e57`, with 17,880 tests,
140 skips, zero failures/cancellations. This is timing evidence, not a new
full-main health certification; dispatch SHA alone never certifies the target.

## AC 2 and AC 5: Current Discovery and Fast Readiness

Verified on freshly fetched main `1b756ed11dad081d9b5fb32894477a32d15c9de7`:

- `discoverNodeTests()` found 1,280 files using the original six root-command
  globs and native dependency exclusion. `full` contains each exactly once;
  22 fast plus 1,258 remaining files have disjoint union equal to full.
- The three CI shards contain 427/427/426 files and their unique union is
  exactly those 1,280 files. Execution is dynamically discovered, not filtered
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
  231/231 passed, zero skips/cancellations, native duration **0.518 seconds**,
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

- AC 1: previously delivered profile/inventory; this adds natural timing evidence.
- AC 2: met for current main's discovered set, with explicit retired-file caveat.
- AC 3: measurement/comparison delivered; consistent performance gain **not
  demonstrated**. Median-only improvement is insufficient; tail and consumption
  are higher. A causal gain claim would need comparable same-workflow/suite
  natural cohorts and resource evidence, not manufactured CI load.
- AC 4: no behavior changed in this measurement pass; focused contracts passed.
  Existing implementation delivery remains the assertion-preservation evidence.
- AC 5: initial fast actual local duration/bottlenecks delivered; hosted standalone
  timing remains unmeasured. Full coverage remains required pending separate rollout.

The observed timeout regression duplicates #3770 (already addressed), rather
than warranting another issue or an optimization in this measurement pass.
No follow-up issues recommended. Issue closure belongs to the parent campaign.

## Source Attempts

The table below identifies every sampled attempt, including skipped/cancelled
work and reruns. PR SHA means API head SHA, not checked-out merge SHA; rolling
SHA is API dispatch SHA (see verified target above). Missing timing is `—`.
Job/step/runner values on reruns remain unmeasured. All links use public forge
metadata; no logs or user content are retained.

| Window | Run / Attempt | Event / State | API SHA | Node Job ID: Execution / Wait / Step | Complete Runner-Minutes |
| --- | --- | --- | --- | --- | ---: |
| early | [40069935046](https://github.com/picoduck/wollipog/actions/runs/40069935046) / 1 | pull_request / passing | e7a142d0ed4120d6c4b387a4ca849d504cb54951 | 120800982194: 24.683 / 0.033 / 21.233 | 155.733 |
| day | [40131473156](https://github.com/picoduck/wollipog/actions/runs/40131473156) / 1 | pull_request / passing | 53c26d971aa1908ebd93927d74f912d1a9b72234 | 120983898473: 30.283 / 0.033 / 26.517 | 186.167 |
| day | [40131396428](https://github.com/picoduck/wollipog/actions/runs/40131396428) / 1 | pull_request / skipped | 53c26d971aa1908ebd93927d74f912d1a9b72234 | 120983704664: — / — / — | — |
| day | [40122109116](https://github.com/picoduck/wollipog/actions/runs/40122109116) / 1 | pull_request / failing | d1fd69bcd3e9ac7a3a97986bd45a3f3d4d23d201 | 120955724486: 19.817 / 0.017 / 17.317 | 160.467 |
| day | [40122109116](https://github.com/picoduck/wollipog/actions/runs/40122109116) / 2 | pull_request / passing | d1fd69bcd3e9ac7a3a97986bd45a3f3d4d23d201 | 120964172041: — / — / — | — |
| day | [40121856762](https://github.com/picoduck/wollipog/actions/runs/40121856762) / 1 | pull_request / skipped | d1fd69bcd3e9ac7a3a97986bd45a3f3d4d23d201 | 120954961766: — / — / — | — |
| day | [40121546150](https://github.com/picoduck/wollipog/actions/runs/40121546150) / 1 | pull_request / skipped | 9c367cace963b3a1f2c22212f4723d5a439a5ff9 | 120954014185: — / — / — | — |
| day | [40113013486](https://github.com/picoduck/wollipog/actions/runs/40113013486) / 1 | pull_request / skipped | 8b426da12956157516eee4f3167ceb8ee291b126 | 120928514192: — / — / — | — |
| day | [40111854457](https://github.com/picoduck/wollipog/actions/runs/40111854457) / 1 | pull_request / passing | 12fbb0fab190505b29ab1ff1bae3be480d0c3942 | 120925050533: 30.717 / 0.033 / 26.783 | 170.367 |
| day | [40111482716](https://github.com/picoduck/wollipog/actions/runs/40111482716) / 1 | pull_request / skipped | 9e0aa8b4d8decf1fb70b576ec378181928986a1f | 120923953411: — / — / — | — |
| day | [40106386697](https://github.com/picoduck/wollipog/actions/runs/40106386697) / 1 | pull_request / passing | 9b902294882f52d51ede6652c6617e52b4490296 | 120908837483: 20.950 / 0.033 / 18.067 | 159.700 |
| day | [40106166266](https://github.com/picoduck/wollipog/actions/runs/40106166266) / 1 | pull_request / skipped | 9b902294882f52d51ede6652c6617e52b4490296 | 120908182567: — / — / — | — |
| day | [40101974522](https://github.com/picoduck/wollipog/actions/runs/40101974522) / 1 | pull_request / skipped | 7ef89233bafa03098c8eb6f18a6eea3ce21d7008 | 120895824639: — / — / — | — |
| day | [40100409106](https://github.com/picoduck/wollipog/actions/runs/40100409106) / 1 | pull_request / skipped | 84f1607e955a8fc1681852ab3e75a6b9b03b32e5 | 120891227585: — / — / — | — |
| day | [40099132512](https://github.com/picoduck/wollipog/actions/runs/40099132512) / 1 | pull_request / failing | da4895ea62c5ea63f6a32b1cbedd3c44d75cd7ff | 120887475442: 29.150 / 0.050 / 26.567 | 185.783 |
| day | [40099132512](https://github.com/picoduck/wollipog/actions/runs/40099132512) / 2 | pull_request / passing | da4895ea62c5ea63f6a32b1cbedd3c44d75cd7ff | 120894690951: — / — / — | — |
| day | [40098753120](https://github.com/picoduck/wollipog/actions/runs/40098753120) / 1 | pull_request / skipped | da4895ea62c5ea63f6a32b1cbedd3c44d75cd7ff | 120886411556: — / — / — | — |
| day | [40098062548](https://github.com/picoduck/wollipog/actions/runs/40098062548) / 1 | pull_request / skipped | 12fbb0fab190505b29ab1ff1bae3be480d0c3942 | 120884366541: — / — / — | — |
| day | [40097516733](https://github.com/picoduck/wollipog/actions/runs/40097516733) / 1 | pull_request / failing | e61003621f2078f172ca814f8804ba0659de8461 | 120882759549: 23.717 / 0.033 / 20.350 | 173.800 |
| day | [40097516733](https://github.com/picoduck/wollipog/actions/runs/40097516733) / 2 | pull_request / passing | e61003621f2078f172ca814f8804ba0659de8461 | 120890118532: — / — / — | — |
| day | [40134141930](https://github.com/picoduck/wollipog/actions/runs/40134141930) / 1 | merge_group / passing | 6df9e76966d9740c1582d2b5d280190e455873ba | 120991954643: 30.550 / 0.033 / 26.767 | 188.117 |
| day | [40127572259](https://github.com/picoduck/wollipog/actions/runs/40127572259) / 1 | merge_group / passing | 4e2652c3bb9d48b255521de8ea37903266e3cdf5 | 120972173758: 24.217 / 0.017 / 21.033 | 187.217 |
| day | [40117722743](https://github.com/picoduck/wollipog/actions/runs/40117722743) / 1 | merge_group / passing | a55a831b62d4ba1b8776f5e05fab5319422e9238 | 120942422780: 25.433 / 0.033 / 22.000 | 177.367 |
| day | [40114734480](https://github.com/picoduck/wollipog/actions/runs/40114734480) / 1 | merge_group / failing | 5064dfdde62cac14792795af0a08ade2abcc9188 | 120933571826: 24.683 / 0.033 / 21.983 | 183.483 |
| day | [40109191193](https://github.com/picoduck/wollipog/actions/runs/40109191193) / 1 | merge_group / passing | 074da66e914728cc51490b0b21928bd1246e6153 | 120917143615: 21.917 / 0.033 / 18.833 | 169.183 |
| day | [40103303022](https://github.com/picoduck/wollipog/actions/runs/40103303022) / 1 | merge_group / passing | 11de60a49e1fb14462cdeff25a8053303b6469de | 120899694248: 29.933 / 0.033 / 26.000 | 171.167 |
| day | [40102698714](https://github.com/picoduck/wollipog/actions/runs/40102698714) / 1 | merge_group / passing | 723ce352d57ff72812dfb00e5e8c6182b6b33e2b | 120897936360: 28.233 / 0.033 / 24.533 | 183.517 |
| day | [40136602471](https://github.com/picoduck/wollipog/actions/runs/40136602471) / 1 | push / passing | 6df9e76966d9740c1582d2b5d280190e455873ba | 120999332267: 31.417 / 0.017 / 27.350 | 184.467 |
| day | [40130169496](https://github.com/picoduck/wollipog/actions/runs/40130169496) / 1 | push / passing | 4e2652c3bb9d48b255521de8ea37903266e3cdf5 | 120979999840: 31.267 / 0.033 / 27.100 | 192.767 |
| day | [40120368877](https://github.com/picoduck/wollipog/actions/runs/40120368877) / 1 | push / passing | a55a831b62d4ba1b8776f5e05fab5319422e9238 | 120950393291: 29.933 / 0.017 / 26.250 | 176.567 |
| day | [40111792773](https://github.com/picoduck/wollipog/actions/runs/40111792773) / 1 | push / passing | 074da66e914728cc51490b0b21928bd1246e6153 | 120924875064: 27.083 / 0.150 / 23.600 | 181.900 |
| day | [40105798151](https://github.com/picoduck/wollipog/actions/runs/40105798151) / 1 | push / passing | 11de60a49e1fb14462cdeff25a8053303b6469de | 120907409341: 30.617 / 0.033 / 26.567 | 171.083 |
| day | [40105210060](https://github.com/picoduck/wollipog/actions/runs/40105210060) / 1 | push / cancelled | 723ce352d57ff72812dfb00e5e8c6182b6b33e2b | 120905373590: 9.017 / 0.033 / 7.000 | 55.550 |
| late | [41134402528](https://github.com/picoduck/wollipog/actions/runs/41134402528) / 1 | pull_request / passing | 5af8515eb77d89876a14facc50316ecc46db8cc9 | 124333148022: 34.833 / 0.017 / 30.950 | 196.500 |
| late | [41134223377](https://github.com/picoduck/wollipog/actions/runs/41134223377) / 1 | pull_request / passing | 5f77d9044b4810c56ed62cecf21953931fde5a08 | 124332550416: 34.733 / 0.033 / 30.817 | 196.683 |
| late | [41133015505](https://github.com/picoduck/wollipog/actions/runs/41133015505) / 1 | pull_request / cancelled | f78ded8233f7a1546e773c497116ae6b452106ac | 124328494380: 35.267 / 0.033 / 32.433 | 197.667 |
| late | [41132522821](https://github.com/picoduck/wollipog/actions/runs/41132522821) / 1 | pull_request / cancelled | de15d230fc8c22c9eb7879c6e3a207a45312157c | 124326769955: 22.783 / 0.033 / 20.500 | — |
| late | [41131151440](https://github.com/picoduck/wollipog/actions/runs/41131151440) / 1 | pull_request / passing | c3fa32505fc5e71220f7ad79da5e1f4712f684b9 | 124322088669: 28.050 / 0.033 / 24.717 | 184.967 |
| late | [41130921048](https://github.com/picoduck/wollipog/actions/runs/41130921048) / 1 | pull_request / cancelled | 3863a837a5e58c75b85ec8a5a54ee8c59f3279e7 | 124321291727: 2.750 / 0.033 / 0.233 | — |
| late | [41130742615](https://github.com/picoduck/wollipog/actions/runs/41130742615) / 1 | pull_request / cancelled | 4854d06c5bc01d37bb4c67ae0dcdf75e4964710a | 124320687088: 2.667 / 0.050 / — | — |
| late | [41130387015](https://github.com/picoduck/wollipog/actions/runs/41130387015) / 1 | pull_request / passing | c1a5b8cd1fd054f97010bf03cd05d37b75319695 | 124319463634: 23.517 / 0.033 / 20.567 | 184.867 |
| late | [41127981247](https://github.com/picoduck/wollipog/actions/runs/41127981247) / 1 | pull_request / cancelled | 3fb85126a8bfccea754761c86520129df85e3c86 | 124311312021: 22.817 / 0.033 / 20.450 | — |
| late | [41127010584](https://github.com/picoduck/wollipog/actions/runs/41127010584) / 1 | pull_request / failing | 646b71f771ba371fee1578970f327d1e81c10248 | 124308020925: 28.267 / 0.033 / 25.833 | 190.000 |
| late | [41125320882](https://github.com/picoduck/wollipog/actions/runs/41125320882) / 1 | pull_request / cancelled | bf0ab74966b1873928cd15009e3d7b5f9c093c8d | 124302161490: 35.317 / 0.033 / 31.517 | 196.167 |
| late | [41125320882](https://github.com/picoduck/wollipog/actions/runs/41125320882) / 2 | pull_request / passing | bf0ab74966b1873928cd15009e3d7b5f9c093c8d | 124320108267: — / — / — | — |
| late | [41115285197](https://github.com/picoduck/wollipog/actions/runs/41115285197) / 1 | pull_request / passing | 0be11cf77a6a47d59039991908bd3d7379e08871 | 124267790284: 34.200 / 0.033 / 30.267 | 210.083 |
| late | [41115184219](https://github.com/picoduck/wollipog/actions/runs/41115184219) / 1 | pull_request / passing | 359ea443492f2f54f212ff3e71c4b26952d55e11 | 124267436278: 34.183 / 0.033 / 30.350 | 195.167 |
| late | [41114894974](https://github.com/picoduck/wollipog/actions/runs/41114894974) / 1 | pull_request / passing | ceb28c4dba55dfe4493ed60eb57c2a6d62fdafaf | 124266432410: 27.817 / 0.050 / 24.317 | 204.067 |
| late | [41114141189](https://github.com/picoduck/wollipog/actions/runs/41114141189) / 1 | pull_request / cancelled | cb5f3ea1aa4551e51121d29269129cadb8525b67 | 124263828960: 9.050 / 0.033 / 7.050 | — |
| late | [41113580843](https://github.com/picoduck/wollipog/actions/runs/41113580843) / 1 | pull_request / cancelled | dc61acf2e7eee6815a2c043e4240ae68467b52b6 | 124261923713: 5.300 / 0.033 / 2.783 | — |
| late | [41111960599](https://github.com/picoduck/wollipog/actions/runs/41111960599) / 1 | pull_request / cancelled | f74ca1191c81492442c26b9d20f68498269bc756 | 124256031301: 12.783 / 0.033 / 10.200 | — |
| late | [41110916344](https://github.com/picoduck/wollipog/actions/runs/41110916344) / 1 | pull_request / passing | 263a5fd3ca2ccbfa6f926ac8a67e481452c76bf2 | 124252805540: 22.033 / 0.017 / 19.200 | 205.100 |
| late | [41109229033](https://github.com/picoduck/wollipog/actions/runs/41109229033) / 1 | pull_request / cancelled | 054bf8d8158a325224493d7c0a683eff10769527 | 124247015873: 12.783 / 0.017 / 10.283 | — |
| late | [41105230462](https://github.com/picoduck/wollipog/actions/runs/41105230462) / 1 | pull_request / passing | 60d3c04d7d57c7d74dfb29c8f2422fb60ca99716 | 124233132180: 32.650 / 0.033 / 28.883 | 200.783 |
| late | [41105111651](https://github.com/picoduck/wollipog/actions/runs/41105111651) / 1 | pull_request / passing | 0df49347cf780ac64a8e70756702d9b45ea20b9d | 124232677377: 22.917 / 0.033 / 20.000 | 179.083 |
| late | [41104008251](https://github.com/picoduck/wollipog/actions/runs/41104008251) / 1 | pull_request / cancelled | 6122ac88837d62a1cdf4421858314bee68093146 | 124228356112: 9.050 / 0.050 / 6.500 | — |
| late | [41103381971](https://github.com/picoduck/wollipog/actions/runs/41103381971) / 1 | pull_request / cancelled | 37ab9c6fff2799e3ebedccdccb1ab2472098ebc4 | 124225878566: 5.300 / 0.033 / 2.883 | — |
| late | [41135027331](https://github.com/picoduck/wollipog/actions/runs/41135027331) / 1 | merge_group / cancelled | 657f53350ca8761fbcca7aa8badb4770aa73209c | 124335270569: 25.267 / 0.033 / 22.817 | — |
| late | [41133385707](https://github.com/picoduck/wollipog/actions/runs/41133385707) / 1 | merge_group / cancelled | 36d3056505125db4962838cadf0a58a375c071ce | 124329732510: 35.317 / 0.033 / 31.600 | 207.000 |
| late | [41127454648](https://github.com/picoduck/wollipog/actions/runs/41127454648) / 1 | merge_group / cancelled | 13b0c6d3cc97df99766cc00cc05e3846512c19e9 | 124309558814: 35.333 / 0.033 / 31.450 | 197.433 |
| late | [41126831751](https://github.com/picoduck/wollipog/actions/runs/41126831751) / 1 | merge_group / passing | ec2bcf3e7079a9c217544dbd67c289e610788940 | 124307416338: 34.850 / 0.033 / 30.883 | 199.183 |
| late | [41125108417](https://github.com/picoduck/wollipog/actions/runs/41125108417) / 1 | merge_group / cancelled | cc1d8d7e348714931eb84c799e824775a43f2bdc | 124301301621: 15.317 / 0.017 / 13.250 | — |
| late | [41122005979](https://github.com/picoduck/wollipog/actions/runs/41122005979) / 1 | merge_group / failing | cac94fea3b016857e74fd39c44a9755dbe414d9c | 124290128247: 34.500 / 0.050 / 31.533 | 190.350 |
| late | [41119931407](https://github.com/picoduck/wollipog/actions/runs/41119931407) / 1 | merge_group / passing | 629861f722453c08224e08bfc4b97d6d3a8f5d86 | 124283769108: 23.450 / 0.017 / 20.550 | 191.117 |
| late | [41116357228](https://github.com/picoduck/wollipog/actions/runs/41116357228) / 1 | merge_group / passing | 2e81d2aa086570df1c35c8f4002c03972ac597f4 | 124271499643: 34.517 / 0.033 / 30.267 | 196.067 |
| late | [41109832546](https://github.com/picoduck/wollipog/actions/runs/41109832546) / 1 | merge_group / passing | 0a0feacb555f78657853eb2b2c5b549e0d3e1977 | 124249078367: 34.017 / 0.033 / 30.217 | 181.467 |
| late | [41109665242](https://github.com/picoduck/wollipog/actions/runs/41109665242) / 1 | merge_group / passing | fabd3e6dfc2585d6ac36d449f80a07d52b1d2579 | 124248508239: 23.000 / 0.033 / 20.133 | 170.217 |
| late | [41104517752](https://github.com/picoduck/wollipog/actions/runs/41104517752) / 1 | merge_group / passing | c070d3326a80be3852bcd0bb640dccbb394af6ac | 124230361275: 34.833 / 0.050 / 30.850 | 200.600 |
| late | [41104271409](https://github.com/picoduck/wollipog/actions/runs/41104271409) / 1 | merge_group / passing | f7f0ec45f6455d014db1a498733b7c7905decd65 | 124229377998: 34.283 / 0.017 / 30.417 | 177.000 |
| rolling | [41442063631](https://github.com/picoduck/wollipog/actions/runs/41442063631) / 1 | workflow_dispatch / passing | 516115d1df575aed79d9c1e8c09727acda298e57 | 125281746877: 10.417 / 4.017 / 9.850; 125281746919: 12.800 / 2.633 / 12.217; 125281746935: 8.083 / 1.717 / 7.533 | 211.283 |
| rolling | [41441503277](https://github.com/picoduck/wollipog/actions/runs/41441503277) / 1 | workflow_dispatch / cancelled | b56708ad44c02adb1d9d034f6aa40c51faac0c37 | — | — |
| rolling | [41436903084](https://github.com/picoduck/wollipog/actions/runs/41436903084) / 1 | workflow_dispatch / passing | 4538b71ed6cb0f011239fe6728e1ce2995820745 | 125260345919: 13.150 / 0.033 / 12.483; 125260345994: 10.667 / 0.117 / 9.917; 125260346038: 8.283 / 0.033 / 7.733 | 230.167 |
| rolling | [41436698548](https://github.com/picoduck/wollipog/actions/runs/41436698548) / 1 | workflow_dispatch / cancelled | c8514260161b4d606d7a1ea0ec5d95e5af1cf9ee | — | — |
| rolling | [41431599192](https://github.com/picoduck/wollipog/actions/runs/41431599192) / 1 | workflow_dispatch / failing | e292910494ccdbbc3c15657893feefd43c65e656 | 125243088379: 13.433 / 0.033 / 12.617; 125243088469: 9.550 / 0.033 / 8.967; 125243088579: 10.850 / 0.033 / 10.283 | 217.333 |
| rolling | [41431323511](https://github.com/picoduck/wollipog/actions/runs/41431323511) / 1 | workflow_dispatch / cancelled | 459ddec8a6562e680db6542c787d820e7bef6673 | — | — |
| rolling | [41426035318](https://github.com/picoduck/wollipog/actions/runs/41426035318) / 1 | workflow_dispatch / passing | 54f7b068d924cfe88a868f9f80470e949851b898 | 125224986769: 10.833 / 0.033 / 10.267; 125224986872: 10.550 / 0.050 / 9.900; 125224986922: 8.150 / 0.033 / 7.300 | 214.083 |
| rolling | [41424595682](https://github.com/picoduck/wollipog/actions/runs/41424595682) / 1 | workflow_dispatch / passing | bbaa8213e5756550841b9a004a60ad5f9258093a | 125208235817: 9.717 / 0.033 / 9.083; 125208235829: 11.650 / 0.033 / 10.900; 125208236010: 13.067 / 0.033 / 12.383 | 192.133 |
