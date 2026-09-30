import { expect, test, type Page } from "@playwright/test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { glyphUnderMark } from "./rail-marks.js";
import { railAttention } from "../src/rail-attention.js";

/** The desktop rail (#1958; docs/design-system.md §4.1, §9.3, §15.3), in the real Shell. */
const shell = (path: string) => `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(path)}`;

async function openShell(page: Page, path = "/inbox") {
  await page.goto(shell(path));
  await expect(page.locator(".app-rail .rail-destinations")).toBeVisible();
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Primary Navigation" });
const tooltip = (page: Page) => page.locator(".rail-tooltip");

test.describe("at 1440×900 with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the rail is 64px with 40px items, 20px glyphs, Search first and two group hairlines", async ({ page }) => {
    await openShell(page);
    const geometry = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const items = [...document.querySelectorAll(".rail-destinations > .rail-item")];
      const settings = document.querySelector(".rail-settings > .rail-item")!;
      return {
        rail: box(document.querySelector(".app-rail")!).width,
        items: items.map((item) => `${box(item).width}x${box(item).height}`),
        glyphs: [...items, settings].map((item) => box(item.querySelector("svg")!).width),
        first: items[0]!.getAttribute("aria-label"),
        separators: [...document.querySelectorAll(".rail-separator")].map((line) => ({
          width: box(line).width,
          height: box(line).height,
          next: line.nextElementSibling?.getAttribute("aria-label"),
          gap: box(line.nextElementSibling!).top - box(line.previousElementSibling!).bottom,
        })),
        // Settings is pinned at the bottom, with only the labelled rail's foot button below it (#1968).
        settingsBottom: box(document.querySelector(".rail-foot")!).top - box(settings).bottom,
        footBottom: box(document.querySelector(".app-rail")!).bottom - box(document.querySelector(".rail-foot")!).bottom,
        filled: [...document.querySelectorAll(".app-rail svg")].filter((svg) => getComputedStyle(svg).fill !== "none").length,
      };
    });
    expect(geometry.rail).toBe(64);
    expect(new Set(geometry.items)).toEqual(new Set(["40x40"]));
    expect(new Set(geometry.glyphs)).toEqual(new Set([20]));
    expect(geometry.first).toBe("Search");
    expect(geometry.separators).toEqual([
      { width: 24, height: 1, next: "Multi-Agent Runs", gap: 13 },
      { width: 24, height: 1, next: "Archived Sessions", gap: 13 },
    ]);
    expect(geometry.settingsBottom, "Settings sits directly above the foot button").toBeLessThanOrEqual(4);
    expect(geometry.footBottom, "which is pinned at the foot of the rail").toBeLessThanOrEqual(8);
    expect(geometry.filled, "no rail glyph is filled").toBe(0);
  });

  test("a hover shows the name and digit after the delay, and the next item's at once", async ({ page }) => {
    await openShell(page);
    await page.locator(".main").hover();
    const automations = rail(page).getByRole("link", { name: "Automations", exact: true });
    await expect(automations).toHaveAttribute("aria-keyshortcuts", "2");
    const started = Date.now();
    await automations.hover();
    await expect(tooltip(page)).toBeHidden();
    await expect(tooltip(page)).toHaveText("Automations2");
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    await expect(tooltip(page).locator("kbd")).toHaveText("2");
    const box = await tooltip(page).boundingBox();
    expect(box!.x, "it opens to the right of the rail").toBeGreaterThanOrEqual(64);

    await rail(page).getByRole("link", { name: "Projects", exact: true }).hover();
    await expect(tooltip(page)).toHaveText("Projects3", { timeout: 200 });

    // The pointer can move onto the tooltip without it closing (WCAG 1.4.13).
    const projectsTip = (await tooltip(page).boundingBox())!;
    await page.mouse.move(projectsTip.x + projectsTip.width / 2, projectsTip.y + projectsTip.height / 2, { steps: 6 });
    await expect(tooltip(page)).toHaveText("Projects3");
    await page.keyboard.press("Escape");
    await expect(tooltip(page)).toBeHidden();
  });

  test("keyboard focus shows the tooltip and a click does not", async ({ page }) => {
    await openShell(page);
    const search = rail(page).getByRole("button", { name: "Search", exact: true });
    await search.focus();
    await page.keyboard.press("Tab");
    const sessions = rail(page).getByRole("link", { name: "Sessions", exact: true });
    await expect(sessions).toBeFocused();
    await expect(tooltip(page)).toHaveText("Sessions1");

    await page.locator(".main").hover();
    await page.locator("#page-title").focus();
    await expect(tooltip(page)).toBeHidden();
    await rail(page).getByRole("link", { name: "Pods", exact: true }).click();
    await page.mouse.move(700, 450);
    await expect(tooltip(page)).toBeHidden();
  });

  test("Search opens the palette and gets focus back when it closes; Ctrl/Cmd+K opens the same palette", async ({ page }) => {
    await openShell(page);
    const search = rail(page).getByRole("button", { name: "Search", exact: true });
    await search.click();
    const palette = page.getByRole("dialog", { name: "Search" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(search).toBeFocused();

    await page.locator("#page-title").focus();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible();
  });

  test("Settings shows the current-page treatment when open", async ({ page }) => {
    await openShell(page, "/settings");
    const settings = rail(page).getByRole("button", { name: "Settings", exact: true });
    await expect(settings).toHaveAttribute("aria-current", "page");
    const look = await settings.evaluate((element) => {
      const style = getComputedStyle(element);
      const bar = getComputedStyle(element, "::before");
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      probe.style.backgroundColor = "var(--surface-selected)";
      document.body.append(probe);
      const expected = getComputedStyle(probe);
      const result = {
        color: style.color === expected.color,
        fill: style.backgroundColor === expected.backgroundColor,
        barWidth: bar.width,
        barColor: bar.backgroundColor === expected.color,
        barLeft: element.getBoundingClientRect().left + Number.parseFloat(bar.left),
      };
      probe.remove();
      return result;
    });
    expect(look).toEqual({ color: true, fill: true, barWidth: "3px", barColor: true, barLeft: 0 });
    await expect(page.locator('.app-rail [aria-current="page"]')).toHaveCount(1);
  });

  test("Connections shows a dot only while a machine needs the user, and says why (#1967)", async ({ page }) => {
    // A session is running on the fixture's one machine.
    await page.goto(`${shell("/projects")}&scenario=conversation-steering`);
    await expect(page.locator(".app-rail .rail-destinations")).toBeVisible();
    const connections = rail(page).getByRole("link", { name: "Connections", exact: true });
    // One machine online on the current protocol is the normal state: nothing to count.
    await expect(connections.locator(".count-badge, .rail-attention-dot")).toHaveCount(0);
    await expect(connections).not.toHaveAttribute("aria-describedby", /./);

    // Offline while its sessions are running: the work is not progressing.
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
    await expect(connections.locator(".rail-attention-dot.t-warning.on-icon")).toHaveCount(1);
    await expect(connections.locator(".count-badge")).toHaveCount(0);
    await expect(connections).toHaveAccessibleName("Connections");
    await expect(connections).toHaveAccessibleDescription("1 machine is offline with active sessions");
    expect(await glyphUnderMark(page, connections), "the dot and its ring cover none of the glyph").toBe(0);
    const dot = await connections.locator(".rail-attention-dot").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const probe = document.createElement("span");
      probe.style.background = "var(--amber)";
      document.body.append(probe);
      const amber = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { size: `${box.width}x${box.height}`, amber: getComputedStyle(element).borderTopColor === amber };
    });
    expect(dot).toEqual({ size: "8x8", amber: true });
    await connections.hover();
    await expect(tooltip(page).locator(".rail-tooltip-note")).toHaveText("1 machine is offline with active sessions");

    // Back online, but on an older protocol: Update Required.
    await page.evaluate((version) => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online");
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version);
    }, PROTOCOL_VERSION - 1);
    await expect(connections).toHaveAccessibleDescription("1 machine needs an update");
    await expect(tooltip(page).locator(".rail-tooltip-note")).toHaveText("1 machine needs an update");

    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION);
    await expect(connections.locator(".rail-attention-dot")).toHaveCount(0);
    await expect(tooltip(page).locator(".rail-tooltip-note")).toHaveCount(0);

    // The longest note railAttention writes, for machines needing the user for both reasons, wraps
    // inside the 280px tooltip instead of painting past it. The fixture has one machine, so the note
    // is set on the item before hovering it, as Rail does.
    const longest = railAttention("runners", {
      blocked: 0,
      stalled: 0,
      machines: { offlineWithActiveSessions: 12, updateRequired: 13 },
    })!.note;
    await page.locator(".main").hover();
    await expect(tooltip(page)).toBeHidden();
    await connections.evaluate((element, note) => element.setAttribute("data-rail-note", note), longest);
    await connections.hover();
    await expect(tooltip(page).locator(".rail-tooltip-note")).toHaveText(longest);
    const fit = await tooltip(page).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const note = element.querySelector(".rail-tooltip-note")!;
      const noteBox = note.getBoundingClientRect();
      return {
        width: box.width,
        overflow: element.scrollWidth > element.clientWidth,
        inside: noteBox.right <= box.right && noteBox.bottom <= box.bottom,
        wrapped: noteBox.height > parseFloat(getComputedStyle(note).lineHeight) * 1.5,
        keysAtEdge: box.right - element.querySelector("kbd")!.getBoundingClientRect().right < 12,
      };
    });
    expect(fit.width).toBeLessThanOrEqual(280);
    expect(fit).toMatchObject({ overflow: false, inside: true, wrapped: true, keysAtEdge: true });
  });

  test("the brand is decoration and Tab skips it", async ({ page }) => {
    await openShell(page);
    const brand = page.locator(".rail-brand");
    await expect(brand).toHaveAttribute("aria-hidden", "true");
    expect(await brand.evaluate((element) => element.tagName)).toBe("DIV");
    await rail(page).focus();
    await page.keyboard.press("Tab");
    await expect(rail(page).getByRole("button", { name: "Search", exact: true })).toBeFocused();
  });
});

