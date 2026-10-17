import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2951: grouped combobox options, the chosen check and the footer action row (docs/design-system.md
 * §8.4, §9.1) in a browser, where the rows' heights, the separator and the list's box are layout.
 *
 * `PICKER_EVIDENCE_DIR` saves a screenshot of each open list there, for UI review; without it the
 * spec captures nothing.
 */

const THEMES = ["dark", "light"] as const;
const SELECT_MENU_MAX_HEIGHT_PX = 320;
const SELECT_LIST_MIN_WIDTH_PX = 280;

const field = (page: Page, name: string) => page.locator(`[data-field="${name}"]`);

async function capture(page: Page, name: string) {
  const dir = process.env.PICKER_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** The open list's box, and each row's kind and height in document order. */
async function listLayout(list: Locator) {
  return list.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>('.menu-label, [role="option"], .menu-sep, .ui-select-filter-row')]
      .map((row) => ({
        kind: row.classList.contains("menu-label") ? "label"
          : row.classList.contains("menu-sep") ? "sep"
            : row.classList.contains("ui-select-filter-row") ? "filter" : "option",
        text: row.textContent ?? "",
        height: row.getBoundingClientRect().height,
        top: row.getBoundingClientRect().top,
      }));
    return { width: box.width, height: box.height, scrolls: element.scrollHeight > element.clientHeight, rows };
  });
}

