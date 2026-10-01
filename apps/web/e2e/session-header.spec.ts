import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { join } from "node:path";

async function openSession(page: Page, scenario = "preview-follow", params: Record<string, string> = {}) {
  const query = new URLSearchParams({ scenario, ...params });
  const evidenceTheme = process.env.SESSION_HEADER_SCREENSHOT_THEME;
  if (evidenceTheme === "dark" || evidenceTheme === "light") {
    // The fixture does not load index.html's pre-paint appearance bootstrap. Apply evidence themes
    // before its CSS can paint so button colour transitions cannot produce a false mixed-theme
    // screenshot while the rest of the document has already switched palettes.
    await page.addInitScript((theme) => {
      localStorage.clear();
      localStorage.setItem("wollipog.theme", theme);
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }, evidenceTheme);
  }
  await page.goto(`/command-inbox-projects-e2e.html?${query.toString()}`);
  await page.evaluate((theme) => {
    localStorage.clear();
    if (theme === "dark" || theme === "light") localStorage.setItem("wollipog.theme", theme);
  }, evidenceTheme);
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-bar")).toBeVisible();
  if (evidenceTheme === "dark" || evidenceTheme === "light") {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }, evidenceTheme);
  }
  if (scenario === "preview-follow") {
    await expect(page.locator(".inbox-preview-pane")).toHaveCount(1);
  }
}

async function capture(page: Page, viewport: string) {
  const directory = process.env.SESSION_HEADER_SCREENSHOT_DIR;
  const phase = process.env.SESSION_HEADER_SCREENSHOT_PHASE;
  if (!directory || !phase) return;
  // Evidence represents the settled UI, not the 130ms global control transition after mounting.
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(directory, `${phase}-${viewport}.png`), fullPage: true });
}

