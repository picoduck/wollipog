import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assessAdvisories,
  collectDirectRuntimeDependencies,
  collectPnpmAudit,
  collectRepositoryAdvisories,
  failureReport,
  mergeFindings,
  normalizeGitHubRepository,
  parseDeferrals,
  parseDirectRuntimeDependencies,
  parsePnpmAudit,
  renderReport,
} from "./check-npm-advisories.mjs";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function finding(overrides = {}) {
  return {
    package: "fastify",
    version: "5.12.1",
    advisory: "GHSA-9q9j-q6p8-xq58",
    url: "https://github.com/fastify/fastify/security/advisories/GHSA-9q9j-q6p8-xq58",
    severity: "high",
    affectedRange: "< 5.12.2",
    patchedRange: "5.12.2",
    sources: ["repository advisory"],
    ...overrides,
  };
}

test("parses and deduplicates direct runtime package versions while skipping workspaces", () => {
  const dependencies = parseDirectRuntimeDependencies([
    {
      dependencies: {
        fastify: { version: "5.12.3" },
        "@wollipog/protocol": { version: "link:../../packages/protocol" },
      },
    },
    {
      dependencies: {
        fastify: { version: "5.12.3" },
        ws: { version: "8.21.0" },
      },
    },
  ]);

  assert.deepEqual(dependencies, [
    { name: "fastify", version: "5.12.3" },
    { name: "ws", version: "8.21.0" },
  ]);
  assert.throws(
    () => parseDirectRuntimeDependencies([{ dependencies: { alias: { version: "catalog:current" } } }]),
    /Unsupported resolved version/u,
  );
  assert.throws(
    () => parseDirectRuntimeDependencies([]),
    /refusing an empty coverage result/u,
  );
});

test("collects direct runtime dependencies only from successful pnpm JSON", () => {
  const dependencies = collectDirectRuntimeDependencies((command, args, options) => {
    assert.equal(command, "pnpm");
    assert.deepEqual(args, ["list", "-r", "--prod", "--depth", "0", "--json"]);
    assert.equal(options.encoding, "utf8");
    return {
      status: 0,
      stdout: JSON.stringify([{ dependencies: { fastify: { version: "5.12.3" } } }]),
      stderr: "",
    };
  });
  assert.deepEqual(dependencies, [{ name: "fastify", version: "5.12.3" }]);

  assert.throws(
    () => collectDirectRuntimeDependencies(() => ({ status: 1, stdout: "[]", stderr: "store failed" })),
    /pnpm list failed.*store failed/u,
  );
});

test("accepts audit findings status and rejects command or schema failures", () => {
  for (const status of [0, 1]) {
    const audit = collectPnpmAudit((command, args, options) => {
      assert.equal(command, "pnpm");
      assert.deepEqual(args, ["audit", "--prod", "--json"]);
      assert.equal(options.encoding, "utf8");
      return { status, stdout: '{"advisories":{}}', stderr: "" };
    });
    assert.deepEqual(audit.advisories, {});
  }

  assert.throws(
    () => collectPnpmAudit(() => ({ status: 2, stdout: "", stderr: "registry unavailable" })),
    /pnpm audit failed.*registry unavailable/u,
  );
  assert.throws(
    () => collectPnpmAudit(() => ({ status: 1, stdout: "not json", stderr: "" })),
    /did not return valid JSON/u,
  );
  assert.throws(
    () => collectPnpmAudit(() => ({ status: 0, stdout: "[]", stderr: "" })),
    /advisories object/u,
  );
});

test("normalizes pnpm audit advisories with their installed versions", () => {
  const result = parsePnpmAudit({
    advisories: {
      1001: {
        id: 1001,
        module_name: "example",
        severity: "moderate",
        github_advisory_id: "GHSA-2345-6789-cfgh",
        url: "https://github.com/advisories/GHSA-2345-6789-cfgh",
        vulnerable_versions: "< 2.0.0",
        patched_versions: ">= 2.0.0",
        findings: [{ version: "1.5.0" }, { version: "1.5.0" }],
      },
    },
  });

  assert.deepEqual(result, [{
    package: "example",
    version: "1.5.0",
    advisory: "GHSA-2345-6789-cfgh",
    url: "https://github.com/advisories/GHSA-2345-6789-cfgh",
    severity: "moderate",
    affectedRange: "< 2.0.0",
    patchedRange: ">= 2.0.0",
    sources: ["pnpm audit"],
  }]);
  assert.throws(
    () => parsePnpmAudit({ advisories: { 1: { module_name: "example", findings: [] } } }),
    /did not identify an installed version/u,
  );
});