/** Each rail control's icon centre, which the labelled rail must not move (#1968). */
async function iconCentres(page: Page) {
  return page.evaluate(() => {
    const centre = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.left + box.width / 2;
    };
    return [
      centre(document.querySelector(".rail-brand")!),
      ...[...document.querySelectorAll(".app-rail .rail-item > svg, .app-rail .rail-item > .rail-icon > svg")].map(centre),
      centre(document.querySelector(".rail-foot > button")!),
    ];
  });
}

test.describe("the labelled rail at 1440×900 (#1968)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const railWidth = (page: Page) => rail(page).evaluate((element) => element.getBoundingClientRect().width);

  test("the foot button widens the rail to 208px without moving an icon, and it survives a reload", async ({ page }) => {
    await openShell(page);
    const before = await iconCentres(page);
    expect(await railWidth(page)).toBe(64);
    await expect(page.locator(".rail-item-label")).toHaveCount(0);

    // The foot button follows Settings in the tab order.
    await rail(page).getByRole("button", { name: "Settings", exact: true }).focus();
    await page.keyboard.press("Tab");
    const expand = rail(page).getByRole("button", { name: "Expand Navigation", exact: true });
    await expect(expand).toBeFocused();
    await page.keyboard.press("Enter");
    const collapse = rail(page).getByRole("button", { name: "Collapse Navigation", exact: true });
    await expect(collapse).toBeFocused();

    expect(await railWidth(page)).toBe(208);
    expect(await iconCentres(page)).toEqual(before);
    const labels = await page.locator(".app-rail .rail-item-label").evaluateAll((elements) => elements.map((element) => ({
      name: element.textContent,
      clipped: element.scrollWidth > element.clientWidth,
    })));
    expect(labels.map((label) => label.name)).toEqual([
      "Search", "Sessions", "Automations", "Projects", "Multi-Agent Runs", "Pods", "Connections", "Agent Skills",
      "Archived Sessions", "Usage and Cost", "Settings",
    ]);
    expect(labels.filter((label) => label.clipped), "every shipped name fits").toEqual([]);
    const separators = await page.locator(".rail-separator").evaluateAll((lines) =>
      lines.map((line) => [line.getBoundingClientRect().left, line.getBoundingClientRect().width]));
    expect(separators, "group hairlines span the rail, less its right edge").toEqual([[0, 207], [0, 207]]);

    await page.reload();
    await expect(page.locator(".app-rail .rail-destinations")).toBeVisible();
    expect(await railWidth(page)).toBe(208);
    await collapse.click();
    expect(await railWidth(page)).toBe(64);
    expect(await iconCentres(page)).toEqual(before);
  });

  test("a hover shows the digit at the trailing edge, not a tooltip, and the attention mark sits inline", async ({ page }) => {
    await openShell(page);
    await rail(page).getByRole("button", { name: "Expand Navigation", exact: true }).click();
    const runs = rail(page).getByRole("link", { name: "Multi-Agent Runs", exact: true });
    await expect(runs.locator(".rail-item-keys")).toBeHidden();
    await runs.hover();
    await expect(runs.locator(".rail-item-keys")).toHaveText("4");
    await page.waitForTimeout(700);
    await expect(tooltip(page), "the labelled rail already shows the name").toBeHidden();
    const hovered = await runs.evaluate((item) => {
      const box = (selector: string) => item.querySelector(selector)!.getBoundingClientRect();
      const label = item.querySelector<HTMLElement>(".rail-item-label")!;
      return {
        keysRightInset: item.getBoundingClientRect().right - box(".rail-item-keys").right,
        separated: box(".rail-item-label").right <= box(".rail-item-keys").left,
        clipped: label.scrollWidth > label.clientWidth,
      };
    });
    expect(hovered).toEqual({ keysRightInset: 8, separated: true, clipped: false });

    // A machine needing an update: Connections' dot follows the name instead of sitting on the icon
    // (#1967).
    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION - 1);
    const connections = rail(page).getByRole("link", { name: "Connections", exact: true });
    await expect(connections.locator(".rail-attention-dot")).toHaveCount(1);
    const marked = await connections.evaluate((item) => {
      const label = item.querySelector(".rail-item-label")!.getBoundingClientRect();
      const dot = item.querySelector(".rail-attention-dot")!;
      const box = dot.getBoundingClientRect();
      const itemBox = item.getBoundingClientRect();
      return {
        after: box.left >= label.right,
        inside: box.right <= itemBox.right,
        centred: Math.abs((box.top + box.height / 2) - (itemBox.top + itemBox.height / 2)) <= 1,
        onIcon: dot.classList.contains("on-icon"),
      };
    });
    expect(marked).toEqual({ after: true, inside: true, centred: true, onIcon: false });
  });

  test("narrowing to a phone while the foot button has focus hands focus to the page heading", async ({ page }) => {
    // The foot button is desktop only, like Search and Settings, so the crossing unmounts it. The
    // shell's breakpoint rescue (App.tsx) catches the dropped focus, as it does for those.
    await openShell(page, "/automations");
    const expand = rail(page).getByRole("button", { name: "Expand Navigation", exact: true });
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(rail(page).getByRole("button", { name: "Collapse Navigation", exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rail(page).locator(".rail-foot")).toHaveCount(0);
    await expect(page.locator("#page-title")).toBeFocused();
  });

  test("Show Labels in Rail and the foot button drive the same preference", async ({ page }) => {
    await openShell(page, "/settings/appearance");
    const row = page.getByRole("switch", { name: /Show Labels in Rail/ });
    await expect(row).toHaveAttribute("aria-checked", "false");
    await row.click();
    await expect(row).toHaveAttribute("aria-checked", "true");
    expect(await railWidth(page)).toBe(208);
    await rail(page).getByRole("button", { name: "Collapse Navigation", exact: true }).click();
    await expect(row).toHaveAttribute("aria-checked", "false");
    expect(await railWidth(page)).toBe(64);
  });
});

