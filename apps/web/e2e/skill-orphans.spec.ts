import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Orphaned Copies (#1974; docs/design-system.md §5.1–§5.2, §3.1, §12): a section per machine, each
 * copy one two-line row with Import… and ⋯, a visible amber reason when a copy can't be imported, a
 * compact notice for what a runner can't report, and one All Resolved state when nothing is left.
 */
const digest = "4f1c".padEnd(64, "0");
const keptId = "0f0e0d0c-0b0a-4908-8706-050403020100";
const unidentifiedId = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const fingerprint = "c".repeat(64);
const recovered = "---\nname: release-notes\n---\n\nSummarize merged pull requests.\nGroup them by area.\n";
const reported = { deployed: [], unmanaged: [], updatedAt: 1_700_000_000_000 };
const keptAside = {
  kind: "kept_aside", id: keptId, name: "release-notes", digest, variant: "manual", keptAsideAt: 1_700_000_000_000,
  observedDigest: "9b2e".padEnd(64, "0"), observedFingerprint: "7e1d".padEnd(64, "0"),
  detail: "A restore kept this edited copy aside in the skill store instead of deleting it.",
};
const current = {
  removalReporting: "supported",
  driftReporting: "supported",
  keptAsideReporting: "supported",
  desired: [],
  reported,
  orphaned: [
    keptAside,
    { kind: "kept_aside", id: unidentifiedId, observedFingerprint: fingerprint,
      detail: "An earlier runner kept this edited copy aside without recording the skill version it came from. It cannot be read as skill content: it contains a symlink." },
    { kind: "deleted_skill", name: "triage-helper", digest, variant: "agent", observedDigest: "5d3a".padEnd(64, "0"), held: true },
  ] as Array<Record<string, unknown>>,
};
const older = {
  removalReporting: "supported",
  driftReporting: "supported",
  keptAsideReporting: "unsupported",
  desired: [],
  reported,
  orphaned: [{ kind: "deleted_skill", name: "legacy-lint", digest, variant: "manual", held: false }] as Array<Record<string, unknown>>,
};

async function openOrphans(page: Page, width: number, theme: string, options: {
  first?: typeof current; second?: typeof older; query?: string;
} = {}) {
  let state = options.first ?? current;
  const requests: Array<{ url: string; body: unknown }> = [];
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/runners/runner-1/skills", (route) => route.fulfill({ json: state }));
  await page.route("**/api/runners/runner-2/skills", (route) => route.fulfill({ json: options.second ?? older }));
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
    state = { ...state, orphaned: state.orphaned.filter((copy) => copy.id !== keptId) };
    await route.fulfill({ json: { released: true, state: reported } });
  });
  await page.route("**/api/orphaned-skill-copies/review-1", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/runners/runner-1/orphaned-skill-copies/discard", async (route) => {
    const body = route.request().postDataJSON() as { id?: string };
    requests.push({ url: "discard", body });
    state = { ...state, orphaned: state.orphaned.filter((copy) => copy.id !== body.id) };
    await route.fulfill({ json: { status: "discarded", state: reported } });
  });
  await page.goto(`/skills-removals-e2e.html?orphans=1${options.query ?? ""}`);
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  const entry = page.locator(".master-detail-list .row", { hasText: "Orphaned Copies" });
  return { requests, entry };
}

const pane = (page: Page) => page.getByRole("region", { name: "Orphaned Copies" });
const machine = (page: Page, name: string) => pane(page).locator("section[aria-labelledby]")
  .filter({ has: page.getByRole("heading", { level: 3, name }) });
const rows = (scope: Locator) => scope.locator(".skill-orphans-list > li.row");
const row = (scope: Locator, name: string) => rows(scope).filter({ has: scope.page().locator(".row-title", { hasText: name }) });
const importButton = (scope: Locator) => scope.getByRole("button", { name: /^Import .*…$/ });
const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** How many lines an element's text takes, from its height and line height. */
const lineCount = (locator: Locator) => locator.evaluate((element) => {
  const style = getComputedStyle(element);
  return Math.round(element.getBoundingClientRect().height / parseFloat(style.lineHeight));
});

