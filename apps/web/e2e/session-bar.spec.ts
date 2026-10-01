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
  options: { session?: RegExp; height?: number; scenario?: string; legacyWorkspaces?: boolean; theme?: "dark" | "light" } = {},
) {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  await page.goto(`/command-inbox-projects-e2e.html?scenario=${options.scenario ?? "git-visibility"}&reviewReady=1&fullShell=1${
    options.legacyWorkspaces ? "&legacyWorkspaces=1" : ""}`);
  await page.evaluate((theme) => {
    localStorage.clear();
    if (theme) localStorage.setItem("wollipog.theme", theme);
  }, options.theme);
  await page.reload();
  // A human campaign request needs the person, and an Orchestrator request is a passive row: the bar
  // shows the first as its one status (#2182), and the popover lists both.
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

const STATUS_NAME = "Session Status: Needs Your Input, 1 Request";

/** The bar shows one status (#2182): the campaign request that needs the person, as one badge. */
async function expectOneStatus(page: Page) {
  const bar = page.locator("header.session-bar");
  const control = bar.locator(".session-status-button");
  await expect(control).toHaveAccessibleName(STATUS_NAME);
  await expect(bar.locator(".status")).toHaveCount(1);
  await expect(control.locator(".status")).toContainText("Needs Your Input");
  // The facts the bar used to carry are in the Pinned Summary, and the rest is in the popover.
  await expect(bar.getByText(/Ready for Review|Uncommitted Changes|Changes Present|Orchestrator Action/)).toHaveCount(0);
}

test("at 1440px the bar is one 48px row and every control in it is 32px tall", async ({ page }) => {
  await openBar(page, 1440);
  // A title long enough to put the row under pressure, as in a real generated title.
  await setTitle(page, LONG_TITLE);
  await expectOneStatus(page);
  const bar = page.locator("header.session-bar");
  const geometry = await bar.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll<HTMLElement>("button, a.btn")]
      .filter((control) => control.getClientRects().length > 0)
      .map((control) => ({
        name: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "",
        height: control.getBoundingClientRect().height,
        top: control.getBoundingClientRect().top - box.top,
      }));
    return { height: box.height, controls };
  });
  expect(geometry.height).toBe(48);
  const names = geometry.controls.map((control) => control.name);
  for (const name of ["Back to Sessions", "Alpha", STATUS_NAME, "Share", "More Actions", "Pinned Summary", "Terminal", "Side Panel"]) {
    expect(names).toContain(name);
  }
  expect(geometry.controls.length).toBeGreaterThanOrEqual(9);
  for (const control of geometry.controls) {
    expect(control.height, control.name).toBe(32);
    // Centred in the row: the 47px above the bottom hairline leaves 7.5px of air either side.
    expect(control.top, control.name).toBe(7.5);
  }
  await expect(bar.locator("h1#page-title")).toHaveCSS("font-size", "16px");
  await expect(bar.locator("h1#page-title")).toHaveCSS("font-weight", "600");
  // One divider before the Open picker and one after it, ahead of the panel toggles.
  const order = await bar.locator(".detail-actions").evaluate((actions) =>
    [...actions.querySelectorAll(".editor-select, .detail-actions-divider, [aria-label='More Actions'], [aria-label='Panels']")]
      .map((node) => node.classList.contains("detail-actions-divider") ? "|" : node.classList.contains("editor-select") ? "Open" : node.getAttribute("aria-label")));
  expect(order).toEqual(["More Actions", "|", "Open", "|", "Panels"]);
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
  // The only live region the bar keeps announces background work (#784, #2182), never a result.
  await expect(bar.locator(".session-header-note, .detail-note, [role='status'][aria-live]:not([data-live='background-work'])")).toHaveCount(0);
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
    await expectOneStatus(page);
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
        statuses: rect(element.querySelector(".session-status-button")!),
        actions: rect(element.querySelector(".detail-actions")!),
        overflow: element.scrollWidth > element.clientWidth,
        dot: element.querySelector(".session-status-button")!.hasAttribute("data-dot"),
        tooltip: element.querySelector(".session-status-button")!.getAttribute("title"),
      };
    });
    expect(geometry.bar.bottom - geometry.bar.top).toBe(48);
    for (const child of geometry.children) {
      expect(child.top, child.name).toBeGreaterThanOrEqual(geometry.bar.top);
      expect(child.bottom, child.name).toBeLessThanOrEqual(geometry.bar.bottom);
    }
    expect(geometry.overflow).toBe(false);
    // The badge gives up its label before the title drops under its readable width (§15.2).
    expect(geometry.title.width).toBeGreaterThanOrEqual(200);
    if (geometry.dot) expect(geometry.tooltip).toBe("Needs Your Input");
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

