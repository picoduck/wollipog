import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const threadPath = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const dir = process.env.ASSISTANT_CAMPAIGN_EVIDENCE_DIR;
const cards = (page: Page) => page.getByRole("listitem", { name: "Start Campaign", exact: true });
const details = (card: Locator) => card.getByRole("region", { name: "Campaign Details" });

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
      const long = cards(page).nth(1);
      await expect(first).toContainText("First Message");
      await expect(first).toContainText("Full Control");
      await expect(first).toContainText("$20 USD · 150 tool calls");
      const approve = first.getByRole("button", { name: "Approve Once" });
      await approve.scrollIntoViewIfNeeded();
      await expect(approve).toBeInViewport({ ratio: 1 });
      await expect(page.locator(".composer")).toBeInViewport({ ratio: 1 });
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `thread-${key}`);
      const longApprove = long.getByRole("button", { name: "Approve Once" });
      await longApprove.scrollIntoViewIfNeeded();
      await expect(longApprove).toBeInViewport({ ratio: 1 });
      await expect(details(long)).toContainText("LongUnbrokenReleaseChecklistIdentifier");
      expect(await details(long).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await details(long).evaluate(element => { element.scrollTop = 190; });
      await capture(page, `long-${key}`);
      for (const card of await cards(page).all()) {
        const deny = card.getByRole("button", { name: "Deny", exact: true });
        await deny.scrollIntoViewIfNeeded();
        await expect(deny).toBeInViewport({ ratio: 1 });
      }
      await first.getByRole("button", { name: "Change Budget" }).click();
      await first.getByRole("spinbutton", { name: "Cost Budget (USD)" }).fill("25");
      await first.getByRole("spinbutton", { name: "Tool Call Limit" }).fill("200");
      await first.scrollIntoViewIfNeeded();
      await expect(first.getByRole("spinbutton", { name: "Cost Budget (USD)" })).toBeInViewport({ ratio: 1 });
      await capture(page, `budget-${key}`);
      await first.getByRole("button", { name: "Update Preview" }).click();
      await expect(first).toContainText("$25 USD · 200 tool calls");
      await approve.click();
      await expect(cards(page)).toHaveCount(6);
      for (let remaining = 6; remaining > 0; remaining--) {
        await cards(page).first().getByRole("button", { name: "Deny", exact: true }).click();
        await expect(cards(page)).toHaveCount(remaining - 1);
      }
      const work = page.getByRole("button", { name: /Plan the Release.*Orchestrator Campaign/ });
      await work.scrollIntoViewIfNeeded();
      await expect(work).toBeInViewport({ ratio: 1 });
      await expect(page.locator(".composer")).toBeInViewport({ ratio: 1 });
      if (dir) await page.getByRole("button", { name: "Dismiss", exact: true }).all().then(async buttons => {
        for (const button of buttons.reverse()) await button.click();
      });
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
      const approve = dialog.getByRole("button", { name: "Approve Once" }).first();
      await approve.scrollIntoViewIfNeeded();
      await expect(approve).toBeInViewport({ ratio: 1 });
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `inbox-${key}`);
      await dialog.getByRole("button", { name: "Deny" }).first().click();
      await expect(dialog.getByRole("listitem", { name: "Start Campaign", exact: true })).toHaveCount(6);
    });
  }
}
