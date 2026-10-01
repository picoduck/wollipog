import { expect, test, type Page } from "@playwright/test";

/**
 * The skill detail's one notice slot (#1972; docs/design-system.md §3.3, §9.1, §13.2), in the real
 * Shell with `?skills=notices`: the most urgent thing a skill needs, directly under its header, with
 * its actions under the body (full width on a phone) and menus anchored to the button that opens them.
 */
const skillPath = (id: string) => `/skills/~${Buffer.from(id, "utf16le").toString("base64url")}`;
async function open(page: Page, id: string) {
  await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&history=1&skills=notices&path=${encodeURIComponent(skillPath(id))}`);
  await expect(page.locator(".skill-notice-slot .notice")).toBeVisible();
}

const slot = (page: Page) => page.locator(".skill-notice-slot");
const notice = (page: Page) => slot(page).locator(".notice");
const actions = (page: Page) => notice(page).locator(".notice-actions > .btn");
/** The skill's own rules, as Assignments lists them (#1982). */
const directRows = (page: Page) => page.locator(".skill-assignment-list[aria-label='Direct Assignments'] .skill-assignment-title");

/** Every shown button in the detail, against the width its own label and padding need. */
const stretchedButtons = (page: Page) => page.locator(".master-detail-detail").evaluate((detail) => {
  const stretched: string[] = [];
  for (const button of detail.querySelectorAll<HTMLElement>("button.btn")) {
    if (button.getClientRects().length === 0) continue;
    const width = button.getBoundingClientRect().width;
    const saved = button.style.cssText;
    button.style.cssText += ";width:max-content !important;justify-self:start !important;align-self:start !important;flex:none !important";
    const natural = button.getBoundingClientRect().width;
    button.style.cssText = saved;
    if (width > natural + 1) stretched.push(`${button.textContent?.trim()}: ${Math.round(width)} > ${Math.round(natural)}`);
  }
  return stretched;
});

/** The open menu's box against its trigger and the viewport. */
async function menuPlacement(page: Page, trigger: ReturnType<Page["locator"]>) {
  const menuId = await trigger.getAttribute("aria-controls");
  expect(menuId, "the button controls the menu it opened").toBeTruthy();
  const menu = page.locator(`[id="${menuId}"]`);
  await expect(menu).toBeVisible();
  await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === "running"));
  const [menuBox, triggerBox] = await Promise.all([menu.boundingBox(), trigger.boundingBox()]);
  const viewport = page.viewportSize()!;
  return { menu, menuBox: menuBox!, triggerBox: triggerBox!, viewport };
}

const insideViewport = (box: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }) =>
  box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5;

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a Manual Only rule's error takes the slot over the edited copy, and its menu opens below Change Invocation…", async ({ page }) => {
    await open(page, "skill-n1");
    // Directly under the header.
    await expect(page.locator(".skill-detail-head + .skill-notice-slot")).toHaveCount(1);
    await expect(notice(page).locator(".notice-title")).toHaveText("Codex and Pi Can't Run Manual-Only Skills");
    await expect(notice(page).locator(".notice-body")).toHaveText(
      "They're skipped on Studio Workstation and Travel Laptop. Switch the assignment to Agent Invocable, or limit it to Claude Code.");
    await expect(actions(page)).toHaveText(["Change Invocation…"]);
    await expect(slot(page).locator(".notice")).toHaveCount(1);

    const trigger = notice(page).getByRole("button", { name: "Change Invocation…" });
    await trigger.click();
    const { menu, menuBox, triggerBox, viewport } = await menuPlacement(page, trigger);
    expect(Math.abs(menuBox.y - (triggerBox.y + triggerBox.height) - 4), "4px below its button").toBeLessThanOrEqual(1);
    expect(Math.abs(menuBox.x - triggerBox.x), "aligned to its button's start").toBeLessThanOrEqual(1);
    expect(insideViewport(menuBox, viewport)).toBe(true);
    await expect(menu.getByRole("menuitem")).toHaveText([
      /^Switch to Agent Invocable\s*Agents run it on their own, so Codex and Pi can use it too\.$/,
      /^Limit to Claude Code\s*Stays Manual Only, and the rule covers Claude Code only\.$/,
    ]);
    await menu.getByRole("menuitem", { name: "Switch to Agent Invocable" }).click();
    // The rule is fixed after the refresh, so the edited copy it hid takes the slot.
    await expect(notice(page).locator(".notice-title")).toHaveText("Studio Workstation Has an Edited Copy");
    await expect(slot(page).locator(".notice")).toHaveCount(1);
  });

  test("Limit to Claude Code keeps Manual Only and clears the error", async ({ page }) => {
    await open(page, "skill-n1");
    await notice(page).getByRole("button", { name: "Change Invocation…" }).click();
    await page.getByRole("menuitem", { name: "Limit to Claude Code" }).click();
    await expect(notice(page).locator(".notice-title")).toHaveText("Studio Workstation Has an Edited Copy");
    await expect(directRows(page)).toContainText(["Claude Code on All Machines"]);
  });

  test("every notice's actions sit under its body, left-aligned, and none is wider than its label", async ({ page }) => {
    const titles: Record<string, string> = {
      "skill-n1": "Codex and Pi Can't Run Manual-Only Skills",
      "skill-n2": "Studio Workstation Has an Edited Copy",
      "skill-n3": "Update Held for Review",
      "skill-n4": "Built-In Update Held",
      "skill-n5": "Recommended by Wollipog",
      "skill-n6": "Couldn't Deploy to Studio Workstation",
    };
    for (const [id, title] of Object.entries(titles)) {
      await open(page, id);
      await expect(notice(page).locator(".notice-title")).toHaveText(title);
      expect(await stretchedButtons(page), id).toEqual([]);
      const [body, row] = await Promise.all([notice(page).locator(".notice-body").boundingBox(), notice(page).locator(".notice-actions").boundingBox()]);
      expect(row!.y, `${id}: actions under the body`).toBeGreaterThanOrEqual(body!.y + body!.height - 0.5);
      expect(Math.abs(row!.x - body!.x), `${id}: actions start at the body's edge`).toBeLessThanOrEqual(0.5);
      const first = await actions(page).first().boundingBox();
      expect(Math.abs(first!.x - row!.x), `${id}: the first action starts the row`).toBeLessThanOrEqual(0.5);
      const count = await actions(page).evaluateAll((buttons) => ({
        menus: buttons.filter((button) => button.getAttribute("aria-haspopup") === "menu").length,
        plain: buttons.filter((button) => button.getAttribute("aria-haspopup") !== "menu" && !button.classList.contains("notice-details-toggle")).length,
      }));
      expect(count.menus <= 1 && count.plain <= 2, `${id}: ${JSON.stringify(count)}`).toBe(true);
    }
  });

  test("the edited copy, held Git update and held built-in update say what is held and why", async ({ page }) => {
    await open(page, "skill-n2");
    await expect(notice(page).locator(".notice-body")).toHaveText(
      "Claude Code's copy differs from v3. Updates on that machine wait until you import the edit or restore v3.");
    await expect(actions(page)).toHaveText(["Review Edit…", "Restore Library Version…"]);
    await expect(page.locator("table.skill-deployment").getByRole("heading", { name: "Edited Copies" })).toHaveCount(0);
    await notice(page).getByRole("button", { name: "Restore Library Version…" }).click();
    await expect(page.getByRole("alertdialog").or(page.getByRole("dialog"))).toContainText("The edited copy of “lint-rules”");

    await open(page, "skill-n3");
    await expect(notice(page).locator(".notice-body")).toHaveText(
      "Commit c3d4e5f6a7b8 adds or changes scripts/collect.sh and tool.py. Review it before it deploys.");
    await notice(page).getByRole("button", { name: "Review Update…" }).click();
    await expect(page.getByRole("dialog", { name: "Check for Skill Updates" })).toBeVisible();

    await open(page, "skill-n4");
    await expect(notice(page).locator(".notice-body")).toHaveText(
      "Wollipog 0.30.0 updates this skill, but the latest library version has changes made here, so it waits for your review.");
    // The held update and the recommendation are the slot's; Source states facts only (#1980).
    await expect(page.locator('[aria-label="Built-In Skill"]')).toHaveCount(0);
    const source = page.locator(".skill-detail > section.section").filter({ has: page.getByRole("heading", { name: "Source", exact: true }) });
    await expect(source.locator(".facts dt").first()).toHaveText("Source");
    await expect(source).not.toContainText("Assign");
  });

  test("the recommendation assigns from a menu of machines and dismisses with its close button", async ({ page }) => {
    await open(page, "skill-n5");
    await expect(notice(page).locator(".notice-title")).toHaveText("Recommended by Wollipog");
    await expect(actions(page)).toHaveText(["Assign to All Machines", "Assign to Machine"]);
    await expect(page.getByRole("button", { name: "Dismiss Recommendation", exact: true })).toHaveCount(1);
    await expect(notice(page).locator(".notice-head .notice-dismiss")).toHaveAccessibleName("Dismiss Recommendation");

    const trigger = notice(page).getByRole("button", { name: "Assign to Machine" });
    await trigger.click();
    const { menu, menuBox, triggerBox, viewport } = await menuPlacement(page, trigger);
    expect(Math.abs(menuBox.y - (triggerBox.y + triggerBox.height) - 4)).toBeLessThanOrEqual(1);
    expect(insideViewport(menuBox, viewport)).toBe(true);
    await expect(menu.getByRole("menuitem")).toHaveText([/^Studio Workstation\s*Online$/, /^Travel Laptop\s*Offline$/, "Choose Agents…"]);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    const group = (name: string) => page.locator(".skill-list-group", { has: page.locator(".row-title", { hasText: new RegExp(`^${name}$`) }) });
    await expect(group("orchestrate-issues")).toHaveAttribute("aria-label", "Recommended");
    await notice(page).locator(".notice-dismiss").click();
    await expect(slot(page)).toHaveCount(0);
    await expect(page.locator(".skill-detail-title")).toBeFocused();
    await expect(group("orchestrate-issues")).not.toHaveAttribute("aria-label", "Recommended");
  });

  test("Assign to Machine › a machine assigns the skill there for every agent in one step", async ({ page }) => {
    await open(page, "skill-n5");
    await notice(page).getByRole("button", { name: "Assign to Machine" }).click();
    await page.getByRole("menuitem", { name: "Studio Workstation" }).click();
    await expect(slot(page)).toHaveCount(0);
    await expect(directRows(page)).toHaveText(["All Agents on Studio Workstation"]);
  });
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [id, title] of [["skill-n1", "Codex and Pi Can't Run Manual-Only Skills"], ["skill-n5", "Recommended by Wollipog"]]) {
    test(`${title}: every action is full width`, async ({ page }) => {
      await open(page, id);
      await expect(notice(page).locator(".notice-title")).toHaveText(title);
      const row = (await notice(page).locator(".notice-actions").boundingBox())!;
      for (const box of await actions(page).evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()))) {
        expect(Math.abs(box.width - row.width)).toBeLessThanOrEqual(0.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }

  test("Change Invocation… opens its own menu inside the viewport", async ({ page }) => {
    await open(page, "skill-n1");
    const trigger = notice(page).getByRole("button", { name: "Change Invocation…" });
    await trigger.click();
    const { menu, menuBox, viewport } = await menuPlacement(page, trigger);
    expect(insideViewport(menuBox, viewport)).toBe(true);
    await expect(menu.getByRole("menuitem")).toHaveText([/^Switch to Agent Invocable/, /^Limit to Claude Code/]);
  });
});
