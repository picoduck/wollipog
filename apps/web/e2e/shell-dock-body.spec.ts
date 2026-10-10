import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The terminal dock's body (#2865; docs/design-system.md §2.5, §2.8, §4.6, §13.2): a flush terminal in
 * a 220px dock with a visible grip, one notice above it, a status row under an exited shell, the pipe
 * row, the empty dock, and one mounted terminal per shell.
 */

async function openDock(page: Page, query = ""): Promise<Locator> {
  const response = await page.goto(`/shell-dock-e2e.html${query}`);
  expect(response?.ok(), "shell dock fixture page should be served").toBe(true);
  return page.getByRole("region", { name: "Terminal" });
}

async function openDockWithTabs(page: Page, query = ""): Promise<Locator> {
  const dock = await openDock(page, query);
  await expect(dock.getByRole("tab")).not.toHaveCount(0);
  return dock;
}

/** The selected shell's terminal: the others stay mounted, hidden. */
const shownTerminal = (dock: Locator) => dock.locator(".shell-term:not(.is-hidden)");
const grip = (dock: Locator) => dock.getByRole("separator", { name: "Resize Terminal" });

test.describe("at 1440px with a fine pointer", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the terminal is flush: no border or radius, and even padding on a terminal-colored body", async ({ page }) => {
    const dock = await openDockWithTabs(page);
    await expect(shownTerminal(dock).locator(".xterm-rows")).toContainText("3 files passed");
    const style = await shownTerminal(dock).evaluate((terminal) => {
      const own = getComputedStyle(terminal);
      const body = getComputedStyle(terminal.closest(".shell-dock-body")!);
      return {
        borders: [own.borderTopWidth, own.borderRightWidth, own.borderBottomWidth, own.borderLeftWidth],
        radius: own.borderRadius,
        padding: [own.paddingLeft, own.paddingRight],
        bodyPadding: [body.paddingLeft, body.paddingRight],
        background: [own.backgroundColor, body.backgroundColor],
      };
    });
    expect(style.borders).toEqual(["0px", "0px", "0px", "0px"]);
    expect(style.radius).toBe("0px");
    expect(style.padding[0]).toBe(style.padding[1]);
    expect(style.bodyPadding).toEqual(["12px", "12px"]);
    expect(style.background[1], "the body is the terminal's ground edge to edge").toBe(style.background[0]);
    await expect(dock.locator(".hint")).toHaveCount(0);
  });

  test("a first-time dock opens 220px tall, keeps a stored height, and Home resets it", async ({ page }) => {
    let dock = await openDockWithTabs(page);
    const body = () => dock.getByRole("tabpanel");
    await expect(grip(dock)).toHaveAttribute("aria-valuenow", "220");
    expect((await body().boundingBox())?.height).toBe(220);

    await grip(dock).focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(grip(dock)).toHaveAttribute("aria-valuenow", "252");

    await page.reload();
    dock = page.getByRole("region", { name: "Terminal" });
    await expect(grip(dock), "the stored height is kept").toHaveAttribute("aria-valuenow", "252");
    expect((await body().boundingBox())?.height).toBe(252);

    await grip(dock).focus();
    await page.keyboard.press("Home");
    await expect(grip(dock)).toHaveAttribute("aria-valuenow", "220");
    expect((await body().boundingBox())?.height).toBe(220);
  });

  test("the grip's 32×4 mark sits on the dock's top edge without hover", async ({ page }) => {
    const dock = await openDockWithTabs(page);
    const mark = await grip(dock).evaluate((element) => {
      const after = getComputedStyle(element, "::after");
      const probe = document.createElement("div");
      probe.style.background = "var(--border-strong)";
      document.body.append(probe);
      const borderStrong = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const box = element.getBoundingClientRect();
      const markTop = box.top + Number.parseFloat(after.top);
      const dockTop = element.closest(".shell-dock")!.getBoundingClientRect().top;
      return {
        content: after.content,
        width: after.width,
        height: after.height,
        color: after.backgroundColor,
        borderStrong,
        straddles: markTop <= dockTop + 1 && markTop + Number.parseFloat(after.height) >= dockTop,
      };
    });
    expect(mark.content).not.toBe("none");
    expect(mark.width).toBe("32px");
    expect(mark.height).toBe("4px");
    expect(mark.color).toBe(mark.borderStrong);
    expect(mark.straddles, "the mark is on the dock's top edge").toBe(true);
  });

  test("switching from a scrolled-up tab to another and back keeps its scroll position", async ({ page }) => {
    const dock = await openDockWithTabs(page, "?long=1");
    const rows = () => shownTerminal(dock).locator(".xterm-rows");
    await expect(rows()).toContainText("3 files passed");
    await shownTerminal(dock).locator(".xterm").hover();
    await page.mouse.wheel(0, -1200);
    await expect(rows()).not.toContainText("3 files passed");
    const scrolled = await rows().innerText();

    await dock.getByRole("tab", { name: /Shell 2/ }).click();
    await expect(rows()).toContainText("VITE ready");
    await dock.getByRole("tab", { name: /Shell 1/ }).click();
    await expect.poll(() => rows().innerText()).toBe(scrolled);
    // One terminal per shell stays mounted.
    await expect(dock.locator(".shell-term")).toHaveCount(3);
  });

  test("with the machine offline and a shell reconnecting, one notice shows and +1 More lists the other", async ({ page }) => {
    const dock = await openDockWithTabs(page, "?tui=offline&reconnecting=1");
    const slot = dock.locator(".terminal-notice-slot");
    await expect(slot.locator(".notice")).toHaveCount(1);
    await expect(slot).toContainText("Build Box is offline. Shells reconnect when it's back.");
    await slot.getByRole("button", { name: "+1 More" }).click();
    const menu = page.getByRole("menu", { name: "Terminal Notices" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Reconnecting"]);
    await menu.getByRole("menuitem", { name: "Reconnecting" }).click();
    await expect(slot.locator(".notice")).toHaveCount(1);
    await expect(slot).toContainText("Reconnecting to this shell…");
    await expect(dock.locator(".hint")).toHaveCount(0);
  });

  test("an exited shell has a status row with Start New Shell and Close Tab", async ({ page }) => {
    const dock = await openDockWithTabs(page);
    await dock.getByRole("tab", { name: /Shell 3/ }).click();
    const status = dock.locator(".term-status");
    await expect(status).toContainText("Shell exited with code 0.");
    await expect(status.getByRole("button", { name: "Start New Shell" })).toBeEnabled();
    await status.getByRole("button", { name: "Close Tab" }).focus();
    await page.keyboard.press("Enter");
    await expect(dock.getByRole("tab", { name: /Shell 3/ })).toHaveCount(0);
    await expect(dock.locator(".term-status")).toHaveCount(0);
    // The control is gone with its shell, so focus goes to the tab that is now selected.
    await expect(dock.getByRole("tab", { name: /Shell 1/ })).toBeFocused();
  });

  test("an empty dock says what a shell is for and opens one", async ({ page }) => {
    const dock = await openDock(page, "?shells=0&status=completed");
    await expect(dock.getByText("No Shells Open", { exact: true })).toBeVisible();
    await expect(dock.getByText("Run commands in this session's worktree on Build Box.")).toBeVisible();
    await dock.getByRole("tabpanel").getByRole("button", { name: "New Shell" }).click();
    await expect(dock.getByRole("tab", { name: /Shell 1/ })).toBeVisible();
    await expect(dock.getByText("No Shells Open", { exact: true })).toHaveCount(0);
  });

  test("the dock's copy has no em dash or three-dot ellipsis in any state", async ({ page }) => {
    const states: Array<{ query: string; tab?: RegExp }> = [
      { query: "" },
      { query: "", tab: /Shell 3/ },
      { query: "?tui=offline&reconnecting=1" },
      { query: "?tui=guardrail" },
      { query: "?tui=open", tab: /Agent TUI/ },
      { query: "?pipe=1" },
      { query: "?expired=1" },
      { query: "?shells=0&status=completed" },
    ];
    for (const { query, tab } of states) {
      const dock = await openDock(page, query);
      if (tab) await dock.getByRole("tab", { name: tab }).click();
      await expect(dock.locator(".shell-dock-body")).not.toBeEmpty();
      const copy = await dock.evaluate((element) => [
        element.innerText,
        ...[...element.querySelectorAll("[title], [placeholder], [aria-label]")].flatMap((node) =>
          ["title", "placeholder", "aria-label"].map((name) => node.getAttribute(name) ?? "")),
      ].join("\n"));
      expect(copy, `${query} ${tab ?? ""}`).not.toContain("—");
      expect(copy, `${query} ${tab ?? ""}`).not.toContain("...");
    }
  });
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the terminal uses 12px text, and the pipe row shows $, the input and No TTY without clipping", async ({ page }) => {
    const dock = await openDockWithTabs(page, "?pipe=1");
    await expect(shownTerminal(dock).locator(".xterm-rows")).toContainText("files passed");
    expect(await shownTerminal(dock).locator(".xterm-rows").evaluate((rows) => getComputedStyle(rows).fontSize)).toBe("12px");

    const row = dock.locator(".pipe-row");
    await expect(row.locator(".shell-prompt")).toHaveText("$");
    const input = row.getByRole("textbox", { name: "Command" });
    await expect(input).toHaveAttribute("placeholder", "Type a command");
    await expect(row.getByText("No TTY", { exact: true })).toBeVisible();
    await expect(input).toHaveAccessibleDescription(/^No TTY\. This Windows-native shell has no TTY/);
    const fit = await row.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        rowFits: element.scrollWidth <= element.clientWidth,
        children: [...element.children].map((child) => {
          const childBox = child.getBoundingClientRect();
          return {
            name: child.className,
            inside: childBox.left >= box.left - 0.5 && childBox.right <= box.right + 0.5,
            unclipped: child.scrollWidth <= child.clientWidth || child.tagName === "INPUT",
            width: childBox.width,
          };
        }),
      };
    });
    expect(fit.rowFits).toBe(true);
    for (const child of fit.children) {
      expect(child.inside, `${child.name} stays inside the row`).toBe(true);
      expect(child.unclipped, `${child.name} is not clipped`).toBe(true);
      expect(child.width, `${child.name} keeps a width`).toBeGreaterThan(0);
    }
  });

  test("a wider host keeps 12.5px text", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const dock = await openDockWithTabs(page);
    await expect(shownTerminal(dock).locator(".xterm-rows")).toContainText("files passed");
    expect(await shownTerminal(dock).locator(".xterm-rows").evaluate((rows) => getComputedStyle(rows).fontSize)).toBe("12.5px");
  });
});

test.describe("on a coarse pointer at 834px", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });

  test("the grip is a 28px strip whose hit area is 44px and does not reach the tabs", async ({ page }) => {
    const dock = await openDockWithTabs(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const geometry = await grip(dock).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const before = getComputedStyle(element, "::before");
      const reach = before.content === "none" ? 0 : -Number.parseFloat(before.top);
      const tabs = element.closest(".shell-dock")!.querySelector(".shell-tabs")!.getBoundingClientRect();
      const x = box.left + box.width / 4;
      return {
        height: box.height,
        hit: box.height + reach,
        hitTopIsGrip: document.elementFromPoint(x, box.top - reach + 1) === element,
        tabsBelow: tabs.top >= box.bottom,
        tabsAreNotGrip: document.elementFromPoint(tabs.left + 4, tabs.top + 2) !== element,
      };
    });
    expect(geometry.height).toBe(28);
    expect(geometry.hit).toBe(44);
    expect(geometry.hitTopIsGrip, "the hit area reaches 16px above the strip").toBe(true);
    expect(geometry.tabsBelow).toBe(true);
    expect(geometry.tabsAreNotGrip).toBe(true);
  });
});