test("normalizes common GitHub repository metadata formats", () => {
  for (const value of [
    "https://github.com/fastify/fastify.git",
    "git+https://github.com/fastify/fastify.git",
    "git://github.com/fastify/fastify.git",
    "git@github.com:fastify/fastify.git",
    "github:fastify/fastify",
    { type: "git", url: "https://www.github.com/fastify/fastify" },
  ]) {
    assert.equal(normalizeGitHubRepository(value), "fastify/fastify");
  }
  assert.equal(normalizeGitHubRepository("https://example.test/fastify/fastify"), null);
  assert.equal(normalizeGitHubRepository(undefined), null);
});

test("detects a repository-scoped advisory absent from pnpm audit", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith("https://registry.npmjs.org/")) {
      return jsonResponse({ repository: { url: "git+https://github.com/fastify/fastify.git" } });
    }
    if (url.startsWith("https://api.github.com/repos/fastify/fastify/security-advisories")) {
      return jsonResponse([{
        ghsa_id: "GHSA-9q9j-q6p8-xq58",
        html_url: "https://github.com/fastify/fastify/security/advisories/GHSA-9q9j-q6p8-xq58",
        severity: "high",
        published_at: "2026-09-04T08:19:48Z",
        withdrawn_at: null,
        vulnerabilities: [{
          package: { ecosystem: "npm", name: "fastify" },
          vulnerable_version_range: ">= 4.0.0, < 5.12.2",
          patched_versions: "5.12.2",
        }],
      }, {
        ghsa_id: "GHSA-667r-xxjv-c9mm",
        severity: "high",
        published_at: "2026-09-04T08:20:48Z",
        withdrawn_at: "2026-09-05T00:00:00Z",
        vulnerabilities: [{
          package: { ecosystem: "npm", name: "fastify" },
          vulnerable_version_range: "< 5.12.2",
          patched_versions: "5.12.2",
        }],
      }]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await collectRepositoryAdvisories([
    { name: "fastify", version: "5.12.1" },
    { name: "fastify", version: "5.12.3" },
  ], { fetchImpl, token: "test-token" });

  assert.equal(result.repositories, 1);
  assert.deepEqual(result.findings, [finding({ affectedRange: ">= 4.0.0, < 5.12.2" })]);
  const githubCall = calls.find(({ url }) => url.startsWith("https://api.github.com/"));
  assert.equal(githubCall.options.headers.authorization, "Bearer test-token");
  assert.equal(calls.filter(({ url }) => url.startsWith("https://api.github.com/")).length, 1);
});

test("fails closed when dependency metadata or an advisory source cannot be read", async () => {
  await assert.rejects(
    collectRepositoryAdvisories(
      [{ name: "private-source", version: "1.0.0" }],
      { fetchImpl: async () => jsonResponse({ repository: "https://example.test/repo" }) },
    ),
    /does not identify a GitHub repository/u,
  );

  await assert.rejects(
    collectRepositoryAdvisories(
      [{ name: "fastify", version: "5.12.1" }],
      {
        fetchImpl: async (url) => url.startsWith("https://registry.npmjs.org/")
          ? jsonResponse({ repository: "github:fastify/fastify" })
          : jsonResponse({}, 403),
      },
    ),
    /GitHub advisories for fastify\/fastify request failed with HTTP 403/u,
  );

  await assert.rejects(
    collectRepositoryAdvisories(
      [{ name: "fastify", version: "5.12.1" }],
      {
        fetchImpl: async (url) => url.startsWith("https://registry.npmjs.org/")
          ? jsonResponse({ repository: "github:fastify/fastify" })
          : jsonResponse([{ published_at: "2026-09-04T00:00:00Z" }]),
      },
    ),
    /returned a malformed advisory/u,
  );
});

