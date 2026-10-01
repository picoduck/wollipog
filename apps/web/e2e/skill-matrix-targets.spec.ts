import { expect, test } from "@playwright/test";
import { installSkillMatrixFixture } from "./skill-matrix.fixture.js";

/**
 * #1714, #1981: a Machine that offers container or cloud targets says, in one plain sentence on its
 * Deployment row, that its assigned skills do not reach them; a host-only Machine says nothing new.
 */

const SENTENCE = "Assigned skills load only in host sessions, so they don't reach Offline Container or Cloud Sandbox.";

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`target sentence appears only on the Machine with container and cloud targets at ${width} in ${theme}`, async ({ page }, info) => {
    await installSkillMatrixFixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills-removals-e2e.html?matrix=1&onlineMatrix=1&targets=1");
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
    const table = page.locator("table.skill-deployment");

    const build = table.getByRole("rowgroup", { name: "Build Machine", exact: true });
    const note = build.locator(".skill-deployment-machine .cell-note", { hasText: SENTENCE });
    await expect(note).toBeVisible();
    const box = await note.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);

    const other = table.getByRole("rowgroup", { name: "Other Machine", exact: true });
    await expect(other).toBeVisible();
    await expect(other).not.toContainText("host sessions");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await table.screenshot({ path: info.outputPath(`deployment-targets-${width}-${theme}.png`) });
  });
}
