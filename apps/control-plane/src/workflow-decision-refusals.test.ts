import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { boundedDecisionString, boundedDecisionStringProblem } from "./issue-closure-request-refusal.js";
import { normalizeWorkflowDecisionSnapshot } from "./sessions.js";

// #4511: a typed decision's refusal names the item, field and rule that failed, never the value.

const ARTIFACT = { evidenceId: "after", artifactId: "artifact-1", mediaType: "image/png", sha256: "a".repeat(64) };
const EXTERNAL = { evidenceId: "before", uri: "https://example.com/before.png", sha256: "b".repeat(64) };
/** A distinctive value that must never appear in a refusal. */
const PRIVATE = "PRIVATE-VALUE";

function refusal(snapshot: unknown): string {
  const result = normalizeWorkflowDecisionSnapshot(snapshot);
  assert.equal(result.ok, false, "refused");
  assert.equal(result.status, 400);
  return result.error ?? "";
}

test("each UI evidence check names the item, its field and the rule (#4511)", () => {
  const evidence = (first: Record<string, unknown> | null, second: Record<string, unknown> = EXTERNAL) =>
    ({ category: "ui_evidence_approval", evidence: [first, second] });
  const cases: [string, unknown, string][] = [
    ["long evidenceId", evidence({ ...ARTIFACT, evidenceId: PRIVATE.padEnd(257, "x") }),
      "evidence item 1: evidenceId is longer than 256 characters"],
    ["missing evidenceId", evidence({ ...ARTIFACT, evidenceId: undefined }), "evidence item 1: evidenceId is missing"],
    ["blank evidenceId", evidence({ ...ARTIFACT, evidenceId: "   " }), "evidence item 1: evidenceId is blank"],
    ["numeric evidenceId", evidence({ ...ARTIFACT, evidenceId: 7 }), "evidence item 1: evidenceId must be text"],
    ["control character", evidence({ ...ARTIFACT, evidenceId: `${PRIVATE}\u0001` }),
      "evidence item 1: evidenceId contains a control character"],
    ["uppercase sha256", evidence({ ...ARTIFACT, sha256: "A".repeat(64) }),
      "evidence item 1: sha256 must be 64 lowercase hexadecimal characters"],
    ["short sha256", evidence({ ...ARTIFACT, sha256: "a".repeat(63) }),
      "evidence item 1: sha256 must be 64 lowercase hexadecimal characters"],
    ["http uri", evidence(ARTIFACT, { ...EXTERNAL, uri: `http://example.com/${PRIVATE}` }),
      "evidence item 2: uri must be an HTTPS URL of at most 4096 characters without a username or password"],
    ["uri with credentials", evidence(ARTIFACT, { ...EXTERNAL, uri: `https://user:${PRIVATE}@example.com/` }),
      "evidence item 2: uri must be an HTTPS URL of at most 4096 characters without a username or password"],
    ["long artifactId", evidence({ ...ARTIFACT, artifactId: PRIVATE.padEnd(257, "x") }),
      "evidence item 1: artifactId is longer than 256 characters"],
    ["malformed mediaType", evidence({ ...ARTIFACT, mediaType: `Image/${PRIVATE}` }),
      "evidence item 1: mediaType must be a lowercase type/subtype media type, such as image/png"],
    ["neither uri nor artifact", evidence({ evidenceId: "after", sha256: "a".repeat(64) }),
      "evidence item 1 needs a uri or an artifactId"],
    ["unrenderable artifact", evidence({ ...ARTIFACT, mediaType: "image/svg+xml" }),
      "evidence item 1: a Session artifact needs a mediaType the review card can show " +
      "(image/png, image/jpeg, image/jpg, image/gif, image/webp, video/mp4, video/webm)"],
    ["not an object", evidence(null), "evidence item 1 must be an object"],
    ["duplicate evidenceId", evidence(ARTIFACT, { ...EXTERNAL, evidenceId: ARTIFACT.evidenceId }),
      "evidence item 2 repeats the evidenceId of item 1"],
  ];
  for (const [name, snapshot, expected] of cases) {
    const message = refusal(snapshot);
    assert.equal(message, expected, name);
    assert.ok(!message.includes(PRIVATE), `${name}: the refusal does not echo the submitted value`);
  }
  assert.equal(refusal({ category: "ui_evidence_approval", evidence: [] }), "UI evidence decisions require at least one evidence reference");
});

test("valid UI evidence normalizes to the same snapshot, in the same key order (#4511)", () => {
  const result = normalizeWorkflowDecisionSnapshot({ category: "ui_evidence_approval", evidence: [
    { sha256: ARTIFACT.sha256, mediaType: ARTIFACT.mediaType, artifactId: ARTIFACT.artifactId, evidenceId: ARTIFACT.evidenceId },
    { ...EXTERNAL, ...ARTIFACT, evidenceId: "both" },
    EXTERNAL,
  ] });
  assert.ok(result.ok, result.error);
  // The digest hashes this canonical form, so its exact serialization must not change.
  assert.equal(JSON.stringify(result.data), JSON.stringify({ category: "ui_evidence_approval", evidence: [
    { evidenceId: "after", sha256: ARTIFACT.sha256, artifactId: "artifact-1", mediaType: "image/png" },
    { evidenceId: "both", uri: EXTERNAL.uri, sha256: ARTIFACT.sha256, artifactId: "artifact-1", mediaType: "image/png" },
    { evidenceId: "before", uri: EXTERNAL.uri, sha256: EXTERNAL.sha256 },
  ] }));
});

