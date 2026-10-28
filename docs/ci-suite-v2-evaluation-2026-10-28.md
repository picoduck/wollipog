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

v2 is a strict refinement. It calls v1's `selectGroups` first and **returns every v1 `full` and
`fast` result unchanged**, so every v1 fallback applies verbatim. That covers unknown, shared,
config, lockfile, CI and test-config inputs, empty/truncated/missing-base diffs, renames and
deletions, cross-package diffs, the security, persistence/migration, runner-execution and
approval rules, and missing mandatory inventory. A v2 selection is always a subset of v1's
(property-tested, and enforced again by the evaluator).

Only v1 `affected` (one ordinary web or control-plane package) is narrowed:

- **Graph.** The selector reads tested-tree blobs with `git cat-file` and parses them as text.
  It recognizes static and literal dynamic imports, `export … from`, `require`,
  `new URL("./x", import.meta.url)`, relative path literals, and same-package basenames such as
  `join(dir, "x.ts")`. It also recognizes package- or repository-relative path literals such as
  `join(WEB, "src/components/X.tsx")`, `@wollipog/*` workspace exports, and Vite page scripts
  (`<script src="/src/…">`). No tested code is imported or executed. Policy comes from the
  trusted base checkout, as in v1.
- **Selection.** A Node test or Chromium spec is kept when its dependency closure reaches a
  changed file. Browser specs also depend on every page named in their own code, and on the
  `apps/web/vite.config.ts` and Playwright configuration closures.
- **Opaque code.** The following make a file opaque:
  - computed module loading (`import(expr)`, `import.meta.glob`, `require(expr)`,
    `createRequire`, `eval`, `new Function`);
  - unreadable or oversized files;
  - unresolved relative module imports and unresolved page scripts;
  - test-side child processes and directory enumeration (`spawn`/`exec*`/`fork`/`Worker`,
    `readdir`/`glob`/`opendir`);
  - test-side file reads through a computed path under `src/` (template interpolation or a
    directory prefix).

  Anything that reaches opaque code is selected when the change is in the opaque file's scope:
  its own package plus every workspace package its text names. Root tooling (`scripts/`) is
  unscoped, so it is selected for any change.
- **Fallbacks within v2.** A spec with no mapped page is selected. A changed file absent from the
  graph, or a graph over its bounds (20,000 files, 96 MiB, 2 MiB per file), selects **full**.
- **Inert mentions.** A literal that only names a test file (a comment, message or fixture path)
  creates no edge. Page names create edges only from code under `apps/web/e2e/`.
- **Cost.** About 0.8 s wall time and 315 MB RSS for the full repository on the authoring host.
  This was measured locally, not in CI.

PR content, labels and author claims are not inputs. A head that edits selector or policy files
selects full under the trusted base policy. This is tested with a hostile head that throws if
executed.

## Sample and Data

- **Sampling rule (fixed before computing results).** Every PR merged into `main` from
  `2026-10-20T00:00:00Z` through `2026-10-28T22:25:30Z` whose squash diff touches at least one
  path outside `docs/` and root-level Markdown. No other filter and no hand selection:
  **160 PRs over 9 UTC dates.** Areas touched, where a PR can count in several: root 113,
  web 69, runner 61, control-plane 55, protocol 34, scripts 33, styles 25, CI 19, desktop 4,
  test-support 1.
- **PR diff.** `merge-base(main before merge, PR head)..PR head`, the same rule as v1. The PR
  head is the last head CI tested (143 PRs), or the final PR head for the 17 PRs with no
  completed PR run. The workflow-runs API records PR heads, not GitHub's test merge commits, so
  the tested tree is the squash result on `main`.
- **Merge-group diff.** The combined `base..group head` for all 231 recorded merge-group runs of
  the sampled PRs: 170 success, 30 failure, 31 cancelled.
- **Failure evidence.** 241 failed, cancelled or rerun attempts of the sampled PRs and their
  groups yielded 99 failed test jobs, whose logs were parsed for failing test files.
- **Timing.** Median job and step durations from a deterministic one-in-four sample of
  successful runs (89 job lists). Browser per-file weights come from
  `scripts/fixtures/browser-shard-profile.json`. Node per-file timing exists only for the 20
  slowest files (`ci-timing-v1` marker, run 40768626257).
- **API use.** 430 REST calls in total, cached outside the repository. No dispatch, rerun or
  ready-for-review was used.

