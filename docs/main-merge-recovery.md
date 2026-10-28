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
main movement or missing control state prevents admission. One independent health
rebuild runs first, followed by **one complete census**. Its main SHA must match
the independently re-pinned health main. Each exact target is evaluated against
that shared health, control and repair state. No prior passing decision is reused.
There is no second census or per-target health rebuild; movement after the census
remains an explicit forge race.

The underlying health `report` entry point independently verifies current full
evidence, incident pointers, ancestry, attempts, inventory and main. One quota-sized
48/96-call budget covers the CLI census and report, with the existing REST floor
and no retry. GraphQL queries use HTTP POST: the existing API counter calls those
`mutationCalls` by method, although the census and workflow-blob operations are read-only queries.
Do not misreport that counter as a state change.

Within each rebuild, `main-merge-admission-evidence.mjs` replaces three separate
workflow Contents reads at one exact commit SHA with one GraphQL query. It binds
the repository and commit object, requires all three complete nonbinary UTF-8
blobs (at most 1 MiB each), verifies byte lengths and Git blob SHA-1 hashes, and
supplies their original blob IDs and base64 bytes to the unchanged health observer.
The observer still checks workflow bindings and suite identity. Missing, partial,
binary, foreign, oversized or corrupt evidence, GraphQL errors and inaccessible
queries fail closed; no weaker fallback is used. The cache contains only those
immutable blobs and is discarded after the rebuild. Mutable refs, incident state,
run/attempt metadata, job inventories and listings are read and independently
rechecked as before. No prior health verdict is reused.
Batching starts only when the collector requests the rolling worker file; legacy
main-push runs that need only CI and Windows evidence retain their original REST
reads and do not require a worker file at their older revision. A committed
integration test runs the real complete collector, compares full health evidence,
asserts the two-call saving and proves main/attempt changes still invalidate it.

The outer admission budget counts actual transport calls, including each batched
query, census and status request. The health report's nested budget conservatively
counts its logical Contents requests as before; its `apiBudget` is not the wire
counter after batching. Both limits and the existing 60% REST quota floor remain
intact; header validation and GraphQL accounting still pass through the shared API.

`planAdmissionCycle` produces exact **Regression Admission** status plans for PR
head SHAs and group SHAs. It plans ordinary eligibility only for fresh evidence
within the proposed thresholds. Every held target gets a planned failure, including
queued and already-building targets whose previous checks were green. `expiresAt`
is evidence expiry, not a GitHub status TTL. Plans carry observation/entry-point
IDs, exact target identities, health digest, reasons and planned-block latency.

`writeAdmissionPlan` returns `{mode: "disabled", writes: 0}` by default without
calling an API. A future operator-owned host must explicitly supply configuration,
the exact repository/context, an authenticated API and
`revalidate({repository}, {api})`. **Once per batch**, that trusted callback must
independently rebuild live health, control state, authority and CI proof, then a
complete exact census, using only the supplied bounded API. The exported
`rebuildAdmissionCycle` implements the report/census/plan sequence; trusted
operator providers remain separately required and absent by default.

The adapter requires the entire fresh target set to match the requested exact
entries before writing anything. Missing/additional targets, changed heads/bases/
groups, duplicate target SHAs, malformed decisions and incomplete census refuse
the whole batch. Duplicate SHAs are conservatively refused rather than letting a
later eligibility decision overwrite a hold on the same status context. Serialized
input supplies identities only; only the independent callback supplies verdicts.

