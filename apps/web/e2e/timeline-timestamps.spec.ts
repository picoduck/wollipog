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
  await page.locator(".tl-work > .disclosure-trigger").click();

  await expect(page.locator(".tl-agent-msg time")).toHaveCount(0);
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
  for (const text of await page.locator("time").allTextContents()) {
    expect(text, "relative times are sentence case (§17.2)").not.toMatch(/Ago|Just Now/);
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
  for (const text of await page.locator("time").allTextContents()) expect(text).not.toMatch(/ago|just now/i);
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

async function readerGeometry(page: Page) {
  return page.getByTestId("reader").evaluate((reader) => {
    const box = reader.getBoundingClientRect();
    const contentLeft = box.left + reader.clientLeft;
    const contentRight = contentLeft + reader.clientWidth;
    const prose = reader.querySelector(".tl-agent-msg .md p")!.getBoundingClientRect();
    const bubble = reader.querySelector(".tl-bubble")!.getBoundingClientRect();
    const column = reader.querySelector(".timeline")!.getBoundingClientRect();
    return {
      proseInset: prose.left - contentLeft,
      bubbleInset: contentRight - bubble.right,
      columnWidth: column.width,
      columnCenterOffset: (column.left + column.right) / 2 - (contentLeft + contentRight) / 2,
    };
  });
}

for (const theme of ["dark", "light"]) {
  test(`three settled turns read as turns, inside the reader's gutter, with neutral bubbles (${theme})`, async ({ page }) => {
    for (const { width, gutter } of [{ width: 390, gutter: 16 }, { width: 834, gutter: 24 }, { width: 1440, gutter: 24 }]) {
      await page.setViewportSize({ width, height: 1600 });
      await page.goto(`/timeline-timestamps-e2e.html?scenario=turns&theme=${theme}`);
      await expect(page.locator("[data-virtual-kind='timeline']")).toHaveAttribute("data-virtual-measurements", "ready");
      const footers = page.locator(".tl-turn-footer");
      await expect(footers).toHaveCount(3);
      await expect(footers.locator(".tl-turn-label")).toHaveText(["Turn 1", "Turn 2", "Turn 3"]);
      await expect(page.getByText(/Start Turn|End Turn/)).toHaveCount(0);
      for (const time of await footers.locator("time").allTextContents()) expect(time).toMatch(/^\d{1,2}:\d{2}\s?[AP]M$/);
      await expect(footers.first().locator(".tl-turn-usage")).toContainText("$0.04");
      await expect(page.locator(".tl-row.user time, .tl-agent-msg time")).toHaveCount(0);

      const geometry = await readerGeometry(page);
      expect(geometry.proseInset, `${width}px prose inset`).toBeGreaterThanOrEqual(gutter);
      expect(geometry.bubbleInset, `${width}px bubble inset`).toBeGreaterThanOrEqual(gutter);
      if (width === 1440) {
        expect(Math.abs(geometry.columnWidth - 860)).toBeLessThan(1);
        expect(Math.abs(geometry.columnCenterOffset)).toBeLessThan(1);
      }
    }

    const bubble = await page.locator(".tl-bubble").first().evaluate((element) => {
      const probe = document.createElement("div");
      probe.style.background = "var(--bg-elev-2)";
      probe.style.border = "1px solid var(--border)";
      document.body.append(probe);
      const expected = getComputedStyle(probe);
      const style = getComputedStyle(element);
      const result = {
        background: style.backgroundColor, expectedBackground: expected.backgroundColor,
        border: style.borderTopColor, expectedBorder: expected.borderTopColor,
        borderWidth: style.borderTopWidth, backgroundImage: style.backgroundImage,
        fontSize: style.fontSize, lineHeight: style.lineHeight,
      };
      probe.remove();
      return result;
    });
    expect(bubble.background).toBe(bubble.expectedBackground);
    expect(bubble.border).toBe(bubble.expectedBorder);
    expect(bubble.borderWidth).toBe("1px");
    expect(bubble.backgroundImage).toBe("none");
    expect(bubble.fontSize).toBe("14px");
    expect(bubble.lineHeight).toBe("22px");
    const prose = await page.locator(".tl-agent-msg").first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontSize: style.fontSize, lineHeight: style.lineHeight };
    });
    expect(prose).toEqual({ fontSize: "14px", lineHeight: "22px" });

    const time = page.locator(".tl-turn-footer time").first();
    const tooltip = page.locator(".tl-turn-footer [role='tooltip']").first();
    await expect(tooltip).toBeHidden();
    await time.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/^Started \d{1,2}:\d{2}:\d{2}\s?[AP]M, finished \d{1,2}:\d{2}:\d{2}\s?[AP]M \(26s\)$/);
    await expect(time).toHaveAccessibleDescription(/^Started .* \(26s\)$/);
  });
}
