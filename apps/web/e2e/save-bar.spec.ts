import { expect, test, type Locator } from "@playwright/test";

/**
 * #2948: the editor save bar (docs/design-system.md §8.6) in a real browser, where a busy Save's
 * width is layout rather than a number a DOM test supplies. Each state of the primitives harness sits
 * in its own `[data-save-bar]` region. Busy, Save keeps its label and its width and Discard is
 * disabled (§3.1); no bar ever reads "Saving…"; and every bar keeps its buttons on one row beside its
 * message, at desktop and phone widths.
 */

const box = async (locator: Locator) => (await locator.boundingBox())!;

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} at ${width}px: a busy Save keeps its label and width, and every bar keeps one row`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/primitives-e2e.html?theme=${theme}`);
      const busy = page.locator('[data-save-bar="busy"] .save-bar');
      const save = busy.getByRole("button", { name: "Save Changes" });
      const discard = busy.getByRole("button", { name: "Discard" });
      await expect(save).toBeVisible();

      const idle = await box(save);
      await save.click();
      await expect(save).toHaveAttribute("aria-busy", "true");
      await expect(save).toHaveText("Save Changes");
      await expect(discard).toBeDisabled();
      const pressed = await box(save);
      expect(pressed.width, "Save keeps its width").toBeCloseTo(idle.width, 1);
      expect(pressed.x, "and its place").toBeCloseTo(idle.x, 1);
      for (const text of await page.locator(".save-bar").allTextContents()) expect(text).not.toContain("Saving…");

      for (const state of ["dirty", "blocked", "busy", "new-record", "error"]) {
        const bar = page.locator(`[data-save-bar="${state}"] .save-bar`);
        const buttons = bar.locator(":scope > button");
        await expect(buttons).toHaveCount(2);
        const [first, second] = [await box(buttons.nth(0)), await box(buttons.nth(1))];
        expect(second.y, `${state}: the buttons share a row`).toBeCloseTo(first.y, 1);
        const outer = await box(bar);
        expect(second.x + second.width, `${state}: Save stays inside the bar`).toBeLessThanOrEqual(outer.x + outer.width);
      }

      const blocked = page.locator('[data-save-bar="blocked"] .save-bar');
      await expect(blocked.getByRole("button", { name: "Save Changes" })).toHaveAccessibleDescription("Fix 1 setting to save");
      await expect(page.locator('[data-save-bar="new-record"] .save-bar').getByRole("button")).toHaveText(["Cancel", "Create Automation"]);
    });
  }
}
