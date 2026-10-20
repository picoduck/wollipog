import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

/**
 * The automation page's polling and actions in a real browser (#2968): a failed read is a
 * Couldn't Refresh notice that the next complete read clears, and a failed Pause keeps its own
 * notice through every poll after it. The races themselves are `AutomationsView.dom.test.tsx`'s.
 */

type PollingFixture = {
  failure: "list" | "detail" | "trigger" | "workflow" | null;
  failRefreshAfterMutation: boolean;
  mutationCalls: number;
  mutationFailure: boolean;
  holdTriggers: boolean;
  listCalls: number;
  detailCalls: number;
  pendingTriggers: Array<() => void>;
  release: () => void;
};

const ROUTE = `/automations/~${Buffer.from("automation-nightly-sweep", "utf16le").toString("base64url")}`;

/** A count the fixture keeps: its calls, or how many trigger reads it is holding. */
function count(page: Page, field: "detailCalls" | "mutationCalls" | "pendingTriggers"): Promise<number> {
  return page.evaluate((field) => {
    const current = (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture;
    return field === "pendingTriggers" ? current.pendingTriggers.length : current[field];
  }, field);
}

async function poll(page: Page, changes: Partial<Pick<PollingFixture, "failure" | "holdTriggers">>) {
  return page.evaluate((changes) => {
    const current = (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture;
    Object.assign(current, changes);
    document.dispatchEvent(new Event("visibilitychange"));
    return current.detailCalls;
  }, changes);
}

/** Pause from the bar, or from ⋯ on a phone, where the bar holds only the pencil and ⋯. */
async function pause(page: Page, phone: boolean) {
  if (!phone) {
    await page.locator(".detail-bar").getByRole("button", { name: "Pause", exact: true }).click();
    return;
  }
  await page.locator(".detail-bar").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Pause", exact: true }).click();
}

async function capture(page: Page, name: string) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  await page.evaluate(() => {
    document.querySelector(".main-pane")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
}

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1440, height: 900 } },
  { label: "mobile", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  const phone = label === "mobile";
  test.describe(`${label} ${theme} automation page polling recovery`, () => {
    test.use({ viewport });
    test("clears complete polling recovery and preserves a failed Pause action", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/automations-e2e.html?theme=${theme}&polling-recovery&route=${encodeURIComponent(ROUTE)}`);
      const notice = page.locator(".automation-notice-slot .notice");
      await expect(page.locator(".automation-detail .glance")).toBeVisible();
      await expect(notice).toHaveCount(0);

      await poll(page, { failure: "detail" });
      await expect(notice.locator(".notice-title")).toHaveText("Couldn't Refresh");
      await expect(notice.locator(".notice-body")).toHaveText("Synthetic polling failure");
      await capture(page, `polling-failed-${label}-${theme}`);

      await poll(page, { failure: null, holdTriggers: true });
      await expect.poll(() => count(page, "pendingTriggers")).toBe(1);
      await expect(notice.locator(".notice-body")).toHaveText("Synthetic polling failure");
      await page.evaluate(() => {
        const current = (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture;
        current.holdTriggers = false;
        current.release();
      });
      await expect(notice).toHaveCount(0);
      await capture(page, `polling-recovered-${label}-${theme}`);

      await poll(page, { failure: "trigger" });
      await expect(notice.locator(".notice-body")).toHaveText("Synthetic polling failure");
      await poll(page, { failure: null });
      await expect(notice).toHaveCount(0);

      await page.evaluate(() => {
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.mutationFailure = true;
      });
      await pause(page, phone);
      await expect(notice.locator(".notice-title")).toHaveText("Automation Not Paused");
      await expect(notice.locator(".notice-body")).toHaveText("Synthetic Pause failure");
      const previousCalls = await count(page, "detailCalls");
      await poll(page, { failure: null });
      await expect.poll(() => count(page, "detailCalls")).toBeGreaterThan(previousCalls);
      await expect(notice.locator(".notice-body")).toHaveText("Synthetic Pause failure");
      await expect(page.locator(phone ? ".automation-status .status" : ".detail-bar .status")).toHaveText("Enabled");
      await capture(page, `mutation-preserved-${label}-${theme}`);
      expect(errors).toEqual([]);
    });

    test("clears a recovered post-mutation read error while preserving an actual failed write", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/automations-e2e.html?theme=${theme}&polling-recovery&route=${encodeURIComponent(ROUTE)}`);
      const notice = page.locator(".automation-notice-slot .notice");
      const badge = page.locator(phone ? ".automation-status .status" : ".detail-bar .status");
      await expect(badge).toHaveText("Enabled");
      await page.evaluate(() => {
        (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture.failRefreshAfterMutation = true;
      });
      await pause(page, phone);
      await expect(notice.locator(".notice-title")).toHaveText("Couldn't Refresh");
      await expect(notice.locator(".notice-body")).toHaveText("Synthetic polling failure");
      await capture(page, `post-mutation-accepted-read-failed-${label}-${theme}`);

      await poll(page, { failure: null, holdTriggers: true });
      await expect.poll(() => count(page, "pendingTriggers")).toBe(1);
      await expect(notice.locator(".notice-title")).toHaveText("Couldn't Refresh");
      await page.evaluate(() => {
        const current = (window as unknown as { automationPollingFixture: PollingFixture }).automationPollingFixture;
        current.holdTriggers = false;
        current.release();
      });
      await expect(notice).toHaveCount(0);
      await expect(badge).toHaveText("Paused");
      await expect.poll(() => count(page, "mutationCalls")).toBe(1);
      await capture(page, `post-mutation-read-recovered-${label}-${theme}`);
      expect(errors).toEqual([]);
    });
  });
}
