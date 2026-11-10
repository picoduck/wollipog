import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** #4120: Campaign Status groups work by repository, filters by it, and shows cross-repository
 * dependencies and holds, over the fixture ledger in campaign-status-main (`workRepositories=1`). */

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

const workRows = (page: Page) => page.locator(".campaign-work-row");
const groups = (page: Page) => page.locator(".campaign-work-group");
const queries = (page: Page) => page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.queries());

async function assertNoHorizontalOverflow(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

for (const width of [1440, 390]) {
  test(`work groups by repository with counts, dependencies and holds, and filters by repository at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&workRepositories=1");

    // One group per repository, each headed by its name and its own counts.
    await expect(groups(page)).toHaveCount(2);
    const app = groups(page).nth(0), api = groups(page).nth(1);
    await expect(app.getByRole("heading", { level: 4 })).toHaveText(/^picoduck\/wollipog9 Items: /u);
    await expect(api.getByRole("heading", { level: 4 })).toHaveText("picoduck/account-api2 Items: 1 Running, 1 Delivered");
    await expect(app.getByRole("list")).toHaveAccessibleName(/^picoduck\/wollipog/u);
    await expect(api.locator(".campaign-work-row")).toHaveCount(1, { timeout: 5_000 });
    await expect(api.locator(".campaign-work-row")).toContainText("Add Account Field");

    // The held item names its prerequisite in the other repository and the pull request it waits on.
    const held = app.locator(".campaign-work-row", { hasText: "Show Account Field in Settings" });
    await expect(held.locator(".campaign-work-row-dependency")).toHaveText("Depends Onpicoduck/account-api: Add Account FieldNot Merged");
    await expect(held.locator(".campaign-work-row-held")).toHaveText("Waiting for Prerequisite Mergepicoduck/account-api#88");
    await expect(held).toHaveAccessibleName(/Depends On picoduck\/account-api: Add Account Field Not Merged Waiting for Prerequisite Merge picoduck\/account-api#88/u);
    if (evidenceDir) {
      await page.locator(".campaign-work").scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidenceDir, `campaign-status-repositories-${width}.png`), fullPage: false });
    }

    // Keyboard order follows the groups as shown.
    const rows = await workRows(page).allTextContents();
    expect(rows.at(-1)).toContain("Add Account Field");
    await workRows(page).first().focus();
    await page.keyboard.press("End");
    await expect(workRows(page).last()).toBeFocused();

    await assertNoHorizontalOverflow(page, ".campaign-status");

    // The Repository filter, Title Case with a matching accessible name, narrows the list on the server.
    const filter = page.getByRole("button", { name: /^Repository:/ });
    await expect(filter).toHaveAccessibleName("Repository: All Repositories");
    await filter.click();
    await expect(page.getByRole("option")).toHaveText(["All Repositories", "picoduck/wollipog", "picoduck/account-api"]);
    await page.getByRole("option", { name: "picoduck/account-api" }).click();
    await expect(filter).toHaveAccessibleName("Repository: picoduck/account-api");
    await expect(workRows(page)).toHaveCount(1, { timeout: 5_000 });
    await expect(workRows(page)).toContainText("Add Account Field");
    expect((await queries(page)).at(-1)).toBe("limit=50&sort=queue&state=unfinished&repository=picoduck%2Faccount-api");
    await page.getByRole("button", { name: /^State:/ }).click();
    await page.getByRole("option", { name: "All States" }).click();
    await expect(workRows(page)).toHaveCount(2, { timeout: 5_000 });

    // Details show the dependency with its repository and the pull request the merge waits on.
    await page.getByRole("button", { name: /^Repository:/ }).click();
    await page.getByRole("option", { name: "All Repositories" }).click();
    await page.locator(".campaign-work-row", { hasText: "Show Account Field in Settings" }).click();
    const lineage = page.locator(".campaign-detail-list").first();
    await expect(lineage).toContainText("picoduck/account-api: Add Account Field");
    await expect(lineage).toContainText("Not Merged");
    await expect(page.locator("dd", { hasText: "Its merge waits until a prerequisite in another repository is merged." }))
      .toContainText("Waiting for picoduck/account-api#88.");
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `campaign-status-held-detail-${width}.png`), fullPage: false });
  });
}

for (const width of [1440, 390]) {
  test(`work verified while its own pull request is open waits on its prerequisite, or is blocked when that can never merge, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&workRepositories=1&verifiedHolds=1");
    const app = groups(page).nth(0);
    const waiting = app.locator(".campaign-work-row", { hasText: "Show Account Badge" });
    await expect(waiting).toContainText("Waiting");
    await expect(waiting.locator(".campaign-work-row-dependency")).toHaveText("Depends Onpicoduck/account-api: Add Account FieldNot Merged");
    await expect(waiting.locator(".campaign-work-row-held")).toHaveText("Waiting for Prerequisite Mergepicoduck/account-api#88");
    const blocked = app.locator(".campaign-work-row", { hasText: "Show Account Avatar" });
    await expect(blocked).toContainText("Blocked");
    await expect(blocked.locator(".campaign-work-row-dependency")).toHaveText("Depends Onpicoduck/account-api: Add Avatar FieldWill Not Merge");
    await expect(blocked.locator(".campaign-work-row-held")).toHaveCount(0);
    await assertNoHorizontalOverflow(page, ".campaign-status");
    if (evidenceDir) {
      await blocked.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidenceDir, `campaign-status-verified-holds-${width}.png`), fullPage: false });
    }
  });
}

test("a single-repository campaign's list stays ungrouped, with no Repository filter", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/campaign-status-e2e.html?scenario=campaign");
  await expect(workRows(page)).toHaveCount(7);
  await expect(groups(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Repository:/ })).toHaveCount(0);
});
