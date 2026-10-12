import { expect, test, type Page } from "@playwright/test";
import { approvalsPolicyView, SETTINGS_SECTIONS, viewPath } from "../src/navigation.js";

const PAGE = "/settings-navigation-e2e.html";

test("Shift+, is discoverable and returns from Settings after nested layers and editors", async ({ page }) => {
  await page.goto(PAGE);
  const shortcutLabel = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "⇧," : "Shift+,");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  // The rail tooltip names it and its shortcut; there is no second, delayed browser title.
  await expect(settings).toHaveAttribute("data-rail-tip", "Settings");
  await expect(settings).toHaveAttribute("data-rail-keys", shortcutLabel);
  await expect(settings).not.toHaveAttribute("title", /.*/);
  await expect(settings).toHaveAccessibleDescription(`Open Settings. Keyboard shortcut: ${shortcutLabel}`);

  await page.keyboard.press("Shift+Comma");
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");

  const editor = page.getByRole("textbox", { name: "Settings Search" });
  await editor.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");
  await expect(editor).not.toBeFocused();

  await page.getByRole("button", { name: "Theme: System" }).click();
  const themeList = page.getByRole("listbox", { name: "Theme" });
  await expect(themeList).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(themeList).toBeHidden();
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");

  await page.getByRole("button", { name: "Open Keyboard Shortcuts" }).click();
  const reference = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(reference).toBeVisible();
  const settingsRow = reference.locator(".shortcut-row").filter({ hasText: "Open Settings" });
  await expect(settingsRow.locator("kbd")).toHaveText(shortcutLabel);
  await page.keyboard.press("Escape");
  await expect(reference).toBeHidden();
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-label")).toHaveText("Inbox");
});

test("Settings preserves exact Session, Project, and Usage origins across section changes", async ({ page }) => {
  await page.goto(PAGE);
  const scenarios = [
    ["Open Session Origin", "Session: session-alpha"],
    ["Open Project Origin", "Project: project-alpha"],
    ["Open Usage Origin", "Usage"],
  ] as const;

  for (const [button, origin] of scenarios) {
    await page.getByRole("button", { name: button }).click();
    await expect(page.getByTestId("view-label")).toHaveText(origin);
    await page.keyboard.press("Shift+Comma");
    await page.getByRole("button", { name: "Open Network Section" }).click();
    await expect(page.getByTestId("view-label")).toHaveText("Settings: network");
    await page.keyboard.press("Shift+Comma");
    await expect(page.getByTestId("view-label")).toHaveText("Settings: network");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("view-label")).toHaveText(origin);
  }
});

test("typing and IME own Shift+, before global Settings navigation", async ({ page }) => {
  await page.goto(PAGE);
  const editor = page.getByRole("textbox", { name: "Origin Editor" });
  await editor.focus();
  await page.keyboard.press("Shift+Comma");
  await expect(page.getByTestId("view-label")).toHaveText("Inbox");

  await editor.blur();
  await page.evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "<",
      shiftKey: true,
      isComposing: true,
      bubbles: true,
    }));
  });
  await expect(page.getByTestId("view-label")).toHaveText("Inbox");

  await page.keyboard.press("Shift+Comma");
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");
});

test("direct Settings entry falls back to Inbox and Escape return remains a browser-history push", async ({ page }) => {
  await page.goto(`${PAGE}?entry=settings`);
  await expect(page.getByTestId("view-label")).toHaveText("Settings: keyboard");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-label")).toHaveText("Inbox");

  await page.goBack();
  await expect(page.getByTestId("view-label")).toHaveText("Settings: keyboard");
});

/**
 * The Settings frame at each width (#3018), on the settings-rows harness: the production panels
 * under real routes, where a link or Back pushes the next route as the shell does.
 */
const FRAME = "/settings-rows-e2e.html";
const frame = (route: string, theme: "dark" | "light" = "dark") => `${FRAME}?theme=${theme}&route=${encodeURIComponent(route)}`;

/** A token's computed colour, read through a probe so it compares with computed backgrounds. */
async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.querySelector(".main-body")!.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, token);
}

