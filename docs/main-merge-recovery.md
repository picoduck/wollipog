# Disabled Regression Admission Controller and Recovery

Refs #3633. Uses the shared candidate primitive merged in #3678 as
`c8f9c4fa384fcafd0cfa27181ad3d497576341e3`. Its request signature and returned
receipt were verified from merged source. **No activation or live write authority.**
This is the code-only implementation and dry-run evidence, not an operational
claim that GitHub is enforcing a new required context.

## Controller and Writer Boundary

`scripts/main-merge-admission-controller.mjs` has one executable mode:
`MAIN_MERGE_ADMISSION_CONTROLLER=dry-run`. Every other value does no work.
The CLI has no operator authority, control-state provider, repair grant, status
writer or enabled mode. Inaccessible control state is a hold even if health is
green. It declares no workflow permission and changes no repository variable,
required context or ruleset.

One complete GraphQL census reads ready PR heads and queue entries, binding
repository, PR number, reviewed head, base and current group SHA. The controller
does not execute candidate code. It groups shared queue heads and records every
member; one repair authorization cannot carry unrelated PRs in a batch. A
100-target cap, truncation, duplicate identities, malformed data, queue movement,
main movement or missing control state prevents admission. The census is read
again after live health collection. No prior passing decision is reused.

The underlying health `report` entry point independently verifies current full
evidence, incident pointers, ancestry, attempts, inventory and main. One quota-sized
48/96-call budget covers the CLI census and report, with the existing REST floor
and no retry. GraphQL queries use HTTP POST: the existing API counter calls those
`mutationCalls` by method, although these two operations are read-only queries.
Do not misreport that counter as two state changes.

`planAdmissionCycle` produces exact **Regression Admission** status plans for PR
head SHAs and group SHAs. It plans ordinary eligibility only for fresh evidence
within the proposed thresholds. Every held target gets a planned failure, including
queued and already-building targets whose previous checks were green. `expiresAt`
is evidence expiry, not a GitHub status TTL. Plans carry observation/entry-point
IDs, exact target identities, health digest, reasons and planned-block latency.

`writeAdmissionPlan` returns `{mode: "disabled", writes: 0}` by default without
calling an API. A future operator-owned host must explicitly supply configuration,
the exact repository/context, an authenticated API and `revalidate(entry, {api})`.
Before **each** write, that callback must independently rebuild live identity,
health, control state, authority and CI proof using the supplied bounded API.
The adapter refuses incomplete censuses, changed entry identities, a cycle at least
60 seconds old or an expired positive decision. It validates each returned status
receipt and audits it; there is no retry. The same quota-sized budget covers writes
and callback reads. A budget stop or partial failure needs reconciliation, not an
alternate token. The callback is a trusted operator boundary, not a deserialized
artifact or an author-provided function.

No workflow grants `statuses:write`. Simply merging this module, setting an
environment string, adding a label or writing a prompt cannot activate it.
Future integration requires separate human approval for the trusted host and its
authority/proof providers, token issuer/scope, scheduling, required context, and
activation. The existing full required context stays intact throughout.

## Repair Admission and Exact Merged Validation

An exceptional repair must have an exact operator grant binding repository, PR,
head, base, integration kind/SHA, failure fingerprint, authorization ID, approval
time and expiry. The injected `verifyAuthority` must verify that exact current
grant through the operator-owned boundary and return its digest. No verifier is
configured by default. `verifyChecks` must independently verify the exact
head/base/integration, passing fast checks and failing scenarios; normal review
and merge authority remain required. The callbacks must never treat a label,
prompt, cached receipt or a claimed `approved` field as authority.

Even an exact grant cannot substitute for unknown, expired, foreign or incomplete
health. The repair path requires a fresh authoritative known-failure or budget
overrun report, verified failure identities and intact baseline/backlog evidence.
The observer's `stale` status is eligible for this exception only when its sole
reason is `oldest-unvalidated-change-exceeds-budget`, the observation itself is
fresh, and the admission age limit is independently exceeded. This is a verified
age-budget hold; expired observations and missing or stalled validation still
cannot authorize a repair.
The code-only writer also refuses an unavailable clock before any status request.

New PR and group SHAs are separate integration identities. A PR-stage decision
cannot be reused for its later queue group. A changed head, base, group, failure
set or expiry requires new authorization. A one-PR repair grant cannot admit a
batched group. In-flight reconciliation prevents a competing repair from
inheriting the first grant. Grant expiry after a valid admission does not erase
its historical binding or strand post-merge observation.

