# Native Pending Validation Evidence

This observation gates #3631's separate legacy main-push cutover. Native pending
behavior shipped in [#3657](https://github.com/picoduck/wollipog/pull/3657), merge
`6df9e76966d9740c1582d2b5d280190e455873ba` at 2026-10-24 21:59:24 UTC, after
the shared helper and health integration landed in #3658. The lighter merge gate
remains disabled. PR/merge-group full validation is unchanged.

## Natural Automatic Handoffs

A bounded read-only watcher started 2026-10-25 01:45:45 UTC, reading Actions about
every ten minutes. It retained earlier post-merge run history too. It ended at
16:13:13 UTC after 87 polls with no API errors, before the 21:59 UTC deadline.
No manual worker dispatch, synthetic main push, cancellation or manufactured
merge was used. Both queued workers were directly observed pending while their
predecessors were in progress.

| Prior Worker | Pending Worker | Push Controller | Pending Created (UTC) | Prior Last Job Finished (UTC) | Admission Started (UTC) |
| --- | --- | --- | --- | --- | --- |
| [40204835575](https://github.com/picoduck/wollipog/actions/runs/40204835575) | [40206675459](https://github.com/picoduck/wollipog/actions/runs/40206675459) | [40206656303](https://github.com/picoduck/wollipog/actions/runs/40206656303) | Oct 25 15:23:06 | Oct 25 15:34:41 | Oct 25 15:34:44 |
| [40206675459](https://github.com/picoduck/wollipog/actions/runs/40206675459) | [40208932298](https://github.com/picoduck/wollipog/actions/runs/40208932298) | [40208912642](https://github.com/picoduck/wollipog/actions/runs/40208912642) | Oct 25 15:51:39 | Oct 25 16:07:47 | Oct 25 16:07:50 |

The first pending target is `796f45fc2cf98c2a381aa03f5d2d2bec1b4f4ad9`, claim
`140793d0-e64c-4e1d-b833-2dcf3dbbe594`; the second is
`6726c68c733e14cb938518b7c1284920b499a8f0`, claim
`9eca5061-5e5f-47da-bf51-a482ba85286f`. Push-controller summaries persist those
claims before dispatch with the corresponding predecessor IDs. Admission confirms
the still-current claim and all nine exact-checkout receipts succeed. Both
predecessors finish the complete required job inventory successfully.

The runs form a linked A→B→C chain; each admission starts three seconds after
its predecessor's final job. Their run-level completion timestamps are one second
after the final-job timestamps. No legacy main-push completion occurred between
either predecessor's finish and its successor's admission. Pending runs already
existed, so a later completion callback was not needed to dispatch them. This is
direct evidence of native concurrency progression, independent of the relay and cron.

## Same-Window Outcomes and Cost

Window: **2026-10-24 21:59:24 through 2026-10-25 16:13:13 UTC**. The calculation
uses the completed exact attempts inside that window, reusing #3626's
`attemptRecord`/`listJobs`; rolling measurements remove the reusable caller prefix.

| Measure | Rolling | Legacy Main Push |
| --- | --- | --- |
| Completed full verdicts | 3 successes | 1 success |
| Terminal cancelled runs | 0 | 2 |
| Known completed-attempt runner-minutes | 565.02 | 494.75 |
| Missing job timing in included attempts | 0 | 0 |
| Dispatch to successful verdict, min / median / max | 33.63 / 34.73 / 44.70 minutes | 33.28 minutes (one success) |
| Forge landing to successful verdict, min / median / max | 33.90 / 34.98 / 44.95 minutes | 33.30 minutes (one success) |
| Unfinished runs excluded from cost and verdict totals | 1 | 1 |

Rolling completed runs: `40136616705`, `40204835575`, `40206675459`.
Legacy included runs: `40136602471` (success), `40204817924` and `40206656337`
(cancelled). Rolling `40208932298` and legacy `40208912713` were still active
at the cutoff; later results do not retroactively enter this fixed window.

Landing times come from the exact merge commits of [#3657](https://github.com/picoduck/wollipog/pull/3657),
[#3663](https://github.com/picoduck/wollipog/pull/3663) and
[#3665](https://github.com/picoduck/wollipog/pull/3665), independently matched to
their main-base PR merge timestamps. The rolling committer-time proxy has a
70.00-minute median because it includes merge-group residence; it is not the
34.98-minute landing-based validation lag. Cancelled legacy attempts supply cost,
not verdict latency.

These are observed elapsed runner-minutes, not billing totals or a causal savings
claim. Rolling completed more validation; legacy consumed time on cancelled work.
Shadow ran both full paths and added overhead. Controller, relay and health costs
and partial unfinished execution are outside these full-validation cost totals.

## Health Evidence and Limits

The independent live read-only health collector reported current main
`6726c68c733e14cb938518b7c1284920b499a8f0`, `pending`, latest attempt
`40208932298` and latest verified full passing snapshot `40206675459`.
This diagnostic scan used 177 GET requests without production quota admission;
it verifies classification evidence, not the production job's budget or wake latency.

**No pending worker was superseded in this window.** Therefore no live worker
non-verdict was available to compare with health; the observed non-verdict count
is zero, rather than a claimed classification success. Natural traffic demonstrated
two handoffs, but not replacement of an older pending target. The shared helper,
health integration and fake-API tests cover cancelled unstarted workers and explicit
superseded-admission receipts. No run was cancelled or dispatched just to manufacture
a sample. Exact-head ready admission must explicitly consider this remaining live
evidence limitation. The two legacy cancellations above are executed legacy work,
not superseded rolling non-verdicts.

The watcher retained the raw run listings, exact-attempt jobs, controller claim
records and state snapshots locally. Their identities and timestamps above can be
re-read from Actions while GitHub retains them. Coordination refs and uploaded
observations never replace independent checkout/job verification. Completion wake
delivery and cron remain best-effort; an entirely missed idle push needs another
delivered event or manual reconciliation. See the [operating runbook and rollback](main-rolling-validation.md).
