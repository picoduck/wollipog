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
  assert.equal(jobGuards.length, 1, `${path}: expected one job-level if guard`);
  assert.match(text, /^  cancel-in-progress: true$/m, `${path}: concurrency must cancel in progress`);

  return {
    pullRequestTypes: pullRequestTypes[1].split(",").map((value) => value.trim()),
    groupTemplate: concurrencyGroup[1].trim(),
    jobGuard: jobGuards[0][1].trim(),
  };
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
