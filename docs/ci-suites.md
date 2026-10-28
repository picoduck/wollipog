# Fast Suites and Conservative Selection

Refs #3629. This is an **advisory shadow contract**, `fast-required-v1`, selection
policy version `1`. The name describes a candidate suite, not a required status.
`Typecheck, Test & Sidecar Bundle` still requires every existing full CI job on
PRs and combined merge groups. No ruleset, required-check list, aggregation edge,
test exclusion or event admission is changed. #3630 consumes these interfaces;
activation requires separate assurance-policy review.

## Commands and Inventory

```sh
pnpm check:fast                         # Candidate portable fast contract
pnpm check:full                         # Complete portable regression contract
CI=1 pnpm check:full --ci               # CI reporters and fail-on-flaky browser semantics
pnpm check:fast --list                  # Print the exact commands without running them
pnpm check:selected --base <40-hex-base> --head <40-hex-tested-head>
pnpm ci:selection --base <40-hex-base> --head <40-hex-tested-head>
pnpm ci:suite-inventory                 # Live TSV: every test file's group, risk and reason
```

Run from the repository root after `pnpm install --frozen-lockfile` and installing
the configured Chromium and WebKit engines/system dependencies. The full command
executes every discovered Node file, all development Chromium tests, all
production smoke and all configured WebKit tests; it also typechecks every
package and validates web, runner and sidecar production bundles. It fails on the
first failed command, propagates child failures, and reports its actual wall
time. The fast command substitutes the explicit fast Node allowlist and critical
Chromium files. It retains all typechecks, bundles, production smoke and WebKit.
`--ci` is suitable for a future CI caller; today's required workflow keeps its
existing parallel full commands. A local plan uses local policy, so it cannot
certify a pull request's trusted selection. If the checkout differs from the
requested head, has tracked or untracked changes, or cannot be inspected, the
local selected command executes full portable coverage and reports no suite ID.

The portable command does not claim to emulate CI's Windows runner, provisioned
Node/pnpm engine matrix, or delegated system/user-manager Linux containment
service. Their existing CI jobs/steps remain mandatory. `full` selection includes
these groups; a future CI executor must preserve their existing job environment
and commands. Local Windows or Linux results cannot substitute for each other.
There is no new required fast job and no platform waiver.

[The file inventory](ci-suite-inventory-2026-10-23.tsv) is a dated snapshot, not
an execution allowlist. Regenerate with `pnpm ci:suite-inventory >
docs/ci-suite-inventory-2026-10-23.tsv`. Each compact `group:` reason reference
resolves to the group table below and the versioned `GROUPS` contract, avoiding
duplicated prose in every file row. The existing root Node discovery globs and
[browser shard inventory contract](ci-browser-shards.md) remain independent
oracles. New Node files enter full discovery automatically; unlisted files go to
their package's deferred partition. New browser files enter the complete
Chromium inventory automatically. Fast allowlists cannot remove them from full
coverage. Production and WebKit retain their explicit, separately tested config
contracts. A missing mandatory fast file forces full selection, and the local
fast runner refuses an incomplete mandatory inventory.

| Group | Risk | Selection and Deferral Reason |
| --- | --- | --- |
| `node-fast` | Protocol, API, Enforcement | All 22 #3627 protocol files, authentication primitives/recovery API, and real-server runner-channel integration always run. The latter preserves #2601 coverage even for a web-only change. |
| `node-web` | Presentation, Approval | All web unit/DOM files for any app source change; deferred only by the fixed fast candidate. |
| `node-control-plane` | Security, Persistence | Entire backend partition for any app source change because tests import web state and runner services. High-risk paths fall back to full. |
| `node-runner` | Execution, Enforcement | Entire runner partition for any app source change because tests import backend services and web identity; runner source changes themselves fall back to full. |
| `node-other` | Shared Contracts | Root/tooling, desktop, shared-package files accompany any app source change; otherwise deferred. Direct changes fall back to full. |
| `browser-critical` | Critical Journeys | Authentication recovery, new-session choices, request surfaces, issue closure and conversation handoff always run. File fixtures/serial groups stay intact. |
| `browser-remaining` | Cross-Component | Every other Chromium file for app source changes; deferred only for allowlisted prose-only changes. |
| Typecheck, Web Build, Runner Bundle, Sidecar Bundle | Shared, Production | Always selected, using the existing root/package commands. |
| Production Smoke, WebKit | Production, Engine Compatibility | Every configured test always selected, including for web changes. |
| Linux Containment | Sandbox | Deferred by the portable fast candidate; full fallback includes both existing delegated-manager checks in their original CI environment. |
| Engine Boundaries | Runtime Compatibility | Deferred by the portable fast candidate; config/toolchain changes force full CI coverage. |
| Windows Baselines | Platform Compatibility | Selected for app changes/full fallback; the existing called workflow retains its own diff-based scope/compare behavior. Deferred by the prose fast candidate. |