async function mobileSessionHeaderGeometry(page: Page) {
  return page.evaluate(() => {
    const topbar = document.querySelector(".topbar") as HTMLElement;
    const header = document.querySelector(".session-bar") as HTMLElement;
    const paneActions = topbar.querySelector(".topbar-mobile-controls") as HTMLElement;
    const sessionActions = header.querySelector(".detail-actions") as HTMLElement;
    const rect = (selector: string, root: ParentNode) => {
      const box = root.querySelector(selector)?.getBoundingClientRect();
      if (!box) throw new Error(`Missing mobile Session control: ${selector}`);
      return { left: box.left, right: box.right, center: box.left + box.width / 2 };
    };
    const optionalRect = (selector: string, root: ParentNode) => {
      const box = root.querySelector(selector)?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, center: box.left + box.width / 2 } : null;
    };
    return {
      pinned: rect('button[aria-label="Pinned Summary"]', topbar),
      terminal: rect('button[aria-label="Terminal"]', topbar),
      sidePanel: rect('button[aria-label="Side Panel"]', topbar),
      fork: optionalRect('[aria-label="Fork Conversation"]', header),
      share: rect('[aria-label="Share"]', header),
      moreActions: rect('[aria-label="More Actions"]', header),
      paneGap: Number.parseFloat(getComputedStyle(paneActions).gap),
      sessionGap: Number.parseFloat(getComputedStyle(sessionActions).gap),
      topbarPaddingRight: Number.parseFloat(getComputedStyle(topbar).paddingRight),
      headerPaddingRight: Number.parseFloat(getComputedStyle(header).paddingRight),
      viewportRight: window.innerWidth,
      titleRight: topbar.querySelector("h1")!.getBoundingClientRect().right,
      paneActionsLeft: paneActions.getBoundingClientRect().left,
      statusesRight: header.querySelector(".session-status-button")!.getBoundingClientRect().right,
      sessionActionsLeft: sessionActions.getBoundingClientRect().left,
      hasPageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

function expectMobileSessionColumnsAligned(geometry: Awaited<ReturnType<typeof mobileSessionHeaderGeometry>>) {
  // Fork Conversation lives in More Actions, not the action line, at every width (#2161).
  expect(geometry.fork).toBeNull();
  expect(Math.abs(geometry.sidePanel.center - geometry.moreActions.center)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.terminal.center - geometry.share.center)).toBeLessThanOrEqual(0.5);
  expect(geometry.paneGap).toBe(geometry.sessionGap);
  expect(geometry.terminal.left - geometry.pinned.right).toBeCloseTo(geometry.paneGap, 1);
  expect(geometry.sidePanel.left - geometry.terminal.right).toBeCloseTo(geometry.paneGap, 1);
  expect(geometry.moreActions.left - geometry.share.right).toBeCloseTo(geometry.sessionGap, 1);
  expect(geometry.viewportRight - geometry.sidePanel.right).toBeCloseTo(geometry.topbarPaddingRight, 1);
  expect(geometry.viewportRight - geometry.moreActions.right).toBeCloseTo(geometry.headerPaddingRight, 1);
  expect(geometry.topbarPaddingRight).toBe(geometry.headerPaddingRight);
  expect(geometry.titleRight).toBeLessThanOrEqual(geometry.paneActionsLeft);
  expect(geometry.statusesRight).toBeLessThanOrEqual(geometry.sessionActionsLeft - 6);
  expect(geometry.hasPageOverflow).toBe(false);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "split pane", width: 900, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`the generic side-panel toggle recovers from empty persisted Requests mode on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow&fullShell=1");
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("wollipog.rightpanel.open", "0");
      localStorage.setItem("wollipog.rightpanel.mode", "requests");
    });
    await page.reload();
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();
    const toggle = page.getByRole("button", { name: "Side Panel", exact: true, pressed: false });
    await expect(toggle).toBeVisible();

    expect(await page.evaluate(() => {
      const observed: string[] = [];
      const panelOwner = document.querySelector(".session-detail.expanded .detail-columns");
      if (!panelOwner) throw new Error("missing panel owner");
      const observer = new MutationObserver((records) => {
        for (const _record of records) {
          observed.push(document.querySelector("#right-panel") ? "added" : "removed");
        }
      });
      observer.observe(panelOwner, { childList: true });
      (window as typeof window & { __rightPanelMutations?: string[] }).__rightPanelMutations = observed;
      return observed;
    })).toEqual([]);

    await toggle.click();
    await page.waitForTimeout(200);

    await expect(page.locator("#right-panel")).toBeVisible();
    await expect(page.locator("#right-panel")).toHaveAccessibleName("Panel");
    await expect(page.getByRole("button", { name: "Side Panel", exact: true, pressed: true })).toBeFocused();
    const persisted = await page.evaluate(() => ({
      open: localStorage.getItem("wollipog.rightpanel.open"),
      mode: localStorage.getItem("wollipog.rightpanel.mode"),
      mutations: (window as typeof window & { __rightPanelMutations?: string[] }).__rightPanelMutations,
    }));
    expect(persisted.open).toBe("1");
    expect(persisted.mode).toBe("launcher");
    expect(persisted.mutations?.length).toBeGreaterThan(0);
    expect(persisted.mutations).not.toContain("removed");
  });
}

test("the Requests panel stays open until descendant polling authoritatively settles", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow&fullShell=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      orchestratorCampaign: { pendingRequests: { human: 1, orchestrator: 0 } } as never,
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setDescendantRequests("one");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextDescendantRequests();
  });
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.descendantRequestCallCount())).toBe(1);

  // The campaign request is the bar's one status (#2182); its popover row opens the Requests panel.
  const trigger = page.locator(".session-bar .session-status-button");
  await expect(trigger).toHaveAccessibleName("Session Status: Needs Your Input, 1 Request");
  await trigger.click();
  await page.getByRole("dialog", { name: "Session Status" }).getByRole("button", { name: "Open Requests" }).click();
  const panel = page.getByRole("complementary", { name: "Requests" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Loading Requests" })).toBeVisible();

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredDescendantRequests();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextDescendantRequests();
  });
  await expect(panel.getByRole("heading", { name: "Descendant Request Fixture" })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.descendantRequestCallCount())).toBeGreaterThanOrEqual(2);
  await expect(panel.getByRole("heading", { name: "Requests Unavailable" })).toBeVisible();
  await expect(panel.locator(".request-panel-row")).toHaveCount(0);

  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.descendantRequestCallCount())).toBeGreaterThanOrEqual(3);
  await expect(panel.getByRole("heading", { name: "Descendant Request Fixture" })).toBeVisible();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setDescendantRequests("empty"));
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.descendantRequestCallCount())).toBeGreaterThanOrEqual(4);
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("resolving a closed Requests surface leaves the cross-session generic toggle on the launcher", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow&fullShell=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "input_required",
      pendingApproval: {
        requestId: "right-panel-recovery",
        occurrenceId: "right-panel-recovery-1",
        kind: "permission",
        title: "Approve Right Panel Recovery?",
        context: { toolName: "fixture.recovery", input: "Verify request panel recovery." },
        options: [
          { optionId: "approve", name: "Approve", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
  });

  const review = page.getByRole("button", { name: "Review Request" });
  await review.scrollIntoViewIfNeeded();
  await review.click();
  await expect(page.locator("#right-panel")).toHaveAccessibleName("Requests");
  await page.getByRole("button", { name: "Close Panel" }).click();
  await expect(page.locator("#right-panel")).toHaveCount(0);
  await expect(review).toBeFocused();

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "running",
      pendingApproval: null,
    });
  });

  await expect(page.locator("#right-panel")).toHaveCount(0);
  await expect(page.locator(".composer-input")).toBeFocused();
  await expect.poll(() => page.evaluate(() => ({
    open: localStorage.getItem("wollipog.rightpanel.open"),
    mode: localStorage.getItem("wollipog.rightpanel.mode"),
  }))).toEqual({ open: "0", mode: "launcher" });

  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await page.getByRole("button", { name: /No Project Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();
  const toggle = page.getByRole("button", { name: "Side Panel", exact: true, pressed: false });
  await toggle.click();
  await expect(page.locator("#right-panel")).toHaveAccessibleName("Panel");
  await expect(page.getByRole("button", { name: "Side Panel", exact: true, pressed: true })).toBeFocused();
});

test("the session bar balances navigation, the project button, status, and actions on one row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSession(page);
  await capture(page, "desktop");

  const header = page.locator(".session-bar");
  const back = header.locator(".detail-bar-back");
  await expect(back).toHaveAccessibleName("Back to Sessions");
  await expect(back).toHaveAttribute("title", "Back to Sessions");
  await expect(header.locator(".status").first()).toBeVisible();

  const geometry = await header.evaluate((element) => {
    const rect = (node: Element) => {
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const backControl = element.querySelector(".detail-bar-back")!;
    const title = element.querySelector("h1")!;
    const actions = element.querySelector(".detail-actions")!;
    const projectButton = element.querySelector(".session-project-button")!;
    const projectLabel = projectButton.querySelector(".session-project-button-label")!;
    const projectSeparator = element.querySelector(".session-bar-sep")!;
    const moreActions = element.querySelector('[aria-label="More Actions"]')!;
    const headerBox = element.getBoundingClientRect();
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("expanded Session bar is not mounted in the clipping pane");
    const clippingBox = clippingPane.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      back: rect(backControl),
      title: rect(title),
      actions: rect(actions),
      projectButton: rect(projectButton),
      projectSeparator: rect(projectSeparator),
      projectLabelWhole: projectLabel.scrollWidth <= projectLabel.clientWidth,
      projectTextOverflow: getComputedStyle(projectLabel).textOverflow,
      headerHeight: headerBox.height,
      headerRight: headerBox.right,
      clippingRight: Math.min(window.innerWidth, clippingBox.right),
      moreActionsRight: moreActions.getBoundingClientRect().right,
      paddingRight: Number.parseFloat(style.paddingRight),
      hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
    };
  });

  expect(geometry.back.width).toBe(32);
  expect(geometry.back.height).toBe(32);
  // The shared 48px bar (§4.4), not the old 52px row.
  expect(geometry.headerHeight).toBe(48);
  expect(geometry.paddingRight).toBeGreaterThanOrEqual(12);
  expect(geometry.hasHorizontalOverflow).toBe(false);
  expect(geometry.projectButton.height).toBe(32);
  expect(geometry.projectLabelWhole).toBe(true);
  expect(geometry.projectTextOverflow).toBe("ellipsis");
  // The separator sits between the project button and the title, with no negative margin.
  expect(geometry.projectSeparator.x).toBeGreaterThanOrEqual(geometry.projectButton.x + geometry.projectButton.width + 7.5);
  expect(geometry.title.x).toBeGreaterThanOrEqual(geometry.projectSeparator.x + geometry.projectSeparator.width + 7.5);
  expect(geometry.headerRight - (geometry.actions.x + geometry.actions.width)).toBeGreaterThanOrEqual(geometry.paddingRight - 1);
  expect(geometry.clippingRight - geometry.moreActionsRight).toBeGreaterThanOrEqual(11.5);
  const center = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(Math.abs(center(geometry.back) - center(geometry.title))).toBeLessThanOrEqual(1);
  expect(Math.abs(center(geometry.actions) - center(geometry.title))).toBeLessThanOrEqual(1);
  expect(Math.abs(center(geometry.projectButton) - center(geometry.title))).toBeLessThanOrEqual(1);

  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  await page.keyboard.press("Tab");
  await expect(back).toBeFocused();
  const focus = await back.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const headerBox = element.parentElement!.getBoundingClientRect();
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      clearanceAbove: box.top - headerBox.top,
    };
  });
  expect(focus.outlineStyle).not.toBe("none");
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(focus.clearanceAbove).toBeGreaterThan(focus.outlineWidth);

  // One control for the project: Back, then the project button, then the actions.
  const projectButton = header.locator(".session-project-button");
  await page.keyboard.press("Tab");
  await expect(projectButton).toBeFocused();
  const moreActions = header.getByRole("button", { name: "More Actions" });
  await moreActions.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(header.getByRole("button", { name: "Share" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(moreActions).toBeFocused();
  const trailingFocus = await moreActions.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("focused action is not mounted in the clipping pane");
    const clippingBox = clippingPane.getBoundingClientRect();
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineOffset: Number.parseFloat(style.outlineOffset),
      clearance: Math.min(window.innerWidth, clippingBox.right) - box.right,
    };
  });
  expect(trailingFocus.outlineStyle).not.toBe("none");
  expect(trailingFocus.clearance).toBeGreaterThan(trailingFocus.outlineWidth + trailingFocus.outlineOffset);

  await moreActions.click();
  const menu = page.getByRole("menu", { name: "More Actions" });
  await expect(menu).toBeVisible();
  // The project button is visible at this width, so More Actions does not repeat its actions.
  await expect(menu.getByRole("menuitem", { name: "Move to Another Project…" })).toHaveCount(0);
  // The former standalone header actions live here now; the process-destructive item stays last
  // and visually distinct.
  await expect(menu.getByRole("menuitem", { name: "Rename…" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Archive and Stop…" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Share Transcript…" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Export as Markdown" })).toHaveCount(0);
  const stopSession = menu.getByRole("menuitem", { name: "Stop Session…" });
  await expect(stopSession).toBeVisible();
  await expect(stopSession).toHaveClass(/\bdanger\b/);
  const menuItems = menu.getByRole("menuitem");
  await expect(menuItems.last()).toHaveText("Stop Session…");
  const menuClearance = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    // The menu is the shared surface, portalled to <body> (#1803); it still has to sit inside the
    // preview pane its trigger lives in.
    const clippingPane = document.querySelector(".inbox-preview-pane");
    if (!clippingPane) throw new Error("the preview pane is not mounted");
    const clippingBox = clippingPane.getBoundingClientRect();
    return Math.min(window.innerWidth, clippingBox.right) - box.right;
  });
  expect(menuClearance).toBeGreaterThanOrEqual(11.5);

  await header.getByRole("button", { name: "Share" }).click();
  await expect(menu).toHaveCount(0);
  const shareMenu = page.getByRole("menu", { name: "Share" });
  await expect(shareMenu.getByRole("menuitem", { name: "Share Transcript…" })).toBeVisible();
  await expect(shareMenu.getByRole("menuitem", { name: "Copy Session Link" })).toBeVisible();
  await expect(shareMenu.getByRole("menuitem", { name: "Export as Markdown" })).toBeVisible();
  await expect(shareMenu.getByRole("menuitem", { name: "Export as JSON" })).toBeVisible();
  await expect(shareMenu.getByRole("menuitem", { name: "Rename…" })).toHaveCount(0);
});

test("desktop Session actions stay contained with concurrent status indicators", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await openSession(page, "git-visibility", { reviewReady: "1", fullShell: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status: "idle",
      backgroundWorkState: "running",
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitActiveSubagent("session-alpha", "active-desktop-subagent");
  });

  const header = page.locator(".session-bar");
  // One status (#2182): with nothing needing the person, running background work leads while the
  // session awaits its next prompt, and the rest are rows of the Session Status popover.
  const status = header.locator(".session-status-button");
  await expect(status).toHaveAccessibleName("Session Status: Waiting on External Job");
  await expect(header.locator(".status")).toHaveCount(1);
  // Changes are a Git fact in the Pinned Summary (#2160), never a status in the bar.
  await expect(header.getByText(/Ready for Review|Uncommitted Changes|Changes Present/)).toHaveCount(0);
  await expect(header.locator('[data-live="background-work"]')).toHaveText("Background Work: Waiting on External Job");
  await status.click();
  const statusPopover = page.getByRole("dialog", { name: "Session Status" });
  await expect(statusPopover.locator(".session-status-row .status"))
    .toHaveText(["Waiting on External Job", "Awaiting Prompt", "1 Worker"]);
  await page.keyboard.press("Escape");
  await expect(statusPopover).toHaveCount(0);
  await capture(page, "desktop-concurrent");
  const longProjectName = "Alpha Project with a deliberately long name for project button truncation";
  await page.evaluate((name) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name });
  }, longProjectName);
  const projectButton = header.locator(".session-project-button");
  await expect(projectButton).toHaveText(longProjectName);
  await page.setViewportSize({ width: 1440, height: 800 });
  const wide = await projectButton.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".session-project-button-label")!;
    return { width: element.getBoundingClientRect().width, clipped: label.scrollWidth > label.clientWidth };
  });
  expect(wide.width).toBe(220);
  expect(wide.clipped).toBe(true);
  await capture(page, "desktop-long-project");

  for (const width of [900, 761]) {
    await page.setViewportSize({ width, height: 800 });
    // The compact tier (§15.2) folds the project button into More Actions.
    await expect(projectButton).toBeHidden();
    const geometry = await header.evaluate((element) => {
      const headerBox = element.getBoundingClientRect();
      const actions = element.querySelector(".detail-actions")!.getBoundingClientRect();
      const moreActions = element.querySelector('[aria-label="More Actions"]')!.getBoundingClientRect();
      const title = element.querySelector("h1")!.getBoundingClientRect();
      const statuses = element.querySelector(".session-status-button")!.getBoundingClientRect();
      const clippingPane = element.closest(".inbox-preview-pane");
      return {
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        headerHeight: headerBox.height,
        headerRight: headerBox.right,
        actionsLeft: actions.left,
        actionsRight: actions.right,
        clippingRight: Math.min(
          window.innerWidth,
          clippingPane?.getBoundingClientRect().right ?? window.innerWidth,
        ),
        moreActionsRight: moreActions.right,
        paddingRight: Number.parseFloat(getComputedStyle(element).paddingRight),
        titleWidth: title.width,
        titleNatural: element.querySelector("h1")!.scrollWidth,
        titleRight: title.right,
        statusesLeft: statuses.left,
        statusesRight: statuses.right,
      };
    });
    expect(geometry.hasHorizontalOverflow, `${width}px header overflow`).toBe(false);
    expect(geometry.headerHeight, `${width}px stays one row`).toBe(48);
    expect(geometry.headerRight - geometry.actionsRight).toBeGreaterThanOrEqual(geometry.paddingRight - 1);
    expect(geometry.clippingRight - geometry.moreActionsRight).toBeGreaterThanOrEqual(11.5);
    // The title keeps 200px, or all of itself when shorter: the badge gives up its label first (§15.2).
    expect(geometry.titleWidth, `${width}px title stays readable`)
      .toBeGreaterThanOrEqual(Math.min(200, geometry.titleNatural) - 0.5);
    expect(geometry.titleRight).toBeLessThanOrEqual(geometry.statusesLeft + 0.5);
    expect(geometry.statusesRight).toBeLessThanOrEqual(geometry.actionsLeft + 0.5);
  }
});

test("managed background indicators open a responsive inspectable inventory and settled work leaves history only", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage(
      "session-alpha",
      "Start the managed background task.",
      "turn-loaded",
    );
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: "resumed",
      backgroundWorkTracking: "untracked",
    });
  });
  const header = page.locator(".session-bar");
  // Untracked detached work is a fact about the provider, stated in the Pinned Summary (#2160).
  await expect(header.getByText("Detached Work")).toHaveCount(0);
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: "running",
      backgroundWorkTracking: "managed",
      backgroundJobs: [{
        id: "private-task-id",
        parentTurnId: "turn-loaded",
        launchType: "shell",
        registeredAt: Date.now() - 65_000,
        lastObservedAt: Date.now() - 1_000,
        sourcePresent: true,
      }],
    });
  });

  await header.locator(".session-status-button").click();
  await page.getByRole("dialog", { name: "Session Status" }).getByRole("button", { name: "Open Background Work" }).click();
  const panel = page.locator("#right-panel");
  await expect(panel).toHaveAccessibleName("Background Work");
  await expect(panel.getByText("Shell Job 1", { exact: true })).toBeVisible();
  await expect(panel.getByText("Running", { exact: true })).toBeVisible();
  await expect(panel.getByText("Not Started", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "View Parent Turn" })).toBeVisible();
  await expect(panel).not.toContainText("private-task-id");
  await panel.getByRole("button", { name: "View Parent Turn" }).click();
  await expect(panel).toBeVisible();
  await capture(page, "background-desktop-running");

  await page.setViewportSize({ width: 390, height: 800 });
  const mobileBox = await panel.boundingBox();
  expect(mobileBox?.x).toBe(0);
  expect(mobileBox?.width).toBe(390);
  await capture(page, "background-mobile-running");

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: undefined,
      backgroundWorkTracking: "managed",
      backgroundJobs: [{
        id: "private-task-id",
        parentTurnId: "turn-loaded",
        launchType: "shell",
        registeredAt: Date.now() - 65_000,
        lastObservedAt: Date.now(),
        sourcePresent: true,
        terminalStatus: "completed",
        terminalObservedAt: Date.now() - 3_000,
        continuationRequired: true,
        continuationId: "private-continuation-id",
        continuationQueuedAt: Date.now() - 2_500,
        assistantResultPersistedAt: Date.now() - 2_000,
      }],
    });
  });
  await expect(header.locator(".session-status-button")).not.toHaveAccessibleName(/Waiting on External Job/);
  await expect(header.locator('[data-live="background-work"]')).toHaveText("");
  await expect(panel.getByText("Completed", { exact: true })).toBeVisible();
  await expect(panel.getByText("Result Delivered", { exact: true })).toBeVisible();
  await expect(panel).not.toContainText("private-continuation-id");
  await capture(page, "background-mobile-settled");

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundJobs: [],
      backgroundJobsTruncated: true,
      backgroundDeliveries: [{
        continuationId: "private-retained-continuation",
        parentTurnId: "turn-loaded",
        jobCount: 2,
        terminalCount: 2,
        runnerResultPersistedAt: Date.now() - 1_000,
        notificationQueuedAt: Date.now() - 900,
        notifications: [{
          deliveryId: "private-retained-delivery",
          endpointKey: "private-retained-endpoint",
          state: "clicked",
          attemptCount: 1,
          clickedAt: Date.now() - 500,
        }],
      }],
    });
  });
  await expect(panel.getByRole("group", { name: "Delivery Receipt Status" })).toContainText("Result Delivered");
  await expect(panel.getByRole("list", { name: "Retained Delivery Receipts" })).toContainText("Notification Opened");
  await expect(panel.locator(".background-work-job")).toHaveCount(0);
  await expect(panel.locator(".background-work-delivery")).toHaveCount(1);
  await expect(panel).not.toContainText(/private-retained-(continuation|delivery|endpoint)/);
  const retainedParent = panel.getByRole("button", { name: "View Parent Turn" });
  await retainedParent.focus();
  await expect(retainedParent).toBeFocused();
  await capture(page, "background-mobile-delivery-only");
});

test("mobile Session pane and action controls share trailing columns", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openSession(page, "git-visibility", { reviewReady: "1", sessionShell: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: "running",
      orchestratorCampaign: { pendingRequests: { human: 1, orchestrator: 1 } } as never,
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitActiveSubagent("session-alpha", "aligned-mobile-subagent");
  });
  await expect(page.locator(".session-bar .session-status-button")).toBeVisible();

  expectMobileSessionColumnsAligned(await mobileSessionHeaderGeometry(page));

  // Chromium desktop emulation reports a zero CSS env() safe area. Override the shared computed
  // inset at its owner to exercise the same non-zero geometry an iPhone notch supplies.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--mobile-session-trailing-inset", "21px");
  });
  expectMobileSessionColumnsAligned(await mobileSessionHeaderGeometry(page));
});

// #2182: the phone's second line leads with one Session Status control, chosen by what needs the
// person rather than by what fits, and the popover is a bottom sheet listing every condition.
for (const viewport of [
  { name: "320-pixel phone", width: 320 },
  { name: "360-pixel phone", width: 360 },
  { name: "390-pixel phone", width: 390 },
]) {
  test.describe(`with a touch pointer on a ${viewport.name}`, () => {
    // Its 44px menu rows are a touch size, keyed to the pointer rather than the viewport (#1799).
    test.use({ hasTouch: true });

    test(`the session bar leads with the Session Status control on a ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: 800 });
      await openSession(page, "git-visibility", { reviewReady: "1", sessionShell: "1" });
      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          backgroundWorkState: "running",
          orchestratorCampaign: { pendingRequests: { human: 1, orchestrator: 1 } } as never,
        });
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitActiveSubagent("session-alpha", "active-mobile-subagent");
      });
      await capture(page, `narrow-${viewport.width}`);

      const header = page.locator(".session-bar");
      const topbar = page.locator(".topbar");
      await expect(page.locator(".topbar, .session-bar")).toHaveCount(2);
      await expect(topbar.getByRole("button", { name: "Back to Sessions" })).toBeVisible();
      await expect(topbar.getByRole("heading", { name: "Alpha Session", exact: true })).toBeVisible();
      await expect(topbar.getByRole("button", { name: /^Open/ })).toHaveCount(0);
      // Settings left the phone topbar for the rail's More sheet (#458). The compact geometry this
      // test pins is now anchored on the trailing pane control instead of the gear.
      await expect(topbar.getByRole("button", { name: "Settings" })).toHaveCount(0);
      await expect(header.locator(".detail-bar-back, .session-bar-project, h1, .editor-select")).toHaveCount(0);
      await expect(header.locator('[aria-label^="Changes:"]')).toHaveCount(0);
      await expect(header.getByText("Detached Work")).toHaveCount(0);
      // The campaign request needs the person, so it is the one badge; background work, the worker
      // and the Orchestrator's request are rows of the popover, never "+N".
      const status = header.locator(".session-status-button");
      await expect(status).toHaveAccessibleName("Session Status: Needs Your Input, 1 Request");
      await expect(header.locator(".status")).toHaveCount(1);
      await expect(status.locator(".session-status-more")).toHaveCount(0);
      await expect(header.locator('[data-live="background-work"]'))
        .toHaveText("Background Work: Waiting on External Job");
      const metrics = await header.evaluate((element) => {
        const rect = (node: Element) => {
          const value = node.getBoundingClientRect();
          return {
            x: value.x, y: value.y, right: value.right, bottom: value.bottom,
            width: value.width, height: value.height,
          };
        };
        const clippingPane = element.closest(".inbox-preview-pane");
        const control = element.querySelector(".session-status-button") as HTMLElement;
        const badge = control.querySelector(".status") as HTMLElement;
        const actions = element.querySelector(".detail-actions") as HTMLElement;
        const share = element.querySelector('[aria-label="Share"]') as HTMLElement;
        const moreActions = element.querySelector('[aria-label="More Actions"]') as HTMLElement;
        const centerTarget = (target: HTMLElement) => {
          const box = target.getBoundingClientRect();
          const painted = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return painted === target || (painted !== null && target.contains(painted));
        };
        return {
          display: getComputedStyle(element).display,
          control: rect(control),
          badge: rect(badge),
          badgeClipped: badge.scrollWidth > badge.clientWidth + 0.5,
          actions: rect(actions),
          hasForkButton: element.querySelector('[aria-label="Fork Conversation"]') !== null,
          share: rect(share),
          shareIcon: rect(element.querySelector('[aria-label="Share"] svg')!),
          moreActions: rect(moreActions),
          moreActionsIcon: rect(element.querySelector('[aria-label="More Actions"] svg')!),
          headerHeight: element.getBoundingClientRect().height,
          headerX: element.getBoundingClientRect().x,
          hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
          pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
          controlIsTopmostAtCenter: centerTarget(control),
          shareIsTopmostAtCenter: centerTarget(share),
          moreActionsIsTopmostAtCenter: centerTarget(moreActions),
          clippingRight: Math.min(
            window.innerWidth, clippingPane?.getBoundingClientRect().right ?? window.innerWidth,
          ),
          paddingRight: Number.parseFloat(getComputedStyle(element).paddingRight),
        };
      });
      const shellMetrics = await topbar.evaluate((element) => {
        const topbarBox = element.getBoundingClientRect();
        const back = element.querySelector('[aria-label="Back to Sessions"]')!.getBoundingClientRect();
        const title = element.querySelector("h1")!.getBoundingClientRect();
        const controls = [...element.querySelectorAll(".topbar-mobile-controls button")]
          .map((node) => node.getBoundingClientRect());
        const trailingControl = controls.reduce((furthest, box) => box.right > furthest.right ? box : furthest);
        const style = getComputedStyle(element.querySelector("h1")!);
        return {
          top: topbarBox.top,
          bottom: topbarBox.bottom,
          right: topbarBox.right,
          trailingControl: {
            width: trailingControl.width, height: trailingControl.height, right: trailingControl.right,
          },
          back: { width: back.width, height: back.height, right: back.right },
          title: { x: title.x, right: title.right, width: title.width },
          titleFontSize: Number.parseFloat(style.fontSize),
          controlsLeft: Math.min(...controls.map((box) => box.left)),
          furthestControlRight: Math.max(...controls.map((box) => box.right)),
          controls: controls.map((box) => ({ width: box.width, height: box.height })),
          controlIcons: [...element.querySelectorAll(".topbar-mobile-controls button svg")]
            .map((node) => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; }),
        };
      });
      const subheaderBottom = await header.evaluate((element) => element.getBoundingClientRect().bottom);

      expect(metrics.display).toBe("grid");
      // The shared 48px bar, which holds the toggles' 44px hit areas (§4.4, #2146).
      expect(shellMetrics.bottom - shellMetrics.top).toBe(48);
      expect(shellMetrics.titleFontSize).toBe(16);
      expect(shellMetrics.back.width).toBeGreaterThanOrEqual(36);
      expect(shellMetrics.back.height).toBeGreaterThanOrEqual(36);
      expect(shellMetrics.trailingControl.width).toBe(metrics.share.width);
      expect(shellMetrics.trailingControl.height).toBe(metrics.share.height);
      expect(metrics.share.width).toBe(metrics.moreActions.width);
      expect(metrics.share.height).toBe(metrics.moreActions.height);
      expect(metrics.hasForkButton, "Fork Conversation lives in More Actions (#2161)").toBe(false);
      expect(metrics.shareIcon.width).toBe(16);
      expect(metrics.shareIcon.height).toBe(16);
      expect(metrics.moreActionsIcon.width).toBe(16);
      expect(metrics.moreActionsIcon.height).toBe(16);
      for (const control of shellMetrics.controls) {
        expect(control.width).toBe(shellMetrics.trailingControl.width);
        expect(control.height).toBe(shellMetrics.trailingControl.height);
      }
      // The top bar's icons are on the §18 scale too, the same 16px as the header's (#2081).
      expect(shellMetrics.controlIcons.length).toBeGreaterThan(0);
      for (const icon of shellMetrics.controlIcons) expect(icon).toEqual({ width: 16, height: 16 });
      expect(shellMetrics.trailingControl.right).toBeCloseTo(shellMetrics.furthestControlRight, 0);
      expect(shellMetrics.title.x).toBeGreaterThanOrEqual(shellMetrics.back.right);
      expect(shellMetrics.title.right).toBeLessThanOrEqual(shellMetrics.controlsLeft);
      expect(shellMetrics.title.width).toBeGreaterThanOrEqual(72);
      // A running job buys the header no line of its own (#784): the topbar, the status/action line
      // and the worktree identity are all of it.
      expect(subheaderBottom - shellMetrics.top).toBeLessThanOrEqual(113);
      expect(metrics.share.width).toBeGreaterThanOrEqual(36);
      expect(metrics.share.height).toBeGreaterThanOrEqual(36);
      expect(metrics.moreActions.width).toBeGreaterThanOrEqual(36);
      expect(metrics.moreActions.height).toBeGreaterThanOrEqual(36);
      // The control leads the line, keeps its whole badge, and never pushes the actions (§15.1).
      expect(metrics.control.x - metrics.headerX).toBeLessThanOrEqual(16);
      expect(metrics.control.right).toBeLessThanOrEqual(metrics.actions.x - 6);
      expect(metrics.badge.right).toBeLessThanOrEqual(metrics.control.right);
      expect(metrics.badgeClipped).toBe(false);
      // The line's small size, like Share, borrowing a 44px target on touch (§2.8).
      expect(metrics.control.height).toBe(36);
      expect(metrics.headerHeight).toBeLessThanOrEqual(79);
      expect(metrics.hasHorizontalOverflow).toBe(false);
      expect(metrics.pageOverflows).toBe(false);
      expect(metrics.controlIsTopmostAtCenter).toBe(true);
      expect(metrics.shareIsTopmostAtCenter).toBe(true);
      expect(metrics.moreActionsIsTopmostAtCenter).toBe(true);
      expect(metrics.paddingRight).toBeGreaterThanOrEqual(12);
      expect(metrics.clippingRight - metrics.moreActions.right).toBeGreaterThanOrEqual(11.5);
      const center = (box: { y: number; height: number }) => box.y + box.height / 2;
      expect(Math.abs(center(metrics.actions) - center(metrics.control))).toBeLessThanOrEqual(1);

      await status.click();
      const statusPopover = page.getByRole("dialog", { name: "Session Status" });
      await expect(statusPopover).toBeVisible();
      const rows = statusPopover.locator(".session-status-row");
      await expect(rows.locator(".status")).toHaveText(["Needs Your Input1, 1 Request", "Waiting on External Job", "1 Worker", "Orchestrator Action1, 1 Request"]);
      await expect(rows.locator("button")).toHaveText(["Open Requests", "Open", "Open Agents", "Open Requests"]);
      // On a phone every popover is a bottom sheet across the screen (docs/design-system.md §9.2).
      await dialogMotionSettled(page);
      const popoverGeometry = await statusPopover.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const head = element.querySelector(".session-status-head")!;
        return {
          left: box.left,
          right: box.right,
          bottom: box.bottom,
          grabber: getComputedStyle(element.querySelector(".sheet-grabber")!).display,
          title: head.textContent,
          titleHeight: head.getBoundingClientRect().height,
          titleTransform: getComputedStyle(head).textTransform,
        };
      });
      expect(popoverGeometry.left).toBe(0);
      expect(popoverGeometry.right).toBe(viewport.width);
      expect(popoverGeometry.bottom).toBeCloseTo(page.viewportSize()!.height, 0);
      expect(popoverGeometry.grabber).toBe("block");
      expect(popoverGeometry.title).toBe("Session Status");
      expect(popoverGeometry.titleHeight).toBe(48);
      expect(popoverGeometry.titleTransform).toBe("none");
      await capture(page, `narrow-${viewport.width}-status-popover`);
      if (viewport.width === 390) {
        await rows.filter({ hasText: "Waiting on External Job" }).getByRole("button", { name: "Open Background Work" }).click();
        await expect(page.locator("#right-panel")).toHaveAccessibleName("Background Work");
        await page.getByRole("button", { name: "Close Panel" }).click();
      } else {
        await page.keyboard.press("Escape");
        await expect(status).toBeFocused();
      }
      await expect(statusPopover).toHaveCount(0);

      await status.click();
      await page.locator(".menu-backdrop").click({ position: { x: 300, y: 300 } });
      await expect(statusPopover).toHaveCount(0);
      await expect(status).toBeFocused();

      await status.click();
      await header.getByRole("button", { name: "Share" }).click();
      await expect(statusPopover).toHaveCount(0);
      await expect(page.getByRole("menu", { name: "Share" })).toBeVisible();
      await status.click();
      await expect(page.getByRole("menu", { name: "Share" })).toHaveCount(0);
      await expect(statusPopover).toBeVisible();

      await header.getByRole("button", { name: "More Actions" }).click();
      await expect(statusPopover).toHaveCount(0);
      const menu = page.getByRole("menu", { name: "More Actions" });
      await expect(menu).toBeVisible();
      await expect(menu.locator(".menu-label", { hasText: "Status" })).toHaveCount(0);
      await expect(menu.locator(".session-menu-statuses")).toHaveCount(0);
      // The project leads the phone sheet (§15.1): Open <Project>, Move to Another Project…, then a
      // separator before the session's own actions.
      const menuRows = menu.locator("[role='menuitem'], [role='separator']");
      await expect(menuRows.nth(0)).toHaveText("Open Alpha");
      await expect(menuRows.nth(1)).toHaveText("Move to Another Project…");
      await expect(menuRows.nth(2)).toHaveAttribute("role", "separator");
      await expect(menu.getByRole("menuitem", { name: "Copy Session Link" })).toHaveCount(0);
      // Read the rows once the sheet has finished sliding up: mid-motion boxes are fractional.
      await dialogMotionSettled(page);
      for (const item of await menu.getByRole("menuitem").all()) {
        const box = await item.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      if (viewport.width === 390) {
        await menu.getByRole("menuitem", { name: "Move to Another Project…" }).click();
        const moveDialog = page.getByRole("dialog", { name: "Move to Project" });
        await expect(moveDialog).toBeVisible();
        await moveDialog.getByRole("button", { name: "Cancel" }).click();
        await expect(header.getByRole("button", { name: "More Actions" })).toBeFocused();
        await header.getByRole("button", { name: "Share" }).click();
        await expect(menu).toHaveCount(0);
        const shareMenu = page.getByRole("menu", { name: "Share" });
        const copyLink = shareMenu.getByRole("menuitem", { name: "Copy Session Link" });
        await expect(copyLink).toBeEnabled();
        const headerHeight = await header.evaluate((element) => element.getBoundingClientRect().height);
        await copyLink.click();
        // The result is a toast (§13.1); the bar keeps its height and holds no note (#2161).
        await expect(page.locator(".toast", { hasText: /Link copied\.|Couldn't copy the link\./ })).toBeVisible();
        await expect(header.locator(".session-header-note, .detail-note")).toHaveCount(0);
        expect(await header.evaluate((element) => element.getBoundingClientRect().height)).toBe(headerHeight);
      }
    });
  });
}

