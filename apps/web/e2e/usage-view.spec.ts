import { expect, test, type Page } from "@playwright/test";

// These cases exercise the explicitly enabled privacy mode. Default-off behavior has separate coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});

/**
 * The redesigned Usage & Cost view (#601): metric toggle, driver-stacked chart with a hover and
 * keyboard readout, totals tiles, shared time aggregation, and the coverage notice. Screenshots land
 * in `test-results/usage-view/` as the PR's visual evidence.
 */

test.use({ reducedMotion: "reduce" });

const SHOT = "test-results/usage-view";

/** A CSS colour as the page computes it ("rgb(248, 81, 73)"), for comparing against a token. */
async function resolvedColor(page: Page, value: string): Promise<string> {
  return page.evaluate((color) => {
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return computed;
  }, value);
}
const resolvedRed = (page: Page) => resolvedColor(page, "var(--red)");

test("desktop: metric, chart interaction, and Group By as the one aggregation control", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  const headline = page.locator(".usage-headline-value");
  await expect(headline).toContainText("$");
  await page.screenshot({ path: `${SHOT}/desktop-dark-cost.png`, fullPage: true });
  const breakdown = page.getByRole("tablist", { name: "Breakdown" });
  const aggregation = page.getByRole("radiogroup", { name: "Group By" });
  const tableHead = page.locator(".usage-tables-section .usage-table thead th");
  await expect(page.getByRole("radiogroup", { name: "Usage Breakdown" })).toHaveCount(0);
  await aggregation.getByRole("radio", { name: "Hour" }).click();
  await expect(page.locator(".usage-chart-svg title")).toContainText("Hourly cost");
  await expect(breakdown.getByRole("tab").first()).toHaveText("By Hour");
  await expect(tableHead.first()).toHaveText("Hour (UTC)");
  // The hourly axis spans the whole range from its first hour, not just the hours with usage.
  await expect(page.locator(".usage-chart-axis").first()).toHaveText("Aug 5 · 00:00");
  await expect(page.locator(".usage-chart-axis").last()).toHaveText("Sep 3 · 23:00");

  const cost = await headline.textContent();
  await page.getByRole("radio", { name: "Tokens" }).click();
  await expect(headline).not.toHaveText(cost ?? "");
  await expect(headline).toContainText("M");
  await expect(page.locator(".usage-chart-svg title")).toContainText("Hourly processed tokens");
  await expect(tableHead.last()).toHaveText("Cost");
  await page.screenshot({ path: `${SHOT}/desktop-dark-tokens.png`, fullPage: true });
  await page.getByRole("radio", { name: "Cost" }).click();

  // Hover a column: the readout lists every driver plus a total. Every hour of the 30 days is a
  // column; the fixture's usage lands at 03:00 each day.
  const hits = page.locator(".usage-chart-hit");
  await expect(hits).toHaveCount(30 * 24);
  const readout = page.locator(".usage-chart-readout");
  await expect(readout).toContainText(/^Hourly average \$[\d.]+ · Peak \$[\d.]+ on Aug \d+ at 03:00$/);
  await hits.nth(14 * 24 + 3).hover();
  await expect(readout).toContainText("Claude Code");
  await expect(readout).toContainText("Codex");
  await expect(readout).toContainText("Total");
  await expect(readout).toContainText("UTC");
  await page.screenshot({ path: `${SHOT}/desktop-dark-hover.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } });

  // Keyboard reaches the same readout.
  await hits.nth(3).focus();
  await expect(readout).toContainText("Total");
  // The driver list is the chart's only legend.
  await expect(page.getByRole("list", { name: "By Driver" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.locator(".usage-legend, .usage-series-key")).toHaveCount(0);

  // A Breakdown tab changes only the dimension; the chart keeps its aggregation.
  await breakdown.getByRole("tab", { name: "By Model" }).click();
  await expect(tableHead.first()).toHaveText("Model");
  await expect(page.locator(".usage-table tbody th").first()).toHaveText("Fable 5.1");
  await expect(page.locator(".usage-chart-svg title")).toContainText("Hourly cost");
  await expect(aggregation.getByRole("radio", { name: "Hour" })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: `${SHOT}/desktop-dark-model.png`, fullPage: true });
  await aggregation.getByRole("radio", { name: "Week" }).click();
  await expect(page.locator(".usage-chart-svg title")).toContainText("Weekly cost");
  await expect(breakdown.getByRole("tab").first()).toHaveText("By Week");
  await expect(breakdown.getByRole("tab", { name: "By Model" })).toHaveAttribute("aria-selected", "true");
  await breakdown.getByRole("tab", { name: "By Week" }).click();
  await expect(tableHead.first()).toHaveText("Week (UTC)");
  await page.screenshot({ path: `${SHOT}/desktop-dark-week.png`, fullPage: true });

  await aggregation.getByRole("radio", { name: "Day" }).click();
  await expect(breakdown.getByRole("tab").first()).toHaveText("By Day");
  await expect(tableHead.first()).toHaveText("Day (UTC)");
  // Seven rows, then Show All; the table never scrolls inside the page.
  const rows = page.locator(".usage-tables-section .usage-table tbody tr");
  await expect(rows).toHaveCount(7);
  await page.getByRole("button", { name: "Show All 30 Days" }).click();
  await expect(rows).toHaveCount(30);
  const innerScroll = await page.locator(".usage-tables-section .table-wrap").evaluate((wrap) => wrap.scrollHeight > wrap.clientHeight + 1);
  expect(innerScroll).toBe(false);
});

test("By Agent and By Machine show the names the store knows, never an agent / model key", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  const breakdown = page.getByRole("tablist", { name: "Breakdown" });
  const names = page.locator(".usage-tables-section .usage-table tbody th");
  await breakdown.getByRole("tab", { name: "By Agent" }).click();
  await expect(names).toHaveText(["Claude Code", "Codex App Server", "Gemini CLI"]);
  await expect(page.locator(".usage-tables-section .usage-table tbody")).not.toContainText(" / ");
  await breakdown.getByRole("tab", { name: "By Machine" }).click();
  await expect(names).toHaveText(["Build Box", "Studio Mac"]);
});

test("By Person: one Budget Reached badge and a warning meter, and admins can change the amount", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  await page.getByRole("tablist", { name: "Breakdown" }).getByRole("tab", { name: "By Person" }).click();
  const panel = page.locator("#usage-breakdown-panel");
  await expect(panel).toContainText(
    "Each person can spend $25.00 per UTC day. When they reach it, their new turns pause until midnight UTC.");
  const ada = panel.locator("tbody tr").filter({ hasText: "Ada" });
  await expect(ada.locator(".status")).toHaveText(["Budget Reached"]);
  await expect(ada.locator(".meter.t-warning")).toBeVisible();
  await expect(ada).toContainText("$26.40 of $25.00");
  await expect(panel).not.toContainText("paused by daily budget");
  // Grace's running turn counts toward today, as the daily-budget gate counts it.
  await expect(panel.locator("tbody tr").filter({ hasText: "Grace" })).toContainText("$11.05 of $25.00");
  await expect(panel).toContainText("Today includes an estimate for running turns.");
  await page.screenshot({ path: `${SHOT}/desktop-dark-person.png`, fullPage: true });

  await page.getByRole("button", { name: "Change Budget…" }).click();
  const dialog = page.getByRole("dialog", { name: "Budget and History" });
  const budget = dialog.getByLabel("Daily Budget per Person (Optional)");
  await expect(budget).toBeFocused();
  await budget.fill("30");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toHaveCount(0);
  const toast = page.locator(".toast").filter({ hasText: "Budget and history saved." });
  await expect(toast).toContainText("Daily budget $30.00 per person. Hourly detail 30 days, daily totals 365 days.");
  await expect(panel).toContainText("Each person can spend $30.00 per UTC day.");
  await expect(panel.locator(".status")).toHaveCount(0);
  await expect(ada).toContainText("$26.40 of $30.00");
});

test("Budget and History: an owner opens it from the header, a member sees neither opener nor form (#3015)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  await expect(page.locator(".page-header").getByRole("button", { name: "Budget and History…" })).toBeVisible();
  // The page reports; its only primary is the dialog's Save Changes.
  await expect(page.locator(".page .btn.primary")).toHaveCount(0);
  await expect(page.locator(".page form, .page input")).toHaveCount(0);

  await page.goto("/usage-view-e2e.html?member=1");
  await expect(page.locator(".usage-headline-value")).toContainText("$");
  await expect(page.getByRole("button", { name: "Budget and History…" })).toHaveCount(0);
  await page.getByRole("tablist", { name: "Breakdown" }).getByRole("tab", { name: "By Person" }).click();
  await expect(page.locator("#usage-breakdown-panel")).toContainText("Each person can spend $25.00 per UTC day.");
  await expect(page.getByRole("button", { name: "Change Budget…" })).toHaveCount(0);
  await expect(page.locator(".page form, .page input")).toHaveCount(0);
});

test("Budget and History: -5 and 500 show inline errors, send nothing and raise no browser bubble (#3015)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  await page.getByRole("button", { name: "Budget and History…" }).click();
  const dialog = page.getByRole("dialog", { name: "Budget and History" });
  await dialog.getByLabel("Daily Budget per Person (Optional)").fill("-5");
  await dialog.getByLabel("Hourly Detail").fill("500");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  const budget = dialog.getByLabel("Daily Budget per Person (Optional)");
  const hourly = dialog.getByLabel("Hourly Detail");
  await expect(budget).toHaveAttribute("aria-invalid", "true");
  await expect(hourly).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.locator(".field-error")).toHaveText([
    "Enter an amount of at least $0.01, or leave it empty for no limit.",
    "Enter 1 to 90 days.",
  ]);
  await expect(dialog.locator(".modal-foot")).toContainText("Fix 2 fields to save.");
  await expect(budget).toBeFocused();
  // Both invalid fields draw the --red edge once the field transition settles (§8.5).
  const red = await resolvedRed(page);
  await expect(budget).toHaveCSS("border-top-color", red);
  await expect(hourly).toHaveCSS("border-top-color", red);
  // No native constraint: the form is noValidate and the fields carry no min or max.
  for (const field of [budget, hourly]) {
    expect(await field.evaluate((input: HTMLInputElement) => input.validationMessage)).toBe("");
  }
  await expect(dialog).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("Budget and History: a shorter period asks Shorten Usage History stacked on the desktop dialog (#3015)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  await page.getByRole("button", { name: "Budget and History…" }).click();
  const dialog = page.getByRole("dialog", { name: "Budget and History" });
  await dialog.getByLabel("Hourly Detail").fill("14");
  await expect(dialog.locator(".field-warn")).toHaveText("Shorter than now (30 days). Older hourly detail will be deleted.");
  // A warning is not an error: no aria-invalid, and the edge settles to the ordinary outline.
  const hourly = dialog.getByLabel("Hourly Detail");
  await dialog.getByLabel("Daily Totals").focus();
  await expect(hourly).not.toHaveAttribute("aria-invalid", /.*/);
  await expect(hourly).toHaveCSS("border-top-color", await resolvedColor(page, "var(--control-outline)"));
  await expect(hourly).not.toHaveCSS("border-top-color", await resolvedRed(page));
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  const confirmation = page.getByRole("dialog", { name: "Shorten Usage History" });
  await expect(confirmation).toContainText(/Hourly detail older than 14 days is deleted now, so hourly charts will start at .+\. Daily totals are not affected\. This can't be undone\./);
  // Stacked: both dialogs are visible, the confirmation above the form.
  await expect(dialog).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Back to Budget and History" })).toHaveCount(0);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(dialog.getByLabel("Hourly Detail")).toHaveValue("14");
  await expect(dialog.getByRole("button", { name: "Save Changes" })).toBeFocused();

  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await confirmation.getByRole("button", { name: "Shorten History" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Hourly detail 14 days, daily totals 365 days.");
});

test("Budget and History at 390px: More Actions opens the sheet, and the confirmation replaces it with Back (#3015)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/usage-view-e2e.html");
  await page.getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Budget and History…" }).click();
  const dialog = page.getByRole("dialog", { name: "Budget and History" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Daily Budget per Person (Optional)").fill("40");
  await dialog.getByLabel("Hourly Detail").fill("14");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  const confirmation = page.getByRole("dialog", { name: "Shorten Usage History" });
  await expect(confirmation).toBeVisible();
  // One sheet: the form's panel is hidden under the confirmation, never a second sheet.
  await expect(dialog).toBeHidden();
  await expect(page.locator(".modal-backdrop:not(.stacked)")).toHaveCount(1);
  await confirmation.getByRole("button", { name: "Back to Budget and History" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Daily Budget per Person (Optional)")).toHaveValue("40");
  await expect(dialog.getByLabel("Hourly Detail")).toHaveValue("14");
  await expect(dialog.getByRole("button", { name: "Save Changes" })).toBeFocused();
});

test("Budget and History: when history fails after the budget saved, the notice says so (#3015)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/usage-view-e2e.html?retentionFails=1");
  await page.getByRole("button", { name: "Budget and History…" }).click();
  const dialog = page.getByRole("dialog", { name: "Budget and History" });
  await dialog.getByLabel("Daily Budget per Person (Optional)").fill("40");
  await dialog.getByLabel("Daily Totals").fill("400");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  const notice = dialog.locator(".notice.t-danger");
  await expect(notice).toContainText("Couldn't Save Changes");
  await expect(notice).toContainText("The daily budget was saved. History wasn't changed.");
  await notice.getByRole("button", { name: "Show Details" }).click();
  await expect(notice).toContainText("Usage retention is temporarily unavailable.");
});

const BREAKDOWN_TABS = ["By Day", "By Model", "By Agent", "By Machine", "By Person"] as const;

test("at 390px every Breakdown tab's rows put the name and the total on line 1 and nothing is cut off sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/usage-view-e2e.html");
  const breakdown = page.getByRole("tablist", { name: "Breakdown" });
  for (const label of BREAKDOWN_TABS) {
    await breakdown.getByRole("tab", { name: label }).click();
    const rows = page.locator(".usage-tables-section .usage-table tbody tr");
    await expect(rows.first()).toBeVisible();
    const layout = await rows.evaluateAll((all) => all.map((row) => {
      const name = row.firstElementChild!.getBoundingClientRect();
      const total = row.querySelector(".cell-status")!;
      const totalBox = total.getBoundingClientRect();
      const meta = [...row.querySelectorAll<HTMLElement>(".cell-meta")].filter((cell) => cell.offsetParent !== null);
      return {
        text: row.textContent,
        sameLine: Math.abs((name.top + name.bottom) / 2 - (totalBox.top + totalBox.bottom) / 2) < 6,
        totalWhole: total.scrollWidth <= total.clientWidth + 1,
        metaBelow: meta.every((cell) => cell.getBoundingClientRect().top >= name.bottom - 1),
        inside: [...row.children].every((cell) => cell.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5),
        hiddenAgents: [...row.querySelectorAll<HTMLElement>("[data-driver]")].every((cell) => cell.offsetParent === null),
      };
    }));
    for (const row of layout) {
      expect(row, `${label}: ${row.text}`).toEqual(expect.objectContaining({
        sameLine: true, totalWhole: true, metaBelow: true, inside: true, hiddenAgents: true,
      }));
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  // Line 2 says its unit, since the header row is not on screen.
  await breakdown.getByRole("tab", { name: "By Day" }).click();
  await expect(page.locator(".usage-tables-section tbody .usage-period-trailing").first()).toHaveText(/tokens$/);
  await breakdown.getByRole("tab", { name: "By Person" }).click();
  await expect(page.locator(".usage-person-today").first()).toHaveText(/^\$26\.40 of \$25\.00 today$/);
});

test("at 834px the time table folds its trailing column under the date and keeps the agent headers whole", async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1112 });
  await page.goto("/usage-view-e2e.html");
  const table = page.locator(".usage-tables-section .usage-table");
  await expect(table.locator("thead th.usage-period-trailing")).toBeHidden();
  await expect(table.locator(".usage-period-meta").first()).toBeVisible();
  await expect(table.locator(".usage-period-meta").first()).toHaveText(/tokens$/);
  const headers = await table.locator("thead th.cell-extra").evaluateAll((cells) => cells.map((cell) => ({
    text: cell.textContent,
    // DejaVu on CI is wider than this host's face: a header needs room to spare, not just to fit.
    spare: cell.clientWidth - cell.scrollWidth,
  })));
  expect(headers.map((header) => header.text)).toEqual(["Claude Code", "Codex", "Gemini CLI"]);
  for (const header of headers) expect(header.spare, header.text ?? "").toBeGreaterThanOrEqual(0);
  const widths = await table.locator("thead th.cell-extra").evaluateAll((cells) => cells.map((cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    const style = getComputedStyle(cell);
    return cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - range.getBoundingClientRect().width;
  }));
  for (const width of widths) expect(width).toBeGreaterThanOrEqual(12);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(table.locator("thead th.usage-period-trailing")).toBeVisible();
  await expect(table.locator(".usage-period-meta").first()).toBeHidden();
});

test("light theme and the coverage notice for unpriced records and a cached rate table", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html?theme=light&unpriced=1");
  const notice = page.locator(".usage-notice");
  await expect(notice).toContainText("could not be fully priced");
  await expect(notice).toContainText("could not be refreshed");
  await page.screenshot({ path: `${SHOT}/desktop-light-unpriced.png`, fullPage: true });

  await page.goto("/usage-view-e2e.html?theme=light&empty=1");
  await expect(page.locator(".usage-chart-empty")).toBeVisible();
  await expect(page.locator(".usage-notice")).toHaveCount(0);
});

test.describe("with a touch pointer", () => {
  // The 44px trigger size is a touch size, keyed to the pointer rather than the viewport (#1799).
  test.use({ hasTouch: true });

  test("mobile: one toolbar row of Metric, the range sheet's button and the About icon, each reachable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/usage-view-e2e.html");
    const toolbar = page.locator(".usage-toolbar");
    const metric = toolbar.getByRole("radiogroup", { name: "Metric" });
    const range = toolbar.getByRole("button", { name: "Range and Group By: 30 Days, Daily" });
    const about = toolbar.getByRole("button", { name: "About These Numbers" });
    await expect(range).toHaveText("30 Days, Daily");
    await expect(about).toHaveText("");
    // One row, in this order; DejaVu on CI is wider than this host's face, so only the order and
    // the row are pinned, not exact widths.
    const boxes = await Promise.all([metric, range, about].map(async (locator) => (await locator.boundingBox())!));
    expect(new Set(boxes.map((box) => Math.round(box.y + box.height / 2))).size).toBe(1);
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x);
    expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x);
    for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("radiogroup", { name: "Group By" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(page.locator(".usage-headline-value")).toBeVisible();

    await metric.getByRole("radio", { name: "Tokens" }).click();
    await expect(page.locator(".usage-headline-value")).toContainText("M");
    // The button opens one sheet with a Range and a Group By section.
    await range.click();
    const sheet = page.getByRole("menu", { name: "Range and Group By" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".menu-label")).toHaveText(["Range", "Group By"]);
    await page.screenshot({ path: `${SHOT}/mobile-dark-range-sheet.png` });
    await sheet.getByRole("menuitemradio", { name: "Week" }).click();
    await expect(page.locator(".usage-chart-svg title")).toContainText("Weekly processed tokens");
    await expect(page.getByRole("button", { name: "Range and Group By: 30 Days, Weekly" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOT}/mobile-dark-tokens.png`, fullPage: true });
  });

  test("mobile: About These Numbers is a bottom sheet that Escape closes without leaving the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/usage-view-e2e.html");
    const about = page.locator(".usage-toolbar").getByRole("button", { name: "About These Numbers" });
    await about.click();
    const sheet = page.getByRole("dialog", { name: "About These Numbers" });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.y + box.height)).toBe(844);
    await expect(sheet).toContainText("Recording started Jul 1, 2026.");
    await page.screenshot({ path: `${SHOT}/mobile-dark-about.png` });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/usage-view-e2e\.html$/);
    await expect(about).toBeFocused();
  });
});

