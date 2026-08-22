import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

async function openSession(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".detail-head")).toBeVisible();
  await expect(page.locator(".inbox-preview-pane")).toHaveCount(1);
}

async function capture(page: Page, viewport: "desktop" | "narrow") {
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
  await expect(back).toHaveAttribute("title", "Back to Inbox");
  await expect(header.locator(".status-badge")).toBeVisible();

  const geometry = await header.evaluate((element) => {
    const rect = (node: Element) => {
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const backControl = element.querySelector(".back")!;
    const crumbs = element.querySelector(".detail-crumbs")!;
    const actions = element.querySelector(".detail-actions")!;
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
      headerHeight: headerBox.height,
      headerRight: headerBox.right,
      clippingRight: Math.min(window.innerWidth, clippingBox.right),
      moreActionsRight: moreActions.getBoundingClientRect().right,
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      paddingRight: Number.parseFloat(style.paddingRight),
    };
  });

  expect(geometry.back.width).toBeGreaterThanOrEqual(40);
  expect(geometry.back.height).toBeGreaterThanOrEqual(40);
  // The point of the unified bar: Codex-density chrome, not the old three-strata stack.
  expect(geometry.headerHeight).toBeLessThanOrEqual(64);
  expect(geometry.paddingTop).toBeGreaterThanOrEqual(6);
  expect(geometry.paddingTop).toBe(geometry.paddingBottom);
  expect(geometry.paddingRight).toBeGreaterThanOrEqual(12);
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
  // The ⋯ trigger overlays the crumb (no layout footprint) but stays in the tab order even
  // while faded out; focusing it reveals it over the crumb's trailing text.
  await expect(header.getByRole("button", { name: "Project Actions" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(header.locator(".detail-crumbs .cctx-chip")).toBeFocused();
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
});

test("the session bar keeps one row and 44-pixel targets at narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await openSession(page);
  await capture(page, "narrow");

  const header = page.locator(".detail-head");
  const metrics = await header.evaluate((element) => {
    const rect = (node: Element) => {
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const clippingPane = element.closest(".inbox-preview-pane");
    if (!clippingPane) throw new Error("expanded Session bar is not mounted in the clipping pane");
    return {
      back: rect(element.querySelector(".back")!),
      crumbs: rect(element.querySelector(".detail-crumbs")!),
      actions: rect(element.querySelector(".detail-actions")!),
      moreActions: rect(element.querySelector('[aria-label="More Actions"]')!),
      headerRight: element.getBoundingClientRect().right,
      clippingRight: Math.min(window.innerWidth, clippingPane.getBoundingClientRect().right),
      paddingRight: Number.parseFloat(getComputedStyle(element).paddingRight),
    };
  });

  expect(metrics.back.width).toBeGreaterThanOrEqual(44);
  expect(metrics.back.height).toBeGreaterThanOrEqual(44);
  expect(metrics.moreActions.width).toBeGreaterThanOrEqual(44);
  expect(metrics.moreActions.height).toBeGreaterThanOrEqual(44);
  expect(metrics.paddingRight).toBeGreaterThanOrEqual(12);
  expect(metrics.headerRight - (metrics.actions.x + metrics.actions.width)).toBeGreaterThanOrEqual(metrics.paddingRight - 1);
  expect(metrics.clippingRight - (metrics.moreActions.x + metrics.moreActions.width)).toBeGreaterThanOrEqual(11.5);
  // Still one row: the compact bar truncates instead of stacking actions under the title.
  const center = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(Math.abs(center(metrics.actions) - center(metrics.crumbs))).toBeLessThanOrEqual(1);

  await header.getByRole("button", { name: "More Actions" }).click();
  const menu = page.getByRole("menu", { name: "Session Actions" });
  await expect(menu).toBeVisible();
  for (const item of await menu.getByRole("menuitem").all()) {
    const box = await item.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
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

test("the session bar keeps 44-pixel targets and a bounded menu above the phone breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await openSession(page);
  const header = page.locator(".session-detail > .detail-head");
  const actions = header.locator(".detail-actions");
  const backBox = await header.locator(".back").boundingBox();

  expect(backBox?.width).toBeGreaterThanOrEqual(44);
  expect(backBox?.height).toBeGreaterThanOrEqual(44);

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
