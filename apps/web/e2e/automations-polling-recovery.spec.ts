import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

type PollingFixture = {
  failure: "list" | "trigger" | "workflow" | null;
  failRefreshAfterMutation: boolean;
  mutationCalls: number;
  mutationFailure: boolean;
  holdTriggers: boolean;
  listCalls: number;
  pendingTriggers: Array<() => void>;
  release: () => void;
};

async function poll(page: Page, changes: Partial<Pick<PollingFixture, "failure" | "holdTriggers">>) {
  return page.evaluate((changes) => {
    const fixture = (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture;
    Object.assign(fixture, changes);
    document.dispatchEvent(new Event("visibilitychange"));
    return fixture.listCalls;
  }, changes);
}

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1440, height: 900 } },
  { label: "mobile", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${label} ${theme} automation polling recovery`, () => {
    test.use({ viewport });
    test("clears complete polling recovery and preserves a failed Pause action", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/automations-e2e.html?theme=${theme}&polling-recovery`);
      const card = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const alert = page.locator('.automation-error[role="alert"]').filter({ hasText: /Synthetic/ });
      await expect(card).toBeVisible();
      await expect(alert).toHaveCount(0);
      await poll(page, { failure: "list" });
      await expect(alert).toHaveText("Synthetic polling failure");
      const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
      if (evidenceDir) await page.screenshot({
        path: join(evidenceDir, `polling-failed-${label}-${theme}.png`), fullPage: true,
      });

      await poll(page, { failure: null, holdTriggers: true });
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.pendingTriggers.length,
      )).toBe(2);
      await expect(alert).toHaveText("Synthetic polling failure");
      await page.evaluate(() => {
        const fixture = (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture;
        fixture.holdTriggers = false;
        fixture.release();
      });
      await expect(alert).toHaveCount(0);
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        document.body.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        document.querySelector(".main-pane")?.scrollTo(0, 0);
        window.scrollTo(0, 0);
      });
      if (evidenceDir) await page.screenshot({
        path: join(evidenceDir, `polling-recovered-${label}-${theme}.png`), fullPage: true,
      });

      await poll(page, { failure: "trigger" });
      await expect(alert).toHaveText("Synthetic polling failure");
      await poll(page, { failure: null });
      await expect(alert).toHaveCount(0);
      await card.click();
      await page.evaluate(() => {
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.mutationFailure = true;
      });
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(alert).toHaveText("Synthetic Pause failure");
      const previousCalls = await page.evaluate(() =>
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.listCalls,
      );
      await poll(page, { failure: null });
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.listCalls,
      )).toBeGreaterThan(previousCalls);
      await expect(alert).toHaveText("Synthetic Pause failure");
      if (evidenceDir && theme === "dark") {
        // Keep the retained action error readable at the top after clicking a lower card action.
        await card.click();
        await page.evaluate(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        document.body.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        document.querySelector(".main-pane")?.scrollTo(0, 0);
        window.scrollTo(0, 0);
      });
        await page.screenshot({ path: join(evidenceDir, `mutation-preserved-${label}-${theme}.png`), fullPage: true });
      }
      expect(errors).toEqual([]);
    });
  });
}


for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1440, height: 900 } },
  { label: "mobile", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${label} ${theme} accepted-action read recovery`, () => {
    test.use({ viewport });
    test("clears a recovered post-mutation read error while preserving an actual failed write", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
      const capture = async (state: string) => {
        if (!evidenceDir) return;
        await page.evaluate(() => {
          document.querySelector(".main-pane")?.scrollTo(0, 0);
          window.scrollTo(0, 0);
        });
        await page.screenshot({ path: join(evidenceDir, `post-mutation-${state}-${label}-${theme}.png`), fullPage: true });
      };
      await page.goto(`/automations-e2e.html?theme=${theme}&polling-recovery`);
      const card = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const alert = page.locator('.page > .automation-error[role="alert"]');
      await expect(card).toBeVisible();
      await card.click();
      await page.evaluate(() => {
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.failRefreshAfterMutation = true;
      });
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(alert).toHaveText("Synthetic post-mutation refresh failure");
      await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
      await expect(card).toContainText("Paused");
      await card.click();
      await capture("accepted-read-failed");

      await poll(page, { failure: null, holdTriggers: true });
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.pendingTriggers.length,
      )).toBe(2);
      await expect(alert).toHaveText("Synthetic post-mutation refresh failure");
      await page.evaluate(() => {
        const fixture = (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture;
        fixture.holdTriggers = false;
        fixture.release();
      });
      await expect(alert).toHaveCount(0);
      await expect(card).toContainText("Paused");
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.mutationCalls,
      )).toBe(1);
      await capture("read-recovered");

      // A separate real rejected Pause must stay visible even when all polling reads are healthy.
      await page.reload();
      await expect(card).toBeVisible();
      await card.click();
      await page.evaluate(() => {
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.mutationFailure = true;
      });
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(alert).toHaveText("Synthetic Pause failure");
      await expect(card).toContainText("Enabled");
      const previousCalls = await page.evaluate(() =>
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.listCalls,
      );
      await poll(page, { failure: null });
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.listCalls,
      )).toBeGreaterThan(previousCalls);
      await expect(alert).toHaveText("Synthetic Pause failure");
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.mutationCalls,
      )).toBe(1);
      await card.click();
      await capture("write-error-preserved");
      expect(errors).toEqual([]);
    });
  });
}
