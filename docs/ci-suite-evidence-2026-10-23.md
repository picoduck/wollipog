# Initial Suite Shadow Evidence

Refs #3629. These measurements cover local validation of PR #3652, based on
`f6865fdf83db979eef6c7598e0112c04fd32deba` before dependency #3643 lands.
Environment: Linux, Node 24.18.1, Playwright 1.63.0. No CI traffic was dispatched
or rerun for sampling. The candidate target remains proposed, not demonstrated.

| Local Check | Observed Result | Runtime Scope |
| --- | --- | --- |
| All Package Typechecks | Passed, including test sources | Wall time not instrumented |
| Authentication, Recovery API, Runner-Channel API Files | 30 passed | Native Node test run: 37.324 s |
| Five Critical Chromium Files | 147 passed, 2 configured skips | Playwright-reported elapsed: 3.3 min |
| Complete Production Smoke | 55 passed | Playwright-reported elapsed: 36.5 s |
| Complete Configured WebKit | 5 launch failures, zero executed assertions | Missing local `libevent-2.1.so.7`; not a product assertion result |
| Web Production Build | Passed, icon bundle contract passed | Vite build phase: 3.55 s; not whole-command wall time |
| Runner and Sidecar Bundle-Only Builds | Passed | Whole-command wall time not instrumented |
| Selection/Report/Trust/Threshold Contracts | 20 passed before final dependency rebase | Inert local exercises; not natural shadow comparisons |

The critical Chromium command was:

```sh
pnpm test:e2e authentication-recovery.spec.ts new-session-choices.spec.ts \
  request-surfaces.spec.ts issue-closure.spec.ts conversation-handoff.spec.ts
```

API validation ran the exact three `FAST_API_FILES` with Node's native test
runner and the existing 300-second per-file timeout. The runner-channel test
reported maximum handshake 452 ms, HTTP 540 ms and pong 539 ms across its three
registrations; no retry or timing assertion was changed.

The local WebKit binary failed while loading a required shared library, before
any page/assertion. No system packages, hosting stack, browser assertions or test
exclusions were changed to make it pass. The same configured WebKit suite passed
in prerequisite PR #3643's natural CI run
[40056011289](https://github.com/picoduck/wollipog/actions/runs/40056011289/job/120759041558)
in 1 min 16 s; this is context, not certification of this PR's head.

These phases were run separately. Adding their durations cannot establish an
actual standalone fast-suite wall time, parallel CI critical path, runner cost,
or speedup. Complete required PR and merge-group CI must still validate the
reviewed head, including the Linux containment, engine-boundary and Windows
contracts that the portable local command does not emulate.

## Historical and Natural Comparison

The stored natural baseline window is half-open UTC
`2026-10-20T00:00:00Z`–`2026-10-22T00:00:00Z`, collected by the existing
`merge-queue-wait-report` tooling. Offline suite-shadow evaluation finds zero
compatible selection records: 257 PR/merge-group attempt gaps out of 315 total
attempt records (the other event is main push). No missing record is a pass or
evidence of zero missed failures. No historical sample is assigned a new suite
identity retroactively.

Historical path/outcome exercises cover #3617, #3517, #2601 and #2452; their
representative selection inputs are explicitly inert. The 30-change threshold
test also uses invented records. Neither contributes a natural observation.

Remaining: at least 30 eligible natural changes over five working days under a
compatible versioned contract, individual miss/flake/infrastructure triage,
actual shadow-job overhead, and a reviewed fast/full outcome/runtime comparison.
Do not declare readiness or change required checks from these local results.
