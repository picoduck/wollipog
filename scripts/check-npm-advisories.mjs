#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import semver from "semver";

const MAX_BUFFER = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 3 * 60 * 1_000;
const GITHUB_API_VERSION = "2022-11-28";

function parseJsonOutput(result, command) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${command} did not return valid JSON: ${error.message}`);
  }
}

export function collectPnpmAudit(run = spawnSync) {
  const result = run("pnpm", ["audit", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  // pnpm uses status 1 when applicable advisories were found.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`pnpm audit failed with exit status ${result.status}: ${result.stderr}`);
  }
  const audit = parseJsonOutput(result, "pnpm audit");
  if (audit === null || Array.isArray(audit) || typeof audit !== "object"
    || audit.advisories === null || Array.isArray(audit.advisories)
    || typeof audit.advisories !== "object") {
    throw new Error("pnpm audit did not return an advisories object");
  }
  return audit;
}

export function parsePnpmAudit(audit) {
  const findings = [];
  for (const [key, advisory] of Object.entries(audit.advisories)) {
    if (typeof advisory.module_name !== "string" || advisory.module_name === "") {
      throw new Error(`pnpm audit advisory ${key} did not identify a package`);
    }
    const versions = [...new Set((advisory.findings ?? []).map((finding) => finding.version)
      .filter((version) => typeof version === "string" && version !== ""))];
    if (versions.length === 0) {
      throw new Error(`pnpm audit advisory ${key} did not identify an installed version`);
    }
    const ghsa = typeof advisory.github_advisory_id === "string"
      ? advisory.github_advisory_id
      : advisory.url?.match(/GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}/iu)?.[0];
    const advisoryId = ghsa ?? String(advisory.id ?? key);
    for (const version of versions) {
      findings.push({
        package: advisory.module_name,
        version,
        advisory: advisoryId,
        url: advisory.url ?? "",
        severity: advisory.severity ?? "unknown",
        affectedRange: advisory.vulnerable_versions ?? "unknown",
        patchedRange: advisory.patched_versions ?? "unknown",
        sources: ["pnpm audit"],
      });
    }
  }
  return findings;
}

export function parseDirectRuntimeDependencies(workspaces) {
  if (!Array.isArray(workspaces)) {
    throw new Error("pnpm list did not return a workspace array");
  }
  const dependencies = new Map();
  for (const workspace of workspaces) {
    for (const [name, dependency] of Object.entries(workspace.dependencies ?? {})) {
      const version = dependency?.version;
      if (typeof version !== "string") {
        throw new Error(`pnpm list did not identify a version for ${name}`);
      }
      if (version.startsWith("link:") || version.startsWith("workspace:")) continue;
      if (!semver.valid(version, { loose: true })) {
        throw new Error(`Unsupported resolved version ${JSON.stringify(version)} for ${name}`);
      }
      dependencies.set(`${name}@${version}`, { name, version });
    }
  }
  return [...dependencies.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || semver.compare(left.version, right.version));
}

export function collectDirectRuntimeDependencies(run = spawnSync) {
  const result = run("pnpm", ["list", "-r", "--prod", "--depth", "0", "--json"], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm list failed with exit status ${result.status}: ${result.stderr}`);
  }
  return parseDirectRuntimeDependencies(parseJsonOutput(result, "pnpm list"));
}

