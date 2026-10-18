import { expect, test, type Locator, type Page } from "@playwright/test";
import { openProjectActions, SESSIONS_HEADER } from "./session-groups.js";

/**
 * A project's Settings and Child Session Defaults as setting rows saved by one save bar (#2962;
 * docs/design-system.md §8.2, §8.3, §8.5, §8.6).
 */
test.use({ video: "on" });

async function openAlpha(page: Page, width: number, theme: string, childSessionDefaults: { costBudgetUsd: number; maxToolCalls: number } | null) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(SESSIONS_HEADER)).toBeVisible();
  await page.evaluate(({ value, defaults }) => {
    document.documentElement.dataset.theme = value;
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { childSessionDefaults: defaults });
  }, { value: theme, defaults: childSessionDefaults });
  await openProjectActions(page, /Alpha/, "Alpha");
  await page.getByRole("menuitem", { name: /Manage Project/ }).click();
  const section = page.getByRole("region", { name: "Child Session Defaults" });
  await expect(section).toBeVisible();
  return {
    section,
    cost: section.getByRole("textbox", { name: "Cost Limit per Child USD" }),
    tools: section.getByRole("textbox", { name: "Tool Calls per Child" }),
    clear: section.getByRole("button", { name: "Clear Limits" }),
    bar: page.locator(".project-detail > .save-bar"),
  };
}

const savedDefaults = (page: Page) => page.evaluate(() =>
  window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().projects.find((project) => project.id === "alpha")!.childSessionDefaults);

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`project child limits failures keep the draft and recover with Try Again ${width} ${theme}`, async ({ page }) => {
    const { cost, tools, clear, bar } = await openAlpha(page, width, theme, { costBudgetUsd: 5, maxToolCalls: 100 });
    await cost.fill("2.5");
    await tools.fill("30");
    await expect(bar).toContainText("Unsaved changes");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextProjectUpdate());
    await bar.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(bar).toHaveClass(/is-error/);
    await expect(bar).toContainText("Couldn't save the changes. Nothing was changed.");
    await expect(cost).toHaveValue("2.5");
    await expect(tools).toHaveValue("30");
    await expect(cost).toBeEditable();
    expect(await savedDefaults(page)).toEqual({ costBudgetUsd: 5, maxToolCalls: 100 });
    await bar.getByRole("button", { name: "Try Again" }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await savedDefaults(page)).toEqual({ costBudgetUsd: 2.5, maxToolCalls: 30 });

    await clear.click();
    await expect(cost).toHaveValue("");
    await expect(tools).toHaveValue("");
    await expect(clear).toHaveCount(0);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextProjectUpdate());
    await bar.getByRole("button", { name: "Save" }).click();
    await expect(bar).toContainText("Couldn't save the changes. Nothing was changed.");
    await expect(cost).toHaveValue("");
    expect(await savedDefaults(page)).toEqual({ costBudgetUsd: 2.5, maxToolCalls: 30 });
    await bar.getByRole("button", { name: "Try Again" }).click();
    await expect(bar).toHaveCount(0);
    expect(await savedDefaults(page)).toBeNull();
    await expect(clear).toHaveCount(0);
  });

  test(`project child limits keep a draft over outside changes and follow them while clean ${width} ${theme}`, async ({ page }, testInfo) => {
    const { section, cost, tools, clear, bar } = await openAlpha(page, width, theme, null);
    await expect(clear).toHaveCount(0);
    await section.screenshot({ path: testInfo.outputPath("before.png") });
    await cost.fill("2.5");
    await tools.fill("30");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha",
      { childSessionDefaults: { costBudgetUsd: 9, maxToolCalls: 90 } }));
    await expect(cost).toHaveValue("2.5");
    await expect(tools).toHaveValue("30");
    await bar.getByRole("button", { name: "Save" }).click();
    await expect(bar).toHaveCount(0);
    await expect(clear).toBeVisible();
    await section.screenshot({ path: testInfo.outputPath("after.png") });
    await page.reload();
    await openProjectActions(page, /Alpha/, "Alpha");
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    await expect(cost).toHaveValue("2.5");
    await expect(tools).toHaveValue("30");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha",
      { childSessionDefaults: { costBudgetUsd: 0.005, maxToolCalls: 10 } }));
    await expect(cost).toHaveValue("0.005");
    await expect(tools).toHaveValue("10");
  });

  test(`-2 in Cost Limit per Child shows its field error with no browser bubble, and blocks Save until fixed ${width} ${theme}`, async ({ page }) => {
    const { section, cost, tools, bar } = await openAlpha(page, width, theme, null);
    const costRow = section.locator(".setting-row").filter({ has: page.getByRole("textbox", { name: "Cost Limit per Child USD" }) });
    await cost.fill("-2");
    await expect(costRow.locator(".field-error")).toHaveCount(0);
    await cost.press("Tab");
    await expect(costRow.locator(".setting-row-desc-slot .field-error")).toHaveText("Enter an amount above 0.");
    await expect(costRow.locator(".setting-row-desc-slot > .setting-row-desc").first()).toBeHidden();
    await expect(cost).toHaveAttribute("aria-invalid", "true");
    expect(await cost.evaluate((input: HTMLInputElement) => input.validationMessage), "no native validation").toBe("");
    const save = bar.getByRole("button", { name: "Save" });
    await expect(bar).toContainText("Fix 1 field to save");
    await expect(save).toHaveAttribute("aria-disabled", "true");
    // `aria-disabled` keeps it focusable and pressable (§8.6); a press saves nothing.
    await save.click({ force: true });
    await expect(bar).toContainText("Fix 1 field to save");
    expect(await savedDefaults(page)).toBeNull();
    await cost.fill("2");
    await tools.fill("40");
    await expect(costRow.locator(".field-error")).toHaveCount(0);
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
    await save.click();
    await expect(bar).toHaveCount(0);
    expect(await savedDefaults(page)).toEqual({ costBudgetUsd: 2, maxToolCalls: 40 });
  });
}

