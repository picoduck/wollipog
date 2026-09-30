import { expect, test, type Page } from "@playwright/test";
import { choosePageAction } from "./page-actions.js";

// #1963: Import from Machine is a two-pane review. Folders load when a machine is chosen, the
// selected folder's facts and diff sit beside the list (a pushed step on a phone), the primary names
// the result, and adoption is one stacked danger confirmation fed by the safety check.

type Candidate = { id: string; name: string; sourceDirectory: string; generation: string; context?: { kind: "wsl"; distro: string } };
const skillFile = (name: string, body: string) => ({ path: "SKILL.md", encoding: "utf8", content: `---\nname: ${name}\n---\n${body}` });
const codeReview: Candidate = { id: "opaque", name: "code-review", sourceDirectory: ".codex/skills", generation: "generation" };
const alpha: Candidate = { id: "alpha-id", name: "alpha", sourceDirectory: ".claude/skills", generation: "generation" };

function previewOf(candidate: Candidate, disposition: "new" | "update" | "identical", assignmentCount = 0) {
  return {
    previewId: `preview-${candidate.id}`, candidate, digest: "a".repeat(64), disposition, assignmentCount,
    files: disposition === "identical"
      ? [skillFile(candidate.name, "Review")]
      : [skillFile(candidate.name, "Inspect the full diff and callers."), { path: "scripts/check.sh", encoding: "utf8", content: "echo review-only" }],
    previousFiles: disposition === "new" ? [] : [skillFile(candidate.name, disposition === "identical" ? "Review" : "Inspect the diff.")],
  };
}

/** Route discovery (counted) and the discard; previews come from `previews` by candidate id. */
async function routeMachine(page: Page, candidates: Candidate[], previews: Record<string, unknown>) {
  const calls = { discover: 0, preview: [] as string[] };
  await page.route("**/api/runners/*/skill-snapshots", async (route) => {
    calls.discover++;
    await route.fulfill({ json: { discoveryId: "discovery", candidates } });
  });
  await page.route("**/api/skill-machine/discovery/preview", async (route) => {
    const { candidateId } = route.request().postDataJSON() as { candidateId: string };
    calls.preview.push(candidateId);
    await route.fulfill({ json: previews[candidateId] });
  });
  await page.route("**/api/skill-machine/discovery", (route) => route.fulfill({ status: 204 }));
  return calls;
}

async function openImport(page: Page) {
  await choosePageAction(page, "Import from Machine…", "Import");
  const dialog = page.getByRole("dialog", { name: "Import from Machine" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectNoProtocolWords(page: Page) {
  const text = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="menu"]')]
    .map((element) => `${element.textContent} ${[...element.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label")).join(" ")}`)
    .join(" "));
  expect(text).not.toMatch(/protocol/iu);
}

/** No button in the body stretches across its pane; folder rows are rows, not buttons in that sense. */
async function expectNoFullWidthButtons(page: Page) {
  const wide = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".modal-body .btn, .modal-body .icon-btn")]
    .filter((button) => {
      const pane = button.closest<HTMLElement>(".skill-machine-import-pane, .modal-body")!;
      const style = getComputedStyle(pane);
      const inner = pane.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      return button.offsetWidth >= inner - 1;
    }).map((button) => button.textContent));
  expect(wide).toEqual([]);
}

