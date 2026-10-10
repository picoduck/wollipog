import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Thread families at a glance (#2215, docs/design-system.md §5.2, §5.5, §11.1, §18): the chevron is
 * the §5.5 icon in a small icon button, the family chip follows its parent's title directly and keeps
 * its dots and working count below a 600px list, and Stalled is said once, by the row's one badge, with no rail.
 *
 * `session-rows-e2e.html?family=1` leads the list with a running parent and a waiting, a stalled, a
 * running and a completed child, threaded by `threadInboxRows()` as the Sessions page threads them.
 */
const FAMILY = "/session-rows-e2e.html?family=1";

const parent = (page: Page) => page.locator(".inbox-row-shell", { hasText: "Family Parent:" });
const childRow = (page: Page, prefix: string) => page.locator(".inbox-row-shell", { hasText: `${prefix} Child:` });
const chip = (page: Page) => parent(page).locator(".inbox-thread-family");
const LABEL = "4 Children · Needs Your Input · 1 Working";

/** The horizontal gap from the end of the title's rendered box to the start of the chip. */
const chipGap = (row: Locator) => row.evaluate((shell) => {
  const title = shell.querySelector(".inbox-row-title")!.getBoundingClientRect();
  const family = shell.querySelector(".inbox-thread-family")!.getBoundingClientRect();
  const line = shell.querySelector(".inbox-row-copy")!.getBoundingClientRect();
  return { gap: family.left - title.right, chipRight: family.right, lineRight: line.right, top: family.top - title.top };
});

for (const length of ["short", "long"] as const) {
  test(`at 1440×900 the family chip starts within 16px of a ${length} parent title`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${FAMILY}${length === "long" ? "&familyTitle=long" : ""}`);
    await expect(chip(page)).toBeVisible();
    await expect(chip(page).locator(".inbox-thread-family-text")).toHaveText(LABEL);
    const { gap, chipRight, lineRight } = await chipGap(parent(page));
    expect(gap, "the chip follows the title, never before it").toBeGreaterThanOrEqual(0);
    expect(gap, "the chip sits beside the title it describes").toBeLessThanOrEqual(16);
    expect(chipRight, "the chip stays inside its line").toBeLessThanOrEqual(lineRight + 0.5);
    // A wide list adds the snippet after them (#2218): title, chip, then the snippet, in that order.
    const snippetLeft = await parent(page).locator(".inbox-row-snippet").evaluate((node) => node.getBoundingClientRect().left);
    expect(snippetLeft, "the snippet follows the chip").toBeGreaterThanOrEqual(chipRight);
    if (length === "long") {
      // The long title gives way, not the chip: it is clipped with an ellipsis and the chip stays whole.
      const clipped = await parent(page).locator(".inbox-row-title").evaluate((node) => node.scrollWidth > node.clientWidth);
      expect(clipped).toBe(true);
      const whole = await chip(page).locator(".inbox-thread-family-text")
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 0.5);
      expect(whole, "the rollup is not clipped").toBe(true);
    }
  });
}

for (const shape of [
  { name: "a 390×844 phone", width: 390, height: 844, query: "" },
  { name: "a 400px list column", width: 1440, height: 900, query: "&listWidth=400" },
] as const) {
  test(`in ${shape.name} the chip shows dots and a working count and keeps the full label as its name`, async ({ page }) => {
    await page.setViewportSize({ width: shape.width, height: shape.height });
    await page.goto(`${FAMILY}${shape.query}`);
    await expect(chip(page)).toBeVisible();
    await expect(chip(page).locator(".inbox-thread-dot")).toHaveCount(4);
    await expect(chip(page).locator(".inbox-thread-family-text")).toBeHidden();
    const working = chip(page).locator(".inbox-thread-working");
    await expect(working).toHaveText("1 Working");
    await expect(working).toBeVisible();
    await parent(page).hover();
    const actions = parent(page).locator(".inbox-row-actions");
    await expect(actions).toBeVisible();
    expect(await working.evaluate((label) => label.scrollWidth <= label.clientWidth)).toBe(true);
    const workingBox = (await working.boundingBox())!;
    const actionsBox = (await actions.boundingBox())!;
    expect(workingBox.x + workingBox.width).toBeLessThanOrEqual(actionsBox.x);
    await expect(chip(page)).toHaveAccessibleName(LABEL);
    await expect(chip(page)).toHaveAttribute("title", LABEL);
    await expect(parent(page).locator(".status")).toHaveText("Needs Your Input");
    await expect(parent(page).locator(".status")).toBeVisible();
    // The row's own name, which a screen reader reads for the row, keeps the rollup too.
    await expect(parent(page).locator(".inbox-row")).toHaveAccessibleName(new RegExp(LABEL));
    const { gap } = await chipGap(parent(page));
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(16);
  });
}

test("the 600px list keeps the chip's words and 599px drops them", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${FAMILY}&listWidth=600`);
  await expect(chip(page).locator(".inbox-thread-family-text")).toBeVisible();
  await page.goto(`${FAMILY}&listWidth=599`);
  await expect(chip(page)).toBeVisible();
  await expect(chip(page).locator(".inbox-thread-family-text")).toBeHidden();
});

