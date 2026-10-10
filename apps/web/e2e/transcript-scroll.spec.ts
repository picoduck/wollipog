import { expect, test } from "@playwright/test";

test("10,503 synthetic events stay virtual and reuse parsed rows after scrolling back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/transcript-scroll-e2e.html");
  const reader = page.getByTestId("reader");
  await expect(reader).toHaveAttribute("data-event-count", "10503");
  await expect(page.locator('[data-virtual-measurements="ready"]')).toBeVisible();
  const first = page.getByRole("heading", { name: "Synthetic Module 0", exact: true });
  await expect(first).toBeVisible();
  expect(await page.locator("[data-virtual-row]").count()).toBeLessThan(50);
  await reader.evaluate(element => { element.scrollTop = 12_000; });
  await expect(first).toHaveCount(0);
  // Wait for the destination's asynchronous row measurements before observing the cache.
  await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBeGreaterThan(10_000);
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const beforeReturn = await page.evaluate(() => window.__transcriptScrollCache());
  await reader.evaluate(element => { element.scrollTop = 0; });
  await expect(first).toBeVisible();
  const returned = await page.evaluate(() => window.__transcriptScrollCache());
  expect(returned.parses).toBe(beforeReturn.parses);
  expect(returned.hits).toBeGreaterThan(beforeReturn.hits);
  expect(returned.entries).toBeLessThanOrEqual(256);
  expect(returned.sourceCharacters).toBeLessThanOrEqual(524_288);
});

test("table overflow remains keyboard accessible and tracks scroll edges and viewport resizing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/transcript-scroll-e2e.html");
  const table = page.locator(".md-table-wrap").first();
  await expect(table).toHaveAttribute("tabindex", "0");
  await expect(table).toHaveAttribute("data-fade-end", "true");
  await table.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await table.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect(table).not.toHaveAttribute("data-fade-end", "true");
  await table.evaluate(element => { element.scrollLeft = 0; });
  await expect(table).toHaveAttribute("data-fade-end", "true");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(table).not.toHaveAttribute("tabindex", "0");
  await expect(table).not.toHaveAttribute("data-fade-end", "true");
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(table).toHaveAttribute("tabindex", "0");
  await expect(table).toHaveAttribute("data-fade-end", "true");
});
