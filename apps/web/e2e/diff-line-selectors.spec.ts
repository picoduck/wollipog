import { devices, expect, test, type Locator } from "@playwright/test";

/**
 * A diff line's own controls (#2849): with a mouse, Add Finding's "+" in the gutter on hover, never
 * over the code; on touch, the line number's menu; and Select Lines, where a click on a row picks it.
 * No line carries a checkbox, and every row stays one line tall.
 */

const ROWS = ".diff-line:not(.diff-nonl), .diff-split-cell:not(.diff-split-empty)";

/** Where a row's controls sit across it, in CSS pixels from the viewport's left edge. */
function geometry(row: Locator) {
  return row.evaluate((element) => {
    const box = (selector: string) => {
      const rect = element.querySelector(selector)!.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    return { number: box(".diff-num"), add: box(".diff-add"), sign: box(".diff-sign"), text: box(".diff-text") };
  });
}

for (const layout of ["unified", "split"] as const) {
  test(`with a mouse, hovering a line shows its gutter + and it never overlaps the code at 320px (${layout})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`/diff-discard-e2e.html?review=1&layout=${layout}`);
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
    const rows = page.locator(ROWS);
    const count = await rows.count();
    let checked = 0;
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const add = row.locator(".diff-add");
      // Side by Side's old-side copy of an unchanged line takes no finding; its new side does.
      if (await add.count() === 0) continue;
      await page.mouse.move(0, 0);
      await expect(add).toHaveCSS("opacity", "0");
      await row.locator(".diff-text").hover();
      await expect(add).toHaveCSS("opacity", "1");
      await expect(add).toHaveAccessibleName(/^Add Finding on (Removed )?Line \d+$/u);
      const at = await geometry(row);
      expect(at.add.left, "after the line numbers").toBeGreaterThanOrEqual(at.number.right - 0.5);
      expect(at.add.right, "before the change marker").toBeLessThanOrEqual(at.sign.left + 0.5);
      expect(at.add.right, "never over the code").toBeLessThanOrEqual(at.text.left + 0.5);
      checked += 1;
    }
    expect(checked, "every changed line and the new side of every unchanged line").toBe(3);
  });
}

for (const query of ["review=1", "review=1&layout=split", "review=1&select=1", "pane=unstaged&layout=split"]) {
  test(`every row is one line tall, with or without the + slot (${query})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/diff-discard-e2e.html?${query}`);
    const heights = await page.locator(ROWS).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    expect(new Set(heights).size, "every row is one line tall").toBe(1);
  });
}

test("Select Lines: a click on a row picks it, Shift-click takes the range, and picked rows take the selected fill", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/diff-discard-e2e.html?review=1&select=1&pane=unstaged&references=1");
  await page.getByRole("button", { name: "Select Lines" }).click();
  await expect(page.locator(".diff-view.is-selecting")).toHaveCount(1);
  await expect(page.locator(".diff-add")).toHaveCount(0);
  await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);

  const first = page.getByRole("button", { name: "Select Line 18", exact: true });
  await first.locator("xpath=..").locator(".diff-text").click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(first).toBeFocused();
  await page.getByRole("button", { name: "Select Line 19", exact: true }).click({ modifiers: ["Shift"] });
  const bar = page.getByRole("region", { name: "Selected Lines" });
  await expect(bar).toContainText("3 lines selected");
  await expect(page.locator(".diff-line.is-selected")).toHaveCount(3);
  const fill = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--surface-selected)";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await expect(page.locator(".diff-line.is-selected").first()).toHaveCSS("background-color", fill);
  // A removed and an added line are two sides, so the range cannot be attached; staging can run.
  await expect(bar.getByRole("button", { name: "Attach to Prompt" })).toHaveAttribute("aria-disabled", "true");
  await expect(bar).toContainText("Select one continuous range to attach it.");
  await expect(bar.getByRole("button", { name: "Stage Lines" })).not.toHaveAttribute("aria-disabled", "true");

  // Escape is the panel's; here the harness's own toggle turns the mode off and clears the lines.
  await page.getByRole("button", { name: "Select Lines" }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator(".diff-line.is-selected")).toHaveCount(0);
});

test.describe("on touch", () => {
  test.use({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce",
    userAgent: devices["Pixel 7"].userAgent,
  });

  test("no + renders, and tapping a line number opens the line menu as a sheet", async ({ page }) => {
    await page.goto("/diff-discard-e2e.html?review=1&select=1");
    await expect(page.locator(".diff-add, .diff-add-slot")).toHaveCount(0);
    await page.getByRole("button", { name: "Line 19 Actions", exact: true }).tap();
    const menu = page.getByRole("menu", { name: "Line 19 Actions" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(["Add Finding…", "Select Line"]);
    // A sheet: it spans the viewport's width at its bottom edge.
    const [box, viewport] = [await menu.boundingBox(), page.viewportSize()!];
    expect(Math.round(box!.width)).toBe(viewport.width);
    expect(Math.round(box!.y + box!.height)).toBe(viewport.height);
    await menu.getByRole("menuitem", { name: "Select Line" }).tap();
    await expect(page.getByRole("region", { name: "Selected Lines" })).toContainText("1 line selected");
    await expect(page.getByRole("button", { name: "Select Line 19", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
});

test("Select Lines is a toolbar toggle where the row holds it, and a View Options item in a 320px panel (#2849)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/review-layout-e2e.html?width=400");
  const toolbar = page.locator(".rpanel-toolbar > .toolbar");
  const toggle = toolbar.getByRole("button", { name: "Select Lines" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toolbar.getByRole("button", { name: "View Options" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Select Lines" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const tops = await toolbar.evaluate((row) => new Set([...row.children].map((child) => Math.round(child.getBoundingClientRect().top))).size);
  expect(tops, "Scope, Select Lines and View Options share one row at 400px").toBe(1);

  await page.goto("/review-layout-e2e.html?width=320");
  await expect(page.locator(".review-summary")).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Select Lines" })).toHaveCount(0);
  await toolbar.getByRole("button", { name: "View Options" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: "Select Lines" });
  await expect(item).toHaveAttribute("aria-checked", "false");
  await item.click();
  await expect(page.locator(".diff-view.is-selecting")).toHaveCount(1);
  await toolbar.getByRole("button", { name: "View Options" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Select Lines" })).toHaveAttribute("aria-checked", "true");
});
