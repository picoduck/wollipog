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

test("the first mobile touch traversal loads earlier activity", async ({ page }) => {
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

  await reader.evaluate((element) => {
    const dispatchTouch = (type: "touchstart" | "touchmove" | "touchend", clientY?: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", {
        value: clientY === undefined ? [] : [{ clientY }],
      });
      element.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 100);
    for (const [scrollTop, clientY] of [[260, 200], [0, 300]]) {
      dispatchTouch("touchmove", clientY);
      element.scrollTop = scrollTop;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    dispatchTouch("touchend");
  });

  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("2");
  await expect(control).toContainText("Loading Earlier Activity…");
});

test("an event-heavy mobile opening fills itself before exposing earlier activity", async ({ page }) => {
  await page.goto(
    "/recovery-notice-e2e.html?pagination=resolve&event-heavy=1&height=720&width=412",
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

test("resolved earlier pages preserve the mobile reading boundary", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("/recovery-notice-e2e.html?pagination=resolve&live=1&height=720&width=412");

  const reader = page.locator(".detail-scroll");
  const control = page.locator(".transcript-earlier-activity");
  await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count")).toBe("1");
  await reader.dispatchEvent("wheel", { deltaY: -40 });
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");

  const traverseToHead = async () => reader.evaluate((element) => {
    const dispatchTouch = (type: "touchstart" | "touchmove" | "touchend", clientY?: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", {
        value: clientY === undefined ? [] : [{ clientY }],
      });
      element.dispatchEvent(event);
    };
    const max = element.scrollHeight - element.clientHeight;
    element.scrollTop = Math.max(240, Math.min(max, 480));
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    dispatchTouch("touchstart", 100);
    dispatchTouch("touchmove", 200);
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    const viewport = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > viewport.top)!;
    const anchor = {
      key: row.dataset.virtualKey!,
      offset: row.getBoundingClientRect().top - viewport.top,
      index: Number(row.dataset.index),
      total: Number(element.querySelector<HTMLElement>("[data-virtual-total]")!.dataset.virtualTotal),
    };
    const state = window as unknown as {
      __prependSamples?: Array<{ offset: number | null; scrollTop: number }>;
      __stopPrependSamples?: () => Array<{ offset: number | null; scrollTop: number }>;
    };
    let sampling = true;
    state.__prependSamples = [];
    const sample = () => {
      if (!sampling) return;
      const current = element.querySelector<HTMLElement>(`[data-virtual-key='${anchor.key}']`);
      state.__prependSamples!.push({
        offset: current ? current.getBoundingClientRect().top - element.getBoundingClientRect().top : null,
        scrollTop: element.scrollTop,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    state.__stopPrependSamples = () => {
      sampling = false;
      return state.__prependSamples ?? [];
    };

    const timeline = element.querySelector<HTMLElement>("[data-virtual-total]")!;
    const initialTotal = timeline.dataset.virtualTotal;
    const observer = new MutationObserver(() => {
      if (timeline.dataset.virtualTotal === initialTotal) return;
      observer.disconnect();
      let frames = 3;
      const delayMeasurement = () => {
        if (frames-- > 0) {
          requestAnimationFrame(delayMeasurement);
          return;
        }
        const anchored = element.querySelector<HTMLElement>(`[data-virtual-key='${anchor.key}']`);
        const anchorIndex = Number(anchored?.dataset.index);
        const earlier = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")]
          .find((candidate) => Number(candidate.dataset.index) < anchorIndex);
        if (earlier) earlier.style.minHeight = `${earlier.offsetHeight + 120}px`;
      };
      requestAnimationFrame(delayMeasurement);
    });
    observer.observe(timeline, { attributes: true, attributeFilter: ["data-virtual-total"] });
    dispatchTouch("touchend");
    return anchor;
  });

  for (const requestCount of [2, 3]) {
    const before = await traverseToHead();
    await expect.poll(() => page.locator("body").getAttribute("data-tail-request-count"))
      .toBe(String(requestCount));
    await expect.poll(() => page.locator("[data-virtual-total]").getAttribute("data-virtual-total"))
      .not.toBe(String(before.total));
    await expect.poll(() => page.locator(`[data-virtual-key='${before.key}']`).evaluate((row, offset) => {
      const viewport = row.closest<HTMLElement>(".detail-scroll")!.getBoundingClientRect();
      return Math.abs(row.getBoundingClientRect().top - viewport.top - Number(offset));
    }, before.offset)).toBeLessThan(1);
    await expect(page.locator(`[data-virtual-key='${before.key}']`)).toHaveCount(1);
    expect(Number(await page.locator(`[data-virtual-key='${before.key}']`).getAttribute("data-index")))
      .toBeGreaterThan(before.index);
    const samples = await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let frames = 16;
        const settle = () => frames-- > 0 ? requestAnimationFrame(settle) : resolve();
        requestAnimationFrame(settle);
      });
      return (window as unknown as {
        __stopPrependSamples?: () => Array<{ offset: number | null; scrollTop: number }>;
      }).__stopPrependSamples?.() ?? [];
    });
    expect(samples.filter((sample) => sample.offset === null), JSON.stringify(samples)).toHaveLength(0);
    expect(Math.max(...samples.map((sample) => Math.abs(sample.offset! - before.offset))), JSON.stringify(samples))
      .toBeLessThan(1);
    await expect(control).not.toBeInViewport();
    await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
  }
  expect(consoleErrors.filter((message) => message.includes("same key"))).toEqual([]);
});
