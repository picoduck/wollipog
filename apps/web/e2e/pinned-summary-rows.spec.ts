import { expect, test, type Locator, type Page } from "@playwright/test";

// These cases exercise the explicitly enabled privacy mode. Default-off behavior has separate coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});
import { dialogMotionSettled } from "./dialog-motion.js";

// The Pinned Summary's contents (#2160): four sections of one-line rows that state each fact once.
// The fixture's session is a linked worktree mid-rebase, with an account chosen automatically, an
// open pull request with failing checks, and a provider that cannot track detached work.

const FIXTURE = "/command-inbox-projects-e2e.html?fullShell=1&scenario=pinned-summary&psActivity=1";
const LONG_BRANCH = "feature/session-alpha-with-a-deliberately-long-branch-name-for-narrow-layout-validation";

async function openSession(page: Page, width: number, storage: Record<string, string> = {}, fixture = FIXTURE) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript((values) => {
    // Seed storage on the first document only, so a reload inside a test keeps what the app wrote.
    if (sessionStorage.getItem("pinned-summary-seeded")) return;
    sessionStorage.setItem("pinned-summary-seeded", "1");
    localStorage.clear();
    localStorage.setItem("wollipog.hide-account-emails", "true");
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(fixture);
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".md table")).toBeVisible();
}

const toggle = (page: Page) => page.getByRole("button", { name: "Pinned Summary", exact: true });
const docked = (page: Page) => page.locator('aside.ps[aria-label="Pinned Summary"]');
const gitSection = (scope: Locator) => scope.getByRole("region", { name: "Git" });
/** The row whose label reads exactly `label`. */
const row = (scope: Locator, label: string) =>
  scope.locator(".ps-row").filter({ has: scope.page().locator(":scope > .k", { hasText: new RegExp(`^${label.replace(/[/.]/g, "\\$&")}$`) }) });

async function openSheet(page: Page): Promise<Locator> {
  await toggle(page).click();
  const sheet = page.getByRole("dialog", { name: "Pinned Summary" });
  await expect(sheet).toBeVisible();
  await dialogMotionSettled(page);
  return sheet;
}

// #2277: the Machine row names the machine as the session bar does (runnerDisplay's name) and keeps
// the hostname or SSH target in its tooltip.
for (const machine of [
  { kind: "local", query: "&machineName=Studio%20Mac", value: "Studio Mac", title: "Local machine: fixture-runner" },
  { kind: "remote", query: "&machineName=Build%20Box&remoteMachine=1", value: "Build Box", title: "Remote machine: pat@build.example.com" },
]) {
  test(`a named ${machine.kind} machine reads its name in the Machine row, its technical identity in the tooltip`, async ({ page }) => {
    await openSession(page, 1440, { "wollipog.pinned.open": "1" }, `${FIXTURE}${machine.query}`);
    const machineRow = row(docked(page), "Machine");
    await expect(machineRow.locator(".v")).toHaveText(machine.value);
    await expect(machineRow).toHaveAttribute("title", machine.title);
  });
}

