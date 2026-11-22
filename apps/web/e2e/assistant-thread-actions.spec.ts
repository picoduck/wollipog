import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import {
  expectFullyInViewport,
  expectNoHorizontalOverflow,
  expectPageNoHorizontalOverflow,
  expectTextContrast,
  expectTouchTargets,
} from "./layout-invariants.js";

const title = "Triage every open issue labelled flaky-test and fix what you can in the upload, terminal and session-list suites tonight";
const thread = viewPath({ name: "assistants", threadId: "thr_triage" });

async function checkSurface(surface: Locator) {
  await expectNoHorizontalOverflow(surface);
  await expectPageNoHorizontalOverflow(surface.page());
  await expectTextContrast(surface);
}

async function checkMenu(menu: Locator, phone: boolean, archived: boolean) {
  await expect(menu.locator(".menu-text, [role=separator]")).toHaveText(archived
    ? ["Thread Settings…", "Open as Session"]
    : ["Rename…", "Thread Settings…", "", "Open as Session", "", "Archive Thread…"]);
  const settings = menu.getByRole("menuitem", { name: "Thread Settings…", exact: true });
  const session = menu.getByRole("menuitem", { name: "Open as Session", exact: true });
  await expect(settings).toHaveAccessibleDescription("Account, harness, budget and delegation");
  await expect(session).toHaveAccessibleDescription("The full session view with Files and Terminal");
  await expect(settings.locator(".menu-desc")).toBeVisible();
  await expect(session.locator(".menu-desc")).toBeVisible();
  if (phone) {
    const heading = menu.locator(".menu-head-title");
    await expect(heading).toHaveText(title);
    await expect(heading).toHaveCSS("text-overflow", "ellipsis");
    await expect(heading).toHaveCSS("white-space", "nowrap");
    expect(await heading.evaluate((element) => element.scrollWidth > element.clientWidth), "The 120-character title truncates").toBe(true);
    expect((await heading.locator("..").boundingBox())!.height, "Menu sheet header height").toBe(48);
  } else {
    await expect(menu.locator(".menu-head")).toBeHidden();
  }

  const items = menu.getByRole("menuitem");
  for (const item of await items.all()) await expectFullyInViewport(item);
  const rows = await items.evaluateAll((elements) => elements.map((item) => {
    const { top, bottom, height, width } = item.getBoundingClientRect();
    return { top, bottom, height, width };
  }));
  for (const [index, row] of rows.entries()) {
    if (index > 0) expect(row.top, "Menu rows do not overlap").toBeGreaterThanOrEqual(rows[index - 1]!.bottom);
    expect(row.height, "Menu row meets the control height").toBeGreaterThanOrEqual(phone ? 44 : 32);
    expect(row.width, "Menu row meets the control width").toBeGreaterThanOrEqual(phone ? 44 : 32);
  }
  await checkSurface(menu);
}

async function capture(page: Page, theme: string, surface: string, state: string, phone: boolean) {
  if (process.env.ASSISTANT_ACTIONS_EVIDENCE !== "1") return;
  const { width, height } = page.viewportSize()!;
  const id = `4808-${surface}-${width}x${height}-${theme}-${state}${phone ? "-target44csspx" : ""}`;
  await page.screenshot({ path: join("playwright-report", "4808", id + ".png"), animations: "disabled" });
}

for (const theme of ["light", "dark"] as const) {
  for (const phone of [false, true]) {
    test.describe(`${theme} ${phone ? "phone" : "desktop"}`, () => {
      test.use({
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        colorScheme: theme, hasTouch: phone, isMobile: phone, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce",
      });

      test("Thread Actions shows the active and archived choices and confirms archive", async ({ page }) => {
        await page.clock.setFixedTime(Date.UTC(2026, 10, 20, 17));
        await page.goto(`/assistants-e2e.html?theme=${theme}&accounts=stress&launched=many&limits=enabled&path=${encodeURIComponent(thread)}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(phone);
        const bar = page.locator(".assistant-thread-bar, .page > .detail-bar");
        const toggle = bar.getByRole("button", { name: "Thread Actions", exact: true });
        const menu = page.getByRole("menu", { name: "Thread Actions" });
        const surface = phone ? "phone-sheet" : "desktop-menu";

        await toggle.click();
        await menu.getByRole("menuitem", { name: "Rename…", exact: true }).click();
        const rename = page.getByRole("dialog", { name: "Rename Thread" });
        expect(title).toHaveLength(120);
        await rename.getByRole("textbox", { name: "Title" }).fill(title);
        await rename.getByRole("button", { name: "Rename", exact: true }).click();
        await expect(bar.locator(".detail-bar-title")).toHaveText(title);
        expect((await bar.boundingBox())!.height, "Thread bar height").toBe(48);
        if (phone) await expectTouchTargets(bar);
        await expectFullyInViewport(page.locator(".composer"), "The active thread composer");

        await toggle.click();
        await checkMenu(menu, phone, false);
        await capture(page, theme, surface, "active", phone);
        const archive = menu.getByRole("menuitem", { name: "Archive Thread…", exact: true });
        await archive.click();
        const confirm = page.getByRole("dialog", { name: "Archive Thread", exact: true });
        await expect(confirm).toContainText(`“${title}” leaves the thread list. Its session and transcript are kept.`);
        const cancel = confirm.getByRole("button", { name: "Cancel", exact: true });
        const confirmArchive = confirm.getByRole("button", { name: "Archive Thread", exact: true });
        await expect(cancel).toBeFocused();
        await expectFullyInViewport(cancel);
        await expectFullyInViewport(confirmArchive);
        await checkSurface(confirm);
        if (phone) await expectTouchTargets(confirm);
        await capture(page, theme, "archive-confirmation", "active", phone);
        if (phone) {
          await confirm.getByRole("button", { name: "Back to Thread Actions", exact: true }).click();
          await expect(archive).toBeFocused();
        } else {
          await cancel.click();
          await expect(toggle).toBeFocused();
          await toggle.click();
        }
        await archive.click();
        await confirmArchive.click();
        await expect(confirm).toHaveCount(0);
        await expect(page.locator("[data-thread-id=thr_triage]")).toHaveCount(0);
        // Open the archived deep link within this fixture so it keeps the rename and archive.
        await page.evaluate((path) => {
          const url = new URL(location.href);
          url.searchParams.set("path", path);
          history.pushState(null, "", url);
          dispatchEvent(new PopStateEvent("popstate"));
        }, thread);
        await expect(bar.locator(".detail-bar-title")).toHaveText(title);
        await expect(bar.locator(".status")).toHaveText("Archived");
        await toggle.click();
        await checkMenu(menu, phone, true);
        await capture(page, theme, surface, "archived", phone);

        await menu.getByRole("menuitem", { name: "Thread Settings…", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "Thread Settings" });
        await expect(settings).toContainText("Archived threads are read-only.");
        await expect(settings.getByRole("button", { name: "Save Changes" })).toBeDisabled();
        await expect(settings.getByRole("button", { name: "Change… Account" })).toBeDisabled();
        await settings.getByRole("button", { name: "Cancel", exact: true }).click();
        await toggle.click();
        await menu.getByRole("menuitem", { name: "Open as Session", exact: true }).click();
        const session = viewPath({ name: "session", id: "sess-triage" });
        await expect.poll(() => new URL(page.url()).searchParams.get("path")).toBe(session);
        await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      });
    });
  }
}
