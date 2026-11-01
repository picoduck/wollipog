import { expect, test, type Locator, type Page } from "@playwright/test";

// These cases exercise the explicitly enabled privacy mode. Default-off behavior has separate coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});
import { dialogMotionSettled } from "./dialog-motion.js";
import { pinWidestFace } from "./font-geometry.js";

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
 * Three viewports chosen to cover the touch floor and the tap-only picker, which since #1799 are
 * two different conditions.
 *
 * `styles.css` applies the 44px floor in its one coarse-pointer block, `@media (pointer: coarse)`,
 * and `useTouchTargetMode()` queries exactly that, so the estimator raises its budget only where the
 * floor renders. A narrow window with a MOUSE keeps the compact rows (`floor: false`). New Session's
 * Project and Agent pickers are still tap-only at phone widths as well as on touch
 * (`TAP_ONLY_PICKER_MEDIA`), so the reflow-minimum case covers that width path at no extra cost, and
 * keeps the WCAG reflow width where it belongs.
 */
const VIEWPORTS = [
  // The reported defect: a phone, where the pointer is what activates the floor.
  { name: "phone", width: 390, height: 780, touch: true, floor: true, tapOnly: true, stacked: true },
  // The WCAG reflow minimum with a MOUSE: no touch floor, but the phone-width tap-only pickers.
  { name: "reflow-minimum", width: REFLOW_WIDTH, height: 640, touch: false, floor: false, tapOnly: true, stacked: true },
  // Wide and fine-pointered: no floor at all, so the compact budget must still be used. Options'
  // 520px surface keeps each control beside its text here (#2955).
  { name: "desktop", width: 1280, height: 900, touch: false, floor: false, tapOnly: false, stacked: false },
] as const;

async function openDialog(page: Page, query = "") {
  await page.goto(`/new-session-choices-e2e.html${query}`);
  await expect(page.getByRole("heading", { name: "New Session" })).toBeVisible();
  await dialogMotionSettled(page);
}

