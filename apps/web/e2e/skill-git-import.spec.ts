import { expect, test, type Locator, type Page } from "@playwright/test";
import { choosePageAction } from "./page-actions.js";

// Import from Git (#1983): two steps in one dialog. Step one is the source, step two the review of
// what it holds, with a strip naming the source and Change Source back to step one.

const at = Date.UTC(2026, 8, 24, 15, 30);
const repository = "https://github.com/example/skills.git";
const commit = "4f1c9b2e7a3d".padEnd(40, "0");
const gitSource = { url: repository, ref: "stable", subdirectory: "skills", path: "skills/code-review", commit: "a".repeat(40) };
const file = (path: string, content: string) => ({ path, encoding: "utf8", content });

const codeReview = {
  name: "code-review", path: "skills/code-review", commit, digest: "d2",
  source: { url: repository, ref: "main", subdirectory: "skills" },
  files: [
    file("SKILL.md", "---\nname: code-review\n---\nReview the diff and verify affected callers."),
    file("scripts/check.sh", "#!/bin/sh\nset -eu\nnpm test\nnpm run lint\n"),
  ],
  previousFiles: [
    file("SKILL.md", "---\nname: code-review\n---\nReview the diff."),
    file("scripts/check.sh", "#!/bin/sh\nnpm test\n"),
  ],
  disposition: "update", assignmentCount: 2, executablePaths: [], deploymentImpact: "1".repeat(64),
};
const lintRules = {
  name: "lint-rules", path: "skills/lint-rules", commit, digest: "d3",
  source: { url: repository, ref: "main", subdirectory: "skills" },
  files: [file("SKILL.md", "---\nname: lint-rules\n---\nRun the linter before committing.")],
  previousFiles: [], disposition: "new", assignmentCount: 0, executablePaths: [],
};

/** The library, through the routed API (`?groups=1`): code-review at v3, imported from Git. */
async function library(page: Page, autoUpdate?: Record<string, unknown>) {
  const skill = { id: "skill-1", name: "code-review", description: "Reviews code", source: "git", gitSource,
    ...(autoUpdate ? { gitAutoUpdate: autoUpdate } : {}),
    latestVersion: { id: "v3", digest: "d1", createdAt: at, versionNumber: 3 }, assignmentCount: 2 };
  await page.route(/\/api\/skills$/, (route) => route.fulfill({ json: { skills: [skill] } }));
  await page.route(/\/api\/skill-groups$/, (route) => route.fulfill({ json: { groups: [] } }));
  await page.route(/\/api\/skills\/skill-1$/, (route) => route.fulfill({ json: { skill, assignments: [], latestVersion: {
    id: "v3", digest: "d1", createdAt: at, versionNumber: 3, gitSource,
    files: [file("SKILL.md", "---\nname: code-review\n---\n\nAlways review the diff.\n")],
  } } }));
  await page.route("**/api/skill-git/preview/*", (route) => route.fulfill({ status: 204 }));
}

/** Park the pointer and let the dialog's opening and the rows' fills finish, for a capture. */
async function settled(page: Page) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" ||
    animation.effect?.getComputedTiming().iterations === Infinity));
}

/** Buttons in the dialog's body as wide as the body: §3.1 says none are. */
async function stretched(dialog: Locator) {
  return dialog.locator(".modal-body").evaluate((body) => {
    const width = body.getBoundingClientRect().width;
    return [...body.querySelectorAll<HTMLElement>("button")]
      .filter((button) => !button.hidden && !button.closest(".choice-row") && button.getBoundingClientRect().width > width * 0.6)
      .map((button) => button.textContent);
  });
}

