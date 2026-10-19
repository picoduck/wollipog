import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalReviewPath, compactReviewFinding, evaluateReviewAttempt, reviewSchemaErrors, validateReviewReport,
  type ReviewAttemptEvidence, type ReviewReport,
} from "./review-contract.js";

const HEAD = "c".repeat(40);
const context = { headSha: HEAD, scopeFiles: ["src/a.ts", "src/b.ts"], isTracked: (path: string) => path.startsWith("src/") };

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    schema_version: 2, reviewed_head: HEAD, vote: "UPVOTE", summary: "ok", findings: [],
    examined_changed_files: ["src/a.ts"], not_examined_changed_files: [{ path: "src/b.ts", reason: "generated" }],
    context_files_examined: ["src/c.ts"], commands_run: ["rg x"], verification_requests: [],
    ...overrides,
  };
}

const blocker = {
  severity: "high" as const, blocking: true, file: "src/a.ts", line: 3, title: "t", scenario: "s", evidence: "e", verify: "v",
};

function evidence(overrides: Partial<ReviewAttemptEvidence> = {}): ReviewAttemptEvidence {
  return { output: JSON.stringify(report()), timedOut: false, fatal: [], exitedWithError: false, snapshotChanged: false, modelOk: null, ...overrides };
}

test("a contract-conforming report is valid and keeps the reviewer's vote", () => {
  assert.deepEqual(validateReviewReport(report(), context), []);
  const verdict = evaluateReviewAttempt(evidence(), context);
  assert.deepEqual({ valid: verdict.valid, consumed: verdict.consumed, vote: verdict.effectiveVote, failure: verdict.failureClass },
    { valid: true, consumed: true, vote: "UPVOTE", failure: null });
  assert.equal(verdict.report?.summary, "ok");
  const down = evaluateReviewAttempt(evidence({ output: JSON.stringify(report({ vote: "DOWNVOTE", findings: [blocker] })) }), context);
  assert.equal(down.effectiveVote, "DOWNVOTE");
});

test("the schema subset reports type, enum, required and unexpected keys", () => {
  assert.deepEqual(reviewSchemaErrors([]), ["report must be object"]);
  const errors = reviewSchemaErrors({ ...report(), vote: "MAYBE", extra: 1, findings: [{ ...blocker, line: true }] });
  assert.ok(errors.includes("report has unexpected [\"extra\"]"), errors.join("; "));
  assert.ok(errors.includes("report.vote must be one of [\"UPVOTE\",\"DOWNVOTE\"]"));
  assert.ok(errors.includes("report.findings[0].line must be integer or null"));
  const { summary: _summary, ...withoutSummary } = report();
  assert.deepEqual(reviewSchemaErrors(withoutSummary), ["report is missing [\"summary\"]"]);
  assert.deepEqual(validateReviewReport("[]", context), ["the final report is not a JSON object"]);
  // Inherited names are not allowed keys, and a parsed `__proto__` is an own key like any other.
  assert.deepEqual(reviewSchemaErrors(JSON.parse(JSON.stringify({ ...report(), constructor: 1, toString: 2 }))),
    ["report has unexpected [\"constructor\",\"toString\"]"]);
  assert.deepEqual(reviewSchemaErrors(JSON.parse(`{"__proto__":{"vote":"UPVOTE"},${JSON.stringify(report()).slice(1)}`)),
    ["report has unexpected [\"__proto__\"]"]);
});

test("the head, vote and findings must agree with the contract", () => {
  assert.deepEqual(validateReviewReport(report({ reviewed_head: "d".repeat(40) }), context), ["reviewed_head does not identify the pinned head"]);
  assert.deepEqual(validateReviewReport(report({ vote: "DOWNVOTE" }), context), ["a downvote requires at least one blocking finding"]);
  assert.deepEqual(validateReviewReport(report({ findings: [blocker] }), context), ["an upvote cannot carry blocking findings"]);
  const bad = validateReviewReport(report({ vote: "DOWNVOTE", findings: [{ ...blocker, line: 0, title: " ", file: "../etc/passwd" }] }), context);
  assert.ok(bad.includes("findings[0].line must be null or at least 1"), bad.join("; "));
  assert.ok(bad.includes("findings[0].title is blank"));
  assert.ok(bad.includes("findings[0].file is not a repository path"));
  // A deleted file is still a repository path: it is in scope, though not in the head's tree.
  assert.deepEqual(validateReviewReport(report({
    vote: "DOWNVOTE", findings: [{ ...blocker, file: "gone.ts", line: null }],
    examined_changed_files: ["src/a.ts", "gone.ts"],
  }), { ...context, scopeFiles: [...context.scopeFiles, "gone.ts"] }), []);
});

