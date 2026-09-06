import { expect, test } from "@playwright/test";

test("starter categories start off, persist independently, and retain their value after a failed save", async ({ page }) => {
  await page.goto("/question-policies-e2e.html");
  const switches = page.getByRole("switch");
  await expect(switches).toHaveCount(3);
  for (const control of await switches.all()) await expect(control).toHaveAttribute("aria-checked", "false");
  if (process.env.QUESTION_POLICY_EVIDENCE) await page.screenshot({ path: process.env.QUESTION_POLICY_EVIDENCE + "/desktop-defaults.png", fullPage: true });
  await switches.nth(0).click();
  await expect(switches.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(switches.nth(1)).toHaveAttribute("aria-checked", "false");
  await switches.nth(2).click();
  await page.reload();
  await expect(switches.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(switches.nth(2)).toHaveAttribute("aria-checked", "true");
  if (process.env.QUESTION_POLICY_EVIDENCE) await page.screenshot({ path: process.env.QUESTION_POLICY_EVIDENCE + "/desktop-enabled.png", fullPage: true });
  await page.goto("/question-policies-e2e.html?failure");
  await switches.nth(0).click();
  await expect(page.getByRole("alert")).toHaveText("The policy could not be saved.");
  await expect(switches.nth(0)).toHaveAttribute("aria-checked", "true");
});

test("question policy controls fit mobile and expose policy attribution", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/question-policies-e2e.html?theme=dark");
  await expect(page.getByText("Answered by Policy", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("switch").nth(1).click();
  await expect(page.getByRole("switch").nth(1)).toHaveAttribute("aria-checked", "true");
  if (process.env.QUESTION_POLICY_EVIDENCE) await page.screenshot({ path: process.env.QUESTION_POLICY_EVIDENCE + "/mobile-dark.png", fullPage: true });
});
