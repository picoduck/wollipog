import { waitForSessionPreview } from "./session-readiness.js";
import { expect, test, type Page } from "@playwright/test";

const LONG_BRANCH = "feature/session-alpha-with-a-deliberately-long-branch-name-for-narrow-layout-validation";

async function resetFixture(page: Page, suffix = ""): Promise<void> {
  await page.goto(`/command-inbox-projects-e2e.html?scenario=git-visibility${suffix}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

async function openSession(page: Page, name: string): Promise<void> {
  const back = page.getByRole("button", { name: "Back to Sessions" });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  await waitForSessionPreview(page);
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-bar")).toBeVisible();
}

function gitRegion(page: Page) {
  return page.getByRole("region", { name: "Git" });
}

/** Git Details is a disclosure, closed by default, whose state persists for the rest of the test
 * (#2160). Refresh Git Status is always in the section head. */
async function showGitDetails(page: Page) {
  const toggle = gitRegion(page).getByRole("button", { name: "Git Details" });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("Inbox preview selection does not issue unconsumed Git or forge-summary reads", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  await expect(page.getByRole("button", { name: "Open Session", exact: true })).toBeVisible();
  expect(await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"))).toEqual({
    status: 0,
    summary: 0,
  });

  await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { status: "running" }));
  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const counts = window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha");
    return counts.status > 0 && counts.summary > 0 && counts.status === counts.summary;
  })).toBe(true);
  await showGitDetails(page);
  await expect(gitRegion(page).getByRole("button", { name: "Refresh Git Status" })).toBeEnabled();
});

test("rich Git facts are truthful, accessible, and contained at desktop and narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page);
  await openSession(page, "Alpha Session");

  // The composer no longer carries a Git footer; the pinned summary is the only Git surface.
  await expect(page.locator(".composer-context")).toHaveCount(0);

  // One row per fact: the branch with its folder's kind, then each state that needs attention.
  const git = gitRegion(page);
  const branchRow = git.locator(".ps-row").first();
  await expect(branchRow.locator(".k")).toHaveText(LONG_BRANCH);
  await expect(branchRow.locator(".v")).toHaveText("Worktree");
  await expect(git.locator(".ps-row", { hasText: "Rebase in Progress" })).toBeVisible();
  await expect(git.locator(".ps-row", { hasText: "Conflicts" }).locator(".v")).toHaveText("1");
  await expect(git.locator(".ps-git-headline")).toHaveCount(0);
  await expect(git).not.toContainText("Remote Status May Be Stale");

  await showGitDetails(page);
  const facts = git.locator("dl.facts");
  await expect(facts).toContainText("Linked Worktree");
  await expect(facts).toContainText("/repos/alpha/.agent-worktrees/session-alpha");
  await expect(facts).toContainText("aaaaaaaaaaaa");
  await expect(facts).toContainText("1 conflicted");
  await expect(facts).toContainText("In sync with upstream");
  await expect(facts).toContainText("231 behind origin/main");
  await expect(facts).toContainText("Remote Refs");
  await expect(facts.locator(":scope > div").filter({ hasText: "Remote Refs" }).locator("dd")).toHaveText(/^Updated \d+m ago$/);
  await expect(git).not.toContainText("Fetched");

  const refresh = git.getByRole("button", { name: "Refresh Git Status" });
  await expect(refresh).toHaveAttribute("title", "Refresh Git Status");
  await refresh.focus();
  await expect(refresh).toBeFocused();

  for (const width of [520, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    // Git Details values wrap in full rather than overflow.
    const overflowing = await facts.locator("dd").evaluateAll((values) =>
      values.filter((value) => value.scrollWidth > value.clientWidth + 1).map((value) => value.textContent));
    expect(overflowing).toEqual([]);
  }
});

test("retained forge rows hide outside a repository and restore current provider data", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page);
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setGitSummary("session-alpha", {
      remoteUrl: "https://gitlab.example.test/team/project.git",
      forge: {
        provider: "gitlab",
        host: "gitlab.example.test",
        project: "team/project",
        authenticated: false,
        authenticationError: "Sign in to GitLab.",
        statusError: "GitLab status unavailable.",
      },
    });
  });
  await openSession(page, "Alpha Session");
  const summary = page.getByRole("complementary", { name: "Pinned Summary" });
  await showGitDetails(page);
  const remote = summary.locator("dl.facts dd a", { hasText: "gitlab.example.test" });
  await expect(remote).toBeVisible();
  await expect(summary.getByText("Forge Authentication Needed", { exact: true })).toBeVisible();
  await expect(summary.getByText("Forge Status Unavailable", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.failNextGit("session-alpha", "status", "not a git repository");
  });
  await gitRegion(page).getByRole("button", { name: "Refresh Git Status" }).click();
  await expect(gitRegion(page)).toContainText("Not a Git Repository");
  await expect(remote).toHaveCount(0);
  await expect(summary.getByText("Forge Authentication Needed", { exact: true })).toHaveCount(0);
  await expect(summary.getByText("Forge Status Unavailable", { exact: true })).toHaveCount(0);

  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.setGitSummary("session-alpha", {
      forge: {
        provider: "gitlab",
        host: "gitlab.example.test",
        project: "team/project",
        authenticated: true,
      },
    });
  });
  await gitRegion(page).getByRole("button", { name: "Refresh Git Status" }).click();
  await expect(remote).toBeVisible();
  await expect(summary.getByText("Forge Authentication Needed", { exact: true })).toHaveCount(0);
  await expect(summary.getByText("Forge Status Unavailable", { exact: true })).toHaveCount(0);
});

test("background cadence preserves focused enabled controls and confirmed facts", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-07T12:00:00Z") });
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page);
  await openSession(page, "Alpha Session");
  await showGitDetails(page);
  const git = gitRegion(page);
  const refresh = git.getByRole("button", { name: "Refresh Git Status" });
  await expect(refresh).toBeEnabled();
  const baseline = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"));
  await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextGit("session-alpha", "status"));
  await refresh.focus();
  await expect(refresh).toBeFocused();

  await page.clock.fastForward(60_001);
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"))).toEqual({
      status: baseline.status + 1,
      summary: baseline.summary,
    });
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
  await expect(git).not.toContainText("Updating Git Status");
  await expect(git).toContainText(LONG_BRANCH);

  await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredGit("session-alpha", "status"));
  await expect(refresh).toBeFocused();
});

test("linked and primary sessions never exchange facts when an old response settles late", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page, "&deferGit=alpha");
  // Git Details only exists once facts do; the persisted preference opens it when they arrive.
  await page.evaluate(() => localStorage.setItem("wollipog.pinned.git.open", "1"));
  await openSession(page, "Alpha Session");
  await expect(gitRegion(page)).toContainText("Loading Git Status");
  await expect(gitRegion(page).getByRole("button", { name: "Git Details" })).toHaveCount(0);

  await openSession(page, "No Project Session");
  await expect(gitRegion(page)).toContainText("Detached");
  await expect(gitRegion(page)).toContainText("Primary Checkout");
  await expect(gitRegion(page)).toContainText("bbbbbbbbbbbb");
  await expect(gitRegion(page).locator("dl.facts > div", { hasText: "Upstream" }).locator("dd")).toHaveText("None");
  await expect(gitRegion(page)).not.toContainText(LONG_BRANCH);
  await expect(page.getByTitle("Open Review")).toHaveCount(0);

  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.settleDeferredGit("session-alpha", "status");
    fixture.settleDeferredGit("session-alpha", "summary");
  });
  await expect(gitRegion(page)).toContainText("bbbbbbbbbbbb");
  await expect(gitRegion(page)).not.toContainText(LONG_BRANCH);

  await openSession(page, "Alpha Session");
  await expect(gitRegion(page)).toContainText(LONG_BRANCH);
  await expect(gitRegion(page)).toContainText("Linked Worktree");
  await expect(gitRegion(page)).not.toContainText("bbbbbbbbbbbb");
  await expect(page.getByTitle("Open Review").first()).toBeVisible();
});

test("legacy runners keep legacy branch rendering and suppress enhanced labels", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(75));
  await openSession(page, "Alpha Session");

  // Legacy runners have no composer Git footer either; the Git section's branch row is the surface,
  // without the repository facts a legacy runner cannot report.
  await expect(gitRegion(page).locator(".ps-row").first().locator(".k")).toHaveText(LONG_BRANCH);
  await expect(page.locator(".composer-context")).toHaveCount(0);
  await expect(gitRegion(page).getByRole("button", { name: "Git Details" })).toHaveCount(0);
  await expect(page.getByText("In sync with upstream")).toHaveCount(0);
  await expect(page.getByText("Rebase in Progress")).toHaveCount(0);
});

test("explicit refresh preserves facts while updating, reports failure, and never implies fetch", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page);
  await openSession(page, "Alpha Session");
  await showGitDetails(page);
  const git = gitRegion(page);
  const refresh = git.getByRole("button", { name: "Refresh Git Status" });
  await expect(git).toContainText(LONG_BRANCH);

  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.deferNextGit("session-alpha", "status");
    fixture.deferNextGit("session-alpha", "summary");
  });
  await refresh.click();
  await expect(git).toHaveAttribute("aria-busy", "true");
  await expect(git).toContainText("Updating Git Status");
  await expect(git).toContainText(LONG_BRANCH);
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.settleDeferredGit("session-alpha", "status");
    fixture.settleDeferredGit("session-alpha", "summary");
  });
  await expect(git).toHaveAttribute("aria-busy", "false");

  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.failNextGit("session-alpha", "status");
    fixture.failNextGit("session-alpha", "summary");
  });
  await refresh.click();
  await expect(git).toContainText("Refresh Failed");
  await expect(git).toContainText(LONG_BRANCH);
  await expect(git).not.toContainText("Fetched");

  const counts = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"));
  expect(counts.status).toBeGreaterThanOrEqual(3);
  expect(counts.summary).toBeGreaterThanOrEqual(3);
});

test("turn boundaries and dashboard reconnect refresh both reads while active turns stay quiet", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page);
  await openSession(page, "Alpha Session");
  await showGitDetails(page);
  await expect(gitRegion(page)).toHaveAttribute("aria-busy", "false");
  const baseline = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"));

  await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { status: "running" }));
  await expect(page.locator(".session-bar .session-status-button"))
    .toHaveAccessibleName("Session Status: Running");
  await expect.poll(async () => {
    const before = await page.evaluate(() =>
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const after = await page.evaluate(() =>
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"));
    return { before, after };
  }).toEqual({ before: baseline, after: baseline });

  const refresh = gitRegion(page).getByRole("button", { name: "Refresh Git Status" });
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.deferNextGit("session-alpha", "status");
    fixture.deferNextGit("session-alpha", "summary");
  });
  await refresh.focus();
  await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { status: "idle" }));
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"))).toEqual({
      status: baseline.status + 1,
      summary: baseline.summary + 1,
    });
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.settleDeferredGit("session-alpha", "status");
    fixture.settleDeferredGit("session-alpha", "summary");
  });

  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.deferNextGit("session-alpha", "status");
    fixture.deferNextGit("session-alpha", "summary");
    fixture.pushSnapshot();
  });
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.gitRequestCounts("session-alpha"))).toEqual({
      status: baseline.status + 2,
      summary: baseline.summary + 2,
    });
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.settleDeferredGit("session-alpha", "status");
    fixture.settleDeferredGit("session-alpha", "summary");
  });
});

test("offline, unavailable, and not-repository states are explicit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await resetFixture(page);
  await openSession(page, "Alpha Session");
  const prLink = page.getByRole("link", { name: "Alpha Visibility PR" });
  await expect(prLink).toHaveAttribute("href", "https://github.com/example/wollipog/pull/318");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  await expect(gitRegion(page)).toContainText("Git Unavailable While Disconnected");
  await expect(gitRegion(page)).not.toContainText(LONG_BRANCH);
  await expect(prLink).toBeVisible();

  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.setRunnerStatus("online");
    fixture.setGitUnavailable("session-alpha", true);
  });
  await openSession(page, "No Project Session");
  await openSession(page, "Alpha Session");
  await expect(gitRegion(page)).toContainText("Git Status Unavailable");

  await openSession(page, "No Project Session");
  await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setGitUnavailable("session-alpha", false));
  await openSession(page, "Alpha Session");
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.failNextGit("session-alpha", "status", "not a git repository");
    fixture.failNextGit("session-alpha", "summary", "not a git repository");
  });
  await showGitDetails(page);
  await gitRegion(page).getByRole("button", { name: "Refresh Git Status" }).click();
  await expect(gitRegion(page)).toContainText("Not a Git Repository");
});
