# Low-Risk Fallback Candidate (`fast-required-v3`) and Offline Replay

Refs #3787, #3629, tracker #3625. **Shadow-only candidate.** Nothing in CI calls it. It gates,
skips or reduces no required job, and no workflow, ruleset, variable or required check changes.
v1 and v2 keep their identities, records and cohorts. Merge groups keep complete validation.
Emitting v3 records in CI is a separate, deferred step, and activation is a human assurance
decision (see [Activation Proposal](#activation-proposal)).

## What v3 Changes

v3 starts from v2 and relaxes exactly three v1 fallbacks:

| Relaxed Class | Rule |
| --- | --- |
| Markdown | `.md`/`.mdx` files become graph nodes. Literal path references link them (relative, package- or repository-relative, or same-package basename). |
| Browser Spec or E2E Fixture | A changed file under `apps/web/e2e/` selects itself and every spec that reaches it. |
| Data or Asset | JSON, text, TSV/CSV, images, fonts, video and web manifests become graph nodes linked by literal paths; `/`-rooted references resolve under `apps/web/public` and `apps/web`. A spec depends on its Playwright `<spec>-snapshots/` directory. A changed data file **nothing references selects full** (`unreferenced-data-or-asset`). |

Every other v1 rule is kept:

- the security/approval, persistence/migration and runner-execution path rules, even for a relaxed
  file type;
- CI, selector, root tooling and `scripts/`;
- `.agents/` and shipped `skills/`;
- every path under `packages/`, and under apps other than web, control-plane and runner (for
  example `apps/desktop`), which v1 treats as shared inputs;
- manifests and configuration: `package.json`, lockfiles, `tsconfig*`, `*.config.*`, Playwright
  configs;
- stylesheets and cross-package source;
- renames/deletions, and empty, incomplete or missing-base diffs;
- missing mandatory inventory.

v1's reviewed prose allowlist keeps its v1 `fast` handling. The source graph keeps v2's own size
bound. If only the data layer is over bound, v2's outcomes are preserved and any relaxed diff
selects full.

The data layer only adds leaf nodes and edges into them. HTML pages stay v2 nodes, linked only
from browser-spec code, so no new path through the graph appears. A relaxed path outside any
workspace package (for example `docs/`) puts every opaque file in scope, since a test that
enumerates directories could read it.

**Identity.** v3 has `suiteVersion: fast-required-v3`, `policyVersion: 3`, marker
`ci-selection-v3`, record `version: 3` and its own `policyId` (v1, v2 and v3 policy/selector files
plus the profile). Records carry `v1Mode`, `v2Mode`, `v3Reason`, `relaxedCount` and
`relaxedClasses`.

Under #3795's policy-identity keying, v3 forms its own cohorts. The v1, v2 and v3 parsers each
reject the other versions' records (tested), so no result under one version can certify another.

**Corrected invariant.** #3787's first criterion ("a superset of v2's selection") cannot hold:
v2 ⊆ v1 already, and v3 must narrow diffs v2 sends to full. The campaign's implementation
decision approved this correction; the issue body is unchanged and this PR uses "Refs". Each
property is tested on every evaluated diff:

1. v3 ⊆ v2 ⊆ v1.
2. v3 equals v2 exactly when no changed path is relaxed.
3. v3 keeps every file the graph rule selects for the changed files, and every v1 always-selected
   group. On v1 `fast` (prose-only) diffs v3 equals v2 by property 2 instead; see
   [v1 Prose Allowlist Finding](#v1-prose-allowlist-finding).
4. Every non-relaxed fallback still selects the complete contract.

The offline evaluator also refuses any replayed diff on which v3 selects outside v2, or differs
from v2 without a relaxed path. During development these checks found two defects, both fixed:

- **Page-name edge leak.** HTML pages named in non-spec code became edges into the web app. The
  evaluator's subset check caught it, and a mutation run confirmed the property test now catches
  it too.
- **Graph mismatch on inherited outcomes.** The prose file beside an app change is a v3 graph node
  but not a v2 one, so outcomes v3 inherits from v2 must be computed on v2's own graph. The
  property test found this one.

## Sample

Same dated sample as the [v2 evaluation](ci-suite-v2-evaluation-2026-10-28.md), so the versions
compare directly:

- **PRs:** every PR merged into `main` from 2026-10-20T00:00:00Z through 2026-10-28T22:25:30Z
  that touches a path outside `docs/` and root Markdown. That is 160 PRs over 9 UTC dates.
- **Merge groups:** their 231 merge-group runs.
- **Failures:** 99 failed test jobs.

**Input correction.** The v2 input looked up a PR's last CI-tested head by branch name. Branch
names are reused across PRs, so 7 of 143 samples picked another PR's head: #3484, #3645, #3647,
#3648, #3655, #3657 and #3666. The evaluator now accepts only the PR's own final head or one of its
ancestors, and those 7 use their final head (24 of 160 samples now use the final head).

With the correction, v1/v2 results are unchanged in every headline figure: modes, narrowed PRs,
modeled minutes and catch rate. The dated v2 numbers stand.

Per-PR results are in [`ci-suite-v3-candidate-2026-10-29.tsv`](ci-suite-v3-candidate-2026-10-29.tsv).
Reproduce with `node --import tsx scripts/ci-suite-v2-evaluate.mjs --input <prepared-input.json>`,
which reports v1, v2 and v3 for each diff.

## Results

| Population | v1 `affected` | v2 `affected` | v3 `affected` | v3 Narrowing by Relaxation |
| --- | ---: | ---: | ---: | ---: |
| 160 PR diffs | 4 | 4 | **8** | 4 |
| 90 PRs merged after the mandatory inventory existed (from 2026-10-22) | 4 | 4 | **8** | 4 |
| 231 merge-group diffs | 5 | 5 | **13** | 8 |

**Newly narrowed PRs:**

| PR | Relaxed Class | Files v3/v2 | Chromium Files v3/v1 | Modeled Browser Runner Minutes (v1: 155.1) | Modeled Browser Wall Minutes (v1: 31.0) |
| --- | --- | ---: | ---: | ---: | ---: |
| #3703 | Markdown | 971/1460 | 280/281 | 154.9 | 31.0 |
| #3723 | Browser spec | 174/1475 | 30/284 | 23.5 | 23.5 |
| #3740 | Browser spec | 164/1475 | 20/284 | 17.0 | 17.0 |
| #3742 | Browser spec | 307/1475 | 146/284 | 96.7 | 24.2 |

#3703 also changes `Icons.tsx`, which reaches 280 of 281 Chromium journeys. Relaxing its
Markdown therefore saves almost no browser time.

**Why the other PRs stay full.** #3784's ranking estimated about 17 PRs for this bundle on current
trees. The replay narrows 4. The remaining PRs, by v3 outcome:

| v3 Outcome | PRs |
| --- | ---: |
| Missing mandatory inventory (trees before 2026-10-22) | 70 |
| A retained fallback alongside the relaxed paths | 46 |
| No relaxed path at all | 37 |
| Unreferenced data file: `docs/ci-baseline-2026-10-22.json` (#3639), `docs/ci-node-inventory-2026-10-23.tsv` (#3643), `docs/ci-suite-inventory-2026-10-23.tsv` (#3652) | 3 |

## Savings, Measured Versus Modeled

**Measured.** A full PR run occupies about **184.5 runner-minutes** (median of sampled runs):

| Job | Median Minutes |
| --- | ---: |
| Chromium shard (×5) | 31.0 |
| Checks | 27.9 |
| WebKit | 1.2 |
| Advisory and aggregator jobs | about 0.4 |

**Modeled.** No reduced run was executed. The model is the same as #3784's (`browserMinutes`):

| Scope | v2 | v3 |
| --- | ---: | ---: |
| Browser runner-minutes saved, summed over the 160 final PR runs | 228.7 | **556.9** |
| Per sampled PR | 1.4 | **3.5** |
| Per post-inventory PR (90) | 2.5 | **6.2** |
| Per PR narrowed by relaxation | — | **82.1** (0.2 to 138.1) |

These are not CI speedups. #3630's routing reduces work only for v1 `fast`, so v3 saves nothing
until an approved executor runs its selections.

## Catch Rate, Misses and Exclusions

The classification rules are unchanged from the v2 evaluation. The denominator is 25
first-attempt real code failures from 16 PRs:

| Design | Caught |
| --- | ---: |
| v1 fixed fast candidate | 5/25 |
| v1 policy | 25/25 |
| v2 policy | 25/25 |
| **v3 candidate** | **25/25** |
| Graph rule alone (counterfactual) | 25/25 |

Excluded, as listed individually in the v2 report: 53 flaky or environment, 17 first-attempt
infrastructure, 3 non-first-attempt, 1 with no test identity.

**Deferred-file failures under v3: none.** In every identified failure, v3 selected the failing
file. All but one failed job ran on a diff v3 sends to full, so this denominator remains weak. A
natural shadow cohort of narrowed comparisons is still required.

## v1 Prose Allowlist Finding

v1's only allowlisted prose file is `docs/ci-suite-evidence-2026-10-23.md`, which v1 reviewed as
having no test consumer. Since #3759, `scripts/fast-gate-readiness-report.test.mjs` asserts that
every quoted measurement appears verbatim in its source, and that file is one of the sources.

An edit to that file is classified `fast`. Once #3630's routing is active, `fast` defers that
Node test. v2 and v3 inherit v1's `fast` result on prose-only diffs by design. The v3 graph does
link the file to the readiness report, so a graph-based rule would select the test. The
allowlist needs review before #3630's routing is activated; see the recommended follow-up.

## Activation Proposal

Exact proposal, not requested in this change. Each step needs its own issue, review and, for live
policy, human assurance approval:

1. **Shadow.** Emit `ci-selection-v3` beside v1 (and v2) in the existing `Suite Selection Shadow
   (Advisory)` job, continue-on-error. This needs one coordinated `ci.yml` change with the #3637
   campaign, and is the deferred emission follow-up. Collect v3 into its own policy cohort.
2. **Readiness.** At least 30 comparisons in which v3 narrows by relaxation, across five working
   days, with every deferred-file failure in the matching full runs investigated. At the replay's
   rate (4 relaxed PRs in 7 post-inventory days, plus 8 merge groups), that is about **7–8 weeks**
   of natural traffic.
3. **Routing.** Only then a new, separately approved routing contract for v3 `affected`
   selections: per-file Node lists, selected Chromium specs sharded by the existing profile, and
   rollback. Merge groups stay full throughout.