test("the chevron is the §5.5 icon in a 28px button, rotates when open, and toggles the thread", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(FAMILY);
  const toggle = parent(page).getByRole("button", { name: "Collapse Thread" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAttribute("title", "Collapse Thread (T)");
  await expect(toggle).toHaveAttribute("tabindex", "-1");
  // No text glyph anywhere in the row's DOM: the chevron is an SVG.
  expect(await parent(page).evaluate((shell) => /[▶▸▾›]/.test(shell.textContent ?? ""))).toBe(false);
  const icon = toggle.locator("svg.disclosure-chevron");
  await expect(icon).toHaveCount(1);
  const geometry = await toggle.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const svg = button.querySelector("svg")!;
    const style = getComputedStyle(svg);
    return {
      width: box.width, height: box.height, iconWidth: svg.getBoundingClientRect().width,
      color: style.color, transition: style.transitionDuration,
      dim: getComputedStyle(document.documentElement).getPropertyValue("--text-dim").trim(),
    };
  });
  expect(geometry).toMatchObject({ width: 28, height: 28, iconWidth: 14 });
  expect(geometry.transition).not.toBe("0s");
  // Rotated a quarter turn while open (`matrix(0, 1, -1, 0, …)`), unrotated while closed.
  await expect(icon).toHaveCSS("transform", /^matrix\(6\.1\d*e-17, 1, -1, 6\.1\d*e-17, 0, 0\)$|^matrix\(0, 1, -1, 0, 0, 0\)$/);
  await toggle.click();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  const expand = parent(page).getByRole("button", { name: "Expand Thread" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(expand).toHaveAttribute("title", "Expand Thread (T)");
  await expect(expand.locator("svg")).toHaveCSS("transform", "none");
  // The chip reads the same while collapsed, and forwards to the same toggle.
  await expect(chip(page)).toHaveAccessibleName(LABEL);
  await chip(page).click();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
});

test("the chevron's 14px icon sits before the sender's icon and never overlaps it", async ({ page }) => {
  for (const width of [1440, 390] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(FAMILY);
    const boxes = await parent(page).evaluate((shell, width) => {
      const icon = shell.querySelector(".inbox-thread-toggle svg")!.getBoundingClientRect();
      const button = shell.querySelector(".inbox-thread-toggle")!.getBoundingClientRect();
      const sender = shell.querySelector(".inbox-row-sender .agent-icon")!.getBoundingClientRect();
      const line = shell.querySelector(width > 760 ? ".inbox-row-status-line" : ".inbox-row-sender-line")!.getBoundingClientRect();
      const row = shell.querySelector(".inbox-row")!.getBoundingClientRect();
      return {
        iconRight: icon.right, senderLeft: sender.left, buttonRight: button.right,
        iconCentre: icon.top + icon.height / 2, lineCentre: line.top + line.height / 2,
        buttonLeft: button.left, rowLeft: row.left,
      };
    }, width);
    expect(boxes.iconRight, `${width}: icon before the sender`).toBeLessThanOrEqual(boxes.senderLeft - 4);
    expect(boxes.buttonRight, `${width}: the button ends before the sender`).toBeLessThanOrEqual(boxes.senderLeft + 0.5);
    expect(boxes.buttonLeft, `${width}: the button stays inside the row`).toBeGreaterThanOrEqual(boxes.rowLeft - 0.5);
    expect(Math.abs(boxes.iconCentre - boxes.lineCentre), `${width}: centred on line one`).toBeLessThanOrEqual(1);
  }
});

test("on touch the chevron is 36px to look and 44px to hit, around the same 14px icon", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  await page.goto(FAMILY);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  const toggle = parent(page).locator(".inbox-thread-toggle");
  const sizes = await toggle.evaluate((button) => {
    const hit = getComputedStyle(button, "::after");
    return {
      width: button.getBoundingClientRect().width,
      icon: button.querySelector("svg")!.getBoundingClientRect().width,
      hitInset: hit.inset || `${hit.top} ${hit.left}`,
    };
  });
  expect(sizes).toMatchObject({ width: 36, icon: 14 });
  expect(sizes.hitInset).toMatch(/^-4px/);
  // The 36px button ends before the sender's icon, so its press fill never covers the provider.
  const clear = await parent(page).evaluate((shell) =>
    shell.querySelector(".inbox-row-sender .agent-icon")!.getBoundingClientRect().left
      - shell.querySelector(".inbox-thread-toggle")!.getBoundingClientRect().right);
  expect(clear).toBeGreaterThanOrEqual(-0.5);
  const box = (await toggle.boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x - 3, y: box.y + box.height / 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

// The accepted follow-up from #2209's forced-colors evidence: forced colors drops the danger tone, so a
// stalled Running row has to differ from a working one in something other than colour.
for (const width of [1440, 390] as const) {
  test(`in forced colors at ${width}px a stalled row differs visibly from a running one`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${FAMILY}&selected=family-parent`);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const stalled = childRow(page, "Stalled").locator(".status");
    const running = childRow(page, "Running").locator(".status");
    await expect(stalled).toHaveText("Stalled");
    await expect(running).toHaveText("Running");
    await expect(stalled).toHaveAccessibleName("Status: Stalled, Running");
    // What a person sees, not what the DOM says: the two badges' pixels differ.
    const [stalledShot, runningShot] = [
      await stalled.screenshot({ animations: "disabled" }),
      await running.screenshot({ animations: "disabled" }),
    ];
    expect(stalledShot.equals(runningShot), "the stalled badge is drawn differently from the running one").toBe(false);
    // The leading edge carries nothing for a stall; only the selected row's bar is there.
    expect(await childRow(page, "Stalled").evaluate((shell) => getComputedStyle(shell, "::before").content)).toBe("none");
  });
}

// Forced colors drops author fills, and a dots-only chip is nothing but its dots: they, and the
// spine that ties the children to their parent, are painted in system colours instead.
test("in forced colors a dots-only chip keeps its dots and the thread keeps its spine", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${FAMILY}&listWidth=400`);
  await expect(chip(page).locator(".inbox-thread-family-text")).toBeHidden();
  const paint = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.background = "Canvas";
    document.body.append(probe);
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const dots = [...document.querySelectorAll(".inbox-thread-dot")].map((dot) => getComputedStyle(dot).backgroundColor);
    const child = document.querySelector(".inbox-row-shell.thread-child")!;
    return {
      canvas,
      dots,
      spine: getComputedStyle(child, "::after").backgroundColor,
      tick: getComputedStyle(child.querySelector(".inbox-row-primary-cell")!, "::before").backgroundColor,
    };
  });
  expect(paint.dots).toHaveLength(4);
  for (const dot of paint.dots) expect(dot, "a dot is painted, not Canvas").not.toBe(paint.canvas);
  expect(paint.spine).not.toBe(paint.canvas);
  expect(paint.tick).not.toBe(paint.canvas);
});

