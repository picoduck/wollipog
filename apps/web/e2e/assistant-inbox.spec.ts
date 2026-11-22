import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast } from "./layout-invariants.js";

const inbox = (page: Page) => page.getByRole("complementary", { name: "Assistants" });
const rows = (list: Locator) => list.locator("[data-thread-id]");

test("background polls refresh active threads and keep the archived list", async ({ page }) => {
  await page.clock.install();
  await page.goto("/assistants-e2e.html?threads=inbox&track-list-reads");
  const list = inbox(page);
  await expect(list.getByRole("button", { name: /^Archived Threads 1/ })).toBeVisible();
  const body = page.locator("body");
  const fullReads = await body.getAttribute("data-full-thread-reads");
  await page.clock.fastForward(16_000);
  await expect(body).toHaveAttribute("data-active-thread-reads", "1");
  await expect(body).toHaveAttribute("data-full-thread-reads", fullReads!);
  await list.getByRole("button", { name: /^Archived Threads 1/ }).click();
  await expect(list.getByRole("button", { name: /^Retire the Old Runner/ })).toBeVisible();
});

test("archiving a thread removes transcript edit actions and keeps copy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "light");
  const list = inbox(page);
  await list.getByRole("button", { name: /^Triage Open Issues/ }).click();
  const prompt = page.locator(".tl-row.user").filter({ hasText: "Last night's CI had two failures." });
  await expect(prompt.getByRole("button", { name: "Edit as a New Turn" })).toHaveCount(1);
  await page.getByRole("button", { name: "Thread Actions" }).click();
  await page.getByRole("menuitem", { name: "Archive Thread…" }).click();
  await page.getByRole("dialog", { name: "Archive Thread" }).getByRole("button", { name: "Archive Thread" }).click();
  await list.getByRole("button", { name: /^Archived Threads 2/ }).click();
  await list.getByRole("button", { name: /^Triage Open Issues/ }).click();
  await expect(prompt.getByRole("button", { name: "Copy Message" })).toHaveCount(1);
  await expect(prompt.getByRole("button", { name: "Edit as a New Turn" })).toHaveCount(0);
});

async function open(page: Page, theme: string, query = "threads=inbox") {
  await page.clock.setFixedTime(Date.UTC(2026, 10, 22, 17, 0));
  await page.goto(`/assistants-e2e.html?theme=${theme}&${query}`);
}

async function capture(page: Page, name: string) {
  const directory = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (directory) await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
}

async function expectInboxLayout(list: Locator, phone: boolean) {
  await expectNoHorizontalOverflow(list, "The Assistants list");
  await expectTextContrast(list);
  const controls = await list.getByRole("button").evaluateAll((buttons) => buttons.flatMap((button) => {
    if (!button.getClientRects().length || button.matches(":disabled")) return [];
    const rect = button.getBoundingClientRect();
    const after = getComputedStyle(button, "::after");
    const style = getComputedStyle(button);
    const expands = after.content !== "none" && after.position === "absolute" && after.pointerEvents !== "none";
    const inset = (edge: "left" | "right" | "top" | "bottom", border: string) =>
      expands ? Math.min(0, (parseFloat(after[edge]) || 0) + parseFloat(border)) : 0;
    const left = rect.left + inset("left", style.borderLeftWidth);
    const top = rect.top + inset("top", style.borderTopWidth);
    const right = rect.right - inset("right", style.borderRightWidth);
    const bottom = rect.bottom - inset("bottom", style.borderBottomWidth);
    const scroll = button.closest(".master-detail-list-body")?.getBoundingClientRect();
    const visibleTop = Math.max(top, scroll?.top ?? 0);
    const visibleBottom = Math.min(bottom, scroll?.bottom ?? innerHeight);
    if (visibleTop >= visibleBottom) return [];
    return [{ name: button.getAttribute("aria-label") || button.textContent, left, right, top, bottom, visibleTop, visibleBottom }];
  }));
  const minimum = phone ? 44 : 24;
  for (const [index, first] of controls.entries()) {
    expect(first.right - first.left, `${first.name} width`).toBeGreaterThanOrEqual(minimum);
    expect(first.bottom - first.top, `${first.name} height`).toBeGreaterThanOrEqual(minimum);
    if (!phone) continue;
    for (const second of controls.slice(index + 1)) {
      const gapX = Math.max(first.left - second.right, second.left - first.right);
      const gapY = Math.max(first.visibleTop - second.visibleBottom, second.visibleTop - first.visibleBottom);
      expect(Math.max(gapX, gapY), `Gap between ${first.name} and ${second.name}`).toBeGreaterThanOrEqual(8);
    }
  }
  const minimumTypeSize = await list.locator(".group-label, .row-title, .row-sub, .status, .btn, .count").evaluateAll((items) =>
    Math.min(...items.filter((item) => item.getClientRects().length).map((item) => parseFloat(getComputedStyle(item).fontSize))));
  expect(minimumTypeSize).toBeGreaterThanOrEqual(12);
}

