import { expect, test, type Page } from "@playwright/test";

/** Campaign Status (#2417) in the real right panel over the fixture ledger in campaign-status-main. */

async function assertNoHorizontalOverflow(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

const SCOPE_EVIDENCE_DIR = process.env.CAMPAIGN_SCOPE_EVIDENCE_DIR;

const campaignRow = (page: Page) => page.locator('.session-tools [data-tool="campaign"]');
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
  await expect(page.locator(".session-tools")).toBeVisible();

  await page.goto("/campaign-status-e2e.html?scenario=unrelated&open=launcher");
  await expect(page.locator(".session-tools")).toBeVisible();
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
  // One back control: the detail returns to the list; the panel header has only the tool switcher (#2843).
  await expect(page.getByRole("button", { name: "Back to Panel List" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to Work Items" }).click();

  await workRows(page).filter({ hasText: "Ledger Read API" }).click();
  await expect(details).toContainText("Waiting for a merge decision on the storage pull request.");
  await expect(details).toContainText("The next turn waits while the provider account switches.");
  await expect(page.getByRole("button", { name: "Open Requests" })).toBeVisible();
  await page.getByRole("button", { name: "Open Requests" }).click();
  await expect(page.locator(".rpanel-switcher-name")).toHaveText("Requests");
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
  expect(facts[0]).toBe("Reported Stage: Merge QueuedReported by the Orchestrator 20m ago. Wollipog has not observed this stage.Binding to the merged contract.");
  const at = (term: string) => facts.indexOf(facts.find((fact) => fact.startsWith(term))!);
  const fresh = facts.slice(at("PR #2440:"), at("PR #2436:"));
  expect(fresh).toEqual([
    "PR #2440: OpenObserved on GitHub 1m ago",
    "Review: No Review Decision",
    "Required Checks: Passing1 passing.",
    "All Checks: Pending1 pending, 8 passing.",
    "Merge Queue: Awaiting Checks, Position 2",
    "Head: 44579c6",
    "Base Branch: main",
  ]);
  // Nothing says a commit is on a branch: an open pull request's head is not on main.
  expect(facts.join("\n")).not.toMatch(/\bOn main\b/);
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
    test(`dirty cleanup paths fit a ${device} ${theme} viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&theme=${theme}`);
      await workRows(page).filter({ hasText: "Ledger Read API" }).click();
      const cleanup = page.locator("dd").filter({ hasText: /Refused: \/w\/3/ });
      await expect(cleanup).toContainText('10 paths');
      await expect(cleanup).toContainText('"report.md"');
      await expect(cleanup).toContainText('2 more');
      await cleanup.scrollIntoViewIfNeeded();
      await assertNoHorizontalOverflow(page, ".campaign-status");
      if (process.env.CAMPAIGN_CLEANUP_EVIDENCE_DIR) await page.screenshot({
        path: `${process.env.CAMPAIGN_CLEANUP_EVIDENCE_DIR}/cleanup-${device}-${theme}.png`,
      });
    });
  }
}
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

/** Wheels the scrolling region holding `heading` until the heading sits 12px below whatever covers that
 * region's top (the panel's sticky header). Wheeling, unlike a forced scroll, never moves the phone's
 * overflow-hidden panel. */
async function wheelBelowStickyHeader(page: import("@playwright/test").Page, heading: import("@playwright/test").Locator): Promise<void> {
  const geometry = () => heading.evaluate((target) => {
    let scroller = target.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const area = scroller!.getBoundingClientRect();
    const x = target.getBoundingClientRect().left + 2;
    const covers = (element: Element | null) => {
      for (let at = element; at && at !== scroller; at = at.parentElement) if (/sticky|fixed/.test(getComputedStyle(at).position)) return true;
      return !element || !scroller!.contains(element);
    };
    let visibleTop = Math.max(area.top, 0);
    while (visibleTop < area.bottom && covers(document.elementFromPoint(x, visibleTop))) visibleTop += 1;
    return { gap: target.getBoundingClientRect().top - visibleTop - 12, middle: { x: area.left + area.width / 2, y: (visibleTop + Math.min(area.bottom, innerHeight)) / 2 } };
  });
  const { middle } = await geometry();
  await page.mouse.move(middle.x, middle.y);
  for (let step = 0; step < 6 && Math.abs((await geometry()).gap) > 2; step += 1) {
    await page.mouse.wheel(0, (await geometry()).gap);
    await page.waitForTimeout(100);
  }
  expect(Math.abs((await geometry()).gap)).toBeLessThanOrEqual(2);
}

