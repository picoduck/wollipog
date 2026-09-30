import { expect, test, type Page } from "@playwright/test";

/**
 * The Agent Skills list (#1961; docs/design-system.md §5.2, §9.1, §11, §12.2, §12.3): equal
 * two-line rows whatever the description, at most one status per row, a filter and View Options,
 * and the Orphaned Copies entry at the list's foot. `?skills=list` holds descriptions that are
 * empty, 20 characters, the built-in orchestrate-issues one and 1,024 characters with line breaks.
 */
const shell = (path: string) =>
  `/command-inbox-projects-e2e.html?fullShell=1&history=1&skills=list&path=${encodeURIComponent(path)}`;
const routePath = (page: Page) => page.evaluate(() => new URL(window.location.href).searchParams.get("path"));

async function open(page: Page, path = "/skills", theme?: "dark" | "light") {
  await page.goto(shell(path));
  await expect(page.locator("#page-title")).toBeVisible();
  if (theme) await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await expect(page.locator(".skill-row")).toHaveCount(8);
}

const list = (page: Page) => page.locator(".master-detail-list");
const row = (page: Page, name: string) => list(page).locator(".skill-row", { has: page.locator(".row-title", { hasText: new RegExp(`^${name}$`) }) });
const names = (page: Page) => list(page).locator(".skill-row .row-title").allTextContents();

/** Every row's height, and each description line's box: one line, and whether it overflows. */
const rowGeometry = (page: Page) => list(page).evaluate((pane) => [...pane.querySelectorAll<HTMLElement>(".skill-row")].map((element) => {
  const sub = element.querySelector<HTMLElement>(".row-sub");
  const style = sub ? getComputedStyle(sub) : null;
  return {
    name: element.querySelector(".row-title")!.textContent,
    height: element.getBoundingClientRect().height,
    sub: sub && style ? {
      oneLine: sub.getBoundingClientRect().height <= parseFloat(style.lineHeight) + 0.5,
      overflows: sub.scrollWidth > sub.clientWidth,
      ellipsis: style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap",
    } : null,
  };
}));

