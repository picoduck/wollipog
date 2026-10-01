import { expect, test, type Page } from "@playwright/test";

// Machine Version (#1984): one name everywhere, the choices as radio rows with the machine's own
// marked Current, and a choice's changes read on their own: no Preview step, and saving the choice
// already in force is disabled with the reason.

const day = 24 * 3_600_000;
const file = (content: string) => ({ path: "SKILL.md", encoding: "utf8", content });
const v1 = { id: "skillv_a1a1a1a1a1a1a1a1a1a1", versionNumber: 1, digest: "a".repeat(64), createdAt: Date.now() - 20 * day,
  note: "Initial reviewed version", files: [file("Original instructions"), { path: "reference.md", encoding: "utf8", content: "Unchanged reference" }] };
const v2 = { id: "skillv_b2b2b2b2b2b2b2b2b2b2", versionNumber: 2, digest: "b".repeat(64), createdAt: Date.now() - 2 * day,
  note: "Tighten the review checklist", files: [file("Updated instructions"), { path: "reference.md", encoding: "utf8", content: "Unchanged reference" }] };
const summary = ({ files: _files, ...version }: typeof v1) => version;

/** A fake server for the version list, the machine's version and its previews and saves. */
async function machineServer(page: Page, options: { refuseFirstSave?: boolean } = {}) {
  let policy: { versionId: string | null; revision: string } | null = null;
  const previews: Array<string | null> = [];
  const saves: unknown[] = [];
  await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: { versions: [summary(v2), summary(v1)], nextCursor: null } }));
  await page.route("**/api/skills/skill-1/machines/runner-1/version-policy", (route) => route.fulfill({ json: { policy } }));
  await page.route(/\/api\/skills\/skill-1\/machines\/runner-1\/version(\?.*)?$/, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      saves.push(body);
      if (options.refuseFirstSave && saves.length === 1) {
        await route.fulfill({ status: 409, json: { error: "The library or machine version policy changed. Preview again." } });
        return;
      }
      policy = { versionId: body.versionId, revision: `rev${saves.length}` };
      await route.fulfill({ json: { policy } });
      return;
    }
    const versionId = new URL(route.request().url()).searchParams.get("versionId");
    previews.push(versionId);
    const running = policy?.versionId === v1.id ? v1 : v2;
    await route.fulfill({ json: { policy, currentVersion: running, proposedVersion: versionId === v1.id ? v1 : v2, expectedLatestVersionId: v2.id } });
  });
  return { previews, saves };
}

async function openMachineVersion(page: Page, query = "") {
  await page.goto(`/skills-removals-e2e.html${query}`);
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  await page.locator(".skill-detail-head, .detail-bar").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Machine Version…", exact: true }).click();
  return page.getByRole("dialog", { name: "Machine Version" });
}

