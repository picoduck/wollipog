import { expect, test, type Page } from "@playwright/test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { waitForSessionPreview } from "./session-readiness.js";

/**
 * #1280 and #4249: a deliberate wait reads as Waiting beside the lifecycle on every surface, and
 * Stalled only when the control plane reports its liveness contract broken. The Sessions list, the
 * Board and the detail header all read the same classification.
 *
 * CAPTURE_SESSION_WAITS=after (or =before, against the base branch's web sources, which skips the
 * assertions) writes the UI evidence to .evidence/1280/.
 */

const MINUTE = 60_000;
const CAPTURE = process.env.CAPTURE_SESSION_WAITS;
const ASSERT = CAPTURE !== "before";

async function theme(page: Page, colorScheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme });
  // The isolated fixtures do not mount the application's theme controller.
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-theme", value);
    document.documentElement.style.colorScheme = value;
  }, colorScheme);
}

async function capture(page: Page, name: string) {
  if (!CAPTURE) return;
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `.evidence/1280/${CAPTURE}-${name}.png`, fullPage: true, animations: "disabled" });
}

/** Healthy and broken waits on the Board fixture's sessions, as a v298 control plane sends them. */
async function applyBoardWaits(page: Page) {
  await page.evaluate((minute) => {
    const now = Date.now();
    const update = (window as unknown as { __updateSession(id: string, change: object): void }).__updateSession;
    // Its children are all working, so no child request outranks the parent's own wait.
    for (const id of ["s-child-601", "s-child-603"]) update(id, { status: "running", column: "running", pendingApproval: null });
    // The #1280 case: an Orchestrator deliberately waiting on its running child, long past ten minutes.
    update("s-orchestrator", { status: "running", lastEventAt: now - 40 * minute, updatedAt: now - 40 * minute,
      waits: [{ waitId: "wait_orchestrator1", kind: "wait_session", target: { kind: "session", child: true },
        since: now - 40 * minute, deadlineAt: now + 20 * minute, health: "healthy" }] });
    // A child waiting on its pull request's CI.
    update("s-child-600", { waits: [{ waitId: "wait_childpullreq", kind: "wait_pull_request",
      target: { kind: "pull_request", repository: "picoduck/wollipog", number: 600 },
      since: now - 25 * minute, deadlineAt: now + 2 * 60 * minute, health: "healthy" }] });
    // A wait whose polls stopped: its contract broke.
    update("s-running", { status: "running", waits: [{ waitId: "wait_runningstuck", kind: "wait_pull_request",
      target: { kind: "pull_request", repository: "picoduck/wollipog", number: 601 },
      since: now - 50 * minute, deadlineAt: now + 60 * minute, health: "stalled", stalledReason: "progress_lost",
      stalledSince: now - 5 * minute }] });
  }, MINUTE);
}

