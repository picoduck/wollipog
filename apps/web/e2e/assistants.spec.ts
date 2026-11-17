import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

/**
 * The Assistants section (#4664) in a real browser, against `assistants-main.tsx`'s stub of the
 * provisional Thread API: the rail destination, the Wollipog Assistant's threads with New Thread,
 * rename and archive, the open thread's transcript and composer with its access level, launched
 * sessions as live work cards with an inline approval, the unavailable control plane, and a phone.
 * With `WOLLIPOG_EVIDENCE_DIR` set, each state is also captured as UI evidence.
 */

async function open(page: Page, theme: string, query = "", path = "/assistants") {
  await page.goto(`/assistants-e2e.html?theme=${theme}&path=${encodeURIComponent(path)}${query ? `&${query}` : ""}`);
}

async function capture(page: Page, name: string) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
}

/** The empty state's column starts where the Threads label's text does. */
async function expectEmptyStateAligned(page: Page) {
  const [label, state] = await Promise.all([
    page.locator(".assistant-threads-head .group-label").evaluate((element) =>
      element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft)),
    page.locator(".assistant-group > .state .state-title").evaluate((element) => element.getBoundingClientRect().left),
  ]);
  expect(Math.abs(state - label), "the empty state lines up with the Threads label").toBeLessThanOrEqual(1);
}