test("Check for Updates opens on the recorded source and says when the skill is up to date", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Checked 15 minutes ago, every hour: the next check is in 45 minutes.
  await library(page, { enabled: true, intervalMs: 60 * 60_000, checkedAt: Date.now() - 15 * 60_000, checkedCommit: "a".repeat(40), error: null, held: null });
  const requests: unknown[] = [];
  await page.route("**/api/skill-git/preview", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { previewId: "current", candidates: [{ ...codeReview, disposition: "identical", assignmentCount: 2 }] } });
  });
  await page.goto("/skills-removals-e2e.html?groups=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  const source = page.locator(".skill-detail > section.section").filter({ has: page.getByRole("heading", { name: "Source", exact: true }) });
  await source.getByRole("button", { name: "Check for Updates…" }).click();
  const dialog = page.getByRole("dialog", { name: "Check for Updates", exact: true });
  await expect(dialog.getByRole("heading", { name: "code-review Is Up to Date", exact: true })).toBeVisible();
  expect(requests).toEqual([{ url: repository, ref: "stable", subdirectory: "skills/code-review" }]);
  await expect(dialog.locator(".state-body")).toHaveText(
    "Commit 4f1c9b2e7a3d on stable has the same files as the library.Automatic updates check again in 45 minutes.");
  // One Done button, and nothing to change or import.
  await expect(dialog.locator(".modal-foot").getByRole("button")).toHaveText(["Done"]);
  await expect(dialog.getByRole("button", { name: "Change Source" })).toHaveCount(0);
  await settled(page);
  await page.screenshot({ path: info.outputPath("git-up-to-date-1440.png") });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("Check for Updates with a new commit checks the update and names it Import Update", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await library(page);
  await page.route("**/api/skill-git/preview", (route) => route.fulfill({ json: { previewId: "update", candidates: [codeReview] } }));
  await page.goto("/skills-removals-e2e.html?groups=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  await page.locator(".skill-detail").getByRole("button", { name: "Check for Updates…" }).click();
  const dialog = page.getByRole("dialog", { name: "Check for Updates", exact: true });
  await expect(dialog.getByRole("checkbox", { name: "code-review", exact: true })).toBeChecked();
  await expect(dialog.locator(".modal-foot .btn.primary")).toHaveText("Import Update");
  await expect(dialog.getByRole("heading", { name: "Changes in code-review" })).toBeVisible();
  await expect(dialog.locator(".skill-review-facts dd")).toHaveText([repository, "stable", "4f1c9b2e7a3d"]);
});

test("a refusal the server makes lands under its field, and step one stays", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/skill-git/preview", (route) => route.fulfill({ status: 400, json: { error: "Use a branch, tag, or commit for the Git ref." } }));
  await page.goto("/skills-removals-e2e.html");
  await choosePageAction(page, "Import from Git…", "Import");
  const dialog = page.getByRole("dialog", { name: "Import from Git", exact: true });
  await dialog.getByLabel("Repository", { exact: true }).fill("example/skills");
  await dialog.getByRole("button", { name: "Find Skills", exact: true }).click();
  const ref = dialog.getByLabel("Branch or Tag", { exact: true });
  await expect(ref).toHaveAttribute("aria-invalid", "true");
  await expect(ref).toBeFocused();
  await expect(dialog.locator(".field-error")).toHaveText("Use a branch or tag name, such as main or v1.2.");
  await expect(dialog.getByRole("button", { name: "Find Skills", exact: true })).toBeVisible();
});

