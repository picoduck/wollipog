import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { EXPERIMENT_OFF_EFFECT, SETTINGS_SECTIONS, type SettingsSection } from "../src/navigation.js";
import { pinWidestFace } from "./font-geometry";
import { expectTextFits } from "./text-fit";

/**
 * Every Settings section in the settings-rows harness, as production composes it (#3019).
 *
 * The row-specific checks before this measured the rows that had already overflowed (#2413, #2506)
 * and nothing else, so each new overflow was found by eye in a review screenshot. These visit every
 * section and measure every row in it.
 */

test.use({ reducedMotion: "reduce" });

const THEMES = ["dark", "light"] as const;

/** Something each section renders once it has settled, including what it loads from the fixture. */
const SETTLED: Record<SettingsSection, (page: Page) => Locator> = {
  appearance: (page) => page.getByRole("radiogroup", { name: "Theme" }),
  notifications: (page) => page.getByRole("switch", { name: "Desktop Alerts" }),
  // Evidence describes the chosen option once the account's preference has loaded.
  behavior: (page) => page.getByText("Upload only when the task or project asks for it.", { exact: true }),
  // The tool policies arrive after the routine questions they load with.
  approvals: (page) => page.getByRole("button", { name: /^Review Agent-Created Sessions/ }),
  orchestrator: (page) => page.getByRole("radiogroup", { name: "Completion" }),
  network: (page) => page.getByRole("switch", { name: "Tailnet Access" }),
  experimental: (page) => page.getByRole("switch").first(),
  about: (page) => page.getByText("0.27.0", { exact: true }),
};

/**
 * The segmented rows each section is known to have. A section listed here must still render each of
 * them as a radiogroup inside a setting row, so a renamed role or class cannot pass this file by
 * measuring nothing.
 */
const SEGMENTED: Partial<Record<SettingsSection, readonly string[]>> = {
  appearance: ["Theme", "Density", "Sessions Layout", "Terminal Placement"],
  behavior: ["Enter Key"],
  approvals: ["Answer Questions In"],
  orchestrator: ["Completion", "Strict Project Isolation", "Integration Isolation"],
};

async function openSection(page: Page, theme: string, section: SettingsSection) {
  await page.goto(`/settings-rows-e2e.html?theme=${theme}&section=${section}`);
  await expect(page.locator("#settings-panel-heading"))
    .toHaveText(SETTINGS_SECTIONS.find((entry) => entry.id === section)!.title);
  await expect(SETTLED[section](page)).toBeVisible();
}

/** Every option of every segmented control inside a setting row, each against its own pill. */
async function expectEveryPillFits(page: Page, section: SettingsSection, where: string) {
  const groups = page.locator(".settings-panel .setting-row [role='radiogroup']");
  const names = await groups.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? ""));
  for (const expected of SEGMENTED[section] ?? []) {
    expect(names, `${section}: "${expected}" is a segmented row`).toContain(expected);
  }
  for (const [index, name] of names.entries()) {
    const radios = groups.nth(index).getByRole("radio");
    const count = await radios.count();
    expect(count, `${section}: "${name}" has options to measure`).toBeGreaterThan(1);
    for (let option = 0; option < count; option++) {
      const radio = radios.nth(option);
      await expectTextFits(radio, `${section}: "${name}" option "${(await radio.innerText()).trim()}" ${where}`);
    }
  }
}