test("the phone status follows live Session changes, attention first, at every width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSession(page, "git-visibility", { reviewReady: "1", sessionShell: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: "running",
      pendingApproval: {
        kind: "permission", requestId: "phone-approval", title: "Run the tests", options: [],
        additionalRequests: [{ kind: "question", requestId: "phone-question", title: "Which branch?", options: [], questions: [] }],
      },
    } as never);
  });
  const header = page.locator(".session-bar");
  const status = header.locator(".session-status-button");
  // Two kinds need the person: the first is the badge, the other is "+1", whatever the width.
  await expect(status).toHaveAccessibleName(/^Session Status: (Answer|Approval) Required and 1 More$/);
  await expect(status.locator(".session-status-more")).toHaveText("+1");
  for (const width of [390, 800, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(status.locator(".session-status-more")).toHaveText("+1");
    await expect(header.locator(".status")).toHaveCount(1);
  }
  // Answered, the session awaits its next prompt with a job still running (#784).
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { pendingApproval: null } as never);
  });
  await expect(status).toHaveAccessibleName("Session Status: Waiting on External Job");
  await expect(status.locator(".session-status-more")).toHaveCount(0);
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { backgroundWorkState: "resumed" });
  });
  await expect(status).toHaveAccessibleName("Session Status: Awaiting Prompt");
  await status.click();
  const popover = page.getByRole("dialog", { name: "Session Status" });
  await expect(popover.getByText("Waiting on External Job", { exact: true })).toHaveCount(0);
  await expect(popover.locator(".session-status-row .status")).toHaveText(["Awaiting Prompt"]);
});

