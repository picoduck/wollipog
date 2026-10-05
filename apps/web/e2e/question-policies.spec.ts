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
  await expect(governanceRow.locator("summary")).toHaveAccessibleName("Blocked Tool Request by Deny Shell Commands");
  // Compact by default: the audit facts stay behind a disclosure that is keyboard operable.
  await expect(governanceRow.getByText("Decided By", { exact: true })).toBeHidden();
  await governanceRow.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(governanceRow.getByText("Decided By", { exact: true })).toBeVisible();
  await expect(governanceRow).not.toContainText("deny-shell");
  const policyAnswer = page.getByRole("list", { name: "Policy Attribution Example" }).locator(".tl-question");
  await expect(policyAnswer.locator(".tl-step-status")).toHaveText("Answered by Policy");
  await expect(policyAnswer.locator(".tl-step-detail")).toHaveText("Answer: Proceed · Policy: Review Sharing and Retries");
  await expect(policyAnswer).not.toContainText("→");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("switch").nth(1).click();
  await expect(page.getByRole("switch").nth(1)).toHaveAttribute("aria-checked", "true");
  if (process.env.QUESTION_POLICY_EVIDENCE) await page.screenshot({ path: process.env.QUESTION_POLICY_EVIDENCE + "/mobile-dark.png", fullPage: true });
});

test("governance history pages older decisions and keeps the native decision after its tool request", async ({ page }) => {
  await page.goto("/question-policies-e2e.html");
  const timeline = page.getByRole("list", { name: "Native Governance Event" });
  await timeline.getByRole("button", { name: /^Worked.*1 Command/ }).click();
  await expect(timeline.getByText("Run Shell Command", { exact: true })).toBeVisible();
  await expect(timeline.locator('[data-audit-id="hook-audit"]')).toBeVisible();
  const timelineText = await timeline.innerText();
  expect(timelineText.indexOf("Run Shell Command")).toBeLessThan(timelineText.indexOf("Blocked"));

  const history = page.getByRole("list", { name: "Governance History" });
  await expect(history.locator("[data-audit-id]")).toHaveCount(1);
  if (process.env.GOVERNANCE_EVIDENCE) {
    await page.screenshot({ path: process.env.GOVERNANCE_EVIDENCE + "/governance-history-before.png", fullPage: true });
  }
  await page.getByRole("button", { name: "Load Older Decisions" }).click();
  await expect(history.locator("[data-audit-id]")).toHaveCount(2);
  await expect(history.locator("summary").last()).toHaveAccessibleName("Allowed Tool Request by You");
  await expect(page.getByRole("button", { name: "Load Older Decisions" })).toHaveCount(0);
  if (process.env.GOVERNANCE_EVIDENCE) {
    await page.screenshot({ path: process.env.GOVERNANCE_EVIDENCE + "/governance-history-after.png", fullPage: true });
  }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`decision records read as one past-tense line with their facts behind the chevron at ${viewport.width}px (#2204)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/question-policies-e2e.html?set=decisions");
    const timeline = page.getByRole("list", { name: "Decision Records" });
    const rows = timeline.locator("details.tl-decision");
    await expect(rows).toHaveCount(6);
    await expect.poll(() => rows.locator("summary").evaluateAll((summaries) =>
      summaries.map((summary) => summary.getAttribute("aria-label")))).toEqual([
      "Allowed Run the Web Unit Tests by You",
      "Rejected Delete the Build Cache by You",
      "Allowed Push the Release Branch by Release Orchestrator",
      "Blocked Bash by No Shell in Production",
      "Timed Out Deploy by Ask Before Deploys",
      "Blocked Write by Wollipog",
    ]);
    await expect(timeline).not.toContainText("→");
    await expect(timeline).not.toContainText(/approved_for_session|session-release-orchestrator|no-shell-in-production|audit-/);
    for (const summary of await rows.locator("summary").all()) {
      const box = (await summary.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.height).toBeLessThan(40);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    const parent = rows.nth(2);
    await parent.locator("summary").click();
    await expect(parent.getByRole("button", { name: "Release Orchestrator" })).toBeVisible();
    await expect(parent.locator("dt")).toHaveText(["Decided By", "Tool", "Path", "Branch", "Command", "Recorded"]);
    await expect(parent.locator(".code-well pre")).toHaveText("git push origin release/v0.31.0");
    await expect(parent.getByRole("button", { name: "Copy Audit ID" })).toBeVisible();
  });
}

test.describe("on a coarse pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("decision record summaries are 44px touch targets (#2204)", async ({ page }) => {
    await page.goto("/question-policies-e2e.html?set=decisions");
    const summaries = page.getByRole("list", { name: "Decision Records" }).locator("details.tl-decision > summary");
    await expect(summaries).toHaveCount(6);
    for (const summary of await summaries.all()) {
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
