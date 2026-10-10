import { expect, test, type Page } from "@playwright/test";
import { waitForSessionPreview } from "./session-readiness.js";

/**
 * The Browser's open artifact in the real side panel (#2855): exactly one back control at a 400px
 * panel and on a 390px phone. On the phone the panel's own Back (#2843) becomes Back to Artifacts
 * while the preview is open, and the artifact header draws none.
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

test("at a 400px panel the artifact header's Back to Artifacts is the one back control", async ({ page }) => {
  await openBrowser(page, 1440);
  expect((await panel(page).boundingBox())!.width).toBe(400);
  await expect(backs(page)).toHaveCount(0);
  await panel(page).locator(".browser-artifact-list .row").filter({ hasText: "Final QA report" }).click();
  await expect(backs(page)).toHaveCount(1);
  const back = panel(page).locator(".art-bar").getByRole("button", { name: "Back to Artifacts" });
  await expect(back).toBeFocused();
  expect((await panel(page).locator(".art-bar").boundingBox())!.height).toBe(48);
  await back.click();
  await expect(panel(page).locator(".browser-artifact-list .row").filter({ hasText: "Final QA report" })).toBeFocused();
});

test.describe("on a 390px phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the panel's Back becomes Back to Artifacts while a preview is open, and the artifact header draws none", async ({ page }) => {
    await openBrowser(page, 390);
    const head = panel(page).locator(".rpanel-head");
    await expect(backs(page)).toHaveCount(1);
    await expect(head.getByRole("button", { name: "Back to Session" })).toBeVisible();
    await panel(page).locator(".browser-artifact-list .row").filter({ hasText: "Final QA report" }).click();
    await expect(backs(page)).toHaveCount(1);
    const back = head.getByRole("button", { name: "Back to Artifacts" });
    await expect(back).toBeFocused();
    await expect(panel(page).locator(".art-bar").getByRole("button", { name: /^Back/u })).toHaveCount(0);
    const title = (await panel(page).locator(".art-bar .art-title").boundingBox())!;
    expect(title.x, "the title starts at the bar's padding").toBeLessThanOrEqual(17);
    expect((await panel(page).locator(".art-bar").boundingBox())!.height).toBe(48);

    await back.click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator(".browser-artifact-list .row").filter({ hasText: "Final QA report" })).toBeFocused();
    await expect(head.getByRole("button", { name: "Back to Session" })).toBeVisible();
    await expect(backs(page)).toHaveCount(1);
    await head.getByRole("button", { name: "Back to Session" }).click();
    await expect(panel(page)).toHaveCount(0);
  });
});
