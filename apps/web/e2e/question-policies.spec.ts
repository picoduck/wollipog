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
  await page.evaluate(() => {
    const policies = JSON.parse(sessionStorage.getItem("question-policies")!);
    policies[0].scope.runnerId = "chosen-runner";
    policies[0].priority = 7;
    sessionStorage.setItem("question-policies", JSON.stringify(policies));
  });
  await page.reload();
  await switches.nth(0).click();
  await switches.nth(0).click();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("question-policies")!)[0].scope.runnerId)).toBe("chosen-runner");
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
  const governanceRow = page.locator("[data-audit-id=\"hook-audit\"]").first();
  await expect(governanceRow.getByText("Blocked by Policy", { exact: true })).toBeVisible();
  // Compact by default: the audit facts stay behind a disclosure that is keyboard operable.
  await expect(governanceRow.getByText("Decided By", { exact: true })).toBeHidden();
  await governanceRow.getByRole("group").locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(governanceRow.getByText("Decided By", { exact: true })).toBeVisible();
  await expect(page.getByText("→ Answered by Policy: Review Sharing and Retries", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("switch").nth(1).click();
  await expect(page.getByRole("switch").nth(1)).toHaveAttribute("aria-checked", "true");
  if (process.env.QUESTION_POLICY_EVIDENCE) await page.screenshot({ path: process.env.QUESTION_POLICY_EVIDENCE + "/mobile-dark.png", fullPage: true });
});

test("governance history pages older decisions and keeps the native decision after its tool request", async ({ page }) => {
  await page.goto("/question-policies-e2e.html");
  const timeline = page.getByRole("list", { name: "Native Governance Event" });
  await timeline.getByRole("button", { name: /Worked · 1 Command/ }).click();
  await expect(timeline.getByText("Run Shell Command", { exact: true })).toBeVisible();
  await expect(timeline.locator('[data-audit-id="hook-audit"]')).toBeVisible();
  const timelineText = await timeline.innerText();
  expect(timelineText.indexOf("Run Shell Command")).toBeLessThan(timelineText.indexOf("Blocked by Policy"));

  const history = page.getByRole("list", { name: "Governance History" });
  await expect(history.locator("[data-audit-id]")).toHaveCount(1);
  if (process.env.GOVERNANCE_EVIDENCE) {
    await page.screenshot({ path: process.env.GOVERNANCE_EVIDENCE + "/governance-history-before.png", fullPage: true });
  }
  await page.getByRole("button", { name: "Load Older Decisions" }).click();
  await expect(history.locator("[data-audit-id]")).toHaveCount(2);
  await expect(history.getByText("Approved by You", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load Older Decisions" })).toHaveCount(0);
  if (process.env.GOVERNANCE_EVIDENCE) {
    await page.screenshot({ path: process.env.GOVERNANCE_EVIDENCE + "/governance-history-after.png", fullPage: true });
  }
});
