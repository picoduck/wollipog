import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { issueReferencesInMessage } from "./campaign-launch-admission.js";
import { firstMessageIssueIntent, MAX_CLASSIFIED_MESSAGE_LENGTH, MAX_CLASSIFIED_REFERENCES } from "./first-message-issue-intent.js";

const repo = "owner/repo";
const intent = (text: string, repository = repo) => firstMessageIssueIntent(text, repository);

test("only references the message asks the campaign to act on become scope; background ones are context (#3920)", () => {
  // The observed launch: the targets are named, and two more issues are background.
  assert.deepEqual(intent("Deliver #11, #12, #13 and #14 (members of the epic), then close #15 and #16. In passing, this run " +
    "serves as a live acceptance test for #20, and #21, a test flake, is a known cause of failures."),
  { scope: [11, 12, 13, 14, 15, 16], context: [20, 21] });
  // A sanitized copy of a real launch: targets after "fix ...:", one issue only in a parenthetical citation.
  assert.deepEqual(intent("Use the orchestrate-issues skill to fix the decision-lifecycle findings from the 2026-10-31 acceptance " +
    "run in owner/repo: #101, #102, #103, #104, #105, #106 and #107. Each issue specifies its acceptance criteria. Order and " +
    "grouping (these all touch apps/control-plane/src/sessions.ts, so run at most two at once): 1. #105 (publication id) and " +
    "#106 together in one child. 2. #103: attribution only. Land it before #102 so #102's tests can assert the reason. " +
    "Commands: the command guard refuses heredocs and pipelines that name the state directory (#900)."),
  { scope: [101, 102, 103, 104, 105, 106, 107], context: [900] });
  for (const verb of ["Deliver", "Implement", "Fix", "Close", "Claim", "Work on", "Resolve", "Tackle", "Pick up"]) {
    assert.deepEqual(intent(`${verb} #5 and #6.`), { scope: [5, 6], context: [] }, verb);
  }
});

test("background, negated, cited and unclear references never get scope (#3920)", () => {
  const context = (text: string, expected: number[]) => assert.deepEqual(intent(text), { scope: [], context: expected }, text);
  context("See #3.", [3]);
  context("Fix the crash; it is related to #3.", [3]);
  context("#3 is a known cause of these failures.", [3]);
  context("This run is the acceptance test for #3.", [3]);
  context("#3 is being handled elsewhere.", [3]);
  context("Close #3 as a duplicate of #4.", [3, 4]); // Mixed intent in one clause: neither is clear enough.
  context("Fix the bug (#3).", [3]);
  context("Fix [#3](https://github.com/owner/repo/issues/3).", [3]);
  context("Fix `#3` now.", [3]);
  context("Don't touch #3.", [3]);
  context("Do not close #3.", [3]);
  context("Never claim #3.", [3]);
  context("Leave #3 to the other campaign.", [3]);
  context("#3 was fixed last week.", [3]);
  context("Issues: #3, #4.", [3, 4]); // No request at all is unclear.
  context("Refs #3.", [3]);
  // A sentence a URL ends keeps its full stop: the next sentence is not swept into the request.
  context("Fix the docs at https://example.com/a/b. #7 stays as is.", [7]);
});