for (const width of [1280, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`the Board and Sessions list show deliberate waits at ${width}px in ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/sessions-board-e2e.html?path=/board&threads=1");
      await theme(page, colorScheme);
      await expect(page.locator(".board .card").first()).toBeVisible();
      await applyBoardWaits(page);
      if (width === 390) await page.getByRole("tab", { name: /^Running,/ }).click();
      const card = (title: string) => page.locator(".board .card").filter({ hasText: title });
      if (ASSERT) {
        await expect(card("Ship the usage and cost overhaul").getByLabel("Status: Waiting on Children")).toBeVisible();
        await expect(card("Ship the usage and cost overhaul").getByLabel("Status: Running")).toBeVisible();
        await expect(card("#600: Add the usage table").getByLabel("Status: Waiting on Pull Request")).toBeVisible();
        await expect(card("Running Session").getByLabel("Status: Wait Stalled")).toBeVisible();
        await expect(card("Running Session").locator(".status").filter({ hasText: /^Wait Stalled$/ })).toHaveClass(/t-warning/);
        await expect(page.locator(".board .card .status").filter({ hasText: /^Stalled$/ })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await capture(page, `board-${width}-${colorScheme}`);

      await page.goto("/sessions-board-e2e.html?path=/&threads=1");
      await theme(page, colorScheme);
      await expect(page.locator(".inbox-row").first()).toBeVisible();
      await applyBoardWaits(page);
      const row = (title: string) => page.locator(".inbox-row").filter({ hasText: title }).first();
      if (ASSERT) {
        await expect(row("Ship the usage and cost overhaul").getByLabel("Status: Waiting on Children")).toBeVisible();
        await expect(row("Running Session").getByLabel("Status: Wait Stalled")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await capture(page, `list-${width}-${colorScheme}`);
    });

    test(`the detail header shows a deliberate wait and a parked merge-queue watch at ${width}px in ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
      await theme(page, colorScheme);
      await page.evaluate((minute) => {
        const now = Date.now();
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          status: "running", pendingApproval: null, role: "orchestrator",
          waits: [{ waitId: "wait_alphachild01", kind: "wait_session", target: { kind: "session", child: true },
            since: now - 30 * minute, deadlineAt: now + 30 * minute, health: "healthy" }],
        } as never);
      }, MINUTE);
      const inbox = page.locator(".inbox-row").filter({ hasText: "Alpha Session" });
      if (ASSERT) await expect(inbox.getByLabel("Status: Waiting on Children")).toBeVisible();
      await inbox.click();
      await waitForSessionPreview(page);
      const expand = page.getByRole("button", { name: "Open Session", exact: true });
      if (await expand.isVisible()) await expand.click();
      const status = page.locator(".session-bar .session-status-button");
      if (ASSERT) await expect(status).toHaveAccessibleName("Session Status: Running, Waiting on Children");
      await capture(page, `header-waiting-${width}-${colorScheme}`);

      if (ASSERT) {
        await status.click();
        const dialog = page.getByRole("dialog", { name: "Session Status" });
        await expect(dialog).toContainText("deliberately waiting on a child session");
        await page.keyboard.press("Escape");
      }

      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          status: "idle", waits: undefined, role: undefined,
          pullRequestWatch: { watchId: "prw_alpha", repository: "picoduck/wollipog", number: 4071, headSha: "a".repeat(40),
            state: "watching", since: Date.now() - 600_000, continuation: "none" },
        } as never);
      });
      if (ASSERT) await expect(status).toHaveAccessibleName("Session Status: Awaiting Prompt, Waiting on Merge Queue");
      await capture(page, `header-parked-${width}-${colorScheme}`);

      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          status: "running", pullRequestWatch: undefined,
          waits: [{ waitId: "wait_alphastuck01", kind: "wait_session", target: { kind: "session", child: true },
            since: Date.now() - 1_800_000, deadlineAt: Date.now() + 1_800_000, health: "stalled",
            stalledReason: "target_missing", stalledSince: Date.now() - 60_000 }],
        } as never);
      });
      if (ASSERT) {
        await expect(status).toHaveAccessibleName("Session Status: Running, Wait Stalled");
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await capture(page, `header-stalled-${width}-${colorScheme}`);
    });
  }
}

/** The inbox fixture's Alpha Session, opened to its detail. */
async function openAlpha(page: Page, patch: object) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
  await theme(page, "light");
  await page.evaluate(({ patch, protocol }) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(protocol);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { pendingApproval: null, ...patch } as never);
  }, { patch, protocol: PROTOCOL_VERSION });
  await page.locator(".inbox-row").filter({ hasText: "Alpha Session" }).click();
  await waitForSessionPreview(page);
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  return page.locator(".session-bar .session-status-button");
}

for (const [reason, sentence] of [
  ["progress_lost", "stopped making progress: its polls stopped succeeding"],
  ["deadline_passed", "is still running past its own timeout"],
] as const) {
  test(`Session Status names the part of a stalled wait's contract that broke: ${reason}`, async ({ page }) => {
    const status = await openAlpha(page, {
      status: "running", role: "orchestrator",
      waits: [{ waitId: "wait_alphastuck02", kind: "wait_pull_request",
        target: { kind: "pull_request", repository: "picoduck/wollipog", number: 4253 },
        since: Date.now() - 3_600_000, deadlineAt: Date.now() - 120_000, health: "stalled", stalledReason: reason,
        stalledSince: Date.now() - 60_000 }],
    });
    await status.click();
    const dialog = page.getByRole("dialog", { name: "Session Status" });
    if (ASSERT) await expect(dialog).toContainText(`The wait on pull request picoduck/wollipog#4253 ${sentence}.`);
    else await expect(dialog).toBeVisible();
    await capture(page, `popover-stalled-${reason}-1280-light`);
  });
}

