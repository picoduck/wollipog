import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Markdown,
  markdownCodeBlockContinues,
  markdownCodeLanguage,
  markdownCodeText,
  markdownCodeWrapsByDefault,
  transcriptMediaKind,
} from "./Markdown.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("block continuation is same-language prefix growth or shrinkage, never a replacement", () => {
  const seen = { language: "text", text: "draft body" };
  assert.equal(markdownCodeBlockContinues(seen, { language: "text", text: "draft body plus a streamed chunk" }), true);
  assert.equal(markdownCodeBlockContinues(seen, { language: "text", text: "draft" }), true);
  assert.equal(markdownCodeBlockContinues(seen, { language: "text", text: "draft body" }), true);
  assert.equal(markdownCodeBlockContinues(seen, { language: "text", text: "another document entirely" }), false);
  assert.equal(markdownCodeBlockContinues(seen, { language: "markdown", text: "draft body" }), false);
  assert.equal(markdownCodeBlockContinues({ language: "js", text: "const a = 1;" }, { language: "python", text: "b = 2" }), false);
});

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

test("transcript media classification uses HTTPS path extensions and ignores signatures", () => {
  for (const href of [
    "https://evidence.example/review.PNG",
    "https://evidence.example/review.jpg?X-Amz-Signature=secret",
    "https://evidence.example/review.jpeg#full",
    "https://evidence.example/review.gif?download=1",
    "https://evidence.example/review.webp",
  ]) assert.equal(transcriptMediaKind(href), "image", href);
  for (const href of [
    "https://evidence.example/review.mp4?X-Amz-Signature=secret",
    "https://evidence.example/review.WEBM#clip",
  ]) assert.equal(transcriptMediaKind(href), "video", href);

  for (const href of [
    "http://evidence.example/review.png",
    "https://evidence.example/download?file=review.png",
    "https://evidence.example/review.png.exe",
    "/local/review.png",
    "not a URL",
  ]) assert.equal(transcriptMediaKind(href), null, href);
});

test("transcript media opt-in keeps links and adds bounded native image/video elements", () => {
  const image = "https://evidence.example/review.png?X-Amz-Signature=redacted";
  const video = "https://evidence.example/review.webm?X-Amz-Signature=redacted";
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    children: `${image}\n\n${video}`,
  }));

  assert.match(html, new RegExp(`href="${image.replaceAll("?", "\\?")}"`));
  assert.match(html, /<img class="md-media-image"[^>]*src="https:\/\/evidence\.example\/review\.png[^>]*loading="lazy"/);
  assert.match(html, /<video class="md-media-video"[^>]*src="https:\/\/evidence\.example\/review\.webm[^>]*controls=""[^>]*playsInline=""[^>]*preload="metadata"/);
  assert.doesNotMatch(html, /autoplay/);
});

test("inline code stays action-free", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { children: "Use `const answer = 42` inline." }));
  assert.match(html, /<code>const answer = 42<\/code>/);
  assert.doesNotMatch(html, /Copy Code/);
});

test("prose-oriented fences wrap by default with a No Wrap escape hatch", () => {
  const longProse =
    "This fenced issue draft is one very long paragraph that would otherwise force horizontal scrolling in the transcript.";
  for (const fence of ["```", "```text", "```markdown"]) {
    const html = renderToStaticMarkup(React.createElement(Markdown, {
      children: [fence, longProse, "```"].join("\n"),
    }));
    assert.match(html, /<div class="md-code-block md-code-wrap">/, fence);
    assert.match(html, />No Wrap</, fence);
    assert.doesNotMatch(html, />Wrap Lines</, fence);
  }
});

test("source-code fences keep the non-wrapping default and offer Wrap Lines", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    children: ["```js", "const answer = veryLongExpression(1, 2, 3);", "```"].join("\n"),
  }));
  assert.match(html, /<div class="md-code-block">/);
  assert.doesNotMatch(html, /md-code-wrap"/);
  assert.doesNotMatch(html, />No Wrap</);
  assert.match(html, /<button type="button" class="copy-btn md-code-wrap-toggle">Wrap Lines<\/button>/);
});

test("fence language detection reads react-markdown and rehype-highlight class shapes", () => {
  assert.equal(markdownCodeLanguage(React.createElement("code", { className: "language-js" }, "x")), "js");
  assert.equal(markdownCodeLanguage(React.createElement("code", { className: "hljs language-TypeScript" }, "x")), "typescript");
  assert.equal(markdownCodeLanguage([" ", React.createElement("code", { className: "language-md" }, "x")]), "md");
  assert.equal(markdownCodeLanguage(React.createElement("code", null, "x")), "");
  assert.equal(markdownCodeWrapsByDefault(""), true);
  assert.equal(markdownCodeWrapsByDefault("plaintext"), true);
  assert.equal(markdownCodeWrapsByDefault("Markdown"), true);
  assert.equal(markdownCodeWrapsByDefault("js"), false);
  assert.equal(markdownCodeWrapsByDefault("python"), false);
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
