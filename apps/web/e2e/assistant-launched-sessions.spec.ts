import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { expectFullyInViewport, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

/**
 * An Assistant thread's launched sessions in the side panel (#4776), against `assistants-main.tsx`'s
 * stub of the Thread API. The thread header keeps a toggle with live counts and whatever waits on the
 * owner; the sessions themselves are the side panel's Launched Sessions tool, hidden until asked for
 * and remembered per device like the session side panel. With `WOLLIPOG_EVIDENCE_DIR` set, each state
 * is also captured as UI evidence.
 */

const TRIAGE_PATH = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
/** A fixed clock, so each card's "5m ago" never changes between captures. */
const FIXED_NOW = Date.UTC(2026, 10, 20, 17, 0);

async function open(page: Page, theme: string, query = "") {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto(`/assistants-e2e.html?theme=${theme}&path=${encodeURIComponent(TRIAGE_PATH)}${query ? `&${query}` : ""}`);
  await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
}

async function capture(page: Page, name: string) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
}

const toggle = (page: Page) => page.locator(".assistant-launched-toggle");
const panel = (page: Page) => page.locator("#right-panel");
const launched = (page: Page) => panel(page).locator(".launched-sessions");
const group = (page: Page, name: string) => launched(page).getByRole("region", { name });
const waitingInHeader = (page: Page) => page.locator(".assistant-thread-head").getByRole("list", { name: "Sessions Waiting for You" });

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} at 1440×900`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, timezoneId: "UTC", locale: "en-US" });

    test("the panel starts closed; the header keeps the counts and the waiting approval, actionable", async ({ page }) => {
      await open(page, theme);
      await expect(toggle(page)).toHaveText("2 Sessions · 1 Needs You");
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
      await expect(panel(page)).toHaveCount(0);
      // Only the waiting session is in the header; the running one is in the closed panel.
      const waiting = waitingInHeader(page).locator(".assistant-work-card");
      await expect(waiting).toHaveCount(1);
      await expect(waiting).toContainText("Bump the Vite Group");
      await expect(page.locator(".assistant-thread-head")).not.toContainText("Fix the Flaky Upload Test");
      await expectFullyInViewport(page.locator(".composer"), "Thread composer");
      await capture(page, `assistant-launched-closed-${theme}-desktop`);

      // The approval is answered from the header with the panel still closed.
      await waiting.getByRole("button", { name: "Approve Once" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-approved", "sess-deps:req-1:allow");
      await expect(toggle(page)).toHaveText("2 Sessions");
      await expect(waitingInHeader(page)).toHaveCount(0);
      await expect(panel(page)).toHaveCount(0);
      // Its card left the header with focus in it; focus moves to the toggle, where the session now is.
      await expect(toggle(page)).toBeFocused();
    });

    test("the toggle opens Launched Sessions with waiting work first, and the counts follow the work live", async ({ page }) => {
      await open(page, theme);
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
      await expect(panel(page).locator(".rpanel-switcher-name")).toHaveText("Launched Sessions");
      await expect(group(page, "Needs You").locator(".assistant-work-card")).toHaveText([/Bump the Vite Group/]);
      await expect(group(page, "Active").locator(".assistant-work-card")).toHaveText([/Fix the Flaky Upload Test/]);
      await expect(group(page, "Finished")).toHaveCount(0);
      // The panel offers the approval now, so the header doesn't offer it a second time.
      await expect(waitingInHeader(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Approve Once" })).toHaveCount(1);
      await expectFullyInViewport(page.locator(".composer"), "Thread composer");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `assistant-launched-open-${theme}-desktop`);

      // The running session finishes: it moves to Finished, folded while other work is listed.
      await page.evaluate(() => (window as unknown as { assistantsAdvance: () => void }).assistantsAdvance());
      const finished = group(page, "Finished");
      await expect(finished.getByRole("button", { name: /Finished/ })).toHaveAttribute("aria-expanded", "false");
      await expect(finished.locator(".assistant-work-card")).toHaveCount(0);
      await expect(group(page, "Active")).toHaveCount(0);
      await finished.getByRole("button", { name: /Finished/ }).click();
      await expect(finished.locator(".assistant-work-card")).toHaveText([/Fix the Flaky Upload Test/]);

      // The assistant launches more work; the toggle counts it at once.
      await page.evaluate(() => (window as unknown as { assistantsLaunch: () => void }).assistantsLaunch());
      await expect(toggle(page)).toHaveText("3 Sessions · 1 Needs You", { timeout: 2_000 });
      await expect(group(page, "Active").locator(".assistant-work-card")).toHaveText([/Write the Changelog/]);

      // A card opens its session. The session page has no Launched Sessions, so its panel shows
      // Session Tools, and going back to the thread finds Launched Sessions as it was left.
      await group(page, "Active").getByRole("button", { name: /Write the Changelog/ }).click();
      await expect(page).toHaveURL(/path=%2Fsessions%2F(~|%7E)/);
      await expect(panel(page).locator(".rpanel-switcher-name")).toHaveText("Session Tools");
      await expect(panel(page).locator('.session-tool[data-tool="launched"]')).toHaveCount(0);
      await page.goBack();
      await expect(launched(page)).toBeVisible();
      await expect(panel(page).locator(".rpanel-switcher-name")).toHaveText("Launched Sessions");
    });

    test("the panel's open state is remembered on this device across a reload", async ({ page }) => {
      await open(page, theme);
      await toggle(page).click();
      await expect(launched(page)).toBeVisible();
      await page.reload();
      await expect(launched(page)).toBeVisible();
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
      await toggle(page).click();
      await expect(panel(page)).toHaveCount(0);
      await page.reload();
      await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
      await expect(panel(page)).toHaveCount(0);
    });

    test("with 42 launched sessions the conversation keeps its height and the panel scrolls on its own", async ({ page }) => {
      await open(page, theme, "launched=many");
      await expect(toggle(page)).toHaveText("42 Sessions · 1 Needs You");
      const head = page.locator(".assistant-thread-head");
      const closedHead = (await head.boundingBox())!.height;
      expect(closedHead, "the header holds no list of 42 cards").toBeLessThan(260);
      await expectFullyInViewport(page.locator(".composer"), "Thread composer");
      await capture(page, `assistant-launched-many-closed-${theme}-desktop`);

      await toggle(page).click();
      await expect(group(page, "Needs You").locator(".assistant-work-card")).toHaveText([/Bump the Vite Group/]);
      await expect(group(page, "Active").locator(".assistant-work-card")).toHaveCount(9);
      const finished = group(page, "Finished");
      await finished.getByRole("button", { name: /Finished/ }).click();
      await expect(finished.locator(".assistant-work-card")).toHaveCount(32);
      // The header loses its waiting card to the panel and keeps its height otherwise.
      expect((await head.boundingBox())!.height).toBeLessThanOrEqual(closedHead);
      const body = panel(page).locator(".rpanel-body");
      const scroll = await body.evaluate((element) => ({ overflow: element.scrollHeight - element.clientHeight }));
      expect(scroll.overflow, "the panel body scrolls its own list").toBeGreaterThan(0);
      // Reaching Finished scrolled the panel; the capture shows it from the top, Needs You first.
      await body.evaluate((element) => { element.scrollTop = 0; });
      // The page itself never scrolls; the composer stays where it was.
      expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(0);
      await expectFullyInViewport(page.locator(".composer"), "Thread composer");
      await capture(page, `assistant-launched-many-open-${theme}-desktop`);
      const last = finished.locator(".assistant-work-card").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await expectFullyInViewport(page.locator(".composer"), "Thread composer after scrolling the panel");
    });
  });

  test.describe(`${theme} at 390×844`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: theme, timezoneId: "UTC", locale: "en-US" });

    test("a phone keeps the waiting approval in the header and opens Launched Sessions as a full-screen sheet", async ({ page }) => {
      await open(page, theme);
      await expect(toggle(page)).toHaveText("2 Sessions · 1 Needs You");
      await expect(panel(page)).toHaveCount(0);
      const waiting = waitingInHeader(page).locator(".assistant-work-card");
      await expect(waiting.getByRole("button", { name: "Approve Once" })).toBeVisible();
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `assistant-launched-closed-${theme}-mobile`);

      await toggle(page).click();
      await expect(launched(page)).toBeVisible();
      // As on a session page: the sheet covers the screen from the top down to the tab bar.
      const box = (await panel(page).boundingBox())!;
      const tabs = (await page.getByRole("navigation", { name: "Primary Navigation" }).boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.x).toBeLessThanOrEqual(0);
      expect(box.y).toBeLessThanOrEqual(0);
      expect(box.width).toBeGreaterThanOrEqual(viewport.width);
      expect(Math.abs(box.y + box.height - tabs.y), "the sheet reaches the tab bar").toBeLessThanOrEqual(1);
      await expect(group(page, "Needs You").getByRole("button", { name: "Approve Once" })).toBeVisible();
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `assistant-launched-sheet-${theme}-mobile`);

      await panel(page).getByRole("button", { name: "Back to Session" }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(waitingInHeader(page).getByRole("button", { name: "Approve Once" })).toBeVisible();

      // A card in the sheet opens its session with the sheet out of the way.
      await toggle(page).click();
      await group(page, "Active").getByRole("button", { name: /Fix the Flaky Upload Test/ }).click();
      await expect(page).toHaveURL(/path=%2Fsessions%2F(~|%7E)/);
      await expect(panel(page)).toHaveCount(0);
    });

    test("a phone's sheet scrolls 42 launched sessions within itself", async ({ page }) => {
      await open(page, theme, "launched=many");
      await toggle(page).click();
      const finished = group(page, "Finished");
      await finished.getByRole("button", { name: /Finished/ }).click();
      const body = panel(page).locator(".rpanel-body");
      expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
      const last = finished.locator(".assistant-work-card").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `assistant-launched-many-sheet-${theme}-mobile`);
    });
  });
}
