import { expect, test, type Locator, type Page } from "@playwright/test";

/** Real-browser geometry for the floating tail control (#2153), which replaced the reserved
 * recovery band of #56 and the always-on follow chip. The harness holds recovery ACTIVE for the
 * whole page life (its history endpoint never resolves) unless `?settled=1`, and `?height=` fixes
 * the pane like an Inbox splitter position would. */

const box = (locator: Locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
  });

const control = (page: Page) => page.locator(".transcript-tail-anchor > .transcript-tail-control");
const reader = (page: Page) => page.locator(".detail-scroll[data-follow-tail-state]");

async function readBack(page: Page) {
  const readerBox = await box(reader(page));
  await page.mouse.move(readerBox.left + readerBox.width / 2, readerBox.top + readerBox.height / 2);
  await page.mouse.wheel(0, -600);
  await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "paused");
  // Let the wheel's smooth scroll finish before reading positions.
  await expect.poll(async () => {
    const first = await reader(page).evaluate((el) => el.scrollTop);
    await page.waitForTimeout(120);
    return first === await reader(page).evaluate((el) => el.scrollTop);
  }).toBe(true);
}

test("a tall pane floats recovery above the reader's lower edge without reserving a band", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=640");
  const recovery = control(page);
  await expect(recovery).toBeVisible();
  await expect(recovery).toHaveText("Checking for missed activity…");
  await expect(recovery).toHaveAttribute("role", "status");
  await expect(page.locator("[data-transcript-recovery-status]")).toHaveText("Checking for missed activity…");

  // Floating --space-3 above the reader's lower edge, centered on the reading column.
  const readerBox = await box(page.locator(".detail-reader"));
  const recoveryBox = await box(recovery);
  expect(readerBox.bottom - recoveryBox.bottom).toBeCloseTo(12, 0);
  expect(Math.abs((recoveryBox.left + recoveryBox.width / 2) - (readerBox.left + readerBox.width / 2))).toBeLessThan(8);
  // No band: the strip starts where the reader ends.
  const stripBox = await box(page.locator(".transcript-status-strip"));
  expect(stripBox.top).toBeCloseTo(readerBox.bottom, 0);

  // A status, not a control: focus cannot land on it.
  await recovery.evaluate((element) => (element as HTMLElement).focus());
  expect(await recovery.evaluate((element) => document.activeElement === element)).toBe(false);

  // Session cost stays in the strip, never in the composer, until #2166 moves it.
  await expect(page.locator(".transcript-status-usage")).toBeVisible();
  await expect(page.locator(".cbar-usage")).toHaveCount(0);
  await expect(page.locator(".transcript-recovery-slot, .follow-tail-chip")).toHaveCount(0);
});

test("recovery coming and going never moves the reader or its follow state", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  const geometry = async (settled: boolean) => {
    await page.goto(`/recovery-notice-e2e.html?mode=expanded&height=640${settled ? "&settled=1" : ""}`);
    await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
    if (settled) await expect(control(page)).toHaveCount(0);
    else await expect(control(page)).toBeVisible();
    await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "following");
    return {
      reader: await box(page.locator(".detail-reader")),
      strip: await box(page.locator(".transcript-status-strip")),
      composer: await box(page.locator(".composer")),
    };
  };
  const active = await geometry(false);
  const settled = await geometry(true);
  expect(active.reader.height).toBeCloseTo(settled.reader.height, 0);
  expect(active.strip.top).toBeCloseTo(settled.strip.top, 0);
  expect(active.composer.top).toBeCloseTo(settled.composer.top, 0);
});

test("Jump to Latest, its new-row count, and End keep the reader's place until asked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=760&width=1100&settled=1");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  // An idle tail says nothing.
  await expect(control(page)).toHaveCount(0);

  await readBack(page);
  const jump = control(page);
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAccessibleName("Jump to Latest");
  await expect(jump.locator("kbd")).toHaveText("End");
  const scrollTop = await reader(page).evaluate((el) => el.scrollTop);

  await page.evaluate(() => (window as typeof window & { appendFixtureEvents: (n: number) => void }).appendFixtureEvents(3));
  await expect(jump).toHaveAccessibleName("3 New, Jump to Latest");
  await expect(jump).toContainText("3 New");
  expect(await reader(page).evaluate((el) => el.scrollTop), "new rows leave the reader in place").toBe(scrollTop);
  await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "paused");

  await reader(page).focus();
  await page.keyboard.press("End");
  await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "following");
  await expect(jump).toHaveCount(0);
  await expect.poll(() => reader(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThanOrEqual(2);

  await readBack(page);
  await expect(jump).toHaveAccessibleName("Jump to Latest", { timeout: 2_000 });
  await jump.click();
  await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "following");
  await expect(jump).toHaveCount(0);
  await expect(reader(page)).toBeFocused();
});

