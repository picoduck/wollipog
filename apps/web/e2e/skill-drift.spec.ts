import { expect, test, type Locator, type Page } from "@playwright/test";

const digest = "4f1c".padEnd(64, "0");
const observedDigest = "9b2e".padEnd(64, "0");
const library = "---\nname: code-review\n---\n\nAlways review the diff.\n";
const edited = `${library}Also check the tests before approving.\n`;
const drifted = {
  removalReporting: "supported",
  driftReporting: "supported",
  desired: [{ name: "code-review", versionDigest: digest, targets: [{ agentId: "claude", invocation: "agent" }] }],
  reported: {
    deployed: [{ name: "code-review", digest, links: [{ agentId: "claude", status: "conflict",
      detail: "This skill's deployed copy was edited on this machine. Its links stay on the edited copy until the edit is imported as a new version, the library version is restored, or the edit is undone." }] }],
    unmanaged: [],
    drift: [{ name: "code-review", digest, variant: "agent", observedDigest, held: true,
      detail: "Updates and removals for this skill are held until the edit is imported as a new version or the library version is restored." }],
    updatedAt: 1_700_000_000_000,
  },
};
const resolved = {
  ...drifted,
  reported: { ...drifted.reported, drift: [], deployed: [{ name: "code-review", digest, links: [{ agentId: "claude", status: "linked" }] }] },
};

