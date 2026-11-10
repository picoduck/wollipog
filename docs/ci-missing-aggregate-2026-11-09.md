# Missing Required Aggregate: November 9, 2026

Refs #4429; related reliability investigation #2674. This is a read-only reconciliation
of a historical attempt, with a sanitized [API metadata fixture](ci-missing-aggregate-2026-11-09.json).
No workflow, queue setting, permission, or live stack was changed for this investigation.

## Observations

| Evidence | Result |
| --- | --- |
| [CI run 42671030052](https://github.com/picoduck/wollipog/actions/runs/42671030052), attempt 1 | Completed with failure; event `merge_group` |
| Tested integration | `36dc6a362edea7ffee8ab0de8e07515d3a2e825a` |
| Created / last updated | November 9, 18:06:28 / 18:27:21 UTC |
| Complete jobs listing | 20 of 20 records: 18 success, 2 skipped |
| Check suite 115572303054 | Failure; 20 checks, matching the jobs inventory |
| Required aggregate | No job or check named `Typecheck, Test & Sidecar Bundle` |
| Available job annotations | Passing Playwright summaries; no explanatory failure annotation in `gh run view` |
| [PR #4409](https://github.com/picoduck/wollipog/pull/4409) | Removed November 9 at 20:07:18 UTC, `checks_timed_out`; unchanged head later merged |

The successful work includes all three unit shards, ten Chromium shards, WebKit,
typecheck/bundles, delegated recovery, Windows change detection, and advisory suite selection.
The skipped jobs are PR Suite Routing and Merge Group Gate. These are expected disabled
dependencies, not the missing protected aggregate.

The exact workflow blob is `8e659c50499b2c34c71534a402911aab833ebd87`.
At that definition the non-PR aggregate's predicate admits merge groups, and the shell
accepts skipped routing/gate jobs when their controls are disabled. Existing source-contract
tests cover these semantics. The same blob ran successfully in
[comparison run 42678692594](https://github.com/picoduck/wollipog/actions/runs/42678692594),
attempt 1 at integration `4b991314dc3de212f765a128b6f087b5f984d7bd`;
required job 129378043749 concluded success.

## Findings and Limits

The jobs and check-suite records agree, so this is not simply a missing page in the jobs API.
The aggregate is absent, not a recorded skipped or queued job. The workflow had already
concluded failure about 100 minutes before queue removal; continuing to wait could not
produce a result in that completed attempt.

No deterministic workflow defect or GitHub scheduler root cause is established.
An identical successful workflow weakens a deterministic-definition explanation but does not
exclude an event-dependent evaluation or infrastructure failure. Public job metadata and
annotations do not explain a job that GitHub never recorded. Obtaining GitHub's orchestration
diagnostics requires operator escalation; a local expression fixture cannot reproduce those internals.

The delivered correction is to investigation output: version-2 per-attempt reports now classify
absent, pending, running, passing, failing, cancelled, skipped, and unmeasured aggregation
independently of timing. Partial or duplicate inventories cannot establish absence.
The [runbook](ci-aggregation.md#missing-required-aggregate) preserves exact attempt evidence,
describes escalation and authorized recovery, and keeps missing required checks blocking.
This does not claim to prevent GitHub from having another such incident.

## Verification

`node --test --test-isolation=none scripts/ci-aggregation-status.test.mjs scripts/merge-queue-wait-report.test.mjs`
replays the sanitized incident through the actual reporting path and exercises recorded waiting,
running and terminal job outcomes, incomplete pagination, duplicates, and old-export recombination.
It proves diagnostic behavior, not GitHub scheduler behavior or future queue reliability.