test("background work as the phone status leaves the actions hittable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status: "idle",
      backgroundWorkState: "running",
    });
  });

  const header = page.locator(".session-bar");
  await expect(header.locator(".change-status-indicators")).toHaveCount(0);
  await expect(header.locator(".session-status-button")).toHaveAccessibleName("Session Status: Waiting on External Job");
  await expect(header.getByRole("status").filter({ hasText: "Background Work: Waiting on External Job" })).toHaveCount(1);
  const metrics = await header.evaluate((element) => {
    const control = element.querySelector(".session-status-button")!.getBoundingClientRect();
    const actions = element.querySelector(".detail-actions")!.getBoundingClientRect();
    const isTopmostAtCenter = (target: Element) => {
      const box = target.getBoundingClientRect();
      const painted = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return painted === target || (painted !== null && target.contains(painted));
    };
    return {
      controlRight: control.right,
      actionsLeft: actions.x,
      shareIsTopmost: isTopmostAtCenter(element.querySelector('[aria-label="Share"]')!),
      moreActionsIsTopmost: isTopmostAtCenter(element.querySelector('[aria-label="More Actions"]')!),
    };
  });
  expect(metrics.controlRight).toBeLessThan(metrics.actionsLeft);
  expect(metrics.shareIsTopmost).toBe(true);
  expect(metrics.moreActionsIsTopmost).toBe(true);
});

