# CI Reliability Triage

A retry-only pass remains a failure signal. `failOnFlakyTests`, the required
aggregator, complete merge-group validation, original logs and the existing
[sanitized synthetic diagnostics](synthetic-browser-failure-artifacts.md) retain
their behavior. This report cannot resume merges, change a check conclusion,
publish an issue, dispatch or rerun CI, or exclude a test. Test-specific repairs
stay in their existing tracker issues. Refs #3636; measurement foundation #3626.

## Collect and Report

Use the existing [attempt collector](merge-queue-wait.md) over explicit half-open
UTC windows. Collect only natural traffic; do not manufacture flaky runs, rerun
jobs to fill a sample, or dispatch the synthetic failure fixture for this report.
Select at most ten exact test-job IDs from the same collected window with
`--timing-job`, as described in the collector guide. For example:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/merge-queue-wait-report.mjs \
  --repo picoduck/wollipog --all-events \
  --since 2026-10-20T00:00:00Z --until 2026-10-22T00:00:00Z \
  --timing-job <job-id> --json > /tmp/ci-attempts.json
node scripts/ci-reliability-report.mjs --input /tmp/ci-attempts.json \
  > /tmp/ci-reliability.json
```

The second command is offline. Multiple `--input` files reuse the collector's
raw-attempt deduplication and retain source windows; latest collection wins for
the same run/attempt. Each file is capped at 32 MiB, at most ten files, 10,000
attempt records, 1,000 jobs per record and ten summaries per job. Parse/transport
errors emit a fixed failure message and nonzero exit; no raw exception is printed.
It writes only the requested stdout report. Store reports privately by default;
public evidence still requires the reporting policy's sanitization and approval.

`ci-timing-v1` now includes an optional `reliability` projection of the first 40
failing, cancelled, unmeasured or retried test events, independent of the slowest
20 tests. Overflow sets `reliability.truncated`; summary counts still cover all
observed events. The parser accepts old summaries without this field and marks
them `legacy-top-20-only` in the reliability report. Both parsers cap marker lines
at 32,000 characters. The existing log reader's 16 MiB/job and ten-summary bounds
remain. No new log retention or upload is introduced. Test titles, paths, errors,
stdout, prompt content, attachments and inputs never enter the new projection.

The report contains:

- `signatures`: suite (`node` or `browser`), exact tested suite revision, hashed
  file/test IDs, observed states and retry indices, exact run/attempt/job IDs,
  event type, workflow source SHA where available, first/last run-creation times,
  and distinct affected runs. At least two distinct runs is `recurring`; repeated
  attempts of one run do not inflate recurrence. This is an identity signature,
  not a hash of an error message. Resolve IDs against the exact source using the
  collector guide. Changed source revisions remain separate; a maintainer must
  establish compatibility before combining signatures across revisions.
- `crossRevisionCandidates`: the same suite/file/test hashes observed in at least
  two runs across different tested revisions, with exact revision lists and
  first/last run-creation times. These are investigation leads explicitly marked
  `compatibility: unverified`; unchanged hashes do not prove unchanged test
  dependencies or a common cause. Natural PR/merge-group tested SHAs usually
  differ, so inspect these candidates as well as exact-revision `recurring` flags
  for escalation. They never inherit cause annotations or certify compatibility.
- `runOutcomes`: original failing, cancelled, skipped, unfinished and unmeasured
  attempts, even when a later attempt passes. `rerunRecoveries` labels a passing
  rerun of the same run and head after a failing first attempt as `retry-only`.
  It does not assert that the same test ran, infer infrastructure failure or
  certify the original contract. Within-test passing retries are also labelled
  `retry-only`, including expected-failure semantics from the underlying reporter.
- `coverageGaps` and `sourceIncomplete`: absent/mismatched context, unknown tested
  SHA, missing job details, old top-20 projections and truncation are visible.
  Non-test jobs without projections are gaps too; these are selected coverage
  observations, not a test denominator or a claim that all jobs should emit tests.
  Abrupt termination can prevent any summary. Zero signatures with gaps means
  unknown reliability. Optional logs and historical exports cannot prove absence
  of failures.

Counts are observed lower bounds, with first attempts separate from workflow
reruns. No flake rate, causal attribution, actual cost or merge health is inferred.
Run IDs, numeric job IDs, SHA values and fixed labels are re-projected; arbitrary
input branches, private fields and test diagnostics are discarded.

## Classification and Ownership

Observed outcome and investigated cause are separate. A timeout, cancellation,
pass on retry or unrelated PR diff alone does not establish cause.

| Cause | Evidence Required | Accountable Role | Next Action |
| --- | --- | --- | --- |
| Unresolved | Default, insufficient evidence, or competing hypotheses | Test Maintainer | Preserve evidence and reproduce the exact test and symptom |
| Product Nondeterminism | Verified product race/state defect under a valid test contract | Product Maintainer | Repair product behavior and keep the regression assertion |
| Environment Sensitivity | Controlled reproduction identifies a test/environment dependency while product guarantees hold | Test Maintainer | Repair isolation/readiness/resource assumptions and preserve the guarantee |
| Infrastructure Interruption | Independent runner/service interruption evidence tied to the exact attempt | CI Maintainer | Repair/escalate infrastructure and verify the original full contract |

The PR author or on-call CI maintainer initially owns triage and explicitly hands
it to an accepting test/product/CI maintainer in the existing issue. The role
labels above avoid embedding personal details in the content-safe report; the
tracker's assignee is the actual accountable person. Never silently assign the
failure to infrastructure because it passed later.

Optional `--triage <file>` annotates exact signatures with reviewed assertions.
The file has `version: 1` and a `decisions` array (maximum 200). Each decision must
supply `suite`, `suiteRevision` (40 hex), `fileId` and `testId` (64 hex), `cause`
(one of the machine names below), `owner` (`test-maintainer`, `product-maintainer`
or `ci-maintainer`), numeric `issue` and `reviewPullRequest`, and `evidence`
(one to ten `{runId, attempt, jobId}` objects). Causes are `unresolved`,
`product-nondeterminism`, `environment-sensitivity`, `infrastructure-interruption`.
Duplicates and unknown policy/decision fields fail. Changed scope does not inherit
an annotation. These are reviewed assertions supplied by an operator; the offline
script does not contact GitHub to authenticate review, inspect evidence or grant
authority. Require a reviewed repository change and actual acceptance by the named
owner before relying on one. A review number alone proves none of these facts.

Existing issue candidates are deliberately file-scoped and labelled
`file-only-confirm-test-and-symptom`. Confirm the exact test and symptom before
recording a reviewed exact-test annotation; other tests in the same file can fail
for unrelated reasons:

| Source File | Existing Issue | Matching Symptom to Confirm |
| --- | --- | --- |
| `apps/web/e2e/command-inbox-projects.spec.ts` | [#3517](https://github.com/picoduck/wollipog/issues/3517) | Offline Composer Response from split preview remains open after Escape |
| `apps/control-plane/src/runner-channel.integration.test.ts` | [#2601](https://github.com/picoduck/wollipog/issues/2601) | Retained-children inventory stalls the Agent Control handshake |

Neither issue has a verified infrastructure cause. These links route investigation;
they do not quarantine tests or claim a new occurrence has the same cause. Search
open and closed tracker issues before proposing any new issue. Publication follows
[the repository approval rules](../.github/ISSUE_REPORTING.md); the report never
publishes issues or comments automatically.

## Bounded Reproduction, Repair, and Escalation

1. Preserve the original first-attempt run URL, head/tested SHA, suite/workflow
   revision, job/shard, test ID and failure outcome before retrying. Record the
   reproduction hypothesis and owner in the existing issue. Inspect sanitized
   #3046 diagnostics only for their existing allowlisted synthetic cases; they
   retain at most three failed-attempt pairs per shard for three days. Download
   allowed evidence before expiry when needed, into private investigation storage.
   Never broaden uploads or preserve raw real-session data for convenience.
2. Keep the configured browser retry budget unchanged. The triage process grants
   no extra CI rerun. Under the project's normal authorization, an investigator
   may make one targeted local reproduction batch, at most 20 repeats, retries
   disabled, bounded to ten minutes. Pin the source, environment and test scope;
   stop when the bound is reached or a useful failure is captured. Record both
   pass and fail counts and the stopping reason. Do not rerun until green, change
   assertions, loosen latency bounds, manufacture production failures or claim
   a negative batch disproves a race. A further experiment needs a new documented
   hypothesis and owner review, rather than an automatic loop.
3. Security, persistence, sandbox and approval-enforcement regressions retain
   highest repair priority and remain blocking until equivalent protection is
   demonstrated. A reproducible product regression or regression shared by main
   blocks the affected certification. Check main's own push CI and existing
   **Main CI Is Failing** issue before blaming an unrelated queued PR. Preserve
   exact-head and merge-group validation and follow `AGENTS.md` for re-enqueueing.
4. Assign a same-working-day triage owner for a recurring signature or a queue
   blocker. The owner posts a hypothesis and next action by the next working day.
   Escalate immediately for critical coverage, two independent natural runs in
   the stated window, no accepting owner, or an unexplained required-check
   failure. Escalate unresolved causes to the CI and component maintainers after
   one bounded batch; keep the failure visible while investigation continues.
   Review open recurring items each working day. Individual repair and repeat
   verification belong to the existing test-specific issue, not this policy.
5. A successful targeted repair batch supports a diagnosis; complete required CI
   on the reviewed head and the actual merge group still decide merge eligibility.
   A retry-only pass, known-issue link or infrastructure annotation never resumes
   merges automatically. Required checks, typed approvals and queue policy remain.

## Exceptional Exclusion Policy

There is **no quarantine mechanism or active exclusion** in this change. The
report always emits `exclusions: []`; any supplied top-level report/attempt
`exclusions` or `quarantine`, or an unknown triage-policy field, fails visibly
with a nonzero exit and no certification. Expired records are refused just like
unknown records; this tool cannot activate even an apparently valid exclusion.
Every raw input and attempt is checked before multi-file deduplication, including
older snapshots that a newer collection would otherwise replace.
It does not read or apply skip lists, edit test selection or change CI exit status.

A future exceptional exclusion requires a separately reviewed, explicitly approved
repository change. Record the exact test IDs, suite revision, platform and job
scope; reason and evidence; accepting owner; existing repair issue; approving
review and date; absolute UTC expiry (at most seven days, no automatic renewal);
replacement coverage and its evidence; and explicit certification effect. The
selection and certification consumers must validate known scope and expiry on
every execution and fail closed with a visible failed check for unknown/expired
records. Test this using inert stored records before activation. Security,
persistence, sandbox and approval coverage requires adequate verified replacement
coverage or stays blocking. Any excluded suite must be labelled as a reduced
contract with its exclusions; it cannot claim the original complete contract.

## Decision Correctness and Actual Trends

`scripts/fixtures/ci-reliability-outcomes.json` is an inert, invented outcome
fixture. Its run IDs and failures are synthetic; tests exercise retry-only
classification, distinct-run recurrence, cause annotations, revision boundaries,
missing/truncated evidence and exclusion rejection without flaky executions.
These tests establish decision behavior, not actual test reliability.

Separately, the natural [October 22 baseline](ci-baseline-2026-10-22.md) covers
`2026-10-20T00:00:00Z` through `2026-10-22T00:00:00Z`. The offline report over its
JSON export finds **308 first attempts, 7 reruns and 6 run-level retry-only
recoveries**. The export intentionally omitted detailed jobs and predates
per-test projections: **315 attempt-level coverage gaps**, zero measured test
signatures. Zero here means unmeasured, not no flakes. These recoveries remain
unresolved; no infrastructure cause or test-level recurrence is inferred.

After merge, collect identified natural PR, merge-group and main-push attempts
with explicit windows and selected timing jobs using the same collector. Report
source bounds, incomplete coverage, first/rerun counts, exact observed signatures
and owner actions next to this baseline. Keep pre-projection/legacy samples
separate. No minimum traffic is manufactured and no improvement is claimed from
a single run. If no compatible natural sample exists yet, report the post-change
trend criterion as undelivered and schedule a later measurement pass; do not hold
the ready slot waiting for traffic.
