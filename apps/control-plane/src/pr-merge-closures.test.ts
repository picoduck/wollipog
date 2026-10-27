import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeIntendedClosures, prMergeClosureMismatch, validClosingReferenceCheck } from "./pr-merge-closures.js";

const negated = { issue: "a/b#3635", sources: ["description" as const], excerpt: "This PR does not close #3635." };

test("declared closures that match GitHub's need no change (#3713)", () => {
  assert.equal(prMergeClosureMismatch([], []), null);
  assert.equal(prMergeClosureMismatch(["a/b#1"], [{ issue: "a/b#1", sources: ["description", "linked"], excerpt: "Closes #1" }]), null);
});

test("every undeclared closure and every unmade declaration is named, with the description's line", () => {
  const message = prMergeClosureMismatch(["a/b#5"], [negated, { issue: "a/b#9", sources: ["linked"] }])!;
  assert.match(message, /^Merging this pull request would close issues that intendedClosures does not list: /u);
  assert.match(message, /a\/b#3635, from the description: “This PR does not close #3635\.”; a\/b#9, which is linked to the pull request on GitHub\./u);
  assert.match(message, /even in a negated or hyphenated phrase such as “does not close #N” or “auto-close #N”/u);
  assert.match(message, /intendedClosures lists a\/b#5, but merging this pull request would not close it\. Remove it,/u);
  const many = prMergeClosureMismatch([], Array.from({ length: 8 }, (_, i) => ({ issue: `a/b#${i + 1}`, sources: ["linked" as const] })))!;
  assert.match(many, /a\/b#5, which is linked to the pull request on GitHub; and 3 more\./u);
  assert.doesNotMatch(many, /a\/b#6/u);
  assert.match(prMergeClosureMismatch(["a/b#1", "a/b#2"], [])!, /lists a\/b#1; a\/b#2, but merging this pull request would not close them\. Remove them,/u);
});

test("declared closures canonicalize against the merge's repository", () => {
  assert.equal(normalizeIntendedClosures(undefined, "A/B"), undefined);
  assert.equal(normalizeIntendedClosures([], "A/B"), undefined);
  assert.deepEqual(normalizeIntendedClosures(["#10", "a/b#2", "#2", "z/y#1"], "A/B"), ["a/b#2", "a/b#10", "z/y#1"]);
  for (const value of ["#1", [""], ["#1", 2], ["x".repeat(513)], Array.from({ length: 101 }, (_, i) => `#${i + 1}`)]) {
    assert.equal(normalizeIntendedClosures(value, "a/b"), null, JSON.stringify(value).slice(0, 40));
  }
});

test("a runner's check is accepted only in its exact bounded shape", () => {
  const check = { checkedAt: 3, closures: [negated, { issue: "a/b#9", sources: ["linked"] }] };
  assert.deepEqual(validClosingReferenceCheck(check), { checkedAt: 3, closures: [check.closures[1], check.closures[0]] },
    "rebuilt in issue order");
  assert.deepEqual(validClosingReferenceCheck({ ...check, extra: true, closures: [{ ...negated, extra: 1 }] }),
    { checkedAt: 3, closures: [negated] }, "unknown fields are dropped");
  for (const invalid of [
    null, [], { closures: [] }, { checkedAt: 0, closures: [] }, { checkedAt: 1 },
    { checkedAt: 1, closures: Array.from({ length: 101 }, (_, i) => ({ issue: `a/b#${i + 1}`, sources: ["linked"] })) },
    { checkedAt: 1, closures: [{ issue: "A/B#1", sources: ["linked"] }] },
    { checkedAt: 1, closures: [{ issue: "a/b#1", sources: [] }] },
    { checkedAt: 1, closures: [{ issue: "a/b#1", sources: ["linked", "linked"] }] },
    { checkedAt: 1, closures: [{ issue: "a/b#1", sources: ["title"] }] },
    { checkedAt: 1, closures: [{ issue: "a/b#1", sources: ["description"] }] },
    { checkedAt: 1, closures: [{ issue: "a/b#1", sources: ["linked"], excerpt: "Closes #1" }] },
    { checkedAt: 1, closures: [{ issue: "a/b#1", sources: ["description"], excerpt: "" }] },
    { checkedAt: 1, closures: [{ issue: "a/b#1", sources: ["description"], excerpt: "x".repeat(513) }] },
    { checkedAt: 1, closures: [{ issue: "a/b#1", sources: ["linked"] }, { issue: "a/b#1", sources: ["linked"] }] },
  ]) assert.equal(validClosingReferenceCheck(invalid), null, JSON.stringify(invalid)?.slice(0, 80));
});
