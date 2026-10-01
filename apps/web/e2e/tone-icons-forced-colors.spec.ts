import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2269: tone icons follow their words in forced colors. Chromium gives an svg
 * `forced-color-adjust: preserve-parent-color`, so an icon that sets its own colour keeps it (amber,
 * red, blue) while the words beside it turn a system colour. Outside forced colors each icon keeps
 * its tone.
 */

const PINNED = "/command-inbox-projects-e2e.html?fullShell=1&scenario=pinned-summary&psActivity=1";

/** A colour as the browser computes it: a token through `var()`, or a system colour by name. */
async function computed(page: Page, value: string): Promise<string> {
  return page.evaluate((color) => {
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.append(probe);
    const result = getComputedStyle(probe).color;
    probe.remove();
    return result;
  }, value);
}

/** The computed colour of an icon and of the words it labels, both inside `scope`. */
async function pair(scope: Locator, icon: string, words: string): Promise<{ icon: string; words: string }> {
  await expect(scope.locator(icon)).toHaveCount(1);
  return scope.evaluate((element, selectors) => ({
    icon: getComputedStyle(element.querySelector(selectors.icon)!).color,
    words: getComputedStyle(element.querySelector(selectors.words)!).color,
  }), { icon, words });
}

async function openPinnedSummary(page: Page, theme: "dark" | "light"): Promise<Locator> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tone-icons-seeded")) return;
    sessionStorage.setItem("tone-icons-seeded", "1");
    localStorage.clear();
    localStorage.setItem("wollipog.pinned.open", "1");
  });
  await page.goto(PINNED);
  await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".md table")).toBeVisible();
  const aside = page.locator('aside.ps[aria-label="Pinned Summary"]');
  await expect(aside).toBeVisible();
  await aside.getByRole("region", { name: "Activity" }).getByRole("button", { name: /^Plan/ }).click();
  await expect(aside.locator(".ps-item.plan-in_progress")).toBeVisible();
  return aside;
}

/** The Pinned Summary row whose label reads exactly `label`. */
const row = (aside: Locator, label: string) =>
  aside.locator(".ps-row").filter({ has: aside.page().locator(":scope > .k", { hasText: new RegExp(`^${label}$`) }) });