test("a negated occurrence withholds scope even where another clause asks for it; a background one does not (#3920)", () => {
  assert.deepEqual(intent("Implement #5, not #6."), { scope: [5], context: [6] });
  assert.deepEqual(intent("Fix #1 but don't touch #2."), { scope: [1], context: [2] });
  assert.deepEqual(intent("Fix #1 without changing #2."), { scope: [1], context: [2] });
  assert.deepEqual(intent("Fix #1 and make sure it doesn't regress."), { scope: [1], context: [] });
  assert.deepEqual(intent("Fix #1 and #2. Don't close #2 yet."), { scope: [1], context: [2] });
  assert.deepEqual(intent("Fix #1. See #1 for the logs."), { scope: [1], context: [] });
  assert.deepEqual(intent("Fix #1 and #2 is handled elsewhere."), { scope: [], context: [1, 2] });
  // A negation reaches every later clause of its sentence, however the actions are coordinated.
  assert.deepEqual(intent("Do not fix #1 or close #2."), { scope: [], context: [1, 2] });
  assert.deepEqual(intent("Don't fix #1, and then close #2 or claim #3."), { scope: [], context: [1, 2, 3] });
  assert.deepEqual(intent("Never close #1 - fix #2 instead."), { scope: [], context: [1, 2] });
  assert.deepEqual(intent("Don't touch #1. Fix #2."), { scope: [2], context: [1] }, "it ends with its sentence");
  // A rejected alternative, or work to stop or put off, is withheld.
  assert.deepEqual(intent("Fix #1 instead of fixing #2."), { scope: [1], context: [2] });
  assert.deepEqual(intent("Fix #1 rather than fixing #2."), { scope: [1], context: [2] });
  assert.deepEqual(intent("Fix #2. Fix #1 instead of #2."), { scope: [1], context: [2] });
  assert.deepEqual(intent("Fix everything other than #2, apart from #3."), { scope: [], context: [2, 3] });
  assert.deepEqual(intent("Stop working on #4. Postpone fixing #5; hold off on closing #6."), { scope: [], context: [4, 5, 6] });
  // A question asks nothing unless it is phrased as a request.
  assert.deepEqual(intent("Should we fix #1? Is #2 worth fixing?"), { scope: [], context: [1, 2] });
  assert.deepEqual(intent("Can you fix #1? Please close #2? Could you work on #3?"), { scope: [1, 2, 3], context: [] });
  // Quoted words, blockquotes and work assigned to someone else grant nothing.
  assert.deepEqual(intent('The issue says "fix #1", and the log says “never close #2”. Fix #3.'), { scope: [3], context: [1, 2] });
  assert.deepEqual(intent("> Fix #1 and close #2\nFix #3."), { scope: [3], context: [1, 2] });
  assert.deepEqual(intent("Someone else will fix #1; another campaign is closing #2. Fix #3."), { scope: [3], context: [1, 2] });
  // A negation inside a parenthetical or inline code still withholds, even one left unclosed.
  assert.deepEqual(intent("Fix #1 and #2 (don't touch #2 yet)."), { scope: [1], context: [2] });
  assert.deepEqual(intent("Fix #1 and #2. `never close #2`"), { scope: [1], context: [2] });
  assert.deepEqual(intent("Fix #1 and #2 (details below.\nDon't touch #2."), { scope: [1], context: [2] });
});

test("a list introduced by a request inherits it item by item; items with their own cue keep it (#3920)", () => {
  assert.deepEqual(intent("Please deliver:\n- #1\n- #2 (login crash)\n\n- #3 is related\n\nBackground:\n- #4\n- #5"),
    { scope: [1, 2], context: [3, 4, 5] });
  assert.deepEqual(intent("Work through these:\n1. #7\n2) #8\nThanks.\n- #9"), { scope: [7, 8], context: [9] });
  // A withholding lead governs every item, whatever verb the item uses, and plain lines up to a blank line.
  assert.deepEqual(intent("Do not:\n- fix #1\n- close #2\n\n- claim #3"), { scope: [], context: [1, 2, 3] });
  assert.deepEqual(intent("Background:\n- We are fixing #3\n- Deliver #4"), { scope: [], context: [3, 4] });
  assert.deepEqual(intent("Don't touch these:\nfix #5\nclose #6\n\nFix #7."), { scope: [7], context: [5, 6] });
  assert.deepEqual(intent("Deliver:\n- #1\n- don't close #2"), { scope: [1], context: [2] });
});

test("an epic named as the target is scope, and so its verified members can be added by lineage (#3920)", () => {
  assert.deepEqual(intent("Deliver epic #40 and its members."), { scope: [40], context: [] });
  assert.deepEqual(intent("Work on the members of epic #40 (see #41 for the design)."), { scope: [40], context: [41] });
});

