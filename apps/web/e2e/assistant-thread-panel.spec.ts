import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectTextContrast, expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const THREAD_PATH = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const LONG_ACCOUNT = "DesignResearchAndEngineeringSubscriptionForLongRunningProjectsAcrossTheEntireNorthAmericanWorkspace";
const PANEL_PREFERENCE = "wollipog.assistant-panel";
const CHORD = "Control+Backslash";
const panel = (page: Page) => page.locator("#right-panel");
const toggle = (page: Page) => page.getByRole("button", { name: /Side Panel/ });
const tab = (page: Page, name: string) => panel(page).getByRole("tab", { name: new RegExp("^" + name) });
const body = (page: Page, name: string) => panel(page).getByRole("tabpanel", { name: new RegExp("^" + name) });

function fixture(theme: string, scenario = "delegated", extra = "") {
  return "/assistants-e2e.html?theme=" + theme + "&threads=long&launched=many&accounts=stress&thread-panel=" +
    scenario + "&path=" + encodeURIComponent(THREAD_PATH) + extra;
}

async function open(page: Page, theme: string, scenario?: string) {
  await page.clock.setFixedTime(Date.UTC(2026, 10, 20, 17));
  await page.goto(fixture(theme, scenario));
  await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function capture(page: Page, theme: string, surface: string, state: string) {
  await expectPageNoHorizontalOverflow(page);
  if (process.env.ASSISTANT_PANEL_EVIDENCE !== "1") return;
  const { width, height } = page.viewportSize()!;
  const id = "4799-" + surface + "-" + width + "x" + height + "-" + theme + "-" + state;
  await page.screenshot({ path: join("playwright-report", "4799", id + ".png"), animations: "disabled" });
}

/** Measure control boxes and, where used, the shared coarse-pointer hit-area pseudo-element. */
async function expectTouchTargets(container: Locator) {
  const targets = await container.evaluate((root) => {
    return [...root.querySelectorAll("button:not(:disabled), input:not(:disabled)")].flatMap((control) => {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const after = getComputedStyle(control, "::after");
      const expand = after.content !== "none" && after.pointerEvents !== "none" && after.position === "absolute";
      const negative = (value: string) => expand ? Math.min(0, parseFloat(value) || 0) : 0;
      return [{
        name: control.getAttribute("aria-label") || control.textContent?.trim() || control.tagName,
        left: rect.left + negative(after.left),
        right: rect.right - negative(after.right),
        top: rect.top + negative(after.top),
        bottom: rect.bottom - negative(after.bottom),
      }];
    });
  });
  for (const target of targets) {
    expect(target.right - target.left, target.name + " hit width in CSS px").toBeGreaterThanOrEqual(44);
    expect(target.bottom - target.top, target.name + " hit height in CSS px").toBeGreaterThanOrEqual(44);
  }
  for (const [index, first] of targets.entries()) {
    for (const second of targets.slice(index + 1)) {
      const width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
      const height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
      expect(width > 0.5 && height > 0.5, first.name + " overlaps " + second.name).toBe(false);
    }
  }
}

async function checkPanel(page: Page, phone: boolean) {
  expect((await panel(page).locator(".rpanel-head").boundingBox())!.height).toBe(48);
  await expectNoHorizontalOverflow(panel(page), "Thread panel");
  await expectTextContrast(panel(page));
  if (phone) await expectTouchTargets(panel(page));
}

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const phone = width === 390;
    test.describe(theme + " at " + width + "×" + height, () => {
      test.use({ viewport: { width, height }, hasTouch: phone, isMobile: phone, colorScheme: theme, timezoneId: "UTC", locale: "en-US" });
      test("first visit, 42 flat work rows and three tabs preserve the conversation", async ({ page }) => {
        await open(page, theme);
        await expect(panel(page)).toHaveCount(0);
        const composer = page.locator(".composer");
        await expectFullyInViewport(composer, "Composer on the first visit");
        const conversation = page.locator(".detail-body");
        const initialHeight = (await conversation.boundingBox())!.height;
        await capture(page, theme, "panel", "first-visit-hidden");

        await toggle(page).click();
        await expect(panel(page).getByRole("tab")).toHaveText([/Work 42/, /Decisions/, "Details"]);
        await expect(panel(page).locator(".rpanel-switcher")).toHaveCount(0);
        await expect(panel(page)).toHaveAttribute("data-presentation", phone ? "sheet" : "docked");
        expect((await conversation.boundingBox())!.height).toBe(initialHeight);
        if (phone) {
          const box = (await panel(page).boundingBox())!;
          const nav = (await page.getByRole("navigation", { name: "Primary Navigation" }).boundingBox())!;
          expect([box.x, box.y, box.width, box.y + box.height]).toEqual([0, 0, width, nav.y]);
        } else {
          await expectFullyInViewport(composer, "Composer beside Work");
        }

        const work = body(page, "Work");
        const filter = work.getByRole("searchbox", { name: "Filter Launched Work" });
        await expectFullyInViewport(filter, "Filter after more than ten launches");
        expect(await work.locator(".launched-sessions-group").evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label"))))
          .toEqual(["Needs You", "Running", "Finished"]);
        const review = work.getByRole("button", { name: "Review", exact: true });
        await expectFullyInViewport(review, "Review on the request row");
        await expect(work.getByRole("region", { name: "Running", exact: true }).locator(".assistant-work-row")).toHaveCount(9);
        const finished = work.getByRole("button", { name: /Finished.*32.*4 Failed/ });
        await expect(finished).toHaveAttribute("aria-expanded", "false");
        await expectFullyInViewport(finished, "Finished fold and failed count");
        const longTitle = work.locator('.assistant-work-row[data-session-id="sess-many-40"] .assistant-work-title');
        await expect(longTitle).toHaveCSS("text-overflow", "ellipsis");
        expect(await longTitle.evaluate((label) => label.scrollWidth)).toBeGreaterThan(await longTitle.evaluate((label) => label.clientWidth));
        await checkPanel(page, phone);
        await capture(page, theme, "panel-work", phone ? "42sessions-sheet-target44csspx" : "42sessions-docked");
        await finished.click();
        await expect(work.getByRole("region", { name: "Finished" }).locator(".assistant-work-row")).toHaveCount(32);
        await filter.fill("Package 7 ·");
        await expect(work.locator(".assistant-work-row")).toHaveCount(1);
        await expect(work.locator(".assistant-work-row")).toHaveAttribute("data-session-id", "sess-many-7");
        await filter.clear();
        await review.click();
        await expect(page.locator('[data-assistant-work-request="occ-deps-1"]')).toBeFocused();
        if (phone) await expect(panel(page)).toHaveCount(0);
        else await expect(panel(page)).toBeVisible();
      });

      test("Decisions, Details and persistence", async ({ page }) => {
        await open(page, theme);
        await toggle(page).click();
        await tab(page, "Decisions").click();
        const decisions = body(page, "Decisions");
        await expect(tab(page, "Decisions")).toHaveText("Decisions 24");
        await expect(decisions).toContainText("Delegate All");
        await expect(decisions).toContainText("Active · Expires");
        await expect(decisions.getByRole("button", { name: "Manage…" })).toBeVisible();
        await expect(decisions.getByRole("list", { name: "Delegated Decisions" }).getByRole("listitem")).toHaveCount(5);
        await checkPanel(page, phone);
        await capture(page, theme, "panel-decisions", "delegated");

        await tab(page, "Details").click();
        const details = body(page, "Details");
        await expect(details).toContainText("Full access. Asks before destructive actions.");
        await expect(details).toContainText("Claude Code");
        await expect(details.getByRole("meter", { name: "Budget" })).toHaveAttribute("aria-valuenow", "8.13");
        await expect(details.getByRole("meter", { name: "Session Launches" })).toHaveAttribute("aria-valuenow", "42");
        await expect(details.getByRole("button", { name: "Thread Settings…" })).toBeVisible();
        await expect(details.getByRole("button", { name: /^Open Earlier Conversation/ })).toBeVisible();
        await expect(details.getByText(LONG_ACCOUNT, { exact: true })).toHaveCount(0);
        await details.getByRole("button", { name: "Show Account" }).click();
        await expect(details.getByText(LONG_ACCOUNT, { exact: true })).toBeVisible();
        await checkPanel(page, phone);
        await expect(page.locator(".assistant-thread-bar, .page > .detail-bar")).not.toContainText("Full access.");
        await capture(page, theme, "panel-details", "long-account");
        await page.reload();
        await expect(body(page, "Details")).toBeVisible();
        await expect(body(page, "Details").getByText(LONG_ACCOUNT, { exact: true })).toHaveCount(0);
        await page.keyboard.press(CHORD);
        await expect(panel(page)).toHaveCount(0);
        await page.reload();
        await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
        await page.keyboard.press(CHORD);
        await expect(body(page, "Details")).toBeVisible();

        await open(page, theme, "not-delegated");
        await tab(page, "Decisions").click();
        await expect(tab(page, "Decisions")).toHaveText("Decisions 0");
        await expect(decisions).toContainText("Not Delegated");
        await expect(decisions).toContainText("No delegated decisions yet.");
        await expect(decisions.getByRole("button", { name: "Delegate…" })).toBeVisible();
        await checkPanel(page, phone);
        await capture(page, theme, "panel-decisions", "not-delegated");
        await decisions.getByRole("button", { name: "Delegate…" }).click();
        await expect(page.getByRole("dialog", { name: "Decision Delegation" })).toBeVisible();
      });

      test("the thread shortcut reference and the session tool frame have separate content", async ({ page }) => {
        await open(page, theme);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press("Shift+Slash");
        const shortcuts = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
        const group = shortcuts.getByRole("region", { name: /^Assistant Thread/ });
        await expect(group.locator("dt")).toHaveText(["Steer Active Turn", "Stop Turn", "Side Panel"]);
        await expect(group.locator(".is-unavailable")).toHaveCount(0);
        await expect(group).toContainText("While the assistant is working, sends your message into its current turn.");
        await expect(group).toContainText("Stops the assistant's current turn. Sessions it launched keep running.");
        await expect(shortcuts.getByText("Session tools are available after Open as Session.")).toBeAttached();
        await capture(page, theme, "keyboard-shortcuts", "assistant-thread");

        await shortcuts.getByRole("button", { name: "Done" }).click();
        await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Open as Session", exact: true }).click();
        await expect(panel(page)).toHaveCount(0);
        await page.keyboard.press(CHORD);
        await expect(panel(page).locator(".rpanel-switcher-name")).toHaveText("Session Tools");
        await expect(panel(page).getByRole("tab", { name: "Work", exact: true })).toHaveCount(0);
        await capture(page, theme, "session-panel", "session-tools");
      });
    });
  }

  test.describe(theme + " at 1024×768", () => {
    test.use({ viewport: { width: 1024, height: 768 }, colorScheme: theme });
    test("Work overlays when the conversation would have less than 480px beside it", async ({ page }) => {
      await open(page, theme);
      await toggle(page).click();
      await expect(panel(page)).toHaveAttribute("data-presentation", "overlay");
      await expect(page.locator(".detail-body")).toHaveAttribute("inert", "");
      await checkPanel(page, false);
      await capture(page, theme, "panel-work", "42sessions-overlay");
    });
  });
}

test("the shortcut never writes the saved panel preference while the thread is loading", async ({ page }) => {
  await page.addInitScript(({ key, saved }) => {
    localStorage.setItem(key, saved);
    const setItem = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) document.documentElement.dataset.threadPanelWrites = String(++writes);
      setItem.call(this, name, value);
    };
  }, { key: PANEL_PREFERENCE, saved: JSON.stringify({ open: true, tab: "Details" }) });
  await page.goto(fixture("light", "delegated", "&hold-initial-list=1"));
  await expect(page.getByText("Loading the thread…")).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-list-held", "true");
  await page.keyboard.press(CHORD);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-thread-panel-writes");
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), PANEL_PREFERENCE))
    .toEqual({ open: true, tab: "Details" });
  await page.evaluate(() => Reflect.get(window, "assistantsReleaseList")());
  await expect(body(page, "Details")).toBeVisible();
  await page.keyboard.press(CHORD);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-thread-panel-writes", "1");
});

