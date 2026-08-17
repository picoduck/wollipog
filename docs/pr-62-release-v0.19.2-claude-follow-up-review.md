---
pr: https://github.com/picoduck/wollipog/pull/62
base: main
reviewed_head: 3cb9ba0b69e93381fbb9cfd01cdaf939bb4be510
merge_base: f983511f7d9f46a456fe7502ae016a7265f7ad1b
round: 2
date: 2026-08-16
reviewer: Claude Opus 5 / High
---

# PR #62 Claude follow-up review - Release v0.19.2

## Summary

This is a pure release-mechanics change: six version identities plus `Cargo.lock` bumped `0.19.1 → 0.19.2`, and one new release-notes document. I verified every gated identity against the tag preflight and the `release-version.test.ts` gate, confirmed no stale `0.19.1` string survives anywhere outside the historical `docs/release-notes-v0.19.1.md`, and traced each factual claim in the notes back to the code it describes (protocol 77, the 27-asset inventory arithmetic, the merged `FlushFileBuffers` fix, and the reconnect-spinner symptom). Risk is low; I found no correctness, security, or compatibility defect.

Verification performed:

- `git log v0.19.1..3cb9ba0` contains exactly one functional commit (`f983511`, the Windows fsync fix), so the notes describe the complete delta.
- All six preflight-gated fields (`.github/workflows/release.yml:63-68`) and the `Cargo.lock` entry read `0.19.2`; `apps/control-plane/src/release-version.test.ts:24-30` will pass.
- `EXPECTED_RELEASE_ASSET_COUNT` = `14 + 6*2 + 1` = 27 (`scripts/verify-runner-release-assets.mjs:10-12`), matching the notes' "14 desktop bundles, 12 runner names, and `SHA256SUMS`". The 14 desktop bundles reconcile with the `docs/RELEASING.md` matrix (2+2+2+2+3+3).
- All four regex gates in `apps/control-plane/src/release-version.test.ts:41-49` match the new notes' exact wording and line wrapping (the `\s+` in the `and\s+\`SHA256SUMS\`` and `remains a\s+manual operator step` assertions absorb both the single space and the newline).
- `PROTOCOL_VERSION = 77` (`packages/protocol/src/index.ts:222`) and `CONTROL_PLANE_SERVICE = WOLLIPOG_CONTROL_PLANE_SERVICE` (`packages/protocol/src/index.ts:236`) confirm the "no protocol change" and service-identity paragraphs.

I also checked the "no repair required" upgrade claim against the actual failure state a v0.19.1 Windows attempt leaves behind. `publishProtected` (`apps/runner/src/runner-data-dir.ts:269-302`) removes its temp file in `finally` before rethrowing, and the desktop writes the local runner token to `app_data_dir/local-runner.token`, *not* inside `app_data_dir/local-runner-data` (`apps/desktop/src-tauri/src/lib.rs:1552-1553,1670-1684`). The data root is therefore left empty, so the `legacyMigrationRequired` guard at `apps/runner/src/runner-data-dir.ts:420-422` does not trip on the v0.19.2 retry and no `--adopt-legacy-data-dir` terminal step is needed. The claim is accurate.

Finally, I confirmed the "spinning indefinitely" symptom description: `connect_local_runner` samples `child.has_terminated()` immediately after spawn (`apps/desktop/src-tauri/src/lib.rs:2850`), so a runner that dies milliseconds later still commits, and `localRunnerReadiness` renders an untimed `"starting"` spinner (`apps/web/src/onboarding.ts:119-127`, `apps/web/src/components/OnboardRunnerDialog.tsx:243`). And I swept every other `fsyncSync` call reachable from runner startup — `durable-command-store.ts`, `session-command-receipt-store.ts`, `checkpoint-ref-ownership.ts`, `session-store.ts`, `worktree.ts` — and all of them either open with a write mode (`"wx"` / `"r+"`) or already tolerate the Windows directory-sync error, so no second instance of this bug class remains on the reconnect path.

## Findings

### P2 — Release notes drop the rollback disclosure that v0.19.1 carried forward

**Severity:** P2 non-blocking · **Confidence:** medium  
**File:** `docs/release-notes-v0.19.2.md:14-16`

`docs/release-notes-v0.19.1.md:13` ends its migration paragraph with "The v0.19.0 runner-ownership upgrade and rollback guidance remains applicable." The v0.19.2 paragraph states the forward path ("Install v0.19.2 over v0.19.1 and reconnect the local machine normally") but says nothing about the reverse.

