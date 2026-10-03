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
  // No band and no strip (#2166): the composer starts where the reader ends.
  const composerBox = await box(page.locator(".composer"));
  expect(composerBox.top).toBeCloseTo(readerBox.bottom, 0);

  // A status, not a control: focus cannot land on it.
  await recovery.evaluate((element) => (element as HTMLElement).focus());
  expect(await recovery.evaluate((element) => document.activeElement === element)).toBe(false);

  // Context and cost live in the composer bar's trailing cluster (#2166).
  await expect(page.locator(".cbar-right .session-usage .cbar-usage")).toBeVisible();
  await expect(page.locator("[class*='transcript-status']")).toHaveCount(0);
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
      composer: await box(page.locator(".composer")),
    };
  };
  const active = await geometry(false);
  const settled = await geometry(true);
  expect(active.reader.height).toBeCloseTo(settled.reader.height, 0);
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
  await expect(message.locator(".tl-receipt-buttons button").first()).toBeFocused();
});

for (const width of [320, 390]) {
  test(`a ${width}px phone shows the whole recovery sentence and keeps the composer bar inside the pane`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/recovery-notice-e2e.html?mode=expanded&height=640&width=${width}`);
    // Stress the bar with wider-than-default text metrics, as GitHub's Linux fallback face does.
    await page.addStyleTag({ content: ".composer-bar { letter-spacing: 0.35px; }" });
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
      const bar = element.querySelector(".composer-bar") as HTMLElement;
      const controls = [...bar.querySelectorAll(":scope > * > :is(button, .context-control, .session-usage, .cbar-menu)")]
        .map((control) => control.getBoundingClientRect())
        .filter((control) => control.width > 0);
      return {
        reader: rect(".detail-reader"),
        composer: rect(".composer"),
        bar: bar.getBoundingClientRect(),
        barOverflow: bar.scrollWidth - bar.clientWidth,
        meter: rect(".context-control"),
        usage: rect(".session-usage"),
        rows: new Set(controls.map((control) => Math.round(control.top + control.height / 2))).size,
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      };
    });
    // The reader extends to the composer: no strip sits between them (#2166).
    expect(frame.composer.top).toBeCloseTo(frame.reader.bottom, 0);
    expect(frame.hasHorizontalOverflow).toBe(false);
    // The collapsed phone composer keeps every bar control on one row. This agent has no Model
    // Settings to open, so the figures take their own row, which the collapsed pill hides.
    expect(frame.barOverflow).toBeLessThanOrEqual(0);
    expect(frame.rows, "the bar's controls share one row").toBe(1);
    expect(frame.meter.width).toBe(0);
    expect(frame.usage.width).toBe(0);
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

  // The preview has no strip; the control floats inside the reader.
  await expect(page.locator("[class*='transcript-status']")).toHaveCount(0);
  const recovery = control(page);
  await expect(recovery).toHaveText("Checking for missed activity…");
  const recoveryBox = await box(recovery);
  const frame = await box(page.locator("#frame"));
  expect(recoveryBox.top).toBeGreaterThanOrEqual(main.top - 0.5);
  expect(recoveryBox.bottom).toBeLessThanOrEqual(frame.bottom + 0.5);
});

/** The reader's `scrollTop` once a wheel's smooth scroll or a fling has come to rest. */
async function settledScrollTop(page: Page): Promise<number> {
  let last = Number.NaN;
  await expect.poll(async () => {
    const first = await reader(page).evaluate((el) => el.scrollTop);
    await page.waitForTimeout(150);
    last = await reader(page).evaluate((el) => el.scrollTop);
    return first === last;
  }).toBe(true);
  return last;
}

test("the wheel scrolls the transcript over the floating control exactly as beside it (#2425)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=760&width=1100&settled=1");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await readBack(page);
  const jump = control(page);
  await expect(jump).toBeVisible();
  const jumpBox = await box(jump);
  const onControl = { x: jumpBox.left + jumpBox.width / 2, y: jumpBox.top + jumpBox.height / 2 };
  const beside = { x: jumpBox.left - 60, y: onControl.y };

  // Rows are measured as they first scroll into view, which corrects `scrollTop` along the way. Each
  // wheel therefore starts from the same place, after a first pass has measured the rows it crosses.
  const start = await settledScrollTop(page);
  const wheelAt = async (point: { x: number; y: number }, deltaY: number) => {
    await reader(page).evaluate((el, top) => { el.scrollTop = top; }, start);
    await settledScrollTop(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, deltaY);
    return await settledScrollTop(page) - start;
  };
  await wheelAt(beside, -300);
  const overControl = await wheelAt(onControl, -300);
  const besideControl = await wheelAt(beside, -300);
  expect(besideControl, "the reader beside the control scrolls").toBeLessThan(-200);
  expect(Math.abs(overControl - besideControl), "the same wheel moves the transcript the same amount")
    .toBeLessThanOrEqual(2);
  await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "paused");

  // Wheeling back down over the control reaches the tail and resumes following, as it does beside it.
  await page.mouse.move(onControl.x, onControl.y);
  await expect.poll(async () => {
    await page.mouse.wheel(0, 600);
    return reader(page).getAttribute("data-follow-tail-state");
  }).toBe("following");
  await expect(jump).toHaveCount(0);

  // A click still returns to the tail.
  await readBack(page);
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "following");
  await expect(reader(page)).toBeFocused();
});

test("the wheel over the recovery status pauses following like the reader beside it (#2425)", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/recovery-notice-e2e.html?mode=expanded&height=640");
  const recovery = control(page);
  await expect(recovery).toHaveText("Checking for missed activity…");
  await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "following");
  const before = await settledScrollTop(page);
  const recoveryBox = await box(recovery);
  await page.mouse.move(recoveryBox.left + recoveryBox.width / 2, recoveryBox.top + recoveryBox.height / 2);
  await page.mouse.wheel(0, -300);
  await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "paused");
  expect(await settledScrollTop(page) - before).toBeLessThan(-200);
});

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a drag that starts on the floating control scrolls the transcript (#2425)", async ({ page, context }) => {
    await page.goto("/recovery-notice-e2e.html?mode=expanded&height=700&width=390&settled=1");
    await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
    await reader(page).dispatchEvent("wheel", { deltaY: -40 });
    await reader(page).evaluate((el) => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 1200); });
    const jump = control(page);
    await expect(jump).toBeVisible();
    const jumpBox = await box(jump);
    const client = await context.newCDPSession(page);
    const drag = async (x: number, startY: number, distance: number) => {
      const before = await settledScrollTop(page);
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY, id: 1 }] });
      for (let step = 1; step <= 10; step += 1) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: startY - (distance * step) / 10, id: 1 }],
        });
        await page.waitForTimeout(16);
      }
      // Hold still before lifting, so the drag ends without a fling and both drags compare closely.
      await page.waitForTimeout(150);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      return await settledScrollTop(page) - before;
    };
    const y = jumpBox.top + jumpBox.height / 2;
    // Moving the finger down reads back toward earlier activity.
    const onControl = await drag(jumpBox.left + jumpBox.width / 2, y, -200);
    const besideControl = await drag(jumpBox.left - 40, y, -200);
    expect(besideControl, "the reader beside the control scrolls").toBeLessThan(-100);
    expect(onControl, "a drag starting on the control scrolls the transcript").toBeLessThan(-100);
    expect(Math.abs(onControl - besideControl)).toBeLessThanOrEqual(24);
    await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "paused");

    // A tap still returns to the tail.
    await jump.tap();
    await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "following");
    await expect(jump).toHaveCount(0);

    // A drag that reaches the tail hides the control under the finger; the same gesture keeps
    // scrolling when it turns back, without lifting.
    await reader(page).dispatchEvent("wheel", { deltaY: -40 });
    await reader(page).evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 150; });
    await expect(jump).toBeVisible();
    const near = await box(jump);
    const x = near.left + near.width / 2;
    const startY = near.top + near.height / 2;
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY, id: 1 }] });
    for (let step = 1; step <= 10; step += 1) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: startY - 30 * step, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await expect(jump, "the drag reached the tail").toHaveCount(0);
    const atTail = await reader(page).evaluate((el) => el.scrollTop);
    for (let step = 1; step <= 10; step += 1) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: startY - 300 + 25 * step, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(150);
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await settledScrollTop(page) - atTail, "turning back reads back again").toBeLessThan(-150);
    await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "paused");
  });
});
