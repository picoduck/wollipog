# Code-Aware Selection Prototype (`fast-required-v2`) and Offline Evaluation

Refs #3629, tracker #3625. **Advisory prototype only.** Nothing in CI calls the v2 selector.
No workflow, ruleset, required check, repository variable, aggregation edge or job admission
changes. `fast-required-v1` keeps its identity, inventory, shadow job, cohort records and its
30-change/five-working-day comparison. Merge groups continue to run complete validation.
Activating any lighter requirement needs a separately approved policy change.

## What v2 Is

| Item | v1 | v2 Prototype |
| --- | --- | --- |
| Modules | `ci-suite-policy.mjs`, `ci-suite-selection.mjs` | `ci-suite-policy-v2.mjs`, `ci-suite-selection-v2.mjs` (v1 files untouched) |
| Identity | `fast-required-v1`, policy version 1, `ci-selection-v1` | `fast-required-v2`, policy version 2, `ci-selection-v2`, record `version: 2` |
| `policyId` | v1 policy, selector, profile | v1 and v2 policy and selector files plus profile |
| Extra Identity | — | `graphId`: hash of every graph edge and opaque scope |
| Outcomes | `fast`, `affected` (whole Node/Chromium closure), `full` | Identical to v1 except `affected`, which is narrowed per file |

v2 is a strict refinement: it calls v1's `selectGroups` first and **returns every v1 `full` and
`fast` result unchanged**, so every v1 fallback applies verbatim. That covers unknown, shared,
config, lockfile, CI and test-config inputs, empty/truncated/missing-base diffs, renames and
deletions, cross-package diffs, the security, persistence/migration, runner-execution and
approval rules, and missing mandatory inventory. A v2 selection is always a subset of v1's
(property-tested, and enforced again by the evaluator). Only v1 `affected` (one ordinary
web or control-plane package) is narrowed:

- **Graph.** The selector reads tested-tree blobs with `git cat-file` and parses them as text:
  static/dynamic literal imports, `export … from`, `require`, `new URL("./x", import.meta.url)`,
  relative path literals, same-package basenames such as `join(dir, "x.ts")`, `@wollipog/*`
  workspace exports, and Vite page scripts (`<script src="/src/…">`). No tested code is
  imported or executed. Policy comes from the trusted base checkout, as in v1.
- **Selection.** A Node test or Chromium spec is kept when its dependency closure reaches a
  changed file. Browser specs also depend on every page named in their own code and on
  `apps/web/vite.config.ts` and the Playwright configuration closures.
- **Conservative Rules.**
  - Computed loading (`import(expr)`, `import.meta.glob`, `require(expr)`, `createRequire`,
    `eval`, `new Function`), unreadable or oversized files, unresolved relative module imports
    and unresolved page scripts all make a file **opaque**.
  - Test-side child processes and directory enumeration (`spawn`/`exec*`/`fork`/`Worker`,
    `readdir`/`glob`/`opendir`) also make a file opaque.
  - Whatever reaches opaque code is selected when the change is in the opaque file's scope:
    its own package plus every workspace package its text names. Root tooling (`scripts/`) is
    unscoped, so it is selected for any change.
  - A spec with no mapped page is selected. A changed file absent from the graph, or a graph
    over its bounds (20,000 files, 96 MiB, 2 MiB per file), selects **full**.
- **Inert Mentions.** A literal that only names a test file (a comment, message or fixture
  path) creates no edge. Page names create edges only from code under `apps/web/e2e/`.
- **Cost.** The selector takes about 0.8 s wall time and about 315 MB RSS for the full
  repository on the authoring host. This was measured locally, not in CI.

PR content, labels and author claims are not inputs. A head that edits selector or policy files
selects full under the trusted base policy. This is tested with a hostile head that throws if
executed.

## Sample and Data

- **Sampling rule (fixed before computing results).** Every PR merged into `main` from
  `2026-10-20T00:00:00Z` through `2026-10-28T22:25:30Z` whose squash diff touches at least one
  path outside `docs/` and root-level Markdown. No other filter and no hand selection:
  **160 PRs over 9 UTC dates.**