// UI evidence for #4117: set CAMPAIGN_REPOSITORIES_EVIDENCE_DIR to capture the Repositories section.
const REPOSITORIES_EVIDENCE_DIR = process.env.CAMPAIGN_REPOSITORIES_EVIDENCE_DIR;
for (const theme of ["dark", "light"] as const) {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    test(`Repositories lists the boundary and includes a waiting Location on a ${device} ${theme} viewport (#4117)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&repositories=1&theme=${theme}`);
      const section = page.locator("section.campaign-detail-section", { has: page.locator("h3", { hasText: /^Repositories$/ }) });
      await expect(section).toBeVisible();
      await expect(section.locator("dt")).toHaveText(["picoduck/wollipog", "picoduck/dev-box-setup", "picoduck/notes-site", "Boundary Revision"]);
      await expect(section.getByRole("list", { name: "Locations of picoduck/wollipog" })).toContainText("Wollipog on Laptop");
      await expect(section.getByRole("list", { name: "Locations of picoduck/wollipog" })).toContainText("Default");
      await expect(section.getByRole("list", { name: "Locations of picoduck/notes-site" })).toContainText("Removed");
      await expect(section.getByRole("list", { name: "Excluded Locations" })).toContainText("Scratch Folder");
      await expect(section.getByRole("list", { name: "Excluded Locations" })).toContainText("not a git repository");
      // Each failure names its own reason.
      const excludedRows = section.getByRole("list", { name: "Excluded Locations" }).getByRole("listitem");
      await expect(excludedRows.filter({ hasText: "Wollipog on Old Mac" })).toContainText("The Location's runner can't perform this campaign's gates. Update and restart it to protocol version 327 or newer.");
      await expect(excludedRows.filter({ hasText: "Wollipog on Travel Laptop" })).toContainText("The Location's machine is offline.");
      await expect(section).toContainText("Joined at boundary revision 6.");
      await section.scrollIntoViewIfNeeded();
      await assertNoHorizontalOverflow(page, ".campaign-status");
      if (REPOSITORIES_EVIDENCE_DIR) await section.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/repositories-${device}-${theme}.png` });
      const include = section.getByRole("button", { name: "Include Shared Docs in Campaign" });
      await expect(include).toHaveText("Include in Campaign");
      await include.click();
      expect(await page.evaluate(() => (window as unknown as { __INCLUDED_LOCATION__?: string }).__INCLUDED_LOCATION__)).toBe("loc_shared");
      await expect(section.getByRole("list", { name: "Locations of picoduck/shared-docs" })).toContainText("Shared Docs");
      await expect(section.getByRole("button", { name: "Include Shared Docs in Campaign" })).toHaveCount(0);
      if (REPOSITORIES_EVIDENCE_DIR) await section.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/repositories-included-${device}-${theme}.png` });
    });

    test(`Repositories keeps listing a Location its runner's version left out, with its repository, and a limited launch Location, on a ${device} ${theme} viewport (#4319)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&repositories=1&limited=1&theme=${theme}`);
      const section = page.locator("section.campaign-detail-section", { has: page.locator("h3", { hasText: /^Repositories$/ }) });
      const row = section.getByRole("list", { name: "Excluded Locations" }).getByRole("listitem").filter({ hasText: "Wollipog on Old Mac" });
      await expect(row).toContainText("picoduck/old-tools");
      await expect(row).toContainText("The Location's runner can't perform this campaign's gates. Update and restart it to protocol version 327 or newer.");
      const launch = section.getByRole("list", { name: "Locations of picoduck/wollipog" }).getByRole("listitem").filter({ hasText: "Wollipog on Laptop" });
      await expect(launch).toContainText("Follow-ups from this campaign's other repositories can't be created in this Location's repository until its runner is on protocol version 327 or newer.");
      await row.scrollIntoViewIfNeeded();
      await assertNoHorizontalOverflow(page, ".campaign-status");
      if (device === "phone") {
        // The limited launch row, its repository and its whole reason show together: scroll with the
        // wheel (a forced scroll moves the phone's overflow-hidden panel) until the section's heading sits
        // just below whatever covers the top of the scrolling region (the panel's sticky header).
        const heading = section.locator("h3", { hasText: /^Repositories$/ });
        const geometry = () => heading.evaluate((dt) => {
          let scroller = dt.parentElement;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
          const area = scroller!.getBoundingClientRect();
          const x = dt.getBoundingClientRect().left + 2;
          // The first point down from the region's top that shows its scrolled content, not a stuck header.
          const covers = (element: Element | null) => {
            for (let at = element; at && at !== scroller; at = at.parentElement) if (/sticky|fixed/.test(getComputedStyle(at).position)) return true;
            return !element || !scroller!.contains(element);
          };
          let visibleTop = Math.max(area.top, 0);
          while (visibleTop < area.bottom && covers(document.elementFromPoint(x, visibleTop))) visibleTop += 1;
          return { gap: dt.getBoundingClientRect().top - visibleTop - 12, middle: { x: area.left + area.width / 2, y: (visibleTop + Math.min(area.bottom, innerHeight)) / 2 } };
        });
        const gap = async () => (await geometry()).gap;
        const { middle } = await geometry();
        await page.mouse.move(middle.x, middle.y);
        for (let step = 0; step < 6 && Math.abs(await gap()) > 2; step += 1) {
          await page.mouse.wheel(0, await gap());
          await page.waitForTimeout(100);
        }
        expect(Math.abs(await gap())).toBeLessThanOrEqual(2);
        expect(await page.locator("aside.rpanel").evaluate((panel) => panel.scrollTop)).toBe(0);
        // Nothing of the row is under the tab bar band.
        const band = await page.getByRole("navigation", { name: "App Navigation" }).boundingBox();
        const shown = await launch.boundingBox();
        expect(shown!.y + shown!.height).toBeLessThanOrEqual(band!.y);
      }
      if (REPOSITORIES_EVIDENCE_DIR) await page.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/location-gates-listed-${device}-${theme}.png` });
    });

    test(`each Location waiting to be included says why it waits, and an entry stored before claims nothing, on a ${device} ${theme} viewport (#4312)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&repositories=1&waiting=causes&theme=${theme}`);
      const section = page.locator("section.campaign-detail-section", { has: page.locator("h3", { hasText: /^Repositories$/ }) });
      const list = section.getByRole("list", { name: "Locations Waiting to Be Included" });
      const row = (name: string) => list.getByRole("listitem").filter({ hasText: name });
      await expect(row("Shared Docs")).toContainText("Someone other than the campaign's owner added this Location to the Project.");
      await expect(row("Old Scripts Folder")).toContainText("No one is recorded as having added this Location to the Project.");
      await expect(row("Wollipog Second Checkout")).toContainText(
        "The campaign's owner approved adding another Location of its repository, and this one wasn't part of that approval.");
      await expect(row("Archive Checkout").locator(".campaign-status-meta")).toHaveCount(0);
      await expect(section).toContainText("These Locations join this campaign only when its owner includes them.");
      await expect(section).not.toContainText("Someone else added these Locations");
      for (const name of ["Shared Docs", "Old Scripts Folder", "Wollipog Second Checkout", "Archive Checkout"]) {
        await expect(row(name).getByRole("button", { name: `Include ${name} in Campaign` })).toHaveText("Include in Campaign");
      }
      await assertNoHorizontalOverflow(page, ".campaign-status");
      // Show the whole section: its heading just below the panel's sticky header, wheeled (#4319's capture).
      await wheelBelowStickyHeader(page, section.getByRole("heading", { name: "Waiting to Be Included" }));
      expect(await page.locator("aside.rpanel").evaluate((panel) => panel.scrollTop)).toBe(0);
      const listBox = await list.boundingBox();
      const band = device === "phone" ? await page.getByRole("navigation", { name: "App Navigation" }).boundingBox() : null;
      expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(band ? band.y : viewport.height);
      if (REPOSITORIES_EVIDENCE_DIR) await page.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/waiting-causes-${device}-${theme}.png` });
    });

    test(`a repository the first message left out shows as available on a ${device} ${theme} viewport (#4117)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&repositories=limited&theme=${theme}`);
      const section = page.locator("section.campaign-detail-section", { has: page.locator("h3", { hasText: /^Repositories$/ }) });
      await expect(section.locator("dt")).toHaveText(["picoduck/wollipog", "picoduck/dev-box-setup", "Boundary Revision"]);
      await expect(section.getByRole("heading", { name: "Available but Not in This Campaign" })).toBeVisible();
      await expect(section).toContainText("Your first message limited this campaign to picoduck/wollipog, picoduck/dev-box-setup.");
      const available = section.getByRole("list", { name: "Locations Available but Not in This Campaign" });
      await expect(available.getByRole("listitem")).toHaveCount(2);
      await expect(available).toContainText("picoduck/shared-docs");
      await expect(available.getByRole("button")).toHaveCount(0);
      await section.scrollIntoViewIfNeeded();
      await assertNoHorizontalOverflow(page, ".campaign-status");
      if (REPOSITORIES_EVIDENCE_DIR) {
        await section.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/repositories-limited-${device}-${theme}.png` });
        if (device === "desktop") await page.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/repositories-limited-viewport-${theme}.png` });
      }
    });

    test(`a Custom campaign's repository list shows no boundary revision on a ${device} ${theme} viewport (#4117)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&repositories=custom&theme=${theme}`);
      const section = page.locator("section.campaign-detail-section", { has: page.locator("h3", { hasText: /^Repositories$/ }) });
      await expect(section.locator("dt")).toHaveText(["picoduck/wollipog", "picoduck/shared-docs"]);
      await expect(section).toContainText("Joined after launch.");
      await expect(section).not.toContainText("Boundary Revision");
      await section.scrollIntoViewIfNeeded();
      await assertNoHorizontalOverflow(page, ".campaign-status");
      if (REPOSITORIES_EVIDENCE_DIR) {
        await section.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/repositories-custom-${device}-${theme}.png` });
        if (device === "desktop") await page.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/repositories-custom-viewport-${theme}.png` });
      }
    });
  }
}

