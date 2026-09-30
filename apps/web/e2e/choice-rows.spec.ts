import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #1952: ChoiceRows, ChoiceList and the Checkbox row (docs/design-system.md §8.4) in a browser.
 *
 * Three things only a rendering engine can answer: whether the markers of rows with different
 * heights still form one column, what the platform's arrow keys and Space do to native inputs, and
 * how tall a row's hit area is under a coarse pointer. Every size compared here is fixed by the
 * stylesheet (the 16px marker, the 20px title line, the row tokens) rather than by text advance,
 * so the comparisons are exact.
 */

const group = (page: Page, name: string) => page.locator(`[data-group="${name}"]`);
const value = (page: Page, name: string) => group(page, name).getAttribute("data-value");

/** The marker's centre and its title's first line, per row, plus the row heights. */
async function markerColumn(rows: Locator) {
  return rows.evaluateAll((elements) => elements.map((row) => {
    const marker = row.querySelector("input")!.getBoundingClientRect();
    const title = row.querySelector<HTMLElement>(".choice-row-title")!;
    const titleBox = title.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
    return {
      left: marker.left,
      width: marker.width,
      height: marker.height,
      markerCentre: marker.top + marker.height / 2,
      firstLineCentre: titleBox.top + lineHeight / 2,
      titleLeft: titleBox.left,
      rowHeight: row.getBoundingClientRect().height,
    };
  }));
}

for (const theme of ["dark", "light"] as const) {
  test(`markers of rows with different heights form one column, aligned to each title's first line (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`/choice-rows-e2e.html?theme=${theme}`);
    for (const name of ["preset", "agents", "worktree"]) {
      const rows = group(page, name).locator(".choice-row");
      const column = await markerColumn(rows);
      expect(column.length, `${name} renders rows`).toBeGreaterThan(1);
      // Not vacuous: the rows the claim is about really are of different heights.
      if (name !== "worktree") {
        expect(new Set(column.map((row) => Math.round(row.rowHeight))).size, `${name} mixes row heights`).toBeGreaterThan(1);
      }
      for (const row of column) {
        expect(row.width).toBe(16);
        expect(row.height).toBe(16);
        expect(row.left, `${name}: every marker shares the first marker's x`).toBe(column[0]!.left);
        expect(Math.abs(row.markerCentre - row.firstLineCentre), `${name}: the marker sits on its title's first line`)
          .toBeLessThanOrEqual(0.5);
        expect(row.titleLeft, `${name}: the marker leads the title`).toBeGreaterThan(row.left + row.width);
      }
    }
  });
}

test("arrow keys move the selection among radio rows and reach, without selecting, a disabled one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/choice-rows-e2e.html");
  const preset = group(page, "preset");
  const radio = (name: string) => preset.getByRole("radio", { name });
  await radio("Quick").focus();
  await page.keyboard.press("ArrowDown");
  await expect(radio("Reviewed")).toBeFocused();
  await expect(radio("Reviewed")).toBeChecked();
  expect(await value(page, "preset")).toBe("reviewed");

  await page.keyboard.press("ArrowDown");
  expect(await value(page, "preset")).toBe("orchestrated");
  // The unavailable row is reachable, so its reason can be read; arriving does not choose it.
  await page.keyboard.press("ArrowDown");
  await expect(radio("Remote Box")).toBeFocused();
  await expect(radio("Remote Box")).not.toBeChecked();
  await expect(radio("Remote Box")).toHaveAccessibleDescription(/No machine is connected/);
  await expect(radio("Orchestrated")).toBeChecked();
  expect(await value(page, "preset")).toBe("orchestrated");
  // Nor does Space on it.
  await page.keyboard.press("Space");
  await expect(radio("Remote Box")).not.toBeChecked();
  expect(await value(page, "preset")).toBe("orchestrated");

  await page.keyboard.press("ArrowDown");
  await expect(radio("Custom")).toBeChecked();
  expect(await value(page, "preset")).toBe("custom");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  expect(await value(page, "preset")).toBe("orchestrated");

  // One tab stop for the group: Tab leaves it for the next group.
  await radio("Orchestrated").focus();
  await page.keyboard.press("Tab");
  await expect(group(page, "agents").getByRole("checkbox", { name: "Claude Code" })).toBeFocused();
});