test("choosing a machine lists its folders, and the selected folder is reviewed beside the list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let imports = 0;
  const previews: Record<string, unknown> = { opaque: previewOf(codeReview, "update", 2), "alpha-id": previewOf(alpha, "new") };
  const calls = await routeMachine(page, [codeReview, alpha], previews);
  await page.route("**/api/skill-machine/discovery/import", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ previewId: "preview-opaque", acceptUpdate: true });
    imports++;
    previews.opaque = previewOf(codeReview, "identical", 2);
    await route.fulfill({ json: { skill: { id: "skill-1", name: "code-review" } } });
  });
  await page.goto("/skills-removals-e2e.html");
  const dialog = await openImport(page);
  // Folders load without another button; a library name reads In Library until it is reviewed.
  const folders = dialog.getByRole("group", { name: "Skill Folders" });
  const reviewRow = folders.getByRole("button", { name: /^code-review/u });
  await expect(reviewRow).toContainText(".codex/skills/code-review");
  await expect(reviewRow.locator(".row-trail")).toHaveText("In Library");
  await expect(folders.getByRole("button", { name: /^alpha/u }).locator(".row-trail")).toHaveText("New Skill");
  expect(calls.discover).toBe(1);
  await expect(dialog.getByText("Choose a folder to review it.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Import Skill", exact: true })).toBeDisabled();
  await expectNoProtocolWords(page);

  await reviewRow.click();
  await expect(reviewRow).toHaveAttribute("aria-current", "true");
  await expect(reviewRow).toHaveClass(/is-selected/u);
  await expect(reviewRow.locator(".row-trail")).toHaveText("New Version");
  const facts = dialog.locator(".skill-machine-import-pane.review .facts");
  await expect(facts).toContainText("MachineBuild Machine");
  await expect(facts).toContainText("Folder.codex/skills/code-review");
  await expect(facts).toContainText("ResultNew Version");
  // The review pane sits beside the list at 1440×900.
  const listBox = (await dialog.locator(".skill-machine-import-pane.list").boundingBox())!;
  const reviewBox = (await dialog.locator(".skill-machine-import-pane.review").boundingBox())!;
  expect(reviewBox.x).toBeGreaterThan(listBox.x + listBox.width - 2);
  expect(Math.abs(reviewBox.y - listBox.y)).toBeLessThan(2);
  const script = dialog.locator(".skill-diff-file", { hasText: "scripts/check.sh" });
  await expect(script.locator(".skill-diff-file-head .status")).toHaveText(["Script", "Added"]);
  // The consent row appears because existing assignments would update, and gates the primary.
  const primary = dialog.getByRole("button", { name: "Import as New Version", exact: true });
  await expect(primary).toBeDisabled();
  const consent = dialog.locator(".modal-foot").getByRole("checkbox", { name: "Deploy to 2 existing assignments", exact: true });
  await consent.check();
  await expectNoFullWidthButtons(page);
  await expectNoProtocolWords(page);
  await primary.click();
  await expect(dialog.getByRole("status").filter({ hasText: "Imported code-review as a new version." })).toBeVisible();
  expect(imports).toBe(1);
  // The folder is read again: it now matches the latest version, so there is nothing to import.
  await expect(dialog.getByText("This Folder Matches the Latest Version", { exact: true })).toBeVisible();
  await expect(reviewRow.locator(".row-trail")).toHaveText("Matches Latest");
  await expect(dialog.getByRole("button", { name: "Import Skill", exact: true })).toBeDisabled();
  await expect(dialog.locator(".modal-foot")).toContainText("This folder matches the latest version; there is nothing to import.");
  await expect(consent).toHaveCount(0);

  // A new skill: its own primary, and no consent row.
  await folders.getByRole("button", { name: /^alpha/u }).click();
  await expect(dialog.getByRole("button", { name: "Import as New Skill", exact: true })).toBeEnabled();
  await expect(dialog.locator(".modal-foot .review-consent")).toHaveCount(0);
  await expect(reviewRow).not.toHaveAttribute("aria-current", "true");

  // Scan Again reads the machine again and starts a fresh review.
  await dialog.getByRole("button", { name: "Scan Again", exact: true }).click();
  await expect.poll(() => calls.discover).toBe(2);
  await expect(dialog.getByText("Choose a folder to review it.")).toBeVisible();
});

test("a folder's read error blocks import", async ({ page }) => {
  await routeMachine(page, [alpha], {});
  await page.route("**/api/skill-machine/discovery/preview", (route) => route.fulfill({ status: 502, json: { error: "Source changed. Discover it again." } }));
  await page.goto("/skills-removals-e2e.html");
  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: /^alpha/u }).click();
  await expect(dialog.getByText("Couldn't Read This Folder")).toBeVisible();
  await expect(dialog.getByText("Source changed")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Import Skill", exact: true })).toBeDisabled();
});

