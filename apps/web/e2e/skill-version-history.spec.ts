import { expect, test, type Page } from "@playwright/test";

// Version History (#1984): numbered versions with their notes in a list beside the selected one's
// facts and diff; Restore names the version; older versions load as the list scrolls.

const hour = 3_600_000;
const day = 24 * hour;
const file = (content: string) => ({ path: "SKILL.md", encoding: "utf8", content });
const v3 = { id: "skillv_c3c3c3c3c3c3c3c3c3c3", versionNumber: 3, digest: "c".repeat(64), createdAt: Date.now() - 2 * hour,
  note: "Add migration and test-coverage checks" };
const v2 = { id: "skillv_b2b2b2b2b2b2b2b2b2b2", versionNumber: 2, digest: "b".repeat(64), createdAt: Date.now() - 3 * day,
  note: "Tighten the review checklist" };
const v1 = { id: "skillv_a1a1a1a1a1a1a1a1a1a1", versionNumber: 1, digest: "a".repeat(64), createdAt: Date.now() - 20 * day, note: null };
const files = {
  [v3.id]: [file("Review the diff and all callers.\nCheck migrations and test coverage."), { path: "scripts/check.sh", encoding: "utf8", content: "echo check" }],
  [v2.id]: [file("Review the diff and all callers.")],
  [v1.id]: [file("Review the diff.")],
};

/** A capture once the sheet and every row have finished moving. */
async function capture(page: Page, path: string) {
  await page.mouse.move(0, 0);
  // Endless ones (a pulsing status dot) never finish, so only the finite ones are waited for.
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
  await page.screenshot({ path });
}

async function openHistory(page: Page) {
  await page.goto("/skills-removals-e2e.html");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  await page.locator(".skill-detail-head, .detail-bar").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Version History…", exact: true }).click();
  return page.getByRole("dialog", { name: "Version History" });
}

/** Routes the version list (`listed()` each time) and every version's preview against the newest. */
async function routeVersions(page: Page, listed: () => Array<typeof v1 | typeof v2 | typeof v3>) {
  await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: { versions: listed(), nextCursor: null } }));
  await page.route("**/api/skills/skill-1/versions/skillv_*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const current = listed()[0]!;
    const version = listed().find((entry) => entry.id === id)!;
    return route.fulfill({ json: {
      version: { ...version, files: files[version.id as keyof typeof files] ?? files[v2.id], gitSource: { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "skills", path: "skills/code-review", commit: "9f8e7d6c5b4a".padEnd(40, "0") } },
      currentVersion: { ...current, files: files[current.id as keyof typeof files] ?? files[v2.id] },
    } });
  });
}

for (const theme of ["dark", "light"]) {
  test(`numbered versions, notes and Restore v2 at 1440 in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const v4 = { id: "skillv_d4d4d4d4d4d4d4d4d4d4", versionNumber: 4, digest: v2.digest, createdAt: Date.now(), note: `Restored from ${v2.id}` };
    let listed = [v3, v2, v1];
    const restores: unknown[] = [];
    await routeVersions(page, () => listed);
    await page.route("**/api/skills/skill-1/restore", async (route) => {
      restores.push(route.request().postDataJSON());
      listed = [v4, v3, v2, v1];
      await route.fulfill({ json: { version: v4 } });
    });
    const dialog = await openHistory(page);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const rows = dialog.getByRole("group", { name: "Versions" }).getByRole("button");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("v3Current");
    await expect(rows.nth(0)).toContainText("Add migration and test-coverage checks");
    await expect(rows.nth(0).locator(".row-trail")).toHaveText("2h ago");
    await expect(rows.nth(1)).toContainText("Tighten the review checklist");
    await expect(rows.nth(2)).toContainText("No note");
    await expect(rows.nth(2).locator(".row-trail")).toHaveText("20d ago");

    // The detail opens on the version before the current one.
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(dialog.getByRole("heading", { name: "Changes If You Restore v2" })).toBeVisible();
    await expect(dialog.locator(".skill-review-facts")).toContainText("Git commit 9f8e7d6");
    await expect(dialog.locator(".skill-version-hash .mono")).toHaveText("b".repeat(12));
    await expect(dialog.getByRole("button", { name: "Copy Fingerprint" })).toBeVisible();
    const script = dialog.locator(".skill-diff-file", { hasText: "scripts/check.sh" });
    await expect(script.locator(".skill-diff-file-head .status")).toHaveText(["Script", "Removed"]);
    const foot = dialog.locator(".modal-foot");
    const restore = foot.getByRole("button", { name: "Restore v2", exact: true });
    await expect(restore).toBeDisabled();
    await expect(foot.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    const text = await dialog.innerText();
    expect(text).not.toMatch(/skillv_/);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    await capture(page, info.outputPath(`history-older-1440-${theme}.png`));

    // One scroll box per pane: the body itself never scrolls.
    const body = await dialog.locator(".modal-body").evaluate((element) => ({
      overflow: getComputedStyle(element).overflowY, scrolls: element.scrollHeight > element.clientHeight,
    }));
    expect(body).toEqual({ overflow: "hidden", scrolls: false });

    await foot.getByRole("checkbox", { name: "Deploy to machines that track the latest version", exact: true }).check();
    await restore.click();
    await expect(dialog.getByRole("status").filter({ hasText: "Restored v2." })).toBeVisible();
    expect(restores).toEqual([{ versionId: v2.id, expectedLatestVersionId: v3.id }]);
    // The restore is the new current version, named by number in its note.
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("v4Current");
    await expect(rows.nth(0)).toContainText("Restored from v2");
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(foot.getByRole("button", { name: "Restore v4", exact: true })).toBeDisabled();
    await expect(foot).toContainText("This is the current version.");

    await rows.nth(1).click();
    await expect(dialog.getByRole("heading", { name: "Changes If You Restore v3" })).toBeVisible();
    await expect(foot).not.toContainText("This is the current version.");
    await rows.nth(0).click();
    await expect(dialog.getByRole("heading", { name: "Files in v4" })).toBeVisible();
    await expect(foot.getByRole("checkbox")).toHaveCount(0);
    await expect(foot.getByRole("button", { name: "Restore v4", exact: true })).toBeDisabled();
    await expect(foot.locator(".skill-version-reason")).toHaveText("This is the current version.");
    await capture(page, info.outputPath(`history-current-1440-${theme}.png`));
  });

  test(`a phone sheet shows the list, then the version with Back, at 390 in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routeVersions(page, () => [v3, v2, v1]);
    const dialog = await openHistory(page);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const rows = dialog.getByRole("group", { name: "Versions" }).getByRole("button");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).not.toHaveAttribute("aria-current", "true");
    await expect(dialog.locator(".skill-review-changes")).toHaveCount(0);
    await capture(page, info.outputPath(`history-list-390-${theme}.png`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await rows.nth(1).click();
    await expect(dialog.getByRole("heading", { name: "Changes If You Restore v2" })).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Versions" })).toHaveCount(0);
    await expect(dialog.locator(".modal-foot").getByRole("button", { name: "Restore v2", exact: true })).toBeDisabled();
    await capture(page, info.outputPath(`history-older-390-${theme}.png`));
    await dialog.getByRole("button", { name: "Back to Versions" }).click();
    await expect(rows).toHaveCount(3);
    await rows.nth(0).click();
    await expect(dialog.getByRole("heading", { name: "Files in v3" })).toBeVisible();
    await expect(dialog.locator(".modal-foot")).toContainText("This is the current version.");
    await capture(page, info.outputPath(`history-current-390-${theme}.png`));
  });
}

