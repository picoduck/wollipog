import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/desktop-native.yml",
  ".github/workflows/platform-isolation.yml",
];
const RELEASE_WORKFLOW = ".github/workflows/release.yml";

const EXPECTED_PULL_REQUEST_TYPES = ["opened", "synchronize", "reopened", "ready_for_review"];
const EXPECTED_GROUP_TEMPLATE =
  "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}-${{ github.event_name == 'pull_request' && github.event.pull_request.draft && github.event.action != 'ready_for_review' && 'draft' || 'active' }}";
const EXPECTED_JOB_GUARD =
  "github.event_name != 'pull_request' || github.event.action == 'ready_for_review' || github.event.pull_request.draft == false";

function workflowContract(path) {
  const text = readFileSync(resolve(process.cwd(), path), "utf8");
  const pullRequestTypes = text.match(
    /^  pull_request:\r?\n    types: \[([^\]]+)\]$/m,
  );
  const concurrencyGroup = text.match(/^  group:\s*(.+)$/m);
  const jobGuards = [...text.matchAll(/^ {4}if:\s*(.+)$/gm)];

  assert.ok(pullRequestTypes, `${path}: missing pull_request types`);
  assert.ok(concurrencyGroup, `${path}: missing concurrency group`);
  const jobIds = (text.split(/^jobs:\r?\n/m)[1] ?? "").match(/^  [A-Za-z_][A-Za-z0-9_-]*:$/gm) ?? [];
  assert.ok(jobIds.length >= 1, `${path}: expected at least one job`);
  assert.equal(jobGuards.length, jobIds.length, `${path}: every job needs a job-level if guard (${jobGuards.length} of ${jobIds.length} jobs have one)`);
  assert.match(text, /^  cancel-in-progress: true$/m, `${path}: concurrency must cancel in progress`);
  // Every job carries the same draft guard. An aggregating job may wrap it in
  // `always() && (...)` so it still reports when the jobs it needs fail or are cancelled.
  const guards = [...new Set(jobGuards.map((match) => unwrapAggregatorGuard(match[1].trim())))];
  assert.equal(guards.length, 1, `${path}: every job must carry the same draft guard, got ${JSON.stringify(guards)}`);

  return {
    pullRequestTypes: pullRequestTypes[1].split(",").map((value) => value.trim()),
    groupTemplate: concurrencyGroup[1].trim(),
    jobGuard: guards[0],
  };
}

function unwrapAggregatorGuard(expression) {
  const wrapped = expression.match(/^\$\{\{\s*always\(\)\s*&&\s*\((.+)\)\s*\}\}$/);
  return wrapped ? wrapped[1].trim() : expression;
}

function groupExpressions(groupTemplate) {
  const match = groupTemplate.match(
    /^\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*(.+?)\s*\}\}-\$\{\{\s*(.+?)\s*\}\}$/,
  );
  assert.ok(match, "concurrency group must retain workflow, ref, and lane segments");
  return { ref: match[1], lane: match[2] };
}

function evaluate(expression, github) {
  return vm.runInNewContext(expression, { github }, { timeout: 1_000 });
}

function githubContext(row) {
  return {
    workflow: "Contract Test",
    ref: row.ref,
    event_name: row.eventName,
    event: {
      action: row.action,
      pull_request:
        row.eventName === "pull_request"
          ? { number: 258, draft: row.draft }
          : {},
    },
  };
}

