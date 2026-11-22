import { expect, test, type Locator, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast } from "./layout-invariants.js";

const path = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const dock = (page: Page) => page.locator(".assistant-dock");
const cards = (page: Page) => dock(page).getByRole("listitem");
const approve = (card: Locator) => card.getByRole("button", { name: "Approve Once", exact: true });
const sidePanel = (page: Page) => page.locator("#right-panel");

async function open(page: Page, theme: string, scenario: string, params = "") {
  await page.clock.setFixedTime(Date.UTC(2026, 10, 19, 19, 0));
  await page.goto(`/assistants-e2e.html?theme=${theme}&threads=long&launched=many&accounts=stress&thread-panel=delegated&dock=${scenario}&path=${encodeURIComponent(path)}&${params}`);
  await expect(dock(page)).toBeVisible();
}

async function capture(page: Page, theme: string, state: string) {
  if (state !== "side-panel-overlaid") await expectTextContrast(dock(page));
  if (state !== "side-panel-overlaid" && !state.endsWith("-show-all")) {
    for (const content of await cards(page).first().locator(
      ".assistant-confirmation-summary, .assistant-dock-target, .code-well, .assistant-dock-facts, .assistant-dock-details, .assistant-dock-choices",
    ).all()) {
      await expectFullyInViewport(content, "Request content within the dock");
    }
  }
  if (page.viewportSize()?.width === 390) {
    const targets = await dock(page).locator("button, .assistant-dock-choices label").evaluateAll(elements => elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      let top = y;
      let bottom = y + height;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (!["auto", "scroll", "hidden"].includes(getComputedStyle(parent).overflowY)) continue;
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
      return { label: element.getAttribute("aria-label") ?? element.textContent?.trim(), x, width, height, top, bottom };
    }));
    for (const [index, target] of targets.entries()) {
      expect(target.width, target.label).toBeGreaterThanOrEqual(44);
      expect(target.height, target.label).toBeGreaterThanOrEqual(44);
      for (const other of targets.slice(index + 1)) {
        const overlapWidth = Math.min(target.x + target.width, other.x + other.width) - Math.max(target.x, other.x);
        const overlapHeight = Math.min(target.bottom, other.bottom) - Math.max(target.top, other.top);
        expect(overlapWidth > 0.5 && overlapHeight > 0.5, `${target.label} overlaps ${other.label}`).toBe(false);
      }
    }
  }
  const evidenceDir = process.env.ASSISTANT_DOCK_EVIDENCE_DIR;
  if (!evidenceDir) return;
  const { width, height } = page.viewportSize()!;
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: resolve(evidenceDir, `4809-dock-${width}x${height}-${theme}-${state}.png`),
    animations: "disabled",
  });
}

async function layout(page: Page) {
  await expectPageNoHorizontalOverflow(page);
  const composer = page.locator(".composer");
  const transcript = page.getByRole("region", { name: "Session Activity", exact: true, includeHidden: true });
  await expectFullyInViewport(composer, "Thread composer");
  expect((await transcript.boundingBox())!.height, "The transcript retains room to read").toBeGreaterThan(80);
  const box = (await dock(page).boundingBox())!;
  const reader = (await transcript.boundingBox())!;
  expect(reader.y + reader.height).toBeLessThanOrEqual(box.y + 1);
  expect(box.y + box.height).toBeLessThanOrEqual((await composer.boundingBox())!.y + 1);
  await expectNoHorizontalOverflow(dock(page), "Waiting for You dock");
  expect((await page.locator(".detail-bar").last().boundingBox())!.height).toBe(48);
  expect((await dock(page).locator(".assistant-dock-head").boundingBox())!.height).toBe(48);
}

async function actionOrder(card: Locator, names: string[]) {
  const actions = card.locator(".assistant-dock-actions").getByRole("button");
  await expect(actions).toHaveText(names);
  for (const action of await actions.all()) {
    await expectFullyInViewport(action, (await action.textContent())!);
  }
}