test("sections and rows read in Title Case, with values in sentence case", async ({ page }) => {
  await openSession(page, 1440, { "wollipog.pinned.open": "1" });
  const aside = docked(page);
  await expect(gitSection(aside).getByText(LONG_BRANCH)).toBeVisible();
  await expect(aside.locator(".ps-head > h3")).toHaveText(["Session", "Environment", "Git", "Activity"]);
  await expect(aside.locator(".ps-row > .k").filter({ hasNotText: /\// })).toHaveText([
    "Agent", "Account", "Updated", "Background Work",
    "Machine", "Folder",
    "Rebase in Progress", "Conflicts", "Changes", "Commit or Push", "Alpha Visibility PR", "Checks",
  ]);
  await expect(row(aside, "Background Work").locator(".v")).toHaveText("Not Tracked");
  await expect(row(aside, "Checks").locator(".v")).toHaveText("2 failing");
  await expect(row(aside, "Alpha Visibility PR").locator(".v")).toHaveText("Open");
  await expect(aside.locator(".disclosure-trigger > .k")).toHaveText(["Git Details", "Plan", "Files", "Tools"]);
  // The title row, the Workspace row and the disabled "+" are gone.
  await expect(aside.getByText("Alpha Session", { exact: true })).toHaveCount(0);
  await expect(row(aside, "Workspace")).toHaveCount(0);
  await expect(aside.locator("button:disabled", { hasText: "+" })).toHaveCount(0);
});

test("in a 280px summary the labels keep their width and a long branch truncates beside Worktree", async ({ page }) => {
  await openSession(page, 1440, { "wollipog.pinned.open": "1", "wollipog.pinned.git.open": "1" });
  const aside = docked(page);
  expect(Math.abs((await aside.boundingBox())!.width - 280)).toBeLessThanOrEqual(0.5);
  const git = gitSection(aside);

  // The branch is the long part, so it truncates and "Worktree" stays whole.
  const branch = git.locator(".ps-row.long-k").first();
  await expect(branch.locator(".k")).toHaveText(LONG_BRANCH);
  const branchGeometry = await branch.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".k")!;
    const value = element.querySelector<HTMLElement>(".v")!;
    return {
      labelTruncated: label.scrollWidth > label.clientWidth,
      labelEllipsis: getComputedStyle(label).textOverflow,
      valueWhole: value.scrollWidth <= value.clientWidth,
      value: value.textContent,
      rowRight: element.getBoundingClientRect().right,
      valueRight: value.getBoundingClientRect().right,
    };
  });
  expect(branchGeometry).toMatchObject({ labelTruncated: true, labelEllipsis: "ellipsis", valueWhole: true, value: "Worktree" });
  expect(branchGeometry.valueRight).toBeLessThanOrEqual(branchGeometry.rowRight);

  // Every row label is whole; values truncate instead.
  const truncatedLabels = await aside.locator(".ps-row:not(.long-k) > .k").evaluateAll((labels) =>
    labels.filter((label) => label.scrollWidth > label.clientWidth + 0.5).map((label) => label.textContent));
  expect(truncatedLabels).toEqual([]);

  // Git Details: the shared disclosure chevron, and a facts list whose terms and values are whole.
  const trigger = git.getByRole("button", { name: "Git Details" });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger.locator("svg.disclosure-chevron")).toBeVisible();
  const facts = git.locator("dl.facts");
  await expect(facts.locator("dt")).toContainText(["Linked Worktree", "Upstream", "Remote"]);
  const factGeometry = await facts.evaluate((list) =>
    [...list.querySelectorAll<HTMLElement>("dt, dd")].map((cell) => ({
      text: cell.textContent,
      clipped: cell.scrollWidth > cell.clientWidth + 0.5,
      ellipsis: getComputedStyle(cell).textOverflow === "ellipsis",
      singleLine: getComputedStyle(cell).whiteSpace === "nowrap",
    })));
  for (const cell of factGeometry) {
    expect(cell, `${cell.text} is shown in full`).toMatchObject({ clipped: false, ellipsis: false, singleLine: false });
  }
  const worktree = facts.locator("dd").filter({ hasText: "/repos/alpha/.agent-worktrees/session-alpha" });
  expect((await worktree.boundingBox())!.height, "the path wraps rather than truncates").toBeGreaterThan(20);

  // One disclosure recipe and no text glyphs or leading separators anywhere in the summary.
  await expect(aside.locator(".ps-git-toggle, .ps-accordion-head, .chev, .ps-plus")).toHaveCount(0);
  const rowStarts = await aside.locator(".ps-row").evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).innerText.trim()));
  for (const text of rowStarts) expect(text.startsWith("·"), text).toBe(false);
  expect(await aside.evaluate((element) => /[▸▾○◐●]/u.test(element.textContent ?? ""))).toBe(false);
});

test("Activity rows are disclosures with counts; plan steps are icons and file and tool rows are 12px", async ({ page }) => {
  await openSession(page, 1440, { "wollipog.pinned.open": "1" });
  const aside = docked(page);
  const activity = aside.getByRole("region", { name: "Activity" });
  for (const [label, count] of [["Plan", "3"], ["Files", "2"], ["Tools", "2"]] as const) {
    const trigger = activity.getByRole("button", { name: new RegExp(`^${label}`) });
    await expect(trigger.locator(".ps-count")).toHaveText(count);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }
  const plan = activity.locator(".disclosure", { has: page.getByRole("button", { name: /^Plan/ }) });
  await expect(plan.locator(".ps-item svg")).toHaveCount(3);
  await expect(plan.locator(".ps-item")).toHaveText([
    "Read the summary's facts", "Rebuild the rows", "Capture the evidence",
  ]);
  const sizes = await activity.locator(".ps-item").evaluateAll((items) =>
    items.map((item) => getComputedStyle(item).fontSize));
  expect(new Set(sizes)).toEqual(new Set(["12px"]));
  await expect(activity.getByRole("button", { name: "PinnedSummary.tsx" })).toBeVisible();
});