test("selects a provider account and submits its opaque id", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDialog(page);

  const account = page.getByRole("button", { name: /Account:/ });
  await expect(account).toHaveAccessibleName(/Account: Work/);
  await account.click();
  await page.getByRole("option", { name: /Personal/ }).click();
  await expect(account).toHaveAccessibleName(/Account: Personal/);

  await page.screenshot({ path: "test-results/provider-accounts/new-session-account.png", fullPage: true });
  await page.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.createSessionRequest))
    .toContain('"providerAccountId":"claude-personal"');
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 780 },
] as const) {
  test(`email-named accounts stay masked until a deliberate reveal on ${viewport.name} (#1648)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openDialog(page, "?emailAccounts=1");

    const account = page.getByRole("button", { name: /Account:/ });
    await expect(account).toHaveAccessibleName(/Account: Hidden Account 1/);
    expect(await page.content()).not.toContain("@example.");
    await account.click();
    await expect(page.getByRole("option")).toHaveText([/Hidden Account 1/, /Hidden Account 2/]);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `test-results/personal-identifiers/new-session-masked-${viewport.name}.png` });

    // Keyboard reveal and hide: the control names the action, never the value.
    const reveal = page.getByRole("button", { name: "Show Emails" });
    await reveal.focus();
    await page.keyboard.press("Enter");
    await expect(account).toHaveAccessibleName(/Account: work\.me@example\.com/);
    const hide = page.getByRole("button", { name: "Hide Emails" });
    await expect(hide).toBeFocused();
    await page.screenshot({ path: `test-results/personal-identifiers/new-session-revealed-${viewport.name}.png` });
    await page.keyboard.press("Space");
    await expect(account).toHaveAccessibleName(/Account: Hidden Account 1/);
    expect(await page.content()).not.toContain("@example.");

    // Reopening the surface never inherits the earlier reveal.
    await openDialog(page, "?emailAccounts=1");
    await expect(page.getByRole("button", { name: /Account:/ })).toHaveAccessibleName(/Hidden Account 1/);
  });
}

async function openDialogWithoutPointer(page: Page, query = "") {
  await page.goto(`/new-session-choices-e2e.html?keyboard=1${query}`);
  const opener = page.getByRole("button", { name: "New Session" });
  await page.keyboard.press("Tab");
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New Session" });
  await expect(dialog).toBeVisible();
  const project = page.getByRole("combobox", { name: "Project" });
  if (await project.count()) await expect(project).toBeFocused();
  else await expect(dialog).toBeFocused();
  return { dialog, opener };
}

async function selectCommonProjectWithoutPointer(page: Page, touch = false) {
  const project = touch
    ? page.getByRole("button", { name: /^Project:/ })
    : page.getByRole("combobox", { name: "Project" });
  if (touch) {
    await page.keyboard.press("Tab");
    // A phone shows New Session as a full-height sheet, whose header has Back instead of Close (§7.5).
    await expect(page.getByRole("button", { name: "Back" })).toBeFocused();
    await page.keyboard.press("Tab");
  }
  await expect(project).toBeFocused();
  if (touch) {
    await page.keyboard.press("Enter");
    // The touch list is searchable (#1951): it opens with its own filter focused.
    await expect(page.getByRole("combobox", { name: "Search Project Options" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(project).toHaveAccessibleName(/Project: Wollipog/);
  } else {
    // Focus leaves the list closed (#2952); typing opens it with the first match highlighted.
    await expect(project).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.type("Wollipog");
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Enter");
    await expect(project).toHaveValue(/Wollipog/);
  }
  await expect(project).toBeFocused();
  return project;
}

/**
 * Options (#2954): every choice below Agent is one row, whose setting rows render only once it is
 * open. Opens it, if it is not already.
 */
async function openOptions(page: Page): Promise<Locator> {
  const head = page.getByRole("button", { name: "Options", exact: true });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return head;
}

const permissionPresets = (page: Page) =>
  page.getByRole("radiogroup", { name: "Role" });

/** The setting row a control sits in: its title, and the sentence that says what it does or why it can't. */
const settingRow = (control: Locator) =>
  control.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' setting-row ')][1]");

/**
 * Whether an element's own content overflows the box it is drawn in.
 *
 * This is the exact shape of the defect — `scrollHeight` past `clientHeight` IS the clipping — and
 * it is a comparison of an element with itself, so it carries no assumption about font size,
 * zoom or platform.
 */
/**
 * How far an element's own text reaches past its box. A segmented option's coarse-pointer hit area
 * (#1799) deliberately extends past the option, so its scroll size is not a clipping signal; its
 * label's extent is.
 */
async function textOverflow(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return Math.max(0, box.top - text.top, text.bottom - box.bottom, box.left - text.left, text.right - box.right);
  });
}

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

    test("Options' segmented rows span their rows, nothing is clipped, and nothing overflows the form", async ({ page }) => {
      await openDialog(page);
      await openOptions(page);
      const group = permissionPresets(page);
      const options = group.getByRole("radio");
      await expect(options).toHaveCount(2);

      // The structural half: Role is pills in its row, with no trigger or popup. The initial-focus
      // Project combobox may legitimately have its own autocomplete open.
      await expect(group.locator(".ui-select-trigger, .menu.listbox")).toHaveCount(0);

      const groupBox = await group.boundingBox();
      expect(groupBox).not.toBeNull();
      for (const option of await options.all()) {
        await expect(option).toBeVisible();
        const box = (await option.boundingBox())!;
        expect(box.height).toBeGreaterThan(0);
        expect(box.y).toBeGreaterThanOrEqual(groupBox!.y - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(groupBox!.y + groupBox!.height + 1);
        expect(await textOverflow(option), "the option's label is not clipped").toBeLessThanOrEqual(1);
      }

      // Horizontal reflow, asserted from the SAME page load rather than a second one (#842).
      const form = page.locator(".form");
      const formBox = (await form.boundingBox())!;
      for (const selector of [".seg", ".ui-select-trigger", ".ui-searchable-combobox-input", ".setting-row"]) {
        for (const control of await page.locator(selector).all()) {
          if (!(await control.isVisible())) continue;
          const box = (await control.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(formBox.x - 1);
          expect(box.x + box.width, `${selector} overflows the form`)
            .toBeLessThanOrEqual(formBox.x + formBox.width + 1);
        }
      }

      if (viewport.tapOnly) {
        await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Agent:/ })).toBeVisible();
      } else {
        await expect(page.getByRole("combobox", { name: "Agent" })).toBeVisible();
      }

      // Every segmented control is full width (`.seg.block`): it spans its row's control column. On a
      // phone that is the whole row under its text (§8.2's narrow rule), at 44px on touch with
      // #1799's hit areas; in the desktop dialog it is the 240px column beside the text (#2955).
      for (const name of ["Role", "Harness", "Working Copy"]) {
        const seg = page.getByRole("radiogroup", { name });
        await expect(seg).toHaveClass(/\bblock\b/);
        const segBox = (await seg.boundingBox())!;
        const rowBox = (await settingRow(seg).boundingBox())!;
        const column = (await seg.locator("xpath=..").boundingBox())!;
        expect(Math.abs(segBox.width - column.width), `${name} spans its control column`).toBeLessThanOrEqual(1);
        if (viewport.stacked) {
          expect(segBox.width, `${name} spans most of its row`).toBeGreaterThan(rowBox.width * 0.85);
        } else {
          const text = (await settingRow(seg).locator(".setting-row-text").boundingBox())!;
          expect(Math.round(segBox.width), `${name} fills the 240px control column`).toBe(240);
          expect(segBox.x, `${name} sits beside its text`).toBeGreaterThan(text.x + text.width);
          expect(segBox.y, `${name} shares its text's line`).toBeLessThan(text.y + text.height);
        }
        for (const option of await seg.getByRole("radio").all()) {
          const box = (await option.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(segBox.x - 1);
          expect(box.x + box.width).toBeLessThanOrEqual(segBox.x + segBox.width + 1);
          if (viewport.floor) {
            // The track is the 44px control; each option is 38px inside its 2px inset and 1px edge,
            // and the coarse-pointer block extends the option's hit area over both (#1799).
            expect(segBox.height).toBeGreaterThanOrEqual(43);
            const hitsEdges = await option.evaluate((element) => {
              element.scrollIntoView({ block: "center" });
              const rect = element.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              return [rect.top - 2.5, rect.bottom + 2.5].every((y) => element.contains(document.elementFromPoint(x, y)));
            });
            expect(hitsEdges, `${name}: the option's hit area reaches the track's edge`).toBe(true);
          }
        }
      }

      // The Options body is part of the sheet's one scroller: nothing between it and the dialog
      // body, and nothing inside it, scrolls on its own.
      const scrollers = await page.locator(".session-options-body").evaluate((body) => {
        const scrolls = (element: Element) => /(auto|scroll)/.test(getComputedStyle(element).overflowY);
        const found: string[] = [];
        for (let node: Element | null = body; node && !node.classList.contains("modal-body"); node = node.parentElement) {
          if (scrolls(node)) found.push(node.className);
        }
        for (const element of body.querySelectorAll("*")) if (scrolls(element)) found.push(element.className);
        return found;
      });
      expect(scrollers, "no nested scroller").toEqual([]);
    });

    test("a two-option Select opens a list its own options fit inside", async ({ page }) => {
      // Skipped only where the floor genuinely does not apply: a fine pointer at any width, since
      // the floor is keyed to the pointer (#1799).
      test.skip(!viewport.floor, "no touch floor applies with this pointer");
      // AC4, against the shared primitive rather than the one control that hit the defect. Every
      // other Select in the app — the archive filter, the agent-defaults rows, the colour-scheme
      // picker — shares this arithmetic, so the guard belongs on the primitive.
      await page.goto("/new-session-choices-e2e.html?probe=select");
      const trigger = page.getByRole("button", { name: /Two Option Probe/ });
      await expect(trigger).toBeVisible();
      await trigger.click();

      const list = page.locator(".menu.listbox");
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

test.describe("responsive Project and Agent controls", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("Projects and Agents use tap-only lists at phone width", async ({ page }) => {
    await openDialog(page, "?agentUnavailable=1");
    await expect(page.locator('input[aria-label="Project"]')).toHaveCount(0);
    const project = page.getByRole("button", { name: /^Project:/ });
    await expect(project).toHaveAccessibleName(/Project: Wollipog/);
    await project.click();
    // Searchable (#1951): the filter inside the list takes focus, never a field the sheet covers.
    await expect(page.getByRole("combobox", { name: "Search Project Options" })).toBeFocused();

    const projects = page.getByRole("listbox", { name: "Project" }).getByRole("option");
    // Wollipog, No Project and the New Project… footer row (#2952).
    await expect(projects).toHaveCount(3);
    await expect(projects.last()).toHaveText("New Project…");
    await expect(projects.filter({ hasText: "Wollipog" })).toHaveCount(1);
    await projects.filter({ hasText: "No Project" }).click();
    await expect(project).toHaveAccessibleName("Project: No Project");

    await expect(page.getByText("Advanced Agents", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toHaveCount(0);

    const agent = page.getByRole("button", { name: /^Agent:/ });
    await expect(agent).toHaveAccessibleName(/Agent: Claude Code/);
    await agent.click();
    await expect(page.getByRole("combobox", { name: "Search Agent Options" })).toBeFocused();

    const options = page.getByRole("listbox", { name: "Agent" }).getByRole("option")
      .filter({ hasNotText: "Set Up Agents in Connections" });
    // Claude Code, Codex App Server, and Pi; the retired Codex exec agent is never listed (#3259).
    await expect(options).toHaveCount(3);
    await expect(options.filter({ hasText: /Non-Interactive|codex exec/ })).toHaveCount(0);
    await expect(options.filter({ hasText: "Pi" })).toContainText("RPC");
    const unavailable = options.filter({ hasText: "Codex App Server" });
    await expect(unavailable).toHaveAttribute("aria-disabled", "true");
    await expect(unavailable).toContainText("Sign in before the session can start.");

    await options.filter({ hasText: "Pi" }).click();
    await expect(agent).toHaveAccessibleName(/Agent: Pi RPC/);
    // No mechanism line under the field (#2953).
    await expect(page.locator(".agent-meta")).toHaveCount(0);
  });
});

test.describe("the tap-only Agent list at phone width with a mouse", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test("a short list grows to its wrapped second lines instead of scrolling", async ({ page }) => {
    // At 390px, in the app font, a long second line wraps. The list's height request counted it as
    // one line, so a short list scrolled to show its last line and clipped it at the bottom edge.
    // This page pins Arial, which may not wrap here, so the test measures in the widest verified
    // face and first proves the line wrapped. Project's "No Project" line was the case until #2952
    // shortened it; an App Server whose check failed has the longest second line in the dialog.
    // A mouse at phone width keeps the tap-only list with compact rows: on touch, the Ready and Needs
    // Setup labels and the footer row (#2953) take this list past its 320px cap, where scrolling is
    // the design rather than a misjudged height.
    await openDialog(page, "?appServerCheck=timeout");
    const face = await pinWidestFace(page, page.locator("body"));
    await page.getByRole("button", { name: /^Agent:/ }).click();
    // The searchable list's scroll box is its panel, which holds the filter above the listbox.
    const list = page.locator(".menu.listbox");
    // Claude Code, Pi, Codex App Server, and the Set Up Agents in Connections footer row.
    await expect(list.getByRole("option")).toHaveCount(4);
    const description = list.getByRole("option", { name: /Codex App Server/ }).locator(".ui-select-option-reason");
    const descriptionLines = await description.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });
    expect(descriptionLines, `the description wraps in ${face}`).toBeGreaterThan(1);
    const fit = await list.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      lastBottom: element.querySelector("[role=option]:last-child")!.getBoundingClientRect().bottom,
      listBottom: element.getBoundingClientRect().bottom,
    }));
    expect(fit.scrollHeight, "the list sizes to its content").toBeLessThanOrEqual(fit.clientHeight + 1);
    expect(fit.lastBottom, "the last option sits inside the list").toBeLessThanOrEqual(fit.listBottom);
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
      await selectCommonProjectWithoutPointer(page, viewport.touch);

      // Every step between the two data-backed selectors remains keyboard-reachable and ordered:
      // Project, then the Location beside it, then Agent (#2952).
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: /^Location:/ })).toBeFocused();
      await page.keyboard.press("Tab");

      if (viewport.touch) {
        const agent = page.getByRole("button", { name: /^Agent:/ });
        await expect(agent).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("combobox", { name: "Search Agent Options" })).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await expect(agent).toHaveAccessibleName(/Agent: Codex App Server/);
        await agent.press("ControlOrMeta+Enter");
      } else {
        const agent = page.getByRole("combobox", { name: "Agent" });
        await expect(agent).toBeFocused();
        // Focus leaves the caret after "Claude Code" rather than selecting it (#1951), so replace
        // the value the way a person would before searching.
        await page.keyboard.press("ControlOrMeta+a");
        // Typing highlights the first match; Arrow Down from it would reach Set Up Agents in
        // Connections (#2953).
        await page.keyboard.type("codex app server");
        await page.keyboard.press("Enter");
        await expect(agent).toHaveValue(/Codex App Server/);

        // The first Enter belonged to the open combobox. Only the next Enter, after it closed,
        // reaches the native form's default submit action.
        await page.keyboard.press("Enter");
      }

      await expect(page.getByRole("dialog", { name: "New Session" })).toHaveCount(0);
      await expect.poll(async () => page.locator("html").getAttribute("data-create-session-count"))
        .toBe("1");
    });
  });
}

