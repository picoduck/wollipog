import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import {
  expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast, expectTouchTargets,
} from "./layout-invariants.js";

const path = viewPath({ name: "assistants", threadId: "thr_triage" });
const fixture = "threads=long&launched=many&accounts=stress&thread-panel=delegated&limits=enabled&dock=tool&dockCount=3&spending=over";
const controls = 'button, a[href], [role="menuitem"], [role="tab"], textarea, select, ' +
  'input:not([type="checkbox"], [type="radio"], [type="file"]), label:has(input:is([type="checkbox"], [type="radio"]))';

async function surface(root: Locator) {
  await expectNoHorizontalOverflow(root);
  await expectPageNoHorizontalOverflow(root.page());
  await expectTextContrast(root);
  if (root.page().viewportSize()?.width === 390) await expectTouchTargets(root, controls);
}

async function capture(page: Page, theme: string, view: string, state: string) {
  if (process.env.ASSISTANT_PHONE_EVIDENCE !== "1") return;
  const { width, height } = page.viewportSize()!;
  const id = [view, width + "x" + height, theme, state, ...(width === 390 ? ["target44csspx"] : [])].join("-");
  await page.screenshot({ path: join("playwright-report", "4818", id + ".png"), animations: "disabled" });
}

async function open(page: Page, theme: string, extra = "") {
  await page.clock.setFixedTime(Date.UTC(2026, 10, 20, 17));
  await page.goto("/assistants-e2e.html?theme=" + theme + "&" + fixture + extra + "&path=" + encodeURIComponent(path));
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const dock = page.getByRole("list", { name: "Pending Requests" });
  await expect(page.locator(".assistant-dock-pager")).toContainText("1 of 3");
  await expect(dock.getByRole("listitem")).toHaveCount(1);
  const notices = page.locator(".composer .session-notice-slot .notice");
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText("Over Budget");
  return dock;
}

async function checkEditor(dialog: Locator, saveLabel: string) {
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const { x, y, width, height } = (await dialog.boundingBox())!;
    return [x, y, width, height];
  }).toEqual([0, 0, 390, 844]);
  await expectFullyInViewport(dialog.locator(".modal-head").getByRole("button", { name: saveLabel }));
  await surface(dialog);
}