for (const width of [1440, 320]) {
  test(`a worker's request shows its kind in the bar and names the worker in the popover at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openSession(page, "git-visibility", width > 760 ? { fullShell: "1" } : { sessionShell: "1" });
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        status: "input_required",
        pendingApproval: { kind: "permission", requestId: "owned", title: "Run the audit", options: [], ownerToolUseId: "tool-audit" },
        attentionOwners: [{ requestId: "owned", toolCallId: "tool-audit", resolved: true, name: "Dependency Audit Worker", role: "security reviewer" }],
        backgroundWorkState: "running",
      } as never);
    });
    const status = page.locator(".session-bar .session-status-button");
    await expect(status).toHaveAccessibleName("Session Status: Approval Required");
    await expect(status.locator(".status")).toHaveText("Approval Required");
    await status.click();
    const dialog = page.getByRole("dialog", { name: "Session Status" });
    const row = dialog.locator(".session-status-row").first();
    await expect(row.locator(".session-status-text")).toContainText("Dependency Audit Worker · Security Reviewer owns this request.");
    await dialogMotionSettled(page);
    // Every row keeps its badge clear of its action and inside the popover.
    const rows = await dialog.locator(".session-status-row").evaluateAll((elements) => elements.map((element) => {
      const badge = element.querySelector(".status, .session-status-fact")!.getBoundingClientRect();
      const action = element.querySelector("button")?.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        overlap: action ? badge.right > action.left && badge.left < action.right &&
          badge.bottom > action.top && badge.top < action.bottom : false,
        inside: badge.left >= box.left - 0.5 && badge.right <= box.right + 0.5,
      };
    }));
    expect(rows.length).toBe(2);
    for (const metrics of rows) expect(metrics).toEqual({ overlap: false, inside: true });
  });
}

test("long session titles truncate before the statuses without hiding actions", async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 800 });
  await openSession(page);
  const header = page.locator(".session-bar");
  await header.locator("h1").evaluate((element) => {
    element.textContent = "A very long session title that must yield to a complete action cluster without hiding navigation";
  });

  const metrics = await header.evaluate((element) => {
    const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
    const headerRect = element.getBoundingClientRect();
    const title = element.querySelector("h1") as HTMLElement;
    const titleBox = title.getBoundingClientRect();
    const statuses = rect(".session-status-button");
    const actions = rect(".detail-actions");
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("expanded Session bar is not mounted in the clipping pane");
    const titleStyle = getComputedStyle(title);
    return {
      titleWidth: titleBox.width,
      titleRight: titleBox.right,
      statusesLeft: statuses.left,
      statusesRight: statuses.right,
      actionsLeft: actions.left,
      actionsRight: actions.right,
      titleWhiteSpace: titleStyle.whiteSpace,
      titleTextOverflow: titleStyle.textOverflow,
      headerRight: headerRect.right,
      clippingRight: Math.min(window.innerWidth, clippingPane.getBoundingClientRect().right),
      moreActionsRight: element.querySelector('[aria-label="More Actions"]')!.getBoundingClientRect().right,
      paddingRight: Number.parseFloat(getComputedStyle(element).paddingRight),
    };
  });

  expect(metrics.titleWidth).toBeGreaterThanOrEqual(120);
  expect(metrics.titleRight).toBeLessThanOrEqual(metrics.statusesLeft + 1);
  expect(metrics.statusesRight).toBeLessThanOrEqual(metrics.actionsLeft + 1);
  expect(metrics.titleWhiteSpace).toBe("nowrap");
  expect(metrics.titleTextOverflow).toBe("ellipsis");
  expect(metrics.paddingRight).toBeGreaterThanOrEqual(12);
  expect(metrics.headerRight - metrics.actionsRight).toBeGreaterThanOrEqual(metrics.paddingRight - 1);
  expect(metrics.clippingRight - metrics.moreActionsRight).toBeGreaterThanOrEqual(11.5);
});

test.describe("at 125% device scaling", () => {
  test.use({ deviceScaleFactor: 1.25 });

  test("mobile Session action columns remain aligned on fractional device pixels", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openSession(page, "preview-follow", { sessionShell: "1" });
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(1.25);
    expectMobileSessionColumnsAligned(await mobileSessionHeaderGeometry(page));
  });

  test("session header preserves its trailing inset across clipping-pane scrollbar states", async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 800 });
    await openSession(page);
    const header = page.locator(".session-bar");
    const clippingPane = page.locator(".inbox-preview-pane");
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(1.25);

    for (const overflowY of ["scroll", "hidden"] as const) {
      await clippingPane.evaluate((element, value) => {
        element.style.overflowY = value;
        element.style.scrollbarGutter = value === "scroll" ? "stable" : "auto";
      }, overflowY);
      const metrics = await header.evaluate((element) => {
        const clippingPane = element.closest(".inbox-preview-pane");
        if (!clippingPane) throw new Error("expanded Session header is not mounted in the clipping pane");
        const headerBox = element.getBoundingClientRect();
        const actionsBox = element.querySelector(".detail-actions")!.getBoundingClientRect();
        const moreActionsBox = element.querySelector('[aria-label="More Actions"]')!.getBoundingClientRect();
        return {
          actionsClearance: headerBox.right - actionsBox.right,
          controlClearance: Math.min(window.innerWidth, clippingPane.getBoundingClientRect().right) - moreActionsBox.right,
          paddingRight: Number.parseFloat(getComputedStyle(element).paddingRight),
        };
      });
      expect(metrics.paddingRight).toBeGreaterThanOrEqual(12);
      expect(metrics.actionsClearance).toBeGreaterThanOrEqual(11.5);
      expect(metrics.controlClearance).toBeGreaterThanOrEqual(11.5);
    }
  });
});

test("unbroken 120-character session titles truncate without overlapping bar actions", async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 800 });
  await openSession(page);
  const header = page.locator(".session-bar");
  await header.locator("h1").evaluate((element) => {
    element.textContent = "W".repeat(120);
  });

  const metrics = await header.evaluate((element) => {
    const title = element.querySelector("h1")!.getBoundingClientRect();
    const actions = element.querySelector(".detail-actions")!.getBoundingClientRect();
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("expanded Session bar is not mounted in the clipping pane");
    return {
      titleRight: title.right,
      actionsLeft: actions.left,
      clippingRight: Math.min(window.innerWidth, clippingPane.getBoundingClientRect().right),
      moreActionsRight: element.querySelector('[aria-label="More Actions"]')!.getBoundingClientRect().right,
    };
  });

  expect(metrics.titleRight).toBeLessThanOrEqual(metrics.actionsLeft + 1);
  expect(metrics.clippingRight - metrics.moreActionsRight).toBeGreaterThanOrEqual(11.5);
});

test.describe("with a touch pointer", () => {
  // Its 44px menu rows are a touch size, keyed to the pointer rather than the viewport (#1799).
  test.use({ hasTouch: true });

  test("the two mobile Session bars use compact touch targets and a bounded menu near the breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await openSession(page, "preview-follow", { sessionShell: "1" });
    const header = page.locator(".session-bar");
    const actions = header.locator(".detail-actions");
    const backBox = await page.locator(".topbar").getByRole("button", { name: "Back to Sessions" }).boundingBox();
    const headerBox = await header.boundingBox();

    expect(backBox?.width).toBeGreaterThanOrEqual(36);
    expect(backBox?.height).toBeGreaterThanOrEqual(36);
    expect(headerBox?.height).toBeLessThanOrEqual(45);

    const moreActions = actions.getByRole("button", { name: "More Actions" });
    const trailingClearance = await moreActions.evaluate((element) => {
      const clippingPane = element.closest(".inbox-preview-pane");
      if (!clippingPane) throw new Error("More Actions is not mounted in the clipping pane");
      return Math.min(window.innerWidth, clippingPane.getBoundingClientRect().right)
        - element.getBoundingClientRect().right;
    });
    expect(trailingClearance).toBeGreaterThanOrEqual(11.5);
    await moreActions.click();
    const menu = page.getByRole("menu", { name: "More Actions" });
    await expect(menu).toBeVisible();
    // Below the phone breakpoint the menu is a bottom sheet (§9.2): docked to the bottom edge,
    // clear of the bar that opened it, and never taller than the screen.
    await dialogMotionSettled(page);
    const triggerBox = await moreActions.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(menuBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
    expect(menuBox!.y + menuBox!.height).toBeCloseTo(800, 0);
    for (const item of await menu.getByRole("menuitem").all()) {
      const box = await item.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test("the mobile Session name is the 16/600 title and truncates a long title on one line", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1" });
  const longTitle = "A deliberately long mobile Session name for compact header coverage";
  await page.evaluate((title) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { title });
  }, longTitle);
  const heading = page.locator(".topbar h1");
  await expect(heading).toHaveText(longTitle);

  // §15.1: the phone title is --type-title like every other page title (#2146), not a label.
  const metrics = await heading.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseFloat(style.fontWeight),
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      height: element.getBoundingClientRect().height,
    };
  });

  expect(metrics.fontSize).toBe(16);
  expect(metrics.fontWeight).toBe(600);
  expect(metrics.whiteSpace).toBe("nowrap");
  expect(metrics.textOverflow).toBe("ellipsis");
  expect(metrics.hasHorizontalOverflow).toBe(true);
  expect(metrics.height).toBeLessThan(30);
});

test("the Share menu scrolls inside a short landscape-phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await openSession(page, "git-visibility", { sessionShell: "1" });
  await page.locator(".session-bar").getByRole("button", { name: "Share" }).click();
  const menu = page.getByRole("menu", { name: "Share" });
  await expect(menu).toBeVisible();
  await dialogMotionSettled(page);
  const geometry = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(320);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.overflowY).toBe("auto");
  await menu.getByRole("menuitem", { name: "Export as JSON" }).scrollIntoViewIfNeeded();
  await expect(menu.getByRole("menuitem", { name: "Export as JSON" })).toBeVisible();
});

test("legacy control planes keep mobile Workspace re-filing in More Actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1", legacyWorkspaces: "1" });
  const moreActions = page.locator(".session-bar").getByRole("button", { name: "More Actions" });
  await moreActions.click();
  const menu = page.getByRole("menu", { name: "More Actions" });
  // A Workspace has no page to open, so the sheet leads with moving the session alone.
  const rows = menu.locator("[role='menuitem'], [role='separator']");
  await expect(rows.nth(0)).toHaveText("Move to Another Workspace…");
  await expect(rows.nth(1)).toHaveAttribute("role", "separator");
  await menu.getByRole("menuitem", { name: "Move to Another Workspace…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to Workspace" });
  const moveSession = dialog.getByRole("button", { name: "Move Session" });
  // The same selection model as Move to Project (#2163): the current workspace is selected, and the
  // primary waits for a different one.
  await expect(moveSession).toBeDisabled();
  await expect(dialog.getByText("Choose a different workspace.")).toBeVisible();
  // New Workspace… is a body action; the footer keeps Cancel and the primary.
  const newWorkspace = dialog.getByRole("button", { name: "New Workspace…" });
  await expect(dialog.locator(".modal-body").getByRole("button", { name: "New Workspace…" })).toBeVisible();
  await expect(dialog.locator(".modal-foot").getByRole("button")).toHaveText(["Cancel", "Move Session"]);
  await newWorkspace.click();
  const createDialog = page.getByRole("dialog", { name: "New Workspace" });
  await expect(createDialog.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(createDialog.getByRole("textbox", { name: "Folder" })).toHaveAttribute("readonly", "");
  await expect(createDialog.getByRole("button", { name: "Browse…" })).toBeVisible();
  await createDialog.getByRole("button", { name: "Cancel" }).click();
  const returnedDialog = page.getByRole("dialog", { name: "Move to Workspace" });
  await expect(returnedDialog.getByRole("button", { name: "New Workspace…" })).toBeFocused();

  await returnedDialog.getByRole("radio", { name: /Alpha Secondary/ }).click();
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.workspaceMoveCount())).toBe(0);
  await returnedDialog.getByRole("button", { name: "Move Session" }).click();
  await expect(returnedDialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
    .find((session) => session.id === "session-alpha")?.workspaceId)).toBe("alpha-secondary-workspace");
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.workspaceMoveCount())).toBe(1);
  await expect(moreActions).toBeFocused();
});

test("legacy unfiled sessions use the Workspace vocabulary in More Actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openSession(page, "preview-follow", {
    sessionShell: "1",
    legacyWorkspaces: "1",
    unfiledWorkspace: "1",
  });
  await page.locator(".session-bar").getByRole("button", { name: "More Actions" }).click();
  await expect(page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem").first())
    .toHaveText("Move to a Workspace…");
});

// Run and Pod detail share one 48px detail bar (#1801, docs/design-system.md §4.3): a ChevronLeft
// Back named for the destination, the entity title as the page's only h1, one status badge after
// it, and destructive actions only in ⋯.
test("shared Pod headers keep their trailing controls out of the back-button track", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/command-inbox-projects-e2e.html?view=pod");
  const pod = page.locator(".pod-detail");
  await expect(pod.getByRole("heading", { level: 1, name: "Active Collaboration Pod" })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(pod.locator(".session-bar")).toHaveCount(0);

  const bar = pod.locator(".detail-bar");
  const back = bar.getByRole("button", { name: "Back to Pods", exact: true });
  await expect(back).toBeVisible();
  await expect(back.locator("svg")).toHaveCount(1);
  await expect(back).toHaveText("");
  const geometry = async () => bar.evaluate((element) => {
    const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
    const back = rect(".detail-bar-back");
    const title = rect(".detail-bar-title");
    const status = rect(".status");
    const more = rect('[aria-label="More Actions"]');
    return {
      display: getComputedStyle(element).display,
      height: element.getBoundingClientRect().height,
      backX: back.x,
      backCenter: back.y + back.height / 2,
      titleRight: title.right,
      statusX: status.x,
      moreCenter: more.y + more.height / 2,
      moreRight: more.right,
      barRight: element.getBoundingClientRect().right,
      badges: element.querySelectorAll(".status").length,
    };
  });
  const desktop = await geometry();
  expect(desktop.display).toBe("flex");
  expect(desktop.height).toBe(48);
  expect(desktop.badges).toBe(1);
  expect(desktop.statusX).toBeGreaterThan(desktop.titleRight);
  expect(desktop.statusX - desktop.titleRight).toBeLessThanOrEqual(12);
  expect(Math.abs(desktop.moreCenter - desktop.backCenter)).toBeLessThanOrEqual(1);
  expect(desktop.barRight - desktop.moreRight).toBeGreaterThanOrEqual(16);

  // Close Pod is destructive, so it is not a bar button: it is the last ⋯ item, in danger text.
  await expect(bar.getByRole("button", { name: "Close Pod" })).toHaveCount(0);
  await bar.getByRole("button", { name: "More Actions" }).click();
  const close = page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem").last();
  await expect(close).toHaveText("Close Pod");
  await expect(close).toHaveClass(/\bdanger\b/);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 520, height: 800 });
  const narrow = await geometry();
  expect(narrow.display).toBe("flex");
  expect(narrow.height).toBe(48);
  expect(narrow.statusX).toBeGreaterThan(narrow.backX);
  expect(Math.abs(narrow.moreCenter - narrow.backCenter)).toBeLessThanOrEqual(1);
});

test("shared Run headers retain their desktop geometry in the stacked Session range", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/command-inbox-projects-e2e.html?view=run");
  const run = page.locator(".run-detail");
  await expect(run.getByRole("heading", { level: 1, name: "Final QA Run" })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(run.getByRole("button", { name: "Back to Multi-Agent Runs", exact: true })).toBeVisible();

  const bar = run.locator(".detail-bar");
  const measure = () => bar.evaluate((element) => {
    const back = element.querySelector(".detail-bar-back")!.getBoundingClientRect();
    return {
      display: getComputedStyle(element).display,
      height: element.getBoundingClientRect().height,
      backWidth: back.width,
      backHeight: back.height,
    };
  });
  const desktop = await measure();
  expect(desktop.display).toBe("flex");
  expect(desktop.height).toBe(48);
  expect(desktop.backWidth).toBe(32);
  expect(desktop.backHeight).toBe(32);

  await page.setViewportSize({ width: 700, height: 800 });
  const stackedRange = await measure();
  expect(stackedRange.display).toBe("flex");
  expect(stackedRange.height).toBe(48);
  expect(Math.abs(stackedRange.backWidth - desktop.backWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(stackedRange.backHeight - desktop.backHeight)).toBeLessThanOrEqual(1);
});