**Failure scenario:** an operator publishes v0.19.2, hits an unrelated regression, and rolls Windows desktop installs back to v0.19.1 using the notes as the only reference. Because the sole functional change in this release is the `runnerDataDirFileSyncFlags` fix (`apps/runner/src/runner-data-dir.ts:216-219,282,317`), that rollback silently reintroduces the exact startup failure this release exists to fix — every Windows local runner fails lease acquisition again. Nothing on disk is corrupted (the v2 owner marker written under v0.19.2 is still read by v0.19.1's `isValidOwnerRecord`), so this is a documentation completeness gap rather than a data hazard, which is why it is P2 rather than P1.

**Fix:** add one sentence to the paragraph at lines 14-16, e.g. "Rolling back to v0.19.1 reintroduces this Windows startup failure; roll back only on macOS or Linux. The v0.19.0 runner-ownership rollback guidance otherwise remains applicable."

**Test that proves it:** extend the release-notes gate in `apps/control-plane/src/release-version.test.ts:33-50` with an assertion that the notes contain a rollback statement (e.g. `assert.match(releaseNotes, /roll(ing)? back/iu)`), so every future release document must state its rollback posture rather than relying on the author remembering.

### P2 — Tag preflight gates six version fields but not `Cargo.lock`

**Severity:** P2 non-blocking · **Confidence:** high  
**File:** `.github/workflows/release.yml:63-70`

The preflight reads `tauri.conf.json`, both `package.json` files, `Cargo.toml`, `release-version.ts`, and `version.ts`, but never `apps/desktop/src-tauri/Cargo.lock`. The lock is only gated by `apps/control-plane/src/release-version.test.ts:20-29`, which runs in `ci.yml` — and `ci.yml` is a pull-request/`main`-push workflow, not part of the tag-triggered release path.

**Failure scenario:** a future release bumps `Cargo.toml` to `X.Y.Z` but forgets `Cargo.lock`, and the tag is pushed to a commit that did not land through a PR (or whose CI run was stale). Preflight passes all six checks. `tauri-action` then invokes `cargo build` without `--locked`, so Cargo silently rewrites the lock in the build workspace and produces six installers from a tree whose committed lockfile does not match what was built. The release is not reproducible from the tagged commit, and the discrepancy is never surfaced.

This PR itself updates `Cargo.lock` correctly (`apps/desktop/src-tauri/Cargo.lock:5336`), so this is a hardening gap in the surrounding process, not a defect in the change under review.

**Fix:** add a seventh comparison to the preflight loop, mirroring the test's regex:

```sh
cargolock=$(sed -nE '/^name = "wollipog-desktop"$/{n;s/^version = "(.*)"/\1/p;}' \
  apps/desktop/src-tauri/Cargo.lock | head -1 | tr -d '\r')
```

then append `"Cargo.lock=$cargolock"` to the `for pair in ...` list at line 70.

**Test that proves it:** add an assertion to `apps/control-plane/src/release-version.test.ts:52-123` (which already pattern-matches `release.yml`) requiring the workflow source to contain a `Cargo.lock` comparison — for example `assert.match(workflow, /"Cargo\.lock=\$cargolock"/u, "tag preflight must gate the Cargo lockfile")`.

## Test-gap notes

None. The version-identity and release-notes contracts are both covered by `apps/control-plane/src/release-version.test.ts`, and that file reads `docs/release-notes-v${rootPackage.version}.md` directly, so a missing or non-conforming notes document fails `pnpm test`. Both gaps I identified are captured as findings above with their proposed tests.

## What looks good

- The bump is complete and self-consistent: all six preflight-gated identities plus `Cargo.lock` move together, and the `Cargo.lock` diff touches only the `wollipog-desktop` version line — no dependency drift smuggled into a release commit.
- No stale `0.19.1` reference survives anywhere in code, config, scripts, or workflows; the only hits are the historical v0.19.1 notes and an unrelated `toml_edit 0.19.15`.
- The release notes are factually accurate on every checkable claim: the 27-asset arithmetic matches `EXPECTED_RELEASE_ASSET_COUNT`, protocol v77 matches `packages/protocol/src/index.ts:222`, the byte-identical alias claim matches both the `cmp -s` in `release.yml` and the digest-pair check in `verifyHostedRelease`, and each of the four fix bullets maps to a real hunk in `f983511`.
- The follow-up commit `3cb9ba0` restores the service-identity and asset-inventory disclosures that the machine-checked gate in `release-version.test.ts:33-50` requires, and it does so without breaking the `\s+` line-wrap-sensitive assertions.
- Scoping the notes to "the bundled local runner startup failure that could leave Reconnect This Machine spinning indefinitely" is precisely correct rather than overclaiming — the spinner is genuinely untimed, and this release genuinely removes the only cause of it introduced by the runner data-directory path.

## Verdict

UPVOTE

The version bump is complete and internally consistent across every gated identity plus the Cargo lockfile, and every substantive claim in the new release notes verifies against the code it describes; the two P2 notes are documentation and CI-hardening improvements that do not affect the correctness of this release.

## Codex triage

- **DEFERRED — add an explicit rollback statement:** this is a non-blocking documentation enhancement. The notes already state that installing v0.19.2 is the Windows repair path, and the P2 confirms rollback causes no data hazard. Preserve the independently reviewed release head rather than changing it after an `UPVOTE`.
- **DEFERRED — gate Cargo.lock in tag preflight:** this is valid process hardening but not a defect in PR #62; the committed lock entry is correct, the release-version contract test gates it in this reviewed PR, and hosted CI must pass before the tag is created.
