import { expect, test, type Page } from "@playwright/test";

/**
 * The session bar on the shared 48px detail-bar anatomy (#2146; docs/design-system.md §4.3, §4.4,
 * §15.2). The real Shell is mounted, so the bar sits in the `app` size container whose width the
 * compact tier answers to, beside the rail and with the shell's Open picker and panel toggles.
 */

const GENERATED_TITLE = "Add a dark mode toggle to the site header.\n\nRequirements:\n- x";
const LONG_TITLE =
  "Add a dark mode toggle to the site header and keep the chosen theme across reloads and new windows.\n\nRequirements:\n- x";

async function openBar(
  page: Page,
  width: number,
  options: { session?: RegExp; height?: number; scenario?: string; legacyWorkspaces?: boolean } = {},
) {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  await page.goto(`/command-inbox-projects-e2e.html?scenario=${options.scenario ?? "git-visibility"}&reviewReady=1&fullShell=1${
    options.legacyWorkspaces ? "&legacyWorkspaces=1" : ""}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // Changes are a Pinned Summary fact (#2160), so two campaign request badges keep the row under
  // the pressure of three statuses that the review and change badges used to supply.
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      orchestratorCampaign: { pendingRequests: { human: 1, orchestrator: 1 } },
    } as never);
  });
  await page.getByRole("button", { name: options.session ?? /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator("header.session-bar")).toBeVisible();
}

async function setTitle(page: Page, title: string) {
  await page.evaluate((value) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { title: value });
  }, title);
}

/** The three statuses the scenario reports: lifecycle and the two campaign request kinds. */
async function expectThreeStatuses(page: Page) {
  const statuses = page.locator("header.session-bar .session-header-statuses");
  await expect(statuses.getByText("Awaiting Prompt", { exact: true })).toBeAttached();
  await expect(statuses.locator('[aria-label^="Needs Your Input"]')).toBeAttached();
  await expect(statuses.locator('[aria-label^="Orchestrator Action"]')).toBeAttached();
  // The facts the bar used to carry are in the Pinned Summary.
  await expect(statuses.getByText(/Ready for Review|Uncommitted Changes|Changes Present/)).toHaveCount(0);
}

/** Every status badge the row paints sits on one line: the row clips, it never wraps (§15.2). */
async function expectStatusesOnOneLine(page: Page) {
  const tops = await page.locator("header.session-bar .session-header-statuses").evaluate((row) =>
    [...row.querySelectorAll<HTMLElement>(".status")]
      .filter((badge) => badge.getClientRects().length > 0)
      .map((badge) => Math.round(badge.getBoundingClientRect().top)));
  expect(tops.length).toBeGreaterThanOrEqual(3);
  expect(new Set(tops).size, `badge tops ${tops.join(", ")}`).toBe(1);
}

test("at 1440px the bar is one 48px row and every control in it is 32px tall", async ({ page }) => {
  await openBar(page, 1440);
  // A title long enough to put the row under pressure, as in a real generated title.
  await setTitle(page, LONG_TITLE);
  await expectThreeStatuses(page);
  const bar = page.locator("header.session-bar");
  const geometry = await bar.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll<HTMLElement>("button, a.btn")]
      // Status badges are statuses, not controls; they keep the badge recipe's height (§11.1).
      .filter((control) => !control.closest(".session-header-statuses") && control.getClientRects().length > 0)
      .map((control) => ({
        name: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "",
        height: control.getBoundingClientRect().height,
        top: control.getBoundingClientRect().top - box.top,
      }));
    return { height: box.height, controls };
  });
  expect(geometry.height).toBe(48);
  const names = geometry.controls.map((control) => control.name);
  for (const name of ["Back to Sessions", "Alpha", "Share", "More Actions", "Toggle Pinned Summary", "Show Side Panel"]) {
    expect(names).toContain(name);
  }
  expect(geometry.controls.length).toBeGreaterThanOrEqual(8);
  for (const control of geometry.controls) {
    expect(control.height, control.name).toBe(32);
    // Centred in the row: the 47px above the bottom hairline leaves 7.5px of air either side.
    expect(control.top, control.name).toBe(7.5);
  }
  await expectStatusesOnOneLine(page);
  await expect(bar.locator("h1#page-title")).toHaveCSS("font-size", "16px");
  await expect(bar.locator("h1#page-title")).toHaveCSS("font-weight", "600");
  // One divider before the Open picker and one after it, ahead of the panel toggles.
  const order = await bar.locator(".detail-actions").evaluate((actions) =>
    [...actions.querySelectorAll(".editor-select, .detail-actions-divider, [aria-label='More Actions'], [aria-label='Toggle Pinned Summary']")]
      .map((node) => node.classList.contains("detail-actions-divider") ? "|" : node.classList.contains("editor-select") ? "Open" : node.getAttribute("aria-label")));
  expect(order).toEqual(["More Actions", "|", "Open", "|", "Toggle Pinned Summary"]);
});

test("the project button renders short names whole and truncates a long one at 220px", async ({ page }) => {
  await openBar(page, 1440);
  const button = page.locator("header.session-bar .session-project-button");
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name: "Payments Service" });
  });
  await expect(button).toHaveText("Payments Service");
  const whole = await button.locator(".session-project-button-label").evaluate((label) => ({
    clientWidth: label.clientWidth,
    scrollWidth: label.scrollWidth,
  }));
  expect(whole.scrollWidth).toBeLessThanOrEqual(whole.clientWidth);

  const longName = "Payment Service Platform Migration and Ledger Reconciliation";
  expect(longName).toHaveLength(60);
  await page.evaluate((name) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name });
  }, longName);
  await expect(button).toHaveAttribute("title", longName);
  const truncated = await button.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".session-project-button-label")!;
    return {
      width: element.getBoundingClientRect().width,
      clipped: label.scrollWidth > label.clientWidth,
      textOverflow: getComputedStyle(label).textOverflow,
    };
  });
  expect(truncated.width).toBe(220);
  expect(truncated.clipped).toBe(true);
  expect(truncated.textOverflow).toBe("ellipsis");
});

test("the project button opens Open Project and Move to Another Project…, and Open Project navigates", async ({ page }) => {
  await openBar(page, 1440);
  const button = page.locator("header.session-bar .session-project-button");
  await expect(button).toHaveAccessibleName("Alpha");
  await expect(button.locator("svg")).toHaveCount(2);
  await button.click();
  const menu = page.getByRole("menu", { name: "Project Actions" });
  await expect(menu).toBeVisible();
  await expect(menu.locator(".menu-label")).toHaveText("Alpha");
  await expect(menu.getByRole("menuitem")).toHaveText(["Open Project", "Move to Another Project…"]);
  await menu.getByRole("menuitem", { name: "Open Project" }).click();
  await expect(page.locator("header.session-bar")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page.locator('[aria-current="true"]', { hasText: "Alpha" })).toBeVisible();
});

test("folding into the compact tier closes the project menu and hands its focus to More Actions", async ({ page }) => {
  await openBar(page, 1440);
  const bar = page.locator("header.session-bar");
  const button = bar.locator(".session-project-button");
  const moreActions = bar.getByRole("button", { name: "More Actions" });
  await button.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Project Actions" });
  await expect(menu.getByRole("menuitem", { name: "Open Project" })).toBeFocused();

  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(button).toBeHidden();
  await expect(menu).toHaveCount(0);
  await expect(moreActions).toBeFocused();

  // The button itself holding focus is handed over the same way.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(button).toBeVisible();
  await button.focus();
  await expect(button).toBeFocused();
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(button).toBeHidden();
  await expect(moreActions).toBeFocused();
});

test("folding while More Actions is disabled by a running export hands focus to the page title", async ({ page }) => {
  // Hold the export open: More Actions is disabled until it settles.
  await page.route("**/api/sessions/*/export*", () => undefined);
  await openBar(page, 1440);
  const bar = page.locator("header.session-bar");
  const moreActions = bar.getByRole("button", { name: "More Actions" });
  await bar.getByRole("button", { name: "Share" }).click();
  await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
  await expect(moreActions).toBeDisabled();

  const button = bar.locator(".session-project-button");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Open Project" })).toBeFocused();
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(button).toBeHidden();
  await expect(page.getByRole("menu", { name: "Project Actions" })).toHaveCount(0);
  await expect(bar.locator("h1#page-title")).toBeFocused();
});

// Delivered from #2146's follow-up in #2163: a dialog opened from the project button returns focus
// to a visible target when the window narrows while it is open and folds the button away.
test("cancelling Move to Project after the bar folds hands focus to More Actions, not the hidden button", async ({ page }) => {
  await openBar(page, 1440);
  const bar = page.locator("header.session-bar");
  const button = bar.locator(".session-project-button");
  await button.click();
  await page.getByRole("menuitem", { name: "Move to Another Project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to Project" });
  await expect(dialog).toBeVisible();

  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(button).toBeHidden();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "More Actions" })).toBeFocused();

  // Wide again, the button itself takes focus back.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(button).toBeVisible();
  await button.click();
  await page.getByRole("menuitem", { name: "Move to Another Project…" }).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(button).toBeFocused();
});

test("cancelling Move to Project after the bar folds while More Actions is disabled hands focus to the title", async ({ page }) => {
  await page.route("**/api/sessions/*/export*", () => undefined);
  await openBar(page, 1440);
  const bar = page.locator("header.session-bar");
  await bar.getByRole("button", { name: "Share" }).click();
  await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
  await expect(bar.getByRole("button", { name: "More Actions" })).toBeDisabled();
  const button = bar.locator(".session-project-button");
  await button.click();
  await page.getByRole("menuitem", { name: "Move to Another Project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to Project" });
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(button).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(bar.locator("h1#page-title")).toBeFocused();
});

test("on a control plane without projects the workspace menu files the session, and New Workspace… is a dialog", async ({ page }) => {
  await openBar(page, 1440, { legacyWorkspaces: true });
  const bar = page.locator("header.session-bar");
  const button = bar.locator(".session-project-button");
  await button.click();
  const menu = page.getByRole("menu", { name: "Move to Workspace" });
  await expect(menu.locator(".menu-label")).toHaveText("Move to Workspace");
  await expect(menu.getByRole("menuitemradio", { name: "Alpha", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "No Workspace" })).toHaveAccessibleDescription("Keep the session ungrouped.");
  await expect(menu.locator("input")).toHaveCount(0);

  await menu.getByRole("menuitem", { name: "New Workspace…" }).click();
  await expect(menu).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "New Workspace" });
  const name = dialog.getByRole("textbox", { name: "Name" });
  await expect(name).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Create and Move" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Browse…" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose Folder" });
  await expect(chooser).toBeVisible();
  // Stacked: the form stays visible under the picker.
  await expect(dialog).toBeVisible();
  await expect(chooser.locator(".modal-foot").getByRole("button")).toHaveText(["Cancel", "Use This Folder"]);
  await chooser.getByRole("button", { name: "billing-service" }).click();
  await expect(chooser.locator(".dir-path-input")).toHaveValue("/repos/billing-service");
  await chooser.getByRole("button", { name: "Use This Folder" }).click();
  await expect(chooser).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Browse…" })).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "Folder" })).toHaveValue("/repos/billing-service");

  await name.fill("Billing Service");
  await dialog.getByRole("button", { name: "Create and Move" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button).toHaveText("Billing Service");
  await expect(button).toBeFocused();

  // Choosing a workspace in the menu files the session there at once.
  await button.click();
  await page.getByRole("menu", { name: "Move to Workspace" }).getByRole("menuitemradio", { name: "Alpha", exact: true }).click();
  await expect(button).toHaveText("Alpha");
});

test("a menu result is a toast, and the bar never shows a transient note", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openBar(page, 940);
  const bar = page.locator("header.session-bar");
  await bar.getByRole("button", { name: "Share" }).click();
  await page.getByRole("menuitem", { name: "Copy Session Link" }).click();
  await expect(page.locator(".toast", { hasText: "Link copied." })).toBeVisible();
  await expect(bar.locator(".session-header-note, .detail-note, [role='status'][aria-live]")).toHaveCount(0);
  expect(await bar.evaluate((element) => element.getBoundingClientRect().height)).toBe(48);
});

test("a session with no project shows a faint No Project whose menu only moves it", async ({ page }) => {
  await openBar(page, 1440, { session: /No Project Session/ });
  const button = page.locator("header.session-bar .session-project-button");
  await expect(button).toHaveText("No Project");
  const colors = await button.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-faint)";
    element.append(probe);
    const faint = getComputedStyle(probe).color;
    probe.remove();
    return { button: getComputedStyle(element).color, faint };
  });
  expect(colors.button).toBe(colors.faint);
  const whole = await button.locator(".session-project-button-label").evaluate((label) => label.scrollWidth <= label.clientWidth);
  expect(whole).toBe(true);
  await button.click();
  const menu = page.getByRole("menu", { name: "Project Actions" });
  await expect(menu.locator(".menu-label")).toHaveText("No Project");
  await expect(menu.getByRole("menuitem")).toHaveText(["Move to a Project…"]);
});

for (const width of [761, 834, 940, 1099]) {
  test(`at ${width}px the bar holds one row with a readable title and the project in More Actions`, async ({ page }) => {
    await openBar(page, width);
    await setTitle(page, LONG_TITLE);
    await expectThreeStatuses(page);
    const bar = page.locator("header.session-bar");
    await expect(bar.locator(".session-project-button")).toBeHidden();
    await expect(bar.locator(".session-bar-sep")).toBeHidden();
    const geometry = await bar.evaluate((element) => {
      const rect = (node: Element) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
      };
      const box = rect(element);
      const children = [...element.children]
        .filter((child) => child.getClientRects().length > 0 && !child.classList.contains("sr-only"))
        .map((child) => ({ name: child.className, ...rect(child) }));
      return {
        bar: box,
        children,
        title: rect(element.querySelector("h1")!),
        statuses: rect(element.querySelector(".session-header-statuses")!),
        actions: rect(element.querySelector(".detail-actions")!),
        overflow: element.scrollWidth > element.clientWidth,
      };
    });
    expect(geometry.bar.bottom - geometry.bar.top).toBe(48);
    await expectStatusesOnOneLine(page);
    for (const child of geometry.children) {
      expect(child.top, child.name).toBeGreaterThanOrEqual(geometry.bar.top);
      expect(child.bottom, child.name).toBeLessThanOrEqual(geometry.bar.bottom);
    }
    expect(geometry.overflow).toBe(false);
    expect(geometry.title.width).toBeGreaterThanOrEqual(200);
    expect(geometry.title.right).toBeLessThanOrEqual(geometry.statuses.left + 0.5);
    expect(geometry.statuses.right).toBeLessThanOrEqual(geometry.actions.left + 0.5);
    expect(geometry.actions.right).toBeLessThanOrEqual(geometry.bar.right);

    await bar.getByRole("button", { name: "More Actions" }).click();
    const rows = page.getByRole("menu", { name: "More Actions" }).locator("[role='menuitem'], [role='separator']");
    await expect(rows.nth(0)).toHaveText("Open Alpha");
    await expect(rows.nth(1)).toHaveText("Move to Another Project…");
    await expect(rows.nth(2)).toHaveAttribute("role", "separator");
  });
}

test("in the compact tier a short title reserves no more than its own width, even after a long one", async ({ page }) => {
  await openBar(page, 940);
  const title = page.locator("header.session-bar h1");
  await setTitle(page, LONG_TITLE);
  await expect.poll(() => title.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(200);
  await setTitle(page, "Fix it");
  await expect(title).toHaveText("Fix it");
  const short = await title.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return { box: element.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
  });
  expect(short.box).toBeLessThan(100);
  expect(short.box - short.text).toBeLessThanOrEqual(1);
});

test("a generated title shows its first line in the bar and the window title", async ({ page }) => {
  await openBar(page, 1440);
  await setTitle(page, GENERATED_TITLE);
  const title = page.locator("header.session-bar h1");
  await expect(title).toHaveText("Add a dark mode toggle to the site header");
  await expect(title).toHaveAttribute("title", "Add a dark mode toggle to the site header");
  await expect(page).toHaveTitle("Add a dark mode toggle to the site header – Wollipog");
});

test.describe("phone", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("the top bar holds Back, the one-line title and the toggles, and every icon button has a 44px hit area", async ({ page }) => {
    await openBar(page, 390, { height: 844 });
    await setTitle(page, GENERATED_TITLE);
    const topbar = page.locator(".topbar");
    await expect(topbar.locator("h1")).toHaveText("Add a dark mode toggle to the site header");
    await expect(topbar.locator("h1")).toHaveCSS("font-size", "16px");
    await expect(topbar.locator("h1")).toHaveCSS("font-weight", "600");
    await expect(page).toHaveTitle("Add a dark mode toggle to the site header – Wollipog");
    await expect(page.locator(".session-project-button, .session-bar-project")).toHaveCount(0);
    await expect(topbar.getByRole("button")).toHaveText(["", "", "", ""]);
    await expect(topbar.getByRole("button").first()).toHaveAccessibleName("Back to Sessions");
    await expect(topbar.getByRole("button").first()).toHaveAttribute("title", "Back to Sessions");

    const targets = await page.evaluate(() => {
      const buttons = [
        ...document.querySelectorAll<HTMLElement>(".topbar button.icon-btn"),
        ...document.querySelectorAll<HTMLElement>(".session-bar .detail-actions button.icon-btn"),
      ];
      return buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const centerX = box.left + box.width / 2;
        const centerY = box.top + box.height / 2;
        // Each edge's midpoint of a 44×44 square on the button's centre (a rounded corner is not
        // part of any target, as in choice-rows.spec.ts). 1px inside rather than 0.5: neighbours'
        // targets abut exactly 8px apart, and Chromium hit-tests a half pixel on that seam as the
        // later neighbour's.
        const corners = [[0, -21], [21, 0], [0, 21], [-21, 0]].map(([dx, dy]) => {
          const hit = document.elementFromPoint(centerX + dx!, centerY + dy!);
          return hit === button || button.contains(hit);
        });
        return { name: button.getAttribute("aria-label"), width: box.width, height: box.height, corners };
      });
    });
    // How many statuses the disclosure holds depends on the UI font (one here, two in CI's DejaVu
    // Sans); this test is about the controls and their hit areas, so it reads the disclosure as +N.
    expect(targets.map((target) => target.name?.replace(/^\+\d+: Show \d+ Hidden Status(es)?$/, "+N"))).toEqual([
      "Back to Sessions",
      "Toggle Pinned Summary",
      "Show Terminal",
      "Show Side Panel",
      "+N",
      "Share",
      "More Actions",
    ]);
    for (const target of targets) {
      expect(target.width, target.name!).toBe(36);
      expect(target.height, target.name!).toBe(36);
      expect(target.corners, target.name!).toEqual([true, true, true, true]);
    }

    await page.locator(".session-bar").getByRole("button", { name: "More Actions" }).click();
    const sheet = page.getByRole("menu", { name: "More Actions" });
    await expect(sheet.locator(".menu-head")).toHaveText("Add a dark mode toggle to the site header");
    const rows = sheet.locator("[role='menuitem'], [role='separator']");
    await expect(rows.nth(0)).toHaveText("Open Alpha");
    await expect(rows.nth(1)).toHaveText("Move to Another Project…");
    await expect(rows.nth(2)).toHaveAttribute("role", "separator");
  });
});

// The issue estimated 260px; the shared §9.1 described row (52px) and the specified copy measure 287px
// here and 303px in CI's DejaVu Sans, against 410px for the old menu. The bound keeps that small margin.
test("at 1440px Share holds four described items and one note in at most 310px", async ({ page }) => {
  await openBar(page, 1440);
  await page.locator("header.session-bar").getByRole("button", { name: "Share" }).click();
  const menu = page.getByRole("menu", { name: "Share" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    /^Share Transcript…/, /^Copy Session Link/, /^Export as Markdown/, /^Export as JSON/,
  ]);
  await expect(menu.locator(".menu-note")).toHaveCount(1);
  await expect(menu.locator(".menu-label")).toHaveCount(0);
  const shape = await menu.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    secondLines: [...element.querySelectorAll('[role="menuitem"]')].map((item) => {
      const line = document.getElementById(item.getAttribute("aria-describedby") ?? "");
      return line && line.getBoundingClientRect().height > 0 ? line.textContent : null;
    }),
  }));
  expect(shape.height).toBeLessThanOrEqual(310);
  expect(shape.secondLines.every(Boolean), JSON.stringify(shape.secondLines)).toBe(true);
});

test("More Actions separates its groups once each and ends with the red Stop Session…", async ({ page }) => {
  await openBar(page, 1440);
  await page.locator("header.session-bar").getByRole("button", { name: "More Actions" }).click();
  const menu = page.getByRole("menu", { name: "More Actions" });
  await expect(menu.locator(".menu-label")).toHaveCount(0);
  const rows = await menu.evaluate((element) => [...element.querySelectorAll('[role="menuitem"], [role="separator"]')]
    .map((row) => row.getAttribute("role") === "separator" ? "—" : row.querySelector(".menu-text")?.textContent ?? ""));
  expect(rows[0]).not.toBe("—");
  expect(rows.at(-1)).toBe("Stop Session…");
  expect(rows.join("|")).not.toContain("—|—");
  const colors = await menu.evaluate((element) => {
    const color = (label: string) => {
      const item = [...element.querySelectorAll('[role="menuitem"]')]
        .find((row) => row.querySelector(".menu-text")?.textContent === label)!;
      return getComputedStyle(item).color;
    };
    const probe = document.createElement("span");
    probe.style.color = "var(--danger-text)";
    document.body.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    return { stop: color("Stop Session…"), rename: color("Rename…"), danger };
  });
  expect(colors.stop).toBe(colors.danger);
  expect(colors.rename).not.toBe(colors.danger);
});

test("Fork Conversation lives in More Actions: enabled after a finished turn, disabled with its reason during one, absent without a worktree", async ({ page }) => {
  // A worktree session whose turns have finished (the edit-in-fork fixture).
  for (const width of [1440, 1000]) {
    await openBar(page, width, { scenario: "edit-in-fork" });
    await expect(page.locator('header.session-bar [aria-label="Fork Conversation"]')).toHaveCount(0);
  }
  const bar = page.locator("header.session-bar");
  const moreActions = bar.getByRole("button", { name: "More Actions" });
  await moreActions.click();
  const fork = page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem", { name: "Fork Conversation…" });
  await expect(fork).toBeEnabled();
  await expect(fork.locator("kbd")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { status: "running" });
  });
  await moreActions.click();
  await expect(fork).toBeDisabled();
  await expect(fork).toHaveAccessibleDescription("Wait for the current turn or approval before creating a fork.");
  await expect(fork.locator(".menu-desc")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status: "idle", useWorktree: false, worktreePath: null,
    });
  });
  await moreActions.click();
  await expect(page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem", { name: "Rename…" })).toBeVisible();
  await expect(fork).toHaveCount(0);
});

test.describe("phone action line", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("has no Fork button; the sheet offers Fork Conversation…", async ({ page }) => {
    await openBar(page, 390, { height: 844, scenario: "edit-in-fork" });
    await expect(page.locator('.session-bar [aria-label="Fork Conversation"]')).toHaveCount(0);
    await page.locator(".session-bar").getByRole("button", { name: "More Actions" }).click();
    await expect(page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem", { name: "Fork Conversation…" }))
      .toBeVisible();
  });
});