async function expectClampedTitle(row: Locator, length: number) {
  const title = row.locator(".assistant-thread-list-title");
  expect((await title.textContent())?.length).toBe(length);
  const layout = await title.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      wrap: style.overflowWrap, clamp: style.webkitLineClamp, line: parseFloat(style.lineHeight),
      height: element.clientHeight, scrollHeight: element.scrollHeight, horizontal: element.scrollWidth - element.clientWidth,
    };
  });
  expect(layout.wrap).toBe("anywhere");
  expect(layout.clamp).toBe("2");
  expect(Math.abs(layout.height - 2 * layout.line)).toBeLessThanOrEqual(1);
  expect(layout.scrollHeight).toBeGreaterThan(layout.height);
  expect(layout.horizontal).toBeLessThanOrEqual(1);
}

for (const theme of ["light", "dark"] as const) {
  for (const phone of [false, true]) {
    const viewport = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    const prefix = `assistant-inbox-${viewport.width}x${viewport.height}-${theme}`;
    test.describe(`${theme} inbox at ${viewport.width}px`, () => {
      test.use({ viewport, hasTouch: phone, isMobile: phone, colorScheme: theme });

      test("mounts the first-thread composer and three starter prompts in an empty inbox", async ({ page }) => {
        await open(page, theme, "threads=empty&limits=enabled");
        const pane = page.locator(".assistant-thread-pane");
        const composer = pane.getByRole("form", { name: "What should the assistant work on?" });
        const start = composer.getByRole("button", { name: "Start Thread" });
        const suggestions = composer.getByRole("group", { name: "Starter Prompts" }).getByRole("button");
        await expect(composer).toBeVisible();
        await expect(suggestions).toHaveText(["Check On Running Work", "Review Open Decisions", "Plan a Task"]);
        for (const suggestion of await suggestions.all()) await expectFullyInViewport(suggestion);
        await expect(start).toBeDisabled();
        await expectFullyInViewport(start, "Start Thread");
        await expect(inbox(page).getByRole("button", { name: "New Thread", exact: true })).toHaveCount(0);
        await expectInboxLayout(composer, phone);
        await expectPageNoHorizontalOverflow(page);
        await capture(page, `${prefix}-empty-composer`);
        await suggestions.getByText("Plan a Task").click();
        await expect(start).toBeEnabled();
        await start.click();
        await expect(pane.locator(".composer")).toBeVisible();
        await expect(composer).toHaveCount(0);
      });

      test("groups owner attention above recent work and keeps titles, statuses and previews inside the pane", async ({ page }) => {
        await open(page, theme);
        const list = inbox(page);
        const search = list.getByRole("button", { name: "Search Threads", exact: true });
        const create = list.getByRole("button", { name: "New Thread", exact: true });
        await expect(list.getByRole("heading", { name: "Threads", exact: true })).toBeVisible();
        await expect(search).toBeVisible();
        await expect(create).toHaveClass(/\bprimary\b/);
        await expectFullyInViewport(create, "New Thread");
        await expect(list.locator("h3")).toHaveText(["Needs You 1", "Recent"]);
        const needsYou = list.getByRole("region", { name: "Needs You 1" });
        const recent = list.getByRole("region", { name: "Recent" });
        await expect(rows(needsYou)).toHaveCount(1);
        await expect(rows(recent)).toHaveCount(16);
        const waiting = rows(needsYou).first();
        const budget = recent.locator('[data-thread-id="thr_release"]');
        const idle = recent.locator('[data-thread-id="thr_cleanup"]');
        await expect(waiting.locator(".assistant-thread-preview-line")).toContainText("Waiting for you: stop Fix the Flaky Upload Test, and 2 more.");
        await expect(waiting.locator(".status")).toHaveText("Needs You");
        await expect(budget.locator(".assistant-thread-preview-line")).toContainText("Spent $79.93 of its $25.00 budget.");
        await expect(budget.locator(".status")).toHaveText("Over Budget");
        await expect(idle.locator(".status")).toHaveCount(0);
        await expect(idle.locator(".assistant-thread-preview-line")).toHaveText("Removed three stale worktrees.");
        await expect(budget.locator("svg.agent-icon")).toHaveCSS("width", "20px");
        await expect(budget.locator("svg.agent-icon")).toHaveCSS("height", "20px");
        await expect(budget.locator(".assistant-thread-preview-line .row-sub")).toHaveCSS("white-space", "nowrap");
        await expectClampedTitle(recent.locator('[data-thread-id="thr_inbox_long"]'), 120);
        await expectClampedTitle(recent.locator('[data-thread-id="thr_inbox_unbroken"]'), 70);
        await expectPageNoHorizontalOverflow(page);
        await expectInboxLayout(list, phone);
        await expectFullyInViewport(list.getByRole("button", { name: /^Archived Threads 1/ }), "Archived Threads");
        await capture(page, `${prefix}-needs-you-recent-stress-${phone ? "target44csspx-gap8csspx" : "target24csspx"}`);

        await search.click();
        const field = list.getByRole("searchbox", { name: "Search Threads" });
        await expect(field).toBeFocused();
        await field.fill("stale worktrees");
        await expect(rows(list)).toHaveCount(1);
        await expect(idle).toBeVisible();
        await field.fill("no matching thread title");
        await expect(list.getByRole("heading", { name: "No Matching Threads" })).toBeVisible();
        await field.press("Escape");
        await expect(search).toBeFocused();
        await expect(rows(list)).toHaveCount(17);
      });

      test("opens the archive and reads a thread without editing or sending", async ({ page }) => {
        await open(page, theme);
        const list = inbox(page);
        await list.getByRole("button", { name: /^Archived Threads 1/ }).click();
        await expect(list.getByRole("heading", { name: "Archived Threads" })).toBeVisible();
        await expect(rows(list)).toHaveCount(1);
        const archived = list.getByRole("button", { name: /^Retire the Old Runner/ });
        await expect(archived.locator(".status")).toHaveText("Archived");
        await expectInboxLayout(list, phone);
        await capture(page, `${prefix}-archived-list`);
        await archived.click();
        await expect(page.getByRole("heading", { name: "Retire the Old Runner" })).toBeVisible();
        await expect(page.getByText("No sessions are using it. The old runner is disconnected.")).toBeVisible();
        await expect(page.getByText("This thread is read-only.")).toBeVisible();
        await expect(page.locator(".assistant-thread-pane .composer")).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Unarchive/ })).toHaveCount(0);
        await expectPageNoHorizontalOverflow(page);
        await capture(page, `${prefix}-archived-read-only`);
        if (phone) await page.getByRole("button", { name: "Back to Assistants" }).click();
        await list.getByRole("button", { name: "Back to Threads" }).click();
        await expect(list.getByRole("heading", { name: "Threads", exact: true })).toBeVisible();
      });

      test("renders older rows without a preview or a page error", async ({ page }) => {
        const errors: Error[] = [];
        page.on("pageerror", (error) => errors.push(error));
        await open(page, theme, "threads=some");
        const list = inbox(page);
        await expect(rows(list)).toHaveCount(3);
        await expect(list.locator(".assistant-thread-preview-line .row-sub")).toHaveCount(0);
        await expect(list.locator('[data-thread-id="thr_cleanup"] .assistant-thread-preview-line')).toHaveCount(0);
        expect(errors).toEqual([]);
        await expectInboxLayout(list, phone);
        await capture(page, `${prefix}-older-control-plane`);
      });

      test("shows skeletons during loading and a retry action on failure", async ({ page }) => {
        await open(page, theme, "threads=inbox&hold-initial-list");
        const list = inbox(page);
        await expect(list.getByRole("status").getByText("Loading threads")).toHaveCount(1);
        await expect(list.locator(".skeleton-bar")).toHaveCount(8);
        await expect(list.locator(".skeleton-bar").first()).toBeVisible();
        await expect(rows(list)).toHaveCount(0);
        await expectPageNoHorizontalOverflow(page);
        await capture(page, `${prefix}-loading`);

        await open(page, theme, "threads=failed");
        await expect(list.getByRole("alert")).toContainText("Couldn't Load Threads");
        await expect(list.getByRole("button", { name: "Retry" })).toBeVisible();
        await expectInboxLayout(list, phone);
        await expectPageNoHorizontalOverflow(page);
        await capture(page, `${prefix}-failed`);
      });
    });
  }
}
