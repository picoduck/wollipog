---
pr: https://github.com/picoduck/wollipog/pull/61
base: main
reviewed_head: 66a8147b3b73818c8f668f567f14b593e6fe2b7d
merge_base: 6cb54430fa3f2be5ece946188f9294d31605c94e
round: 1
date: 2026-08-16
reviewer: Claude Opus 5 / High
---

# PR #61 Claude review - Fix Windows local runner durability fsync

## Summary

The production fix is correct and minimal: `FlushFileBuffers` (libuv's `fsync` on Windows) does require a write-capable handle, POSIX behavior is unchanged, and the new helper matches the convention already used in `session-store.ts:791-794` (`"r+"` for file fsync). The problem is the other half of the PR: adding `runner-data-dir.test.ts` to the `windows-latest`/`macos-latest` matrix runs a test file that has never executed off Linux, and it contains temp-path assertions that fail deterministically on macOS (and almost certainly on GitHub's Windows image), plus it will exercise a directory-fsync path that has the same read-only-handle defect this PR just fixed for files. As written, the new CI leg does not prove the regression is fixed — it goes red first.

## Findings

### P1 — `tempRoot()` returns an unresolved temp path, so the newly added platform legs fail on every `dataDir`/durability-path assertion

**Confidence:** high  
**Files:** `.github/workflows/platform-isolation.yml:47`; `apps/runner/src/runner-data-dir.test.ts:44-46` (and assertions at `:140`, `:195-197`, `:399-411`, `:344`, `:579`, `:627`, `:652`, `:668`, `:713`, `:819`)

`acquireRunnerDataDirLeaseAt` canonicalizes the root: `const dataDir = realpathSync(requestedDataDir);` (`apps/runner/src/runner-data-dir.ts:408`). Every path it returns or reports through `beforeDurabilityOperationForTest` is therefore the *resolved* path. The tests compare those values against the raw `mkdtempSync(join(tmpdir(), …))` string.

Failure scenario:

- **macOS runner:** `os.tmpdir()` is `/var/folders/<xx>/<yyy>/T`, and `/var` is a symlink to `private/var`. `root = /var/folders/…/wollipog-runner-owner-XXXX`, but `lease.dataDir = /private/var/folders/…/wollipog-runner-owner-XXXX`. `runner-data-dir.test.ts:140` (`assert.equal(second.dataDir, join(root, "runner-instances", …))`) fails; so do `:344`, `:579`, `:627`, `:652`, `:668`, `:713`, `:819`.
- The durability-ordering tests are worse: they scan recorded operations for `entry.path === root` / `join(root, …)` (`:197`, `:401`, `:406`, `:410`, `:595`, `:604`). Production emits the resolved path, so `findIndex` returns `-1` and `assert.ok(leaseLink >= 0 && …)` at `:412-417` and `:606-607` fail.
- **`windows-latest`:** `%TEMP%` on the GitHub image is `C:\Users\RUNNER~1\AppData\Local\Temp` (account `runneradmin`). `realpathSync` expands the 8.3 alias via `GetFinalPathNameByHandleW`, yielding `C:\Users\runneradmin\...`, so the same assertions fail. This does not reproduce on a developer box whose username is ≤ 8 characters, which is why the file passes locally on Windows.

This has been latent because `ci.yml:29` runs `pnpm test` only on `ubuntu-22.04`, where `/tmp` needs no resolution. The workflow line in this diff is what exposes it, and the result is a permanently red Platform Isolation job on every subsequent `apps/runner/**` PR.

**Fix:** make the helper canonical — `function tempRoot(): string { return realpathSync(mkdtempSync(join(tmpdir(), "wollipog-runner-owner-"))); }` — and use it for the roots created inline at `:240-241`, `:271-273`, `:387`, etc.  
**Test that proves it:** the workflow change itself; once `tempRoot()` resolves, the existing `dataDir` equality and `beforeDurabilityOperationForTest` ordering assertions become the cross-platform regression test.

### P1 — `syncDirectory` still opens the directory read-only, so the same Windows defect blocks the very next durability step

**Confidence:** medium  
**Files:** `apps/runner/src/runner-data-dir.ts:229-242` (specifically `:233`), reached from `:296`, `:300`, `:325`, `:329`; tolerance set at `:207`

The PR's own premise (`:217`: "FlushFileBuffers … requires a write-capable handle") applies equally to `syncDirectory`, which does `openSync(directory, constants.O_RDONLY)` and then `fsyncSync(fd)`. A directory handle cannot be granted write access, so `FlushFileBuffers` fails with `ERROR_ACCESS_DENIED`, which libuv translates to `EACCES`. `WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_ERRORS` is `{EINVAL, EISDIR, EPERM}` — `EACCES` is deliberately excluded, and `runner-data-dir.test.ts:464-466` asserts it is *not* ignorable.

