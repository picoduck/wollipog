import { expect, test, type Page } from "@playwright/test";

/**
 * New Project (#2965; docs/design-system.md §7.1, §7.5, §8.1, §9.1): the Access field spans the
 * form, its list is at least 280px wide and stays inside the viewport at 390px, and over New Session
 * a phone sheet's content is replaced, with Back, rather than a second sheet stacking on it.
 */

const VIEWPORTS = [
  { name: "1440×900 with a mouse", viewport: { width: 1440, height: 900 }, coarse: false },
  { name: "390×844 on touch", viewport: { width: 390, height: 844 }, coarse: true },
] as const;

const newProject = (page: Page) => page.getByRole("dialog", { name: "New Project" });

for (const { name, viewport, coarse } of VIEWPORTS) {
  test.describe(`at ${name}`, () => {
    test.use({ viewport, ...(coarse ? { hasTouch: true, isMobile: true } : {}) });

    test("the Access field is full width and its list is at least 280px, inside the viewport", async ({ page }) => {
      await page.goto("/new-project-e2e.html");
      const dialog = newProject(page);
      await expect(dialog).toBeVisible();
      const trigger = dialog.getByRole("button", { name: /^Access:/ });
      await expect(trigger).toHaveAccessibleName("Access: Organization-Wide");
      const [triggerBox, formBox, nameBox] = await Promise.all([
        trigger.boundingBox(), dialog.locator("form").boundingBox(), dialog.getByLabel("Project Name").boundingBox(),
      ]);
      expect(Math.abs(triggerBox!.width - formBox!.width), "the trigger spans the form").toBeLessThanOrEqual(1);
      expect(Math.abs(triggerBox!.width - nameBox!.width), "as wide as Project Name").toBeLessThanOrEqual(1);

      await trigger.click();
      const list = page.locator(".menu.listbox");
      await expect(list).toBeVisible();
      // Two-line options: the level, then who it reaches.
      await expect(list.getByRole("option")).toHaveCount(4);
      await expect(list.getByRole("option").first()).toContainText("Private to Me");
      const box = (await list.boundingBox())!;
      expect(box.width, "the list floor").toBeGreaterThanOrEqual(280);
      expect(box.x, "inside the viewport's left edge").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, "inside the viewport's right edge").toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, "inside the viewport's bottom edge").toBeLessThanOrEqual(viewport.height);
    });

    test("over New Session it stacks on desktop and takes over the phone sheet with Back", async ({ page }) => {
      await page.goto("/new-project-e2e.html?parent=1");
      const dialog = newProject(page);
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".modal-desc")).toHaveText("It's selected for this session once it's created.");
      if (coarse) {
        await expect(page.locator(".modal-backdrop")).toHaveCount(1);
        await expect(dialog.getByRole("button", { name: "Back to New Session" })).toBeVisible();
      } else {
        await expect(page.locator(".modal-backdrop")).toHaveCount(2);
        await expect(page.getByRole("dialog", { name: "New Session" })).toBeVisible();
      }
      await dialog.getByLabel("Project Name").fill("Payments");
      await dialog.getByRole("button", { name: "Create Project" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("button", { name: "New Project…" }), "focus returns to the trigger in New Session").toBeFocused();
    });
  });
}