async function openMenu(scope: Locator, name: string) {
  await scope.getByRole("button", { name: `More Actions for ${name}` }).click();
  return scope.page().getByRole("menu");
}

for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
  test(`orphaned copies are rows per machine, imported with Import…, and discarded from ⋯ at ${width} in ${theme}`, async ({ page }, info) => {
    const { requests, entry } = await openOrphans(page, width, theme);
    await expect(entry).toContainText("4");
    await entry.click();
    const build = machine(page, "Build Machine");
    const olderMachine = machine(page, "Older Machine");
    await expect(rows(build)).toHaveCount(3);
    await expect(rows(build).locator(".row-title")).toHaveText(["release-notes", "Unidentified Copy", "triage-helper"]);
    await expect(row(build, "release-notes").locator(".row-sub")).toHaveText("Kept aside by a restore on Nov 14, 2023. Manual Only.");
    await expect(row(build, "triage-helper").locator(".row-sub"))
      .toHaveText("Its skill was deleted from the library; links still serve this copy. Agent Invocable.");
    await expect(row(build, "Unidentified Copy").locator(".skill-orphans-reason"))
      .toHaveText("Can't be imported: its content can't be read as a skill (it contains a symlink).");
    await expect(importButton(row(build, "Unidentified Copy"))).toBeDisabled();
    // Kinds are facts on line 2, not badges; store entries and digests are not shown.
    await expect(pane(page).locator(".skill-orphans-list .status")).toHaveCount(0);
    await expect(pane(page)).not.toContainText(".drift-");
    await expect(pane(page)).not.toContainText(digest.slice(0, 12));
    await expect(olderMachine.locator(".notice")).toHaveText(
      "This machine's runner can't list copies a restore kept aside. Update it to list them here.");
    await expect(row(olderMachine, "legacy-lint").locator(".skill-orphans-reason"))
      .toHaveText("Can't be imported: its content can't be read as a skill.");
    await page.screenshot({ path: info.outputPath(`orphans-list-${width}-${theme}.png`), fullPage: true });
    expect(await noHorizontalOverflow(page)).toBe(true);

    await importButton(row(build, "release-notes")).click();
    const dialog = page.getByRole("dialog", { name: "Import Orphaned Copy" });
    // #1973: the facts, then one notice: the Manual Only setting, in words.
    await expect(dialog.locator(".skill-review-facts dt")).toHaveText(["Machine", "Kept Aside", "Result"]);
    await expect(dialog.locator(".skill-review-facts dd").last()).toHaveText("New skill");
    await expect(dialog.locator(".modal-body > .notice")).toHaveText(
      ["The copy was Manual Only. That setting isn't imported; choose it when you assign the skill."]);
    await expect(dialog).not.toContainText("disable-model-invocation");
    // A new skill's file is Added and every line of it is a + line (#1948); nothing to consent to.
    const file = dialog.locator(".skill-diff-file", { hasText: "SKILL.md" });
    await expect(file.locator(".skill-diff-file-head")).toContainText("Added");
    await expect(file.locator(".skill-diff-counts")).toContainText("+6 −0");
    await expect(file.locator(".diff-line-add")).toHaveCount(6);
    await expect(file.locator(".diff-line-del, .diff-line-ctx")).toHaveCount(0);
    await expect(file.getByText("Group them by area.")).toBeVisible();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`orphans-review-${width}-${theme}.png`) });
    expect(await noHorizontalOverflow(page)).toBe(true);
    await dialog.getByRole("button", { name: "Import as New Skill" }).click();
    await expect(dialog).toBeHidden();
    await expect(rows(build)).toHaveCount(2);

    const menu = await openMenu(build, "Unidentified Copy");
    await expect(menu.getByRole("menuitem")).toHaveText(["Copy Store Entry", "Discard Copy…"]);
    await menu.getByRole("menuitem", { name: "Discard Copy…" }).click();
    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(confirmation.getByRole("heading", { name: "Discard Copy" })).toBeVisible();
    await expect(confirmation).toContainText("The kept-aside copy on");
    await expect(confirmation).toContainText("nothing is deleted");
    await confirmation.getByRole("button", { name: "Discard Copy" }).click();
    await expect(rows(build)).toHaveCount(1);
    await expect(entry).toContainText("2");
    expect(requests).toEqual([
      { url: "preview", body: { kind: "kept_aside", id: keptId } },
      { url: "import", body: { acceptUpdate: false } },
      { url: "discard", body: { kind: "kept_aside", id: unidentifiedId, observedFingerprint: fingerprint, confirmation: "explicit" } },
    ]);
  });
}

