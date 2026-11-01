import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * Pair Device (#2999): one title and a top edge that stays put across both steps and the result,
 * suspended people listed but unselectable, plain words when other devices can't reach this
 * computer, Manual Setup's values on one line, and the phone sheet's header Back.
 */

const FIXTURE = "/people-devices-e2e.html";

async function openPairDevice(page: Page, query = ""): Promise<Locator> {
  await page.goto(`${FIXTURE}${query}`);
  await page.getByRole("button", { name: /^Pair Device/ }).click();
  const dialog = page.getByRole("dialog", { name: "Pair Device" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function cardTop(page: Page): Promise<number> {
  await dialogMotionSettled(page);
  const box = await page.locator(".modal").boundingBox();
  expect(box).not.toBeNull();
  return Math.round(box!.y);
}

async function createLink(dialog: Locator, name = "Pat's Tablet"): Promise<void> {
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("textbox", { name: "Device Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create Pairing Link" }).click();
  await expect(dialog.getByRole("button", { name: "Done" })).toBeVisible();
}

async function openManualSetup(dialog: Locator): Promise<Locator[]> {
  await dialog.locator("summary", { hasText: "Manual Setup" }).click();
  const wells = dialog.locator(".pair-manual .code-well.one-line");
  await expect(wells).toHaveCount(2);
  return [wells.nth(0), wells.nth(1)];
}

/** The value's text is one line: its content box is one line box tall, and it is clipped, not wrapped. */
async function expectOneLine(well: Locator): Promise<void> {
  const shape = await well.locator("code").evaluate((code) => {
    const style = getComputedStyle(code);
    const content = code.getBoundingClientRect().height - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
    return {
      whiteSpace: style.whiteSpace,
      lines: Math.round(content / Number.parseFloat(style.lineHeight)),
    };
  });
  expect(shape).toEqual({ whiteSpace: "nowrap", lines: 1 });
}

/** The box a pointer can hit: the element plus any absolutely positioned ::after that extends it. */
async function hitArea(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const after = getComputedStyle(element, "::after");
    const extends_ = after.content !== "none" && after.position === "absolute";
    const inset = (side: string) => extends_ ? Math.min(0, Number.parseFloat(after.getPropertyValue(side)) || 0) : 0;
    return {
      width: rect.width - inset("left") - inset("right"),
      height: rect.height - inset("top") - inset("bottom"),
    };
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("one title over both steps and the result, and the top edge never moves", async ({ page }) => {
    const dialog = await openPairDevice(page, "?suspended&reach=lan");
    await expect(dialog.locator(".modal-title")).toHaveText("Pair Device");
    await expect(dialog.locator(".modal-desc")).toHaveText("Step 1 of 2: Choose who it's for.");
    const top = await cardTop(page);

    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.locator(".modal-title")).toHaveText("Pair Device");
    await expect(dialog.locator(".modal-desc")).toHaveText("Step 2 of 2: Name the device.");
    expect(await cardTop(page)).toBe(top);

    await dialog.getByRole("textbox", { name: "Device Name" }).fill("Pat's Tablet");
    await dialog.getByRole("button", { name: "Create Pairing Link" }).click();
    await expect(dialog.locator(".pair-qr svg")).toBeVisible();
    await expect(dialog.locator(".modal-title")).toHaveText("Pair Device");
    expect(await cardTop(page)).toBe(top);
    // The result has no primary: Copy Pairing Link and Done are both secondary.
    await expect(dialog.locator(".btn.primary")).toHaveCount(0);
  });

  test("a suspended person is listed with the reason and can't be chosen by click or keyboard", async ({ page }) => {
    const dialog = await openPairDevice(page, "?suspended");
    const group = dialog.getByRole("radiogroup", { name: "Person" });
    await expect(group.getByRole("radio")).toHaveCount(3);
    const suspended = dialog.locator(".choice-row").filter({ hasText: "Morgan Lee" });
    await expect(suspended).toContainText("Suspended. Restore their access to pair a device.");
    const morgan = group.getByRole("radio", { name: /Morgan Lee/ });
    await expect(morgan).toHaveAttribute("aria-disabled", "true");

    // Playwright refuses an aria-disabled target; the person can still press it.
    await suspended.click({ force: true });
    await expect(morgan).not.toBeChecked();
    await morgan.focus();
    await page.keyboard.press("Space");
    await expect(morgan).not.toBeChecked();
    await group.getByRole("radio").nth(1).focus();
    await page.keyboard.press("ArrowUp");
    await expect(morgan).not.toBeChecked();
    await expect(group.locator("input:checked")).toHaveCount(1);
  });

  test("with a loopback-only computer the result says so plainly and keeps the environment variables behind Show Details", async ({ page }) => {
    const dialog = await openPairDevice(page);
    await createLink(dialog);
    const notice = dialog.locator(".notice").filter({ hasText: "Other Devices Can't Reach This Computer Yet" });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "Open Network Settings" })).toBeVisible();
    await expect(dialog).toContainText("The link still works in another browser on this computer.");
    await expect(dialog).not.toContainText("CONTROL_PLANE");
    await expect(dialog).not.toContainText(/control plane/i);
    await expect(dialog.locator(".btn.primary")).toHaveCount(0);
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice).toContainText("CONTROL_PLANE_PUBLIC_ORIGIN");
    await expect(notice).toContainText("CONTROL_PLANE_HOST");

    await notice.getByRole("button", { name: "Open Network Settings" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("Manual Setup's values stay on one line, 16px apart", async ({ page }) => {
    const dialog = await openPairDevice(page, "?reach=lan");
    await createLink(dialog);
    const [fragment, code] = await openManualSetup(dialog);
    await expectOneLine(fragment!);
    await expectOneLine(code!);
    const fields = dialog.locator(".pair-manual > .field");
    const first = await fields.nth(0).boundingBox();
    const second = await fields.nth(1).boundingBox();
    expect(Math.round(second!.y - (first!.y + first!.height))).toBe(16);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a sheet whose header Back returns from step 2 to step 1 with the chosen person kept", async ({ page }) => {
    const dialog = await openPairDevice(page);
    await dialogMotionSettled(page);
    const card = await page.locator(".modal").boundingBox();
    expect(Math.round(card!.y + card!.height)).toBe(844);
    const member = dialog.getByRole("radio", { name: /Hidden Name 2/ });
    await member.check();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.locator(".modal-desc")).toHaveText("Step 2 of 2: Name the device.");
    const footer = await dialog.locator(".modal-foot .btn").evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
    expect(footer).toEqual([48, 48]);
    await dialog.locator(".modal-head").getByRole("button", { name: "Back" }).click();
    await expect(dialog.locator(".modal-desc")).toHaveText("Step 1 of 2: Choose who it's for.");
    await expect(member).toBeChecked();
  });

  test("Manual Setup's values stay on one line and each copy button has a 44px hit area", async ({ page }) => {
    const dialog = await openPairDevice(page, "?reach=lan");
    await createLink(dialog);
    // The QR stacks above its controls, inside the sheet's one scroll.
    const qr = await dialog.locator(".pair-qr").boundingBox();
    const side = await dialog.locator(".pair-result-side").boundingBox();
    expect(side!.y).toBeGreaterThanOrEqual(qr!.y + qr!.height);
    for (const well of await openManualSetup(dialog)) {
      await expectOneLine(well);
      const area = await hitArea(well.getByRole("button"));
      expect(area.width).toBeGreaterThanOrEqual(44);
      expect(area.height).toBeGreaterThanOrEqual(44);
    }
  });
});
