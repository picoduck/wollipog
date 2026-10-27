import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSING_REFERENCE_EXCERPT_MAX, canonicalIssueReference, findClosingReferences } from "./closing-references.js";

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
  for (const text of ["Example: `closes #1`", "closes `#1`", "``a ` closes #1 ``", "`a` closes `#1`", "```\ncloses #1\n```",
    "~~~~md\ncloses #1\n~~~~", "> ```\n> closes #1\n> ```", "> > ```\n> > closes #1\n> > ```", "   ~~~\n   closes #1\n   ~~~",
    "> ```\n>\n> closes #1\n> ```", "- item\n\n  ```\n\n  closes #1\n  ```", "```\n> ```\ncloses #1\n```",
    "<details>\n\n```\ncloses #1\n```\n\n</details>", "<!-- closes #1 -->", "<!--\ncloses #1\n-->", "closes `x` #1",
    "closes <!-- x --> #1", "<!-- a --><!-- closes #7 -->", "<!-- a -- b\ncloses #1\n-->", "> <!-- closes #1 -->",
    "Text <!-- closes #1 --> more", "Text <!---->closes <!-- x --> #1", "`a` b\n`closes #1` c",
    "x `a\nb` y\n\n`closes #1`"]) {
    assert.deepEqual(issues(text), [], text);
  }
  // Outside the code, or where code or a comment never closes, the reference still counts.
  for (const text of ["`code` then closes #1", "an unmatched ` then closes #1", "```\ncode\n```\ncloses #1",
    "<!-- note --> closes #1 <!-- open", "    ```\ncloses #1", "> ``\ncloses #1", "``` x`y\ncloses #1",
    "```\ncode\n~~~\nmore\n```\ncloses #1", "- ```\ncloses #1"]) {
    assert.deepEqual(issues(text), ["team/repo#1"], text);
  }
  // Wherever this approximation of GitHub's Markdown is unsure, it reports rather than hides
  // (#3729 security reviews). Each case below is text GitHub shows, or could show.
  for (const text of [
    // An unclosed fence; one in a quote or list item also ends with its container.
    "```\nunclosed fence\ncloses #1", ">```\n>closes #1", ">    ```\ncloses #1\n```", "> ```\n> code\nThis PR does not close #1",
    "> ```\n\nThis PR does not close #1", "- item\n  ```\n  code\nThis PR does not close #1",
    "> > ```\n> code\nThis PR does not close #1",
    // A closing fence less indented than its opener closes it; the line after is visible.
    "  ```\n  code\n```\ncloses #1\n```",
    // An indented fence is read as a list item's, ending at the first less indented line; telling the
    // two apart needs a full list parser, so this one is reported though GitHub hides it.
    "   ~~~\ncloses #1\n   ~~~",
    // Raw HTML blocks are not Markdown: no fence opens inside one, and a backtick is literal.
    "<details>\n```\ncloses #1\n```\n</details>", "<div>\n`closes #1`\n</div>", "- <div>\n  ```\n  closes #1\n  ```",
    "<pre>\n\n```\n</pre>\ncloses #1\n```", "<!--\n```\n-->\ncloses #1\n```",
    // Comments: GitHub ends one at its first `-->`, even inside what would read as code; `<!-->` is
    // complete; HTML ends one at `--!>`; an inline one with `--`, ending in `-`, or crossing a line
    // may be literal text.
    "Text <!-- a `-->` closes #1 -->", "<!--> This PR does not close #1 <!-- note -->", "<!---> closes #1",
    "<!-- x --!> closes #1 -->", "Text <!-- a -- b closes #1 -->", "Text <!--> closes #1 -->", "Text <!-- x - closes #1 --->",
    "Text <!-- a\n\ncloses #1 -->", "Text <!-- a\n# closes #1 -->", "- <!-- a -- b closes #1 -->",
    // A code span crossing a line may be cut by a block that starts the next line, and pairs
    // backticks so that a later span on the next line is not what it seems.
    "Text `a\n- closes #1 `", "a `b\nc` closes #1 `d`", "Text `a\n- `x` closes #1 `y`", "x `a\nb` y\n`c` closes #1 `d`",
    "Text `a\nx` <!-- `closes #1 -->",
  ]) {
    assert.deepEqual(issues(text), ["team/repo#1"], text);
  }
});

test("a long link keeps its excerpt within the bound every consumer accepts (#3729 review)", () => {
  const [found] = findClosingReferences(`Closes [the issue](https://github.com/a/b/issues/1?${"x".repeat(1_900)}) for real.`, REPO);
  assert.equal(found!.issue, "a/b#1");
  assert.ok(found!.excerpt.length <= CLOSING_REFERENCE_EXCERPT_MAX, String(found!.excerpt.length));
  assert.match(found!.excerpt, /^Closes \[the issue\]\(https:\/\/github\.com\/a\/b\/issues\/1\?x+…$/u);
  const [emoji] = findClosingReferences(`closes [x](https://github.com/a/b/issues/2?${"😀".repeat(400)})`, REPO);
  assert.ok(emoji!.excerpt.length <= CLOSING_REFERENCE_EXCERPT_MAX);
  assert.doesNotMatch(emoji!.excerpt, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u, "no surrogate pair is split");
});

test("each finding carries one bounded line around it", () => {
  const [found] = findClosingReferences(`Intro.\n${"x".repeat(100)} This PR does not close #3635. ${"y".repeat(100)}\nNext.`,
    REPO);
  assert.equal(found!.keyword, "close");
  assert.match(found!.excerpt, /^…x+ This PR does not close #3635\. y+…$/u);
  assert.ok(found!.excerpt.length < 140);
  assert.equal(findClosingReferences("a\u0007closes #1", REPO)[0]!.excerpt, "a closes #1");
});

test("adversarial descriptions stay linear", () => {
  for (const text of [
    `${"`".repeat(1)} ${"``".repeat(20_000)} ${"`x".repeat(20_000)} closes #1`,
    // Repeated quote markers without a fence backtracked exponentially in a fence regex (#3729 review).
    `${"> ".repeat(20_000)}plain\ncloses #1`,
    `${"> ".repeat(40)}plain\n`.repeat(1_000) + "closes #1",
    `${"<!--".repeat(20_000)} closes #1`,
    `${"<!-- x -->".repeat(10_000)} closes #1`,
    `x ${"<!-- -- ".repeat(10_000)}--> closes #1`,
    `${"> ```\n".repeat(10_000)}closes #1`,
    `- a\n${"  ```\n  b\n".repeat(10_000)}closes #1`,
    `${"closes ".repeat(10_000)}#1`,
    `closes [${"x".repeat(256)}](${"y".repeat(2_048)}`.repeat(30) + " closes #1",
  ]) {
    const started = Date.now();
    assert.ok(issues(text).includes("team/repo#1"), text.slice(0, 40));
    assert.ok(Date.now() - started < 2_000, `${text.slice(0, 40)} took ${Date.now() - started} ms`);
  }
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
