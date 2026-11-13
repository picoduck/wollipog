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
  await expect(page.getByRole("navigation", { name: "Campaign Sections" }).getByRole("button", { name: "Recovery Automation · 1 · Attention", exact: true })).toBeVisible();
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
  await expect(section("Summary").getByRole("button", { name: /Summary · 1/ })).toHaveAttribute("aria-expanded", "true");
  await expect(section("Waiting for You").getByRole("button", { name: /Waiting for You/ })).toHaveAttribute("aria-expanded", "true");
  await expect(section("Decisions").getByRole("button", { name: /Decisions · 30/ })).toHaveAttribute("aria-expanded", "false");
  expect(await page.locator('[data-campaign-section]:has(h3 button[aria-expanded="true"])').evaluateAll(sections =>
    sections.map(section => section.getAttribute("data-campaign-section")))).toEqual(["Waiting for You", "Repositories", "Summary", "Work Items"]);
  await page.mouse.move(width - 100, 220); await page.mouse.wheel(0, -10000);
  await expect(page.locator(".campaign-status")).toHaveJSProperty("scrollTop", 0);
  const capture = async (name: string) => {
    if (process.env.CAMPAIGN_SECTIONS_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CAMPAIGN_SECTIONS_EVIDENCE_DIR}/${name}-${width}.png` });
  };
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
  const index = page.getByRole("navigation", { name: "Campaign Sections" });
  await index.getByRole("button", { name: "Decisions · 30", exact: true }).click();
  await expect(index.getByRole("button", { name: "Decisions · 30", exact: true })).toHaveAttribute("aria-current", "location");
  await expect(section("Decisions").getByRole("heading")).toBeFocused();
  await expect(section("Decisions").locator(".campaign-decision-item")).toHaveCount(3);
  await capture("navigation");
  await section("Decisions").getByRole("button", { name: "Show All (30)", exact: true }).click();
  await expect(section("Decisions").locator(".campaign-decision-item")).toHaveCount(30);
  await index.getByRole("button", { name: "Recovery Records · 5", exact: true }).click();
  await expect(section("Recovery Records").getByRole("button", { name: "Show All (5)", exact: true })).toBeVisible();
  await section("Recovery Records").getByRole("button", { name: "Show All (5)", exact: true }).click();
  await expect(section("Recovery Records").getByRole("button", { name: "Show All (5)", exact: true })).toHaveCount(0);
  await index.getByRole("button", { name: "Authorized Issue Scope · 40", exact: true }).click();
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
