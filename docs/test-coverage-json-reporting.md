# Incomplete Coverage JSON from Fixture Cleanup

Issue: [#3373](https://github.com/picoduck/wollipog/issues/3373).

## Verified Mechanism

`LockRace` in `apps/runner/src/session-store-lock.test.ts` considers an atomically published
result ready before the child process exits. Its original `dispose()` sent `SIGKILL` to every
child that had not yet exited, including successful children flushing V8 coverage. Killing one
during that write leaves a permanently incomplete coverage JSON file. Waiting for the killed
child's `close` event afterwards cannot finish its interrupted write.

This is a repository fixture lifecycle bug. Node's coverage reader exposes the corruption; the
evidence does not establish a Node size limit or require a Node patch. Node v24.18.1's
[`TestCoverage.getCoverageFromDirectory()`](https://github.com/nodejs/node/blob/v24.18.1/lib/internal/test_runner/coverage.js)
reads and parses each matching `coverage-<pid>-<timestamp>-<thread>.json` directly. Its
[`V8CoverageConnection::WriteProfile()`](https://github.com/nodejs/node/blob/v24.18.1/src/inspector_profiler.cc)
writes the final filename through
[`WriteFileSync()`](https://github.com/nodejs/node/blob/v24.18.1/src/util.cc), without publishing
via an atomic rename. The test-runner harness turns a parse failure into a coverage diagnostic
and a failing exit status. Neither ignoring that error nor discarding the file is a correct fix.

## Diagnostic Evidence

The following focused runs used Node v24.18.1 on base `156a80e70523f8e00efb87843d56b74e6b56902a`,
which includes the missing-source fix `82dcb49ac58236615387c8c4a2f5e9506d24b8af`. Source maps
remained enabled, and TAP and lcov had separate destinations.

| Probe | Test Result | Coverage Result |
| --- | --- | --- |
| Bounded-child-process tests | Passed | Usable lcov; nine retained raw files all parse |
| Entire lock-race test file | 62 passed, zero failed | Unterminated JSON string at character 1,269,416; zero-byte lcov |
| Lock-race file with child lifecycle logging | 62 passed, zero failed | One permanently incomplete 126,976-byte raw file; zero-byte lcov |

In the first failure, the corresponding retained raw file was 1,269,760 bytes. UTF-8 byte size
and JSON character offset differ. In the correlated failure, the filename identified a writer
whose result was published before cleanup sent `SIGKILL`. Times relative to the filename's
coverage timestamp were:

| Event | Relative Time |
| --- | --- |
| Native coverage filename timestamp | 0 ms |
| Fixture cleanup sends `SIGKILL`; final result already exists | +10 ms |
| Child exits with signal `SIGKILL` | +15 ms |

The raw file still failed parsing after the writer exited and Node copied it to the retained
directory. This distinguishes an interrupted writer from a reader merely catching a write that
later completes. Nineteen valid files in that same run exceeded 1,310,720 bytes, ruling out a
universal 1.25 MiB boundary. This focused trigger does not exercise the synchronous bounded-child
wrapper, so its timeout is not responsible for this reproduced failure. No
`ERR_SOURCE_MAP_MISSING_SOURCE` occurred.

The focused diagnostic command is:

```sh
NODE_OPTIONS=--enable-source-maps NODE_V8_COVERAGE=<scratch>/v8 \
  node --import tsx --test --test-timeout=300000 --experimental-test-coverage \
  --test-reporter=tap --test-reporter-destination=<scratch>/tap.txt \
  --test-reporter=lcov --test-reporter-destination=<scratch>/lcov.info \
  apps/runner/src/session-store-lock.test.ts
```

The timing race is intermittent. A deterministic fixture regression holds a child after result
publication and proves that cleanup leaves it alive, retains its files, waits for its exit, and
then removes the directory. The original implementation fails that regression. A coverage
integration check additionally verifies the real race's original TypeScript and child-script
source records. Neither test relies on hitting a kernel write at a particular instant.

## Repository Fix

Disposal waits up to the existing 30-second close bound for a child whose final result exists
and that was not configured to stay alive. Intentionally paused or live children still receive
`SIGKILL` immediately. A published child exceeding the bound is killed and awaited, and cleanup
reports a timeout rather than treating it as success. Disposal awaits every owned cleanup before
removing fixture files. A separate deterministic test advances the close timer and verifies the
fallback reaps the child and reports the timeout.

The neighboring successor-election fixture in `provider-home-lease.test.ts` already publishes
its release signal and waits for close before falling back to forced tree cleanup. Reviewed
lease-portability, lease-heartbeat, campaign-review-job, WSL-helper, and provider-pipe termination
sites either await normal completion or deliberately terminate a still-running process to test
crash recovery, cancellation, or containment. No second instance of this successful-child
publication/kill race was verified in that audit. That inspection is not a proof that every
possible coverage writer in the suite is safe; the full-suite acceptance runs remain necessary.

## Verification Contract

Full-suite acceptance requires three consecutive runs at the fixed commit using all six globs
from `.agents/skills/codebase-maintenance/jobs/coverage-gap-fill.md`, source maps, and separate
TAP/lcov destinations. Record each exit status, test totals, coverage warnings, lcov byte size,
source-record count, and the presence of `session-store.ts` and `session-store-lock-child.mjs`.
Report test failures independently from coverage usability; do not count empty or partial lcov
as success. Keep diagnostic retries bounded, and delete only each run's own raw directory after
preserving the useful evidence. Never remove source maps, exclude tests or coverage, suppress
reporter errors, or relax process cleanup to obtain coverage.
