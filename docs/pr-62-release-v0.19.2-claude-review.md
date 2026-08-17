---
pr: https://github.com/picoduck/wollipog/pull/62
base: main
reviewed_head: b12e369e2ce3c0885d6594a2538771aea28e393d
merge_base: f983511f7d9f46a456fe7502ae016a7265f7ad1b
round: 1
date: 2026-08-16
reviewer: Claude Opus 5 / High
---

# PR #62 Claude review - Release v0.19.2

## Summary

The six gated version identities (`tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, desktop `package.json`, root `package.json`, `APP_RELEASE_VERSION`, runner `VERSION`) are all correctly and consistently bumped to `0.19.2`, and the technical content of the new release notes accurately describes the only change since `v0.19.1` (PR #61's Windows `FlushFileBuffers` fix). However, the new `docs/release-notes-v0.19.2.md` drops four disclosures that the repo's own release-compatibility contract test asserts, so `pnpm test` fails on this head commit and the published notes would omit the control-plane service compatibility boundary. That is a merge blocker for a release PR whose entire purpose is to be tagged.

## Findings

### P0 — v0.19.2 release notes omit the required control-plane compatibility disclosures; `release-version.test.ts` fails on this commit

- **Severity:** P0 blocker
- **Confidence:** high
- **Location:** `docs/release-notes-v0.19.2.md:1-22` (new file); contract asserted at `apps/control-plane/src/release-version.test.ts:33-50`

**Failure scenario.** `apps/control-plane/src/release-version.test.ts:37-40` reads `docs/release-notes-v${rootPackage.version}.md`, which after this bump resolves to `docs/release-notes-v0.19.2.md`. It then requires six things of that file. Grepping the new file shows only one of them is present:

| Assertion | Source | Present in v0.19.2 notes? |
| --- | --- | --- |
| `` /`wollipog-control-plane`/ `` | `release-version.test.ts:41` | **no** |
| `/Desktop v0\.15\.0 and later/` | `release-version.test.ts:42` | **no** |
| `/The address is not a Wollipog control plane\./` | `release-version.test.ts:43` | **no** |
| `/draft holds exactly ([0-9]+) assets/ === 27` | `release-version.test.ts:44-47` | yes (`docs/release-notes-v0.19.2.md:19`) |
| `` /14 desktop bundles, 12 runner names, and\s+`SHA256SUMS`/ `` | `release-version.test.ts:48` | yes (`:19`) |
| `/Publishing the verified draft remains a\s+manual operator step\./` | `release-version.test.ts:49` | **no** — replaced by "Publishing occurs only after the draft and checksums pass those release gates." (`:20-21`) |

The predecessor file `docs/release-notes-v0.19.1.md:13-15,17-19` carries exactly those sentences, and commit `b18f4a0` ("Satisfy release compatibility contract") exists precisely because the v0.19.1 notes had to be reworded to pass this test. This PR reintroduces the same defect.

Concretely: `pnpm test` (root script `package.json:31`, glob `apps/**/src/**/*.test.ts`) discovers this file, so the CI **Typecheck, Test & Sidecar Bundle** job (`.github/workflows/ci.yml:50-51`) fails. The `paths-ignore` filter (`ci.yml:9-11`) does not save the run, because this PR also touches `package.json`, `Cargo.toml`, `tauri.conf.json`, and two `.ts` files. Note the release workflow's tag preflight does **not** catch this — it only compares the six version fields — so a green-looking tag push is possible while the required check is red, and the operator would paste notes into the GitHub release that never tell users on pre-v0.15.0 desktop clients why they see `The address is not a Wollipog control plane.` and must upgrade.

Separately on substance: the substituted sentence at `:20-21` is a semantic regression, not just a string mismatch. "Publishing occurs only after the draft and checksums pass those release gates" reads as though publication is automatic once gates pass, whereas `release.yml:180` sets `releaseDraft: true` and `docs/RELEASING.md` ("Cut a release") requires an operator to open the draft and press **Publish**. Nothing in the workflow ever publishes.

**Fix.** Restore the two paragraphs from `docs/release-notes-v0.19.1.md:13-15` and the `manual operator step` wording in `docs/release-notes-v0.19.2.md`, e.g. append after line 16:

```
The control plane continues to advertise the `wollipog-control-plane` service identity.
Desktop v0.15.0 and later accept both the current and legacy service identities. Older clients may report
`The address is not a Wollipog control plane.` and must be upgraded before connecting.
```

and end the last paragraph with `Publishing the verified draft remains a manual operator step.` (keeping the existing 27-asset and `14 desktop bundles, 12 runner names, and \`SHA256SUMS\`` phrasing, which already pass).

