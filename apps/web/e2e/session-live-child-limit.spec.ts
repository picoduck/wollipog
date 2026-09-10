import { expect, test } from "@playwright/test";

const SHOT = "test-results/session-live-child-limit";

async function openSession(page: import("@playwright/test").Page) {
  await page.goto("/command-inbox-projects-e2e.html?scenario=live-child-limit");
  await page.evaluate(() => {
    localStorage.clear();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      maxChildSessions: 6,
    });
  });
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".detail-head")).toBeVisible();
}

test("the Composer exposes and saves the live-child limit at desktop and mobile widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openSession(page);

  await page.getByRole("button", { name: "Add and Modes" }).click();
  const input = page.getByRole("spinbutton", { name: "Live Child Limit" });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("6");
  await expect(input).toHaveAttribute("max", "64");
  const menu = page.locator(".plus-menu");
  await expect(menu).toContainText("Live Child Limit");
  await expect(menu).not.toContainText("Pauses when spend reaches this amount");
  await expect(menu.getByRole("button", { name: /^About / })).toHaveCount(4);
  const costHelp = menu.getByRole("button", { name: "About Recurring Cost Threshold" });
  await costHelp.click();
  await expect(costHelp).toHaveAttribute("aria-expanded", "true");
  await expect(menu.locator(".plus-budget-help-popover")).toContainText("Pauses when spend reaches this amount");
  const toolHelp = menu.getByRole("button", { name: "About Tool-Call Threshold" });
  await toolHelp.click();
  await expect(menu.locator(".plus-budget-help-popover")).toHaveCount(1);
  await expect(costHelp).toHaveAttribute("aria-expanded", "false");
  await expect(toolHelp).toHaveAttribute("aria-expanded", "true");
  await toolHelp.press("Escape");
  await expect(costHelp).toHaveAttribute("aria-expanded", "false");
  await expect(menu.locator(".plus-budget-help-popover")).toHaveCount(0);
  await expect(input).toBeVisible();
  await page.screenshot({ path: `${SHOT}/desktop.png` });

  await input.fill("9");
  await input.press("Tab");
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
      .find((session) => session.id === "session-alpha")?.maxChildSessions,
  )).toBe(9);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("9");
  await page.screenshot({ path: `${SHOT}/mobile.png` });
});

test("guardrail help stays within a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 440 });
  await openSession(page);
  await page.getByRole("button", { name: "Add and Modes" }).click();
  const menu = page.locator(".composer-plus-pop");
  await menu.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await menu.getByRole("button", { name: "About Cost Checkpoints" }).click();
  const box = await menu.locator(".plus-budget-help-popover").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(8);
  expect(box!.y + box!.height).toBeLessThanOrEqual(432);
});
