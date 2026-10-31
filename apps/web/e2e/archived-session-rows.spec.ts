import { expect, test } from "@playwright/test";

for (const width of [1440, 1100, 834, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`archive rows and phone confirmations at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/archived-sessions-e2e.html?rows=1&theme=${theme}`);
      const rows = page.locator(".archive-item");
      await expect(rows).toHaveCount(5);
      expect(await rows.evaluateAll((items) => items.map((row) => row.getBoundingClientRect().height))).toEqual([56, 56, 56, 56, 56]);
      expect(await rows.evaluateAll((items) => items.every((row) => row.scrollWidth <= row.clientWidth))).toBe(true);
      await expect(rows.first().locator(".status")).toHaveCount(0);
      const failed = rows.filter({ hasText: "Fix the Half-Cent Rounding Bug" });
      await expect(failed.locator(".status")).toHaveCount(1);
      await expect(failed.locator(".status")).toHaveText("Stop Failed");
      await expect(rows.first().locator(".archive-project")).toHaveText("Wollipog");
      await expect(rows.nth(1).locator(".archive-project")).toHaveText("Wollipog › Release Checkout");
      await failed.getByRole("button", { name: /More Actions/ }).click();
      await expect(page.getByRole("menuitem", { name: /Retry Stop/ })).toContainText("The machine could not stop the session.");
      await page.keyboard.press("Escape");
      await rows.first().getByRole("button", { name: /More Actions/ }).click();
      await page.getByRole("menuitem", { name: "Delete Session…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Delete Session", exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole("menu")).toHaveCount(0);
      if (width === 390) {
        await dialog.getByRole("button", { name: "Back to More Actions" }).click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.getByRole("menuitem", { name: "Delete Session…", exact: true }).click();
      }
      await dialog.getByRole("button", { name: "Delete Session", exact: true }).click();
      await expect(page.locator(".toast")).toContainText("Couldn't delete “Migrate the Usage Dashboard to Daily Buckets”.");
      await expect(page.locator(".toast")).toContainText("The server refused this deletion.");
      await page.getByRole("searchbox").fill("UI");
      await expect(rows.first().locator("mark")).toHaveText("UI");
      await expect(rows.first().locator(".archive-item-snippet")).toContainText("Transcript:");
      expect(await rows.first().evaluate((row) => row.getBoundingClientRect().height)).toBe(76);
      await rows.first().focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveTitle("Session archived-1");
    });
  }
}
