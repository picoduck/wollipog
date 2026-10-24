# PR Assurance Pre-Activation Baseline

Refs #3630. Recomputed offline on October 24, 2026, using the existing
`combineReports`, `eventSummary` and `quantile` exports from
`scripts/merge-queue-wait-report.mjs` and the committed
[October 22 raw baseline](ci-baseline-2026-10-22.json). No CI run was created,
rerun or cancelled for measurement. The window is
**[2026-10-20T00:00:00Z, 2026-10-22T00:00:00Z)**. The source collection was made
at `2026-10-22T22:37:00.647Z`. Its pagination, attempt and removal truncation
flags are all false.

| Event / Attempt | Records | Pass | Fail | Cancel | Skip | Passing Required p50 / p90 (min) | Passing Runner p50 / p90 (min) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR / First | 175 | 82 | 8 | 82 | 3 | 57.28 / 214.07 | 173.43 / 185.52 |
| PR / Rerun | 7 | 7 | 0 | 0 | 0 | Unmeasured | Unmeasured |
| Merge Group / First | 75 | 65 | 6 | 4 | 0 | 40.22 / 64.10 | 172.98 / 184.50 |
| Main Push / First | 58 | 16 | 1 | 41 | 0 | 36.53 / 78.90 | 175.95 / 183.42 |

There are 315 attempt records: 308 distinct first attempts and seven reruns.
PR first-attempt cancellations are **82/175 (46.86%)**; merge-group cancellations
are **4/75 (5.33%)**. Do not assign these cancellations a cause from the conclusion
alone. Passing PR critical-path runner wait p50/p90 is **23.83/192.18 min**;
passing merge-group wait is **6.48/31.90 min**. These passing cohorts have complete
timing denominators of 82 and 65 respectively.

All-state **measured elapsed runner minutes** total 21,987.70 for PR first
attempts, 12,652.38 for merge groups and 6,618.52 for main pushes. Cancelled/missing
job timing and rerun execution remain incomplete; these totals are lower bounds,
not billing or per-passing-run costs. The 56 measured surviving queue episodes
have queue-entry-to-merge p50 **110.73 min**, p90 **310.67 min**, maximum
**336.48 min**. This excludes ejected/unmerged attempts and is distinct from
merge-group CI creation-to-required-result latency.

Reproduce the cohort table directly:

```sh
node scripts/merge-queue-wait-report.mjs --input docs/ci-baseline-2026-10-22.json
```

The baseline predates suite selection, Node reordering, duration-based browser
assignment and package-cache changes. It has no compatible trusted-selection
records, so it cannot certify the fast subset or isolate routing's causal effect.
Retain suite/workflow/tested identities and workload/capacity changes in later
comparisons. Do not mix outcome classes or average daily percentiles.

The [proposed contract](ci-pr-assurance.md) remains inactive. Disabled routing adds
zero executed jobs. Proposed fast routing removes four Chromium jobs and adds one
routing job, net **three fewer jobs**. Actual standalone fast runner minutes,
critical-path latency, plan overhead, queue effect and cancellation changes are
**unmeasured**. The existing #3629 local/profile measurements are contextual
phase evidence; their sum is not a parallel-CI speedup estimate.

**Remaining acceptance criterion:** after separately approved human activation,
collect an explicit natural post-activation window and use the existing report's
`--input post.json --baseline docs/ci-baseline-2026-10-22.json --json` comparison.
Report sample counts, selection compatibility and all gaps. There is no
post-activation sample or measured gain in this delivery.
