import { expect, test, type Locator, type Page } from "@playwright/test";

// #2152: transcript markdown on the type scale. Tables scroll inside a bordered wrapper instead of
// breaking cells one glyph per line, headings take the named type roles, a fenced block has a header
// row for its language and icon buttons, task-list boxes are drawn, and user messages render inline
// markdown.

const FIXTURE = "/timeline-reflow-e2e.html?markdown=1";

async function open(page: Page, width: number, theme: "dark" | "light" = "dark") {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${FIXTURE}&theme=${theme}`);
  await expect(page.locator(".tl-agent-msg .md-table-wrap")).toBeVisible();
}

/** How many distinct lines an element's text occupies. */
async function lineCount(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
    return tops.size;
  });
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("element has no box");
  return { ...value, right: value.x + value.width, bottom: value.y + value.height };
}

test("at 390px a table keeps its headers and figures on one line and scrolls inside its wrapper", async ({ page }) => {
  await open(page, 390);
  const wrap = page.locator(".tl-agent-msg .md-table-wrap");
  await wrap.scrollIntoViewIfNeeded();
  expect(await wrap.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
  expect(await wrap.evaluate((element) => element.scrollWidth > element.clientWidth), "the table scrolls sideways").toBe(true);
  await expect(wrap).toHaveAttribute("data-fade-end", "true");
  expect(await wrap.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("1px");
  const message = await box(page.locator(".tl-agent-msg").first());
  const wrapBox = await box(wrap);
  expect(wrapBox.right, "the wrapper stays inside the reply").toBeLessThanOrEqual(message.right + 0.5);

  for (const header of await wrap.locator("th").all()) {
    expect(await lineCount(header), `header "${await header.textContent()}"`).toBe(1);
  }
  const figures = wrap.locator("td.num");
  await expect(figures).toHaveCount(9);
  for (const figure of await figures.all()) {
    expect(await lineCount(figure), `figure "${await figure.textContent()}"`).toBe(1);
    expect(await figure.evaluate((element) => getComputedStyle(element).fontVariantNumeric)).toBe("tabular-nums");
    expect(await figure.evaluate((element) => getComputedStyle(element).textAlign)).toBe("right");
  }

  // Scrolled to the end, the trailing fade goes away.
  await wrap.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(wrap).not.toHaveAttribute("data-fade-end");
});

test("a path in a table cell breaks only after a slash, dot or underscore", async ({ page }) => {
  await open(page, 390);
  const code = page.locator(".tl-agent-msg td code").first();
  await expect(code).toHaveText("apps/web/src/components/EventTimeline.tsx");
  // Each run of text between <wbr> break hints stays on a single line, so any line break the
  // browser chose falls right after a separator.
  const segments = await code.evaluate((element) => [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
      return { text: node.textContent, lines: tops.size };
    }));
  expect(segments.map((segment) => segment.text).join("")).toBe("apps/web/src/components/EventTimeline.tsx");
  for (const segment of segments) {
    expect(segment.lines, `"${segment.text}" stays whole`).toBe(1);
    expect(segment.text === "tsx" || /[/._]$/.test(segment.text ?? ""), `"${segment.text}" ends at a separator`).toBe(true);
  }
  expect(await lineCount(code), "the path does wrap inside its narrow cell").toBeGreaterThan(1);
});

test("headings take the page-title, title and section roles", async ({ page }) => {
  await open(page, 1440);
  const metrics = (selector: string) => page.locator(`.tl-agent-msg ${selector}`).evaluate((element) => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight };
  });
  expect(await metrics("h1")).toEqual({ size: "20px", lineHeight: "28px", weight: "600" });
  expect(await metrics("h2")).toEqual({ size: "16px", lineHeight: "24px", weight: "600" });
  expect(await metrics("h3")).toEqual({ size: "14px", lineHeight: "20px", weight: "600" });
  expect(await metrics("h4")).toEqual({ size: "13px", lineHeight: "20px", weight: "500" });
});

for (const width of [390, 1440]) {
  test(`at ${width}px a fenced block's header holds its language and buttons above the first line`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, width);
    const block = page.locator(".tl-agent-msg .md-code-block");
    await block.scrollIntoViewIfNeeded();
    const head = block.locator(".md-code-head");
    await expect(head.locator(".md-code-lang")).toHaveText("typescript");
    const pre = block.locator("pre");
    const preBox = await box(pre);
    const headBox = await box(head);
    expect(headBox.bottom).toBeLessThanOrEqual(preBox.y + 0.5);
    expect(await pre.evaluate((element) => getComputedStyle(element).fontSize)).toBe("12px");
    expect(await pre.evaluate((element) => getComputedStyle(element).lineHeight)).toBe("18px");

    const wrapLines = head.getByRole("button", { name: "Wrap Lines", exact: true });
    const copy = head.getByRole("button", { name: "Copy Code", exact: true });
    for (const button of [wrapLines, copy]) {
      const buttonBox = await box(button);
      expect(buttonBox.bottom, "no line of code sits under a button").toBeLessThanOrEqual(preBox.y + 0.5);
      expect(buttonBox.y).toBeGreaterThanOrEqual(headBox.y - 0.5);
    }

    await expect(wrapLines).toHaveAttribute("aria-pressed", "false");
    await wrapLines.click();
    await expect(wrapLines).toHaveAttribute("aria-pressed", "true");
    await expect(block).toHaveClass(/md-code-wrap/);
    await expect(head.getByRole("button", { name: "Wrap Lines", exact: true })).toHaveCount(1);

    await copy.click();
    await expect(copy.locator(".copy-status-icon-copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe([
      "export function separatorBreaks(text: string): string[] {",
      "  return text.split(/(?<=[/._])/); // break after a slash, dot or underscore",
      "}",
    ].join("\n"));
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`task-list boxes are visible in the ${theme} theme and announced as Done or Not Done`, async ({ page }) => {
    await open(page, 1440, theme);
    const reply = page.locator(".tl-agent-msg");
    await expect(reply.getByRole("img", { name: "Done", exact: true })).toHaveCount(2);
    await expect(reply.getByRole("img", { name: "Not Done", exact: true })).toHaveCount(1);
    await expect(reply.locator("input[type=checkbox]")).toHaveCount(0);
    const unchecked = reply.getByRole("img", { name: "Not Done", exact: true });
    const done = reply.getByRole("img", { name: "Done", exact: true }).first();
    for (const check of [unchecked, done]) {
      const size = await check.boundingBox();
      expect(size?.width).toBe(16);
      expect(size?.height).toBe(16);
    }
    // The open box's edge differs from the reply's ground; the done box is accent-filled with a check.
    const [edge, ground] = await unchecked.evaluate((element) => [
      getComputedStyle(element).borderTopColor,
      getComputedStyle(element.closest(".detail-chat, main, body")!).backgroundColor,
    ]);
    expect(edge).not.toBe(ground);
    await expect(done.locator("svg")).toBeVisible();
  });
}

test("a user message renders a code span and a list, and keeps a heading as text", async ({ page }) => {
  await open(page, 1440);
  const bubble = page.locator(".user-bubble .bubble-text");
  await expect(bubble.locator("code")).toHaveText("apps/web/src/components/Markdown.tsx");
  await expect(bubble.getByRole("listitem")).toHaveCount(2);
  await expect(bubble.locator("strong")).toHaveText("tables");
  await expect(bubble.locator("h1, h2, h3, h4, h5, h6, table")).toHaveCount(0);
  await expect(bubble.getByText("# Not a heading")).toBeVisible();
});

test("a settled reply's code block is highlighted", async ({ page }) => {
  await open(page, 1440);
  await expect(page.locator(".tl-agent-msg pre code .hljs-keyword").first()).toBeVisible();
});
