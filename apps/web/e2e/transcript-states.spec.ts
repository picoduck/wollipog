import { expect, test, type Page } from "@playwright/test";

/** The reading column's load, empty and history-error states in a real browser (#2172). */

test.use({ reducedMotion: "reduce" });

async function open(page: Page, query: string) {
  await page.goto(`/transcript-states-e2e.html?${query}`);
  await expect(page.locator(".detail-scroll")).toBeVisible();
}

/** The reader's content box: where a row in the reading column starts and ends. */
async function readingColumn(page: Page) {
  return page.locator(".detail-scroll").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: box.left + Number.parseFloat(style.paddingLeft),
      right: box.right - Number.parseFloat(style.paddingRight),
      top: box.top + Number.parseFloat(style.paddingTop),
    };
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("an empty session's state sits at the top left of the reading column", async ({ page }) => {
      await open(page, "state=awaiting");
      const title = page.getByText("Start the Conversation");
      await expect(title).toBeVisible();
      await expect(page.getByText("Claude Code is ready in Wollipog on Build Box.")).toBeVisible();
      const column = await readingColumn(page);
      const box = (await page.locator(".detail-scroll .state").boundingBox())!;
      expect(Math.abs(box.x - column.left)).toBeLessThanOrEqual(1);
      expect(box.y - column.top).toBeLessThanOrEqual(32);
      await page.getByRole("button", { name: "Browse Files" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-right-panel-mode", "files");
      await expect(page.locator(".transcript-tail-control")).toHaveCount(0);
    });

    test("a history failure is one notice that heads the reading column and never covers a row", async ({ page }) => {
      await open(page, "state=history-partial");
      const notice = page.locator(".detail-reader .notice");
      await expect(notice).toHaveCount(1);
      await expect(notice).toContainText("Couldn't Load the Full Conversation");
      await expect(notice).toContainText("Loaded 9 of 60 events from Build Box.");
      await expect(page.getByText("Activity Unavailable")).toHaveCount(0);
      await expect(page.getByText(/502 Bad Gateway|Could not load complete/u)).toHaveCount(0);
      await page.locator("[data-virtual-row]").first().waitFor();
      const reader = page.locator(".detail-scroll");
      const column = await readingColumn(page);
      const box = (await notice.boundingBox())!;
      expect(Math.abs(box.x - column.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.x + box.width - column.right)).toBeLessThanOrEqual(1);
      // The notice takes its own height above the scroller: the scroller starts below it, so no
      // row can sit under it at any scroll position.
      const scroller = (await reader.boundingBox())!;
      expect(scroller.y).toBeGreaterThanOrEqual(box.y + box.height);
      // The reader opens at the tail, and the notice is still in view there.
      await expect(notice).toBeInViewport();
      // Scrolled to the top, the first row starts below the notice and is fully readable. The reader
      // opens following the tail, and a bare scrollTop assignment carries no reader intent: a row
      // measurement landing in that settle window follows the tail again after a single jump. Each
      // poll returns to the top and reads it back two frames later, so it passes only once the reader
      // stays there.
      const topAfterTwoFrames = () => reader.evaluate(async (element) => {
        element.scrollTop = 0;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return element.scrollTop;
      });
      await expect.poll(topAfterTwoFrames).toBe(0);
      // The virtual list re-renders its window and corrects its anchor as rows are measured, which
      // can move the reader off the top after a single jump. Each poll returns to the top, then reads
      // the head row (index 0); until it is mounted the poll reads null and keeps waiting, so an
      // empty window can never pass.
      const headRowTop = () => reader.evaluate((element) => {
        element.scrollTop = 0;
        const head = element.querySelector<HTMLElement>("[data-virtual-row][data-index='0']");
        return head && element.scrollTop === 0 ? head.getBoundingClientRect().top : null;
      });
      await expect.poll(headRowTop).not.toBeNull();
      await expect.poll(headRowTop).toBeGreaterThanOrEqual(box.y + box.height);
      expect((await notice.boundingBox())!.y).toBe(box.y);
      await notice.getByRole("button", { name: "Show Details" }).click();
      await expect(notice.locator(".notice-details-body")).toHaveText("Could not load complete session activity.");
    });

    test("a failed message keeps its row, Retry and Dismiss while history loads or failed to load (#2500)", async ({ page }) => {
      for (const state of ["loading", "history-error"]) {
        await open(page, `state=${state}&failed=1`);
        if (state === "loading") await expect(page.locator(".transcript-skeleton")).toBeVisible();
        else await expect(page.locator(".detail-reader .notice")).toContainText("Couldn't Load the Full Conversation");
        const row = page.locator('.detail-scroll [data-pending-prompt-id="prompt-failed"]');
        await expect(row).toBeInViewport();
        await expect(row.locator(".tl-receipt")).toContainText("Delivery Failed");
        await expect(row.locator(".tl-receipt")).toContainText("Sign-in was dismissed, so this message wasn't sent.");
        const retry = row.getByRole("button", { name: "Retry Message" });
        const dismiss = row.getByRole("button", { name: "Dismiss" });
        await expect(retry).toBeEnabled();
        await expect(retry).toBeInViewport();
        await expect(dismiss).toBeEnabled();
        await retry.click();
        await expect(page.locator("body")).toHaveAttribute("data-pending-prompt-actions", "retry:prompt-failed");
        await dismiss.click();
        await expect(page.locator("body"))
          .toHaveAttribute("data-pending-prompt-actions", "retry:prompt-failed dismiss:prompt-failed");
      }
    });

    test("the earlier-activity failure and unpaired-device state name Wollipog (#2579)", async ({ page }) => {
      await open(page, "state=earlier&older=unsupported");
      await page.locator("[data-virtual-row]").first().waitFor();
      await page.locator(".detail-scroll").evaluate((element) => { element.scrollTop = 0; });
      const row = page.locator(".tl-earlier");
      await row.getByRole("button", { name: /^Load Earlier Activity/u }).click();
      await expect(row).toHaveAttribute("data-state", "error");
      await expect(row.locator(".notice-body"))
        .toHaveText("Earlier activity isn't available from this version of Wollipog. Update Wollipog to load it.");

      await open(page, "state=unpaired");
      const state = page.locator(".detail-scroll .state.offline");
      await expect(state.locator(".state-title")).toHaveText("Pair to Load Activity");
      await expect(state.locator(".state-body")).toHaveText("Pair this device with Wollipog to load this transcript.");
      await expect(page.getByText(/control plane/iu)).toHaveCount(0);
    });

    test("the earlier-activity row centers its action between two hairlines", async ({ page }) => {
      await open(page, "state=earlier&older=hold");
      await page.locator("[data-virtual-row]").first().waitFor();
      const reader = page.locator(".detail-scroll");
      await reader.evaluate((element) => { element.scrollTop = 0; });
      const row = page.locator(".tl-earlier");
      await expect(row).toHaveAttribute("data-state", "idle");
      const load = row.getByRole("button", { name: /^Load Earlier Activity/u });
      await expect(load).toBeVisible();
      const geometry = await row.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const before = getComputedStyle(element, "::before");
        const after = getComputedStyle(element, "::after");
        const action = element.querySelector("button")!.getBoundingClientRect();
        return {
          rowCenter: box.left + box.width / 2,
          actionCenter: action.left + action.width / 2,
          hairlines: [before.borderTopWidth, after.borderTopWidth],
        };
      });
      expect(Math.abs(geometry.rowCenter - geometry.actionCenter)).toBeLessThanOrEqual(1);
      expect(geometry.hairlines).toEqual(["1px", "1px"]);
      await load.click();
      await expect(row).toHaveAttribute("data-state", "loading");
      await expect(row).toHaveText("Loading earlier activity…");
    });
  });
}

