import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { waitForSessionPreview } from "./session-readiness.js";

/**
 * The Browser's open artifact in the real side panel (#2855): exactly one back control at a 400px
 * panel and on a 390px phone. The artifact is a page on the panel's stack (#2914, #2856), so that
 * control is the panel header's Back to Browser, beside the page's title; Back and Escape return to
 * the list with focus on the artifact's row. Its Enlarge and Download share that header's one row
 * (#3036), and its meta line follows the header directly.
 */
async function openBrowser(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("wollipog.rightpanel.open", "1");
    localStorage.setItem("wollipog.rightpanel.mode", "browser");
  });
  await page.goto("/command-inbox-projects-e2e.html?fullShell=1&runArtifacts=1");
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  await waitForSessionPreview(page);
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator("#right-panel .browser-artifact-list .row").first()).toBeVisible();
}

const panel = (page: Page) => page.locator("#right-panel");
const backs = (page: Page) => panel(page).getByRole("button", { name: /^Back/u });
const HTML_NAME = "Order summary preview for the redesigned checkout flow";

/** The header's visible controls, in order, with their boxes. */
async function headerControls(page: Page) {
  return panel(page).locator(".rpanel-head").evaluate((head) => {
    const bar = head.getBoundingClientRect();
    return {
      bar: { top: bar.top, bottom: bar.bottom, right: bar.right, height: bar.height },
      controls: [...head.querySelectorAll("button")].filter((button) => button.getClientRects().length > 0).map((button) => {
        const box = button.getBoundingClientRect();
        return { name: button.getAttribute("aria-label"), left: box.left, right: box.right, width: box.width, height: box.height, middle: box.top + box.height / 2 };
      }),
    };
  });
}

