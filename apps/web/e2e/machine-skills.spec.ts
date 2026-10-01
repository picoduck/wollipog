import { expect, test } from "@playwright/test";

/** #1981: a machine's own skills diagnostics, moved from the skill detail into its Connections
 * details: its unmanaged skills, named by agent, and every link removal it reported. */

for (const width of [1280, 390]) {
  test(`Skills on This Machine lists unmanaged skills and the whole removal history at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/machine-management-e2e.html");
    await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
    const disclosure = page.locator("details.machine-skills");
    await disclosure.locator("summary").click();
    await expect(disclosure.getByRole("heading", { name: "Unmanaged Skills" })).toBeVisible();
    await expect(disclosure).toContainText("local-notes · Custom ACP — Scratch notes kept outside Wollipog");
    await expect(disclosure).not.toContainText("custom-acp");
    await expect(disclosure.getByRole("heading", { name: "Recent Link Removals" })).toBeVisible();
    await expect(disclosure).toContainText("~/.claude/skills/code-review — No longer in the desired skill list.");
    await expect(disclosure).toContainText("~/.codex/skills/retired-skill-with-a-long-name-that-wraps");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await disclosure.screenshot({ path: info.outputPath(`machine-skills-${width}.png`) });
  });
}
