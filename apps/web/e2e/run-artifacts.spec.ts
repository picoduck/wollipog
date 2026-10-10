import { expect, test, type Page } from "@playwright/test";

/**
 * Run detail's artifacts (#2855; docs/design-system.md §11.9) through the app shell: full-width
 * two-line rows in one surface with Show More, and a preview in a large dialog, a sheet on a phone,
 * with Download and Done and no ×.
 */
async function openRun(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/command-inbox-projects-e2e.html?view=run&runArtifacts=1");
  await expect(page.locator(".run-detail").getByRole("heading", { level: 1, name: "Final QA Run" })).toBeVisible();
}

const section = (page: Page) => page.getByRole("region", { name: "Workflow Artifacts" });
const rows = (page: Page) => section(page).locator(".surface .row.row-2");

for (const [label, width, touch] of [["on a desktop", 1440, false], ["on a phone", 390, true]] as const) {
  test.describe(label, () => {
    test.use({ hasTouch: touch, isMobile: touch });

    test("artifacts are full-width rows with no ids or hashes, and Show More loads the next page", async ({ page }) => {
      await openRun(page, width);
      await expect(rows(page)).toHaveCount(4);
      await expect(section(page).locator(".run-artifacts-head")).toHaveText("Artifacts 4+");
      const list = (await section(page).locator(".surface").boundingBox())!;
      for (const box of await rows(page).evaluateAll((all) => all.map((row) => row.getBoundingClientRect().width))) {
        expect(box, "each row spans the list").toBeCloseTo(list.width - 2, 0);
      }
      const first = rows(page).filter({ hasText: "Final QA report" });
      // The Alpha session runs the Codex App Server driver; its id never shows.
      await expect(first.locator(".art-row-meta > span")).toHaveText(["Review report", "Codex App Server"]);
      const text = await section(page).textContent() ?? "";
      expect(text).not.toMatch(/session-alpha|text\/markdown|usr_|[0-9a-f]{12}/u);
      await section(page).getByRole("button", { name: "Show More" }).click();
      await expect(rows(page)).toHaveCount(5);
      await expect(section(page).getByRole("button", { name: "Show More" })).toHaveCount(0);
      await expect(rows(page).filter({ hasText: "Gate verdict" }).locator(".art-row-meta > span")).toHaveText(["Verdict (JSON)", "Wollipog"]);
    });

    test("a row opens its preview in a large dialog with Done, a sheet on a phone, and no × renders", async ({ page }) => {
      await openRun(page, width);
      const row = rows(page).filter({ hasText: "e2e shard 3 of 5.log" });
      await row.click();
      const dialog = page.getByRole("dialog", { name: "e2e shard 3 of 5.log" });
      await expect(dialog.locator(".art-meta")).toContainText("Verified");
      await expect(dialog.locator(".code-well.art-code pre")).toContainText("checkout.spec.ts");
      const card = page.locator(".modal.lg");
      if (width === 390) {
        // A sheet: full width, and once it has slid in, resting on the bottom edge (§7.5).
        expect((await card.boundingBox())!.width).toBe(390);
        await expect.poll(async () => {
          const box = (await card.boundingBox())!;
          return Math.round(box.y + box.height);
        }).toBe(900);
      } else {
        // A large dialog (§7.1), once its entrance has settled.
        await expect.poll(async () => Math.round((await card.boundingBox())!.width)).toBe(800);
      }
      await expect(page.locator("body")).not.toContainText("×");
      await dialog.getByRole("button", { name: "Download" }).click();
      await expect(page.getByRole("menuitem", { name: "Download Original File" }))
        .toHaveAccessibleDescription("Not redacted. It may contain secrets or personal data.");
      await page.keyboard.press("Escape");
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row).toBeFocused();
    });

    test("Enlarge from the preview dialog shows the screenshot at full size and returns to the preview", async ({ page }) => {
      await openRun(page, width);
      await rows(page).filter({ hasText: "Checkout at 1440px.png" }).click();
      const preview = page.getByRole("dialog", { name: "Checkout at 1440px.png" });
      const enlarge = preview.getByRole("button", { name: "Enlarge" });
      await enlarge.click();
      const stage = page.locator(".art-enlarged .art-stage");
      await expect(stage.locator("img")).toBeVisible();
      // Over another dialog's sheet on a phone, the sheet still takes the whole height (§7.5).
      await expect.poll(async () => Math.round((await stage.boundingBox())!.height)).toBeGreaterThan(width === 390 ? 600 : 500);
      if (width === 390) {
        const sheet = page.locator(".modal:has(> .modal-panel-host > .art-enlarged)");
        await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBe(900);
      }
      await page.locator(".art-enlarged").getByRole("button", { name: "Done" }).click();
      await expect(page.locator(".art-enlarged")).toHaveCount(0);
      await expect(preview.locator(".art-checker img")).toBeVisible();
      await expect(enlarge).toBeFocused();
    });
  });
}
