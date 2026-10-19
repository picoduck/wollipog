/**
 * The review contract's validity rules (#3369): whether a reviewer's attempt counts, and why not.
 *
 * Ported from the cross-model-review skill (scripts/review_core.py: `schema_errors`,
 * `validate_report`, `evaluate`), Copyright 2026 Mitch Miskoski, licensed under the Apache License,
 * Version 2.0. The rules are unchanged: a fixed output schema, the exact pinned head, findings that
 * name repository files, a vote consistent with its blocking findings, and coverage that classifies
 * every in-scope changed file exactly once. An invalid attempt is never promoted.
 *
 * Pure and dependency-free: the runner applies it against its checkout (which can also say whether
 * a path exists at the reviewed head); the control plane applies it again to what the runner sent.
 */
import { REVIEW_OUTPUT_SCHEMA } from "./review-session.js";

export type ReviewFailureClass =
  | "runner_config" | "snapshot" | "sandbox" | "transport" | "timeout"
  | "malformed_output" | "tool_policy" | "evidence_contract";

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewReportFinding {
  severity: ReviewFindingSeverity;
  blocking: boolean;
  file: string;
  line: number | null;
  title: string;
  scenario: string;
  evidence: string;
  verify: string;
}

/** The reviewer's report, version 2, once it has passed `validateReviewReport`. */
export interface ReviewReport {
  schema_version: 2;
  reviewed_head: string;
  vote: "UPVOTE" | "DOWNVOTE";
  summary: string;
  findings: ReviewReportFinding[];
  examined_changed_files: string[];
  not_examined_changed_files: Array<{ path: string; reason: string }>;
  context_files_examined: string[];
  commands_run: string[];
  verification_requests: Array<{ command: string; claim: string }>;
}

const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);
const MAX_SCHEMA_ERRORS = 8;

type Schema = {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  required?: readonly string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
};

function hasType(value: unknown, name: string): boolean {
  switch (name) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: throw new Error(`unsupported schema type ${name}`);
  }
}

/** The JSON Schema subset the review schema uses: type (one or a list), enum, required,
 * properties, `additionalProperties: false`, and items. */
