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
      pinned: rect('[aria-label="Toggle Pinned Summary"]', topbar),
      terminal: rect('[aria-label="Show Terminal"], [aria-label="Hide Terminal"]', topbar),
      sidePanel: rect('[aria-label="Show Side Panel"], [aria-label="Hide Side Panel"]', topbar),
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
      statusesRight: header.querySelector(".session-header-statuses")!.getBoundingClientRect().right,
      sessionActionsLeft: sessionActions.getBoundingClientRect().left,
      hasPageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

function expectMobileSessionColumnsAligned(geometry: Awaited<ReturnType<typeof mobileSessionHeaderGeometry>>) {
  expect(geometry.fork, "the fixture must expose the optional Fork column").not.toBeNull();
  expect(Math.abs(geometry.sidePanel.center - geometry.moreActions.center)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.terminal.center - geometry.share.center)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.pinned.center - geometry.fork!.center)).toBeLessThanOrEqual(0.5);
  expect(geometry.paneGap).toBe(geometry.sessionGap);
  expect(geometry.terminal.left - geometry.pinned.right).toBeCloseTo(geometry.paneGap, 1);
  expect(geometry.sidePanel.left - geometry.terminal.right).toBeCloseTo(geometry.paneGap, 1);
  expect(geometry.share.left - geometry.fork!.right).toBeCloseTo(geometry.sessionGap, 1);
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
    const toggle = page.getByRole("button", { name: "Show Side Panel" });
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
    await expect(page.getByRole("button", { name: "Hide Side Panel" })).toBeFocused();
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

  const trigger = page.getByRole("button", { name: "Needs Your Input: 1 Requests" });
  await trigger.click();
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
  const toggle = page.getByRole("button", { name: "Show Side Panel" });
  await toggle.click();
  await expect(page.locator("#right-panel")).toHaveAccessibleName("Panel");
  await expect(page.getByRole("button", { name: "Hide Side Panel" })).toBeFocused();
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
  const menu = page.getByRole("menu", { name: "Session Actions" });
  await expect(menu).toBeVisible();
  // The project button is visible at this width, so More Actions does not repeat its actions.
  await expect(menu.getByRole("menuitem", { name: "Move to Another Project…" })).toHaveCount(0);
  // The former standalone header actions live here now; the process-destructive item stays last
  // and visually distinct.
  await expect(menu.getByRole("menuitem", { name: "Rename Session…" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Archive and Stop" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Share Transcript…" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Export Markdown" })).toHaveCount(0);
  const stopSession = menu.getByRole("menuitem", { name: "Stop Session" });
  await expect(stopSession).toBeVisible();
  await expect(stopSession).toHaveClass(/\bdanger\b/);
  const menuItems = menu.getByRole("menuitem");
  await expect(menuItems.last()).toHaveText("Stop Session");
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
  const shareMenu = page.getByRole("menu", { name: "Session Sharing" });
  await expect(shareMenu.getByRole("menuitem", { name: "Share Transcript…" })).toBeVisible();
  await expect(shareMenu.getByRole("menuitem", { name: "Copy Internal Session Link" })).toBeVisible();
  await expect(shareMenu.getByRole("menuitem", { name: "Export Markdown" })).toBeVisible();
  await expect(shareMenu.getByRole("menuitem", { name: "Export JSON" })).toBeVisible();
  await expect(shareMenu.getByRole("menuitem", { name: "Rename Session…" })).toHaveCount(0);
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
  await expect(header.getByText("Awaiting Prompt", { exact: true })).toBeVisible();
  // Changes are a Git fact in the Pinned Summary (#2160), never a status in the bar.
  await expect(header.getByText(/Ready for Review|Uncommitted Changes|Changes Present/)).toHaveCount(0);
  await expect(header.getByRole("status", { name: "Background Work: Waiting on External Job" })).toBeVisible();
  await expect(header.locator(
    '.session-header-statuses > [aria-label="Background Work: Waiting on External Job"]',
  )).toBeVisible();
  await expect(header.getByRole("button", { name: "1 Worker Active" })).toBeVisible();
  await expect(header.locator(".session-status-overflow-trigger")).toHaveCount(0);
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
      const statuses = element.querySelector(".session-header-statuses")!.getBoundingClientRect();
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
    // The title keeps 200px, or all of itself when shorter, before the five statuses clip (§15.2).
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

  await header.getByRole("button", { name: "Background Work: Waiting on External Job" }).click();
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
  await expect(header.getByLabel("Background Work: Waiting on External Job")).toHaveCount(0);
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
      // Two campaign request badges take the place the change badges held before #2160, so the row
      // still overflows into its disclosure.
      orchestratorCampaign: { pendingRequests: { human: 1, orchestrator: 1 } } as never,
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitActiveSubagent("session-alpha", "aligned-mobile-subagent");
  });
  await expect(page.locator(".session-status-overflow-trigger")).toBeVisible();

  expectMobileSessionColumnsAligned(await mobileSessionHeaderGeometry(page));

  // Chromium desktop emulation reports a zero CSS env() safe area. Override the shared computed
  // inset at its owner to exercise the same non-zero geometry an iPhone notch supplies.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--mobile-session-trailing-inset", "21px");
  });
  expectMobileSessionColumnsAligned(await mobileSessionHeaderGeometry(page));

  const beforeOptionalActionRemoval = await mobileSessionHeaderGeometry(page);
  await page.getByRole("button", { name: "Fork Conversation" }).evaluate((element) => element.remove());
  const withoutOptionalAction = await mobileSessionHeaderGeometry(page);
  expect(withoutOptionalAction.fork).toBeNull();
  expect(withoutOptionalAction.share.center).toBeCloseTo(beforeOptionalActionRemoval.share.center, 1);
  expect(withoutOptionalAction.moreActions.center).toBeCloseTo(beforeOptionalActionRemoval.moreActions.center, 1);
  expect(withoutOptionalAction.terminal.center).toBeCloseTo(withoutOptionalAction.share.center, 1);
  expect(withoutOptionalAction.sidePanel.center).toBeCloseTo(withoutOptionalAction.moreActions.center, 1);
});

