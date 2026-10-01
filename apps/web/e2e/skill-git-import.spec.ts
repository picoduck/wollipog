import { expect, test } from "@playwright/test";
import { choosePageAction } from "./page-actions.js";

test.use({ video: "on" });
test("Check for Updates preserves the source and previews the recorded skill directory", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route("**/api/skill-git/preview", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ url: "https://github.com/example/skills.git", ref: "stable", subdirectory: "skills/code-review" });
    await route.fulfill({ json: { previewId: "updates", candidates: [] } });
  });
  await page.goto("/skills-removals-e2e.html");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  const source = page.locator(".skill-detail > section.section").filter({ has: page.getByRole("heading", { name: "Source", exact: true }) });
  await expect(source.locator(".facts dt")).toHaveText(["Repository", "Folder", "Branch or Tag", "Commit"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: info.outputPath("git-source-mobile-after.png"), fullPage: true });
  await source.getByRole("button", { name: "Check for Updates…" }).click();
  await expect(page.getByLabel("Git Repository", { exact: true })).toHaveValue("https://github.com/example/skills.git");
  await expect(page.getByLabel("Ref", { exact: true })).toHaveValue("stable");
  await expect(page.getByLabel("Repository Subdirectory")).toHaveValue("skills/code-review");
  await page.getByRole("button", { name: "Preview Skills" }).click();
  await expect(page.getByText("No remaining skill candidates in this preview.")).toBeVisible();
});
for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`Git import previews files and requires update acceptance at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let imports = 0;
    await page.route("**/api/skill-git/preview", async (route) => {
      await route.fulfill({ json: { previewId: "preview-1", candidates: [{
        name: "code-review", path: "skills/code-review", commit: "a".repeat(40), digest: "d2",
        source: { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "skills" },
        files: [
          { path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\nReview the diff and verify affected callers." },
          { path: "scripts/check.sh", encoding: "utf8", content: "#!/bin/sh\nset -eu\nnpm test\nnpm run lint\n" },
        ],
        previousFiles: [
          { path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\nReview the diff." },
          { path: "scripts/check.sh", encoding: "utf8", content: "#!/bin/sh\nnpm test\n" },
        ],
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
    await choosePageAction(page, "Import from Git…", "Import");
    await page.getByLabel("Git Repository", { exact: true }).fill("example/skills");
    await page.getByRole("button", { name: "Preview Skills" }).click();
    await expect(page.getByText("New version · 2 existing assignments")).toBeVisible();
    // One highlighted diff per file (#1948): the changed line is one − and one + line, and the
    // changed script is flagged with its counts.
    const skill = page.locator(".skill-diff-file", { hasText: "SKILL.md" });
    await expect(skill.locator(".skill-diff-file-head")).toContainText("Changed");
    await expect(skill.locator(".diff-line-del")).toHaveText(["Removed line 4−Review the diff. No newline at end of file"]);
    await expect(skill.locator(".diff-line-add")).toHaveText(["Added line 4+Review the diff and verify affected callers. No newline at end of file"]);
    await expect(page.getByRole("heading", { name: "Current", exact: true })).toHaveCount(0);
    const script = page.locator(".skill-diff-file", { hasText: "scripts/check.sh" });
    await expect(script.locator(".skill-diff-file-head .status")).toHaveText(["Script", "Changed"]);
    await expect(script.locator(".skill-diff-counts")).toContainText("+2 −0");
    // No consent until an update that deploys somewhere is selected.
    await expect(page.locator(".modal-foot").getByRole("checkbox")).toHaveCount(0);
    await page.getByRole("checkbox", { name: "code-review", exact: true }).check();
    const submit = page.getByRole("button", { name: "Import Selected" });
    await expect(submit).toBeDisabled();
    const consent = page.locator(".modal-foot").getByRole("checkbox", { name: "Deploy to 2 existing assignments", exact: true });
    await expect(consent).toBeVisible();
    expect(imports).toBe(0);
    await page.screenshot({ path: info.outputPath(`git-preview-${width}-${theme}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await consent.check();
    await submit.click();
    await expect(page.getByRole("status")).toHaveText("Imported: code-review");
    expect(imports).toBe(1);
  });
}