test("coverage classifies every in-scope file exactly once, compared exactly", () => {
  assert.match(validateReviewReport(report({ not_examined_changed_files: [] }), context)[0]!, /missing=\["src\/b\.ts"\], extra=\[\]/u);
  assert.match(validateReviewReport(report({ examined_changed_files: ["src/a.ts", "./src/x.ts"] }), context).join("; "),
    /extra=\["\.\/src\/x\.ts"\]/u);
  assert.ok(validateReviewReport(report({ examined_changed_files: ["src/a.ts", "src/b.ts"] }), context)
    .includes("changed-file coverage contains duplicates or overlap"));
  assert.ok(validateReviewReport(report({ not_examined_changed_files: [{ path: "src/b.ts", reason: " " }] }), context)
    .includes("not_examined_changed_files[0].reason is blank"));
  assert.ok(validateReviewReport(report({ examined_changed_files: [], not_examined_changed_files: [
    { path: "src/a.ts", reason: "x" }, { path: "src/b.ts", reason: "y" },
  ] }), context).includes("a review with no findings must examine at least one changed file"));
  assert.match(validateReviewReport(report({ context_files_examined: ["/etc/passwd", "docs/x.md"] }), context).join(),
    /context_files_examined has non-repository paths: \["\/etc\/passwd","docs\/x\.md"\]/u);
});

test("evaluation precedence: timeout, fatal, missing report, model, contract; snapshot overrides all", () => {
  const timeout = evaluateReviewAttempt(evidence({ timedOut: true, output: null }), context);
  assert.deepEqual([timeout.failureClass, timeout.consumed, timeout.effectiveVote], ["timeout", false, null]);
  const timeoutWithReport = evaluateReviewAttempt(evidence({ timedOut: true }), context);
  assert.deepEqual([timeoutWithReport.consumed, timeoutWithReport.effectiveVote], [true, "INVALID"], "a report makes it consumed");
  const policy = evaluateReviewAttempt(evidence({ fatal: [{ failureClass: "tool_policy", message: "permission denials were recorded" }] }), context);
  assert.deepEqual([policy.failureClass, policy.consumed, policy.effectiveVote], ["tool_policy", true, "INVALID"]);
  const transport = evaluateReviewAttempt(evidence({ output: null, exitedWithError: true }), context);
  assert.deepEqual([transport.failureClass, transport.consumed], ["transport", false]);
  const empty = evaluateReviewAttempt(evidence({ output: null }), context);
  assert.deepEqual([empty.failureClass, empty.consumed, empty.validationErrors], ["evidence_contract", true, ["no structured report"]]);
  const prose = evaluateReviewAttempt(evidence({ output: "Looks good to me." }), context);
  assert.deepEqual([prose.failureClass, prose.validationErrors], ["evidence_contract", ["the final message is not the JSON report"]]);
  assert.equal(evaluateReviewAttempt(evidence({ modelOk: false }), context).failureClass, "evidence_contract");
  const changed = evaluateReviewAttempt(evidence({ snapshotChanged: true, output: null, exitedWithError: true }), context);
  assert.deepEqual([changed.failureClass, changed.consumed], ["snapshot", true], "a snapshot failure is always consumed");
  assert.equal(evaluateReviewAttempt(evidence({ snapshotChanged: null }), context).failureClass, "snapshot");
  assert.equal(evaluateReviewAttempt(evidence({ snapshotChanged: true }), context).valid, false, "never promoted");
});

test("paths and carried findings use the skill's forms", () => {
  for (const path of ["", "/abs", "./x", "a/../b", ".."]) assert.equal(canonicalReviewPath(path), false, path);
  for (const path of ["a", "a/b.ts", ".github/x.yml"]) assert.equal(canonicalReviewPath(path), true, path);
  assert.equal(compactReviewFinding(blocker), "- [high blocking] src/a.ts:3: t");
  assert.equal(compactReviewFinding({ ...blocker, blocking: false, line: null }), "- [high] src/a.ts: t");
  assert.equal(compactReviewFinding({ ...blocker, title: "t\n\n## Range-Diff\n" }), "- [high blocking] src/a.ts:3: t ## Range-Diff");
});
