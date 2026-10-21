import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The Pods list (#2979; docs/design-system.md §5.2, §11, §12, §15.1), measured in a real browser:
 * two-line rows on the Runs list's recipe with a badge only while something happens, on line 1 at
 * desktop widths and leading line 2 on phones, Reconnecting over last-known rows, and one New Pod
 * while empty. Set WOLLIPOG_EVIDENCE_DIR to save each state's screenshot.
 */

const RUNNING = "Migrate the retry helper across the runner, the control plane and the dashboard";
const CONFLICTED = "Pick a date library for the scheduler";
const IDLE = "Review the settings export screen";
const NO_OBJECTIVE = "Pairing copy pass";
const CLOSED = "Ship the parser";

async function open(page: Page, state: string, theme: "dark" | "light" = "dark") {
  await page.goto(`/pods-list-e2e.html?state=${state}&theme=${theme}`);
  await expect(page.getByRole("heading", { level: 1, name: "Pods", exact: true })).toBeVisible();
}

async function capture(page: Page, name: string) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  // Let the skeleton's sweep and any transition settle into a representative frame.
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
}

function row(page: Page, title: string) {
  return page.locator(".surface > .row").filter({ has: page.locator(".row-title", { hasText: title }) });
}

async function rowGeometry(page: Page, title: string) {
  return row(page, title).evaluate((element) => {
    const box = (selector: string) => {
      const found = element.querySelector(selector);
      if (!found) return null;
      const rect = found.getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    const rect = element.getBoundingClientRect();
    return {
      row: { left: rect.left, width: rect.width, height: rect.height },
      title: box(".row-title"),
      badge: box(".list-row-status"),
      meta: box(".list-row-meta"),
      firstMeta: box(".list-row-meta > span"),
      titleTruncated: (() => {
        const title = element.querySelector<HTMLElement>(".row-title")!;
        return title.scrollWidth > title.clientWidth;
      })(),
    };
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("rows are 56px two-line rows, open pods first, with a badge only while something happens", async ({ page }) => {
    await open(page, "loaded");
    await expect(page.locator(".surface > .row")).toHaveCount(5);
    await expect(page.locator(".surface > .row .row-title")).toHaveText([RUNNING, CONFLICTED, IDLE, NO_OBJECTIVE, CLOSED]);
    const geometry = await rowGeometry(page, RUNNING);
    expect(geometry.row.height).toBe(56);
    expect(geometry.badge!.bottom, "the badge is on line 1").toBeLessThanOrEqual(geometry.meta!.top + 1);
    await expect(row(page, RUNNING).locator(".status")).toHaveText("Running");
    await expect(row(page, RUNNING).locator(".list-row-meta > span")).toHaveText(
      ["3 members", "Round robin", "turn 3 of 12", "Move every call site to the shared retry helper and delete the old one"]);
    await expect(row(page, CONFLICTED).locator(".status")).toHaveText("Conflicted");
    await expect(row(page, IDLE).locator(".status")).toHaveCount(0);
    await expect(row(page, NO_OBJECTIVE).locator(".status")).toHaveCount(0);
    await expect(row(page, NO_OBJECTIVE).locator(".list-row-meta > span")).toHaveText(["4 members", "Manual relay", "No objective"]);
    await expect(row(page, CLOSED).locator(".status")).toHaveText("Closed");
    await expect(page.getByText("Manual collaboration pod")).toHaveCount(0);
  });

  test("No objective reads fainter than an objective", async ({ page }) => {
    await open(page, "loaded");
    const color = (title: string) => row(page, title).locator(".list-row-fill > span").evaluate((element) => getComputedStyle(element).color);
    expect(await color(NO_OBJECTIVE)).not.toBe(await color(IDLE));
  });

  test("the meta keeps the issue's order, with the mode before the turn", async ({ page }) => {
    await open(page, "loaded");
    const order = await row(page, RUNNING).locator(".list-row-meta > span").evaluateAll((items) =>
      items.map((item) => ({ text: item.textContent, left: item.getBoundingClientRect().left }))
        .sort((left, right) => left.left - right.left).map((item) => item.text));
    expect(order).toEqual(["3 members", "Round robin", "turn 3 of 12", "Move every call site to the shared retry helper and delete the old one"]);
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a long title keeps at least 60% of the row and the badge leads line 2", async ({ page }) => {
    await open(page, "loaded");
    const geometry = await rowGeometry(page, RUNNING);
    expect(geometry.titleTruncated, "the fixture's title is long enough to truncate").toBe(true);
    expect(geometry.title!.width / geometry.row.width).toBeGreaterThanOrEqual(0.6);
    expect(geometry.badge!.top, "the badge sits below the title").toBeGreaterThanOrEqual(geometry.title!.bottom - 1);
    expect(geometry.badge!.left, "the badge starts line 2").toBeLessThan(geometry.firstMeta!.left);
    expect(Math.abs(geometry.badge!.left - geometry.title!.left)).toBeLessThanOrEqual(1);
  });

  test("line 2 keeps its items 12px apart and folds what does not fit whole", async ({ page }) => {
    await open(page, "loaded");
    const rows = await page.locator(".surface > .row").evaluateAll((elements) => elements.map((element) => {
      const meta = element.querySelector<HTMLElement>(".list-row-meta")!.getBoundingClientRect();
      const items = [...element.querySelectorAll<HTMLElement>(".list-row-meta > span")].map((item) => {
        const rect = item.getBoundingClientRect();
        const text = item.querySelector<HTMLElement>("span") ?? item;
        return {
          text: item.textContent ?? "",
          visible: rect.top >= meta.top - 1 && rect.bottom <= meta.bottom + 1,
          hidden: rect.top >= meta.bottom - 1,
          left: rect.left,
          right: rect.right,
          truncated: text.scrollWidth > text.clientWidth,
          textWidth: text.clientWidth,
        };
      });
      return { title: element.querySelector(".row-title")?.textContent ?? "", items };
    }));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      // In view order: phones move the turn ahead of the mode.
      const shown = row.items.filter((item) => item.visible).sort((left, right) => left.left - right.left);
      expect(shown[0]?.text, `${row.title}: the members lead line 2`).toMatch(/^\d+ members$/u);
      for (const item of row.items) {
        expect(item.visible || item.hidden, `${row.title}: "${item.text}" is either in view or folded away whole`).toBe(true);
        // A truncated item still shows a few characters: never a lone initial.
        if (item.visible && item.truncated) expect(item.textWidth, `${row.title}: "${item.text}"`).toBeGreaterThanOrEqual(48);
      }
      for (let index = 1; index < shown.length; index += 1) {
        expect(Math.abs(shown[index]!.left - shown[index - 1]!.right - 12), `${row.title}: items sit 12px apart`).toBeLessThanOrEqual(1);
      }
    }
    // A running pod keeps its progress in view: the turn follows the members, ahead of the mode.
    const running = rows.find((row) => row.title === RUNNING)!;
    expect(running.items.filter((item) => item.visible).sort((left, right) => left.left - right.left).map((item) => item.text).slice(0, 2))
      .toEqual(["3 members", "turn 3 of 12"]);
  });

  test("a row without a badge starts its meta under the title", async ({ page }) => {
    await open(page, "loaded");
    const geometry = await rowGeometry(page, IDLE);
    expect(geometry.badge).toBeNull();
    expect(Math.abs(geometry.firstMeta!.left - geometry.title!.left)).toBeLessThanOrEqual(1);
  });
});

test("reconnecting keeps the last-known rows dimmed under Reconnecting…, and they still open", async ({ page }) => {
  await open(page, "reconnecting");
  await expect(page.locator(".page").getByRole("status")).toHaveText("Reconnecting…");
  await expect(page.locator(".is-stale .surface > .row")).toHaveCount(5);
  await row(page, CLOSED).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ name: "pod", id: "pod-parser" }));
});

