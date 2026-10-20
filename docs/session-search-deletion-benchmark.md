# Session Search Deletion Benchmark

Run `pnpm benchmark:session-search-deletion` to compare the production search cleanup helper
with the previous `session_id` predicate (#3315). The fixture uses only synthetic text, the real
control-plane schema and FTS5 secure-delete, and 200 target rows at each index size. It times
search cleanup inside a transaction, excluding setup, correctness assertions and rollback.
Each method gets one warm-up and five measured trials, alternating order and rolling back to
identical contents. Other session deletion cascades are deliberately outside the measurement.

Node.js 24.18.1, SQLite 3.53.1, Linux, in-memory database:

| Indexed Rows | Target Rows | Session Scan Median (ms) | Keyed Cleanup Median (ms) |
| --- | --- | --- | --- |
| 20,000 | 200 | 1.771 | 0.766 |
| 100,000 | 200 | 8.893 | 1.002 |
| 400,000 | 200 | 36.310 | 0.898 |
| 1,000,000 | 200 | 85.519 | 0.853 |

For this fixed target, keyed cleanup stays around one millisecond while scanning grows with the
whole index. This demonstrates removal of the full-index scan, rather than a fixed latency
guarantee: FTS tree shape, text size, storage and cache state still affect individual key deletes.
This in-memory benchmark does not measure disk flush latency or end-to-end runner/box deletion.
The regression suite separately covers all five production paths, completed and pending legacy
mapping, collision fallbacks, term removal, and preservation of unrelated sessions' rows.