// UI evidence for #3539 and #3600: set CAMPAIGN_GITLAB_EVIDENCE_DIR to capture the GitLab refs.
const GITLAB_EVIDENCE_DIR = process.env.CAMPAIGN_GITLAB_EVIDENCE_DIR;
test("GitLab issue and merge request refs link to their host and show observed GitLab facts in GitLab's terms", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/campaign-status-e2e.html?scenario=campaign&forge=gitlab");
  const project = "gitlab.example.com/platform/agents/wollipog";
  const row = workRows(page).filter({ hasText: "Campaign Status Panel" });
  await expect(row).toContainText(`${project}#2417`);
  if (GITLAB_EVIDENCE_DIR) await page.screenshot({ path: `${GITLAB_EVIDENCE_DIR}/gitlab-list-desktop.png` });
  await row.click();
  await expect(page.locator("h3.campaign-detail-title")).toHaveText("Campaign Status Panel");
  await expect(page.getByRole("link", { name: `${project}#2417` }))
    .toHaveAttribute("href", `https://${project}/-/issues/2417`);
  await expect(page.getByRole("link", { name: `${project}!2440` }))
    .toHaveAttribute("href", `https://${project}/-/merge_requests/2440`);
  await expect(page.getByRole("link", { name: `${project}!2436` }))
    .toHaveAttribute("href", `https://${project}/-/merge_requests/2436`);
  const facts = await deliveryFacts(page);
  const at = (term: string) => facts.indexOf(facts.find((fact) => fact.startsWith(term))!);
  expect(facts.slice(at("MR !2440:"), at("MR !2436:"))).toEqual([
    "MR !2440: OpenObserved on GitLab 1m ago",
    "Approvals: Approved2 approvals.",
    "Pipeline: RunningPipeline #90142.",
    "Merge Train: Running, Position 2",
    "Head: 5c1e0b7",
    "Target Branch: main",
  ]);
  expect(facts[at("MR !2436:")]).toBe("MR !2436: UnavailableThe GitLab CLI on the campaign's runner isn't signed in to this host.");
  expect(facts.join("\n")).not.toMatch(/PR #|GitHub|Passed/);
  await assertNoHorizontalOverflow(page, ".campaign-status");
  if (GITLAB_EVIDENCE_DIR) {
    await page.locator("section.campaign-detail-section", { has: page.locator("h4", { hasText: /^Links$/ }) }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${GITLAB_EVIDENCE_DIR}/gitlab-links-desktop.png` });
    await page.locator("section.campaign-detail-section", { has: page.locator("h4", { hasText: /^Delivery$/ }) }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${GITLAB_EVIDENCE_DIR}/gitlab-delivery-desktop.png` });
  }
});

