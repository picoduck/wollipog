# Regression Merge Admission

Refs #3633 under #3625. **Disabled; no enforcement or activation in this delivery.**
The first slice supplies a pure ordinary-admission policy, read-only live observer,
optional advisory workflow job and this operator runbook. The recovery slice adds
a [dry-run controller, default-deny code-only writer and complete recovery rehearsal](main-merge-recovery.md).
No workflow grants the writer permissions. Operator providers, status-writing
authority, required-context wiring and activation remain separate human steps.

## Shipped Mechanism and Contexts

`scripts/main-merge-admission.mjs` accepts only the exact lowercase `dry-run` mode.
Unset, `disabled`, `enabled`, `enforce` and other values do no work. There is no
activation value. No repository variable is changed by this implementation.

In `ci.yml`, `CI_REGRESSION_ADMISSION=dry-run` would admit **Regression Admission
Shadow (Advisory)** for ready PRs and merge groups. That setting change requires
separate human approval. It checks out current `refs/heads/main`, with non-persisted
credentials and only contents **read**, matching the existing reusable rolling
caller's permission cap. Public Actions/issues endpoints support reads without
extra permissions; inaccessible evidence remains a hold. See GitHub's
[public workflow-run permissions](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run)
and [reusable permission ceiling](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).
It runs after the suite jobs, alongside the required aggregator. The aggregator's
dependencies, commands and results remain unchanged. Disabled mode schedules no
job. Dry run adds no dependency to the required critical path; it consumes a separate
runner and API allowance, so contention across jobs cannot be claimed to cost zero.

The only required context remains **Typecheck, Test & Sidecar Bundle**, with
full merge-group coverage. Neither the optional shadow job's successful exit nor
`ordinary-admission-eligible` certifies an integration. A hold exits successfully
because the job is advisory; its JSON still says `decision: hold`, never pass.
Missing trusted policy is an explicit hold. Failure before observation or retention
means **unavailable evidence**, never an admission. The job has a five-minute
timeout, no retries and no dispatch or status-writing capability.

The live adapter invokes the authoritative health module's `report` entry point.
It independently rebuilds evidence using Actions/compare APIs, recovers the incident
pointer, revalidates attempts and main, and retains the existing 48/96-request cap,
quota floor and complete-inventory rules. `ci/main-health-state` supplies hints
only. A cached report, hand-edited JSON, green controller, label, prompt or candidate
artifact cannot supply live proof. The pure function is useful for inert fixtures;
production callers must use the live adapter rather than deserialize a verdict.

