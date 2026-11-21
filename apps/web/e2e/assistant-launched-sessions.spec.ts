import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { expectFullyInViewport, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

/**
 * An Assistant thread's launched sessions in the side panel (#4776), against `assistants-main.tsx`'s
 * stub of the Thread API. The thread bar signals when launched work needs the owner,
 * and the waiting approval is answered in the conversation; the sessions themselves are in the thread panel's Work tab, hidden
 * until asked for and remembered per device like the session side panel. With `WOLLIPOG_EVIDENCE_DIR`
 * set, each state is also captured as UI evidence.
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

const toggle = (page: Page) => page.getByRole("button", { name: /Side Panel/ });
const panel = (page: Page) => page.locator("#right-panel");
const launched = (page: Page) => panel(page).locator(".launched-sessions");
const group = (page: Page, name: string) => launched(page).getByRole("region", { name });
const waitingInHeader = (page: Page) => page.locator(".assistant-thread-head").getByRole("list", { name: "Sessions Waiting for You" });
const advance = (page: Page) => page.evaluate(() => (window as unknown as { assistantsAdvance: () => void }).assistantsAdvance());

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} at 1440×900`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, timezoneId: "UTC", locale: "en-US" });

    test("the panel starts closed; the bar signals the waiting approval, actionable", async ({ page }) => {
      await open(page, theme);
      await expect(toggle(page)).toHaveAccessibleName("Show Side Panel, 1 Session Needs You");
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
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
      await expect(toggle(page)).toHaveAccessibleName("Side Panel");
      await expect(waitingInHeader(page)).toHaveCount(0);
      await expect(panel(page)).toHaveCount(0);
      // Its card left the header with focus in it; focus moves to the toggle, where the session now is.
      await expect(toggle(page)).toBeFocused();
    });

    test("Work lists waiting work first and its counts follow the work live", async ({ page }) => {
      await open(page, theme);
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await expect(panel(page).getByRole("tab", { name: /^Work/, selected: true })).toBeVisible();
      const needsYou = group(page, "Needs You").locator(".assistant-work-row");
      await expect(needsYou).toHaveText([/Bump the Vite Group/]);
      await expect(needsYou).toContainText("Run pnpm install --frozen-lockfile");
      await expect(group(page, "Running").locator(".assistant-work-row")).toHaveText([/Fix the Flaky Upload Test/]);
      await expect(group(page, "Finished")).toHaveCount(0);
      // The approval is answered from the header, which stays beside the open panel; the panel's card
      // names it and opens its session, so the approval is offered once.
      await expect(waitingInHeader(page).getByRole("button", { name: "Approve Once" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Approve Once" })).toHaveCount(1);
      await expect(needsYou.getByRole("button", { name: "Approve Once" })).toHaveCount(0);
      await expectFullyInViewport(page.locator(".composer"), "Thread composer");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `assistant-launched-open-${theme}-desktop`);

      // Approving from the header moves the session to Running in the open panel.
      await waitingInHeader(page).getByRole("button", { name: "Approve Once" }).click();
      await expect(group(page, "Needs You")).toHaveCount(0);
      await expect(group(page, "Running").locator('[data-session-id="sess-deps"]')).toHaveCount(1);

      // The running session finishes: it moves to Finished, folded while other work is listed.
      await advance(page);
      const finished = group(page, "Finished");
      await expect(finished.getByRole("button", { name: /Finished/ })).toHaveAttribute("aria-expanded", "false");
      await expect(finished.locator(".assistant-work-row")).toHaveCount(0);
      await finished.getByRole("button", { name: /Finished/ }).click();
      await expect(finished.locator(".assistant-work-row")).toHaveText([/Fix the Flaky Upload Test/]);

      // The assistant launches more work; Work counts it at once.
      await page.evaluate(() => (window as unknown as { assistantsLaunch: () => void }).assistantsLaunch());
      await expect(panel(page).getByRole("tab", { name: "Work 3", exact: true })).toBeVisible({ timeout: 2_000 });
      await expect(group(page, "Running").locator('[data-session-id="sess-changelog"]')).toHaveCount(1);

      // A card opens its session. The session page has no Launched Sessions, so its panel shows
      // Session Tools, and going back to the thread finds Launched Sessions as it was left.
      await group(page, "Running").getByRole("button", { name: /Write the Changelog/ }).click();
      await expect(page).toHaveURL(/path=%2Fsessions%2F(~|%7E)/);
      await expect(panel(page)).toHaveCount(0);
      await expect(panel(page).locator('.session-tool[data-tool="launched"]')).toHaveCount(0);
      await page.goBack();
      await expect(launched(page)).toBeVisible();
      await expect(panel(page).getByRole("tab", { name: /^Work/, selected: true })).toBeVisible();
    });

    test("as on a session page, one bar holds Thread Actions and the Side Panel toggle, and the panel spans the side under it", async ({ page }) => {
      await open(page, theme);
      const bar = page.locator(".assistant-thread-bar");
      // Thread Settings is in Thread Actions, not a button of its own.
      await expect(page.getByRole("button", { name: "Thread Settings", exact: true })).toHaveCount(0);
      await bar.getByRole("button", { name: "Thread Actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Thread Settings" })).toBeVisible();
      await page.keyboard.press("Escape");
      // The Side Panel toggle follows Thread Actions at the bar's end, as the session bar's does.
      const sidePanel = bar.getByRole("button", { name: "Side Panel" });
      const [menuBox, toggleBox, barBox] = await Promise.all([
        bar.getByRole("button", { name: "Thread Actions" }).boundingBox(), sidePanel.boundingBox(), bar.boundingBox()]);
      expect(toggleBox!.x).toBeGreaterThan(menuBox!.x);
      expect(barBox!.x + barBox!.width - (toggleBox!.x + toggleBox!.width)).toBeLessThan(24);
      await expect(sidePanel).toHaveAttribute("aria-pressed", "false");
      await sidePanel.click();
      await expect(sidePanel).toHaveAttribute("aria-pressed", "true");
      await expect(panel(page)).toBeVisible();
      // The panel runs from under the bar to the bottom of the window, beside the column.
      const panelBox = (await panel(page).boundingBox())!;
      expect(Math.abs(panelBox.y - (barBox!.y + barBox!.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(panelBox.y + panelBox.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
      const waiting = (await page.locator(".assistant-thread-head").boundingBox())!;
      expect(waiting.x + waiting.width).toBeLessThanOrEqual(panelBox.x + 1);
      await sidePanel.click();
      await expect(panel(page)).toHaveCount(0);
      // The chord its tooltip names works here, as on a session page.
      await expect(sidePanel).toHaveAttribute("aria-keyshortcuts", /\\/);
      await page.locator(".assistant-thread-pane").click({ position: { x: 300, y: 600 } });
      await page.keyboard.press("Control+Backslash");
      await expect(sidePanel).toHaveAttribute("aria-pressed", "true");
      await expect(panel(page)).toBeVisible();
      await page.keyboard.press("Control+Backslash");
      await expect(sidePanel).toHaveAttribute("aria-pressed", "false");
      await expect(panel(page)).toHaveCount(0);
    });

    test("on a missing thread's placeholder the side panel's chords change nothing", async ({ page }) => {
      await page.clock.setFixedTime(FIXED_NOW);
      await page.goto(`/assistants-e2e.html?theme=${theme}&path=${encodeURIComponent("/assistants/~bgBvAHAAZQA")}`);
      await expect(page.getByRole("heading", { name: "Thread Not Found" })).toBeVisible();
      await page.keyboard.press("Control+Backslash");
      await expect(panel(page)).toHaveCount(0);
      // The preference the chord would have saved is untouched: a real thread still opens closed.
      await page.goto(`/assistants-e2e.html?theme=${theme}&path=${encodeURIComponent(TRIAGE_PATH)}`);
      await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      await expect(panel(page)).toHaveCount(0);
    });

    test("a focused card that changes group keeps focus in the panel", async ({ page }) => {
      await open(page, theme);
      await toggle(page).click();
      await group(page, "Running").getByRole("button", { name: /Fix the Flaky Upload Test/ }).focus();
      // The session finishes and its card moves into the folded Finished group.
      await advance(page);
      await expect(group(page, "Running")).toHaveCount(0);
      await expect(group(page, "Finished").getByRole("button", { name: /Finished/ })).toBeFocused();
    });

    test("answering one of two requests keeps focus on the card that still waits", async ({ page }) => {
      await open(page, theme, "deps=question");
      await waitingInHeader(page).getByRole("button", { name: "Approve Once" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("body")).toHaveAttribute("data-approved", "sess-deps:req-1:allow");
      const card = waitingInHeader(page).locator('[data-session-id="sess-deps"]');
      await expect(card).toContainText("Which lockfile should I keep?");
      await expect(card.getByRole("button", { name: "Open Session" })).toBeFocused();
    });

    test("the panel's open state is remembered on this device across a reload", async ({ page }) => {
      await open(page, theme);
      await toggle(page).click();
      await expect(launched(page)).toBeVisible();
      await page.reload();
      await expect(launched(page)).toBeVisible();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await toggle(page).click();
      await expect(panel(page)).toHaveCount(0);
      await page.reload();
      await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      await expect(panel(page)).toHaveCount(0);
    });

    test("with 42 launched sessions the conversation keeps its height and the panel scrolls on its own", async ({ page }) => {
      await open(page, theme, "launched=many");
      await expect(toggle(page)).toHaveAccessibleName("Show Side Panel, 1 Session Needs You");
      const head = page.locator(".assistant-thread-head");
      const closedHead = (await head.boundingBox())!.height;
      expect(closedHead, "the header holds no list of 42 cards").toBeLessThan(260);
      await expectFullyInViewport(page.locator(".composer"), "Thread composer");
      await capture(page, `assistant-launched-many-closed-${theme}-desktop`);

      await toggle(page).click();
      await expect(group(page, "Needs You").locator(".assistant-work-row")).toHaveText([/Bump the Vite Group/]);
      await expect(group(page, "Running").locator(".assistant-work-row")).toHaveCount(9);
      const finished = group(page, "Finished");
      await finished.getByRole("button", { name: /Finished/ }).click();
      await expect(finished.locator(".assistant-work-row")).toHaveCount(32);
      // Opening the panel leaves the header as it was.
      expect(Math.abs((await head.boundingBox())!.height - closedHead)).toBeLessThanOrEqual(1);
      const body = panel(page).getByRole("tabpanel", { name: /^Work/ });
      const scroll = await body.evaluate((element) => ({ overflow: element.scrollHeight - element.clientHeight }));
      expect(scroll.overflow, "the panel body scrolls its own list").toBeGreaterThan(0);
      // Reaching Finished scrolled the panel; the capture shows it from the top, Needs You first.
      await body.evaluate((element) => { element.scrollTop = 0; });
      // The page itself never scrolls; the composer stays where it was.
      expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(0);
      await expectFullyInViewport(page.locator(".composer"), "Thread composer");
      await capture(page, `assistant-launched-many-open-${theme}-desktop`);
      const last = finished.locator(".assistant-work-row").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await expectFullyInViewport(page.locator(".composer"), "Thread composer after scrolling the panel");
    });
  });

  test.describe(`${theme} at 390×844`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: theme, timezoneId: "UTC", locale: "en-US" });

    test("a phone keeps the waiting approval in the conversation and opens Launched Sessions as a full-screen sheet", async ({ page }) => {
      await open(page, theme);
      await expect(toggle(page)).toHaveAccessibleName("Show Side Panel, 1 Session Needs You");
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
      await expect(group(page, "Needs You")).toContainText("Run pnpm install --frozen-lockfile");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `assistant-launched-sheet-${theme}-mobile`);

      await panel(page).getByRole("button", { name: "Close Panel" }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(waitingInHeader(page).getByRole("button", { name: "Approve Once" })).toBeVisible();

      const sidePanel = page.locator(".detail-bar").getByRole("button", { name: "Side Panel" });
      await sidePanel.click();
      await expect(launched(page)).toBeVisible();
      await panel(page).getByRole("button", { name: "Close Panel" }).click();
      await expect(sidePanel).toHaveAttribute("aria-pressed", "false");
      await expect(sidePanel).toBeFocused();

      // A card in the sheet opens its session with the sheet out of the way.
      await toggle(page).click();
      await group(page, "Running").getByRole("button", { name: /Fix the Flaky Upload Test/ }).click();
      await expect(page).toHaveURL(/path=%2Fsessions%2F(~|%7E)/);
      await expect(panel(page)).toHaveCount(0);
    });

    test("a phone's sheet scrolls 42 launched sessions within itself", async ({ page }) => {
      await open(page, theme, "launched=many");
      await toggle(page).click();
      const finished = group(page, "Finished");
      await finished.getByRole("button", { name: /Finished/ }).click();
      const body = panel(page).getByRole("tabpanel", { name: /^Work/ });
      expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
      const last = finished.locator(".assistant-work-row").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `assistant-launched-many-sheet-${theme}-mobile`);
    });
  });

  test.describe(`${theme} at 1000×800`, () => {
    test.use({ viewport: { width: 1000, height: 800 }, colorScheme: theme, timezoneId: "UTC", locale: "en-US" });

    test("behind an overlaying panel the column's waiting approval is out of the tab order until it closes", async ({ page }) => {
      await open(page, theme);
      const approve = waitingInHeader(page).getByRole("button", { name: "Approve Once" });
      await toggle(page).click();
      await expect(panel(page)).toHaveAttribute("data-presentation", "overlay");
      await expect(page.locator(".detail-column-lead")).toHaveAttribute("inert", "");
      await approve.focus();
      await expect(approve).not.toBeFocused();
      await panel(page).getByRole("button", { name: "Close Panel" }).click();
      await expect(page.locator(".detail-column-lead")).not.toHaveAttribute("inert", "");
      await approve.focus();
      await expect(approve).toBeFocused();
    });

    test("Review closes an overlay and focuses the matching request in the thread", async ({ page }) => {
      await open(page, theme);
      await toggle(page).click();
      await expect(panel(page)).toHaveAttribute("data-presentation", "overlay");
      await group(page, "Needs You").getByRole("button", { name: "Review", exact: true }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(waitingInHeader(page).locator('[data-assistant-work-request="occ-deps-1"]')).toBeFocused();
      await expect(waitingInHeader(page).getByRole("button", { name: "Approve Once" })).toBeVisible();
    });
  });
}
