import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StructuredQuestionText, structuredQuestionSummary } from "./StructuredQuestionText.js";

test("structured question text renders safe Markdown without loading remote media", () => {
  const signed = "https://evidence.example/private/review.png?signature=secret#full";
  const html = renderToStaticMarkup(React.createElement(StructuredQuestionText, {
    children: `First paragraph.\n\n- **Review** \`build-42\`\n- ${signed}\n\n<img src=x onerror=alert(1)>`,
  }));

  assert.match(html, /<p>First paragraph\.<\/p>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<strong>Review<\/strong> <code>build-42<\/code>/);
  assert.match(html, />evidence\.example\/review\.png<\/a>/);
  assert.match(html, /href="https:\/\/evidence\.example\/private\/review\.png\?signature=secret#full"/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("historical summaries remove Markdown and bound plain URLs", () => {
  const signed = "https://evidence.example/private/review.png?signature=secret#full";
  assert.equal(
    structuredQuestionSummary(`## Review **this** [named link](https://example.com) and ${signed}\n\nMore context`),
    "Review this named link and evidence.example/review.png",
  );
  assert.equal(structuredQuestionSummary("x".repeat(200)).length, 120);
  assert.match(structuredQuestionSummary("x".repeat(200)), /…$/);
});