test("the title sits 8px above its description; line 2 wraps whole and never splits a date at 1440, 834 or 390", async ({ page }) => {
  await openOrphans(page, 1440, "dark", { query: "&route=/skills/orphans" });
  const build = machine(page, "Build Machine");
  await expect(rows(build)).toHaveCount(3);
  const gap = await pane(page).locator(".skill-orphans-head").evaluate((head) => {
    const title = head.querySelector("h2")!.getBoundingClientRect();
    const summary = head.querySelector("p")!.getBoundingClientRect();
    return { gap: summary.top - title.bottom, margin: getComputedStyle(head.querySelector("h2")!).marginBottom };
  });
  expect(gap).toEqual({ gap: 8, margin: "0px" });
  for (const width of [1440, 834, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["release-notes", "Unidentified Copy", "triage-helper"]) {
      const geometry = await row(build, name).evaluate((element) => {
        const sub = element.querySelector<HTMLElement>(".row-sub")!;
        // The date, when there is one, sits on one line: all of its text boxes share a top.
        const text = sub.firstChild!;
        const at = text.textContent!.search(/[A-Z][a-z]{2}\u00a0\d{1,2},\u00a0\d{4}/);
        let dateTops: number[] = [];
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + text.textContent!.slice(at).search(/\d{4}/) + 4);
          dateTops = [...new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))];
        }
        const box = element.getBoundingClientRect();
        const subBox = sub.getBoundingClientRect();
        return {
          clipped: sub.scrollWidth > sub.clientWidth,
          inside: subBox.bottom <= box.bottom,
          lines: Math.round(subBox.height / parseFloat(getComputedStyle(sub).lineHeight)),
          dateTops: dateTops.length,
          height: box.height,
          token: parseFloat(getComputedStyle(element).getPropertyValue("--row-h-2")),
        };
      });
      // Line 2 is never cut, so every fact stays readable.
      expect(geometry.clipped, `${name}'s line 2 at ${width}`).toBe(false);
      expect(geometry.inside, `${name}'s line 2 at ${width}`).toBe(true);
      if (name === "release-notes") expect(geometry.dateTops, `the date at ${width}`).toBe(1);
      // Only a row whose line 2 wraps grows past the two-line height.
      if (geometry.lines === 1) expect(geometry.height, `${name}'s row at ${width}`).toBe(geometry.token);
      else expect(geometry.height, `${name}'s row at ${width}`).toBeGreaterThan(geometry.token);
    }
    // Every fact is in the text, whole.
    if (width === 1440) await expect(rows(build).locator(".row-sub")).toHaveText([/Manual Only\.$/, /symlink\)\.$/, /Agent Invocable\.$/]);
    await expect(row(build, "triage-helper").locator(".row-sub")).toContainText("Agent Invocable.");
    expect(await noHorizontalOverflow(page)).toBe(true);
  }
});

