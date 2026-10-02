import { expect, test, type Locator, type Page } from "@playwright/test";

/** #2168: a run of work is one ledger line; its open steps sit on one rule and keep their focus ring. */

async function open(page: Page, width: number, theme: "dark" | "light") {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/timeline-reflow-e2e.html?ledger=1&theme=${theme}`);
  await expect(page.locator("[data-virtual-kind='timeline']")).toHaveAttribute("data-virtual-measurements", "ready");
}

const ledger = (page: Page, index: number) => page.locator(".tl-work > .disclosure-trigger").nth(index);

/** The chevron's centre and every rule's x under a row, in page coordinates. */
async function chevronCentre(trigger: Locator): Promise<number> {
  return trigger.locator(".disclosure-chevron").evaluate((chevron) => {
    const box = chevron.getBoundingClientRect();
    return box.left + box.width / 2;
  });
}

async function rulesUnder(row: Locator): Promise<number[]> {
  return row.evaluate((element) => {
    const rules: number[] = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.classList.contains("tl-work-rule")) {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (style.borderLeftWidth !== "1px" || style.borderLeftStyle !== "solid") throw new Error("a rule is a 1px solid line");
        rules.unshift(box.left + 0.5);
      }
    }
    return rules;
  });
}

for (const width of [1440, 390]) {
  test(`the ledger line is one line with every count, and its steps sit on a rule under its chevron at ${width}px`, async ({ page }) => {
    await open(page, width, "dark");
    const settled = ledger(page, 1);
    await expect(settled).toHaveAccessibleName(/^Worked for 25s\s*4 Commands\s*1 Edit\s*1 Failed$/);
    const line = await settled.evaluate((trigger) => {
      const meta = trigger.querySelector<HTMLElement>(".tl-work-meta")!;
      const failed = trigger.querySelector<HTMLElement>(".tl-work-failed")!;
      const probe = document.createElement("span");
      probe.style.color = "var(--danger-text)";
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      const lineHeight = Number.parseFloat(getComputedStyle(trigger).lineHeight);
      return {
        height: trigger.querySelector<HTMLElement>(".tl-work-title")!.getBoundingClientRect().height,
        lineHeight,
        metaClipped: meta.scrollWidth > meta.clientWidth + 0.5,
        failedColour: getComputedStyle(failed).color,
        danger,
        failedIcon: Boolean(failed.querySelector("svg")),
      };
    });
    expect(line.height, "the title never wraps").toBeLessThanOrEqual(line.lineHeight + 0.5);
    expect(line.metaClipped, "every count is present at this width").toBe(false);
    expect(line.failedColour).toBe(line.danger);
    expect(line.failedIcon).toBe(true);

    await settled.click();
    const chevron = await chevronCentre(settled);
    const steps = page.locator(".tl-step");
    await expect(steps).toHaveCount(6);
    for (const step of await steps.all()) {
      const rules = await rulesUnder(step);
      expect(rules).toHaveLength(1);
      expect(Math.abs(rules[0]! - chevron), "the rule starts under the chevron's centre").toBeLessThanOrEqual(1);
    }
    // The rule never breaks between flush rows: each row's rule meets the next one.
    const gaps = await page.locator("[data-virtual-row]").evaluateAll((rows) => {
      const rules = rows.map((row) => row.querySelector(":scope > .tl-work-rule")).filter((rule): rule is Element => Boolean(rule));
      return rules.slice(1).map((rule, index) => rule.getBoundingClientRect().top - rules[index]!.getBoundingClientRect().bottom);
    });
    for (const gap of gaps) expect(Math.abs(gap)).toBeLessThanOrEqual(0.5);

    // A nested agent's steps add one rule under that agent's chevron, with no inline margin.
    // The harness's control panel overlaps the first turn on a phone, so toggle it from the keyboard.
    await ledger(page, 0).focus();
    await page.keyboard.press("Enter");
    const agent = page.locator(".tl-subagent .subagent-toggle");
    const agentChevron = await chevronCentre(agent);
    const nested = page.locator(".tl-step", { hasText: "Search" });
    const nestedRules = await rulesUnder(nested);
    expect(nestedRules).toHaveLength(2);
    expect(Math.abs(nestedRules[0]! - await chevronCentre(ledger(page, 0)))).toBeLessThanOrEqual(1);
    expect(Math.abs(nestedRules[1]! - agentChevron)).toBeLessThanOrEqual(1);
    await expect(page.locator(".timeline [style*='margin']")).toHaveCount(0);

    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("tabbing through an open group paints a focus ring outside every step", async ({ page }) => {
  await open(page, 1440, "dark");
  const settled = ledger(page, 1);
  await settled.click();
  await settled.focus();
  const summaries = page.locator(".tl-work-rule details.tl-step > summary");
  const count = await summaries.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
    const summary = summaries.nth(index);
    await expect(summary).toBeFocused();
    const ring = await summary.evaluate((element) => {
      const style = getComputedStyle(element);
      const width = Number.parseFloat(style.outlineWidth);
      const offset = Number.parseFloat(style.outlineOffset);
      const box = element.getBoundingClientRect();
      const outset = width + Math.max(0, offset);
      // Nothing between the row and the reader clips the ring.
      let clipped = false;
      for (let node = element.parentElement; node && !node.matches("[data-testid='reader']"); node = node.parentElement) {
        const overflow = getComputedStyle(node);
        if (overflow.overflowX === "visible" && overflow.overflowY === "visible") continue;
        const clip = node.getBoundingClientRect();
        if (box.left - outset < clip.left || box.right + outset > clip.right ||
            box.top - outset < clip.top || box.bottom + outset > clip.bottom) clipped = true;
      }
      return { style: style.outlineStyle, width, offset, clipped };
    });
    expect(ring.style).toBe("solid");
    expect(ring.width).toBeGreaterThan(0);
    expect(ring.offset, "the ring sits outside the row box").toBeGreaterThanOrEqual(0);
    expect(ring.clipped, "no ancestor clips the ring").toBe(false);
  }
});
