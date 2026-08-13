import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, markdownCodeText } from "./Markdown.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("safe Markdown renders immediately without synchronous highlighting or active images", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    highlightEligible: true,
    children: [
      "```js",
      "const answer = 42;",
      "```",
      "<script>globalThis.compromised = true</script>",
      "![tracking pixel](https://attacker.example/pixel.png)",
    ].join("\n"),
  }));

  assert.match(html, /<div class="md-code-block">/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /aria-label="Copy Code Block"/);
  assert.doesNotMatch(html, / node=/);
  assert.doesNotMatch(html, /hljs/);
  assert.doesNotMatch(html, /<script|<img/i);
  assert.match(html, /class="md-img-link"/);
  assert.match(html, /href="https:\/\/attacker\.example\/pixel\.png"/);
});

test("inline code stays action-free", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { children: "Use `const answer = 42` inline." }));
  assert.match(html, /<code>const answer = 42<\/code>/);
  assert.doesNotMatch(html, /Copy Code/);
});

test("code-block copy reconstructs exact highlighted text without renderer newline", () => {
  const highlighted = React.createElement("code", null, [
    React.createElement("span", { key: "a" }, "const value"),
    " = ",
    React.createElement("span", { key: "b" }, "1"),
    ";\n",
  ]);
  assert.equal(markdownCodeText(highlighted), "const value = 1;");
  assert.equal(markdownCodeText(React.createElement("code", null, "line\n\n")), "line\n");
});
