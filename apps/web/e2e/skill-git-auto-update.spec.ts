import { expect, test, type Page } from "@playwright/test";

const at = Date.UTC(2026, 8, 24, 15, 30);
const gitSource = { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "skills", path: "skills/code-review", commit: "a".repeat(40) };
type AutoUpdate = {
  enabled: boolean; intervalMs: number; checkedAt: number | null; checkedCommit: string | null;
  error: { message: string; at: number } | null;
  held: { commit: string; reason: "scripts" | "local_changes"; scriptPaths: string[]; heldAt: number } | null;
};

async function install(page: Page, initial: AutoUpdate) {
  const state = { autoUpdate: initial, puts: [] as unknown[] };
  const skill = () => ({ id: "skill-1", name: "code-review", description: "Reviews code", source: "git", gitSource,
    gitAutoUpdate: state.autoUpdate, latestVersion: { id: "v1", digest: "d1", createdAt: at }, assignmentCount: 1 });
  await page.route(/\/api\/skills$/, (route) => route.fulfill({ json: { skills: [skill()] } }));
  await page.route(/\/api\/skill-groups$/, (route) => route.fulfill({ json: { groups: [] } }));
  await page.route(/\/api\/skills\/skill-1$/, (route) => route.fulfill({ json: { skill: skill(), assignments: [], latestVersion: {
    id: "v1", digest: "d1", createdAt: at, gitSource,
    files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: code-review\n---\n\nAlways review the diff.\n" }],
  } } }));
  await page.route(/\/api\/skills\/skill-1\/git-auto-update$/, async (route) => {
    const body = route.request().postDataJSON() as { enabled: boolean };
    state.puts.push(body);
    state.autoUpdate = { ...state.autoUpdate, enabled: body.enabled, checkedAt: null, checkedCommit: null, error: null, held: null };
    await route.fulfill({ json: { skill: skill() } });
  });
  return state;
}

const off: AutoUpdate = { enabled: false, intervalMs: 60 * 60_000, checkedAt: null, checkedCommit: null, error: null, held: null };

test("Automatic Updates is off by default and opting in waits for the first check", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await install(page, off);
  await page.goto("/skills-removals-e2e.html?groups=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  const toggle = page.getByRole("checkbox", { name: "Automatic Updates", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("Off. Use Check for Updates to review new commits.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("git-auto-update-off-1280.png"), fullPage: true });
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(state.puts).toEqual([{ enabled: true }]);
  await expect(page.getByText("Checks main every hour and imports new commits as library versions.", { exact: false })).toBeVisible();
  await expect(page.getByText("Waiting for the first check.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check for Updates" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("git-auto-update-enabled-1280.png"), fullPage: true });
});

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`a held script update is reviewed through the existing preview at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await install(page, { ...off, enabled: true, checkedAt: at, checkedCommit: "c".repeat(40),
      held: { commit: "c".repeat(40), reason: "scripts", scriptPaths: ["scripts/collect.sh", "tool.py"], heldAt: at } });
    await page.route("**/api/skill-git/preview", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ url: gitSource.url, ref: "main", subdirectory: "skills/code-review" });
      await route.fulfill({ json: { previewId: "held", candidates: [] } });
    });
    await page.goto("/skills-removals-e2e.html?groups=1");
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole("button", { name: /code-review/i }).click();
    await expect(page.getByRole("status").filter({ hasText: "held for review" }))
      .toHaveText(`Update to commit ${"c".repeat(12)} is held for review because it adds or changes scripts: scripts/collect.sh, tool.py. Review it before it can deploy.`);
    await expect(page.getByText(`Last checked`, { exact: false })).toBeVisible();
    const review = page.getByRole("button", { name: "Review Held Update" });
    await review.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`git-auto-update-held-${width}-${theme}.png`), fullPage: true });
    await review.click();
    await expect(page.getByRole("heading", { name: "Check for Skill Updates" })).toBeVisible();
    await expect(page.getByLabel("Repository Subdirectory")).toHaveValue("skills/code-review");
    await page.getByRole("button", { name: "Preview Skills" }).click();
    await expect(page.getByText("No remaining skill candidates in this preview.")).toBeVisible();
  });
}

test("a failed check is reported on the skill", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await install(page, { ...off, enabled: true, checkedAt: at, checkedCommit: "a".repeat(40),
    error: { message: "Could not read the Git source within its limits. Check the URL, ref, access, and repository size.", at } });
  await page.goto("/skills-removals-e2e.html?groups=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  await expect(page.getByText("Could not read the Git source within its limits.", { exact: false })).toBeVisible();
  await expect(page.getByText("Existing versions and deployments are unchanged.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check for Updates" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("git-auto-update-error-390.png"), fullPage: true });
});