/** A capture once the sheet has finished moving; endless animations (a pulsing dot) are ignored. */
async function capture(page: Page, path: string) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
  await page.screenshot({ path });
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const theme of ["dark", "light"]) {
  test(`pin and track latest without a Preview step at ${width} in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const server = await machineServer(page);
    const dialog = await openMachineVersion(page);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const choices = dialog.getByRole("radiogroup", { name: "Version" });
    const foot = dialog.locator(".modal-foot");
    const save = foot.getByRole("button", { name: "Save Version", exact: true });
    await expect(choices.getByRole("radio")).toHaveCount(3);
    await expect(choices.locator(".choice-row-title")).toHaveText(["Track LatestCurrent", "Pin to v2", "Pin to v1"]);
    await expect(choices.locator(".choice-row-desc")).toHaveText([
      "Always runs the newest library version.", "Tighten the review checklist · 2d ago", "Initial reviewed version · 20d ago"]);
    await expect(choices.getByRole("radio", { name: /^Track Latest/ })).toBeChecked();

    // The choice already in force: nothing to read or save, and the footer says why.
    await expect(save).toBeDisabled();
    await expect(foot.locator(".skill-version-reason")).toHaveText("Choose a different version to save.");
    await expect(dialog.locator(".skill-review-changes")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /Preview/ })).toHaveCount(0);
    const text = await dialog.innerText();
    for (const gone of ["Version Policy", "Machine Versions", "skillv_"]) expect(text).not.toContain(gone);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    await capture(page, info.outputPath(`machine-unchanged-${width}-${theme}.png`));
    expect(server.previews).toEqual([]);

    // Choosing a pin reads its changes on its own, each file collapsed under its counts.
    await choices.getByText("Pin to v1", { exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Changes If You Pin to v1" })).toBeVisible();
    const files = dialog.locator(".skill-diff-file");
    await expect(files).toHaveCount(2);
    expect(server.previews).toEqual([v1.id]);
    for (const each of await files.all()) await expect(each).not.toHaveAttribute("open");
    await expect(files.first().locator(".skill-diff-counts")).toContainText("+1 −1");
    await expect(foot.locator(".skill-version-reason")).toHaveCount(0);
    await expect(save).toBeDisabled();
    await capture(page, info.outputPath(`machine-changed-${width}-${theme}.png`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await foot.getByRole("checkbox", { name: "Switch 1 agent to v1", exact: true }).check();
    await save.click();
    await expect(dialog.getByRole("status").filter({ hasText: "Build Machine runs v1 now." })).toBeVisible();
    await expect(choices.locator(".choice-row-title")).toHaveText(["Track Latest", "Pin to v2", "Pin to v1Current"]);
    await expect(save).toBeDisabled();
    await expect(foot.locator(".skill-version-reason")).toHaveText("Choose a different version to save.");

    await choices.getByText("Track Latest", { exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Changes If You Track Latest" })).toBeVisible();
    await foot.getByRole("checkbox", { name: "Switch 1 agent to the latest version", exact: true }).check();
    await save.click();
    await expect(dialog.getByRole("status").filter({ hasText: "Build Machine tracks the latest version now." })).toBeVisible();
    expect(server.saves).toEqual([
      { versionId: v1.id, expectedRevision: null, expectedLatestVersionId: v2.id },
      { versionId: null, expectedRevision: "rev1", expectedLatestVersionId: v2.id },
    ]);
  });
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`the Machine select and the version list share one width with a long machine name at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await machineServer(page);
    const dialog = await openMachineVersion(page, "?longMachine=1");
    const trigger = dialog.getByRole("button", { name: /^Machine:/ });
    await expect(trigger).toBeVisible();
    await expect(dialog.getByRole("radiogroup", { name: "Version" }).getByRole("radio")).toHaveCount(3);
    const widths = await dialog.evaluate((element) => ({
      select: element.querySelector<HTMLElement>(".field .ui-select-trigger")!.offsetWidth,
      list: element.querySelector<HTMLElement>(".choice-rows")!.offsetWidth,
    }));
    expect(widths.select).toBe(widths.list);
    // The name never widens the select: where it does not fit it ends in an ellipsis.
    const value = await trigger.locator(".ui-select-value").evaluate((element) => ({
      text: element.textContent, overflow: getComputedStyle(element).textOverflow, clipped: element.scrollWidth > element.clientWidth,
    }));
    expect(value).toEqual({ text: "Build Machine in the Third-Floor Lab Rack With Two GPU Cards", overflow: "ellipsis", clipped: width < 800 });
  });
}

test("choosing quickly reads only the settled choice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await machineServer(page);
  const dialog = await openMachineVersion(page);
  const choices = dialog.getByRole("radiogroup", { name: "Version" });
  await expect(choices.getByRole("radio")).toHaveCount(3);
  await choices.getByRole("radio", { name: /^Track Latest/ }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("heading", { name: "Changes If You Pin to v1" })).toBeVisible();
  await expect(dialog.locator(".skill-diff-file")).toHaveCount(2);
  expect(server.previews).toEqual([v1.id]);
  // Back to the choice in force: no read, and Save waits for a different one.
  await page.keyboard.press("ArrowDown");
  await expect(choices.getByRole("radio", { name: /^Track Latest/ })).toBeChecked();
  await expect(dialog.locator(".skill-review-changes")).toHaveCount(0);
  await expect(dialog.locator(".modal-foot").getByRole("button", { name: "Save Version", exact: true })).toBeDisabled();
  expect(server.previews).toEqual([v1.id]);
});

test("a stale machine version asks for a fresh preview before saving", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await machineServer(page, { refuseFirstSave: true });
  const dialog = await openMachineVersion(page);
  const foot = dialog.locator(".modal-foot");
  const save = foot.getByRole("button", { name: "Save Version", exact: true });
  await dialog.getByRole("radiogroup", { name: "Version" }).getByText("Pin to v1", { exact: true }).click();
  await foot.getByRole("checkbox", { name: "Switch 1 agent to v1", exact: true }).check();
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("Preview again");
  await expect(save).toBeDisabled();
  await expect(foot.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Preview Again" }).click();
  await expect(dialog.getByRole("heading", { name: "Changes If You Pin to v1" })).toBeVisible();
  await expect(dialog.locator(".skill-diff-file")).toHaveCount(2);
  expect(server.previews).toEqual([v1.id, v1.id]);
  await foot.getByRole("checkbox", { name: "Switch 1 agent to v1", exact: true }).check();
  await save.click();
  await expect(dialog.getByRole("status").filter({ hasText: "Build Machine runs v1 now." })).toBeVisible();
  expect(server.saves).toHaveLength(2);
});
