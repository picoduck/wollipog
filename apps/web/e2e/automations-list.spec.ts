import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

/**
 * The Automations list (#2969; docs/design-system.md §5.2, §10.1, §12, §15.1), measured in a real
 * browser: 56px two-line rows under Scheduled and Paused, one whole meta fact per row on a phone, a
 * 44px Enabled switch, the tabs as routes, and the loading, reconnecting, error and empty states.
 * `AutomationsView.dom.test.tsx` covers the logic against a fake DOM. With `WOLLIPOG_EVIDENCE_DIR`
 * set, each state is also captured, viewport only, as UI evidence.
 */

const NIGHTLY = "Nightly Dependency Sweep and Long-Running Audit Report";

async function open(page: Page, theme: string, scenario: string) {
  await page.goto(`/automations-e2e.html?theme=${theme}${scenario ? `&${scenario}` : ""}`);
  await expect(page.getByRole("heading", { level: 1, name: "Automations", exact: true })).toBeVisible();
}

function row(page: Page, name: string) {
  return page.locator(".automation-row").filter({ has: page.locator(".row-title", { hasText: name }) });
}

/** The space between the Scheduled group's Surface and the Paused heading. */
async function groupGap(page: Page): Promise<number> {
  return page.locator(".automation-group").evaluateAll((groups) =>
    Math.round(groups[1]!.getBoundingClientRect().top - groups[0]!.getBoundingClientRect().bottom));
}

