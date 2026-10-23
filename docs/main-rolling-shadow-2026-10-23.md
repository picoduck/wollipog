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

Before removing main-push fan-out, observe automatic reconciliation and main
advancing during an active worker, followed by newest-target progress. Preserve
all observations and export updated records for that larger normal-traffic window.
Do not create unrelated merges, cancel workers, or dispatch duplicate full runs
to obtain the sample. Review and verify the precise cutover/rollback separately,
then obtain exact readiness and merge admission. Main-push CI remains the safety
path until these gates are satisfied. The lighter merge gate stays disabled.
