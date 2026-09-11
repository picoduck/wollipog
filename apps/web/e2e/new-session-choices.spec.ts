import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #832, in the only place that can answer it: a rendering engine.
 *
 * The defect was a disagreement between a CSS rule and a number in TypeScript. `.ui-select-option`
 * gets a 44px touch target under `(pointer: coarse)`, while the menu's height estimator budgeted
 * 34px a row — so a two-option Permission Preset asked for 76px to draw 98px in, and half of
 * "Orchestrator" sat under a scrollbar on a phone.
 *
 * No unit suite can catch that class. happy-dom has no layout, so every box measures zero and every
 * clipping assertion passes vacuously; a stylesheet test can read the 44px rule but not the
 * estimate that contradicted it. The arithmetic is pinned in `ChoiceControls.test.ts`; what is
 * asserted here is PAINT.
 *
 * Nothing below compares an absolute pixel count. CI renders text about 3.5% smaller than a
 * developer box, so a hardcoded height is a test that fails on the machine that matters. Every
 * assertion is relative — content against its own scroll box, a child against its container — which
 * is also the only form that stays true under increased browser text size.
 */

/** The narrowest width WCAG 2.2 Reflow requires content to survive at. */
const REFLOW_WIDTH = 320;

/** A representative phone, and a desktop window for the same dialog. */
const VIEWPORTS = [
  { name: "phone", width: 390, height: 780, touch: true },
  { name: "reflow-minimum", width: REFLOW_WIDTH, height: 640, touch: true },
  { name: "desktop", width: 1280, height: 900, touch: false },
] as const;

async function openDialog(page: Page, query = "") {
  await page.goto(`/new-session-choices-e2e.html${query}`);
  await expect(page.getByRole("heading", { name: "New Session" })).toBeVisible();
}

const permissionPresets = (page: Page) =>
  page.getByRole("radiogroup", { name: "Permission Preset" });

/**
 * Whether an element's own content overflows the box it is drawn in.
 *
 * This is the exact shape of the defect — `scrollHeight` past `clientHeight` IS the clipping — and
 * it is a comparison of an element with itself, so it carries no assumption about font size,
 * zoom or platform.
 */
