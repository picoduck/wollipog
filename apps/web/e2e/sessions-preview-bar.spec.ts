import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #2210: the Sessions preview's detail bar, the request at the top of the preview, and the preview
 * aligned to the page. The fixture seeds a blocked session (three permission requests and
 * background work), a running one, an idle one and one whose machine is offline.
 */

const FIXTURE = "/command-inbox-projects-e2e.html?scenario=preview-bar&fullShell=1&reminders=1";
const BLOCKED = "Migrate the Billing Tables to the New Schema and Verify Every Row Count";
const OFFLINE = "Profile the Nightly Build";
const IDLE = "Draft the Quarterly Report";

async function open(page: Page): Promise<void> {
  await page.goto(FIXTURE);
  await page.evaluate(() => localStorage.clear());
  await page.goto(FIXTURE);
  await expect(page.locator(".inbox-row").first()).toBeVisible();
}

async function select(page: Page, title: string): Promise<Locator> {
  await page.locator(".inbox-row").filter({ hasText: title }).click();
  const bar = page.locator(".session-detail.preview header.session-preview-bar");
  await expect(bar.locator(".detail-bar-title")).toHaveText(title);
  return bar;
}

type Box = { left: number; top: number; right: number; bottom: number };

function overlaps(a: Box, b: Box): boolean {
  // Touching edges are not an overlap; half a pixel of rounding is allowed either way.
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

for (const viewport of [
  { name: "touch tablet", width: 834, height: 1112, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false },
]) {
  test.describe(`at ${viewport.width}×${viewport.height} (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch });

    test("the preview bar is one 48px row and its status overlaps nothing", async ({ page }) => {
      await open(page);
      for (const title of [BLOCKED, OFFLINE]) {
        const bar = await select(page, title);
        const geometry = await bar.evaluate((element) => {
          const box = (node: Element) => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          };
          const barH = Number.parseFloat(getComputedStyle(element).getPropertyValue("--bar-h"));
          const status = element.querySelector(".detail-bar-status")!;
          const others = [
            element.querySelector(".detail-bar-title")!,
            ...element.querySelectorAll(".detail-bar-actions > *"),
          ];
          return {
            barH,
            bar: box(element),
            status: box(status),
            badges: element.querySelectorAll(".status").length,
            others: others.map(box),
          };
        });
        expectGeometry(Math.abs(geometry.bar.bottom - geometry.bar.top - geometry.barH), `${title}: the bar is --bar-h tall`)
          .toBeLessThanOrEqual(0.61);
        expect(geometry.badges, `${title}: one status badge`).toBe(1);
        for (const item of [geometry.status, ...geometry.others]) {
          expectGeometry(geometry.bar.top - item.top, `${title}: every item sits inside the one row`).toBeLessThanOrEqual(0.61);
          expectGeometry(item.bottom - geometry.bar.bottom, `${title}: every item sits inside the one row`).toBeLessThanOrEqual(0.61);
        }
        for (const other of geometry.others) {
          expect(overlaps(geometry.status, other), `${title}: the status overlaps nothing`).toBe(false);
        }
      }
    });

    test("Open Session opens the session, and its Enter keycap shows on fine pointers only", async ({ page }) => {
      await open(page);
      const bar = await select(page, IDLE);
      const openSession = bar.getByRole("button", { name: "Open Session", exact: true });
      await expect(openSession).toBeVisible();
      if (viewport.touch) await expect(openSession.locator("kbd")).toBeHidden();
      else await expect(openSession.locator("kbd")).toHaveText("Enter");
      // At compact widths Snooze and Archive stay icon buttons; Open Session keeps its label.
      await expect(bar.getByRole("button", { name: "Snooze", exact: true })).toHaveClass("icon-btn");
      await expect(bar.getByRole("button", { name: /^Archive/ })).toHaveClass("icon-btn");
      await openSession.click();
      await expect(page.locator(".session-detail.expanded")).toBeVisible();
      await expect(page.locator(".session-detail.preview")).toHaveCount(0);
    });
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Enter from the list opens the selected session", async ({ page }) => {
    await open(page);
    await select(page, IDLE);
    await page.keyboard.press("Enter");
    await expect(page.locator(".session-detail.expanded")).toBeVisible();
    await expect(page.locator(".session-detail.expanded .detail-bar-title")).toHaveText(IDLE);
  });

  test("the request card heads the preview, A approves it from the list, and it never exceeds half the preview", async ({ page }) => {
    await open(page);
    await select(page, BLOCKED);
    const preview = page.locator(".session-detail.preview");
    const slot = preview.locator(".detail-chat > .session-notice-slot");
    const title = slot.locator(".request-card-title");
    await expect(title).toHaveText("Run the Migration Script");
    await expect(slot.locator(".request-dock-more")).toContainText("+2 More Requests");

    const geometry = await preview.evaluate((element) => {
      const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      const body = element.querySelector<HTMLElement>(".request-card-body")!;
      return {
        pane: element.getBoundingClientRect().height,
        facts: rect(".session-preview-facts").bottom,
        slotTop: rect(".detail-chat > .session-notice-slot").top,
        slot: rect(".detail-chat > .session-notice-slot").height,
        reader: rect(".detail-chat > .chat-reading").top,
        bodyScrolls: body.scrollHeight > body.clientHeight + 1 && getComputedStyle(body).overflowY !== "visible",
      };
    });
    expectGeometry(Math.abs(geometry.slotTop - geometry.facts), "the request sits right under the meta line").toBeLessThanOrEqual(0.61);
    expectGeometry(geometry.slotTop + geometry.slot - geometry.reader, "the transcript starts below the request").toBeLessThanOrEqual(0.61);
    expectGeometry(geometry.slot - geometry.pane / 2, "the request never exceeds half the preview").toBeLessThanOrEqual(0.61);
    expect(geometry.bodyScrolls, "the long command scrolls inside the card").toBe(true);

    // Focus stays in the list: A approves the request in view and the next one comes up.
    await expect(page.locator(".inbox-preview-pane")).not.toContainText("Approve Request");
    await page.keyboard.press("a");
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.approvalRequests().map((request) => request.requestId))).toEqual(["request-migrate"]);
    await expect(title).toHaveText("Vacuum the Billing Database");
    await expect(slot.locator(".request-dock-more")).toContainText("+1 More Request");
    await expect(page.locator('[role="row"][aria-selected="true"]')).toContainText(BLOCKED);
  });

  test("in a short preview the request scrolls whole, so its command never shrinks away", async ({ page }) => {
    await open(page);
    await select(page, BLOCKED);
    await page.getByRole("separator", { name: "Resize List and Preview" }).focus();
    await page.keyboard.press("End");
    const preview = page.locator(".session-detail.preview");
    await expect.poll(() => preview.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(400);
    const geometry = await preview.evaluate((element) => {
      const slot = element.querySelector<HTMLElement>(".detail-chat > .session-notice-slot")!;
      const body = element.querySelector<HTMLElement>(".request-card-body")!;
      return {
        pane: element.getBoundingClientRect().height,
        slot: slot.getBoundingClientRect().height,
        dockScrolls: (({ scrollHeight, clientHeight }) => scrollHeight > clientHeight + 1)(slot.querySelector<HTMLElement>(".request-dock")!),
        bodyClipped: body.scrollHeight - body.clientHeight,
        body: body.getBoundingClientRect().height,
      };
    });
    expectGeometry(geometry.slot - geometry.pane / 2, "the request still takes at most half the preview").toBeLessThanOrEqual(0.61);
    expect(geometry.dockScrolls, "the dock scrolls the whole card").toBe(true);
    expectGeometry(geometry.bodyClipped, "the command keeps its natural height").toBeLessThanOrEqual(0.61);
    expect(geometry.body, "the command is not squeezed to nothing").toBeGreaterThan(40);
  });

  test("the title, the meta line and the first transcript turn share the page title's left edge", async ({ page }) => {
    await open(page);
    await select(page, IDLE);
    await expect(page.locator(".session-detail.preview .detail-scroll .tl-row").first()).toBeVisible();
    const lefts = await page.evaluate(() => {
      const left = (element: Element | null | undefined) => element?.getBoundingClientRect().left ?? Number.NaN;
      const scroll = document.querySelector(".session-detail.preview .detail-scroll")!;
      const scrollTop = scroll.getBoundingClientRect().top;
      const firstTurn = [...scroll.querySelectorAll(".tl-row")].find((row) => row.getBoundingClientRect().bottom > scrollTop);
      return {
        page: left(document.getElementById("page-title")),
        title: left(document.querySelector(".session-preview-bar .detail-bar-title")),
        meta: left(document.querySelector(".session-preview-facts > li")),
        turn: left(firstTurn),
        turnWidth: firstTurn?.getBoundingClientRect().width ?? Number.NaN,
        chatMax: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chat-max")),
      };
    });
    for (const [name, value] of Object.entries({ title: lefts.title, "meta line": lefts.meta, "first turn": lefts.turn })) {
      expectGeometry(Math.abs(value - lefts.page), `the preview's ${name} starts at the page title's left edge`).toBeLessThanOrEqual(0.61);
    }
    expectGeometry(lefts.turnWidth - lefts.chatMax, "the reading column is at most --chat-max wide").toBeLessThanOrEqual(0.61);
  });

  test("the preview shows no follow status or paging hints, and Jump to Latest only away from the latest turn", async ({ page }) => {
    await open(page);
    await select(page, IDLE);
    const preview = page.locator(".session-detail.preview");
    await expect(preview.locator(".detail-scroll .tl-row").first()).toBeVisible();
    await expect(preview).not.toContainText(/Following|Page Up|Shift\+Space/);
    const jump = preview.locator(".transcript-tail-control");
    await expect(jump).toHaveCount(0);
    await preview.locator(".detail-scroll").evaluate((scroll) => { scroll.scrollTop = 0; scroll.dispatchEvent(new Event("scroll")); });
    await preview.locator(".detail-scroll").hover();
    await page.mouse.wheel(0, -600);
    await expect(jump).toBeVisible();
    await expect(jump).toContainText("Jump to Latest");
  });

  test("⋯ opens the session's context menu", async ({ page }) => {
    await open(page);
    const bar = await select(page, IDLE);
    await bar.getByRole("button", { name: "More Actions", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Rename/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bar.getByRole("button", { name: "More Actions", exact: true })).toBeFocused();
  });
});
