import { expect, test, type Locator } from "@playwright/test";

/** Real-browser geometry for the transcript recovery notice (issue #56, review round 3).
 * The harness holds recovery ACTIVE for the whole page life (its history endpoint never
 * resolves) and `?height=` fixes the pane like an inbox splitter position would. */

const box = (locator: Locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  });

test("a short preview pane always keeps the status strip and its follow control usable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/recovery-notice-e2e.html?mode=preview&height=150");
  const strip = page.locator(".transcript-status-strip");
  await expect(strip).toBeVisible();

  // Sanity: this pane is genuinely below the compact threshold (the clipped-strip regression
  // was observed at a ~99px transcript pane).
  const main = await box(page.locator(".detail-main"));
  expect(main.height).toBeLessThan(240);
  expect(main.height).toBeGreaterThan(60);

  // Compact mode: the slot is collapsed even though recovery is active…
  await expect(page.locator(".transcript-recovery-slot")).toBeHidden();
  // …and the strip itself carries the active-recovery echo instead.
  const echo = page.locator(".transcript-recovery-strip-echo");
  await expect(echo).toBeVisible();
  await expect(echo).toContainText("Checking for Missed Activity…");

  // The whole strip fits inside the clipped pane — nothing extends below the frame —
  // and the follow-state control takes a real click (Playwright verifies it is visible,
  // stable, and actually receives the pointer event).
  const frame = await box(page.locator("#frame"));
  const stripBox = await box(strip);
  expect(stripBox.bottom).toBeLessThanOrEqual(frame.bottom + 0.5);
  const chip = page.locator(".follow-tail-chip");
  await expect(chip).toBeVisible();
  await chip.click();
});

test("a tall pane shows the in-flow pill and the pinned summary can never intersect it", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=640&pinned=1");
  const slot = page.locator(".transcript-recovery-slot");
  await expect(slot).toBeVisible();
  await expect(page.locator(".transcript-recovery-notice")).toBeVisible();
  await expect(page.locator(".transcript-recovery-notice")).toContainText("Checking for Missed Activity…");
  const summary = page.locator(".pinned-summary");
  await expect(summary).toBeVisible();

  // The summary is bounded by the reader region, and the reader region ends where the slot
  // begins — so the summary cannot intersect the active pill REGARDLESS of the pill's rendered
  // height (no hardcoded pixel reservation involved).
  const readerBox = await box(page.locator(".detail-reader"));
  const summaryBox = await box(summary);
  const slotBox = await box(slot);
  expect(summaryBox.bottom).toBeLessThanOrEqual(readerBox.bottom + 0.5);
  expect(slotBox.top).toBeGreaterThanOrEqual(readerBox.bottom - 0.5);
  expect(summaryBox.bottom).toBeLessThanOrEqual(slotBox.top + 0.5);

  // In the tall pane the compact echo stays out of the strip.
  await expect(page.locator(".transcript-recovery-strip-echo")).toBeHidden();
});

test("a full-height mobile Session keeps recovery in the persistent strip without an empty band", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });

  const readGeometry = async (settled: boolean) => {
    await page.goto(`/recovery-notice-e2e.html?mode=expanded&height=640&width=390${settled ? "&settled=1" : ""}`);
    const slot = page.locator(".transcript-recovery-slot");
    const echo = page.locator(".transcript-recovery-strip-echo");
    const strip = page.locator(".transcript-status-strip");
    await expect(slot).toBeHidden();
    await expect(slot).toHaveClass(settled ? /transcript-recovery-slot$/ : /active/);
    if (settled) await expect(echo).toBeHidden();
    else {
      await expect(echo).toBeVisible();
      await expect(echo).toContainText("Checking for Missed Activity…");
    }
    await expect(page.locator(".follow-tail-chip")).toContainText("Following Live Output");

    return page.locator("#frame").evaluate((frame) => {
      const rect = (selector: string) => {
        const box = frame.querySelector(selector)!.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      };
      const slotBox = rect(".transcript-recovery-slot");
      const reader = rect(".detail-reader");
      const stripBox = rect(".transcript-status-strip");
      return {
        reader,
        strip: stripBox,
        slot: slotBox,
        hasHorizontalOverflow: frame.scrollWidth > frame.clientWidth,
      };
    });
  };

  const active = await readGeometry(false);
  const inactive = await readGeometry(true);
  for (const state of [active, inactive]) {
    expect(state.slot.height).toBe(0);
    expect(state.strip.top).toBeCloseTo(state.reader.bottom, 0);
    expect(state.strip.height).toBeLessThanOrEqual(37.5);
    expect(state.hasHorizontalOverflow).toBe(false);
  }
  expect(active.reader.height).toBeCloseTo(inactive.reader.height, 0);
  expect(active.strip.top).toBeCloseTo(inactive.strip.top, 0);
});