`mergedRepairBinding` reads the merged PR and exact Git commit objects, requires
the approved head, main repository/base, a single squash parent equal to the
approved base, and a merged tree identical to the authorized group. It rechecks
the PR and main after observation. The queue group and actual squash SHA may
differ, so neither a run title nor a presumed SHA equivalence is enough. This is
an identity binding; it does not certify an unmerged candidate.

`requestMergedRepairCandidate` uses only:

```js
requestCandidate(repository, exactMergedSha, { purpose: "repair", api, now })
```

It adds no scheduler or cooldown and does not require broken current main to pass
before requesting validation. The shared primitive validates main ancestry,
deduplicates across purposes and enforces its bounded allocation. It can reuse a
verified existing exact-suite worker. `scheduledPurpose: "release"` is therefore
compatible with a requested repair purpose; an allocation claim is not necessarily
the worker's original claim. Scheduling receipts always certify `none`.

`repairRecovery` releases only after a **fresh independently collected health
report** fully certifies the exact merged SHA and the receipt matches its target,
suite and current full run. Pending reruns, newer failures, receipt-only success,
wrong purposes/suites, incomplete evidence and main movement hold. The initial
implementation is deliberately conservative: main must still equal that repair
SHA; unexpected movement requires new exact reconciliation, not descendant
extrapolation. The operator must preserve durable active-repair/control state
until reconciliation finishes. Unavailable state must not be interpreted as no
active repair. Raw cached JSON is not a production input verifier.

## Evidence and Measured Decision Bound