The browser-wide and Node-wide closures are deliberately coarse. Existing
`apps/runner/src/worktree.test.ts` imports web worktree identity;
`apps/control-plane/src/ingest-rollback-recovery.test.ts` imports the web store;
and backend/runner tests import each other's services. Ordinary app-source
changes therefore select **all portable test coverage**. Only the separately
identified engine/privileged checks may be deferred by an ordinary affected
plan; high-risk/shared/uncertain edits still select the entire CI contract.
There is no claimed app-code latency reduction in this initial policy.
There is no assertion that
component filenames identify all impacted journeys. Security/approval paths
(`auth`, `approv`, `permission`, `workflow`, `campaign`, `sandbox`, `containment`,
`cgroup`, `security`, `secret`, `credential`, `provider-home`, `provider-account`),
identity/principal/token/crypto/policy/lease/governance/Agent Control and central
hub/session/device ownership, persistence/migration paths (`persist`, `migration`, `db`, `database`, `store`, `sqlite`,
`retention`), and every `apps/runner/` source path force full coverage. These are
explicit conservative ownership rules, not an inferred import graph. Both API
packages and root/tooling tests accompany ordinary backend edits.

## Trusted Selection and Fallbacks

`scripts/ci-suite-policy.mjs` owns versioned groups and dependencies.
`scripts/ci-suite-selection.mjs` takes immutable Git base/tested-head SHAs, optional
`--change-head` (PR head), and the event context. It reads Git objects, never
executes or imports the tested revision, and does not consume labels, PR prose,
author claims, or a test list supplied by the author. CLI selection failure is
an explicit failure requiring full coverage, never an empty passing plan.

| Input | Behavior |
| --- | --- |
| Allowlisted Prose | Only explicit `FAST_PROSE_FILES` qualifies: initially `docs/ci-suite-evidence-2026-10-23.md`, reviewed as having no test/runtime consumer. Unknown Markdown, README/CONTRIBUTING and docs consumed by tests require full coverage. |
| One App Package | Add all Node partitions (the existing cross-app dependency closure), every Chromium journey and Windows routing. WebKit/production were already mandatory. |
| Shared, Unknown, Lockfile, CI or Test Configuration | Full contract. This includes shared packages, root scripts, selector/policy/profiles, CSS/assets, manifests and any unrecognized path/extension. |
| Security, Persistence, Migrations, Execution, Approval | Full contract using the explicit ownership rules above. |
| Cross-Package | Full contract, even if each individual path might permit reduced coverage. |
| Empty Diff | Full contract with an `empty-diff` reason. |
| Missing Base or Merge Base | Full contract with `missing-base`; invalid/missing immutable CLI SHAs refuse selection and explicitly require full coverage. |
| Truncated, Malformed, Oversized Diff | Full contract with `incomplete-diff`; bounds are 1 MiB and 5,000 name-status entries. |
| Renamed, Deleted, Type-Changed, Unmerged | Full contract. `--no-renames` exposes rename deletions; no old path can vanish from selection. |
| Missing or Oversized Inventory | No reduced plan; missing mandatory files select full, unavailable/oversized inventory refuses selection. |

PR shadow mode checks out **the event's base SHA**, reads its selector/profile,
and compares the PR head with its Git merge base. The separate `testedSha` is
GitHub's PR test merge commit, whose inventory is what the full suite executes.
Merge-group shadow mode compares **the group's base to the entire group head**;
it never selects from the last PR alone. Context records include both heads,
diff base, trusted policy SHA, event and diff kind. A PR changing selection policy
therefore evaluates under the old trusted base policy and requests full coverage.
The first introducing PR has no policy on its base and is visibly unmeasured.

