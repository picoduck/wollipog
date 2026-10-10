import { expect, test, type Page } from "@playwright/test";

/**
 * The side panel's frame (#2843; docs/design-system.md §4.9): a docked, flush column with a 48px
 * header (tool switcher, action slot, Close Panel), a resize handle on its edge, and on phones a
 * full-screen sheet that covers the session bar with one bar and Back to Session.
 */
async function openSession(page: Page, width: number, height = 860) {
  await page.setViewportSize({ width, height });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&reviewReady=1&fullShell=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-input")).toBeAttached();
}

const panel = (page: Page) => page.locator("#right-panel");

test.describe("on a desktop", () => {
  test("the header is 48px with 32px icon buttons, the aside is the Side Panel, and nothing reads Panel (#2843)", async ({ page }) => {
    await openSession(page, 1440);
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Side Panel", exact: true })).toBeVisible();
    const head = panel(page).locator(".rpanel-head");
    expect((await head.boundingBox())!.height).toBe(48);
    const close = head.getByRole("button", { name: "Close Panel" });
    expect(await close.boundingBox()).toMatchObject({ width: 32, height: 32 });
    await expect(head.locator(".rpanel-switcher")).toHaveText("Session Tools");
    await expect(panel(page).getByText("Panel", { exact: true })).toHaveCount(0);

    // Docked and flush: no margin or radius, one hairline on the leading edge.
    const frame = await panel(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        margin: style.margin, radius: style.borderRadius, left: style.borderLeftWidth,
        top: style.borderTopWidth, right: style.borderRightWidth, bottom: style.borderBottomWidth,
        width: element.getBoundingClientRect().width,
      };
    });
    expect(frame).toEqual({ margin: "0px", radius: "0px", left: "1px", top: "0px", right: "0px", bottom: "0px", width: 400 });
    const bar = (await page.locator("header.session-bar").boundingBox())!;
    const box = (await panel(page).boundingBox())!;
    expect(box.y).toBeCloseTo(bar.y + bar.height, 0);
  });

  test("the switcher lists the groups in order and switches tools; Escape closes its menu first, then the panel (#2843)", async ({ page }) => {
    await openSession(page, 1440);
    const composer = page.locator(".composer-input");
    await composer.focus();
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    const switcher = panel(page).locator(".rpanel-switcher");
    await switcher.click();
    const menu = page.getByRole("menu", { name: "Switch Tool" });
    await expect(menu.locator(".menu-label")).toHaveText(["Code", "Work", "Decisions"]);
    await expect(menu.getByRole("menuitemradio", { name: "Session Tools" })).toHaveAttribute("aria-checked", "true");
    await menu.getByRole("menuitemradio", { name: "Decision History" }).click();
    await expect(switcher).toHaveText("Decision History");
    await expect(switcher).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: "Decision History" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
  });

  test("the Side Panel chord toggles the panel and reopens the last tool (#2843)", async ({ page }) => {
    await openSession(page, 1440);
    const reader = page.locator(".detail-scroll");
    await reader.focus();
    await page.keyboard.press("Control+\\");
    await expect(panel(page)).toBeVisible();
    // The chord lands on the switcher, so the arrow keys reach every tool.
    const switcher = panel(page).locator(".rpanel-switcher");
    await expect(switcher).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "Session Tools" })).toBeFocused();
    for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "Browser" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(switcher).toHaveText("Browser");
    // Pressed again from inside the panel, it closes it and focus goes back where it was.
    await expect(switcher).toBeFocused();
    await page.keyboard.press("Control+\\");
    await expect(panel(page)).toHaveCount(0);
    await expect(reader).toBeFocused();
    await page.keyboard.press("Control+\\");
    await expect(panel(page).locator(".rpanel-switcher")).toHaveText("Browser");
    await expect(page.getByRole("button", { name: "Side Panel", exact: true }))
      .toHaveAttribute("title", "Side Panel (Ctrl+\\)");
  });

  test("the resize handle shows a line on hover and focus, the width while dragging, and resizes from the keyboard (#2843)", async ({ page }) => {
    await openSession(page, 1440);
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    const handle = page.getByRole("separator", { name: "Resize Panel" });
    const line = () => handle.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
    expect(await line()).toBe("rgba(0, 0, 0, 0)");
    const box = (await handle.boundingBox())!;
    expect(box.width).toBe(8);
    const edge = (await panel(page).boundingBox())!.x;
    expect(box.x + box.width / 2).toBeCloseTo(edge, 0);
    await page.mouse.move(box.x + 4, box.y + 200);
    await expect.poll(line).not.toBe("rgba(0, 0, 0, 0)");
    await expect(handle).not.toHaveAttribute("title");

    await page.mouse.down();
    await page.mouse.move(box.x - 36, box.y + 200, { steps: 4 });
    await expect(handle.locator(".rpanel-resize-tip")).toHaveText("440px");
    await page.mouse.up();
    await expect(handle.locator(".rpanel-resize-tip")).toHaveCount(0);
    await expect(handle).toHaveAttribute("aria-valuenow", "440");

    await page.mouse.move(10, 10);
    await expect.poll(line).toBe("rgba(0, 0, 0, 0)");
    // A key press first, so the browser treats the focus that follows as keyboard focus.
    await page.keyboard.press("Shift");
    await handle.focus();
    await expect.poll(line).not.toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "424");
    await page.keyboard.press("End");
    await expect(handle).toHaveAttribute("aria-valuenow", "320");
  });
});

