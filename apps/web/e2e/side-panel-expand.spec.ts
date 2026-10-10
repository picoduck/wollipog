import { expect, test, type Page } from "@playwright/test";

/**
 * Expand Panel and the drag ceiling (#2845; docs/design-system.md §4.9, §15.2): expanded, the side
 * panel fills the session's content area beside the rail in place of the chat column, and Restore
 * Panel or Escape brings the chat back at the width it had. A drag stops where the chat column
 * keeps its 480px (and the handle its 10px), never past 640px, so it never overlays.
 */
const CHAT_MIN = 480;
const HANDLE_ROOM = 10;

async function openSession(page: Page, width: number, { labelled = false, title = "Alpha Session" } = {}) {
  await page.setViewportSize({ width, height: 860 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&reviewReady=1&fullShell=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  if (labelled) {
    await page.getByRole("navigation", { name: "Primary Navigation" })
      .getByRole("button", { name: "Expand Navigation", exact: true }).click();
    await expect(page.locator(".app-rail.labelled")).toBeVisible();
  }
  await enterSession(page, title);
}

async function enterSession(page: Page, title: string) {
  await page.getByRole("button", { name: new RegExp(title) }).first().click();
  const open = page.getByRole("button", { name: "Open Session", exact: true });
  if (await open.isVisible()) await open.click();
  await expect(page.locator("header.session-bar")).toBeVisible();
}

const panel = (page: Page) => page.locator("#right-panel");
const headButton = (page: Page, name: string) => panel(page).locator(".rpanel-head").getByRole("button", { name, exact: true });

async function openTool(page: Page, tool: string) {
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  await panel(page).locator(".rpanel-switcher").click();
  await page.getByRole("menuitemradio", { name: tool, exact: true }).click();
  await expect(panel(page).locator(".rpanel-switcher")).toHaveText(tool);
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width } : null;
    };
    const aside = document.querySelector<HTMLElement>("#right-panel");
    return {
      columns: rect(".detail-columns")!,
      body: rect(".detail-body")!,
      bodyVisibility: getComputedStyle(document.querySelector(".detail-body")!).visibility,
      panel: rect("#right-panel")!,
      container: aside ? getComputedStyle(aside).containerName : null,
      bar: rect("header.session-bar")!,
      rail: rect(".app-rail"),
      scrim: rect(".rpanel-scrim"),
      handle: rect(".rpanel-resizer"),
      presentation: aside?.dataset.presentation,
    };
  });
}

/** The expanded panel covers the whole row under the session bar, with the chat hidden under it. */
async function expectExpanded(page: Page, label: string) {
  const at = await measure(page);
  expect(at.presentation, label).toBe("expanded");
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    expect(Math.abs(at.panel[edge] - at.columns[edge]), `${label}: fills the row (${edge})`).toBeLessThanOrEqual(0.5);
  }
  expect(at.panel.top, `${label}: under the session bar`).toBeGreaterThanOrEqual(at.bar.bottom - 0.5);
  if (at.rail) expect(at.panel.left, `${label}: beside the rail`).toBeGreaterThanOrEqual(at.rail.right - 0.5);
  expect(at.bodyVisibility, `${label}: the chat column is hidden`).toBe("hidden");
  expect(at.scrim, `${label}: no scrim`).toBeNull();
  expect(at.handle, `${label}: no handle`).toBeNull();
  expect(at.container, `${label}: still the rp container`).toBe("rp");
  await expect(page.locator(".composer-input")).toBeHidden();
  await expect(headButton(page, "Restore Panel")).toBeVisible();
  await expect(headButton(page, "Expand Panel")).toHaveCount(0);
  return at;
}

test("at 1440px Expand Panel fills the content area, and Restore Panel and Escape each bring the chat back at its width (#2845)", async ({ page }) => {
  await openSession(page, 1440);
  await openTool(page, "Review");
  const docked = await measure(page);
  expect(docked.presentation).toBe("docked");
  expect(docked.bodyVisibility).toBe("visible");

  const expand = headButton(page, "Expand Panel");
  expect(await expand.boundingBox()).toMatchObject({ width: 32, height: 32 });
  await expect(expand).toHaveAttribute("title", "Expand Panel");
  await expand.click();
  await expectExpanded(page, "expanded");
  await expect(page.locator("header.session-bar")).toBeVisible();

  await headButton(page, "Restore Panel").click();
  const restored = await measure(page);
  expect(restored.presentation).toBe("docked");
  expect(restored.panel.width, "Restore: the panel's width").toBe(docked.panel.width);
  expect(restored.body.width, "Restore: the chat's width").toBe(docked.body.width);
  expect(restored.bodyVisibility).toBe("visible");
  await expect(page.locator(".composer-input")).toBeVisible();
  await expect(headButton(page, "Expand Panel")).toBeFocused();

  // Escape restores before it closes.
  await headButton(page, "Expand Panel").click();
  await expectExpanded(page, "expanded again");
  await expect(headButton(page, "Restore Panel")).toBeFocused();
  await page.keyboard.press("Escape");
  const escaped = await measure(page);
  expect(escaped.presentation).toBe("docked");
  expect(escaped.panel.width, "Escape: the panel's width").toBe(docked.panel.width);
  expect(escaped.body.width, "Escape: the chat's width").toBe(docked.body.width);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("the expanded state survives switching tools and sessions, closing the panel and a reload (#2845)", async ({ page }) => {
  await openSession(page, 1440);
  await openTool(page, "Review");
  await headButton(page, "Expand Panel").click();
  await expectExpanded(page, "Review");
  expect(await page.evaluate(() => localStorage.getItem("wollipog.rightpanel.expanded"))).toBe("1");

  await panel(page).locator(".rpanel-switcher").click();
  await page.getByRole("menuitemradio", { name: "Decision History", exact: true }).click();
  await expectExpanded(page, "another tool");

  await headButton(page, "Close Panel").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".composer-input")).toBeVisible();
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  await expectExpanded(page, "reopened");

  await page.reload();
  await enterSession(page, "Alpha Session");
  await expectExpanded(page, "after a reload");

  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await enterSession(page, "No Project Session");
  await expect(page.locator("[data-session-surface-id='session-no-project']")).toBeAttached();
  await expectExpanded(page, "another session");
});

