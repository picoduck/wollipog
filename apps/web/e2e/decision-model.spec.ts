import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * Settings › Orchestrator › Decision Model and Campaign Status › Decision Model (#4101) in a real
 * browser, on the real pages: the Orchestrator settings page beside its defaults (the settings-rows
 * harness) and the Campaign Status panel (the campaign-status harness), at desktop and phone widths.
 *
 * `DECISION_MODEL_EVIDENCE=1` also saves a screenshot of each state into the test's output folder.
 */

const EVIDENCE = process.env.DECISION_MODEL_EVIDENCE === "1";
const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "390", width: 390, height: 844 },
] as const;

const group = (page: Page) => page.locator("section.settings-group").filter({ has: page.getByRole("heading", { name: "Decision Model", exact: true }) });
const settings = (query = "") => `/settings-rows-e2e.html?theme=dark&section=orchestrator${query}`;

async function capture(page: Page, name: string, testInfo: { outputPath: (name: string) => string }, scrollTo?: Page | ReturnType<Page["locator"]>) {
  if (!EVIDENCE) return;
  await dialogMotionSettled(page);
  if (scrollTo && "scrollIntoViewIfNeeded" in scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.label}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the group sits on the Orchestrator page after its defaults, scoped to the organization", async ({ page }, testInfo) => {
      await page.goto(settings());
      await expect(page.locator("#settings-panel-heading")).toHaveText("Orchestrator");
      await expect(page.getByRole("heading", { name: "Decision Delegation", exact: true })).toBeVisible();
      const decision = group(page);
      await expect(decision.locator(".settings-group-head")).toContainText("This Organization");
      await expect(decision.getByRole("button", { name: /^Model Source: Automatic/ })).toBeEnabled();
      await expect(decision.getByText("to the selected agent's provider")).toBeVisible();
      await capture(page, `${viewport.label}-admin-automatic`, testInfo, decision);
    });

    test("Test Decision Model shows the verdict, latency and attempts", async ({ page }, testInfo) => {
      await page.goto(settings());
      const decision = group(page);
      await decision.getByRole("button", { name: /^Run Test/ }).click();
      await expect(decision.getByText("Verdict: Confirm. 3.2 s, 1 attempt on Claude Code (Haiku, Low effort), answered by claude-haiku-5-5.")).toBeVisible();
      await capture(page, `${viewport.label}-admin-test-verdict`, testInfo, decision);
    });

    test("a test without a verdict says the campaign owner would decide", async ({ page }, testInfo) => {
      await page.goto(settings("&decisionTest=fail"));
      const decision = group(page);
      await decision.getByRole("button", { name: /^Run Test/ }).click();
      await expect(decision.getByText(/No verdict: the provider asked to slow down\. A campaign would ask its owner instead\. 42 s, 3 attempts/)).toBeVisible();
      await capture(page, `${viewport.label}-admin-test-no-verdict`, testInfo, decision);
    });

    test("an administrator chooses Machine, Agent Harness, Model and Effort", async ({ page }, testInfo) => {
      await page.goto(settings());
      const decision = group(page);
      await decision.getByRole("button", { name: /^Model Source:/ }).click();
      await page.getByRole("option", { name: /^Chosen Agent/ }).click();
      const dialog = page.getByRole("dialog", { name: "Agent for Decisions" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /^Model:/ }).click();
      await page.getByRole("option", { name: /^Haiku/ }).click();
      await dialog.getByRole("button", { name: /^Reasoning Effort:/ }).click();
      await page.getByRole("option", { name: /^Low/ }).click();
      await capture(page, `${viewport.label}-admin-agent-dialog`, testInfo);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden();
      await expect(decision.getByText("Claude Code on Studio Workstation")).toBeVisible();
      await expect(decision.getByText("Haiku · Low effort")).toBeVisible();
      await capture(page, `${viewport.label}-admin-chosen-agent`, testInfo, decision);
    });

    test("a member without admin permission reads the setting but cannot change or test it", async ({ page }, testInfo) => {
      await page.goto(settings("&decision=viewer"));
      const decision = group(page);
      await expect(decision.getByText("Claude Code on Studio Workstation")).toBeVisible();
      await expect(decision.getByRole("button", { name: /^Run Test/ })).toBeDisabled();
      await expect(decision.getByRole("button", { name: /^Edit…/ })).toBeDisabled();
      await expect(decision.getByText("Only an organization owner or admin can change this.").first()).toBeVisible();
      await capture(page, `${viewport.label}-viewer-read-only`, testInfo, decision);
    });

    test("Campaign Status groups each decision with its outcome, reason, target model, answering model and usage", async ({ page }, testInfo) => {
      await page.goto("/campaign-status-e2e.html?scenario=campaign&decisions=1");
      await expect(page.locator(".campaign-status-summary")).toBeVisible();
      const section = page.locator("section.campaign-status-handoffs").filter({ has: page.getByRole("heading", { name: "Decision Model", exact: true }) });
      await expect(section.getByText("3 calls, 6,932 tokens, $0.0104. Not counted in the campaign's cost.", { exact: false })).toBeVisible();
      const items = section.locator(".campaign-decision-item");
      await expect(items).toHaveCount(3);
      for (let index = 0; index < 3; index += 1) {
        await expect(items.nth(index)).toHaveCSS("border-top-style", "solid");
      }
      await expect(items.nth(0)).toContainText("Verdict: Confirm");
      // #4367: each record names its target and, as its own row, the exact model that answered.
      const fact = (index: number, term: string) => items.nth(index).locator("dl.facts > div")
        .filter({ has: page.getByRole("term").getByText(term, { exact: true }) }).locator("dd");
      await expect(items.nth(0).getByRole("term")).toHaveText(["Decision", "Outcome", "Target Model", "Answered By", "Usage"]);
      await expect(fact(0, "Target Model")).toContainText("Haiku, Low effort");
      await expect(fact(0, "Answered By")).toHaveText("claude-haiku-5-5");
      await expect(items.nth(0)).toContainText("3,466 tokens, $0.0052");
      await expect(fact(1, "Target Model")).toContainText("Haiku, Low effort");
      await expect(fact(1, "Answered By")).toHaveText("claude-sonnet-5-5");
      // An attempt that never reached a provider reports no model, so the record claims none.
      await expect(fact(2, "Target Model")).toContainText("Haiku, Low effort");
      await expect(fact(2, "Answered By")).toHaveCount(0);
      await expect(items.nth(1)).toContainText("Uncertain: the owner decides");
      await expect(items.nth(2)).toContainText("No verdict (no connected machine can make decisions): the owner decides");
      await capture(page, `${viewport.label}-campaign-status-decisions`, testInfo, section);
    });
  });
}
