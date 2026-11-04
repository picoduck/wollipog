# PR Browser Routing Measurements

Refs #3630. Routing remains inactive. Benchmark dispatches used: **0/4**.
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

Pending after candidate review and CI. Report the same job rows, result latency,
actual run/job IDs, half-open UTC window, elapsed runner-minutes, runner wait and
timestamp-conflict allocation. Keep inconsistent jobs explicitly unmeasured and
report test-step execution separately. The benchmark has its own result context,
retains full Node/platform coverage, and omits live PR planning overhead. No
15-minute achievement, savings or natural post-activation effect is claimed yet.
