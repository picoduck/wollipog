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

async function settleReaderScrollTop(reader: Locator, scrollTop: number) {
  await reader.evaluate((element, nextScrollTop) => new Promise<void>((resolve) => {
    const finish = () => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    };
    element.addEventListener("scroll", finish, { once: true });
    const previousScrollTop = element.scrollTop;
    element.scrollTop = nextScrollTop;
    // Assigning the current value does not enqueue a native event. Preserve the same React scroll
    // path for Chromium's occasional native Home behavior while still waiting for it to settle.
    if (element.scrollTop === previousScrollTop) {
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  }), scrollTop);
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
  // Consume the native event from positioning the reader before the next input arms pagination.
  // Otherwise Chromium can deliver that stale event after pointerdown and clear the fresh intent.
  await settleReaderScrollTop(reader, 500);

  await navigate(reader);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() =>
    requestAnimationFrame(() => resolve()))));
  await expect.poll(() => reader.evaluate((element) => element.scrollTop), {
    message: "reader navigation did not reach the earlier-activity boundary",
  }).toBeLessThanOrEqual(160);
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

test("an event-heavy desktop opening fills itself before exposing earlier activity", async ({ page }) => {
  await page.goto(
    "/recovery-notice-e2e.html?pagination=resolve&event-heavy=1&height=800&width=1000",
  );

  const reader = page.locator(".detail-scroll");
  const control = page.locator(".transcript-earlier-activity");
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("2");
  await expect.poll(() => reader.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(160);
  await expect(control).toHaveCount(1);
  await expect(control).not.toBeInViewport();
  await expect(control).toHaveText("Load Earlier Activity");
  await expect(page.getByText("A response near the beginning of the loaded activity may be incomplete."))
    .toHaveCount(0);
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "following");
});

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
    await settleReaderScrollTop(reader, 0);
  });
});

test("desktop direct scrollbar navigation preserves the earlier-page boundary", async ({ page }) => {
  await expectDesktopPrependAnchor(page, async (reader) => {
    await reader.dispatchEvent("pointerdown", { pointerType: "mouse", button: 0 });
    await settleReaderScrollTop(reader, 0);
  });
});

/** Position the paused reader at an exact scrollTop without arming pagination: the fixture's
 * reader intent expires once a gesture's scroll stream goes quiet, so a programmatic move after
 * that window is a layout scroll, not navigation. */
async function positionPausedReader(page: Page, reader: Locator, scrollTop: number) {
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("1");
  await reader.dispatchEvent("wheel", { deltaY: -40 });
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
  await page.waitForTimeout(250);
  await settleReaderScrollTop(reader, scrollTop);
  await page.waitForTimeout(250);
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("1");
}

test("one reading key whose scroll stream starts above the trigger still loads when it lands at the head", async ({ page }) => {
  await page.goto("/recovery-notice-e2e.html?pagination=resolve&pagination-delay=300&height=800&width=1000");
  const reader = page.locator(".detail-scroll");
  await positionPausedReader(page, reader, 700);
  const before = await renderedAnchor(reader);

  // A smooth-scrolling browser answers one PageUp with a stream of scroll events; the first ones
  // are still above the trigger zone, and the last one lands on the transcript head.
  await reader.dispatchEvent("keydown", { key: "PageUp" });
  await reader.evaluate((element) => new Promise<void>((resolve) => {
    const stream = [520, 360, 210, 90, 0];
    const step = () => {
      const next = stream.shift();
      if (next === undefined) return resolve();
      element.scrollTop = next;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));

  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("2");
  await expect.poll(() => page.locator("[data-virtual-total]").getAttribute("data-virtual-total"))
    .not.toBe(String(before.total));
  await expect(page.locator(`[data-virtual-key='${before.key}']`)).toHaveCount(1);
  await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
  // The stream requested exactly one page; nothing else fires until the reader navigates again.
  await page.waitForTimeout(600);
  await expect(page.locator("body")).toHaveAttribute("data-tail-request-count", "2");
});

test("upward wheel input at the head loads the next page without a scroll event", async ({ page }) => {
  await page.goto("/recovery-notice-e2e.html?pagination=resolve&pagination-delay=300&height=800&width=1000");
  const reader = page.locator(".detail-scroll");
  await positionPausedReader(page, reader, 0);
  await expect(page.locator(".transcript-earlier-activity")).toBeInViewport();
  const before = await renderedAnchor(reader);

  await reader.hover();
  await page.mouse.wheel(0, -100);
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("2");
  // Repeated ticks while the page is in flight cannot duplicate the request.
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await expect(page.locator("body")).toHaveAttribute("data-tail-request-count", "2");

  await expect.poll(() => page.locator("[data-virtual-total]").getAttribute("data-virtual-total"))
    .not.toBe(String(before.total));
  await expect(page.locator(`[data-virtual-key='${before.key}']`)).toHaveCount(1);
  await expect.poll(() => page.locator(`[data-virtual-key='${before.key}']`).evaluate((row, offset) => {
    const viewport = row.closest<HTMLElement>(".detail-scroll")!.getBoundingClientRect();
    return Math.abs(row.getBoundingClientRect().top - viewport.top - Number(offset));
  }, before.offset)).toBeLessThan(1);
  await expect(page.locator(".transcript-earlier-activity")).not.toBeInViewport();
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
});

test("an upward reading key at the head loads the next page without a scroll event", async ({ page }) => {
  await page.goto("/recovery-notice-e2e.html?pagination=resolve&pagination-delay=300&height=800&width=1000");
  const reader = page.locator(".detail-scroll");
  await positionPausedReader(page, reader, 0);

  await reader.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("2");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("body")).toHaveAttribute("data-tail-request-count", "2");
  await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
});
