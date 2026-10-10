import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { Markdown, markdownContentCache } from "./Markdown.js";
import { codeHighlighterRuns, loadCodeHighlighter } from "../markdown-highlight.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

async function renderMarkdown(
  markdown: string,
  inlineMedia = false,
  mediaSettled = true,
): Promise<{ container: HTMLDivElement; root: Root }> {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Markdown highlightEligible={false} inlineMedia={inlineMedia} settled={mediaSettled}>{markdown}</Markdown>,
    );
  });
  return { container, root };
}

async function cleanup(container: HTMLDivElement, root: Root): Promise<void> {
  await act(async () => { root.unmount(); });
  container.remove();
}

function wrapToggle(container: HTMLDivElement): HTMLButtonElement {
  const button = container.querySelector('.md-code-head button[aria-label="Wrap Lines"]');
  assert.ok(button, "code blocks render a wrap toggle in their header");
  return button as HTMLButtonElement;
}

const pressed = (button: HTMLButtonElement) => button.getAttribute("aria-pressed");

const LONG_CODE_LINE = "export const configuration = mergeDeep(baseConfiguration, overrides, { verbose: true });";

test("a remounted markdown row reuses parsed content but owns fresh code and media state", async () => {
  const source = ["Unique remount cache fixture.", "", "```ts", "const cached = 2771;", "```", "",
    "![synthetic](https://example.test/cache-remount.png)"].join("\n");
  const before = markdownContentCache.snapshot();
  const first = await renderMarkdown(source);
  await act(async () => { wrapToggle(first.container).click(); });
  assert.equal(pressed(wrapToggle(first.container)), "true");
  await cleanup(first.container, first.root);
  const parsed = markdownContentCache.snapshot();
  assert.equal(parsed.parses, before.parses + 1);
  const second = await renderMarkdown(source, true);
  try {
    assert.equal(markdownContentCache.snapshot().parses, parsed.parses, "remount does not parse again");
    assert.equal(pressed(wrapToggle(second.container)), "false", "mounted toggle state is not cached");
    assert.ok(second.container.querySelector(".md-media-image"), "media permission comes from this mount's context");
  } finally { await cleanup(second.container, second.root); }
});

