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
