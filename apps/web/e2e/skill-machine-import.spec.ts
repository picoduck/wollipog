import { expect, test } from "@playwright/test";

test.use({ video: "on" });
for (const width of [1280, 320]) for (const theme of ["dark", "light"]) {
  test(`machine snapshot preview and explicit update acceptance at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const candidate = { id: "opaque", name: "code-review", sourceDirectory: ".codex/skills", generation: "generation" };
    let imports = 0;
    await page.route("**/api/runners/runner-1/skill-snapshots", (route) => route.fulfill({ json: { discoveryId: "discovery", candidates: [candidate] } }));
    await page.route("**/api/skill-machine/discovery/preview", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ candidateId: "opaque" });
      await route.fulfill({ json: { previewId: "preview", candidate, digest: "a".repeat(64), disposition: "update", assignmentCount: 2,
        files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\nInspect the full diff and callers." }, { path: "scripts/check.sh", encoding: "utf8", content: "echo review-only" }],
        previousFiles: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\nInspect the diff." }] } });
    });
    await page.route("**/api/skill-machine/discovery/import", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ previewId: "preview", acceptUpdate: true });
      imports++;
      await route.fulfill({ json: { skill: { id: "skill-1", name: "code-review" } } });
    });
    await page.route("**/api/skill-machine/discovery", (route) => route.fulfill({ status: 204 }));
    await page.goto("/skills-removals-e2e.html");
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: info.outputPath(`machine-entry-${width}-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: /code-review/i }).click();
    await expect(page.getByRole("heading", { name: "Machine Snapshot Source" })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`machine-source-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("button", { name: "Import from Machine" }).click();
    await expect(page.getByRole("button", { name: "Import Snapshot" })).toBeDisabled();
    await page.getByRole("button", { name: "Discover Skills" }).click();
    await page.getByRole("button", { name: "Preview Files for code-review from .codex/skills" }).click();
    await expect(page.getByRole("heading", { name: "Snapshot Preview" })).toBeVisible();
    await page.getByText("SKILL.md · Changed", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Current", exact: true })).toBeVisible();
    await expect(page.getByText("scripts/check.sh · Script · Added", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import Snapshot" })).toBeDisabled();
    expect(imports).toBe(0);
    await page.screenshot({ path: info.outputPath(`machine-preview-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("checkbox", { name: "Accept Version Diff and Update Existing Assignments" }).check();
    await page.getByRole("button", { name: "Import Snapshot" }).click();
    await expect(page.getByRole("status")).toHaveText("Imported: code-review. The source directory was not adopted.");
    expect(imports).toBe(1);
    await expect(page.getByRole("button", { name: "Import Snapshot" })).toBeDisabled();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  });
}
test("machine snapshot read errors block import", async ({ page }) => {
  const candidate = { id: "opaque", name: "alpha", sourceDirectory: ".codex/skills", generation: "generation" };
  await page.route("**/api/runners/runner-1/skill-snapshots", (route) => route.fulfill({ json: { discoveryId: "discovery", candidates: [candidate] } }));
  await page.route("**/api/skill-machine/discovery/preview", (route) => route.fulfill({ status: 502, json: { error: "Source changed. Discover it again." } }));
  await page.goto("/skills-removals-e2e.html");
  await page.getByRole("button", { name: "Import from Machine" }).click();
  await page.getByRole("button", { name: "Discover Skills" }).click();
  await page.getByRole("button", { name: "Preview Files for alpha from .codex/skills" }).click();
  await expect(page.getByRole("alert")).toContainText("Source changed");
  await expect(page.getByRole("button", { name: "Import Snapshot" })).toBeDisabled();
});

for (const width of [1280, 320]) for (const theme of ["dark", "light"]) test(
  `identical assigned source requires confirmed adoption at ${width} in ${theme}`,
  async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const candidate = { id: "opaque", name: "code-review", sourceDirectory: ".codex/skills", generation: "generation" };
  await page.route("**/api/runners/runner-1/skill-snapshots", (route) =>
    route.fulfill({ json: { discoveryId: "discovery", candidates: [candidate] } }));
  await page.route("**/api/skill-machine/discovery/preview", (route) =>
    route.fulfill({ json: { previewId: "preview", candidate, digest: "a".repeat(64), disposition: "identical",
      assignmentCount: 1, files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\nReview" }],
      previousFiles: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\nReview" }] } }));
  await page.route("**/api/skill-machine/discovery/adoption-preflight", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ previewId: "preview" });
    await route.fulfill({ json: { status: "prerequisites_met", mutationSupported: true, blockers: [], advisories: [],
      adoptionToken: "approval", sharedReaders: ["codex-two"], source: { candidate, digest: "a".repeat(64), checkedAt: 1 },
      notice: "Read-only prerequisite report. No directory was changed." } });
  });
  await page.route("**/api/skill-machine/discovery/adopt", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ previewId: "preview", adoptionToken: "approval",
      acceptSharedImpact: true, confirmation: "explicit" });
    await route.fulfill({ json: { status: "adopted", operationId: "operation",
      backupDirectory: ".codex/skills/.wollipog-adoption-operation" } });
  });
  await page.goto("/skills-removals-e2e.html");
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await page.getByRole("button", { name: "Import from Machine" }).click();
  await page.getByRole("button", { name: "Discover Skills" }).click();
  await page.getByRole("button", { name: "Preview Files for code-review from .codex/skills" }).click();
  const snapshotHeading = page.getByRole("heading", { name: "Snapshot Preview" });
  await expect(snapshotHeading).toBeVisible();
  await snapshotHeading.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: info.outputPath(`adoption-before-${width}-${theme}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Check Adoption" }).click();
  const adopt = page.getByRole("button", { name: "Adopt Source Directory" });
  await expect(adopt).toBeDisabled();
  await page.getByRole("checkbox", { name: "Confirm Recoverable Adoption" }).check();
  await expect(adopt).toBeDisabled();
  await page.getByRole("checkbox", { name: "Accept Shared Directory Impact" }).check();
  await page.screenshot({ path: info.outputPath(`adoption-confirm-${width}-${theme}.png`), fullPage: true });
  await adopt.click();
  await expect(page.getByRole("status")).toContainText("Original preserved at .codex/skills/.wollipog-adoption-operation");
  await page.screenshot({ path: info.outputPath(`adoption-result-${width}-${theme}.png`), fullPage: true });
});
