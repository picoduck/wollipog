import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  compactMarkdownUrlLabel,
  formatTranscriptMediaDuration,
  Markdown,
  markdownContentCache,
  markdownCodeBlockContinues,
  markdownCodeLanguage,
  markdownCodeText,
  markdownCodeWrapsByDefault,
  transcriptMediaExpiry,
  transcriptMediaKind,
  transcriptMediaLabel,
} from "./Markdown.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("cache hits preserve GFM, raw HTML and URL security, and separate the inline profile", () => {
  const source = ["# Cached Security 2771", "", "| Item | Result |", "| --- | --- |", "| **safe** | ~~old~~ |", "",
    "[unsafe](javascript:alert%281%29) ![unsafe](javascript:alert%281%29)",
    "", "<script>globalThis.cachedCompromise = true</script>"].join("\n");
  const render = (profile: "document" | "inline") => renderToStaticMarkup(React.createElement(Markdown, {
    profile, children: source, highlightEligible: false,
  }));
  const cold = render("document");
  const first = markdownContentCache.snapshot();
  assert.equal(render("document"), cold);
  assert.equal(markdownContentCache.snapshot().parses, first.parses);
  assert.match(cold, /<table>/);
  assert.match(cold, /<h1>/);
  assert.doesNotMatch(cold, /<script|<img|href="javascript:/i);
  const inline = render("inline");
  assert.doesNotMatch(inline, /<table|<h1|<script|<img|href="javascript:/i);
  assert.equal(render("inline"), inline);
  assert.equal(markdownContentCache.snapshot().parses, first.parses + 1);
});

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
  assert.match(html, /aria-label="Copy Code"/);
  assert.doesNotMatch(html, / node=/);
  assert.doesNotMatch(html, /hljs/);
  assert.doesNotMatch(html, /<script|<img/i);
  assert.match(html, /<a class="md-img-link"[^>]*><svg[^>]*class="[^"]*lucide-image app-icon"[^>]*>.*<\/svg>tracking pixel<\/a>/);
  assert.match(html, /href="https:\/\/attacker\.example\/pixel\.png"/);
  assert.doesNotMatch(html, /\u{1F5BC}/u);
});

test("compact URL rendering hides signatures while retaining exact safe destinations", () => {
  const signed = "https://evidence.example/private/mobile-capture.png?X-Amz-Signature=secret#review";
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    compactUrls: true,
    children: `Plain ${signed}\n\n[Named evidence](${signed})`,
  }));

  assert.equal(compactMarkdownUrlLabel(signed), "evidence.example/mobile-capture.png");
  assert.equal((html.match(/href="https:\/\/evidence\.example\/private\/mobile-capture\.png\?X-Amz-Signature=secret#review"/g) ?? []).length, 2);
  assert.match(html, />evidence\.example\/mobile-capture\.png<\/a>/);
  assert.match(html, />Named evidence<\/a>/);
  assert.equal((html.match(/X-Amz-Signature=secret/g) ?? []).length, 2,
    "the signature appears only in the two retained href attributes");
  assert.doesNotMatch(html, /<img|<video/);
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

test("transcript media labels prefer author text and otherwise omit signed query strings", () => {
  const signed = "https://evidence.example/reviews/session%20capture.png?X-Amz-Signature=secret";
  assert.equal(transcriptMediaLabel(signed, "image"), "session capture.png");
  assert.equal(transcriptMediaLabel(signed, "image", signed), "session capture.png");
  assert.equal(transcriptMediaLabel(signed, "image", "Reviewed layout"), "Reviewed layout");
  const unicodeSigned = "https://evidence.example/caf%C3%A9.png?X-Amz-Signature=secret";
  assert.equal(transcriptMediaLabel(unicodeSigned, "image", "https://evidence.example/café.png?X-Amz-Signature=secret"), "café.png");
  assert.equal(transcriptMediaLabel("https://evidence.example/%E2%80%AEreview.png", "image"), "review.png");
  assert.equal(transcriptMediaLabel("https://evidence.example/%00review.webm", "video"), "review.webm");
  assert.equal(transcriptMediaLabel("not a URL", "video"), "Video");
});