test("table geometry is first read on observer delivery and responds to scrolling and resizing", async () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let reads = 0;
  let width = 100;
  let contentWidth = 300;
  let scrollLeft = 0;
  const observers: Array<{ callback: () => void; targets: Element[]; disconnected: boolean }> = [];
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  class Observer {
    record: typeof observers[number];
    constructor(callback: () => void) {
      this.record = { callback, targets: [], disconnected: false };
      observers.push(this.record);
    }
    observe(target: Element) { this.record.targets.push(target); }
    disconnect() { this.record.disconnected = true; }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
  for (const [property, get] of Object.entries({
    clientWidth: () => { reads++; return width; },
    scrollWidth: () => { reads++; return contentWidth; },
    scrollLeft: () => scrollLeft,
  })) {
    descriptors.set(property, Object.getOwnPropertyDescriptor(domWindow.HTMLElement.prototype, property));
    Object.defineProperty(domWindow.HTMLElement.prototype, property, { configurable: true, get });
  }
  let mounted: Awaited<ReturnType<typeof renderMarkdown>> | undefined;
  try {
    mounted = await renderMarkdown("| Deferred Table | Result |\n| --- | --- |\n| synthetic | preserved |");
    const wrap = mounted.container.querySelector<HTMLElement>(".md-table-wrap")!;
    assert.equal(reads, 0, "mount and effect registration do not force geometry reads");
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0]!.targets, [wrap, wrap.firstElementChild]);
    await act(async () => { observers[0]!.callback(); });
    assert.equal(wrap.tabIndex, 0);
    assert.equal(wrap.dataset.fadeEnd, "true");
    const changes: MutationRecord[] = [];
    const mutations = new domWindow.MutationObserver(records => changes.push(...records as unknown as MutationRecord[]));
    mutations.observe(wrap as never, { attributes: true });
    await act(async () => { observers[0]!.callback(); });
    await domWindow.happyDOM.waitUntilComplete();
    assert.equal(changes.length, 0, "unchanged geometry does not update attributes");
    scrollLeft = 200;
    await act(async () => { wrap.dispatchEvent(new domWindow.Event("scroll") as unknown as Event); });
    assert.equal(wrap.dataset.fadeEnd, undefined);
    width = contentWidth = 400;
    await act(async () => { observers[0]!.callback(); });
    assert.equal(wrap.hasAttribute("tabindex"), false, "resize removes unnecessary keyboard stop");
    mutations.disconnect();
  } finally {
    if (mounted) await cleanup(mounted.container, mounted.root);
    assert.ok(observers.every(observer => observer.disconnected));
    for (const [property, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(domWindow.HTMLElement.prototype, property, descriptor);
      else Reflect.deleteProperty(domWindow.HTMLElement.prototype, property);
    }
    if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

test("Wrap Lines toggles a source-code block on and off", async () => {
  const { container, root } = await renderMarkdown(["```ts", LONG_CODE_LINE, "```"].join("\n"));
  try {
    const block = container.querySelector(".md-code-block")!;
    const toggle = wrapToggle(container);
    assert.equal(block.classList.contains("md-code-wrap"), false, "source code keeps the non-wrapping default");
    assert.equal(pressed(toggle), "false");

    await act(async () => { toggle.click(); });
    assert.equal(block.classList.contains("md-code-wrap"), true);
    assert.equal(pressed(toggle), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Wrap Lines", "the name stays the same in both states");

    await act(async () => { toggle.click(); });
    assert.equal(block.classList.contains("md-code-wrap"), false);
    assert.equal(pressed(toggle), "false");
    assert.equal(toggle.getAttribute("aria-label"), "Wrap Lines");
  } finally {
    await cleanup(container, root);
  }
});

test("the wrap toggle is a native focusable icon button whose name and tooltip match", async () => {
  const { container, root } = await renderMarkdown(["```text", "prose draft", "```"].join("\n"));
  try {
    const toggle = wrapToggle(container);
    // A native <button type="button"> is keyboard operable (Enter/Space) by definition; the
    // assertions below guard against opting out of that contract.
    assert.equal(toggle.tagName, "BUTTON");
    assert.equal(toggle.getAttribute("type"), "button");
    assert.equal(toggle.hasAttribute("tabindex"), false, "must keep its natural tab-order slot");
    assert.equal(toggle.getAttribute("aria-label"), "Wrap Lines");
    assert.equal(toggle.getAttribute("title"), "Wrap Lines", "the tooltip repeats the accessible name");
    assert.equal(toggle.classList.contains("icon-btn"), true);
    assert.equal(toggle.hasAttribute("aria-hidden"), false);
    toggle.focus();
    assert.equal(domWindow.document.activeElement, toggle as unknown as ReturnType<typeof domWindow.document.createElement>);
  } finally {
    await cleanup(container, root);
  }
});

test("a reused block re-derives its wrap default when the fence language changes", async () => {
  // While an info string streams in, the same component instance can first see `m` (source-like)
  // and then `markdown` (prose). A default captured in a state initializer would go stale here and
  // reproduce the original non-wrapping-prose bug.
  const { container, root } = await renderMarkdown(["```m", "draft prose", "```"].join("\n"));
  try {
    assert.equal(container.querySelector(".md-code-block")!.classList.contains("md-code-wrap"), false);
    await act(async () => {
      root.render(<Markdown highlightEligible={false}>{["```markdown", "draft prose", "```"].join("\n")}</Markdown>);
    });
    const block = container.querySelector(".md-code-block")!;
    assert.equal(block.classList.contains("md-code-wrap"), true, "the prose default must follow the corrected language");
    assert.equal(pressed(wrapToggle(container)), "true");

    await act(async () => {
      root.render(<Markdown highlightEligible={false}>{["```typescript", "const x = 1;", "```"].join("\n")}</Markdown>);
    });
    assert.equal(container.querySelector(".md-code-block")!.classList.contains("md-code-wrap"), false,
      "swapping in a source-code document must drop the stale prose default");
  } finally {
    await cleanup(container, root);
  }
});

test("a replacement block with the same boolean default still resets to its own default", async () => {
  // js → python both default to non-wrapping, so tracking only the boolean default would let the
  // user's js toggle leak onto an unrelated python block.
  const { container, root } = await renderMarkdown(["```js", "const a = 1;", "```"].join("\n"));
  try {
    await act(async () => { wrapToggle(container).click(); });
    assert.equal(container.querySelector(".md-code-block")!.classList.contains("md-code-wrap"), true);

    await act(async () => {
      root.render(<Markdown highlightEligible={false}>{["```python", "b = 2", "```"].join("\n")}</Markdown>);
    });
    const block = container.querySelector(".md-code-block")!;
    assert.equal(block.classList.contains("md-code-wrap"), false, "an unrelated block must not inherit the toggle");
    assert.equal(pressed(wrapToggle(container)), "false");
  } finally {
    await cleanup(container, root);
  }
});

test("a same-language document swap resets to the default", async () => {
  const { container, root } = await renderMarkdown(["```text", "first draft body", "```"].join("\n"));
  try {
    await act(async () => { wrapToggle(container).click(); });
    assert.equal(container.querySelector(".md-code-block")!.classList.contains("md-code-wrap"), false);

    await act(async () => {
      root.render(<Markdown highlightEligible={false}>{["```text", "an entirely unrelated replacement document", "```"].join("\n")}</Markdown>);
    });
    const block = container.querySelector(".md-code-block")!;
    assert.equal(block.classList.contains("md-code-wrap"), true, "a replaced document returns to its prose default");
    assert.equal(pressed(wrapToggle(container)), "true");
  } finally {
    await cleanup(container, root);
  }
});

test("an explicit wrap choice survives body streaming while the language is stable", async () => {
  const { container, root } = await renderMarkdown(["```text", "first chunk", "```"].join("\n"));
  try {
    await act(async () => { wrapToggle(container).click(); });
    assert.equal(container.querySelector(".md-code-block")!.classList.contains("md-code-wrap"), false);

    await act(async () => {
      root.render(<Markdown highlightEligible={false}>{["```text", "first chunk and a much longer second chunk", "```"].join("\n")}</Markdown>);
    });
    const block = container.querySelector(".md-code-block")!;
    assert.equal(block.classList.contains("md-code-wrap"), false, "streamed body text must not revert the user's choice");
    assert.equal(pressed(wrapToggle(container)), "false");
  } finally {
    await cleanup(container, root);
  }
});

test("copying a visually wrapped block yields the original fenced text", async () => {
  const proseLines = [
    "## Draft issue",
    "",
    "This single prose sentence is intentionally much longer than any reasonable code-block viewport so wrapping matters.",
  ];
  const copied: string[] = [];
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value); } },
  });
  const { container, root } = await renderMarkdown(["```markdown", ...proseLines, "```"].join("\n"));
  try {
    const block = container.querySelector(".md-code-block")!;
    assert.equal(block.classList.contains("md-code-wrap"), true, "markdown fences wrap by default");
    const copyButton = container.querySelector('.md-code-head button[aria-label="Copy Code"]') as HTMLButtonElement;
    await act(async () => {
      copyButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => { wrapToggle(container).click(); });
    await act(async () => {
      copyButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(copied, [proseLines.join("\n"), proseLines.join("\n")], "wrapping never alters the copied bytes");
  } finally {
    await cleanup(container, root);
  }
});

test("a settled block is highlighted on first render and reuses its cached highlight when it returns", async () => {
  await loadCodeHighlighter();
  const fence = ["```ts", "const answer: number = 42; // settled", "```"].join("\n");
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    const before = codeHighlighterRuns();
    await act(async () => { root.render(<Markdown>{fence}</Markdown>); });
    assert.ok(container.querySelector("pre code .hljs-keyword"), "the first render already carries highlight classes");
    assert.equal(codeHighlighterRuns(), before + 1);

    // Scrolling away unmounts the virtual row, and scrolling back mounts a new one.
    await act(async () => { root.render(<></>); });
    assertNoDomNode(container.querySelector("pre"), "the row unmounted");
    await act(async () => { root.render(<Markdown>{fence}</Markdown>); });
    assert.ok(container.querySelector("pre code .hljs-keyword"), "the returning block is highlighted on its first render");
    assert.equal(codeHighlighterRuns(), before + 1, "the highlighter does not run again for the same block");
    assert.equal(
      container.querySelector("pre code")!.textContent,
      "const answer: number = 42; // settled\n",
      "highlighting keeps the exact fenced text",
    );
  } finally {
    await cleanup(container, root);
  }
});