// #784 put background work into this measured row, so five badges compete for it and the row
// prefers background work over everything else. The compact phone label now keeps background work
// inline at the 320px floor, and the disclosure carries lower-priority statuses, workers included.
for (const viewport of [
  { name: "320-pixel phone", width: 320 },
  { name: "360-pixel phone", width: 360 },
  { name: "390-pixel phone", width: 390 },
]) {
  test.describe(`with a touch pointer on a ${viewport.name}`, () => {
    // Its 44px menu rows are a touch size, keyed to the pointer rather than the viewport (#1799).
    test.use({ hasTouch: true });

    test(`the session bar discloses overflowed statuses on a ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: 800 });
      await openSession(page, "git-visibility", { reviewReady: "1", sessionShell: "1" });
      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          backgroundWorkState: "running",
          // Two campaign request badges take the place the change badges held before #2160.
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
      await expect(header.locator('[aria-label="Activity: Awaiting Prompt"]')).toHaveCount(1);
      await expect(header.locator('[aria-label^="Changes:"]')).toHaveCount(0);
      const inlineBackgroundWork = header.locator(
        '.session-header-statuses > [aria-label="Background Work: Waiting on External Job"]',
      );
      await expect(inlineBackgroundWork).toHaveCount(1);
      await expect(inlineBackgroundWork).toBeVisible();
      await expect(header.locator(
        '.sr-only > [role="status"][aria-label="Background Work: Waiting on External Job"]',
      )).toHaveCount(1);
      // Workers rank with the lifecycle group, so at these widths the badge is disclosed rather than
      // inline; the popover copy below is asserted enabled, which is where it stays reachable.
      // A CSS locator, not a role locator: a displaced badge leaves the accessibility tree, and its
      // presence in the row's measured set is exactly what is being asserted here.
      const activeSubagent = header.locator('[aria-label="1 Worker Active"]');
      await expect(activeSubagent).toHaveCount(1);
      const activeSubagentInline = await activeSubagent.evaluate((element) => !element.hidden);
      const overflowTrigger = header.locator(".session-status-overflow-trigger");
      await expect(overflowTrigger).toBeVisible();
      const hiddenCount = Number.parseInt((await overflowTrigger.textContent())?.replace("+", "") ?? "", 10);
      expect(hiddenCount).toBeGreaterThan(0);
      await expect(overflowTrigger).toHaveAccessibleName(`+${hiddenCount}: Show ${hiddenCount} Hidden Statuses`);
      const metrics = await header.evaluate((element) => {
        const rect = (node: Element) => {
          const value = node.getBoundingClientRect();
          return {
            x: value.x, y: value.y, right: value.right, bottom: value.bottom,
            width: value.width, height: value.height,
          };
        };
        const clippingPane = element.closest(".inbox-preview-pane");
        const allBadges = [...element.querySelectorAll<HTMLElement>(
          ".session-header-statuses .status, " +
          ".session-header-statuses > .status[data-group='background-work']",
        )];
        const badges = allBadges.filter((node) => !node.hidden).map((node) => ({
          ...rect(node),
          label: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "unknown status",
        }));
        const statuses = element.querySelector(".session-header-statuses") as HTMLElement;
        const actions = element.querySelector(".detail-actions") as HTMLElement;
        const fork = element.querySelector('[aria-label="Fork Conversation"]') as HTMLElement;
        const share = element.querySelector('[aria-label="Share"]') as HTMLElement;
        const overflow = element.querySelector('.session-status-overflow-trigger') as HTMLElement;
        const moreActions = element.querySelector('[aria-label="More Actions"]') as HTMLElement;
        const activeSubagent = element.querySelector('[aria-label="1 Worker Active"]') as HTMLElement;
        const statusStyle = getComputedStyle(statuses);
        const pageScrollWidth = document.documentElement.scrollWidth;
        statuses.style.display = "none";
        const pageScrollWidthWithoutStatuses = document.documentElement.scrollWidth;
        statuses.style.removeProperty("display");
        const centerTarget = (target: HTMLElement) => {
          const box = target.getBoundingClientRect();
          const painted = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return painted === target || (painted !== null && target.contains(painted));
        };
        return {
          display: getComputedStyle(element).display,
          statuses: rect(statuses),
          firstVisibleStatus: badges[0],
          actions: rect(actions),
          fork: rect(fork),
          forkIcon: rect(element.querySelector('[aria-label="Fork Conversation"] svg')!),
          overflow: rect(overflow),
          share: rect(share),
          shareIcon: rect(element.querySelector('[aria-label="Share"] svg')!),
          moreActions: rect(moreActions),
          moreActionsIcon: rect(element.querySelector('[aria-label="More Actions"] svg')!),
          activeSubagent: rect(activeSubagent),
          badges,
          totalBadgeCount: allBadges.length,
          badgeRows: new Set(badges.map((badge) => Math.round(badge.y))).size,
          headerHeight: element.getBoundingClientRect().height,
          hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
          statusAddsPageOverflow: pageScrollWidth > pageScrollWidthWithoutStatuses,
          statusIsClipped: Math.max(...badges.map((badge) => badge.right)) >
            statuses.getBoundingClientRect().right,
          statusOverflowX: statusStyle.overflowX,
          statusFlexWrap: statusStyle.flexWrap,
          statusMaskImage: statusStyle.maskImage || statusStyle.webkitMaskImage,
          forkIsTopmostAtCenter: centerTarget(fork),
          shareIsTopmostAtCenter: centerTarget(share),
          moreActionsIsTopmostAtCenter: centerTarget(moreActions),
          activeSubagentIsTopmostAtCenter: centerTarget(activeSubagent),
          headerRight: element.getBoundingClientRect().right,
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
      expect(metrics.fork.width).toBe(metrics.share.width);
      expect(metrics.fork.height).toBe(metrics.share.height);
      expect(metrics.forkIcon.width).toBe(16);
      expect(metrics.forkIcon.height).toBe(16);
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
      // #784: background work rides the measured status/action line, so a running job no longer buys
      // the header a line of its own. The topbar, that line, and the worktree identity are all of it.
      expect(subheaderBottom - shellMetrics.top).toBeLessThanOrEqual(113);
      expect(metrics.share.width).toBeGreaterThanOrEqual(36);
      expect(metrics.share.height).toBeGreaterThanOrEqual(36);
      expect(metrics.moreActions.width).toBeGreaterThanOrEqual(36);
      expect(metrics.moreActions.height).toBeGreaterThanOrEqual(36);
      expect(metrics.statuses.right).toBeLessThanOrEqual(metrics.actions.x - 6);
      expect(metrics.headerHeight).toBeLessThanOrEqual(79);
      expect(metrics.hasHorizontalOverflow).toBe(false);
      expect(metrics.statusAddsPageOverflow).toBe(false);
      expect(metrics.statusIsClipped).toBe(false);
      expect(metrics.statusOverflowX).toBe("clip");
      expect(metrics.statusFlexWrap).toBe("nowrap");
      expect(metrics.statusMaskImage).toBe("none");
      expect(metrics.forkIsTopmostAtCenter).toBe(true);
      expect(metrics.shareIsTopmostAtCenter).toBe(true);
      expect(metrics.moreActionsIsTopmostAtCenter).toBe(true);
      if (activeSubagentInline) {
        expect(metrics.activeSubagentIsTopmostAtCenter).toBe(true);
        expect(metrics.activeSubagent.x).toBeGreaterThanOrEqual(metrics.statuses.x);
        expect(metrics.activeSubagent.right).toBeLessThanOrEqual(metrics.statuses.right);
      }
      expect(metrics.overflow.right).toBeLessThanOrEqual(metrics.fork.x);
      expect(metrics.fork.x - metrics.overflow.right).toBeCloseTo(8, 0); // 8px apart, so the borrowed 44px hit areas meet without overlapping (§2.8)
      expect(metrics.fork.right).toBeLessThanOrEqual(metrics.share.x);
      expect(metrics.share.x - metrics.fork.right).toBeCloseTo(8, 0);
      expect(metrics.paddingRight).toBeGreaterThanOrEqual(12);
      expect(metrics.clippingRight - metrics.moreActions.right).toBeGreaterThanOrEqual(11.5);
      expect(metrics.totalBadgeCount).toBe(5);
      expect(metrics.badges.length).toBe(5 - hiddenCount);
      expect(metrics.badgeRows).toBe(1);
      const center = (box: { y: number; height: number }) => box.y + box.height / 2;
      expect(Math.abs(center(metrics.actions) - center(metrics.firstVisibleStatus))).toBeLessThanOrEqual(1);
      for (let index = 0; index < metrics.badges.length; index += 1) {
        for (let other = index + 1; other < metrics.badges.length; other += 1) {
          const left = metrics.badges[index]!;
          const right = metrics.badges[other]!;
          const overlaps = left.x < right.right && left.right > right.x &&
            left.y < right.bottom && left.bottom > right.y;
          expect(overlaps).toBe(false);
        }
      }

      await overflowTrigger.click();
      const statusPopover = page.getByRole("dialog", { name: "Session Statuses" });
      await expect(statusPopover).toBeVisible();
      await expect(statusPopover.getByText("Awaiting Prompt", { exact: true })).toBeVisible();
      await expect(statusPopover.getByText("Waiting on External Job", { exact: true })).toBeVisible();
      await expect(statusPopover.getByRole("button", { name: "1 Worker Active" })).toBeEnabled();
      await expect(statusPopover.getByLabel("All Session Statuses")).toBeFocused();
      // On a phone every popover is a bottom sheet across the screen (docs/design-system.md §9.2).
      await dialogMotionSettled(page);
      const popoverGeometry = await statusPopover.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          bottom: box.bottom,
          grabber: getComputedStyle(element.querySelector(".sheet-grabber")!).display,
          contentWrap: getComputedStyle(element.querySelector(".session-status-popover-content")!).flexWrap,
        };
      });
      expect(popoverGeometry.left).toBe(0);
      expect(popoverGeometry.right).toBe(viewport.width);
      expect(popoverGeometry.bottom).toBeCloseTo(page.viewportSize()!.height, 0);
      expect(popoverGeometry.grabber).toBe("block");
      expect(popoverGeometry.contentWrap).toBe("wrap");
      await capture(page, `narrow-${viewport.width}-status-popover`);
      if (viewport.width === 390) {
        await statusPopover.getByRole("button", { name: "Background Work: Waiting on External Job" }).click();
        await expect(page.locator("#right-panel")).toHaveAccessibleName("Background Work");
        await expect(overflowTrigger).toBeFocused();
        await page.getByRole("button", { name: "Close Panel" }).click();
      } else {
        await page.keyboard.press("Escape");
      }
      await expect(statusPopover).toHaveCount(0);
      if (viewport.width !== 390) await expect(overflowTrigger).toBeFocused();

      await overflowTrigger.click();
      await page.locator(".menu-backdrop").click({ position: { x: 300, y: 700 } });
      await expect(statusPopover).toHaveCount(0);
      await expect(overflowTrigger).toBeFocused();

      await overflowTrigger.click();
      await header.getByRole("button", { name: "Share" }).click();
      await expect(statusPopover).toHaveCount(0);
      await expect(page.getByRole("menu", { name: "Session Sharing" })).toBeVisible();
      await overflowTrigger.click();
      await expect(page.getByRole("menu", { name: "Session Sharing" })).toHaveCount(0);
      await expect(statusPopover).toBeVisible();

      await header.getByRole("button", { name: "More Actions" }).click();
      await expect(statusPopover).toHaveCount(0);
      const menu = page.getByRole("menu", { name: "Session Actions" });
      await expect(menu).toBeVisible();
      await expect(menu.locator(".menu-label", { hasText: "Status" })).toHaveCount(0);
      await expect(menu.locator(".session-menu-statuses")).toHaveCount(0);
      // The project leads the phone sheet (§15.1): Open <Project>, Move to Another Project…, then a
      // separator before the session's own actions.
      const rows = menu.locator("[role='menuitem'], [role='separator']");
      await expect(rows.nth(0)).toHaveText("Open Alpha");
      await expect(rows.nth(1)).toHaveText("Move to Another Project…");
      await expect(rows.nth(2)).toHaveAttribute("role", "separator");
      await expect(menu.getByRole("menuitem", { name: "Copy Internal Session Link" })).toHaveCount(0);
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
        const shareMenu = page.getByRole("menu", { name: "Session Sharing" });
        const copyLink = shareMenu.getByRole("menuitem", { name: "Copy Internal Session Link" });
        await expect(copyLink).toBeEnabled();
        await copyLink.click();
        const note = header.locator(":scope > .session-header-note");
        await expect(note).toContainText(/session link/i);
        await expect(header.locator(".detail-actions .detail-note")).toHaveCount(0);
        const noteMetrics = await header.evaluate((element) => {
          const noteBox = element.querySelector(".session-header-note")!.getBoundingClientRect();
          const statusBox = element.querySelector(".session-header-statuses")!.getBoundingClientRect();
          const headerBox = element.getBoundingClientRect();
          return {
            width: noteBox.width,
            x: noteBox.x,
            right: noteBox.right,
            y: noteBox.y,
            statusBottom: statusBox.bottom,
            headerX: headerBox.x,
            headerRight: headerBox.right,
            paddingRight: Number.parseFloat(getComputedStyle(element).paddingRight),
            hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
          };
        });
        expect(noteMetrics.width).toBeGreaterThanOrEqual(140);
        expect(noteMetrics.x).toBeGreaterThanOrEqual(noteMetrics.headerX);
        expect(noteMetrics.y).toBeGreaterThanOrEqual(noteMetrics.statusBottom);
        expect(noteMetrics.right).toBeLessThanOrEqual(noteMetrics.headerRight - noteMetrics.paddingRight + 1);
        expect(noteMetrics.hasHorizontalOverflow).toBe(false);
      }
    });
  });
}

test("status overflow count follows width and live Session status changes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSession(page, "git-visibility", { reviewReady: "1", sessionShell: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: "running",
      // Two campaign request badges take the place the change badges held before #2160.
      orchestratorCampaign: { pendingRequests: { human: 1, orchestrator: 1 } } as never,
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitActiveSubagent("session-alpha", "dynamic-status-subagent");
  });

  const header = page.locator(".session-bar");
  // Five badges compete for the row since #784 put background work in it.
  const overflowTrigger = header.locator(".session-status-overflow-trigger");
  await expect(overflowTrigger).toBeVisible();
  const initialHiddenCount = Number.parseInt((await overflowTrigger.textContent())!.replace("+", ""), 10);
  expect(initialHiddenCount).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 800 });
  const landscapeOverflowTrigger = header.locator(".session-status-overflow-trigger");
  await expect(landscapeOverflowTrigger).toHaveText(/^\+[34]$/);
  await landscapeOverflowTrigger.click();
  await expect(page.getByRole("dialog", { name: "Session Statuses" })).toBeVisible();

  await page.setViewportSize({ width: 800, height: 800 });
  await expect(header.locator('.session-status-overflow-trigger')).toHaveCount(0);
  await expect(header.locator('.session-header-statuses [hidden]')).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Share" })).toBeFocused();

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(overflowTrigger).toBeVisible();
  const beforeRemoval = Number.parseInt((await overflowTrigger.textContent())!.replace("+", ""), 10);
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: "resumed",
    });
  });
  // Losing the badge removes it from both the row and disclosure. The fitter may use the freed
  // width for another badge, so pin the authoritative membership rather than a font-dependent count.
  await expect(header.locator(
    '.session-header-statuses > [aria-label^="Background Work:"]',
  )).toHaveCount(0);
  const afterRemoval = Number.parseInt((await overflowTrigger.textContent())!.replace("+", ""), 10);
  expect(afterRemoval).toBeGreaterThan(0);
  expect(afterRemoval).toBeLessThanOrEqual(beforeRemoval);
  await overflowTrigger.click();
  const popover = page.getByRole("dialog", { name: "Session Statuses" });
  await expect(popover.getByText("Waiting on External Job", { exact: true })).toHaveCount(0);
  await expect(popover.getByText("Awaiting Prompt", { exact: true })).toBeVisible();
});

test("a fitting phone status row does not render an overflow control", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1" });
  const header = page.locator(".session-bar");
  await expect(header.locator('.session-status-overflow-trigger')).toHaveCount(0);
  await expect(header.locator(".session-header-statuses .status")).toBeVisible();
});

test("measured background work leaves phone actions hittable when no change status is available", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: "running",
    });
  });

  const header = page.locator(".session-bar");
  await expect(header.locator(".change-status-indicators")).toHaveCount(0);
  await expect(header.getByRole("status", { name: "Background Work: Waiting on External Job" })).toBeVisible();
  const metrics = await header.evaluate((element) => {
    const badge = element.querySelector(".status[data-group='background-work']")!.getBoundingClientRect();
    const statuses = element.querySelector(".session-header-statuses")!.getBoundingClientRect();
    const actions = element.querySelector(".detail-actions")!.getBoundingClientRect();
    const isTopmostAtCenter = (target: Element) => {
      const box = target.getBoundingClientRect();
      const painted = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return painted === target || (painted !== null && target.contains(painted));
    };
    return {
      paintedBadgeRight: Math.min(badge.right, statuses.right),
      actionsLeft: actions.x,
      shareIsTopmost: isTopmostAtCenter(element.querySelector('[aria-label="Share"]')!),
      moreActionsIsTopmost: isTopmostAtCenter(element.querySelector('[aria-label="More Actions"]')!),
    };
  });
  expect(metrics.paintedBadgeRight).toBeLessThan(metrics.actionsLeft);
  expect(metrics.shareIsTopmost).toBe(true);
  expect(metrics.moreActionsIsTopmost).toBe(true);
});

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
    const statuses = rect(".session-header-statuses");
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
    const menu = page.getByRole("menu", { name: "Session Actions" });
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
  const menu = page.getByRole("menu", { name: "Session Sharing" });
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
  await menu.getByRole("menuitem", { name: "Export JSON" }).scrollIntoViewIfNeeded();
  await expect(menu.getByRole("menuitem", { name: "Export JSON" })).toBeVisible();
});

test("legacy control planes keep mobile Workspace re-filing in More Actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1", legacyWorkspaces: "1" });
  const moreActions = page.locator(".session-bar").getByRole("button", { name: "More Actions" });
  await moreActions.click();
  const menu = page.getByRole("menu", { name: "Session Actions" });
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
  await expect(page.getByRole("menu", { name: "Session Actions" }).getByRole("menuitem").first())
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
