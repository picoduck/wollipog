import { expect, test, type Locator, type Page } from "@playwright/test";

const YOUR_MESSAGE = ["Copy Message", "Edit as a New Turn", "Rewind Files to Before This Turn…"];
const THIS_TURN = ["Copy Response", "Copy Response as Markdown", "Fork After This Turn…", "Hand Off After This Turn…"];

/** The open menu's rows in order: section labels in brackets, then each item's name. */
async function menuRows(page: Page): Promise<string[]> {
  return page.getByRole("menu").locator(".menu-label, [role='menuitem']").evaluateAll((rows) => rows.map((row) =>
    row.getAttribute("role") === "menuitem" ? (row as HTMLElement).dataset.menuLabel ?? "" : `[${row.textContent}]`));
}

/** The box a pointer can hit: the element plus any absolutely positioned ::after that extends it. */
async function hitArea(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const after = getComputedStyle(element, "::after");
    const extends_ = after.content !== "none" && after.position === "absolute";
    const inset = (side: string) => extends_ ? Math.min(0, Number.parseFloat(after.getPropertyValue(side)) || 0) : 0;
    return {
      left: rect.left + inset("left"),
      top: rect.top + inset("top"),
      right: rect.right - inset("right"),
      bottom: rect.bottom - inset("bottom"),
    };
  });
}

test("rewind stays compact on its user turn across pointer interactions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/checkpoint-rewind-e2e.html");
  // The turn's footer names it; its checkpoints draw no Start Turn or End Turn separator.
  await expect(page.locator(".tl-turn-footer .tl-turn-label")).toHaveText("Turn 4");
  await expect(page.getByRole("separator", { name: /^(Start|End) Turn/ })).toHaveCount(0);
  await expect(page.getByRole("separator", { name: "Files Rewound to Before Turn 4" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Forked from Turn 4" })).toBeVisible();
  const handoff = page.getByRole("separator", { name: "Handoff from Claude Code to Codex After Turn 4" });
  await expect(handoff).toBeVisible();
  const handoffDescriptionId = await handoff.getAttribute("aria-describedby");
  expect(handoffDescriptionId).toBeTruthy();
  await expect(page.locator(`[id="${handoffDescriptionId}"]`))
    .toHaveText("Fresh provider conversation. Tool output and reasoning were omitted.");
  await expect(page.locator(".tl-divider").filter({ hasText: "Rewind Files" })).toHaveCount(0);

  // More Turn Actions is visible at rest, quietly, and stays put while the footer is hovered.
  const more = page.getByRole("button", { name: "More Turn Actions" });
  await expect(more).toHaveCount(1);
  await expect(more).toBeVisible();
  await expect(more).toHaveCSS("opacity", "1");
  const before = await more.boundingBox();
  await page.locator(".tl-turn-footer").hover();
  expect(await more.boundingBox()).toEqual(before);

  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  expect(await menuRows(page)).toEqual(["[Your Message]", ...YOUR_MESSAGE, "[This Turn]", ...THIS_TURN]);
  await page.getByRole("menuitem", { name: "Rewind Files to Before This Turn…" }).click();
  await expect(page.getByRole("status")).toHaveText("Rewind requested for turn 4.");
  await expect(more).toBeFocused();
});

test("on a fine pointer the hover clusters appear on hover or focus and take no height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/checkpoint-rewind-e2e.html");
  const cluster = page.getByRole("group", { name: "Message Actions" });
  const bubble = page.locator(".tl-row.user .tl-bubble");
  const row = page.locator(".tl-row.user");
  await page.mouse.move(0, 0);
  await expect(cluster).toHaveCSS("opacity", "0");
  expect(await cluster.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))))
    .toEqual(["Copy Message", "Edit as a New Turn", "More Message Actions"]);
  // Absolutely placed beside the bubble: the row is exactly as tall as the bubble.
  const [rowBox, bubbleBox, clusterBox] = await Promise.all([row.boundingBox(), bubble.boundingBox(), cluster.boundingBox()]);
  expect(rowBox!.height).toBeCloseTo(bubbleBox!.height, 0);
  expect(clusterBox!.x + clusterBox!.width).toBeLessThanOrEqual(bubbleBox!.x);
  expect(clusterBox!.y + clusterBox!.height).toBeCloseTo(bubbleBox!.y + bubbleBox!.height, 0);

  await bubble.hover();
  await expect(cluster).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(cluster).toHaveCSS("opacity", "0");
  await cluster.getByRole("button", { name: "Copy Message" }).focus();
  await expect(cluster).toHaveCSS("opacity", "1");

  // The footer's cluster: Copy Response and a usable Fork, before More Turn Actions.
  const footer = page.locator(".tl-turn-footer");
  const hoverActions = footer.locator(".tl-hover-action");
  await page.mouse.move(0, 0);
  await page.locator("body").focus();
  await expect(hoverActions).toHaveCount(2);
  for (const action of await hoverActions.all()) await expect(action).toHaveCSS("opacity", "0");
  await footer.hover();
  for (const action of await hoverActions.all()) await expect(action).toHaveCSS("opacity", "1");
  await footer.getByRole("button", { name: "Fork After This Turn" }).click();
  await expect(page.getByRole("status")).toHaveText("Fork requested after turn 4.");

  // An open menu keeps its cluster shown after the pointer leaves.
  await bubble.hover();
  await cluster.getByRole("button", { name: "More Message Actions" }).click();
  await page.mouse.move(0, 0);
  await expect(cluster).toHaveCSS("opacity", "1");
  expect(await menuRows(page)).toEqual(["[Your Message]", ...YOUR_MESSAGE]);
});