test("an implementation question's text, option count and each option field have their own refusals (#4511)", () => {
  const options = (count: number) => Array.from({ length: count }, (_, index) => ({ optionId: `o${index + 1}`, label: `Option ${index + 1}` }));
  const ask = (fields: Record<string, unknown>) => ({ category: "implementation_question", question: "Which one?", options: options(2), ...fields });
  const withOption = (option: unknown) => ask({ options: [options(1)[0], option] });
  const cases: [string, unknown, string][] = [
    ["long question", ask({ question: PRIVATE.padEnd(4001, "x") }), "implementation question text is longer than 4000 characters"],
    ["missing question", ask({ question: undefined }), "implementation question text is missing"],
    ["one option", ask({ options: options(1) }), "implementation questions require a list of 2 to 12 options; 1 given"],
    ["options not a list", ask({ options: "o1" }), "implementation questions require a list of 2 to 12 options"],
    ["thirteen suggestions", ask({ kind: "question", options: options(13) }),
      "implementation questions require a list of 0 to 12 options; 13 given"],
    ["option not an object", withOption(null), "implementation question option 2 must be an object"],
    ["long optionId", withOption({ optionId: PRIVATE.padEnd(129, "x"), label: "Two" }),
      "implementation question option 2: optionId is longer than 128 characters"],
    ["long label", withOption({ optionId: "o2", label: PRIVATE.padEnd(201, "x") }),
      "implementation question option 2: label is longer than 200 characters"],
    ["missing label", withOption({ optionId: "o2" }), "implementation question option 2: label is missing"],
    ["long description", withOption({ optionId: "o2", label: "Two", description: PRIVATE.padEnd(1001, "x") }),
      "implementation question option 2: description is longer than 1000 characters"],
    ["reserved optionId", withOption({ optionId: "__workflow_deny__", label: "Two" }),
      "implementation question option 2 uses an optionId Wollipog reserves"],
    ["duplicate optionId", withOption({ optionId: "o1", label: "Two" }),
      "implementation question option 2 repeats the optionId of option 1"],
  ];
  for (const [name, snapshot, expected] of cases) {
    const message = refusal(snapshot);
    assert.equal(message, expected, name);
    assert.ok(!message.includes(PRIVATE), `${name}: the refusal does not echo the submitted value`);
  }
  assert.equal(refusal({ category: "owner_decision", question: "Proceed?", options: [] }),
    "owner decisions require a list of 2 to 12 options; 0 given", "an owner decision names its own kind");
  const valid = normalizeWorkflowDecisionSnapshot(ask({ options: [{ label: "One", description: "First", optionId: "o1" }, options(2)[1]],
    recommendedOptionId: "o1" }));
  assert.ok(valid.ok, valid.error);
  assert.equal(JSON.stringify(valid.data), JSON.stringify({ category: "implementation_question", question: "Which one?",
    options: [{ optionId: "o1", label: "One", description: "First" }, { optionId: "o2", label: "Option 2" }], recommendedOptionId: "o1" }));
});

test("a merge decision's required check rows name the row and the field that failed (#4511)", () => {
  const head = "c".repeat(40);
  const merge = (check: unknown) => ({ category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 7, headSha: head,
    reviewResult: "merge", requiredChecks: { headSha: head, status: "passed", checkedAt: 10,
      checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed", url: "https://github.com/picoduck/wollipog/actions/runs/1" }, check] } });
  const cases: [string, unknown, string][] = [
    ["failed state", { name: PRIVATE, state: "failed" }, "requiredChecks.checks item 2: state must be passed"],
    ["missing name", { state: "passed" }, "requiredChecks.checks item 2: name is missing"],
    ["http url", { name: "Lint", state: "passed", url: `http://example.com/${PRIVATE}` },
      "requiredChecks.checks item 2: url must be an HTTPS URL of at most 4096 characters without a username or password"],
    ["not an object", "Lint", "requiredChecks.checks item 2 must be an object"],
  ];
  for (const [name, check, expected] of cases) {
    const message = refusal(merge(check));
    assert.equal(message, expected, name);
    assert.ok(!message.includes(PRIVATE), `${name}: the refusal does not echo the submitted value`);
  }
  const valid = normalizeWorkflowDecisionSnapshot(merge({ state: "passed", name: "Lint" }));
  assert.ok(valid.ok, valid.error);
  assert.equal(JSON.stringify((valid.data as { requiredChecks: unknown }).requiredChecks), JSON.stringify({ headSha: head, status: "passed",
    checkedAt: 10, checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed", url: "https://github.com/picoduck/wollipog/actions/runs/1" },
      { name: "Lint", state: "passed" }] }));
});

test("boundedDecisionStringProblem reports a problem exactly when boundedDecisionString refuses (#4511)", () => {
  fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 40 }), fc.string({ unit: "binary", maxLength: 40 }), fc.anything()),
    fc.integer({ min: 0, max: 40 }), (value, max) =>
      (boundedDecisionStringProblem(value, max) === null) === boundedDecisionString(value, max)));
});