test.describe("responsive Project and Agent presentation", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the searchable and Select lists size to their content at desktop width", async ({ page }) => {
    await openDialog(page);
    const fits = (name: string) => page.getByRole("listbox", { name }).evaluate((element) =>
      element.scrollHeight <= element.clientHeight + 1);
    // The Project combobox has initial focus with its list closed (#2952); Arrow Down opens it.
    await expect(page.getByRole("combobox", { name: "Project" })).toBeFocused();
    await expect(page.getByRole("listbox", { name: "Project Options" })).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox", { name: "Project Options" })).toBeVisible();
    expect(await fits("Project Options")).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Account:/ }).click();
    await expect(page.getByRole("listbox", { name: "Account" })).toBeVisible();
    expect(await fits("Account")).toBe(true);
  });

  test("keeps focus on each logical selector while its responsive control changes", async ({ page }) => {
    await openDialog(page);

    const desktopProject = page.getByRole("combobox", { name: "Project" });
    await desktopProject.focus();
    await expect(desktopProject).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const desktopProjectOptions = page.getByRole("listbox", { name: "Project Options" });
    await expect(desktopProjectOptions).toBeVisible();

    await page.setViewportSize({ width: 390, height: 780 });
    const touchProject = page.getByRole("button", { name: /^Project:/ });
    await expect(touchProject).toBeFocused();
    await expect(desktopProjectOptions).toHaveCount(0);

    await touchProject.press("Enter");
    const touchProjectOptions = page.getByRole("listbox", { name: "Project", exact: true });
    await expect(touchProjectOptions).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Search Project Options" })).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("combobox", { name: "Project" })).toBeFocused();
    await expect(touchProjectOptions).toHaveCount(0);

    const desktopAgent = page.getByRole("combobox", { name: "Agent" });
    await desktopAgent.focus();
    await expect(desktopAgent).toBeFocused();
    const desktopAgentOptions = page.getByRole("listbox", { name: "Agent Options" });
    await expect(desktopAgentOptions).toBeVisible();

    await page.setViewportSize({ width: 390, height: 780 });
    const touchAgent = page.getByRole("button", { name: /^Agent:/ });
    await expect(touchAgent).toBeFocused();
    await expect(desktopAgentOptions).toHaveCount(0);

    await touchAgent.press("Enter");
    const touchAgentOptions = page.getByRole("listbox", { name: "Agent", exact: true });
    await expect(touchAgentOptions).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Search Agent Options" })).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("combobox", { name: "Agent" })).toBeFocused();
    await expect(touchAgentOptions).toHaveCount(0);
  });

  test("does not move unrelated focus when the responsive controls change", async ({ page }) => {
    await openDialog(page);
    // The header's Close becomes Back on a phone sheet (§7.5). It is one element, so the crossing
    // renames it without moving focus.
    const close = page.getByRole("dialog", { name: "New Session" }).locator(".modal-head .icon-btn");
    await expect(close).toHaveAccessibleName("Close");
    await close.focus();

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(close).toBeFocused();
    await expect(close).toHaveAccessibleName("Back");
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(close).toBeFocused();
    await expect(close).toHaveAccessibleName("Close");
  });

  test("keeps both selections while switching between searchable and tap-only controls", async ({ page }) => {
    await openDialog(page);
    const desktopProject = page.getByRole("combobox", { name: "Project" });
    await desktopProject.fill("No Project");
    await page.keyboard.press("Enter");
    await expect(desktopProject).toHaveValue("No Project");

    const desktopAgent = page.getByRole("combobox", { name: "Agent" });
    // Not `fill()`: it selects the text BEFORE focusing, and focus now leaves the caret after the
    // value instead of keeping a selection (#1951). Replace the value the way a person would.
    await desktopAgent.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("pi rpc");
    await page.keyboard.press("Enter");
    await expect(desktopAgent).toHaveValue(/Pi RPC/);

    await page.setViewportSize({ width: 390, height: 780 });
    const touchProject = page.getByRole("button", { name: /^Project:/ });
    await expect(touchProject).toHaveAccessibleName("Project: No Project");
    await touchProject.click();
    await page.getByRole("listbox", { name: "Project" }).getByRole("option", { name: /Wollipog/ }).click();

    const touchAgent = page.getByRole("button", { name: /^Agent:/ });
    await expect(touchAgent).toHaveAccessibleName(/Agent: Pi RPC/);

    await touchAgent.click();
    await page.getByRole("listbox", { name: "Agent" }).getByRole("option", { name: /Claude Code/ }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue("Wollipog");
    await expect(page.getByRole("combobox", { name: "Agent" })).toHaveValue("Claude Code");
  });
});

