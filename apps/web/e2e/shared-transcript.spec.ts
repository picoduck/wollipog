import { expect, test, type Page } from "@playwright/test";

/**
 * #2173: the page a share link opens is the transcript's own reading surface (docs/design-system.md
 * §4.4, §12, §13.2): a 48px bar, the page title with its meta line, one warning notice, right-aligned
 * bubbles and unframed replies, inside the reader's gutters at every width.
 */

// The harness's link expires Sep 26, 2026; a fixed clock in that year keeps the label yearless.
const NOW = new Date(2026, 8, 20, 12, 0);

async function open(page: Page, query = ""): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`/shared-transcript-e2e.html${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Shared Transcript" })).toBeVisible();
}

/** The nearest distance of any visible text from the viewport's left and right edges, and the
 * document's horizontal overflow. Text inside a box that scrolls on its own (a wide table or code
 * block) counts only where that box shows it. */
async function edges(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    let left = Infinity;
    let right = Infinity;
    const walker = document.createTreeWalker(document.querySelector(".share-page")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      let clip = { left: -Infinity, right: Infinity };
      for (let element = node.parentElement; element; element = element.parentElement) {
        if (getComputedStyle(element).overflowX === "visible") continue;
        const box = element.getBoundingClientRect();
        clip = { left: Math.max(clip.left, box.left), right: Math.min(clip.right, box.right) };
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const shownLeft = Math.max(rect.left, clip.left);
        const shownRight = Math.min(rect.right, clip.right);
        if (shownRight <= shownLeft) continue;
        left = Math.min(left, shownLeft);
        right = Math.min(right, width - shownRight);
      }
    }
    return { left, right, overflow: document.documentElement.scrollWidth - width };
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("the bar is 48px, messages use the transcript recipes, and nothing overflows", async ({ page }) => {
      await open(page);
      await expect(page.locator(".share-bar")).toHaveText("Shared Transcript");
      expect(await page.locator(".share-bar").evaluate((element) => element.getBoundingClientRect().height)).toBe(48);
      await expect(page.locator(".share-meta")).toHaveText("6 messages · Link expires Sep 26, 12:49 AM");
      await expect(page.locator(".share-head .notice.t-warning")).toHaveText(
        "Secrets were removed automatically, but this may still contain code or personal information.");

      const reply = page.locator(".tl-agent-msg").first();
      await expect(reply.getByRole("heading", { level: 2, name: "What Was Wrong" })).toBeVisible();
      await expect(reply.getByRole("table")).toBeVisible();
      await expect(reply.locator("pre code")).toContainText("await page.waitForURL");
      await expect(page.locator(".share-main").locator("img, video")).toHaveCount(0);
      await expect(page.locator(".tl-turn-footer .tl-turn-stopped")).toHaveText("Stopped");
      await expect(page.locator(".share-page")).not.toContainText(/USER|ASSISTANT|Operational|operationally|capability/);

      // A person's message hugs the column's right edge; a reply starts at its left edge.
      const column = await page.locator(".timeline").boundingBox();
      const bubble = await page.locator(".tl-bubble").first().boundingBox();
      expect(Math.abs(column!.x + column!.width - (bubble!.x + bubble!.width))).toBeLessThanOrEqual(1);
      expect(bubble!.x).toBeGreaterThan(column!.x + 1);

      const { left, right, overflow } = await edges(page);
      expect(overflow).toBe(0);
      expect(left).toBeGreaterThanOrEqual(16);
      expect(right).toBeGreaterThanOrEqual(16);
    });

    test("an unavailable link and a failed load keep the same gutters", async ({ page }) => {
      await open(page, "?state=unavailable");
      await expect(page.getByRole("heading", { level: 2, name: "This Link Isn't Available" })).toBeVisible();
      expect((await edges(page)).left).toBeGreaterThanOrEqual(16);

      await open(page, "?state=network");
      const notice = page.getByRole("alert");
      await expect(notice.getByRole("heading", { level: 2, name: "Couldn't Load This Transcript" })).toBeVisible();
      await expect(notice).not.toContainText("Failed to fetch");
      await notice.getByRole("button", { name: "Show Details" }).click();
      await expect(notice.locator(".code-well pre")).toHaveText("Failed to fetch");
      await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
      const { left, overflow } = await edges(page);
      expect(overflow).toBe(0);
      expect(left).toBeGreaterThanOrEqual(16);
    });
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`session title at ${viewport.width}px (#2189)`, () => {
    test.use({ viewport });

    test("an included title is the heading, the bar keeps Shared Transcript, and the longest one wraps", async ({ page }) => {
      await page.clock.setFixedTime(NOW);
      await page.goto("/shared-transcript-e2e.html?title=1");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix the flaky login test on CI");
      await expect(page.locator(".share-bar")).toHaveText("Shared Transcript");
      await expect(page.getByRole("main")).toHaveAccessibleName("Fix the flaky login test on CI");

      await page.goto("/shared-transcript-e2e.html?title=long");
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toHaveText(/…$/);
      await expect(page.locator(".timeline")).toBeVisible();
      const { left, right, overflow } = await edges(page);
      expect(overflow).toBe(0);
      expect(left).toBeGreaterThanOrEqual(16);
      expect(right).toBeGreaterThanOrEqual(16);
    });
  });
}
