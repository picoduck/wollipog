import { expect, test, type Locator, type Page } from "@playwright/test";

type Scenario = "running" | "failing" | "silent" | "approval";

async function openScenario(page: Page, scenario: Scenario, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`/active-turn-progress-e2e.html?scenario=${scenario}`);
  // The progress facts live in the transcript's merged Working row, not a separate card.
  const progress = page.getByRole("region", { name: "Active Turn Progress" });
  await expect(progress).toBeVisible();
  return progress;
}

async function expectWorkingLine(progress: Locator) {
  const line = progress.locator(".tl-working-line");
  await expect(line.locator(".tl-working-state")).toHaveText("Working");
  await expect(line.locator(".tl-working-elapsed")).toHaveText("7m 0s");
  await expect(line.getByRole("button", { name: "Coordinate Release Audit" })).toBeVisible();
  await expect(line.getByRole("button", { name: "Open Agent" })).toBeVisible();
  // The tooltip is hidden text inside the line; only the visible copy must stay count-free.
  await expect.poll(() => line.evaluate((element) => element.innerText)).not.toMatch(/Completed|Failed|Last Activity|Plan Step|\b0\b/i);
  await expect(progress.locator("[role='tooltip']")).toHaveText("Show this step in the transcript. 1 completed. Plan step: Validate compatibility release");
}

async function expectFailureNote(progress: Locator) {
  const note = progress.locator(".tl-working-note");
  await expect(note.locator(".tl-working-failed")).toHaveText("3 failed");
  await expect(note.locator(".tl-working-retry")).toContainText("Retried 2 times: Release validation failed");
}

async function expectRetryTruncated(page: Page) {
  const retry = page.locator(".tl-working-retry");
  await expect(retry).toBeVisible();
  await expect(retry).toHaveAttribute("title", /compatibility marker/);
  await expect.poll(() => retry.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.getByTestId("reader").evaluate((reader) => reader.scrollWidth <= reader.clientWidth + 1)).toBe(true);
}

/** Every child of a line sits on the line's single row: nothing, a count least of all, wraps. */
async function expectSingleRow(line: Locator) {
  await expect.poll(() => line.evaluate((element) => {
    const lineBox = element.getBoundingClientRect();
    return [...element.children].every((child) => {
      const box = child.getBoundingClientRect();
      return box.height === 0 || (box.top >= lineBox.top - 1 && box.bottom <= lineBox.bottom + 1 && box.height < 2 * 20 + 1);
    }) && lineBox.height <= 32;
  })).toBe(true);
}

/**
 * Reveal a row and wait for the reveal to settle before acting again. MeasuredVirtualList re-centers
 * the revealed row for up to 8 frames, and a click's own pointerdown cancels that settle, so a click
 * issued mid-settle can land on a control that is still moving (#1806, #2170).
 */
async function revealAndSettle(page: Page, trigger: Locator, text: string) {
  await trigger.click();
  const target = page.locator("[aria-current='location']");
  await expect(target).toBeVisible();
  await expect(target).toContainText(text);
  await expect.poll(() => target.evaluate((element) => element === document.activeElement)).toBe(true);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport();
  return target;
}

test("the working line shows observable progress and links to transcript and Subagents", async ({ page }) => {
  const progress = await openScenario(page, "failing", { width: 1280, height: 800 });
  await expectWorkingLine(progress);
  await expectFailureNote(progress);
  await expectRetryTruncated(page);
  await expectNoHorizontalOverflow(page);

  await revealAndSettle(page, progress.getByRole("button", { name: "Coordinate Release Audit" }), "Coordinate Release Audit");
  await progress.getByRole("button", { name: "Open Agent" }).click();
  await expect(page.getByTestId("opened-subagent")).toHaveText("release-audit-agent");
});

test("the working line remains compact and readable in a narrow viewport", async ({ page }) => {
  const progress = await openScenario(page, "failing", { width: 390, height: 844 });
  await expectWorkingLine(progress);
  await expectFailureNote(progress);
  await expectRetryTruncated(page);
  await expectNoHorizontalOverflow(page);
  await expectSingleRow(progress.locator(".tl-working-line"));
  await expectSingleRow(progress.locator(".tl-working-note"));

  const bounds = await progress.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(366);
  expect(bounds!.height).toBeLessThan(80);

  await revealAndSettle(page, progress.getByRole("button", { name: "Coordinate Release Audit" }), "Coordinate Release Audit");
  await progress.getByRole("button", { name: "Open Agent" }).click();
  await expect(page.getByTestId("opened-subagent")).toHaveText("release-audit-agent");
});

test("a running turn without failures is one line with no exception line", async ({ page }) => {
  const progress = await openScenario(page, "running", { width: 390, height: 844 });
  await expectWorkingLine(progress);
  await expect(progress.locator(".tl-working-note")).toHaveCount(0);
  await expect(progress.getByRole("status")).toHaveText("Working");
});

test("a silent turn says how long it has been quiet", async ({ page }) => {
  const progress = await openScenario(page, "silent", { width: 390, height: 844 });
  await expect(progress.locator(".tl-working-note")).toHaveText("No new output for 3m");
  await expectSingleRow(progress.locator(".tl-working-line"));
});

test("a pending approval outranks progress and Review moves focus to the request", async ({ page }) => {
  const progress = await openScenario(page, "approval", { width: 1280, height: 800 });
  await expect(progress.locator(".tl-working-line .status")).toHaveText("Approval Required");
  await expect(progress).not.toContainText("Working");
  await expect(progress.getByRole("button", { name: "Open Agent" })).toHaveCount(0);
  await expect(progress.getByRole("status")).toHaveText("Approval Required");

  await revealAndSettle(page, progress.getByRole("button", { name: "Review" }), "Publish the compatibility release");
});
