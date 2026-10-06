import { expect, test, type Page } from "@playwright/test";

/**
 * The Sessions search (#2200), measured in a real browser: a field that never resizes, so focusing
 * and typing move nothing; 240px wide, 200px in the compact tier; `/` to reach it; tab counts that
 * follow the results; and No Matches with Clear Search and Search Transcripts. The harness mounts
 * the real InboxView with ten groups, two of whose sessions mention terraform.
 */

async function openGroups(page: Page) {
  await page.goto(`/sessions-board-e2e.html?groups=1&path=${encodeURIComponent("/")}`);
  await expect(page.getByRole("tablist", { name: "Session Groups" }).getByRole("tab")).toHaveCount(10);
}

const field = (page: Page) => page.getByRole("textbox", { name: "Search Sessions" });

/** Every control in the page header and the tab row, by a stable name, with its box. */
async function controlBoxes(page: Page, { tabs }: { tabs: boolean }) {
  return page.locator(".page-header").evaluate((header, includeTabs) => {
    const controls = [...header.querySelectorAll<HTMLElement>("button, input, [role='tab'], .tabs-tools > *")]
      .filter((control) => includeTabs || !control.closest(".tabs-bar > .tabs"));
    return Object.fromEntries(controls.map((control, index) => {
      const { x, y, width, height } = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") ?? control.getAttribute("title") ?? control.textContent?.trim();
      return [`${index}:${control.tagName}:${name}`, { x, y, width, height }];
    }));
  }, tabs);
}

test("focusing and typing in the field moves no other control in the header or tab row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  const resting = await controlBoxes(page, { tabs: true });
  expect(Object.keys(resting).length).toBeGreaterThan(14);

  await field(page).focus();
  await expect(field(page)).toBeFocused();
  expect(await controlBoxes(page, { tabs: true }), "focus moves nothing").toEqual(resting);

  await page.keyboard.type("terraform");
  await expect(page.locator(".inbox-row")).toHaveCount(2);
  // The tabs' own counts follow the results, so only the controls around them are compared.
  const restingOthers = await controlBoxes(page, { tabs: false });
  await field(page).fill("");
  await expect(page.locator(".inbox-row")).not.toHaveCount(2);
  expect(restingOthers).toEqual(await controlBoxes(page, { tabs: false }));
  await field(page).fill("terraform");
  expect(await controlBoxes(page, { tabs: false }), "typing moves nothing outside the tabs").toEqual(restingOthers);
});

for (const [width, height, expected] of [[1440, 900, 240], [940, 700, 200]] as const) {
  test(`the field is ${expected}px at ${width}px, in the UI font, one control tall`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openGroups(page);
    const metrics = await field(page).evaluate((input) => {
      const label = input.closest("label")!;
      const style = getComputedStyle(input);
      return {
        width: label.getBoundingClientRect().width,
        inputWidth: input.getBoundingClientRect().width,
        height: input.getBoundingClientRect().height,
        controlHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-h")),
        font: style.fontFamily,
        uiFont: getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim(),
      };
    });
    expect(metrics.width).toBe(expected);
    expect(metrics.inputWidth).toBe(expected);
    expect(metrics.height).toBe(metrics.controlHeight);
    expect(metrics.font.replace(/\s+/g, "")).toBe(metrics.uiFont.replace(/\s+/g, ""));

    await field(page).focus();
    await page.keyboard.type("terraform");
    expect(await field(page).evaluate((input) => input.closest("label")!.getBoundingClientRect().width)).toBe(expected);
  });
}

