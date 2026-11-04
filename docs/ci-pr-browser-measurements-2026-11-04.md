# PR Browser Routing Measurements

Refs #3630. Routing remains inactive. Benchmark dispatches used: **2/4**.
This report separates applicability, runtime and timestamp quality; none grants
activation approval or replaces full merge-group regression.

## Applicability: 32 Reduced PRs in the Recent Sample

Replay of `pr-browser-critical-v2` over **100 unique recent squash PR identities**
at main `aaadff56faab892f6ab4f101e2e2485ce2bbe55a` selected **32 reduced / 68 full**.
The original unshipped v1 proposal selected **0 reduced / 100 full** on the same
sample. V2 accepts ordinary app source (including auth/session/store/runner),
Node tests, docs, styles and assets, while retaining full infrastructure fallback.
This can shorten checks for a minority of this recent sample; 68% retain full
Chromium coverage, so a median latency improvement is not established. A faster
synthetic lane alone would not demonstrate overall throughput improvement.

Reproduce with `node scripts/ci-pr-browser-applicability.mjs --ref
aaadff56faab892f6ab4f101e2e2485ce2bbe55a --count 100`. The
[raw replay](ci-pr-browser-applicability-2026-11-04.json) records all source commit
SHAs, PR suffix identities, selection outcomes and hashes of policy/replay sources.
The source commit contains both exact tool versions; `sourceWorkingTreeDirty`
compares executed source bytes with that commit and is false in this artifact.
One repeated
PR suffix was skipped, retaining the newest commit for that identity. No extra CI
run was used. This is a Git-history convention, not 100 fresh forge lookups.

The commit-clock window is **[2026-11-01T22:50:21Z, 2026-11-04T20:39:39Z)**,
denominator 100 unique PR identities. These are commit timestamps, **not merge
landing times**, so the window must not be used for queue or scheduling latency.

| First Full-Fallback Reason | PRs / 100 |
| --- | ---: |
| Browser infrastructure or toolchain | 21 |
| Browser harness or support | 23 |
| Unknown input | 23 |
| Empty diff (`diff-unavailable`) | 1 |

Co-occurring full-trigger reasons overlap; they do not sum to 100 and do not
estimate the independent effect of relaxing any one category:

| Category | PRs / 100 |
| --- | ---: |
| Browser infrastructure or toolchain | 23 |
| Browser harness or support | 26 |
| Unknown input | 41 |

Frequent full inputs include shared protocol implementation, desktop/Rust
configuration, browser fixture entrypoints under apps/web/src/e2e, and manifests.
Application security/persistence filenames alone no longer force full. The
reviewed tradeoff defers missed browser regressions to the complete merge group,
where they cost queue ejections. Monitor merge-group browser failure rate after
activation, with per-run failure attribution and main/flake comparisons as
described in [the assurance contract](ci-pr-assurance.md). Future PR mix may differ.

## Natural Full-PR Baseline