test("an off-screen message that was not sent is named in danger text and scrolls into view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=760&width=1100&settled=1&not-sent=1");
  const message = page.getByTestId("pending-prompt-prompt-not-sent");
  await expect(message).toBeInViewport();
  await expect(control(page)).toHaveCount(0);

  await readBack(page);
  await expect(message).not.toBeInViewport();
  const notSent = control(page);
  await expect(notSent).toHaveText("1 Message Not Sent");
  const colours = await notSent.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger-text)";
    document.body.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    return { text: getComputedStyle(element).color, danger };
  });
  expect(colours.text).toBe(colours.danger);

  await notSent.click();
  await expect(message).toBeInViewport();
  // Focus follows to the message's first action, so the keyboard lands where the person can act.
  await expect(message.locator(".pending-prompt-actions button").first()).toBeFocused();
});

for (const width of [320, 390]) {
  test(`a ${width}px phone shows the whole recovery sentence and keeps the strip inside the pane`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/recovery-notice-e2e.html?mode=expanded&height=640&width=${width}`);
    // Stress the strip with wider-than-default text metrics, as GitHub's Linux fallback face does.
    await page.addStyleTag({ content: ".transcript-status-strip { letter-spacing: 0.35px; }" });
    const recovery = control(page);
    await expect(recovery).toBeVisible();
    const label = await recovery.locator("span").last().evaluate((element) => ({
      visible: element.getBoundingClientRect().width,
      full: element.scrollWidth,
      text: element.textContent,
    }));
    expect(label.text).toBe("Checking for missed activity…");
    expect(label.visible, "the full sentence is visible, not truncated").toBeGreaterThanOrEqual(label.full - 0.5);
    const recoveryBox = await box(recovery);
    expect(recoveryBox.left).toBeGreaterThanOrEqual(0);
    expect(recoveryBox.right).toBeLessThanOrEqual(width + 0.5);

    const frame = await page.locator("#frame").evaluate((element) => {
      const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      const strip = rect(".transcript-status-strip");
      return {
        reader: rect(".detail-reader"),
        strip,
        meter: rect(".context-control"),
        usage: rect(".transcript-status-usage"),
        stripCenter: strip.left + strip.width / 2,
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      };
    });
    expect(frame.strip.top).toBeCloseTo(frame.reader.bottom, 0);
    expect(frame.strip.height).toBeLessThanOrEqual(37.5);
    expect(frame.hasHorizontalOverflow).toBe(false);
    // Context and cost flank the strip's empty center.
    expect(frame.meter.left).toBeGreaterThanOrEqual(frame.strip.left - 0.5);
    expect(frame.meter.right).toBeLessThanOrEqual(frame.stripCenter + 0.5);
    expect(frame.usage.left).toBeGreaterThanOrEqual(frame.stripCenter - 0.5);
    expect(frame.usage.right).toBeLessThanOrEqual(frame.strip.right + 0.5);
  });
}

test("enlarged text wraps the recovery sentence inside a 320px pane instead of overflowing it", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=640&width=320");
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
  const recovery = control(page);
  await expect(recovery).toHaveText("Checking for missed activity…");
  const geometry = await recovery.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const label = element.querySelector("span:last-child") as HTMLElement;
    const reader = document.querySelector(".detail-reader")!.getBoundingClientRect();
    return {
      left: box.left, right: box.right, bottom: box.bottom,
      readerBottom: reader.bottom,
      labelOverflow: label.scrollWidth - label.clientWidth,
      contentOverflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(320.5);
  expect(geometry.labelOverflow, "the whole sentence is shown, not clipped").toBeLessThanOrEqual(0.5);
  expect(geometry.contentOverflow).toBeLessThanOrEqual(0.5);
  expect(geometry.readerBottom - geometry.bottom, "it still sits --space-3 above the reader's edge")
    .toBeCloseTo(12, 0);
});

test("a short preview pane keeps the floating control inside the pane", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/recovery-notice-e2e.html?mode=preview&height=150");
  // Sanity: a genuinely short pane (the clipped-strip regression was observed at ~99px).
  const main = await box(page.locator(".detail-main"));
  expect(main.height).toBeLessThan(240);
  expect(main.height).toBeGreaterThan(60);

  // The preview has no strip at all; the control floats inside the reader.
  await expect(page.locator(".transcript-status-strip")).toHaveCount(0);
  const recovery = control(page);
  await expect(recovery).toHaveText("Checking for missed activity…");
  const recoveryBox = await box(recovery);
  const frame = await box(page.locator("#frame"));
  expect(recoveryBox.top).toBeGreaterThanOrEqual(main.top - 0.5);
  expect(recoveryBox.bottom).toBeLessThanOrEqual(frame.bottom + 0.5);
});