for (const palette of ["dark", "light"] as const) {
  test.describe(`forced colors (${palette} palette)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active", colorScheme: palette });
    });

    test("the field warning and the Save bar error icons follow their words", async ({ page }) => {
      await page.goto(`/primitives-e2e.html?theme=${palette}`);
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
      const canvasText = await computed(page, "CanvasText");

      const warning = await pair(page.locator('.field[data-state="warning"] .field-warn'), ".field-warn-icon", ":scope > span");
      expect(warning.icon, "the warning icon follows the warning's words").toBe(warning.words);
      expect(warning.words).toBe(canvasText);

      const saveBar = await pair(page.locator(".save-bar.is-error"), ".save-bar-icon", ".save-bar-message");
      expect(saveBar.icon, "the Save bar's error icon follows its message").toBe(saveBar.words);
      expect(saveBar.words).toBe(canvasText);
    });

    test("a provider's mark follows the session list's sender line", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(PINNED);
      await expect(page.locator(".inbox-row-sender").first()).toBeVisible();
      // Outside forced colors the mark keeps its brand colour; in them it follows the words beside it.
      const senders = await page.locator(".inbox-row-sender").evaluateAll((lines) => lines.map((line) => ({
        mark: line.querySelector(":scope > .agent-icon")!.getAttribute("class")!,
        icon: getComputedStyle(line.querySelector(":scope > .agent-icon")!).color,
        words: getComputedStyle(line.querySelector(":scope > span")!).color,
      })));
      expect(senders.length).toBeGreaterThan(0);
      expect(senders.some((sender) => /\bagent-(openai|anthropic|google)\b/.test(sender.mark))).toBe(true);
      for (const sender of senders) expect(sender.icon, sender.mark).toBe(sender.words);
    });

    test("the Pinned Summary's warning rows and plan steps follow their words", async ({ page }) => {
      const aside = await openPinnedSummary(page, palette);
      const canvasText = await computed(page, "CanvasText");

      for (const label of ["Rebase in Progress", "Conflicts"]) {
        const warning = row(aside, label);
        await expect(warning).toHaveClass(/\bis-warning\b/);
        const colours = await pair(warning, ":scope > .ps-icon", ":scope > .k");
        expect(colours.icon, `${label}: the warning icon follows its label`).toBe(colours.words);
        expect(colours.words).toBe(canvasText);
      }

      const steps = aside.locator(".ps-item[class*='plan-']");
      await expect(steps).toHaveCount(3);
      for (const step of await steps.all()) {
        const colours = await pair(step, ".ps-item-icon", ".ps-item-text");
        expect(colours.icon, `${await step.getAttribute("class")}: the step's icon follows its words`).toBe(colours.words);
      }

      // Every other icon a row carries (its leading icon, and the chevron or external-link icon of a
      // row that opens something) follows the row's label too, whatever system colour that is.
      const rows = await aside.locator(".ps-row").evaluateAll((elements) => elements.map((element) => ({
        label: element.querySelector(":scope > .k")?.textContent ?? "",
        words: getComputedStyle(element.querySelector(":scope > .k") ?? element).color,
        icons: [...element.querySelectorAll(":scope > svg")].map((icon) => getComputedStyle(icon).color),
      })));
      expect(rows.filter((entry) => entry.icons.length > 0).length).toBeGreaterThan(5);
      for (const entry of rows) {
        for (const icon of entry.icons) expect(icon, `${entry.label}: icon`).toBe(entry.words);
      }
      const chevrons = await aside.locator(".ps-disclosure > .disclosure-trigger").evaluateAll((triggers) => triggers.map((trigger) => ({
        icon: getComputedStyle(trigger.querySelector(".disclosure-chevron")!).color,
        words: getComputedStyle(trigger.querySelector(".k")!).color,
      })));
      expect(chevrons.length).toBeGreaterThan(0);
      for (const chevron of chevrons) expect(chevron.icon).toBe(chevron.words);

    });
  });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`outside forced colors (${theme} theme)`, () => {
    test("the field warning and the Save bar error icons keep their tones", async ({ page }) => {
      await page.goto(`/primitives-e2e.html?theme=${theme}`);
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(false);
      const warning = await pair(page.locator('.field[data-state="warning"] .field-warn'), ".field-warn-icon", ":scope > span");
      expect(warning).toEqual({ icon: await computed(page, "var(--amber)"), words: await computed(page, "var(--text-dim)") });
      const saveBar = await pair(page.locator(".save-bar.is-error"), ".save-bar-icon", ".save-bar-message");
      expect(saveBar).toEqual({ icon: await computed(page, "var(--red)"), words: await computed(page, "var(--text-dim)") });
    });

    test("the Pinned Summary's warning rows and plan steps keep their tones", async ({ page }) => {
      const aside = await openPinnedSummary(page, theme);
      const [warningTone, blue, faint, dim, text] = await Promise.all(
        ["--warning", "--blue", "--text-faint", "--text-dim", "--text"].map((name) => computed(page, `var(${name})`)));
      for (const label of ["Rebase in Progress", "Conflicts"]) {
        expect(await pair(row(aside, label), ":scope > .ps-icon", ":scope > .k")).toEqual({ icon: warningTone, words: warningTone });
      }
      expect(await pair(row(aside, "Machine"), ":scope > .ps-icon", ":scope > .k")).toEqual({ icon: dim, words: text });
      expect(await pair(aside.locator(".ps-item.plan-in_progress"), ".ps-item-icon", ".ps-item-text"))
        .toEqual({ icon: blue, words: dim });
      expect(await pair(aside.locator(".ps-item.plan-pending"), ".ps-item-icon", ".ps-item-text"))
        .toEqual({ icon: faint, words: dim });
    });
  });
}