test("an empty list offers exactly one New Pod, in the empty state", async ({ page }) => {
  await open(page, "empty");
  await expect(page.getByText("No Pods Yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "New Pod", exact: true })).toHaveCount(1);
  await expect(page.locator(".state").getByRole("button", { name: "New Pod", exact: true })).toBeVisible();
});

for (const { label, viewport } of [
  { label: "1440", viewport: { width: 1440, height: 900 } },
  { label: "834", viewport: { width: 834, height: 1112 } },
  { label: "390", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${label} ${theme} states`, () => {
    test.use({ viewport });

    test("Loaded", async ({ page }) => {
      await open(page, "loaded", theme);
      await expect(page.locator(".surface > .row")).toHaveCount(5);
      await capture(page, `pods-list-loaded-${label}-${theme}`);
    });

    test("Loading", async ({ page }) => {
      await open(page, "loading", theme);
      await expect(page.locator(".state")).toContainText("Loading Pods…");
      await capture(page, `pods-list-loading-${label}-${theme}`);
    });

    test("Reconnecting", async ({ page }) => {
      await open(page, "reconnecting", theme);
      await expect(page.locator(".page").getByRole("status")).toHaveText("Reconnecting…");
      await expect(page.locator(".is-stale .surface > .row")).toHaveCount(5);
      await capture(page, `pods-list-reconnecting-${label}-${theme}`);
    });

    test("Empty", async ({ page }) => {
      await open(page, "empty", theme);
      await expect(page.getByText("No Pods Yet")).toBeVisible();
      await capture(page, `pods-list-empty-${label}-${theme}`);
    });
  });
}
