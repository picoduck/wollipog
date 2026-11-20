import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const evidence = process.env.ASSISTANT_DELEGATION_EVIDENCE_DIR;
const thread = viewPath({ name: "assistants", threadId: "thr_triage" });

async function openAssistantFixture(page: Page, path: string, supported = true) {
  await page.goto(`/assistants-e2e.html?delegation=${supported ? "stress" : "old"}&path=${encodeURIComponent(path)}`);
}

for (const theme of ["light", "dark"] as const) {
  for (const [layout, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
    test(`Assistant evidence approval in ${theme} on ${layout}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      const scenario = (state: string) => page.goto(
        `/assistants-e2e.html?theme=${theme}&delegation=stress&evidence=${state}&path=${encodeURIComponent(thread)}`,
      );
      const screenshot = async (state: string) => {
        if (!evidence) return;
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `assistant-evidence-${state}-${theme}-${layout}.png`), animations: "disabled" });
      };
      const dialog = page.getByRole("dialog", { name: "Decision Delegation" });
      const approval = dialog.getByRole("checkbox", { name: "UI Evidence Approval", exact: true });
      const denial = dialog.getByRole("checkbox", { name: "UI Evidence Denial", exact: true });
      const save = dialog.getByRole("button", { name: "Save Grant" });
      const openGrant = async (state: string) => {
        await scenario(state);
        await threadAction(page, "Decision Delegation");
        await expectNoHorizontalOverflow(dialog, "Decision Delegation");
        await expectFullyInViewport(save, "Save Grant");
        await expect(denial).toBeEnabled();
      };

      await openGrant("legacy");
      await expect(approval).toHaveCount(0);
      await screenshot("before");
      await openGrant("unavailable");
      await expect(approval).toBeDisabled();
      await expect(approval).toHaveAccessibleDescription(/Update this Machine’s runner/);
      await approval.scrollIntoViewIfNeeded();
      await screenshot("unavailable");
      await openGrant("available");
      await expect(approval).not.toBeChecked();
      await approval.check();
      await expect(approval).toHaveAccessibleDescription(/Claude Code.*claude-opus-5-5.*provider may retain/);
      await dialog.getByRole("button", { name: "Project Scope: All Projects" }).click();
      await page.getByRole("option", { name: "Selected Projects" }).click();
      await dialog.getByRole("checkbox", { name: /Release Validation and Engineering/ }).check();
      await expect(dialog).toContainText("Showing 1–5 of 36 projects");
      await approval.scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(dialog, "Grant with provider disclosure and scoped projects");
      await expectFullyInViewport(save, "Save Grant after selecting a project");
      await screenshot("available");
      await save.click();
      await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
        categories: ["ui_evidence_review"], projects: ["project_0"], campaigns: "all", expiresAt: null,
        evidenceDisclosureDigest: "a".repeat(64),
      }));
      await scenario("refused");
      await page.getByRole("button", { name: /Worked.*1 Failed/ }).click();
      await page.getByLabel("Resolve UI Evidence · Failed", { exact: true }).click();
      const message = page.getByText(/UI evidence approval requires current review receipts/);
      await expect(message).toBeVisible();
      await expectPageNoHorizontalOverflow(page);
      await screenshot("refused");
    });
  }
}

async function threadAction(page: Page, name: string) {
  await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("a control plane without delegation support offers no grant or history actions", async ({ page }) => {
  await openAssistantFixture(page, thread, false);
  await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Decision Delegation" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delegated Decisions" })).toHaveCount(0);
});

for (const [layout, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
  const capture = async (page: Page, view: string) => {
    if (!evidence) return;
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `${view}-${layout}.png`), animations: "disabled" });
  };
  test(`a grant that expires is shown as expired on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.clock.install({ time: new Date("2026-11-19T16:00:00Z") });
    await page.goto(`/assistants-e2e.html?delegation=expires&path=${encodeURIComponent(thread)}`);
    const details = page.getByLabel("Thread Details");
    await expect(details).toContainText("Decision Delegation Set");
    await page.clock.fastForward(61_000);
    await expect(details).toContainText("Decision Delegation Expired");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "thread-grant-expired");
  });
  test(`a thread's grant and decision history stay usable on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openAssistantFixture(page, thread);
    await threadAction(page, "Decision Delegation");
    const settings = page.getByRole("dialog", { name: "Decision Delegation" });
    const save = settings.getByRole("button", { name: "Save Grant" });
    const details = page.getByLabel("Thread Details");
    await expect(details).toContainText("Decision Delegation Off");
    await expect(settings.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(settings.getByRole("checkbox", { name: /release|ci rerun|ui evidence approval/i })).toHaveCount(0);
    await settings.getByRole("checkbox", { name: "Owner Questions", exact: true }).check();
    await settings.getByRole("checkbox", { name: "Pull Request Merge", exact: true }).check();
    await settings.getByRole("button", { name: "Project Scope: All Projects" }).click();
    await expect(page.getByRole("option", { name: "Selected Projects" })).toBeVisible();
    await capture(page, "thread-project-picker");
    await page.getByRole("option", { name: "Selected Projects" }).click();
    await settings.getByRole("checkbox", { name: /Release Validation and Engineering/ }).check();
    await expect(settings).toContainText("Showing 1–5 of 36 projects");
    await expectNoHorizontalOverflow(settings, "Decision Delegation");
    await expectFullyInViewport(save, "Save Grant");
    await capture(page, "thread-project-scope");
    await settings.getByRole("button", { name: "Campaign Scope: All Campaigns" }).click();
    await page.getByRole("option", { name: "Selected Campaigns" }).click();
    await settings.getByRole("checkbox", { name: "Release Campaign 0", exact: true }).check();
    const expiry = settings.getByLabel("Expires at (Optional)");
    await expiry.scrollIntoViewIfNeeded();
    await expectFullyInViewport(expiry, "Expiration");
    await expect(settings).toContainText("Showing 1–5 of 36 campaigns");
    await expectNoHorizontalOverflow(settings, "Decision Delegation");
    await expectFullyInViewport(save, "Save Grant");
    await capture(page, "thread-campaign-scope");
    await save.click();
    await expect(settings).toHaveCount(0);
    await expect(details).toContainText("Decision Delegation Set");
    await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
      categories: ["owner_question", "pr_merge"], projects: ["project_0"], campaigns: ["campaign_0"], expiresAt: null,
    }));
    await threadAction(page, "Decision Delegation");
    const revoke = settings.getByRole("button", { name: "Revoke Grant" });
    await expiry.scrollIntoViewIfNeeded();
    await expectFullyInViewport(revoke, "Revoke Grant");
    await expectFullyInViewport(expiry, "Expiration on an existing grant");
    await capture(page, "thread-existing-grant");
    await revoke.click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", "null");
    await expect(details).toContainText("Decision Delegation Off");
    await capture(page, "thread-grant-revoked");
    await threadAction(page, "Delegated Decisions");
    const history = page.getByRole("dialog", { name: "Delegated Decisions" });
    await expect(history).toContainText("under your delegation.");
    await expect(history).toContainText("Triage Open Issues");
    await expect(history.getByRole("listitem")).toHaveCount(5);
    await history.getByRole("listitem").nth(1).scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(history, "Thread Decision History");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "thread-history");
  });

  test(`Inbox and Campaign Status show bounded delegated decisions on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openAssistantFixture(page, "/");
    await page.getByRole("button", { name: "More Actions", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Delegated Decisions", exact: true }).click();
    const history = page.getByRole("dialog", { name: "Delegated Decisions" });
    await expect(history).toContainText("The required checks passed and the review covered the current head.");
    await expect(history.getByRole("button", { name: "Triage Open Issues" }).first()).toBeVisible();
    await expectNoHorizontalOverflow(history, "Inbox Decision History");
    await expectFullyInViewport(history.getByRole("button", { name: "Close", exact: true }).last(), "Close");
    await history.getByRole("listitem").nth(1).scrollIntoViewIfNeeded();
    await capture(page, "inbox-history");
    await history.getByRole("button", { name: "Older Decisions" }).click();
    await expect(history.getByRole("listitem")).toHaveCount(5);
    await expect(history).toContainText("picoduck/wollipog#120");
    await history.getByRole("button", { name: "Newer Decisions" }).click();
    await expect(history.getByRole("listitem")).toHaveCount(5);
    await expect(history).toContainText("picoduck/wollipog#126");

    await page.goto("/campaign-status-e2e.html?scenario=campaign&delegation=stress");
    await page.getByRole("navigation", { name: "Campaign Sections" }).getByRole("button", { name: /Delegated Decisions/ }).click();
    const section = page.locator('[data-campaign-section="Delegated Decisions"]');
    await expect(section.getByText("The required checks passed and the review covered the current head.")).toBeVisible();
    await expect(section.getByRole("listitem")).toHaveCount(5);
    await section.getByRole("listitem").nth(1).scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page.locator(".campaign-status"), "Campaign Status");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "campaign-history");
  });
}