for (const theme of THEMES) {
  test.describe(`at 1440px (${theme})`, () => {
    test.use({ viewport: { width: 1440, height: 1000 } });

    test("a grouped combobox lists its sections, checks the chosen option and ends with the footer action", async ({ page }) => {
      await page.goto(`/picker-footer-e2e.html?theme=${theme}`);
      const agent = page.getByRole("combobox", { name: "Agent" });
      await agent.click();
      await expect(agent).toHaveAttribute("aria-expanded", "true");
      const list = page.getByRole("listbox", { name: "Agent Options" });
      await expect(list.getByRole("group", { name: "Ready" })).toBeVisible();
      await expect(list.getByRole("group", { name: "Needs Setup" })).toBeVisible();

      const chosen = list.getByRole("option", { name: "Codex" });
      await expect(chosen.locator("svg")).toBeVisible();
      await expect(list.locator(".is-selected")).toHaveCount(1);

      const layout = await listLayout(list);
      expect(layout.rows.map((row) => row.kind)).toEqual(
        ["label", "option", "option", "option", "label", "option", "sep", "option"]);
      for (const row of layout.rows.filter((row) => row.kind === "label")) expect(row.height).toBe(28);
      const footer = layout.rows.at(-1)!;
      expect(footer.text).toBe("Set Up Agents in Connections");
      expect(footer.height).toBe(32);
      expect(layout.height).toBeLessThanOrEqual(SELECT_MENU_MAX_HEIGHT_PX);
      expect(layout.width).toBeGreaterThanOrEqual(SELECT_LIST_MIN_WIDTH_PX);
      await capture(page, `combobox-open-1440-${theme}`);

      await page.keyboard.press("End");
      await expect(agent).toHaveAttribute("aria-activedescendant", (await list.getByRole("option", { name: "Set Up Agents in Connections" }).getAttribute("id"))!);
      await page.keyboard.press("Enter");
      await expect(agent).toHaveAttribute("aria-expanded", "false");
      await expect(agent).toBeFocused();
      await expect(field(page, "agent")).toHaveAttribute("data-footer-runs", "1");
      await expect(field(page, "agent")).toHaveAttribute("data-value", "codex");
    });

    test("a search with no matches keeps the footer action after the no-match sentence", async ({ page }) => {
      await page.goto(`/picker-footer-e2e.html?theme=${theme}`);
      const agent = page.getByRole("combobox", { name: "Agent" });
      await agent.click();
      await agent.fill("zzz");
      const list = page.getByRole("listbox", { name: "Agent Options" });
      await expect(list.locator(".ui-select-no-match")).toHaveText("No agents match “zzz”.");
      const layout = await listLayout(list);
      expect(layout.rows.map((row) => row.kind)).toEqual(["sep", "option"]);
      expect(layout.rows[1]!.height).toBe(32);
      expect(layout.scrolls).toBe(false);
      await capture(page, `combobox-no-match-1440-${theme}`);
    });

    test("a Select's footer action is a 32px row after a separator, and returns focus to the trigger", async ({ page }) => {
      await page.goto(`/picker-footer-e2e.html?theme=${theme}`);
      const trigger = page.getByRole("button", { name: "Location: Studio Mac" });
      await trigger.click();
      const list = page.getByRole("listbox", { name: "Location" });
      const layout = await listLayout(list);
      expect(layout.rows.map((row) => row.kind)).toEqual(["option", "label", "option", "sep", "option"]);
      expect(layout.rows.at(-1)!.height).toBe(32);
      expect(layout.width).toBeGreaterThanOrEqual(SELECT_LIST_MIN_WIDTH_PX);
      expect(layout.scrolls).toBe(false);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(trigger).toBeFocused();
      await expect(field(page, "location")).toHaveAttribute("data-footer-runs", "1");
    });

    test("with openOnFocus off, focus leaves the list closed and typing opens it filtered", async ({ page }) => {
      await page.goto(`/picker-footer-e2e.html?theme=${theme}&openOnFocus=0`);
      const agent = page.getByRole("combobox", { name: "Agent" });
      await agent.focus();
      await expect(agent).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.type("pay");
      await expect(agent).toHaveValue("pay");
      await expect(agent).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("listbox", { name: "Agent Options" }).getByRole("option"))
        .toHaveText(["Payments Reviewer", "Set Up Agents in Connections"]);
    });
  });

  test.describe(`in a short window (${theme})`, () => {
    test.use({ viewport: { width: 1440, height: 220 } });

    test("End in a combobox list that scrolls brings its footer action into view", async ({ page }) => {
      await page.goto(`/picker-footer-e2e.html?theme=${theme}`);
      const agent = page.getByRole("combobox", { name: "Agent" });
      await agent.click();
      const list = page.getByRole("listbox", { name: "Agent Options" });
      expect((await listLayout(list)).scrolls, "the list is shorter than its rows here").toBe(true);
      await page.keyboard.press("End");
      const footer = list.getByRole("option", { name: "Set Up Agents in Connections" });
      await expect(agent).toHaveAttribute("aria-activedescendant", (await footer.getAttribute("id"))!);
      await expect.poll(() => list.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const row = element.querySelector('[id$="-footer"]')!.getBoundingClientRect();
        return row.top >= box.top && row.bottom <= box.bottom;
      })).toBe(true);
    });
  });

  test.describe(`at 1440px, a Select's selection (${theme})`, () => {
    test.use({ viewport: { width: 1440, height: 1000 } });

    test("highlighting a Select's footer action leaves one selected option, its value", async ({ page }) => {
      await page.goto(`/picker-footer-e2e.html?theme=${theme}`);
      await page.getByRole("button", { name: "Location: Studio Mac" }).click();
      const list = page.getByRole("listbox", { name: "Location" });
      await expect(list).toBeFocused();
      await page.keyboard.press("End");
      await expect(list.locator('[role="option"][aria-selected="true"]')).toHaveText(["Studio MacOnline · ~/dev/wollipog"]);
    });
  });

  test.describe(`at 390px with a coarse pointer (${theme})`, () => {
    test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

    test("a searchable Select shows its filter at the top and the footer action as its 44px last row", async ({ page }) => {
      await page.goto(`/picker-footer-e2e.html?theme=${theme}`);
      await page.getByRole("button", { name: "Project: Wollipog" }).tap();
      const filter = page.getByRole("combobox", { name: "Search Project Options" });
      await expect(filter).toBeFocused();
      const panel = page.locator(".menu.listbox").filter({ has: filter });
      const layout = await listLayout(panel);
      expect(layout.rows[0]!.kind).toBe("filter");
      expect(layout.rows.map((row) => row.kind)).toEqual(["filter", "option", "option", "option", "sep", "option"]);
      const footer = layout.rows.at(-1)!;
      expect(footer.text).toBe("New Project…");
      expect(footer.height).toBe(44);
      expect(layout.height).toBeLessThanOrEqual(SELECT_MENU_MAX_HEIGHT_PX);
      expect(layout.width).toBeGreaterThanOrEqual(SELECT_LIST_MIN_WIDTH_PX);
      await capture(page, `select-touch-390-${theme}`);

      await filter.fill("zzz");
      const empty = await listLayout(panel);
      expect(empty.rows.map((row) => row.kind)).toEqual(["filter", "option", "sep", "option"]);
      expect(empty.rows.at(-1)!.text).toBe("New Project…");
      expect(empty.rows.at(-1)!.height).toBe(44);
      await capture(page, `select-touch-no-match-390-${theme}`);

      await page.getByRole("option", { name: "New Project…" }).tap();
      await expect(page.getByRole("button", { name: "Project: Wollipog" })).toBeFocused();
      await expect(field(page, "project")).toHaveAttribute("data-footer-runs", "1");
    });

    test("a grouped combobox's rows and footer action are touch height", async ({ page }) => {
      await page.goto(`/picker-footer-e2e.html?theme=${theme}`);
      const agent = page.getByRole("combobox", { name: "Agent" });
      await agent.tap();
      const list = page.getByRole("listbox", { name: "Agent Options" });
      await expect(list).toBeVisible();
      const layout = await listLayout(list);
      for (const row of layout.rows.filter((row) => row.kind === "label")) expect(row.height).toBe(28);
      for (const row of layout.rows.filter((row) => row.kind === "option")) expect(row.height).toBeGreaterThanOrEqual(44);
      expect(layout.rows.at(-1)!.height).toBe(44);
      expect(layout.height).toBeLessThanOrEqual(SELECT_MENU_MAX_HEIGHT_PX);
      await capture(page, `combobox-open-390-${theme}`);

      await agent.fill("zzz");
      await expect(list.locator(".ui-select-no-match")).toHaveText("No agents match “zzz”.");
      await capture(page, `combobox-no-match-390-${theme}`);
    });
  });
}
