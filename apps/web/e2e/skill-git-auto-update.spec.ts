import { expect, test, type Page } from "@playwright/test";

const at = Date.UTC(2026, 8, 24, 15, 30);
const gitSource = { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "skills", path: "skills/code-review", commit: "a".repeat(40) };
type AutoUpdate = {
  enabled: boolean; intervalMs: number; checkedAt: number | null; checkedCommit: string | null;
  error: { message: string; at: number } | null;
  held: { commit: string; reason: "scripts" | "local_changes" | "untracked_modes"; scriptPaths: string[]; heldAt: number } | null;
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
const source = (page: Page) => page.locator(".skill-detail > section.section").filter({ has: page.getByRole("heading", { name: "Source", exact: true }) });

/** `deployError` has the machine report a failed link: a deployment error, which outranks a held
 * update in the notice slot. `drift` makes the harness read the machine through the routed API. */
async function open(page: Page, deployError = false) {
  if (deployError) {
    await page.route("**/api/runners/runner-1/skills", (route) => route.fulfill({ json: {
      removalReporting: "supported",
      desired: [{ name: "code-review", versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" }] }],
      reported: { deployed: [{ name: "code-review", digest: "d1", links: [{ agentId: "claude", status: "error", detail: "Permission denied" }] }], updatedAt: at },
    } }));
  }
  await page.goto(`/skills-removals-e2e.html?groups=1${deployError ? "&drift=1" : ""}`);
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
}

/** Buttons in Source that stretch to the Surface's width; §3.1 says none do. */
async function stretched(page: Page) {
  return source(page).evaluate((section) => {
    const surface = section.querySelector(".surface")!.getBoundingClientRect().width;
    return [...section.querySelectorAll<HTMLElement>("button:not([role='switch'])")]
      .filter((button) => button.getBoundingClientRect().width > surface * 0.6).map((button) => button.textContent);
  });
}

test("Automatic Updates is a switch: one click turns it on, Saved shows for about 2s, and the description follows", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await install(page, off);
  await open(page);
  const toggle = page.getByRole("switch", { name: "Automatic Updates", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(source(page).getByRole("checkbox")).toHaveCount(0);
  await expect(toggle.locator(".ui-row-desc")).toHaveText("Off. Use Check for Updates to review new commits.");
  await page.screenshot({ path: info.outputPath("git-auto-update-off-1280.png"), fullPage: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(state.puts).toEqual([{ enabled: true }]);
  await expect(toggle.locator(".ui-row-desc")).toHaveText("Checks main every hour. Waiting for the first check.");
  const saved = toggle.locator(".ui-row-saved");
  await expect(saved).toHaveText("Saved");
  const shownAt = Date.now();
  await expect(source(page).getByRole("status").filter({ hasText: "Automatic Updates saved" })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("git-auto-update-enabled-1280.png"), fullPage: true });
  await expect(saved).toHaveCount(0, { timeout: 4000 });
  const shownFor = Date.now() - shownAt;
  expect(shownFor).toBeGreaterThan(1200);
  expect(shownFor).toBeLessThan(3500);
  expect(await stretched(page)).toEqual([]);
});

test("the switch takes Space and Enter from the keyboard", async ({ page }) => {
  const state = await install(page, off);
  await open(page);
  const toggle = page.getByRole("switch", { name: "Automatic Updates", exact: true });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toBeEnabled();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(state.puts).toEqual([{ enabled: true }, { enabled: false }]);
});

test("with a coarse pointer the switch is a 40×24 track with a 44px hit area", async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await install(page, { ...off, enabled: true, checkedAt: at, checkedCommit: "c".repeat(40) });
    await open(page);
    const toggle = page.getByRole("switch", { name: "Automatic Updates", exact: true });
    await toggle.scrollIntoViewIfNeeded();
    const track = toggle.locator(".ui-switch");
    const size = await track.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = getComputedStyle(element, "::before");
      return { width: box.width, height: box.height, hitTop: hit.top, hitBottom: hit.bottom, row: element.parentElement!.getBoundingClientRect().height };
    });
    expect(size.width).toBe(40);
    expect(size.height).toBe(24);
    // The hit area is the track's padding box (22px) plus 11px each way: 44px.
    expect([size.hitTop, size.hitBottom]).toEqual(["-11px", "-11px"]);
    expect(size.row).toBeGreaterThanOrEqual(44);
    await toggle.screenshot({ path: info.outputPath("git-auto-update-switch-coarse.png") });
  } finally {
    await context.close();
  }
});

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`a held update the slot shows is reviewed through the existing preview at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await install(page, { ...off, enabled: true, checkedAt: at, checkedCommit: "c".repeat(40),
      held: { commit: "c".repeat(40), reason: "scripts", scriptPaths: ["scripts/collect.sh", "tool.py"], heldAt: at } });
    await page.route("**/api/skill-git/preview", async (route) => {
      // The held commit, not the branch's head (#2280).
      expect(route.request().postDataJSON()).toEqual({ url: gitSource.url, ref: "main", subdirectory: "skills/code-review", commit: "c".repeat(40) });
      await route.fulfill({ json: { previewId: "held", candidates: [] } });
    });
    await open(page);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const held = page.getByRole("region", { name: "Update Held for Review" });
    // One notice: the slot's. Source doesn't repeat it, and its row still says one waits.
    await expect(held).toHaveCount(1);
    await expect(page.locator(".skill-notice-slot")).toHaveAttribute("data-notice", "git-held");
    await expect(held).toContainText(`Commit ${"c".repeat(12)} adds or changes scripts/collect.sh and tool.py. Review it before it deploys.`);
    await expect(source(page).getByRole("switch").locator(".ui-row-desc")).toContainText("An update is held for review.");
    await source(page).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    expect(await stretched(page)).toEqual([]);
    await page.screenshot({ path: info.outputPath(`git-auto-update-held-${width}-${theme}.png`), fullPage: true });
    await held.getByRole("button", { name: "Review Update…" }).click();
    // It opens on the review of the held commit of the recorded source (#1983, #2280), which the route above checks.
    await expect(page.getByRole("dialog", { name: "Review Held Update", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No Skills Found", exact: true })).toBeVisible();
  });
}

test("a held update behind a more urgent notice is a notice inside Source with Review Update…", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await install(page, { ...off, enabled: true, checkedAt: at, checkedCommit: "c".repeat(40),
    held: { commit: "c".repeat(40), reason: "scripts", scriptPaths: ["scripts/collect.sh"], heldAt: at } });
  await open(page, true);
  await expect(page.locator(".skill-notice-slot")).toHaveAttribute("data-notice", "deployment-error");
  const held = source(page).getByRole("region", { name: "Update Held for Review" });
  await expect(held).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Update Held for Review" })).toHaveCount(1);
  // Flush with the Surface: edge to edge, square below, sharing the Surface's top corners.
  const geometry = await held.evaluate((notice) => {
    const surface = notice.parentElement!.getBoundingClientRect();
    const box = notice.getBoundingClientRect();
    const style = getComputedStyle(notice);
    return { left: box.left - surface.left, right: surface.right - box.right, bottomLeft: style.borderBottomLeftRadius, side: style.borderLeftWidth };
  });
  expect(geometry).toEqual({ left: 1, right: 1, bottomLeft: "0px", side: "0px" });
  expect(await stretched(page)).toEqual([]);
  await source(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("git-auto-update-held-in-source-1280.png"), fullPage: true });
  await held.getByRole("button", { name: "Review Update…" }).click();
  await expect(page.getByRole("dialog", { name: "Review Held Update", exact: true })).toBeVisible();
});

test("a failed check is a danger notice in Source with Check for Updates… and Show Details", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await install(page, { ...off, enabled: true, checkedAt: at, checkedCommit: "a".repeat(40),
    error: { message: "Could not read the Git source within its limits. Check the URL, ref, access, and repository size.", at } });
  await open(page);
  const failed = source(page).getByRole("region", { name: "Couldn't Check for Updates" });
  await expect(failed).toContainText("Existing versions and deployments are unchanged.");
  await expect(failed).not.toContainText("Could not read the Git source");
  await failed.getByRole("button", { name: "Show Details" }).click();
  await expect(failed).toContainText("Could not read the Git source within its limits.");
  expect(await stretched(page)).toEqual([]);
  await source(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("git-auto-update-error-390.png"), fullPage: true });
  await failed.getByRole("button", { name: "Check for Updates…" }).click();
  await expect(page.getByRole("dialog", { name: "Check for Updates", exact: true })).toBeVisible();
});

test("an update over an import without recorded modes explains its one-time review", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await install(page, { ...off, enabled: true, checkedAt: at, checkedCommit: "e".repeat(40),
    held: { commit: "e".repeat(40), reason: "untracked_modes", scriptPaths: ["SKILL.md", "tool"], heldAt: at } });
  await open(page);
  await expect(page.getByRole("region", { name: "Update Held for Review" }))
    .toContainText(`Commit ${"e".repeat(12)} changes SKILL.md and tool, which the last import didn't check for scripts.`);
  await expect(page.getByRole("button", { name: "Review Update…" })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("git-auto-update-untracked-390.png"), fullPage: true });
});