async function overflow(locator: Locator): Promise<{ vertical: number; horizontal: number }> {
  return locator.evaluate((element) => ({
    vertical: element.scrollHeight - element.clientHeight,
    horizontal: element.scrollWidth - element.clientWidth,
  }));
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} (${viewport.width}px)`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      // `isMobile` is what makes Chromium report `(pointer: coarse)` and `(hover: none)` — the
      // media conditions the 44px rule is written against. Without it a "phone" viewport is just a
      // narrow desktop and the touch floor never applies, which would make this whole file pass
      // while the defect it guards was fully intact.
      isMobile: viewport.touch,
    });

    test("both permission presets are fully visible without opening anything", async ({ page }) => {
      await openDialog(page);
      const group = permissionPresets(page);
      const options = group.getByRole("radio");
      await expect(options).toHaveCount(2);

      // The structural half: there is no trigger, so nothing can be behind one.
      await expect(page.locator(".ui-select-list")).toHaveCount(0);

      const groupBox = await group.boundingBox();
      expect(groupBox).not.toBeNull();
      for (const option of await options.all()) {
        await expect(option).toBeVisible();
        const box = await option.boundingBox();
        expect(box).not.toBeNull();
        // Inside its own group, with its full height — the assertion that fails when a container
        // caps a list below what its rows render.
        expect(box!.height).toBeGreaterThan(0);
        expect(box!.y).toBeGreaterThanOrEqual(groupBox!.y - 1);
        expect(box!.y + box!.height).toBeLessThanOrEqual(groupBox!.y + groupBox!.height + 1);
        // And no clipped label, description or reason inside the card itself.
        const inner = await overflow(option);
        expect(inner.vertical).toBeLessThanOrEqual(1);
        expect(inner.horizontal).toBeLessThanOrEqual(1);
      }

      // The group itself does not scroll. A scrollbar on a two-option control is the user-visible
      // symptom the issue reported.
      const groupOverflow = await overflow(group);
      expect(groupOverflow.vertical).toBeLessThanOrEqual(1);
    });

    test("an unavailable preset is readable rather than hidden", async ({ page }) => {
      await openDialog(page, "?orchestrator=0");
      const orchestrator = permissionPresets(page).getByRole("radio", { name: /Orchestrator/ });
      // Rendered, not dropped — §11.3. The list used to omit it entirely, so a user could not learn
      // that the reason was their agent.
      await expect(orchestrator).toBeVisible();
      await expect(orchestrator).toHaveAttribute("aria-disabled", "true");
      await expect(orchestrator).toContainText(/does not offer the Orchestrator/);
      const clipped = await overflow(orchestrator);
      expect(clipped.vertical).toBeLessThanOrEqual(1);
    });

    test("a two-option Select opens a list its own options fit inside", async ({ page }) => {
      // AC4, against the shared primitive rather than the one control that hit the defect. Every
      // other Select in the app — the archive filter, the agent-defaults rows, the colour-scheme
      // picker — shares this arithmetic, so the guard belongs on the primitive.
      await page.goto("/new-session-choices-e2e.html?probe=select");
      const trigger = page.getByRole("button", { name: /Two Option Probe/ });
      await expect(trigger).toBeVisible();
      await trigger.click();

      const list = page.locator(".ui-select-list");
      await expect(list).toBeVisible();
      await expect(list.getByRole("option")).toHaveCount(2);

      const optionHeights = await list.getByRole("option").evaluateAll(
        (nodes) => nodes.map((node) => node.getBoundingClientRect().height),
      );
      const rendered = optionHeights.reduce((total, height) => total + height, 0);

      // Two options cannot plausibly exceed a 640px-tall viewport, so this list has no business
      // scrolling at any of these sizes. `scrollHeight` past `clientHeight` IS the reported defect.
      expect(
        (await overflow(list)).vertical,
        `a 2-option list rendering ${rendered}px of rows scrolled inside a ${viewport.height}px viewport`,
      ).toBeLessThanOrEqual(1);

      // And both options are inside the list box they were drawn in, which is what "half of
      // Orchestrator was below the fold" looked like to the user.
      const listBox = (await list.boundingBox())!;
      for (const option of await list.getByRole("option").all()) {
        const box = (await option.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(listBox.y - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
        if (viewport.touch) {
          // The floor the estimator disagreed with. Asserted as a minimum, never an equality:
          // CI renders text ~3.5% smaller than a developer box, so only the CSS-declared bound is
          // stable across hosts.
          expect(box.height).toBeGreaterThanOrEqual(43);
        }
      }

      await page.keyboard.press("Escape");
      await expect(list).toHaveCount(0);
    });

    test("no choice control overflows the form horizontally", async ({ page }) => {
      await openDialog(page);
      const form = page.locator(".form");
      const formBox = await form.boundingBox();
      expect(formBox).not.toBeNull();

      for (const selector of [".ui-choice-card", ".ui-seg", ".ui-select-trigger", ".loc-pick"]) {
        for (const control of await page.locator(selector).all()) {
          if (!(await control.isVisible())) continue;
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          // Within the form's content width, at 320px as well as at 1280px. Reflow failures show up
          // here as a control wider than the column it sits in.
          expect(box!.x).toBeGreaterThanOrEqual(formBox!.x - 1);
          expect(box!.x + box!.width, `${selector} overflows the form`)
            .toBeLessThanOrEqual(formBox!.x + formBox!.width + 1);
        }
      }
    });
  });
}

test.describe("increased text size", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("presets stay unclipped when the user enlarges text", async ({ page }) => {
    // The other half of WCAG Reflow, and the half a fixed per-option pixel budget cannot satisfy by
    // construction: at 150% the rows are taller than any constant the estimator could name.
    await openDialog(page);
    await page.addStyleTag({ content: "html { font-size: 150%; }" });
    const group = permissionPresets(page);
    await expect(group.getByRole("radio")).toHaveCount(2);
    for (const option of await group.getByRole("radio").all()) {
      await expect(option).toBeVisible();
      const clipped = await overflow(option);
      expect(clipped.vertical).toBeLessThanOrEqual(1);
    }
    expect((await overflow(group)).vertical).toBeLessThanOrEqual(1);
  });
});
