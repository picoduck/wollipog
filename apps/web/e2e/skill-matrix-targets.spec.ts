import { expect, test } from "@playwright/test";
import { installSkillMatrixFixture } from "./skill-matrix.fixture.js";

/**
 * #1714: a Machine that offers container or cloud targets says its assigned skills do not reach
 * them; a host-only Machine says nothing new. Same gate and wording as the #1695 session notice.
 */

const UNAVAILABLE = /Managed skills from this Machine are unavailable on container and cloud targets/u;

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`target note appears only on the Machine with container and cloud targets at ${width} in ${theme}`, async ({ page }, info) => {
    await installSkillMatrixFixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills-removals-e2e.html?matrix=1&onlineMatrix=1&targets=1");
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.getByRole("button", { name: /code-review/i }).click();
    const matrix = page.getByRole("region", { name: "Machine × Agents", exact: true });

    const build = matrix.getByRole("article", { name: "Assignments on Build Machine", exact: true });
    const note = build.getByRole("note", { name: "Skills Unavailable on Container and Cloud Targets", exact: true });
    await expect(note).toBeVisible();
    await expect(note).toContainText(UNAVAILABLE);
    await expect(note).toContainText("Affected targets: Offline Container, Cloud Sandbox.");
    const box = await note.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);

    const other = matrix.getByRole("article", { name: "Assignments on Other Machine", exact: true });
    await expect(other).toBeVisible();
    await expect(other.getByRole("note")).toHaveCount(0);
    await expect(other).not.toContainText(UNAVAILABLE);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await matrix.screenshot({ path: info.outputPath(`matrix-targets-${width}-${theme}.png`) });
  });
}
