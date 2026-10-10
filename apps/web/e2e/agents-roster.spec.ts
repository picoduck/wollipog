import { expect, test, type Page } from "@playwright/test";

/** The Agents roster (#2857): grouped two-line rows with one status word each, in a 380px panel. */
const open = async (page: Page, scene: string, theme = "dark") => {
  await page.goto(`/agents-roster-e2e.html?scene=${scene}&theme=${theme}`);
  await expect(page.locator(".agents-panel")).toBeVisible();
  if (scene !== "empty") await expect(page.locator(".worker-row").first()).toBeVisible();
};
const rowHeights = (page: Page) => page.locator(".worker-row").evaluateAll((rows) =>
  rows.map((row) => Math.round(row.getBoundingClientRect().height)));
/** The panel itself, which is the whole screen on a phone. */
const shot = (page: Page, name: string) => page.locator(".agents-roster-fixture-panel")
  .screenshot({ path: `.agents/tmp/agents-roster/${process.env.AGENTS_ROSTER_EVIDENCE ?? "after"}/${name}.png` });

test.describe("fine pointer", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a pod lead's workers sit under Subagents, Background Jobs and the pod's title, every row 56px", async ({ page }) => {
    await open(page, "pod");
    await expect(page.locator(".group-label")).toHaveText(["Subagents1", "Background Jobs1", "Parser Rewrite Pod3"]);
    expect(new Set(await rowHeights(page))).toEqual(new Set([56]));
    const inspect = page.locator(".worker-row", { hasText: "Inspect Parser Entry Points" });
    await expect(inspect.locator(".status")).toHaveText("Running");
    await expect(inspect.locator(".row-sub")).toHaveText("Running npm test -- parser");
    await expect(inspect.locator(".row-icon svg")).toHaveCount(1);
    await expect(inspect).not.toHaveAttribute("title", /.+/);
    const reviewer = page.locator(".worker-row", { hasText: "Parser Reviewer" });
    await expect(reviewer.locator(".status")).toHaveText("Approval Required");
    await expect(reviewer.locator(".row-sub")).toHaveText("Waiting to run npm run lint -- --fix");
    await expect(reviewer).toHaveAttribute("title", "Opens Parser Reviewer");
    await expect(page.locator(".worker-row", { hasText: "Test Writer" }).locator(".status")).toHaveText("Awaiting Prompt");
    await expect(page.locator(".agents-list")).not.toContainText(/Tokens|claude-opus|high|Pod Member|Subagent ·/);
    // The filter fills the panel with three equal options and no "Loaded".
    const options = await page.locator(".seg.block .seg-option").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().width)));
    expect(options).toHaveLength(3);
    expect(Math.max(...options) - Math.min(...options)).toBeLessThanOrEqual(1);
    await expect(page.locator(".seg.block")).not.toContainText("Loaded");
  });

  test("a run member's rows lead with the agent, untruncated in a 380px panel, under the run's title", async ({ page }) => {
    await open(page, "run");
    // One member has finished, so All shows both.
    await page.getByRole("radio", { name: "All, 3", exact: true }).click();
    await expect(page.locator(".group-label")).toHaveText(["Subagents1", "Release Audit for Wollipog 2026.102"]);
    const titles = page.locator(".worker-row[title] .row-title");
    await expect(titles).toHaveText(["Codex", "Gemini CLI"]);
    for (const title of await titles.all()) {
      expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await expect(page.locator(".worker-row", { hasText: "Codex" })).toHaveAttribute("title", "Opens Release Audit for Wollipog 2026.10 · Codex");
  });

  test("nested workers indent once under a spine, and the one asking says what it waits to do", async ({ page }) => {
    await open(page, "nested");
    const items = page.locator(".agents-list [role=listitem]");
    await expect(items).toHaveCount(3);
    await expect(items.nth(1)).toHaveClass(/nested/);
    await expect(items.nth(2)).toHaveClass(/nested nested-last/);
    const indents = await items.evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().left)));
    expect(indents[1]! - indents[0]!).toBe(20);
    expect(indents[2]).toBe(indents[1]);
    await expect(items.nth(1).locator(".status")).toHaveText("Approval Required");
    await expect(items.nth(1).locator(".row-sub")).toHaveText("Waiting to edit src/auth/parser.ts");
    expect(new Set(await rowHeights(page))).toEqual(new Set([56]));
  });

  test("with the runner offline, Active still lists the workers, each Unverified", async ({ page }) => {
    await open(page, "offline");
    await expect(page.getByRole("radio", { name: "Active, 3", exact: true })).toBeChecked();
    await expect(page.locator(".worker-row .status")).toHaveText(["Unverified", "Unverified", "Unverified"]);
  });

  test("an empty Active offers History", async ({ page }) => {
    await open(page, "empty");
    await expect(page.locator(".state-title")).toHaveText("No Active Workers");
    await page.getByRole("button", { name: "Show History", exact: true }).click();
    await expect(page.getByRole("radio", { name: "History, 1", exact: true })).toBeChecked();
    await expect(page.locator(".worker-row .status")).toHaveText("Completed");
  });

  test("120 workers show 50 at a time from one list foot", async ({ page }) => {
    await open(page, "many");
    const foot = page.locator(".list-foot");
    await expect(foot).toContainText("Showing 50 of 120");
    await expect(page.locator(".worker-row")).toHaveCount(50);
    await foot.getByRole("button", { name: "Show 50 More", exact: true }).click();
    await expect(page.locator(".worker-row")).toHaveCount(100);
    await expect(foot).toContainText("Showing 100 of 120");
  });
});

test.describe("coarse pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const scene of ["pod", "nested"]) test(`${scene} rows are 64px on touch, and no filter option wraps at 390px`, async ({ page }) => {
    await open(page, scene);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    expect(new Set(await rowHeights(page))).toEqual(new Set([64]));
    for (const option of await page.locator(".seg.block .seg-option").all()) {
      expect(await option.evaluate((element) => element.scrollWidth <= element.clientWidth && element.getClientRects().length === 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator(".worker-row.is-selected")).toHaveCount(0);
  });
});

// UI evidence: every scene at desktop, compact and phone widths in both themes.
for (const viewport of [{ width: 1440, height: 900 }, { width: 834, height: 1112 }, { width: 390, height: 844 }]) {
  test.describe(`evidence at ${viewport.width}px`, () => {
    test.use({ viewport, ...(viewport.width < 1000 ? { hasTouch: true, isMobile: true } : {}) });
    for (const theme of ["dark", "light"]) test(`captures every scene in ${theme}`, async ({ page }) => {
      for (const scene of ["pod", "run", "nested", "offline", "empty"]) {
        await page.goto(`/agents-roster-e2e.html?scene=${scene}&theme=${theme}`);
        // Also matches the roster before #2857, so the same capture runs against the base commit.
        await expect(page.locator(".agents-panel :is([role=listitem], .state, p[role=status])").first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await shot(page, `${scene}-${viewport.width}-${theme}`);
      }
    });
  });
}
