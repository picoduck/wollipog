# Runner Reconciliation Performance

This records the #2125 re-measurement against main
`f2337f163d2ecca2b26eda9b40af00e409dd18bb` on 2026-11-01. The earlier #2126,
#3749, #3758 and #3885 fixes are already present in that baseline.

## Remaining Cost and Change

Terminal registration and post-registration runtime republish already group 32 snapshots per
FULL transaction. Active registration still committed each existing session separately, including
an unchanged reconnect. For 500 idle sessions, 500 snapshot commits consumed about 2.7–2.8 seconds
of a roughly 3.9-second reconciliation. Runtime republish used only 16 commits and took about
0.7 seconds. Relaxing the runtime transaction would also relax control-plane settlements inside
it; the measurements did not justify that change.

Registration now also groups contiguous eligible idle/running snapshots, at most 32 per FULL
transaction. Pending service work, stop/deletion intent, ownership or row-version drift, duplicate
IDs, media/review lifecycle, worktree recovery, policy/hook work, prompt commands, pending decisions,
owed deliveries and cost repair retain the original paths. Exceptional snapshots settle before
the next active group is classified. A rolled-back active group falls back to those original
per-session paths, without publishing its failed changes. Failure of maintenance after COMMIT
propagates instead of retrying already committed work.

Post-commit policy evaluation and deliveries still run through their original FULL paths,
including work created by that evaluation. No #2125 safety rule required a design trade-off.
The claim-time implementation decision approved grouping while retaining these exclusions.
The [database durability policy](control-plane-database-durability.md) is unchanged: this change
does not add a NORMAL/replayableCommit exception, change checkpointing, or weaken secure deletion.

## Isolated Measurements

Linux, Node 24.18.1, AMD Ryzen 9 7900X3D, local NVMe ext4; `taskset -c 0-3` restricts the
measurement process to four logical CPUs. Each process opens its own copy of the same synthetic
seed: 500 sessions and 220,000 retained `agent_message` rows (440 per session, approximately
157 MiB). Fixture construction alone uses synchronous=OFF; measured connections reopen with
the normal WAL/FULL configuration. No live database is read or modified.

The probe constructs real ControlPlaneDb/Hub/SessionsService instances and measures
hydrateRunnerSessionsCooperatively for fresh registration and unchanged reconnect, then
applySessionRuntimeUpdates in 32-frame runs, yielding between runs. Wrappers time native COMMIT
calls and attribute them to the snapshot API. Event payloads are synthetic, with no pending
service obligations or costs. These are source-level measurements, not a complete transport or
dashboard benchmark; the real-server test covers that separate boundary.

Three alternating baseline/candidate pairs use fresh process/database copies. Baseline source
is extracted from the pinned main commit; dependencies are the same frozen workspace install
(the lockfile and protocol package are unchanged). This controls source and fixture differences,
but shared-host storage/CPU scheduling still varies. The table reports every paired measurement,
rounded to milliseconds, rather than claiming a universal latency guarantee.

| Phase | Baseline Runs (ms) | Candidate Runs (ms) | Snapshot Commits Before → After |
|---|---|---|---|
| 500 Idle Sessions: Registration | 3877, 3774, 3975 | 1032, 1026, 1025 | 500 → 16 |
| Same Sessions: Unchanged Reconnect | 3879, 4452, 3850 | 1015, 1013, 1017 | 500 → 16 |
| Post-Registration Runtime Republish | 717, 765, 720 | 723, 731, 740 | 16 → 16 |

Separate three-run terminal-session probes on main measured registration at 908–949 ms,
unchanged reconnect at 823–875 ms and runtime republish at 641–668 ms, already using 16 commits.
An isolated whole-connection NORMAL diagnostic reduced the idle 500-commit registration to
1.01 seconds; this confirms flush cost, but is not a production configuration proposal.

## Acceptance Evidence and Remaining Work

| #2125 Criterion | Main / Candidate Evidence | Status |
|---|---|---|
| Initial registration/reconnect with ≥1,000 retained sessions across campaigns | Existing real-server test: 1,500 children, ten campaigns, three registrations including replacement during inventory and exact newer-snapshot convergence. Three candidate repetitions and a further repetition after restoring the full post-policy delivery path passed, with unchanged bounds. | Automated coverage delivered; active grouping improves the remaining measured registration cost. |
| Coalesce attention once per affected campaign; avoid redundant replay work | Existing registration attention work-count and continuation transaction/idempotency tests pass. Terminal registration and runtime replay already group writes; candidate work-count tests now pin 70 active snapshots to 32/32/6 FULL snapshot commits and fail on baseline main. | Delivered in earlier fixes plus this change. Eligibility reads remain necessary safety checks. |
| Bounded work/yields; HTTP, heartbeats and Agent Control progress | Existing 32-snapshot cooperative yields and frame queue are retained. Candidate real-server maxima across four executions: HTTP/pong 143/143 ms, handshake 271 ms, convergence 5,625 ms, against unchanged two-second liveness/handshake and 60-second convergence assertions. | Delivered in automated fixtures; arbitrary storage stalls remain outside a hard guarantee. |
| Preserve stop/tombstone/ownership/decision/resume/report/continuation/worktree safety | Existing stop/deletion, history/report verification, continuation and ownership tests pass. Candidate tests exercise active-group version fencing, all admission obligations, duplicate order, rollback, post-commit maintenance failure, and fresh FULL policy decisions/delivery. Terminal/report/worktree-retirement algorithms are unchanged. | Preserved; no durability relaxation. |
| Disconnect/replacement/duplicates/live updates without stale writes or overlapping work | Existing cancellation/replacement tests and real-server newer-fingerprint assertion pass. Candidate extends the interleaved Stop/delete/answered-request/relaunch/worktree test to idle sessions and keeps exceptional snapshots in order. | Delivered in automated coverage. |
| Deterministic scaling and real-server regression tests that fail before the fix | Active registration work-count tests fail on main and pass with grouped commits. Existing real-server scaling regression continues passing. | Delivered. |
| Bounded sanitized duration/batch/campaign/completion/failure diagnostics | Existing reconciliation lifecycle diagnostics remain. New runner_reconciliation_batch_fallback identifies entry point, runner, reconciliation ID and bounded snapshot count, with no snapshot text or error contents. Injected write/commit failures verify its schema and retry behavior. | Delivered. |
| Verify repeated restarts/reconnects and latency on live dogfood | Read-only deployed checkout: 6bd00bf05a74e4a4ec7e84961804986eaa7d5744. Twenty sequential health requests returned 200 (max 16.954 ms). No readable tmux/journal reconciliation history established repeated operator restarts. Hosting services and databases were not changed. | **Missing: external operator deployment and repeated live restart/reconnect evidence. Keep under #2125; do not infer this from synthetic tests or idle health checks.** |

For the last criterion, an operator outside the hosting stack must deploy the eventual merged
commit and retain sanitized reconciliation start/completion/cancellation/failure diagnostics
around repeated restarts/reconnects, with concurrent health and heartbeat observations and exact
newer-state convergence. This hosted session must not perform those restarts. Original #2125
work remains open until that evidence exists; it does not need a duplicate issue.

The #3874 [verification census](https://github.com/picoduck/wollipog/issues/3874#issuecomment-6555528668)
separately records 81 distinct passing hosted executions after #3885, including two at its exact
unchanged merge commit. Its worst HTTP/pong maxima were 1,452/1,450 ms: passing evidence with
limited margin, not proof that runtime FULL transactions can never stall under slower storage.