test("Space toggles a checkbox row and a multiple ChoiceRow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/choice-rows-e2e.html");
  const codex = group(page, "agents").getByRole("checkbox", { name: "Codex" });
  await codex.focus();
  await page.keyboard.press("Space");
  await expect(codex).toBeChecked();
  expect(await value(page, "agents")).toBe("claude,codex");
  await page.keyboard.press("Space");
  expect(await value(page, "agents")).toBe("claude");

  const pi = group(page, "agents").getByRole("checkbox", { name: "Pi" });
  await pi.focus();
  await page.keyboard.press("Space");
  await expect(pi).not.toBeChecked();
  expect(await value(page, "agents")).toBe("claude");

  const succeeded = group(page, "checks").getByRole("checkbox", { name: "Succeeded" });
  await succeeded.focus();
  await page.keyboard.press("Space");
  await expect(succeeded).toBeChecked();
  expect(await value(page, "checks")).toBe("started,succeeded");
});

test("clicking anywhere on a row selects it, and a disabled row refuses the click", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/choice-rows-e2e.html");
  const rows = group(page, "preset").locator(".choice-row");
  // The far end of the row, well away from the marker and the text.
  const reviewed = rows.nth(1);
  const box = (await reviewed.boundingBox())!;
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  expect(await value(page, "preset")).toBe("reviewed");
  // The description line.
  await rows.nth(2).locator(".choice-row-desc").click();
  expect(await value(page, "preset")).toBe("orchestrated");
  // Disabled: the row's reason line, and the row itself.
  // `force`: Playwright treats an `aria-disabled` control's label as not enabled and would wait.
  await rows.nth(3).locator(".choice-row-reason").click({ force: true });
  await rows.nth(3).click({ force: true });
  expect(await value(page, "preset")).toBe("orchestrated");
  await expect(group(page, "preset").getByRole("radio", { name: "Remote Box" })).not.toBeChecked();

  // ChoiceList: its trailing value is part of the target.
  await group(page, "worktree").locator(".choice-row-meta", { hasText: "fix/issue-1952" }).click();
  expect(await value(page, "worktree")).toBe("fix");

  // A checkbox row: the label toggles it; a disabled one does not.
  await group(page, "checks").getByText("Include Session Name", { exact: true }).click();
  expect(await value(page, "checks")).toBe("started,sessionName");
  await group(page, "checks").getByText("Session names are excluded unless selected.").click();
  expect(await value(page, "checks")).toBe("started");
  await group(page, "checks").getByText("Expired", { exact: true }).click({ force: true });
  expect(await value(page, "checks")).toBe("started");
});

test("a selected row takes --surface-selected from its checked input, and a disabled row keeps its size", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/choice-rows-e2e.html");
  const rows = group(page, "preset").locator(".choice-row");
  const surface = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--surface-selected)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  const backgrounds = await rows.evaluateAll((elements) => elements.map((row) => getComputedStyle(row).backgroundColor));
  expect(backgrounds[0]).toBe(surface);
  expect(backgrounds.slice(1).every((colour) => colour !== surface)).toBe(true);

  // The disabled row is laid out like its enabled neighbours: the same padding and marker, with the
  // reason on the line a description would use.
  const [enabled, disabled] = await Promise.all([rows.nth(1), rows.nth(3)].map((row) => row.evaluate((element) => {
    const style = getComputedStyle(element);
    return { padding: style.padding, minHeight: style.minHeight };
  })));
  expect(disabled).toEqual(enabled);
  await expect(rows.nth(3).locator(".choice-row-reason")).toBeVisible();
});