test("the summary scrolls on its own and its last row has 24px below it at 1440px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  await openSession(page, 1440, { "wollipog.pinned.open": "1", "wollipog.pinned.git.open": "1" });
  await page.setViewportSize({ width: 1440, height: 640 });
  const aside = docked(page);
  for (const label of ["Plan", "Files", "Tools"]) await aside.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  const geometry = await aside.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const body = element.querySelector(".ps-body")!;
    const last = body.lastElementChild!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      scrolls: element.scrollHeight > element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      below: box.bottom - last.bottom,
      readerScrollTop: document.querySelector<HTMLElement>(".detail-scroll")!.scrollTop,
    };
  });
  expect(geometry.scrolls).toBe(true);
  expect(geometry.overflowY).toBe("auto");
  expect(geometry.below).toBeGreaterThanOrEqual(23.5);
});

test("at 390px the sheet's last row has 24px below it and the sheet scrolls on its own", async ({ page }) => {
  await openSession(page, 390, { "wollipog.pinned.git.open": "1" });
  const sheet = await openSheet(page);
  for (const label of ["Plan", "Files", "Tools"]) await sheet.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  const geometry = await sheet.evaluate((dialog) => {
    const body = dialog.querySelector<HTMLElement>(".ps-body")!;
    let scroller: HTMLElement | null = body;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    scroller!.scrollTop = scroller!.scrollHeight;
    const last = body.lastElementChild!.getBoundingClientRect();
    const box = scroller!.getBoundingClientRect();
    return { scrolls: scroller!.scrollHeight > scroller!.clientHeight, inSheet: dialog.contains(scroller), below: box.bottom - last.bottom };
  });
  expect(geometry.inSheet).toBe(true);
  expect(geometry.scrolls).toBe(true);
  expect(geometry.below).toBeGreaterThanOrEqual(23.5);
});

test.describe("with a coarse pointer at 390px", () => {
  test.use({ hasTouch: true });

  test("the Account row's reveal control has a 44px target and the account is masked until revealed (#1665)", async ({ page }) => {
    await openSession(page, 390);
    // The session bar carries no account at all.
    await expect(page.locator(".session-bar").locator(".pid, .pid-toggle")).toHaveCount(0);
    let sheet = await openSheet(page);
    const account = row(sheet, "Account");
    await expect(account).toContainText("Email Hidden");
    await expect(account.locator(".ps-note")).toHaveText("Chosen Automatically");
    expect(await sheet.evaluate((dialog) => dialog.innerHTML.includes("example.com")), "masked means absent").toBe(false);
    const reveal = account.getByRole("button", { name: "Show Account Email" });
    const target = await reveal.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      // Every point of the centered 44×44 square (1px inside its edge) reaches the control.
      const probes: Array<[number, number]> = [];
      for (const dx of [-21.5, 0, 21.5]) for (const dy of [-21.5, 0, 21.5]) probes.push([cx + dx, cy + dy]);
      return {
        size: { width: box.width, height: box.height },
        misses: probes.filter(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return !(hit === button || button.contains(hit));
        }),
      };
    });
    expect(target.misses).toEqual([]);
    await reveal.tap();
    await expect(account).toContainText("pat.example@example.com");
    await expect(account.getByRole("button", { name: "Hide Account Email" })).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: /Alpha Session/ }).first().click();
    sheet = await openSheet(page);
    await expect(row(sheet, "Account")).toContainText("Email Hidden");
    expect(await sheet.evaluate((dialog) => dialog.innerHTML.includes("example.com")), "masked again after reload").toBe(false);
  });

  for (const target of [
    { label: "Changes", panel: "Review" },
    { label: "Background Work", panel: "Background Work" },
    { label: "PinnedSummary.tsx", panel: "Files", within: "Files" },
  ]) {
    test(`a ${target.label} row in the phone sheet closes the sheet and opens ${target.panel}`, async ({ page }) => {
      await openSession(page, 390);
      const sheet = await openSheet(page);
      if (target.within) {
        await sheet.getByRole("button", { name: new RegExp(`^${target.within}`) }).tap();
        await sheet.getByRole("button", { name: target.label }).tap();
      } else {
        await row(sheet, target.label).tap();
      }
      await expect(page.getByRole("dialog", { name: "Pinned Summary" })).toHaveCount(0);
      const panel = page.locator("#right-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAccessibleName(target.panel);
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      // Only one overlay is open. The row that held focus closed with the sheet, so focus moves
      // into the panel it opened rather than back to the toggle.
      await page.evaluate(() => new Promise((resolve) => setTimeout(() =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)), 0)));
      await expect(panel.locator(".rp-head button").first()).toBeFocused();
      await panel.getByRole("button", { name: "Close Panel" }).tap();
      await expect(panel).toHaveCount(0);
    });
  }
});