test("a member sees its assignment, and leaving the campaign returns the open panel to the launcher", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=member");
  await expect(page.locator(".campaign-status-context")).toContainText("#2417 Campaign Orchestrator");
  const assignment = page.locator(".campaign-work-row.is-assignment");
  await expect(assignment).toContainText("Campaign Status Panel");
  await expect(assignment).toContainText("Current Assignment");
  await expect(assignment).toHaveAttribute("tabindex", "0");

  await page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.navigate("s_other"));
  await expect(page.locator("#right-panel")).toBeVisible();
  await expect(page.locator(".session-tools")).toBeVisible();
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

test("a campaign complete with handoffs lists the owner's items without a recovery warning (#4070)", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign&handoffs=before");
  await expect(page.locator(".campaign-status-summary")).toContainText("Blocked");
  await expect(page.getByText("Authorized Recovery Unavailable")).toBeVisible();
  await expect(page.locator(".campaign-status-handoffs")).toHaveCount(0);

  await expect(page.locator(".campaign-status-summary")).toContainText("6 of 8 Delivered");
  await expect(workRows(page)).toHaveCount(2);

  await page.goto("/campaign-status-e2e.html?scenario=campaign&handoffs=after");
  await expect(page.locator(".campaign-status-summary")).toContainText("Complete with Handoffs");
  await expect(page.locator(".campaign-status-summary")).toContainText("6 of 8 Delivered");
  await expect(workRows(page)).toHaveCount(2);
  await expect(workRows(page).first()).toContainText("Handed Off");
  await expect(page.getByText("stays blocked")).toHaveCount(0);
  const handoffs = page.locator(".campaign-status-handoffs");
  await expect(handoffs.getByRole("heading", { name: "Handed Off" })).toBeVisible();
  await expect(handoffs).toContainText("File the security advisory from a maintainer account.");
  await expect(handoffs).toContainText("External");
  await expect(page.getByText("Authorized Recovery Unavailable")).toHaveCount(0);
  await expect(page.getByText("Recovery Blocked")).toHaveCount(0);
  await expect(page.getByText("Recovery Resolved")).toBeVisible();
  await handoffs.getByRole("button", { name: "Open Details for Ledger Read API" }).click();
  await expect(page.locator("h3.campaign-detail-title")).toContainText("Ledger Read API");
  await expect(page.locator(".campaign-detail-head")).toContainText("Handed Off");
  await expect(page.locator(".campaign-detail-head")).not.toContainText("Blocked");
  await assertNoHorizontalOverflow(page, ".campaign-status");
});