test("a streaming block stays plain until its row settles", async () => {
  await loadCodeHighlighter();
  const fence = ["```js", "let streamingValue = 1;", "```"].join("\n");
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    const before = codeHighlighterRuns();
    await act(async () => { root.render(<Markdown settled={false}>{fence}</Markdown>); });
    assertNoDomNode(container.querySelector("pre code [class^='hljs-']"), "no highlight classes");
    assert.equal(codeHighlighterRuns(), before);
    await act(async () => { root.render(<Markdown settled>{fence}</Markdown>); });
    assert.ok(container.querySelector("pre code .hljs-keyword"));
  } finally {
    await cleanup(container, root);
  }
});

test("a consumer that opts out of highlighting never shows highlight classes", async () => {
  await loadCodeHighlighter();
  const { container, root } = await renderMarkdown(["```ts", "const optedOut = true;", "```"].join("\n"));
  try {
    assertNoDomNode(container.querySelector("pre code [class^='hljs-']"), "no highlight classes");
  } finally {
    await cleanup(container, root);
  }
});

function dispatch(element: Element, type: string): void {
  element.dispatchEvent(new domWindow.Event(type) as unknown as Event);
}

function caption(figure: Element) {
  const cap = figure.querySelector("figcaption.md-media-cap")!;
  return {
    name: cap.querySelector(".md-media-name")!.textContent,
    meta: [...cap.querySelectorAll(".md-media-meta")].map((element) => element.textContent),
    icon: cap.querySelector("svg.app-icon"),
    link: cap.querySelector("a.link")!,
  };
}