export function normalizeGitHubRepository(repository) {
  let value = typeof repository === "string" ? repository : repository?.url;
  if (typeof value !== "string" || value.trim() === "") return null;
  value = value.trim();
  if (value.startsWith("github:")) value = `https://github.com/${value.slice("github:".length)}`;
  if (/^git@github\.com:/iu.test(value)) {
    value = `https://github.com/${value.replace(/^git@github\.com:/iu, "")}`;
  }
  value = value.replace(/^git\+/iu, "").replace(/^git:\/\/github\.com\//iu, "https://github.com/");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["github.com", "www.github.com"].includes(parsed.hostname.toLowerCase())) return null;
  const [owner, rawRepository] = parsed.pathname.split("/").filter(Boolean);
  const name = rawRepository?.replace(/\.git$/iu, "");
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

async function fetchJson(url, { fetchImpl, headers, source }) {
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new Error(`${source} request failed: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`${source} request failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${source} returned malformed JSON: ${error.message}`);
  }
}

async function repositoryForDependency(dependency, fetchImpl) {
  const path = `${encodeURIComponent(dependency.name)}/${encodeURIComponent(dependency.version)}`;
  const metadata = await fetchJson(`https://registry.npmjs.org/${path}`, {
    fetchImpl,
    headers: { accept: "application/json", "user-agent": "wollipog-npm-advisory-health" },
    source: `npm metadata for ${dependency.name}@${dependency.version}`,
  });
  const repository = normalizeGitHubRepository(metadata.repository);
  if (!repository) {
    throw new Error(
      `npm metadata for ${dependency.name}@${dependency.version} does not identify a GitHub repository`,
    );
  }
  return repository;
}

async function advisoriesForRepository(repository, { fetchImpl, token }) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "wollipog-npm-advisory-health",
    "x-github-api-version": GITHUB_API_VERSION,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const advisories = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageItems = await fetchJson(
      `https://api.github.com/repos/${repository}/security-advisories?per_page=100&page=${page}`,
      { fetchImpl, headers, source: `GitHub advisories for ${repository}` },
    );
    if (!Array.isArray(pageItems)) {
      throw new Error(`GitHub advisories for ${repository} did not return an array`);
    }
    advisories.push(...pageItems);
    if (pageItems.length < 100) return advisories;
  }
  throw new Error(`GitHub advisories for ${repository} exceeded the pagination safety limit`);
}

function normalizeAdvisoryRange(range) {
  return range.replaceAll(",", " ").replace(/\s+/gu, " ").trim();
}

export async function collectRepositoryAdvisories(
  dependencies,
  { fetchImpl = fetch, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN } = {},
) {
  const byRepository = new Map();
  for (const dependency of dependencies) {
    const repository = await repositoryForDependency(dependency, fetchImpl);
    const entries = byRepository.get(repository) ?? [];
    entries.push(dependency);
    byRepository.set(repository, entries);
  }

  const findings = [];
  for (const [repository, repositoryDependencies] of byRepository) {
    const advisories = await advisoriesForRepository(repository, { fetchImpl, token });
    for (const advisory of advisories) {
      if (advisory === null || typeof advisory !== "object"
        || typeof advisory.ghsa_id !== "string"
        || !Array.isArray(advisory.vulnerabilities)) {
        throw new Error(`GitHub advisories for ${repository} returned a malformed advisory`);
      }
      if (!advisory.published_at || advisory.withdrawn_at) continue;
      for (const vulnerability of advisory.vulnerabilities ?? []) {
        if (vulnerability.package?.ecosystem?.toLowerCase() !== "npm") continue;
        for (const dependency of repositoryDependencies) {
          if (vulnerability.package.name !== dependency.name) continue;
          const affectedRange = vulnerability.vulnerable_version_range;
          if (typeof affectedRange !== "string" || affectedRange.trim() === "") {
            throw new Error(
              `GitHub advisory ${advisory.ghsa_id ?? "unknown"} has no npm version range for ${dependency.name}`,
            );
          }
          const normalizedRange = normalizeAdvisoryRange(affectedRange);
          if (semver.validRange(normalizedRange, { loose: true }) === null) {
            throw new Error(
              `GitHub advisory ${advisory.ghsa_id ?? "unknown"} has an invalid npm version range`,
            );
          }
          const affected = semver.satisfies(
            dependency.version,
            normalizedRange,
            { includePrerelease: true, loose: true },
          );
          if (!affected) continue;
          findings.push({
            package: dependency.name,
            version: dependency.version,
            advisory: advisory.ghsa_id,
            url: advisory.html_url
              ?? `https://github.com/${repository}/security/advisories/${advisory.ghsa_id}`,
            severity: advisory.severity ?? "unknown",
            affectedRange,
            patchedRange: vulnerability.patched_versions ?? "none published",
            sources: ["repository advisory"],
          });
        }
      }
    }
  }
  return { findings, repositories: byRepository.size };
}

