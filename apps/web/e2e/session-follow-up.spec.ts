import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

const PAGE = "/command-inbox-projects-e2e.html?scenario=human-follow-up";
const input = "Choose the Release Target";
const result = "Findings Ready for Assessment";
const work = "Investigating in the Background";
const quiet = "Previously Reviewed Explanation";
const titles = (page: Page) => page.locator(".inbox-row-title").allTextContents();
const row = (page: Page, title: string) => page.locator(".inbox-row-shell", { hasText: title });

async function open(page: Page) {
  await page.goto(PAGE);
  await expect(page.getByRole("grid", { name: "Sessions", exact: true })).toBeVisible();
  await expect.poll(() => titles(page)).toEqual([input, result, work, quiet]);
}

for (const width of [1440, 390]) {
  test(`human follow-up keeps exact review state and stable live targets at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const before = await row(page, result).boundingBox();
    await page.evaluate(() => {
      const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
      const working = fixture.model().sessions.find((s) => s.id === "session-working")!;
      fixture.replaceSessionSnapshot("session-working", { lastEventAt: 999999, updatedAt: 999999, attention: working.attention });
    });
    await expect.poll(() => titles(page)).toEqual([input, result, work, quiet]);
    expect((await row(page, result).boundingBox())?.y).toBe(before?.y);
    const requests = await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests());
    expect(requests.every((request) => request.sessionId === "session-input")).toBe(true);

    await row(page, result).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Mark Reviewed", exact: true })).toBeVisible();
    // A result arrives while the menu is open. The old menu still addresses result-1.
    await page.evaluate(() => {
      const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
      const facts = fixture.model().sessions.find((s) => s.id === "session-review")!.attention!;
      fixture.replaceSessionSnapshot("session-review", { attention: { ...facts,
        result: { revision: "result-2", at: Date.now(), owner: "human" } } });
    });
    await page.getByRole("menuitem", { name: "Mark Reviewed", exact: true }).click();
    await expect(page.getByText("A newer result is waiting for review.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
      .find((s) => s.id === "session-review")!.attention!.acknowledgedRevision)).toBeNull();
    await row(page, result).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark Reviewed", exact: true }).click();
    await expect(row(page, result).getByText("Result Available", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
      .find((s) => s.id === "session-review")!.attention!.acknowledgedRevision)).toBe("result-2");
    await page.reload();
    await expect.poll(() => titles(page)).toEqual([input, work, result, quiet]);
  });
}

test("All and Project lists share priorities; new results defer reordering while selection and keyboard targets stay held", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await row(page, work).click();
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    const facts = fixture.model().sessions.find((s) => s.id === "session-working")!.attention!;
    fixture.replaceSessionSnapshot("session-working", { attention: { ...facts,
      result: { revision: "work-result", at: Date.now(), owner: "human" } } });
  });
  await expect(row(page, work)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => titles(page)).toEqual([input, result, work, quiet]);
  const orderLine = page.locator(".inbox-order-line");
  await expect(orderLine).toBeVisible();
  await expect(orderLine).toContainText("New activity changed the order.");
  await orderLine.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => titles(page)).toEqual([input, work, result, quiet]);
  await expect(orderLine).toHaveCount(0);
  await expect(grid).toBeFocused();
  await grid.press("j");
  await expect(row(page, result)).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /^Alpha/ }).click();
  await expect.poll(() => titles(page)).toEqual([input, work, result, quiet]);
});

test("opening and marking read do not review a result; accepted follow-up addresses its submitted revision", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await row(page, result).click();
  await row(page, result).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Reply/ }).click();
  const composer = page.locator(".composer-input");
  await expect(composer).toBeVisible();
  const acknowledgment = () => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
    .find((s) => s.id === "session-review")!.attention!.acknowledgedRevision);
  expect(await acknowledgment()).toBeNull();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextPrompt());
  await composer.fill("Explain the next step for this finding");
  await composer.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()[0]!.reviewedResultRevision)).toBe("result-1");
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    const facts = fixture.model().sessions.find((s) => s.id === "session-review")!.attention!;
    fixture.replaceSessionSnapshot("session-review", { attention: { ...facts,
      result: { revision: "result-2", at: Date.now(), owner: "human" } } });
    fixture.settleDeferredPrompt();
  });
  await expect(composer).toHaveValue("");
  expect(await acknowledgment()).toBeNull();
  await composer.fill("Assess the newer finding");
  await composer.press("Enter");
  await expect.poll(acknowledgment).toBe("result-2");
});

test("mobile touch menu keeps its target while a result changes priority", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await open(page);
  const box = (await row(page, result).boundingBox())!;
  const point = { x: box.x + 60, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await expect(page.getByRole("menuitem", { name: "Mark Reviewed", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    const facts = fixture.model().sessions.find((s) => s.id === "session-working")!.attention!;
    fixture.replaceSessionSnapshot("session-working", { attention: { ...facts,
      result: { revision: "work-result", at: Date.now(), owner: "human" } } });
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => titles(page)).toEqual([input, result, work, quiet]);
  await page.getByRole("menuitem", { name: "Mark Reviewed", exact: true }).click();
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
    .find((s) => s.id === "session-review")!.attention!.acknowledgedRevision)).toBe("result-1");
  await expect(row(page, work).getByText("Result Available", { exact: true })).toBeVisible();
});

if (process.env.WOLLIPOG_CAPTURE_EVIDENCE === "1") {
  for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
    test(`capture follow-up order and exact-review menu ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().filter((animation) =>
          animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
      });
      await page.screenshot({ path: `/tmp/2717-evidence/after-${width}-${theme}-order.png`, fullPage: true });
      await row(page, result).click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: "Mark Reviewed", exact: true })).toBeVisible();
      await dialogMotionSettled(page);
      await page.screenshot({ path: `/tmp/2717-evidence/after-${width}-${theme}-review-menu.png`, fullPage: true });
    });
  }
}


