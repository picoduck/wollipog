import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast } from "./layout-invariants.js";

const threadPath = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const cards = (page: Page) => page.getByRole("listitem", { name: "Create Automation", exact: true });
const reviewButton = (card: Locator) => card.getByRole("button", { name: "Review Automation" });
const reviewDialog = (page: Page) => page.getByRole("dialog", { name: "Create Automation" });

async function open(page: Page, theme: string, count: number, mode: "standalone" | "campaign") {
  await page.clock.setFixedTime(new Date("2026-11-19T19:00:00Z"));
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await page.goto(`/assistants-e2e.html?automation=${mode}&confirm=${count}&theme=${theme}&path=${encodeURIComponent(threadPath)}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`automation review dialog shows full standalone and campaign configuration with clean layout at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "dark", 2, "campaign");

    // Collapsed dock card requires reviewing the full automation before Approve Once.
    await expect(cards(page).first().getByRole("button", { name: "Approve Once", exact: true })).toHaveCount(0);
    await expectPageNoHorizontalOverflow(page);

    await reviewButton(cards(page).first()).click();
    const dialog = reviewDialog(page);
    await expect(dialog).toBeVisible();
    const details = dialog.getByRole("region", { name: "Create Automation Details" });
    await expect(details).toContainText("Nightly Maintenance Campaign");
    await expect(details).toContainText("Release Engineering (project-releases)");
    await expect(details).toContainText("Release Checkout (loc-release)");
    await expect(details).toContainText("0 2 * * *");
    await expect(details).toContainText("2026-11-23T09:00:00.000Z");
    await expect(details).toContainText("Enabled");
    await expect(details).toContainText("Dead Code Sweep");
    await expect(details).toContainText("Flaky Tests Check");
    await expect(details).toContainText("PR Merge: Human");
    await expect(details).toContainText("Implementation Question: Orchestrator");
    await expect(details).toContainText("$12");
    await expect(details).toContainText("120");

    // Layout invariants: no sideways overflow, primary actions stay visible, text contrast holds.
    await expectNoHorizontalOverflow(dialog);
    for (const name of ["Approve Once", "Deny"]) {
      const action = dialog.getByRole("button", { name, exact: true });
      await expect(action).toBeEnabled();
      await expect(action).toBeInViewport({ ratio: 1 });
    }
    await expectTextContrast(dialog);

    // Scroll to bottom of modal body and verify primary actions remain pinned in viewport.
    const body = dialog.locator(".modal-body");
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expectNoHorizontalOverflow(dialog);
    await expect(dialog.getByRole("button", { name: "Approve Once", exact: true })).toBeInViewport({ ratio: 1 });

    // Approving settles the automation request.
    await dialog.getByRole("button", { name: "Approve Once", exact: true }).click();
    await expect(page.getByText("Create Automation ran once.", { exact: true })).toBeVisible();
    await expect(cards(page)).toHaveCount(1);

    // Standalone review + Deny flow.
    await open(page, "light", 1, "standalone");
    await reviewButton(cards(page).first()).click();
    await expect(dialog).toBeVisible();
    await expect(details).toContainText("Weekly Read-Only Review");
    await expect(details).toContainText("Release Engineering (project-releases)");
    await expect(details).toContainText("Worktree");
    await expect(details).toContainText("$5");
    await expect(details).toContainText("50");
    await expectNoHorizontalOverflow(dialog);
    await expectTextContrast(dialog);
    await dialog.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.getByText("Create Automation was denied. Nothing ran.", { exact: true })).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
  });
}