test("an unreadable copy's reason is fully visible at 390, and only its row grows", async ({ page }) => {
  await openOrphans(page, 390, "dark", { query: "&route=/skills/orphans" });
  const build = machine(page, "Build Machine");
  const blocked = row(build, "Unidentified Copy");
  const reason = blocked.locator(".skill-orphans-reason");
  await expect(reason).toBeVisible();
  const geometry = await blocked.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const text = element.querySelector(".skill-orphans-reason")!.getBoundingClientRect();
    const sub = element.querySelector<HTMLElement>(".row-sub")!;
    return {
      inside: text.left >= box.left && text.right <= box.right && text.bottom <= box.bottom,
      clipped: sub.scrollWidth > sub.clientWidth,
      height: box.height,
      token: parseFloat(getComputedStyle(element).getPropertyValue("--row-h-2")),
    };
  });
  expect(geometry.inside).toBe(true);
  expect(geometry.clipped).toBe(false);
  expect(geometry.height).toBeGreaterThan(geometry.token);
  // The amber reason is what the disabled Import… points to.
  const describedBy = await importButton(blocked).getAttribute("aria-describedby");
  expect(describedBy).toBe(await reason.getAttribute("id"));
  const color = await reason.evaluate((element) => getComputedStyle(element).color);
  const amber = await reason.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--amber)";
    element.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(color).toBe(amber);
});

test("Copy Store Entry copies a kept-aside copy's entry name; a deleted skill's copy has none", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openOrphans(page, 1440, "dark", { query: "&route=/skills/orphans" });
  const build = machine(page, "Build Machine");
  let menu = await openMenu(build, "release-notes");
  await menu.getByRole("menuitem", { name: "Copy Store Entry" }).click();
  await expect(menu).toBeHidden();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`.drift-${keptId}`);
  menu = await openMenu(build, "triage-helper");
  await expect(menu.getByRole("menuitem")).toHaveText(["Discard Copy…"]);
});

test("an offline machine's copies say when they can be resolved, and its header has no Sync Now", async ({ page }, info) => {
  await openOrphans(page, 1440, "dark", { query: "&route=/skills/orphans&orphansOffline=1" });
  const olderMachine = machine(page, "Older Machine");
  const phrase = olderMachine.locator(".skill-orphans-meta");
  await expect(phrase).toHaveText("Import or discard when back online");
  await expect(olderMachine.locator(".status")).toHaveText("Offline");
  await expect(olderMachine.getByRole("button", { name: "Sync Now" })).toHaveCount(0);
  await expect(machine(page, "Build Machine").getByRole("button", { name: "Sync Now" })).toBeVisible();
  const menu = await openMenu(olderMachine, "legacy-lint");
  const discard = menu.getByRole("menuitem", { name: "Discard Copy…" });
  await expect(discard).toBeDisabled();
  expect(await discard.getAttribute("aria-describedby")).toBe(await phrase.getAttribute("id"));
  await page.screenshot({ path: info.outputPath("orphans-offline.png"), fullPage: true });
});

test("cancelling Discard Copy… returns focus to the row's ⋯ button, by Cancel and by Escape", async ({ page }) => {
  await openOrphans(page, 1440, "dark", { query: "&route=/skills/orphans" });
  const build = machine(page, "Build Machine");
  const trigger = build.getByRole("button", { name: "More Actions for release-notes" });
  for (const dismiss of ["cancel", "escape"]) {
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Discard Copy…" }).focus();
    await page.keyboard.press("Enter");
    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(confirmation.getByRole("heading", { name: "Discard Copy" })).toBeVisible();
    if (dismiss === "cancel") await confirmation.getByRole("button", { name: "Cancel" }).click();
    else await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(trigger, `focus after ${dismiss}`).toBeFocused();
  }
});

