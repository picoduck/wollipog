import { devices, expect, test } from "@playwright/test";

const phone = devices["Pixel 7"];
test.use({
  viewport: phone.viewport,
  hasTouch: phone.hasTouch,
  isMobile: phone.isMobile,
  userAgent: phone.userAgent,
  deviceScaleFactor: phone.deviceScaleFactor,
  screen: phone.screen,
  reducedMotion: "reduce",
});

test("the first mobile touch traversal loads earlier activity", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The native touch gesture uses Chromium DevTools input.");
  await page.goto("/recovery-notice-e2e.html?pagination=1&height=720&width=412");

  const reader = page.locator(".detail-scroll");
  const control = page.locator(".transcript-earlier-activity");
  await expect(control).toBeVisible();
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("1");
  await expect.poll(() => reader.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(400);
  await reader.dispatchEvent("wheel", { deltaY: -40 });
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
  await reader.evaluate((element) => {
    element.scrollTop = 320;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBe(320);

  await reader.dispatchEvent("touchstart");
  await reader.evaluate((element) => {
    for (const scrollTop of [260, 120]) {
      element.scrollTop = scrollTop;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  });

  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("2");
  await expect(control).toContainText("Loading Earlier Activity…");
});