for (const theme of ["light", "dark"] as const) {
  for (const phone of [true, false]) {
    test.describe(theme + (phone ? " phone" : " desktop"), () => {
      test.use({
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        colorScheme: theme, isMobile: phone, hasTouch: phone, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
      });

      test("the first message and approval pair fit with three requests and a notice", async ({ page }) => {
        const dock = await open(page, theme);
        const bar = page.locator(phone ? ".page > .detail-bar" : ".assistant-thread-bar");
        await expect(bar.getByRole("button")).toHaveCount(phone ? 4 : 3);
        await expect(bar.getByRole("button", { name: "Back to Assistants" })).toHaveCount(phone ? 1 : 0);
        await expect(bar.getByRole("button", { name: /Side Panel/ })).toBeVisible();
        await expect(bar.getByRole("button", { name: "Thread Actions" })).toBeVisible();
        const title = bar.locator(".detail-bar-title");
        expect(await title.textContent()).toHaveLength(120);
        await expect(title).toHaveCSS("text-overflow", "ellipsis");
        await expect(bar.locator(".status")).toHaveText("Over Budget");
        const message = page.getByText("Last night's CI had two failures. Find out why and fix what you can.", { exact: true });
        const reader = page.getByRole("region", { name: "Session Activity", exact: true });
        await expectFullyInViewport(message);
        const messageBox = (await message.boundingBox())!;
        const readerBox = (await reader.boundingBox())!;
        const barBox = (await bar.boundingBox())!;
        expect(messageBox.y).toBeGreaterThanOrEqual(Math.max(readerBox.y, barBox.y + barBox.height));
        expect(messageBox.y + messageBox.height).toBeLessThanOrEqual(readerBox.y + readerBox.height);
        const actions = dock.locator(".assistant-dock-actions");
        await expect(actions.getByRole("button")).toHaveText(["Open Session", "Deny", "Approve Once"]);
        await expect(actions.locator(".primary")).toHaveText("Approve Once");
        const deny = actions.getByRole("button", { name: "Deny", exact: true });
        const approve = actions.getByRole("button", { name: "Approve Once" });
        await expectFullyInViewport(deny);
        await expectFullyInViewport(approve);
        if (phone) expect((await deny.boundingBox())!.width).toBeCloseTo((await approve.boundingBox())!.width, 1);
        await surface(bar);
        await surface(page.locator(".detail-body"));
        await capture(page, theme, "thread", "title120-three-requests-one-notice");
        if (phone) {
          const notice = page.locator(".assistant-spending-notice");
          await notice.getByRole("button", { name: "Show Details" }).tap();
          await expectFullyInViewport(notice.getByText(/Sessions this thread launched kept running/));
          await expectFullyInViewport(notice.getByRole("meter", { name: "Budget" }));
          await expectFullyInViewport(approve);
          await notice.getByRole("button", { name: "Hide Details" }).tap();
          const requestBody = dock.locator(".assistant-dock-card-body");
          expect(await requestBody.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
          await requestBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
          await expect(dock.locator(".assistant-dock-scroll-cue")).toBeHidden();
          await expectFullyInViewport(approve);
        } else {
          await expect(page.locator(".assistant-spending-notice .notice-trailing")).toBeHidden();
        }
      });

      if (!phone) return;

      test("a compact notice still explains why launched sessions cannot be stopped", async ({ page }) => {
        await open(page, theme, "&no-running-launches");
        const notice = page.locator(".assistant-spending-notice");
        await expect(notice.getByRole("button", { name: "Show Details" })).toHaveAttribute("aria-expanded", "false");
        const stop = notice.getByRole("button", { name: "Stop Launched Sessions…" });
        await expect(stop).toBeDisabled();
        await expect(stop).toHaveAccessibleDescription("There are no running sessions to stop.");
        await expectFullyInViewport(notice.getByText("There are no running sessions to stop."));
      });

      test("thread sheets keep their controls, heading and Save in reach", async ({ page }) => {
        await open(page, theme);
        await page.getByRole("button", { name: /Side Panel/ }).tap();
        const panel = page.getByRole("complementary", { name: "Side Panel" });
        await expect(panel).toHaveAttribute("data-presentation", "sheet");
        await expect(panel.getByRole("tab")).toHaveText([/Work 42/, /Decisions/, "Details"]);
        const nav = page.getByRole("navigation", { name: "Primary Navigation" });
        const { x, y, width, height } = (await panel.boundingBox())!;
        expect([x, y, width, height]).toEqual([0, 0, 390, (await nav.boundingBox())!.y]);
        await surface(panel);
        await capture(page, theme, "side-panel", "work-42-sessions");
        await panel.getByRole("tab", { name: /^Decisions/ }).tap();
        await surface(panel);
        await panel.getByRole("tabpanel", { name: /^Decisions/ }).getByRole("button", { name: "Manage…" }).tap();
        const delegation = page.getByRole("dialog", { name: "Decision Delegation" });
        await checkEditor(delegation, "Save Delegation");
        await capture(page, theme, "decision-delegation", "active-grant");
        await page.keyboard.press("Escape");
        await expect(delegation).toHaveCount(0);
        await panel.getByRole("tab", { name: "Details" }).tap();
        await surface(panel);
        await panel.getByRole("button", { name: "Close Panel" }).tap();

        await page.getByRole("button", { name: "Thread Actions" }).tap();
        const menu = page.getByRole("menu", { name: "Thread Actions" });
        await expect(menu.locator(".menu-head-title")).toHaveText(await page.locator(".page > .detail-bar .detail-bar-title").textContent() ?? "");
        await surface(menu);
        await capture(page, theme, "thread-actions", "title120");
        await menu.getByRole("menuitem", { name: "Thread Settings…" }).tap();
        const settings = page.getByRole("dialog", { name: "Thread Settings" });
        await checkEditor(settings, "Save Changes");
        await capture(page, theme, "thread-settings", "conversation-and-spending");
      });

      test("composer and dock actions clear the software keyboard", async ({ page }) => {
        // Model visual-viewport-only resize, keeping layout pixels at 390×844.
        await page.addInitScript(() => {
          let height = innerHeight;
          const viewport = visualViewport!;
          Object.defineProperty(viewport, "height", { get: () => height });
          document.addEventListener("simulate-keyboard", () => {
            height = 528;
            viewport.dispatchEvent(new Event("resize"));
          });
        });
        const dock = await open(page, theme);
        const composer = page.locator(".composer");
        const input = composer.locator("textarea.composer-input");
        if (!await input.isVisible()) await composer.locator(".composer-box").tap();
        await input.tap();
        await input.fill("Check the next release.");
        await expect(input).toBeFocused();
        await page.evaluate(() => document.dispatchEvent(new Event("simulate-keyboard")));
        await expect(page.locator("html")).toHaveCSS("--keyboard-inset", "316px");
        await page.evaluate(() => window.dispatchEvent(new Event("assistants-fixture-toast")));
        const toast = page.locator(".toast").filter({ hasText: "Thread settings saved." });
        const targets = [
          input, composer.getByRole("button", { name: "Send", exact: true }),
          dock.getByRole("button", { name: "Deny", exact: true }), dock.getByRole("button", { name: "Approve Once" }),
        ];
        for (const target of targets) {
          await expect(target).toBeInViewport({ ratio: 1 });
          const { y, height } = (await target.boundingBox())!;
          expect(y + height).toBeLessThanOrEqual(528);
        }
        await expectFullyInViewport(composer.locator(".assistant-spending-notice"));
        await expectFullyInViewport(toast);
        const bar = (await page.locator(".page > .detail-bar").boundingBox())!;
        expect((await toast.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
        await expect.poll(async () => {
          const box = (await toast.boundingBox())!;
          return box.y + box.height;
        }).toBeLessThanOrEqual(Math.min((await composer.boundingBox())!.y, (await page.locator(".assistant-dock").boundingBox())!.y));
        await surface(composer);
        await surface(dock);
        if (process.env.ASSISTANT_PHONE_EVIDENCE === "1") {
          await page.evaluate(() => {
            const marker = document.createElement("div");
            marker.textContent = "Simulated software keyboard";
            marker.style.cssText = "position:fixed;inset:528px 0 0;z-index:9999;background:var(--bg-elev-2);color:var(--text);display:grid;place-items:center";
            document.body.append(marker);
          });
          await capture(page, theme, "thread", "keyboard-open");
        }
      });
    });
  }
}