test("an unreadable edited copy of a deleted skill can't be imported, and discarding it says it moves aside first", async ({ page }) => {
  await openOrphans(page, 1440, "dark", { query: "&route=/skills/orphans" });
  const olderMachine = machine(page, "Older Machine");
  await expect(importButton(row(olderMachine, "legacy-lint"))).toBeDisabled();
  const menu = await openMenu(olderMachine, "legacy-lint");
  await menu.getByRole("menuitem", { name: "Discard Copy…" }).click();
  const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(confirmation).toContainText("The edited copy of “legacy-lint”");
  await expect(confirmation).toContainText("appears here as a kept-aside copy");
});

for (const width of [1280, 390]) {
  test(`Discard Copy… in the review opens the list's confirmation and closes the review at ${width}`, async ({ page }) => {
    const { requests, entry } = await openOrphans(page, width, "dark");
    await page.route("**/api/runners/runner-1/orphaned-skill-copies/discard", async (route) => {
      requests.push({ url: "discard", body: route.request().postDataJSON() });
      await route.fulfill({ json: { status: "discarded", state: reported } });
    });
    await entry.click();
    await importButton(row(machine(page, "Build Machine"), "release-notes")).click();
    const dialog = page.getByRole("dialog", { name: "Import Orphaned Copy" });
    await expect(dialog.locator(".skill-diff-file")).toHaveCount(1);
    await expect(dialog.locator(width > 760 ? ".modal-foot > .modal-tertiary" : ".modal-body > .modal-tertiary"))
      .toHaveText("Discard Copy…");
    await dialog.getByRole("button", { name: "Discard Copy…" }).click();
    const confirmation = page.getByRole("dialog", { name: "Discard Copy" });
    await expect(confirmation).toContainText("The kept-aside copy of “release-notes” on Build Machine");
    await expect(confirmation).toContainText("nothing is deleted");
    await confirmation.getByRole("button", { name: "Discard Copy" }).click();
    await expect(dialog).toBeHidden();
    await expect(confirmation).toBeHidden();
    expect(requests).toEqual([
      { url: "preview", body: { kind: "kept_aside", id: keptId } },
      { url: "discard", body: { kind: "kept_aside", id: keptId, observedFingerprint: "7e1d".padEnd(64, "0"),
        observedDigest: "9b2e".padEnd(64, "0"), confirmation: "explicit" } },
    ]);
  });
}

test("resolving the last copy on the pane shows All Resolved, with the way back to the overview", async ({ page }) => {
  const first = { ...current, orphaned: [keptAside] };
  // One current machine: no runner keeps copies it can't report, so the list's entry goes too.
  const { entry } = await openOrphans(page, 1440, "dark", { first, query: "&route=/skills/orphans&orphansSingle=1" });
  await expect(entry).toBeVisible();
  const build = machine(page, "Build Machine");
  const menu = await openMenu(build, "release-notes");
  await menu.getByRole("menuitem", { name: "Discard Copy…" }).click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "Discard Copy" }).click();
  const state = pane(page).locator(".state");
  await expect(state.getByRole("heading", { level: 3 })).toHaveText("All Resolved");
  await expect(state).toContainText("No orphaned copies are left on your machines.");
  await expect(pane(page).locator("section[aria-labelledby]")).toHaveCount(0);
  await expect(entry).toHaveCount(0);
  const back = state.getByRole("button", { name: "Open Library Overview" });
  await expect(back, "focus moves on from the removed row").toBeFocused();
  await back.click();
  await expect(page.locator(".skills-overview")).toBeVisible();
});

