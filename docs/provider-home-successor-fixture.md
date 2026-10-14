# Successor-Election Fixture

`provider-home-lease.test.ts` runs two real Node children against the same temporary HOME and
released legacy lease. It still requires exactly one winner, one competing-owner refusal, and
successful exits. Structured fail-closed lease refusals count as losing outcomes. Before publishing its result, the
loser also verifies that the winner's completed canonical lease is readable and refuses another
owner. Unexpected runtime errors and genuine ownership violations still fail.

Each child loads the registry, proves native helper availability with the fixture HOME, and sends
a flushed readiness message before waiting for the shared start barrier. The parent opens that
barrier only after both children are ready. No production lease deadline or ownership check changes.

| Fixture Phase | Bound |
| --- | ---: |
| Both children ready, including loader and native-helper initialization | 5 seconds |
| Both results published after the start barrier | 5 seconds |
| Graceful exit after release | 5 seconds |
| Forced cleanup of fixture-owned trees | 5 seconds |

The controlled regression injects 2.6 seconds of startup delay and 2.6 seconds of result-publication
delay. With the original barrier, it repeatedly failed the five-second reporting assertion in about
5.6 seconds; removing either delay passed in about 3 seconds. With readiness coordination it passes
while retaining the five-second reporting bound. Its startup-only allowance is ten seconds to
accommodate the deliberately injected pause in addition to ordinary bounded initialization.

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
