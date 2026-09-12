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

/**
 * Three viewports chosen to cover the touch floor's THREE activation paths, not three device sizes.
 *
 * `styles.css` applies the 44px floor under a comma-separated list:
 *     @media (max-width: 760px), (pointer: coarse), (hover: none)
 * so it is active if ANY of those matches. A narrow window with a mouse gets the floor just as a
 * phone does, and `useCoarsePointer()` queries that same list — so the estimator raises its budget
 * there too.
 *
 * The first version of this file had 390px and 320px both coarse, which tested the pointer path
 * twice and the width path never. Making the reflow-minimum case a FINE pointer covers the width
 * path at no extra cost, and keeps the WCAG reflow width where it belongs.
 */
const VIEWPORTS = [
  // The reported defect: a phone, where the pointer is what activates the floor.
  { name: "phone", width: 390, height: 780, touch: true, floor: true },
  // The WCAG reflow minimum with a MOUSE: the floor here comes from width alone.
  { name: "reflow-minimum", width: REFLOW_WIDTH, height: 640, touch: false, floor: true },
  // Wide and fine-pointered: no floor at all, so the compact budget must still be used.
  { name: "desktop", width: 1280, height: 900, touch: false, floor: false },
] as const;

async function openDialog(page: Page, query = "") {
  await page.goto(`/new-session-choices-e2e.html${query}`);
  await expect(page.getByRole("heading", { name: "New Session" })).toBeVisible();
}

async function openDialogWithoutPointer(page: Page, query = "") {
  await page.goto(`/new-session-choices-e2e.html?keyboard=1${query}`);
  const opener = page.getByRole("button", { name: "New Session" });
  await page.keyboard.press("Tab");
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New Session" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  return { dialog, opener };
}

async function selectCommonProjectWithoutPointer(page: Page) {
  const project = page.getByRole("combobox", { name: "Project" });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(project).toBeFocused();
  await page.keyboard.type("Wollipog");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(project).toHaveValue(/Wollipog/);
  return project;
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

    test("both presets are fully visible and nothing overflows the form", async ({ page }) => {
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

      // Horizontal reflow, asserted from the SAME page load rather than a second one. Both checks
      // want this dialog at this viewport, so opening it twice bought nothing but wall clock — and
      // the browser job has roughly 18 seconds of headroom against its 30-minute cap (#842).
      const form = page.locator(".form");
      const formBox = (await form.boundingBox())!;
      // `.loc-pick` and the native Project/Agent selects are gone. Include the editable combobox
      // owner explicitly so the two controls #218 migrated cannot overflow unnoticed.
      for (const selector of [".ui-choice-card", ".ui-seg", ".ui-select-trigger", ".ui-searchable-combobox-input"]) {
        for (const control of await page.locator(selector).all()) {
          if (!(await control.isVisible())) continue;
          const box = (await control.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(formBox.x - 1);
          expect(box.x + box.width, `${selector} overflows the form`)
            .toBeLessThanOrEqual(formBox.x + formBox.width + 1);
        }
      }
    });

    test("a two-option Select opens a list its own options fit inside", async ({ page }) => {
      // Skipped only where the floor genuinely does not apply — wide AND fine-pointered. Keyed on
      // `floor` rather than `touch`: an earlier version skipped by `touch` and justified it as
      // "coarse pointer only", which is false. The media query also fires on width, so that
      // reasoning would have silently dropped every narrow fine-pointer case.
      test.skip(!viewport.floor, "no touch floor applies at this width and pointer");
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
        if (viewport.floor) {
          // The floor the estimator disagreed with. Asserted as a minimum, never an equality:
          // CI renders text ~3.5% smaller than a developer box, so only the CSS-declared bound is
          // stable across hosts.
          expect(box.height).toBeGreaterThanOrEqual(43);
        }
      }

      await page.keyboard.press("Escape");
      await expect(list).toHaveCount(0);
    });

  });
}

