import { expect, test, type Locator, type Page } from "@playwright/test";

type Scenario = "running" | "failing" | "silent" | "approval" | "agents";

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

test("a long unbroken plan step wraps inside the step tooltip at 390px", async ({ page }) => {
  const plan = `apps/web/src/components/${"VeryLongIdentifierWithoutBreaks".repeat(6)}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/active-turn-progress-e2e.html?scenario=running&plan=${encodeURIComponent(plan)}`);
  const tooltip = page.locator(".tl-working [role='tooltip']");
  await expect(tooltip).toContainText(plan);
  await expect.poll(() => tooltip.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoHorizontalOverflow(page);
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

/** Open the turn's work group so its agents' rows are on screen. */
async function openAgents(page: Page, viewport: { width: number; height: number }, query = "") {
  await page.setViewportSize(viewport);
  await page.goto(`/active-turn-progress-e2e.html?scenario=agents${query}`);
  const ledger = page.locator(".tl-work > .disclosure-trigger");
  await ledger.click();
  await expect(ledger).toHaveAttribute("aria-expanded", "true");
  return page.locator(".tl-agent");
}

test("each agent is one named row with its role, step count, status and Open (#2183)", async ({ page }) => {
  const agents = await openAgents(page, { width: 1440, height: 900 });
  await expect(agents.locator(".tl-agent-name")).toHaveText(["Coordinate Release Audit", "Check Compatibility Gates", "Draft Release Notes"]);
  await expect(agents.locator(".tl-agent-meta")).toHaveText(["Explorer3 Steps", "2 Steps", "Writer2 Steps"]);
  await expect(agents.locator(".tl-agent-status")).toHaveText(["Running", "Completed", "Completed"]);
  await expect(page.getByText("Agent · 1 Step")).toHaveCount(0);
  // The disclosure and Open sit on one 28px row, Open 8px past the disclosure.
  const row = agents.first();
  const toggle = row.locator(".tl-agent-toggle");
  const open = row.getByRole("button", { name: "Open Coordinate Release Audit" });
  await expect(open).toHaveText("Open");
  const [toggleBox, openBox] = [await toggle.boundingBox(), await open.boundingBox()];
  expect(Math.round(openBox!.height)).toBe(28);
  expect(openBox!.x - (toggleBox!.x + toggleBox!.width)).toBeGreaterThanOrEqual(8);
  await open.click();
  await expect(page.getByTestId("opened-subagent")).toHaveText("release-audit-agent");
  await expectNoHorizontalOverflow(page);
});

test.describe("on a coarse pointer at 390px", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("Open's hit area is at least 44px tall and the row never overflows (#2183)", async ({ page }) => {
    const agents = await openAgents(page, { width: 390, height: 844 });
    await expect(agents).toHaveCount(3);
    for (const open of await agents.getByRole("button", { name: /^Open / }).all()) {
      const hit = await open.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const after = getComputedStyle(element, "::after");
        return { visual: box.height, top: Number.parseFloat(after.top), bottom: Number.parseFloat(after.bottom) };
      });
      expect(hit.visual).toBe(36);
      expect(hit.visual - hit.top - hit.bottom, "the ::after hit area borrows past the visual edge").toBeGreaterThanOrEqual(44);
    }
    // A phone gives the name the line: it runs from the icon to the disclosure's end, and the role,
    // step count and status wrap to a second line under it. Open stays at the trailing edge.
    const fits = await agents.evaluateAll((rows) => rows.map((row) => {
      const toggle = row.querySelector<HTMLElement>(".tl-agent-toggle")!;
      const end = toggle.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(toggle).paddingRight);
      const icon = row.querySelector(".tl-step-icon")!.getBoundingClientRect();
      const name = row.querySelector(".tl-agent-name")!.getBoundingClientRect();
      const meta = row.querySelector(".tl-agent-meta")!.getBoundingClientRect();
      const status = row.querySelector(".tl-agent-status")!.getBoundingClientRect();
      const open = row.querySelector(".btn")!.getBoundingClientRect();
      return {
        nameHasTheLine: name.right >= end - 2 && name.left - icon.right <= 9,
        factsUnderName: meta.top >= name.bottom - 1 && status.top >= name.bottom - 1 && Math.abs(meta.left - name.left) <= 1,
        factsWhole: meta.right <= end + 1 && status.right <= end + 1,
        openTrailing: open.left >= end && open.right <= document.documentElement.clientWidth,
      };
    }));
    expect(fits).toEqual(Array.from({ length: 3 }, () =>
      ({ nameHasTheLine: true, factsUnderName: true, factsWhole: true, openTrailing: true })));
    await expect(agents.locator(".tl-agent-name").first()).toHaveText("Coordinate Release Audit");
    expect(await agents.locator(".tl-agent-name").evaluateAll((names) =>
      names.filter((name) => name.scrollWidth > name.clientWidth + 1).length), "every fixture name fits whole at 390px").toBe(0);
    await expectNoHorizontalOverflow(page);
    await agents.first().getByRole("button", { name: "Open Coordinate Release Audit" }).tap();
    await expect(page.getByTestId("opened-subagent")).toHaveText("release-audit-agent");
  });
});

test.describe("a long provider role on a coarse pointer at 390px", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the role ellipsizes; the name, step count and status stay whole (#2183)", async ({ page }) => {
    // Providers send roles of up to 48 characters.
    const role = "Security Architecture and Compliance Reviewer";
    const agents = await openAgents(page, { width: 390, height: 844 }, `&role=${encodeURIComponent(role)}`);
    const row = agents.first();
    await expect(row.locator(".tl-agent-name")).toHaveText("Coordinate Release Audit");
    await expect(row.locator(".tl-agent-toggle")).toHaveAccessibleName(
      `Coordinate Release Audit · ${role} · 3 Steps · Running`);
    const layout = await row.evaluate((element) => {
      const toggle = element.querySelector<HTMLElement>(".tl-agent-toggle")!;
      const end = toggle.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(toggle).paddingRight);
      const name = element.querySelector(".tl-agent-name")!;
      const roleSpan = element.querySelector<HTMLElement>(".tl-agent-role")!;
      const steps = element.querySelector(".tl-agent-steps")!.getBoundingClientRect();
      const status = element.querySelector(".tl-agent-status")!.getBoundingClientRect();
      return {
        nameWhole: name.scrollWidth <= name.clientWidth + 1,
        roleEllipsized: roleSpan.scrollWidth > roleSpan.clientWidth,
        stepsWhole: steps.right <= end + 1 && steps.width > 20,
        statusWhole: status.right <= end + 1,
        oneFactLine: Math.abs(steps.top - status.top) <= 4 && steps.top >= name.getBoundingClientRect().bottom - 1,
      };
    });
    expect(layout).toEqual({ nameWhole: true, roleEllipsized: true, stepsWhole: true, statusWhole: true, oneFactLine: true });
    await expectNoHorizontalOverflow(page);
  });
});