After the rebuild, preflight requires enough **remaining calls AND REST quota
above the existing floor for every planned status**. A shortfall records exact
planned/available counts, cap, reads used, quota and floor, then refuses with zero
writes. It never raises the 48/96-call cap or borrows another token. A successful
preflight is conditional on subsequent API availability: changed quota, receipt
failure or clock/lease expiry can still interrupt delivery. The adapter checks
cycle age (strictly less than 60 seconds) and positive-decision expiry immediately
before each write, validates receipts, and reports partial delivery with actual
acknowledged and attempted write counts (a failed request may have reached the
forge). Receipt timestamps, cumulative API calls and planned block latency
are auditable through the last completed hold. No automatic retry is configured.
A batch refusal is not an enforcement success: existing forge successes remain
until explicitly replaced. Merge groups receive a success only just in time, once
ready to land ([fail-closed group admission](main-merge-admission.md#fail-closed-group-admission)),
so only pull-request head successes, which gate enqueueing alone, can outlive an outage. The callback is an operator trust boundary,
never a deserialized artifact or an author-provided function.

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

The initial decision rehearsal plans a block **1,000 ms after the fixture
failure** and **0 ms after the observation-expiry boundary**. The extended
full-target rehearsal exercises the actual writer adapter, shared rebuild,
complete GraphQL census and all **45 hold receipts** using an inert API. It
reserves 36 synthetic health-report reads plus one census, matching the prior
37-read rebuild cost without asserting that every future health history costs
the same. Every API call takes an explicit **100 ms on a virtual clock**; no sleep
or live status request is involved.

| Full-Set Case | Arithmetic | Last Planned Hold |
| --- | --- | --- |
| Failure, 96-call cap | 1 quota + 36 health + 1 census + 45 statuses = **83** | **9,300 ms** after failure (1,000 ms initial delay + 8,300 ms calls) |
| Expiry, 96-call cap | Same 83 calls, one report and one census | **8,300 ms** after expiry |
| Same 45 targets, 48-call cap | 38 reads used; 48 - 38 = **10** writable; **35** short | **Zero writes**, incomplete; no block bound |

Both successful fixtures leave **13 calls** under the unchanged 96-call cap and
remain above the existing 60% REST quota floor. Property tests cover target counts
0–100, read costs 0–40, both quota sizes and quota headroom, including exact budget
boundaries. They compare actual writes with independent capacity arithmetic and
require either complete delivery or zero-write capacity refusal. Expiry during a
batch, main/head changes, incomplete census and changed target sets retain their
negative checks.

These are **planned full-set delivery bounds under explicit inert assumptions**,
not measured live enforcement. Real CPU duration is emitted separately and is not
included in virtual API latency. Actual request latency, runner delivery and
controller availability have no established upper bound. For a delivered cycle
with unchanged target identities, enough quota, call latency at most L and an
initial delay D and computation C, the conditional receipt envelope is D + 83L + C.
Forge visibility/landing races add a separate unbounded term. The proposed
60-second reevaluation interval only bounds D if a separately approved host can
actually guarantee that delivery interval. Full queue validation stays required.

A separate live read-only controller observation at **2026-10-26T01:54:35.936Z**
completed two matching censuses of **37 ready targets** (the previous controller). Main health was passing, zero
backlog, independently reverified at 01:54:29.783Z with the same exact worker and
main above. It planned **37 holds** because control state was unconfigured, and
zero writes. The whole cycle made **27 API calls: 25 REST reads and 2 GraphQL
queries**, with zero state changes. REST remaining was 4976/5000 (floor 3000),
GraphQL remaining 4733/5000; the 96-call cap was unchanged. This proves the live
census and default-deny operating point, not natural queue-group membership,
status-writing permissions, sustained cost or live enforcement.

A repeat at **2026-10-26T15:42:05.482Z**, after the first policy slice merged,
verified two matching complete censuses of **45 targets** (the previous controller) and planned **45 holds** for
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

A new read-only observation with the shared rebuild and **one census**, at
**2026-10-26T19:41:19.776Z**, found **35 targets and 35 planned holds** (control
unconfigured). Independent health at 19:40:58.266Z was pending, main
`8f9970a183348fe3a5c7a19ffedc089dd7a2d804`, passing worker `40379151336`,
two unvalidated commits. It used **53 calls: 52 REST reads and one GraphQL query**,
zero actual mutations, REST remaining 4964/5000 and GraphQL 4939/5000. The adapter
rejected every state-writing request. These CLI credentials still do not prove
future workflow-token access. The larger current health history costs more than
the earlier sample; the 37-read fixture is not a universal rebuild-cost claim.

The rehearsal also models that measured read cost: **53 + 35 = 88** calls delivers
the complete current-size set under the 96-call cap, taking **9,800 virtual ms**
from failure to the last planned hold with the same assumptions. At **45 targets**
with that read cost, **96 - 53 = 43** statuses fit, leaving a **two-write shortfall**.
That unbatched fixture refuses with **zero writes** and no block bound. It remains
in the rehearsal as the regression case; the batching delivery below addresses
this specific shortfall without raising budgets or weakening evidence.

### Slice 4: Batched Read Cost and Full-Set Delivery

The conservative updated fixture keeps the measured **53 unbatched reads**, but
uses just **one** complete three-file workflow batch. It executes the actual
batching adapter within the shared rebuild, not a smaller synthetic read count.
Every complete worker workflow verification reads these three files, so a known
full baseline supplies this opportunity. Other reads remain charged individually.
Additional workflow revisions can save more; unavailable evidence cannot supply
a pass and does not promise this saving. These are conditional capacity proofs,
not a universal maximum for future health histories.

| Case | Exact Arithmetic | Last Planned Hold at 100 ms per Call |
| --- | --- | --- |
| Prior 53-read cost, one batch, 45 failure holds | 53 - 3 + 1 = **51 reads**; 51 + 45 = **96/96**, **0 calls headroom** | **10,600 ms** after failure, including 1,000 ms initial delay |
| Same cost and set, expiry | Same **96/96**, **0 calls headroom** | **9,600 ms** after expiry |
| Same cost, 46 targets | 96 - 51 = **45** writable, **1** short | **Zero writes**, no block bound |
| Original 48-call short batch | 48 - 38 = **10** writable, **35** short | **Zero writes**, no block bound |
| Latest observed cost, two workflow batches, 45 targets | 38 - 6 + 2 = **34 reads**; 34 + 45 = **79/96**, **17 calls headroom** | **8,900 ms** after failure |

At the conservative measured-cost boundary there is no spare call: any extra
read needs fresh capacity preflight and may refuse the whole batch. Quota
headroom is checked independently; no REST floor or call cap was changed.
The conditional receipt envelope for that case is **D + 96L + C**, where D is
trigger-to-start delay, L an assumed per-call maximum and C actual computation.
The rehearsal emits CPU time separately. All statuses are inert; live latency
through the final held target still requires separately approved activation.

Two new read-only observations on **2026-10-26**, at **21:51:57.465 UTC**
(unbatched health start) and **21:52:21.618 UTC** (batched health start), used the
same main `e22d02a65fdc130b07731a4e45818dd4a47820ec`, passing worker
`40387489001`, one unvalidated commit and **36 census targets**. Both retained the
authoritative failure in worker
[40401596651](https://github.com/picoduck/wollipog/actions/runs/40401596651/attempts/1)
and planned 36 holds. Unbatched cost was **38 calls** (37 REST, one census);
batched cost was **34 calls** (31 REST, two workflow queries, one census).
REST remaining was 4947/5000 then 4925/5000, floor **3000**; GraphQL remaining
was 4733/5000 then 4860/5000. Independent buckets can reset between observations.
The read-only CLI adapter rejected every state-writing request; zero mutations
occurred. This proves current CLI read access, not future workflow-token access.

The complete saved real REST snapshot was also replayed locally through the
actual unchanged health `report` with and without batching, at one fixed clock.
Full health JSON, including failure, inventory, attempts, ancestry and workflow
blob identities, was identical after omitting only its budget counters:
SHA-256 `ea71cbcdf5bf4cb06421f5c64faf4c8097a1a1bef95a01eb618d51f5d11e7c22`.
Report transport calls fell **36 to 32**; adding outer quota and census gives the
same **38 to 34** comparison. This was a deterministic replay of public reads,
not fresh live authority. Existing independent end-of-observation main/run/listing
checks all still executed. The red worker is tracked under #3710; this slice
does not alter its tests or mask its failure.

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
a merge group's success exists only once its own aggregator succeeded and it is next
to land ([fail-closed group admission](main-merge-admission.md#fail-closed-group-admission)).
A controller or forge outage before that write leaves no success, and the queue removes
the group at its check-response timeout. Lease expiry still does not make GitHub expire
a status. A race between the last check/write and landing remains, bounded by
observation age, cycle age and GitHub's unmeasured landing latency. The adapter checks time/expiry before each write and binds all targets to one
independent census; it cannot make that snapshot or the writes atomic with GitHub
merging. New entries after the census wait for the next cycle. These races must be
included in a separately approved activation design. No finite unconditional
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
