import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assessDependabotHealth,
  collectOutdated,
  parseIgnoredDependencies,
  parseIssueDeferrals,
  renderReport,
} from "./check-dependabot-stall.mjs";

const NOW = new Date("2026-09-09T12:00:00Z");

function outdated(current, latest) {
  return { current, latest };
}

function pull(overrides = {}) {
  return {
    number: 10,
    title: "chore(deps): bump fastify from 5.12.1 to 5.12.3",
    body: "Updates `fastify` from 5.12.1 to 5.12.3.",
    url: "https://example.test/pulls/10",
    createdAt: "2026-09-08T12:00:00Z",
    statusCheckRollup: [],
    ...overrides,
  };
}

test("parses dependency names only from ignore blocks", () => {
  const config = `
groups:
  example:
    dependency-name: "not-an-ignore"
ignore:
  - dependency-name: "@agentclientprotocol/sdk"
  - dependency-name: '@types/*'
labels:
  - dependencies
`;

  assert.deepEqual(parseIgnoredDependencies(config), ["@agentclientprotocol/sdk", "@types/*"]);
});

test("parses explicit deferral markers from issue bodies", () => {
  const issues = [
    { number: 22, body: "Context\nDependabot-Deferral: `lucide-react`\nMore context" },
    { number: 23, body: "Dependabot-Deferral: typescript" },
  ];

  assert.deepEqual([...parseIssueDeferrals(issues).keys()], ["lucide-react", "typescript"]);
});

test("accepts PR, ignore, and issue coverage without confusing package prefixes", () => {
  const result = assessDependabotHealth({
    outdated: {
      fastify: outdated("5.12.1", "5.12.3"),
      react: outdated("19.0.0", "19.1.0"),
      "react-dom": outdated("19.0.0", "19.1.0"),
      typescript: outdated("5.9.3", "7.0.2"),
      "lucide-react": outdated("1.38.0", "1.43.0"),
    },
    pulls: [
      pull(),
      pull({
        number: 11,
        title: "chore(deps): bump the frontend group",
        body: "Updates `react-dom` from 19.0.0 to 19.1.0.",
      }),
    ],
    issues: [{ number: 22, body: "Dependabot-Deferral: `lucide-react`" }],
    config: "ignore:\n  - dependency-name: \"typescript\"\n",
    now: NOW,
  });

  assert.deepEqual(result.uncovered, [
    { dependency: "react", current: "19.0.0", latest: "19.1.0" },
  ]);
  assert.equal(result.healthy, false);
});

test("does not treat package names found only in release notes as coverage", () => {
  const result = assessDependabotHealth({
    outdated: { ws: outdated("8.21.0", "8.21.3") },
    pulls: [pull({
      body: "Bumps [fastify](https://example.test/fastify) from 5.12.1 to 5.12.3.\n<details>Release notes mention ws.</details>",
    })],
    issues: [],
    config: "",
    now: NOW,
  });

  assert.deepEqual(result.uncovered, [
    { dependency: "ws", current: "8.21.0", latest: "8.21.3" },
  ]);
});

test("does not treat a group named after a package as coverage for that package", () => {
  const result = assessDependabotHealth({
    outdated: { fastify: outdated("5.12.5", "5.12.7") },
    pulls: [
      pull({
        title: "chore(deps): bump the fastify group",
        body: "Bumps the fastify group with updates to @fastify/cors and @fastify/static.\n"
          + "<details>Release notes.</details>",
      }),
      pull({
        number: 11,
        title: "chore(deps)(deps): bump @fastify/static from 10.1.6 to 10.1.7 in the fastify group",
        body: "Bumps the fastify group with 1 update: [@fastify/static](https://example.test/static).\n\n"
          + "Updates `@fastify/static` from 10.1.6 to 10.1.7\n<details>Release notes.</details>",
      }),
      pull({
        number: 12,
        title: "chore(deps)(deps): bump the fastify group across 1 directory with 2 updates",
        body: "Bumps the fastify group with 2 updates in the / directory: [@fastify/cors](https://example.test/cors) "
          + "and [@fastify/static](https://example.test/static).\n<details>Release notes.</details>",
      }),
    ],
    issues: [],
    config: "",
    now: NOW,
  });

  assert.deepEqual(result.uncovered, [
    { dependency: "fastify", current: "5.12.5", latest: "5.12.7" },
  ]);
  assert.equal(result.healthy, false);
});