test.describe("New Session dialog keyboard contract", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("plain Enter in the closed Project field names its problem under the field", async ({ page }) => {
    await openDialogWithoutPointer(page);
    const project = page.getByRole("combobox", { name: "Project" });
    await expect(project).toBeFocused();
    await expect(project).toHaveAttribute("aria-expanded", "false");
    // Not a hard block (#2952): Create Session stays enabled and pressing it finds the field.
    await expect(page.getByRole("button", { name: "Create Session" })).toBeEnabled();

    await page.keyboard.press("Enter");
    await expect(page.locator(".modal-body .field-error")).toHaveText("Choose a project, or choose No Project.");
    await expect(project).toHaveAttribute("aria-invalid", "true");
    await expect(project).toHaveAccessibleDescription("Choose a project, or choose No Project.");
    await expect(project).toBeFocused();
    await expect(page.locator(".modal-foot .form-error")).toHaveCount(0);
  });

  test("traps focus, validates, closes the selector before the dialog, and restores its opener", async ({ page }) => {
    const { dialog, opener } = await openDialogWithoutPointer(page);

    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
    // Create Session stays enabled with no project chosen yet (#2952), so it ends the trap.
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Create Session" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();

    await page.keyboard.press("ControlOrMeta+Enter");
    const project = page.getByRole("combobox", { name: "Project" });
    await expect(page.locator(".modal-body .field-error")).toHaveText("Choose a project, or choose No Project.");
    await expect(project).toBeFocused();
    // Validation focus leaves the list closed, as opening focus does (#2952).
    await expect(project).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("ArrowDown");
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

    // Project, then Location beside it, then Agent (#2952).
    for (let index = 0; index < 2; index += 1) await page.keyboard.press("Tab");
    const agent = page.getByRole("combobox", { name: "Agent" });
    await expect(agent).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    // Typing highlights the first match; Arrow Down from it would reach the footer action (#2953).
    await page.keyboard.type("codex app server");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(agent).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("html")).not.toHaveAttribute("data-create-session-count", /.+/);
    await page.keyboard.press("Enter");
    await expect(agent).toHaveValue(/Codex App Server/);

    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(async () => page.locator("html").getAttribute("data-create-session-count"))
      .toBe("1");
    await expect(page.getByRole("dialog", { name: "New Session" })).toHaveCount(0);
  });

  test("modified Enter submits from a Select trigger instead of reopening its list", async ({ page }) => {
    await openDialogWithoutPointer(page);
    const project = page.getByRole("combobox", { name: "Project" });
    await expect(project).toBeFocused();
    // Typing highlights the first match; Arrow Down from it would reach New Project… (#2952).
    await page.keyboard.type("No Project");
    await page.keyboard.press("Enter");
    await expect(project).toHaveValue("No Project");

    const workspace = page.getByRole("button", { name: /Workspace:/ });
    await expect(workspace).toHaveAttribute("aria-expanded", "false");
    await workspace.press("ControlOrMeta+Enter");
    await expect(page.getByRole("dialog", { name: "New Session" })).toHaveCount(0);
    await expect.poll(async () => page.locator("html").getAttribute("data-create-session-count"))
      .toBe("1");
  });
});