test("a failed earlier load is a compact danger notice with Retry in the row", async ({ page }) => {
  await open(page, "state=earlier&older=fail");
  await page.locator("[data-virtual-row]").first().waitFor();
  await page.locator(".detail-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.locator(".tl-earlier").getByRole("button", { name: /^Load Earlier Activity/u }).click();
  const row = page.locator(".tl-earlier");
  await expect(row).toHaveAttribute("data-state", "error");
  const notice = row.locator(".notice.compact.t-danger");
  await expect(notice).toContainText("Could not load earlier activity.");
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
});

test.describe("in a short Inbox preview", () => {
  test.use({ viewport: { width: 390, height: 260 } });

  test("the history notice keeps at most half the reader and its details stay reachable", async ({ page }) => {
    await open(page, "state=history-error&mode=preview");
    const band = page.locator(".transcript-history-band");
    const notice = band.locator(".notice");
    await expect(notice).toContainText("Couldn't Load the Full Conversation");
    await notice.getByRole("button", { name: "Show Details" }).click();
    const details = notice.locator(".notice-details-body");
    await expect(details).toHaveText("Could not load complete session activity.");
    const sizes = await page.evaluate(() => ({
      band: document.querySelector<HTMLElement>(".transcript-history-band")!.getBoundingClientRect().height,
      reader: document.querySelector<HTMLElement>(".detail-reader")!.getBoundingClientRect().height,
    }));
    expect(sizes.band).toBeLessThanOrEqual(sizes.reader / 2 + 1);
    // Whatever does not fit scrolls inside the band rather than being clipped by the reader.
    await details.scrollIntoViewIfNeeded();
    await expect(details).toBeInViewport();
    await notice.getByRole("button", { name: "Retry" }).scrollIntoViewIfNeeded();
    await expect(notice.getByRole("button", { name: "Retry" })).toBeInViewport();
  });
});

test("a slow load says what it is waiting for after 3 seconds", async ({ page }) => {
  await page.clock.install();
  await open(page, "state=loading&count=1240");
  await expect(page.locator(".transcript-skeleton-turn")).toHaveCount(2);
  await expect(page.locator(".transcript-skeleton-sentence")).toHaveCount(0);
  await page.clock.runFor(3_000);
  await expect(page.locator(".transcript-skeleton-sentence")).toHaveText("Loading a long conversation (1,240 events)…");
});

/** A session whose only event is a hidden Agent Log, and whose machine cannot finish filling the
 * history cache (#2773). */
test.describe("a history its machine cannot finish", () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`an offline machine's incomplete history settles on its notice at once at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, "state=incomplete&runner=offline&count=1");
      const notice = page.locator(".detail-reader .notice");
      // Well inside the reader's 12-second re-read budget: the first answer is the last.
      await expect(notice).toContainText("Couldn't Load the Full Conversation", { timeout: 2_000 });
      await expect(notice).toContainText("Loaded 1 event from Build Box, which is offline.");
      await expect(page.locator(".transcript-skeleton")).toHaveCount(0);
      await page.waitForTimeout(500);
      await expect(page.locator("body")).toHaveAttribute("data-tail-request-count", "1");
    });
  }

  test("a long history filling from an online machine keeps its loading notice", async ({ page }) => {
    await page.clock.install();
    await open(page, "state=incomplete&count=1240");
    await page.clock.runFor(3_000);
    await expect(page.locator(".transcript-skeleton-sentence")).toHaveText("Loading a long conversation (1,240 events)…");
    await expect(page.locator(".detail-reader .notice")).toHaveCount(0);
    await expect.poll(async () => Number(await page.locator("body").getAttribute("data-tail-request-count")))
      .toBeGreaterThan(1);
  });

  test("a complete history of only hidden Agent Logs is the empty state", async ({ page }) => {
    await open(page, "state=agent-logs&count=1");
    await expect(page.locator(".detail-scroll .state .state-title")).toHaveText("No Messages");
    await expect(page.locator(".transcript-skeleton")).toHaveCount(0);
  });
});
