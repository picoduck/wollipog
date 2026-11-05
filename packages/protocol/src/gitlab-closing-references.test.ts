import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSING_REFERENCE_EXCERPT_MAX } from "./closing-references.js";
import { canonicalGitLabIssueReference, findGitLabClosingReferences } from "./gitlab-closing-references.js";

const REPO = "GitLab.Example.com/Team/Sub/Repo";
const issues = (text: string) => findGitLabClosingReferences(text, REPO).map((found) => found.issue);
const at = (number: number) => `gitlab.example.com/team/sub/repo#${number}`;

test("negated sentences still close, as on GitHub", () => {
  assert.deepEqual(issues("This MR does not close #12."), [at(12)]);
  assert.deepEqual(issues("It must not auto-close #13"), [at(13)]);
  assert.deepEqual(issues("This does not resolve #14, and will never fix #15"), [at(14), at(15)]);
});

test("every keyword of GitLab's default pattern closes, including -ing forms and Implements", () => {
  const keywords = ["close", "closes", "closed", "closing", "fix", "fixes", "fixed", "fixing",
    "resolve", "resolves", "resolved", "resolving", "implement", "implements", "implemented", "implementing"];
  for (const keyword of keywords) {
    assert.deepEqual(issues(`${keyword} #1`), [at(1)], keyword);
    assert.deepEqual(issues(`${keyword[0]!.toUpperCase()}${keyword.slice(1)}: #1`), [at(1)], keyword);
    // GitLab's pattern accepts only an initial capital; any other case is reported anyway.
    assert.deepEqual(issues(`${keyword.toUpperCase()} #1`), [at(1)], keyword);
  }
  assert.deepEqual(issues("Implementing #4 here"), [at(4)]);
  assert.deepEqual(issues("closes\t#1"), [at(1)]);
  assert.deepEqual(issues("closes   #1"), [at(1)]);
  assert.deepEqual(issues("Closes issue #2 and issues #3"), [at(2), at(3)]);
});

test("one keyword closes every reference in a comma- or and-separated list", () => {
  assert.deepEqual(issues("Closes #1, #2 and #3"), [at(1), at(2), at(3)]);
  assert.deepEqual(issues("Closes #1, #2, and #3"), [at(1), at(2), at(3)]);
  assert.deepEqual(issues("Fixes #1 #2,#3#4"), [at(1), at(2), at(3), at(4)]);
  // An external tracker's key names no GitLab issue but continues the list.
  assert.deepEqual(issues("Closes ABC-12, #5"), [at(5)]);
  // A list ends at anything else.
  assert.deepEqual(issues("Closes #1 and then #2"), [at(1)]);
  assert.deepEqual(issues("Closes #1 andrew #2"), [at(1)]);
});

test("cross-project references and URLs name issues as GitLab resolves them", () => {
  assert.deepEqual(issues("Closes other/project#7"), ["gitlab.example.com/other/project#7"]);
  assert.deepEqual(issues("Closes Group/Deep/Project#8"), ["gitlab.example.com/group/deep/project#8"]);
  // A project without a namespace is in this project's namespace.
  assert.deepEqual(issues("Closes sibling#9"), ["gitlab.example.com/team/sub/sibling#9"]);
  assert.deepEqual(issues("Closes https://gitlab.example.com/team/sub/repo/-/issues/10#note_1"), [at(10)]);
  assert.deepEqual(issues("Closes http://GITLAB.example.com/a/b/issues/11"), ["gitlab.example.com/a/b#11"]);
  assert.deepEqual(issues("Closes https://gitlab.example.com/a/b/-/work_items/12"), ["gitlab.example.com/a/b#12"]);
  assert.deepEqual(issues("Closes https://gitlab.example.com/a/b/-/issues/incident/13"), ["gitlab.example.com/a/b#13"]);
  // Another instance's URL is not a reference this one resolves, but the list goes on past it.
  assert.deepEqual(issues("Closes https://other.example.com/a/b/-/issues/14 and #15"), [at(15)]);
  assert.deepEqual(issues("Closes https://gitlab.example.com/a/b/-/merge_requests/16"), []);
});

test("GitLab reads raw text: code and comments hide nothing", () => {
  assert.deepEqual(issues("```\ncloses #1\n```"), [at(1)]);
  assert.deepEqual(issues("<!-- closes #2 -->"), [at(2)]);
  assert.deepEqual(issues("Run `fixes #3` to see"), [at(3)]);
});

test("text that is not a closing statement closes nothing", () => {
  assert.deepEqual(issues("Refs #1. See #2. disclose #3. prefix #4. closes#5. Closes:#6. closes (#7)"), []);
  assert.deepEqual(issues("closes\n#8"), []);
  assert.deepEqual(issues("Closes !9, a merge request"), []);
  assert.deepEqual(issues("**Closes** #10"), []);
});

test("each finding carries its keyword, offset and line", () => {
  const [found] = findGitLabClosingReferences("Intro.\nThis does not close #12 at all.\nMore.", REPO);
  assert.equal(found!.keyword, "close");
  assert.equal(found!.excerpt, "This does not close #12 at all.");
  const long = `${"x".repeat(400)} closes #1 ${"y".repeat(400)}`;
  assert.ok(findGitLabClosingReferences(long, REPO)[0]!.excerpt.length <= CLOSING_REFERENCE_EXCERPT_MAX);
  // One keyword, several issues: each is reported with the same keyword offset.
  assert.deepEqual(findGitLabClosingReferences("Closes #1 and #2", REPO).map((item) => item.index), [0, 0]);
  assert.throws(() => findGitLabClosingReferences("closes #1", "team/repo"));
});

test("canonical references name a GitLab issue on the project's instance", () => {
  assert.equal(canonicalGitLabIssueReference("#12", REPO), at(12));
  assert.equal(canonicalGitLabIssueReference(" sibling#3 ", REPO), "gitlab.example.com/team/sub/sibling#3");
  assert.equal(canonicalGitLabIssueReference("Other/Project#4", REPO), "gitlab.example.com/other/project#4");
  assert.equal(canonicalGitLabIssueReference("gitlab.example.com/team/sub/repo#5", REPO), at(5));
  assert.equal(canonicalGitLabIssueReference("GitLab.Example.com/Team/Sub/Repo#5", REPO), at(5));
  assert.equal(canonicalGitLabIssueReference("https://gitlab.example.com/team/sub/repo/-/issues/6", REPO), at(6));
  for (const refused of ["https://other.example.com/a/b/-/issues/1", "gitlab.example.com/repo#1", "#0", "12", "ABC-1",
    "https://github.com/a/b/issues/1", "closes #1"]) {
    assert.equal(canonicalGitLabIssueReference(refused, REPO), null, refused);
  }
  assert.equal(canonicalGitLabIssueReference("#1", "team/repo"), null);
});