for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of ["dark", "light"]) {
  test(`Import from Git finds skills, reviews them beside their files and imports the checked ones at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await library(page);
    const previews: unknown[] = [];
    const imports: unknown[] = [];
    await page.route("**/api/skill-git/preview", async (route) => {
      previews.push(route.request().postDataJSON());
      await route.fulfill({ json: { previewId: `preview-${previews.length}`, candidates: [codeReview, lintRules] } });
    });
    await page.route("**/api/skill-git/import", async (route) => {
      imports.push(route.request().postDataJSON());
      await route.fulfill({ json: { skill: { id: `skill-${imports.length + 1}`, name: "imported" } } });
    });
    await page.goto("/skills-removals-e2e.html?groups=1");
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await choosePageAction(page, "Import from Git…", "Import");
    const dialog = page.getByRole("dialog", { name: "Import from Git", exact: true });
    const foot = dialog.locator(".modal-foot");
    const shot = async (name: string) => {
      await settled(page);
      await page.screenshot({ path: info.outputPath(`git-import-${name}-${width}-${theme}.png`) });
    };

    // Step one: three fields, Find Skills in the footer, and no button stretched across the body.
    await expect(dialog.locator(".field-head label")).toHaveText(["Repository", "Branch or Tag", "Folder (Optional)"]);
    await expect(foot.getByRole("button")).toHaveText(["Cancel", "Find Skills"]);
    expect(await stretched(dialog)).toEqual([]);
    const sideBySide = await dialog.locator(".field-row").evaluate((row) => {
      const [first, second] = [...row.children].map((child) => child.getBoundingClientRect());
      return Math.abs(first!.top - second!.top) < 1;
    });
    // Under 480px of form the pair stacks (§8.1).
    expect(sideBySide).toBe(width > 760);
    if (width < 760) {
      const box = await dialog.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(height - 1);
    }
    await shot("source");

    // A password in the address: the error shows under Repository on leaving it, and Find Skills stays.
    const url = dialog.getByLabel("Repository", { exact: true });
    await url.fill("https://user:secret@github.com/example/skills.git");
    await dialog.getByLabel("Branch or Tag", { exact: true }).focus();
    await expect(url).toHaveAttribute("aria-invalid", "true");
    const urlError = dialog.locator(".field-error");
    await expect(urlError).toHaveText("Remove the password from the address, or use an SSH address such as git@host:org/repo.git.");
    await expect(url).toHaveAttribute("aria-describedby", (await urlError.getAttribute("id"))!);
    await shot("invalid");
    await foot.getByRole("button", { name: "Find Skills", exact: true }).click();
    await expect(url).toBeFocused();
    expect(previews).toEqual([]);
    await expect(foot.getByRole("button", { name: "Find Skills", exact: true })).toBeVisible();

    await url.fill(repository);
    await expect(url).not.toHaveAttribute("aria-invalid", "true");
    await dialog.getByLabel("Branch or Tag", { exact: true }).fill("main");
    await dialog.getByLabel("Folder (Optional)", { exact: true }).fill("skills");
    await foot.getByRole("button", { name: "Find Skills", exact: true }).click();

    // Step two: the strip, two rows, and the first row's files.
    await expect(dialog.locator(".skill-review-facts dt")).toHaveText(["Repository", "Branch or Tag", "Commit"]);
    await expect(dialog.locator(".skill-review-facts dd")).toHaveText([repository, "main", "4f1c9b2e7a3d"]);
    expect(previews).toEqual([{ url: repository, ref: "main", subdirectory: "skills" }]);
    const rows = dialog.locator(".choice-row");
    await expect(rows.locator(".choice-row-title")).toHaveText(["code-review", "lint-rules"]);
    await expect(rows.locator(".choice-row-desc")).toHaveText(["Updates v3 · 2 assignments", "New skill"]);
    await expect(rows.locator(".choice-row-meta")).toHaveText(["2 files · 1 script", "1 file"]);
    await expect(dialog.getByRole("heading", { name: "Changes in code-review" })).toBeVisible();
    await expect(foot.getByRole("checkbox")).toHaveCount(0);

    // Selecting a row shows its files and leaves its checkbox alone.
    const lint = dialog.getByRole("checkbox", { name: "lint-rules", exact: true });
    await rows.nth(1).locator(".choice-row-show").click();
    await expect(dialog.getByRole("heading", { name: "Files in lint-rules" })).toBeVisible();
    await expect(lint).not.toBeChecked();
    await expect(rows.nth(1).locator(".choice-row-show")).toHaveAttribute("aria-current", "true");
    await rows.nth(0).locator(".choice-row-show").click();
    await expect(dialog.getByRole("heading", { name: "Changes in code-review" })).toBeVisible();

    // Checking two rows: Import 2 Skills, and the consent names the update's assignments.
    await dialog.getByRole("checkbox", { name: "code-review", exact: true }).check();
    await lint.check();
    const primary = foot.getByRole("button", { name: "Import 2 Skills", exact: true });
    await expect(primary).toBeDisabled();
    const consent = foot.getByRole("checkbox", { name: "Deploy to 2 existing assignments", exact: true });
    await expect(consent).toBeVisible();
    // The phone footer keeps two buttons: Cancel and the primary.
    await expect(foot.getByRole("button")).toHaveText(["Cancel", "Import 2 Skills"]);
    const layout = await dialog.evaluate((element) => {
      const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      return { list: box(".skill-git-pane.list"), review: box(".skill-git-pane.review") };
    });
    if (width > 760) expect(layout.review.left).toBeGreaterThanOrEqual(layout.list.right - 1);
    else expect(layout.review.top).toBeGreaterThanOrEqual(layout.list.bottom - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    expect(await stretched(dialog)).toEqual([]);
    await shot("review");

    // Change Source keeps every value; finding again reads the same source.
    await dialog.getByRole("button", { name: "Change Source", exact: true }).click();
    await expect(url).toHaveValue(repository);
    await expect(dialog.getByLabel("Branch or Tag", { exact: true })).toHaveValue("main");
    await expect(dialog.getByLabel("Folder (Optional)", { exact: true })).toHaveValue("skills");
    await expect(url).toBeFocused();
    await foot.getByRole("button", { name: "Find Skills", exact: true }).click();
    await expect(rows).toHaveCount(2);
    expect(previews).toHaveLength(2);

    await dialog.getByRole("checkbox", { name: "code-review", exact: true }).check();
    await lint.check();
    await consent.check();
    await expect(primary).toBeEnabled();
    await primary.click();
    await expect(dialog).toHaveCount(0);
    expect(imports).toEqual([
      { previewId: "preview-2", path: "skills/code-review", acceptUpdate: true, expectedDeploymentImpact: "1".repeat(64) },
      { previewId: "preview-2", path: "skills/lint-rules", acceptUpdate: true },
    ]);
    await expect(page.locator(".toast")).toContainText("Imported 2 skills");
  });
}
