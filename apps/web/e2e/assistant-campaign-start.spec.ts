import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const threadPath = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const dir = process.env.ASSISTANT_CAMPAIGN_EVIDENCE_DIR;
const cards = (page: Page) => page.getByRole("listitem", { name: "Start Campaign", exact: true });
const reviewButton = (card: Locator) => card.getByRole("button", { name: "Review Campaign" });
const reviewDialog = (page: Page) => page.getByRole("dialog", { name: "Start Campaign" });

async function capture(page: Page, name: string) {
  if (!dir) return;
  await page.mouse.move(1, 1);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" });
}

async function open(page: Page, theme: string, path: string, count: number) {
  await page.clock.setFixedTime(new Date("2026-11-19T19:00:00Z"));
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await page.goto(`/assistants-e2e.html?campaign&confirm=${count}&theme=${theme}&path=${encodeURIComponent(path)}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
    const key = `${viewport.name}-${theme}`;
    test(`${key} keeps campaign approvals, settings and launched work reachable`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, theme, threadPath, 7);
      await expect(cards(page)).toHaveCount(7);
      const first = cards(page).first();
      await expect(first.getByRole("button", { name: "Approve Once", exact: true })).toHaveCount(0);
      await expect(page.locator(".composer")).toBeInViewport({ ratio: 1 });
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `thread-${key}`);
      for (const card of await cards(page).all()) {
        const review = reviewButton(card);
        await review.scrollIntoViewIfNeeded();
        await expect(review).toBeInViewport({ ratio: 1 });
      }
      await reviewButton(first).click();
      const dialog = reviewDialog(page);
      const details = dialog.getByLabel("Campaign Details");
      const body = dialog.locator(".modal-body");
      const approve = dialog.getByRole("button", { name: "Approve Once", exact: true });
      await expect(details).toBeVisible();
      for (const fact of ["Location", "Campaign Mode", "Campaign Budget", "Orchestrator Harness", "Orchestrator Model",
        "Orchestrator Effort", "Child Harness", "Child Model", "Child Effort", "Repository Scope",
        "Initial Issues", "Issue Authority", "Delegated Operations", "Human-Required Gates"]) {
        await expect(details.getByText(fact, { exact: true })).toBeVisible();
      }
      await expect(details).toContainText("Release Engineering for Long-Running Cross-Platform Verification and Packaging");
      await expect(details).toContainText("claude-opus-5-5-release-engineering-long-context-verification-preview-fixture");
      await expect(dialog.getByRole("region", { name: "First Message" }))
        .toContainText("ReleaseEngineeringCrossPlatformPackagingReadinessChecklistWithoutAdditionalSeparators.");
      const nestedScrollers = await body.locator("*").evaluateAll(elements => elements.filter(element => {
        const style = getComputedStyle(element);
        return ["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      }).length);
      expect(nestedScrollers).toBe(0);
      expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect(approve).toBeInViewport({ ratio: 1 });
      await capture(page, `review-top-${key}`);
      await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(dialog.getByRole("region", { name: "First Message" })).toBeInViewport({ ratio: 1 });
      await expect(approve).toBeInViewport({ ratio: 1 });
      await capture(page, `review-end-${key}`);

      await dialog.getByRole("button", { name: "Change Budget" }).click();
      const editor = page.getByRole("dialog", { name: "Campaign Budget" });
      const cost = editor.getByRole("spinbutton", { name: "Cost Budget (USD)" });
      await expect(cost.locator("..").getByText("$", { exact: true })).toBeVisible();
      await cost.fill("25");
      await editor.getByRole("spinbutton", { name: "Tool Call Limit" }).fill("200");
      await capture(page, `budget-${key}`);
      await editor.getByRole("button", { name: "Update Preview" }).click();
      await expect(dialog).toContainText("$25 USD · 200 tool calls");
      await approve.click();
      await expect(cards(page)).toHaveCount(6);
      const work = page.getByRole("button", { name: /Plan the Release.*Campaign/u });
      await work.scrollIntoViewIfNeeded();
      await expect(work).toBeInViewport({ ratio: 1 });
      await expect(work.getByText("Campaign", { exact: true })).toBeVisible();
      await expect(page.locator(".composer")).toBeInViewport({ ratio: 1 });
      const toast = page.getByText("Start Campaign ran once.", { exact: true });
      await expect(toast).toBeVisible();
      if (dir) {
        await page.getByRole("button", { name: "Dismiss Notification", exact: true }).click();
        await expect(toast).toBeHidden();
      }
      await capture(page, `launched-${key}`);
      await work.click();
      await expect(page.getByRole("heading", { name: /Plan the Release$/u })).toBeVisible();
    });

    test(`${key} reviews the same campaign card from the Inbox`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, theme, "/inbox", 7);
      const notice = page.getByRole("region", { name: "Assistant Approvals" });
      await notice.getByRole("button", { name: "Review", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Campaign Approvals" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("listitem", { name: "Start Campaign", exact: true })).toHaveCount(7);
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `inbox-${key}`);
      await dialog.getByRole("button", { name: "Review Campaign", exact: true }).first().click();
      await expect(reviewDialog(page).getByLabel("Campaign Details")).toBeVisible();
      await reviewDialog(page).getByRole("button", { name: "Deny", exact: true }).click();
      await expect(dialog.getByRole("listitem", { name: "Start Campaign", exact: true })).toHaveCount(6);
    });
  }
}
