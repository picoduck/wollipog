import { expect, test, type Page } from "@playwright/test";
import { choosePageAction } from "./page-actions.js";
import { installSkillGroupsFixture } from "./skill-groups.fixture.js";

const manageGroups = (page: Page) => page.getByRole("dialog", { name: "Manage Groups" });
const confirmation = (page: Page, title: string) => page.getByRole("dialog", { name: title });

async function createGroup(page: Page, name: string) {
  await manageGroups(page).getByRole("button", { name: "New Group", exact: true }).click();
  await manageGroups(page).getByLabel("Group Name", { exact: true }).fill(name);
  await manageGroups(page).getByRole("button", { name: "Create Group", exact: true }).click();
  await expect(manageGroups(page).locator(".skill-groups-name")).toHaveText(name);
}

async function addRule(page: Page, machine?: string, agent?: string) {
  await manageGroups(page).getByRole("button", { name: "Add Assignment…", exact: true }).click();
  const child = page.getByRole("dialog", { name: "Add Group Assignment" });
  if (machine) {
    await child.getByRole("button", { name: /^Machine:/ }).click();
    await page.getByRole("option", { name: machine }).click();
  }
  if (agent) {
    await child.getByRole("button", { name: /^Agents:/ }).click();
    await page.getByRole("option", { name: agent, exact: true }).click();
  }
  await child.getByRole("button", { name: "Add Assignment", exact: true }).click();
  await expect(child).toHaveCount(0);
}

test("creating another group cannot retain the previously selected group's rules", async ({ page }) => {
  await installSkillGroupsFixture(page);
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  await createGroup(page, "First Group");
  await addRule(page);
  await expect(manageGroups(page).locator(".skill-assignment-title")).toHaveText(["All Agents on All Machines"]);
  await createGroup(page, "Second Group");
  await expect(manageGroups(page).getByText("No assignments. Add one to deploy this group's skills.", { exact: true })).toBeVisible();
  await expect(manageGroups(page).locator(".skill-assignment-title")).toHaveCount(0);
});

