import { expect, test, type Page } from "@playwright/test";

/**
 * The Browser's open artifact in the real side panel (#2855): exactly one back control at a 400px
 * panel and on a 390px phone. The artifact is a page on the panel's stack (#2914, #2856), so that
 * control is the panel header's Back to Browser, beside the page's title; Back and Escape return to
 * the list with focus on the artifact's row.
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
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator("#right-panel .browser-artifact-list .row").first()).toBeVisible();
}

const panel = (page: Page) => page.locator("#right-panel");
const backs = (page: Page) => panel(page).getByRole("button", { name: /^Back/u });

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
      const bar = panel(page).locator(".rpanel-toolbar > .art-bar");
      expect((await bar.boundingBox())!.height).toBe(48);
      await expect(bar.getByRole("button", { name: /^Back/u })).toHaveCount(0);
      await expect(bar.getByRole("button", { name: "Download" })).toBeVisible();
      await expect(panel(page).locator(".rpanel-body").getByText("Final QA report", { exact: true }).filter({ visible: true }),
        "the title is shown once, in the header").toHaveCount(0);
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