test("a signed image shows its name, then its pixel size once loaded, and Open Full Size", async () => {
  const image = "https://evidence.example/screenshot.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
  const { container, root } = await renderMarkdown(`Here is the result.\n\n${image}`, true);
  try {
    const figure = container.querySelector("figure.md-media")!;
    assert.equal(figure.parentElement, container.querySelector(".md"), "the figure is never inside a paragraph");
    const img = figure.querySelector("img.md-media-image")!;
    assert.equal(img.getAttribute("src"), image);
    assert.equal(img.getAttribute("data-load-state"), "pending");
    assert.deepEqual(caption(figure).meta, [], "no size before the image loads");

    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 1280 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 720 });
    await act(async () => { dispatch(img, "load"); });

    const { name, meta, link, icon } = caption(figure);
    assert.equal(name, "screenshot.png");
    assert.deepEqual(meta, ["1280 × 720"]);
    assertNoDomNode(icon, "a loaded figure has no failure icon");
    assert.equal(link.textContent, "Open Full Size");
    assert.equal(link.getAttribute("href"), image, "the anchor keeps the full signed href");
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    assert.equal(link.getAttribute("aria-describedby"), figure.querySelector(".md-media-name")!.id);
    assert.doesNotMatch(container.textContent ?? "", /X-Amz|\?/, "the signed query string is never visible text");
    assert.equal(container.querySelectorAll("a").length, 1, "one action per figure: no separate link row");
  } finally {
    await cleanup(container, root);
  }
});

test("a signed video shows its duration once metadata loads", async () => {
  const video = "https://evidence.example/walkthrough.webm?X-Amz-Signature=abc";
  const { container, root } = await renderMarkdown(video, true);
  try {
    const figure = container.querySelector("figure.md-media")!;
    const element = figure.querySelector("video.md-media-video")!;
    Object.defineProperty(element, "duration", { configurable: true, value: 83.2 });
    await act(async () => { dispatch(element, "loadedmetadata"); });
    assert.equal(caption(figure).name, "walkthrough.webm");
    assert.deepEqual(caption(figure).meta, ["1:23"]);
    assert.equal(caption(figure).link.textContent, "Open Full Size");
  } finally {
    await cleanup(container, root);
  }
});