Per-PR results are in [`ci-suite-v2-evaluation-2026-10-28.tsv`](ci-suite-v2-evaluation-2026-10-28.tsv).
Reproduce them with
`node --import tsx scripts/ci-suite-v2-evaluate.mjs --input <prepared-input.json>`; the script
header documents the input. The evaluator applies the selectors' mandatory-inventory fallback,
and its `modeledBrowser` output implements the timing model below.

## v1 Versus v2 Selection

| Population | v1 `full` | v1 `affected` | v2 `full` | v2 `affected` | v2 Extra Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: |
| 160 PR diffs | 156 | 4 | 156 | 4 | 0 |
| 231 merge-group diffs | 226 | 5 | 226 | 5 | 0 |

**Older trees.** The 70 PRs merged before 2026-10-22T09:55Z were tested on trees that predate a
current mandatory fast, API or critical file. Both selectors therefore require full
(`missing-mandatory-inventory`).

- From 2026-10-22 onward: **4 of 90 PRs** (4.4%, over 7 UTC dates) and 5 of 133 merge groups
  are `affected`.
- If that historical fallback were ignored (diff only), 5 more web PRs would be `affected`:
  #3491, #3554, #3556, #3572 and #3583. That is a sensitivity figure, not what either selector
  would have done.

Over all 160 PR diffs, v2 keeps **98.0%** of v1's file selections (225,174 of 229,783). On the
4 `affected` PRs, all web-only, v2 keeps **1,285 of 5,894 files (21.8%)**:

| PR | Chromium Files v2/v1 | Node Files v2/v1 | Modeled Browser Runner Minutes (v1: 155.1) | Modeled Browser Wall Minutes (v1: 31.0) |
| --- | ---: | ---: | ---: | ---: |
| #3660 | 142/281 | 161/1189 | 91.3 | 30.4 |
| #3661 | 137/281 | 154/1189 | 90.6 | 30.2 |
| #3662 | 143/281 | 155/1189 | 97.4 | 24.3 |
| #3751 | 187/285 | 206/1199 | 112.3 | 28.1 |

- **Opacity scoping.** Package-scoped opacity accounts for 1,140 of those deferrals; under
  global opacity they would stay selected. This is the main sensitivity in the rule set and is
  recorded per selection as `scopedOpaqueDeferred`.
- **Merge groups.** The 5 merge groups that v1 rated `affected` contain the same PRs and narrow
  identically. Merge groups nevertheless remain full by policy.

**Why v2 touches so few PRs.** All of v1's fallbacks still apply. These changed-path classes
forced full (a PR can have several):

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
| Missing mandatory inventory (historical tree) | 70 | — |

## Failures, Catch Rate, Misses and Exclusions

**v2 missed no failure.** The bar is low: every one of the 99 failed test jobs ran on a diff
that both versions send to full. Verdicts are identical for v1 and v2:

- 75 failing-file observations selected.
- 4 typecheck failures, always selected.
- 19 infrastructure exclusions.
- 1 with no test identity.

**Catch rate on real code failures.** Requested by #3638's staged-design model. The denominator
is first-attempt failures with test identity and no flake evidence, classified by these rules,
applied in order:

- **Excluded:** a later attempt of the same run passed; another run on the same SHA passed; a
  merge group whose identical PR change (equal `git patch-id`) later merged after a passing
  group; `automation-triggers.spec.ts` inside #3617's 00:00–02:15 UTC window; or every failing
  file also failing on at least 3 PRs in the window.
- **Kept as real:** typecheck failures, and test failures with none of that evidence (fixed by a
  later change).

That leaves **25 real failures from 16 PRs** (22 PR runs and 3 merge groups):

| Design | Caught |
| --- | ---: |
| v1 fixed fast candidate (`node-fast`, critical Chromium, typecheck) | **5/25 (20%)** |
| v1 policy (`selectGroups` with fallbacks) | 25/25 (100%) |
| v2 policy | 25/25 (100%) |
| Graph rule alone (all v1 fallbacks removed; counterfactual) | **25/25 (100%)** |

All 25 real failures ran on full-mode diffs, so the two policy rows are 100% by construction.
The informative rows are the fixed fast candidate (20%) and the graph alone (100%). The graph
connected every real failing test to its diff. Caught by the fixed fast candidate: typecheck in
#3484, #3556, #3614 and #3541, and `authentication-recovery.spec.ts` in #3727. Missed by it:
`browser-remaining` journeys in #3484, #3568, #3589 and #3744; `node-runner` in #3586 (×4 runs),
#3603, #3614 (×2), #3622 and #3729; `node-web` in #3540, #3615 and #3744; `node-other` in
#3677; `node-control-plane`/`node-web` in #3756.

