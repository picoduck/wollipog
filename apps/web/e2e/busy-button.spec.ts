import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled, motionSettled } from "./dialog-motion.js";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1949: a busy button keeps its label, its width and its height, and shows a 14px spinner before
 * the label (docs/design-system.md §3.1). Measured idle and busy on the SAME element, so the font
 * stack of the machine cancels out.
 */

interface Box { left: number; width: number; height: number; right: number }

async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, width: rect.width, height: rect.height, right: rect.right };
  });
}

async function coarse(page: Page): Promise<boolean> {
  return page.evaluate(() => matchMedia("(pointer: coarse)").matches);
}

/** Presses `button`, then checks it against the measurements taken just before. */
async function expectSteadyWhenBusy(button: Locator, label: string, neighbour?: Locator) {
  const idle = await box(button);
  const neighbourIdle = neighbour ? await box(neighbour) : null;
  await button.click();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toHaveText(label);
  const busy = await box(button);
  expectGeometry(Math.abs(busy.width - idle.width), `${label}: the width does not change`).toBeLessThanOrEqual(0.61);
  expectGeometry(Math.abs(busy.height - idle.height), `${label}: the height does not change`).toBeLessThanOrEqual(0.61);
  expectGeometry(Math.abs(busy.left - idle.left), `${label}: the button does not move`).toBeLessThanOrEqual(0.61);
  if (neighbour && neighbourIdle) {
    expectGeometry(Math.abs((await box(neighbour)).left - neighbourIdle.left), `${label}: its neighbour does not move`)
      .toBeLessThanOrEqual(0.61);
  }
  const inside = await button.evaluate((element) => {
    const spinner = element.querySelector<HTMLElement>(".spinner")!;
    const own = element.getBoundingClientRect();
    // The spinner is rotating, and a rotated square's bounding box is larger than the square; its
    // layout box is the same size around the same centre.
    const turning = spinner.getBoundingClientRect();
    const centre = turning.left + turning.width / 2;
    const spin = {
      width: spinner.offsetWidth,
      height: spinner.offsetHeight,
      left: centre - spinner.offsetWidth / 2,
      right: centre + spinner.offsetWidth / 2,
    };
    const text = document.createRange();
    const label = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!;
    text.selectNodeContents(label);
    const words = text.getBoundingClientRect();
    const lines = new Set([...text.getClientRects()].map((rect) => Math.round(rect.top))).size;
    return {
      spinner: { width: spin.width, height: spin.height },
      spinnerFirst: element.firstElementChild === spinner,
      spinnerBeforeLabel: spin.right <= words.left + 0.5,
      overflowLeft: own.left - Math.min(spin.left, words.left),
      overflowRight: Math.max(spin.right, words.right) - own.right,
      lines,
    };
  });
  expect(inside.spinner).toEqual({ width: 14, height: 14 });
  expect(inside.spinnerFirst).toBe(true);
  expect(inside.spinnerBeforeLabel).toBe(true);
  expect(inside.lines, `${label}: the label stays on one line`).toBe(1);
  expectGeometry(inside.overflowLeft, `${label}: the spinner stays inside the button`).toBeLessThanOrEqual(0.61);
  expectGeometry(inside.overflowRight, `${label}: the label stays inside the button`).toBeLessThanOrEqual(0.61);
  return busy;
}

for (const pointer of ["fine", "coarse"] as const) {
  test.describe(`with a ${pointer} pointer`, () => {
    test.use({ viewport: pointer === "fine" ? { width: 1440, height: 900 } : { width: 390, height: 844 }, hasTouch: pointer === "coarse" });

    test("every variant and size keeps its label, width and height while busy", async ({ page }) => {
      await page.goto("/busy-button-e2e.html");
      expect(await coarse(page)).toBe(pointer === "coarse");
      const rows = page.locator(".busy-button-fixture > .actions");
      await expect(rows).toHaveCount(15);
      for (const row of await rows.all()) {
        const size = await row.getAttribute("data-size");
        const install = row.getByRole("button", { name: "Install and Restart" });
        const busy = await expectSteadyWhenBusy(install, "Install and Restart", row.locator('[data-neighbour="after"]'));
        const expected = pointer === "fine"
          ? { sm: 28, default: 32, lg: 40 }[size!]
          : { sm: 36, default: 44, lg: 48 }[size!];
        expect(busy.height).toBe(expected);
        await expectSteadyWhenBusy(row.getByRole("button", { name: "Add" }), "Add", row.locator('[data-neighbour="after"]'));
        if (pointer === "coarse" && size === "sm") {
          // 36px visual, and at least 44px of hit area through the coarse-pointer `::after` (§2.8),
          // busy or not.
          const hit = await install.evaluate((element) => {
            const after = getComputedStyle(element, "::after");
            return {
              position: after.position,
              height: element.getBoundingClientRect().height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom),
            };
          });
          expect(hit.position).toBe("absolute");
          expect(hit.height).toBeGreaterThanOrEqual(44);
        }
      }
    });

    test("a busy toast action keeps its label and width", async ({ page }) => {
      for (const [kind, label] of [["install", "Install and Restart"], ["undo", "Undo"]] as const) {
        await page.goto(`/busy-button-e2e.html?surface=toast&toast=${kind}`);
        const toast = page.locator(".toast");
        await expect(toast).toBeVisible();
        // The toast slides in; measure the layout, not a frame of that motion.
        await motionSettled(toast);
        const message = await box(toast.locator(".toast-message"));
        const action = toast.getByRole("button", { name: label });
        await expectSteadyWhenBusy(action, label);
        expectGeometry(Math.abs((await box(toast.locator(".toast-message"))).width - message.width),
          `${label}: the toast message does not reflow`).toBeLessThanOrEqual(0.61);
        await expect(toast).not.toContainText(/Installing…|Undoing…|Retrying…/);
        const progress = kind === "install" ? "Installing the update…" : "Undoing the change…";
        await expect(toast.getByRole("status").filter({ hasText: progress })).toHaveCount(1);
      }
    });

    test("a pending confirmation keeps its confirm label and leaves Cancel available", async ({ page }) => {
      await page.goto("/busy-button-e2e.html?surface=confirm");
      const dialog = page.getByRole("dialog", { name: "Stop Session" });
      await expect(dialog).toBeVisible();
      await dialogMotionSettled(page);
      const confirm = dialog.getByRole("button", { name: "Stop Session" });
      await expectSteadyWhenBusy(confirm, "Stop Session", dialog.getByRole("button", { name: "Cancel" }));
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
      await expect(dialog.getByRole("status").filter({ hasText: "Stopping the session…" })).toHaveCount(1);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
    });
  });
}
