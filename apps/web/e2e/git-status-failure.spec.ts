import { expect, test } from "@playwright/test";
import { GIT_STATUS_DIAGNOSTIC, routeGitStatusFailure } from "./fixtures/git-status-failure.js";

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`${theme} ${viewport.width}px Git status failures`, () => {
      test.use({ viewport });

      test("an initial failure stays unknown and diagnostics only enter the DOM after disclosure", async ({ page }) => {
        await routeGitStatusFailure(page);
        await page.goto(`/git-status-failure-e2e.html?theme=${theme}`);
        const notice = page.locator(".notice.t-danger");
        await expect(notice).toContainText("Git status could not be read. The current status is unknown.");
        await expect(page.locator(".review-summary")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Refresh Review" })).toBeEnabled();
        await expect(page.locator(".notice-details-body")).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText("Command failed:");
        const toggle = notice.getByRole("button", { name: "Show Details", exact: true });
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(notice.locator("pre")).toHaveText(GIT_STATUS_DIAGNOSTIC);
        await expect(notice.getByRole("button", { name: "Hide Details" })).toBeFocused();
        const detailsId = await notice.locator(".notice-details-body").getAttribute("id");
        await expect(notice.getByRole("button", { name: "Hide Details" })).toHaveAttribute("aria-controls", detailsId!);
        await page.keyboard.press("Enter");
        await expect(page.locator(".notice-details-body")).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText("fatal:");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });

      test("a failed refresh retains last-known status and retry replaces it and clears the notice", async ({ page }) => {
        const controller = await routeGitStatusFailure(page, false);
        await page.goto(`/git-status-failure-e2e.html?theme=${theme}`);
        const row = page.locator(".review-summary");
        const refresh = page.getByRole("button", { name: "Refresh Review" });
        await expect(row).toContainText("feature/retry");
        await expect(row).toContainText("1 uncommitted file");
        await expect(row).toContainText("2 commits ahead");
        controller.fail();
        await refresh.click();
        const notice = page.locator(".notice.t-danger");
        await expect(notice).toContainText("The status shown below is the last known result and may be out of date.");
        await expect(row).toContainText("feature/retry");
        await expect(row).toContainText("1 uncommitted file");
        await expect(row).toContainText("2 commits ahead");
        await expect(page.locator(".notice-details-body")).toHaveCount(0);
        await notice.getByRole("button", { name: "Show Details" }).click();
        await expect(notice.locator("pre")).toHaveText(GIT_STATUS_DIAGNOSTIC);
        controller.recover({ branch: "feature/recovered", files: [], hasChanges: false, ahead: 0, remoteUrl: null });
        await refresh.click();
        await expect(notice).toHaveCount(0);
        await expect(page.locator(".notice-details-body")).toHaveCount(0);
        await expect(row).toContainText("feature/recovered");
        await expect(row).not.toContainText("uncommitted");
        await expect(row).not.toContainText("ahead");
        expect(controller.statusReads()).toBe(3);
        // A new failure after recovery must start collapsed, even if the previous one was open.
        controller.fail();
        await refresh.click();
        await expect(notice).toBeVisible();
        await expect(notice.getByRole("button", { name: "Show Details" })).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator(".notice-details-body")).toHaveCount(0);
      });

      test("a successful retry after an initial failure installs the first status", async ({ page }) => {
        const controller = await routeGitStatusFailure(page);
        await page.goto(`/git-status-failure-e2e.html?theme=${theme}`);
        await expect(page.locator(".notice.t-danger")).toContainText("The current status is unknown.");
        controller.recover();
        await page.getByRole("button", { name: "Refresh Review" }).click();
        await expect(page.locator(".notice.t-danger")).toHaveCount(0);
        await expect(page.locator(".review-summary")).toContainText("feature/retry");
        expect(controller.statusReads()).toBe(2);
      });
    });
  }
}
