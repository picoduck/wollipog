import { expect, test } from "@playwright/test";

test.use({ video: "on" });
const current = { id: "v1", digest: "a".repeat(64), files: [{ path: "SKILL.md", encoding: "utf8", content: "Review the diff and all callers." }, { path: "scripts/check.sh", encoding: "utf8", content: "echo check" }] };
const historical = { id: "v0", digest: "b".repeat(64), createdAt: 1700000000000, note: "Initial reviewed version", files: [{ path: "SKILL.md", encoding: "utf8", content: "Review the diff." }] };
for (const width of [1280, 320]) for (const theme of ["dark", "light"]) {
  test(`history previews and restores with explicit acceptance at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let restores = 0;
    await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: { versions: [historical], nextCursor: null } }));
    await page.route("**/api/skills/skill-1/versions/v0", (route) => route.fulfill({ json: { version: historical, currentVersion: current } }));
    await page.route("**/api/skills/skill-1/restore", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ versionId: "v0", expectedLatestVersionId: "v1" });
      restores++;
      await route.fulfill({ json: { version: { ...historical, id: "v2" } } });
    });
    await page.goto("/skills-removals-e2e.html");
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await page.getByRole("button", { name: /code-review/i }).click();
    await page.getByRole("button", { name: "Version History", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restore Version", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Preview Version v0", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Restore Preview" })).toBeVisible();
    await page.getByText("SKILL.md · Changed", { exact: true }).click();
    await expect(page.getByText("scripts/check.sh · Removed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore Version", exact: true })).toBeDisabled();
    expect(restores).toBe(0);
    await page.screenshot({ path: info.outputPath(`history-preview-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("checkbox", { name: "Accept Version Diff and Update Existing Assignments" }).check();
    await page.getByRole("button", { name: "Restore Version", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Version restored" })).toBeVisible();
    expect(restores).toBe(1);
    await expect(page.getByRole("button", { name: "Restore Version", exact: true })).toBeDisabled();
  });
}
test("history paginates and stale restore invalidates acceptance; current versions cannot be restored", async ({ page }) => {
  await page.route("**/api/skills/skill-1/versions*", (route) => route.fulfill({ json: route.request().url().includes("?before=") ? { versions: [historical], nextCursor: null } : { versions: [current], nextCursor: "v1" } }));
  await page.route("**/api/skills/skill-1/versions/v1", (route) => route.fulfill({ json: { version: current, currentVersion: current } }));
  await page.route("**/api/skills/skill-1/versions/v0", (route) => route.fulfill({ json: { version: historical, currentVersion: current } }));
  await page.route("**/api/skills/skill-1/restore", (route) => route.fulfill({ status: 409, json: { error: "The library changed after preview. Preview the version again." } }));
  await page.goto("/skills-removals-e2e.html");
  await page.getByRole("button", { name: /code-review/i }).click();
  await page.getByRole("button", { name: "Version History", exact: true }).click();
  await page.getByRole("button", { name: "Preview Version v1", exact: true }).click();
  await expect(page.getByText("This is the current version.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore Version", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Load Older Versions" }).click();
  await page.getByRole("button", { name: "Preview Version v0", exact: true }).click();
  await page.getByRole("checkbox", { name: "Accept Version Diff and Update Existing Assignments" }).check();
  await page.getByRole("button", { name: "Restore Version", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("library changed");
  await expect(page.getByRole("heading", { name: "Restore Preview" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore Version", exact: true })).toBeDisabled();
});