async function openDrift(page: Page, width: number, theme: string, assignmentCount = 2,
  options: { previewDelay?: Promise<void> } = {}) {
  let state: typeof drifted = drifted;
  const requests: Array<{ url: string; body: unknown }> = [];
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/runners/runner-1/skills", (route) => route.fulfill({ json: state }));
  // The review names versions from the version list and the machine's pin (#1973): the copy is of
  // v3, the latest, and Build Machine is pinned to it.
  await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: {
    versions: [{ id: "skillv_3", digest, createdAt: 1_700_000_000_000, versionNumber: 3 }], nextCursor: null,
  } }));
  await page.route("**/api/skills/skill-1/machines/runner-1/version-policy", (route) => route.fulfill({ json: {
    policy: { versionId: "skillv_3", revision: "r1" },
  } }));
  await page.route("**/api/runners/runner-1/skills/sync", (route) => route.fulfill({ json: { state: state.reported } }));
  await page.route("**/api/runners/runner-1/skill-drift/preview", async (route) => {
    requests.push({ url: "preview", body: route.request().postDataJSON() });
    await options.previewDelay;
    await route.fulfill({ json: {
      previewId: "review-1",
      drift: { name: "code-review", digest, variant: "agent", observedDigest },
      files: [{ path: "SKILL.md", content: edited, encoding: "utf8" }],
      previousFiles: [{ path: "SKILL.md", content: library, encoding: "utf8" }],
      digest: observedDigest, importable: true, disposition: "update", publishedFromLatest: true, pinned: true, assignmentCount,
    } });
  });
  await page.route("**/api/skill-drift/review-1/import", async (route) => {
    requests.push({ url: "import", body: route.request().postDataJSON() });
    state = resolved;
    await route.fulfill({ json: { released: false, pinMoved: true, state: resolved.reported } });
  });
  await page.route("**/api/skill-drift/review-1", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/runners/runner-1/skill-drift/restore", async (route) => {
    requests.push({ url: "restore", body: route.request().postDataJSON() });
    state = resolved;
    await route.fulfill({ json: { status: "restored", state: resolved.reported } });
  });
  await page.goto("/skills-removals-e2e.html?drift=1&pins=1");
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await expect(page.locator(".master-detail-list .row").getByText("Edited", { exact: true })).toBeVisible();
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  return { requests };
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** No two consecutive text blocks before the diff are more than 16px apart (#1973). */
async function expectTextBlocksWithin16px(dialog: Locator) {
  const gaps = await dialog.evaluate((element) => {
    const blocks = [
      ...element.querySelectorAll(".modal-body > .skill-review-facts, .modal-body > .notice"),
      ...element.querySelectorAll(".skill-review-changes-title, .skill-review-changes-note"),
    ].map((block) => block.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    return blocks.slice(1).map((block, index) => Math.round(block.top - blocks[index]!.bottom));
  });
  expect(gaps.length).toBeGreaterThanOrEqual(3);
  for (const gap of gaps) expect(gap).toBeLessThanOrEqual(16);
}

for (const width of [1280, 320]) for (const theme of ["dark", "light"]) {
  test(`an edited deployed copy shows Edited and imports as a new version at ${width} in ${theme}`, async ({ page }, info) => {
    const { requests } = await openDrift(page, width, theme);
    const machine = page.locator("table.skill-deployment");
    await expect(machine.locator(".skill-deployment-agent .status")).toHaveText("Edited");
    // The edited copy is the notice under the skill's header (#1972); Deployment keeps the badge.
    const notice = page.locator(".skill-notice-slot .notice");
    await expect(notice.locator(".notice-title")).toHaveText("Build Machine Has an Edited Copy");
    await expect(notice).toContainText("Claude's copy differs from 4f1c00000000. Updates on that machine wait until you import the edit or restore 4f1c00000000.");
    await expect(machine.getByRole("heading", { name: "Edited Copies" })).toHaveCount(0);
    await expect(machine).toContainText("Edited on this machine. Updates wait until you import or restore it.");
    await machine.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`drift-status-${width}-${theme}.png`), fullPage: true });
    expect(await noHorizontalOverflow(page)).toBe(true);

    await notice.getByRole("button", { name: "Review Edit…" }).click();
    const dialog = page.getByRole("dialog", { name: "Import Edit as New Version" });
    // #1973: one sentence, the facts, one notice for the pin, then the diff under its heading.
    await expect(dialog.locator(".modal-desc")).toHaveText(
      "Importing records the files edited on Build Machine as a new version of code-review.");
    await expect(dialog.locator(".skill-review-facts dt")).toHaveText(["Machine", "Edited Copy Of", "Copy", "Result"]);
    await expect(dialog.locator(".skill-review-facts dd")).toHaveText(["Build Machine", "v3", "Agent Invocable", "New version v4"]);
    await expect(dialog.locator(".modal-body > .notice")).toHaveText(["Build Machine is pinned to v3. Importing moves its pin to v4."]);
    await expect(dialog.getByRole("heading", { name: "Changes From v3" })).toBeVisible();
    await expectTextBlocksWithin16px(dialog);
    // One highlighted diff (#1948): the changed file is open, its header counts the change, and the
    // added line is announced as one.
    const file = dialog.locator(".skill-diff-file", { hasText: "SKILL.md" });
    await expect(file.locator(".skill-diff-file-head")).toContainText("SKILL.md");
    await expect(file.locator(".skill-diff-file-head")).toContainText("Changed");
    await expect(file.locator(".skill-diff-counts")).toContainText("+1 −0");
    await expect(file.locator(".diff-line-add")).toHaveCount(1);
    await expect(file.locator(".diff-line-add")).toContainText("Added line");
    await expect(file.locator(".diff-line-add")).toContainText("Also check the tests before approving.");
    await expect(dialog.getByRole("heading", { name: "Current" })).toHaveCount(0);
    const importButton = dialog.getByRole("button", { name: "Import as v4" });
    await expect(importButton).toBeDisabled();
    // The consent names what importing deploys, beside the primary it unlocks.
    const consent = dialog.locator(".modal-foot").getByRole("checkbox", { name: "Deploy to 2 existing assignments", exact: true });
    await expect(consent).not.toBeChecked();
    await page.screenshot({ path: info.outputPath(`drift-import-${width}-${theme}.png`), fullPage: true });
    expect(await noHorizontalOverflow(page)).toBe(true);
    await consent.check();
    await importButton.click();
    await expect(dialog).toBeHidden();
    await expect(machine.locator(".skill-deployment-agent .status")).toHaveText("Linked");
    await expect(page.locator(".master-detail-list .row").getByText("Edited", { exact: true })).toHaveCount(0);
    expect(requests).toEqual([
      { url: "preview", body: { name: "code-review", digest, variant: "agent" } },
      { url: "import", body: { acceptUpdate: true } },
    ]);
  });
}

test("an edit whose skill has no assignments imports without a consent row", async ({ page }) => {
  const { requests } = await openDrift(page, 1280, "dark", 0);
  await page.locator(".skill-notice-slot").getByRole("button", { name: "Review Edit…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Edit as New Version" });
  await expect(dialog.locator(".skill-diff-file")).toHaveCount(1);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  const importButton = dialog.getByRole("button", { name: "Import as v4" });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(dialog).toBeHidden();
  // The update's server-side acceptance is unchanged: reviewing an update that deploys nothing accepts it.
  expect(requests.at(-1)).toEqual({ url: "import", body: { acceptUpdate: true } });
});

