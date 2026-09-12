import { expect, test, type Page } from "@playwright/test";

/**
 * The automation card disclosure (#793), across the two widths the acceptance criteria call out.
 * `AutomationsView.dom.test.tsx` covers the component logic (default state, independent expansion,
 * polling, deletion, keyboard) against a fake DOM; this is the one thing that cannot be automated
 * there — real layout, real CSS, real touch-target geometry.
 */

async function open(page: Page) {
  await page.goto("/automations-e2e.html?theme=dark");
  await expect(page.getByRole("button", { name: /Nightly Dependency Sweep/ })).toBeVisible();
}

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1280, height: 900 } },
  { label: "mobile", viewport: { width: 375, height: 812 } },
]) {
  test.describe(`${label} width`, () => {
    test.use({ viewport });

    test("cards start collapsed, showing only name, summary, state, and the toggle", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toContainText("Enabled");
      // The header carries the action summary, not the automation's prompt.
      await expect(toggle).toContainText("Create agent-1 session on runner-1");
      await expect(page.getByText("Schedule", { exact: true })).toHaveCount(0);
      // Exact names throughout: the toggle's own accessible name ends in "Enabled" or "Paused",
      // which a substring match on "Enable"/"Pause" would pick up instead of the action button.
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    });

    test("activating the toggle expands the card and reveals its details and actions", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const bodyId = await toggle.getAttribute("aria-controls");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const body = page.locator(`#${bodyId}`);
      await expect(body).toBeVisible();
      await expect(body.getByText("Schedule", { exact: true })).toBeVisible();
      await expect(body.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await expect(body.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(`#${bodyId}`)).toHaveCount(0);
    });

    test("multiple cards expand independently", async ({ page }) => {
      await open(page);
      const first = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const second = page.getByRole("button", { name: /Weekly Digest/ });
      await first.click();
      await second.click();
      await expect(first).toHaveAttribute("aria-expanded", "true");
      await expect(second).toHaveAttribute("aria-expanded", "true");
      // Both bodies visible at once, and each shows its own management actions (Pause vs. Enable).
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible();

      await first.click();
      await expect(first).toHaveAttribute("aria-expanded", "false");
      await expect(second).toHaveAttribute("aria-expanded", "true");
    });

    test("Enter and Space both activate the disclosure from the keyboard", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    test("toggling keeps focus on the control and does not scroll the page", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      await toggle.focus();
      const scrollBefore = await page.evaluate(() => window.scrollY);

      // Collapsing unmounts the body; the control itself is never unmounted, so focus must stay on
      // it rather than falling back to <body> and stranding a keyboard user at the top of the page.
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toBeFocused();
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    });

    test("the toggle meets its minimum target size and stays inside the viewport", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const box = await toggle.boundingBox();
      expect(box).not.toBeNull();
      // 44px is the comfortable touch target the mobile stylesheet guarantees; on desktop the
      // pointer target only has to clear the WCAG 2.2 minimum.
      expect(box!.height).toBeGreaterThanOrEqual(label === "mobile" ? 44 : 24);
      // A long automation name must wrap rather than push the header out of the viewport.
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    });
  });
}
