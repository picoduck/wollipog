import { expect, test } from "@playwright/test";

for (const width of [1440, 834, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`archive toolbar at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/archived-sessions-e2e.html?toolbar&theme=${theme}`);
      await expect(page.locator(".archive-item")).toHaveCount(4);
      await expect(page.getByRole("navigation", { name: "Archived Sessions Pagination" })).toHaveCount(0);
      const toolbar = page.locator(".archive-view > .toolbar");
      const initialWidth = await toolbar.evaluate((node) => node.getBoundingClientRect().width);
      const compact = width < 1100;
      const filters = page.getByRole("button", { name: /^Filters/ });
      if (compact) {
        await expect(filters).toBeVisible();
        if (width === 390) {
          await expect(page.getByRole("radiogroup", { name: "Show" })).toBeHidden();
          const offset = await page.locator(".archive-item").first().evaluate((row) => row.getBoundingClientRect().top - row.closest(".main-body")!.getBoundingClientRect().top);
          expect(offset).toBeLessThan(200);
        }
        await filters.click();
      } else {
        expect(await page.locator(".archive-query").evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThanOrEqual(240);
        expect(await toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      const scope = compact ? page.getByRole("dialog", { name: "Filters", exact: true }) : toolbar;
      await scope.getByRole("button", { name: "Project: All Projects", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Search Project Options" })).toBeVisible();
      await page.getByRole("combobox", { name: "Search Project Options" }).fill("Wolli");
      await page.getByRole("option", { name: "Wollipog", exact: true }).click();
      await scope.getByRole("button", { name: "Status: Any Status", exact: true }).click();
      await page.getByRole("option", { name: "Completed", exact: true }).click();
      if (compact) {
        await expect(scope.getByRole("status")).toHaveText("2 sessions");
        await scope.getByRole("button", { name: "Done", exact: true }).click();
        await expect(filters).toBeFocused();
        await expect(filters).toHaveAccessibleName(/Filters\s*, 2 applied/);
      }
      await expect(page.locator(".chips")).toContainText("Project: Wollipog");
      if (!compact) {
        // Move off the controls so hover cannot masquerade as a chosen filter's edge.
        await page.mouse.move(1400, 850);
        const border = (name: string) => scope.getByRole("button", { name, exact: true })
          .evaluate((node) => getComputedStyle(node).borderTopColor);
        const unset = await border("Location: All Locations");
        expect(await border("Project: Wollipog")).not.toBe(unset);
        expect(await border("Status: Completed")).not.toBe(unset);
        expect(await border("Agent: All Agents")).toBe(unset);
      }
      expect(await toolbar.evaluate((node) => node.getBoundingClientRect().width)).toBe(initialWidth);
      await page.getByRole("searchbox").fill("UI");
      await expect(page.locator(".archive-view > [role=status]")).toContainText("match “UI”");
      await page.getByRole("button", { name: "Remove Project: Wollipog", exact: true }).click();
      await expect(page.getByRole("button", { name: "Remove Status: Completed", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Clear Filters", exact: true }).click();
      await expect(page.getByRole("searchbox")).toHaveValue("UI");
      await expect(page.locator(".chips")).toHaveCount(0);
      await page.getByRole("button", { name: "Clear Search", exact: true }).click();
      await expect(page.getByRole("searchbox")).toHaveValue("");
      await expect(page.getByRole("searchbox")).toBeFocused();
      await page.goto(`/archived-sessions-e2e.html?toolbar&paged&theme=${theme}`);
      await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeEnabled();
    });
  }
}