test("an unavailable action is a disabled menu item whose visible reason describes it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/checkpoint-rewind-e2e.html?unavailable");
  await expect(page.getByRole("button", { name: "Fork After This Turn" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit as a New Turn" })).toHaveCount(0);
  await page.getByRole("button", { name: "More Turn Actions" }).click();
  const reasons: Record<string, string> = {
    "Edit as a New Turn": "Runner is offline.",
    "Rewind Files to Before This Turn…": "Reconnect the runner before restoring files.",
    "Fork After This Turn…": "Reconnect the runner before creating a fork.",
    "Hand Off After This Turn…": "Reconnect the runner before creating a handoff.",
  };
  for (const [name, reason] of Object.entries(reasons)) {
    const item = page.getByRole("menuitem", { name });
    await expect(item).toBeDisabled();
    await expect(item).toHaveAccessibleDescription(reason);
    await expect(item.locator(".menu-desc")).toHaveText(reason);
    await expect(item.locator(".menu-desc")).toBeVisible();
  }
  await expect(page.getByRole("menuitem", { name: "Copy Response", exact: true })).toBeEnabled();
});

for (const width of [1440, 390]) {
  test(`More Turn Actions is visible at rest at ${width}px on a coarse pointer, with a 44px target and nothing overlapping`, async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, isMobile: width < 760, viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto("/checkpoint-rewind-e2e.html");
    const more = page.getByRole("button", { name: "More Turn Actions" });
    await expect(more).toBeVisible();
    await expect(more).toHaveCSS("opacity", "1");
    // No hover cluster on a coarse pointer: More Turn Actions is the only action control.
    await expect(page.locator(".tl-user-actions, .tl-hover-action")).toHaveCount(0);
    await expect(page.locator(".tl-message-actions button")).toHaveCount(1);
    const area = await hitArea(more);
    expect(area.right - area.left).toBeGreaterThanOrEqual(44);
    expect(area.bottom - area.top).toBeGreaterThanOrEqual(44);
    // No other control's hit area reaches into it.
    for (const other of await page.locator(".timeline :is(button, a[href], summary)").all()) {
      if (await other.evaluate((element) => element.classList.contains("tl-more-actions"))) continue;
      const box = await hitArea(other);
      const overlaps = box.left < area.right && box.right > area.left && box.top < area.bottom && box.bottom > area.top;
      expect(overlaps, await other.evaluate((element) => element.outerHTML.slice(0, 120))).toBe(false);
    }

    await more.tap();
    const menu = page.getByRole("menu", { name: "More Turn Actions" });
    await expect(menu).toBeVisible();
    expect(await menuRows(page)).toEqual(["[Your Message]", ...YOUR_MESSAGE, "[This Turn]", ...THIS_TURN]);
    if (width < 760) {
      // A phone sheet: once it has slid in, docked to the bottom edge across the full width.
      await expect.poll(async () => {
        const box = (await menu.boundingBox())!;
        return [Math.round(box.x), Math.round(box.width), Math.round(box.y + box.height)];
      }).toEqual([0, width, 900]);
    }
    await page.getByRole("menuitem", { name: "Rewind Files to Before This Turn…" }).tap();
    await expect(page.getByRole("status")).toHaveText("Rewind requested for turn 4.");
    await context.close();
  });
}

test("long-pressing a user bubble on a touch device selects text and opens no menu", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.goto("/checkpoint-rewind-e2e.html");
  const text = page.locator(".tl-row.user .bubble-text");
  await expect(text).toHaveCSS("user-select", /^(auto|text)$/);
  const box = (await text.boundingBox())!;
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // A long press reaches the page as a context menu; nothing in the transcript claims it.
  const claimed = await text.evaluate((element) =>
    !element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(claimed).toBe(false);
  await expect(page.getByRole("menu")).toHaveCount(0);
  // The bubble's words can be selected as text.
  const selected = await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selected).toBe("Inspect the checkpoint controls.");
  await context.close();
});
