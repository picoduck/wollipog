import { expect, test, type Page } from "@playwright/test";

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

async function openDrift(page: Page, width: number, theme: string, assignmentCount = 2) {
  let state: typeof drifted = drifted;
  const requests: Array<{ url: string; body: unknown }> = [];
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/runners/runner-1/skills", (route) => route.fulfill({ json: state }));
  await page.route("**/api/runners/runner-1/skills/sync", (route) => route.fulfill({ json: { state: state.reported } }));
  await page.route("**/api/runners/runner-1/skill-drift/preview", async (route) => {
    requests.push({ url: "preview", body: route.request().postDataJSON() });
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
  await page.goto("/skills-removals-e2e.html?drift=1");
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await expect(page.locator(".master-detail-list .row").getByText("Edited", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /code-review/i }).click();
  return { requests };
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const width of [1280, 320]) for (const theme of ["dark", "light"]) {
  test(`an edited deployed copy shows Edited and imports as a new version at ${width} in ${theme}`, async ({ page }, info) => {
    const { requests } = await openDrift(page, width, theme);
    const machine = page.locator(".skills-machine");
    await expect(machine.locator(".status")).toHaveText("Edited");
    await expect(machine.getByRole("heading", { name: "Edited Copies" })).toBeVisible();
    await expect(machine).toContainText("Agent Invocable Copy · Version 4f1c00000000");
    await expect(machine).toContainText("Updates and removals are held");
    await machine.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`drift-status-${width}-${theme}.png`), fullPage: true });
    expect(await noHorizontalOverflow(page)).toBe(true);

    await machine.getByRole("button", { name: "Import Edit as New Version" }).click();
    const dialog = page.getByRole("dialog", { name: "Import Edit as New Version" });
    await expect(dialog).toContainText("This machine is pinned to a version of this skill.");
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
    const importButton = dialog.getByRole("button", { name: "Import Edit as New Version" });
    await expect(importButton).toBeDisabled();
    // The consent names what importing deploys, beside the primary it unlocks.
    const consent = dialog.locator(".modal-foot").getByRole("checkbox", { name: "Deploy to 2 existing assignments", exact: true });
    await expect(consent).not.toBeChecked();
    await page.screenshot({ path: info.outputPath(`drift-import-${width}-${theme}.png`), fullPage: true });
    expect(await noHorizontalOverflow(page)).toBe(true);
    await consent.check();
    await importButton.click();
    await expect(dialog).toBeHidden();
    await expect(machine.locator(".status")).toHaveText("Linked");
    await expect(page.locator(".master-detail-list .row").getByText("Edited", { exact: true })).toHaveCount(0);
    expect(requests).toEqual([
      { url: "preview", body: { name: "code-review", digest, variant: "agent" } },
      { url: "import", body: { acceptUpdate: true } },
    ]);
  });
}

test("an edit whose skill has no assignments imports without a consent row", async ({ page }) => {
  const { requests } = await openDrift(page, 1280, "dark", 0);
  await page.locator(".skills-machine").getByRole("button", { name: "Import Edit as New Version" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Edit as New Version" });
  await expect(dialog.locator(".skill-diff-file")).toHaveCount(1);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  const importButton = dialog.getByRole("button", { name: "Import Edit as New Version" });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(dialog).toBeHidden();
  // The update's server-side acceptance is unchanged: reviewing an update that deploys nothing accepts it.
  expect(requests.at(-1)).toEqual({ url: "import", body: { acceptUpdate: true } });
});

for (const width of [1280, 320]) {
  test(`restoring the library version requires confirmation at ${width}`, async ({ page }, info) => {
    const { requests } = await openDrift(page, width, "dark");
    const machine = page.locator(".skills-machine");
    await machine.getByRole("button", { name: "Restore Library Version" }).click();
    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(confirmation).toContainText("The edited copy of “code-review”");
    await expect(confirmation).toContainText("is discarded and cannot be recovered.");
    await page.screenshot({ path: info.outputPath(`drift-restore-confirm-${width}.png`), fullPage: true });
    expect(await noHorizontalOverflow(page)).toBe(true);
    await confirmation.getByRole("button", { name: "Restore Library Version" }).click();
    await expect(machine.locator(".status")).toHaveText("Linked");
    expect(requests).toEqual([{ url: "restore", body: {
      name: "code-review", digest, variant: "agent", observedDigest, confirmation: "explicit",
    } }]);
  });
}
