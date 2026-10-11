import { expect, test, type Locator, type Page } from "@playwright/test";

/** A worker opens as a page in Agents (#2860): its badge and facts, its request, Nested Workers and Activity. */
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 834, height: 1112 },
  { name: "phone", width: 390, height: 844 },
] as const;

/** A capture once every opening animation has finished; a Running badge's pulse never does (§11.1). */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" ||
    animation.effect?.getComputedTiming().iterations === Infinity));
  await page.screenshot({ path: `.agents/tmp/worker-page/after/${name}.png` });
}

async function openRow(panel: Locator, key: string): Promise<void> {
  const row = panel.locator(`.agents-panel [data-panel-page-key="${key}"]`);
  if (!await row.isVisible()) await panel.getByRole("radio", { name: /^All/ }).click();
  await row.scrollIntoViewIfNeeded();
  await row.click();
}

for (const viewport of VIEWPORTS) for (const theme of ["dark", "light"] as const) {
  test(`a worker's pages on ${viewport.name} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const panel = page.getByRole("complementary", { name: "Side Panel" });
    const title = panel.locator(".rpanel-page-title");
    const back = panel.getByRole("button", { name: "Back to Agents", exact: true });

    // A waiting worker: its badge, its facts, what it wants and its request, then Nested Workers and Activity.
    await page.goto(`/panel-pages-e2e.html?theme=${theme}&request=1&nested=1`);
    await openRow(panel, "subagent:worker-30");
    await expect(title).toHaveText("Profile Payouts 30");
    await expect(title).toBeFocused();
    const waiting = panel.getByRole("region", { name: "Profile Payouts 30", exact: true });
    await expect(waiting.locator(".worker-detail-head .status")).toHaveText("Approval Required");
    await expect(waiting.locator(".worker-detail-meta > li")).toContainText(["Subagent", /^Started /, "600 Tokens, 740 With Nested"]);
    await expect(waiting.locator(".notice")).toHaveText("Wants to run npm test -- payouts and is waiting for your approval.");
    await expect(waiting.getByRole("region", { name: "Pending Request", exact: true })).toContainText("npm test -- payouts");
    await expect(waiting.getByRole("list", { name: "Nested Workers" }).getByRole("button")).toHaveText([/Check Payout Fixtures/]);
    await expect(waiting.getByText("Checked 32 files in the payouts module; two need a migration step.")).toBeVisible();
    // Activity virtualizes against the panel body as the page's own child, after the request (#2941 review).
    await expect(waiting.locator(':scope > .timeline[data-virtual-kind="timeline"]')).toHaveCount(1);
    // Its scroll host, the panel body, opts out of native anchoring while it is there (#2941 review).
    expect(await panel.locator(".rpanel-body").evaluate((body) => getComputedStyle(body).overflowAnchor)).toBe("none");
    // One bar with one Back on every width; a phone's sheet draws no second bar or Back (§4.9).
    await expect(back).toHaveCount(1);
    await expect(panel.getByRole("button", { name: "Back to Session", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, `${viewport.name}-${theme}-1-waiting`);

    // A nested worker's page, running with its activity, names its parent as a link to the parent's page.
    await back.click();
    await openRow(panel, "subagent:worker-31");
    await expect(title).toHaveText("Check Payout Fixtures");
    const nested = panel.getByRole("region", { name: "Check Payout Fixtures", exact: true });
    await expect(nested.locator(".worker-detail-head .status")).toHaveText("Running");
    await expect(nested.getByText("Fixtures for refunds are stale.")).toBeVisible();
    await shot(page, `${viewport.name}-${theme}-2-nested`);
    await nested.getByRole("button", { name: "Profile Payouts 30", exact: true }).click();
    await expect(title).toHaveText("Profile Payouts 30");
    await back.click();
    await expect(title).toHaveText("Check Payout Fixtures");
    await expect(nested.getByRole("button", { name: "Profile Payouts 30", exact: true })).toBeFocused();

    // A background job opens the shared Job Detail page under its roster name, and Open in
    // Background Work lands on the same job there.
    await page.goto(`/panel-pages-e2e.html?theme=${theme}&job=1`);
    await openRow(panel, "background:job-monitor-7be210");
    await expect(title).toHaveText("Monitor Job 7be210");
    await expect(panel.locator('.agents-page .job-detail[aria-label="Monitor Job 7be210"]')).toBeVisible();
    await expect(panel.locator(".background-work-panel")).toHaveCount(0);
    await shot(page, `${viewport.name}-${theme}-3-job`);
    await panel.getByRole("button", { name: "Open in Background Work", exact: true }).click();
    await expect(title).toHaveText("Monitor Job 7be210");
    await expect(title).toBeFocused();
    await expect(panel.locator(".background-work-page .job-detail")).toBeVisible();
    await panel.getByRole("button", { name: "Back to Background Work", exact: true }).click();
    await expect(panel.locator(".background-work-panel")).toBeVisible();

    // A Codex worker has no output to show, and says so in a neutral notice.
    await page.goto(`/panel-pages-e2e.html?theme=${theme}&codex=1`);
    await openRow(panel, "subagent:worker-30");
    await expect(panel.locator(".agents-page .notice")).toHaveText("Codex doesn't report subagent output yet, so only this summary is available.");
    await shot(page, `${viewport.name}-${theme}-4-codex`);

    // Two workers under one provider id can't be told apart, so the roster can't list either; the
    // transcript's Open lands on a page that says so, with Back to Agents.
    await page.goto(`/panel-pages-e2e.html?theme=${theme}&ambiguous=1`);
    await expect(panel.locator('.agents-panel [data-panel-page-key="subagent:worker-27"]')).toHaveCount(0);
    // The fixture's stand-in for the transcript's Open sits under the phone's sheet, so it is clicked from script.
    await page.getByRole("button", { name: "Open Worker 27", exact: true }).evaluate((button: HTMLElement) => button.click());
    await expect(panel.locator(".agents-page .state-title")).toHaveText("Can't Show This Worker");
    await expect(panel.locator(".agents-page .state-body")).toHaveText(
      "Two recorded subagents share the same ID, so Wollipog can't tell which one you picked.");
    await shot(page, `${viewport.name}-${theme}-5-unavailable`);
    await panel.locator(".agents-page").getByRole("button", { name: "Back to Agents", exact: true }).click();
    await expect(panel.locator(".agents-page")).toHaveCount(0);
    await expect(panel.locator(".agents-panel")).toBeVisible();
  });
}

test("the page's header, sections and rows share the panel's left edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/panel-pages-e2e.html?request=1&nested=1");
  const panel = page.getByRole("complementary", { name: "Side Panel" });
  await openRow(panel, "subagent:worker-30");
  const edges = await panel.evaluate((aside) => {
    const body = aside.querySelector<HTMLElement>(".rpanel-body")!;
    const contentLeft = body.getBoundingClientRect().left + parseFloat(getComputedStyle(body).paddingLeft);
    const page = aside.querySelector(".agents-page .worker-detail")!;
    const parts = [".worker-detail-head", ".worker-detail-head .status", ".worker-detail-meta", ".worker-detail-request",
      ".worker-detail-section", ".worker-detail-section .group-label", ".worker-detail-section .worker-row", ".timeline"];
    return { contentLeft, parts: Object.fromEntries(parts.map((selector) =>
      [selector, page.querySelector(selector)!.getBoundingClientRect().left])) };
  });
  for (const [selector, left] of Object.entries(edges.parts)) {
    expect(Math.abs(left - edges.contentLeft), `${selector} starts on the panel's left edge`).toBeLessThanOrEqual(1);
  }
});

