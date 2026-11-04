# PR Browser Assurance Routing

Refs #3630 and #3812. **Inactive until separate owner activation.** Independent
policy `pr-browser-critical-v1` uses new variable `CI_PR_BROWSER_ROUTING=enabled`.
The former `CI_PR_SUITE_ROUTING` cannot activate it: legacy prose/Node-reduction
approval must not silently activate a different assurance contract. Agents never
create, change or delete repository variables or settings.

## Coverage and Required Context

Workflow `CI` remains at `.github/workflows/ci.yml`. Protected result
**Typecheck, Test & Sidecar Bundle** retains these event-specific meanings:

| Event | Default/Off | Exact Enabled Value |
| --- | --- | --- |
| Draft PR | Existing draft exclusion | Same |
| Ready PR, Including Stale Draft Payload on Ready Event | Complete coverage | Critical Chromium files plus every added/modified browser spec, or full fallback |
| Merge Group | Complete regression | Same; PR routing is never admitted |
| Main Push or Reusable Rolling Validation | Complete regression | Same |
| Ordinary Manual Dispatch | Complete regression | Same |
| Explicit Branch Benchmark Dispatch | Isolated browser simulation | Same; never emits the protected context |

Every PR retains all three full Node shards, typecheck, engine boundaries,
web/control-plane/runner bundles, delegated Linux containment/recovery, Platform
Isolation, full WebKit, Windows change detection and conditional comparison.
Only development Chromium shrinks. Shard 1 retains production build/smoke.
The disabled fast-only merge-group gate and legacy selector are unchanged;
this campaign does not authorize activation. Full queue regression remains the
premerge integration gate.

## Reviewed Critical Manifest

`scripts/ci-pr-browser-policy.mjs` owns seven complete critical files:

| File | Reason |
| --- | --- |
| authentication-recovery.spec.ts | Authentication recovery |
| new-session-choices.spec.ts | Session creation |
| request-surfaces.spec.ts | Approval/decision surfaces |
| issue-closure.spec.ts | Issue closure/campaign boundary |
| conversation-handoff.spec.ts | Conversation continuity |
| automation-triggers.spec.ts | Recorded UTC trigger regression #3617 |
| command-inbox-projects.spec.ts | Recorded Composer Escape regression #3517 |

The original five remain; additions follow committed regression exercises in
`scripts/fixtures/ci-suite-regressions.json`. Runner-channel regression #2601
remains covered by full Node testing. This is a reviewed risk tradeoff, not proof
of complete browser behavior. Deferred journeys remain mandatory in the queue.
Manifest changes require a reviewed version change and measurement.

## Trusted Selection and Failure Behavior

The optional PR plan checks out immutable base with non-persisted credentials,
reads tested Git objects without importing tested policy, verifies base/head
ancestry in the tested merge, and requires identical base/tested workflow blobs.
Every critical file and each added/modified browser spec is selected. Ordinary
web/control-plane implementation can qualify. Runner source stays full. High-risk security/persistence/approval/
execution paths, shared helpers/fixtures/harnesses, Playwright config, inventory,
profile/routing scripts, workflow, lockfiles, manifests, shared packages,
docs/assets and unknown inputs require full. Renames/deletions/type changes,
missing base, incomplete diff and missing critical/changed inventory stay full.

Execution independently validates selected canonical paths against live inventory
and requires every critical file. Exact matches preserve whole files, serial
fixtures, one worker, retries and fail-on-flaky semantics. JSON is an environment
value, never executable shell interpolation or arbitrary CLI arguments.

Only exact lowercase `enabled` reduces coverage. Case-insensitive GitHub equality
can admit planning for `Enabled`, but the raw shell selects full and aggregation
rejects reduction. Default/off adds no executed plan. Failed/cancelled/skipped
planning cannot shrink the matrix. Active planning must succeed with explicit
full/fast mode; every work dependency must succeed. Missing, cancelled, unexpected
skips and unknown outcomes fail. Setup/timeouts remain failures; unavailable
Git/selection explicitly selects full. Existing draft/ready admission, duplicate
head safety, PR cancellation, stale-head superseding, reruns, queue replacement
and read-only permissions remain. `fast` means browser selection, never fewer
Node tests on a PR.

## Full Diagnostics and Isolated Measurement

Authors/maintainers can run complete CI regardless of routing:

```sh
gh workflow run ci.yml --repo picoduck/wollipog --ref <branch>
```

Verify tested SHA. Dispatch tests branch head; PR CI tests GitHub's merge commit.
A diagnostic cannot replace required PR/queue checks. Before merge, explicitly
simulate the reduced lane on a feature branch without repository variables:

```sh
gh workflow run ci.yml --repo picoduck/wollipog --ref <branch> -f browser_benchmark=true
```

The flag exists only under workflow_dispatch, not rolling reusable inputs. The
same event/input guard controls reduced matrix and a distinct **PR Browser
Benchmark Result** name. PR/merge-group events cannot exploit the flag; reduced
dispatch cannot emit the protected context. Default dispatch stays full. The
simulation runs critical files, full Node/check/platform work, WebKit, Windows
and production smoke. It represents critical-only PR work, not arbitrary changed
specs or live planning latency. At most four additional runs per PR are authorized.

Record run/job IDs, SHA and UTC half-open window. Compare with a recent natural
full PR; report result latency, critical job/step, elapsed runner-minutes, runner
wait, test execution and separate unmeasured timestamp conflicts. Never impute
zero wait, subtract assumed offsets or translate elapsed minutes into billing
dollars. Name Node/WebKit/platform bottlenecks even if 15 minutes is missed.
Natural post-activation PR/queue/cancellation evidence remains required by #3630.

## Owner Activation and Rollback

After merge, exact assurance approval and v1.1 shadow compatibility:

```sh
# Owner only; never execute from this implementation session.
gh variable set CI_PR_BROWSER_ROUTING --repo picoduck/wollipog --body enabled
gh variable get CI_PR_BROWSER_ROUTING --repo picoduck/wollipog
```

Record revision, actor and UTC activation. A new ordinary source PR event must
prove successful routing, all full Node shards, selected Chromium plus production,
WebKit/Windows/platform work and the protected result. A workflow/helper edit
must prove all Chromium shards. Queue integration must remain complete.

Rollback restores full PR testing:

```sh
# Owner only.
gh variable set CI_PR_BROWSER_ROUTING --repo picoduck/wollipog --body disabled
gh variable get CI_PR_BROWSER_ROUTING --repo picoduck/wollipog
```

Use a new PR event: verify skipped planning, all five full Chromium shards, all
full Node shards and successful protected result. Failed-jobs reruns can retain
an earlier plan/matrix and cannot prove rollback. In-flight observations do not
prove later settings. No ruleset migration is needed.

## Coordinated Shadow Compatibility and Measurement Status

Parent-approved deferral keeps legacy shadow emission in #3812. After #4046/#4148
merges, rebase and add v1.1 collector/report support before switching emission
and requesting activation. Historical v1 records never certify v1.1 or this policy.

Benchmark/full-PR comparison is pending. No latency, queue, runner-minute, cost
saving or 15-minute achievement is claimed. Link measured run/job evidence before
implementation merge; post-activation natural measurement remains afterward.