test("assignment read failure does not masquerade as an empty group", async ({ page }) => {
  await installSkillGroupsFixture(page);
  await page.route("**/api/skill-groups/created/assignments", route => route.fulfill({ status: 503, json: { error: "Assignments temporarily unavailable" } }));
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  await createGroup(page, "Read Failure");
  const alert = manageGroups(page).getByRole("alert");
  await expect(alert).toContainText("Couldn't Load the Group's Assignments");
  await expect(alert).toContainText("Assignments temporarily unavailable");
  await expect(manageGroups(page).getByRole("button", { name: "Add Assignment…", exact: true })).toBeDisabled();
  await expect(manageGroups(page).getByText(/^No assignments/)).toHaveCount(0);
});

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`group membership and inherited rules at ${width} in ${theme}`, async ({ page }, info) => {
    const fixture = await installSkillGroupsFixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills-removals-e2e.html?groups=1");
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await choosePageAction(page, "Manage Groups…");
    await createGroup(page, "Review Team");
    // Adding a skill asks first; Cancel changes nothing.
    await manageGroups(page).getByRole("button", { name: "Add Skill", exact: true }).click();
    await page.getByRole("menu", { name: "Add Skill" }).getByRole("menuitem", { name: "code-review", exact: true }).click();
    const add = confirmation(page, "Add Skill to Group");
    await expect(add).toContainText("“code-review” joins “Review Team”. The group has no assignments yet, so nothing deploys until it has one.");
    await add.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(fixture.writes.filter(write => write.method === "PUT")).toEqual([]);
    await manageGroups(page).getByRole("button", { name: "Add Skill", exact: true }).click();
    await page.getByRole("menu", { name: "Add Skill" }).getByRole("menuitem", { name: "code-review", exact: true }).click();
    await confirmation(page, "Add Skill to Group").getByRole("button", { name: "Add Skill", exact: true }).click();
    await expect(manageGroups(page).locator(".skill-groups-members .row-title")).toHaveText(["code-review"]);
    await addRule(page, "Build Machine", "Claude");
    await expect(manageGroups(page).locator(".skill-assignment-title")).toHaveText(["Claude on Build Machine"]);
    expect(fixture.writes.find(write => write.path.endsWith("/assignments"))?.body).toEqual({ scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "agent", agentId: "claude" }, invocation: "agent" });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`groups-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // A rule's Enabled applies at once, with no confirmation.
    const enabled = manageGroups(page).getByRole("switch", { name: "Enabled" });
    await enabled.click();
    await expect(enabled).toHaveAttribute("aria-checked", "false");
    await enabled.click();
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await manageGroups(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
    // The group's rule is a read-only row under From Groups (#1982).
    const fromGroups = page.getByRole("region", { name: "From Groups: Review Team" });
    await expect(fromGroups.locator(".skill-assignment-title")).toHaveText(["Claude on Build Machine"]);
    await expect(fromGroups.locator(".skill-assignment-facts")).toHaveText(["Agent Invocable"]);
    await expect(fromGroups.getByRole("switch")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`inherited-${width}-${theme}.png`), fullPage: true });
    // Edit in Groups… opens Manage Groups with the group already selected.
    await fromGroups.getByRole("button", { name: "Edit in Groups…", exact: true }).click();
    await expect(manageGroups(page).locator(".skill-groups-name")).toHaveText("Review Team");
    await manageGroups(page).getByRole("button", { name: "More Actions for Review Team", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete Group…", exact: true }).click();
    const remove = confirmation(page, "Delete Group");
    const name = remove.getByLabel("Type Review Team to Confirm", { exact: true });
    await expect(name).toBeFocused();
    await expect(remove.getByRole("button", { name: "Delete Group", exact: true })).toBeDisabled();
    await name.fill("Review Team");
    await remove.getByRole("button", { name: "Delete Group", exact: true }).click();
    // The next group takes its place; a phone returns to the list.
    await expect(manageGroups(page).locator(".skill-groups-list > .row")).toHaveText([/^Legacy Tools/]);
    await expect(manageGroups(page).getByRole("alert")).toHaveCount(0);
    expect(fixture.writes.at(-1)).toMatchObject({ method: "DELETE", path: "/api/skill-groups/created" });
    await manageGroups(page).getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".skill-assignments-group")).toHaveCount(0);
    // The skill stays open; on a phone it is its own screen, named in the detail bar (#1947, #1962).
    await expect(page.locator(".skill-detail-head, .detail-bar").getByRole("heading", { name: "code-review", exact: true })).toBeVisible();
  });
}

test("legacy conversion is explicit and discloses permanent ownership", async ({ page }) => {
  const { writes } = await installSkillGroupsFixture(page);
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  await expect(manageGroups(page).locator(".skill-groups-name")).toHaveText("Legacy Tools");
  const notice = manageGroups(page).locator(".notice");
  await expect(notice).toContainText("This Group Has No Owner");
  await expect(notice).toContainText("Converting makes it shared with your organization.");
  await notice.getByRole("button", { name: "Convert Group…", exact: true }).click();
  const convert = confirmation(page, "Convert Group");
  await expect(convert).toContainText("“Legacy Tools” becomes shared with your organization for good");
  await convert.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(writes).toHaveLength(0);
  await notice.getByRole("button", { name: "Convert Group…", exact: true }).click();
  await confirmation(page, "Convert Group").getByRole("button", { name: "Convert Group", exact: true }).click();
  await expect(manageGroups(page).getByRole("button", { name: "Add Assignment…", exact: true })).toBeEnabled();
  await expect(manageGroups(page).getByRole("button", { name: "Convert Group…", exact: true })).toHaveCount(0);
  await expect(manageGroups(page).locator(".skill-groups-owner")).toHaveText("Shared with your organization");
});

test("failed conversion preserves the legacy group and surfaces the server error", async ({ page }) => {
  await installSkillGroupsFixture(page);
  await page.route("**/api/skill-groups/legacy/convert", route => route.fulfill({ status: 409, json: { error: "Members have different ownership. No changes saved." } }));
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  await manageGroups(page).getByRole("button", { name: "Convert Group…", exact: true }).click();
  await confirmation(page, "Convert Group").getByRole("button", { name: "Convert Group", exact: true }).click();
  await expect(manageGroups(page).getByRole("alert")).toContainText("No changes saved");
  await expect(manageGroups(page).getByRole("button", { name: "Add Assignment…", exact: true })).toHaveCount(0);
  await expect(manageGroups(page).getByRole("button", { name: "Convert Group…", exact: true })).toBeVisible();
});

test("a change shows a spinner on its own control only, and the body keeps its height", async ({ page }) => {
  await installSkillGroupsFixture(page, { library: "full" });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/skills/skill-2", async route => {
    if (route.request().method() === "PUT") await held;
    await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  const dialog = manageGroups(page);
  // The first group is selected; ownership is words, never an id.
  await expect(dialog.locator(".skill-groups-list > .row")).toHaveText([/^Review Team3 skills$/, /^Platform ToolsNo skills$/, /^My DraftsNo skills$/, /^Legacy ToolsNo owner$/]);
  await expect(dialog.locator(".skill-groups-owner")).toHaveText("Shared with your organization");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog).not.toContainText("Accept Group-Wide Deployment and Ownership Impact");
  await dialog.locator(".skill-groups-list > .row").nth(1).click();
  await expect(dialog.locator(".skill-groups-owner")).toHaveText("Shared with Platform");
  await dialog.locator(".skill-groups-list > .row").nth(2).click();
  await expect(dialog.locator(".skill-groups-owner")).toHaveText("Only you");
  await expect(dialog).not.toContainText(/demo-org|team-platform|user-1/);
  await dialog.locator(".skill-groups-list > .row").first().click();

  const body = dialog.locator(".modal-body");
  const before = await body.evaluate(element => element.getBoundingClientRect().height);
  const removeLint = dialog.locator(".skill-groups-members .row", { hasText: "lint-fix" }).getByRole("button", { name: "Remove…", exact: true });
  await removeLint.click();
  const remove = confirmation(page, "Remove Skill from Group");
  await expect(remove).toContainText("“lint-fix” leaves “Review Team”");
  await expect(remove.locator(".confirmation-rows .row-title")).toHaveText(["Claude on Build Machine", "All Agents on All Machines"]);
  await remove.getByRole("button", { name: "Remove Skill", exact: true }).click();
  await expect(removeLint).toHaveAttribute("aria-busy", "true");
  await expect(dialog.locator("[aria-busy='true']")).toHaveCount(1);
  await expect(dialog.locator(".spinner")).toHaveCount(1);
  await expect(dialog.getByText(/Loading/)).toHaveCount(0);
  expect(await body.evaluate(element => element.getBoundingClientRect().height)).toBe(before);
  release();
  await expect(dialog.locator(".skill-groups-members .row-title")).toHaveText(["docs-writer", "test-triage"]);
  await expect(dialog.locator("[aria-busy='true']")).toHaveCount(0);
  expect(await body.evaluate(element => element.getBoundingClientRect().height)).toBe(before);
  await expect(dialog.locator(".skill-groups-members").getByRole("button", { name: "Remove…" }).first()).toBeFocused();
});

for (const width of [1440, 390]) test(`the dialog's in-place menus at ${width} have no containing block between them and the viewport`, async ({ page }) => {
  await installSkillGroupsFixture(page, { library: "full" });
  await page.setViewportSize({ width, height: width > 760 ? 900 : 844 });
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  const dialog = manageGroups(page);
  // A phone opens the group as the sheet's second step, where each menu is a bottom sheet.
  if (width <= 760) await dialog.locator(".skill-groups-list > .row").first().click();
  await expect(dialog.locator(".skill-assignment")).toHaveCount(2);
  // At the build floor (§2.10) a size container, a transform or layout containment between an
  // in-place menu and the viewport becomes its fixed containing block and moves it off its trigger.
  const triggers = [
    dialog.getByRole("button", { name: "Add Skill", exact: true }),
    dialog.getByRole("button", { name: "More Actions for Review Team", exact: true }),
    dialog.locator('[data-rule-control="invocation"]').first(),
    dialog.locator('[data-rule-control="more"]').first(),
  ];
  for (const trigger of triggers) {
    await trigger.click();
    const menu = page.locator(`#${await trigger.getAttribute("aria-controls")}`);
    await expect(menu).toBeVisible();
    const boxes = await menu.evaluate((element, triggerId) => {
      const containing: string[] = [];
      for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.containerType !== "normal" || /layout|paint|strict|content/.test(style.contain) || style.transform !== "none" || style.filter !== "none") {
          containing.push(node.className);
        }
      }
      const button = document.querySelector(`[aria-controls="${triggerId}"]`)!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return { containing, gap: Math.round(box.top - button.bottom), right: Math.round(button.right - box.right) };
    }, await trigger.getAttribute("aria-controls"));
    expect(boxes.containing).toEqual([]);
    if (width > 760) {
      expect(boxes.gap).toBeGreaterThanOrEqual(0);
      expect(boxes.gap).toBeLessThanOrEqual(12);
      expect(Math.abs(boxes.right)).toBeLessThanOrEqual(2);
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  await expect(dialog).toBeVisible();
});