for (const width of [1440, 390]) {
  test(`the selected version's whole note shows in its detail at ${width} (#2286)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const long = "Tighten the review checklist so every caller of a changed function is read, not only the diff, " +
      "and say which callers were checked in the review summary.\nKeep the migration and test-coverage checks from v1.";
    await routeVersions(page, () => [v3, { ...v2, note: long }, v1]);
    const dialog = await openHistory(page);
    const rows = dialog.getByRole("group", { name: "Versions" }).getByRole("button");
    if (width === 390) await rows.nth(1).click();
    await expect(dialog.getByRole("heading", { name: "Changes If You Restore v2" })).toBeVisible();
    const note = dialog.locator(".skill-version-full-note dd");
    await expect(note).toBeVisible();
    // The whole note, wrapped on its author's line break, and nothing cut off.
    expect(await note.evaluate((element) => element.textContent)).toBe(long);
    expect(await note.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect(await note.evaluate((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().height > 40)).toBe(true);
    await expect(dialog.locator(".skill-version-full-note dt")).toHaveText("Note");
    if (width === 1440) {
      // The row keeps its one line.
      const sub = rows.nth(1).locator(".row-sub");
      expect(await sub.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    }
    await expect(dialog).not.toContainText("skillv_");
  });
}

test("older versions load as the list scrolls to its end", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const make = (n: number) => ({ id: `skillv_n${n}`, versionNumber: n, digest: n.toString(16).padStart(64, "0"), createdAt: Date.now() - (61 - n) * day, note: `Revision ${n}` });
  const newer = Array.from({ length: 50 }, (_, index) => make(60 - index));
  const older = Array.from({ length: 10 }, (_, index) => make(10 - index));
  const requested: string[] = [];
  await page.route("**/api/skills/skill-1/versions*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/versions")) {
      const before = url.searchParams.get("before");
      requested.push(before ?? "first");
      return route.fulfill({ json: before ? { versions: older, nextCursor: null } : { versions: newer, nextCursor: newer.at(-1)!.id } });
    }
    const id = url.pathname.split("/").pop()!;
    return route.fulfill({ json: { version: { ...make(Number(id.slice(8))), files: [file(id)] }, currentVersion: { ...newer[0], files: [file("current")] } } });
  });
  const dialog = await openHistory(page);
  const rows = dialog.getByRole("group", { name: "Versions" }).getByRole("button");
  await expect(rows).toHaveCount(50);
  await expect(dialog.getByRole("button", { name: "Load Older Versions" })).toHaveCount(0);
  expect(requested).toEqual(["first"]);
  const pane = dialog.locator(".skill-version-pane.list");
  expect(await pane.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await pane.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(rows).toHaveCount(60);
  expect(requested).toEqual(["first", newer.at(-1)!.id]);
  await expect(rows.last()).toContainText("v1");
  await expect(dialog.locator(".skill-version-list-end")).toHaveCount(0);
});

test("the selected version's diff beside the list offers only Unified at 1440×900 (#2292)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await routeVersions(page, () => [v3, v2, v1]);
  const dialog = await openHistory(page);
  await expect(dialog.getByRole("heading", { name: "Changes If You Restore v2" })).toBeVisible();
  const pane = dialog.locator(".skill-version-pane.detail");
  await expect(pane.locator(".skill-diff-file", { hasText: "SKILL.md" }).locator(".diff-line-del").first()).toBeVisible();
  // The card is wide enough for Split, but the pane the diff is read in is not.
  const widths = await pane.evaluate((element) => ({ card: element.closest<HTMLElement>(".modal")!.offsetWidth, pane: element.offsetWidth }));
  expect(widths.card).toBeGreaterThanOrEqual(800);
  expect(widths.pane).toBeLessThan(800);
  await expect(dialog.getByRole("radiogroup", { name: "Diff Layout" })).toHaveCount(0);
  await expect(dialog.locator(".diff-split-row")).toHaveCount(0);
});