test("a video whose length is unknown at first shows it once the duration changes", async () => {
  const video = "https://evidence.example/recording.webm?X-Amz-Signature=abc";
  const { container, root } = await renderMarkdown(video, true);
  try {
    const figure = container.querySelector("figure.md-media")!;
    const element = figure.querySelector("video.md-media-video")!;
    Object.defineProperty(element, "duration", { configurable: true, writable: true, value: Number.POSITIVE_INFINITY });
    await act(async () => { dispatch(element, "loadedmetadata"); });
    assert.deepEqual(caption(figure).meta, [], "an unindexed recording shows no length yet");

    Object.defineProperty(element, "duration", { configurable: true, writable: true, value: 83.2 });
    await act(async () => { dispatch(element, "durationchange"); });
    assert.deepEqual(caption(figure).meta, ["1:23"]);
  } finally {
    await cleanup(container, root);
  }
});

test("media inside emphasis, a heading or a link is never a figure inside phrasing content", async () => {
  const image = "https://evidence.example/shot.png?signature=valid";
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const { container, root } = await renderMarkdown([
      `**[Bold shot](${image})**`,
      "",
      `# ${image}`,
      "",
      `*![Emphasized](${image})*`,
      "",
      `Before [![Linked](${image})](https://example.test/page) after`,
    ].join("\n"), true);
    try {
      for (const figure of container.querySelectorAll("figure")) {
        assertNoDomNode(figure.closest("p, em, strong, del, a, h1, h2, h3, h4, h5, h6"),
          "a <figure> only appears in flow content");
      }
      const inline = [...container.querySelectorAll("span.md-media[role='figure']")];
      assert.equal(inline.length, 4, "each nested image keeps the figure layout as spans");
      for (const element of inline) {
        const name = element.querySelector(".md-media-name")!;
        assert.equal(element.getAttribute("aria-labelledby"), name.id, "the span figure is named by its file name");
        assertNoDomNode(element.querySelector("figcaption"), "no figcaption inside phrasing content");
      }
      assert.deepEqual(inline.map((element) => element.querySelector(".md-media-name")!.textContent),
        ["Bold shot", "shot.png", "Emphasized", "Linked"]);
      assert.equal(container.querySelectorAll("a a").length, 0, "media inside a link adds no nested anchor");
      assert.equal(inline[3]!.closest("a")?.getAttribute("href"), "https://example.test/page",
        "the surrounding link stays the linked image's action");
      assert.deepEqual(errors.filter((args) => /descendant|child of/.test(String(args[0]))), [],
        "React reports no invalid DOM nesting for figures");
    } finally {
      await cleanup(container, root);
    }
  } finally {
    console.error = originalError;
  }
});

test("failed media collapses to one caption line with the icon, its name, a reason and Open Link", async () => {
  const expired = "https://evidence.example/expired.png?X-Amz-Date=20200101T000000Z&X-Amz-Expires=3600&X-Amz-Signature=s";
  const broken = "https://evidence.example/broken.png?signature=valid";
  const video = "https://evidence.example/broken.webm?signature=valid";
  const { container, root } = await renderMarkdown(`${expired}\n\n${broken}\n\n${video}`, true);
  try {
    const figures = [...container.querySelectorAll("figure.md-media")];
    assert.equal(figures.length, 3);
    await act(async () => {
      dispatch(figures[0]!.querySelector("img")!, "error");
      dispatch(figures[1]!.querySelector("img")!, "error");
      dispatch(figures[2]!.querySelector("video")!, "error");
    });

    assertNoDomNode(container.querySelector("img, video"), "a failed figure reserves no media box");
    const [first, second, third] = figures.map(caption);
    assert.equal(first!.name, "expired.png");
    assert.deepEqual(first!.meta, ["Link expired"]);
    assert.deepEqual(second!.meta, ["Couldn't load this image"]);
    assert.deepEqual(third!.meta, ["Couldn't load this video"]);
    for (const [index, href] of [expired, broken, video].entries()) {
      const { icon, link } = [first, second, third][index]!;
      assert.ok(icon?.classList.contains("lucide-image-off"), "the ImageOff icon leads the caption");
      assert.equal(link.textContent, "Open Link");
      assert.equal(link.getAttribute("href"), href);
      assert.equal(link.getAttribute("target"), "_blank");
      assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    }
    for (const figure of figures) assert.equal(figure.getAttribute("data-media-state"), "failed");
  } finally {
    await cleanup(container, root);
  }
});

