#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1_000;

// Dependabot's npm updater skips releases younger than its own release-age gate. The repository
// sets no `cooldown` in .github/dependabot.yml; the value is supplied by Dependabot, whose
// 2026-11-02 weekly run passed `--config.minimum-release-age=4320` (minutes) to pnpm and logged
// "Filtered out 1 versions due to cooldown" (#4155). Update this if an updater log shows another
// minimum-release-age.
export const DEPENDABOT_RELEASE_AGE_GATE_MS = 3 * DAY_MS;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

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

// The npm entry's weekly schedule, or null when it is not a weekly day/time schedule this checker
// can place in time. A null schedule leaves every uncovered release uncovered.
export function parseNpmSchedule(config) {
  const fields = {};
  let inNpm = false;

  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const ecosystem = trimmed.match(/^- package-ecosystem:\s*["']?([^"'#\s]+)["']?/u);
    if (ecosystem) {
      inNpm = ecosystem[1] === "npm";
      continue;
    }
    if (!inNpm) continue;
    const field = trimmed.match(/^(interval|day|time|timezone):\s*["']?([^"'#\s]+)["']?\s*(#.*)?$/u);
    if (field && !(field[1] in fields)) fields[field[1]] = field[2];
  }

  const day = WEEKDAYS.indexOf(fields.day);
  const time = fields.time?.match(/^(\d{2}):(\d{2})$/u);
  if (fields.interval !== "weekly" || day < 0 || !time) return null;
  const timezone = fields.timezone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return null;
  }
  return { day, hour: Number(time[1]), minute: Number(time[2]), timezone };
}

function zonedWallClock(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms)).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

// The instant at which the schedule's wall-clock time occurs on the calendar date `dateMs` (UTC
// midnight of that date) in the schedule's time zone. Two passes settle the zone offset across a
// daylight-saving change.
function scheduledInstantOn(schedule, dateMs) {
  const wall = dateMs + (schedule.hour * 60 + schedule.minute) * 60 * 1_000;
  let instant = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = wall - (zonedWallClock(instant, schedule.timezone) - instant);
  }
  return instant;
}

// The most recent scheduled update at or before `now`, as the UTC midnight of its calendar date in
// the schedule's zone and the instant it was due.
export function lastScheduledUpdate(schedule, now) {
  const local = zonedWallClock(now.getTime(), schedule.timezone);
  const today = local - (local % DAY_MS);
  let dateMs = today - (((new Date(today).getUTCDay() - schedule.day + 7) % 7) * DAY_MS);
  let instant = scheduledInstantOn(schedule, dateMs);
  if (instant > now.getTime()) {
    dateMs -= 7 * DAY_MS;
    instant = scheduledInstantOn(schedule, dateMs);
  }
  return { dateMs, instant };
}

// Splits uncovered releases into those the last scheduled update could not yet consider because of
// the release-age gate, and the rest. Scheduled time stands in for the run's actual start, which is
// a few minutes later; a release without a readable publish time stays uncovered.
function separateGatedReleases(candidates, schedule, now) {
  const last = schedule === null ? null : lastScheduledUpdate(schedule, now);
  const uncovered = [];
  const waiting = [];

  for (const [dependency, version] of candidates) {
    const row = { dependency, current: version.current, latest: version.latest };
    const published = Date.parse(version.latestPublishedAt ?? "");
    if (
      last === null
      || !Number.isFinite(published)
      || published <= last.instant - DEPENDABOT_RELEASE_AGE_GATE_MS
    ) {
      uncovered.push(row);
      continue;
    }
    let dateMs = last.dateMs;
    let instant = last.instant;
    while (instant < published + DEPENDABOT_RELEASE_AGE_GATE_MS) {
      dateMs += 7 * DAY_MS;
      instant = scheduledInstantOn(schedule, dateMs);
    }
    waiting.push({
      ...row,
      publishedAt: new Date(published).toISOString(),
      firstEligibleUpdate: new Date(instant).toISOString(),
    });
  }

  return { uncovered, waiting };
}

