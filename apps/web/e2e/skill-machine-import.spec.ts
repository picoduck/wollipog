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

test("a snapshot-capable runner explains the newer recovery protocol requirement", async ({ page }) => {
  await page.goto("/skills-removals-e2e.html?legacyRecovery=1");
  await page.getByRole("button", { name: "Import from Machine" }).click();
  await expect(page.getByRole("button", { name: "Inspect Recovery" })).toBeDisabled();
  await expect(page.getByText("Recovery inspection requires protocol 116 or newer.")).toBeVisible();
});

test("a macOS runner remains unavailable without a native no-follow snapshot reader", async ({ page }) => {
  await page.goto("/skills-removals-e2e.html?macos=1");
  await page.getByRole("button", { name: "Import from Machine" }).click();
  await expect(page.getByRole("button", { name: "Discover Skills" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Inspect Recovery" })).toBeDisabled();
  await expect(page.getByText("No compatible connected machines.")).toBeVisible();
});

test("a Windows runner offers snapshots while explaining that adoption remains Linux-only", async ({ page }) => {
  await page.goto("/skills-removals-e2e.html?windows=1");
  await page.getByRole("button", { name: "Import from Machine" }).click();
  await expect(page.getByRole("button", { name: "Discover Skills" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Inspect Recovery" })).toBeDisabled();
  await expect(page.getByText("Recovery inspection and source adoption require a Linux runner.")).toBeVisible();
});

test("switching machines clears inspected adoption recovery", async ({ page }) => {
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  await page.route("**/api/runners/runner-1/skill-adoption-recovery", (route) => route.fulfill({ json: {
    operations: [{ operationId, backupDirectory: `.codex/skills/.wollipog-adoption-${operationId}`,
      sourceDirectory: ".codex/skills", name: "code-review", digest: "a".repeat(64), state: "managed_linked",
      detail: "The managed link is active and the original is preserved." }], truncated: false,
  } }));
  await page.goto("/skills-removals-e2e.html?matrix=1&onlineMatrix=1");
  await page.getByRole("button", { name: "Import from Machine" }).click();
  await page.getByRole("button", { name: "Inspect Recovery" }).click();
  await expect(page.getByRole("heading", { name: "Adoption Recovery" })).toBeVisible();
  await page.getByRole("button", { name: /^Machine:/ }).click();
  await page.getByRole("option", { name: "Other Machine", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adoption Recovery" })).toBeHidden();
  await expect(page.getByRole("status")).toBeHidden();
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

for (const width of [1280, 320]) for (const theme of ["dark", "light"]) test(
  `adoption recovery requires an inspected operation and explicit restore at ${width} in ${theme}`,
  async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const operationId = "123e4567-e89b-42d3-a456-426614174000";
    let restored = false;
    const operation = () => ({
      operationId,
      backupDirectory: `.codex/skills/.wollipog-adoption-${operationId}`,
      sourceDirectory: ".codex/skills",
      name: "code-review",
      digest: "a".repeat(64),
      state: restored ? "restored" : "managed_linked",
      detail: restored ? "A recovery link exposes the preserved original at its source path." : "The managed link is active and the original is preserved.",
    });
    await page.route("**/api/runners/runner-1/skill-adoption-recovery", (route) =>
      route.fulfill({ json: { operations: [operation()], truncated: false } }));
    await page.route(`**/api/runners/runner-1/skill-adoption-recovery/${operationId}/restore`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ confirmation: "explicit" });
      restored = true;
      await route.fulfill({ json: { status: "restored", operation: operation() } });
    });
    await page.goto("/skills-removals-e2e.html");
    await page.evaluate((selected) => { document.documentElement.dataset.theme = selected; }, theme);
    await page.getByRole("button", { name: "Import from Machine" }).click();
    await page.getByRole("button", { name: "Inspect Recovery" }).click();
    await expect(page.getByRole("heading", { name: "Adoption Recovery" })).toBeVisible();
    const restore = page.getByRole("button", { name: "Restore Original Source" });
    await expect(restore).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`recovery-inspect-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("checkbox", { name: "Confirm Restore of code-review" }).check();
    await expect(restore).toBeEnabled();
    await restore.click();
    await expect(page.getByRole("status")).toContainText("Published a recovery link to the preserved original for code-review");
    await expect(page.getByText("A recovery link exposes the preserved original at its source path.")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`recovery-restored-${width}-${theme}.png`), fullPage: true });
  },
);