test("covers packages that single-package and grouped pull requests actually update", () => {
  const result = assessDependabotHealth({
    outdated: {
      fastify: outdated("5.12.5", "5.12.7"),
      "happy-dom": outdated("20.14.5", "21.0.4"),
      react: outdated("19.3.0", "19.3.1"),
      "react-dom": outdated("19.3.0", "19.3.1"),
      vite: outdated("8.3.4", "8.3.5"),
      ws: outdated("8.21.3", "8.22.0"),
      "@types/ws": outdated("8.18.1", "8.18.2"),
    },
    pulls: [
      pull({
        title: "chore(deps)(deps-dev): bump happy-dom from 20.14.5 to 21.0.4",
        body: "Bumps [happy-dom](https://example.test/happy-dom) from 20.14.5 to 21.0.4.\n"
          + "<details>Release notes.</details>",
      }),
      pull({
        number: 11,
        title: "chore(deps)(deps): bump the react group with 2 updates",
        body: "Bumps the react group with 2 updates: [react](https://example.test/react) and "
          + "[react-dom](https://example.test/react-dom).\n\nUpdates `react` from 19.3.0 to 19.3.1\n"
          + "<details>Release notes.</details>\n\nUpdates `react-dom` from 19.3.0 to 19.3.1\n"
          + "<details>Release notes.</details>",
      }),
      pull({
        number: 12,
        title: "chore(deps)(deps-dev): bump vite from 8.3.4 to 8.3.5 in the vite group",
        body: "Bumps the vite group with 1 update: [vite](https://example.test/vite).\n\n"
          + "Updates `vite` from 8.3.4 to 8.3.5\n<details>Release notes.</details>",
      }),
      pull({
        number: 13,
        title: "chore(deps)(deps): bump the fastify group with 2 updates",
        body: "Bumps the fastify group with 2 updates: [fastify](https://example.test/fastify) and "
          + "[@fastify/static](https://example.test/static).\n<details>Release notes.</details>",
      }),
      pull({
        number: 14,
        title: "chore(deps)(deps): bump ws and @types/ws",
        body: "Bumps [ws](https://example.test/ws) and [@types/ws](https://example.test/types-ws). "
          + "These dependencies needed to be updated together.\nUpdates `ws` from 8.21.3 to 8.22.0\n"
          + "<details>Release notes.</details>",
      }),
    ],
    issues: [],
    config: "",
    now: NOW,
  });

  assert.deepEqual(result.uncovered, []);
  assert.equal(result.healthy, true);
});

test("flags pull requests only after they have been open for more than seven days", () => {
  const result = assessDependabotHealth({
    outdated: {},
    pulls: [
      pull({ number: 7, createdAt: "2026-09-02T12:00:00Z" }),
      pull({
        number: 8,
        createdAt: "2026-09-02T11:59:59Z",
        statusCheckRollup: [
          { name: "Desktop Native", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      }),
    ],
    issues: [],
    config: "",
    now: NOW,
  });

  assert.deepEqual(result.stalePulls.map(({ number, ageDays, checks }) => ({ number, ageDays, checks })), [
    { number: 8, ageDays: 7, checks: "failing: Desktop Native" },
  ]);
});

test("renders actionable uncovered and stale tables", () => {
  const report = renderReport({
    healthy: false,
    uncovered: [{ dependency: "ws", current: "8.21.0", latest: "8.21.3" }],
    stalePulls: [{
      number: 358,
      title: "bump the rustcrypto group",
      url: "https://example.test/pulls/358",
      ageDays: 14,
      checks: "failing: Desktop Native",
    }],
    totals: { outdated: 1, pulls: 1, deferrals: 0 },
  });

  assert.match(report, /`ws` \| 8\.21\.0 \| 8\.21\.3/u);
  assert.match(report, /\[#358\]\(https:\/\/example\.test\/pulls\/358\)/u);
  assert.match(report, /Dependabot-Deferral/u);
});

test("collects valid outdated JSON from pnpm's success and updates-found statuses", () => {
  for (const status of [0, 1]) {
    const result = collectOutdated((command, args, options) => {
      assert.equal(command, "pnpm");
      assert.deepEqual(args, ["outdated", "-r", "--format", "json"]);
      assert.equal(options.encoding, "utf8");
      return { status, stdout: '{"fastify":{"current":"5.12.1","latest":"5.12.3"}}', stderr: "" };
    });
    assert.equal(result.fastify.latest, "5.12.3");
  }
});

test("rejects true command failures and malformed updates-found output", () => {
  assert.throws(
    () => collectOutdated(() => ({ status: 2, stdout: "", stderr: "registry failed" })),
    /exit status 2: registry failed/u,
  );
  assert.throws(
    () => collectOutdated(() => ({ status: 1, stdout: "not json", stderr: "" })),
    /Unexpected token|JSON/u,
  );
  assert.throws(
    () => collectOutdated(() => ({ status: 1, stdout: "[]", stderr: "" })),
    /JSON object/u,
  );
});

test("workflow runs after Dependabot with least-privilege read access", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/dependency-queue-health.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /cron: "0 14 \* \* 2"/u);
  assert.match(workflow, /permissions:\n  contents: read\n  issues: read\n  pull-requests: read/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /--collect-outdated "\$RUNNER_TEMP\/outdated\.json"/u);
  assert.match(workflow, /--author app\/dependabot/u);
  assert.match(workflow, /--summary "\$GITHUB_STEP_SUMMARY"/u);
});

test("Dependabot limits and TypeScript deferral are deliberate and machine-readable", () => {
  const config = readFileSync(
    new URL("../.github/dependabot.yml", import.meta.url),
    "utf8",
  );

  assert.match(config, /five open pull requests plus nine uncovered packages/u);
  assert.equal(config.match(/open-pull-requests-limit: 15/gu)?.length, 1);
  assert.equal(config.match(/open-pull-requests-limit: 10/gu)?.length, 1);
  assert.equal(config.match(/day: "monday"/gu)?.length, 2);
  assert.equal(config.match(/time: "06:00"/gu)?.length, 2);
  assert.equal(config.match(/timezone: "America\/Chicago"/gu)?.length, 2);
  assert.ok(parseIgnoredDependencies(config).includes("typescript"));
});
