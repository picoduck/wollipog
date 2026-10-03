import { expect, test, type Page } from "@playwright/test";

/** Campaign Status (#2417) in the real right panel over the fixture ledger in campaign-status-main. */

async function assertNoHorizontalOverflow(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

const campaignRow = (page: Page) => page.locator(".rp-launcher .rp-row", { hasText: "Campaign Status" });
const workRows = (page: Page) => page.locator(".campaign-work-row");
const queries = (page: Page) => page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.queries());

test("the launcher offers Campaign Status on a campaign, explains an unsupported server, and hides it elsewhere", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign&open=launcher");
  await expect(campaignRow(page)).toBeEnabled();
  await expect(campaignRow(page)).not.toHaveAttribute("aria-disabled", "true");

  await page.goto("/campaign-status-e2e.html?scenario=legacy&open=launcher");
  const legacy = campaignRow(page);
  await expect(legacy).toHaveAttribute("aria-disabled", "true");
  await expect(legacy).toContainText("This Wollipog server does not report campaign work.");
  await expect(legacy).toHaveAccessibleDescription(/does not report campaign work/);
  await legacy.focus();
  await expect(legacy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".rp-launcher")).toBeVisible();

  await page.goto("/campaign-status-e2e.html?scenario=unrelated&open=launcher");
  await expect(page.locator(".rp-launcher")).toBeVisible();
  await expect(campaignRow(page)).toHaveCount(0);
});

test("the summary, filters, sorting and keyboard details flow keep the list's place", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/campaign-status-e2e.html?scenario=campaign");
  const summary = page.locator(".campaign-status-summary");
  await expect(summary).toContainText("1 of 8 Delivered");
  await expect(summary).toContainText("3 of 4 Occupied");
  await expect(summary).toContainText("Partially Priced");
  await expect(summary).toContainText("Orchestrator Session Budget");
  await expect(workRows(page)).toHaveCount(7);
  expect((await queries(page))[0]).toBe("limit=50&sort=queue&state=unfinished");

  await page.getByRole("button", { name: /^State:/ }).click();
  await page.getByRole("option", { name: "All States" }).click();
  await expect(workRows(page)).toHaveCount(9, { timeout: 5_000 });
  await expect(page.locator('.campaign-work-row[data-state="removed"]')).toContainText("Scope Removed");
  await page.getByRole("button", { name: /^Sort:/ }).click();
  await page.getByRole("option", { name: "Highest Cost" }).click();
  await expect(workRows(page).first()).toContainText("Campaign Status Panel");
  expect((await queries(page)).at(-1)).toBe("limit=50&sort=cost&state=all");

  // One tab stop for the list; arrows move along it and Enter opens the focused item.
  await workRows(page).first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(workRows(page).nth(1)).toBeFocused();
  const scroller = page.locator(".campaign-status");
  await scroller.evaluate((element) => { element.scrollTop = 260; });
  const scrollBefore = await scroller.evaluate((element) => element.scrollTop);
  await page.keyboard.press("Enter");
  const heading = page.locator("h3.campaign-detail-title");
  await expect(heading).toHaveText("Campaign Work Ledger Contract");
  await expect(heading).toBeFocused();
  await expect(page.locator(".campaign-work-list")).toHaveCount(0);

  await page.getByRole("button", { name: "Back to Work Items" }).click();
  await expect(workRows(page).nth(1)).toBeFocused();
  await expect(page.getByRole("button", { name: /^State:/ })).toHaveAccessibleName("State: All States");
  await expect(page.getByRole("button", { name: /^Sort:/ })).toHaveAccessibleName("Sort: Highest Cost");
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
});

test("details separate reported stages from observations and never show missing data as zero", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign");
  await workRows(page).filter({ hasText: "Campaign Status Panel" }).click();
  const details = page.locator(".campaign-status");
  await expect(details).toContainText("Reported by the Orchestrator 20m ago");
  // Helper text is sentence case (AGENTS.md): no Title Cased relative times anywhere in the panel.
  expect(await details.textContent()).not.toMatch(/\bAgo\b|Just Now/);
  await expect(details).toContainText("Observed 1m ago");
  await expect(details.locator("dd", { hasText: "The GitHub CLI on the campaign's runner isn't signed in to github.com." })).toContainText("Unavailable");
  await expect(details.locator("dd", { hasText: "This server does not record it yet." })).toContainText("Unavailable");
  await expect(details).toContainText("At least 9m");
  await expect(details).toContainText("Superseded, session deleted, $1.10 (estimated API cost)");
  // Two back controls, two destinations: the panel header leaves the mode, the detail returns to the list.
  await expect(page.getByRole("button", { name: "Back to Panel List" })).toHaveCount(1);
  await page.getByRole("button", { name: "Back to Work Items" }).click();

  await workRows(page).filter({ hasText: "Ledger Read API" }).click();
  await expect(details).toContainText("Waiting for a merge decision on the storage pull request.");
  await expect(details).toContainText("The next turn waits while the provider account switches.");
  await expect(page.getByRole("button", { name: "Open Requests" })).toBeVisible();
  await page.getByRole("button", { name: "Open Requests" }).click();
  await expect(page.locator(".rp-title")).toHaveText("Requests");
  expect(await page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.selectedRequestKey()))
    .toBe(JSON.stringify(["s_child_3", "occ_1"]));
});

