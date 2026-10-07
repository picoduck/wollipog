import assert from "node:assert/strict";
import { test } from "node:test";
import { plainTextPreview } from "./index.js";

test("plain text passes through, whitespace collapsed to one line", () => {
  assert.equal(plainTextPreview("Running activity 1"), "Running activity 1");
  assert.equal(plainTextPreview("  First line\r\n\n  second   line\rthird "), "First line second line third");
  assert.equal(plainTextPreview(""), "");
  assert.equal(plainTextPreview(null), "");
  assert.equal(plainTextPreview(undefined), "");
});

test("block syntax goes and its words stay", () => {
  assert.equal(plainTextPreview("## Summary ##\nAll tests pass."), "Summary All tests pass.");
  assert.equal(plainTextPreview("> quoted\n>> nested"), "quoted nested");
  assert.equal(plainTextPreview("- one\n* two\n+ three\n1. four\n2) five"), "one two three four five");
  assert.equal(plainTextPreview("- [x] Done\n- [ ] Next"), "Done Next");
  assert.equal(plainTextPreview("Title\n=====\nBody\n---\n***\nEnd"), "Title Body End");
  assert.equal(plainTextPreview("See [docs][1].\n\n[1]: https://example.com/docs"), "See docs.");
  assert.equal(plainTextPreview("Issue #42 is fixed"), "Issue #42 is fixed");
});

test("emphasis markers go, but snake_case, arithmetic and code keep their characters", () => {
  assert.equal(plainTextPreview("**Bold**, *italic*, __strong__, _em_ and ~~gone~~"), "Bold, italic, strong, em and gone");
  assert.equal(plainTextPreview("Renamed user_id to account_id"), "Renamed user_id to account_id");
  assert.equal(plainTextPreview("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24");
  assert.equal(plainTextPreview("Edited `__init__.py` and `a*b*c`"), "Edited __init__.py and a*b*c");
  assert.equal(plainTextPreview("Use ``code with ` tick``"), "Use code with ` tick");
  assert.equal(plainTextPreview("Escaped \\*stars\\* and \\_under\\_"), "Escaped *stars* and _under_");
});

test("fenced code keeps its code and loses the fence", () => {
  assert.equal(plainTextPreview("Run this:\n```bash\npnpm test\n```\nThen push."), "Run this: pnpm test Then push.");
  assert.equal(plainTextPreview("~~~\nconst x = 1;\n~~~"), "const x = 1;");
  assert.equal(plainTextPreview("```\n# not a heading\n- **kept** \\* as is\n```"), "# not a heading - **kept** \\* as is");
  assert.equal(plainTextPreview("Matched `\\d+\\.` in `a_b_`"), "Matched \\d+\\. in a_b_");
});

test("links and images keep their text", () => {
  assert.equal(plainTextPreview("Read [the guide](https://example.com/guide \"Guide\") first"), "Read the guide first");
  assert.equal(plainTextPreview("![Screenshot](shot.png) attached"), "Screenshot attached");
  assert.equal(plainTextPreview("Visit <https://example.com>"), "Visit https://example.com");
  assert.equal(plainTextPreview("As noted[^1]."), "As noted.");
});

test("a construct the 240-character cut ended inside still reads as text", () => {
  assert.equal(plainTextPreview("Opened [the pull request](https://github.com/picoduck/wol"), "Opened the pull request");
  assert.equal(plainTextPreview("Running `pnpm test --filt"), "Running pnpm test --filt");
  assert.equal(plainTextPreview("Here is the diff:\n```diff\n- old"), "Here is the diff: - old");
  assert.equal(plainTextPreview("This is **important"), "This is important");
});

test("tables lose their rules and pipes, and HTML its common tags", () => {
  assert.equal(plainTextPreview("| Name | Status |\n| --- | :---: |\n| api | passing |"), "Name Status api passing");
  assert.equal(plainTextPreview("Line one<br>line two <strong>done</strong>"), "Line one line two done");
  assert.equal(plainTextPreview("Returns Vec<String> or Option<T>"), "Returns Vec<String> or Option<T>");
  assert.equal(plainTextPreview("Fish &amp; chips &lt;3"), "Fish & chips <3");
});