test("at 390px a folder pushes a review step with Back, in one sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeMachine(page, [codeReview, alpha], { opaque: previewOf(codeReview, "update", 2) });
  await page.goto("/skills-removals-e2e.html");
  const dialog = await openImport(page);
  const row = dialog.getByRole("button", { name: /^code-review/u });
  await expect(row).toBeVisible();
  await expect(dialog.getByText("Choose a folder to review it.")).toHaveCount(0);
  await row.click();
  await expect(dialog.getByRole("group", { name: "Skill Folders" })).toHaveCount(0);
  await expect(dialog.locator(".facts")).toContainText("ResultNew Version");
  await expect(dialog.locator(".modal-foot .review-consent")).toBeVisible();
  const back = dialog.getByRole("button", { name: "Back to Skill Folders", exact: true });
  await back.click();
  await expect(row).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("a runner too old to import shows only the runner-update notice", async ({ page }) => {
  let discovered = 0;
  await page.route("**/api/runners/*/skill-snapshots", (route) => { discovered++; return route.abort(); });
  await page.goto("/skills-removals-e2e.html?legacySkills=1");
  const dialog = await openImport(page);
  await expect(dialog.getByText("Build Machine Needs a Runner Update")).toBeVisible();
  await expect(dialog.getByText("Update Wollipog on this machine to import its skill folders.")).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Skill Folders" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Scan Again" })).toHaveCount(0);
  await expect(dialog.locator(".notice")).toHaveCount(1);
  expect(discovered).toBe(0);
  await dialog.getByRole("button", { name: "More Actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Adoption Recovery…" })).toBeDisabled();
  await expectNoProtocolWords(page);
});

test("the Machine select shows each machine's status and disables offline ones", async ({ page }) => {
  await routeMachine(page, [], {});
  await page.goto("/skills-removals-e2e.html?matrix=1");
  const dialog = await openImport(page);
  await expect(dialog.getByText("No skill folders were found on Build Machine.")).toBeVisible();
  await dialog.getByRole("button", { name: /^Machine:/u }).click();
  await expect(page.getByRole("option", { name: /Build Machine/u })).toContainText("Online");
  const offline = page.getByRole("option", { name: /Other Machine/u });
  await expect(offline).toContainText("Offline");
  await expect(offline).toHaveAttribute("aria-disabled", "true");
});

test("switching machines lists the other machine's folders", async ({ page }) => {
  const calls = await routeMachine(page, [codeReview], { opaque: previewOf(codeReview, "update", 2) });
  await page.goto("/skills-removals-e2e.html?matrix=1&onlineMatrix=1");
  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: /^code-review/u }).click();
  await expect(dialog.locator(".facts")).toContainText("Build Machine");
  await dialog.getByRole("button", { name: /^Machine:/u }).click();
  await page.getByRole("option", { name: /Other Machine/u }).click();
  await expect.poll(() => calls.discover).toBe(2);
  await expect(dialog.getByText("Choose a folder to review it.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^code-review/u })).not.toHaveAttribute("aria-current", "true");
});

test("WSL folders name their distro without exposing transport paths", async ({ page }) => {
  const candidate: Candidate = { id: "wsl-opaque", name: "review", sourceDirectory: ".codex/skills",
    generation: "a".repeat(64), context: { kind: "wsl", distro: "Ubuntu" } };
  await routeMachine(page, [candidate], {});
  await page.goto("/skills-removals-e2e.html?wslSkills=1");
  const dialog = await openImport(page);
  await expect(dialog.getByRole("button", { name: /^review/u })).toContainText("WSL: Ubuntu · .codex/skills/review");
  await expect(dialog.getByText(/wsl\.localhost/u)).toHaveCount(0);
});

const preflightJson = (candidate: Candidate, overrides: Record<string, unknown> = {}) => ({
  status: "prerequisites_met", mutationSupported: true, blockers: [], advisories: [], adoptionToken: "approval",
  sharedReaders: [], source: { candidate, digest: "a".repeat(64), checkedAt: 1 },
  notice: "Read-only prerequisite report. No directory was changed.", ...overrides,
});

