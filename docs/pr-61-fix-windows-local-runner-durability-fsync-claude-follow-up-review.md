---
pr: https://github.com/picoduck/wollipog/pull/61
base: main
reviewed_head: c1c86415167f30c4643ed266b086971ade7c39b5
merge_base: 6cb54430fa3f2be5ece946188f9294d31605c94e
round: 2
date: 2026-08-16
reviewer: Claude Opus 5 / High
---

# PR #61 Claude follow-up review - Fix Windows local runner durability fsync

## Summary

The change is small, targeted, and correct: it replaces the read-only `openSync` used before `fsyncSync` in the two protected-publication paths with a platform-aware flag helper, because `FlushFileBuffers` (libuv's Windows `fsync`) requires a write-capable handle. It mirrors an already-proven precedent in the same package (`stateDoctorFileSyncFlags`, `apps/runner/src/state-doctor.ts:133-136`), leaves POSIX behavior bit-for-bit identical (`O_RDONLY` is still `0`), and — more valuably than the unit assertion — wires `runner-data-dir.test.ts` into the Windows/macOS matrix so the regression is exercised end-to-end through `acquireRunnerDataDirLease` → `publishProtected`. Risk is low; I found no correctness, security, or ordering defect in the reviewed commit.

## Findings

### 1. `runnerDataDirFileSyncFlags` drops the `O_NOFOLLOW` component its sibling helper deliberately carries

- **Severity:** P2 non-blocking
- **Confidence:** medium
- **Location:** `apps/runner/src/runner-data-dir.ts:216-219`, used at `apps/runner/src/runner-data-dir.ts:282` and `apps/runner/src/runner-data-dir.ts:317`

The new helper is a near-copy of `stateDoctorFileSyncFlags` (`apps/runner/src/state-doctor.ts:133-136`), which returns `access | (constants.O_NOFOLLOW ?? 0)`. The new one returns bare `access`. This is not a regression — the lines it replaced were plain `constants.O_RDONLY` — and the concrete exposure today is negligible: the target is always a freshly created temp path with an unguessable `randomUUID()` suffix inside a `0o700` directory, created with `flag: "wx"` (so `O_EXCL` already rejects a pre-planted symlink), and the reopen window is a few instructions wide.

The reason to fix it anyway is forward safety: `runnerDataDirFileSyncFlags()` is now an exported, general-sounding name, and the obvious next use is fsyncing an *existing* protected file (e.g. a durable re-sync of `.wollipog-runner-owner-v2.json` after a partial write). At that point the missing `O_NOFOLLOW` silently follows a symlink out of the data dir, while every other protected read in this file (`protectedRead`, `apps/runner/src/runner-data-dir.ts:161`) does not. Fix: return `access | (constants.O_NOFOLLOW ?? 0)` to match the sibling, and extend the new test with `assert.notEqual(runnerDataDirFileSyncFlags("linux") & constants.O_NOFOLLOW, 0)` guarded to non-win32 (`O_NOFOLLOW` is undefined on Windows).

### 2. Newly enabled Windows job cleans up temp roots with `rmSync` and no retry budget

- **Severity:** P2 non-blocking
- **Confidence:** low
- **Location:** `apps/runner/src/runner-data-dir.test.ts:64` (new), and the pre-existing `finally` blocks it joins, e.g. `:163`, `:236`, `:348`, `:421`, `:456`

This PR is what first runs these 14 tests on `windows-latest` (`.github/workflows/platform-isolation.yml:47`), so Windows-specific cleanup behavior becomes this PR's problem. `rmSync(root, { recursive: true, force: true })` defaults to `maxRetries: 0`; `force` only swallows `ENOENT`, not the `EBUSY`/`EPERM` that Windows returns when a transient handle (Defender real-time scan on a just-created file, or a lagging directory handle) is still open. Because these calls sit in `finally` blocks, such a throw converts a passing test into a red job with a misleading failure. The tests hold no open fds or child processes of their own, so this is a flake risk rather than a defect — hence low confidence and P2.

Fix if it materializes: `rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })`. No new test is needed; the proof is job stability across repeated `workflow_dispatch` runs on `windows-latest`.

## Test-gap notes

`apps/runner/src/state-doctor.test.ts` is still absent from the platform-isolation matrix (`.github/workflows/platform-isolation.yml:47` lists only `execution-isolation.test.ts`, `runner-data-dir.test.ts`, `spawn.test.ts`). `state-doctor.ts` carries the identical Windows fsync constraint at `apps/runner/src/state-doctor.ts:138-143` and runs on Windows in production via the `state-doctor` CLI command, but its only guard is the platform-parameterized flag assertion at `state-doctor.test.ts:32-35`, which passes on any host and cannot catch the real `FlushFileBuffers` failure. Adding that file to the same `node --import tsx --test` invocation would close the gap for the sibling path at no extra job cost, and is squarely within this PR's stated goal of making the native workflow exercise the regression on the intended runners.

A negative assertion (opening the probe file `O_RDONLY` and asserting `fsyncSync` throws on `win32`) is *not* recommended — it pins an OS implementation detail rather than this code's behavior, and the end-to-end Windows run of `publishProtected` already provides the meaningful regression proof.

## What looks good

- **Correct root cause and correct scope.** `FlushFileBuffers` requires `GENERIC_WRITE`; `O_RDWR` on Windows and `O_RDONLY` elsewhere is exactly right, and the inline comment records why. I checked every other `fsyncSync` call site in the runner and control plane: `session-store.ts:791-793` uses `"r+"`, `worktree.ts:129`, `durable-command-store.ts`, `session-command-receipt-store.ts` and `checkpoint-ref-ownership.ts` all fsync `"wx"` write handles, and the remaining `"r"` opens are directory syncs behind error tolerance. `runner-data-dir.ts` was genuinely the last file-fsync-on-read-handle site — the fix is complete, not partial.
- **Zero POSIX behavior change.** `O_RDONLY` is `0`, so the non-Windows open is byte-identical to the replaced code; there is no rollout or version-skew hazard.
- **Publication ordering untouched.** The `fsync-file` hook is still raised between `openSync` and `fsyncSync`, so the durability-ordering assertions (`runner-data-dir.test.ts:387-423`, `:594-608`) continue to pin the fsync-file → link → fsync-directory → owner-marker sequence, and hard-link/cleanup semantics in `publishProtected` and `replaceProtectedContents` are unchanged.
- **The `tempRoot()` canonicalization is load-bearing, not cosmetic.** `acquireRunnerDataDirLeaseAt` returns `realpathSync(requestedDataDir)` (`runner-data-dir.ts:408`), and several assertions compare hook paths and `dataDir` against `join(root, ...)`. Without `realpathSync` at `runner-data-dir.test.ts:46`, the macOS `/var` → `/private/var` symlink and the 8.3 short `RUNNER~1` temp path on GitHub's Windows images would have failed these comparisons for reasons unrelated to the fix. Getting this in before enabling the new platforms is the right call.
- **Regression coverage is real, not nominal.** Because nearly every test in the file drives `acquireRunnerDataDirLease` → `writeProtected` → `publishProtected`, reverting the source change would fail the Windows job broadly, not just the one new flag assertion. Linux coverage is retained separately through the root `pnpm test` glob in `ci.yml:51`.

## Verdict

UPVOTE

The fix is correct, complete across the runner's fsync call sites, behavior-preserving on POSIX, and backed by genuine end-to-end Windows coverage; only two non-blocking P2 notes remain.

## Codex triage

- **DEFERRED — add `O_NOFOLLOW` to the sync helper:** this is explicitly not a regression and the current helper is only used to reopen fresh `wx` files with UUID names under an owner-only directory. A broader descriptor-lifetime/security-hardening refactor should avoid expanding this targeted compatibility patch.
- **DEFERRED — add retries to Windows test cleanup:** the suite closes its own descriptors and has passed repeatedly on the affected Windows ARM64 host. The low-confidence flake mitigation can be added if hosted Windows CI demonstrates it is needed.
- **DEFERRED — add the state-doctor suite to the platform matrix:** state doctor already has a separate platform-parameterized flag contract and is outside issue #60's runner ownership publication failure. The newly added suite drives the actual affected production paths end to end.
