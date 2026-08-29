import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });

async function renderedAnchor(reader: Locator) {
  return reader.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > viewport.top)!;
    return {
      key: row.dataset.virtualKey!,
      offset: row.getBoundingClientRect().top - viewport.top,
      total: Number(element.querySelector<HTMLElement>("[data-virtual-total]")!.dataset.virtualTotal),
    };
  });
}

async function expectDesktopPrependAnchor(page: Page, navigate: (reader: Locator) => Promise<void>) {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(
    "/recovery-notice-e2e.html?pagination=resolve&pagination-delay=300&height=800&width=1000",
  );
  const reader = page.locator(".detail-scroll");
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("1");
  await reader.dispatchEvent("wheel", { deltaY: -40 });
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
  await reader.evaluate((element) => {
    element.scrollTop = 500;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await navigate(reader);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() =>
    requestAnimationFrame(() => resolve()))));
  const before = await renderedAnchor(reader);
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("2");
  await expect.poll(() => page.locator("[data-virtual-total]").getAttribute("data-virtual-total"))
    .not.toBe(String(before.total));
  await expect(page.locator(`[data-virtual-key='${before.key}']`)).toHaveCount(1);
  await expect.poll(() => page.locator(`[data-virtual-key='${before.key}']`).evaluate((row, offset) => {
    const viewport = row.closest<HTMLElement>(".detail-scroll")!.getBoundingClientRect();
    return Math.abs(row.getBoundingClientRect().top - viewport.top - Number(offset));
  }, before.offset)).toBeLessThan(1);
  await expect(page.locator(".transcript-earlier-activity")).not.toBeInViewport();
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
  expect(consoleErrors.filter((message) => message.includes("same key"))).toEqual([]);
}

test("desktop wheel navigation preserves the earlier-page boundary", async ({ page }) => {
  await expectDesktopPrependAnchor(page, async (reader) => {
    await reader.hover();
    await page.mouse.wheel(0, -2_000);
  });
});

test("desktop keyboard navigation preserves the earlier-page boundary", async ({ page }) => {
  await expectDesktopPrependAnchor(page, async (reader) => {
    await reader.focus();
    await reader.dispatchEvent("keydown", { key: "Home" });
    // Chromium does not consistently apply the native Home default to an overflow region in
    // headless mode. Apply that default explicitly after the real React key path arms pagination.
    await reader.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
  });
});

test("desktop direct scrollbar navigation preserves the earlier-page boundary", async ({ page }) => {
  await expectDesktopPrependAnchor(page, async (reader) => {
    await reader.dispatchEvent("pointerdown", { pointerType: "mouse", button: 0 });
    await reader.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
  });
});