test.describe("unavailable preset", () => {
  // One run, at the BINDING width rather than a comfortable one: a disabled option's reason is the
  // longest sentence its row carries, so 320px is where it would be clipped first.
  test.use({ viewport: { width: REFLOW_WIDTH, height: 640 } });

  test("an unavailable Orchestrator keeps its place and its row says why (#2954)", async ({ page }) => {
    await openDialog(page, "?orchestrator=0");
    await openOptions(page);
    const orchestrator = permissionPresets(page).getByRole("radio", { name: "Orchestrator" });
    // Rendered, not dropped — §11.3. The list used to omit it entirely, so a user could not learn
    // that the reason was their agent.
    await expect(orchestrator).toBeVisible();
    await expect(orchestrator).toHaveAttribute("aria-disabled", "true");
    await expect(orchestrator).toHaveAccessibleDescription("Claude Code doesn't offer the Orchestrator role.");
    // The reason replaces the row's description rather than hiding in a tooltip.
    await expect(settingRow(orchestrator).locator(".setting-row-desc")).toHaveText("Claude Code doesn't offer the Orchestrator role.");
    expect((await overflow(settingRow(orchestrator))).vertical).toBeLessThanOrEqual(1);
    // And it is in the arrow order, so a keyboard reaches the reason.
    await permissionPresets(page).getByRole("radio", { name: "Normal" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(orchestrator).toBeFocused();
    await expect(orchestrator).toHaveAttribute("aria-checked", "false");
  });
});

test.describe("increased text size", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("Options' rows stay unclipped when the user enlarges text", async ({ page }) => {
    // The other half of WCAG Reflow, and the half a fixed per-option pixel budget cannot satisfy by
    // construction: at 150% the rows are taller than any constant the estimator could name.
    await openDialog(page);
    await page.addStyleTag({ content: "html { font-size: 150%; }" });
    await openOptions(page);
    const group = permissionPresets(page);
    await expect(group.getByRole("radio")).toHaveCount(2);
    for (const option of await group.getByRole("radio").all()) {
      await expect(option).toBeVisible();
      expect(await textOverflow(option), "the option's label is not clipped").toBeLessThanOrEqual(1);
    }
    for (const row of await page.locator(":is(.new-session-role, .session-options-body) .setting-row").all()) {
      expect((await overflow(row)).vertical).toBeLessThanOrEqual(1);
    }
    expect((await overflow(group)).vertical).toBeLessThanOrEqual(1);
    // Closed, the head's meta wraps rather than clipping.
    const head = page.getByRole("button", { name: "Options", exact: true });
    await head.click();
    expect((await overflow(head)).horizontal).toBeLessThanOrEqual(1);
    expect((await overflow(head)).vertical).toBeLessThanOrEqual(1);

    const agent = page.getByRole("button", { name: /^Agent:/ });
    await agent.click();
    const list = page.locator(".menu.listbox");
    const listBox = (await list.boundingBox())!;
    expect(listBox.x).toBeGreaterThanOrEqual(0);
    expect(listBox.y).toBeGreaterThanOrEqual(0);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(390);
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(780);
    // The last agent, above the Set Up Agents in Connections footer row (#2953).
    const lastOption = list.getByRole("option").filter({ hasNotText: "Set Up Agents in Connections" }).last();
    await lastOption.scrollIntoViewIfNeeded();
    await lastOption.click();
    await expect(agent).toHaveAccessibleName(/Agent: Pi RPC/);
  });
});

test.describe("Options at 1440px (#2954)", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("with every option at its default, the dialog is at most 420px from its description to its footer", async ({ page }) => {
    await openDialog(page);
    const head = page.getByRole("button", { name: "Options", exact: true });
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(head.locator(".session-options-meta-item")).toHaveText(["Direct", "In Place", "Harness Default"]);
    // Role is always visible above Options (#3929), with both choices one click away.
    const role = permissionPresets(page);
    await expect(role).toBeVisible();
    await expect(role.getByRole("radio")).toHaveText(["Normal", "Orchestrator"]);
    const description = (await page.locator(".modal-desc").boundingBox())!;
    const footer = (await page.locator(".modal-foot").boundingBox())!;
    const height = footer.y - (description.y + description.height);
    expect(height, `${height}px from the description to the footer`).toBeLessThanOrEqual(420);
    // One closed row: the head is the only thing Options draws.
    await expect(page.locator(".session-options-body")).toBeHidden();
  });

  test("one click on the visible Role chooses Orchestrator, shows its policy, and leaves Options closed (#3929)", async ({ page }) => {
    await openDialog(page, "?policy=1&role=1");
    const head = page.getByRole("button", { name: "Options", exact: true });
    await permissionPresets(page).getByRole("radio", { name: "Orchestrator" }).click();
    await expect(permissionPresets(page).getByRole("radio", { name: "Orchestrator" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("button", { name: "Customize…" })).toBeVisible();
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".session-options-body")).toBeHidden();
    await page.getByRole("button", { name: "Create Session" }).click();
    const request = JSON.parse(await page.locator("html").getAttribute("data-create-session-request") ?? "{}");
    expect(request.orchestrator).toBeTruthy();
  });

  test("a container target opens Options by itself and shows the skills notice under Run On", async ({ page }) => {
    await openDialog(page, "?containerTargets=1");
    await openOptions(page);
    await page.getByRole("button", { name: /^Run On:/ }).click();
    await page.getByRole("option", { name: /Offline Container/ }).click();
    const notice = page.getByRole("status", { name: "Skills Unavailable" });
    await expect(notice).toContainText("so release-notes and review-pr can’t be used here.");
    await expect(notice).toBeInViewport();
    await expect(settingRow(page.getByRole("button", { name: /^Run On:/ })).locator("xpath=following-sibling::*[1]"))
      .toContainText(/Skills from .+ aren’t available in container sessions/);
    await expect(settingRow(page.getByRole("button", { name: /^Run On:/ })).locator(".setting-row-desc"))
      .toHaveText("No network, secrets or billing. Only the workspace is mounted.");
    const head = page.getByRole("button", { name: "Options", exact: true });
    await head.click();
    await expect(head.locator(".status.t-warning")).toHaveText("Skills Unavailable");
  });

  test("the cloud budget is a 96px field with its unit inside, and 0 shows its error", async ({ page }) => {
    await openDialog(page, "?cloudTargets=1");
    await openOptions(page);
    await page.getByRole("button", { name: /^Run On:/ }).click();
    await page.getByRole("option", { name: /Cloud Sandbox/ }).click();
    const budget = page.getByRole("spinbutton", { name: "Cloud Budget USD" });
    await expect(budget).toHaveValue("1");
    const field = (await budget.locator("xpath=..").boundingBox())!;
    expect(field.width).toBe(96);
    await expect(budget.locator("xpath=..").locator(".input-affix-text")).toHaveText("USD");
    await budget.fill("0");
    await expect(settingRow(budget).locator(".field-error")).toHaveText("Enter an amount from $1 to $50.");
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("button", { name: "Create Session" }).click();
    await expect(budget).toBeFocused();
    expect(await page.locator("html").getAttribute("data-create-session-count")).toBeNull();
  });
});

