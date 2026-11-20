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
  test(`a thread's grant and decision history stay usable on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openAssistantFixture(page, thread);
    await threadAction(page, "Decision Delegation");
    const settings = page.getByRole("dialog", { name: "Decision Delegation" });
    const save = settings.getByRole("button", { name: "Save Grant" });
    await expect(settings.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(settings.getByRole("checkbox", { name: /release|ci rerun|ui evidence approval/i })).toHaveCount(0);
    await settings.getByRole("checkbox", { name: "Owner Questions", exact: true }).check();
    await settings.getByRole("checkbox", { name: "Pull Request Merge", exact: true }).check();
    await settings.getByRole("combobox", { name: "Project Scope" }).selectOption("selected");
    await settings.getByRole("checkbox", { name: /Release Validation and Engineering/ }).check();
    await expectNoHorizontalOverflow(settings, "Decision Delegation");
    await expectFullyInViewport(save, "Save Grant");
    await capture(page, "thread-project-scope");
    await settings.getByRole("combobox", { name: "Campaign Scope" }).selectOption("selected");
    await settings.getByRole("checkbox", { name: "Release Campaign 0", exact: true }).check();
    await expectNoHorizontalOverflow(settings, "Decision Delegation");
    await expectFullyInViewport(save, "Save Grant");
    await capture(page, "thread-campaign-scope");
    await save.click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
      categories: ["owner_question", "pr_merge"], projects: ["project_0"], campaigns: ["campaign_0"], expiresAt: null,
    }));
    await threadAction(page, "Decision Delegation");
    const revoke = settings.getByRole("button", { name: "Revoke Grant" });
    await expectFullyInViewport(revoke, "Revoke Grant");
    await revoke.click();
    await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", "null");
    await threadAction(page, "Delegated Decisions");
    const history = page.getByRole("dialog", { name: "Delegated Decisions" });
    await expect(history).toContainText("under your delegation.");
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
    await expectNoHorizontalOverflow(history, "Inbox Decision History");
    await expectFullyInViewport(history.getByRole("button", { name: "Close", exact: true }).last(), "Close");
    await capture(page, "inbox-history");
    await history.getByRole("button", { name: "Older Decisions" }).click();
    await expect(history.getByRole("listitem")).toHaveCount(4);
    await history.getByRole("button", { name: "Newer Decisions" }).click();
    await expect(history.getByRole("listitem")).toHaveCount(20);

    await page.goto("/campaign-status-e2e.html?scenario=campaign&delegation=stress");
    await page.getByRole("navigation", { name: "Campaign Sections" }).getByRole("button", { name: /Delegated Decisions/ }).click();
    const section = page.locator('[data-campaign-section="Delegated Decisions"]');
    await expect(section.getByText("The required checks passed and the review covered the current head.")).toBeVisible();
    await expectNoHorizontalOverflow(page.locator(".campaign-status"), "Campaign Status");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "campaign-history");
  });
}
