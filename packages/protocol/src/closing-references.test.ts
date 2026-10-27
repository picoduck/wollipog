import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalIssueReference, findClosingReferences } from "./closing-references.js";

const REPO = "Team/Repo";
const issues = (text: string) => findClosingReferences(text, REPO).map((found) => found.issue);

test("negated, hyphenated and possessive sentences still close, as they did for #3635, #3633 and #3157", () => {
  assert.deepEqual(issues("This PR does not close #3635."), ["team/repo#3635"]);
  assert.deepEqual(issues("The second slice must not auto-close #3633"), ["team/repo#3633"]);
  assert.deepEqual(issues("This does not resolve #3157's cross-repository race."), ["team/repo#3157"]);
  assert.deepEqual(issues("It does not fix #12, and will never resolve #13"), ["team/repo#12", "team/repo#13"]);
});

test("every documented keyword closes in any case, with an optional colon", () => {
  for (const keyword of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
    assert.deepEqual(issues(`${keyword} #1`), ["team/repo#1"], keyword);
    assert.deepEqual(issues(`${keyword.toUpperCase()}: #1`), ["team/repo#1"], keyword);
  }
  assert.deepEqual(issues("closes : #1"), ["team/repo#1"]);
  assert.deepEqual(issues("closes\t#1"), ["team/repo#1"]);
  assert.deepEqual(issues("closes   #1"), ["team/repo#1"]);
});

test("references name an issue as GitHub resolves them", () => {
  assert.deepEqual(issues("Fixes octo-org/octo-repo#100"), ["octo-org/octo-repo#100"]);
  assert.deepEqual(issues("closes TEAM/REPO#7"), ["team/repo#7"]);
  assert.deepEqual(issues("closes GH-8 and closes gh-9"), ["team/repo#8", "team/repo#9"]);
  assert.deepEqual(issues("closes https://github.com/Other/Name/issues/5#issuecomment-1"), ["other/name#5"]);
  assert.deepEqual(issues("closes https://github.com/team/repo/pull/6"), ["team/repo#6"]);
  assert.deepEqual(issues("closes <https://github.com/team/repo/issues/10>"), ["team/repo#10"]);
  assert.deepEqual(issues("closes \\#11"), ["team/repo#11"]);
  assert.deepEqual(issues("closes [#12](https://example.com)"), ["team/repo#12"]);
  assert.deepEqual(issues("closes [the issue](https://github.com/team/repo/issues/13)"), ["team/repo#13"]);
  assert.deepEqual(issues("closes [#14](https://github.com/team/repo/issues/15 \"title\")"), ["team/repo#14", "team/repo#15"]);
  assert.deepEqual(issues("closes #16-part, closes #17/#3 and closes #18.5"), ["team/repo#16", "team/repo#17", "team/repo#18"]);
});

test("each keyword closes only the reference directly after it", () => {
  assert.deepEqual(issues("Closes #1, #2 and #3"), ["team/repo#1"]);
  assert.deepEqual(issues("Resolves #10, resolves #123, resolves octo-org/octo-repo#100"),
    ["team/repo#10", "team/repo#123", "octo-org/octo-repo#100"]);
  assert.deepEqual(issues("Refs #1, #2; fixes #3"), ["team/repo#3"]);
});

test("closing blocks outside code all count", () => {
  for (const text of ["## Closes #1", "- [ ] closes #1", "| a |\n|---|\n| closes #1 |", "> closes #1",
    "~~closes #1~~", "**closes #1**", "__closes #1__", "<b>closes #1</b>",
    "<details><summary>x</summary>\n\ncloses #1\n\n</details>", "text  \ncloses #1"]) {
    assert.deepEqual(issues(text), ["team/repo#1"], text);
  }
});

test("forms GitHub measurably ignores are not reported", () => {
  for (const text of ["Refs #1", "See #1", "fail closed (#1)", "closes (#1)", "closes#1", "closes:#1",
    "This does not close\n#1", "closes #1", "**Closes:** #1", "**Closes** #1", "_closes_ #1",
    "[closes](https://example.com) #1", "closes http://github.com/team/repo/issues/1",
    "closing #1", "disclosed #1", "enclosed #1", "closest #1", "unfixed #1", "prefix #1", "fixed #12abc",
    "closes #", "closes #0"]) {
    assert.deepEqual(issues(text), [], text);
  }
});

test("code and HTML comments in a Markdown description do not close", () => {
  for (const text of ["Example: `closes #1`", "closes `#1`", "``a ` closes #1 ``", "```\ncloses #1\n```",
    "~~~~md\ncloses #1\n~~~~", "> ```\n> closes #1\n> ```", "```\nunclosed fence\ncloses #1",
    "<!-- closes #1 -->", "<!--\ncloses #1\n-->", "closes `x` #1", "closes <!-- x --> #1"]) {
    assert.deepEqual(issues(text), [], text);
  }
  // Outside the code, or in a code span that never closes, the reference still counts.
  assert.deepEqual(issues("`code` then closes #1"), ["team/repo#1"]);
  assert.deepEqual(issues("an unmatched ` then closes #2"), ["team/repo#2"]);
  assert.deepEqual(issues("`span\n\nends` closes #3"), ["team/repo#3"]);
  assert.deepEqual(issues("```\ncode\n```\ncloses #4"), ["team/repo#4"]);
  assert.deepEqual(issues("<!-- note --> closes #5 <!-- open"), ["team/repo#5"]);
  // Indented code is still reported: telling it apart from list text needs a full parser.
  assert.deepEqual(issues("Text\n\n    closes #6"), ["team/repo#6"]);
});

test("each finding carries one bounded line around it", () => {
  const [found] = findClosingReferences(`Intro.\n${"x".repeat(100)} This PR does not close #3635. ${"y".repeat(100)}\nNext.`,
    REPO);
  assert.equal(found!.keyword, "close");
  assert.match(found!.excerpt, /^…x+ This PR does not close #3635\. y+…$/u);
  assert.ok(found!.excerpt.length < 140);
  assert.equal(findClosingReferences("a\u0007closes #1", REPO)[0]!.excerpt, "a closes #1");
});

test("adversarial backticks stay linear", () => {
  const text = `${"`".repeat(1)} ${"``".repeat(20_000)} ${"`x".repeat(20_000)} closes #1`;
  const started = Date.now();
  assert.deepEqual(issues(text), ["team/repo#1"]);
  assert.ok(Date.now() - started < 2_000);
});

test("issue references canonicalize for declared closures", () => {
  assert.equal(canonicalIssueReference("#5", "Team/Repo"), "team/repo#5");
  assert.equal(canonicalIssueReference(" Team/Repo#6 "), "team/repo#6");
  assert.equal(canonicalIssueReference("https://github.com/Team/Repo/issues/7"), "team/repo#7");
  for (const value of ["#5", "5", "team/repo#0", "team/repo#x", "http://github.com/team/repo/issues/7", "team#5"]) {
    assert.equal(canonicalIssueReference(value), null, value);
  }
  assert.throws(() => findClosingReferences("closes #1", "not-a-repository"));
});
