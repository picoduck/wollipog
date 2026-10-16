# Successor-Election Fixture

`provider-home-lease.test.ts` runs two real Node children against the same temporary HOME and
released legacy lease. It still requires exactly one winner, one competing-owner refusal, and
successful exits. Structured fail-closed lease refusals and the explicit checkpoint-in-progress refusal count as
losing outcomes. Before publishing its result, the
loser also verifies that the winner's completed canonical lease is readable and excludes a competing
process with the exact winning PID. Provisional outcome/PID claims diagnose two refusals immediately
instead of making the contenders wait on each other's final results. Errors outside those recognized refusal paths fail. Invalid stable lease evidence or a
second successful acquirer also fails; the registry may wrap errors during chain verification as
structured refusals, so this fixture does not classify the original cause of every refusal.

Each child loads the registry, proves native helper availability with the fixture HOME, and sends
a flushed readiness message before waiting for the shared start barrier. The parent opens that
barrier only after both children are ready. No production lease deadline or ownership check changes.

| Fixture Phase | Bound |
| --- | ---: |
| Both children ready, including loader and native-helper initialization | 10 seconds |
| Both results published after the start barrier | 10 seconds |
| Graceful exit after release | 5 seconds |
| Forced cleanup of fixture-owned trees | 5 seconds |

The first controlled probe injected 2.6 seconds of startup and 2.6 seconds of publication delay.
It reproduced the original reporting assertion twice; removing either delay passed. Native Windows
measurements then showed an acquisition taking 2.887 seconds plus a 0.492-second losing-contender
verification, so the artificial publication pause left too little of the five-second reporting
window. That was a defect in the initial regression, not grounds to expand reporting limits.

The startup regression initially injected 5.2 seconds of startup and no publication pause,
with a fifteen-second readiness allowance. That caught the original five-second reporting window,
but after the reporting allowance increased to ten seconds, removing only the readiness wait still
passed in a controlled 5.626-second Linux run (#3274).

The regression now derives its startup pause from the reporting window: ten seconds plus two
seconds of separation, with no publication pause. Its separate twenty-two-second readiness bound
adds the normal ten-second native setup margin to that twelve-second pause. Without the readiness
wait, reporting expires before startup finishes; with it, real acquisition/publication/verification
retains the full ten-second reporting allowance. `verify-successor-readiness-regression.mjs` makes
a temporary copy beside the test, removes only the parent readiness wait, and requires the exact
focused test to fail at the reporting deadline with both contenders closed and no retained fixture
state. Platform Isolation runs this check on Linux, both Windows images, and macOS, after the
unmodified lease suite. The temporary copy is removed even if verification fails.

Normal readiness is ten seconds: Windows PR validation at head `7ba963e4` failed a post-report fault regression
before reaching that fault, with both contenders still initializing when the prior five-second
readiness deadline expired. Other measured Windows runs reached readiness around 0.8–1.1 seconds;
this full-suite outlier supports a separate bounded setup allowance.

Windows dispatch validation at head `bbd2d330` then measured a winner acquisition of 5.389 seconds
and losing-contender verification of 0.884 seconds. Both contenders exited successfully with one
winner and one refusal, but reporting crossed its former five-second bound. This measures actual
post-readiness work, so the reporting allowance is now a finite ten seconds. Graceful exit and forced
cleanup retain five seconds each, and production deadlines remain unchanged. The focused load runner
allows 35 seconds for the fixture and 45 seconds overall; five outer timeouts plus owned-tree cleanup
fit within the existing five-minute validation step.

These measurements establish a defect in the fixture's combined phase budget. Historical Windows
failure logs do not identify their stalled phase, so they do not prove a production lease defect or
the exact cause of each previous occurrence. New runs report loader/readiness, native initialization,
acquisition, and publication timings separately.

Failures report each contender's phase, elapsed times, outcome, exit status, signal, and bounded,
path-sanitized stderr. Startup failure, readiness/publication hangs, failed exit, and cancellation
are covered with real children. Cleanup signals only the owned child trees and removes their
temporary root (including helper staging outside the HOME) after observed closure; incomplete cleanup retains that HOME and fails explicitly. Cleanup errors remain visible after an
earlier failure; tree termination must be followed by observed child closure within its existing bound.

## Five Runs Under Concurrent Load

Run `node apps/runner/scripts/verify-successor-election-load.mjs` from the repository. Two owned
workers continuously consume CPU and write/delete 16 KiB temporary files throughout five consecutive
executions of the exact focused election test. The harness verifies each test actually ran and
that both load workers advanced during every run, and prints platform, Node, CPU, and phase data.
Cancellation allows the current bounded fixture to finish cleanup before stopping the load workers.

Each focused invocation creates its own fixture parent before launching Node and passes it through
`WOLLIPOG_SUCCESSOR_FIXTURE_PARENT`. The real election puts its HOME, helper staging, and advisory
`contenders.json` there. Ordinary fixture cleanup removes that root after observing both contenders
close, and the load harness removes the now-empty parent.

An outer timeout can kill the test runner before it cleans up detached POSIX contenders. Runner
closure does not establish their closure. If the parent is nonempty, or runner closure cannot be
observed within five seconds, validation fails and reports the retained absolute parent path,
possibly live detached contenders, and unproved cleanup. The parent remains separate from the load
workers' directory, so stopping the workers cannot erase fixture evidence. A successful runner exit
with retained fixture evidence fails validation too. This deliberately uses the explicit-retention
fallback: the outer harness does not automatically reclaim escaped detached contenders, scan global
temporary directories, or signal PIDs recovered from files. Such PIDs are advisory historical
evidence and may have been reused; inspect actual process identity before any manual recovery.

Primary validation failures, tree-termination failures, close-wait failures, worker cleanup, and
directory-removal failures are preserved together rather than replacing one another in `finally`.
The lifecycle regression exercises a real outer timeout with a detached child, verifies retained
evidence and an unrelated process/file, and injects termination, close-wait, and removal failures.
Its synthetic detached child exits itself after eight seconds; the tests never signal stored PIDs.

For native Windows evidence, dispatch the Platform Isolation workflow on the tested branch with
`successor_election_load=true`. Both Windows images run the five focused loaded tests alongside the
complete normal platform job. Linux validation does not substitute for these Windows results.