test("a compressed expanded pane hides the pinned summary instead of letting it cover the strip", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=250&pinned=1");
  // The reader is too short to contain the floating card, so it must not render at all —
  // an escaped card previously covered the compact status strip.
  await expect(page.locator(".pinned-summary")).toBeHidden();

  // The compact strip (with its echo) survives fully inside the pane and stays usable.
  const strip = page.locator(".transcript-status-strip");
  await expect(strip).toBeVisible();
  await expect(page.locator(".transcript-recovery-slot")).toBeHidden();
  await expect(page.locator(".transcript-recovery-strip-echo")).toBeVisible();
  const frame = await box(page.locator("#frame"));
  const stripBox = await box(strip);
  expect(stripBox.bottom).toBeLessThanOrEqual(frame.bottom + 0.5);
  await page.locator(".follow-tail-chip").click();
});

test("in a narrow compact expanded pane the active echo wins the leading cell over the meter", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=250&width=320");
  const echo = page.locator(".transcript-recovery-strip-echo");
  await expect(echo).toBeVisible();

  // The context meter (fixed width, wider than the whole leading track at this width) yields
  // while recovery is active — otherwise it starved the echo's label to zero visible width.
  await expect(page.locator(".context-meter")).toBeHidden();

  // The label keeps genuinely readable width and truncates rather than vanishing.
  const label = echo.locator("span").last();
  const geometry = await label.evaluate((el) => ({
    visible: el.clientWidth,
    full: el.scrollWidth,
    textOverflow: getComputedStyle(el).textOverflow,
  }));
  expect(geometry.visible).toBeGreaterThan(0);
  expect(geometry.full).toBeGreaterThanOrEqual(geometry.visible);
  expect(geometry.textOverflow).toBe("ellipsis");
});

test("growing the pane past the compact threshold never re-hides the pinned summary", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  // Just below the pane's compact switch, at the first non-compact pane (the slot returns and
  // shrinks the reader), and comfortably above it: disclosure must be monotonic — the summary
  // stays visible at every step of a splitter drag upward. Before the threshold coordination,
  // the middle height hid the card until the pane out-grew the returning slot by ~30px.
  for (const height of [439, 439.5, 469]) {
    await page.goto(`/recovery-notice-e2e.html?mode=expanded&height=${height}&pinned=1`);
    await expect(page.locator(".pinned-summary"), `pinned summary at harness height ${height}`).toBeVisible();
  }
});

test("a 320px-wide compact pane keeps the echo inside the viewport, truncating in place", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/recovery-notice-e2e.html?mode=preview&height=150&width=320");
  const echo = page.locator(".transcript-recovery-strip-echo");
  await expect(echo).toBeVisible();

  // The whole echo stays within its grid track and therefore within the viewport — the
  // regression pushed it to x ≈ -100 with only the label's tail visible.
  const echoBox = await echo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  expect(echoBox.left).toBeGreaterThanOrEqual(-0.5);
  expect(echoBox.right).toBeLessThanOrEqual(320.5);

  // And it truncates in place: the label is genuinely wider than its clipped box.
  const truncated = await echo.locator("span").last()
    .evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis");
  expect(truncated).toBe(true);
});
