import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #3522 (docs/design-system.md §13.2): a compact notice's tone icon sits at its first line. Once a
 * notice wraps, the icon is level with the title, or with an untitled sentence's first line, and an
 * untitled notice's dismiss button stays on that line too. A notice that fits on one line is
 * unchanged: icon, sentence and Retry centered on one 40px line. The shapes come from the
 * primitives harness's `?view=compact-notices`; Provider Accounts' Couldn't Remove and Campaign
 * Status's Couldn't Refresh Work Items are measured where they appear.
 */

interface Line { top: number; bottom: number; center: number }

/** The first line of an element's text: the box of its first text fragment, not of the element. */
async function firstLine(locator: Locator): Promise<Line> {
  return locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT,
      { acceptNode: (node) => node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const text = walker.nextNode();
    if (!text) throw new Error("no text to measure");
    const range = document.createRange();
    range.selectNodeContents(text);
    const rect = range.getClientRects()[0]!;
    return { top: rect.top, bottom: rect.bottom, center: rect.top + rect.height / 2 };
  });
}

async function centerY(locator: Locator): Promise<number> {
  const box = (await locator.boundingBox())!;
  return box.y + box.height / 2;
}

async function iconCenter(notice: Locator): Promise<number> {
  return centerY(notice.locator(".notice-icon svg"));
}

/** The icon sits on the title's line, and the title on the notice's first line. */
async function expectIconOnTitleLine(notice: Locator, label: string) {
  const title = await firstLine(notice.locator(".notice-title"));
  const box = (await notice.boundingBox())!;
  expectGeometry(title.top - box.y, `${label}: the title is the notice's first line`).toBeLessThan(16);
  expectGeometry(Math.abs(await iconCenter(notice) - title.center), `${label}: the icon is level with the title`)
    .toBeLessThanOrEqual(2);
}

async function openNotices(page: Page, theme: string) {
  await page.goto(`/primitives-e2e.html?view=compact-notices&theme=${theme}`);
  await expect(page.locator(".notice")).toHaveCount(6);
}