test.describe("at 1440×900 with a fine pointer", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("every row is exactly 56px, and a long description is one line ending in an ellipsis", async ({ page }) => {
    await open(page);
    const rows = await rowGeometry(page);
    expect(rows.map((entry) => entry.height)).toEqual(rows.map(() => 56));
    const byName = Object.fromEntries(rows.map((entry) => [entry.name, entry.sub]));
    for (const name of ["orchestrate-issues", "review-checklist"]) {
      expect(byName[name], name).toEqual({ oneLine: true, overflows: true, ellipsis: true });
    }
    expect(byName["deploy-bot"], "a 20-character description fits").toEqual({ oneLine: true, overflows: false, ellipsis: true });
    expect(byName["qa"], "a description equal to the name is not shown").toBeNull();
    await expect(row(page, "code-review").locator(".row-sub")).toHaveText("No description");
    expect(await row(page, "review-checklist").locator(".row-sub").evaluate((sub) => /[\n\r]/.test(sub.textContent ?? "")),
      "line breaks collapse to spaces").toBe(false);
  });

  test("groups read Recommended, No Group, Platform, with no text-transform and no retired labels", async ({ page }) => {
    await open(page);
    const titles = list(page).locator(".skill-list-group-title");
    await expect(titles).toHaveText(["Recommended1", "No Group5", "Platform2"]);
    expect(await titles.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).textTransform))).toEqual(["none", "none", "none"]);
    expect(await list(page).evaluate((pane) => [...pane.querySelectorAll("*")]
      .filter((element) => getComputedStyle(element).textTransform !== "none").length), "nothing in the list is transformed").toBe(0);
    await expect(list(page)).not.toContainText("Ungrouped");
    await expect(list(page)).not.toContainText("All Skills");
  });

  test("a row's one badge is its status, only when the skill needs the user", async ({ page }) => {
    await open(page);
    const badges = (name: string) => row(page, name).locator(".status").allTextContents();
    expect(await badges("orchestrate-issues"), "a healthy recommended built-in skill").toEqual(["Built-In"]);
    await expect(row(page, "orchestrate-issues").locator(".status")).toHaveClass(/\bt-neutral\b.*\bno-dot\b|\bno-dot\b.*\bt-neutral\b/);
    expect(await badges("deploy-bot"), "an error outranks the edited copy").toEqual(["Error"]);
    expect(await badges("release-notes")).toEqual(["Edited"]);
    expect(await badges("lint-rules")).toEqual(["Update Held"]);
    expect(await badges("code-review")).toEqual([]);
    // The status trails line 1; the flag sits beside the name.
    const [title, status, line] = await Promise.all([
      row(page, "deploy-bot").locator(".row-title").boundingBox(),
      row(page, "deploy-bot").locator(".status").boundingBox(),
      row(page, "deploy-bot").locator(".row-line").boundingBox(),
    ]);
    expect(Math.round(status!.x + status!.width)).toBe(Math.round(line!.x + line!.width));
    expect(status!.x).toBeGreaterThan(title!.x + title!.width);
  });

  test("typing a word that appears only past a description's ellipsis filters to that skill", async ({ page }) => {
    await open(page);
    const filter = list(page).getByRole("searchbox", { name: "Filter Skills" });
    await filter.fill("archives");
    expect(await names(page)).toEqual(["review-checklist"]);
    await filter.fill("recursive follow-ups");
    expect(await names(page)).toEqual(["orchestrate-issues"]);
    await filter.fill("terr");
    const state = list(page).locator(".state.no-results");
    await expect(state).toHaveText(/No skills match “terr”\./);
    await state.getByRole("button", { name: "Clear Search", exact: true }).click();
    await expect(filter).toHaveValue("");
    await expect(list(page).locator(".skill-row")).toHaveCount(8);
  });

  test("View Options › Show › Needs Attention and Group By › None", async ({ page }) => {
    await open(page);
    const trigger = list(page).getByRole("button", { name: "View Options", exact: true });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "View Options" });
    await expect(menu.locator(".menu-label")).toHaveText(["Show", "Group By"]);
    await expect(menu.getByRole("menuitemradio")).toHaveText(["All Skills", "Needs Attention", "Imported from Git", "Built-In", "Not Assigned", "Group", "None"]);
    await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText(["All Skills", "Group"]);
    await expect(menu.getByRole("menuitemradio", { name: "All Skills" })).toBeFocused();
    await menu.getByRole("menuitemradio", { name: "Needs Attention" }).click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await names(page)).toEqual(["release-notes", "deploy-bot", "lint-rules"]);
    for (const name of await names(page)) {
      await expect(row(page, name).locator(".status:not(.no-dot)"), name).toHaveCount(1);
    }

    await trigger.click();
    await menu.getByRole("menuitemradio", { name: "All Skills" }).click();
    await trigger.click();
    await menu.getByRole("menuitemradio", { name: "None" }).click();
    await expect(list(page).locator(".skill-list-group-title")).toHaveCount(0);
    expect(await names(page)).toEqual(["code-review", "deploy-bot", "lint-rules", "orchestrate-issues", "qa", "release-notes", "review-checklist", "using-wollipog"]);
  });

  test("the Orphaned Copies entry follows the last group with its count and opens /skills/orphans", async ({ page }) => {
    await open(page);
    const foot = list(page).locator(".master-detail-list-body > .list-foot");
    await expect(foot).toBeVisible();
    expect(await list(page).locator(".master-detail-list-body").evaluate((body) => body.lastElementChild?.classList.contains("list-foot"))).toBe(true);
    const entry = foot.getByRole("button", { name: "Orphaned Copies", exact: true });
    await expect(entry.locator(".count-badge")).toHaveText("2");
    await expect(entry).toHaveAccessibleDescription("2 copies");
    await entry.click();
    expect(await routePath(page)).toBe("/skills/orphans");
    await expect(page.locator('.master-detail-detail [aria-label="Orphaned Copies"]')).toBeVisible();
    await expect(entry).toHaveAttribute("aria-current", "true");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`hover, selection and keyboard focus are distinct in the ${theme} theme`, async ({ page }) => {
      await open(page, "/skills", theme);
      await row(page, "code-review").click();
      await expect(row(page, "code-review")).toHaveAttribute("aria-current", "true");
      // Focus by keyboard: from the selected row, Tab reaches the next row with a visible ring.
      await page.keyboard.press("Tab");
      await expect(row(page, "qa")).toBeFocused();
      await row(page, "deploy-bot").hover();
      // Rows ease their fill in (--dur-fast); read them once every transition has settled.
      await page.waitForFunction(() => !document.getAnimations().some((animation) => animation instanceof CSSTransition));
      const look = (name: string) => row(page, name).evaluate((element) => {
        const style = getComputedStyle(element);
        const bar = getComputedStyle(element, "::before");
        return { background: style.backgroundColor, ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? style.outlineColor : null, bar: bar.content !== "none" ? bar.width : null };
      });
      const [selected, hovered, ringed, resting] = await Promise.all([look("code-review"), look("deploy-bot"), look("qa"), look("release-notes")]);
      expect(selected.bar, "selection is the accent bar").toBe("2px");
      expect(selected.background).not.toBe(resting.background);
      expect(hovered.background, "hover is a fill step").not.toBe(resting.background);
      expect(hovered.background, "hover is not selection").not.toBe(selected.background);
      expect(hovered.bar).toBeNull();
      expect(ringed.ring, "focus is the ring").not.toBeNull();
      expect(ringed.background, "focus is not selection").toBe(resting.background);
      expect(ringed.bar).toBeNull();
      expect(selected.ring).toBeNull();
    });
  }
});

test("with a coarse pointer on an 834px tablet every row is exactly 64px", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await open(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const rows = await rowGeometry(page);
    expect(rows.map((entry) => entry.height)).toEqual(rows.map(() => 64));
    expect(rows.find((entry) => entry.name === "review-checklist")!.sub).toEqual({ oneLine: true, overflows: true, ellipsis: true });
  } finally {
    await context.close();
  }
});

test.describe("on a 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("no row is highlighted after returning from a detail route", async ({ page }) => {
    await open(page);
    const resting = await row(page, "qa").evaluate((element) => getComputedStyle(element).backgroundColor);
    await row(page, "deploy-bot").tap();
    await expect(page.locator(".detail-bar")).toBeVisible();
    await page.locator(".detail-bar").getByRole("button", { name: "Back to Agent Skills", exact: true }).tap();
    await expect(list(page)).toBeVisible();
    await expect(list(page).locator(".is-selected")).toHaveCount(0);
    const backgrounds = await list(page).locator(".skill-row").evaluateAll((elements) => elements.map((element) => ({
      background: getComputedStyle(element).backgroundColor,
      bar: getComputedStyle(element, "::before").content,
    })));
    expect(new Set(backgrounds.map((entry) => entry.background))).toEqual(new Set([resting]));
    expect(backgrounds.every((entry) => entry.bar === "none")).toBe(true);
  });
});