// UI evidence for #3361: set CAMPAIGN_RECOVERY_HOLD_EVIDENCE_DIR to capture each recovery hold. The
// capture comes before the assertions, so the same run against the old panel records "before".
const RECOVERY_HOLD_EVIDENCE_DIR = process.env.CAMPAIGN_RECOVERY_HOLD_EVIDENCE_DIR;
const RECOVERY_HOLDS = [
  { name: "complete", query: "activity=complete&automation=complete", label: "Campaign Complete", notice: null },
  { name: "cleanup", query: "activity=cleanup&automation=complete", label: "Complete, Needs Cleanup", notice: null },
  { name: "active", query: "activity=active&automation=complete", label: "Campaign Active", notice: "No Recovery Needed" },
  { name: "stuck", query: "activity=stuck&automation=held", label: "Campaign Stuck", notice: "Authorized Recovery Unavailable" },
] as const;
for (const theme of ["dark", "light"] as const) {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
    for (const hold of RECOVERY_HOLDS) {
      test(`${hold.label} shows ${hold.notice ?? "no recovery notice"} for its recovery hold on a ${device} ${theme} viewport (#3361)`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(`/campaign-status-e2e.html?scenario=campaign&${hold.query}&theme=${theme}`);
        await expect(page.locator(".campaign-status-summary")).toContainText(hold.label);
        const titled = (title: string) => page.locator(".notice", { has: page.locator(".notice-title", { hasText: title }) });
        // Frame where the recovery notice is, or where it would be: just above Authorized Issue Scope.
        const notice = page.locator(".notice", { has: page.locator(".notice-title", { hasText: /^(No Recovery Needed|Authorized Recovery Unavailable)$/u }) });
        await (await notice.count() ? notice : page.getByRole("heading", { name: "Authorized Issue Scope" })).scrollIntoViewIfNeeded();
        if (RECOVERY_HOLD_EVIDENCE_DIR) await page.screenshot({ path: `${RECOVERY_HOLD_EVIDENCE_DIR}/recovery-${hold.name}-${device}-${theme}.png` });
        if (hold.notice === "No Recovery Needed") {
          await expect(titled("No Recovery Needed")).toHaveClass(/\bt-neutral\b/u);
          await expect(titled("No Recovery Needed")).toHaveAttribute("role", "status");
          await expect(titled("No Recovery Needed")).toContainText("The campaign has no unfinished original scoped recovery obligation.");
          await expect(titled("Authorized Recovery Unavailable")).toHaveCount(0);
        } else if (hold.notice) {
          await expect(titled("Authorized Recovery Unavailable")).toHaveClass(/\bt-warning\b/u);
          await expect(titled("Authorized Recovery Unavailable")).toContainText("Reconcile its original obligation before continuing.");
          await expect(titled("No Recovery Needed")).toHaveCount(0);
        } else {
          await expect(page.getByText(/Authorized Recovery Unavailable|No Recovery Needed/u)).toHaveCount(0);
        }
        await assertNoHorizontalOverflow(page, ".campaign-status");
      });
    }
  }
}

