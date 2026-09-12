import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

const fixtureUrl = "/command-inbox-projects-e2e.html?scenario=pending-prompt-reconciliation";

async function openAlphaSession(page: Page) {
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-detail")).toBeVisible();
}

async function capture(page: Page, phase: string, viewport: string) {
  const directory = process.env.PENDING_PROMPT_SCREENSHOT_DIR;
  if (!directory) return;
  await page.screenshot({ path: join(directory, `${phase}-${viewport}.png`), fullPage: true });
}

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
] as const) {
  test(`durable user-event evidence retires a started prompt with partial history on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(fixtureUrl);
    await page.evaluate(() => localStorage.clear());
    await page.goto(fixtureUrl);
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        status: "queued",
        pendingPrompts: [{
          commandId: "admission-queued",
          text: "Continue once capacity is available.",
          state: "queued",
          revision: 2,
          attemptCount: 287,
          createdAt: 10,
          updatedAt: 20,
        }],
      });
    });
    await openAlphaSession(page);

    const prompt = page.getByTestId("pending-prompt-admission-queued");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("Queued");
    await expect(prompt).toContainText("287 Delivery Attempts");
    await capture(page, "before", viewport.name);

    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        status: "running",
        activeTurnId: "turn-after-capacity-release",
        pendingPrompts: [{
          commandId: "admission-queued",
          text: "Continue once capacity is available.",
          state: "started",
          revision: 3,
          attemptCount: 287,
          userEventSeq: 991,
          createdAt: 10,
          updatedAt: 30,
        }],
      });
    });
    await expect(prompt).toHaveCount(0);
    await capture(page, "after", viewport.name);

    // The fixture deliberately has no command-tagged user event. Persisted receipt evidence must
    // still keep the duplicate retired after the browser reconnects and reloads its partial page.
    await page.reload();
    await openAlphaSession(page);
    await expect(page.getByTestId("pending-prompt-admission-queued")).toHaveCount(0);
  });
}
