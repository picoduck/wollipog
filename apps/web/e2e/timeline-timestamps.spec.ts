import { expect, test, type Page } from "@playwright/test";

async function cardGeometry(page: Page) {
  return page.locator(".tl-agent-msg, .tl-reasoning, .tl-tool").evaluateAll((cards) => cards.map((card) => {
    const rect = card.getBoundingClientRect();
    return { className: card.className, top: rect.top, height: rect.height };
  }));
}

test("activity timestamps tick without layout shift and become stable absolute records when inactive", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-04T12:00:00.000Z") });
  await page.goto("/timeline-timestamps-e2e.html");
  await expect(page.locator('[data-virtual-kind="timeline"]')).toHaveAttribute("data-virtual-total", "42");
  expect(await page.locator("[data-virtual-row]").count()).toBeLessThan(42);
  await page.locator(".tl-work > .tl-disclosure").click();

  await expect(page.locator(".tl-agent-msg time")).toHaveCount(2);
  await expect(page.locator(".tl-reasoning time")).toHaveCount(1);
  await expect(page.locator(".tl-tool:not(details) .tool-head time")).toHaveCount(2);
  await expect(page.locator("details.tl-tool:not([open]) .tool-head time")).toHaveCount(2);
  const mountedTimes = await page.locator("time").evaluateAll((times) => times.map((time) => ({
    dateTime: time.getAttribute("datetime"),
    title: time.getAttribute("title"),
  })));
  for (const time of mountedTimes) {
    expect(time.dateTime).toMatch(/^2026-08-04T/);
    expect(time.title).toMatch(/^(Recorded|Started|Last Activity) /);
  }
  await expect(page.locator(".tl-tool", { hasText: "Completed Details Tool" })).toContainText("Duration 40s");
  const completedToolSummary = page.locator("details.tl-tool", { hasText: "Completed Details Tool" }).locator("summary");
  await expect(completedToolSummary).toHaveAccessibleName("Completed Details Tool · Completed");
  await expect(completedToolSummary).toHaveAccessibleDescription(/Started .*Last Activity .*Duration 40s/);

  const before = await cardGeometry(page);
  const beforeText = await page.locator(".tl-timestamp-meta").allTextContents();
  await page.evaluate(() => window.timelineTimestampE2E.resetMetrics());
  await page.clock.fastForward(30_100);
  await expect.poll(async () => page.evaluate(() => window.timelineTimestampE2E.metrics().updateCommits)).toBe(1);
  const afterText = await page.locator(".tl-timestamp-meta").allTextContents();
  expect(afterText).not.toEqual(beforeText);

  const after = await cardGeometry(page);
  expect(after).toHaveLength(before.length);
  after.forEach((card, index) => {
    expect(Math.abs(card.top - before[index]!.top)).toBeLessThan(0.5);
    expect(Math.abs(card.height - before[index]!.height)).toBeLessThan(0.5);
  });
  const metrics = await page.evaluate(() => window.timelineTimestampE2E.metrics());
  expect(metrics.timestampMutations).toBeGreaterThan(0);
  expect(metrics.layoutShift).toBe(0);

  await page.getByTestId("complete-session").click();
  for (const text of await page.locator("time").allTextContents()) expect(text).not.toMatch(/Ago|Just Now/);
  await expect(page.locator(".tl-tool", { hasText: "Active Bare Tool" })).toContainText("Observed 1m 15s");
  await expect(page.locator(".tl-tool", { hasText: "Completed Details Tool" })).toContainText("Duration 40s");
  for (const slot of await page.locator(".tl-tool :is(.tl-timestamp-value, .tl-timestamp-duration)").all()) {
    expect(await slot.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  const frozen = await page.locator(".tl-timestamp-meta").allTextContents();
  await page.evaluate(() => window.timelineTimestampE2E.resetMetrics());
  await page.clock.fastForward(60_000);
  expect(await page.locator(".tl-timestamp-meta").allTextContents()).toEqual(frozen);
  expect(await page.evaluate(() => window.timelineTimestampE2E.metrics().updateCommits)).toBe(0);
});