// UI evidence: set CAMPAIGN_WORKTREE_CLEANUP_EVIDENCE_DIR to capture the refused-worktree Cleanup row.
// The capture comes before the assertions, so the same run against the old panel records "before".
for (const theme of ["dark", "light"] as const) {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
    test(`a refused worktree's Cleanup row shows what Wollipog knows and the next step, with no command, on a ${device} ${theme} viewport`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-11-06T12:00:00Z"));
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&activity=cleanup&automation=complete&theme=${theme}`);
      await expect(page.locator(".campaign-status-summary")).toContainText("Complete, Needs Cleanup");
      const cleanup = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Cleanup", exact: true }) });
      const row = cleanup.locator("li").filter({ hasText: "/home/dev/worktrees/wollipog/s_079714ea231c" });
      await row.scrollIntoViewIfNeeded();
      if (process.env.CAMPAIGN_WORKTREE_CLEANUP_EVIDENCE_DIR) await page.screenshot({
        path: `${process.env.CAMPAIGN_WORKTREE_CLEANUP_EVIDENCE_DIR}/worktree-cleanup-${device}-${theme}.png`,
      });
      await expect(row.locator("dt")).toHaveText(["Worktree", "Reason", "Action"]);
      await expect(row.locator("code")).toHaveText(["/home/dev/worktrees/wollipog/s_079714ea231c"]);
      await expect(row).toContainText('The worktree has uncommitted changes (2 paths): "report.md", "notes.txt".');
      await expect(row.getByRole("link")).toHaveCount(1);
      await expect(row).toContainText("Review the child's work from its session in Wollipog. Ask its session or the Orchestrator " +
        "to commit and push the changes you want to keep, or confirm they are not needed. Then ask the Orchestrator to retire " +
        "the worktree through Wollipog.");
      await expect(row).not.toContainText(/git -C|\bgit (status|log)\b/u);
      await expect(row.getByRole("button")).toHaveCount(0);
      // The merged branch's deletion command is unchanged: it does not run inside a worktree.
      await expect(cleanup.getByRole("button", { name: "Copy Command for agent/s_9d2f41c07a11" })).toBeVisible();
      await assertNoHorizontalOverflow(page, ".campaign-status");
    });
  }
}

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

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`personal-rule approval shows the exact rule and campaign bounds at ${viewport.width}px (#4540)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&owners=after&personalRule=1");
    await page.getByRole("button", { name: "Open Request: Merge picoduck/wollipog#4141" }).click();
    await page.getByRole("button", { name: "All Requests" }).click();
    await page.getByText("Owner Decision Required", { exact: true }).click();
    const detail = page.locator(".request-panel-detail");
    await expect(detail).toContainText("~/.claude/CLAUDE.md");
    await expect(detail).toContainText("Ask before merging a pull request.");
    await expect(detail).toContainText("boundary revision 3");
    await expect(detail).toContainText("Repository rules, installed skills and Human Required rules remain unchanged.");
    await expect(detail.getByRole("button", { name: "Delegate for This Campaign", exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Keep My Approval", exact: true })).toBeVisible();
    await expect(detail.getByRole("listitem")).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Do Not Proceed", exact: true })).toHaveCount(0);
    await assertNoHorizontalOverflow(page, ".request-panel-detail");
    if (process.env.PERSONAL_RULE_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.PERSONAL_RULE_EVIDENCE_DIR}/personal-rule-${viewport.width}.png` });
  });
}

test("decisions the owner kept wait for them in Campaign Status, and each opens its card (#4064)", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign&owners=before");
  await expect(page.locator(".campaign-status-summary")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for You" })).toHaveCount(0);

  await page.goto("/campaign-status-e2e.html?scenario=campaign&owners=after");
  const waiting = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Waiting for You" }) });
  await expect(waiting).toContainText("Which credential design should the provider bridge use?");
  await expect(waiting).toContainText("Merge picoduck/wollipog#4141");
  await expect(waiting).toContainText("Handed over by the Orchestrator");
  // A child's handed-off merge opens in Requests, where the owner now decides it.
  await waiting.getByRole("button", { name: "Open Request: Merge picoduck/wollipog#4141" }).click();
  await expect(page.locator(".rpanel-switcher-name")).toHaveText("Requests");
  const detail = page.locator(".request-panel-detail");
  await expect(detail).toContainText("PR Merge Approval Required");
  await expect(detail.getByRole("button", { name: "Approve" })).toBeVisible();
  // The root's own owner decision is a card for the owner too. (In the app, Open Request takes the
  // root's own request to its dock card above the composer, which this harness does not render.)
  await page.getByRole("button", { name: "All Requests" }).click();
  await page.getByText("Owner Decision Required", { exact: true }).click();
  await expect(detail).toContainText("Owner Decision Required");
  await expect(detail).toContainText("Short-Lived Lease (Recommended)");
  await expect(detail).toContainText("You kept this decision, so only you can make it.");
  await expect(detail.getByRole("button", { name: "Do Not Proceed" })).toBeVisible();
  await assertNoHorizontalOverflow(page, ".request-panel-detail");
});

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  for (const route of [
    { name: "lineage requiring an increase (#4333)", scope: "1&lineageReview=1&lineageIncrease=1", request: "wd_scope_141", summary: "Add team/repo#141, team/repo#142, raising Maximum Issues from 6 to 7. The named epic is outside the authorized epics, so it needs your approval. (epic_not_authorized)", limit: "6 to 7" },
    { name: "lineage requiring a person (#4333)", scope: "1&lineageReview=1", request: "wd_scope_141", summary: "Add team/repo#141. The publication's authority differs from the current boundary, so it needs your approval. (publication_authority_changed)", limit: "6 to 7" },
    { name: "a proposal without lineage (#4267)", scope: "1", request: "wd_scope_141", summary: "Add team/repo#141, team/repo#142, raising Maximum Issues from 6 to 7", limit: "6 to 7" },
    { name: "a failed grant's proposal (#4334)", scope: "grant", request: "wd_scope_143", summary: "Add team/repo#143, team/docs#7, raising Maximum Issues from 6 to 9", limit: "6 to 9" },
    { name: "a proposal check's owner route (#4334)", scope: "proposal", request: "wd_scope_151", summary: "Add team/repo#151, team/repo#152, raising Maximum Issues from 6 to 8", limit: "6 to 8" },
  ]) {
    test(`${route.name} waits for the owner as a Scope Approval and opens its own request, ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&ownerScope=${route.scope}`);
      const waiting = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Waiting for You" }) });
      await expect(waiting.locator("dt")).toHaveText(["Scope Approval"]);
      await expect(waiting).toContainText(route.summary);
      await expect(waiting).toContainText("Proposed by the Orchestrator");
      await expect(waiting).toContainText("Only you can make this decision.");
      await assertNoHorizontalOverflow(page, ".campaign-status");
      const openRequest = waiting.getByRole("button", { name: `Open Request: ${route.summary}`, exact: true });
      await openRequest.scrollIntoViewIfNeeded();
      const increase = route.scope.includes("lineageIncrease");
      const capture = `${increase ? "increase" : "publication"}-${viewport.name}`;
      if (route.name.includes("#4333")) {
        if (viewport.name === "phone") {
          const buttonBox = await openRequest.boundingBox();
          const barBox = await page.getByRole("navigation", { name: "App Navigation" }).boundingBox();
          expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(barBox!.y);
        }
        if (SCOPE_EVIDENCE_DIR) await page.screenshot({ path: `${SCOPE_EVIDENCE_DIR}/campaign-${capture}.png`, fullPage: true });
      }
      await openRequest.click();
      const card = page.locator(`[data-session-request-id="${route.request}"]`);
      await expect(card).toBeVisible();
      if (route.name.includes("#4333")) {
        await expect(card).toContainText(increase ? "epic_not_authorized" : "publication_authority_changed");
        await expect(card).toContainText(increase ? "raises Maximum Issues from 6 to 7" : "counts it once");
        await assertNoHorizontalOverflow(page, ".request-card");
        await card.getByRole("button", { name: "Expand Decision", exact: true }).click();
        if (SCOPE_EVIDENCE_DIR) await page.screenshot({ path: `${SCOPE_EVIDENCE_DIR}/expanded-${capture}.png`, fullPage: true });

      }
      await expect(card.locator(":focus")).toHaveCount(1);
      // The card it opens states the same increase the entry names (#4334).
      if (!route.name.includes("#4333")) await expect(card).toContainText(`Maximum Issues${route.scope === "proposal" ? ": " : ""}${route.limit}`);
    });
  }

  test(`each routed scope approval opens exactly its own request, ${viewport.name} (#4334)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&ownerScope=routed");
    const waiting = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Waiting for You" }) });
    await expect(waiting.locator("dt")).toHaveText(["Scope Approval", "Scope Approval", "Scope Approval"]);
    await expect(waiting.getByText("Only you can make these decisions.")).toBeVisible();
    // The third request waits behind the first in the dock, so reaching it can't be an accident.
    await waiting.getByRole("button", { name: "Open Request: Add team/repo#151, team/repo#152, raising Maximum Issues from 6 to 8", exact: true }).click();
    const card = page.locator('[data-session-request-id="wd_scope_151"]');
    await expect(card).toBeVisible();
    await expect(card.locator(":focus")).toHaveCount(1);
    await expect(card.getByText("Approve Scope")).toBeVisible();
    await expect(page.locator('[data-session-request-id="wd_scope_141"]')).toHaveCount(0);
  });

  test(`routed scope approvals leave Waiting for You once settled, ${viewport.name} (#4334)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&ownerScope=routed");
    const heading = page.getByRole("heading", { name: "Waiting for You" });
    await expect(heading).toBeVisible();
    await page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__!.bumpRevision());
    await expect(heading).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Open Request: Add team\/repo/u })).toHaveCount(0);
    await expect(page.locator(".campaign-status")).toBeVisible();
  });

  test(`a merge an installed rule keeps for the owner waits for them with the rule's source and quote, ${viewport.name} (#4137)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&owners=rule");
    const waiting = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Waiting for You" }) });
    await expect(waiting).toContainText("Kept by Rule");
    await expect(waiting).toContainText("Merge picoduck/wollipog#4141");
    await expect(waiting).toContainText("~/.codex/skills/issue-workflow/SKILL.md");
    await expect(waiting).toContainText("Never merge a pull request without per-PR user authorization");
    await assertNoHorizontalOverflow(page, ".campaign-status");
    await waiting.getByRole("button", { name: "Open Request: Merge picoduck/wollipog#4141" }).click();
    const detail = page.locator(".request-panel-detail");
    await expect(detail).toContainText("PR Merge Approval Required");
    await expect(detail).toContainText("An installed or user-authored rule keeps this decision for a person, so no agent can make it.");
    await expect(detail).toContainText("Rule Source");
    await expect(detail).toContainText("~/.codex/skills/issue-workflow/SKILL.md");
    await expect(detail.getByRole("button", { name: "Approve" })).toBeVisible();
    await assertNoHorizontalOverflow(page, ".request-panel-detail");
  });

  test(`a request to add a repository waits for the owner in Waiting for You, ${viewport.name} (#4117)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&ownerAddition=1");
    const waiting = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Waiting for You" }) });
    await expect(waiting).toContainText("Only you can make this decision.");
    await expect(waiting.locator("dt")).toHaveText(["Add Repository"]);
    await expect(waiting).toContainText("Add picoduck/notes-site to the campaign");
    await expect(waiting).toContainText("Asked by the Orchestrator");
    await waiting.scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(page, ".campaign-status");
    if (REPOSITORIES_EVIDENCE_DIR) await page.screenshot({ path: `${REPOSITORIES_EVIDENCE_DIR}/waiting-add-repository-${viewport.name}.png` });
  });
}