export function reviewSchemaErrors(value: unknown, schema: Schema = REVIEW_OUTPUT_SCHEMA as Schema, where = "report"): string[] {
  if (schema.type !== undefined) {
    const names = typeof schema.type === "string" ? [schema.type] : [...schema.type];
    if (!names.some((name) => hasType(value, name))) return [`${where} must be ${names.join(" or ")}`];
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    return [`${where} must be one of ${JSON.stringify(schema.enum)}`];
  }
  const errors: string[] = [];
  if (hasType(value, "object")) {
    const record = value as Record<string, unknown>;
    const missing = (schema.required ?? []).filter((key) => !Object.hasOwn(record, key));
    if (missing.length) errors.push(`${where} is missing ${JSON.stringify(missing)}`);
    if (schema.additionalProperties === false) {
      // Own properties only: an inherited name such as `constructor` is not an allowed key.
      const unexpected = Object.keys(record).filter((key) => !Object.hasOwn(schema.properties ?? {}, key)).sort();
      if (unexpected.length) errors.push(`${where} has unexpected ${JSON.stringify(unexpected)}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(record, key)) errors.push(...reviewSchemaErrors(record[key], child, `${where}.${key}`));
    }
  } else if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...reviewSchemaErrors(item, schema.items, `${where}[${index}]`)));
  }
  return errors;
}

/** A repository-relative path a report may name: not empty, not absolute, no `..`, no `./`. */
export function canonicalReviewPath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.startsWith("./")) return false;
  return !path.split("/").some((part) => part === "..");
}

const blank = (value: unknown) => typeof value !== "string" || !value.trim();

export interface ReviewReportContext {
  /** The pinned head the reviewer was given. */
  headSha: string;
  /** The changed files the reviewer must classify, each exactly once. */
  scopeFiles: readonly string[];
  /** Whether a path exists at the reviewed head; omitted where the tree is not available. */
  isTracked?: (path: string) => boolean;
}

/** Every reason `report` breaks the contract; empty when it holds. */
export function validateReviewReport(report: unknown, context: ReviewReportContext): string[] {
  if (!hasType(report, "object")) return ["the final report is not a JSON object"];
  const schemaErrors = reviewSchemaErrors(report);
  if (schemaErrors.length) return schemaErrors.slice(0, MAX_SCHEMA_ERRORS);
  const value = report as unknown as ReviewReport;
  const errors: string[] = [];
  if (value.schema_version !== 2) errors.push("unsupported report schema_version");
  if (value.reviewed_head !== context.headSha) errors.push("reviewed_head does not identify the pinned head");
  const scope = new Set(context.scopeFiles);
  const inRepository = (path: string) => canonicalReviewPath(path) && (scope.has(path) || context.isTracked?.(path) !== false);
  let blocking = 0;
  value.findings.forEach((finding, index) => {
    const where = `findings[${index}]`;
    if (!SEVERITIES.has(finding.severity)) errors.push(`${where}.severity is not a severity`);
    if (finding.blocking) blocking += 1;
    if (finding.line !== null && !(Number.isInteger(finding.line) && finding.line >= 1)) errors.push(`${where}.line must be null or at least 1`);
    for (const key of ["file", "title", "scenario", "evidence", "verify"] as const) {
      if (blank(finding[key])) errors.push(`${where}.${key} is blank`);
    }
    if (!blank(finding.file) && !inRepository(finding.file)) errors.push(`${where}.file is not a repository path`);
  });
  if (value.vote === "DOWNVOTE" && blocking === 0) errors.push("a downvote requires at least one blocking finding");
  if (value.vote === "UPVOTE" && blocking > 0) errors.push("an upvote cannot carry blocking findings");
  const omitted: string[] = [];
  value.not_examined_changed_files.forEach((item, index) => {
    if (blank(item.reason)) errors.push(`not_examined_changed_files[${index}].reason is blank`);
    omitted.push(item.path);
  });
  const classified = [...value.examined_changed_files, ...omitted];
  if (new Set(classified).size !== classified.length) errors.push("changed-file coverage contains duplicates or overlap");
  const classifiedSet = new Set(classified);
  const missing = [...scope].filter((path) => !classifiedSet.has(path)).sort();
  const extra = [...classifiedSet].filter((path) => !scope.has(path)).sort();
  if (missing.length || extra.length) {
    errors.push(`changed-file coverage mismatch; missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`);
  }
  if (!value.findings.length && !value.examined_changed_files.length && scope.size) {
    errors.push("a review with no findings must examine at least one changed file");
  }
  const outside = value.context_files_examined.filter((path) => !canonicalReviewPath(path) || context.isTracked?.(path) === false);
  if (outside.length) errors.push(`context_files_examined has non-repository paths: ${JSON.stringify(outside.slice(0, 5))}`);
  value.verification_requests.forEach((item, index) => {
    if (blank(item.command) || blank(item.claim)) errors.push(`verification_requests[${index}] needs a command and a claim`);
  });
  return errors;
}

/** What the runner observed about one attempt. */
export interface ReviewAttemptEvidence {
  /** The reviewer's final output text, if any. */
  output: string | null;
  timedOut: boolean;
  /** Violations observed while the reviewer ran, most decisive first. */
  fatal: Array<{ failureClass: ReviewFailureClass; message: string }>;
  /** Whether the provider exited with an error before any report. */
  exitedWithError: boolean;
  /** True when the reviewed checkout changed during the attempt; null when it could not be checked. */
  snapshotChanged: boolean | null;
  /** False when the reviewer ran on a model it was not meant to; null when not reported. */
  modelOk: boolean | null;
}

export interface ReviewAttemptVerdict {
  valid: boolean;
  /** An unconsumed attempt (a transport failure or timeout before any report) does not count. */
  consumed: boolean;
  effectiveVote: "UPVOTE" | "DOWNVOTE" | "INVALID" | null;
  failureClass: ReviewFailureClass | null;
  validationErrors: string[];
  /** The parsed report, when the output was one. */
  report: ReviewReport | null;
}

const UNCONSUMED_WITHOUT_REPORT = new Set<ReviewFailureClass>(["transport", "timeout"]);

/** Decide an attempt's validity with `evaluate`'s precedence: timeout, then the first fatal
 * violation, then a missing report, then the model, then the contract; a changed or unverifiable
 * snapshot overrides every other outcome. */
export function evaluateReviewAttempt(evidence: ReviewAttemptEvidence, context: ReviewReportContext): ReviewAttemptVerdict {
  let report: unknown;
  let parsed = false;
  if (evidence.output !== null && evidence.output.trim()) {
    try { report = JSON.parse(evidence.output); parsed = true; } catch { parsed = false; }
  }
  let failureClass: ReviewFailureClass | null = null;
  let errors: string[] = [];
  if (evidence.timedOut) {
    failureClass = "timeout"; errors = ["the reviewer timed out"];
  } else if (evidence.fatal.length) {
    failureClass = evidence.fatal[0]!.failureClass; errors = evidence.fatal.map((item) => item.message);
  } else if (evidence.output !== null && evidence.output.trim() && !parsed) {
    failureClass = "evidence_contract"; errors = ["the final message is not the JSON report"];
  } else if (!parsed) {
    failureClass = evidence.exitedWithError ? "transport" : "evidence_contract";
    errors = [evidence.exitedWithError ? "the reviewer exited with an error" : "no structured report"];
  } else if (evidence.modelOk === false) {
    failureClass = "evidence_contract"; errors = ["unexpected reviewer model"];
  } else {
    errors = validateReviewReport(report, context);
    if (errors.length) failureClass = "evidence_contract";
  }
  if (evidence.snapshotChanged === null) {
    failureClass = "snapshot"; errors.push("post-review snapshot failed");
  } else if (evidence.snapshotChanged) {
    failureClass = "snapshot"; errors.push("the reviewed repository changed during the attempt");
  }
  const consumed = !(failureClass !== null && UNCONSUMED_WITHOUT_REPORT.has(failureClass) && !parsed);
  const valid = failureClass === null;
  return {
    valid,
    consumed,
    effectiveVote: valid ? (report as ReviewReport).vote : consumed ? "INVALID" : null,
    failureClass,
    validationErrors: errors,
    report: valid ? report as ReviewReport : null,
  };
}

/** One line per open finding, carried into a follow-up round's prompt. */
export function compactReviewFinding(finding: Pick<ReviewReportFinding, "severity" | "blocking" | "file" | "line" | "title">): string {
  // A reviewer wrote these: one bounded line each, so none can open a section of the next prompt.
  const line = (text: string) => text.replace(/\s+/gu, " ").trim().slice(0, 200);
  const where = finding.line ? `${line(finding.file)}:${finding.line}` : line(finding.file);
  return `- [${finding.severity}${finding.blocking ? " blocking" : ""}] ${where}: ${line(finding.title)}`;
}

/** The review-run policy the skill states and Wollipog enforces. */
export const REVIEW_ROUND_BUDGET = 4;
export const REVIEW_ATTEMPTS_PER_ROUND = 2;
