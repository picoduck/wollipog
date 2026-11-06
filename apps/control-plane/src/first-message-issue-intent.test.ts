/**
 * The exact-reference parser that remains of first-message intent (#4104): the scope grant's fast
 * path and its reference bounds. It decides no intent; the #3920 and #4061 cases now pass through
 * the scope grant (`scope-grant.test.ts`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { issueReferencesInMessage } from "./campaign-launch-admission.js";
import { firstMessageTargetEpics, issueReferenceSpans, MAX_EXPANDED_REFERENCES, MAX_TARGET_EPICS } from "./first-message-issue-intent.js";

const repo = "owner/repo";
const references = (text: string, repository = repo) => issueReferencesInMessage(text, repository);
const context = (text: string) => [...new Set(issueReferenceSpans(text, repo).filter((r) => r.context).map((r) => r.number))].sort((a, b) => a - b);

test("no verb list decides what a first message asks for any more (#4104)", () => {
  const source = readFileSync(new URL("./first-message-issue-intent.ts", import.meta.url), "utf8");
  for (const retired of ["DIRECTIVE", "BACKGROUND", "NEGATION", "CLAUSE_START", "firstMessageIssueIntent"]) {
    assert.equal(source.includes(retired), false, retired);
  }
});

test("a range names every issue in it, in every written form (#4061)", () => {
  const all = Array.from({ length: 9 }, (_, i) => 2997 + i);
  for (const range of ["#2997–#3005", "#2997-#3005", "#2997—#3005", "#2997 – #3005", "#2997 - #3005", "#2997 — #3005",
    "#2997 to #3005", "#2997 through #3005", "#2997..#3005", "#2997 .. #3005"]) {
    assert.deepEqual(references(`Implement units ${range}.`), all, range);
    assert.ok(issueReferenceSpans(`Implement units ${range}.`, repo).every((r) => r.range && !r.context), range);
  }
  assert.deepEqual(references("Implement epic #3032 in owner/repo: units #2997–#3005. Close #3032 when all its units have merged."),
    [...all, 3032]);
  assert.deepEqual(references("Deliver:\n- #1–#3\n- #7 through #8"), [1, 2, 3, 7, 8]);
  // A chain names no range, spaced or not and whatever its separators: no issue between them is read.
  for (const chain of ["#1–#3–#5", "#1 – #3 – #5", "#1 - #3 - #5", "#1 to #3 to #5", "#1 – #3 to #5", "#1..#3 through #5",
    "#1 through #3–#5", "#1—#3 .. #5", "#1 – #3 – #5 – #7"]) {
    assert.equal(issueReferenceSpans(`Fix ${chain}.`, repo).some((r) => r.range), false, chain);
    assert.ok(references(`Fix ${chain}.`).every((n) => [1, 3, 5, 7].includes(n)), chain);
  }
  assert.deepEqual(references("Fix #1–#3 - then close #9."), [1, 2, 3, 9], "a range beside a chain-like word is still a range");
});

test("an oversized, inverted or empty range names only its endpoints, as context (#4061)", () => {
  assert.deepEqual(context("Fix #1–#101."), [1, 101], "1 through 101 is 101 issues");
  assert.equal(references("Fix #1–#100.").length, 100);
  assert.deepEqual(context("Fix #1–#100."), []);
  assert.deepEqual(context("Fix #9–#5."), [5, 9]);
  assert.deepEqual(context("Fix #5–#5."), [5]);
  // Ranges that together pass 100 distinct issues expand none of them.
  assert.deepEqual(context("Fix #1–#60 and #101–#160."), [1, 60, 101, 160]);
  assert.equal(references("Fix #1–#60 and #31–#90.").length, 90);
  // Expansion is bounded however many ranges a message repeats.
  const started = performance.now();
  assert.deepEqual(context(`Fix ${"#1–#100 ".repeat(5000)}`), [1, 100]);
  assert.ok(performance.now() - started < 1000);
  assert.ok(MAX_EXPANDED_REFERENCES >= 100);
  // Separator and whitespace runs the range's guards read around each reference stay fast.
  const near = 64 * 1024 - 64;
  for (const filler of [`#1${" ".repeat(near)}–#2`, "#1 – ".repeat(near / 5), "#1 to ".repeat(near / 6), `#1 ${"– ".repeat(near / 2)}#2`,
    "#1..".repeat(near / 4), `${" ".repeat(near)}#1 through #2`, "a".repeat(near), "(".repeat(near), "\"a".repeat(near / 2)]) {
    const begun = performance.now();
    issueReferenceSpans(`Fix ${filler}`, repo);
    assert.ok(performance.now() - begun < 1000, `${filler.slice(0, 12)}… took ${Math.round(performance.now() - begun)}ms`);
  }
});

test("only a scoped reference written after the word epic names a target epic (#4061)", () => {
  assert.deepEqual(firstMessageTargetEpics("Implement epic #3032 in owner/repo: units #2997–#3005.", repo, [3032, 2997]), [3032]);
  assert.deepEqual(firstMessageTargetEpics("Deliver Epic: https://github.com/owner/repo/issues/40 and #41.", repo, [40, 41]), [40]);
  assert.deepEqual(firstMessageTargetEpics("Fix #41. See epic #40.", repo, [41]), [], "an epic the grant left out of scope is not a target");
  assert.deepEqual(firstMessageTargetEpics("Implement epic #1–#3.", repo, [1, 2, 3]), [], "a range is never an epic");
  assert.deepEqual(firstMessageTargetEpics(`Deliver ${[1, 2, 3, 4, 5].map((n) => `epic #${n}`).join(", ")}.`, repo, [1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);
  const many = Array.from({ length: MAX_TARGET_EPICS + 1 }, (_, i) => i + 1);
  assert.deepEqual(firstMessageTargetEpics(`Deliver ${many.map((n) => `epic #${n}`).join(", ")}.`, repo, many), [],
    "more target epics than the bound name none");
});

test("every reference format of the campaign's repository is read, and other repositories' are ignored", () => {
  assert.deepEqual(references("Fix #1, Owner/Repo#2 and https://github.com/owner/repo/issues/3#issuecomment-9. " +
    "Fix other/repo#7 and https://github.com/owner/repo/pull/8."), [1, 2, 3]);
  const gitlab = "gitlab.example.com/group/sub/project";
  assert.deepEqual(references("Fix #1 and https://gitlab.example.com/Group/Sub/Project/-/issues/2. " +
    "See https://gitlab.example.com/group/sub/other/-/issues/4.", gitlab), [1, 2]);
});

test("the parser reads each reference once, in text order, whatever surrounds it", () => {
  const word = fc.constantFrom("Fix", "see", "not", "and", "(", ")", ":", ".", ",", "\n", "- ", "#1", "#2", "#3", "owner/repo#4",
    "https://github.com/owner/repo/issues/5", "`#6`", "don't", "#1–#3", "#2 through #5", "#5..#2", "other/repo#9");
  fc.assert(fc.property(fc.array(word, { maxLength: 40 }), (words) => {
    const text = words.join(" ");
    const spans = issueReferenceSpans(text, repo);
    assert.ok(spans.every((r, i) => i === 0 || spans[i - 1]!.start <= r.start));
    assert.equal(references(text).includes(9), false, "another repository's reference is never read");
  }), { numRuns: 300 });
});
