import { expect, test } from "@playwright/test";

/** #1981: a machine's own skills diagnostics, moved from the skill detail into its Connections
 * details: its unmanaged skills, named by agent, and every link removal it reported. */

for (const width of [1280, 390]) {
  test(`Skills on This Machine lists unmanaged skills and the whole removal history at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/machine-management-e2e.html");
    // The machine opens from its row: as the detail route on a phone (#2985), beside the list and its
    // All Machines overview wider (#2986).
    await page.getByRole("complementary", { name: "Machines" }).locator("button.row.row-2").click();
    await expect(page.getByRole("heading", { name: "Design Workstation", exact: true })).toBeVisible();
    const disclosure = page.locator("details.machine-skills");
    await disclosure.locator("summary").click();
    // #2989: section labels over surfaces of rows, the meta 12px apart rather than dot- or dash-joined.
    await expect(disclosure.getByRole("heading", { name: "Unmanaged Skills" })).toBeVisible();
    const skill = disclosure.getByRole("list", { name: "Unmanaged Skills" }).getByRole("listitem").filter({ hasText: "local-notes" });
    await expect(skill.locator(".row-line")).toContainText("Custom ACP");
    await expect(skill.locator(".row-sub")).toHaveText("Scratch notes kept outside Wollipog");
    await expect(disclosure).not.toContainText("custom-acp");
    await expect(disclosure).not.toContainText(" · ");
    await expect(disclosure.getByRole("heading", { name: "Recent Link Removals" })).toBeVisible();
    const removals = disclosure.getByRole("list", { name: "Recent Link Removals" });
    await expect(removals.getByRole("listitem").filter({ hasText: "~/.claude/skills/code-review" }).locator(".row-sub"))
      .toHaveText("No longer in the desired skill list.");
    await expect(removals).toContainText("~/.codex/skills/retired-skill-with-a-long-name-that-wraps");
    await expect(disclosure.locator(".machine-skills-reported")).toHaveText(/^Reported .+ ago$|^Reported just now$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await disclosure.screenshot({ path: info.outputPath(`machine-skills-${width}.png`) });
  });

  test(`a masked account email keeps its whole reveal control, and closing the section hides it again at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
    await page.goto("/machine-management-e2e.html?emailLabels");
    await page.getByRole("complementary", { name: "Machines" }).locator("button.row.row-2").click();
    const disclosure = page.locator("details.machine-skills");
    await disclosure.locator("summary").click();
    const skill = disclosure.getByRole("list", { name: "Unmanaged Skills" }).getByRole("listitem").filter({ hasText: "local-notes" });
    await expect(skill).toContainText("Email Hidden");
    await expect(skill).not.toContainText("work@example.com");
    const reveal = skill.getByRole("button", { name: "Show Account Email" });
    // Whole and inside its row: a clipped control could not be pressed (review CR-1.2). In view
    // first: the sections above it (Provider Accounts, #2995) can push it below the fold.
    await reveal.scrollIntoViewIfNeeded();
    const [control, row] = await Promise.all([reveal.boundingBox(), skill.boundingBox()]);
    expect(control!.x + control!.width).toBeLessThanOrEqual(row!.x + row!.width);
    expect(await reveal.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return button === hit || button.contains(hit);
    })).toBe(true);
    await reveal.click();
    await expect(skill).toContainText("work@example.com");
    await disclosure.locator("summary").click();
    await disclosure.locator("summary").click();
    await expect(skill).toContainText("Email Hidden");
    await expect(skill).not.toContainText("work@example.com");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test(`Skills on This Machine says when nothing is reported, and Retry recovers a failed read at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const open = async (query: string) => {
      await page.goto(`/machine-management-e2e.html?${query}`);
      await page.getByRole("complementary", { name: "Machines" }).locator("button.row.row-2").click();
      const disclosure = page.locator("details.machine-skills");
      await disclosure.locator("summary").click();
      return disclosure;
    };
    const empty = await open("skills=empty");
    await expect(empty).toContainText("This machine reports no unmanaged skills.");
    await expect(empty).toContainText("No managed link removals have been reported.");

    const failed = await open("skills=fail");
    const notice = failed.locator('.notice.t-danger[role="alert"]');
    await expect(notice).toContainText("Couldn't Load Skills on This Machine");
    await notice.getByRole("button", { name: "Retry" }).click();
    await expect(notice).toHaveCount(0);
    await expect(failed.getByRole("heading", { name: "Unmanaged Skills" })).toBeVisible();
  });
}