/** The Delivery section's facts as `term: description`, in order. */
async function deliveryFacts(page: Page): Promise<string[]> {
  return page.locator("section.campaign-detail-section", { has: page.locator("h4", { hasText: /^Delivery$/ }) })
    .locator("dl > div")
    .evaluateAll((rows) => rows.map((row) => `${row.querySelector("dt")?.textContent}: ${row.querySelector("dd")?.textContent}`));
}

test("details show observed GitHub facts beside the reported stage, with stale and unavailable ones explained", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign");
  await workRows(page).filter({ hasText: "Campaign Status Panel" }).click();
  await expect(page.locator("h3.campaign-detail-title")).toHaveText("Campaign Status Panel");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.forgeRefreshes()))
    .toEqual(["s_root/cwi_2"]);
  const facts = await deliveryFacts(page);
  expect(facts[0]).toBe("Reported Stage: Merge QueuedReported by the Orchestrator 20m ago. Not observed.Binding to the merged contract.");
  const at = (term: string) => facts.indexOf(facts.find((fact) => fact.startsWith(term))!);
  const fresh = facts.slice(at("PR #2440:"), at("PR #2436:"));
  expect(fresh).toEqual([
    "PR #2440: OpenObserved on GitHub 1m ago",
    "Review: No Review Decision",
    "Required Checks: Passing1 passing.",
    "All Checks: Pending1 pending, 8 passing.",
    "Merge Queue: Awaiting Checks, Position 2",
    "Head: 44579c6On main.",
  ]);
  const stale = facts.slice(at("PR #2436:"), at("PR #2441:"));
  expect(stale[0]).toBe("PR #2436: Last Seen MergedStale: observed on GitHub 25m ago. It may have changed since.");
  expect(stale).toContain("Review: Last Seen Approved");
  expect(stale).toContain("Required Checks: Last Seen Passing1 passing.");
  expect(stale).toContain("Merge Commit: dd08b41");
  expect(facts[at("PR #2441:")]).toBe("PR #2441: UnavailableThe GitHub CLI on the campaign's runner isn't signed in to github.com.");

  await page.getByRole("button", { name: "Back to Work Items" }).click();
  await workRows(page).filter({ hasText: "Ledger Read API" }).click();
  const hidden = await deliveryFacts(page);
  expect(hidden).toContain("PR #2436: UnavailableGitHub status is read through the campaign runner's GitHub CLI, and you don't have access to that runner.");
  expect(hidden.join("\n")).not.toMatch(/Passing|Approved|Merged|Observed on GitHub/);
  expect(await page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.forgeRefreshes())).toEqual(["s_root/cwi_2"]);
});

// UI evidence for #2417 slice 8: set CAMPAIGN_FORGE_EVIDENCE_DIR to capture the changed details states.
const FORGE_EVIDENCE_DIR = process.env.CAMPAIGN_FORGE_EVIDENCE_DIR;
for (const theme of ["dark", "light"] as const) {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    test(`forge facts fit a ${device} ${theme} viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&theme=${theme}`);
      for (const [name, title] of [["observed", "Campaign Status Panel"], ["not-authorized", "Ledger Read API"]] as const) {
        await workRows(page).filter({ hasText: title }).click();
        await expect(page.locator("h3.campaign-detail-title")).toHaveText(title);
        const delivery = page.locator("section.campaign-detail-section", { has: page.locator("h4", { hasText: /^Delivery$/ }) });
        await delivery.scrollIntoViewIfNeeded();
        await assertNoHorizontalOverflow(page, ".campaign-status");
        if (FORGE_EVIDENCE_DIR) {
          await page.screenshot({ path: `${FORGE_EVIDENCE_DIR}/forge-${name}-${device}-${theme}.png` });
        }
        await page.getByRole("button", { name: "Back to Work Items" }).click();
      }
    });
  }
}

test("a member sees its assignment, and leaving the campaign returns the open panel to the launcher", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=member");
  await expect(page.locator(".campaign-status-context")).toContainText("#2417 Campaign Orchestrator");
  const assignment = page.locator(".campaign-work-row.is-assignment");
  await expect(assignment).toContainText("Campaign Status Panel");
  await expect(assignment).toContainText("Current Assignment");
  await expect(assignment).toHaveAttribute("tabindex", "0");

  await page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.navigate("s_other"));
  await expect(page.locator("#right-panel")).toBeVisible();
  await expect(page.locator(".rp-launcher")).toBeVisible();
  await expect(campaignRow(page)).toHaveCount(0);
});

test("a ledger write reloads the shown list without an error", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign");
  await expect(workRows(page)).toHaveCount(7);
  const before = (await queries(page)).length;
  await page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.bumpRevision());
  await expect.poll(async () => (await queries(page)).length).toBe(before + 1);
  await expect(page.locator('.campaign-status [role="alert"]')).toHaveCount(0);
});

test("a campaign without a recorded plan says so", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=planless");
  const notice = page.locator(".campaign-status-summary .notice");
  await expect(notice).toContainText("Plan Not Recorded");
  await expect(notice).toContainText("2 child sessions without a work item are not counted");
  await expect(page.locator(".campaign-status-summary")).not.toContainText("$0.00");
});

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    test(`the panel fits a ${viewport.width}px ${theme} viewport and scrolls its own content`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&theme=${theme}`);
      if (theme === "light") await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(workRows(page)).toHaveCount(7);
      await assertNoHorizontalOverflow(page, ".campaign-status");
      const panel = await page.locator("#right-panel").boundingBox();
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width + 1);
      const last = workRows(page).last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await last.click();
      await expect(page.locator("h3.campaign-detail-title")).toBeFocused();
      await assertNoHorizontalOverflow(page, ".campaign-status");
    });
  }
}