- **Areas touched** (a PR can count in several): root 113, web 69, runner 61, control-plane 55,
  protocol 34, scripts 33, styles 25, CI 19, desktop 4, test-support 1.
- **PR diff.** `merge-base(main before merge, PR head)..PR head`, the same rule as v1. The PR
  head is the last head CI tested (143) or, for 17 PRs with no completed PR run, the final PR
  head. The workflow-runs API records PR heads, not GitHub's test merge commits, so the
  tested tree is the squash result on `main`.
- **Merge-group diff.** The combined `base..group head` for all 231 recorded merge-group runs
  of the sampled PRs: 170 success, 30 failure, 31 cancelled.
- **Failure evidence.** 241 failed/cancelled/rerun attempts of sampled PRs and their groups,
  99 failed test jobs, logs parsed for failing test files.
- **Timing.** Median job and step durations from a deterministic one-in-four sample of
  successful runs (89 job lists). Browser per-file weights come from
  `scripts/fixtures/browser-shard-profile.json`. Node per-file timing exists only for the
  20 slowest files (`ci-timing-v1` marker, run 40768626257).
- **API use.** 430 REST calls in total, cached under `~/.cache/wollipog-ci-ws2/` (not in the
  repository). No dispatch, rerun or ready-for-review was used.

Per-PR results are in [`ci-suite-v2-evaluation-2026-10-28.tsv`](ci-suite-v2-evaluation-2026-10-28.tsv).
Re-run the evaluation with:
`node --import tsx scripts/ci-suite-v2-evaluate.mjs --input <prepared-input.json>`.
The input format is documented in the script header.

## v1 Versus v2 Selection

| Population | v1 `full` | v1 `affected` | v2 `full` | v2 `affected` | v2 Extra Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: |
| 160 PR diffs | 151 | 9 | 151 | 9 | 0 |
| 231 merge-group diffs | 221 | 10 | 221 | 10 | 0 |

Over all 160 PR diffs, v2 keeps **95.7%** of v1's file selections (219,936 of 229,783). On the
9 `affected` PRs, all web-only, v2 keeps **3,039 of 12,886 files (23.6%)**:

| PR | Chromium Files v2/v1 | Node Files v2/v1 | Modeled Browser Runner Minutes (v1: 155.1) | Modeled Browser Wall Minutes (v1: 31.0) |
| --- | ---: | ---: | ---: | ---: |
| #3491 | 254/261 | 376/1098 | 152.1 | 30.4 |
| #3554 | 20/272 | 110/1124 | 17.6 | 17.6 |
| #3556 | 163/272 | 147/1131 | 106.5 | 26.6 |
| #3572 | 163/277 | 151/1139 | 104.5 | 26.1 |
| #3583 | 216/278 | 224/1140 | 131.3 | 26.3 |
| #3660 | 142/281 | 155/1189 | 91.3 | 30.4 |
| #3661 | 137/281 | 148/1189 | 90.6 | 30.2 |
| #3662 | 143/281 | 149/1189 | 97.4 | 24.3 |
| #3751 | 167/285 | 174/1199 | 104.5 | 26.1 |

- **Opacity scoping.** Package-scoped opacity accounts for 2,421 of those deferrals; under
  global opacity they would stay selected. This is the main sensitivity in the rule set and is
  recorded per selection as `scopedOpaqueDeferred`.
- **Merge groups.** The 10 merge groups that v1 rated `affected` contain the same PRs and narrow
  identically. Merge groups nevertheless remain full by policy.

**Why v2 touches only 6% of PRs.** All of v1's fallbacks still apply. Changed-path classes forcing
full (a PR can have several):