for (const width of [1280, 320]) {
  test(`restoring the library version requires confirmation at ${width}`, async ({ page }, info) => {
    const { requests } = await openDrift(page, width, "dark");
    const machine = page.locator("table.skill-deployment");
    await page.locator(".skill-notice-slot").getByRole("button", { name: "Restore Library Version…" }).click();
    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(confirmation).toContainText("The edited copy of “code-review”");
    await expect(confirmation).toContainText("is discarded and cannot be recovered.");
    await page.screenshot({ path: info.outputPath(`drift-restore-confirm-${width}.png`), fullPage: true });
    expect(await noHorizontalOverflow(page)).toBe(true);
    await confirmation.getByRole("button", { name: "Restore Library Version" }).click();
    await expect(machine.locator(".skill-deployment-agent .status")).toHaveText("Linked");
    expect(requests).toEqual([{ url: "restore", body: {
      name: "code-review", digest, variant: "agent", observedDigest, confirmation: "explicit",
    } }]);
  });
}

for (const width of [1280, 390]) {
  test(`Restore Library Version… in the review opens the same confirmation and closes the review at ${width}`, async ({ page }, info) => {
    const { requests } = await openDrift(page, width, "dark");
    await page.locator(".skill-notice-slot").getByRole("button", { name: "Review Edit…" }).click();
    const dialog = page.getByRole("dialog", { name: "Import Edit as New Version" });
    await expect(dialog.locator(".skill-diff-file")).toHaveCount(1);
    const restore = dialog.getByRole("button", { name: "Restore Library Version…" });
    if (width > 760) {
      // §7.3: the destructive tertiary is far left in the footer.
      await expect(dialog.locator(".modal-foot > .modal-tertiary").getByRole("button")).toHaveText("Restore Library Version…");
    } else {
      // §7.5: a sheet's footer keeps two buttons; the alternative is a full-width row at the body's end.
      await expect(dialog.locator(".modal-foot > .btn")).toHaveText(["Cancel", "Import as v4"]);
      await expect(dialog.locator(".modal-body > .modal-tertiary").getByRole("button")).toHaveText("Restore Library Version…");
      await expect(dialog.locator(".modal-body > :last-child")).toHaveClass(/modal-tertiary/);
      // Full width: the row spans the body's content box (offsetWidth: the sheet opens transformed).
      const widths = await restore.evaluate((button) => {
        const body = button.closest(".modal-body")!;
        const style = getComputedStyle(body);
        return { row: (button as HTMLElement).offsetWidth,
          content: body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
      expect(widths.row).toBe(widths.content);
      await restore.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`drift-review-sheet-${width}.png`) });
      expect(await noHorizontalOverflow(page)).toBe(true);
    }
    await restore.click();
    const confirmation = page.getByRole("dialog", { name: "Restore Library Version" });
    await expect(confirmation).toContainText("The edited copy of “code-review”");
    await confirmation.getByRole("button", { name: "Restore Library Version" }).click();
    await expect(dialog).toBeHidden();
    await expect(confirmation).toBeHidden();
    await expect(page.locator("table.skill-deployment .skill-deployment-agent .status")).toHaveText("Linked");
    expect(requests.map((request) => request.url)).toEqual(["preview", "restore"]);
  });
}

test("while the edited copy is read, the review keeps the diff's place with a skeleton", async ({ page }, info) => {
  let release!: () => void;
  await openDrift(page, 1440, "dark", 2, { previewDelay: new Promise((resolve) => { release = resolve; }) });
  await page.locator(".skill-notice-slot").getByRole("button", { name: "Review Edit…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Edit as New Version" });
  const loading = dialog.locator(".skill-review-loading");
  await expect(loading).toHaveText("Reading the edited copy…");
  await expect(loading).toHaveAttribute("role", "status");
  expect(await loading.evaluate((block) => (block as HTMLElement).offsetHeight)).toBe(240);
  await expect(dialog.getByRole("button", { name: "Restore Library Version…" })).toBeDisabled();
  await expect(dialog.locator(".modal-foot .btn.primary")).toBeDisabled();
  await page.screenshot({ path: info.outputPath("drift-review-loading-1440.png") });
  release();
  await expect(dialog.locator(".skill-diff-file")).toHaveCount(1);
  await expect(loading).toHaveCount(0);
});