// #2589: a pill's share of the control column is fixed, so a label longer than its share is drawn
// past its pill. The margin depends on the text's advance width, so every width is measured again in
// the widest verified face (see README.md).
for (const theme of THEMES) {
  for (const width of [1440, 900, 390]) {
    test(`every segmented option in every Settings section fits its own pill at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const { id } of SETTINGS_SECTIONS) {
        await openSection(page, theme, id);
        await expectEveryPillFits(page, id, `at ${width}px in ${theme}`);
        const face = await pinWidestFace(page, page.locator("body"));
        await expectEveryPillFits(page, id, `at ${width}px in ${theme} with ${face}`);
      }
    });
  }
}

test("at 1440px every section's row titles share one left edge and its controls one right edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let measuredControls = 0;
  for (const { id } of SETTINGS_SECTIONS) {
    await openSection(page, "dark", id);
    // Appearance's Navigation editor rows are not setting rows yet (#3021 rebuilds them), but they sit
    // in the same group surface and are held to the same two edges: the icon on the left one, the
    // last control on the right one.
    const rows = await page.locator(".settings-panel .settings-group-surface :is(.setting-row, .rail-order-row)").evaluateAll((elements) => elements.map((row) => {
      if (row.classList.contains("rail-order-row")) {
        return {
          title: (row.querySelector(".rail-order-title")?.textContent ?? "").trim(),
          titleLeft: row.firstElementChild!.getBoundingClientRect().left,
          controlRight: row.querySelector(".rail-order-controls")!.getBoundingClientRect().right,
        };
      }
      const control = row.querySelector(":scope > .setting-row-control");
      // The rightmost thing the control column draws: a select keeps an unrendered list root after
      // its trigger, and a disabled select its reason under it.
      const rights = [...(control?.children ?? [])].map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 1 && box.height > 1).map((box) => box.right);
      const track = row.querySelector(":scope > .ui-switch, :scope > .ui-switch-standalone > .ui-switch");
      return {
        title: (row.querySelector(".setting-row-title")?.textContent ?? "").trim(),
        titleLeft: row.querySelector(".setting-row-title, .setting-row-label")!.getBoundingClientRect().left,
        controlRight: track ? track.getBoundingClientRect().right : rights.length ? Math.max(...rights) : null,
      };
    }));
    expect(rows.length, `${id}: rows were measured`).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Math.abs(row.titleLeft - rows[0]!.titleLeft), `${id}: "${row.title}" starts on the section's one left edge`)
        .toBeLessThanOrEqual(0.5);
    }
    const ends = rows.filter((row) => row.controlRight !== null);
    measuredControls += ends.length;
    for (const row of ends) {
      expect(Math.abs(row.controlRight! - ends[0]!.controlRight!), `${id}: "${row.title}" ends its control on the section's one right edge`)
        .toBeLessThanOrEqual(0.5);
    }
  }
  expect(measuredControls, "controls were measured across the sections").toBeGreaterThan(20);
});

test("every Settings group is one surface with hairlines between its rows, and a section with one group has no group heading", async ({ page }) => {
  for (const theme of THEMES) {
    for (const { id } of SETTINGS_SECTIONS) {
      await openSection(page, theme, id);
      const groups = await page.locator(".settings-panel .settings-group").evaluateAll((elements) => elements.map((group) => {
        const surfaces = group.querySelectorAll(":scope > .settings-group-surface");
        const children = [...(surfaces[0]?.children ?? [])];
        const title = group.querySelector(":scope > .settings-group-head > .settings-group-title");
        return {
          title: title?.textContent ?? null,
          transform: title ? getComputedStyle(title).textTransform : null,
          surfaces: surfaces.length,
          tops: children.map((child) => getComputedStyle(child).borderTopWidth),
        };
      }));
      expect(groups.length, `${id}: the section renders its groups`).toBeGreaterThan(0);
      // About draws its own head, the identity header (#3028), which does not name its one group in a
      // browser, so that group keeps its title; every other section's heading names its only group.
      if (groups.length === 1 && id !== "about") expect(groups[0]!.title, `${id}: its only group has no heading`).toBeNull();
      for (const group of groups) {
        const name = `${id} › ${group.title ?? "its group"}`;
        if (groups.length > 1) expect(group.title, `${name}: each of several groups is headed`).not.toBeNull();
        if (group.title !== null) expect(group.transform, `${name}: the heading is written in Title Case`).toBe("none");
        expect(group.surfaces, `${name}: one surface`).toBe(1);
        expect(group.tops[0], `${name}: no hairline above the first row`).toBe("0px");
        for (const [index, top] of group.tops.slice(1).entries()) {
          expect(top, `${name}: a hairline above row ${index + 2}`).toBe("1px");
        }
      }
    }
  }
});

