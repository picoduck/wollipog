# Fast-Gate Cutover Recovery Rehearsal

Refs #3637 under #3625 (acceptance criterion 2). **Inert, offline and disabled.**
No repository variable, secret, ruleset, required context, permission, status
grant or budget changes. No workflow is dispatched and no status is written.
This document covers the recovery rehearsal only. The fast merge-group mode is
in [CI aggregation](ci-aggregation.md#disabled-merge-group-gate). The
[readiness report](fast-gate-readiness-2026-10-28.md) embeds this rehearsal's
results, and the end-to-end rollback rehearsal and operator steps are in the
[activation proposal](fast-gate-activation-proposal.md).

## What It Runs

```sh
node scripts/rehearse-fast-gate-cutover.mjs [report.json]   # exits 1 if any flow mismatches
node --test scripts/rehearse-fast-gate-cutover.test.mjs
```

The rehearsal pretends the fast gate is active: merge groups land after fixture
fast checks, and rolling full validation runs behind them. Every decision comes
from the delivered modules: `main-ci-health` (through its production `report`
entry point), `main-merge-admission`, `main-merge-admission-controller` (census,
plan and default-deny writer, explicitly enabled only against the fixture),
`main-merge-repair`, `main-rolling-validation` (scheduler, state and shared
candidate request), `main-validation-candidates`, `main-regression-automation`,
`main-regression-investigation` and `release-certification`. It adds no parallel
policy. It also reuses the delivered #3633 `rehearseAdmission` unchanged for its
historical replay, the 45/46-target hold fan-out bounds and the ordered rollback
phases (`delivered3633Rehearsal` in the report).

`scripts/fast-gate-rehearsal-forge.mjs` is the only transport. It is an
in-process fake GitHub for `fixture/fast-gate-rehearsal`: main history, pull
requests, queue groups, rolling worker runs and jobs, state refs, workflow blobs
and statuses. Each API call advances a virtual clock by 100 ms (the #3633
convention). The fake refuses any other repository and any unknown mutation.
Dispatches create virtual runs only; a scenario starts and finishes them
explicitly. Output is deterministic byte for byte.

Fixture timing assumptions (`TIMING` in the report):

| Assumption | Value | Basis |
| --- | --- | --- |
| Fast gate, enqueue to landing | 10 min | Upper bound of #3637's ordinary-change target |
| Rolling dispatch to verdict | 34.27 min | Median from the [2026-10-23 census](main-rolling-shadow-2026-10-23.md) |
| Worker start, health wake, controller wake | 1 min each | Fixture |
| Repair proposal after failure | 20 min | Fixture; human and agent latency are unmeasured |

## Per-Flow Results

Each flow lists every step with the module that decided it and the expected
and actual decisions. It also records virtual times, call budgets, raw
observations and disclosed limits. A future readiness report can embed the
JSON as is.

| Flow | Deciding Modules | Outcome (Virtual Time) |
| --- | --- | --- |
| Missed failure | health, rolling, controller, automation, investigation, repair, candidates | The fast gate admits the regression. Its worker fails **35.30 min** after landing. Holds are delivered **70.7 s** after the verdict. **2** exposure-window admissions (ready PR heads) are withdrawn; the queued innocent group never received a success while its checks ran. The exact revert is the only exception. Release comes **67.66 min** after the failure. |
| Validator outage | admission, health, rolling, controller | A stalled worker admits until **120 min** of lag, then holds. Health turns unknown (`validation-stalled`) and the scheduler reports `stalled-active-run`. A health-observer outage or crash is an explicit hold. The writer refuses with **0** writes, so **2** earlier PR-head successes stay; they only gate enqueueing. |
| Exhausted investigation budget | automation, investigation, controller | Exhausted delivery attempts and elapsed time give `*-exhausted-operator-required` with zero deliveries. Re-planning stays blocked, holds remain, and the helper budget refuses extra work before running it. Each exhaustion reaches the open incident as exactly one marked comment; a repeat finds the marker. |
| Stale or backlogged health | admission, health, rolling, controller | Commits 1–4 admit and the 5th unvalidated commit holds. Every ready PR opened before a landing holds as `base-moved`. At 7,195 s the decision is eligible; at 7,200 s it holds, with a planned block 3.6 s later. Health reports stale only after strictly two hours. |
| Queued-entry hold | controller, admission | One ready PR, a queued group and a stacked two-PR group (6 targets). All are held **67.5 s** after the failure. All **5** earlier successes, including the ready queue-head group's just-in-time success, are withdrawn by exact-SHA failures. The stacked group holds `base-moved` with no write while healthy, so it is not ejected. |
| Exact-head repair | controller, repair | Only the exact single-PR group is eligible. Refusals: changed head, base or group, a batched group, a stale failure set, an expired grant, unverified fast checks, an expired observation, a mismatched squash tree, and a competing repair during reconciliation. |
| Exact-candidate release | rolling, candidates, certification | A skipped intermediate SHA reads `missing`, and its receipt certifies `none`. The candidate is dispatched only after main is validated and the 60-minute cooldown has passed: `pending`, then `certified`, **95.32 min** after the request. Off-main, failed and changed-suite candidates are refused. |

Call budgets stay inside the unchanged 48/96-call caps and the 60% REST floor.
A health report costs 35 calls at one unvalidated commit and **57 calls** at
five, because each commit adds landing-evidence reads. At the five-commit hold,
the writer's shared budget has used 55 calls, leaving **41** status writes. That
is fewer than the 45-target fan-out the #3633 rehearsal fits, so a full queue
at the backlog limit would refuse with zero writes. This is fixture call cost;
GitHub's per-commit cost still needs observation.

## What It Proves and What It Does Not

It proves that the delivered modules, composed in order and reading one
consistent fake history, express all seven flows with the expected fail-safe
decisions. It also proves they do so without live authority.

It does not prove:

- Live enforcement, forge timing or GitHub landing races.
- Fast-check coverage. The fast checks are fixtures.
- Runner availability or real queue waits.
- Human or agent repair latency.
- Real API cost.
- That thresholds have been approved.

The times are virtual consequences of the fixture assumptions above, not
measurements. Nothing here is evidence for #2674's historical full-gate
criterion.

**Composition fix (shipped here).** The `main-ci-health` `report` entry point,
`observeAdmission` and `rebuildAdmissionCycle` ignored the caller's clock, so a
virtual-time caller saw wall-clock health observations. They now pass the clock
through. Wall-clock callers are unchanged.

**Open activation gaps (not fixed here).** These cannot be resolved in fixture
code:

- **Sticky success (addressed for merge groups).** A group's success is now
  written just in time, after its own aggregator and only at the queue head, and
  an outage before that leaves no success
  ([fail-closed group admission](main-merge-admission.md#fail-closed-group-admission)).
  The race between that write and GitHub's landing remains, bounded by
  observation and cycle age plus GitHub's unmeasured landing latency.
- **Escalation delivery (addressed, disabled by default).** Exhausted escalation
  is delivered as one marked comment on the open Main CI Health incident, mentioning
  `MAIN_REGRESSION_ESCALATION_MENTION`
  ([escalation delivery](main-regression-automation.md#escalation-delivery)). It runs
  on Main CI Health's next invocation and cannot prove a human read it.
- **Exposure window.** Work admitted between landing and the failed verdict
  (35 min here) lands on a broken main and depends on repair.
- **Ready-PR `base-moved` holds.** On GitHub, `baseRefOid` stays at an open
  PR's last sync. A read-only GraphQL check of the 8 oldest open PRs on
  2026-10-27 found none whose base equalled the main tip. The fake forge models
  this, so the controller holds every ready PR as `base-moved` after any
  landing until that PR is re-synced. Under fast-gate traffic, measured false
  holds must separate this from health holds before thresholds are approved.

The fast-gate mode, observed traffic, approved thresholds and outage bounds,
and the operator's approval of the workflow, status and ruleset changes all
remain separate steps.
