import { expect, test } from "@playwright/test";

/**
 * #1796: the session cost and context window popovers follow the shell's "one Escape, one layer"
 * rule (#718). The first Escape closes only the popover and returns focus to its trigger; the
 * session stays open until a second Escape leaves it.
 */
const POPOVERS = [
  { name: "session usage", trigger: ".session-cost-button", panel: ".session-usage-popover" },
  { name: "context window", trigger: ".context-ring-button", panel: ".context-popover" },
] as const;

for (const width of [390, 1440]) {
  for (const popover of POPOVERS) {
    test(`full shell closes the ${popover.name} popover without leaving the session at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/command-inbox-projects-e2e.html?scenario=session-usage-escape&fullShell=1");
      await page.getByRole("button", { name: /Alpha Session/ }).click();
      const expand = page.getByRole("button", { name: "Expand Session" });
      if (await expand.isVisible()) await expand.click();
      const sessionHeading = page.getByRole("heading", { level: 1, name: "Alpha Session" });
      await expect(sessionHeading).toBeVisible();
      await expect(page.locator(".composer-box")).toHaveCount(1);

      const trigger = page.locator(`${popover.trigger}:visible`);
      await trigger.click();
      const panel = page.locator(popover.panel);
      await expect(panel).toBeVisible();
      await expect(trigger).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
      await expect(sessionHeading).toBeVisible();
      await expect(page.locator(".composer-box")).toHaveCount(1);

      // The next Escape belongs to the session again.
      await page.keyboard.press("Escape");
      await expect(sessionHeading).toHaveCount(0);
      await expect(page.locator(".composer-box")).toHaveCount(0);
    });
  }
}

test("a modal opened over a status popover takes the first Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=session-usage-escape&fullShell=1");
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  const sessionHeading = page.getByRole("heading", { level: 1, name: "Alpha Session" });
  await expect(sessionHeading).toBeVisible();
  const trigger = page.locator(".session-cost-button:visible");
  await trigger.click();
  const panel = page.locator(".session-usage-popover");
  await expect(panel).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(panel).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(sessionHeading).toBeVisible();
});
