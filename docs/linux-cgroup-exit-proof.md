# Linux cgroup exit proof and procfs observation

Investigation for #3646, following the nondumpable-helper assertion failure in merge-group run
[39892012532](https://github.com/picoduck/wollipog/actions/runs/39892012532/job/120213730198).

## Conclusion

The test equated every non-zombie procfs entry with an executable helper. Linux can expose an
exiting task after the cgroup has become unpopulated. Local stress reproduced a successful proof
followed by state `X` (dead), which the old `alive()` also classified as alive. This is an
observation race in the test, not evidence that the helper can still execute user code.

The single historical CI failure did not capture task flags, so its precise state cannot be
recovered. Both the pre-zombie exit path and the observed dead-task path explain its non-`Z`
result. The fix covers both while immediately rejecting a task that has not entered exit.

## Kernel ordering

The [cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#un-populated-notification)
defines `cgroup.events`'s `populated` value recursively over live tasks. In upstream Linux 6.17:

1. [`do_exit()`](https://github.com/torvalds/linux/blob/v6.17/kernel/exit.c#L842-L949) is `noreturn`.
   `exit_signals()` sets `PF_EXITING`; `exit_mm()`, `exit_files()` and `exit_fs()` precede
   `cgroup_exit()`. An exiting task cannot return to its provider/helper user code.
2. [`cgroup_exit()`](https://github.com/torvalds/linux/blob/v6.17/kernel/cgroup/cgroup.c#L6437-L6472)
   detaches the task using `css_set_move_task()`. That function updates populated counters when
   the last live task leaves; `cgroup_update_populated()` propagates the change to ancestors.
   These are the counters read by `cgroup_events_show()`.
3. `do_exit()` calls `exit_notify()` **after** `cgroup_exit()`.
   [`exit_notify()`](https://github.com/torvalds/linux/blob/v6.17/kernel/exit.c#L696-L736) sets
   `EXIT_ZOMBIE`, and an autoreaped task can advance to `EXIT_DEAD` before procfs disappears.
4. [`fs/proc/array.c`](https://github.com/torvalds/linux/blob/v6.17/fs/proc/array.c) maps dead tasks
   to `X` and zombies to `Z`. `do_task_stat()` writes task flags in field 9 independently of its
   ptrace permission check, so this evidence is available for the nondumpable fixture too.
   [`PF_EXITING`](https://github.com/torvalds/linux/blob/v6.17/include/linux/sched.h#L1623) is `0x4`.

The same relevant `cgroup_exit()` / `exit_notify()` ordering and populated-counter detachment
exist in [Linux 6.8 exit.c](https://github.com/torvalds/linux/blob/v6.8/kernel/exit.c#L811-L837)
and [cgroup.c](https://github.com/torvalds/linux/blob/v6.8/kernel/cgroup/cgroup.c#L6269-L6303).
A procfs task state alone is therefore not an exit-completion barrier.

## Wollipog proof inputs

`PosixProcessBoundary.terminateOnce()` delegates directly to the contained boundary when one
exists. `LinuxCgroupBoundary` first waits for its private admission acknowledgment; the native
launcher writes that acknowledgment only after joining the exact fd-anchored cgroup, before
executing provider code. An unused, empty cgroup cannot authorize a proof before admission.

`openCgroup()` verifies the retained directory's inode/device and linked identity before reading
its anchored `cgroup.events`. `terminate()` reads recursive populated state after admission,
attempts cgroup-local pidfd TERM, escalates with recursive `cgroup.kill` if needed, and returns
success only after an unpopulated read. Neither process-table guesses nor unreadable environment
markers decide this path. Missing, replaced or unreadable identities retain a failed proof.

For tasks exiting this boundary, unpopulated means user-code execution has ended, but does not
require procfs to have reached `Z` or disappeared. As already documented by the native launcher,
deliberate same-user cgroup migration is outside this lifecycle contract; this investigation does
not broaden that contract or change lease authority.

## Test assertion

Immediately after proof, the test reads the helper state and flags. A non-zombie helper without
`PF_EXITING` fails immediately, even if it would exit on a later poll. Only irreversible kernel
exit is allowed to finish within the existing five-second fixture deadline. Each observation
retains that executable-task check. The test then requires `Z` or disappearance and keeps the
original `proof cannot precede the helper's death` assertion. `ENOENT` and `ESRCH` both represent
a disappearing proc entry; other read failures propagate.

The final check after that wait reads procfs once more. A zombie can be reaped between the two
reads, so `Z`, `X` and a missing entry all count as exited there; any other state fails at once,
and the failure message carries the observed state, flags and `PF_EXITING` bit. The `alive()`
helper uses the same classification. #3773 records a main CI failure of the earlier `Z`-only
final check after the wait had already returned.

Deterministic cases reject `R`, `S`, `D` and `T` without `PF_EXITING` on the first read, and exercise
`R`/`X` with `PF_EXITING` reaching zombie or disappearance. The pre-fix immediate zombie check
failed both initial transition cases. Further cases pass a zombie that then reads `X` or
disappears, which the `Z`-only final check failed for `X`, and reject `R`, `S`, `D`, `T`, and `R`
with `PF_EXITING` at the final check. No containment check, cleanup retry, CI retry policy,
`failOnFlakyTests`, workflow, or product proof behavior is changed.

## Local evidence and repetition

On Linux `6.17.0-23-generic` with Node `24.18.1`, the provider's own cgroup mount was read-only and
`sudo` was unavailable under no-new-privileges. A fresh `systemd-run --user` service with
`Delegate=yes` supplied a writable test subtree; it did not update or restart the hosting stack.

A temporary stress harness compiled the existing `cgroup-descendant.c` once and ran 1,000
nondumpable launches through the real ledger and `terminatePosixProcessBoundaries()`. Every launch
required the cgroup proof standard and a failed non-killing proof while the helper lived. After
successful shutdown proof, it read procfs immediately, checked any non-zombie task's `PF_EXITING`,
then waited for zombie/disappearance without sending another signal. Results:

```text
iteration=965 state=X flags=4228108 PF_EXITING=true
runs=1000 nonZombieExitWindows=1 executableSurvivors=0
```

An earlier stress attempt encountered `ESRCH` while reading the exiting task, motivating the
matching disappearance handling. Another preliminary attempt could not see provider-private
`/tmp` from the transient service; the successful harness lived temporarily in the worktree.
These incomplete attempts are not included in the 1,000 completed iterations.

After the fix, 20 consecutive complete delegated suites passed: 39 tests per run, no skips,
780 passing tests total, including 80 executions across the four helper modes. There were zero
failures of the death assertion. A separate full fixed suite also passed all 39 tests. Runner
production/test typechecks passed, and related process-tree/spawn tests passed 53 tests with
10 Windows/macOS skips. Eight deterministic assertion tests passed; both original exit-transition
cases failed under the pre-fix immediate-zombie check.

The repeated suite required both containment and the real user-manager query. Repeat it in a disposable delegated user service (the command's node path is passed
explicitly; choose a suitable clean test HOME if needed):

```sh
systemd-run --user --wait --collect --pipe \
  --property=Delegate=yes --property=RuntimeMaxSec=420 --property=TimeoutStopSec=5 \
  --working-directory="$PWD" \
  /usr/bin/env -i PATH="$PATH" HOME=/tmp XDG_RUNTIME_DIR="/run/user/$(id -u)" \
  WOLLIPOG_TEST_REQUIRE_CGROUP=1 WOLLIPOG_TEST_EXPECT_USER_MANAGER_QUERY=1 \
  /usr/bin/bash -c 'set -e; for iteration in $(seq 1 20); do
    "$1" --import tsx --test --test-timeout=60000 apps/runner/src/linux-cgroup.test.ts
  done' _ "$(command -v node)"
```
