import { expect, test, type Page } from "@playwright/test";

const digest = "4f1c".padEnd(64, "0");
const keptId = "0f0e0d0c-0b0a-4908-8706-050403020100";
const unidentifiedId = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const fingerprint = "c".repeat(64);
const recovered = "---\nname: release-notes\n---\n\nSummarize merged pull requests.\nGroup them by area.\n";
const reported = { deployed: [], unmanaged: [], updatedAt: 1_700_000_000_000 };
const current = {
  removalReporting: "supported",
  driftReporting: "supported",
  keptAsideReporting: "supported",
  desired: [],
  reported,
  orphaned: [
    { kind: "kept_aside", id: keptId, name: "release-notes", digest, variant: "manual", keptAsideAt: 1_700_000_000_000,
      observedDigest: "9b2e".padEnd(64, "0"), observedFingerprint: "7e1d".padEnd(64, "0"),
      detail: "A restore kept this edited copy aside in the skill store instead of deleting it." },
    { kind: "kept_aside", id: unidentifiedId, observedFingerprint: fingerprint,
      detail: "An earlier runner kept this edited copy aside without recording the skill version it came from. It cannot be read as skill content: it contains a symlink." },
    { kind: "deleted_skill", name: "triage-helper", digest, variant: "agent", observedDigest: "5d3a".padEnd(64, "0"), held: true },
  ],
};
const older = {
  removalReporting: "supported",
  driftReporting: "supported",
  keptAsideReporting: "unsupported",
  desired: [],
  reported,
  orphaned: [{ kind: "deleted_skill", name: "legacy-lint", digest, variant: "manual", held: false }],
};

async function openOrphans(page: Page, width: number, theme: string) {
  let state: typeof current = current;
  const requests: Array<{ url: string; body: unknown }> = [];
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/runners/runner-1/skills", (route) => route.fulfill({ json: state }));
  await page.route("**/api/runners/runner-2/skills", (route) => route.fulfill({ json: older }));
  await page.route("**/api/runners/runner-1/orphaned-skill-copies/preview", async (route) => {
    requests.push({ url: "preview", body: route.request().postDataJSON() });
    await route.fulfill({ json: {
      previewId: "review-1",
      copy: { kind: "kept_aside", id: keptId, observedDigest: "9b2e".padEnd(64, "0") },
      name: "release-notes",
      files: [{ path: "SKILL.md", content: recovered, encoding: "utf8" }],
      previousFiles: [],
      digest: "9b2e".padEnd(64, "0"), importable: true, disposition: "new", assignmentCount: 0,
    } });
  });
  await page.route("**/api/orphaned-skill-copies/review-1/import", async (route) => {
    requests.push({ url: "import", body: route.request().postDataJSON() });
    state = { ...current, orphaned: current.orphaned.slice(1) };
    await route.fulfill({ json: { released: true, state: reported } });
  });
  await page.route("**/api/orphaned-skill-copies/review-1", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/runners/runner-1/orphaned-skill-copies/discard", async (route) => {
    requests.push({ url: "discard", body: route.request().postDataJSON() });
    state = { ...state, orphaned: state.orphaned.filter((copy) => copy.id !== unidentifiedId) };
    await route.fulfill({ json: { status: "discarded", state: reported } });
  });
  await page.goto("/skills-removals-e2e.html?orphans=1");
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  const entry = page.locator(".skills-item", { hasText: "Orphaned Copies" });
  await expect(entry).toContainText("4");
  return { requests, entry };
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const width of [1280, 320]) for (const theme of ["dark", "light"]) {
  test(`orphaned copies are listed per machine, imported after review, and discarded after confirmation at ${width} in ${theme}`, async ({ page }, info) => {
    const { requests, entry } = await openOrphans(page, width, theme);
    await entry.click();
    const panel = page.getByRole("region", { name: "Orphaned Copies" });
    const machine = panel.locator("article", { hasText: "Build Machine" });
    const olderMachine = panel.locator("article", { hasText: "Older Machine" });
    await expect(machine.locator(".skills-orphans li")).toHaveCount(3);
    await expect(machine.locator(".skills-orphans li").nth(0)).toContainText("release-notes");
    await expect(machine.locator(".skills-orphans li").nth(0)).toContainText("Kept Aside");
    await expect(machine.locator(".skills-orphans li").nth(0)).toContainText(`.drift-${keptId}`);
    await expect(machine.locator(".skills-orphans li").nth(1)).toContainText("Unidentified Copy");
    await expect(machine.locator(".skills-orphans li").nth(2)).toContainText("Deleted Skill");
    await expect(olderMachine).toContainText("This runner version cannot report copies a restore kept aside.");
    await expect(olderMachine).toContainText("legacy-lint");
    await page.screenshot({ path: info.outputPath(`orphans-list-${width}-${theme}.png`), fullPage: true });
    expect(await noHorizontalOverflow(page)).toBe(true);

    await machine.getByRole("button", { name: "Review and Import" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Review Orphaned Copy" });
    await expect(dialog).toContainText("creates it with no assignments");
    await expect(dialog).toContainText("injected disable-model-invocation line is left out");
    await dialog.getByText("SKILL.md · Added").click();
    await expect(dialog.getByText("Group them by area.")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`orphans-review-${width}-${theme}.png`) });
    expect(await noHorizontalOverflow(page)).toBe(true);
    await dialog.getByRole("button", { name: "Import as New Skill" }).click();
    await expect(dialog).toBeHidden();
    await expect(machine.locator(".skills-orphans li")).toHaveCount(2);

    await machine.getByRole("button", { name: "Discard Copy" }).first().click();
    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(confirmation).toContainText("Discard this unidentified kept-aside copy?");
    await expect(confirmation).toContainText("nothing is deleted");
    await page.screenshot({ path: info.outputPath(`orphans-discard-confirm-${width}-${theme}.png`) });
    expect(await noHorizontalOverflow(page)).toBe(true);
    await confirmation.getByRole("button", { name: "Discard Copy" }).click();
    await expect(machine.locator(".skills-orphans li")).toHaveCount(1);
    await expect(entry).toContainText("2");
    await page.screenshot({ path: info.outputPath(`orphans-after-${width}-${theme}.png`), fullPage: true });
    expect(requests).toEqual([
      { url: "preview", body: { kind: "kept_aside", id: keptId } },
      { url: "import", body: { acceptUpdate: false } },
      { url: "discard", body: { kind: "kept_aside", id: unidentifiedId, observedFingerprint: fingerprint, confirmation: "explicit" } },
    ]);
  });
}

test("an unreadable edited copy of a deleted skill explains that discarding moves it aside first", async ({ page }) => {
  const { entry } = await openOrphans(page, 1280, "dark");
  await entry.click();
  const olderMachine = page.getByRole("region", { name: "Orphaned Copies" }).locator("article", { hasText: "Older Machine" });
  await expect(olderMachine).toContainText("discarding it moves it aside first");
  await expect(olderMachine.getByRole("button", { name: "Review and Import" })).toBeDisabled();
  await olderMachine.getByRole("button", { name: "Discard Copy" }).click();
  const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(confirmation).toContainText("Discard the edited copy of “legacy-lint”?");
  await expect(confirmation).toContainText("appears here as a kept-aside copy");
});