test.describe("a stalled child", () => {
  for (const width of [1440, 390] as const) {
    test(`shows one danger badge and no rail or red border at ${width}px; selected, it keeps the accent bar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${FAMILY}&selected=family-stalled`);
      const stalled = childRow(page, "Stalled");
      await expect(stalled).toHaveClass(/thread-child/);
      await expect(stalled.locator(".status")).toHaveCount(1);
      await expect(stalled.locator(".status.t-danger")).toHaveCount(1);
      await expect(stalled.locator(".status")).toHaveText("Stalled");
      await expect(stalled.locator(".status")).toHaveAttribute("title", "Running, but no activity for 14 minutes.");
      const paint = await stalled.evaluate((shell) => {
        const row = shell.querySelector<HTMLElement>(".inbox-row")!;
        const cell = shell.querySelector<HTMLElement>(".inbox-row-primary-cell")!;
        const style = getComputedStyle(row);
        const spine = getComputedStyle(shell, "::after");
        const probe = document.createElement("i");
        probe.style.color = "var(--border-strong)";
        shell.append(probe);
        const borderStrong = getComputedStyle(probe).color;
        probe.remove();
        return {
          rail: getComputedStyle(shell, "::before").content,
          borders: [style.borderLeftColor, style.borderTopColor, style.borderRightColor, style.borderBottomColor],
          bar: getComputedStyle(cell, "::after").content,
          spine: spine.backgroundColor,
          tick: getComputedStyle(cell, "::before").backgroundColor,
          borderStrong,
          red: (() => {
            const red = document.createElement("i");
            red.style.color = "var(--red)";
            shell.append(red);
            const value = getComputedStyle(red).color;
            red.remove();
            return value;
          })(),
        };
      });
      expect(paint.rail, "no stalled rail").toBe("none");
      for (const border of paint.borders) expect(border, "no red border").not.toBe(paint.red);
      expect(paint.spine, "the spine is --border-strong").toBe(paint.borderStrong);
      expect(paint.tick, "the tick is --border-strong").toBe(paint.borderStrong);
      if (width > 760) {
        await expect(stalled).toHaveClass(/selected/);
        expect(paint.bar, "the selected stalled child keeps its accent bar").toBe("\"\"");
      }
      // The waiting child next to it keeps its own warning badge.
      await expect(childRow(page, "Waiting").locator(".status.t-warning")).toHaveCount(1);
    });
  }
});