test("no Expand or Restore control renders at 390px, even with Expanded stored (#2845)", async ({ page }) => {
  await openSession(page, 390);
  await page.evaluate(() => localStorage.setItem("wollipog.rightpanel.expanded", "1"));
  await page.reload();
  await enterSession(page, "Alpha Session");
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /^(Expand|Restore) Panel$/ })).toHaveCount(0);
  const at = await measure(page);
  expect(at.presentation).not.toBe("expanded");
  expect(at.panel.width).toBe(390);
});

/** Drags the handle far to the left and returns where it stopped. */
async function dragWide(page: Page) {
  const handle = page.getByRole("separator", { name: "Resize Panel" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 600, box.y + 200, { steps: 12 });
  await expect(panel(page)).toHaveAttribute("data-presentation", "docked");
  await page.mouse.up();
  return handle;
}

test("at 1280px the panel drags to 640px (#2845)", async ({ page }) => {
  await openSession(page, 1280);
  await openTool(page, "Review");
  const handle = await dragWide(page);
  await expect(handle).toHaveAttribute("aria-valuenow", "640");
  await expect(handle).toHaveAttribute("aria-valuemax", "640");
  const at = await measure(page);
  expect(at.presentation).toBe("docked");
  expect(at.panel.width).toBe(640);
  expect(at.body.width).toBeGreaterThanOrEqual(CHAT_MIN);
});

test("at 1100px with the labelled rail a drag stops where the chat keeps 480px, never overlaying, and aria-valuemax is that ceiling (#2845)", async ({ page }) => {
  await openSession(page, 1100, { labelled: true });
  await openTool(page, "Review");
  const before = await measure(page);
  const ceiling = Math.floor(before.columns.width - CHAT_MIN - HANDLE_ROOM);
  const handle = page.getByRole("separator", { name: "Resize Panel" });
  await expect(handle).toHaveAttribute("aria-valuemax", String(ceiling));
  await dragWide(page);
  await expect(handle).toHaveAttribute("aria-valuenow", String(ceiling));
  const at = await measure(page);
  expect(at.presentation).toBe("docked");
  expect(at.panel.width).toBe(ceiling);
  expect(at.body.width, "the chat keeps its 480px").toBeGreaterThanOrEqual(CHAT_MIN);
  expect(at.scrim).toBeNull();
  // The keyboard stops at the same place.
  await handle.focus();
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", String(ceiling));
  await expect(panel(page)).toHaveAttribute("data-presentation", "docked");

  // Expanded, the panel is wide enough for Side by Side's 720px rows (#2848).
  await headButton(page, "Expand Panel").click();
  const expanded = await expectExpanded(page, "1100px expanded");
  expect(expanded.panel.width).toBeGreaterThanOrEqual(720);
  await page.keyboard.press("Escape");
  expect((await measure(page)).panel.width).toBe(ceiling);
});

test("at 834px Expand fills the content area over no scrim, and Restore returns to the overlay (#2845)", async ({ page }) => {
  await openSession(page, 834);
  await openTool(page, "Review");
  const overlaid = await measure(page);
  expect(overlaid.presentation).toBe("overlay");
  expect(overlaid.scrim).not.toBeNull();
  await headButton(page, "Expand Panel").click();
  await expectExpanded(page, "834px expanded");
  await headButton(page, "Restore Panel").click();
  const restored = await measure(page);
  expect(restored.presentation).toBe("overlay");
  expect(restored.scrim).not.toBeNull();
  expect(restored.panel.width).toBe(overlaid.panel.width);
});

test("Show in Transcript restores an expanded panel and scrolls the real transcript to the request (#2845)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/decision-history-session-e2e.html?expanded=1");
  await expect(panel(page)).toHaveAttribute("data-presentation", "expanded");
  const transcriptSummary = page.locator(".detail-scroll summary", { hasText: "Run ./scripts/deploy.sh staging" });
  const historyRow = page.locator('.decision-history details[data-audit-id="audit-early-deploy"]');
  await historyRow.locator("summary").click();
  await historyRow.getByRole("button", { name: "Show in Transcript" }).click();
  await expect(panel(page)).toHaveAttribute("data-presentation", "docked");
  await expect(transcriptSummary).toBeInViewport();
});