test("/ focuses the field from the list, its keycap shows at rest, and Escape clears it, from No Matches too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The app shell owns the / and Escape bindings.
  await page.goto(`/sessions-board-e2e.html?full-shell=1&groups=1&path=${encodeURIComponent("/")}`);
  await expect(page.locator(".inbox-search kbd")).toBeVisible();
  await page.getByRole("grid", { name: "Sessions", exact: true }).focus();
  await page.keyboard.press("/");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("terraform");
  await expect(page.locator(".inbox-row")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue("");
  await expect(page.locator(".inbox-row").nth(2), "the whole list is back").toBeVisible();

  await field(page).fill("kubernetes");
  // F6 still enters the list zone while No Matches stands in for the list (§16.1).
  await page.locator('.rail-item[aria-current="page"]').first().focus();
  await page.keyboard.press("F6");
  await expect(page.locator(".inbox-no-matches")).toBeFocused();
  const clear = page.locator(".inbox-no-matches").getByRole("button", { name: "Clear Search" });
  await clear.focus();
  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue("");
  await expect(page.locator(".inbox-no-matches")).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "Sessions", exact: true })).toBeFocused();
});

test("each tab counts its matches, a tab with none shows a faint 0 without a badge, and clearing restores the totals", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  const tab = (name: string) => page.getByRole("tablist", { name: "Session Groups" }).getByRole("tab", { name: new RegExp(`^${name}`) });
  const total = (await tab("All").locator(":scope > .count").textContent())!;
  expect(Number(total)).toBeGreaterThan(2);
  await expect(tab("Billing").locator(".count-badge").first(), "Billing has a session waiting on the user").toBeVisible();

  await field(page).fill("terraform");
  await expect(tab("All").locator(":scope > .count")).toHaveText("2");
  await expect(tab("Infrastructure").locator(":scope > .count")).toHaveText("1");
  await expect(tab("Billing").locator(":scope > .count")).toHaveText("1");
  await expect(tab("Billing").locator(".count-badge"), "the waiting session does not match").toHaveCount(0);
  const zero = tab("Design System").locator(":scope > .count");
  await expect(zero).toHaveText("0");
  await expect(tab("Design System").locator(".count-badge")).toHaveCount(0);
  const [zeroColor, faint] = await zero.evaluate((count) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-faint)";
    document.body.append(probe);
    const colors = [getComputedStyle(count).color, getComputedStyle(probe).color];
    probe.remove();
    return colors;
  });
  expect(zeroColor).toBe(faint);

  await field(page).fill("");
  await expect(tab("All").locator(":scope > .count")).toHaveText(total);
  await expect(tab("Design System").locator(":scope > .count")).toHaveText("1");
});

test("No Matches replaces both panes; Clear Search restores the list and Search Transcripts opens the palette with the query", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  await field(page).fill("kubernetes");
  const state = page.locator(".inbox-no-matches .state");
  await expect(state.getByText("No Matches", { exact: true })).toBeVisible();
  await expect(state).toContainText("No sessions match “kubernetes” in any group.");
  await expect(page.locator(".inbox-preview-pane")).toHaveCount(0);
  await expect(page.locator(".master-detail-resize")).toHaveCount(0);

  await state.getByRole("button", { name: "Search Transcripts" }).click();
  const palette = page.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();
  await expect(palette.locator(".palette-input")).toHaveValue("kubernetes");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(field(page)).toHaveValue("kubernetes");

  await state.getByRole("button", { name: "Clear Search" }).click();
  await expect(field(page)).toHaveValue("");
  await expect(page.locator(".inbox-no-matches")).toHaveCount(0);
  await expect(page.locator(".inbox-row").nth(2), "the whole list is back").toBeVisible();
  await expect(page.locator(".inbox-preview-pane")).toBeVisible();
});

test("when the selected session leaves the results, the first result is selected and previewed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  await page.locator(".inbox-row", { hasText: "Mobile App Session" }).click();
  await expect(page.locator(".session-preview-bar .detail-bar-title")).toHaveText("Mobile App Session");
  await field(page).fill("terraform");
  const selected = page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title');
  await expect(page.locator(".inbox-row")).toHaveCount(2);
  const first = await page.locator(".inbox-row-title").first().textContent();
  await expect(selected).toHaveText(first!);
  await expect(page.locator(".session-preview-bar .detail-bar-title")).toHaveText(first!);
});