test("a worker's badge on its page matches its row in every state the agents harness draws", async ({ page }) => {
  await page.goto("/agents-e2e.html");
  const roster = page.locator(".agents-list");
  const states: string[] = [];
  for (const filter of ["Active, 3", "History, 1"] as const) {
    await page.goto("/agents-e2e.html");
    await page.getByRole("radio", { name: filter, exact: true }).click();
    const count = await roster.locator(".worker-row").count();
    for (let index = 0; index < count; index += 1) {
      await page.goto("/agents-e2e.html");
      await page.getByRole("radio", { name: filter, exact: true }).click();
      const row = roster.locator(".worker-row").nth(index);
      const badge = (await row.locator(".status").textContent())!;
      await row.click();
      // A job's page is the shared Job Detail, whose badge leads the page as a worker's does.
      await expect(page.locator(".agents-page :is(.worker-detail-head, .job-detail) > .status").first()).toHaveText(badge);
      states.push(badge);
    }
  }
  // Offline, a worker's page reads Unverified as its row does (#2857).
  await page.goto("/agents-e2e.html");
  await page.getByRole("button", { name: "Disconnect Runner", exact: true }).click();
  const offline = roster.locator(".worker-row").first();
  await expect(offline.locator(".status")).toHaveText("Unverified");
  await offline.click();
  await expect(page.locator(".agents-page .worker-detail-head .status")).toHaveText("Unverified");
  states.push("Unverified");
  expect(new Set(states)).toEqual(new Set(["Approval Required", "Running", "Completed", "Unverified"]));
});

test.describe("on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("the page fills the sheet with one bar and one Back, and the request card's buttons are 44px", async ({ page }) => {
    await page.goto("/panel-pages-e2e.html?request=1");
    const panel = page.getByRole("complementary", { name: "Side Panel" });
    await openRow(panel, "subagent:worker-30");
    await expect(panel.locator(".rpanel-page-title")).toHaveText("Profile Payouts 30");
    const box = (await panel.boundingBox())!;
    expect(Math.round(box.width)).toBe(390);
    await expect(panel.locator(".rpanel-head")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Back to /u })).toHaveCount(1);
    const buttons = panel.getByRole("region", { name: "Pending Request", exact: true }).locator(".btn");
    await expect(buttons.first()).toBeVisible();
    for (const height of await buttons.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
  });
});