test.describe("searchable Project and Agent controls", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("Advanced Agents share the searchable Agent list at phone width", async ({ page }) => {
    await openDialog(page);
    await expect(page.locator('select[aria-label="Project"], select[aria-label="Agent"]')).toHaveCount(0);
    await expect(page.getByText("Advanced Agents", { exact: true })).toHaveCount(0);

    const agent = page.getByRole("combobox", { name: "Agent" });
    await agent.click();
    const options = page.getByRole("listbox", { name: "Agent Options" }).getByRole("option");
    await expect(options).toHaveCount(3);
    await expect(options.filter({ hasText: "Advanced Agent" })).toHaveCount(1);

    await agent.fill("non-interactive");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("Codex — Non-Interactive");
    await page.keyboard.press("Enter");
    await expect(agent).toHaveValue(/Codex — Non-Interactive/);
  });
});

for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
  test.describe(`common keyboard path at ${viewport.name} width`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
    });

    test("selects Project and Agent, then submits with the popup safely closed", async ({ page }) => {
      await openDialogWithoutPointer(page);
      await selectCommonProjectWithoutPointer(page);

      // Every step between the two data-backed selectors remains keyboard-reachable and ordered:
      // Project management, the required Location, then Agent.
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Create Project…" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("radiogroup", { name: "Project Location" }).getByRole("radio"))
        .toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Add Location…" })).toBeFocused();
      await page.keyboard.press("Tab");

      const agent = page.getByRole("combobox", { name: "Agent" });
      await expect(agent).toBeFocused();
      await page.keyboard.type("codex app server");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(agent).toHaveValue(/Codex App Server/);

      // The first Enter belonged to the open combobox. Only the next Enter, after it closed,
      // reaches the native form's default submit action.
      await expect(page.getByRole("dialog", { name: "New Session" })).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "New Session" })).toHaveCount(0);
      await expect.poll(async () => page.locator("html").getAttribute("data-create-session-count"))
        .toBe("1");
    });
  });
}

test.describe("New Session dialog keyboard contract", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("traps focus, validates, closes the selector before the dialog, and restores its opener", async ({ page }) => {
    const { dialog, opener } = await openDialogWithoutPointer(page);

    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();

    await page.keyboard.press("ControlOrMeta+Enter");
    const project = page.getByRole("combobox", { name: "Project" });
    await expect(page.getByRole("alert")).toHaveText("Choose a Project or No Project.");
    await expect(project).toBeFocused();
    await expect(project).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("Escape");
    await expect(project).toHaveAttribute("aria-expanded", "false");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("modified Enter ignores composition and repeats and permits only one delayed creation", async ({ page }) => {
    await openDialogWithoutPointer(page, "&createDelay=250");
    const project = await selectCommonProjectWithoutPointer(page);

    await project.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, repeat: true });
    await project.dispatchEvent("keydown", { key: "Enter", metaKey: true, isComposing: true });
    await expect(page.locator("html")).not.toHaveAttribute("data-create-session-count", /.+/);

    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(async () => page.locator("html").getAttribute("data-create-session-count"))
      .toBe("1");
    await expect(page.getByRole("dialog", { name: "New Session" })).toHaveCount(0);
  });
});

test.describe("unavailable preset", () => {
  // One run, at the BINDING width rather than a comfortable one. Review caught that calling this
  // "viewport-independent" was wrong: it asserts geometry, and a disabled card carries the longest
  // content in the group — title, description AND reason — so 320px is where its extra wrapped
  // lines would be clipped first. Running it at 390px would have passed while 320px broke.
  test.use({ viewport: { width: REFLOW_WIDTH, height: 640 } });

  test("an unavailable preset is readable rather than hidden", async ({ page }) => {
    await openDialog(page, "?orchestrator=0");
    const orchestrator = permissionPresets(page).getByRole("radio", { name: /Orchestrator/ });
    // Rendered, not dropped — §11.3. The list used to omit it entirely, so a user could not learn
    // that the reason was their agent.
    await expect(orchestrator).toBeVisible();
    await expect(orchestrator).toHaveAttribute("aria-disabled", "true");
    await expect(orchestrator).toContainText(/does not offer the Orchestrator/);
    expect((await overflow(orchestrator)).vertical).toBeLessThanOrEqual(1);
  });
});

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