const threadsList = (page: Page) => page.getByRole("complementary", { name: "Assistants" });
const threadRow = (page: Page, title: string) => threadsList(page).getByRole("button", { name: new RegExp(`^${title}`) });

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} at 1440×900`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme });

    test("the Assistants destination lists the Wollipog Assistant's threads with their status", async ({ page }) => {
      await open(page, theme);
      await expect(page.getByRole("heading", { level: 1, name: "Assistants", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Assistants", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(threadsList(page).getByRole("heading", { level: 2, name: "Wollipog Assistant" })).toBeVisible();
      await expect(threadsList(page).getByRole("button", { name: "New Thread" })).toBeVisible();
      const rows = threadsList(page).locator("[data-thread-id]");
      await expect(rows).toHaveCount(3);
      // Newest activity first, each with its status badge.
      await expect(rows.locator(".row-title")).toHaveText(["Triage Open Issues", "Ship the Release Notes", "Weekly Cleanup"]);
      await expect(rows.locator(".status")).toHaveText(["Needs You", "Working", "Done"]);
      await expect(rows.nth(1).locator(".row-sub")).toContainText("Codex");
      await capture(page, `assistants-list-${theme}-desktop`);
    });

    test("an open thread shows its transcript, composer, access level and live work cards", async ({ page }) => {
      await open(page, theme, "", "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA");
      const head = page.locator(".assistant-thread-head");
      await expect(head.getByRole("heading", { level: 2, name: "Triage Open Issues" })).toBeVisible();
      await expect(head.getByRole("list", { name: "Thread Details" })).toContainText("Full Access · Ask Before Destructive");
      await expect(head.getByRole("list", { name: "Thread Details" })).toContainText("Claude Code");
      // The backing session's transcript and composer.
      await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      await expect(page.locator(".composer")).toBeVisible();
      // Launched sessions are work cards; the waiting one carries its approval inline.
      const cards = page.getByRole("region", { name: "Launched Work" }).locator(".assistant-work-card");
      await expect(cards).toHaveCount(2);
      // Work waiting on the person comes first.
      await expect(cards.nth(0)).toContainText("Bump the Vite Group");
      const flaky = cards.filter({ hasText: "Fix the Flaky Upload Test" });
      await expect(flaky).toHaveCount(1);
      await expect(flaky.locator(".status")).toHaveText("Running");
      const waiting = cards.filter({ hasText: "Bump the Vite Group" });
      await expect(waiting).toContainText("Run pnpm install --frozen-lockfile");
      await expect(waiting.getByRole("button", { name: "Approve Once" })).toBeVisible();
      await expect(waiting.getByRole("button", { name: "Deny" })).toBeVisible();
      await expect(waiting.getByRole("button", { name: "Open Session" })).toBeVisible();
      await capture(page, `assistants-thread-${theme}-desktop`);

      // Live: the running session finishes and its card follows.
      await page.evaluate(() => (window as unknown as { assistantsAdvance: () => void }).assistantsAdvance());
      await expect(flaky.locator(".status")).not.toHaveText("Running");

      // Approve Once answers the exact request with its once-only option.
      await waiting.getByRole("button", { name: "Approve Once" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-approved", "sess-deps:req-1:allow");
      await expect(waiting.getByRole("button", { name: "Approve Once" })).toHaveCount(0);

      // A card opens its session.
      await flaky.getByRole("button", { name: /Fix the Flaky Upload Test/ }).click();
      await expect(page).toHaveURL(/path=%2Fsessions%2F(~|%7E)/);
    });

    test("a thread change arrives as an event, and one that lands during a list read survives it", async ({ page }) => {
      await open(page, theme, "", "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA");
      const cards = page.getByRole("region", { name: "Launched Work" }).locator(".assistant-work-card");
      await expect(cards).toHaveCount(2);
      // The launched sessions arrive as summaries, without their requests' options: the card reads
      // the detail and still offers the inline approval.
      await expect(cards.filter({ hasText: "Bump the Vite Group" }).getByRole("button", { name: "Approve Once" })).toBeVisible();

      // Mid-turn the assistant launches more work while its own status stays put. The control plane
      // republishes the thread, and the card follows from that event alone: well inside the 15s poll.
      await page.evaluate(() => (window as unknown as { assistantsLaunch: () => void }).assistantsLaunch());
      await expect(cards).toHaveCount(3, { timeout: 2_000 });
      await expect(cards.filter({ hasText: "Write the Changelog" })).toHaveCount(1);

      // A rename starts a list read; hold that read, publish another change to the thread while it
      // is in flight, then let it land. The read began before the change, so the change must stay.
      await page.evaluate(() => (window as unknown as { assistantsHoldNextList: () => void }).assistantsHoldNextList());
      await page.locator(".assistant-thread-head").getByRole("button", { name: "Thread Actions" }).click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const rename = page.getByRole("dialog", { name: "Rename Thread" });
      await expect(rename.getByRole("textbox", { name: "Title" })).toHaveAttribute("maxlength", "120");
      await rename.getByRole("textbox", { name: "Title" }).fill("Triage Last Night's CI");
      await rename.getByRole("button", { name: "Rename" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-list-held", "true", { timeout: 5_000 });
      await expect(threadRow(page, "Triage Last Night's CI")).toBeVisible();
      await page.evaluate(() => (window as unknown as { assistantsThreadStatus: (id: string, status: string) => void })
        .assistantsThreadStatus("thr_triage", "done"));
      await expect(threadRow(page, "Triage Last Night's CI").locator(".status")).toHaveText("Done");
      await page.evaluate(() => (window as unknown as { assistantsReleaseList: () => void }).assistantsReleaseList());
      await page.waitForTimeout(500);
      await expect(threadRow(page, "Triage Last Night's CI").locator(".status")).toHaveText("Done");
      await expect(page.locator(".assistant-thread-head").getByRole("heading", { level: 2 })).toHaveText("Triage Last Night's CI");
    });

    test("the thread's transcript is the backing session's, as the Sessions page shows it", async ({ page }) => {
      // The same session on its own page: the transcript, its turn footer (finish time, usage, Copy
      // and the turn menu) and the composer are the shared session surface, not the thread's own.
      await open(page, theme, "", "/sessions/~cwBlAHMAcwAtAHQAcgBpAGEAZwBlAA");
      await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      await expect(page.locator(".composer")).toBeVisible();
      await capture(page, `assistants-backing-session-page-${theme}-desktop`);
    });

    test("work cards share the row's width, so a title is not cut while there is room", async ({ page }) => {
      await open(page, theme, "", "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA");
      const titles = page.getByRole("region", { name: "Launched Work" }).locator(".assistant-work-title");
      await expect(titles).toHaveCount(2);
      for (const title of await titles.all()) {
        expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth), await title.textContent() ?? "")
          .toBe(true);
      }
    });

    test("a list read that outlives more changes than the store keeps reads again instead of undoing one", async ({ page }) => {
      await open(page, theme, "", "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA");
      await expect(threadsList(page).locator("[data-thread-id]")).toHaveCount(3);
      type Fixture = {
        assistantsHoldNextList: () => void;
        assistantsReleaseList: () => void;
        assistantsThreadStatus: (id: string, status: string) => void;
        assistantsFlood: (id: string, count: number, spacedMs: number) => Promise<void>;
      };
      // A rename starts a list read; hold it, change the triage thread while it is in flight, then
      // send more changes to another thread than the store keeps, each in its own render.
      await page.evaluate(() => (window as unknown as Fixture).assistantsHoldNextList());
      await page.locator(".assistant-thread-head").getByRole("button", { name: "Thread Actions" }).click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const rename = page.getByRole("dialog", { name: "Rename Thread" });
      await rename.getByRole("textbox", { name: "Title" }).fill("Triage Last Night's CI");
      await rename.getByRole("button", { name: "Rename" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-list-held", "true", { timeout: 5_000 });
      await page.evaluate(() => (window as unknown as Fixture).assistantsThreadStatus("thr_triage", "done"));
      await expect(threadRow(page, "Triage Last Night's CI").locator(".status")).toHaveText("Done");
      await page.evaluate(() => (window as unknown as Fixture).assistantsFlood("thr_cleanup", 70, 5));
      // The held read predates the status change, and the store no longer has it to replay: the
      // read lands, sees that, and reads again rather than leaving the old status in place.
      await page.evaluate(() => (window as unknown as Fixture).assistantsReleaseList());
      await page.waitForTimeout(1_000);
      await expect(threadRow(page, "Triage Last Night's CI").locator(".status")).toHaveText("Done");
    });

    test("an archived thread open on its own follows a change the store could not keep", async ({ page }) => {
      await open(page, theme, "", "/assistants/~dABoAHIAXwByAGUAdABpAHIAZQBkAA");
      const head = page.locator(".assistant-thread-head");
      await expect(head.getByRole("heading", { level: 2, name: "Retire the Old Runner" })).toBeVisible();
      // Its rename and more changes than the store keeps arrive in one render: the list is read
      // again, and so is the archived thread, which the list leaves out.
      await page.evaluate(async () => {
        const fixture = window as unknown as {
          assistantsRenameElsewhere: (id: string, title: string) => void;
          assistantsFlood: (id: string, count: number, spacedMs: number) => Promise<void>;
        };
        fixture.assistantsRenameElsewhere("thr_retired", "Runner Retired in November");
        await fixture.assistantsFlood("thr_cleanup", 70, 0);
      });
      await expect(head.getByRole("heading", { level: 2, name: "Runner Retired in November" })).toBeVisible({ timeout: 3_000 });
    });

    test("a link to an archived thread opens it on its own, though the list leaves it out", async ({ page }) => {
      // thr_retired
      await open(page, theme, "", "/assistants/~dABoAHIAXwByAGUAdABpAHIAZQBkAA");
      await expect(threadsList(page).locator("[data-thread-id]")).toHaveCount(3);
      const head = page.locator(".assistant-thread-head");
      await expect(head.getByRole("heading", { level: 2, name: "Retire the Old Runner" })).toBeVisible();
      await expect(head.locator(".status")).toHaveText("Archived");
    });

    test("someone who isn't an organization owner sees why there are no threads, with nothing to start", async ({ page }) => {
      await open(page, theme, "threads=owner-only");
      await expect(threadsList(page).getByText("Threads Are for Owners", { exact: true })).toBeVisible();
      await expect(threadsList(page)).toContainText("Only an organization owner can use Wollipog Assistant threads.");
      await expect(page.getByRole("button", { name: "New Thread" })).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.locator(".assistant-thread-pane")).toBeEmpty();
      await expectEmptyStateAligned(page);
      await capture(page, `assistants-owner-only-${theme}-desktop`);
    });

    test("New Thread preselects the Orchestrator harness, and rename and archive act on the thread", async ({ page }) => {
      await open(page, theme);
      await page.getByRole("button", { name: "New Thread" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New Thread" });
      await expect(dialog.getByRole("radio", { name: /Claude Code/ })).toBeChecked();
      await capture(page, `assistants-new-thread-${theme}-desktop`);
      await dialog.getByRole("radio", { name: /Codex/ }).check();
      // The control plane takes titles of up to 120 characters; the field stops there.
      await expect(dialog.getByRole("textbox", { name: "Title (Optional)" })).toHaveAttribute("maxlength", "120");
      await dialog.getByRole("textbox", { name: "Title (Optional)" }).fill("Plan the Next Release");
      await dialog.getByRole("button", { name: "Start Thread" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".assistant-thread-head").getByRole("heading", { level: 2, name: "Plan the Next Release" })).toBeVisible();
      await expect(threadRow(page, "Plan the Next Release")).toHaveAttribute("aria-current", "true");
      await expect(threadRow(page, "Plan the Next Release").locator(".row-sub")).toContainText("Codex");

      await page.locator(".assistant-thread-head").getByRole("button", { name: "Thread Actions" }).click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const rename = page.getByRole("dialog", { name: "Rename Thread" });
      await rename.getByRole("textbox", { name: "Title" }).fill("Plan Release 0.31");
      await rename.getByRole("button", { name: "Rename" }).click();
      await expect(threadRow(page, "Plan Release 0.31")).toBeVisible();

      await page.locator(".assistant-thread-head").getByRole("button", { name: "Thread Actions" }).click();
      await page.getByRole("menuitem", { name: "Archive" }).click();
      await page.getByRole("dialog", { name: "Archive Thread" }).getByRole("button", { name: "Archive Thread" }).click();
      await expect(threadRow(page, "Plan Release 0.31")).toHaveCount(0);
      await expect(threadsList(page).locator("[data-thread-id]")).toHaveCount(3);
    });

    test("a control plane without threads shows the empty section, and New Thread explains", async ({ page }) => {
      await open(page, theme, "threads=unavailable");
      await expect(threadsList(page).getByText("No Threads Yet", { exact: true })).toBeVisible();
      await expect(threadsList(page)).toContainText("Assistant threads aren't available on this control plane yet.");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expectEmptyStateAligned(page);
      // The pane beside the list offers no thread to choose: the list already says why.
      await expect(page.locator(".assistant-thread-pane")).toBeEmpty();
      await capture(page, `assistants-unavailable-${theme}-desktop`);
      await page.getByRole("button", { name: "New Thread" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New Thread" });
      await expect(dialog.getByText("Threads Aren't Available Yet", { exact: true })).toBeVisible();
      await expect(dialog).toContainText("aren't available on this control plane yet");
      await expect(dialog.getByRole("button", { name: "Start Thread" })).toHaveCount(0);
      await capture(page, `assistants-unavailable-new-thread-${theme}-desktop`);
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toHaveCount(0);
    });
  });

  test.describe(`${theme} at 390×844`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: theme });

    test("a phone lists the threads, then opens one as its own route with Back", async ({ page }) => {
      await open(page, theme);
      await expect(threadsList(page).locator("[data-thread-id]")).toHaveCount(3);
      await expect(page.locator(".assistant-thread-pane")).toBeHidden();
      await capture(page, `assistants-list-${theme}-mobile`);
      await threadRow(page, "Triage Open Issues").click();
      await expect(page.getByRole("button", { name: "Back to Assistants" })).toBeVisible();
      await expect(threadsList(page)).toBeHidden();
      await expect(page.getByRole("list", { name: "Thread Details" })).toContainText("Full Access · Ask Before Destructive");
      await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      await expect(page.getByRole("region", { name: "Launched Work" }).getByRole("button", { name: "Approve Once" })).toBeVisible();
      // The waiting approval is whole on the screen: its title, its command and all three buttons sit
      // inside the phone's width, with no sideways scroll to find them.
      const approval = page.locator(".assistant-work-card", { hasText: "Bump the Vite Group" });
      const width = page.viewportSize()!.width;
      for (const part of [
        approval,
        approval.locator(".assistant-work-title"),
        approval.locator(".assistant-work-request-title"),
        approval.getByRole("button", { name: "Approve Once" }),
        approval.getByRole("button", { name: "Deny" }),
        approval.getByRole("button", { name: "Open Session" }),
      ]) {
        const box = (await part.boundingBox())!;
        expect(box.x, "starts on the screen").toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, "ends on the screen").toBeLessThanOrEqual(width);
      }
      expect(await approval.locator(".assistant-work-title").evaluate((element) => element.scrollWidth <= element.clientWidth),
        "the card's title is not cut").toBe(true);
      // Nothing overflows the phone's width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await capture(page, `assistants-thread-${theme}-mobile`);
      await page.getByRole("button", { name: "Back to Assistants" }).click();
      await expect(threadsList(page).locator("[data-thread-id]")).toHaveCount(3);
    });

    test("a phone without threads shows the empty section", async ({ page }) => {
      await open(page, theme, "threads=unavailable");
      await expect(threadsList(page).getByText("No Threads Yet", { exact: true })).toBeVisible();
      await expectEmptyStateAligned(page);
      await capture(page, `assistants-unavailable-${theme}-mobile`);
    });

    test("a phone that isn't an owner's sees why there are no threads", async ({ page }) => {
      await open(page, theme, "threads=owner-only");
      await expect(threadsList(page).getByText("Threads Are for Owners", { exact: true })).toBeVisible();
      await expectEmptyStateAligned(page);
      await capture(page, `assistants-owner-only-${theme}-mobile`);
    });
  });
}
