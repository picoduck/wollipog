import { expect, test, type Page } from "@playwright/test";

/**
 * Session Tools (#2844; docs/design-system.md §4.9, §5.2): the side panel's landing list starts at
 * the top under its 48px header, in Code, Work and Decisions groups of two-line rows that are 56px
 * with a mouse and 64px on touch whatever their fact says, with keycaps only for a mouse, and an
 * older runner's unavailable tools keep their reasons as visible text under one neutral notice.
 */
const FIXTURE = "/command-inbox-projects-e2e.html?scenario=session-tools&fullShell=1";

async function openTools(page: Page, width: number, height = 860) {
  await page.setViewportSize({ width, height });
  await page.goto(FIXTURE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const open = page.getByRole("button", { name: "Open Session", exact: true });
  if (await open.isVisible()) await open.click();
  await expect(page.locator(".composer-input")).toBeAttached();
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  await expect(tools(page)).toBeVisible();
  await expect(row(page, "review").locator(".row-sub")).toHaveText("9 uncommitted changes, 1 required finding");
}

const tools = (page: Page) => page.locator("#right-panel .session-tools");
const row = (page: Page, id: string) => tools(page).locator(`[data-tool="${id}"]`);

async function olderRunner(page: Page) {
  await page.evaluate(() => (window as unknown as {
    __WOLLIPOG_PROJECT_INBOX_E2E__: { setRunnerProtocolVersion(version: number): void };
  }).__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(1));
  await expect(row(page, "files")).toHaveAttribute("aria-disabled", "true");
}

/** The gap between the panel's header and the list's first element, and every row's height. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const head = document.querySelector("#right-panel .rpanel-head")!.getBoundingClientRect();
    const list = document.querySelector("#right-panel .session-tools")!;
    const first = list.firstElementChild!.getBoundingClientRect();
    const firstRow = list.querySelector(".session-tool")!.getBoundingClientRect();
    return {
      firstGap: first.top - head.bottom,
      firstRowGap: firstRow.top - head.bottom,
      labels: [...list.querySelectorAll(".group-label")].map((label) => label.getBoundingClientRect().height),
      rows: [...list.querySelectorAll<HTMLElement>(".session-tool")].map((button) => ({
        tool: button.dataset.tool, height: button.getBoundingClientRect().height,
      })),
    };
  });
}

function expectRowHeights(rows: { tool?: string; height: number }[], height: number) {
  expect(rows.length).toBeGreaterThanOrEqual(9);
  for (const measured of rows) expect(measured.height, measured.tool).toBe(height);
}

test.describe("with a mouse", () => {
  test("at 1440px the list starts under the header, in its groups, with 56px rows, live facts and keycaps (#2844)", async ({ page }) => {
    await openTools(page, 1440);
    const measured = await layout(page);
    expect(measured.firstGap).toBeGreaterThanOrEqual(0);
    expect(measured.firstGap).toBeLessThanOrEqual(16);
    // The first row sits under its group label (32px) and no further down.
    expect(measured.firstRowGap).toBeLessThanOrEqual(16 + 32);
    expect(measured.labels).toEqual([32, 32, 32]);
    expectRowHeights(measured.rows, 56);
    await expect(tools(page).locator(".group-label")).toHaveText(["Code", "Work", "Decisions"]);
    await expect(tools(page).locator(".session-tool .row-title")).toHaveText([
      "Review", "Files", "Browser", "Terminal", "Agents", "Side Chat", "Background Work", "Requests", "Decision History",
    ]);
    await expect(row(page, "requests").locator(".count-badge")).toHaveText("2");
    await expect(row(page, "requests").locator(".row-sub"))
      .toHaveText("An approval from Deploy Pipeline, and a question from Docs Subagent");
    await expect(row(page, "subagents").locator(".status")).toHaveText("1 Working");
    await expect(row(page, "background").locator(".row-sub")).toHaveText("1 of 3 jobs running");
    for (const id of ["review", "files", "terminal"]) await expect(row(page, id).locator("kbd")).toBeVisible();
    await expect(tools(page).locator("kbd")).toHaveCount(3);
    // No card borders; hover fills the row.
    const review = row(page, "review");
    expect(await review.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px");
    await review.hover();
    // The fill fades in over the shared button transition.
    await expect.poll(() => review.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe("rgba(0, 0, 0, 0)");
  });

  test("at 400px rows stay 56px, however long their fact (#2844)", async ({ page }) => {
    await openTools(page, 400);
    expectRowHeights((await layout(page)).rows, 56);
    // The older runner's reasons are full sentences; the rows keep their height.
    await olderRunner(page);
    expectRowHeights((await layout(page)).rows, 56);
  });

  test("on an older runner Files and Terminal keep a visible reason, a hollow tile and full opacity under one neutral notice (#2844)", async ({ page }) => {
    await openTools(page, 1440);
    await olderRunner(page);
    const notice = tools(page).locator(".notice");
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(/runs an older Wollipog\. Update it to browse files and open a terminal\./);
    expect(await tools(page).evaluate((list) => list.firstElementChild?.classList.contains("notice"))).toBe(true);
    expect((await layout(page)).firstGap).toBeLessThanOrEqual(16);
    await expect(page.locator("#right-panel .hint.warn")).toHaveCount(0);
    for (const id of ["files", "terminal"]) {
      const button = row(page, id);
      const reason = button.locator(".row-sub");
      await expect(reason).toContainText("Needs a newer runner");
      await expect(reason).toBeVisible();
      // The reason reads whole on one line; nothing is cut off behind an ellipsis.
      expect(await reason.evaluate((element) => element.scrollWidth <= element.clientWidth), `${id}'s reason fits`).toBe(true);
      await expect(button.locator("kbd")).toHaveCount(0);
      await button.focus();
      await expect(button).toBeFocused();
      const look = await button.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--text-faint)";
        element.append(probe);
        const faint = getComputedStyle(probe).color;
        probe.remove();
        const tile = element.querySelector(".session-tool-tile")!;
        return {
          opacities: [element, ...element.querySelectorAll("*")].map((node) => getComputedStyle(node).opacity),
          reasonColour: getComputedStyle(element.querySelector(".row-sub")!).color,
          faint,
          tileShadow: getComputedStyle(tile).boxShadow,
          tileFill: getComputedStyle(tile).backgroundColor,
        };
      });
      expect(look.opacities.every((opacity) => opacity === "1"), `${id} draws nothing translucent`).toBe(true);
      expect(look.reasonColour).toBe(look.faint);
      expect(look.tileShadow).toContain("inset");
      expect(look.tileFill).toBe("rgba(0, 0, 0, 0)");
    }
    await expect(tools(page).locator("[title]")).toHaveCount(0);
  });
});

test.describe("on a phone with a coarse pointer", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("at 390px the list starts under the panel's bar with 64px rows and no keycaps (#2844)", async ({ page }) => {
    await openTools(page, 390, 844);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const measured = await layout(page);
    expect(measured.firstGap).toBeGreaterThanOrEqual(0);
    expect(measured.firstGap).toBeLessThanOrEqual(16);
    expectRowHeights(measured.rows, 64);
    await expect(tools(page).locator("kbd")).toHaveCount(0);
    await olderRunner(page);
    expectRowHeights((await layout(page)).rows, 64);
    for (const id of ["files", "terminal"]) {
      expect(await row(page, id).locator(".row-sub").evaluate((element) => element.scrollWidth <= element.clientWidth),
        `${id}'s reason reads whole at 390px`).toBe(true);
    }
  });
});