The ≥3-PR rule can misclassify a real failure that recurs across PRs. It removed
`runner-channel.integration.test.ts` (#2601) and `bounded-child-process.test.ts` observations.

Excluded observations (74):

- **53 flaky or environment.**
  - 18 `automation-triggers.spec.ts`, mostly in the #3617 window.
  - 7 `runner-channel.integration.test.ts`.
  - 6 `claude-namespace-driver.integration.test.ts`.
  - 6 `bounded-child-process.test.ts`.
  - 3 `linux-cgroup.test.ts` (containment).
  - 2 `provider-home-lease.test.ts`.
  - 11 single observations, each a same-run rerun pass or an identical-change re-merge:
    `add-location`, `long-turn-opening-live`, `run-workflow`, `remote-access`,
    `machine-management`, `provider-home-lease-worker-protocol`, `earlier-activity-desktop`,
    `inline-media`, `command-inbox-projects`, `delegated-video-evidence-live` and
    `session-review-jobs`.
- **17 first-attempt infrastructure.**
- **3 non-first attempts.**
- **1 no test identity.**

**Infrastructure exclusions, listed individually.** All were Playwright system-dependency
installs that timed out after 6 minutes; no test ran.

| Attempt Group | Runs |
| --- | --- |
| WebKit, PR runs | 39860802999/1, 39865706977/1, 39910262077/1, 39910425372/1 and /2, 39953739975/1 and /2, 40534148825/1 |
| WebKit, merge groups | 39868656882/1, 39957826226/1, 40012747402/1, 40040728855/1 |
| Chromium shards | 39866598899/1, 39947637261/1, 39953117531/1, 39953739975/1 (shards 3 and 4), 40012747402/1, 40024026119/1 |

No test identity: 39375862997/1 (#3495 group), a shard that failed with no failed step recorded.

**Counterfactual misses over all identified failures, flaky ones included.** With every v1
fallback removed, the graph would have deferred a failing file in **27 of 75** observations.
None shows evidence of a diff-caused regression:

| Failing File | Count | Evidence |
| --- | ---: | --- |
| `automation-triggers.spec.ts` | 11 | All between 00:16 and 01:41 UTC (#3617 window). The file failed on 16 PRs, and each PR later passed. |
| `claude-namespace-driver.integration.test.ts` | 5 | Failed on 6 PRs on 2026-10-20. Same-SHA reruns passed; later groups passed. |
| `provider-home-lease.test.ts` | 2 | #3678 and #3741 groups. The identical change merged after later groups passed. |
| `bounded-child-process.test.ts` | 1 | Failed on 4 PRs. |
| Singletons: `add-location`, `run-workflow`, `earlier-activity-desktop`, `command-inbox-projects` (#3517 symptom), `session-review-jobs` | 5 | Identical change merged after a later passing group. |
| Singletons: `machine-management`, `inline-media`, `delegated-video-evidence-live` | 3 | Same-SHA reruns passed. |

A reduced PR suite would push such flaky failures to the merge group: the same queue cost, with
later feedback for the author.

**Historical regression replays** (`ci-suite-selection-v2.test.mjs`, current tree):

- **#3617.** A change to `src/e2e/automations-main.tsx` selects `automation-triggers.spec.ts`.
- **#3517.** The fixture's `CommandInbox.tsx` path never existed, so v2 selects **full**
  (`graph-missing-changed-file`). Replaying the file #3751 actually changed (`SessionDetail.tsx`)
  selects `command-inbox-projects.spec.ts`.
- **#2601.** `runner-channel.integration.test.ts` stays in `node-fast`, which v2 always selects.
- **#2452.** A change to `ci.yml` selects full.
- **Package-relative source read** (from review). Changing `AgentSessionDiscoveryDialog.tsx`
  selects `forced-colors-focus.test.ts`, which reads that component's source text.

## Savings: Measured Versus Modeled, in PR Runner-Minutes

**Measured.** Median durations over the sampled successful PR runs:

| Job | Median |
| --- | --- |
| Chromium shard (×5) | 31.0 min (test step 29.2) |
| Checks | 27.9 min (Node step 24.4) |
| WebKit | 1.2 min |
| Advisory shadow | 0.2 min |
| Aggregator and Windows detection | 0.2 min combined |

A full PR run therefore occupies about **184.5 runner-minutes**, 155.1 of them in browser shards.

**Modeled.** No reduced run was executed. Browser time scales the observed medians by the
selected share of profile weight. Shards needed are `ceil(5 × share)`, and each pays the observed
per-job overhead. The evaluator's `browserMinutes` implements this model.

| Scope | Browser Runner-Minutes Saved per PR Run | Additional Node Bound | Share of a 184.5-Minute PR Run |
| --- | ---: | ---: | ---: |
| v2, per **affected** PR run (4 PRs) | **57.2** (228.7 total) | ≤ 20.9 | 31% (≤ 42% with the Node bound) |
| v2, averaged over all 160 sampled PRs (final run each) | **1.4** | ≤ 0.5 | 0.8% |
| v2, averaged over the 90 post-inventory PRs | 2.5 | ≤ 0.9 | 1.4% |
| Graph rule alone (counterfactual; all fallbacks removed) | **81.0** (12,964 total; median browser wall 17.5 vs 31.0) | not modeled | 44% |

- **Node bound.** Node narrows to 14.2% of files on affected PRs. Only the 20 slowest Node files
  have timings, and concurrency makes wall time track the slowest selected files, so the Node
  figure is an upper bound, not a prediction.
- **Comparison with #2674.** These figures are per PR run and compare directly with #2674's
  per-PR runner-minutes. A PR with several CI runs saves this amount on each run of an affected
  head.
- **Not a speedup today.** These are not CI speedups. #3630's routing reduces work only for v1
  `fast`. Even v1 `affected` runs the complete contract today, so **v2 saves nothing until a
  separately approved executor runs `affected` selections.**

## Proposed Shadow Rollout (Not Implemented Here)

1. **Emit.** Add one advisory step after v1's selection in the existing `Suite Selection Shadow
   (Advisory)` job: `node scripts/ci-suite-selection-v2.mjs --base … --head … --change-head …`.
   - It uses the same trusted-base checkout, emits `ci-selection-v2` and continues on error.
   - It adds no new job, runner admission or aggregator edge.
   - It costs about 1 s of CPU inside an existing job of about 12 s, plus the blob reads.
   - This is the only `ci.yml` change. Coordinate it with the #3637 campaign, which owns
     adjacent workflow edits.
2. **Collect.** Teach `merge-queue-wait-report.mjs` to retain one bounded `ci-selection-v2`
   record per job through `parseSelectionV2`, separately from v1. Teach
   `ci-suite-shadow-report.mjs` to produce a v2 comparison.
3. **Separate cohorts.** v2 records parse only as v2, and v1 records only as v1 (tested). Each
   version's comparisons, gaps and exclusions are reported separately.
4. **Fix cohort keying first.** v1 cohorts key on `suiteId/policyId`, but `suiteId` hashes the
   test inventory and every CI input. Across the 170 successful merge-group trees it took
   **158 distinct values**, and the longest run under one value was 4 groups. A 30-change cohort
   under one `suiteId` is therefore practically unreachable for v1 as built. A v2 cohort should
   key on `(suiteVersion, policyId)` and keep `suiteId`, `inventoryId` and `graphId` as per-sample
   compatibility evidence.
5. **Readiness denominator.** Only comparisons where v2 actually narrows (`v1Mode: affected`)
   test v2's rules. Everything else equals v1 by construction.
   - Since the mandatory inventory existed, the observed rate is about one such PR every
     1.75 days (4 in 7 days) and 5 merge groups in 133.
   - Reaching **30 narrowed PR comparisons across at least five working days** therefore takes
     about **7–8 weeks of natural traffic**.
   - Every deferred-file failure in the matching full PR or merge-group run is investigated
     individually, as here.
6. **Interactions.**
   - **#3630 routing (`CI_PR_SUITE_ROUTING`).** Unchanged: it consumes v1 and reduces only on
     `fast`. Executing v2 `affected` needs a new approved routing contract: per-file Node lists,
     selected Chromium specs sharded by the existing profile, and rollback.
   - **#3637 merge-group gate (`CI_MERGE_GROUP_GATE`).** Continues to run v1 over the combined
     diff and must not consume v2 records.
   - **Merge groups.** Stay complete.

**Remaining:** shadow emission and collection, the cohort-key correction, natural shadow
traffic, and any fallback relaxation. The graph-only rows show what relaxation could buy. Each
of these needs its own issue, review, and (for live policy) human approval.
