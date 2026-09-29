import { expect, test, type Locator } from "@playwright/test";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1955: a labeled copy button confirms with an icon. Its leading icon becomes a check and its label
 * "Copied" (or an error icon and "Copy Failed") for about two seconds, then it returns to its label,
 * and its width never changes (docs/design-system.md §18). Measured before and after on the SAME
 * element, so the font stack of the machine cancels out.
 */

interface Box { left: number; width: number; height: number }

async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, width: rect.width, height: rect.height };
  });
}

function expectSameBox(now: Box, before: Box, what: string) {
  expectGeometry(Math.abs(now.width - before.width), `${what}: the width does not change`).toBeLessThanOrEqual(0.61);
  expectGeometry(Math.abs(now.height - before.height), `${what}: the height does not change`).toBeLessThanOrEqual(0.61);
  expectGeometry(Math.abs(now.left - before.left), `${what}: the button does not move`).toBeLessThanOrEqual(0.61);
}

const VARIANTS = [["Default", "Copy"], ["Code Block", "Copy Code"], ["Secondary", "Copy Pairing Link"], ["Primary", "Copy Pairing Link"]] as const;
const RESULTS = [
  ["copied", "Copied", "copy-status-icon-copied"],
  ["failed", "Copy Failed", "copy-status-icon-failed"],
] as const;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport });

    for (const [result, shown, iconClass] of RESULTS) {
      test(`every labeled copy button shows "${shown}" with an icon, keeps its width, then returns`, async ({ page }) => {
        await page.goto(`/copy-button-e2e.html${result === "failed" ? "?result=fail" : ""}`);
        for (const [variant, label] of VARIANTS) {
          const row = page.locator(`.actions[data-variant="${variant}"]`);
          const button = row.getByRole("button", { name: label });
          const visible = button.locator(".copy-btn-labels > [data-shown]");
          const after = row.locator('[data-neighbour="after"]');
          await expect(visible).toHaveText(label);
          const idle = await box(button);
          const neighbour = await box(after);

          await button.click();
          await expect(visible).toHaveText(shown);
          await expect(button.locator("svg").first()).toHaveClass(new RegExp(`\\b${iconClass}\\b`));
          await expect(button).not.toContainText("✓");
          expectSameBox(await box(button), idle, `${variant} ${shown}`);
          expectSameBox(await box(after), neighbour, `${variant} ${shown}'s neighbour`);
          // The label stays on one line inside the button.
          const fits = await visible.evaluate((element) => {
            const own = element.closest("button")!.getBoundingClientRect();
            const words = element.getBoundingClientRect();
            const text = document.createRange();
            text.selectNodeContents(element);
            const lines = new Set([...text.getClientRects()].map((rect) => Math.round(rect.top))).size;
            return words.left >= own.left - 0.5 && words.right <= own.right + 0.5 && lines === 1;
          });
          expect(fits, `${variant} ${shown}: the label fits`).toBe(true);

          await expect(visible).toHaveText(label, { timeout: 4_000 });
          await expect(button.locator("svg").first()).not.toHaveClass(new RegExp(`\\b${iconClass}\\b`));
          expectSameBox(await box(button), idle, `${variant} back to its label`);
        }
      });
    }

    test("the icon-only copy button swaps its icon without changing size", async ({ page }) => {
      await page.goto("/copy-button-e2e.html");
      const button = page.getByRole("button", { name: "Copy Start Command" });
      const idle = await box(button);
      await button.click();
      await expect(button.locator("svg")).toHaveClass(/\bcopy-status-icon-copied\b/);
      expectSameBox(await box(button), idle, "Icon-only copy");
      expect(await button.locator("svg").evaluate((svg) => svg.getBoundingClientRect().width)).toBe(16);
    });
  });
}