for (const theme of ["dark", "light"]) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`${theme} theme at ${viewport.width}px`, () => {
      test.use({ viewport });

      test("a wrapping titled compact notice keeps its title and icon on its first line", async ({ page }) => {
        await openNotices(page, theme);
        for (const state of ["titled-dismiss", "error"]) {
          const notice = page.locator(`.notice.compact[data-state="${state}"]`);
          const title = await firstLine(notice.locator(".notice-title"));
          const body = await firstLine(notice.locator(".notice-body"));
          const box = (await notice.boundingBox())!;
          expectGeometry(box.height, `${state}: the notice wraps onto several lines`).toBeGreaterThan(60);
          // A wide notice keeps its sentence beside the title, starting on the title's line; a narrow
          // one wraps the sentence under it.
          if (body.top < title.bottom) {
            expectGeometry(Math.abs(body.center - title.center), `${state}: the sentence starts on the title's line`)
              .toBeLessThanOrEqual(1);
          }
          await expectIconOnTitleLine(notice, state);
        }
      });

      test(`the titled Retry notice keeps its icon on the title's line${viewport.width === 1440 ? " on one line" : " when it wraps"}`, async ({ page }) => {
        await openNotices(page, theme);
        const notice = page.locator('.notice.compact[data-state="titled-retry"]');
        const title = await firstLine(notice.locator(".notice-title"));
        const body = await firstLine(notice.locator(".notice-body"));
        if (viewport.width === 1440) {
          expectGeometry(Math.abs(body.center - title.center), "the sentence sits beside the title")
            .toBeLessThanOrEqual(1);
          const box = (await notice.boundingBox())!;
          expectGeometry(Math.abs(box.height - 40), "a one-line notice is 40px tall").toBeLessThanOrEqual(1);
          expectGeometry(Math.abs(title.center - (box.y + box.height / 2)), "the title is centered in the notice")
            .toBeLessThanOrEqual(1);
        } else {
          expectGeometry(body.top - title.bottom, "the sentence wraps under the title").toBeGreaterThanOrEqual(0);
        }
        expectGeometry(Math.abs(await iconCenter(notice) - title.center), "the icon is level with the title")
          .toBeLessThanOrEqual(2);
      });

      test("an untitled sentence that wraps keeps its icon and dismiss button on its first line", async ({ page }) => {
        await openNotices(page, theme);
        const notice = page.locator('.notice.compact[data-state="untitled-wrap"]');
        const line = await firstLine(notice.locator(".notice-body"));
        const body = (await notice.locator(".notice-body").boundingBox())!;
        expectGeometry(body.height - (line.bottom - line.top), "the sentence wraps").toBeGreaterThan(10);
        expectGeometry(Math.abs(await iconCenter(notice) - line.center), "the icon is level with the first line")
          .toBeLessThanOrEqual(2);
        expectGeometry(Math.abs(await centerY(notice.locator(".notice-dismiss")) - line.center),
          "the dismiss button is level with the first line").toBeLessThanOrEqual(2);
      });

      test("a one-line compact notice is unchanged: icon, sentence and Retry centered on 40px", async ({ page }) => {
        await openNotices(page, theme);
        for (const state of ["one-line", "one-line-text"]) {
          const notice = page.locator(`.notice.compact[data-state="${state}"]`);
          const box = (await notice.boundingBox())!;
          const middle = box.y + box.height / 2;
          expectGeometry(Math.abs(box.height - 40), `${state}: the notice is one 40px line`).toBeLessThanOrEqual(1);
          expectGeometry(Math.abs(await iconCenter(notice) - middle), `${state}: the icon is centered`)
            .toBeLessThanOrEqual(1);
          expectGeometry(Math.abs((await firstLine(notice.locator(".notice-body"))).center - middle),
            `${state}: the sentence is centered`).toBeLessThanOrEqual(1);
          if (state === "one-line") {
            expectGeometry(Math.abs(await centerY(notice.getByRole("button", { name: "Retry" })) - middle),
              "Retry is centered").toBeLessThanOrEqual(1);
          }
        }
      });

      test("Provider Accounts' Couldn't Remove notice keeps its icon on the title's line", async ({ page }) => {
        const phone = viewport.width <= 760;
        await page.goto(`/machine-management-e2e.html?theme=${theme}${phone ? "" : "&machine=native-t14s"}`);
        if (phone) {
          await page.getByRole("complementary", { name: "Machines" }).locator("button.row")
            .filter({ has: page.locator(".row-title", { hasText: "Design Workstation" }) }).click();
        }
        const accounts = page.getByRole("region", { name: /^Provider Accounts/ });
        await accounts.locator(".surface > .row").filter({ has: page.locator(".row-title", { hasText: "Codex Solo" }) })
          .getByRole("button", { name: "More Actions for Codex Solo" }).click();
        await page.getByRole("menu", { name: "Codex Solo" }).getByRole("menuitem", { name: "Remove Account…" }).click();
        await page.getByRole("dialog", { name: "Remove Account" }).getByRole("button", { name: "Remove Account" }).click();
        const notice = accounts.locator(".notice.compact.t-danger");
        await expect(notice).toContainText("Couldn't Remove Codex Solo");
        await expectIconOnTitleLine(notice, "Couldn't Remove");
      });

      test("Campaign Status's Couldn't Refresh notice keeps its icon on the title's line", async ({ page }) => {
        await page.goto(`/campaign-status-e2e.html?scenario=campaign&refresh=failing&theme=${theme}`);
        await expect(page.locator(".campaign-work-row")).toHaveCount(7);
        await page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.bumpRevision());
        const notice = page.locator(".campaign-status .notice.compact.t-danger");
        await expect(notice).toContainText("Couldn't Refresh Work Items");
        await expectIconOnTitleLine(notice, "Couldn't Refresh");
      });
    });
  }
}
