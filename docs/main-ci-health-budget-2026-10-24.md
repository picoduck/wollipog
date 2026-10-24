# Main CI Health Budget Census

Refs #3654, follow-up to #3632 under #3625. The lighter merge gate remains disabled.

## Production Window and Method

This bounded census covers workflow creation from **2026-10-23 23:05:11Z through
2026-10-24 12:06:08Z**: fifteen natural Main CI Health invocations, seven eligible
observations and eight skipped events. No manual dispatch was used. Each observation
uses trusted main code at `3ee7eba780204cf1d4488819a2a32bd2375a2db6`,
`f6865fdf83db979eef6c7598e0112c04fd32deba`, or
`85044bee2a50e1d817d6886f3fb632f21d5c9c8b`.

Read the retained `main-ci-health-<run>-1/main-ci-health.json` and the reconcile job's
`main_ci_health_api_usage` and incident events. Workflow success alone is insufficient:
one successful workflow below produced unknown health. Counts include the primary-exempt
`GET /rate_limit`. Observation calls are the pre-write `apiBudget.calls`; final calls
come from the final usage event. Each completed write phase has three mutations
(tree, commit, GraphQL CAS) and one REST repository read. Thus total reads are final
calls minus three, rather than just the observation calls. All runs are attempt one.

| Health Run | Observation Calls | Total Reads / Mutations | REST / GraphQL Calls | Final REST Limit / Remaining | Final GraphQL Limit / Remaining | Lag | Active Worker | Health / Stop |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| [40037604208](https://github.com/picoduck/wollipog/actions/runs/40037604208/job/120700796313) | 38 | 39 / 3 | 41 / 1 | 5000 / 4897 | 5000 / 4965 | 1 | 40036470340 | pending / none |
| [40039995961](https://github.com/picoduck/wollipog/actions/runs/40039995961) | 35 | 36 / 3 | 38 / 1 | 5000 / 4960 | 5000 / 4987 | 0 | none | passing / none |
| [40051092648](https://github.com/picoduck/wollipog/actions/runs/40051092648) | 28 | 29 / 3 | 31 / 1 | 5000 / 4969 | 5000 / 4998 | 0 | none | passing / none |
| [40058153186](https://github.com/picoduck/wollipog/actions/runs/40058153186) | 40 | 41 / 3 | 43 / 1 | 5000 / 4972 | 5000 / 4999 | 1 | 40055850385 | pending / none |
| [40062898218](https://github.com/picoduck/wollipog/actions/runs/40062898218/job/120780010022) | 40 | 40 / 0 | 40 / 0 | 5000 / 4979 | unobserved | unknown (window 1) | 40060673346 | unknown / api-budget-exhausted |
| [40073105385](https://github.com/picoduck/wollipog/actions/runs/40073105385) | 36 | 37 / 3 | 39 / 1 | 5000 / 4976 | 5000 / 4999 | 0 | none | passing / none |
| [40092545465](https://github.com/picoduck/wollipog/actions/runs/40092545465) | 28 | 29 / 3 | 31 / 1 | 5000 / 4980 | 5000 / 4999 | 0 | none | passing / none |

Every observation reported `main_ci_health_unchanged`, with no incident open. The two
pending observations independently verified their full passing ancestor, retained
uncertified current main and lag one, and persisted through CAS while workers were active.
The exhausted observation retained its existing ref, certified nothing and mutated no incident;
its one-commit ancestry window is diagnostic, not a completed backlog measurement.
These runs demonstrate pending-to-passing recovery, **not** production incident closure.
No failing/incident-closing observation occurred in this bounded window; those paths are
fixture evidence only. Do not manufacture a production regression for this measurement.

## Sizing and Shared Headroom

The completed pending samples require 38–40 observation calls before persistence. The
third active-worker sample already needs more than 40 despite REST remaining 4979.
The old 40-read ceiling therefore limits normal traffic independently of quota scarcity.
The change first removes duplicate live pointer lookups; it retains final run revalidation,
all dispatcher listings and their final fingerprints, exact attempt jobs and workflow proofs.

Runtime policy, with observed REST limit `L`:

- Invocation cap: `min(96, floor(48 * L / 1000))`. Without valid headers the initial
  cap stays 48 and production stops unknown; it never assumes the measured 5000.
- Mutation-phase reserve: eight requests, unchanged, including author/repository reads.
  Exhausted observation cannot unlock it. At L=5000, observation stops at 88 calls.
- Remaining REST floor: `max(600, ceil(0.60 * L))`. At L=1000 this retains the old
  48/600 bounds; L=1500 gives 72/900; L=5000 gives 96/3000. Below 600, preflight
  cannot admit observation. Missing, invalid or changing limits stop unknown.
- Checkpoint-invalidated recovery: twelve requests inside the same invocation budget,
  unchanged. It never expands with quota. Existing pagination/evidence bounds still apply.
- GraphQL is an independent quota. Its headers cannot enlarge the REST budget or lower
  the REST floor; malformed GraphQL quota and GraphQL errors stop further mutation.

The focused production-entry-point fixture matrix covers pending, red and recovery at
lag zero through five with active-worker overlap. L=5000 consumes 34–59 calls for
pending, 40–65 for red and 38–68 for recovery, including persistence and incident work.
The non-verdict integration reads complete first-attempt jobs before deciding whether an older
worker is covered; the recovery matrix uses one additional request compared with #3655's 37–67.
The 96 ceiling leaves 26 observation calls above the largest matrix's observation
phase, plus its reserved write capacity. It doubles the old maximum without scaling
unboundedly for larger token limits. This is a measured fixture envelope, not proof
that every lag-five production history or rerun fits.

Let C, R and M count eligible main-CI completions, rolling completions and manual/report
invocations per hour. The unconstrained envelope is `B * (3 + C + R + M)`; at B=96,
three schedules plus one CI and one worker completion allow at most 480 calls/hour.
Skipped events and push/in-progress wakes add zero observation calls. Unbounded event
counts cannot be justified by schedule arithmetic. Serialized jobs and the live floor
bound aggregate admission: conservatively `L - F + B` exposed calls, leaving `F - B`
for shared consumers (2904 at L=5000; 552 at L=1000). Per-response checks normally
stop near the higher floor. Counters are not an atomic reservation, and concurrent
workflows and GitHub's distributed rate counters can erode this headroom.

Measured REST remaining is 4897–4980, at least 1897 above the new 3000 floor despite
active rolling workers and other workflows. Separate GraphQL remaining is 4965–4999
when sampled. This establishes observed shared headroom during this window; it does
not attribute consumption to individual controllers, establish sustained hourly demand,
or guarantee the six scheduled controller ticks arrive on time. The existing controller
fixture's 22 calls/tick models 132/hour before push/completion/admission/recovery traffic.
No controller token or permissions were changed. The new health counters distinguish
read/mutation and REST/GraphQL calls directly for later natural censuses.

## Availability Limits and Rollback

Long backlogs, many attempts, expired/missing evidence, changing main, listing races,
API failures, quota uncertainty and exhausted budgets still yield unknown. Only a
verified compatible full passing descendant can close a full incident. Alert markers
remain deduplicated. No gate, ruleset, merge-queue or required-check policy changed.

Rollback this sizing change through a reviewed PR to restore the 48-call/600-floor
policy; retain the existing observation artifacts and exact forge verification.
Low-quota wakes still make only the primary-exempt preflight. Never restore availability
by trusting stored verdicts, increasing credentials, retrying without bounds or enabling
the lighter merge gate. The post-merge observation below demonstrates the new runtime sizing
with an active natural worker; it does not remove the stated slow-API or long-history limits.

## Post-Merge Production Observation

PR [#3655](https://github.com/picoduck/wollipog/pull/3655) merged at
`a55a831b62d4ba1b8776f5e05fab5319422e9238` on **2026-10-24 18:22:01Z** after
successful PR CI and merge-group [40117722743](https://github.com/picoduck/wollipog/actions/runs/40117722743).
Its first merge group failed on the pre-existing Linux test probe ESRCH race; the unchanged-head
retry was separately approved and passed. No code was changed to work around that failure.

The post-merge census window is **18:23:07Z–18:23:32Z**, sample size **one** eligible
observation: authorized main dispatch [40120451028](https://github.com/picoduck/wollipog/actions/runs/40120451028),
running the merged commit. One of the three authorized census dispatches was used; no production
traffic or regression was manufactured. The worker overlap itself was natural.

| Measurement | Observed Value |
| --- | --- |
| Health observation | 2026-10-24T18:23:15.308Z; pending, no stop reason |
| Lag | 1 commit / 1 merged PR; landing 18:22:01Z; age 74.308 seconds |
| Active worker | [40120388345](https://github.com/picoduck/wollipog/actions/runs/40120388345), attempt 1, in progress, target/dispatcher a55a831b62d4ba1b8776f5e05fab5319422e9238 |
| Verified prior full pass | [40111820679](https://github.com/picoduck/wollipog/actions/runs/40111820679), target 074da66e914728cc51490b0b21928bd1246e6153 |
| Observation / final calls | 48 / 52, within cap 96 and observation ceiling 88 |
| Final reads / mutations | 49 / 3 |
| REST / GraphQL calls | 51 / 1, including the primary-exempt REST preflight |
| Final REST limit / remaining / floor | 5000 / 4931 / 3000 |
| Final GraphQL limit / remaining | 5000 / 4985, independent of REST |
| Health and incident behavior | CAS-persisted pending; no current certificate; no unresolved failures; incident unchanged, none open |
| Job duration | [120950646769](https://github.com/picoduck/wollipog/actions/runs/40120451028/job/120950646769), 18:23:10Z–18:23:32Z (22 seconds), success |

This common lag-one observation required **48 observation calls**, exceeding the former 40-call
ceiling while completing under the new policy. Final visible REST headroom is 1931 above the
reserved floor. The existing five-minute job timeout remains an availability limit under slow API
responses: neither a 96-request nor the former 48-request ceiling guarantees completion if each
request approaches its ten-second timeout. This observed job took 22 seconds.

The retained [Actions artifact 12570861625](https://github.com/picoduck/wollipog/actions/runs/40120451028/artifacts/12570861625)
is 3400 archive bytes, SHA-256
`fc0fb8a71622262dc4de5532375e3146aae11cc98d753c1f3b45634ee7b38648` (download verified).
Every serialized observation field matches `health.json` at pinned health-state ref commit
`ce1802af710471a5ba613bfc3a797369bdbc4bca`, sequence 9. The record's 48-call snapshot
precedes the four-call persistence phase; final logs contain 52. The correlation is
`observationId: "40120451028:1"`, `entryPoint: "workflow_dispatch"`.

This adds one post-merge pending/active-worker observation to the seven pre-change natural
observations above. It proves this production operating point and the writer's scoped quota/CAS
path, not sustained-load availability, lag-five production behavior or production incident closure.
Red and incident-closing paths remain fixture evidence in this census window.