async function capture(page: Page, name: string) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  // Let the skeleton's sweep and any transition settle into a representative frame.
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("rows are 56px, grouped Scheduled by next run then Paused, and the list is the first content", async ({ page }) => {
    await open(page, "dark", "list");
    await expect(page.locator(".automation-row")).toHaveCount(6);
    for (const rowBox of await page.locator(".automation-row").evaluateAll((rows) =>
      rows.map((element) => element.getBoundingClientRect().height))) {
      expect(rowBox).toBe(56);
    }
    const groups = await page.locator(".automation-group").evaluateAll((elements) => elements.map((group) => ({
      label: group.querySelector(".group-label")!.firstChild!.textContent,
      count: group.querySelector(".group-label > .count")!.textContent,
    })));
    expect(groups).toEqual([{ label: "Scheduled", count: "4" }, { label: "Paused", count: "2" }]);
    // The first content under the header is the list, never Outbound Events.
    const first = await page.locator(".page-header").evaluate((header) => header.nextElementSibling?.querySelector(":scope > *")?.className);
    expect(first).toBe("automation-groups");
    await expect(page.locator(".outbound-events")).toHaveCount(0);
    // Line 2 is three facts, 12px apart, each after a 14px icon.
    const meta = await row(page, "Morning Issue Triage").locator(".automation-row-meta > span").evaluateAll((items) =>
      items.map((item) => ({ text: item.textContent, left: item.getBoundingClientRect().left,
        right: item.getBoundingClientRect().right, icon: item.querySelector("svg")!.getBoundingClientRect().width })));
    expect(meta.map((item) => item.text)).toEqual(["Weekdays at 9:00 AM", expect.stringMatching(/^Next /), "Codex"]);
    for (const [index, item] of meta.entries()) {
      expect(item.icon).toBe(14);
      if (index > 0) expect(Math.round(item.left - meta[index - 1]!.right)).toBe(12);
    }
  });

  test("Needs Attention shows one badge per row: Last Run Failed, else Target Unavailable", async ({ page }) => {
    await open(page, "dark", "list&needs-attention");
    await expect(row(page, NIGHTLY).locator(".status")).toHaveText("Last Run Failed");
    await expect(row(page, "Morning Issue Triage").locator(".status")).toHaveText("Target Unavailable");
    await expect(row(page, "Hourly Health Check").locator(".status")).toHaveCount(0);
  });

  test("activating the switch moves the row between groups without opening it", async ({ page }) => {
    await open(page, "dark", "list");
    const control = row(page, "Hourly Health Check").getByRole("switch", { name: "Enabled" });
    await control.press("Space");
    await expect(page.locator(".automation-group").last().locator(".row-title", { hasText: "Hourly Health Check" })).toBeVisible();
    await expect(page.locator(".automation-detail")).toHaveCount(0);
    await expect(row(page, "Hourly Health Check").getByRole("switch", { name: "Enabled" })).toBeFocused();
    await row(page, "Hourly Health Check").getByRole("switch", { name: "Enabled" }).click();
    await expect(page.locator(".automation-group").first().locator(".row-title", { hasText: "Hourly Health Check" })).toBeVisible();
    await expect(page.locator(".automation-detail")).toHaveCount(0);
  });

  test("each tab is a route that selects itself on load and survives a reload", async ({ page }) => {
    await page.goto(`/automations-e2e.html?theme=dark&list&route=${encodeURIComponent("/automations/outbound")}`);
    await expect(page.getByRole("tab", { name: "Outbound Events" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".outbound-events")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("tab", { name: "Outbound Events" })).toHaveAttribute("aria-selected", "true");
    await page.goto("/automations-e2e.html?theme=dark&list&route=%2Fautomations");
    await expect(page.getByRole("tab", { name: "Automations" })).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(page.getByRole("tab", { name: "Automations" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".automation-row")).toHaveCount(6);
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("each row keeps one whole meta fact and a 44px switch, and shows no selection after a visit", async ({ page }) => {
    await open(page, "dark", "list");
    await expect(page.locator(".automation-row")).toHaveCount(6);
    for (const name of [NIGHTLY, "Hourly Health Check", "Weekly Digest", "Release Notes Follow-Up"]) {
      const facts = await row(page, name).locator(".automation-row-meta > span").evaluateAll((items) => items
        .filter((item) => getComputedStyle(item).display !== "none")
        .map((item) => {
          const text = item.querySelector<HTMLElement>(":scope > span")!;
          return { className: item.className, clipped: text.scrollWidth > text.clientWidth };
        }));
      expect(facts, `${name} shows one fact`).toHaveLength(1);
      expect(facts[0]!.clipped, `${name}'s fact is whole`).toBe(false);
      const paused = name === "Weekly Digest" || name === "Release Notes Follow-Up";
      expect(facts[0]!.className).toBe(paused ? "automation-row-schedule" : "automation-row-next");
    }
    const target = await row(page, "Hourly Health Check").getByRole("switch", { name: "Enabled" }).evaluate((control) => {
      const rect = control.querySelector(".ui-switch")!.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hits = (dx: number, dy: number) => control.contains(document.elementFromPoint(x + dx, y + dy));
      return { edges: [hits(-21, 0), hits(21, 0), hits(0, -21), hits(0, 21)], beyond: hits(0, -24) };
    });
    expect(target.edges, "a 44×44 hit area").toEqual([true, true, true, true]);
    expect(target.beyond).toBe(false);

    await row(page, "Hourly Health Check").locator(".automation-row-open").click();
    await expect(page.locator(".automation-detail .glance")).toBeVisible();
    await page.getByRole("button", { name: "Back to Automations" }).click();
    await expect(page.locator(".automation-row")).toHaveCount(6);
    await expect(page.locator(".automation-row.is-selected, .automation-row[aria-current]")).toHaveCount(0);
    const fills = await page.locator(".automation-row").evaluateAll((rows) =>
      rows.map((element) => getComputedStyle(element).backgroundColor));
    expect(new Set(fills).size, "no row is filled differently from the others").toBe(1);
  });
});

for (const { label, viewport } of [
  { label: "1440", viewport: { width: 1440, height: 900 } },
  { label: "834", viewport: { width: 834, height: 1112 } },
  { label: "390", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${label} ${theme} states`, () => {
    test.use({ viewport });

    test("Loaded", async ({ page }) => {
      await open(page, theme, "list");
      await expect(page.locator(".automation-row")).toHaveCount(6);
      await capture(page, `automations-list-loaded-${label}-${theme}`);
    });

    test("Needs Attention", async ({ page }) => {
      await open(page, theme, "list&needs-attention");
      await expect(row(page, NIGHTLY).locator(".status")).toHaveText("Last Run Failed");
      await capture(page, `automations-list-needs-attention-${label}-${theme}`);
    });

    test("Loading", async ({ page }) => {
      await open(page, theme, "list&list-loading");
      await expect(page.locator('.automation-list > .surface[role="status"] > .row')).toHaveCount(5);
      await capture(page, `automations-list-loading-${label}-${theme}`);
    });

    test("Reconnecting", async ({ page }) => {
      await open(page, theme, "list");
      await expect(page.locator(".automation-row")).toHaveCount(6);
      const loadedGap = await groupGap(page);
      expect(loadedGap).toBe(16);
      await page.evaluate(() => (window as unknown as { automationsDisconnect: () => void }).automationsDisconnect());
      await expect(page.locator('.automation-list > .notice[role="status"]')).toHaveText("Reconnecting…");
      await expect(page.locator(".automation-list .is-stale .automation-row")).toHaveCount(6);
      await expect(page.locator(".automation-list .state")).toHaveCount(0);
      // The groups keep the loaded list's spacing while dimmed.
      expect(await groupGap(page)).toBe(loadedGap);
      await capture(page, `automations-list-reconnecting-${label}-${theme}`);
    });

    test("Load Error", async ({ page }) => {
      await open(page, theme, "list&list-error");
      const notice = page.locator('.automation-list > .notice[role="alert"]');
      await expect(notice.locator(".notice-title")).toHaveText("Couldn't Load Automations");
      await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Automations" })).toBeVisible();
      await capture(page, `automations-list-error-${label}-${theme}`);
    });

    if (label !== "834") test("Outbound Events", async ({ page }) => {
      await page.goto(`/automations-e2e.html?theme=${theme}&list&route=${encodeURIComponent("/automations/outbound")}`);
      await expect(page.getByRole("tab", { name: "Outbound Events" })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(".outbound-subscription")).toHaveCount(2);
      await expect(page.locator(".automation-list")).toHaveCount(0);
      await capture(page, `automations-outbound-${label}-${theme}`);
    });

    test("Empty", async ({ page }) => {
      await open(page, theme, "list-empty");
      await expect(page.locator(".automation-list .state")).toContainText("No Automations Yet");
      await expect(page.getByRole("button", { name: "New Automation" })).toHaveCount(1);
      await capture(page, `automations-list-empty-${label}-${theme}`);
    });
  });
}
