# Initial Rolling Main Shadow Observation

Stage one, PR [#3645](https://github.com/picoduck/wollipog/pull/3645), merged as
`468c54a0dde2509a43a1e28626b0d0b5f3d9753b` at 2026-10-23 15:15:07 UTC.
The existing main-push full suite remains enabled. No cutover has been performed.

## Identified Window and Results

The first shadow window is 15:15:07–16:09:03 UTC on October 23. Main did not
advance during that window. This is one naturally merged snapshot, not a causal
before/after sample or evidence of savings under sustained traffic.

| Cohort | Run | Verdict | Runner-Minutes | Created to Required Result |
| --- | --- | --- | --- | --- |
| Rolling shadow | [39976704984](https://github.com/picoduck/wollipog/actions/runs/39976704984) | Success | 207.15 | 46.40 min |
| Same-SHA main push | [39976663148](https://github.com/picoduck/wollipog/actions/runs/39976663148) | Success | 177.42 | 40.45 min |
| Pre-merge full merge group | [39970322381](https://github.com/picoduck/wollipog/actions/runs/39970322381) | Success | 208.62 | 43.65 min |

Measurements reuse `attemptRecord`/`listJobs` from
`scripts/merge-queue-wait-report.mjs` (#3626). All are first attempts, with zero
missing job timing entries. These are sums of Actions job execution times, not
GitHub billing invoices. Rolling job timing includes its admission job; the
controller's execution is separate overhead. No savings are claimed: shadow
adds a complete validation to the ordinary main-push run.

The rolling verdict completed at 16:01:51 UTC. Dispatch-to-verdict lag was
46.42 minutes. Commit-to-verdict was 90.97 minutes, explicitly the committer-date
proxy: the squash commit was authored before the merge-group execution, so this
proxy includes time before it actually reached main. Merge-to-verdict, using the
forge's 15:15:07 merged timestamp, was 46.73 minutes. The rolling critical-path
wait/execution split remains unknown because of the extra admission dependency;
individual job timing and total runner-minutes are measured.

## Exact Identity and Inventory

- Schema: `main-rolling-validation-v1`; repository: `picoduck/wollipog`.
- Target, tested SHA, suite revision, dispatcher and workflow source SHA:
  `468c54a0dde2509a43a1e28626b0d0b5f3d9753b`.
- Run/attempt: `39976704984` / `1`; claim:
  `4f4e584b-86df-46b1-b110-7063650880cb`.
- Worker blob: `f3c8f901cdbbf4573e0ab2b5d29ad89095bd13d9`.
- Full CI blob: `0e1859453dd60a86abf675959cbef108a5d3ffec`.
- Windows blob: `52d074abd60837b694fc6fc82efb03fcb7763fa7`.
- Suite version SHA-256:
  `8335b28daee185d587d4a72f79c5c44fae71fc3f64036b0ac991cc5161e983a4`.

All ten required outcomes succeeded: Node/typechecks/bundles, five Chromium
shards, WebKit, Windows change detection, Windows comparison, and aggregation.
All nine checkout-job assertions succeeded. The observer independently verified
workflow-source and target ancestry against the live-main snapshot. Ordinary
main CI ran the same full job inventory; its Windows comparison was conditionally
skipped because the push had no baseline change, whereas the rolling dispatch
conservatively executed comparison. No PR or merge-group suite became optional.

This first run has equal dispatcher and target SHAs. It does not exercise their
divergence. Consumers must continue to use the run claim and verified checkout
steps, rather than check-run attachment, to identify a tested target (#3632).

## Coordination and Remaining Cutover Gates

The [push controller](https://github.com/picoduck/wollipog/actions/runs/39976663184)
succeeded, persisted intent before dispatch, and admission recorded the worker.
The initial observed active-state OID was
`00ccc7916eb3dab3162ec5fed15fb35ec0da99c8` (sequence 3).

After worker completion, the state still pointed to active work. A documented
[manual reconciliation](https://github.com/picoduck/wollipog/actions/runs/39983902556)
succeeded and recorded `current-target-completed`, with `active: null`,
`pending: null`, and the verified verdict pointer. The resulting state OID was
`85fba67601fdd79f5f174cc24fa90c481ec88392` (sequence 4). The worker census remained
one: reconciliation did not dispatch duplicate validation. The state ref remains
untrusted coordination, not certification.

At the window's end, no scheduled or completion-triggered controller run appeared
in the Actions API. The controller workflow was active. The cause and eventual
delivery are unverified; manual recovery alone does not prove periodic or
completion-driven progress. Do not treat configured event wiring or passing
fixtures as live delivery evidence.

Before removing main-push fan-out, observe automatic reconciliation and collect
the [campaign's ready-admission window](main-rolling-validation.md#shadow-verification-and-cutover-gate):
five natural completed verdicts including live coalescing, or 24 hours after the
stage-one merge with at least three natural completed verdicts. Neither threshold
is met in this initial window. Preserve all observations and export updated records
for the larger normal-traffic window.
Do not create unrelated merges, cancel workers, or dispatch duplicate full runs
to obtain the sample. Review and verify the precise cutover/rollback separately,
then obtain exact readiness and merge admission. Main-push CI remains the safety
path until these gates are satisfied. The lighter merge gate stays disabled.

## Completion Wake Gap and Next Natural Push

The second natural worker,
[40016012094](https://github.com/picoduck/wollipog/actions/runs/40016012094), tested
`784d96e50d4d7bf5ee641d476aa57ccf886fd32b` and completed successfully at 20:39:09 UTC.
Neither this completion nor the first produced a controller `workflow_run` entry.
Only one scheduled controller appeared between 15:15 and approximately 20:15:
[40010704406](https://github.com/picoduck/wollipog/actions/runs/40010704406) at 19:20:59.
The independent health subscriber did receive the second completion at 20:39:24 in
[40020898293](https://github.com/picoduck/wollipog/actions/runs/40020898293). Its separate
health-script failure is addressed by [#3651](https://github.com/picoduck/wollipog/pull/3651).
No controller run entry means the job predicate cannot explain the observed gap;
GitHub's exact suppression mechanism is unproven. Configured cron is not a recovery
latency bound, and the durable pending target is not a queued GitHub worker.

The next natural merge, [#3644](https://github.com/picoduck/wollipog/pull/3644), reached
main as `98accc6be15171f931a90a2f9de602b0048cf330` at 21:02:55 UTC. Its
[push controller](https://github.com/picoduck/wollipog/actions/runs/40023860676) was
created at 21:02:56 and succeeded; it dispatched
[worker 40023903319](https://github.com/picoduck/wollipog/actions/runs/40023903319) at
21:03:17 with claim `99530ef0-8075-484d-bbff-edc9ba363b76`. Admission succeeded for
that exact target. This observation establishes idle-after-verdict push admission,
not completion-driven progress or coalescing; the worker was still active when
this sample was recorded. No manual wake was used for this sample.

The proposed independent **Main Rolling Relay** must ship and demonstrate recurring
live completion delivery in shadow before cutover, including at least two consecutive
relay-originated controller → worker → relay → controller cycles. A first relay wake
from a push-originated worker does not test suppression once the relay itself is in
the chain. Preserve each run ID, event and dispatch linkage. Its static admission
tests establish routing and token scope only. A fully missed idle push still requires another
delivered event or an operator's manual controller dispatch.

## Post-Relay Live Result

Shadow relay PR [#3648](https://github.com/picoduck/wollipog/pull/3648) is verified MERGED as `723ce352d57ff72812dfb00e5e8c6182b6b33e2b` at 2026-10-24 15:03:08 UTC. Its [merge-group run 40102698714](https://github.com/picoduck/wollipog/actions/runs/40102698714) passed; exact reviewed head was `e61003621f2078f172ca814f8804ba0659de8461`. Legacy main-push full CI remains enabled.

**Live result: cutover is still blocked.** Worker [40105230793](https://github.com/picoduck/wollipog/actions/runs/40105230793) completed successfully at 15:37:06 with all exact-checkout/job evidence verified. Main had advanced naturally to `11de60a49e1fb14462cdeff25a8053303b6469de` during that worker. No relay/controller completion entry appeared then. The next relay [40108449808](https://github.com/picoduck/wollipog/actions/runs/40108449808) appeared at 15:45:45, three seconds after [legacy CI 40105798151](https://github.com/picoduck/wollipog/actions/runs/40105798151) completed, and shared its `github-merge-queue[bot]` actor; the worker's actor was `github-actions[bot]`. That relay dispatched [controller 40108454729](https://github.com/picoduck/wollipog/actions/runs/40108454729), whose persisted claim `33d1921c-dca8-43ac-990e-1b2b285fb47f` matches new [worker 40108478451](https://github.com/picoduck/wollipog/actions/runs/40108478451). This proves relay dispatch/pending-target progress after legacy completion, not recurring worker-completion progress. No manual wake or manufactured merge was used.

Correction to the earlier health-subscriber inference: historic health run40020898293 at20:39:24 followed canceled legacy run40015972562 at20:39:22 and shared its merge-queue actor. It did not establish worker-completion delivery. This behavior is consistent with the [published GITHUB_TOKEN-dispatch/workflow_run reproduction](https://github.com/orgs/community/discussions/48748) and [GitHub's general generated-event restrictions](https://docs.github.com/en/actions/concepts/security/github_token). The internal cause remains an inference; the missing worker wake and legacy dependency are directly observed. The required two consecutive relay-originated worker cycles remain **0/2 verified**.

Measurement window 2026-10-23 15:15:07 through 2026-10-24 15:51:23 UTC, reusing #3626's attemptRecord/listJobs and the rolling exact-evidence observer: seven completed rolling verdicts, all success with verified checkouts, **1,287.03 known runner-minutes**. One newer worker remains active and its unfinished execution is excluded from that sum. Over the same window, eight legacy push runs produced four success, two failure, two cancelled, **1,328.93 runner-minutes**. All included terminal attempts are first attempts with no missing job timing. Rolling dispatch-to-verdict min/median/max: **33.68/34.27/46.42 min**; successful legacy push-created-to-required-result: **33.70/34.31/40.45 min**. These are Actions execution sums, not billing invoices, exclude controller/relay overhead, and are different completed-target counts; no causal savings claim. The numeric natural-traffic threshold is met, but the automatic-progress blocker prevents cutover.


The next repair uses a durable native pending worker. Before cutover, verify two
consecutive natural pending-to-active transitions without legacy-CI dependency,
and health classification of unexecuted cancelled pending workers as non-verdicts.
Static fake-queue tests are not live proof of either requirement.
