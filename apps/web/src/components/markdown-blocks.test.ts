import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown.js";
import { markdownBlockStarts } from "./markdown-blocks.js";

/**
 * A streaming reply renders block by block (#2763). Cutting it must never change what it shows:
 * a document that starts out streaming (`settled={false}`, rendered blockwise) produces exactly the
 * markup of the same text rendered whole. Highlighting and media both wait for settlement, so with
 * highlighting off the two paths differ only in how the text was cut.
 */

const whole = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { highlightEligible: false, children: text }));
const blockwise = (text: string) =>
  renderToStaticMarkup(React.createElement(Markdown, { highlightEligible: false, settled: false, children: text }));

function assertSameMarkup(text: string) {
  assert.equal(blockwise(text), whole(text), `cut at ${JSON.stringify(markdownBlockStarts(text))}:\n${text}`);
}

const cases: Record<string, string> = {
  paragraphs: "First paragraph\nwith a break.\n\nSecond **bold** paragraph.\n\n\nThird after two blank lines.",
  headings: "# Title\n\nIntro text.\n\n## Section\n\nBody\n===\n\nAfter a setext heading.\n\n---\n\nAfter a rule.",
  fences: "Before.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.\n\n~~~\nunclosed tilde fence\n\nstill code",
  "fence inside a list": "- item\n\n  ```\n  code\n\n  more\n  ```\n\nAfter the list.",
  "loose list": "- one\n\n- two\n\n  continued\n\n1. first\n\n2) second\n\nParagraph.",
  "indented code": "Text.\n\n    code line\n\n    more code\n\nText again.",
  blockquotes: "> quoted\n> lazy\n\n> second quote\n\nPlain.",
  tables: "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
  "task lists": "- [x] done\n- [ ] todo\n\nNotes.",
  html: "<div>\n\nnot rendered\n\n</div>\n\nAfter.",
  "reference definitions": "See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com/docs",
  footnotes: "A claim.[^1]\n\nMore.\n\n[^1]: The source.",
  "inline code with backticks": "Use ```not a fence``` here.\n\nNext paragraph.",
  "emphasis at line start": "*emphasis* first\n\n*more* here\n\n* a real item",
  // Found by the generator: an empty list item in a quote parses differently after indented code.
  "quote after indented code": "    alpha\n\n> *\n\n# alpha",
  // Found by the generator: a fence indented into a list item is not closed by an unindented one.
  "fence in a list item, then an unindented fence": "+\n  ``` alpha\n```\n| a | b |\n| - | - |\n\n\n```\n\nText.",
  // Found in review: definitions the guard must see however their label is written or placed.
  "multiline reference label": "See [foo bar].\n\nMiddle.\n\n[foo\nbar]: /target",
  "escaped bracket in a reference label": "See [a\\]b].\n\nMiddle.\n\n[a\\]b]: /target",
  "reference definition in a quote": "See [quoted].\n\nMiddle.\n\n> [quoted]: /target",
  "streamed so far": "The quick brown fox jumps over the lazy dog while the agent streams **markdown** with `code`\n\n```ts\nconst x1 = 1;\n```\n\nThe quick brown",
};

for (const [name, text] of Object.entries(cases)) {
  test(`blockwise rendering matches whole rendering: ${name}`, () => assertSameMarkup(text));
}

test("documents with raw HTML, definitions or footnotes are never cut", () => {
  for (const name of ["html", "reference definitions", "footnotes", "multiline reference label",
    "escaped bracket in a reference label", "reference definition in a quote"]) {
    assert.deepEqual(markdownBlockStarts(cases[name]!), [0], name);
  }
  assert.deepEqual(markdownBlockStarts(cases.paragraphs!).length, 3, "ordinary paragraphs are cut");
  assert.deepEqual(markdownBlockStarts(cases["loose list"]!), [0], "never next to a list");
  const fences = cases.fences!;
  assert.deepEqual(markdownBlockStarts(fences), [0, fences.indexOf("```ts"), fences.indexOf("After."), fences.indexOf("~~~")],
    "around fences, never inside one");
});

test("every prefix of a streamed reply renders blockwise exactly as whole", () => {
  const reply = Object.values(cases).filter((text) => markdownBlockStarts(text).length > 1).join("\n\n");
  for (let end = 1; end <= reply.length; end += 7) assertSameMarkup(reply.slice(0, end));
});

test("generated documents render blockwise exactly as whole", () => {
  const word = fc.constantFrom("alpha", "**bold**", "`code`", "_em_", "[link](https://example.com)", "1.", "-", "*", ">", "|", "x");
  const line = fc.array(word, { minLength: 1, maxLength: 5 }).map((words) => words.join(" "));
  const block = fc.oneof(
    line,
    line.map((text) => `# ${text}`),
    line.map((text) => `- ${text}`),
    line.map((text) => `1. ${text}`),
    line.map((text) => `> ${text}`),
    line.map((text) => `    ${text}`),
    line.map((text) => `  ${text}`),
    fc.constant("```"),
    fc.constant("~~~ts"),
    fc.constant("---"),
    fc.constant("==="),
    fc.constant("| a | b |\n| - | - |"),
    fc.constant(""),
  );
  const separator = fc.constantFrom("\n", "\n\n", "\n\n\n", "\n \n");
  fc.assert(
    fc.property(fc.array(fc.tuple(block, separator), { minLength: 1, maxLength: 14 }), (parts) => {
      assertSameMarkup(parts.map(([text, gap]) => text + gap).join(""));
    }),
    { numRuns: 1500 },
  );
});