test.describe("at 390px with the labelled rail stored on (#1968)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the phone tab bar is unchanged and Settings offers no labels row", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShell(page, "/settings/appearance");
    await page.getByRole("switch", { name: /Show Labels in Rail/ }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator(".app-rail .rail-destinations")).toBeVisible();
    const bar = await rail(page).evaluate((element) => ({
      labelled: element.classList.contains("labelled"),
      width: element.getBoundingClientRect().width,
      tabs: element.querySelectorAll(".rail-tab-label").length,
      names: element.querySelectorAll(".rail-item-label").length,
      foot: element.querySelector(".rail-foot") !== null,
    }));
    expect(bar).toEqual({ labelled: false, width: 390, tabs: 5, names: 0, foot: false });
    await expect(page.getByRole("switch", { name: /Show Labels in Rail/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Move Sessions Down" })).toBeVisible();
  });
});

test.describe("on an 834px coarse-pointer tablet", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });

  test("items are 48px, a tap never shows a tooltip, and no hover fill stays behind", async ({ page }) => {
    await openShell(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const sizes = await page.locator(".rail-destinations > .rail-item").evaluateAll((items) =>
      [...new Set(items.map((item) => `${item.getBoundingClientRect().width}x${item.getBoundingClientRect().height}`))]);
    expect(sizes).toEqual(["48x48"]);

    const pods = rail(page).getByRole("link", { name: "Pods", exact: true });
    await pods.tap();
    await expect(page.getByRole("heading", { level: 1, name: "Pods" })).toBeVisible();
    await page.waitForTimeout(700);
    await expect(tooltip(page)).toBeHidden();
    const automations = rail(page).getByRole("link", { name: "Automations", exact: true });
    await automations.tap();
    await expect(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible();
    // Pods was tapped and left: its fill must be the rest fill, not the hover one.
    expect(await pods.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  });
});
