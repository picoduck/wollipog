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

async function renderMarkdown(markdown: string): Promise<{ container: HTMLDivElement; root: Root }> {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(<Markdown highlightEligible={false}>{markdown}</Markdown>);
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