test("Replace with Link opens one stacked confirmation that sends both acceptances", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls = await routeMachine(page, [codeReview], { opaque: previewOf(codeReview, "identical", 1) });
  let preflights = 0;
  await page.route("**/api/skill-machine/discovery/adoption-preflight", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ previewId: "preview-opaque" });
    preflights++;
    await route.fulfill({ json: preflightJson(codeReview, { sharedReaders: ["claude"] }) });
  });
  let adoptions = 0;
  await page.route("**/api/skill-machine/discovery/adopt", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ previewId: "preview-opaque", adoptionToken: "approval",
      acceptSharedImpact: true, confirmation: "explicit" });
    adoptions++;
    await route.fulfill({ json: { status: "adopted", operationId: "operation", backupDirectory: ".codex/skills/.wollipog-adoption-operation" } });
  });
  await page.goto("/skills-removals-e2e.html");
  const dialog = await openImport(page);
  const row = dialog.getByRole("button", { name: /^code-review/u });
  await row.click();
  await expect(dialog.getByText("This Folder Matches the Latest Version", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Replace with Link…", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Replace with Link" });
  await expect(confirmation).toBeVisible();
  await expect(page.locator(".modal-backdrop.stacked")).toHaveCount(1);
  await expect(confirmation.getByRole("list", { name: "Also Read By" })).toContainText("Claude");
  await expect(confirmation).toContainText("You can undo this from Adoption Recovery.");
  expect(preflights).toBe(1);
  await expect(confirmation.getByRole("checkbox")).toHaveCount(0);
  await expectNoProtocolWords(page);
  // Cancel returns to the dialog with the selection kept.
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(row).toHaveAttribute("aria-current", "true");
  expect(adoptions).toBe(0);
  // Opening it again runs the safety check again; confirming adopts.
  await dialog.getByRole("button", { name: "Replace with Link…", exact: true }).click();
  await expect.poll(() => preflights).toBe(2);
  await confirmation.getByRole("button", { name: "Replace with Link", exact: true }).click();
  await expect(confirmation).toBeHidden();
  expect(adoptions).toBe(1);
  await expect(dialog.getByText("Replaced with Link")).toBeVisible();
  await expect.poll(() => calls.discover).toBe(2);
});

test("the safety check's blockers disable Replace with Link and say why", async ({ page }) => {
  await routeMachine(page, [codeReview], { opaque: previewOf(codeReview, "identical", 1) });
  await page.route("**/api/skill-machine/discovery/adoption-preflight", (route) => route.fulfill({ json: preflightJson(codeReview, {
    status: "blocked", adoptionToken: undefined, blockers: ["executable_mode_adoption_unsupported", "source_not_targeted"] }) }));
  await page.goto("/skills-removals-e2e.html");
  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: /^code-review/u }).click();
  await dialog.getByRole("button", { name: "Replace with Link…", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Replace with Link" });
  await expect(confirmation.getByText("This Folder Can't Be Replaced")).toBeVisible();
  await expect(confirmation.getByText("No assigned agent reads this folder.")).toBeVisible();
  const confirm = confirmation.getByRole("button", { name: "Replace with Link", exact: true });
  await expect(confirm).toBeDisabled();
  await expect(confirmation.locator(".modal-foot")).toContainText("Resolve what the safety check found to replace this folder.");
});

for (const [query, os] of [["macos=1", "macOS"], ["windows=1", "Windows"]] as const) test(
  `an older ${os} runner imports but cannot replace folders with links`,
  async ({ page }) => {
    await routeMachine(page, [codeReview], { opaque: previewOf(codeReview, "identical", 1) });
    await page.goto(`/skills-removals-e2e.html?${query}`);
    const dialog = await openImport(page);
    await dialog.getByRole("button", { name: /^code-review/u }).click();
    await expect(dialog.getByText("Build Machine needs a runner update to replace this folder with a link to the library.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Replace with Link…" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "More Actions", exact: true }).click();
    const recovery = page.getByRole("menuitem", { name: "Adoption Recovery…" });
    await expect(recovery).toBeDisabled();
    await expect(recovery).toContainText("Build Machine needs a runner update.");
    await expectNoProtocolWords(page);
  },
);

test("a Windows runner without WSL adoption keeps WSL folders import-only", async ({ page }) => {
  const candidate: Candidate = { id: "wsl-opaque", name: "review", sourceDirectory: ".codex/skills",
    generation: "a".repeat(64), context: { kind: "wsl", distro: "Ubuntu" } };
  await routeMachine(page, [candidate], { "wsl-opaque": previewOf(candidate, "identical", 1) });
  await page.goto("/skills-removals-e2e.html?windowsAdoption=1");
  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: /^review/u }).click();
  await expect(dialog.getByText("This Folder Matches the Latest Version", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Replace with Link…" })).toHaveCount(0);
});

