# Successor-Election Fixture

`provider-home-lease.test.ts` runs two real Node children against the same temporary HOME and
released legacy lease. It still requires exactly one winner, one competing-owner refusal, and
successful exits. Structured fail-closed lease refusals and the explicit checkpoint-in-progress refusal count as
losing outcomes. Before publishing its result, the
loser also verifies that the winner's completed canonical lease is readable and excludes a competing
process. Errors outside those recognized refusal paths fail. Invalid stable lease evidence or a
second successful acquirer also fails; the registry may wrap errors during chain verification as
structured refusals, so this fixture does not classify the original cause of every refusal.

Each child loads the registry, proves native helper availability with the fixture HOME, and sends
a flushed readiness message before waiting for the shared start barrier. The parent opens that
barrier only after both children are ready. No production lease deadline or ownership check changes.

| Fixture Phase | Bound |
| --- | ---: |
| Both children ready, including loader and native-helper initialization | 5 seconds |
| Both results published after the start barrier | 5 seconds |
| Graceful exit after release | 5 seconds |
| Forced cleanup of fixture-owned trees | 5 seconds |

The first controlled probe injected 2.6 seconds of startup and 2.6 seconds of publication delay.
It reproduced the original reporting assertion twice; removing either delay passed. Native Windows
measurements then showed an acquisition taking 2.887 seconds plus a 0.492-second losing-contender
verification, so the artificial publication pause left too little of the five-second reporting
window. That was a defect in the initial regression, not grounds to expand reporting limits.

The permanent regression instead injects 5.2 seconds of startup and no publication pause. The
original barrier always expires its reporting budget before startup finishes; the coordinated
barrier retains the complete five seconds for real acquisition/publication/verification work.
Its finite ten-second readiness allowance accommodates the injected pause plus measured native
initialization (about 1.1 seconds on the observed Windows run). Normal readiness remains five seconds.

These measurements establish a defect in the fixture's combined phase budget. Historical Windows
failure logs do not identify their stalled phase, so they do not prove a production lease defect or
the exact cause of each previous occurrence. New runs report loader/readiness, native initialization,
acquisition, and publication timings separately.

Failures report each contender's phase, elapsed times, outcome, exit status, signal, and bounded,
path-sanitized stderr. Startup failure, readiness/publication hangs, failed exit, and cancellation
are covered with real children. Cleanup signals only the owned child trees and removes their
temporary root (including helper staging outside the HOME) after observed closure; incomplete cleanup retains that HOME and fails explicitly.

## Five Runs Under Concurrent Load

Run `node apps/runner/scripts/verify-successor-election-load.mjs` from the repository. Two owned
workers continuously consume CPU and write/delete 16 KiB temporary files throughout five consecutive
executions of the exact focused election test. The harness verifies each test actually ran and
that both load workers advanced during every run, and prints platform, Node, CPU, and phase data.
Cancellation allows the current bounded fixture to finish cleanup before stopping the load workers.

For native Windows evidence, dispatch the Platform Isolation workflow on the tested branch with
`successor_election_load=true`. Both Windows images run the five focused loaded tests alongside the
complete normal platform job. Linux validation does not substitute for these Windows results.
