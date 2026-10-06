import { expect, test, type Page } from "@playwright/test";

const SHOT = "test-results/session-live-child-limit";

async function openSession(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html?scenario=live-child-limit");
  await page.evaluate(() => {
    localStorage.clear();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      maxChildSessions: 6,
    });
  });
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-bar")).toBeVisible();
}

async function openGuardrails(page: Page) {
  await page.getByRole("button", { name: "Attach and Settings" }).click();
  await page.getByRole("menuitem", { name: "Guardrails…" }).click();
  const dialog = page.getByRole("dialog", { name: "Guardrails" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function liveChildLimit(page: Page) {
  return page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
    .find((session) => session.id === "session-alpha")?.maxChildSessions);
}

test("the Guardrails dialog saves the live-child limit, keeps it when emptied, and pauses children at 0", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openSession(page);

  await page.getByRole("button", { name: "Attach and Settings" }).click();
  const menu = page.locator('.menu[aria-label="Attach and Settings"]');
  await expect(menu.getByRole("menuitem", { name: "Guardrails…" })).toHaveAccessibleDescription("Up to 6 live children.");
  await expect(menu.locator("input")).toHaveCount(0);
  await expect(menu.getByRole("button", { name: /^About / })).toHaveCount(0);
  await page.keyboard.press("Escape");

  let dialog = await openGuardrails(page);
  const input = dialog.getByRole("textbox", { name: "Live Child Limit" });
  await expect(input).toHaveValue("6");
  await expect(input).toHaveAccessibleDescription(/^How many child sessions can run at once\. Set 0 to pause new children\./);
  await page.screenshot({ path: `${SHOT}/desktop.png` });

  await input.fill("9");
  await dialog.getByRole("button", { name: "Save Guardrails" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => liveChildLimit(page)).toBe(9);

  // Empty keeps the current limit: 0, not empty, is how new children are paused.
  dialog = await openGuardrails(page);
  await dialog.getByRole("textbox", { name: "Live Child Limit" }).fill("");
  await dialog.getByRole("button", { name: "Save Guardrails" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await liveChildLimit(page)).toBe(9);

  dialog = await openGuardrails(page);
  await dialog.getByRole("textbox", { name: "Live Child Limit" }).fill("0");
  await dialog.getByRole("button", { name: "Save Guardrails" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => liveChildLimit(page)).toBe(0);
  await page.getByRole("button", { name: "Attach and Settings" }).click();
  await expect(page.getByRole("menuitem", { name: "Guardrails…" })).toHaveAccessibleDescription("New children paused.");
});

test("a typo keeps the Guardrails dialog open with the error in place of the helper", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openSession(page);
  const dialog = await openGuardrails(page);
  const recurring = dialog.getByRole("textbox", { name: "Recurring Cost Threshold" });
  await recurring.fill("1e");
  await dialog.getByRole("button", { name: "Save Guardrails" }).click();
  await expect(dialog).toBeVisible();
  await expect(recurring).toHaveAttribute("aria-invalid", "true");
  await expect(recurring).toBeFocused();
  await expect(recurring).toHaveAccessibleDescription("Enter an amount like 5 or 2.50.");
  await recurring.fill("5");
  await expect(recurring).not.toHaveAttribute("aria-invalid", "true");
});

test("at 390×844 Guardrails is a bottom sheet with full-width fields and a footer that stays visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSession(page);
  const dialog = await openGuardrails(page);
  await expect(dialog.locator(".input-affix").first()).toBeVisible();
  const sheet = await dialog.boundingBox();
  expect(sheet).not.toBeNull();
  expect(sheet!.width).toBeGreaterThanOrEqual(389);
  expect(sheet!.y + sheet!.height).toBeGreaterThanOrEqual(843);

  const body = dialog.locator(".modal-body");
  const bodyBox = await body.boundingBox();
  for (const label of ["Recurring Cost Threshold", "Cost Checkpoints", "Tool-Call Threshold", "Live Child Limit"]) {
    const box = await dialog.getByRole("textbox", { name: label }).boundingBox();
    expect(box, label).not.toBeNull();
    // Full width: the field spans the body less its padding on each side.
    expect(box!.width, `${label} is full width`).toBeGreaterThanOrEqual(bodyBox!.width - 2 * 24);
  }

  // A short viewport makes the body scroll; the footer's buttons stay on screen throughout.
  await page.setViewportSize({ width: 390, height: 520 });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const save = dialog.getByRole("button", { name: "Save Guardrails" });
  for (const position of ["top", "bottom"] as const) {
    await body.evaluate((element, where) => { element.scrollTop = where === "top" ? 0 : element.scrollHeight; }, position);
    for (const control of [cancel, save]) {
      await expect(control).toBeInViewport({ ratio: 1 });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOT}/mobile.png` });
});

test.describe("on a coarse pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("opening Guardrails focuses no field until one is tapped", async ({ page }) => {
    await openSession(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      "this emulation must report the coarse pointer the rule is keyed on").toBe(true);
    await page.getByRole("button", { name: "Attach and Settings" }).tap();
    await page.getByRole("menuitem", { name: "Guardrails…" }).tap();
    const dialog = page.getByRole("dialog", { name: "Guardrails" });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      return { tag: active?.tagName.toLowerCase() ?? null, inDialog: Boolean(active?.closest('[role="dialog"]')) };
    });
    expect(["input", "textarea", "select"], "no field may raise the keyboard as the sheet opens").not.toContain(focused.tag);
    expect(focused.inDialog, "focus still moves into the sheet").toBe(true);

    const recurring = dialog.getByRole("textbox", { name: "Recurring Cost Threshold" });
    await recurring.tap();
    await expect(recurring).toBeFocused();
  });
});