test.describe("Options on a phone (#2954)", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("the cloud budget stays a compact field under its sentence, at §8.3's 16px-text width", async ({ page }) => {
    await openDialog(page, "?cloudTargets=1");
    await openOptions(page);
    await page.getByRole("button", { name: /^Run On:/ }).click();
    await page.getByRole("option", { name: /Cloud Sandbox/ }).click();
    const budget = page.getByRole("spinbutton", { name: "Cloud Budget USD" });
    const field = (await budget.locator("xpath=..").boundingBox())!;
    const row = (await settingRow(budget).boundingBox())!;
    expect(field.width).toBe(120);
    expect(field.x - row.x, "at the row's start, under its text").toBeLessThan(24);
  });
});

test.describe("an ACP agent (#1360)", () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 780 }]) {
    test(`an ACP Orchestrator's notice says the preset sets its permissions, at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openDialog(page, "?acp=1&savedAgent=gemini");
      const agent = viewport.width > 760
        ? page.getByRole("combobox", { name: "Agent" })
        : page.getByRole("button", { name: /^Agent:/ });
      if (viewport.width > 760) await expect(agent).toHaveValue("Gemini");
      else await expect(agent).toHaveAccessibleName(/Agent: Gemini/);
      await openOptions(page);
      // An ACP agent offers its workspace's extra folders, one checkbox row each.
      const folders = page.getByRole("group", { name: "Extra Folders" });
      await expect(folders.getByRole("checkbox")).toHaveCount(2);
      await expect(settingRow(folders).locator(".setting-row-title")).toHaveText("Extra Folders (Preview)");
      await permissionPresets(page).getByRole("radio", { name: "Orchestrator" }).click();
      const notice = page.locator(".session-options-body > .notice.t-warning");
      await expect(notice).toContainText("Permissions Set by the Orchestrator Preset");
      await expect(notice).toContainText("This agent's adapter can't run an Orchestrator with normal permissions, so the preset sets them.");
      await expect(settingRow(page.getByText("Permissions", { exact: true })).locator(".setting-row-value-text"))
        .toHaveText("Orchestrator Preset");
    });
  }
});

/**
 * #1951: the searchable pickers read as fields — the Select's chevron, the brand icon inside the
 * field, a caret rather than a selection on focus — and keep search on touch.
 */

/** A plain text field in the same form, for the one-control-height comparison (§3.2, #1799). */
async function probeTextInput(page: Page): Promise<Locator> {
  await page.locator(".form").evaluate((form) => {
    const field = document.createElement("div");
    field.className = "field";
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", "Height Probe");
    field.append(input);
    form.prepend(field);
  });
  return page.getByRole("textbox", { name: "Height Probe" });
}

async function height(locator: Locator): Promise<number> {
  return (await locator.boundingBox())!.height;
}

test.describe("searchable pickers at 1440px (#1951)", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("the Agent icon sits inside its field, whose left edge is Project's", async ({ page }) => {
    await openDialog(page);
    const project = page.getByRole("combobox", { name: "Project" });
    const agent = page.getByRole("combobox", { name: "Agent" });
    const projectBox = (await project.boundingBox())!;
    const agentBox = (await agent.boundingBox())!;
    expect(Math.abs(agentBox.x - projectBox.x), "the Agent field starts where the Project field does")
      .toBeLessThanOrEqual(0.5);

    const agentField = page.locator(".field", { has: agent });
    const icons = agentField.locator(".agent-icon");
    await expect(icons).toHaveCount(1);
    const iconBox = (await icons.boundingBox())!;
    expect(iconBox.x).toBeGreaterThan(agentBox.x);
    expect(iconBox.x + iconBox.width).toBeLessThan(agentBox.x + agentBox.width);
    expect(iconBox.y).toBeGreaterThanOrEqual(agentBox.y);
    expect(iconBox.y + iconBox.height).toBeLessThanOrEqual(agentBox.y + agentBox.height);
    expect(Math.round(iconBox.width), "the leading icon is 16px").toBe(16);
    // The value starts after the icon rather than under it.
    const textStart = await agent.evaluate((element) =>
      element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft));
    expect(textStart).toBeGreaterThan(iconBox.x + iconBox.width);
  });

  test("the chevron opens and closes the list, and focus never selects the value", async ({ page }) => {
    await openDialog(page);
    const agent = page.getByRole("combobox", { name: "Agent" });
    const chevron = page.locator(".field", { has: agent }).locator(".ui-picker-chevron");
    await expect(chevron.locator("svg")).toBeVisible();
    await expect(agent).toHaveAttribute("aria-expanded", "false");

    await chevron.click();
    await expect(agent).toHaveAttribute("aria-expanded", "true");
    await expect(agent).toBeFocused();
    await chevron.click();
    await expect(agent).toHaveAttribute("aria-expanded", "false");
    await expect(agent).toBeFocused();

    await page.getByRole("button", { name: /^Location:/ }).focus();
    await page.keyboard.press("Tab");
    await expect(agent).toBeFocused();
    const selection = await agent.evaluate((element: HTMLInputElement) =>
      [element.selectionStart, element.selectionEnd, element.value.length]);
    expect(selection[0], "no text is selected").toBe(selection[1]);
    expect(selection[1], "the caret follows the value").toBe(selection[2]);
  });

  // #2369: as for Select (#2285), an option's name is its label alone, and its description and any
  // unavailable reason are its accessible description, as the browser computes them.
  test("each Project and Agent option is named by its label and described by its second lines", async ({ page }) => {
    await openDialog(page, "?agentUnavailable=1");
    for (const field of ["Project", "Agent"]) {
      await page.getByRole("combobox", { name: field }).focus();
      // Project's list stays closed on focus (#2952).
      if (field === "Project") await page.keyboard.press("ArrowDown");
      // The footer action (New Project…, Set Up Agents in Connections) is a row to act on, not a
      // choice with a description.
      const options = page.getByRole("listbox", { name: `${field} Options` }).getByRole("option")
        .filter({ hasNotText: /^(New Project…|Set Up Agents in Connections)$/ });
      await expect(options.first()).toBeVisible();
      if (process.env.EVIDENCE_DIR) {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/combobox-option-names-${field.toLowerCase()}.png` });
      }
      const rows = await options.evaluateAll((elements) => elements.map((element) => ({
        label: element.querySelector(".ui-select-option-body > span")?.textContent ?? "",
        lines: [...element.querySelectorAll(".ui-select-option-desc, .ui-select-option-reason")]
          .map((line) => line.textContent ?? "").join(" "),
        reason: element.querySelector(".ui-select-option-reason") !== null,
      })));
      // Every Project has a second line; an Agent has one only when it changes the choice (#2953).
      expect(rows.every((row) => row.label !== "" && (field === "Agent" || row.lines !== "")),
        "every option has a label, and every Project a second line").toBe(true);
      if (field === "Agent") expect(rows.some((row) => row.reason), "an unavailable Agent shows its reason").toBe(true);
      for (const [index, row] of rows.entries()) {
        await expect(options.nth(index)).toHaveAccessibleName(row.label);
        await expect(options.nth(index)).toHaveAccessibleDescription(row.lines);
      }
    }
    // One concrete pair, so the comparison above cannot pass by reading the wrong elements.
    await page.getByRole("combobox", { name: "Project" }).focus();
    await page.keyboard.press("ArrowDown");
    const noProject = page.getByRole("option", { name: "No Project", exact: true });
    await expect(noProject).toHaveAccessibleDescription("Run in any folder on a machine, outside a project.");
  });

  test("a Project search with no results says so in a sentence and still offers New Project…", async ({ page }) => {
    await openDialog(page);
    const project = page.getByRole("combobox", { name: "Project" });
    await expect(project).toBeFocused();
    await page.keyboard.type("wolipogx");
    const list = page.getByRole("listbox", { name: "Project Options" });
    await expect(list).toContainText("No projects match “wolipogx”.");
    await expect(list.getByRole("option")).toHaveText(["New Project…"]);
    // A search that found nothing never highlights the footer for Enter; Arrow Down reaches it.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const create = page.getByRole("dialog", { name: "New Project" });
    await expect(create).toBeVisible();
    // Cancelling returns to the picker whose row opened it.
    await create.getByRole("button", { name: "Cancel" }).click();
    await expect(create).toHaveCount(0);
    await expect(project).toBeFocused();
  });

  test("the combobox, a Select and a text field in one form are one control height", async ({ page }) => {
    await openDialog(page);
    const probe = await probeTextInput(page);
    const heights = await Promise.all([
      height(page.getByRole("combobox", { name: "Project" })),
      height(page.getByRole("button", { name: /^Account:/ })),
      height(probe),
    ]);
    for (const value of heights) expect(value).toBeCloseTo(32, 0);
  });
});