test.describe("descriptions", () => {
  test("are one ellipsized line on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/choice-rows-e2e.html");
    const description = group(page, "preset").locator(".choice-row-desc").filter({ hasText: "Delegate implementation" });
    const measure = await description.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight),
      overflow: element.scrollWidth > element.clientWidth,
      textOverflow: getComputedStyle(element).textOverflow,
    }));
    expect(measure.height).toBe(measure.lineHeight);
    expect(measure.overflow).toBe(true);
    expect(measure.textOverflow).toBe("ellipsis");
    // The full text is still the tooltip and the accessible description.
    await expect(description).toHaveAttribute("title", /cannot change after creation\.$/);
    await expect(group(page, "preset").getByRole("radio", { name: "Orchestrated" }))
      .toHaveAccessibleDescription(/cannot change after creation\.$/);
  });

  test("wrap to at most two lines on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1100 });
    await page.goto("/choice-rows-e2e.html");
    const description = group(page, "preset").locator(".choice-row-desc").filter({ hasText: "Delegate implementation" });
    const measure = await description.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(measure.height).toBe(measure.lineHeight * 2);
  });
});

test.describe("with a coarse pointer at 390px", () => {
  test.use({ viewport: { width: 390, height: 1100 }, hasTouch: true });

  test("every checkbox row and choice row is at least 44px of hit area", async ({ page }) => {
    await page.goto("/choice-rows-e2e.html");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const targets = page.locator("label.checkbox, label.choice-row");
    expect(await targets.count()).toBe(16);
    const hits = await targets.evaluateAll((elements) => elements.map((row) => {
      const box = row.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      // `elementFromPoint` half a pixel inside each edge, at the edge's midpoint (a rounded corner
      // is not part of the box a pointer hits): the row itself, or something inside it, has to be
      // what a finger there lands on.
      const owns = (px: number, py: number) => document.elementFromPoint(px, py)?.closest("label") === row;
      return {
        name: row.textContent,
        height: box.height,
        edges: [owns(x, box.top + 0.5), owns(x, box.bottom - 0.5), owns(box.left + 0.5, y), owns(box.right - 0.5, y)],
      };
    }));
    for (const hit of hits) {
      expect(hit.height, `${hit.name} is at least 44px tall`).toBeGreaterThanOrEqual(44);
      expect(hit.edges, `${hit.name} owns its top, bottom, left and right edges`).toEqual([true, true, true, true]);
    }
  });

  test("a wrapped checkbox label keeps its box on the first line, and a one-line row stays centred (#2044)", async ({ page }) => {
    await page.goto("/choice-rows-e2e.html");
    const rows = await group(page, "checks").locator("label.checkbox").evaluateAll((elements) => elements.map((row) => {
      const marker = row.querySelector("input")!.getBoundingClientRect();
      const label = row.querySelector<HTMLElement>(".checkbox-label")!;
      const labelBox = label.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return {
        name: label.textContent,
        markerCentre: marker.top + marker.height / 2,
        firstLineCentre: labelBox.top + parseFloat(getComputedStyle(label).lineHeight) / 2,
        lines: Math.round(labelBox.height / parseFloat(getComputedStyle(label).lineHeight)),
        rowCentre: box.top + box.height / 2,
      };
    }));
    const consent = rows.find((row) => row.name?.startsWith("I understand this deletes"))!;
    // Not vacuous: at this width the consent sentence really does wrap.
    expect(consent.lines).toBe(2);
    expect(Math.abs(consent.markerCentre - consent.firstLineCentre), "the box sits on the first line").toBeLessThanOrEqual(0.5);
    for (const name of ["Started", "Succeeded", "Expired"]) {
      const row = rows.find((candidate) => candidate.name === name)!;
      expect(row.lines).toBe(1);
      expect(Math.abs(row.markerCentre - row.rowCentre), `${name}: the box is centred in its row`).toBeLessThanOrEqual(0.5);
    }
  });
});