Failure scenario: on Windows with an existing data dir, `ensureDurableDirectory` creates nothing, so the first durability operation is the file fsync in `publishProtected` — that is exactly issue #60, and it is fixed here. The *next* operation is `syncDirectory(dirname(file))` at `:296`, which throws `could not durably publish runner data directory …`, aborting lease acquisition before any owner marker is written. In other words, the runner still cannot claim its data dir on Windows; the failure just moves one step later.

The rest of the repo already reflects the observed Windows behavior and blanket-tolerates it: `apps/runner/src/durable-command-store.ts:435-447` ("Windows does not consistently permit directory handles to be flushed"), `apps/runner/src/session-store.ts:796-806`, `apps/runner/src/session-command-receipt-store.ts:528-537`, `apps/control-plane/src/artifact-blob-store.ts:115-129`. `runner-data-dir.ts` is the strict outlier, and it is the only one that was never exercised on a Windows runner.

I am flagging this at medium confidence because the exact errno depends on libuv's translation of the `CreateFileW`/`FlushFileBuffers` failure; the new Windows CI leg will settle it either way, but only after Finding 1 is fixed.

**Fix:** align the tolerance with the rest of the codebase — either add `EACCES` to `WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_ERRORS` (`:207`) with a comment tying it to `FlushFileBuffers` access requirements, or mirror the `process.platform !== "win32"` blanket tolerance used by the sibling stores. Keep POSIX fatal.  
**Test that proves it:** an end-to-end assertion that `acquireRunnerDataDirLease(tempRoot(), FIRST)` succeeds and publishes both markers — the existing test at `runner-data-dir.test.ts:386-422` already does this and becomes the proof once it runs on the Windows leg.

### P2 — the reopen-to-fsync pattern is avoidable and re-introduces a TOCTOU window

**Confidence:** medium  
**File:** `apps/runner/src/runner-data-dir.ts:275-288` and `:314-323`

`writeFileSync(temp, …, { flag: "wx" })` closes the descriptor, then the code reopens `temp` by path to fsync it. Between the close and the reopen the path can be replaced (the parent is mode `0o700`, so this is not a strong attack, but it is a real gap — and unlike `protectedRead` at `:161`, the reopen carries no `O_NOFOLLOW`). Requesting write access on Windows also widens the window for a transient sharing violation from an AV/indexer holding the freshly created file.

The pattern used elsewhere in this repo avoids both: `openSync(temp, "wx", 0o600)` → `writeFileSync(fd, …)` → `fsyncSync(fd)` → `closeSync(fd)` (`apps/runner/src/durable-command-store.ts:163-169`). That would make `runnerDataDirFileSyncFlags` unnecessary. Non-blocking; the current fix is correct as far as it goes.

## Test-gap notes

The new test at `runner-data-dir.test.ts:48-65` re-implements `openSync`/`fsyncSync` inline rather than driving `publishProtected`/`replaceProtectedContents`. The flag assertions at `:49-50` do pin the helper against a regression, so this is acceptable — but it means all real coverage of the fixed production path on Windows comes from the rest of the file executing successfully, which Finding 1 currently prevents.

## What looks good

- The root-cause diagnosis is right, and the comment at `runner-data-dir.ts:217` records *why* the flags differ, which is the part a future reader would otherwise strip.
- Parameterizing the helper on `NodeJS.Platform` lets both branches be asserted from any host (`:49-50`), so the Windows contract is checked even on the Linux CI leg.
- POSIX keeps `O_RDONLY`, so there is no behavior change for existing Linux/macOS callers, and the helper is applied consistently to both fsync sites (`:282`, `:317`) with no other call sites left behind.
- The temp files are created mode `0o600`, so the `O_RDWR` reopen cannot trip `FILE_ATTRIBUTE_READONLY` on Windows — the fix would have been subtly broken at `0o400`.
- Adding the file to the native workflow is the correct instinct: this class of bug is only catchable on a real Windows runner.

## Verdict

DOWNVOTE

The workflow change lands a deterministically failing Platform Isolation job on macOS and the GitHub Windows image because the test roots are not canonicalized, and behind that failure the directory-fsync path still carries the same read-only-handle defect this PR fixes for files.

## Codex triage

- **CONFIRMED — unresolved temporary roots:** production canonicalizes the requested data directory, so cross-platform test assertions must compare canonical paths. The helper now wraps `mkdtempSync` in `realpathSync`; the focused 19-test suite passes after the change.
- **DISPUTED — directory fsync allegedly fails with unhandled `EACCES`:** a direct Node probe on the affected Windows ARM64 host returned `EPERM`, which `canIgnoreRunnerDataDirDirectorySyncError` already accepts. More importantly, the production-path lease and durability tests all pass on that host, including protected publication. Broadening the allowlist to `EACCES` without an observed failure would weaken fail-closed durability handling.
- **DEFERRED — reopen-to-fsync TOCTOU note:** this is explicitly P2 and does not invalidate the minimal Windows compatibility fix. The protected directory is owner-only, temporary names are unguessable UUIDs, and files are created with exclusive `wx`; a descriptor-lifetime refactor can be evaluated separately without expanding this hotfix.