**Test that proves it.** No new test is needed — the existing contract already encodes the requirement. `node --import tsx --test apps/control-plane/src/release-version.test.ts` from the repo root must pass, specifically the `release notes disclose the control-plane service compatibility boundary` case. Run it before pushing the tag; it is the same assertion CI will run.

## Test-gap notes

None. The failure above is caught by an existing test that this PR did not run; no additional coverage is warranted for a version-bump changeset.

## What looks good

- All six preflight-gated identities agree at `0.19.2`: `apps/desktop/src-tauri/tauri.conf.json:4`, `apps/desktop/src-tauri/Cargo.toml:3`, `apps/desktop/package.json:3`, `package.json:3`, `apps/control-plane/src/release-version.ts:6`, `apps/runner/src/version.ts:2`. The `Cargo.lock` bump is correctly limited to the `wollipog-desktop` entry (`Cargo.lock:5336`) with no dependency churn, which is what the `release-version.test.ts:21-23` lock regex checks; the unrelated `cargo_metadata 0.19.2` at `Cargo.lock:432` is coincidental and untouched. `pnpm-lock.yaml` correctly needs no change.
- The asset-inventory claim is exactly right: `EXPECTED_RELEASE_ASSET_COUNT` = `14 + 6 × 2 + 1 = 27` (`scripts/verify-runner-release-assets.mjs:9-11`), matching "14 desktop bundles, 12 runner names, and `SHA256SUMS`".
- The protocol claim is verified: `PROTOCOL_VERSION = 77` (`packages/protocol/src/index.ts:222`), unchanged by PR #61.
- Every technical bullet in the notes maps to the real merged fix: the write-capable handle (`apps/runner/src/runner-data-dir.ts:216-219`), both `publishProtected` (`:283`) and `replaceProtectedContents` (`:318`) call sites, the widened matrix in `.github/workflows/platform-isolation.yml:47` running `runner-data-dir.test.ts` on `windows-latest`/`macos-latest`, and the `realpathSync` temp-root canonicalization.
- The upgrade-path claim ("no terminal or configuration-file repair") holds up under inspection: both durability helpers publish through unique per-PID/UUID temp files removed in `finally` (`runner-data-dir.ts:283-300`, `:318-329`), so the pre-fix Windows failure leaves no owner marker or stale temp file that would block a v0.19.2 retry.
- The "spinning indefinitely" symptom is a fair description — a runner that dies during lease acquisition never reaches `online`, and `localRunnerReadiness` (`apps/web/src/onboarding.ts:119-127`) stays in the `starting` spinner state with no timeout.
- I checked the other `fsyncSync` call sites for the same Windows landmine; all are either opened write-capable or are best-effort directory flushes that tolerate Windows errors, so no second reconnect-path failure undercuts the hotfix claim.

## Verdict

DOWNVOTE

The new release notes fail the repo's own release-compatibility contract test (`apps/control-plane/src/release-version.test.ts:41-49`), so CI is red on this head commit and the published notes would drop the control-plane service compatibility boundary and the manual-publication statement.

## Codex triage

- **CONFIRMED — required release disclosures are missing:** the existing contract reads the notes for the root package version and requires all cited compatibility and publication statements. The v0.19.2 notes now restore the current/legacy service-identity boundary, the older-client error guidance, and the exact manual-operator publication statement.
