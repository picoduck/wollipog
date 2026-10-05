import { expect, test } from "@playwright/test";

test("resolved question disclosure survives virtual recycling and transcript reprojection", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?question-history=1");
  const reader = page.getByTestId("reader");
  const first = page.locator('[data-virtual-key="item:question:301"] .tl-question > details');
  const second = page.locator('[data-virtual-key="item:question:302"] .tl-question > details');
  await expect(first).not.toHaveAttribute("open");
  await expect(second).not.toHaveAttribute("open");
  await first.locator("summary").click();
  await expect(first).toHaveAttribute("open");
  await expect(second).not.toHaveAttribute("open");

  // Scroll beyond overscan and blur the summary so focus retention cannot keep its row mounted.
  await reader.focus();
  await reader.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await page.getByTestId("stream-tail").click();
  await reader.evaluate((element) => { element.scrollTop = 0; });
  await expect(first).toHaveAttribute("open");
  await expect(second).not.toHaveAttribute("open");
  await expect(first.locator(".tl-question-body strong")).toHaveText("destination 1");
  await expect(first.locator(".tl-question-context code")).toHaveText("staging");
  await expect(first.getByRole("link", { name: "release checklist" })).toBeVisible();

  // Changing row positions must not transfer the first question's state to another event.
  await page.getByTestId("prepend-history").click();
  await reader.evaluate((element) => { element.scrollTop = 0; });
  await first.locator("summary").scrollIntoViewIfNeeded();
  await expect(first).toHaveAttribute("open");
  await second.locator("summary").click();
  await expect(second).toHaveAttribute("open");
  await first.locator("summary").click();
  await expect(first).not.toHaveAttribute("open");
  await reader.focus();
  await reader.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await reader.evaluate((element) => { element.scrollTop = 0; });
  await first.locator("summary").scrollIntoViewIfNeeded();
  await expect(first).not.toHaveAttribute("open");
  await expect(second).toHaveAttribute("open");
});

// #502's reproduction, docked (#2205): a question asked far above the reader, with 80 and more rows
// after it, used to render its form at the transcript row and hand it to a fallback above the
// transcript, so it appeared and then seemed to vanish. It now lives only in the dock above the
// composer, at every scroll position and after a refresh, and its row is a one-line marker.
test("a pending question renders only on the dock at every scroll position and after a refresh, with 90 rows after it (#502, #2205)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agent-questions-e2e.html?before=2&after=90");
  const reader = page.getByRole("region", { name: "Session Activity" });
  const dock = page.locator(".request-dock");
  const marker = page.locator(".ask-marker");
  const expectDocked = async () => {
    await expect(dock).toBeVisible();
    // Expanded at the live tail, or behind its strip while reading back: never at the transcript row.
    await expect(page.locator(".question-card")).toHaveCount(1);
    await expect(dock.locator(".question-card")).toHaveCount(1);
    // Exactly one of the strip and the card shows, read in one pass: the strip may come or go while
    // the reader settles, so the two are never compared across separate reads.
    await expect.poll(() => page.evaluate(() => {
      const strip = document.querySelector(".request-dock .dock-strip") !== null;
      const card = document.querySelector<HTMLElement>(".request-dock .question-card");
      return strip !== (card?.checkVisibility() === true);
    })).toBe(true);
    await expect(reader.getByRole("region", { name: "Agent Questions" })).toHaveCount(0);
    await expect(reader.getByRole("radio")).toHaveCount(0);
    await expect(page.locator(".detail-chat > .question-bar")).toHaveCount(0);
  };
  const read = async (key: string) => {
    await reader.focus();
    await page.keyboard.press(key);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };

  for (const visit of ["first", "refreshed"]) {
    await expect(dock.getByRole("region", { name: "Agent Questions" })).toBeVisible();
    await expectDocked();
    await page.getByRole("radio", { name: /TypeScript/ }).check();
    // Back through the transcript page by page, to its start, then down again and to the live tail.
    for (const key of ["PageUp", "PageUp", "PageUp", "Home", "PageDown", "PageDown", "End"]) {
      await read(key);
      await expectDocked();
    }
    // At the start the marker is the question's only trace in the transcript. Rows measured on the
    // way up can leave one Home short of the start.
    for (let attempt = 0; attempt < 5 && !(await marker.isVisible()); attempt += 1) await read("Home");
    await expect(marker).toBeVisible();
    await expect(marker).toContainText("Language");
    expect(await page.locator("[data-virtual-row]").count()).toBeLessThan(90);
    if (visit === "first") await page.reload();
  }
  // The draft outlived the refresh.
  await page.locator(".dock-strip-title").click();
  await expect(dock.getByRole("radio", { name: /TypeScript/ })).toBeChecked();
});