const PR_ACTIONS = ["opened", "synchronize", "reopened"];
const EVENT_MATRIX = [
  ...PR_ACTIONS.flatMap((action) => [
    {
      name: `pull_request/${action}/draft`,
      eventName: "pull_request",
      action,
      draft: true,
      ref: "refs/pull/258/merge",
      expectedLane: "draft",
      expectedRun: false,
      expectedRef: 258,
    },
    {
      name: `pull_request/${action}/ready`,
      eventName: "pull_request",
      action,
      draft: false,
      ref: "refs/pull/258/merge",
      expectedLane: "active",
      expectedRun: true,
      expectedRef: 258,
    },
  ]),
  {
    name: "pull_request/ready_for_review/current payload",
    eventName: "pull_request",
    action: "ready_for_review",
    draft: false,
    ref: "refs/pull/258/merge",
    expectedLane: "active",
    expectedRun: true,
    expectedRef: 258,
  },
  {
    name: "pull_request/ready_for_review/stale draft payload",
    eventName: "pull_request",
    action: "ready_for_review",
    draft: true,
    ref: "refs/pull/258/merge",
    expectedLane: "active",
    expectedRun: true,
    expectedRef: 258,
  },
  {
    name: "push/main",
    eventName: "push",
    action: undefined,
    draft: undefined,
    ref: "refs/heads/main",
    expectedLane: "active",
    expectedRun: true,
    expectedRef: "refs/heads/main",
  },
  {
    name: "workflow_dispatch/branch",
    eventName: "workflow_dispatch",
    action: undefined,
    draft: undefined,
    ref: "refs/heads/contract-test",
    expectedLane: "active",
    expectedRun: true,
    expectedRef: "refs/heads/contract-test",
  },
];

test("PR workflows share the ready-for-review concurrency contract", () => {
  const contracts = WORKFLOWS.map((path) => ({ path, ...workflowContract(path) }));

  for (const contract of contracts) {
    assert.deepEqual(
      contract.pullRequestTypes,
      EXPECTED_PULL_REQUEST_TYPES,
      `${contract.path}: pull_request event coverage drifted`,
    );
    assert.equal(
      contract.groupTemplate,
      EXPECTED_GROUP_TEMPLATE,
      `${contract.path}: concurrency expression drifted`,
    );
    assert.equal(
      contract.jobGuard,
      EXPECTED_JOB_GUARD,
      `${contract.path}: job guard drifted`,
    );
  }

  assert.equal(
    new Set(contracts.map(({ groupTemplate }) => groupTemplate)).size,
    1,
    "concurrency groups must remain identical across PR workflows",
  );
  assert.equal(
    new Set(contracts.map(({ jobGuard }) => jobGuard)).size,
    1,
    "job guards must remain identical across PR workflows",
  );
});

test("PR workflows keep least-privilege permissions and an always-present required check", () => {
  for (const path of WORKFLOWS) {
    const text = readFileSync(resolve(process.cwd(), path), "utf8");
    assert.match(
      text,
      /^permissions:\r?\n  contents: read$/m,
      `${path}: expected explicit read-only contents permission`,
    );
  }

  const ci = readFileSync(resolve(process.cwd(), WORKFLOWS[0]), "utf8");
  assert.match(
    ci,
    /^    name: Typecheck, Test & Sidecar Bundle$/m,
    `${WORKFLOWS[0]}: job name is a protected required status context`,
  );
  assert.doesNotMatch(
    ci,
    /^\s+paths-ignore:/m,
    `${WORKFLOWS[0]}: path filters can suppress the required status check`,
  );
});

test("the required CI check aggregates parallel jobs that each own a time budget", () => {
  const ci = readFileSync(resolve(process.cwd(), WORKFLOWS[0]), "utf8");
  const jobsText = ci.split(/^jobs:\r?\n/m)[1];
  const starts = [...jobsText.matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):$/gm)];
  const byId = Object.fromEntries(starts.map((match, index) => [
    match[1],
    jobsText.slice(match.index, index + 1 < starts.length ? starts[index + 1].index : undefined),
  ]));
  assert.deepEqual(Object.keys(byId), ["checks", "browser", "check"], "CI jobs drifted");
  for (const id of ["checks", "browser"]) {
    assert.match(byId[id], /^    timeout-minutes: (\d+)$/m, `${id}: needs its own time budget`);
    assert.doesNotMatch(byId[id], /^    needs:/m, `${id}: the work jobs run in parallel, not chained`);
  }
  assert.match(byId.browser, /Remote-Instance Browser End-to-End Tests/, "the browser suite runs in its own job");
  assert.doesNotMatch(byId.checks, /Remote-Instance Browser End-to-End Tests|Rendered Production Browser Smoke/,
    "the browser suites must not share the unit-test job's budget");
  assert.match(byId.checks, /^      - name: Unit Tests$/m);
  assert.match(byId.check, /^    name: Typecheck, Test & Sidecar Bundle$/m, "the required context is the aggregator");
  assert.match(byId.check, /^    needs: \[checks, browser\]$/m, "the aggregator must wait for every work job");
  assert.match(byId.check, /^    if: \$\{\{ always\(\) && \(/m,
    "the aggregator must run when a needed job failed or was cancelled, or the required context never reports");
  assert.match(byId.check, /needs\.checks\.result/, "the aggregator must inspect the checks job result");
  assert.match(byId.check, /needs\.browser\.result/, "the aggregator must inspect the browser job result");
  assert.match(byId.check, /cancelled\) .*timeout-minutes budget/, "a cancelled job is reported as a budget hit, not a flaky test");
});

