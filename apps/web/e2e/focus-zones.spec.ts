import { expect, test, type Page } from "@playwright/test";

/**
 * F6 zones on every route (docs/design-system.md §16.1, #1946): F6 reaches the page, the rail lands
 * on the current destination, and only F6 draws the brief top-edge zone line.
 */
const HARNESS = "/command-inbox-projects-e2e.html?fullShell=1";
const shell = (path: string) => `${HARNESS}&path=${encodeURIComponent(path)}`;

const activeZone = (page: Page) => page.evaluate(() =>
  document.activeElement?.closest<HTMLElement>("[data-focus-zone]")?.dataset.focusZone ?? null);

async function openShell(page: Page, url: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await expect(page.locator(".app-rail")).toBeVisible();
  await expect(page.locator(".main-body[data-focus-zone='main']")).toBeVisible();
}

const ROUTES = [
  { name: "Sessions", url: shell("/inbox"), current: /^Sessions/, list: true },
  { name: "Automations", url: shell("/automations"), current: /^Automations/, list: false },
  { name: "Projects", url: shell("/projects"), current: /^Projects/, list: true },
  { name: "Multi-Agent Runs", url: shell("/runs"), current: /^Multi-Agent/, list: false },
  { name: "Pods", url: shell("/pods"), current: /Pods/, list: false },
  { name: "Connections", url: shell("/connections"), current: /^Connections/, list: false },
  { name: "Agent Skills", url: shell("/skills"), current: /Skills/, list: true },
  { name: "Archived Sessions", url: shell("/archived"), current: /^Archived/, list: false },
  { name: "Usage and Cost", url: shell("/usage"), current: /^Usage/, list: false },
  { name: "Settings", url: shell("/settings"), current: /^Settings$/, list: false },
  { name: "a run detail", url: `${HARNESS}&view=run`, current: /^Multi-Agent/, list: false },
  { name: "a pod detail", url: `${HARNESS}&view=pod`, current: /Pods/, list: false },
] as const;

for (const route of ROUTES) {
  test(`F6 reaches the page on ${route.name}, and Shift+F6 returns to the rail`, async ({ page }) => {
    await openShell(page, route.url);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await page.keyboard.press("F6");
    const current = page.locator('.app-rail [aria-current="page"]');
    await expect(current).toBeFocused();
    await expect(current).toHaveAccessibleName(route.current);
    await expect(page.locator(".rail-brand")).not.toBeFocused();

    await page.keyboard.press("F6");
    if (route.list) {
      await expect.poll(() => activeZone(page)).toBe("list");
      await page.keyboard.press("F6");
    }
    await expect.poll(() => activeZone(page)).toBe("main");
    await page.keyboard.press("F6");
    await expect(current).toBeFocused();

    await page.keyboard.press("Shift+F6");
    await expect.poll(() => activeZone(page)).toBe("main");
    await page.keyboard.press("Shift+F6");
    if (route.list) {
      await expect.poll(() => activeZone(page)).toBe("list");
      await page.keyboard.press("Shift+F6");
    }
    await expect(current).toBeFocused();
  });
}