for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
  test(`questions stand out from available results while collapsed children keep working at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-working", { parentSessionId: "session-review" });
    }, theme);
    const parent = row(page, result);
    const resultBadge = parent.locator(".status");
    const answerBadge = row(page, input).locator(".status");
    await expect(resultBadge).toHaveText("Result Available");
    await expect(resultBadge).toHaveClass(/t-neutral/);
    await expect(answerBadge).toHaveText("Answer Required");
    await expect(answerBadge).toHaveClass(/t-warning/);
    expect(await resultBadge.evaluate((badge) => getComputedStyle(badge).color))
      .not.toBe(await answerBadge.evaluate((badge) => getComputedStyle(badge).color));
    await parent.locator(".inbox-thread-toggle").click();
    await expect(row(page, work)).toHaveCount(0);
    const working = parent.locator(width < 600 ? ".inbox-thread-working" : ".inbox-thread-family-text");
    await expect(working).toBeVisible();
    await expect(working).toContainText("1 Working");
    await parent.hover();
    const actions = parent.locator(".inbox-row-actions");
    await expect(actions).toBeVisible();
    const workingBox = await working.boundingBox();
    const actionsBox = await actions.boundingBox();
    expect(workingBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(workingBox!.x + workingBox!.width).toBeLessThanOrEqual(actionsBox!.x);
    expect(await working.evaluate((label) => label.scrollWidth <= label.clientWidth)).toBe(true);
    await expect(parent.locator(".inbox-thread-family")).toHaveAttribute("aria-label", /1 Working/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.emulateMedia({ forcedColors: "active" });
    await expect(answerBadge).toHaveAccessibleName("Status: Answer Required");
    await expect(resultBadge).toHaveAccessibleName("Status: Result Available");
    await expect(working).toBeVisible();
    await page.emulateMedia({ forcedColors: "none" });
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-working", { status: "completed" });
    });
    await expect(parent.locator(".inbox-thread-working")).toHaveCount(0);
    await expect(resultBadge).toHaveText("Result Available");
    await parent.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark Reviewed", exact: true }).click();
    await expect(resultBadge).toHaveText("Running");
  });
}
