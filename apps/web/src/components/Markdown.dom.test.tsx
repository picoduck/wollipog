import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { Markdown } from "./Markdown.js";

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
      <Markdown highlightEligible={false} inlineMedia={inlineMedia} mediaSettled={mediaSettled}>{markdown}</Markdown>,
    );
  });
  return { container, root };
}

async function cleanup(container: HTMLDivElement, root: Root): Promise<void> {
  await act(async () => { root.unmount(); });
  container.remove();
}

function wrapToggle(container: HTMLDivElement): HTMLButtonElement {
  const button = container.querySelector("button.md-code-wrap-toggle");
  assert.ok(button, "code blocks render a wrap toggle");
  return button as HTMLButtonElement;
}

const LONG_CODE_LINE = "export const configuration = mergeDeep(baseConfiguration, overrides, { verbose: true });";

test("Wrap Lines toggles a source-code block on and off", async () => {
  const { container, root } = await renderMarkdown(["```ts", LONG_CODE_LINE, "```"].join("\n"));
  try {
    const block = container.querySelector(".md-code-block")!;
    const toggle = wrapToggle(container);
    assert.equal(block.classList.contains("md-code-wrap"), false, "source code keeps the non-wrapping default");
    assert.equal(toggle.textContent, "Wrap Lines");

    await act(async () => { toggle.click(); });
    assert.equal(block.classList.contains("md-code-wrap"), true);
    assert.equal(toggle.textContent, "No Wrap");

    await act(async () => { toggle.click(); });
    assert.equal(block.classList.contains("md-code-wrap"), false);
    assert.equal(toggle.textContent, "Wrap Lines");
  } finally {
    await cleanup(container, root);
  }
});

test("the wrap toggle is a native focusable button whose accessible name is its visible label", async () => {
  const { container, root } = await renderMarkdown(["```text", "prose draft", "```"].join("\n"));
  try {
    const toggle = wrapToggle(container);
    // A native <button type="button"> is keyboard operable (Enter/Space) by definition; the
    // assertions below guard against opting out of that contract.
    assert.equal(toggle.tagName, "BUTTON");
    assert.equal(toggle.getAttribute("type"), "button");
    assert.equal(toggle.hasAttribute("tabindex"), false, "must keep its natural tab-order slot");
    assert.equal(toggle.hasAttribute("aria-label"), false, "accessible name is the visible Title Case label");
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
    assert.equal(wrapToggle(container).textContent, "No Wrap");

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
    assert.equal(wrapToggle(container).textContent, "Wrap Lines");
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
    assert.equal(wrapToggle(container).textContent, "No Wrap");
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
    assert.equal(wrapToggle(container).textContent, "Wrap Lines");
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
    const copyButton = container.querySelector("button.md-code-copy") as HTMLButtonElement;
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

test("failed transcript image and video loads collapse to their plain links", async () => {
  const image = "https://evidence.example/expired.png?signature=expired";
  const video = "https://evidence.example/expired.webm?signature=expired";
  const { container, root } = await renderMarkdown(`${image}\n\n${video}`, true);
  try {
    assert.equal(container.querySelectorAll(".md-media-embed").length, 2);
    assert.equal(container.querySelectorAll(`a[href^="https://evidence.example/expired"]`).length, 2,
      "only the two visible plain URL links are actionable before the image loads");

    await act(async () => {
      container.querySelector("img.md-media-image")!.dispatchEvent(new domWindow.Event("error") as unknown as Event);
      container.querySelector("video.md-media-video")!.dispatchEvent(new domWindow.Event("error") as unknown as Event);
    });

    assert.equal(container.querySelectorAll(".md-media-embed").length, 0, "failed embeds reserve no layout space");
    assert.equal(container.querySelectorAll(`a[href^="https://evidence.example/expired"]`).length, 2,
      "each original plain link remains usable");
  } finally {
    await cleanup(container, root);
  }
});

test("pending transcript images stay out of the accessibility tree and tab order until loaded", async () => {
  const image = "https://evidence.example/session%20review.png?signature=valid";
  const { container, root } = await renderMarkdown(image, true);
  try {
    const fullSizeLink = container.querySelector("a.md-media-image-link")!;
    const embeddedImage = container.querySelector("img.md-media-image")!;
    assert.equal(fullSizeLink.hasAttribute("href"), false);
    assert.equal(fullSizeLink.getAttribute("aria-hidden"), "true");
    assert.equal(fullSizeLink.hasAttribute("aria-label"), false);
    assert.equal(embeddedImage.getAttribute("alt"), "session review.png");

    await act(async () => {
      embeddedImage.dispatchEvent(new domWindow.Event("load") as unknown as Event);
    });

    assert.equal(fullSizeLink.getAttribute("href"), image, "loaded image becomes a full-size link");
    assert.equal(fullSizeLink.hasAttribute("aria-hidden"), false, "loaded link returns to the accessibility tree");
    assert.equal(fullSizeLink.getAttribute("aria-label"), "Open session review.png Full Size");
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
    assert.equal(container.querySelector(".md-media-embed"), null);
    await act(async () => {
      root.render(<Markdown highlightEligible={false} inlineMedia mediaSettled={false}>{second}</Markdown>);
    });
    assert.equal(container.querySelector(".md-media-embed"), null);

    await act(async () => {
      root.render(<Markdown highlightEligible={false} inlineMedia mediaSettled>{final}</Markdown>);
    });
    assert.equal(container.querySelectorAll(".md-media-embed").length, 1);
    assert.equal(container.querySelector("img.md-media-image")?.getAttribute("src"), final);
  } finally {
    await cleanup(container, root);
  }
});

test("loaded transcript media survives visibility-only rerenders without remounting", async () => {
  const image = "https://evidence.example/review.png?signature=valid";
  const { container, root } = await renderMarkdown(image, true);
  try {
    const loadedImage = container.querySelector("img.md-media-image")!;
    await act(async () => {
      loadedImage.dispatchEvent(new domWindow.Event("load") as unknown as Event);
    });
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
    await act(async () => {
      loadedImage.dispatchEvent(new domWindow.Event("load") as unknown as Event);
    });

    await act(async () => {
      root.render(<Markdown highlightEligible={false} inlineMedia mediaSettled={false}>{image}</Markdown>);
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
    await act(async () => {
      container.querySelector("img.md-media-image")!.dispatchEvent(new domWindow.Event("error") as unknown as Event);
    });
    assert.equal(container.querySelector("img.md-media-image"), null);

    await act(async () => {
      root.render(<Markdown highlightEligible={false} inlineMedia>{signed}</Markdown>);
    });

    assert.equal(container.querySelector("img.md-media-image")?.getAttribute("src"), signed,
      "the href identity must reset a failed embed when streaming completes the signed URL");
  } finally {
    await cleanup(container, root);
  }
});