for (const [state, label] of [["wake_pending", "Merge Queue Wake Pending"], ["lost", "Merge Queue Watch Lost"]] as const) {
  test(`a parked watch's ${label} reads in the header and the row`, async ({ page }) => {
    const watch = { watchId: "prw_alpha2", repository: "picoduck/wollipog", number: 4071, headSha: "a".repeat(40),
      since: Date.now() - 1_800_000, ...(state === "lost"
        ? { state: "lost", reason: "the runner could not read GitHub for half an hour", continuation: "none" }
        : { state: "fired", outcome: "merged", endedAt: Date.now() - 30_000, continuation: "held" }) };
    const status = await openAlpha(page, { status: "idle", pullRequestWatch: watch });
    if (ASSERT) await expect(status).toHaveAccessibleName(`Session Status: Awaiting Prompt, ${label}`);
    else await expect(status).toBeVisible();
    await capture(page, `header-${state}-1280-light`);

    await page.goto("/sessions-board-e2e.html?path=/&threads=1");
    await theme(page, "light");
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    await page.evaluate((change) => {
      (window as unknown as { __updateSession(id: string, change: object): void }).__updateSession("s-review", change);
    }, { status: "idle", pullRequestWatch: watch });
    const row = page.locator(".inbox-row").filter({ hasText: "Review Session" }).first();
    if (ASSERT) await expect(row.getByLabel(`Status: ${label}`)).toBeVisible();
    await capture(page, `list-${state}-1280-light`);
  });
}

test("a background job its runner still lists reads Running past an hour, and a broken contract still reads Unverified", async ({ page }) => {
  const now = Date.now();
  const job = { parentTurnId: "turn-1", runnerId: "runner-main", workspaceId: null, context: { kind: "native" },
    launchType: "shell", sourcePresent: true, lastObservedAt: now - 30_000 };
  const status = await openAlpha(page, {
    driver: "claude-code", status: "idle", backgroundWorkState: "running", backgroundWorkTracking: "managed",
    backgroundJobsAvailable: true, backgroundJobsTruncated: false,
    backgroundJobs: [
      // A CI watch listed for two hours: past the control plane's one-hour mark.
      { ...job, id: "job-ci-watch-a1f3c9", registeredAt: now - 2 * 3_600_000, stalledSince: now - 3_600_000 },
      // A job the runner stopped listing without a result: its contract broke.
      { ...job, id: "job-dropped-7be210", registeredAt: now - 600_000, sourcePresent: false },
    ],
  });
  await status.click();
  await page.getByRole("dialog", { name: "Session Status" }).getByRole("button", { name: "Open Background Work" }).click();
  const panel = page.locator('#right-panel[data-mode="background"]');
  await expect(panel).toBeVisible();
  if (ASSERT) {
    await expect(panel.locator(".status").filter({ hasText: /^Stalled$/ })).toHaveCount(0);
    await expect(panel.locator(".status").filter({ hasText: /^Running$/ }).first()).toBeVisible();
    await expect(panel.locator(".status").filter({ hasText: /^Unverified$/ }).first()).toBeVisible();
  }
  await capture(page, "background-jobs-1280-light");
});

test("a phone Board parent keeps only its family dots beside any secondary badge, as before (#2222)", async ({ page }) => {
  // The fixture's own family, with children awaiting input: a request, not a wait, is the secondary.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/sessions-board-e2e.html?path=/board&threads=1");
  await theme(page, "light");
  await page.getByRole("tab", { name: /^Running,/ }).click();
  const parent = page.locator(".board .card").filter({ hasText: "Ship the usage and cost overhaul" });
  await expect(parent).toBeVisible();
  if (ASSERT) {
    await expect(parent.getByLabel("Status: Needs Your Input")).toBeVisible();
    await expect(parent.locator(".inbox-thread-family")).toHaveClass(/dots-only/);
    await expect(parent.getByRole("img", { name: /4 Children/ })).toBeVisible();
  }
  await capture(page, "board-family-request-390-light");
});