for (const theme of ["dark", "light"] as const) {
  test(`at 1440px the current section is selected, never mistaken for a hovered one, in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(frame("/settings/behavior", theme));
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const nav = page.getByRole("navigation", { name: "Settings Sections" });
    const current = nav.locator('a[aria-current="page"]');
    await expect(current).toHaveText("Behavior");
    await expect(nav.locator("a")).toHaveCount(SETTINGS_SECTIONS.length);
    // Hover another item, so the comparison is against a real hover fill rather than a rest state.
    const hovered = nav.getByRole("link", { name: "Notifications" });
    await hovered.hover();
    const [selectedFill, hoverFill] = [await tokenColour(page, "--surface-selected"), await tokenColour(page, "--bg-elev-2")];
    expect(selectedFill, "the two tokens are different colours in this theme").not.toBe(hoverFill);
    await expect.poll(() => hovered.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(hoverFill);
    const selected = await current.evaluate((element) => {
      const bar = getComputedStyle(element, "::before");
      return {
        background: getComputedStyle(element).backgroundColor,
        barWidth: bar.width,
        barColour: bar.backgroundColor,
        barHeight: Number.parseFloat(bar.height),
        icon: getComputedStyle(element.querySelector(".row-icon")!).color,
      };
    });
    expect(selected.background, "the --surface-selected fill").toBe(selectedFill);
    expect(selected.background, "and not the hover fill").not.toBe(hoverFill);
    expect(selected.barWidth, "a 2px accent bar on the leading edge").toBe("2px");
    expect(selected.barHeight).toBeGreaterThan(0);
    const accent = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    });
    expect(selected.barColour).toBe(accent);
    expect(selected.icon, "the current section's glyph is in --accent").toBe(accent);
    expect(await hovered.evaluate((element) => getComputedStyle(element, "::before").content),
      "a hovered item has no bar").toBe("none");
    // Hovering the current item keeps it selected.
    await current.hover();
    await expect.poll(() => current.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(selectedFill);
  });
}

test("in forced colors the current section keeps a visible bar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto(frame("/settings/behavior"));
  const current = page.getByRole("navigation", { name: "Settings Sections" }).locator('a[aria-current="page"]');
  await expect(current).toHaveText("Behavior");
  const paint = await current.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.background = "Canvas";
    document.body.append(probe);
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const bar = getComputedStyle(element, "::before");
    return { canvas, bar: bar.backgroundColor, width: bar.width };
  });
  expect(paint.width, "wider than the 2px bar, as the Sessions list's is").toBe("4px");
  expect(paint.bar, "the bar is not the page colour, so it is seen").not.toBe(paint.canvas);
  expect(paint.bar).not.toBe("rgba(0, 0, 0, 0)");
});

test("at 1440px the section nav stays in view after Behavior scrolls 600px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto(`${frame("/settings/behavior")}&defaults=agent`);
  const scroller = page.locator(".main-body");
  const nav = page.getByRole("navigation", { name: "Settings Sections" });
  await expect(nav.locator('a[aria-current="page"]')).toHaveText("Behavior");
  // Behavior's agent defaults, open, make it tall enough to scroll 600px in a 600px window.
  await page.getByRole("button", { name: /^Default Models, Efforts, and Permissions/ }).click();
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(600);
  const scrolled = await scroller.evaluate((element) => {
    element.scrollTop = 600;
    return element.scrollTop;
  });
  expect(scrolled, "Behavior is tall enough to scroll 600px here").toBe(600);
  await expect.poll(() => nav.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeGreaterThanOrEqual(0);
  const top = await nav.evaluate((element) => element.getBoundingClientRect().top);
  expect(top, "the nav's top edge is inside the viewport").toBeLessThan(600);
  await expect(nav.locator('a[aria-current="page"]')).toBeInViewport();
});

test("at 900px the sections are link tabs in the page header, with About's tab in view", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(frame("/settings/about"));
  await expect(page.locator(".settings-nav")).toHaveCount(0);
  const tabs = page.locator(".page-header .page-tabs").getByRole("navigation", { name: "Settings Sections" });
  await expect(tabs.locator("a.tab")).toHaveText(SETTINGS_SECTIONS.map((section) => section.title));
  await expect(page.getByRole("tablist")).toHaveCount(0);
  const current = tabs.locator('a[aria-current="page"]');
  await expect(current).toHaveText("About");
  const [row, tab] = await Promise.all([tabs.boundingBox(), current.boundingBox()]);
  expect(tab!.x, "About's tab starts inside the row").toBeGreaterThanOrEqual(row!.x);
  expect(tab!.x + tab!.width, "and ends inside it").toBeLessThanOrEqual(row!.x + row!.width + 0.5);
  // The tab names the section, so the panel does not repeat it.
  await expect(page.locator("#settings-panel-heading")).toBeHidden();
  await expect(page.getByRole("heading", { name: "About", exact: true })).toHaveCount(0);
  await expect(page.locator(".settings-panel-desc")).toBeVisible();
  // A tab is a link: following one changes the route.
  await tabs.getByRole("link", { name: "Network" }).click();
  await expect(current).toHaveText("Network");
  expect(new URL(page.url()).searchParams.get("route")).toBe("/settings/network");
});

for (const width of [1440, 900]) {
  test(`at ${width}px /settings opens Appearance under the Settings header`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(frame("/settings"));
    await expect(page.locator("#page-title")).toHaveText("Settings");
    await expect(page.locator(".page-desc")).toHaveText("Preferences for this device and your account.");
    await expect(page.locator(".page-desc")).toBeVisible();
    await expect(page.locator('[aria-current="page"]')).toHaveText("Appearance");
    await expect(page.locator(".settings-panel .settings-panel-scope")).toHaveText("This Device");
    await expect(page.locator(".settings-index")).toHaveCount(0);
  });
}

test.describe("at 390px", () => {
  // Short enough that the index scrolls, so Back has a position to restore.
  test.use({ viewport: { width: 390, height: 480 } });

  test("/settings is the section index, and Approvals opens with Back to it where it was", async ({ page }) => {
    await page.goto(frame("/settings"));
    await expect(page.locator("#page-title")).toHaveText("Settings");
    await expect(page.locator(".page-desc"), "a phone hides page descriptions").toBeHidden();
    const index = page.getByRole("navigation", { name: "Settings Sections" });
    const rows = index.locator("a.row");
    await expect(rows).toHaveCount(SETTINGS_SECTIONS.length);
    for (const [position, section] of SETTINGS_SECTIONS.entries()) {
      const row = rows.nth(position);
      await expect(row.locator(".row-title")).toHaveText(section.title);
      await expect(row.locator(".row-sub")).toHaveText(section.description);
      await expect(row.locator(".row-icon svg")).toHaveCount(1);
      await expect(row.locator(".settings-index-chevron svg")).toHaveCount(1);
      const box = await row.boundingBox();
      const [title, sub] = [await row.locator(".row-title").boundingBox(), await row.locator(".row-sub").boundingBox()];
      expect(sub!.y, `${section.title}: two lines, the description under the title`).toBeGreaterThanOrEqual(title!.y + title!.height - 0.5);
      expect(box!.height).toBeGreaterThan(title!.height + sub!.height);
      expect(await row.locator(".row-sub").evaluate((element) => element.scrollWidth <= element.clientWidth),
        `${section.title}: the description fits its one line`).toBe(true);
    }
    await expect(index.locator('[aria-current], .is-selected')).toHaveCount(0);
    const fills = await rows.evaluateAll((elements) => [...new Set(elements.map((element) => getComputedStyle(element).backgroundColor))]);
    expect(fills, "no row looks selected").toHaveLength(1);

    const scroller = page.locator(".main-body");
    const before = await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(before, "the index scrolls at this height").toBeGreaterThan(0);
    await index.getByRole("link", { name: /^Approvals/ }).click();
    expect(new URL(page.url()).searchParams.get("route")).toBe("/settings/approvals");
    const bar = page.locator(".detail-bar");
    await expect(bar.locator("#page-title")).toHaveText("Approvals");
    expect((await bar.boundingBox())!.height, "the 48px detail bar").toBe(48);
    await expect(page.locator(".settings-index")).toHaveCount(0);
    expect(await scroller.evaluate((element) => element.scrollTop), "a section opens at its top").toBe(0);
    await expect(page.locator(".settings-panel h3").first()).toBeVisible();

    await page.getByRole("button", { name: "Back to Settings" }).click();
    expect(new URL(page.url()).searchParams.get("route")).toBe("/settings");
    await expect(index.locator("a.row")).toHaveCount(SETTINGS_SECTIONS.length);
    expect(await scroller.evaluate((element) => element.scrollTop), "Back returns to where the index was").toBe(before);
    await expect(index.locator('[aria-current], .is-selected')).toHaveCount(0);
  });

  test("a policy link opens Approvals directly, with Back to the index", async ({ page }) => {
    await page.goto(frame(viewPath(approvalsPolicyView("builtin:session-spawn-human-gate"))));
    await expect(page.locator(".detail-bar #page-title")).toHaveText("Approvals");
    await expect(page.getByText("Review Agent-Created Sessions").first()).toBeVisible();
    await page.getByRole("button", { name: "Back to Settings" }).click();
    await expect(page.getByRole("navigation", { name: "Settings Sections" }).locator("a.row")).toHaveCount(SETTINGS_SECTIONS.length);
  });
});
