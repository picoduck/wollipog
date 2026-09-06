import { expect, test } from "@playwright/test";

test.use({ video: "on" });
for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`Git import previews files and requires update acceptance at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let imports = 0;
    await page.route("**/api/skill-git/preview", async (route) => {
      await route.fulfill({ json: { previewId: "preview-1", candidates: [{
        name: "code-review", path: "skills/code-review", commit: "a".repeat(40), digest: "d2",
        source: { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "skills" },
        files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\nReview the diff and verify affected callers." }],
        previousFiles: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\nReview the diff." }],
        disposition: "update", assignmentCount: 2, executablePaths: [],
      }] } });
    });
    await page.route("**/api/skill-git/import", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ previewId: "preview-1", path: "skills/code-review", acceptUpdate: true });
      imports++;
      await route.fulfill({ json: { skill: { id: "skill-1", name: "code-review" } } });
    });
    await page.route("**/api/skill-git/preview/preview-1", (route) => route.fulfill({ status: 204 }));
    await page.goto("/skills-removals-e2e.html");
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole("button", { name: "Import from Git" }).click();
    await page.getByLabel("Git Repository", { exact: true }).fill("example/skills");
    await page.getByRole("button", { name: "Preview Skills" }).click();
    await expect(page.getByText("New version · 2 existing assignments")).toBeVisible();
    await page.getByText("SKILL.md · Changed", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Current", exact: true })).toBeVisible();
    await expect(page.getByText("Review the diff and verify affected callers.", { exact: false })).toBeVisible();
    await page.getByRole("checkbox", { name: "code-review", exact: true }).check();
    const submit = page.getByRole("button", { name: "Import Selected" });
    await expect(submit).toBeDisabled();
    expect(imports).toBe(0);
    await page.screenshot({ path: info.outputPath(`git-preview-${width}-${theme}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await page.getByRole("checkbox", { name: "Accept Version Diffs and Update Existing Assignments" }).check();
    await submit.click();
    await expect(page.getByRole("status")).toHaveText("Imported: code-review");
    expect(imports).toBe(1);
  });
}
