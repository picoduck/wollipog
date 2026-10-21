import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #3511 (docs/design-system.md §13.2): when Show Details leads a notice's action row, its label
 * starts where the notice's sentence starts, open or closed. A row led by a bordered resolving
 * action keeps that button's edge at the sentence and the toggle 8px after it, and a compact
 * notice keeps its row beside the sentence. The shapes come from the primitives harness's
 * `?view=notices`; the Automation editor's save failure is the notice #3501 aligned on its own.
 */

/** The left edge of an element's first line of text, not of its box. */
async function textLeft(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT,
      { acceptNode: (node) => node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const text = walker.nextNode();
    if (!text) throw new Error("no text to measure");
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getClientRects()[0]!.left;
  });
}

async function expectToggleAligned(notice: Locator) {
  const toggle = notice.locator(".notice-details-toggle");
  const body = await textLeft(notice.locator(".notice-body"));
  for (const label of ["Show Details", "Hide Details"]) {
    await expect(toggle).toHaveText(label);
    expectGeometry(Math.abs(await textLeft(toggle) - body), `${label} starts at the sentence's left edge`)
      .toBeLessThanOrEqual(1);
    await toggle.click();
  }
}

async function openNotices(page: Page, theme: string) {
  await page.goto(`/primitives-e2e.html?view=notices&theme=${theme}`);
  await expect(page.locator(".notice")).toHaveCount(4);
}

for (const theme of ["dark", "light"]) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`${theme} theme at ${viewport.width}px`, () => {
      test.use({ viewport });

      test("Show Details as the only action lines up with the sentence, untitled and titled", async ({ page }) => {
        await openNotices(page, theme);
        await expectToggleAligned(page.locator('.notice[data-state="details-only"]'));
        await expectToggleAligned(page.locator('.notice[data-state="titled-details-only"]'));
      });

      test("a row led by Retry keeps Retry's edge at the sentence and Show Details after it", async ({ page }) => {
        await openNotices(page, theme);
        const notice = page.locator('.notice[data-state="retry-first"]');
        const body = await textLeft(notice.locator(".notice-body"));
        const retry = (await notice.getByRole("button", { name: "Retry" }).boundingBox())!;
        const toggle = (await notice.locator(".notice-details-toggle").boundingBox())!;
        expectGeometry(Math.abs(retry.x - body), "Retry's border edge sits at the sentence's left edge")
          .toBeLessThanOrEqual(1);
        expectGeometry(Math.abs(toggle.x - (retry.x + retry.width) - 8), "Show Details follows Retry at the row's 8px gap")
          .toBeLessThanOrEqual(1);
      });

      test("a compact notice keeps Show Details clear of its sentence", async ({ page }) => {
        await openNotices(page, theme);
        const notice = page.locator('.notice[data-state="compact"]');
        const toggle = notice.locator(".notice-details-toggle");
        expect(await toggle.evaluate((element) => getComputedStyle(element).marginInlineStart)).toBe("0px");
      });
    });
  }
}

test("the Automation editor's save failure keeps its Show Details at the sentence", async ({ page }) => {
  const route = `/automations/~${Buffer.from("automation-nightly-sweep", "utf16le").toString("base64url")}`;
  await page.goto(`/automations-e2e.html?theme=dark&save-error&route=${encodeURIComponent(route)}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill(`${await name.inputValue()} Again`);
  await page.getByRole("button", { name: "Save Changes" }).click();
  const notice = page.locator(".automation-editor-form .notice.t-danger");
  await expect(notice).toBeVisible();
  await expectToggleAligned(notice);
});