test("workflow actions use immutable commit pins", () => {
  for (const path of [...WORKFLOWS, RELEASE_WORKFLOW]) {
    const text = readFileSync(resolve(process.cwd(), path), "utf8");
    const actionRefs = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map(
      (match) => match[1],
    );

    assert.notEqual(actionRefs.length, 0, `${path}: expected at least one action reference`);
    for (const actionRef of actionRefs) {
      assert.match(
        actionRef,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${path}: action reference must use a full commit SHA: ${actionRef}`,
      );
    }
  }
});

test("real WSL isolation CI keeps automatic PE/binfmt interop out of the provider boundary", () => {
  const platform = readFileSync(resolve(process.cwd(), WORKFLOWS[2]), "utf8");

  assert.match(platform, /os: \[windows-latest, windows-2025, macos-latest\]/u);
  assert.match(platform, /Verify WSL Boundaries Stay Fail-Closed/u);
  assert.match(platform, /WOLLIPOG_WSL_FAIL_CLOSED_DISTRO = "Ubuntu-24\.04"/u);
  assert.match(platform, /node --import tsx --test --test-reporter=tap apps\/runner\/src\/wsl-bwrap-fail-closed\.integration\.test\.ts/u,
    "the real WSL job must exercise the product's Direct bwrap rejection against a target-local alias");
  assert.match(platform, /\$wslBoundaryOutput -notmatch '\(\?m\)\^# pass 1\\r\?\$'/u);
  assert.match(platform, /\$wslBoundaryOutput -notmatch '\(\?m\)\^# skipped 0\\r\?\$'/u,
    "the WSL boundary job must fail if its opt-in real integration test silently skips");
  assert.match(platform,
    /\$savedBoundaryPreference = \$ErrorActionPreference[\s\S]*\$ErrorActionPreference = "Continue"[\s\S]*\$wslBoundaryExit = \$LASTEXITCODE[\s\S]*\$ErrorActionPreference = \$savedBoundaryPreference/u,
    "native stderr capture must not terminate PowerShell before the explicit exit and TAP checks");
  assert.match(platform, /apt-get install -y bubblewrap build-essential curl xz-utils/u,
    "the real target must compile the checked-in native launcher source");
  assert.match(platform, /node --import tsx --test --test-reporter=tap apps\/runner\/src\/wsl-agent-control\.wsl\.test\.ts/u,
    "the real WSL job must exercise the safe launcher and authenticated broker end to end");
  assert.match(platform, /\$safeWslOutput -notmatch '\(\?m\)\^# pass 1\\r\?\$'/u);
  assert.match(platform, /\$safeWslOutput -notmatch '\(\?m\)\^# skipped 0\\r\?\$'/u,
    "the safe-launcher integration must fail if it silently skips");
  assert.match(platform, /wsl\.exe -d Ubuntu-24\.04 -- cmd\.exe \/d \/c exit 0/u,
    "the capability-sensitive outside probe must use WSL's ordinary binfmt command path");
  assert.match(platform, /WSLInterop registration outside bwrap:/u);
  assert.match(platform, /WSLInterop registration inside bwrap: absent/u);
  assert.match(platform, /\$registrationExit = \$LASTEXITCODE/u);
  assert.match(platform, /cmd\.exe executable outside bwrap: \$outsideInterop/u);
  assert.match(platform, /Hosted WSL baseline lacks PE interop; verifying bwrap does not add it/u);
  assert.match(platform, /-not \$outsideInterop -and \$outsideOutput -notmatch 'Exec format error'/u,
    "unexpected host-side failures must not be accepted as a fail-closed baseline");
  assert.doesNotMatch(platform, /WSL Windows interop baseline failed outside bwrap/u,
    "host PE interop availability is diagnostic, not a prerequisite");
  assert.match(platform, /--chdir \/ -- \/bin\/true/u,
    "a production-shaped bwrap smoke test must prove the sandbox itself works");
  assert.match(platform, /test ! -e \/proc\/sys\/fs\/binfmt_misc\/WSLInterop/u,
    "the fresh provider proc must explicitly prove the automatic WSL binfmt registration is absent");
  assert.match(platform, /--proc \/proc --tmpfs \/tmp --chdir \/ -- \$cmdPath/u);
  assert.match(platform, /bwrap unexpectedly preserved automatic PE\/binfmt interop/u);
  assert.doesNotMatch(platform, /\$blockedOutput -notmatch/u,
    "libc execvp may fall back to a shell after ENOEXEC, so denial is behavioral rather than stderr-textual");
  assert.doesNotMatch(platform, /--bind[^\n]*\/init|--ro-bind[^\n]*\/init/u,
    "CI must never add a dedicated WSL /init bind inside bwrap");
});

test("desktop Rust verification enforces the lockfile and runs one pinned audit", () => {
  const desktop = readFileSync(resolve(process.cwd(), WORKFLOWS[1]), "utf8");

  assert.match(
    desktop,
    /^      - name: Install Cargo Audit\r?\n        if: startsWith\(matrix\.os, 'ubuntu'\)\r?\n        run: cargo install cargo-audit --version 0\.22\.2 --locked$/m,
    "desktop CI must install an exact cargo-audit release on only the Linux matrix leg",
  );
  assert.match(
    desktop,
    /^      - name: Audit Locked Dependencies\r?\n        if: startsWith\(matrix\.os, 'ubuntu'\)\r?\n        run: cargo audit --file apps\/desktop\/src-tauri\/Cargo\.lock$/m,
    "desktop CI must audit the committed lockfile on only the Linux matrix leg",
  );
  assert.equal(
    desktop.match(/cargo audit --file apps\/desktop\/src-tauri\/Cargo\.lock/g)?.length,
    1,
    "desktop CI must not duplicate the audit across matrix legs",
  );
  assert.match(
    desktop,
    /run: cargo test --locked --manifest-path apps\/desktop\/src-tauri\/Cargo\.toml/,
    "desktop tests must fail instead of resolving a changed lockfile",
  );
  assert.match(
    desktop,
    /run: cargo clippy --locked --manifest-path apps\/desktop\/src-tauri\/Cargo\.toml/,
    "desktop lint must fail instead of resolving a changed lockfile",
  );

  const rootPackage = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  assert.match(rootPackage.scripts["check:rust"], /cargo clippy --locked /);
  assert.match(rootPackage.scripts["check:rust"], /cargo test --locked /);
});

test("CI validates production builds and caches the pinned Playwright browser", () => {
  const ci = readFileSync(resolve(process.cwd(), WORKFLOWS[0]), "utf8");

  assert.match(
    ci,
    /^      - name: Validate Web Production Build\r?\n        run: pnpm --filter @wollipog\/web build$/m,
    "CI must exercise the web production build",
  );
  assert.match(
    ci,
    /^      - name: Rendered Production Browser Smoke\r?\n        run: pnpm test:e2e:production$/m,
    "CI must render the built Timeline and Settings fixtures through the production preview server",
  );
  assert.match(
    ci,
    /^      - name: Validate Runner Bundle\r?\n        run: pnpm --filter @wollipog\/runner exec node scripts\/build-binary\.mjs --bundle-only$/m,
    "CI must exercise the runner esbuild bundle",
  );
  assert.match(
    ci,
    /^      - name: Resolve Playwright Version\r?\n        id: playwright-version\r?\n        run: \|\r?\n          playwright_version="\$\(pnpm exec playwright --version\)"\r?\n          echo "version=\$\{playwright_version#Version \}" >> "\$GITHUB_OUTPUT"$/m,
    "the cache key must derive from the installed pinned Playwright version",
  );
  assert.match(
    ci,
    /^      - name: Cache Playwright Browser\r?\n        id: playwright-cache\r?\n        uses: actions\/cache@[0-9a-f]{40}[^\r\n]*\r?\n        with:\r?\n          path: ~\/\.cache\/ms-playwright\r?\n          key: \$\{\{ runner\.os \}\}-playwright-\$\{\{ steps\.playwright-version\.outputs\.version \}\}$/m,
    "CI must cache Playwright's browser directory by OS and exact version",
  );
  assert.match(
    ci,
    /^      - name: Install Playwright Browser\r?\n        if: steps\.playwright-cache\.outputs\.cache-hit != 'true'\r?\n        run: pnpm exec playwright install --with-deps chromium$/m,
  );
  assert.match(
    ci,
    /^      - name: Install Playwright System Dependencies\r?\n        if: steps\.playwright-cache\.outputs\.cache-hit == 'true'\r?\n        run: pnpm exec playwright install-deps chromium$/m,
  );
});

test("PR workflow expressions satisfy the complete event matrix", () => {
  const { groupTemplate, jobGuard } = workflowContract(WORKFLOWS[0]);
  const expressions = groupExpressions(groupTemplate);

  for (const row of EVENT_MATRIX) {
    const github = githubContext(row);
    const lane = evaluate(expressions.lane, github);
    const shouldRun = evaluate(jobGuard, github);
    const refSegment = evaluate(expressions.ref, github);

    assert.equal(lane, row.expectedLane, `${row.name}: wrong concurrency lane`);
    assert.equal(shouldRun, row.expectedRun, `${row.name}: wrong job decision`);
    assert.equal(refSegment, row.expectedRef, `${row.name}: wrong concurrency ref segment`);
    assert.notEqual(String(refSegment).length, 0, `${row.name}: empty concurrency ref segment`);
    assert.equal(
      lane === "draft",
      shouldRun === false,
      `${row.name}: draft lane must be exactly the skipped-job lane`,
    );
  }
});

test("every workflow job bounds its own runtime", () => {
  // Without timeout-minutes a hung job runs to GitHub's 360-minute default. CI normally
  // finishes in under 20 minutes, so any bound here is a large improvement; the ceiling
  // below just keeps a future edit from restoring the default in all but name.
  const MAX_TIMEOUT_MINUTES = 60;

  for (const path of [...WORKFLOWS, RELEASE_WORKFLOW]) {
    const text = readFileSync(resolve(process.cwd(), path), "utf8");
    const jobsIndex = text.search(/^jobs:$/m);
    assert.notEqual(jobsIndex, -1, `${path}: missing jobs block`);

    const jobsBlock = text.slice(jobsIndex);
    const jobHeadings = [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
    assert.notEqual(jobHeadings.length, 0, `${path}: expected at least one job`);

    for (const [index, heading] of jobHeadings.entries()) {
      const end = jobHeadings[index + 1]?.index ?? jobsBlock.length;
      const body = jobsBlock.slice(heading.index, end);
      const timeout = body.match(/^ {4}timeout-minutes: (\d+)$/m);

      assert.ok(timeout, `${path}: job "${heading[1]}" must set timeout-minutes`);
      assert.ok(
        Number(timeout[1]) <= MAX_TIMEOUT_MINUTES,
        `${path}: job "${heading[1]}" timeout-minutes ${timeout[1]} exceeds ${MAX_TIMEOUT_MINUTES}`,
      );
    }
  }
});