test.describe("searchable touch pickers at 390px (#1951)", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("the Project list opens with a focused 16px filter at its top that narrows it", async ({ page }) => {
    await openDialog(page);
    await page.getByRole("button", { name: /^Project:/ }).click();
    const filter = page.getByRole("combobox", { name: "Search Project Options" });
    await expect(filter).toBeFocused();
    expect(await filter.evaluate((element) => getComputedStyle(element).fontSize),
      "16px, so iOS does not zoom the page").toBe("16px");

    const panel = page.locator(".menu.listbox");
    const options = page.getByRole("listbox", { name: "Project" }).getByRole("option");
    await expect(options).toHaveCount(3);
    const filterBox = (await filter.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    const firstOptionBox = (await options.first().boundingBox())!;
    expect(filterBox.y).toBeGreaterThanOrEqual(panelBox.y);
    expect(filterBox.y + filterBox.height, "the filter leads the options").toBeLessThanOrEqual(firstOptionBox.y);

    await page.keyboard.type("no proj");
    await expect(options).toHaveText(["No Project", "New Project…"].map((text) => new RegExp(`^${text}`)));
    expect((await filter.boundingBox())!.y, "the filter being typed into stays put as the list narrows")
      .toBeCloseTo(filterBox.y, 0);

    await filter.fill("wolipogx");
    await expect(panel).toContainText("No projects match “wolipogx”.");
    await expect(options).toHaveText(["New Project…"]);

    await options.click();
    const create = page.getByRole("dialog", { name: "New Project" });
    await expect(create).toBeVisible();
    await create.getByRole("button", { name: "Cancel" }).click();
    await expect(create).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Project:/ }), "focus returns to the picker")
      .toBeFocused();
  });

  test("a list that opens above its trigger keeps its filter still as a search empties it", async ({ page }) => {
    // A short phone (a landscape-ish window), so the Agent trigger can sit with no room below it.
    await page.setViewportSize({ width: 390, height: 480 });
    await openDialog(page);
    // Room above it for the whole list, as a longer form above Agent would leave: the Ready group's
    // label and the footer row (#2953) made the list taller than the fixture's own form offers.
    await page.addStyleTag({ content: "form.form { padding-top: 160px; }" });
    const agent = page.getByRole("button", { name: /^Agent:/ });
    await agent.evaluate((element) => element.scrollIntoView({ block: "end" }));
    await agent.click();
    const filter = page.getByRole("combobox", { name: "Search Agent Options" });
    await expect(filter).toBeFocused();
    const panelBox = (await page.locator(".menu.listbox").boundingBox())!;
    const agentBox = (await agent.boundingBox())!;
    expect(panelBox.y + panelBox.height, "no room below, so the list opened above").toBeLessThanOrEqual(agentBox.y);

    const before = (await filter.boundingBox())!.y;
    await page.keyboard.type("zzz");
    await expect(page.locator(".menu.listbox")).toContainText("No agents match “zzz”.");
    expect((await filter.boundingBox())!.y, "the bottom-anchored list held its height").toBeCloseTo(before, 0);
  });

  test("the Select trigger, the filter and a text field are all the 44px touch height", async ({ page }) => {
    await openDialog(page);
    const probe = await probeTextInput(page);
    const trigger = page.getByRole("button", { name: /^Project:/ });
    await trigger.click();
    const filter = page.getByRole("combobox", { name: "Search Project Options" });
    await expect(filter).toBeFocused();
    const heights = await Promise.all([height(trigger), height(filter), height(probe)]);
    for (const value of heights) expect(value).toBeCloseTo(44, 0);
  });
});