| Trigger | PRs | Sole Trigger |
| --- | ---: | ---: |
| Security/approval path rule | 78 | 8 |
| Markdown outside the prose allowlist | 77 | 1 |
| Runner source | 60 | 4 |
| Cross-package source | 49 | — |
| Browser spec or e2e fixture | 44 | 5 |
| Persistence path rule | 41 | 1 |
| Other unknown input (assets, JSON, HTML, `.mjs` outside `src`) | 37 | 6 |
| Shared package (`packages/*`) | 36 | 1 |
| CI or root tooling | 31 | 2 |
| Stylesheet | 25 | 0 |
| Shared source or fixture | 24 | 0 |
| Manifest or config | 18 | 3 |
| Renamed or deleted | 13 | 0 |

## Failures, Misses and Exclusions

**v2 missed no failure.** The bar is low: 98 of 99 failed test jobs ran on diffs both versions
send to full, and the one `affected` observation selected its failing file. Every verdict is
the same for v1 and v2:

- 75 failing-file observations selected.
- 4 typecheck failures, always selected.
- 19 infrastructure exclusions.
- 1 with no test identity.

**Infrastructure exclusions, listed individually.** All were Playwright system-dependency
installs that timed out after 6 minutes; no test ran.

| Attempt Group | Runs |
| --- | --- |
| WebKit, PR runs | 39860802999/1, 39865706977/1, 39910262077/1, 39910425372/1 and /2, 39953739975/1 and /2, 40534148825/1 |
| WebKit, merge groups | 39868656882/1, 39957826226/1, 40012747402/1, 40040728855/1 |
| Chromium shards | 39866598899/1, 39947637261/1, 39953117531/1, 39953739975/1 (shards 3 and 4), 40012747402/1, 40024026119/1 |