test("generated transcript media labels remove invisible Unicode without rewriting author text", () => {
  const unsafeCharacters = [0x200b, 0x200c, 0x200d, 0x2028, 0x2029]
    .map((codePoint) => String.fromCodePoint(codePoint)).join("");
  const encodedUnsafe = [...unsafeCharacters].map((character) => encodeURIComponent(character)).join("");
  const encoded = `https://evidence.example/session${encodedUnsafe}review.png?X-Amz-Signature=secret`;
  const raw = `https://evidence.example/session${unsafeCharacters}review.png?X-Amz-Signature=secret`;
  assert.equal(transcriptMediaLabel(encoded, "image"), "sessionreview.png");
  assert.equal(transcriptMediaLabel(raw, "image"), "sessionreview.png");

  const authorLabel = `Reviewed${unsafeCharacters} Layout`;
  assert.equal(transcriptMediaLabel(encoded, "image", authorLabel), authorLabel,
    "generated-label hardening does not rewrite explicit author text");
  assert.equal(transcriptMediaLabel("https://evidence.example/%E2%80review.png", "image"), "%E2%80review.png",
    "malformed percent encoding remains a defensive raw basename");
  assert.equal(transcriptMediaLabel(`https://evidence.example/${encodedUnsafe}`, "video"), "Video",
    "an empty sanitized basename uses the stable kind fallback");

  const imageMarkup = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    children: `![](${encoded})`,
  }));
  assert.match(imageMarkup, /<img class="md-media-image"[^>]*alt=""/,
    "an intentionally empty image alt remains decorative after generated-label sanitization");
  assert.match(imageMarkup, /<span class="md-media-name"[^>]*>sessionreview\.png<\/span>/);

  const video = `https://evidence.example/session${encodedUnsafe}review.webm?X-Amz-Signature=secret`;
  const videoMarkup = renderToStaticMarkup(React.createElement(Markdown, { inlineMedia: true, children: video }));
  assert.match(videoMarkup, /<video class="md-media-video"[^>]*aria-label="sessionreview\.webm"/);
});

test("transcript media renders as captioned figures whose visible text omits the signed query", () => {
  const image = "https://evidence.example/review.png?X-Amz-Signature=redacted";
  const video = "https://evidence.example/review.webm?X-Amz-Signature=redacted";
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    children: `${image}\n\n${video}`,
  }));

  assert.equal(html.match(/<figure class="md-media"/g)?.length, 2);
  assert.doesNotMatch(html, /<p>\s*<figure|<figure[^>]*>(?:(?!<\/figure>).)*<\/p>/, "a figure never sits inside a paragraph");
  assert.match(html, /<img class="md-media-image"[^>]*src="https:\/\/evidence\.example\/review\.png[^>]*alt="review\.png"[^>]*loading="lazy"/);
  assert.match(html, /<video class="md-media-video"[^>]*src="https:\/\/evidence\.example\/review\.webm[^>]*aria-label="review\.webm"[^>]*controls=""[^>]*playsInline=""[^>]*preload="metadata"/);
  assert.doesNotMatch(html, /autoplay/);
  assert.match(html, /<figcaption class="md-media-cap"><span class="md-media-title"><span class="md-media-name" id="[^"]+">review\.png<\/span><\/span><a class="link" href="https:\/\/evidence\.example\/review\.png\?X-Amz-Signature=redacted" target="_blank" rel="noopener noreferrer" aria-describedby="[^"]+">Open Full Size<\/a><\/figcaption>/);
  const visibleText = html.replace(/<[^>]*>/g, "");
  assert.doesNotMatch(visibleText, /X-Amz|\?/);
});

test("unsettled transcript media shows its caption without mounting a remote element", () => {
  const image = "https://evidence.example/review.png?X-Amz-Signature=partial";
  const video = "https://evidence.example/review.webm?X-Amz-Signature=partial";
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    settled: false,
    children: `${image}\n\n${video}`,
  }));

  assert.match(html, new RegExp(`href="${image.replaceAll("?", "\\?")}"[^>]*>Open Link</a>`));
  assert.match(html, new RegExp(`href="${video.replaceAll("?", "\\?")}"[^>]*>Open Link</a>`));
  assert.match(html, /data-media-state="unsettled"/);
  assert.doesNotMatch(html, /<img|<video/);
});