// The guard above keeps containment out of this dialog's own styles, but a containing block can still
// form between an in-place menu and the viewport: a floor engine's size container, or a dialog's
// transform while it animates (#2284). Layout containment forced on the dialog's body stands in for
// one; each menu must still open beside its trigger and dismiss on a click away from it. A phone sheet
// keeps docking inside that body, which clips it, so every item stays where a finger can reach it.
for (const width of [1440, 390]) test(`the dialog's in-place menus at ${width} open beside their triggers under a fixed containing block`, async ({ page }) => {
  await installSkillGroupsFixture(page, { library: "full" });
  const height = width > 760 ? 900 : 844;
  await page.setViewportSize({ width, height });
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  const dialog = manageGroups(page);
  if (width <= 760) await dialog.locator(".skill-groups-list > .row").first().click();
  await expect(dialog.locator(".skill-assignment")).toHaveCount(2);
  await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === "running"));
  await page.addStyleTag({ content: ".skill-groups-body { contain: layout !important; }" });
  const body = await dialog.locator(".skill-groups-body").evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px";
    element.appendChild(probe);
    const fixed = probe.getBoundingClientRect();
    probe.remove();
    const own = element.getBoundingClientRect();
    return { probe: { x: fixed.left, y: fixed.top }, box: { x: own.left, y: own.top, bottom: own.bottom } };
  });
  expect(body.probe, "the dialog's body is the fixed containing block").toEqual({ x: body.box.x, y: body.box.y });
  expect(body.box.x + body.box.y, "it is offset from the viewport, so an uncorrected menu would move").toBeGreaterThan(0);

  const triggers = [
    dialog.getByRole("button", { name: "Add Skill", exact: true }),
    dialog.getByRole("button", { name: "More Actions for Review Team", exact: true }),
    dialog.locator('[data-rule-control="invocation"]').first(),
    dialog.locator('[data-rule-control="more"]').first(),
  ];
  for (const [index, trigger] of triggers.entries()) {
    await trigger.click();
    const menu = page.locator(`#${await trigger.getAttribute("aria-controls")}`);
    await expect(menu).toBeVisible();
    await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === "running"));
    if (process.env.EVIDENCE_DIR) {
      await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/inline-menu-contained-${width}-${index + 1}.png` });
    }
    const boxes = await menu.evaluate((element, triggerId) => {
      const button = document.querySelector(`[aria-controls="${triggerId}"]`)!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const backdrop = element.previousElementSibling!.getBoundingClientRect();
      const items = [...element.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
      return {
        contained: Boolean(element.closest(".skill-groups-body")),
        gap: Math.round(box.top - button.bottom),
        right: Math.round(button.right - box.right),
        backdrop: [backdrop.left, backdrop.top, backdrop.right, backdrop.bottom].map(Math.round),
        items: items.length,
        // The topmost element at each item's centre is that item: nothing clips or covers it.
        reachable: items.every((item) => {
          const rect = item.getBoundingClientRect();
          return item.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        }),
      };
    }, await trigger.getAttribute("aria-controls"));
    expect(boxes.contained, "the menu is under the containing block").toBe(true);
    expect(boxes.items).toBeGreaterThan(0);
    expect(boxes.reachable, "no item is clipped or covered").toBe(true);
    if (width > 760) {
      expect(boxes.gap, "the menu opens 4px below its trigger").toBe(4);
      expect(Math.abs(boxes.right), "and end-aligned with it").toBeLessThanOrEqual(2);
      expect(boxes.backdrop, "the backdrop covers the whole viewport").toEqual([0, 0, width, height]);
    }
    // A click away from the menu lands on its backdrop and dismisses it. (The dialog's scrolling body
    // still clips anything under a containing block inside it, the backdrop included.)
    const [x, y] = [body.box.x + 8, body.box.y + 8];
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.className, [x, y])).toBe("menu-backdrop");
    await page.mouse.click(x, y);
    await expect(menu).toHaveCount(0);
  }
  await expect(dialog).toBeVisible();
});

test("at 390px the list and the group are two steps of one sheet, with Back and one Done", async ({ page }) => {
  await installSkillGroupsFixture(page, { library: "full" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  const dialog = manageGroups(page);
  await expect(dialog.locator(".skill-groups-list > .row")).toHaveCount(4);
  await expect(dialog.locator(".skill-groups-pane.detail")).toHaveCount(0);
  await expect(dialog.locator(".modal-foot button")).toHaveText(["Done"]);
  await dialog.locator(".skill-groups-list > .row").first().click();
  await expect(dialog.locator(".skill-groups-pane.list")).toHaveCount(0);
  await expect(dialog.locator(".skill-groups-name")).toHaveText("Review Team");
  const back = dialog.getByRole("button", { name: "Back to Groups", exact: true });
  await expect(back).toBeFocused();
  await expect(dialog.locator(".modal-foot button")).toHaveText(["Done"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await back.click();
  await expect(dialog.locator(".skill-groups-list > .row")).toHaveCount(4);
});

test("at 390px Back from the keyboard returns focus to the chosen group, and to the dialog while a change runs (#2368)", async ({ page }) => {
  await installSkillGroupsFixture(page, { library: "full" });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/skills/skill-2", async route => {
    if (route.request().method() === "PUT") await held;
    await route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/skills-removals-e2e.html?groups=1");
  await choosePageAction(page, "Manage Groups…");
  const dialog = manageGroups(page);
  const rows = dialog.locator(".skill-groups-list > .row");
  const back = dialog.getByRole("button", { name: "Back to Groups", exact: true });
  // Choosing Platform Tools from the keyboard shows the group with focus on Back; Back returns it to
  // that row, so the second Enter opens the group again rather than closing the dialog through the
  // header button, now Close.
  await rows.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".skill-groups-name")).toHaveText("Platform Tools");
  await expect(back).toBeFocused();

  // While a change runs every row is disabled: Back leaves focus on the dialog, and Enter there
  // closes nothing. Once the change lands, focus moves to the chosen row.
  await page.keyboard.press("Enter");
  await rows.first().focus();
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".skill-groups-name")).toHaveText("Review Team");
  await dialog.locator(".skill-groups-members .row", { hasText: "lint-fix" }).getByRole("button", { name: "Remove…", exact: true }).click();
  await confirmation(page, "Remove Skill from Group").getByRole("button", { name: "Remove Skill", exact: true }).click();
  await expect(dialog.locator("[aria-busy='true']")).toHaveCount(1);
  await back.focus();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toBeDisabled();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  release();
  await expect(rows.first()).toBeEnabled();
  await expect(rows.first()).toBeFocused();
  await expect(dialog).toBeVisible();
});