test("generated media names remove invisible Unicode from the caption and image alt", async () => {
  const image = "https://evidence.example/session%E2%80%8B%E2%80%8C%E2%80%8D%E2%80%A8%E2%80%A9review.png?signature=valid";
  const { container, root } = await renderMarkdown(image, true);
  try {
    assert.equal(container.querySelector("img.md-media-image")!.getAttribute("alt"), "sessionreview.png");
    assert.equal(container.querySelector(".md-media-name")!.textContent, "sessionreview.png");
  } finally {
    await cleanup(container, root);
  }
});

test("streaming URL changes mount no media until the final settled URL", async () => {
  const first = "https://evidence.example/review.png?signature=a";
  const second = "https://evidence.example/review.png?signature=ab";
  const final = "https://evidence.example/review.png?signature=valid";
  const { container, root } = await renderMarkdown(first, true, false);
  try {
    assertNoDomNode(container.querySelector("img, video"));
    assert.equal(container.querySelector(".md-media-name")!.textContent, "review.png");
    assert.equal(container.querySelector("figcaption a")!.textContent, "Open Link");
    await act(async () => {
      root.render(<Markdown highlightEligible={false} inlineMedia settled={false}>{second}</Markdown>);
    });
    assertNoDomNode(container.querySelector("img, video"));

    await act(async () => {
      root.render(<Markdown highlightEligible={false} inlineMedia settled>{final}</Markdown>);
    });
    assert.equal(container.querySelectorAll("img.md-media-image").length, 1);
    assert.equal(container.querySelector("img.md-media-image")?.getAttribute("src"), final);
    assert.equal(container.querySelector("figcaption a")!.textContent, "Open Full Size");
  } finally {
    await cleanup(container, root);
  }
});

test("loaded transcript media survives visibility-only rerenders without remounting", async () => {
  const image = "https://evidence.example/review.png?signature=valid";
  const { container, root } = await renderMarkdown(image, true);
  try {
    const loadedImage = container.querySelector("img.md-media-image")!;
    await act(async () => { dispatch(loadedImage, "load"); });
    assert.equal(loadedImage.getAttribute("data-load-state"), "loaded");

    await act(async () => {
      root.render(<Markdown highlightEligible inlineMedia>{image}</Markdown>);
    });

    assert.equal(container.querySelector("img.md-media-image") === loadedImage, true,
      "a scroll-driven highlightEligible change must preserve the loaded media node and state");
    assert.equal(loadedImage.getAttribute("data-load-state"), "loaded");
  } finally {
    await cleanup(container, root);
  }
});

test("settled transcript media never regresses when an existing session becomes active again", async () => {
  const image = "https://evidence.example/review.png?signature=valid";
  const { container, root } = await renderMarkdown(image, true);
  try {
    const loadedImage = container.querySelector("img.md-media-image")!;
    await act(async () => { dispatch(loadedImage, "load"); });

    await act(async () => {
      root.render(<Markdown highlightEligible={false} inlineMedia settled={false}>{image}</Markdown>);
    });

    assert.equal(container.querySelector("img.md-media-image") === loadedImage, true,
      "a later session-active transition must not unmount or refetch settled media");
    assert.equal(loadedImage.getAttribute("data-load-state"), "loaded");
  } finally {
    await cleanup(container, root);
  }
});

test("a completed signed media URL retries after its streamed unsigned prefix failed", async () => {
  const unsigned = "https://evidence.example/review.png";
  const signed = `${unsigned}?signature=valid`;
  const { container, root } = await renderMarkdown(unsigned, true);
  try {
    await act(async () => { dispatch(container.querySelector("img.md-media-image")!, "error"); });
    assertNoDomNode(container.querySelector("img.md-media-image"));

    await act(async () => {
      root.render(<Markdown highlightEligible={false} inlineMedia>{signed}</Markdown>);
    });

    assert.equal(container.querySelector("img.md-media-image")?.getAttribute("src"), signed,
      "the href identity must reset a failed embed when streaming completes the signed URL");
  } finally {
    await cleanup(container, root);
  }
});