test("at 1440px the header, the tabs and the toolbar are all that sit above the overview", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/usage-view-e2e.html?unpriced=0");
  await expect(page.locator(".usage-headline-value")).toContainText("$");
  const above = await page.evaluate(() => {
    const overview = document.querySelector(".usage-overview")!.getBoundingClientRect().top;
    // Every visible element with text of its own that starts above the overview.
    const ownText = (node: Element) => [...node.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join("").trim();
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((node) => ownText(node) !== "" && !node.closest(".sr-only"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < overview && getComputedStyle(node).visibility !== "hidden";
      })
      .map((node) => ({ text: ownText(node), region: node.closest(".page-header") ? "header" : node.closest(".usage-toolbar") ? "toolbar" : "other" }));
  });
  expect(above.filter((item) => item.region === "other"), "nothing but the header and the toolbar sits above the overview").toEqual([]);
  expect(above.map((item) => item.text)).toEqual(expect.arrayContaining(["Usage and Cost", "API Usage", "Subscriptions", "Cost", "Tokens", "Last 30 Days", "Hour", "Day", "Week", "About These Numbers"]));
  await expect(page.getByText(/published API rates|Recording started|Only totals are stored/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/desktop-1440-dark-api.png` });

  // The caveats are one click away and leave again on Escape.
  const about = page.getByRole("button", { name: "About These Numbers" });
  await about.click();
  const popover = page.getByRole("dialog", { name: "About These Numbers" });
  await expect(popover).toContainText("These are estimates at published API rates, not a bill. Subscription plans are not billed this way.");
  await expect(popover).toContainText("Recording started Jul 1, 2026. Earlier usage isn't in these charts.");
  await expect(popover).not.toContainText(/\d{1,2}:\d{2}/);
  await expect(popover).toContainText("Codex App Server usage recorded before a machine's Wollipog update includes only the final response of each turn, so it is incomplete. Usage recorded since then counts every response.");
  await expect(popover).toContainText("Only totals are stored: no prompts, file paths, tool inputs or session content.");
  await expect(popover.getByRole("link", { name: "raw.githubusercontent.com" })).toHaveAttribute("href", /^https:\/\/raw\.githubusercontent\.com\//);
  await page.screenshot({ path: `${SHOT}/desktop-1440-dark-about.png` });
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(about).toBeFocused();

  // The Range menu: radio items within daily retention, the ones that allow Hour saying so.
  await page.getByRole("button", { name: "Range: Last 30 Days" }).click();
  const menu = page.getByRole("menu", { name: "Range" });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
  await expect(menu.getByRole("menuitemradio", { name: "Last 30 Days" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "Last 7 Days" })).toHaveAccessibleDescription("Hour grouping is available for ranges up to 30 days.");
  await page.screenshot({ path: `${SHOT}/desktop-1440-dark-range.png` });
  await menu.getByRole("menuitemradio", { name: "Last 90 Days" }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "Range: Last 90 Days" })).toBeVisible();
  // Past hourly retention Hour is omitted, never shown disabled.
  await expect(page.getByRole("radiogroup", { name: "Group By" }).getByRole("radio")).toHaveText(["Day", "Week"]);
});

/** Each fact's label and value boxes, and whether the label is cut off. */
const factBoxes = (page: Page) => page.locator(".usage-facts > div").evaluateAll((pairs) => pairs.map((pair) => {
  const box = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  };
  const label = pair.querySelector("dt")!;
  return {
    label: label.textContent,
    pair: box(pair),
    dt: box(label),
    dd: box(pair.querySelector("dd")!),
    truncated: label.scrollWidth > label.clientWidth + 1,
  };
}));

test("at 1440px the overview puts the headline column beside the chart over one facts strip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/usage-view-e2e.html");
  const caption = page.locator(".usage-headline-note").first();
  await expect(caption).toHaveText("Estimated API cost, Aug 5 – Sep 3");
  const headline = (await page.locator(".usage-headline").boundingBox())!;
  const chart = (await page.locator(".usage-chart-section").boundingBox())!;
  expect(headline.width).toBeGreaterThanOrEqual(240);
  expect(headline.width).toBeLessThanOrEqual(280);
  expect(chart.x).toBeGreaterThan(headline.x + headline.width);
  expect(Math.abs(chart.y - headline.y)).toBeLessThanOrEqual(1);
  await expect(page.locator(".usage-chart-section h3")).toHaveCount(0);
  await expect(page.locator(".usage-facts dt")).toHaveText(["Processed Tokens", "Cached Input", "Uncached Input", "Output", "Cache Savings"]);
  const cost = await page.locator(".usage-headline-value").textContent();

  await page.getByRole("radio", { name: "Tokens" }).click();
  await expect(caption).toHaveText("Processed tokens, Aug 5 – Sep 3");
  await expect(page.locator(".usage-facts dt")).toHaveText([
    "Processed Tokens", "Cached Input", "Uncached Input", "Output", "Cache Savings", "Estimated Cost",
  ]);
  await expect(page.locator(".usage-facts dd").last()).toHaveText(cost!);
  // Six facts sit on one row.
  const facts = await factBoxes(page);
  expect(new Set(facts.map((fact) => Math.round(fact.pair.top))).size).toBe(1);
  expect(facts.filter((fact) => fact.truncated)).toEqual([]);
});

test("recent coverage: the caption says when recording started instead of counting days", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/usage-view-e2e.html?coverage=recent");
  const caption = page.locator(".usage-headline-note").first();
  await expect(caption).toHaveText("Estimated API cost since Sep 2, when recording started");
  await page.getByRole("radio", { name: "Tokens" }).click();
  await expect(caption).toHaveText("Processed tokens since Sep 2, when recording started");
  await expect(page.locator("main")).not.toContainText(/\b1 days?\b/);
});

test("at 834px the overview stacks, five facts keep one row and six wrap to three columns by two rows", async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  // Cost mode's five facts never wrap into a row with an empty cell.
  await expect(page.locator(".usage-facts dt")).toHaveCount(5);
  const five = await factBoxes(page);
  expect(new Set(five.map((fact) => Math.round(fact.pair.top))).size).toBe(1);
  expect(five.filter((fact) => fact.truncated)).toEqual([]);
  await page.screenshot({ path: `${SHOT}/compact-834-dark-cost.png`, fullPage: true });

  await page.getByRole("radio", { name: "Tokens" }).click();
  await expect(page.locator(".usage-facts dt")).toHaveCount(6);
  const headline = (await page.locator(".usage-headline").boundingBox())!;
  const chart = (await page.locator(".usage-chart-section").boundingBox())!;
  expect(chart.y).toBeGreaterThanOrEqual(headline.y + headline.height);

  const facts = await factBoxes(page);
  const rows = [...new Set(facts.map((fact) => Math.round(fact.pair.top)))];
  const columns = [...new Set(facts.map((fact) => Math.round(fact.pair.left)))];
  expect(rows).toHaveLength(2);
  expect(columns).toHaveLength(3);
  // Fonts on CI are wider than on a workstation, so only clipping is checked, not exact widths.
  expect(facts.filter((fact) => fact.truncated)).toEqual([]);
  await page.screenshot({ path: `${SHOT}/compact-834-dark-tokens.png`, fullPage: true });
});

test("a desktop main column narrowed by a docked panel turns the facts strip into rows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/usage-view-e2e.html");
  // The main column is the `app` container; a docked panel can leave it this narrow on a desktop.
  await page.addStyleTag({ content: ".main { width: 480px; }" });
  for (const metric of ["Cost", "Tokens"] as const) {
    await page.getByRole("radio", { name: metric }).click();
    await expect(page.locator(".usage-facts dt")).toHaveCount(metric === "Cost" ? 5 : 6);
    const strip = (await page.locator(".usage-facts").boundingBox())!;
    const facts = await factBoxes(page);
    expect(new Set(facts.map((fact) => Math.round(fact.pair.top))).size).toBe(facts.length);
    for (const fact of facts) {
      expect(Math.abs(fact.dd.right - (strip.x + strip.width))).toBeLessThanOrEqual(1);
      expect(fact.dt.right).toBeLessThanOrEqual(fact.dd.left);
    }
    expect(facts.filter((fact) => fact.truncated)).toEqual([]);
  }
  // Just wide enough for five side by side: one row, no label spills out of its cell.
  await page.addStyleTag({ content: ".main { width: 640px; }" });
  await page.getByRole("radio", { name: "Cost" }).click();
  const five = await factBoxes(page);
  expect(new Set(five.map((fact) => Math.round(fact.pair.top))).size).toBe(1);
  expect(five.filter((fact) => fact.truncated)).toEqual([]);
});

test("at 390px the facts strip is rows, label left and value right", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/usage-view-e2e.html");
  await page.getByRole("radio", { name: "Tokens" }).click();
  await expect(page.locator(".usage-facts dt")).toHaveCount(6);
  const strip = (await page.locator(".usage-facts").boundingBox())!;
  const facts = await factBoxes(page);
  expect(new Set(facts.map((fact) => Math.round(fact.pair.top))).size).toBe(6);
  for (const fact of facts) {
    expect(Math.abs(fact.dt.left - strip.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(fact.dd.right - (strip.x + strip.width))).toBeLessThanOrEqual(1);
    expect(fact.dt.right).toBeLessThanOrEqual(fact.dd.left);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("with 14 days of hourly retention Hour appears only on Last 7 Days", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/usage-view-e2e.html?hourlyDays=14");
  const groupBy = page.getByRole("radiogroup", { name: "Group By" });
  await expect(groupBy.getByRole("radio")).toHaveText(["Day", "Week"]);
  await page.getByRole("button", { name: "Range: Last 30 Days" }).click();
  await page.getByRole("menu", { name: "Range" }).getByRole("menuitemradio", { name: "Last 7 Days" }).click();
  await expect(groupBy.getByRole("radio")).toHaveText(["Hour", "Day", "Week"]);
  await expect(page.locator('[role="radio"][aria-disabled="true"]', { hasText: "Hour" })).toHaveCount(0);
});

test("against a plane without weekly support Group By has no Week and the Range menu ends with why", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/usage-view-e2e.html?noWeek=1");
  await expect(page.getByRole("radiogroup", { name: "Group By" }).getByRole("radio")).toHaveText(["Hour", "Day"]);
  await page.getByRole("button", { name: "Range: Last 30 Days" }).click();
  await expect(page.locator(".menu > :last-child")).toHaveText("Week grouping needs a newer version of Wollipog.");
  await page.screenshot({ path: `${SHOT}/desktop-dark-range-no-week.png` });
});

test("the tabs are the URL: switching pushes it and Back returns to the previous tab", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/command-inbox-projects-e2e.html?fullShell=1&history=1&path=%2Fusage%2Fsubscriptions");
  const tabs = page.getByRole("tablist", { name: "Usage and Cost" });
  await expect(tabs.getByRole("tab", { name: /^Subscriptions/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".usage-toolbar")).toHaveCount(0);

  await tabs.getByRole("tab", { name: "API Usage" }).click();
  await expect(tabs.getByRole("tab", { name: "API Usage" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/path=%2Fusage(&|$)/);
  await expect(page.locator(".usage-toolbar")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/path=%2Fusage%2Fsubscriptions/);
  await expect(tabs.getByRole("tab", { name: /^Subscriptions/ })).toHaveAttribute("aria-selected", "true");
});

test("the Subscriptions tab counts its Approaching Limit and Exhausted badges", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/usage-view-e2e.html?subscriptions=1");
  const tab = page.getByRole("tab", { name: /^Subscriptions/ });
  await tab.click();
  await expect(page).toHaveURL(/tab=subscriptions/);
  const badges = page.locator("#usage-subscriptions-panel .subscription-bucket .status")
    .filter({ hasText: /^(Approaching Limit|Exhausted)$/ });
  const count = await badges.count();
  expect(count).toBeGreaterThan(0);
  await expect(tab.locator(".count-badge")).toHaveText(String(count));
  await expect(tab).toHaveAccessibleName(`Subscriptions, ${count} Need Attention`);
  await page.screenshot({ path: `${SHOT}/desktop-1440-dark-subscriptions.png`, fullPage: true });
  await page.goBack();
  await expect(page.getByRole("tab", { name: "API Usage" })).toHaveAttribute("aria-selected", "true");
});

test("subscription cards show provider allowances in presentation order (#223, #224)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html?tab=subscriptions&subscriptions=1");
  const cards = page.locator(".subscription-source");
  await expect(cards).toHaveCount(4);

  // #223: the runner normalizes the account-wide Codex group before model-specific groups, and
  // the shared desktop/mobile renderer preserves that order without matching display labels.
  const codex = cards.filter({ hasText: "Codex App Server on build-box" });
  await expect(codex.locator("h4")).toHaveText("Codex — Pro");
  await expect(codex.getByRole("button", { name: "Refresh Account" })).toBeVisible();
  await expect(codex.locator(".subscription-bucket dt")).toHaveText([
    "Codex — Weekly",
    "GPT-5.3-Codex-Spark — 5-Hour Window",
    "GPT-5.3-Codex-Spark — Weekly",
  ]);

  // A current Claude build: every window it tracks is listed independently, with real percentages
  // rather than the bare "Allowance Reported" fallback.
  const current = cards.filter({ hasText: "Claude Code on build-box" }).first();
  await expect(current.locator("h4")).toHaveText("Claude — Max");
  // #1648: account emails are masked by default and revealed only by an explicit action.
  await expect(current.locator(".subscription-account")).not.toContainText("primary@example.com");
  await current.getByRole("button", { name: "Show Account Email" }).click();
  await expect(current.locator(".subscription-account .pid-value")).toHaveText("primary@example.com");
  await expect(current.getByRole("button", { name: "Refresh Account" })).toHaveCount(0);
  const buckets = current.locator(".subscription-bucket");
  await expect(buckets).toHaveCount(3);
  await expect(buckets.nth(0)).toContainText("Five-Hour Window");
  await expect(buckets.nth(0)).toContainText("17% Remaining");
  await expect(buckets.nth(0)).toContainText("83% Used");
  await expect(buckets.nth(0)).toContainText("Approaching Limit");
  await expect(buckets.nth(1)).toContainText("Weekly — All Models");
  await expect(buckets.nth(1)).toContainText("54% Remaining");
  await expect(buckets.nth(2)).toContainText("Weekly — Extra Usage");
  await expect(buckets.nth(2)).toContainText("88% Remaining");
  await expect(current).not.toContainText("Allowance Reported");

  // A build that reports resets but no utilization says so, instead of reading as a source that
  // has not answered yet.
  const resetOnly = cards.filter({ hasText: "Claude Code (Ubuntu)" }).first();
  await expect(resetOnly.locator(".subscription-account")).not.toContainText("alternate@example.com");
  await expect(resetOnly.getByRole("button", { name: "Show Account Email" })).toBeVisible();
  await expect(resetOnly.getByRole("button", { name: "Refresh Account" })).toHaveCount(0);
  await expect(resetOnly).toContainText("without utilization percentages");
  await expect(resetOnly).not.toContainText("after the first provider response");

  // #872: the unmeasured window marks its missing percentage rather than putting a non-value
  // where every sibling shows one, and its reset time becomes the prominent fact instead.
  const unmeasured = resetOnly.locator(".subscription-bucket.unmeasured");
  await expect(unmeasured).toHaveCount(2);
  await expect(resetOnly).not.toContainText("Allowance Reported");
  await expect(unmeasured.first().locator(".subscription-unmeasured")).toHaveText("—Utilization Not Reported");
  await expect(unmeasured.first().locator("dd strong")).toContainText("Resets in");

  // A status-only warning is still unmeasured, and its promoted reset keeps the warning colour:
  // the size rule is declared before the status rules so only weight and size come from it.
  const warned = unmeasured.nth(1);
  await expect(warned).toHaveClass(/warning/);
  await expect(warned).toContainText("Approaching Limit");
  const warnColour = await warned.locator("dd strong").evaluate((el) => getComputedStyle(el).color);
  const plainColour = await unmeasured.first().locator("dd strong").evaluate((el) => getComputedStyle(el).color);
  expect(warnColour).not.toBe(plainColour);
  // A measured window is untouched: its percentage keeps the prominent slot.
  await expect(buckets.nth(0)).not.toHaveClass(/unmeasured/);
  await expect(buckets.nth(0).locator("dd strong").first()).toHaveText("17% Remaining");

  // A source that answered without allowance headers gets its own explanation.
  const noHeaders = cards.filter({ hasText: "Claude Code (Debian)" }).first();
  await expect(noHeaders.locator(".subscription-account")).toHaveCount(0);
  await expect(noHeaders).toContainText("Temporarily Unavailable");
  await expect(noHeaders).toContainText("answered without reporting subscription allowances");
  await expect(noHeaders).not.toContainText("after the first provider response");

  await page.locator(".subscription-source-grid").screenshot({ path: `${SHOT}/subscription-claude-dark.png` });
  await page.goto("/usage-view-e2e.html?tab=subscriptions&subscriptions=1&theme=light");
  await expect(current.locator(".subscription-bucket").first()).toContainText("17% Remaining");
  await page.locator(".subscription-source-grid").screenshot({ path: `${SHOT}/subscription-claude-light.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/usage-view-e2e.html?tab=subscriptions&subscriptions=1");
  const mobileCurrent = page.locator(".subscription-source").filter({ hasText: "Claude Code on build-box" }).first();
  // A reload starts hidden again, including on the mobile layout.
  await expect(mobileCurrent.locator(".subscription-account")).not.toContainText("primary@example.com");
  await expect(mobileCurrent.getByRole("button", { name: "Show Account Email" })).toBeVisible();
  await expect(mobileCurrent.locator("h4")).toHaveText("Claude — Max");
  await expect(mobileCurrent).toBeVisible();
  await page.locator(".subscription-source-grid").screenshot({ path: `${SHOT}/subscription-claude-mobile.png` });
});

test("a missing selected installation appears as one unsupported usage source", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/usage-view-e2e.html?tab=subscriptions&subscriptions=1&selectedUnavailable=1");
  const codex = page.locator(".subscription-source").filter({ hasText: "Codex App Server on build-box" });
  await expect(codex).toHaveCount(1);
  await expect(codex).toContainText("The selected harness installation is unavailable");
  await codex.screenshot({ path: `${SHOT}/selected-installation-unavailable-desktop.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(codex).toBeVisible();
  await codex.screenshot({ path: `${SHOT}/selected-installation-unavailable-mobile.png` });
});
