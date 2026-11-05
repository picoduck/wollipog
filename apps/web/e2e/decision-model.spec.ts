import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * Settings › Orchestrator › Decision Model (#4101) in a real browser: the organization-scoped group
 * with its provider disclosure, Automatic and Chosen Agent, the agent dialog, Test Decision Model's
 * verdict, latency and attempts, a member without admin permission, and the Campaign Status section.
 *
 * `DECISION_MODEL_EVIDENCE=1` also saves a screenshot of each state into the test's output folder.
 */

const PAGE = "/decision-model-e2e.html";
const EVIDENCE = process.env.DECISION_MODEL_EVIDENCE === "1";

const group = (page: Page) => page.locator("section.settings-group").filter({ has: page.getByRole("heading", { name: "Decision Model" }) });

async function capture(page: Page, name: string, testInfo: { outputPath: (name: string) => string }) {
  if (!EVIDENCE) return;
  await dialogMotionSettled(page);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

test.use({ viewport: { width: 1440, height: 900 } });

test("an administrator sees the organization-scoped group with Automatic and its provider disclosure", async ({ page }, testInfo) => {
  await page.goto(PAGE);
  const decision = group(page);
  await expect(decision).toBeVisible();
  await expect(decision.getByText("This Organization")).toBeVisible();
  await expect(decision.getByRole("button", { name: /^Model Source: Automatic/ })).toBeEnabled();
  await expect(decision.getByText("to the selected agent's provider")).toBeVisible();
  await expect(decision.getByRole("button", { name: "Run Test" })).toBeEnabled();
  await capture(page, "admin-automatic", testInfo);
});

test("Test Decision Model shows the verdict, latency and attempts", async ({ page }, testInfo) => {
  await page.goto(PAGE);
  const decision = group(page);
  await decision.getByRole("button", { name: "Run Test" }).click();
  await expect(decision.getByText(/Verdict: Confirm\. 3\.2 s, 1 attempt on Claude Code \(haiku, Low effort\)\./)).toBeVisible();
  await capture(page, "admin-test-verdict", testInfo);
});

test("a test without a verdict says the campaign owner would decide", async ({ page }, testInfo) => {
  await page.goto(`${PAGE}?test=fail`);
  const decision = group(page);
  await decision.getByRole("button", { name: "Run Test" }).click();
  await expect(decision.getByText(/No verdict: the provider asked to slow down\. A campaign would ask its owner instead\. 42 s, 3 attempts/)).toBeVisible();
  await capture(page, "admin-test-no-verdict", testInfo);
});

test("an administrator chooses Machine, Agent Harness, Model and Effort", async ({ page }, testInfo) => {
  await page.goto(PAGE);
  const decision = group(page);
  await decision.getByRole("button", { name: /^Model Source:/ }).click();
  await page.getByRole("option", { name: /^Chosen Agent/ }).click();
  const dialog = page.getByRole("dialog", { name: "Agent for Decisions" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^Agent:/ }).click();
  await page.getByRole("option", { name: /^Claude Code/ }).click();
  await dialog.getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("option", { name: /^Haiku/ }).click();
  await dialog.getByRole("button", { name: /^Reasoning Effort:/ }).click();
  await page.getByRole("option", { name: /^Low/ }).click();
  await capture(page, "admin-agent-dialog", testInfo);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(decision.getByText("Claude Code on Studio Workstation")).toBeVisible();
  await expect(decision.getByText("Haiku · Low effort")).toBeVisible();
  await capture(page, "admin-chosen-agent", testInfo);
});

test("an unavailable chosen agent says why, and is never replaced by Automatic", async ({ page }, testInfo) => {
  await page.goto(`${PAGE}?source=unavailable`);
  const decision = group(page);
  await expect(decision.getByRole("button", { name: /^Model Source: Chosen Agent/ })).toBeVisible();
  await expect(decision.getByText("The selected Machine is offline.")).toBeVisible();
  await capture(page, "admin-unavailable", testInfo);
});

test("a member without admin permission reads the setting but cannot change or test it", async ({ page }, testInfo) => {
  await page.goto(`${PAGE}?source=chosen&viewer`);
  const decision = group(page);
  await expect(decision.getByText("Claude Code on Studio Workstation")).toBeVisible();
  await expect(decision.getByRole("button", { name: "Run Test" })).toBeDisabled();
  await expect(decision.getByRole("button", { name: /^Edit…/ })).toBeDisabled();
  await expect(decision.getByText("Only an organization owner or admin can change this.").first()).toBeVisible();
  await capture(page, "viewer-read-only", testInfo);
});

test("Campaign Status lists each decision's outcome, reason and usage apart from worker cost", async ({ page }, testInfo) => {
  await page.goto(`${PAGE}?view=campaign`);
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Decision Model" }) });
  await expect(section).toBeVisible();
  await expect(section.getByText(/3 calls, .* tokens, \$0\.0104\. Not counted in the campaign's cost\./)).toBeVisible();
  await expect(section.getByText("Verdict: Confirm")).toBeVisible();
  await expect(section.getByText("Uncertain: the owner decides")).toBeVisible();
  await expect(section.getByText("No verdict (no connected machine can make decisions): the owner decides")).toBeVisible();
  await capture(page, "campaign-status-decisions", testInfo);
});