test("a markdown image is the same figure with its alt text as the caption and no emoji", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    children: "![Reviewed Layout](https://evidence.example/review.png?signature=redacted)",
  }));

  assert.match(html, /<figure class="md-media"/);
  assert.match(html, /<img class="md-media-image"[^>]*alt="Reviewed Layout"/);
  assert.match(html, /<span class="md-media-name"[^>]*>Reviewed Layout<\/span>/);
  assert.doesNotMatch(html, /md-img-link|\u{1F5BC}/u);
  assert.doesNotMatch(html, /alt="https:\/\//);
});

test("a linked image keeps its alt text as the figure's caption and alt", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    children: "[![Reviewed Layout](https://evidence.example/thumb.png)](https://evidence.example/full.png?sig=1)",
  }));

  assert.equal(html.match(/class="md-media"/g)?.length, 1);
  assert.match(html, /<img class="md-media-image"[^>]*src="https:\/\/evidence\.example\/full\.png\?sig=1"[^>]*alt="Reviewed Layout"/);
  assert.match(html, /<span class="md-media-name"[^>]*>Reviewed Layout<\/span>/);
});

test("an intentionally empty Markdown image alt stays decorative", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    children: "![](https://evidence.example/review.png?signature=redacted)",
  }));

  assert.match(html, /<img class="md-media-image"[^>]*alt=""/);
  assert.match(html, /<span class="md-media-name"[^>]*>review\.png<\/span>/);
});

test("text sharing a paragraph with media stays a paragraph beside the figure", () => {
  const video = "https://evidence.example/walkthrough.webm?X-Amz-Signature=redacted";
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    children: `Interaction recording:\n${video}\nRecorded at 1x.`,
  }));

  assert.match(html, /^<div class="md"><p>Interaction recording:<\/p><figure class="md-media"[^>]*>.*<\/figure><p>Recorded at 1x\.<\/p><\/div>$/);
});

test("non-HTTPS and non-media links stay ordinary links without a figure", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    inlineMedia: true,
    children: "http://evidence.example/review.png and https://evidence.example/report.pdf?sig=1",
  }));

  assert.match(html, /^<div class="md"><p><a href="http:\/\/evidence\.example\/review\.png"[^>]*>http:\/\/evidence\.example\/review\.png<\/a> and <a href="https:\/\/evidence\.example\/report\.pdf\?sig=1"/);
  assert.doesNotMatch(html, /<figure|<img|<video/);
});

test("signed URL expiry is read from S3, GCS, CloudFront and Azure query strings", () => {
  assert.equal(
    transcriptMediaExpiry("https://b.example/a.png?X-Amz-Date=20260101T000000Z&X-Amz-Expires=3600&X-Amz-Signature=s"),
    Date.UTC(2026, 0, 1, 1),
  );
  assert.equal(
    transcriptMediaExpiry("https://b.example/a.png?X-Goog-Date=20260101T120000Z&X-Goog-Expires=60"),
    Date.UTC(2026, 0, 1, 12, 1),
  );
  assert.equal(transcriptMediaExpiry("https://b.example/a.png?Expires=1767225600&Signature=s"), 1_767_225_600_000);
  assert.equal(transcriptMediaExpiry("https://b.example/a.png?se=2026-01-01T00%3A00%3A00Z&sig=s"), Date.UTC(2026, 0, 1));
  assert.equal(transcriptMediaExpiry("https://b.example/a.png?X-Amz-Date=garbage&X-Amz-Expires=60"), null);
  assert.equal(transcriptMediaExpiry("https://b.example/a.png"), null);
  assert.equal(transcriptMediaExpiry("not a url"), null);
});

test("video durations read as m:ss or h:mm:ss and stay unknown when not finite", () => {
  assert.equal(formatTranscriptMediaDuration(7.4), "0:07");
  assert.equal(formatTranscriptMediaDuration(75), "1:15");
  assert.equal(formatTranscriptMediaDuration(3_725), "1:02:05");
  assert.equal(formatTranscriptMediaDuration(Number.POSITIVE_INFINITY), null);
  assert.equal(formatTranscriptMediaDuration(Number.NaN), null);
});

test("inline code stays action-free", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { children: "Use `const answer = 42` inline." }));
  assert.match(html, /<code>const answer = 42<\/code>/);
  assert.doesNotMatch(html, /Copy Code/);
});