test("a short desktop keeps room for the transcript with the 320% spending notice", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await open(page, "light", "tool", "spending=over");
  await layout(page);
  await expectFullyInViewport(approve(cards(page).first()), "Approve Once above the notice");
  await expectFullyInViewport(page.locator(".composer .assistant-spending-notice"), "Spending notice");
  const body = cards(page).first().locator(".assistant-dock-card-body");
  const { clientHeight, scrollHeight } = await body.evaluate(element => ({
    clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
  }));
  expect(clientHeight).toBeGreaterThan(0);
  expect(scrollHeight).toBeGreaterThan(clientHeight);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    const phone = width === 390;
    test.describe(`${theme}, ${width}px`, () => {
      test.use({ viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, isMobile: phone,
        colorScheme: theme, timezoneId: "UTC", locale: "en-US" });

      test("the dock and 320% spending notice fit above the composer without overlap", async ({ page }) => {
        await open(page, theme, "tool", "spending=over");
        await expect(cards(page)).toHaveCount(1);
        const notice = page.locator(".composer .session-notice-slot .assistant-spending-notice");
        const composer = page.locator(".composer-box");
        const transcript = page.getByRole("region", { name: "Session Activity", exact: true });
        await expect(notice.getByRole("meter")).toHaveAttribute("aria-valuetext", "$79.93 of $25.00 spent");
        await expectFullyInViewport(notice, "Spending notice");
        await expectFullyInViewport(composer, "Composer input with both surfaces");
        await expectFullyInViewport(approve(cards(page).first()), "Approve Once above the notice");
        await layout(page);
        const [reader, waiting, spending, input] = await Promise.all(
          [transcript, dock(page), notice, composer].map(item => item.boundingBox()),
        );
        expect(reader!.y + reader!.height).toBeLessThanOrEqual(waiting!.y);
        expect(waiting!.y + waiting!.height).toBeLessThanOrEqual(spending!.y);
        expect(spending!.y + spending!.height).toBeLessThanOrEqual(input!.y);
        await expectTextContrast(notice);
        await capture(page, theme, "dock-and-spending-notice");
      });

      test("one pending tool approval shows the command and ordered actions", async ({ page }) => {
        await open(page, theme, "tool");
        const card = cards(page).first();
        await expect(dock(page).getByRole("heading", { level: 3 })).toHaveText("Waiting for You 1");
        await expect(card.locator(".code-well")).toHaveCount(1);
        await expect(card.locator(".code-well")).toContainText("--filter cross-platform-packaging-verification");
        await expect(card.locator("time")).toHaveText("Expires in 14 min");
        await expect(card.locator("time")).toHaveAttribute("title", /:/);
        await actionOrder(card, ["Open Session", "Deny", "Approve Once"]);
        await layout(page);
        if (phone) {
          const deny = (await card.getByRole("button", { name: "Deny", exact: true }).boundingBox())!;
          const allow = (await approve(card).boundingBox())!;
          expect(deny.height).toBeGreaterThanOrEqual(44);
          expect(allow.height).toBeGreaterThanOrEqual(44);
          expect(deny.width).toBeGreaterThanOrEqual(44);
          expect(deny.width).toBeCloseTo(allow.width, 0);
          expect(deny.y).toBe(allow.y);
          expect(deny.x + deny.width).toBeLessThan(allow.x);
        }
        await capture(page, theme, phone ? "one-tool-equal-pair-target44csspx" : "one-tool");
      });

      test("three requests page individually and share one outlined dock in Show All", async ({ page }) => {
        await open(page, theme, "tool", "dockCount=3");
        await expect(dock(page).getByText("1 of 3", { exact: true })).toBeVisible();
        await expect(cards(page)).toHaveCount(1);
        await dock(page).getByRole("button", { name: "Next Request" }).click();
        await expect(dock(page).getByText("2 of 3", { exact: true })).toBeVisible();
        await dock(page).getByRole("button", { name: "Previous Request" }).click();
        await expect(dock(page).getByText("1 of 3", { exact: true })).toBeVisible();
        await layout(page);
        await capture(page, theme, "three-paged");
        await dock(page).getByRole("button", { name: "Show All" }).click();
        await expect(cards(page)).toHaveCount(3);
        await expect(dock(page)).toHaveCSS("border-left-width", "1px");
        await expect(cards(page).first()).toHaveCSS("border-top-width", "0px");
        for (const card of await cards(page).all()) await expect(card).toHaveCSS("border-left-width", "0px");
        await layout(page);
        await capture(page, theme, "three-show-all");
      });

      test("eight requests scroll inside Show All while the composer and transcript keep their room", async ({ page }) => {
        await open(page, theme, "tool", "dockCount=8");
        await dock(page).getByRole("button", { name: "Show All" }).click();
        await expect(cards(page)).toHaveCount(8);
        await expect(dock(page).getByRole("heading", { level: 3 })).toHaveText("Waiting for You 8");
        await layout(page);
        const list = dock(page).getByRole("list", { name: "Pending Requests" });
        expect(await list.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
        await expectFullyInViewport(approve(cards(page).first()), "First approval in Show All");
        await capture(page, theme, "eight-show-all");
        for (const card of await cards(page).all()) {
          await approve(card).scrollIntoViewIfNeeded();
          await expect(approve(card)).toBeInViewport({ ratio: 1 });
        }
        await layout(page);
      });

      test("owner confirmation shows the live target and exact arguments and can be denied", async ({ page }) => {
        await open(page, theme, "owner", "confirm=1");
        const card = cards(page).first();
        await expect(card).toContainText("Owner Confirmation");
        await expect(card.locator(".assistant-dock-target .status")).toHaveText("Running");
        await expect(card.locator("dl[aria-label='Arguments']")).toContainText("sess-flaky");
        await expect(card.locator("dl[aria-label='Impact']")).toContainText("Worktree Path");
        await actionOrder(card, ["Open Session", "Deny", "Approve Once"]);
        await layout(page);
        await capture(page, theme, "owner-confirmation");
        await card.getByRole("button", { name: "Deny", exact: true }).click();
        await expect(page.getByText("Stop Session was denied. Nothing ran.")).toBeVisible();
        await expect(page.locator("body")).toHaveAttribute("data-confirmation-answer", "aoc_0_sess-flaky:deny");
        await expect(dock(page)).toHaveCount(0);
      });

      test("campaign approval opens the existing review with Deny before Approve Once", async ({ page }) => {
        await open(page, theme, "campaign", "campaign&confirm=1");
        const card = cards(page).first();
        await expect(card).toContainText("Campaign Approval");
        await expect(card.getByRole("button", { name: /^Show Details/ })).toHaveAttribute("aria-expanded", "false");
        await actionOrder(card, ["Deny", "Review Campaign…"]);
        await layout(page);
        await capture(page, theme, "campaign-approval");
        await card.getByRole("button", { name: "Review Campaign…" }).click();
        const dialog = page.getByRole("dialog", { name: "Start Campaign", exact: true });
        await expect(dialog.locator(".modal-foot").getByRole("button")).toHaveText(["Deny", "Approve Once"]);
        await expect(dialog.getByLabel("Campaign Details")).toBeVisible();
        await approve(dialog).click();
        await expect(dock(page)).toHaveCount(0);
        await expect(page.getByText("Start Campaign ran once.", { exact: true })).toBeVisible();
      });

      test("question submits the selected option with the exact occurrence", async ({ page }) => {
        await open(page, theme, "question");
        const card = cards(page).first();
        await expect(card).toContainText("Which lockfile should I keep?");
        await actionOrder(card, ["Open Session", "Send Answer"]);
        const answer = card.getByRole("button", { name: "Send Answer" });
        await expect(answer).toBeDisabled();
        await card.getByRole("radio", { name: "Workspace Lockfile" }).check();
        await layout(page);
        await capture(page, theme, "question");
        await answer.click();
        await expect(page.getByText("Answer sent.", { exact: true })).toBeVisible();
        await expect(page.locator("body")).toHaveAttribute("data-question-answer", JSON.stringify([
          "sess-deps", { requestId: "req-lockfile", occurrenceId: "occ-deps-1", answers: { lockfile: "Workspace Lockfile" }, action: "submit" },
        ]));
        await expect(dock(page)).toHaveCount(0);
      });

      test("richer requests only offer to open the session", async ({ page }) => {
        await open(page, theme, "rich");
        await actionOrder(cards(page).first(), ["Open Session"]);
        await layout(page);
        await capture(page, theme, "open-session");
        await cards(page).first().getByRole("button", { name: "Open Session" }).click();
        await expect(page).toHaveURL(/path=%2Fsessions/);
      });

      test("approval stays put while busy, announces failure, then retries on the same button", async ({ page }) => {
        await open(page, theme, "tool", "dockCount=3&dockFailure");
        const card = cards(page).first();
        const allow = approve(card);
        const deny = card.getByRole("button", { name: "Deny", exact: true });
        await allow.focus();
        const before = await allow.boundingBox();
        const denyBefore = await deny.boundingBox();
        await page.keyboard.press("Enter");
        await expect(allow).toHaveAttribute("aria-busy", "true");
        await expect(allow.locator("[aria-hidden='true']")).toHaveCount(1);
        await expect(allow).toBeFocused();
        await expect(allow).toHaveAccessibleName("Approve Once");
        await expect(card.getByRole("status").filter({ hasText: "Approving the request" })).toHaveCount(1);
        expect(await allow.boundingBox()).toEqual(before);
        expect(await deny.boundingBox()).toEqual(denyBefore);
        for (const name of ["Deny", "Open Session", "Next Request", "Previous Request", "Show All"]) {
          await expect(dock(page).getByRole("button", { name, exact: true })).toHaveAttribute("aria-disabled", "true");
        }
        await capture(page, theme, "busy");
        await page.evaluate(() => Reflect.get(window, "assistantsReleaseApproval")());
        const failure = card.getByRole("alert");
        await expect(failure).toHaveText("Couldn't approve the request.");
        await expect(allow).toBeFocused();
        await expect(card.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
        await expect(card.getByText("The runner did not acknowledge this approval.")).toHaveCount(0);
        await expectFullyInViewport(failure, "Inline approval failure");
        const details = card.getByRole("button", { name: /^Show Details/ });
        await expectFullyInViewport(details, "Show Details for the inline failure");
        await capture(page, theme, "failure");
        await details.click();
        await expect(card.getByText("The runner did not acknowledge this approval.")).toBeVisible();
        await allow.click();
        await expect(page.locator("body")).toHaveAttribute("data-approved", "sess-deps:req-1:allow");
        await expect(dock(page).getByText("1 of 2", { exact: true })).toBeVisible();
        await expect(approve(cards(page).first())).toBeFocused();
      });
    });
  }

  test.describe(`${theme} with the side panel open`, () => {
    test.use({ viewport: { width: 1024, height: 768 }, colorScheme: theme, timezoneId: "UTC", locale: "en-US" });

    test("the dock stays above the composer behind the overlay at 1024px", async ({ page }) => {
      await open(page, theme, "tool");
      await page.getByRole("button", { name: /Side Panel/ }).click();
      await expect(sidePanel(page)).toHaveAttribute("data-presentation", "overlay");
      await expect(sidePanel(page).getByRole("tab", { name: "Work 42", exact: true })).toBeVisible();
      await expect(page.locator(".detail-body")).toHaveAttribute("inert", "");
      const dockBox = (await dock(page).boundingBox())!;
      const panelBox = (await sidePanel(page).boundingBox())!;
      expect(dockBox.x).toBeLessThan(panelBox.x);
      await layout(page);
      await capture(page, theme, "side-panel-overlaid");
    });
  });
}

test("resizing out of the docked presentation keeps the very same approval button focused", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "light", "tool");
  await page.getByRole("button", { name: /Side Panel/ }).click();
  await expect(sidePanel(page)).toHaveAttribute("data-presentation", "docked");
  const button = approve(cards(page).first());
  const node = await button.elementHandle();
  await button.focus();
  await page.setViewportSize({ width: 920, height: 768 });
  await expect(sidePanel(page)).toHaveCount(0);
  expect(await node!.evaluate(element => document.activeElement === element)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await node!.evaluate(element => document.activeElement === element)).toBe(true);
});

test("answering a request focuses the same action on the next one, then the composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "light", "tool", "dockCount=2");
  await approve(cards(page).first()).focus();
  await page.keyboard.press("Enter");
  await expect(cards(page).first()).toHaveAccessibleName("Verify Release Engineering Package 2");
  await expect(approve(cards(page).first())).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dock(page)).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toBeFocused();
});

test("a newer summary of the same request keeps its hydrated once-only actions", async ({ page }) => {
  await open(page, "light", "tool", "dockHydrationRace");
  await expect(page.locator("body")).toHaveAttribute("data-dock-hydration-race", "published");
  await approve(cards(page).first()).click();
  await expect(page.locator("body")).toHaveAttribute("data-approved", "sess-deps:req-1:allow");
});