The advisory job's workflow definition itself comes from GitHub's ordinary PR
workflow routing; a PR may edit that workflow. Such an edit selects full and
remains subject to existing review/full required CI. The advisory log cannot
grant lighter coverage or become a security authority. Any future gating caller
must establish a trusted workflow definition as well as trusted selector code;
this issue does not activate that route. The [disabled merge-group gate](ci-aggregation.md#disabled-merge-group-gate)
(#3637) is such a caller: it runs this selector from current main over the
combined main-to-group diff, requires an unchanged workflow and enforced
regression admission, and is inert unless `CI_MERGE_GROUP_GATE` is exactly `enabled`.

Every `ci-selection-v1` record includes `suiteVersion`, `policyVersion`, `policyId`
(trusted policy/selector/profile content), `suiteId` (group contract, allowlists,
tested workflow/config/command inputs and test inventory), `inventoryId` (test paths/blobs/groups),
tested revision, counts, fast/selected/deferred hashed file identities, reasons and
`certification: none`. Changed contracts cannot reuse the same cohort; inventory
and tested revisions remain available for compatibility review. Human-readable
file paths stay in the local inventory, not the shadow marker.
The record's `inventoryDomain: node-and-development-chromium` makes its file
counts explicit: production/WebKit selections are always mandatory, are
inventoried separately in the TSV, and retain their tested config identity.

## Shadow Evaluation and Cost

The `Suite Selection Shadow (Advisory)` job is independent of the required
aggregator, continues on failure, and is draft guarded. It performs one filtered
base checkout/history fetch, Node setup and a bounded Git plan. It installs no
pnpm dependencies or browsers and executes **zero additional tests**. Its maximum
runner occupation is five minutes per admitted PR/merge group; actual setup/Git
time must be measured from natural jobs. No extra workflow dispatch or CI rerun
is justified for sampling. Missing shadow output has no effect on full validation.

Use the [existing attempt collector](merge-queue-wait.md) with an explicit UTC
window and `--all-events`. Its existing `--timing-job` option also accepts the
shadow job ID. Collect Node, five Chromium, WebKit, the shadow job and (when it
runs) Windows comparison logs: at most nine selected jobs for one run, below the
existing ten-job cap. The collector retains its 16 MiB/job redirect/transport
boundary, ten timing-summary cap and 32,000-character timing-marker limit. The
additional selection marker is capped at 768,000 characters, 5,000 files and two
records per job; duplicates cannot become an eligible comparison. Only a pending
selection line receives the larger buffer; unrelated lines retain the existing
32,000-character buffer bound. Invalid marker echoes are ignored. Selection
overflow uses `selectionTruncated`, separately from legacy timing `truncated`.

```sh
# First collect a natural window with selected job IDs as documented in merge-queue-wait.md.
node scripts/ci-suite-shadow-report.mjs --input /tmp/ci-attempts.json \
  > /tmp/ci-suite-comparisons.json
```

The offline tool reuses the existing collector's deduplication and reliability
validation. Inputs are capped at ten 32 MiB files. It requires matched run,
attempt, event, trusted base, exact tested SHA and complete current full-job
projections for eligible samples. It handles the real nested Windows scope/compare job names and the
existing intentional Windows skip. It reports full elapsed minutes from the
collector and each original failing test identity. It never calls a subset's
observed duration its standalone runtime. `selectedRuntimeMs` stays null.

`projectedFastOutcome` and `projectedSelectedOutcome` are **subset projections**, not independent executions.
Full passes imply no observed subset failure under that full execution. A full
failure outside selected files is a **missed-failure candidate**, requiring
investigation; changed scheduling, fixture isolation and omitted subsequent
commands may change standalone behavior. Retry-only signals, reruns and unresolved
non-test/infrastructure interruptions are listed individually with evidence IDs,
never silently counted as passes or automatically assigned an infrastructure
cause. Missing/truncated/mismatched evidence stays a gap. Intentional test skips
are counted visibly; all-skipped, cancelled or unmeasured projections are gaps.
Follow [reliability triage](ci-reliability-triage.md) for actual cause/owner review.
Failures that skip downstream work are preserved as partial failure observations:
for example, a shard-1 Chromium failure prevents production smoke, and a typecheck
failure prevents Node tests. Observed failures and miss candidates remain visible,
while unknown subset outcomes are `unmeasured`, `eligible` is false and those
observations never inflate the 30-change/five-working-day denominator.

Cohorts separate exact suite/policy identities. They count distinct identified PRs
conservatively (unidentified merge-group snapshots do not inflate the change
denominator), distinct sampled UTC working dates, and misses. Even a cohort with
30 changes across five working dates is not auto-certified. Investigate every
miss and exclusion and review compatibility before any readiness decision.

## Evidence and Remaining Comparison

The inert [regression exercises](../scripts/fixtures/ci-suite-regressions.json)
reference #3617's UTC fixture failure, #3517's unresolved Escape flake, #2601's
runner-channel stall on a web-only change, and #2452's cancelled aggregation.
Paths are representative selection inputs; these exercises are not replayed
historical patches or freshly executed flaky CI samples. Tests also exercise
shared/high-risk inputs, missing/truncated/empty diffs, rename/deletion, mixed
merge-group packages, a hostile head policy, missed-failure projection and
retry/infrastructure exclusions. No flaky run is manufactured.

The [October 22 baseline](ci-baseline-2026-10-22.md), window
`2026-10-20T00:00:00Z`–`2026-10-22T00:00:00Z`, contains 315 attempt records and
no compatible selection records. This mechanism cannot retroactively certify
them. **Zero eligible shadow comparisons** exist in that baseline; absence is
unmeasured, not zero misses. The proposed 5–10 minute fast-suite target is not
demonstrated. Local/profile measurements belong in the accompanying evidence
record, with environment and commands, without claiming CI speedup.

A separately versioned, advisory successor prototype, `fast-required-v2`, narrows only
v1's `affected` outcome with a conservative import graph. It has its own marker and identities,
and no CI caller. See the [v2 prototype and offline evaluation](ci-suite-v2-evaluation-2026-10-28.md).
That evaluation also measures how often v1's `suiteId` changes across merges, which bears on
the cohort denominator below. Nothing in this section changes for v1.

**Remaining:** at least 30 eligible natural changes across five working days,
individual miss/flake/infrastructure review, actual shadow overhead/selected
runtime evidence, and the reviewed fast/full comparison. Full queue validation
continues throughout. Do not hold a ready slot waiting for future traffic.