test.describe("on a phone with a coarse pointer", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("one 48px bar covers the session bar, starts with Back to Session, has no Close, and the composer leaves (#2843)", async ({ page }) => {
    await openSession(page, 390, 844);
    // Mark the composer, to show it is the same one, with its private state, after Back.
    await page.locator(".composer").evaluate((element) => { element.dataset.evidenceMark = "kept"; });
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    await expect(panel(page)).toBeVisible();
    // The session's app bar is not rendered, and the composer has no box and leaves the
    // accessibility tree; it stays mounted so Answer Mode's secret answers survive (#2843).
    await expect(page.locator("header.topbar")).toHaveCount(0);
    await expect(page.locator(".composer")).toBeHidden();
    const head = panel(page).locator(".rpanel-head");
    const bar = (await head.boundingBox())!;
    expect(bar.y).toBe(0);
    expect(bar.height).toBe(48);
    const buttons = head.locator("button");
    await expect(buttons.first()).toHaveAccessibleName("Back to Session");
    await expect(head.getByRole("button", { name: "Close Panel" })).toHaveCount(0);
    for (const button of await head.locator(".icon-btn").all()) {
      expect(await button.boundingBox()).toMatchObject({ width: 44, height: 44 });
    }
    // The panel's bar is the only bar on screen: everything from the top edge down is the panel.
    const covered = await page.evaluate(() => [4, 24, 47, 60].flatMap((y) => [8, 195, 382]
      .map((x) => Boolean(document.elementFromPoint(x, y)?.closest("#right-panel")))));
    expect(covered.every(Boolean)).toBe(true);

    await head.getByRole("button", { name: "Back to Session" }).tap();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator("header.topbar")).toBeVisible();
    await expect(page.locator(".detail-scroll")).toBeFocused();
    await expect(page.locator(".composer")).toBeVisible();
    await expect(page.locator(".composer")).toHaveAttribute("data-evidence-mark", "kept");
  });

  test("a focused field in the panel takes the tab bar's place, so the sheet reaches the keyboard (#2843)", async ({ page }) => {
    await openSession(page, 390, 844);
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    await panel(page).locator(".rpanel-switcher").tap();
    await page.getByRole("menuitemradio", { name: "Browser" }).tap();
    const rail = page.locator(".app-rail");
    const railTop = (await rail.boundingBox())!.y;
    expect(Math.round((await panel(page).boundingBox())!.y + (await panel(page).boundingBox())!.height)).toBe(Math.round(railTop));
    await panel(page).getByRole("radio", { name: "Web URL" }).tap();
    await panel(page).getByLabel("Web Preview URL").focus();
    await expect(rail).toBeHidden();
    const bottom = async () => {
      const box = (await panel(page).boundingBox())!;
      return Math.round(box.y + box.height);
    };
    expect(await bottom()).toBe(844);
    // Where the keyboard covers the layout viewport, the sheet ends at its top edge.
    await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-inset", "300px"));
    expect(await bottom()).toBe(544);
  });

  test("what the sheet covers is inert: Tab stays in the sheet and the tab bar, and Back restores it (#2888)", async ({ page }) => {
    await openSession(page, 390, 844);
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    await expect(panel(page)).toBeVisible();
    // Focusable, rendered controls outside the sheet and the tab bar.
    const outside = () => page.evaluate(() => {
      const sheet = document.querySelector("#right-panel")!;
      return [...document.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, [tabindex]")]
        .filter((element) => element.tabIndex >= 0 && !sheet.contains(element) && !element.closest(".app-rail") &&
          element.getClientRects().length > 0 && !element.closest("[inert]"))
        .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName);
    });
    expect(await outside()).toEqual([]);
    await expect(page.locator("header.session-bar")).toHaveAttribute("inert", "");
    await expect(page.locator(".detail-body")).toHaveAttribute("inert", "");
    // Nothing covered is in the browser's accessibility tree. Playwright's role locators do not model
    // `inert`, so this reads Chromium's own tree.
    const exposedButtons = async () => {
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = await cdp.send("Accessibility.getFullAXTree") as {
        nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[];
      };
      await cdp.detach();
      return nodes.filter((node) => !node.ignored && node.role?.value === "button").map((node) => node.name?.value ?? "");
    };
    const exposedWhileOpen = await exposedButtons();
    expect(exposedWhileOpen.filter((name) => /^Session Status|^Share$|^More Actions$|^Browse Files$/.test(name))).toEqual([]);
    expect(exposedWhileOpen).toContain("Back to Session");

    // Shift+Tab and Tab from the sheet land only in the sheet or the tab bar.
    const switcher = panel(page).locator(".rpanel-switcher");
    for (const key of ["Shift+Tab", "Tab"]) {
      await switcher.focus();
      for (let step = 0; step < 4; step += 1) {
        await page.keyboard.press(key);
        const where = await page.evaluate(() => {
          const active = document.activeElement;
          return active?.closest("#right-panel") ? "sheet" : active?.closest(".app-rail") ? "tab bar" : active === document.body ? "body" : "covered";
        });
        expect(where, `${key} ×${step + 1}`).not.toBe("covered");
      }
    }

    await panel(page).getByRole("button", { name: "Back to Session" }).tap();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator("header.session-bar")).not.toHaveAttribute("inert");
    await expect(page.locator(".detail-body")).not.toHaveAttribute("inert");
    await expect(page.getByRole("button", { name: /^Session Status/ })).toBeVisible();
    await expect(page.locator(".detail-scroll")).toBeFocused();
    expect((await exposedButtons()).filter((name) => /^Session Status|^Share$/.test(name))).toHaveLength(2);
  });
});

test("in a 400px desktop panel a finding row is single-column, and in a wide one it is not (#2843)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/review-anchor-reload-e2e.html?theme=dark&stored=0");
  const row = page.locator(".review-finding-row").first();
  await expect(row).toBeVisible();
  const columns = () => row.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  const wide = await columns();
  expect(wide).toBeGreaterThan(2);
  await page.locator("section.rpanel").evaluate((element) => { (element as HTMLElement).style.width = "400px"; });
  await expect.poll(columns).toBe(2);
  const actions = (await row.locator(".review-finding-row-actions").boundingBox())!;
  const body = (await row.locator(":scope > :nth-child(2)").boundingBox())!;
  expect(actions.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
});