test("prose-oriented fences wrap by default, shown as a pressed Wrap Lines toggle", () => {
  const longProse =
    "This fenced issue draft is one very long paragraph that would otherwise force horizontal scrolling in the transcript.";
  for (const fence of ["```", "```text", "```markdown"]) {
    const html = renderToStaticMarkup(React.createElement(Markdown, {
      children: [fence, longProse, "```"].join("\n"),
    }));
    assert.match(html, /<div class="md-code-block md-code-wrap">/, fence);
    assert.match(html, /aria-label="Wrap Lines" aria-pressed="true"/, fence);
  }
});

test("source-code fences keep the non-wrapping default with Wrap Lines not pressed", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    children: ["```js", "const answer = veryLongExpression(1, 2, 3);", "```"].join("\n"),
  }));
  assert.match(html, /<div class="md-code-block">/);
  assert.doesNotMatch(html, /md-code-wrap"/);
  assert.match(html, /<button type="button" class="icon-btn sm" title="Wrap Lines" aria-label="Wrap Lines" aria-pressed="false">/);
});

test("a fenced block has a header row with its language before the Wrap Lines and Copy Code buttons", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    children: ["```ts", "const a = 1;", "```"].join("\n"),
  }));
  const head = /<div class="md-code-head">([\s\S]*?)<\/div><\/div><pre>/.exec(html)?.[1] ?? "";
  assert.match(head, /^<span class="md-code-lang">ts<\/span>/);
  assert.ok(head.indexOf('aria-label="Wrap Lines"') < head.indexOf('aria-label="Copy Code"'));
  assert.doesNotMatch(html, /Copy Code Block|No Wrap|copy-btn/);

  const unknown = renderToStaticMarkup(React.createElement(Markdown, { children: ["```", "plain", "```"].join("\n") }));
  assert.doesNotMatch(unknown, /md-code-lang/, "an unknown language shows no label");
});

test("a table scrolls inside its wrapper, aligned columns are figures, and cell paths break at separators", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    children: [
      "| File | Lines | Share |",
      "| --- | ---: | :---: |",
      "| `apps/web/src/components/EventTimeline.tsx` | 120 | 4% |",
    ].join("\n"),
  }));
  assert.match(html, /<div class="md-table-wrap"><table>/);
  assert.match(html, /<th class="num">Lines<\/th><th class="num">Share<\/th>/);
  assert.match(html, /<td class="num">120<\/td><td class="num">4%<\/td>/);
  assert.doesNotMatch(html, /text-align/, "alignment comes from .num, not an inline style");
  assert.match(html, /<code>apps\/<wbr\/>web\/<wbr\/>src\/<wbr\/>components\/<wbr\/>EventTimeline.<wbr\/>tsx<\/code>/);
});

test("inline code outside a table keeps its text without break hints", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { children: "Open `apps/web/src/x_y.tsx` now." }));
  assert.match(html, /<code>apps\/web\/src\/x_y.tsx<\/code>/);
});

test("task-list items are drawn boxes announced as Done or Not Done", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, { children: "- [x] Ship it\n- [ ] Review it" }));
  assert.doesNotMatch(html, /<input/);
  assert.match(html, /<span class="md-check" role="img" aria-label="Done" data-checked="true"><svg[^>]*md-check-mark/);
  assert.match(html, /<span class="md-check" role="img" aria-label="Not Done"><\/span>/);
});

test("the inline profile renders code spans, emphasis, links and lists", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    profile: "inline",
    children: "Run `pnpm test` with *care*, see https://example.test/docs\n\n- item one\n- item two",
  }));
  assert.match(html, /<code>pnpm test<\/code>/);
  assert.match(html, /<em>care<\/em>/);
  assert.match(html, /<a href="https:\/\/example.test\/docs"/);
  assert.match(html, /<ul>\s*<li>item one<\/li>\s*<li>item two<\/li>\s*<\/ul>/);
});

test("the inline profile leaves headings, tables, quotes, images and raw HTML as typed text", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    profile: "inline",
    inlineMedia: true,
    children: [
      "# Heading",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "> quoted",
      "",
      "![shot](https://evidence.example/shot.png) <b>bold</b>",
    ].join("\n"),
  }));
  assert.doesNotMatch(html, /<h\d|<table|<blockquote|<img|<video|<b>|<figure/);
  assert.match(html, /<p># Heading<\/p>/);
  assert.match(html, /\| a \| b \|/);
  assert.match(html, /&gt; quoted/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
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
