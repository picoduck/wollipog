#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1_000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function dependencyPattern(value) {
  const escaped = escapeRegExp(value).replaceAll("\\*", ".*").replaceAll("\\?", ".");
  return new RegExp(`^${escaped}$`, "u");
}

export function parseIgnoredDependencies(config) {
  const patterns = [];
  let ignoreIndent = null;

  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (trimmed === "ignore:") {
      ignoreIndent = indent;
      continue;
    }
    if (ignoreIndent !== null && trimmed !== "" && !trimmed.startsWith("#") && indent <= ignoreIndent) {
      ignoreIndent = null;
    }
    if (ignoreIndent === null) continue;

    const match = trimmed.match(/^- dependency-name:\s*["']?([^"'#\s]+)["']?\s*$/u);
    if (match) patterns.push(match[1]);
  }

  return patterns;
}

export function parseIssueDeferrals(issues) {
  const deferrals = new Map();
  const marker = /^\s*Dependabot-Deferral:\s*`?([^`\s]+)`?\s*$/gimu;

  for (const issue of issues) {
    for (const match of (issue.body ?? "").matchAll(marker)) {
      deferrals.set(match[1], issue);
    }
  }

  return deferrals;
}

function pullMentionsDependency(pull, dependency) {
  const token = escapeRegExp(dependency);
  const boundary = `[A-Za-z0-9@._/-]`;
  // Dependabot's authoritative package summary precedes the first release-note details block.
  // Ignoring the changelog prevents an incidental mention of another package from counting as
  // coverage for that package.
  const bodySummary = (pull.body ?? "").split("<details>", 1)[0];
  return new RegExp(`(^|[^${boundary.slice(1, -1)}])${token}(?=$|[^${boundary.slice(1, -1)}])`, "imu")
    .test(`${pull.title ?? ""}\n${bodySummary}`);
}

function checkState(pull) {
  const checks = pull.statusCheckRollup ?? [];
  const failures = checks.filter((check) =>
    ["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STALE", "TIMED_OUT"].includes(check.conclusion),
  );
  if (failures.length > 0) return `failing: ${failures.map((check) => check.name).join(", ")}`;
  if (checks.some((check) => check.status !== "COMPLETED")) return "pending";
  return checks.length === 0 ? "no checks" : "passing";
}

export function assessDependabotHealth({
  outdated,
  pulls,
  issues,
  config,
  now = new Date(),
}) {
  const ignoredPatterns = parseIgnoredDependencies(config).map((pattern) => ({
    pattern,
    matcher: dependencyPattern(pattern),
  }));
  const deferrals = parseIssueDeferrals(issues);
  const updates = Object.entries(outdated).sort(([left], [right]) => left.localeCompare(right));

  const uncovered = updates.flatMap(([dependency, version]) => {
    const pull = pulls.find((candidate) => pullMentionsDependency(candidate, dependency));
    if (pull) return [];
    const ignored = ignoredPatterns.find(({ matcher }) => matcher.test(dependency));
    if (ignored) return [];
    const issue = deferrals.get(dependency);
    if (issue) return [];
    return [{ dependency, current: version.current, latest: version.latest }];
  });

  const stalePulls = pulls.flatMap((pull) => {
    const ageMs = now.getTime() - new Date(pull.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs <= 7 * DAY_MS) return [];
    return [{ ...pull, ageDays: Math.floor(ageMs / DAY_MS), checks: checkState(pull) }];
  });

  return {
    healthy: uncovered.length === 0 && stalePulls.length === 0,
    uncovered,
    stalePulls,
    totals: { outdated: updates.length, pulls: pulls.length, deferrals: deferrals.size },
  };
}

export function renderReport(result) {
  const icon = result.healthy ? "✅" : "❌";
  const lines = [
    `# ${icon} Dependabot Queue Health`,
    "",
    `${result.totals.outdated} outdated npm package(s), ${result.totals.pulls} open Dependabot pull request(s), and ${result.totals.deferrals} explicit issue deferral(s) were inspected.`,
  ];

  if (result.uncovered.length > 0) {
    lines.push(
      "",
      "## Outdated Packages Without Coverage",
      "",
      "| Package | Current | Latest |",
      "| --- | --- | --- |",
      ...result.uncovered.map(({ dependency, current, latest }) =>
        `| \`${dependency}\` | ${current} | ${latest} |`),
    );
  }

  if (result.stalePulls.length > 0) {
    lines.push(
      "",
      "## Pull Requests Open Longer Than Seven Days",
      "",
      "| Pull Request | Age | Checks |",
      "| --- | --- | --- |",
      ...result.stalePulls.map((pull) =>
        `| [#${pull.number}](${pull.url}) ${pull.title} | ${pull.ageDays} days | ${pull.checks} |`),
    );
  }

  if (result.healthy) {
    lines.push("", "Every outdated package is covered, and no Dependabot pull request is stale.");
  } else {
    lines.push(
      "",
      "An outdated package is covered by an open Dependabot pull request, an `ignore` entry in `.github/dependabot.yml`, or an open `dependencies` issue whose body contains a line such as `Dependabot-Deferral: package-name`.",
    );
  }

  return `${lines.join("\n")}\n`;
}

export function collectOutdated(run = spawnSync) {
  const result = run("pnpm", ["outdated", "-r", "--format", "json"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 3 * 60 * 1_000,
  });
  if (result.error) throw result.error;
  // pnpm 11 uses 1 to mean "outdated packages found", even though stdout is valid JSON.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`pnpm outdated failed with exit status ${result.status}: ${result.stderr}`);
  }

  const parsed = JSON.parse(result.stdout);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("pnpm outdated did not return a JSON object");
  }
  return parsed;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments, received ${JSON.stringify(argv)}`);
    }
    values.set(flag.slice(2), value);
  }
  for (const required of ["outdated", "pulls", "issues", "config"]) {
    if (!values.has(required)) throw new Error(`Missing required --${required} argument`);
  }
  return values;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(argv) {
  if (argv[0] === "--collect-outdated" && argv.length === 2) {
    const outdated = collectOutdated();
    writeFileSync(argv[1], `${JSON.stringify(outdated, null, 2)}\n`);
    return;
  }
  const args = parseArguments(argv);
  const result = assessDependabotHealth({
    outdated: readJson(args.get("outdated")),
    pulls: readJson(args.get("pulls")),
    issues: readJson(args.get("issues")),
    config: readFileSync(args.get("config"), "utf8"),
  });
  const report = renderReport(result);
  process.stdout.write(report);
  if (args.has("summary")) appendFileSync(args.get("summary"), report);
  process.exitCode = result.healthy ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