test("every reference format is classified the same way, and other repositories' references are ignored (#3920)", () => {
  assert.deepEqual(intent("Fix #1, Owner/Repo#2 and https://github.com/owner/repo/issues/3#issuecomment-9. " +
    "See #4, owner/repo#5 and https://github.com/owner/repo/issues/6. Fix other/repo#7 and https://github.com/owner/repo/pull/8."),
  { scope: [1, 2, 3], context: [4, 5, 6] });
  const gitlab = "gitlab.example.com/group/sub/project";
  assert.deepEqual(intent("Fix #1 and https://gitlab.example.com/Group/Sub/Project/-/issues/2. " +
    "See https://gitlab.example.com/group/sub/project/-/issues/3 and https://gitlab.example.com/group/sub/other/-/issues/4.", gitlab),
  { scope: [1, 2], context: [3] });
  // Words inside an address or a file name are not cues.
  assert.deepEqual(intent("Fix #5 next to other/never-touch#2 and docs/see-also.md."), { scope: [5], context: [] });
});

test("classification is bounded: a message too long or too dense scopes nothing, and adversarial text stays fast (#3920)", () => {
  // Over either bound, every reference is context; truncating could drop a negation and widen scope.
  assert.deepEqual(intent(`Fix #1. ${"x ".repeat(MAX_CLASSIFIED_MESSAGE_LENGTH / 2)}`), { scope: [], context: [1] });
  assert.deepEqual(intent(`Fix ${Array.from({ length: MAX_CLASSIFIED_REFERENCES + 1 }, () => "#1").join(" ")}.`), { scope: [], context: [1] });
  assert.deepEqual(intent(`Fix ${Array.from({ length: MAX_CLASSIFIED_REFERENCES }, (_, i) => `#${i % 50 + 1}`).join(" ")}.`).scope.length, 50);
  // Inputs that are quadratic for unanchored path, file-name or punctuation patterns, or for a
  // clause-by-reference scan, each stay well inside the bound.
  const near = MAX_CLASSIFIED_MESSAGE_LENGTH - 64;
  for (const filler of ["a".repeat(near), ")".repeat(near), "a.".repeat(near / 2), "(".repeat(near), "and x ".repeat(near / 6), "\"a".repeat(near / 2), "? ".repeat(near / 2),
    "#1, ".repeat(MAX_CLASSIFIED_REFERENCES) + "but ".repeat((near - 4 * MAX_CLASSIFIED_REFERENCES) / 4)]) {
    const started = performance.now();
    intent(`Fix #1 ${filler}`.slice(0, MAX_CLASSIFIED_MESSAGE_LENGTH));
    assert.ok(performance.now() - started < 1000, `${filler.slice(0, 12)}… took ${Math.round(performance.now() - started)}ms`);
  }
});

test("the split covers every reference exactly once; citing or negating a reference never grants it (#3920)", () => {
  const word = fc.constantFrom("Fix", "deliver", "see", "not", "and", "the", "bug", "(", ")", ":", ".", ",", "\n", "- ", "related", "close",
    "#1", "#2", "#3", "owner/repo#4", "https://github.com/owner/repo/issues/5", "`#6`", "elsewhere", "don't", "work on");
  fc.assert(fc.property(fc.array(word, { maxLength: 40 }), fc.constantFrom(1, 2, 3, 4, 5), (words, n) => {
    const text = words.join(" ");
    const { scope, context } = intent(text);
    assert.deepEqual([...scope, ...context].sort((a, b) => a - b), issueReferencesInMessage(text, repo));
    assert.equal(scope.some((x) => context.includes(x)), false);
    // Appending a negated mention of any issue withdraws it; a parenthetical alone grants nothing.
    assert.equal(intent(`${text}\nDon't touch #${n}.`).scope.includes(n), false);
    assert.deepEqual(intent(`(Fix #${n}.)`).scope, []);
    // A withholding lead or a negation earlier in the sentence withholds whatever the request says.
    const request = words.filter((w) => !w.includes("\n") && w !== ":").join(" ");
    assert.equal(intent(`Do not:\n- ${request} fix #${n}`).scope.includes(n), false);
    assert.equal(intent(`Background:\n- ${request} close #${n}`).scope.includes(n), false);
    // Within one sentence: a full stop legitimately ends the negation's reach.
    assert.equal(intent(`Do not fix #9 or ${request.replaceAll(".", "")} close #${n}.`).scope.includes(n), false);
  }), { numRuns: 500 });
});