test("both limit fields are 96px wide, and the cost field holds USD inside it", async ({ page }) => {
  const { cost, tools } = await openAlpha(page, 1280, "dark", { costBudgetUsd: 5, maxToolCalls: 100 });
  for (const field of [cost, tools]) expect((await field.boundingBox())!.width).toBe(96);
  const unit = cost.locator("xpath=following-sibling::*[contains(@class, 'input-affix-text')]");
  await expect(unit).toHaveText("USD");
  const [fieldBox, unitBox] = [(await cost.boundingBox())!, (await unit.boundingBox())!];
  expect(unitBox.x).toBeGreaterThan(fieldBox.x);
  expect(unitBox.x + unitBox.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width);
  await expect(cost).toHaveAttribute("placeholder", "No limit");
});

/** The access fixture (`?projects=access`): Alpha is shared with Builders. */
const accessShell = (path: string) =>
  `/command-inbox-projects-e2e.html?fullShell=1&history=1&path=${encodeURIComponent(path)}&projects=access`;
const alphaPath = `/projects/~${Buffer.from("alpha", "utf16le").toString("base64url")}`;

async function settingsRows(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(accessShell(alphaPath));
  await page.evaluate(() => localStorage.clear());
  await page.goto(accessShell(alphaPath));
  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings.getByRole("button", { name: /^Change…/ })).toBeVisible();
  return {
    settings,
    name: settings.getByRole("textbox", { name: "Name", exact: true }),
    change: settings.getByRole("button", { name: /^Change…/ }),
    track: settings.getByRole("switch", { name: "Show as a Sessions Tab" }).locator(".ui-switch"),
  };
}
const right = async (locator: Locator) => { const box = (await locator.boundingBox())!; return box.x + box.width; };

test("at 1440px Name, Access and Show as a Sessions Tab are setting rows sharing one 240px control column", async ({ page }) => {
  const { settings, name, change, track } = await settingsRows(page, 1440);
  await expect(settings.locator(".setting-row-title")).toHaveText(["Name", "Team: Builders", "Show as a Sessions Tab"]);
  expect((await name.boundingBox())!.width).toBe(240);
  const edge = await right(name);
  expect(await right(change)).toBeCloseTo(edge, 0);
  expect(await right(track)).toBeCloseTo(edge, 0);
  const nameRow = settings.locator(".setting-row").filter({ has: page.getByRole("textbox", { name: "Name", exact: true }) });
  const title = (await nameRow.locator(".setting-row-title").boundingBox())!;
  expect((await name.boundingBox())!.x, "the control sits beside its text").toBeGreaterThan(title.x + title.width);
});

test("in an 834px window the Settings controls stack under their text", async ({ page }) => {
  const { settings, name, change, track } = await settingsRows(page, 834);
  const nameRow = settings.locator(".setting-row").filter({ has: page.getByRole("textbox", { name: "Name", exact: true }) });
  const [row, text, field] = [
    (await nameRow.boundingBox())!,
    (await nameRow.locator(".setting-row-text").boundingBox())!,
    (await name.boundingBox())!,
  ];
  expect(field.y, "the field drops under its text").toBeGreaterThanOrEqual(text.y + text.height);
  expect(field.width, "at the row's full width").toBeCloseTo(row.width - 32, 0);
  // A switch and an action keep their control trailing beside the text (§8.2, Narrow).
  expect(await right(change)).toBeCloseTo(row.x + row.width - 16, 0);
  expect(await right(track)).toBeCloseTo(row.x + row.width - 16, 0);
});
