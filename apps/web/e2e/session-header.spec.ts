import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

async function openSession(page: Page, scenario = "preview-follow", params: Record<string, string> = {}) {
  const query = new URLSearchParams({ scenario, ...params });
  await page.goto(`/command-inbox-projects-e2e.html?${query.toString()}`);
  const evidenceTheme = process.env.SESSION_HEADER_SCREENSHOT_THEME;
  await page.evaluate((theme) => {
    localStorage.clear();
    if (theme === "dark" || theme === "light") localStorage.setItem("wollipog.theme", theme);
  }, evidenceTheme);
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".detail-head")).toBeVisible();
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
  await page.screenshot({ path: join(directory, `${phase}-${viewport}.png`), fullPage: true });
}

test("the unified session bar balances navigation, breadcrumb, status, and actions on one row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSession(page);
  await capture(page, "desktop");

  const header = page.locator(".detail-head");
  const back = header.locator(".back");
  await expect(back).toHaveAccessibleName("Back to Inbox");
  await expect(back).toHaveAttribute("title", "Back to inbox");
  await expect(header.locator(".status-badge").first()).toBeVisible();

  const geometry = await header.evaluate((element) => {
    const rect = (node: Element) => {
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const backControl = element.querySelector(".back")!;
    const crumbs = element.querySelector(".detail-crumbs")!;
    const actions = element.querySelector(".detail-actions")!;
    const project = element.querySelector(".crumb-project")!;
    const projectButton = project.querySelector(".cctx-chip")!;
    const projectLabel = project.querySelector(".crumb-project-label")!;
    const projectActions = project.querySelector(".crumb-project-actions")!;
    const projectText = document.createRange();
    projectText.selectNodeContents(projectLabel);
    const moreActions = element.querySelector('[aria-label="More Actions"]')!;
    const headerBox = element.getBoundingClientRect();
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("expanded Session bar is not mounted in the clipping pane");
    const clippingBox = clippingPane.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      back: rect(backControl),
      crumbs: rect(crumbs),
      actions: rect(actions),
      project: rect(project),
      projectButton: rect(projectButton),
      projectActions: rect(projectActions),
      projectTextWidth: projectText.getBoundingClientRect().width,
      projectTextOverflow: getComputedStyle(projectLabel).textOverflow,
      headerHeight: headerBox.height,
      headerRight: headerBox.right,
      clippingRight: Math.min(window.innerWidth, clippingBox.right),
      moreActionsRight: moreActions.getBoundingClientRect().right,
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      paddingRight: Number.parseFloat(style.paddingRight),
      hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
    };
  });

  expect(geometry.back.width).toBeGreaterThanOrEqual(40);
  expect(geometry.back.height).toBeGreaterThanOrEqual(40);
  // The point of the unified bar: Codex-density chrome, not the old three-strata stack.
  expect(geometry.headerHeight).toBeLessThanOrEqual(64);
  expect(geometry.paddingTop).toBeGreaterThanOrEqual(6);
  expect(geometry.paddingTop).toBe(geometry.paddingBottom);
  expect(geometry.paddingRight).toBeGreaterThanOrEqual(12);
  expect(geometry.hasHorizontalOverflow).toBe(false);
  expect(geometry.projectButton.width - geometry.projectTextWidth).toBeLessThanOrEqual(1.5);
  expect(geometry.project.width - geometry.projectButton.width).toBeCloseTo(34, 0);
  expect(geometry.projectActions.x).toBeGreaterThanOrEqual(
    geometry.projectButton.x + geometry.projectButton.width - 1,
  );
  expect(geometry.projectTextOverflow).toBe("ellipsis");
  expect(geometry.headerRight - (geometry.actions.x + geometry.actions.width)).toBeGreaterThanOrEqual(geometry.paddingRight - 1);
  expect(geometry.clippingRight - geometry.moreActionsRight).toBeGreaterThanOrEqual(11.5);
  const center = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(Math.abs(center(geometry.back) - center(geometry.crumbs))).toBeLessThanOrEqual(1);
  expect(Math.abs(center(geometry.actions) - center(geometry.crumbs))).toBeLessThanOrEqual(1);

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

  const moreActions = header.getByRole("button", { name: "More Actions" });
  await moreActions.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(header.getByRole("button", { name: "Share" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  // The ⋯ trigger overlays the crumb (no layout footprint) but stays in the tab order even
  // while faded out; focusing it reveals it over the crumb's trailing text.
  await expect(header.getByRole("button", { name: "Project Actions" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(header.locator(".detail-crumbs .cctx-chip")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
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
  // The former standalone header actions live here now; the process-destructive item stays last
  // and visually distinct.
  await expect(menu.getByRole("menuitem", { name: "Rename Session…" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Archive and Stop" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Share Transcript…" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Export Markdown" })).toHaveCount(0);
  const stopSession = menu.getByRole("menuitem", { name: "Stop Session" });
  await expect(stopSession).toBeVisible();
  await expect(stopSession).toHaveClass(/menu-danger/);
  const menuItems = menu.getByRole("menuitem");
  await expect(menuItems.last()).toHaveText("Stop Session");
  const menuClearance = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("Session Actions menu is not mounted in the clipping pane");
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

test("coarse-pointer desktop keeps Project Actions beside short Project text", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 900, height: 800 },
  });
  const page = await context.newPage();
  try {
    await openSession(page);
    const header = page.locator(".detail-head");
    const projectButton = header.locator(".crumb-project > .cctx-chip");
    const projectActions = header.getByRole("button", { name: "Project Actions" });
    await expect(projectButton).toHaveText("Alpha");
    await expect(projectActions).toHaveCSS("opacity", "1");
    const geometry = await header.locator(".crumb-project").evaluate((element) => {
      const project = element.getBoundingClientRect();
      const button = element.querySelector(".cctx-chip")!.getBoundingClientRect();
      const actions = element.querySelector(".crumb-project-actions")!.getBoundingClientRect();
      return {
        projectWidth: project.width,
        buttonRight: button.right,
        actionsLeft: actions.left,
      };
    });
    expect(geometry.projectWidth).toBeLessThan(100);
    expect(geometry.actionsLeft).toBeGreaterThanOrEqual(geometry.buttonRight - 1);
  } finally {
    await context.close();
  }
});

test("desktop Session actions stay contained with five concurrent status indicators", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openSession(page, "git-visibility", { reviewReady: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status: "idle",
      backgroundWorkState: "running",
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitActiveSubagent("session-alpha", "active-desktop-subagent");
  });

  const header = page.locator(".session-detail > .detail-head");
  await expect(header.getByText("Awaiting Prompt", { exact: true })).toBeVisible();
  await expect(header.getByText("Ready for Review", { exact: true })).toBeVisible();
  await expect(header.getByText("Uncommitted Changes", { exact: true })).toBeVisible();
  await expect(header.getByRole("status", { name: "Background Work: Waiting on External Job" })).toBeVisible();
  await expect(header.getByRole("button", { name: "1 Subagent Active" })).toBeVisible();
  await capture(page, "desktop-concurrent");
  const longProjectName = "Alpha Project with a deliberately long name for breadcrumb truncation";
  await page.evaluate((name) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name });
  }, longProjectName);
  await expect(header.locator(".crumb-project > .cctx-chip")).toHaveText(longProjectName);
  await capture(page, "desktop-long-project");

  for (const width of [900, 761]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await header.evaluate((element) => {
      const headerBox = element.getBoundingClientRect();
      const actions = element.querySelector(".detail-actions")!.getBoundingClientRect();
      const moreActions = element.querySelector('[aria-label="More Actions"]')!.getBoundingClientRect();
      const project = element.querySelector(".crumb-project")!.getBoundingClientRect();
      const projectButton = element.querySelector(".crumb-project > .cctx-chip") as HTMLElement;
      const projectLabel = element.querySelector(".crumb-project-label") as HTMLElement;
      const projectActions = element.querySelector(".crumb-project-actions")!.getBoundingClientRect();
      const separator = element.querySelector(".detail-crumb-sep")!.getBoundingClientRect();
      const clippingPane = element.closest(".inbox-preview-pane");
      return {
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        headerRight: headerBox.right,
        actionsRight: actions.right,
        clippingRight: Math.min(
          window.innerWidth,
          clippingPane?.getBoundingClientRect().right ?? window.innerWidth,
        ),
        moreActionsRight: moreActions.right,
        paddingRight: Number.parseFloat(getComputedStyle(element).paddingRight),
        projectRight: project.right,
        projectWidth: project.width,
        projectButtonRight: projectButton.getBoundingClientRect().right,
        projectLabelClientWidth: projectLabel.clientWidth,
        projectLabelScrollWidth: projectLabel.scrollWidth,
        projectLabelTextOverflow: getComputedStyle(projectLabel).textOverflow,
        projectActionsLeft: projectActions.left,
        separatorLeft: separator.left,
      };
    });
    expect(geometry.hasHorizontalOverflow, `${width}px header overflow`).toBe(false);
    expect(geometry.headerRight - geometry.actionsRight).toBeGreaterThanOrEqual(geometry.paddingRight - 1);
    expect(geometry.clippingRight - geometry.moreActionsRight).toBeGreaterThanOrEqual(11.5);
    expect(geometry.projectWidth).toBeLessThanOrEqual(220);
    expect(geometry.projectRight).toBeLessThanOrEqual(geometry.separatorLeft);
    expect(geometry.projectLabelClientWidth).toBeGreaterThan(0);
    expect(geometry.projectLabelScrollWidth).toBeGreaterThan(geometry.projectLabelClientWidth);
    expect(geometry.projectLabelTextOverflow).toBe("ellipsis");
    expect(geometry.projectActionsLeft).toBeGreaterThanOrEqual(geometry.projectButtonRight - 1);
  }
  const projectActions = header.getByRole("button", { name: "Project Actions" });
  await projectActions.focus();
  await expect(projectActions).toBeFocused();
  await expect(projectActions).toBeVisible();
});

for (const viewport of [
  { name: "320-pixel phone", width: 320 },
  { name: "390-pixel phone", width: 390 },
]) {
  test(`the session bar clips simultaneous statuses to one line on a ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 800 });
    await openSession(page, "git-visibility", { reviewReady: "1", sessionShell: "1" });
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        backgroundWorkState: "running",
      });
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitActiveSubagent("session-alpha", "active-mobile-subagent");
    });
    await capture(page, `narrow-${viewport.width}`);

    const header = page.locator(".session-detail > .detail-head");
    const topbar = page.locator(".topbar");
    await expect(page.locator(".topbar, .session-detail > .detail-head")).toHaveCount(2);
    await expect(topbar.getByRole("button", { name: "Back to Inbox" })).toBeVisible();
    await expect(topbar.getByRole("heading", { name: "Alpha Session", exact: true })).toBeVisible();
    await expect(topbar.getByRole("button", { name: /^Open/ })).toHaveCount(0);
    await expect(topbar.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(header.locator(".back, .detail-crumbs, .editor-select")).toHaveCount(0);
    await expect(header.getByLabel("Activity: Awaiting Prompt")).toHaveCount(1);
    await expect(header.getByLabel("Changes: Ready for Review")).toHaveCount(1);
    await expect(header.getByLabel("Changes: Uncommitted Changes")).toHaveCount(1);
    await expect(header.getByRole("status", { name: "Background Work: Waiting on External Job" })).toHaveCount(1);
    const activeSubagent = header.getByRole("button", { name: "1 Subagent Active" });
    await expect(activeSubagent).toBeVisible();
    const metrics = await header.evaluate((element) => {
      const rect = (node: Element) => {
        const value = node.getBoundingClientRect();
        return {
          x: value.x, y: value.y, right: value.right, bottom: value.bottom,
          width: value.width, height: value.height,
        };
      };
      const clippingPane = element.closest(".inbox-preview-pane");
      const badges = [...element.querySelectorAll(
        ".session-header-statuses .status-badge, " +
        ".session-header-statuses > .background-work-badge",
      )].map((node) => ({
        ...rect(node),
        label: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "unknown status",
      }));
      const statuses = element.querySelector(".session-header-statuses") as HTMLElement;
      const actions = element.querySelector(".detail-actions") as HTMLElement;
      const share = element.querySelector('[aria-label="Share"]') as HTMLElement;
      const moreActions = element.querySelector('[aria-label="More Actions"]') as HTMLElement;
      const activeSubagent = element.querySelector('[aria-label="1 Subagent Active"]') as HTMLElement;
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
        lifecycle: rect(element.querySelector(".session-status-indicators > .status-badge")!),
        actions: rect(actions),
        share: rect(share),
        shareIcon: rect(element.querySelector('[aria-label="Share"] svg')!),
        moreActions: rect(moreActions),
        moreActionsIcon: rect(element.querySelector('[aria-label="More Actions"] svg')!),
        activeSubagent: rect(activeSubagent),
        badges,
        badgeRows: new Set(badges.map((badge) => Math.round(badge.y))).size,
        headerHeight: element.getBoundingClientRect().height,
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        statusAddsPageOverflow: pageScrollWidth > pageScrollWidthWithoutStatuses,
        statusIsClipped: Math.max(...badges.map((badge) => badge.right)) >
          statuses.getBoundingClientRect().right,
        statusOverflowX: statusStyle.overflowX,
        statusFlexWrap: statusStyle.flexWrap,
        statusMaskImage: statusStyle.maskImage || statusStyle.webkitMaskImage,
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
      const settings = element.querySelector('[aria-label="Settings"]')!.getBoundingClientRect();
      const back = element.querySelector('[aria-label="Back to Inbox"]')!.getBoundingClientRect();
      const title = element.querySelector("h1")!.getBoundingClientRect();
      const controls = [...element.querySelectorAll(".topbar-mobile-controls button")]
        .map((node) => node.getBoundingClientRect());
      const style = getComputedStyle(element.querySelector("h1")!);
      return {
        top: topbarBox.top,
        bottom: topbarBox.bottom,
        right: topbarBox.right,
        settings: { width: settings.width, height: settings.height, right: settings.right },
        back: { width: back.width, height: back.height, right: back.right },
        title: { x: title.x, right: title.right, width: title.width },
        titleFontSize: Number.parseFloat(style.fontSize),
        controlsLeft: Math.min(...controls.map((box) => box.left)),
        furthestControlRight: Math.max(...controls.map((box) => box.right)),
        controls: controls.map((box) => ({ width: box.width, height: box.height })),
      };
    });
    const subheaderBottom = await header.evaluate((element) => element.getBoundingClientRect().bottom);

    expect(metrics.display).toBe("grid");
    expect(shellMetrics.bottom - shellMetrics.top).toBeLessThanOrEqual(40.5);
    expect(shellMetrics.titleFontSize).toBeLessThanOrEqual(14);
    expect(shellMetrics.back.width).toBeGreaterThanOrEqual(36);
    expect(shellMetrics.back.height).toBeGreaterThanOrEqual(36);
    expect(shellMetrics.settings.width).toBe(metrics.share.width);
    expect(shellMetrics.settings.height).toBe(metrics.share.height);
    expect(metrics.share.width).toBe(metrics.moreActions.width);
    expect(metrics.share.height).toBe(metrics.moreActions.height);
    expect(metrics.shareIcon.width).toBe(15);
    expect(metrics.shareIcon.height).toBe(15);
    expect(metrics.moreActionsIcon.width).toBe(15);
    expect(metrics.moreActionsIcon.height).toBe(15);
    for (const control of shellMetrics.controls) {
      expect(control.width).toBe(shellMetrics.settings.width);
      expect(control.height).toBe(shellMetrics.settings.height);
    }
    expect(shellMetrics.settings.right).toBeCloseTo(shellMetrics.furthestControlRight, 0);
    expect(shellMetrics.title.x).toBeGreaterThanOrEqual(shellMetrics.back.right);
    expect(shellMetrics.title.right).toBeLessThanOrEqual(shellMetrics.controlsLeft);
    expect(shellMetrics.title.width).toBeGreaterThanOrEqual(72);
    // Five simultaneous statuses remain represented but use one clipped visual line. The Session
    // topbar is 40px tall, the main body adds 12px of leading space, and the second bar is 44px.
    expect(subheaderBottom - shellMetrics.top).toBeLessThanOrEqual(96.5);
    expect(metrics.share.width).toBeGreaterThanOrEqual(36);
    expect(metrics.share.height).toBeGreaterThanOrEqual(36);
    expect(metrics.moreActions.width).toBeGreaterThanOrEqual(36);
    expect(metrics.moreActions.height).toBeGreaterThanOrEqual(36);
    expect(metrics.statuses.right).toBeLessThanOrEqual(metrics.actions.x - 6);
    expect(metrics.headerHeight).toBeLessThanOrEqual(45.5);
    expect(metrics.hasHorizontalOverflow).toBe(false);
    expect(metrics.statusAddsPageOverflow).toBe(false);
    expect(metrics.statusIsClipped).toBe(true);
    expect(metrics.statusOverflowX).toBe("clip");
    expect(metrics.statusFlexWrap).toBe("nowrap");
    expect(metrics.statusMaskImage).toContain("linear-gradient");
    expect(metrics.statusMaskImage).toMatch(/rgba\(0, 0, 0, 0\) 100%/);
    expect(metrics.shareIsTopmostAtCenter).toBe(true);
    expect(metrics.moreActionsIsTopmostAtCenter).toBe(true);
    expect(metrics.activeSubagentIsTopmostAtCenter).toBe(true);
    expect(metrics.activeSubagent.x).toBeGreaterThanOrEqual(metrics.statuses.x);
    expect(metrics.activeSubagent.right).toBeLessThanOrEqual(metrics.statuses.right);
    expect(metrics.paddingRight).toBeGreaterThanOrEqual(12);
    expect(metrics.clippingRight - metrics.moreActions.right).toBeGreaterThanOrEqual(11.5);
    expect(metrics.badges.length).toBe(5);
    expect(metrics.badgeRows).toBe(1);
    const center = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(center(metrics.actions) - center(metrics.lifecycle))).toBeLessThanOrEqual(1);
    for (let index = 0; index < metrics.badges.length; index += 1) {
      for (let other = index + 1; other < metrics.badges.length; other += 1) {
        const left = metrics.badges[index]!;
        const right = metrics.badges[other]!;
        const overlaps = left.x < right.right && left.right > right.x &&
          left.y < right.bottom && left.bottom > right.y;
        expect(overlaps).toBe(false);
      }
    }

    await header.getByRole("button", { name: "More Actions" }).click();
    const menu = page.getByRole("menu", { name: "Session Actions" });
    await expect(menu).toBeVisible();
    await expect(menu.locator(".menu-label", { hasText: "Status" })).toHaveAttribute("aria-hidden", "true");
    const statusSummary = menu.locator(".session-menu-statuses");
    await expect(statusSummary.locator(".session-status-indicators")).toHaveCSS("flex-wrap", "wrap");
    await expect(statusSummary.getByText("Awaiting Prompt", { exact: true })).toBeVisible();
    await expect(statusSummary.getByText("Ready for Review", { exact: true })).toBeVisible();
    await expect(statusSummary.getByText("Uncommitted Changes", { exact: true })).toBeVisible();
    await expect(statusSummary.getByText("Waiting on External Job", { exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "View 1 Active Subagent" })).toBeEnabled();
    await capture(page, `narrow-${viewport.width}-status-menu`);
    const projectHeader = menu.locator(".session-project-menu-header");
    await expect(projectHeader).toContainText("Project");
    expect(await projectHeader.evaluate((element) => getComputedStyle(element).textTransform)).toBe("none");
    await expect(menu.getByRole("menuitem", { name: "Manage Project" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Move Session…" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy Internal Session Link" })).toHaveCount(0);
    for (const item of await menu.getByRole("menuitem").all()) {
      const box = await item.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    if (viewport.width === 390) {
      await menu.getByRole("menuitem", { name: "Move Session…" }).click();
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
}

test("wrapped background work clears phone actions when no change status is available", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1" });
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      backgroundWorkState: "running",
    });
  });

  const header = page.locator(".session-detail > .detail-head");
  await expect(header.locator(".change-status-indicators")).toHaveCount(0);
  await expect(header.getByRole("status", { name: "Background Work: Waiting on External Job" })).toBeVisible();
  const overlapsActions = await header.evaluate((element) => {
    const badge = element.querySelector(".background-work-badge")!.getBoundingClientRect();
    const actions = element.querySelector(".detail-actions")!.getBoundingClientRect();
    return badge.x < actions.right && badge.right > actions.x &&
      badge.y < actions.bottom && badge.bottom > actions.y;
  });
  expect(overlapsActions).toBe(false);
});

test("long session titles truncate inside the breadcrumb without hiding actions", async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 800 });
  await openSession(page);
  const header = page.locator(".session-detail > .detail-head");
  await header.locator(".detail-title").evaluate((element) => {
    element.textContent = "A very long session title that must yield to a complete action cluster without hiding navigation";
  });

  const metrics = await header.evaluate((element) => {
    const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
    const headerRect = element.getBoundingClientRect();
    const crumbs = rect(".detail-crumbs");
    const actions = rect(".detail-actions");
    const title = element.querySelector(".detail-title") as HTMLElement;
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("expanded Session bar is not mounted in the clipping pane");
    const titleStyle = getComputedStyle(title);
    return {
      crumbsWidth: crumbs.width,
      crumbsRight: crumbs.right,
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

  expect(metrics.crumbsWidth).toBeGreaterThanOrEqual(120);
  expect(metrics.crumbsRight).toBeLessThanOrEqual(metrics.actionsLeft + 1);
  expect(metrics.titleWhiteSpace).toBe("nowrap");
  expect(metrics.titleTextOverflow).toBe("ellipsis");
  expect(metrics.paddingRight).toBeGreaterThanOrEqual(12);
  expect(metrics.headerRight - metrics.actionsRight).toBeGreaterThanOrEqual(metrics.paddingRight - 1);
  expect(metrics.clippingRight - metrics.moreActionsRight).toBeGreaterThanOrEqual(11.5);
});

test.describe("at 125% device scaling", () => {
  test.use({ deviceScaleFactor: 1.25 });

  test("session header preserves its trailing inset across clipping-pane scrollbar states", async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 800 });
    await openSession(page);
    const header = page.locator(".session-detail > .detail-head");
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
  const header = page.locator(".session-detail > .detail-head");
  await header.locator(".detail-title").evaluate((element) => {
    element.textContent = "W".repeat(120);
  });

  const metrics = await header.evaluate((element) => {
    const crumbs = element.querySelector(".detail-crumbs")!.getBoundingClientRect();
    const actions = element.querySelector(".detail-actions")!.getBoundingClientRect();
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("expanded Session bar is not mounted in the clipping pane");
    return {
      crumbsRight: crumbs.right,
      actionsLeft: actions.left,
      clippingRight: Math.min(window.innerWidth, clippingPane.getBoundingClientRect().right),
      moreActionsRight: element.querySelector('[aria-label="More Actions"]')!.getBoundingClientRect().right,
    };
  });

  expect(metrics.crumbsRight).toBeLessThanOrEqual(metrics.actionsLeft + 1);
  expect(metrics.clippingRight - metrics.moreActionsRight).toBeGreaterThanOrEqual(11.5);
});

test("the two mobile Session bars use compact touch targets and a bounded menu near the breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1" });
  const header = page.locator(".session-detail > .detail-head");
  const actions = header.locator(".detail-actions");
  const backBox = await page.locator(".topbar").getByRole("button", { name: "Back to Inbox" }).boundingBox();
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
  const triggerBox = await moreActions.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(menuBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(800);
  for (const item of await menu.getByRole("menuitem").all()) {
    const box = await item.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test("the mobile Session name uses compact typography to reveal more of a long title", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openSession(page, "preview-follow", { sessionShell: "1" });
  const longTitle = "A deliberately long mobile Session name for compact header coverage";
  await page.evaluate((title) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { title });
  }, longTitle);
  const heading = page.locator(".topbar h1");
  await expect(heading).toHaveText(longTitle);

  const metrics = await heading.evaluate((element) => {
    const title = element as HTMLElement;
    const style = getComputedStyle(title);
    const box = title.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = `600 17px ${style.fontFamily}`;
    let prominentFit = 0;
    for (let index = 1; index <= title.textContent!.length; index += 1) {
      if (context.measureText(title.textContent!.slice(0, index)).width > box.width) break;
      prominentFit = index;
    }

    const range = document.createRange();
    const text = title.firstChild!;
    let visibleFit = 0;
    for (let index = 1; index <= text.textContent!.length; index += 1) {
      range.setStart(text, 0);
      range.setEnd(text, index);
      if (range.getBoundingClientRect().right > box.right + 0.5) break;
      visibleFit = index;
    }
    return {
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseFloat(style.fontWeight),
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      visibleFit,
      prominentFit,
      hasHorizontalOverflow: title.scrollWidth > title.clientWidth,
    };
  });

  expect(metrics.fontSize).toBeLessThanOrEqual(14);
  expect(metrics.fontWeight).toBeLessThanOrEqual(500);
  expect(metrics.whiteSpace).toBe("nowrap");
  expect(metrics.textOverflow).toBe("ellipsis");
  expect(metrics.hasHorizontalOverflow).toBe(true);
  expect(metrics.visibleFit).toBeGreaterThan(metrics.prominentFit);
});

test("the Share menu scrolls inside a short landscape-phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await openSession(page, "git-visibility", { sessionShell: "1" });
  await page.locator(".session-detail > .detail-head").getByRole("button", { name: "Share" }).click();
  const menu = page.getByRole("menu", { name: "Session Sharing" });
  await expect(menu).toBeVisible();
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
  const moreActions = page.locator(".session-detail > .detail-head").getByRole("button", { name: "More Actions" });
  await moreActions.click();
  const menu = page.getByRole("menu", { name: "Session Actions" });
  await expect(menu.locator(".session-project-menu-header")).toHaveText("Workspace · alpha-workspace");
  await expect(menu.getByRole("menuitem", { name: "Manage Project" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Move Session…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to Workspace" });
  await expect(dialog.getByRole("radio", { name: /Alpha Secondary/ })).toBeVisible();
  await dialog.getByRole("button", { name: "New Workspace…" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create Workspace" });
  await expect(createDialog.getByRole("textbox", { name: "Workspace Name" })).toBeVisible();
  await expect(createDialog.getByRole("button", { name: "Browse for a Folder…" })).toBeVisible();
  await createDialog.getByRole("button", { name: "Cancel" }).click();
  const returnedDialog = page.getByRole("dialog", { name: "Move to Workspace" });
  await returnedDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(moreActions).toBeFocused();
});

test("legacy unfiled sessions use the Workspace vocabulary in More Actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openSession(page, "preview-follow", {
    sessionShell: "1",
    legacyWorkspaces: "1",
    unfiledWorkspace: "1",
  });
  await page.locator(".session-detail > .detail-head").getByRole("button", { name: "More Actions" }).click();
  await expect(page.getByRole("menu", { name: "Session Actions" }).locator(".session-project-menu-header"))
    .toHaveText("Workspace · No Workspace");
});

test("shared Pod headers keep their trailing controls out of the back-button track", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/command-inbox-projects-e2e.html?view=pod");
  const pod = page.locator(".pod-detail");
  await expect(pod.getByText("Active Collaboration Pod", { exact: true })).toBeVisible();

  const header = pod.locator(".detail-head");
  const desktop = await header.evaluate((element) => {
    const back = element.querySelector(".back")!.getBoundingClientRect();
    const close = element.querySelector(".btn")!.getBoundingClientRect();
    return {
      display: getComputedStyle(element).display,
      backY: back.y,
      closeY: close.y,
      closeHeight: close.height,
    };
  });
  expect(desktop.display).toBe("flex");
  expect(Math.abs(desktop.closeY - desktop.backY)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 520, height: 800 });
  const narrow = await header.evaluate((element) => {
    const back = element.querySelector(".back")!.getBoundingClientRect();
    const info = element.querySelector(".detail-headinfo")!.getBoundingClientRect();
    const status = element.querySelector(".pod-status")!.getBoundingClientRect();
    const close = element.querySelector(".btn")!.getBoundingClientRect();
    return {
      display: getComputedStyle(element).display,
      backX: back.x,
      infoX: info.x,
      statusX: status.x,
      closeHeight: close.height,
    };
  });
  expect(narrow.display).toBe("flex");
  expect(narrow.infoX).toBeGreaterThan(narrow.backX);
  expect(narrow.statusX).toBeGreaterThan(narrow.backX);
  expect(Math.abs(narrow.closeHeight - desktop.closeHeight)).toBeLessThanOrEqual(1);
});

test("shared Run headers retain their desktop geometry in the stacked Session range", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/command-inbox-projects-e2e.html?view=run");
  const run = page.locator(".run-detail");
  await expect(run.getByText("Final QA Run", { exact: true })).toBeVisible();

  const header = run.locator(".detail-head");
  const desktop = await header.evaluate((element) => {
    const back = element.querySelector(".back")!.getBoundingClientRect();
    return { display: getComputedStyle(element).display, backWidth: back.width, backHeight: back.height };
  });
  expect(desktop.display).toBe("flex");

  await page.setViewportSize({ width: 700, height: 800 });
  const stackedRange = await header.evaluate((element) => {
    const back = element.querySelector(".back")!.getBoundingClientRect();
    return { display: getComputedStyle(element).display, backWidth: back.width, backHeight: back.height };
  });
  expect(stackedRange.display).toBe("flex");
  expect(Math.abs(stackedRange.backWidth - desktop.backWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(stackedRange.backHeight - desktop.backHeight)).toBeLessThanOrEqual(1);
});