for (const [label, width, touch] of [["a 400px panel", 1440, false], ["a 390px phone", 390, true]] as const) {
  test.describe(`at ${label}`, () => {
    test.use({ hasTouch: touch, isMobile: touch });

    test("an open artifact is a page whose one back control is the header's Back to Browser, beside its title", async ({ page }) => {
      await openBrowser(page, width);
      expect((await panel(page).boundingBox())!.width).toBe(touch ? 390 : 400);
      const head = panel(page).locator(".rpanel-head");
      await expect(backs(page)).toHaveCount(touch ? 1 : 0);
      if (touch) await expect(head.getByRole("button", { name: "Back to Session" })).toBeVisible();
      await panel(page).locator(".browser-artifact-list .row").filter({ hasText: "Final QA report" }).click();

      await expect(backs(page)).toHaveCount(1);
      const back = head.getByRole("button", { name: "Back to Browser" });
      await expect(back).toBeVisible();
      const title = head.locator(".rpanel-page-title");
      await expect(title).toHaveText("Final QA report");
      await expect(title).toBeFocused();
      const backBox = (await back.boundingBox())!;
      expect((await title.boundingBox())!.x - (backBox.x + backBox.width), "the title follows Back").toBeLessThanOrEqual(8);
      await expect(panel(page).locator(".rpanel-switcher")).toHaveCount(0);
      await expect(panel(page).getByRole("tablist", { name: "Browser" })).toHaveCount(0);
      await expect(panel(page).locator(".rpanel-body").getByText("Final QA report", { exact: true }).filter({ visible: true }),
        "the title is shown once, in the header").toHaveCount(0);
    });

    test("a Markdown artifact's Download shares the header's one row, and its meta line starts right under the header", async ({ page }) => {
      await openBrowser(page, width);
      await panel(page).locator(".browser-artifact-list .row").filter({ hasText: "Final QA report" }).click();
      await expect(panel(page).locator(".art-meta .art-verified")).toHaveText("Verified");

      const { bar, controls } = await headerControls(page);
      expect(bar.height, "one 48px header row").toBe(48);
      const names = controls.map((control) => control.name);
      // A phone's sheet has no Expand or Close, and may end with the session's waiting requests.
      expect(touch ? names.slice(0, 3) : names).toEqual(touch
        ? ["Back to Browser", "Download", "About Browser"]
        : ["Back to Browser", "Download", "About Browser", "Expand Panel", "Close Panel"]);
      for (const control of controls) {
        // Centred in the row above its 1px bottom border, give or take a pixel.
        expect(Math.abs(control.middle - controls[0]!.middle), `${control.name} shares Back's line`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(control.middle - (bar.top + bar.height / 2)), `${control.name} sits mid-row`).toBeLessThanOrEqual(1);
        expect(control.right, `${control.name} stays inside the row`).toBeLessThanOrEqual(bar.right + 0.5);
        expect([control.width, control.height], `${control.name} is the slot's ${touch ? 44 : 32}px icon button`)
          .toEqual(touch ? [44, 44] : [32, 32]);
      }
      await expect(panel(page).locator(".rpanel-toolbar"), "no bar between the header and the meta line").toHaveCount(0);
      const meta = (await panel(page).locator(".art-meta").boundingBox())!;
      // Only the scroller's 12px top padding separates them; the removed bar was 48px.
      expect(meta.y - bar.bottom, "the meta line starts directly under the header").toBeLessThanOrEqual(16);

      const download = panel(page).locator(".rpanel-head").getByRole("button", { name: "Download", exact: true });
      await download.click();
      const menu = page.getByRole("menu", { name: "Download" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Download Original File" }))
        .toHaveAccessibleDescription("Not redacted. It may contain secrets or personal data.");
      await expect(menu.getByRole("menuitem", { name: "Copy Checksum" })).toBeVisible();
      if (touch) {
        await dialogMotionSettled(page);
        await expect(menu.locator(".sheet-grabber"), "a phone's menu is a sheet").toHaveCount(1);
        const sheet = (await menu.boundingBox())!;
        expect(Math.round(sheet.y + sheet.height), "docked to the bottom").toBeGreaterThanOrEqual(899);
        expect(sheet.width).toBeGreaterThanOrEqual(389);
      }

      await page.keyboard.press("Escape");
      await expect(menu, "Escape closes the menu first").toHaveCount(0);
      await expect(download).toBeFocused();
      await expect(panel(page).locator(".rpanel-page-title")).toHaveText("Final QA report");
      await page.keyboard.press("Escape");
      const row = panel(page).locator(".browser-artifact-list .row").filter({ hasText: "Final QA report" });
      await expect(row, "then it pops the page").toBeFocused();
      await expect(panel(page).locator(".rpanel-head").getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
    });

    test("an HTML artifact adds Enlarge before Download, its long title truncates first, and the viewer returns focus to Enlarge", async ({ page }) => {
      await openBrowser(page, width);
      await panel(page).locator(".browser-artifact-list .row").filter({ hasText: HTML_NAME }).click();
      const head = panel(page).locator(".rpanel-head");
      const enlarge = head.getByRole("button", { name: "Enlarge" });
      await expect(enlarge).toBeVisible();

      const { bar, controls } = await headerControls(page);
      expect(bar.height).toBe(48);
      const names = controls.map((control) => control.name);
      expect(names.slice(0, 4)).toEqual(["Back to Browser", "Enlarge", "Download", "About Browser"]);
      if (!touch) expect(names.slice(4)).toEqual(["Expand Panel", "Close Panel"]);
      for (const control of controls) {
        expect([control.width, control.height], `${control.name} keeps its full target`).toEqual(touch ? [44, 44] : [32, 32]);
        expect(control.right, `${control.name} stays inside the row`).toBeLessThanOrEqual(bar.right + 0.5);
      }
      const title = head.locator(".rpanel-page-title");
      await expect(title).toHaveText(HTML_NAME);
      const fit = await title.evaluate((element) => ({
        clipped: element.scrollWidth > element.clientWidth,
        ellipsis: getComputedStyle(element).textOverflow,
        lines: Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight)),
        right: element.getBoundingClientRect().right,
      }));
      expect(fit.clipped, "the title truncates before any action gives way").toBe(true);
      expect(fit.ellipsis).toBe("ellipsis");
      expect(fit.lines, "on one line").toBe(1);
      const enlargeBox = controls.find((control) => control.name === "Enlarge")!;
      expect(fit.right, "the title ends before Enlarge").toBeLessThanOrEqual(enlargeBox.left + 0.5);
      await expect(panel(page).locator(".art-meta")).toContainText("HTML preview");
      await expect(panel(page).locator(".rpanel-toolbar")).toHaveCount(0);

      await enlarge.click();
      const dialog = page.getByRole("dialog", { name: HTML_NAME });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(enlarge, "closing the enlarged view returns focus to Enlarge").toBeFocused();
    });

    test("Back and Escape return to the list with focus on the artifact's row", async ({ page }) => {
      await openBrowser(page, width);
      const head = panel(page).locator(".rpanel-head");
      const row = panel(page).locator(".browser-artifact-list .row").filter({ hasText: "Final QA report" });
      await expect(row).toHaveAttribute("data-panel-page-key", "run-art-report");
      const title = head.locator(".rpanel-page-title");

      await row.click();
      await expect(title).toBeFocused();
      await head.getByRole("button", { name: "Back to Browser" }).click();
      await expect(row).toBeFocused();
      await expect(backs(page)).toHaveCount(touch ? 1 : 0);
      await expect(panel(page).getByRole("tablist", { name: "Browser" })).toBeVisible();

      await row.click();
      await expect(title).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(panel(page)).toBeVisible();
      await expect(row).toBeFocused();
      await expect(title).toBeHidden();

      if (touch) {
        await expect(head.getByRole("button", { name: "Back to Session" })).toBeVisible();
        await head.getByRole("button", { name: "Back to Session" }).click();
        await expect(panel(page)).toHaveCount(0);
      }
    });
  });
}