No test identity: 39375862997/1 (#3495 group), a shard that failed with no failed step recorded.

**Counterfactual graph recall (not a policy).** Apply the graph rule with every v1 fallback
ignored, then check each recorded failing file. The graph would have deferred a failing file in
**27 of 75** observations. Each was investigated; **none shows evidence of a diff-caused
regression**:

| Failing File | Count | Evidence |
| --- | ---: | --- |
| `automation-triggers.spec.ts` | 11 | All between 00:16 and 01:41 UTC: the #3617 UTC-midnight window. The file failed on 16 branches. Each PR later passed. |
| `claude-namespace-driver.integration.test.ts` | 5 | Failed on 6 unrelated branches on 2026-10-20. Same-SHA reruns passed (#3543, #3545, #3557). Groups #3508 and #3540 passed later. |
| `provider-home-lease.test.ts` | 2 | Groups #3678 and #3741 (one changed file, not related). Both PRs' later groups passed. |
| `bounded-child-process.test.ts` | 1 | Failed on 4 branches. #3545 later passed. |
| Singletons: `add-location`, `run-workflow`, `earlier-activity-desktop`, `command-inbox-projects` (#3517 symptom), `session-review-jobs` | 5 | Merge groups that passed later for the same PR. `earlier-activity-desktop` failed in the #3617 window. |
| Singletons: `machine-management`, `inline-media`, `delegated-video-evidence-live` | 3 | Same-SHA reruns passed. |

So the graph did not miss a reproducible failure in this sample. It did defer flaky or
time-dependent failures, which a reduced PR suite would push to the merge group: same cost
to the queue, later feedback for the author.

**Historical regression replays** (`ci-suite-selection-v2.test.mjs`, current tree):

- **#3617.** A change to `src/e2e/automations-main.tsx` selects `automation-triggers.spec.ts`.
- **#3517.** The fixture's `CommandInbox.tsx` path never existed, so v2 selects **full**
  (`graph-missing-changed-file`). Replaying the file #3751 actually changed (`SessionDetail.tsx`)
  selects `command-inbox-projects.spec.ts`.
- **#2601.** `runner-channel.integration.test.ts` stays in `node-fast`, which v2 always selects.
- **#2452.** A change to `ci.yml` selects full.

## Savings: Measured Versus Modeled

**Measured.** Median durations over the sampled successful runs:

| Job or Step | Median |
| --- | --- |
| Chromium shard job (×5) | 31.0 min (test step 29.2) |
| Checks job | 27.9 min (Node step 24.4) |
| WebKit job | 1.2 min |
| Advisory shadow job | 11–12 s |

A full PR run therefore occupies about **155 browser runner-minutes**.

**Modeled.** No reduced run was executed. Browser time scales observed medians by the selected
share of profile weight. Shards needed are `ceil(5 × share)`, each paying the observed per-job
overhead.

- **v2 as prototyped.** About **500 browser runner-minutes** saved across the 9 affected PRs'
  final runs, out of 1,396 (36%). That is roughly 56 minutes per affected PR, or about 0.4% of
  all sampled browser minutes. Wall time drops from 31.0 to 17.6–30.4 minutes. Node narrows to
  15.8% of files on affected PRs. Because only the 20 slowest Node files have timings, the
  Node-step saving (at most 20.5 minutes per affected PR) is an **upper bound, not a
  prediction**: concurrency makes wall time track the slowest selected files.
- **Graph-only counterfactual** (all v1 fallbacks removed, not proposed as-is). About
  **13,002 of 24,813** browser runner-minutes (52%) and a median browser wall of 17.5 minutes.
  This bounds what relaxing fallbacks could buy. It comes with the 27 deferred flaky
  observations above.

These are not CI speedups. #3630's routing reduces work only for v1 `fast`. Even v1 `affected`
runs the complete contract today, so **v2 saves nothing until a separately approved executor
runs `affected` selections.**

## Proposed Shadow Rollout (Not Implemented Here)

1. **Emit.** Add one advisory step after v1's selection in the existing `Suite Selection Shadow
   (Advisory)` job: `node scripts/ci-suite-selection-v2.mjs --base … --head … --change-head …`.
   - It uses the same trusted-base checkout, emits `ci-selection-v2` and continues on error.
   - It adds no new job or runner admission, and no edge into the aggregator.
   - It costs about 1 s of CPU inside an existing job of about 12 s, plus the blob reads.
   - This is the only `ci.yml` change. It must be coordinated with the #3637 campaign, which
     owns adjacent workflow edits.
2. **Collect.** Teach `merge-queue-wait-report.mjs` to retain one bounded `ci-selection-v2`
   record per job through `parseSelectionV2`, separately from v1. Teach
   `ci-suite-shadow-report.mjs` to produce a v2 comparison.
3. **Separate cohorts.** v2 records parse only as v2 and v1 records only as v1 (tested). Each
   version's comparisons, gaps and exclusions are reported separately.
4. **Fix cohort keying first.** v1 cohorts key on `suiteId/policyId`, but `suiteId` hashes the
   test inventory and every CI input. Across the 170 successful merge-group trees it took
   **158 distinct values**, and the longest run under one value was 4 groups. A 30-change cohort
   under one `suiteId` is therefore practically unreachable for v1 as built. A v2 cohort should
   key on `(suiteVersion, policyId)` and keep `suiteId`, `inventoryId` and `graphId` as per-sample
   compatibility evidence.
5. **Readiness denominator.** Only comparisons where v2 actually narrows (`v1Mode: affected`)
   test v2's rules. Everything else equals v1 by construction. The observed rate is about one
   such PR per day (9 in 9 days) and about one merge group per day (10 of 231). Reaching
   **30 narrowed PR comparisons across at least five working days** therefore takes about
   **six weeks of natural traffic**. Every deferred-file failure in the matching full PR or
   merge-group run is investigated individually, as here.
6. **Interactions.**
   - **#3630 routing (`CI_PR_SUITE_ROUTING`).** Unchanged: it consumes v1 and reduces only on
     `fast`. Executing v2 `affected` needs a new approved routing contract: per-file Node
     lists, selected Chromium specs sharded by the existing profile, and rollback.
   - **#3637 merge-group gate (`CI_MERGE_GROUP_GATE`).** Continues to run v1 over the combined
     diff and must not consume v2 records.
   - **Merge groups.** Stay complete.

**Remaining:** shadow emission and collection, the cohort-key correction, natural shadow traffic,
and any fallback relaxation. Each needs its own issue, review, and (for live policy) human
approval.
