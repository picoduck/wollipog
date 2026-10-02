import assert from "node:assert/strict";
import test from "node:test";
import {
  codeHighlighterRuns,
  createCodeHighlighter,
  hasFencedCode,
  highlightCodeBlock,
  HighlightCache,
  loadCodeHighlighter,
  loadedCodeHighlighter,
  markdownBlockHash,
  markdownHighlightEligible,
  MARKDOWN_HIGHLIGHT_MAX_BYTES,
  utf8ByteLengthExceeds,
  type CodeHighlighter,
} from "./markdown-highlight.js";

test("highlight eligibility requires a visible fenced block within the exact UTF-8 ceiling", () => {
  assert.equal(hasFencedCode("inline ```js code```"), false);
  assert.equal(hasFencedCode("  ```js\nconst answer = 42;\n```"), true);
  assert.equal(hasFencedCode("~~~ts\nconst answer = 42;\n~~~"), true);
  assert.equal(markdownHighlightEligible("```js\nconst answer = 42;\n```", false), false);
  assert.equal(markdownHighlightEligible("ordinary **Markdown**", true), false);

  const fenceBytes = "```js\n".length + "\n```".length;
  const atLimit = `\`\`\`js\n${"a".repeat(MARKDOWN_HIGHLIGHT_MAX_BYTES - fenceBytes)}\n\`\`\``;
  assert.equal(markdownHighlightEligible(atLimit, true), true);
  assert.equal(markdownHighlightEligible(`${atLimit}a`, true), false);
  assert.equal(utf8ByteLengthExceeds("é", 1), true);
  assert.equal(utf8ByteLengthExceeds("é", 2), false);
  assert.equal(utf8ByteLengthExceeds("😀", 3), true);
  assert.equal(utf8ByteLengthExceeds("😀", 4), false);
});

test("a block's hash depends on both its language and its text", () => {
  assert.equal(markdownBlockHash("ts", "const a = 1;"), markdownBlockHash("ts", "const a = 1;"));
  assert.notEqual(markdownBlockHash("ts", "const a = 1;"), markdownBlockHash("js", "const a = 1;"));
  assert.notEqual(markdownBlockHash("ts", "const a = 1;"), markdownBlockHash("ts", "const a = 2;"));
  // The separator keeps a language/text split from colliding with another split of the same chars.
  assert.notEqual(markdownBlockHash("t", "sx"), markdownBlockHash("ts", "x"));
});

test("the highlight cache is bounded, least-recently-used first, and verifies text on a hit", () => {
  const cache = new HighlightCache(2);
  const nodes = [{ type: "text", value: "a" }];
  cache.set("ts", "a", nodes);
  cache.set("ts", "b", null);
  assert.equal(cache.get("ts", "a")?.nodes, nodes, "a hit returns the cached nodes and refreshes the entry");
  cache.set("ts", "c", []);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("ts", "b"), undefined, "the least recently used entry is evicted");
  assert.ok(cache.get("ts", "a"));
  assert.ok(cache.get("ts", "c"));
  assert.equal(cache.get("js", "a"), undefined, "the same text in another language is a different block");
});

test("the block highlighter wraps rehype-highlight and reports unknown languages as null", async () => {
  const highlighter = await loadCodeHighlighter();
  const nodes = highlighter("ts", "const a = 1;\n");
  assert.ok(nodes);
  const keyword = nodes.find((node) => node.type === "element");
  assert.deepEqual(keyword?.properties?.className, ["hljs-keyword"]);
  const text = (list: readonly { value?: string; children?: unknown[] }[]): string =>
    list.map((node) => node.value ?? text((node.children ?? []) as never)).join("");
  assert.equal(text(nodes), "const a = 1;\n", "highlighting never changes the characters");
  assert.equal(highlighter("not-a-language", "x"), null);
  assert.equal(loadedCodeHighlighter(), highlighter);
});

test("highlightCodeBlock runs the highlighter once per block and serves repeats from the cache", () => {
  let calls = 0;
  const fake: CodeHighlighter = (_language, text) => {
    calls += 1;
    return [{ type: "text", value: text }];
  };
  const text = `cache-test-${Date.now()}`;
  assert.equal(highlightCodeBlock("ts", text, null), undefined, "without a highlighter an unseen block stays plain");
  const runs = codeHighlighterRuns();
  const first = highlightCodeBlock("ts", text, fake);
  const second = highlightCodeBlock("ts", text, fake);
  const withoutHighlighter = highlightCodeBlock("ts", text, null);
  assert.equal(calls, 1);
  assert.equal(codeHighlighterRuns(), runs + 1);
  assert.equal(second, first);
  assert.equal(withoutHighlighter, first, "a cached block needs no highlighter at all");

  const throwing: CodeHighlighter = () => { throw new Error("parser failure"); };
  assert.equal(highlightCodeBlock("ts", `${text}-throws`, throwing), null, "a parser failure leaves plain code");
});

test("createCodeHighlighter hands the transform a pre > code tree and returns the code's children", () => {
  const highlighter = createCodeHighlighter((tree, file) => {
    const code = tree.children![0]!.children![0]!;
    assert.equal(code.tagName, "code");
    assert.deepEqual(code.properties?.className, ["language-rust"]);
    if (code.children![0]!.value === "unknown") file.message();
    else code.children = [{ type: "element", tagName: "span", properties: { className: ["hljs-keyword"] }, children: [] }];
  });
  assert.equal(highlighter("rust", "fn")![0]!.tagName, "span");
  assert.equal(highlighter("rust", "unknown"), null);
});