/** An authentication request: the longest attention label, so it is the first to need the room. */
async function signInRequired(page: Page) {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status: "input_required",
      orchestratorCampaign: undefined,
      pendingApproval: { kind: "authentication", requestId: "sign-in", title: "Sign in", options: [] },
    } as never);
  });
}

/** The bar's title width, the status badge's width, and the control's box. */
function statusGeometry(page: Page) {
  return page.locator("header.session-bar").evaluate((element) => ({
    title: element.querySelector("h1")!.getBoundingClientRect().width,
    badge: element.querySelector(".session-status-button .status")!.getBoundingClientRect().width,
    control: element.querySelector(".session-status-button")!.getBoundingClientRect(),
  }));
}

test("at 940px a long title keeps 200px: the badge keeps its label only while it leaves that much", async ({ page }) => {
  await openBar(page, 940);
  // The labelled rail is the narrowest a 940px window gets.
  await page.getByRole("button", { name: "Expand Navigation" }).click();
  await signInRequired(page);
  await setTitle(page, LONG_TITLE);
  const control = page.locator("header.session-bar .session-status-button");
  await expect(control).toHaveAccessibleName("Session Status: Authentication Required");
  await expect(control).toHaveAttribute("data-compact", "");
  const geometry = await statusGeometry(page);
  expect(geometry.title).toBeGreaterThanOrEqual(200);
  // Whichever form the font leaves room for, a dot always carries its label as the tooltip.
  if (await control.getAttribute("data-dot") !== null) {
    await expect(control).toHaveAttribute("title", "Authentication Required");
  } else {
    await expect(control.locator(".status")).toHaveText("Authentication Required");
  }
});

test("in the compact tier a long title collapses the status badge to its dot before the title drops under 200px", async ({ page }) => {
  // 800px is inside the compact tier (761–1099px) with room enough to measure both forms.
  await openBar(page, 800);
  await page.getByRole("button", { name: "Expand Navigation" }).click();
  await signInRequired(page);
  const control = page.locator("header.session-bar .session-status-button");
  await setTitle(page, "Fix it");
  await expect(control).toHaveAccessibleName("Session Status: Authentication Required");
  await expect(control).not.toHaveAttribute("data-dot");
  // Dot and label, without the pill, where the label fits.
  await expect(control).toHaveAttribute("data-compact", "");
  await expect(control.locator(".status")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(control.locator(".status")).toHaveText("Authentication Required");

  await setTitle(page, LONG_TITLE);
  await expect(control).toHaveAttribute("data-dot", "");
  await expect(control).toHaveAttribute("title", "Authentication Required");
  await expect(control).toHaveAccessibleName("Session Status: Authentication Required");
  const geometry = await statusGeometry(page);
  expect(geometry.title).toBeGreaterThanOrEqual(200);
  expect(geometry.badge).toBe(6);
  // Still a 32px target, and the popover is its visible label.
  expect(geometry.control.width).toBeGreaterThanOrEqual(32);
  expect(geometry.control.height).toBe(32);
  await control.click();
  await expect(page.getByRole("dialog", { name: "Session Status" }).locator(".session-status-row .status").first())
    .toHaveText("Authentication Required");
});

for (const width of [1100, 1440]) {
  test(`at ${width}px the status is the full badge, never a dot, whatever the title's length`, async ({ page }) => {
    await openBar(page, width);
    await page.getByRole("button", { name: "Expand Navigation" }).click();
    await setTitle(page, `${LONG_TITLE} ${LONG_TITLE}`);
    const control = page.locator("header.session-bar .session-status-button");
    await expect(control).toHaveAccessibleName(STATUS_NAME);
    await expect(control).not.toHaveAttribute("data-dot");
    await expect(control).not.toHaveAttribute("data-compact");
    await expect(control).not.toHaveAttribute("title");
    await expect(control.locator(".status")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const badge = await control.locator(".status").evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      clipped: element.scrollWidth > element.clientWidth + 0.5,
    }));
    expect(badge.width).toBeGreaterThan(80);
    expect(badge.clipped).toBe(false);
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

/** The resolved value of a custom property on the root, as the browser serializes colours. */
async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

/** A control's fill and edge once the pointer rests on it and its transitions have finished. */
async function hoveredLook(page: Page, name: string) {
  const button = page.locator("header.session-bar .panel-toggles").getByRole("button", { name, exact: true });
  await button.hover();
  await page.waitForFunction(() => !document.getAnimations().some((animation) => animation instanceof CSSTransition));
  return button.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    boxShadow: getComputedStyle(element).boxShadow,
  }));
}