test("loading the pane with no copies shows All Resolved, and the list has no Orphaned Copies entry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&history=1&skills=healthy&path=${encodeURIComponent("/skills/orphans")}`);
  const state = pane(page).locator(".state");
  await expect(state.getByRole("heading", { level: 3 })).toHaveText("All Resolved");
  await expect(page.locator(".master-detail-list .row", { hasText: "Orphaned Copies" })).toHaveCount(0);
  // Nothing was resolved here, so focus is left where the page put it.
  await expect(state.getByRole("button", { name: "Open Library Overview" })).not.toBeFocused();
  // /skills, with the same library, has no entry either.
  await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&history=1&skills=healthy&path=${encodeURIComponent("/skills")}`);
  await expect(page.locator(".master-detail-list .row-title").first()).toBeVisible();
  await expect(page.locator(".master-detail-list .row", { hasText: "Orphaned Copies" })).toHaveCount(0);
});

/** #2289: a deleted skill's copy says when the library deleted it, and a copy whose deletion was not
 * recorded (an older control plane, or a deletion before the record) keeps the undated text. */
const skillDeletedAt = Date.UTC(2026, 8, 3, 12, 0);
const deletions = {
  ...current,
  orphaned: [
    { kind: "deleted_skill", name: "triage-helper", digest, variant: "agent", observedDigest: "5d3a".padEnd(64, "0"), held: true, skillDeletedAt },
    { kind: "deleted_skill", name: "old-triage", digest, variant: "manual", observedDigest: "6e4b".padEnd(64, "0"), held: false },
  ] as Array<Record<string, unknown>>,
};

async function previewDeleted(page: Page, name: string) {
  await page.route("**/api/runners/runner-1/orphaned-skill-copies/preview", (route) => route.fulfill({ json: {
    previewId: "review-1",
    copy: { ...(route.request().postDataJSON() as object), observedDigest: "5d3a".padEnd(64, "0") },
    name,
    files: [{ path: "SKILL.md", content: `---\nname: ${name}\n---\n\nTriage new issues.\n`, encoding: "utf8" }],
    previousFiles: [],
    digest: "5d3a".padEnd(64, "0"), importable: true, disposition: "new", assignmentCount: 0,
  } }));
}

for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
  test(`a deleted skill's copy shows its deletion date in the row and the review, only when recorded, at ${width} in ${theme}`, async ({ page }, info) => {
    const { entry } = await openOrphans(page, width, theme, { first: deletions });
    await entry.click();
    const build = machine(page, "Build Machine");
    await expect(rows(build).locator(".row-title")).toHaveText(["triage-helper", "old-triage"]);
    await expect(row(build, "triage-helper").locator(".row-sub"))
      .toHaveText("Its skill was deleted from the library on Sep 3, 2026; links still serve this copy. Agent Invocable.");
    // The date's spaces never break, as in "Kept aside by a restore on <date>".
    expect(await row(build, "triage-helper").locator(".row-sub").evaluate((sub) => sub.textContent))
      .toContain("on Sep 3, 2026;");
    await expect(row(build, "old-triage").locator(".row-sub"))
      .toHaveText("Its skill was deleted from the library; no link serves it. Manual Only.");
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`deleted-dates-list-${width}-${theme}.png`), fullPage: true });

    const dialog = page.getByRole("dialog", { name: "Import Orphaned Copy" });
    const expected = await page.evaluate((at) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), skillDeletedAt);
    for (const [name, dated] of [["triage-helper", true], ["old-triage", false]] as const) {
      await previewDeleted(page, name);
      await importButton(row(build, name)).click();
      await expect(dialog.locator(".skill-diff-file")).toHaveCount(1);
      await expect(dialog.locator(".skill-review-facts dt"))
        .toHaveText(dated ? ["Machine", "Deleted Skill", "Deleted On", "Result"] : ["Machine", "Deleted Skill", "Result"]);
      await expect(dialog.locator(".skill-review-facts dd"))
        .toHaveText(dated ? ["Build Machine", name, expected, "New skill"] : ["Build Machine", name, "New skill"]);
      const clipped = await dialog.locator(".skill-review-facts dd").evaluateAll((values) =>
        values.filter((value) => value.scrollWidth > value.clientWidth).map((value) => value.textContent));
      expect(clipped, "every fact is whole").toEqual([]);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: info.outputPath(`deleted-dates-review-${dated ? "dated" : "undated"}-${width}-${theme}.png`) });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
    }
  });
}