Source: [CI run 41890273700](https://github.com/picoduck/wollipog/actions/runs/41890273700),
attempt 1, PR #4147 head `861206b8d978b32bfddb71e0cbd2b601d1d1082d`.
Observation window **[2026-11-04T18:45:31Z, 2026-11-04T19:18:52Z)**,
denominator **one passing natural full PR**. The end includes the final run update.
The #4046 collector reports no missing job timing, unmeasured allocation job or
timestamp conflict for this sample. This is not proof of scheduler behavior in
other runs, and no clock offset was inferred or subtracted.

- Required-result latency: **33.32 minutes**, ending at aggregator job
  [126804538891](https://github.com/picoduck/wollipog/actions/runs/41890273700/job/126804538891).
- Elapsed runner time: **198.37 runner-minutes** across measured executed jobs.
  This is not billed usage or a dollar cost.
- Inferred critical path: browser shard 2 → aggregator; **33.23 minutes execution**
  and **0.08 minutes residual wait**, using the collector's dependency model.
- Once Chromium shrinks, baseline Node shard 3 already provides a **14.37-minute**
  execution bound before any new planning, waiting or aggregator overhead.

All rows below use the same run/window and one observed job per row. Execution is
API start-to-completion; runner wait is job-created-to-start. These clocks passed
the collector's consistency checks. Test execution is only part of job execution;
setup/build/cleanup remain included in these wall times.

| Job | Job ID | Execution Minutes | Runner Wait Minutes |
| --- | ---: | ---: | ---: |
| Unit Tests (1) | 126785512827 | 11.70 | 0.05 |
| Unit Tests (2) | 126785512897 | 10.92 | 0.03 |
| Unit Tests (3) | 126785512846 | 14.37 | 0.03 |
| Typecheck & Bundles | 126785512606 | 2.75 | 0.03 |
| WebKit End-to-End Tests | 126785512357 | 1.87 | 0.03 |
| Delegated Pipeline Recovery | 126785512662 | 1.08 | 0.03 |
| Chromium Shard 1, Including Production Work | 126785512756 | 32.90 | 0.03 |
| Chromium Shard 2, Critical Full Leg | 126785513106 | 33.20 | 0.03 |
| Chromium Shard 3 | 126785512833 | 28.92 | 0.03 |
| Chromium Shard 4 | 126785513192 | 28.47 | 0.03 |
| Chromium Shard 5 | 126785512970 | 31.88 | 0.03 |
| Reduced Chromium | Not Applicable | Not Run | Not Run |
| Platform Isolation | No Run at This Head | Unmeasured | Unmeasured |

The exact-head Actions listing contains only CI for this baseline. Platform
Isolation is a separate optional workflow outside the required CI aggregator;
its absence is not zero execution time. Its workflow and routing are unchanged.

## Reduced-Lane Benchmark

The first dispatch, [41920114659](https://github.com/picoduck/wollipog/actions/runs/41920114659)
on `f4b3d8e32cb7395d5c97b40619786974033e791f`, was cancelled after review found
that skipping its protected aggregator could satisfy GitHub protection. It counts
against the dispatch budget but supplies no completed-lane latency sample. Its
elapsed runner consumption will be included separately in the measurement costs.
For this single cancelled attempt, the UTC window is
**[2026-11-04T21:52:29Z, 2026-11-04T21:54:07Z)**. Collector-measured execution is
**11.58 runner-minutes**, with **three non-skipped jobs lacking execution timing**
and no detected timestamp-conflict allocation. Total consumed runner-minutes are
therefore **unmeasured**, not 11.58; that value is the measured partial sum. No
missing allocation was imputed as zero. Required-result latency is unmeasured.
The replacement design deliberately fails the protected check and uses a separate
same-tree benchmark marker commit to isolate that expected failure from the PR.

### First Complete Sample

[Run 41920774688](https://github.com/picoduck/wollipog/actions/runs/41920774688),
attempt 1, used marker `8255a75a91f6dcf72c7db8f8e7744ec3bf6522c0`; its tree
`0f3a78a636e20b85767472e932e93e692d9aad84` equals reviewed candidate
`f9e6a702e9753af844cbe20c85949cc7bee95a06`. Observation window
**[2026-11-04T21:56:49Z, 2026-11-04T22:11:11Z)**, denominator **one complete
critical-only dispatch**. [Raw projections](ci-pr-browser-benchmark-2026-11-04.json)
record all job IDs, step clocks and quality classifications, plus the cancelled
attempt. Both run/job listings were complete; no timestamp-conflict allocation or
missing job execution was detected in this complete sample.

The diagnostic result, job **126899956062**, passed **14.33 minutes** after run
creation. The protected sentinel **126899956095** failed deliberately, so the
overall workflow failed as expected. This is **not a passing required PR result**.
Elapsed consumption was **60.27 runner-minutes**, including both result jobs;
this is not billed usage or dollar cost. The diagnostic critical path was Chromium
→ result: **14.23 minutes execution / 0.10 minutes residual wait**, inferred by
the collector after removing the deliberately failed protected sentinel and
renaming the diagnostic result only in an analysis copy. Raw identities remain
unchanged in the evidence. No required-check certification is inferred.

All rows share that run/window and contain one observed job each. Execution is
start-to-completion, not test-only time; wait is created-to-start.

| Job | Job ID | Execution Minutes | Runner Wait Minutes |
| --- | ---: | ---: | ---: |
| Unit Tests (1) | 126892379143 | 11.83 | 0.03 |
| Unit Tests (2) | 126892379394 | 12.32 | 0.03 |
| Unit Tests (3) | 126892379230 | 10.80 | 0.03 |
| Typecheck & Bundles | 126892379824 | 4.17 | 0.03 |
| WebKit End-to-End Tests | 126892378900 | 1.78 | 0.03 |
| Delegated Pipeline Recovery | 126892379545 | 1.05 | 0.03 |
| Reduced Chromium, Including Production Work | 126892380110 | 14.17 | 0.03 |
| Windows Change Detection | 126892379547 | 0.12 | 0.03 |
| Windows Comparison | 126892463073 | 3.92 | 0.03 |
| Platform Isolation | No Run at This Marker | Unmeasured | Unmeasured |

The exact-marker Actions listing contains only CI. Platform Isolation remains an
unchanged optional PR workflow, with no sample on this dispatch. Its absence
cannot be counted as zero execution or as evidence of a platform speedup.

Chromium remains the long pole. Within job126892380110, the development browser
test step ran **11m40s**, production build **46s**, and production smoke **61s**;
these are API step durations, distinct from the full **14m10s** job wall time.
Node test-only steps were **11m13s / 11m39s / 10m11s** for shards1/2/3.
Delegated recovery's verification step was **44s**, within its **63s** job.

Compared with the one natural baseline, observed result latency was **18.98 minutes
shorter** and runner consumption **138.10 runner-minutes lower**. These are
differences between two observations at different revisions, not a controlled
causal estimate, billing saving or distribution. The first synthetic lane is
below 15 minutes; natural PR performance is still unproven because live trusted
planning and arbitrary changed browser specs are absent. Only **32/100** replayed
PRs qualify, and the synthetic lane has little margin before 15 minutes. Runner
wait was small; Chromium/production work, followed by Node shard2, dominated.

The approved sampling plan keeps this **single complete premerge sample**. After
[PR #4149](https://github.com/picoduck/wollipog/pull/4149) merges and registers the
caller, dispatch on main for up to **two more samples** within the remaining
two-dispatch allowance. Check prefixed names in the API, report exact caller/tested
SHAs, and post repeat observations and comparisons on #3630. No premerge caller
adapter is authorized. Post-activation natural PR and merge-group measurements
remain required by #3630; this one synthetic sample does not complete the issue.

### Contemporary Full PR at the Same Head

[Full PR run 41920725615](https://github.com/picoduck/wollipog/actions/runs/41920725615),
attempt1, also names head `f9e6a702e9753af844cbe20c85949cc7bee95a06` and passed
all full PR coverage. Its window is **[2026-11-04T21:56:29Z,
2026-11-04T22:31:55Z)**, denominator **one full PR**. The protected result took
**35.40 minutes**, with **208.47 runner-minutes**, no missing job execution and no
detected timing-conflict allocation. Critical path: shard2 → aggregator,
**35.30 minutes execution / 0.10 minutes residual wait**. Against the one synthetic
sample, the observed difference is **21.07 minutes / 148.20 runner-minutes**.
These overlap in time and share a declared PR head, but PR CI checks the merge
revision and dispatch checks the branch revision; this is still not a controlled
latency distribution or proof of natural routed-PR performance.

| Job | Job ID | Execution Minutes | Runner Wait Minutes |
| --- | ---: | ---: | ---: |
| Unit Tests (1) | 126892194268 | 11.32 | 0.03 |
| Unit Tests (2) | 126892194129 | 12.18 | 0.03 |
| Unit Tests (3) | 126892194113 | 13.27 | 0.03 |
| Typecheck & Bundles | 126892193862 | 3.93 | 0.03 |
| WebKit End-to-End Tests | 126892193450 | 1.43 | 0.03 |
| Delegated Pipeline Recovery | 126892193925 | 1.18 | 0.03 |
| Chromium Shard 1, Including Production Work | 126892194460 | 33.80 | 0.03 |
| Chromium Shard 2 | 126892194214 | 35.23 | 0.03 |
| Chromium Shard 3 | 126892194487 | 32.82 | 0.03 |
| Chromium Shard 4 | 126892194400 | 35.20 | 0.03 |
| Chromium Shard 5 | 126892194141 | 27.68 | 0.03 |

All rows use that full-PR window and one job per row. Exact source IDs, step times
and quality projections are included in the linked raw evidence. Browser-shard
execution dominates; shrinking it makes the 13.27-minute Node shard3 a near-term
bound before routed planning, wait and aggregate overhead.
