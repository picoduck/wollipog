import { expect, test } from "@playwright/test";

for (const query of ["scenario=member", "scenario=campaign&section=Decisions&decisions=1"]) test(`Back preserves the row after targeted entry: ${query}`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/campaign-status-e2e.html?${query}`);
  const target = query.includes("member") ? "Work Items" : "Decisions";
  await expect(page.getByRole("heading", { name: target, exact: true })).toBeFocused();
  await expect(page.getByRole("list", { name: "Work Items", exact: true })).toBeVisible();
  const row = page.locator(".campaign-work-row").first();
  await row.focus();
  const scroller = page.locator(".campaign-status");
  await scroller.evaluate(element => { element.scrollTop = 260; });
  const before = await scroller.evaluate(element => element.scrollTop);
  await page.keyboard.press("Enter");
  await expect(page.locator(".campaign-detail-title")).toBeFocused();
  await page.getByRole("button", { name: "Back to Work Items", exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(row).toBeFocused();
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(before);
});

for (const width of [1440, 390]) test(`a recovery hold remains actionable before opening reference sections at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.goto("/campaign-status-e2e.html?scenario=campaign&handoffs=before&chrome=1");
  await expect(page.getByRole("navigation", { name: "Primary Navigation" })).toBeVisible();
  await expect(page.getByText("Authorized Recovery Unavailable", { exact: true })).toBeVisible();
  await expect(page.locator('[data-campaign-section="Recovery Automation"] h3 button')).toHaveAttribute("aria-expanded", "true");
  const index = page.getByRole("navigation", { name: "Campaign Sections" });
  await expect(index.getByRole("button", { name: /^\d+ Needs? Attention$/ })).toBeVisible();
  await index.getByRole("button", { name: /^Go to Section/ }).click();
  await expect(page.getByRole("menu", { name: "Go to Section" }).getByRole("menuitem", { name: "Recovery Automation, Needs Attention", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Go to Section" })).toHaveCount(0);
  await page.mouse.move(width - 100, 360);
  await page.mouse.wheel(0, -10000);
  await expect(page.locator(".campaign-status")).toHaveJSProperty("scrollTop", 0);
  expect(await page.locator(".campaign-status").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  if (process.env.CAMPAIGN_SECTIONS_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CAMPAIGN_SECTIONS_EVIDENCE_DIR}/recovery-attention-${width}.png` });
});

for (const width of [1440, 390]) test(`large campaign sections at ${width}px (#4549)`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.goto("/campaign-status-e2e.html?scenario=campaign&largeCampaign=1");
  await expect(page.getByRole("navigation", { name: "Primary Navigation" })).toBeVisible();
  const section = (title: string) => page.locator(`[data-campaign-section="${title}"]`);
  await expect(section("Work Items").getByRole("button", { name: /Work Items · 40/ })).toHaveAttribute("aria-expanded", "true");
  await expect(section("Summary").getByRole("button", { name: "Summary", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(section("Waiting for You").getByRole("button", { name: /Waiting for You/ })).toHaveAttribute("aria-expanded", "true");
  await expect(section("Decisions").getByRole("button", { name: /Decisions · 30/ })).toHaveAttribute("aria-expanded", "false");
  expect(await page.locator('[data-campaign-section]:has(h3 button[aria-expanded="true"])').evaluateAll(sections =>
    sections.map(section => section.getAttribute("data-campaign-section")))).toEqual(["Waiting for You", "Repositories", "Summary", "Work Items"]);
  await page.mouse.move(width - 100, 220); await page.mouse.wheel(0, -10000);
  await expect(page.locator(".campaign-status")).toHaveJSProperty("scrollTop", 0);
  const capture = async (name: string) => {
    // Finish the menu's open motion first, so a capture never catches it mid-fade or mid-slide.
    if (process.env.CAMPAIGN_SECTIONS_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CAMPAIGN_SECTIONS_EVIDENCE_DIR}/${name}-${width}.png`, animations: "disabled" });
  };
  const index = page.getByRole("navigation", { name: "Campaign Sections" });
  const trigger = index.getByRole("button", { name: /^Go to Section/ });
  const menu = page.getByRole("menu", { name: "Go to Section" });
  const jump = async (name: string) => {
    await trigger.click();
    await menu.getByRole("menuitem", { name, exact: true }).click();
    await expect(menu).toHaveCount(0);
  };
  // One row (#4781): every control shares a line, nothing wraps or scrolls sideways.
  const indexBox = await page.locator(".campaign-section-index").evaluate(element => {
    const tops = [...element.children].map(child => Math.round(child.getBoundingClientRect().top + child.getBoundingClientRect().height / 2));
    return { height: element.getBoundingClientRect().height, rows: new Set(tops).size, overflow: element.scrollWidth > element.clientWidth + 1 };
  });
  expect(indexBox.height).toBeLessThanOrEqual(44);
  expect(indexBox.rows).toBe(1);
  expect(indexBox.overflow).toBe(false);
  await expect(trigger).toHaveAccessibleName("Go to Section, Current Section: Waiting for You");
  await capture("default");
  // The same default state, wheeled further down: Summary and Work Items stay expanded.
  for (const [title, name] of [["Summary", "default-summary"], ["Work Items", "default-work-items"]]) {
    const heading = section(title!).getByRole("heading");
    const delta = await heading.evaluate(element => {
      const scroller = element.closest(".campaign-status")!;
      return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        - scroller.querySelector(".campaign-section-index")!.getBoundingClientRect().height - 12;
    });
    await page.mouse.wheel(0, delta);
    await expect(heading).toBeInViewport();
    await expect(section(title!).locator("h3 button")).toHaveAttribute("aria-expanded", "true");
    // Wheeling alone moves the current section to the heading now under the index.
    await expect(trigger).toHaveAccessibleName(`Go to Section, Current Section: ${title}`);
    await capture(name!);
  }
  await page.mouse.wheel(0, -10000);
  await expect(page.locator(".campaign-status")).toHaveJSProperty("scrollTop", 0);
  await page.getByRole("button", { name: "Collapse All", exact: true }).click();
  await expect(page.locator('[data-campaign-section] h3 button[aria-expanded="true"]')).toHaveCount(0);
  expect(await page.locator('[data-campaign-section] h3 button').evaluateAll(buttons => buttons.every(button => {
    const style = getComputedStyle(button);
    return button.getBoundingClientRect().height <= parseFloat(style.lineHeight)
      + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 1;
  }))).toBe(true);
  await capture("collapsed");
  await trigger.click();
  await expect(menu.getByRole("menuitem", { name: "Decisions, 30", exact: true })).toBeVisible();
  await capture("menu");
  await menu.getByRole("menuitem", { name: "Decisions, 30", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("Go to Section, Current Section: Decisions");
  await expect(section("Decisions").getByRole("heading")).toBeFocused();
  await expect(section("Decisions").locator(".campaign-decision-item")).toHaveCount(3);
  await capture("navigation");
  await trigger.click();
  await expect(menu.getByRole("menuitem", { name: "Decisions, 30", exact: true })).toHaveAttribute("aria-current", "location");
  await expect(menu.getByRole("menuitem", { name: "Decisions, 30", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  // Expanding everything above the jumped section pushes it off screen without scrolling the
  // panel: the label moves on to the heading now under the index.
  await page.getByRole("button", { name: "Expand All", exact: true }).click();
  await expect(section("Decisions").getByRole("heading")).not.toBeInViewport();
  const underIndex = () => page.locator(".campaign-status").evaluate(scroller => {
    const line = scroller.querySelector(".campaign-section-index")!.getBoundingClientRect().bottom + 16;
    let title = "";
    for (const heading of scroller.querySelectorAll<HTMLElement>("[data-campaign-section] > h3")) {
      if (heading.getBoundingClientRect().top <= line) title = heading.getAttribute("aria-label")!;
    }
    return title;
  });
  await expect.poll(async () => (await trigger.getAttribute("aria-label")) === `Go to Section, Current Section: ${await underIndex()}`).toBe(true);
  await expect(trigger).not.toHaveAccessibleName("Go to Section, Current Section: Decisions");
  await page.getByRole("button", { name: "Collapse All", exact: true }).click();
  await jump("Decisions, 30");
  await section("Decisions").getByRole("button", { name: "Show All (30)", exact: true }).click();
  await expect(section("Decisions").locator(".campaign-decision-item")).toHaveCount(30);
  await jump("Recovery Records, 5");
  await expect(section("Recovery Records").getByRole("button", { name: "Show All (5)", exact: true })).toBeVisible();
  await section("Recovery Records").getByRole("button", { name: "Show All (5)", exact: true }).click();
  await expect(section("Recovery Records").getByRole("button", { name: "Show All (5)", exact: true })).toHaveCount(0);
  await jump("Authorized Issue Scope, 40");
  await expect(section("Authorized Issue Scope").getByText("picoduck/wollipog#4503", { exact: false })).toHaveCount(0);
  await section("Authorized Issue Scope").getByRole("button", { name: "Show All (40)", exact: true }).click();
  await expect(section("Authorized Issue Scope")).toContainText("picoduck/wollipog#4539");
  expect(await page.locator(".campaign-status").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Collapse All", exact: true }).click();
  await page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.bumpRevision());
  await expect(section("Waiting for You").getByRole("button", { name: /Waiting for You.*Attention.*New/ })).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(width - 100, 220); await page.mouse.wheel(0, -10000);
  await expect(page.locator(".campaign-status")).toHaveJSProperty("scrollTop", 0);
  await capture("new-attention");
  await page.goto("/campaign-status-e2e.html?scenario=campaign&largeCampaign=1&section=Decisions");
  await expect(section("Decisions").getByRole("heading")).toBeFocused();
  await expect(section("Decisions").getByRole("button", { name: /Decisions · 30/ })).toHaveAttribute("aria-expanded", "true");
  await page.goto("/campaign-status-e2e.html?scenario=campaign&largeCampaign=1&workItemId=cwi_3");
  await expect(page.getByRole("heading", { name: "Ledger Read API", exact: true })).toBeFocused();
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });
  for (const width of [385, 390]) test(`the section index stays within 44px and its hit areas stay apart at ${width}px (#4781)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&largeCampaign=1");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const index = page.locator(".campaign-section-index");
    await expect(index.getByRole("button", { name: /^\d+ Needs? Attention$/ })).toBeVisible();
    const layout = await index.evaluate(element => {
      const controls = [...element.querySelectorAll<HTMLElement>("button")].map(button => button.getBoundingClientRect());
      return {
        height: element.getBoundingClientRect().height,
        controlHeights: controls.map(rect => rect.height),
        gaps: controls.slice(1).map((rect, i) => rect.left - controls[i]!.right),
        // The index's own scrollWidth counts the last button's borrowed hit area; the panel's does not.
        overflow: (() => { const panel = element.closest(".campaign-status")!; return panel.scrollWidth > panel.clientWidth + 1; })(),
        label: element.querySelector<HTMLElement>(".campaign-section-trigger")!.innerText.trim(),
      };
    });
    // Too narrow for the "Section:" prefix: the section's own name keeps the room.
    expect(layout.label).toBe("Waiting for You");
    expect(layout.height).toBeLessThanOrEqual(44);
    expect(layout.controlHeights.every(height => height === 36)).toBe(true);
    // Each small control borrows 4px a side for its 44px target, so neighbours sit 8px apart.
    expect(Math.min(...layout.gaps)).toBeGreaterThanOrEqual(8);
    expect(layout.overflow).toBe(false);
    // A tap just inside Collapse All's right edge, and in its borrowed margin, is Collapse All's.
    const collapse = await index.getByRole("button", { name: "Collapse All", exact: true }).boundingBox();
    for (const dx of [-1, 3]) {
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("button")?.getAttribute("aria-label"),
        [collapse!.x + collapse!.width + dx, collapse!.y + collapse!.height / 2]);
      expect(hit).toBe("Collapse All");
    }
  });
});
