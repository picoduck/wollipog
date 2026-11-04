import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

const encoded = (id: string) => Buffer.from(id, "utf16le").toString("base64url");
const automationPath = `/automations/~${encoded("automation-nightly-sweep")}`;
const skillPath = `/skills/~${encoded("skill-n6")}`;

async function assertShellAnchored(page: Page) {
  // A hidden 1px absolute element must not make the document a second scroll owner (#4152).
  await page.evaluate(() => window.scrollTo(0, 350));
  const geometry = await page.evaluate(() => ({
    height: innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    scrollY,
    railBottom: document.querySelector(".app-rail")!.getBoundingClientRect().bottom,
  }));
  expect(geometry.documentHeight).toBe(geometry.height);
  expect(geometry.scrollY).toBe(0);
  expect(Math.abs(geometry.railBottom - geometry.height)).toBeLessThanOrEqual(1);
}

for (const width of [390, 1280]) {
  test.describe(`hidden accessible content at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: width === 390 });

    test("Run History stays inside the shell, including its action menu and Run Details dialog", async ({ page }) => {
      await page.goto(`/automations-e2e.html?fullShell&route=${encodeURIComponent(automationPath)}&run-history`);
      const table = page.locator("table.automation-runs");
      await expect(table.locator("tbody tr")).toHaveCount(10);
      await assertShellAnchored(page);
      const last = table.locator("tbody tr").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await assertShellAnchored(page);
      await expect(table.getByRole("columnheader", { name: "Started", exact: true })).toHaveCount(1);

      await last.locator('.actions-cell button[aria-haspopup="menu"]').click();
      const item = page.getByRole("menuitem", { name: "Run Details…" });
      await expect(item).toBeInViewport();
      await item.click();
      const dialog = page.locator('[role="dialog"].automation-run-details');
      await expect(dialog).toBeVisible();
      await dialogMotionSettled(page);
      await expect(dialog).toBeInViewport();
      const box = (await dialog.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(845);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await assertShellAnchored(page);
    });

    test("multiple expanded outbound delivery tables do not move navigation", async ({ page }) => {
      await page.goto("/automations-e2e.html?fullShell&route=%2Fautomations%2Foutbound");
      for (const address of ["hooks.acme.dev/wollipog/events", "events.example.com/wollipog"]) {
        await page.locator(".outbound-subscription-open").filter({ hasText: address }).click();
      }
      const tables = page.locator("table.outbound-deliveries");
      await expect(tables).toHaveCount(2);
      await assertShellAnchored(page);
      const last = tables.last().locator("tbody tr").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await expect(tables.last().getByRole("columnheader", { name: "Next Retry", exact: true })).toHaveCount(1);
      await assertShellAnchored(page);
    });

    test("Skill descriptions and live statuses stay inside the nested detail scroller", async ({ page }) => {
      await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&history=1&skills=notices&deployment=1&path=${encodeURIComponent(skillPath)}`);
      await expect(page.locator("table.skill-deployment")).toBeVisible();
      const copy = page.getByRole("button", { name: "Copy", exact: true });
      await expect(copy).toHaveAccessibleDescription("Copies SKILL.md");
      await expect(page.locator('.skill-assignment > [role="status"]')).not.toHaveCount(0);
      await assertShellAnchored(page);
      const assertOuterDoesNotScroll = async () => expect(await page.locator(".main-body")
        .evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
      await assertOuterDoesNotScroll();
      await copy.scrollIntoViewIfNeeded();
      await expect(copy).toBeInViewport();
      await assertShellAnchored(page);
      await assertOuterDoesNotScroll();
      await page.locator("table.skill-deployment").scrollIntoViewIfNeeded();
      await expect(page.locator("table.skill-deployment")).toBeInViewport();
      await assertShellAnchored(page);
      await assertOuterDoesNotScroll();
    });
  });
}