/**
 * Appearance › Navigation on a phone: with 44px buttons, a hidden destination's name shares its row
 * with "Hidden", the shortcut digit and three controls. In the widest face "Automations" ran into
 * its status at 360px and 375px, so every name is measured against its own box there.
 */
test.describe("on a touch phone", () => {
  const phone = devices["Pixel 7"];
  test.use({ hasTouch: phone.hasTouch, isMobile: phone.isMobile, userAgent: phone.userAgent });

  for (const width of [320, 360, 375]) {
    test(`every Navigation destination's name stays in its own box at ${width}px, hidden or shown`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openSection(page, "dark", "appearance");
      const face = await pinWidestFace(page, page.locator("body"));
      for (const name of ["Automations", "Multi-Agent Runs", "Archived Sessions", "Usage and Cost"]) {
        await page.locator(".rail-order-row", { has: page.locator(".rail-order-title", { hasText: name }) })
          .getByRole("button", { name: "Hide", exact: true })
          .click();
      }
      const titles = page.locator(".rail-order-title");
      expect(await titles.count(), "the destinations were measured").toBeGreaterThan(5);
      for (const title of await titles.all()) {
        await expectTextFits(title, `"${await title.innerText()}" at ${width}px with ${face}`);
      }
    });
  }
});

/** The sentences a section shows outside its rows: its head's description and its groups' intros. */
async function visibleSectionSentences(page: Page): Promise<string[]> {
  return page.locator(".settings-panel :is(.settings-panel-desc, .settings-group-desc)").filter({ visible: true }).allInnerTexts();
}

/**
 * Experimental's head is the one place that says what turning a feature off does (#3022), and a
 * phone hides the head's description under its detail bar (§4.2), so there the group says it (#3139).
 */
test.describe("what turning an experiment off does", () => {
  for (const width of [1440, 900]) {
    test(`is said once, in the panel head, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of THEMES) {
        await openSection(page, theme, "experimental");
        expect(await visibleSectionSentences(page), `${theme}: only the head says it`)
          .toEqual([`Early features. ${EXPERIMENT_OFF_EFFECT}`]);
      }
    });
  }

  test.describe("on a touch phone", () => {
    const phone = devices["Pixel 7"];
    test.use({ hasTouch: phone.hasTouch, isMobile: phone.isMobile, userAgent: phone.userAgent });

    test("is said once, above the rows, at 390px", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      for (const theme of THEMES) {
        await openSection(page, theme, "experimental");
        expect(await visibleSectionSentences(page), `${theme}: the group says it once`).toEqual([EXPERIMENT_OFF_EFFECT]);
        const intro = await page.locator(".settings-panel .settings-group-desc").boundingBox();
        const firstRow = await page.getByRole("switch").first().boundingBox();
        expect(intro!.y + intro!.height, `${theme}: above the rows`).toBeLessThanOrEqual(firstRow!.y);
      }
    });

    // No other section gains a sentence on a phone: each shows the same group intros as at 1440px,
    // and no panel head description.
    test("every other section shows the same sentences at 390px as its groups do at 1440px", async ({ page }) => {
      for (const { id } of SETTINGS_SECTIONS) {
        if (id === "experimental") continue;
        await page.setViewportSize({ width: 1440, height: 900 });
        await openSection(page, "dark", id);
        const desktop = await page.locator(".settings-panel .settings-group-desc").filter({ visible: true }).allInnerTexts();
        await page.setViewportSize({ width: 390, height: 900 });
        await openSection(page, "dark", id);
        expect(await visibleSectionSentences(page), `${id}: unchanged on a phone`).toEqual(desktop);
      }
    });
  });
});