test.describe("Agent's Ready and Needs Setup groups on a phone (#2953)", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("at 390px the touch sheet shows both groups and a 44px Set Up Agents in Connections row", async ({ page }) => {
    await openDialog(page, "?agentSetup=1&savedAgent=pi");
    const agent = page.getByRole("button", { name: /^Agent:/ });
    await expect(agent).toHaveAccessibleName("Agent: Pi RPC");
    await agent.click();
    const list = page.getByRole("listbox", { name: "Agent", exact: true });
    await expect(list.getByRole("group")).toHaveCount(2);
    await expect(list.getByRole("group").nth(0)).toHaveAccessibleName("Ready on Studio Workstation");
    await expect(list.getByRole("group").nth(0).getByRole("option")).toHaveCount(3);
    await expect(list.getByRole("group").nth(0).getByRole("option").first()).toHaveAccessibleName("Pi RPC");
    await expect(list.getByRole("group").nth(0).getByRole("option").first())
      .toHaveAccessibleDescription("Your default on this machine · No approval cards");
    const needsSetup = list.getByRole("group").nth(1);
    await expect(needsSetup).toHaveAccessibleName("Needs Setup");
    await expect(needsSetup.getByRole("option")).toHaveText([
      /^Gemini.*Not installed on Studio Workstation\.$/,
      /^OpenCode.*Sign in before the session can start\.$/,
    ]);
    const rows = list.getByRole("option");
    await expect(rows.last()).toHaveText("Set Up Agents in Connections");
    await rows.last().scrollIntoViewIfNeeded();
    expect(Math.round((await rows.last().boundingBox())!.height), "the footer row is a 44px touch row").toBeGreaterThanOrEqual(44);
  });
});

test.describe("Agent before a location at 1440px (#2953)", () => {
  test("at 1440px Agent waits for a location, then lines up with Project", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openDialog(page, "?agentSetup=1&noPreset=1");
    const agent = page.getByRole("combobox", { name: "Agent" });
    await expect(agent).toHaveAttribute("aria-disabled", "true");
    await expect(agent).toHaveAttribute("placeholder", "Choose a Location First");
    await agent.click({ force: true });
    await expect(agent).toHaveAttribute("aria-expanded", "false");

    const project = page.getByRole("combobox", { name: "Project" });
    await project.focus();
    await page.keyboard.type("Wollipog");
    await page.keyboard.press("Enter");
    await expect(agent).not.toHaveAttribute("aria-disabled", "true");
    const projectBox = (await project.boundingBox())!;
    const agentBox = (await agent.boundingBox())!;
    expect(Math.abs(agentBox.x - projectBox.x), "the Agent field starts where the Project field does").toBeLessThanOrEqual(0.5);
  });
});