Run `node scripts/rehearse-main-merge-admission.mjs` after the candidate dependency
is merged. It replays a projection of the real authoritative observation at
2026-10-26T01:00:10.276Z, main `b0b1313e420df3f537c4abf5a080ff978f6b65f6`,
passing worker [40229673312](https://github.com/picoduck/wollipog/actions/runs/40229673312/attempts/1).
The original full-report digest is
`bceec599469d54bebe838cd5f7dc397c112ff6d9788cb4620fbdd414a436ac2e`.
The projection is explicitly historical test data, not a fresh certificate.
Every failure, authorization, CI proof, merge, request, full result and rollback
approval in the remaining sequence is an **inert fixture**. No live regression,
workflow dispatch, exceptional merge or status write was manufactured.

| Rehearsal Phase | Result |
| --- | --- |
| Failure and expiry | Held ordinary work |
| Authorized exact head, fast and failing-scenario proof | Repair alone eligible; review/merge authority retained |
| Exact squash tree/base reconciliation | Bound to actual merged SHA |
| Shared purpose=`repair` request | Exact merged target, receipt certification `none` |
| Pending validation or receipt without health | Held |
| Independent exact merged-SHA full health | Release eligible |
| Rebuilt entries on repaired main | Ordinary eligibility restored |
| Rollback before full queue restoration | Hold retained |
| Full queue restored and exact operator approval | Manual hold-removal plan only; no live removal |

The recorded local rehearsal planned a block **1,000 ms after the fixture failure**
and **0 ms after the fixture observation-expiry boundary**. Measured computation
was 0.501 ms and 0.097 ms respectively in the latest local repeat. Virtual failure/expiry timestamps and real
CPU duration are separate measurements; these values are not live detection or
forge invalidation latency. The proposed 60-second reevaluation interval gives
only a conditional decision envelope: next delivered cycle plus API observation
and computation. No scheduler or provider delivery bound is established.

A separate live read-only controller observation at **2026-10-26T01:54:35.936Z**
completed a stable census of **37 ready targets**. Main health was passing, zero
backlog, independently reverified at 01:54:29.783Z with the same exact worker and
main above. It planned **37 holds** because control state was unconfigured, and
zero writes. The whole cycle made **27 API calls: 25 REST reads and 2 GraphQL
queries**, with zero state changes. REST remaining was 4976/5000 (floor 3000),
GraphQL remaining 4733/5000; the 96-call cap was unchanged. This proves the live
census and default-deny operating point, not natural queue-group membership,
status-writing permissions, sustained cost or live enforcement.

A repeat at **2026-10-26T15:42:05.482Z**, after the first policy slice merged,
verified a complete stable census of **45 targets** and planned **45 holds** for
unconfigured control state. Main was `5f6743109ea487503f08a701c10714c7b702b937`;
the independent health report at 15:41:49.353Z was pending with one unvalidated
commit and passing snapshot run `40280462697`. The cycle used **39 API calls:
37 REST reads and 2 read-only GraphQL queries**, zero state changes, REST
remaining 4908/5000 and GraphQL remaining 4849/5000. This used the existing CLI
login through an adapter that rejects every state-writing request; it does not
establish future workflow-token permissions or operator trust-provider readiness.

The local compatibility run passed **729 scripts tests**, including the complete
inert rehearsal, against an unchanged temporary copy of #3678's provisional shared
helper (SHA-256 `4c8835528f432f9e44a9cd7084ba15f2d2785f42079a88dad3337ec3994ffdf8`).
That temporary helper was removed, not included in this slice. The actual merged
helper has the identical SHA-256. The repeat against merged source passed all
**744 scripts tests**, with zero failures or skips, and the recovery rehearsal.

A later campaign merge-group observation illustrates the scheduling limitation.
Run [40318437984](https://github.com/picoduck/wollipog/actions/runs/40318437984),
group `5e3cc43ea022ba3b746e72841c9763174b977c52`, was created at 11:53:44 UTC.
At the bounded read at **12:46:26 UTC**, **52 minutes 42 seconds** later, browser
shards 1, 3 and 4 were still queued. Shard 2 had waited 19 minutes 5 seconds and
then run for 22 minutes 29 seconds; unit/bundle work started only at 12:45:52.
This is partial campaign queue-pressure evidence, not a completed rolling-worker
duration or a steady-state traffic sample. It reinforces why neither the earlier
seven-worker timing sample nor a proposed reevaluation interval establishes a
delivery guarantee. No retry, new capacity or policy activation was used to
manufacture faster results.

At **13:54:48 UTC**, the same three shards were actively testing: shard 1 had
started at 13:36:04, shard 3 at 13:38:10 and shard 4 at 13:38:35. Their queue waits
were therefore **102 minutes 20 seconds**, **104 minutes 26 seconds** and
**104 minutes 51 seconds**. Queue delay alone exceeded the earlier two-worker
runtime sample's 92.84-minute envelope. This does not measure rolling-worker
dispatch latency, but it demonstrates why the proposed two-hour age cutoff is
a conservative hold threshold rather than a validation-completion guarantee.
Operator approval must account for such availability tradeoffs before activation.

The queue timeline then recorded removal at **13:54:31 UTC**, reason
`checks_timed_out`, before those shards finished; no failing test was reported.
The campaign operator identified runner saturation during a Dependabot burst,
cancelled the obsolete run and separately authorized a same-head enqueue.
This episode illustrates an external scheduling limit; it does not demonstrate
an admission-policy hold or justify changing queue rules, budgets or thresholds.

**Actual enforcement bound remains none while disabled.** After future activation,
a status success remains sticky if the controller stops. Lease expiry does not
make GitHub expire the status. Full controller outage, API outage, incomplete
census, quota stops and a race between the last check/write and landing can leave
a prior status unchanged. The adapter rechecks before each write but cannot make
those operations atomic with GitHub merging. No finite unconditional
failure-to-block bound is claimed. The full queue remains required; do not cut
over if the separately approved operator bound cannot be demonstrated.

## Operator Activation and Rollback

These are future, separately approved human steps, not actions requested or
performed by the implementation agent:

1. Review this evidence, proposed thresholds, API and runner costs, state recovery,
   issuer restrictions and the accepted forge race. Provide a trusted default-main
   host, durable control/repair state and independent exact authority/CI verifiers.
2. Run natural dry-run observations and the complete recovery/rollback rehearsal.
   Recheck the actual workflow token and callback source; CLI credentials do not
   prove workflow access. Missing providers keep the controller disabled/held.
3. Only after separate approval, provision the restricted writer and scheduling,
   prime the exact new context for live PR/group identities, and add the exact
   **Regression Admission** required context with its approved issuer. Preserve
   **Typecheck, Test & Sidecar Bundle** and full group coverage. Drain/rebuild old
   groups rather than inherit pre-activation successes. Activate only after testing
   new, queued, building and already-green behavior against the approved bound.
4. For rollback, **restore and independently verify full queue validation first**.
   `planRollback` cannot propose hold removal without that exact proof plus a
   separate operator approval bound to its digest. It always retains the hold in
   dry run. Removing an admission context/hold is a manual human operation; full
   required CI remains enforced, including on a failing baseline. Keep ordinary
   integrations blocked by full validation and repair forward without globally
   disabling checks. Preserve the repair/audit records and reconcile current main.

Do not update or restart the stack hosting an agent to perform these steps.