test("Agent Skills and Projects land on their pane roots with no ring", async ({ page }) => {
  for (const [path, list, detail] of [
    ["/skills", ".skills-list", ".skills-detail"],
    ["/projects", ".project-manager-list", ".project-manager-detail"],
  ] as const) {
    await openShell(page, shell(path));
    await page.keyboard.press("F6");
    await page.keyboard.press("F6");
    await expect(page.locator(list)).toBeFocused();
    expect(await page.locator(list).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
    await page.keyboard.press("F6");
    await expect(page.locator(detail)).toBeFocused();
    expect(await page.locator(detail).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  }
});

/** The lit zone and where its line is drawn, relative to the zone root's own box. */
const zoneLine = (page: Page) => page.evaluate(() => {
  const lit = [...document.querySelectorAll<HTMLElement>(".zone-lit")];
  if (lit.length !== 1) return { count: lit.length };
  const root = lit[0]!;
  const line = getComputedStyle(root, "::after");
  const box = root.getBoundingClientRect();
  return {
    count: 1,
    className: root.className,
    position: line.position,
    top: Number.parseFloat(line.top) - box.top,
    left: Number.parseFloat(line.left) - box.left,
    width: Number.parseFloat(line.width) - box.width,
    height: line.height,
    background: line.backgroundColor,
    animation: line.animationName,
  };
});

for (const theme of ["dark", "light"] as const) {
  test(`F6 draws a 2px --focus line on the entered zone's top edge that is gone after 1.5s (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await openShell(page, shell("/skills"));
    await page.keyboard.press("F6");
    await page.keyboard.press("F6");
    await page.keyboard.press("F6");
    await expect(page.locator(".skills-detail")).toBeFocused();
    const line = await zoneLine(page);
    expect(line.count).toBe(1);
    expect(line.className).toContain("skills-detail");
    expect(line).toMatchObject({ position: "fixed", top: 0, left: 0, width: 0, height: "2px", animation: "zone-line-fade" });
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    expect(line.background).not.toBe(accent);
    await expect.poll(() => zoneLine(page).then((value) => value.count), { timeout: 3_000 }).toBe(0);
  });
}

test("the zone line has no fade under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openShell(page, shell("/automations"));
  await page.keyboard.press("F6");
  await page.keyboard.press("F6");
  const line = await zoneLine(page);
  expect(line).toMatchObject({ count: 1, animation: "none", top: 0 });
  await expect.poll(() => zoneLine(page).then((value) => value.count), { timeout: 3_000 }).toBe(0);
});

test("the zone line stays on the visible top edge of a scrolled page", async ({ page }) => {
  await openShell(page, shell("/settings"));
  await page.locator(".main-body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.keyboard.press("F6");
  await page.keyboard.press("F6");
  await expect(page.locator(".main-body")).toBeFocused();
  const line = await zoneLine(page);
  expect(line).toMatchObject({ count: 1, top: 0 });
});

test("no zone line after a click, a digit, a route change or opening a session", async ({ page }) => {
  await openShell(page, shell("/inbox"));
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await expect(grid).toBeVisible();

  await grid.click();
  expect((await zoneLine(page)).count).toBe(0);
  await page.locator(".inbox-preview-pane").click({ position: { x: 200, y: 200 } });
  expect((await zoneLine(page)).count).toBe(0);

  await page.getByRole("link", { name: /^Projects/ }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  expect((await zoneLine(page)).count).toBe(0);
  await page.keyboard.press("1");
  await expect(grid).toBeFocused();
  expect((await zoneLine(page)).count).toBe(0);

  await grid.press("Enter");
  await expect(page.getByRole("region", { name: "Session Activity" })).toBeVisible();
  expect((await zoneLine(page)).count).toBe(0);

  // F6 lights the zone, and a click puts it out at once rather than after 1.5s.
  await page.keyboard.press("F6");
  await page.keyboard.press("F6");
  expect((await zoneLine(page)).count).toBe(1);
  await page.locator(".detail-scroll").click({ position: { x: 20, y: 20 } });
  expect((await zoneLine(page)).count).toBe(0);
});

/** Everything drawn around a pane on focus: its outline and any ::before/::after frame. */
const paneFrame = (page: Page, selector: string) => page.locator(selector).evaluate((pane) => {
  const frames = [pane, ...pane.querySelectorAll<HTMLElement>(".detail-scroll, .inbox-list")].flatMap((element) =>
    ["::before", "::after"].map((pseudo) => getComputedStyle(element, pseudo))
      .filter((style) => style.content !== "none" && style.content !== "normal" && parseFloat(style.borderTopWidth) > 0)
      .map((style) => style.borderTopColor));
  const outlines = [pane, ...pane.querySelectorAll<HTMLElement>(".detail-scroll, .inbox-list")]
    .map((element) => getComputedStyle(element).outlineStyle)
    .filter((style) => style !== "none");
  return { frames, outlines };
});

test("opening a session from the keyboard leaves no ring or frame on the reading pane", async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(shell("/inbox"));
    const grid = page.getByRole("grid", { name: "Sessions", exact: true });
    await expect(grid).toBeVisible();
    if (width > 760) {
      await grid.focus();
      await page.keyboard.press("ArrowDown");
      // A keyboard-focused list draws no pane frame either: the selected row is its cue.
      expect(await paneFrame(page, ".inbox-list-pane")).toEqual({ frames: [], outlines: [] });
      await grid.press("Enter");
    } else {
      // Phones have no grid keys; the keyboard opens a session through the row's own button.
      await grid.getByRole("button").first().focus();
      await page.keyboard.press("Enter");
    }
    await expect(page.locator(".detail-scroll")).toBeVisible();
    await expect(page.locator(".detail-scroll")).toBeFocused();
    expect(await paneFrame(page, ".inbox-preview-pane")).toEqual({ frames: [], outlines: [] });
    expect((await zoneLine(page)).count).toBe(0);
  }
});

test("Escape from an open session returns to its row, and Escape closes only the top layer", async ({ page }) => {
  await openShell(page, shell("/inbox"));
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  const row = await grid.getAttribute("aria-activedescendant");
  expect(row).toBeTruthy();
  await grid.press("Enter");
  await expect(page.getByRole("region", { name: "Session Activity" })).toBeVisible();

  // A menu over the open session consumes its own Escape and hands focus back to its trigger.
  const trigger = page.getByRole("button", { name: "More Actions", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("region", { name: "Session Activity" })).toBeVisible();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Session Activity" })).toHaveCount(0);
  await expect(grid).toBeFocused();
  await expect(grid).toHaveAttribute("aria-activedescendant", row!);
});
