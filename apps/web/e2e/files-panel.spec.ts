import { expect, test, type Page } from "@playwright/test";

/**
 * Files (#2852) in a browser: Go to File in the toolbar over one scroller, the folder's dense rows
 * and Go to File's results at 32px with a mouse and 44px on touch, file icons rather than emoji, git
 * markers, and the truncated, offline and empty states.
 */

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/files-panel-e2e.html${query}`);
  await expect(page.locator(".files-list .row").first()).toBeVisible();
}

const goToFile = (page: Page) => page.getByRole("combobox", { name: "Go to File" });

async function heights(page: Page, selector: string): Promise<number[]> {
  await expect(page.locator(selector).first()).toBeVisible();
  return page.locator(selector).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
}

for (const pointer of ["fine", "coarse"] as const) {
  test.describe(`with a ${pointer} pointer`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: pointer === "coarse" });
    const dense = pointer === "fine" ? 32 : 44;

    test(`folder rows and Go to File results are ${dense}px dense rows`, async ({ page }) => {
      await open(page);
      for (const height of await heights(page, ".files-list .row")) expect(height).toBe(dense);
      // The Ctrl/⌘+P keycap is the field's suffix on a fine pointer only (§11.5).
      await expect(page.locator(".files-goto kbd")).toBeVisible({ visible: pointer === "fine" });

      await goToFile(page).fill("check");
      await expect(page.getByRole("option").first()).toBeVisible();
      for (const height of await heights(page, '[role="option"]')) expect(height).toBe(dense);
    });
  });
}

test.describe("at 400px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the folder has file icons, git markers and one scroller under Go to File", async ({ page }) => {
    await open(page);
    await expect(page.locator(".crumbs .crumb").first()).toHaveText("wollipog");
    const rows = page.locator(".files-list .row");
    await expect(rows).toHaveCount(7);
    expect(await rows.evaluateAll((elements) => elements.every((row) => row.querySelector(".row-icon svg")))).toBe(true);
    expect(await page.locator("#right-panel").textContent()).not.toMatch(/\p{Extended_Pictographic}|↻/u);
    const marker = (name: string) => page.locator(".files-list .row", { hasText: name }).locator(".files-git-marker > [aria-hidden]");
    await expect(marker("README.md")).toHaveText("M");
    await expect(marker("AGENTS.md")).toHaveText("U");
    await expect(page.locator(".rpanel-head").getByRole("button", { name: "Refresh Files" })).toBeVisible();

    // One vertical scroller: nothing else in the panel scrolls on its own.
    const scrollers = await page.locator("#right-panel *").evaluateAll((elements) => elements
      .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowY))
      .map((element) => element.className));
    expect(scrollers).toEqual(["rpanel-scroll"]);
    await expect(page.locator(".rpanel-toolbar").getByRole("combobox", { name: "Go to File" })).toBeVisible();
  });

  test("Go to File lists changed files first, opens one with the keyboard and clears with Escape", async ({ page }) => {
    await open(page);
    await goToFile(page).fill("check");
    const options = page.getByRole("option");
    await expect(options.first()).toHaveAttribute("title", "apps/web/src/components/CheckBadge.tsx");
    await expect(page.locator(".files-goto-count")).toHaveText("5 matches in wollipog");
    await expect(page.locator(".crumbs")).toHaveCount(0);
    await goToFile(page).press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    const second = await options.nth(1).getAttribute("title");
    await goToFile(page).press("Enter");
    await expect(goToFile(page)).toHaveValue("");
    await expect(page.locator(".crumbs .crumb.is-current")).toHaveText(second!.split("/").pop()!);

    await goToFile(page).fill("check");
    await expect(options.first()).toBeVisible();
    await goToFile(page).press("Escape");
    await expect(goToFile(page)).toHaveValue("");
    await expect(page.locator(".crumbs")).toBeVisible();

    await goToFile(page).fill("zzz");
    await expect(page.getByText("No Matching Files")).toBeVisible();
    await expect(page.getByText("Nothing in wollipog matches that name.")).toBeVisible();
    await page.getByRole("button", { name: "Clear Filter" }).click();
    await expect(goToFile(page)).toHaveValue("");
    await expect(goToFile(page)).toBeFocused();
  });

  test("a truncated search says so", async ({ page }) => {
    await open(page, "?truncated=1");
    await goToFile(page).fill("check");
    await expect(page.locator(".files-goto-count")).toHaveText("Showing the first matches only. Type more to narrow them.");
  });

  test("an empty folder offers the way up", async ({ page }) => {
    await open(page);
    await page.locator(".files-list .row", { hasText: "docs" }).click();
    await page.locator(".files-list .row", { hasText: "archive" }).click();
    await expect(page.getByText("Empty Folder")).toBeVisible();
    await expect(page.getByText("archive has no files yet.")).toBeVisible();
    await page.getByRole("button", { name: "Up to docs" }).click();
    await expect(page.locator(".crumbs .crumb.is-current")).toHaveText("docs");
  });

  test("offline keeps the last-known rows, dimmed, under the warning", async ({ page }) => {
    await open(page, "?offline=1");
    await expect(page.locator(".notice")).toContainText("is offline. This list is from");
    await expect(page.locator(".is-stale .files-list .row")).toHaveCount(7);
  });

  test("a first listing shows skeleton dense rows", async ({ page }) => {
    await page.goto("/files-panel-e2e.html?listing=loading");
    await expect(page.locator(".files-skeleton .row.dense").first()).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
  });
});
