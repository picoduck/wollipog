import { createHash } from "node:crypto";
import { relative } from "node:path";

export const TIMING_MARKER = "ci-timing-v1 ";
export const identity = (value) => createHash("sha256").update(value).digest("hex");
const TOP = 20;
const RELIABILITY_LIMIT = 40;
const MAX_FILES = 5_000;

/** Bounded, allowlisted projection. No test titles, stdout, errors, attachments or inputs. */
export class TimingSummary {
  constructor(suite) {
    this.suite = suite;
    this.files = new Map();
    this.tests = [];
    this.reliabilityTests = [];
    this.reliabilityTruncated = false;
    this.count = 0;
    this.failed = 0;
    this.skipped = 0;
    this.cancelled = 0;
    this.unmeasured = 0;
    this.retryOnly = 0;
    this.truncated = false;
  }

  add({ file, name, durationMs, state, retry = 0, accumulateFile = true, includeTest = true }) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const fileId = identity(relative(process.cwd(), file).replaceAll("\\", "/"));
    const testId = identity(`${fileId}:${name}`);
    if (includeTest) {
      this.count++;
      this.failed += state === "failing" ? 1 : 0;
      this.skipped += state === "skipped" ? 1 : 0;
      this.cancelled += state === "cancelled" ? 1 : 0;
      this.unmeasured += state === "unmeasured" ? 1 : 0;
      this.retryOnly += retry > 0 && state === "passing" ? 1 : 0;
    }
    if (accumulateFile && !this.files.has(fileId) && this.files.size >= MAX_FILES) this.truncated = true;
    else if (accumulateFile) {
      const row = this.files.get(fileId) ?? { fileId, durationMs: 0, count: 0 };
      row.durationMs += durationMs;
      row.count++;
      this.files.set(fileId, row);
    }
    if (includeTest) {
      const row = { fileId, testId, durationMs, state, retry };
      this.tests.push(row);
      if (retry > 0 || ["failing", "cancelled", "unmeasured"].includes(state)) {
        if (this.reliabilityTests.length < RELIABILITY_LIMIT) this.reliabilityTests.push(row);
        else this.reliabilityTruncated = true;
      }
    }
    this.tests.sort((a, b) => b.durationMs - a.durationMs);
    this.tests.length = Math.min(TOP, this.tests.length);
  }

  result() {
    const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? "") ? value : null;
    return { version: 1, suite: this.suite, count: this.count, failed: this.failed, skipped: this.skipped,
      cancelled: this.cancelled, unmeasured: this.unmeasured,
      retryOnly: this.retryOnly, truncated: this.truncated,
      context: { runId: /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : null,
        attempt: /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "") ? Number(process.env.GITHUB_RUN_ATTEMPT) : null,
        testedSha: sha(process.env.GITHUB_SHA), workflowSha: sha(process.env.GITHUB_WORKFLOW_SHA) },
      slowestFiles: [...this.files.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, TOP),
      slowestTests: this.tests,
      reliability: { tests: this.reliabilityTests, truncated: this.reliabilityTruncated } };
  }
}

/** Validate and re-project even our own log output: log lines are untrusted. */
export function parseTiming(line) {
  const position = line.indexOf(TIMING_MARKER);
  if (position < 0 || line.length > 32_000) return null;
  let value;
  try { value = JSON.parse(line.slice(position + TIMING_MARKER.length)); } catch { return null; }
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  const ms = (n) => Number.isFinite(n) && n >= 0;
  const hash = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  if (!value || typeof value !== "object" || value.version !== 1 || !["node", "browser"].includes(value.suite) ||
      ![value.count, value.failed, value.skipped, value.cancelled, value.unmeasured, value.retryOnly].every(count) || typeof value.truncated !== "boolean" ||
      !Array.isArray(value.slowestFiles) || value.slowestFiles.length > TOP ||
      !Array.isArray(value.slowestTests) || value.slowestTests.length > TOP ||
      !value.slowestFiles.every((row) => row && hash(row.fileId) && ms(row.durationMs) && count(row.count)) ||
      !value.slowestTests.every((row) => row && hash(row.fileId) && hash(row.testId) && ms(row.durationMs) && count(row.retry) &&
        ["passing", "failing", "cancelled", "skipped", "unmeasured"].includes(row.state))) return null;
  const validTest = (row) => row && hash(row.fileId) && hash(row.testId) && ms(row.durationMs) && count(row.retry) &&
    ["passing", "failing", "cancelled", "skipped", "unmeasured"].includes(row.state);
  if (value.reliability !== undefined && (!value.reliability || typeof value.reliability.truncated !== "boolean" ||
      !Array.isArray(value.reliability.tests) || value.reliability.tests.length > RELIABILITY_LIMIT ||
      !value.reliability.tests.every(validTest))) return null;
  const projectTest = ({ fileId, testId, durationMs, state, retry }) => ({ fileId, testId, durationMs, state, retry });
  const sha = (s) => typeof s === "string" && /^[a-f0-9]{40}$/.test(s) ? s : null;
  return { version: 1, suite: value.suite, count: value.count, failed: value.failed, skipped: value.skipped,
    cancelled: value.cancelled, unmeasured: value.unmeasured,
    retryOnly: value.retryOnly, truncated: value.truncated,
    context: { runId: typeof value.context?.runId === "string" && /^[1-9][0-9]*$/.test(value.context.runId) ? value.context.runId : null,
      attempt: count(value.context?.attempt) && value.context.attempt > 0 ? value.context.attempt : null,
      testedSha: sha(value.context?.testedSha), workflowSha: sha(value.context?.workflowSha) },
    slowestFiles: value.slowestFiles.map(({ fileId, durationMs, count }) => ({ fileId, durationMs, count })),
    slowestTests: value.slowestTests.map(projectTest),
    ...(value.reliability === undefined ? {} : { reliability: {
      tests: value.reliability.tests.map(projectTest), truncated: value.reliability.truncated } }) };
}