test("merges duplicate findings and preserves every originating source", () => {
  const result = mergeFindings(
    [finding({ sources: ["pnpm audit"], affectedRange: "unknown", patchedRange: "unknown" })],
    [finding()],
  );
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].sources, ["pnpm audit", "repository advisory"]);
  assert.equal(result[0].affectedRange, "< 5.12.2");
  assert.equal(result[0].patchedRange, "5.12.2");
});

test("applies only matching, unexpired, explicit deferrals", () => {
  const deferrals = parseDeferrals({
    version: 1,
    deferrals: [{
      advisory: "GHSA-9q9j-q6p8-xq58",
      package: "fastify",
      expires: "2026-09-30",
      reason: "Reachability review is in progress.",
    }],
  });
  const deferred = assessAdvisories({
    findings: [finding()],
    deferrals,
    now: new Date("2026-09-10T12:00:00Z"),
  });
  assert.equal(deferred.healthy, true);
  assert.equal(deferred.deferred.length, 1);

  const expiresToday = assessAdvisories({
    findings: [finding()],
    deferrals,
    now: new Date("2026-09-30T23:59:59Z"),
  });
  assert.equal(expiresToday.healthy, true);
  assert.equal(expiresToday.deferred.length, 1);

  const expired = assessAdvisories({
    findings: [finding()],
    deferrals,
    now: new Date("2026-10-01T00:00:00Z"),
  });
  assert.equal(expired.healthy, false);
  assert.deepEqual(expired.active, [finding()]);

  assert.throws(
    () => parseDeferrals({ version: 1, deferrals: [{ advisory: "GHSA-x" }] }),
    /must have a non-empty package/u,
  );
  assert.throws(
    () => parseDeferrals({ version: 1, deferrals: [{
      advisory: "GHSA-x", package: "x", expires: "tomorrow", reason: "wait",
    }] }),
    /invalid expires date/u,
  );
  assert.throws(
    () => parseDeferrals({ version: 1, deferrals: [{
      advisory: "GHSA-x", package: "x", expires: "2026-02-31", reason: "wait",
    }] }),
    /invalid expires date/u,
  );
});

test("renders packages, versions, advisories, ranges, sources, and deferrals", () => {
  const activeReport = renderReport(
    { healthy: false, active: [finding()], deferred: [] },
    { dependencies: 17, repositories: 12 },
  );
  assert.match(activeReport, /17 direct runtime package version/u);
  assert.match(activeReport, /`fastify` \| 5\.12\.1 \| GHSA-9q9j-q6p8-xq58/u);
  assert.match(activeReport, /< 5\.12\.2 \| 5\.12\.2 \| repository advisory/u);
  assert.match(activeReport, /npm-advisory-deferrals\.json/u);

  const deferredFinding = {
    ...finding(),
    deferral: { expires: "2026-09-30", reason: "Reviewing reachability." },
  };
  const deferredReport = renderReport(
    { healthy: true, active: [], deferred: [deferredFinding] },
    { dependencies: 1, repositories: 1 },
  );
  assert.match(deferredReport, /Explicit Deferrals/u);
  assert.match(deferredReport, /2026-09-30 \| Reviewing reachability\./u);
});

test("failure summaries stay single-line, bounded, and HTML-safe", () => {
  const report = failureReport(new Error(`registry failed\n<details>${"x".repeat(10_000)}`));
  assert.equal(report.split("\n").length, 4);
  assert.doesNotMatch(report, /<details>/u);
  assert.match(report, /&lt;details&gt;/u);
  assert.ok(report.length < 4_100);
  assert.match(report, /\.\.\.\n$/u);
});

test("workflow is daily, frozen, least-privilege, and reports to the job summary", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/npm-advisory-health.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /cron: "0 15 \* \* \*"/u);
  assert.match(workflow, /permissions:\n  contents: read\n/u);
  assert.doesNotMatch(workflow, /security-events: write|contents: write/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(workflow, /--deferrals \.github\/npm-advisory-deferrals\.json/u);
  assert.match(workflow, /--summary "\$GITHUB_STEP_SUMMARY"/u);
  assert.match(workflow, /timeout-minutes: 10/u);
  assert.equal(workflow.match(/uses: [^\s]+@[0-9a-f]{40}/gu)?.length, 3);
});