for (const theme of ["dark", "light"] as const) {
  test(`at 1440px the Panels toggles keep their names, and a hovered on toggle keeps its edge (${theme}, #2164)`, async ({ page }) => {
    await openBar(page, 1440, { theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const group = page.locator("header.session-bar").getByRole("group", { name: "Panels" });
    await expect(group.getByRole("button")).toHaveText(["", "", ""]);
    const names = await group.getByRole("button").evaluateAll((buttons) => buttons.map((button) => ({
      name: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      glyph: ["lucide-info", "lucide-square-terminal", "lucide-panel-right"]
        .find((glyph) => button.querySelector("svg")?.classList.contains(glyph)),
    })));
    expect(names.map(({ name }) => name)).toEqual(["Pinned Summary", "Terminal", "Side Panel"]);
    expect(names.map(({ title }) => title)).toEqual(["Pinned Summary", "Terminal (Ctrl+`)", "Side Panel"]);
    expect(names.map(({ glyph }) => glyph)).toEqual([
      "lucide-info", "lucide-square-terminal", "lucide-panel-right",
    ]);

    const sidePanel = group.getByRole("button", { name: "Side Panel", exact: true });
    await sidePanel.click();
    await expect(sidePanel).toHaveAttribute("aria-pressed", "true");
    await expect(sidePanel).toHaveAccessibleName("Side Panel");
    await expect(group.getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-pressed", "false");
    await sidePanel.evaluate((element) => (element as HTMLElement).blur());

    const outline = await tokenColour(page, "--control-outline");
    const hoveredOff = await hoveredLook(page, "Terminal");
    const hoveredOn = await hoveredLook(page, "Side Panel");
    expect(hoveredOff.boxShadow).toBe("none");
    expect(hoveredOn.boxShadow).toBe(`${outline} 0px 0px 0px 1px inset`);
    expect(hoveredOn).not.toEqual(hoveredOff);
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => !document.getAnimations().some((animation) => animation instanceof CSSTransition));
    await expect(sidePanel).toHaveCSS("background-color", await tokenColour(page, "--bg-elev-3"));
    await expect(sidePanel).toHaveCSS("box-shadow", `${outline} 0px 0px 0px 1px inset`);
  });
}

test("at 940px the Open control is icon-only with its name as the tooltip (#2164)", async ({ page }) => {
  await openBar(page, 940);
  // The fixture's machine has no editors, so its folder has one destination: Open Folder.
  const open = page.locator("header.session-bar .editor-select").getByRole("button", { name: "Open Folder", exact: true });
  await expect(open).toHaveAttribute("title", "Open Folder");
  await expect(open.locator(".editor-main-label")).toBeHidden();
  expect(await open.boundingBox()).toMatchObject({ width: 32, height: 32 });
  await expect(page.locator("header.session-bar .editor-select button")).toHaveCount(1);
});

test("in the shell, Open becomes a split once the machine has editors, and offline it names the machine (#2164)", async ({ page }) => {
  await openBar(page, 1440);
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerEditors([{ id: "code", name: "VS Code" }, { id: "cursor", name: "Cursor" }]);
  });
  const select = page.locator("header.session-bar .editor-select");
  const main = select.getByRole("button", { name: "Open in VS Code" });
  const choose = select.getByRole("button", { name: "Choose Where to Open" });
  await expect(main).toHaveText("Open");
  await choose.click();
  const menu = page.getByRole("menu", { name: "Open In" });
  await expect(menu.getByRole("menuitemradio")).toHaveText(["VS Code", "Cursor", "File Manager"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  const note = "runner-1 is offline. You can open the folder again when it reconnects.";
  await expect(main).toBeDisabled();
  await expect(main).toHaveAccessibleDescription(note);
  await choose.click();
  await expect(menu.locator(".menu-note")).toHaveText(note);
  await expect(menu.getByRole("menuitemradio", { disabled: false })).toHaveCount(0);
  await expect(page.locator('[title="Runner is offline."]')).toHaveCount(0);
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
    // Opening the folder on the machine is not a phone action (#2164), and a coarse pointer's
    // Terminal tooltip carries no keycap.
    await expect(page.locator(".editor-select")).toHaveCount(0);
    await expect(topbar.getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("title", "Terminal");
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
    expect(targets.map((target) => target.name)).toEqual([
      "Back to Sessions",
      "Pinned Summary",
      "Terminal",
      "Side Panel",
      "Share",
      "More Actions",
    ]);
    for (const target of targets) {
      expect(target.width, target.name!).toBe(36);
      expect(target.height, target.name!).toBe(36);
      expect(target.corners, target.name!).toEqual([true, true, true, true]);
    }

    // The status control leads the second line with the full badge (§15.1): 36px like Share, with
    // the same borrowed 44px touch target.
    const control = page.locator(".session-bar .session-status-button");
    await expect(control).toHaveAccessibleName(STATUS_NAME);
    const status = await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const share = document.querySelector(".session-bar [aria-label='Share']")!.getBoundingClientRect();
      const line = element.closest(".session-bar")!.getBoundingClientRect();
      const centerY = box.top + box.height / 2;
      const hit = (x: number, y: number) => {
        const target = document.elementFromPoint(x, y);
        return target === element || element.contains(target);
      };
      return {
        height: box.height, left: box.left - line.left, right: box.right, shareLeft: share.left,
        target: [hit(box.left + 8, centerY - 21), hit(box.left + 8, centerY + 21)],
      };
    });
    expect(status.height).toBe(36);
    expect(status.target).toEqual([true, true]);
    expect(status.right).toBeLessThan(status.shareLeft);
    expect(status.left).toBeLessThanOrEqual(16);

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
  // The item teaches its key, which forks from the reader the same way (#2272).
  await expect(fork.locator(".menu-trail kbd")).toHaveText("F");
  await expect(fork).toHaveAccessibleName("Fork Conversation…");
  await page.keyboard.press("Escape");
  const transcript = page.locator(".detail-scroll");
  const createFork = page.getByRole("dialog", { name: "Create Fork" });
  await transcript.focus();
  await page.keyboard.press("f");
  await expect(createFork).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(createFork).toBeHidden();

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { status: "running" });
  });
  await moreActions.click();
  await expect(fork).toBeDisabled();
  await expect(fork).toHaveAccessibleDescription("Wait for the current turn or approval before creating a fork.");
  await expect(fork.locator(".menu-desc")).toBeVisible();
  await page.keyboard.press("Escape");
  await transcript.focus();
  await page.keyboard.press("f");
  await expect(page.getByRole("dialog")).toHaveCount(0);

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
    const fork = page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem", { name: "Fork Conversation…" });
    await expect(fork).toBeVisible();
    await expect(fork.locator("kbd"), "a touch pointer shows no keycap (#2272)").toHaveCount(0);
  });
});