export function mergeFindings(...findingGroups) {
  const merged = new Map();
  for (const finding of findingGroups.flat()) {
    const key = `${finding.package}\0${finding.version}\0${finding.advisory}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...finding, sources: [...finding.sources] });
      continue;
    }
    existing.sources = [...new Set([...existing.sources, ...finding.sources])].sort();
    if (existing.affectedRange === "unknown") existing.affectedRange = finding.affectedRange;
    if (existing.patchedRange === "unknown") existing.patchedRange = finding.patchedRange;
    if (!existing.url) existing.url = finding.url;
  }
  return [...merged.values()].sort((left, right) =>
    left.package.localeCompare(right.package)
      || semver.compare(left.version, right.version)
      || left.advisory.localeCompare(right.advisory));
}

export function parseDeferrals(config) {
  if (config === null || Array.isArray(config) || typeof config !== "object"
    || config.version !== 1 || !Array.isArray(config.deferrals)) {
    throw new Error("npm advisory deferrals must use { version: 1, deferrals: [] }");
  }
  return config.deferrals.map((deferral, index) => {
    const label = `deferrals[${index}]`;
    for (const field of ["advisory", "package", "expires", "reason"]) {
      if (typeof deferral?.[field] !== "string" || deferral[field].trim() === "") {
        throw new Error(`${label} must have a non-empty ${field}`);
      }
    }
    const parsedExpiry = new Date(`${deferral.expires}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(deferral.expires)
      || Number.isNaN(parsedExpiry.getTime())
      || parsedExpiry.toISOString().slice(0, 10) !== deferral.expires) {
      throw new Error(`${label} has an invalid expires date`);
    }
    return { ...deferral };
  });
}

export function assessAdvisories({ findings, deferrals, now = new Date() }) {
  const today = now.toISOString().slice(0, 10);
  const active = [];
  const deferred = [];
  for (const finding of findings) {
    const deferral = deferrals.find((candidate) =>
      candidate.advisory === finding.advisory
        && candidate.package === finding.package
        && candidate.expires >= today);
    if (deferral) deferred.push({ ...finding, deferral });
    else active.push(finding);
  }
  return { healthy: active.length === 0, active, deferred };
}

function tableCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
}

export function renderReport(result, { dependencies, repositories }) {
  const lines = [
    `# ${result.healthy ? "✅" : "❌"} npm Advisory Health`,
    "",
    `${dependencies} direct runtime package version(s) across ${repositories} GitHub source repository/repositories were inspected.`,
  ];
  if (result.active.length > 0) {
    lines.push(
      "",
      "## Applicable Advisories",
      "",
      "| Package | Resolved | Advisory | Severity | Affected | Patched | Sources |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...result.active.map((finding) =>
        `| \`${tableCell(finding.package)}\` | ${tableCell(finding.version)} | ${tableCell(finding.advisory)} | ${tableCell(finding.severity)} | ${tableCell(finding.affectedRange)} | ${tableCell(finding.patchedRange)} | ${tableCell(finding.sources.join(", "))} |`),
    );
  }
  if (result.deferred.length > 0) {
    lines.push(
      "",
      "## Explicit Deferrals",
      "",
      "| Package | Advisory | Expires | Reason |",
      "| --- | --- | --- | --- |",
      ...result.deferred.map((finding) =>
        `| \`${tableCell(finding.package)}\` | ${tableCell(finding.advisory)} | ${tableCell(finding.deferral.expires)} | ${tableCell(finding.deferral.reason)} |`),
    );
  }
  if (result.healthy) {
    lines.push("", "No applicable, undeferred npm advisories were found.");
  } else {
    lines.push(
      "",
      "Upgrade each affected package or record a temporary, expiring deferral in `.github/npm-advisory-deferrals.json`.",
    );
  }
  return `${lines.join("\n")}\n`;
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
  if (!values.has("deferrals")) throw new Error("Missing required --deferrals argument");
  return values;
}

async function main(argv) {
  const args = parseArguments(argv);
  const audit = collectPnpmAudit();
  const dependencies = collectDirectRuntimeDependencies();
  const supplemental = await collectRepositoryAdvisories(dependencies);
  const findings = mergeFindings(parsePnpmAudit(audit), supplemental.findings);
  const deferrals = parseDeferrals(JSON.parse(readFileSync(args.get("deferrals"), "utf8")));
  const result = assessAdvisories({ findings, deferrals });
  const report = renderReport(result, {
    dependencies: dependencies.length,
    repositories: supplemental.repositories,
  });
  process.stdout.write(report);
  if (args.has("summary")) appendFileSync(args.get("summary"), report);
  process.exitCode = result.healthy ? 0 : 1;
}

function failureReport(error) {
  return `# ❌ npm Advisory Health\n\nThe advisory scan did not complete: ${error.message}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    const report = failureReport(error);
    process.stderr.write(report);
    const summaryIndex = process.argv.indexOf("--summary");
    const summary = summaryIndex === -1 ? undefined : process.argv[summaryIndex + 1];
    if (summary) appendFileSync(summary, report);
    process.exitCode = 2;
  });
}
