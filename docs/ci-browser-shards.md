# Browser Shard Profile and Redistribution

Refs #3628 and tracker #3625. The [October 22 baseline](ci-baseline-2026-10-22.md)
found shard-5 execution p50/p90 of 35.1/38.2 minutes against shard-3's 25.9/27.6.
Passing groups' longest/shortest ratio was 1.54/1.81. These are historical
observations, not a measured benefit of this redistribution.

## Timing Evidence

[The profile](../scripts/fixtures/browser-shard-profile.json) uses only the bounded
projection from `scripts/ci-browser-timing-reporter.mjs`, collected by
`scripts/merge-queue-wait-report.mjs`. No workflow was dispatched or rerun to obtain it.
The natural prerequisite PR run was
[39866598899](https://github.com/picoduck/wollipog/actions/runs/39866598899), created
2026-10-22T22:40:04Z. Collection window: **[2026-10-22T22:40:00Z,
2026-10-22T22:41:00Z)**. Its head was `9a57f6a4efcf5418f4eeb66731ab96a45d9322cf`;
the actual tested merge tree was `8183eb56c4beb1ebfa4bfcc2693591e8d8a8cfbb`.
Its e2e/config inventory matches prerequisite main `b1a90aad1`.

| Shard | Executed Attempt | Job ID | Development Seconds | Test Attempts | Production Seconds |
| --- | --- | --- | --- | --- | --- |
| 1 | 3 | 120202516638 | 1817 | 771 | 99 |
| 2 | 1 | 120130235621 | 1531 | 705 | 0 |
| 3 | 1 | 120130235688 | 1615 | 743 | 0 |
| 4 | 1 | 120130235547 | 1643 | 725 | 0 |
| 5 | 1 | 120130235646 | 1600 | 731 | 0 |

These are **five executed jobs across attempts of one natural run**, not five
independent runs or an all-green first attempt. Shard 1's earlier attempts failed
before tests. The reporter contexts establish which attempt actually executed;
copied rerun job records are excluded. All 3675 development test attempts in these
projections comprise 3546 passes and 129 skips, without test retries or failures.
Production's 55 tests also passed.
This does not establish the workflow's infrastructure retry rate or a long-term
failure/flaky rate. The report deliberately leaves rerun consumption unmeasured;
the phase rows in the profile are sizing evidence, not extra independent consumption.

Reproduce the safe collection:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events \
  --since 2026-10-22T22:40:00Z --until 2026-10-22T22:41:00Z \
  --timing-job 120202516638 --timing-job 120130235621 \
  --timing-job 120130235688 --timing-job 120130235547 \
  --timing-job 120130235646 --json > browser-profile-source.json
```

Resolve file IDs by SHA-256 of `apps/web/e2e/<file>` without a newline at the tested
revision. The profile retains the top 20 measured files per shard and three test
identity/duration examples per shard, with original hashed IDs and context. The
100 measured files account for 5876.391 seconds. Total development-step time was
8206 seconds. The remaining 180 files use the rounded residual mean:
`ceil((8206000 - 5876391) / 180) = 12943ms`. This estimate also absorbs test-runner
overhead; it is not a claim that all unprofiled files took the same time.

The expensive files include `command-inbox-projects.spec.ts` (297.859s),
`agent-questions-live.spec.ts` (228.338s), `conversation-steering.spec.ts`
(175.227s), `agent-questions.spec.ts` (150.039s), and `settings-rows.spec.ts`
(132.746s). File count and test count alone miss these duration differences.

## Assignment and Isolation

`playwright.ci.config.ts` assigns the live default development file inventory to
five projects, longest estimated file first, always choosing the least-loaded
project. Shard 1 starts with 99 seconds for its measured production build/smoke.
Unprofiled/new files receive the residual weight and are always assigned. Deleted
files disappear from discovery; their historical evidence stays historical.

No file is split. Shared `beforeAll`/`afterAll` fixtures and the explicitly serial
campaign-status, walkthrough and long-turn-opening suites stay intact. Each job
still has one worker, `fullyParallel: false`, CI retries and `failOnFlakyTests`.
Development/production ports remain distinct; suites run sequentially on the
same worktree. Strict ports and `reuseExistingServer: false` remain required.
Project names do not change existing snapshot paths. The opt-in synthetic
artifact probe runs on each project, through the unchanged #3046 allowlisted
sanitizer and upload steps; ordinary traffic runs the complete disjoint inventory.

The profile's estimated complete loads are **1665.186 / 1661.086 / 1652.358 /
1663.022 / 1663.479 seconds**: longest/median **1.0013**, including production.
The source development steps plus production total 8305 seconds, and the model
retains that work (within residual rounding). This is a scheduling forecast, not
an observed speedup, reduced runner consumption, or a new job deadline.

`scripts/browser-shards.test.mjs` compares every test identity in the five projects
with Playwright's unpartitioned discovery, rejects duplication and splits within
a file, checks newly added unprofiled files, reconciles profile hashes and phases,
and verifies production, WebKit and conditional Windows inventory routes. The
workflow contract pins all five matrix entries and their exact project-selection
command. Production remains shard-1-only; WebKit remains independent; Windows
still compares the full settings-rows spec when the existing diff detector requires it.

## Budget and Natural-Run Delivery

The [finite budget](ci-browser-budget.md) remains **59 minutes**, without raising
any deadline. This profile measured other setup at 19–31 seconds and cleanup at
3–4 seconds. The projected non-install envelope is
`ceil((1665.186 + 31 + 4) / 10) * 10 = 1710s`. Retain the larger historical
2020-second envelope until post-change full-run phases justify tightening it:
`720 + max(2020, 1710) + 105 + 480 + 180 = 3505s <= 3540s`.
This explicitly includes production, both exclusive install-path attempts,
enforcement, failure diagnostics and reserve. Queue wait is excluded. Cold-cache
save and enforcement uncertainty remain as documented in the existing budget.

WebKit and Windows deadlines remain 20 and 25 minutes. The baseline measured
WebKit tests at 0.22/0.27 minutes p50/p90; this redistribution adds no work to that
job. No conditional Windows execution was observed in the source run, so its
post-change phase budget is unmeasured. No faster Windows or WebKit claim is made.

After merge, use the same collector with explicit half-open windows starting at
the merge timestamp, without generating traffic. Compare identified passing
natural runs with the baseline, separately by event and workload: longest/median
complete shard path, longest/shortest for baseline compatibility, summed elapsed
runner-minutes, runner wait, workflow failure/retry rates and reporter retry-only
test counts. Exclude copied retry jobs and preserve missing evidence. Report
production, WebKit and conditional Windows execution separately. Recalculate
phase margins from actual redistributed runs before reducing the budget.

**Undelivered until those runs exist:** a demonstrated reduction in the longest
critical path and its natural-run resource, wait and reliability comparison.
Local/profile evidence and a passing PR/merge group do not establish that trend.
Release the campaign ready slot after merge; a later measurement pass can finish
this criterion without occupying the slot or manufacturing samples.
