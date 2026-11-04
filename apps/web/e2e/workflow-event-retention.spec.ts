import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 16, 12))); });
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`workflow retention is separate, off until confirmed, and read-only for members at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/settings-rows-e2e.html?theme=dark&section=storage&retention=off");
    const workflow = page.getByRole("switch", { name: "Prune Workflow Events" });
    const archived = page.getByRole("switch", { name: "Prune Archived History" });
    await expect(workflow).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("spinbutton", { name: "Prune Workflow Events After" })).toHaveValue("90");
    await workflow.click();
    const dialog = page.getByRole("dialog", { name: "Prune Workflow Events" });
    await expect(dialog).toContainText("decisions and action receipts are kept");
    await expect(dialog).toContainText("17,500");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(workflow).toHaveAttribute("aria-checked", "false");
    await workflow.click();
    await dialog.getByRole("button", { name: "Prune Events" }).click();
    await expect(workflow).toHaveAttribute("aria-checked", "true");
    await expect(archived).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("24 workflow instances, 17,500 events", { exact: true })).toBeVisible();
    await page.goto("/settings-rows-e2e.html?theme=light&section=storage&workflowRetention=viewer");
    await expect(page.getByRole("switch", { name: "Prune Workflow Events" })).toBeDisabled();
  });
  test(`a pruned workflow keeps its outcome and explains missing events at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/command-inbox-projects-e2e.html?view=run&workflowPruned=1");
    // The steps' side column (#2977), which a phone shows under its Steps tab.
    const progress = viewport.width > 760
      ? page.getByRole("region", { name: "Workflow Progress" })
      : page.getByRole("tabpanel", { name: "Steps" });
    await expect(progress).toContainText("Event History Pruned");
    await expect(progress).toContainText("1,284 workflow events were removed by the 90-day retention policy.");
    await expect(progress.locator(".wf-panel .facts")).toContainText(/Outcome\s*Succeeded/u);
    await expect(progress.locator(".wf-step .status")).toHaveText("Succeeded");
  });
}