The disabled controller's shared rebuild additionally batches the three immutable
workflow blobs at each exact commit into one GraphQL read, with complete byte,
Git blob hash, repository and revision verification. Mutable main/run/listing
rechecks, freshness and complete evidence remain mandatory. Its measured-cost
rehearsal now fits **45 holds in 96/96 calls** from the earlier 53-read baseline
using only one three-file batch: **53 - 3 + 1 + 45 = 96**, **zero call headroom**.
At 100 ms per virtual request, the last planned hold is **10,600 ms** after failure
or **9,600 ms** after expiry; CPU time is separate. A 46-target batch is one short
and refuses with zero writes. A new real read-only comparison reduced 38 calls to
34 with two batches and preserved failing health; replaying that cost fits 45
holds in **79/96 calls**, leaving **17**. See [the recovery runbook](main-merge-recovery.md#slice-4-batched-read-cost-and-full-set-delivery)
for exact assumptions, negative cases and observations. Neither sample gives a
universal history-cost bound. Limits and REST quota floors are unchanged.

Every observation retains the complete health report, its SHA-256 digest, policy
version/thresholds, decision time, repository, integration/base identity, passing
run/attempt and reasons. `main_merge_admission_observed` logs the bounded summary
with `observationId` and explicit `entryPoint`; it omits raw event bodies, prompts,
tokens and API error bodies. Optional workflow JSON artifacts have 30-day retention.
Investigate by observation ID: determine **which exact integration**, **which
health proof**, and **which threshold or unavailable dependency caused the hold**.
Read the JSON rather than inferring a decision from workflow success.

## Proposed Shadow Thresholds

These values are code-reviewed measurement defaults, **not human-approved live
admission policy**. Activation must review measured shadow false holds and quota.

| Dimension | Hold Condition | Basis and Limitation |
| --- | --- | --- |
| Full failures | Any unresolved authoritative full failure | Failure is sticky through reruns; an older passing ancestor cannot resolve it. |
| Unavailable health | Missing, unknown, stale, incomplete, mismatched, future or unverifiable evidence | Full evidence and exact main/base identity are mandatory. |
| Observation age | At least 120 seconds since observation start | Proposed decision lease; collection time counts against it. Not a forge TTL. |
| Unvalidated age | At least 7,200 seconds since oldest verified landing | Two-suite detection envelope plus operational margin; recalculated at decision time. |
| Unvalidated backlog | At least 5 commits | Conservative bounded shadow budget; counts direct pushes as well as squash merges. |

Seven natural completed rolling validations measured **33.68/34.27/46.42 minutes**
minimum/median/maximum dispatch-to-verdict in the [24-hour census](main-rolling-shadow-2026-10-23.md).
A change landing just after a snapshot may wait for the current suite and its own
suite: two observed maxima total 92.84 minutes. The two-hour proposal leaves 27.16
minutes for observation/dispatch overhead in that sample. Neither GitHub queue time
nor provider scheduling has an SLA; this is a threshold, not a detection guarantee.

Natural health observations in the [budget census](main-ci-health-budget-2026-10-24.md)
were caught up or one commit behind, including an active worker. Lag zero through
five was exercised by the production-entry-point fixture matrix. Five is a
conservative shadow cutoff within that tested observer envelope; sustained traffic
at lag five is **not measured production evidence**. The cutoff may hold a naturally
busy repository early and needs operator review. No throughput extrapolation is
made from seven validations. Idle, fully caught-up main has zero unvalidated age,
even when its passing suite completed long ago; fresh live revalidation is required.

The evaluator recomputes oldest-unvalidated age from verified forge landing time
at decision time, so crossing a threshold during an API scan holds. It does not use
committer time. Equality holds. A changed main/base, including competing repairs,
invalidates that integration's prior evaluation. Prospective commits in a queue
group are not included in current backlog; this is not a hard five-commit landing
bound for batched groups.

The workflow does not assume an event base is safe code to execute. It always
executes current main's observer. An integration whose event base differs from
live main, including a queued predecessor if the forge supplies one, conservatively
records `base-moved` and holds until rebuilt on current main. This can produce
expected holds for stacked entries; report them separately from health failures
when sizing thresholds. No natural stacked-entry shape was measured in this slice.

## Disabled Enforcement Adapter and Forge Race

The code-only controller plans exact-integration checks and invalidation of
queued/in-flight entries. A check at initial enqueue alone does not cover entries
already waiting or building. Its default-deny writer rebuilds evidence before each
target write and requires an operator-owned host. The separate operator-approved
context would be **Regression Admission**; it is not required or emitted today.
The existing **Typecheck, Test & Sidecar Bundle** must remain required and fully
validate merge groups until a separately reviewed cutover proves the replacement.

| Entry State | Required Future Behavior | Current Dry Run |
| --- | --- | --- |
| New PR/enqueue | Bind evaluation to repository, PR head and integration/base; hold ordinary work if health fails or exceeds budget. | Observe ready PRs; never gate. |
| Queued | Reevaluate every current integration on failure, expiry and base movement; withdraw prior success. | Observe delivered merge-group events only. |
| Building | Final fresh check after tests; a health change or threshold crossing holds despite successful tests. | Advisory sibling after tests. |
| Already green | Expire/revoke a stale success before ordinary admission; audit each revocation. | No invalidation or status writes. |
| Controller/API outage | Missing fresh authorization must hold; never keep an old cached green as proof. | Explicit hold or unavailable observation; existing full queue CI continues. |

**Actual shipped enforcement bound: none.** This slice intentionally blocks zero
merges. Fixtures prove policy decisions at expiry, not forge enforcement. Even the
planned final check leaves a race between its last read, success publication and
GitHub landing. Scheduled invalidation is best effort; a controller outage can
leave a previously green check sticky indefinitely. A 120-second policy lease does
not cause GitHub to expire success automatically. No finite unconditional
failure-to-block bound may be claimed from Actions cron or webhook timing.

Before activation, measure failure-to-observation, observation-to-invalidation and
last-check-to-landing in real shadow traffic. Specify an approved bound and outage
strategy. If no supported fail-closed lease/invalidation mechanism can satisfy it,
retain full queue validation and leave the lighter gate disabled. Do not market a
poll interval, workflow timeout or check timestamp as atomic enforcement.

## Exact Repair and Reconciliation Contract

Keep ordinary admissions held while a separately authorized repair/revert is tested.
Do not require broken current main to pass before candidate testing. #3635 owns the
single bounded, deduplicated exact-SHA candidate request and receipt-verification
primitive; #3633 must use its merged interface, never add another scheduler.

The repair grant binds an authorization to repository, PR number, reviewed
head, base SHA, exact resulting integration SHA, unresolved failure identities,
approver/audit identity and bounded expiry. Review and normal merge authority remain
required. A label, prompt or author-provided receipt grants nothing. Changing head,
base, integration, current failure set or expiry requires new proof and approval.
Concurrent repairs cannot inherit one another's authorization.

Before exceptional admission, independently verify fast checks and named failing
scenarios on the exact authorized head/integration. Preserve normal review, merge
authority and the existing full merge-group check. The shared candidate primitive
accepts only main-ancestry targets; it supplies no pre-merge or merge-group
equivalence. Do not require broken current main to pass before admitting its repair.

After the squash merge, independently bind its actual SHA to the authorized group
tree and base, then request purpose=`repair` validation of that exact merged SHA.
A scheduling receipt certifies `none`; a green dispatcher or run title is not full
proof. Keep ordinary admissions held until fresh independent main health verifies
the exact merged target, current full run/attempt and suite, resolves the failures,
and meets freshness/backlog policy. A different SHA, superseded attempt, partial
inventory, changed workflow or unexpected main movement keeps the hold. Recovery
must work with all existing required contexts intact.

This contract is deliberately **not a live repair bypass**. The
[recovery rehearsal](main-merge-recovery.md) exercises hold → exact authorized
repair → purpose=repair merged-SHA validation → independent reconciliation →
release, plus ordered rollback, using historical health and inert fixtures.
Normal review/merge authority and separate activation approval remain mandatory.

## Dry-Run Evidence and Separate Operator Steps

See [the bounded read-only observation](main-merge-admission-shadow-2026-10-26.md).
It uses real authoritative health with an inert integration identity, not a natural
merge-group shadow job. No variable, ruleset, permission or repository status was
changed. Failure, expiry, out-of-order failure retention, base movement and competing
repair refusal are inert tests; no production regression is manufactured.

Separate human-authorized operator work, after remaining code and dry-run recovery:

1. Review measured thresholds, health completeness, call/runner costs and outage
   behavior. Confirm the exact candidate primitive and reconciliation are merged.
2. If approved, set only the shadow variable; retain observations from natural new,
   queued and building entries, including holds and expiry. Verify every artifact
   against its exact event and live health. Do not enable enforcement at this step.
3. Require a completed recovery/rollback dry run and an explicitly accepted forge
   race/bound. Obtain separate approval for any controller/status-writing identity,
   credential scope, required context/ruleset change or hold activation. These are
   not implementation permissions and are not requested by this issue's agents.
4. During future activation, keep the existing full queue required context while
   adding the exact approved admission context. Drain/rebuild old queue groups so
   pre-activation green checks cannot inherit admission. Verify the protected
   context's issuer and new/queued/in-flight behavior before considering fast cutover.
   The [disabled merge-group gate](ci-aggregation.md#disabled-merge-group-gate) refuses
   to reduce work until it reads exactly that issuer-pinned required context.

Rollback order is mandatory: **restore full queue regression validation first**,
verify exact-group full results (`scripts/ci-merge-group-restoration.mjs`, see
[Rollback and Restoration Proof](ci-aggregation.md#rollback-and-restoration-proof)),
then remove the hold only under separate operator
approval. Do not remove a required context or clear holds on a failing baseline to
make the queue green. Revoke outstanding repair authorizations, retain evidence and
reconcile current main. If the full baseline still fails, keep ordinary admissions
held and use the reviewed repair path; do not globally disable checks. Today full
merge-group validation is already intact, and disabling the advisory job affects no
protection. Never update the stack hosting an agent as part of this procedure.
