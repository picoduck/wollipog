import { expect, test, type Page } from "@playwright/test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { waitForSessionPreview } from "./session-readiness.js";

/**
 * #2938: an at-rest Full Control root sits in the Board column its campaign state implies, and its
 * session header shows the campaign state instead of Awaiting Prompt. Campaign Active goes to
 * Running, Campaign Complete and Complete, Needs Cleanup to Done; Campaign Stuck, Waiting for You and
 * a Custom campaign keep Review, where a person's attention is.
 *
 * CAPTURE_CAMPAIGN_BOARD=after (or =before, against the base branch's web sources, which skips the
 * assertions) writes the UI evidence to .evidence/2938/.
 */

const CAPTURE = process.env.CAPTURE_CAMPAIGN_BOARD;
const ASSERT = CAPTURE !== "before";

const ACTIVE = "Campaign Active: Children Working";
const COMPLETE = "Campaign Complete: Every Issue Merged";
const CLEANUP = "Campaign Delivered: Merged Branch Left";
const STUCK = "Campaign Stuck: Unmerged PR, Nothing Running";
const WAITING = "Campaign Waiting: Merge Approval for You";
const CUSTOM = "Custom Campaign: Result to Review";

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
  await page.screenshot({ path: `.evidence/2938/${CAPTURE}-${name}.png`, fullPage: true, animations: "disabled" });
}

const columnTitles = (page: Page, column: string) =>
  page.locator(`.board .column.col-${column} .card .card-title`).allTextContents();

for (const colorScheme of ["light", "dark"] as const) {
  test(`the Board places Full Control roots by campaign state at 1280px in ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/sessions-board-e2e.html?path=/board&campaigns=1");
    await theme(page, colorScheme);
    await expect(page.locator(".board .card").first()).toBeVisible();
    if (ASSERT) {
      await expect.poll(() => columnTitles(page, "running")).toEqual(expect.arrayContaining([ACTIVE, "Running Session"]));
      expect((await columnTitles(page, "done")).sort()).toEqual([CLEANUP, COMPLETE].sort());
      expect((await columnTitles(page, "review")).sort()).toEqual([CUSTOM, STUCK, WAITING].sort());
      expect(await columnTitles(page, "input_required")).toEqual(["Question Session"]);
      // Each card keeps the badge its row shows; Title Case labels with matching accessible names.
      const card = (title: string) => page.locator(".board .card").filter({ hasText: title });
      await expect(card(ACTIVE).getByLabel("Status: Campaign Active", { exact: true })).toHaveText("Campaign Active");
      await expect(card(COMPLETE).getByLabel("Status: Campaign Complete", { exact: true })).toHaveText("Campaign Complete");
      await expect(card(CLEANUP).getByLabel("Status: Complete, Needs Cleanup", { exact: true })).toHaveText("Complete, Needs Cleanup");
      await expect(card(STUCK).getByLabel("Status: Campaign Stuck", { exact: true })).toHaveText("Campaign Stuck");
      await expect(card(CUSTOM).getByLabel("Status: Ready for Review", { exact: true })).toBeVisible();
      await expect(page.locator(".board .column.col-running .column-head .count")).toHaveText("2");
      await expect(page.locator(".board .column.col-done .column-head .count")).toHaveText("2");
      await expect(page.locator(".board .column.col-review .column-head .count")).toHaveText("3");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await capture(page, `board-1280-${colorScheme}`);
  });

  test(`the phone Board places Full Control roots by campaign state in ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/sessions-board-e2e.html?path=/board&campaigns=1");
    await theme(page, colorScheme);
    await expect(page.getByRole("tablist", { name: "Board Columns" })).toBeVisible();
    for (const [tab, column, titles] of [
      ["Running", "running", [ACTIVE, "Running Session"]],
      ["Review", "review", [CUSTOM, STUCK, WAITING]],
      ["Done", "done", [CLEANUP, COMPLETE]],
    ] as const) {
      await page.getByRole("tab", { name: new RegExp(`^${tab},`) }).click();
      if (ASSERT) {
        await expect(page.getByRole("tab", { name: `${tab}, ${titles.length}` })).toHaveAttribute("aria-selected", "true");
        await expect.poll(async () => (await page.locator(".board-phone .card .card-title").allTextContents()).sort())
          .toEqual([...titles].sort());
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await capture(page, `board-390-${colorScheme}-${column}`);
    }
  });
}