test("Adoption Recovery is in the ⋯ menu, and Restore Original asks before restoring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await routeMachine(page, [], {});
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  let restored = false;
  const operation = () => ({
    operationId, backupDirectory: `.codex/skills/.wollipog-adoption-${operationId}`, sourceDirectory: ".codex/skills",
    name: "code-review", digest: "a".repeat(64), state: restored ? "restored" : "managed_linked",
    detail: restored ? "A recovery link exposes the preserved original at its source path." : "The managed link is active and the original is preserved.",
  });
  await page.route("**/api/runners/runner-1/skill-adoption-recovery", (route) =>
    route.fulfill({ json: { operations: [operation()], truncated: false } }));
  let restores = 0;
  await page.route(`**/api/runners/runner-1/skill-adoption-recovery/${operationId}/restore`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirmation: "explicit" });
    restores++;
    restored = true;
    await route.fulfill({ json: { status: "restored", operation: operation() } });
  });
  await page.goto("/skills-removals-e2e.html");
  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: "More Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Adoption Recovery…" }).click();
  const recovery = page.getByRole("dialog", { name: "Adoption Recovery" });
  const journal = recovery.getByRole("listitem").filter({ hasText: "code-review" });
  await expect(journal).toContainText(".codex/skills/code-review");
  await expect(journal).toContainText("Linked");
  await expect(journal).not.toContainText(operationId);
  await journal.getByRole("button", { name: "Restore Original…", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Restore Original" });
  await expect(confirmation).toBeVisible();
  expect(restores).toBe(0);
  await confirmation.getByRole("button", { name: "Restore Original", exact: true }).click();
  await expect(confirmation).toBeHidden();
  expect(restores).toBe(1);
  await expect(recovery.getByRole("status").filter({ hasText: "Restored the original code-review folder." })).toBeVisible();
  await expect(journal).toContainText("Restored");
  await expect(journal.getByRole("button", { name: "Restore Original…" })).toHaveCount(0);
  await expectNoProtocolWords(page);
  await recovery.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeVisible();
});

test("a restore refusal phrased with protocol numbers is shown in the dialog's words", async ({ page }) => {
  await routeMachine(page, [], {});
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  await page.route("**/api/runners/runner-1/skill-adoption-recovery", (route) => route.fulfill({ json: { truncated: false, operations: [{
    operationId, backupDirectory: ".codex/skills/.x", sourceDirectory: ".codex/skills", name: "code-review", digest: "a",
    state: "managed_linked", detail: "The managed link is active and the original is preserved." }] } }));
  await page.route(`**/api/runners/runner-1/skill-adoption-recovery/${operationId}/restore`, (route) => route.fulfill({
    status: 409, json: { error: "Machine skill adoption recovery requires runner protocol v116 or newer; this runner is v115." } }));
  await page.goto("/skills-removals-e2e.html");
  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: "More Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Adoption Recovery…" }).click();
  await page.getByRole("dialog", { name: "Adoption Recovery" }).getByRole("button", { name: "Restore Original…" }).click();
  const confirmation = page.getByRole("dialog", { name: "Restore Original" });
  await confirmation.getByRole("button", { name: "Restore Original", exact: true }).click();
  await expect(confirmation.getByText("Build Machine needs a runner update to do this.")).toBeVisible();
  await expectNoProtocolWords(page);
});

test("Escape closes an open ⋯ menu whose only item is unavailable, and keeps the dialog", async ({ page }) => {
  await routeMachine(page, [codeReview], { opaque: previewOf(codeReview, "update", 2) });
  await page.goto("/skills-removals-e2e.html?legacyRecovery=1");
  const dialog = await openImport(page);
  const row = dialog.getByRole("button", { name: /^code-review/u });
  await row.click();
  await expect(dialog.locator(".facts")).toContainText("ResultNew Version");
  await dialog.getByRole("button", { name: "More Actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Adoption Recovery…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(dialog.getByRole("button", { name: "More Actions", exact: true })).toBeFocused();
  // Tab leaves the menu as it leaves any menu: closed, so a later Escape belongs to the dialog.
  await dialog.getByRole("button", { name: "More Actions", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
});