function pullMentionsDependency(pull, dependency) {
  const token = escapeRegExp(dependency);
  const boundary = `[A-Za-z0-9@._/-]`;
  // Dependabot's authoritative package summary precedes the first release-note details block.
  // Ignoring the changelog prevents an incidental mention of another package from counting as
  // coverage for that package.
  const bodySummary = (pull.body ?? "").split("<details>", 1)[0];
  // A group label ("bump the fastify group", "in the fastify group") names the Dependabot group,
  // not a package it updates, so it cannot cover the package that shares its name (#3612).
  // Updated packages are named elsewhere in the title or summary.
  const evidence = `${pull.title ?? ""}\n${bodySummary}`.replace(/\bthe\s+\S+\s+group\b/giu, "");
  return new RegExp(`(^|[^${boundary.slice(1, -1)}])${token}(?=$|[^${boundary.slice(1, -1)}])`, "imu")
    .test(evidence);
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

  const withoutCoverage = updates.filter(([dependency]) => {
    const pull = pulls.find((candidate) => pullMentionsDependency(candidate, dependency));
    if (pull) return false;
    const ignored = ignoredPatterns.find(({ matcher }) => matcher.test(dependency));
    if (ignored) return false;
    const issue = deferrals.get(dependency);
    if (issue) return false;
    return true;
  });
  const { uncovered, waiting } = separateGatedReleases(withoutCoverage, parseNpmSchedule(config), now);

  const stalePulls = pulls.flatMap((pull) => {
    const ageMs = now.getTime() - new Date(pull.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs <= 7 * DAY_MS) return [];
    return [{ ...pull, ageDays: Math.floor(ageMs / DAY_MS), checks: checkState(pull) }];
  });

  return {
    healthy: uncovered.length === 0 && stalePulls.length === 0,
    uncovered,
    waiting,
    stalePulls,
    totals: { outdated: updates.length, pulls: pulls.length, deferrals: deferrals.size },
  };
}

function formatInstant(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
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

  const waiting = result.waiting ?? [];
  if (waiting.length > 0) {
    lines.push(
      "",
      "## Waiting for Dependabot's Release-Age Gate",
      "",
      "The last scheduled update skipped these releases because they were too new. They do not fail this check; each becomes eligible at the update shown. A release that was a security fix still needs its own advisory review.",
      "",
      "| Package | Current | Latest | Published | First Eligible Update |",
      "| --- | --- | --- | --- | --- |",
      ...waiting.map(({ dependency, current, latest, publishedAt, firstEligibleUpdate }) =>
        `| \`${dependency}\` | ${current} | ${latest} | ${formatInstant(publishedAt)} | ${formatInstant(firstEligibleUpdate)} |`),
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
    lines.push("", waiting.length > 0
      ? "Every other outdated package is covered, and no Dependabot pull request is stale."
      : "Every outdated package is covered, and no Dependabot pull request is stale.");
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

// Adds `latestPublishedAt` (ISO string, or null when the registry lookup fails) to each outdated
// entry. A null publish time keeps an uncovered release reported as uncovered.
export function collectPublishTimes(outdated, run = spawnSync) {
  const annotated = {};
  for (const [dependency, version] of Object.entries(outdated)) {
    let latestPublishedAt = null;
    const result = run("pnpm", ["view", dependency, "time", "--json"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60 * 1_000,
    });
    if (!result.error && result.status === 0) {
      try {
        const published = JSON.parse(result.stdout)?.[version.latest];
        if (typeof published === "string" && Number.isFinite(Date.parse(published))) {
          latestPublishedAt = published;
        }
      } catch {
        // Unparseable registry output leaves the publish time unknown.
      }
    }
    if (latestPublishedAt === null) {
      process.stderr.write(`Could not read the publish time of ${dependency}@${version.latest}.\n`);
    }
    annotated[dependency] = { ...version, latestPublishedAt };
  }
  return annotated;
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
    const outdated = collectPublishTimes(collectOutdated());
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
