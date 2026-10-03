import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

// One dialog anatomy with a phone sheet (docs/design-system.md §7, #1800), measured in a browser.

async function openSessions(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/command-inbox-projects-e2e.html");
  await expect(page.getByRole("tab", { name: /Alpha/ })).toBeVisible();
}

async function openProjectMenu(page: Page) {
  await page.getByRole("tab", { name: /Alpha/ }).hover();
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
}

async function anatomy(dialog: Locator) {
  return dialog.evaluate((panel) => {
    const card = panel.closest(".modal")!;
    const backdrop = card.parentElement!;
    const style = (selector: string) => {
      const element = panel.querySelector(selector);
      return element ? getComputedStyle(element) : null;
    };
    const title = style(".modal-title")!;
    const body = style(".modal-body")!;
    const foot = style(".modal-foot");
    const cardBox = card.getBoundingClientRect();
    return {
      backdropParentIsBody: backdrop.parentElement === document.body,
      backdropFilter: getComputedStyle(backdrop).backdropFilter,
      width: Math.round(cardBox.width),
      bottomGap: Math.round(window.innerHeight - cardBox.bottom),
      title: `${title.fontSize} ${title.fontWeight}`,
      // Above the header's hairline.
      header: panel.querySelector(".modal-head")!.clientHeight,
      bodyPadding: body.padding,
      bodyMinHeight: body.minHeight,
      footPadding: foot?.padding ?? null,
      footGap: foot?.columnGap ?? null,
    };
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Rename Project from a project tab's menu is a full 560px dialog portalled to <body>", async ({ page }) => {
    await openSessions(page);
    await openProjectMenu(page);
    await page.getByRole("menuitem", { name: /^Rename Project/ }).click();
    const dialog = page.getByRole("dialog", { name: "Rename Project" });
    await expect(dialog.getByRole("heading", { name: "Rename Project" })).toBeVisible();
    await dialogMotionSettled(page);
    expect(await anatomy(dialog)).toMatchObject({
      backdropParentIsBody: true,
      backdropFilter: "none",
      width: 560,
      title: "16px 600",
      header: 56,
      bodyPadding: "20px",
      bodyMinHeight: "0px",
      footPadding: "16px 20px",
      footGap: "8px",
    });
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveClass("btn");
  });

  test("a destructive confirmation is 400px with the warning icon, a solid danger button and Cancel focused", async ({ page }) => {
    await openSessions(page);
    await openProjectMenu(page);
    await page.getByRole("menuitem", { name: /^Archive/ }).click();
    const dialog = page.getByRole("dialog").last();
    await dialogMotionSettled(page);
    expect((await anatomy(dialog)).width).toBe(400);
    await expect(dialog.getByRole("heading")).not.toHaveText(/\?$/);
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    const confirm = dialog.locator(".modal-foot .btn").last();
    const toneIcon = dialog.locator(".modal-tone-icon");
    if (await toneIcon.count()) {
      await expect(confirm).toHaveClass(/\bdanger\b/);
      expect(await toneIcon.evaluate((icon) => getComputedStyle(icon).color))
        .toBe(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--red").trim()).then((red) =>
          page.evaluate((value) => {
            const probe = document.createElement("span");
            probe.style.color = value;
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          }, red)));
    }
  });

  test("Delete Project focuses its name field and stays disabled until the name matches", async ({ page }) => {
    await openSessions(page);
    await openProjectMenu(page);
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    await page.getByRole("button", { name: /Alpha/ }).first().click();
    await page.getByRole("button", { name: "Delete Project" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Project" });
    await dialogMotionSettled(page);
    expect((await anatomy(dialog)).width).toBe(400);
    await expect(dialog.getByLabel("Type Alpha to Confirm")).toBeFocused();
    const confirm = dialog.getByRole("button", { name: "Delete Project" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type Alpha to Confirm").fill("Alph");
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type Alpha to Confirm").fill("Alpha");
    await expect(confirm).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveClass("btn");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a form dialog is a full-width bottom sheet with a grabber, a 48px header and equal 48px footer buttons", async ({ page }) => {
    await openSessions(page);
    await openProjectMenu(page);
    await page.getByRole("menuitem", { name: /^Rename Project/ }).click();
    const dialog = page.getByRole("dialog", { name: "Rename Project" });
    await expect(dialog).toBeVisible();
    await dialogMotionSettled(page);
    const layout = await anatomy(dialog);
    expect(layout).toMatchObject({ backdropParentIsBody: true, width: 390, bottomGap: 0, header: 48 });
    const grabber = await page.locator(".modal .sheet-grabber").boundingBox();
    expect([grabber?.width, grabber?.height]).toEqual([36, 4]);
    await expect(page.locator(".modal .sheet-grabber")).toHaveAttribute("aria-hidden", "true");
    const buttons = await dialog.locator(".modal-foot .btn").evaluateAll((elements) =>
      elements.map((element) => [element.textContent, Math.round(element.getBoundingClientRect().width), element.getBoundingClientRect().height]));
    expect(buttons.map(([label]) => label)).toEqual(["Cancel", "Save"]);
    expect(buttons[0]![1]).toBe(buttons[1]![1]);
    expect(buttons.map(([, , height]) => height)).toEqual([48, 48]);
    const close = await dialog.getByRole("button", { name: "Close" }).evaluate((button) => {
      const hit = getComputedStyle(button, "::after");
      const box = button.getBoundingClientRect();
      return Math.round(box.height - 2 * Number.parseFloat(hit.top));
    });
    expect(close).toBeGreaterThanOrEqual(44);
  });

  test("New Session opens as a full-height sheet with a back arrow and no grabber", async ({ page }) => {
    await openSessions(page);
    await openProjectMenu(page);
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    await expect(dialog).toBeVisible();
    await dialogMotionSettled(page);
    const card = await page.locator(".modal").boundingBox();
    expect([card?.y, card?.height]).toEqual([0, 844]);
    await expect(page.locator(".modal .sheet-grabber")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Back" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
  });

  test("Delete Team takes over the Manage Team sheet and Back returns with its values", async ({ page }) => {
    await page.goto("/people-devices-e2e.html");
    await page.getByRole("region", { name: "Teams" }).locator(".access-row").first().getByRole("button", { name: "Manage" }).click();
    const manage = page.getByRole("dialog", { name: "Manage Support" });
    await expect(manage).toBeVisible();
    const member = manage.getByRole("checkbox").first();
    const checked = await member.isChecked();
    await member.setChecked(!checked);

    // On a phone the destructive tertiary is a full-width row at the end of the body.
    const deleteTeam = manage.locator(".modal-body > .modal-tertiary").getByRole("button", { name: "Delete Team" });
    await deleteTeam.click();

    const confirmation = page.getByRole("dialog", { name: "Delete Team" });
    await expect(confirmation).toBeVisible();
    await expect(page.locator(".modal")).toHaveCount(1);
    await expect(page.locator(".modal-backdrop")).toHaveCount(1);
    await expect(manage).toBeHidden();
    const back = confirmation.getByRole("button", { name: "Back to Manage Support" });
    await expect(back).toBeVisible();
    await expect(confirmation.locator(".modal-foot .btn.danger")).toHaveText("Delete Team");

    await back.click();
    await expect(confirmation).toHaveCount(0);
    await expect(manage).toBeVisible();
    await expect(manage.getByRole("checkbox").first()).toBeChecked({ checked: !checked });
  });

  test("the composer's model-settings sheet shows the same 36px grabber", async ({ page }) => {
    await page.goto("/session-usage-e2e.html?width=390&height=804&composer=orchestrator");
    await expect(page.locator(".composer-box")).toBeVisible();
    await page.locator(".composer-idle-preview").click();
    await page.getByRole("button", { name: /^Model Settings:/ }).click();
    const grabber = page.locator('.menu[aria-label="Model Settings"] .sheet-grabber');
    await expect(grabber).toBeVisible();
    await expect(grabber).toHaveAttribute("aria-hidden", "true");
    const box = await grabber.boundingBox();
    expect([box?.width, box?.height]).toEqual([36, 4]);
  });
});

test.describe("desktop stacking", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Delete Team stacks over Manage Team under one dim", async ({ page }) => {
    await page.goto("/people-devices-e2e.html");
    await page.getByRole("region", { name: "Teams" }).locator(".access-row").first().getByRole("button", { name: "Manage" }).click();
    const manage = page.getByRole("dialog", { name: "Manage Support" });
    await manage.locator(".modal-foot .modal-tertiary").getByRole("button", { name: "Delete Team" }).click();
    const confirmation = page.getByRole("dialog", { name: "Delete Team" });
    await expect(confirmation).toBeVisible();
    await expect(manage).toBeVisible();
    await expect(page.locator(".modal")).toHaveCount(2);
    expect(await page.locator(".modal-backdrop").evaluateAll((layers) =>
      layers.map((layer) => [layer.parentElement === document.body, getComputedStyle(layer).backgroundColor !== "rgba(0, 0, 0, 0)"])))
      .toEqual([[true, true], [true, false]]);
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect(manage.getByRole("button", { name: "Delete Team" })).toBeFocused();
  });
});