/** The inbox fixture's Alpha Session, made an at-rest Orchestrator root, opened to its detail. */
async function openRoot(page: Page, width: number, colorScheme: "light" | "dark", patch: object) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
  await theme(page, colorScheme);
  await page.evaluate(({ patch, protocol }) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(protocol);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status: "idle", pendingApproval: null, role: "orchestrator", updatedAt: Date.now() - 600_000, lastEventAt: Date.now() - 600_000,
      attention: { version: 1, meaningfulAt: Date.now() - 600_000, humanActions: [],
        result: { revision: "alpha-result", at: Date.now() - 600_000, owner: "human" }, acknowledgedRevision: null },
      ...patch,
    } as never);
  }, { patch, protocol: PROTOCOL_VERSION });
  await page.locator(".inbox-row").filter({ hasText: "Alpha Session" }).click();
  await waitForSessionPreview(page);
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  return page.locator(".session-bar .session-status-button");
}

const fullControl = (status: string) => ({ fullControlCampaignStatus: status,
  orchestratorPolicy: { control: { mode: "full_control" } } });

const HEADER_CASES = [
  ["active", fullControl("active"), "Session Status: Campaign Active"],
  ["complete", fullControl("verified_complete"), "Session Status: Campaign Complete"],
  ["cleanup", fullControl("complete_needs_cleanup"), "Session Status: Complete, Needs Cleanup"],
  ["stuck", fullControl("stuck"), "Session Status: Awaiting Prompt, Campaign Stuck and 1 More"],
  ["waiting", { ...fullControl("waiting_human"), campaignRequests: { human: 1, orchestrator: 0, humanRequestTokens: [] } },
    "Session Status: Awaiting Prompt, 1 Child Request"],
] as const;

for (const width of [1280, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const [name, patch, accessibleName] of HEADER_CASES) {
      test(`a Full Control root's header reads its campaign state (${name}) at ${width}px in ${colorScheme}`, async ({ page }) => {
        const status = await openRoot(page, width, colorScheme, patch);
        if (ASSERT) {
          await expect(status).toHaveAccessibleName(accessibleName);
          if (name === "active" || name === "complete" || name === "cleanup") {
            await expect(status).not.toContainText("Awaiting Prompt");
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        } else {
          await expect(status).toBeVisible();
        }
        await capture(page, `header-${name}-${width}-${colorScheme}`);
      });
    }
  }
}

test("the header's Session Status explains the campaign state, never a prompt the person owes", async ({ page }) => {
  const status = await openRoot(page, 1280, "light", fullControl("active"));
  await status.click();
  const dialog = page.getByRole("dialog", { name: "Session Status" });
  if (ASSERT) {
    // This fixture carries no campaign projection, so readiness isn't proven and the line claims none (#2940).
    await expect(dialog).toContainText("This Full Control campaign continues automatically where it can; Campaign Status shows anything it still needs from you.");
    await expect(dialog).not.toContainText("waiting for your next prompt");
  } else {
    await expect(dialog).toBeVisible();
  }
  await capture(page, "popover-active-1280-light");
});

for (const [name, patch, before] of [
  ["Campaign Stuck", { ...fullControl("stuck") }, ["Campaign Stuck", "Awaiting Prompt", "Ready for Review"]],
  ["Completed with Campaign Complete", { ...fullControl("verified_complete"), status: "completed" }, ["Completed", "Campaign Complete"]],
] as const) {
  test(`an open Session Status keeps exactly the current rows as a request replaces ${name}`, async ({ page }) => {
    const status = await openRoot(page, 1280, "light", patch);
    await status.click();
    const rows = page.getByRole("dialog", { name: "Session Status" }).locator(".session-status-row .status");
    await expect.poll(() => rows.allTextContents()).toEqual(before);
    // A question for the person arrives while the popover stays open.
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        pendingApproval: { requestId: "campaign-question", kind: "question", title: "Which release?", options: [],
          questions: [{ id: "release", question: "Which release?", options: [{ label: "Now" }, { label: "Later" }] }] },
        attention: { version: 1, meaningfulAt: Date.now(), humanActions: [{ requestId: "campaign-question", rank: 3, requestedAt: Date.now() }],
          result: null, acknowledgedRevision: null },
      } as never);
    });
    await expect.poll(() => rows.allTextContents()).toEqual(["Answer Required", before[0] === "Completed" ? "Completed" : "Awaiting Prompt"]);
    await expect(rows.filter({ hasText: /^Campaign (Stuck|Complete)$/ })).toHaveCount(0);
  });
}

test("a Custom campaign root's header and an older control plane's root keep Awaiting Prompt", async ({ page }) => {
  // A Custom root: its result is the person's to review.
  let status = await openRoot(page, 1280, "light", { orchestratorPolicy: { control: { mode: "custom" } } });
  if (ASSERT) await expect(status).toHaveAccessibleName("Session Status: Awaiting Prompt, Ready for Review");
  else await expect(status).toBeVisible();
  await capture(page, "header-custom-1280-light");
  // A control plane that sends no campaign status reads as it always has.
  status = await openRoot(page, 1280, "light", {});
  if (ASSERT) await expect(status).toHaveAccessibleName("Session Status: Awaiting Prompt, Ready for Review");
});