// #2280: Review Update… reads the commit the notice names, even after the branch moved on.
const heldCommit = "a1b2c3d4e5f6".padEnd(40, "1");
const newerCommit = "0f9e8d7c6b5a".padEnd(40, "2");
const reviewFile = (path: string, content: string) => ({ path, encoding: "utf8", content });
const heldCandidate = (commit: string, script: string) => ({
  name: "code-review", path: "skills/code-review", commit, digest: `d-${commit.slice(0, 4)}`,
  source: { url: gitSource.url, ref: "main", subdirectory: "skills/code-review" },
  files: [reviewFile("SKILL.md", "---\nname: code-review\n---\n\nAlways review the diff.\n"), reviewFile("scripts/collect.sh", script)],
  previousFiles: [reviewFile("SKILL.md", "---\nname: code-review\n---\n\nAlways review the diff.\n")],
  disposition: "update", assignmentCount: 0, executablePaths: [],
});

async function movedBranch(page: Page) {
  await install(page, { ...off, enabled: true, checkedAt: at, checkedCommit: heldCommit,
    held: { commit: heldCommit, reason: "scripts", scriptPaths: ["scripts/collect.sh"], heldAt: at } });
  const previews: unknown[] = [];
  const imports: unknown[] = [];
  await page.route("**/api/skill-git/preview", async (route) => {
    const body = route.request().postDataJSON() as { commit?: string };
    previews.push(body);
    await route.fulfill({ json: body.commit
      ? { previewId: "held", candidates: [heldCandidate(heldCommit, "#!/bin/sh\ngit log -1\n")], refCommit: newerCommit }
      : { previewId: "newer", candidates: [heldCandidate(newerCommit, "#!/bin/sh\ngit log -1\ncurl -fsS https://example.com/collect\n")] } });
  });
  await page.route("**/api/skill-git/preview/*", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/skill-git/import", async (route) => {
    imports.push(route.request().postDataJSON());
    await route.fulfill({ json: { skill: { id: "skill-1", name: "code-review" } } });
  });
  await open(page);
  await page.getByRole("region", { name: "Update Held for Review" }).getByRole("button", { name: "Review Update…" }).click();
  return { previews, imports };
}

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`a held update whose branch moved on reviews the held commit and names the newer one at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { previews, imports } = await movedBranch(page);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const dialog = page.getByRole("dialog", { name: "Review Held Update", exact: true });
    await expect(dialog).toBeVisible();
    expect(previews).toEqual([{ url: gitSource.url, ref: "main", subdirectory: "skills/code-review", commit: heldCommit }]);
    const moved = dialog.getByRole("region", { name: "Newer Commit on main" });
    await expect(moved).toContainText("main is now at commit 0f9e8d7c6b5a. This review imports commit a1b2c3d4e5f6 only; review the newer commit on its own before importing it.");
    await expect(dialog.locator(".skill-git-strip .skill-review-facts dd")).toHaveText([gitSource.url, "main", "a1b2c3d4e5f6"]);
    await expect(dialog.getByRole("checkbox", { name: "code-review", exact: true })).toBeChecked();
    await expect(dialog.locator(".skill-git-pane.review")).toContainText("git log -1");
    await expect(dialog.locator(".skill-git-pane.review")).not.toContainText("curl");
    expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" ||
      animation.effect?.getComputedTiming().iterations === Infinity));
    await page.screenshot({ path: info.outputPath(`git-held-review-moved-${width}-${theme}.png`) });
    if (width === 390 || theme === "light") return;

    await dialog.getByRole("button", { name: "Import Update", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(imports).toEqual([{ previewId: "held", path: "skills/code-review", acceptUpdate: true }]);
  });
}

test("Review Newer Commit is a separate review of the branch's head", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { previews, imports } = await movedBranch(page);
  const held = page.getByRole("dialog", { name: "Review Held Update", exact: true });
  await held.getByRole("button", { name: "Review Newer Commit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Check for Updates", exact: true });
  await expect(dialog.locator(".skill-git-strip .skill-review-facts dd")).toHaveText([gitSource.url, "main", "0f9e8d7c6b5a"]);
  expect(previews).toEqual([
    { url: gitSource.url, ref: "main", subdirectory: "skills/code-review", commit: heldCommit },
    { url: gitSource.url, ref: "main", subdirectory: "skills/code-review" },
  ]);
  await expect(dialog.getByRole("region", { name: "Newer Commit on main" })).toHaveCount(0);
  await expect(dialog.locator(".skill-git-pane.review")).toContainText("curl -fsS https://example.com/collect");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role='dialog']")))).toBe(true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath("git-held-review-newer-1280-dark.png") });
  await dialog.getByRole("button", { name: "Import Update", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(imports).toEqual([{ previewId: "newer", path: "skills/code-review", acceptUpdate: true }]);
});
