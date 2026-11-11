# Node Shard Capacity, 2026-11-10

Refs #4459. Source: [PR run 42915746591, attempt 1](https://github.com/picoduck/wollipog/actions/runs/42915746591/attempts/1),
tested commit `dabb5b8943f6981034ad09339830fe39416c1bb2`. The committed
[profile](ci-node-shard-profile-2026-11-10.json) contains the twenty slowest files from
each shard's `ci-timing-v1` projection, resolved by SHA-256 of repository-relative
paths. It includes public job IDs and step durations, without test inputs or log text.

| Shard | Unit Tests Step | Tests | Result |
| --- | --- | --- | --- |
| 1 | 18m01s | 7,140 | 18-minute timeout; zero assertion failures |
| 2 | 14m02s | 7,069 | Success |
| 3 | 13m49s | 5,925 | Success |

Shard 1's largest measured files were `runner-channel.integration.test.ts` (408s),
`prepared-media-session-delegated.integration.test.ts` (397s),
`session-manager-location-switch-setup.test.ts` (198s), and
`campaign-issue-authority.test.ts` (165s). Shard 2's largest was `sessions.test.ts`
(465s); shard 3's was `prepared-media-session-integration.test.ts` (259s).
These are accumulated top-level test durations, which can overlap between workers;
they are scheduling estimates, not file-process wall times.

The October 23 profile had 16,194 tests; this attempt had 20,134, about 24% more.
`runner-channel.integration.test.ts` grew from five tests/71s to eight/408s;
`sessions.test.ts` grew from 254s to 465s. There is also substantial runtime
variation: shard 1's same-head rerun took 11m44s, while shards 2 and 3 retained
their successful first-attempt jobs. That is not a second complete independent run.

Replaying the captured sixty slow-file costs against the old three-shard allocation
at the implementation base gives 1,548/1,565/1,472 accumulated seconds. Refreshing
the costs alone gives 1,565/1,510/1,511: little improvement in the largest load.
The evidence supports suite growth and runtime variation more than a general
shard-1 imbalance. A fourth shard reduces file counts from about 467 to 350 and
captured slow-file loads to 1,206/1,164/1,182/1,032 seconds. Unknown/new files still
participate in discovery and the deterministic snake deal.

The change adds capacity and independently refreshes scheduling costs,
without changing fast/remaining suite membership. All four shards retain the
18-minute step limit, native runner failures, and `fail-fast: false`. The aggregator
still requires the combined unit result to succeed. Rolling validation, main health,
release certification and restoration proof now require the fourth shard too;
historical three-shard runs cannot certify the new coverage envelope.

The replay is a capacity estimate, not proof of hosted-runner performance. PR,
merge-group and subsequent rolling-main step durations must be recorded in the
delivery report, with repeated-run evidence kept separate from predictions.
