import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectWithinWidth } from "./layout-invariants.js";

/**
 * The Assistants section (#4664) in a real browser, against `assistants-main.tsx`'s stub of the
 * provisional Thread API: the rail destination, the Wollipog Assistant's threads with New Thread,
 * rename and archive, the open thread's transcript and composer with its access level, the launched
 * sessions' toggle with a waiting approval inline in the header, the unavailable control plane, and a
 * phone. The Launched Sessions panel itself is `assistant-launched-sessions.spec.ts` (#4776).
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

async function captureAccountList(page: Page, dialog: Locator, action: Locator, name: string, accountRows: number) {
  const body = dialog.locator(".modal-body");
  const accounts = dialog.getByRole("radiogroup", { name: "Account" });
  await expect(accounts.getByRole("radio")).toHaveCount(accountRows);
  await expectNoHorizontalOverflow(dialog, "Thread account dialog");
  await expectNoHorizontalOverflow(accounts, "Account choices");
  // The dialog body is the only scroll surface. Its footer remains in view as all nine accounts
  // are browsed. Verify every whole row is visible in at least one captured scroll position.
  expect(await accounts.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  const visibleRows = (bottom: boolean) => body.evaluate((element, bottom) => {
    element.scrollTop = bottom ? element.scrollHeight : 0;
    const clip = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll('[aria-labelledby].choice-rows .choice-row'))
      .map((row, index) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= clip.top && rect.bottom <= clip.bottom ? index : -1;
      }).filter((index) => index >= 0);
  }, bottom);
  const visible = await visibleRows(false);
  await expectFullyInViewport(action, "Thread account dialog primary action");
  await capture(page, `${name}-top`);
  const atBottom = await visibleRows(true);
  expect(new Set([...visible, ...atBottom]).size).toBe(accountRows);
  await expectFullyInViewport(action, "Thread account dialog primary action after scrolling");
  if (visible.length < accountRows) await capture(page, `${name}-bottom`);
}

for (const theme of ["dark", "light"] as const) {
  for (const device of ["desktop", "phone"] as const) {
    test.describe(`thread accounts in ${theme} on ${device}`, () => {
      const phone = device === "phone";
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        hasTouch: phone, isMobile: phone, colorScheme: theme });

      test("chooses an eligible account at creation and changes an existing thread's account", async ({ page }) => {
        await page.clock.setFixedTime(new Date("2026-11-19T16:00:00Z"));
        const prefix = `assistant-account-${theme}-${device}`;
        const path = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
        const openChange = async () => {
          await page.getByRole("button", { name: "Thread Actions" }).click();
          await page.getByRole("menuitem", { name: "Thread Settings" }).click();
          await page.getByRole("button", { name: "Change… Account" }).click();
        };
        await open(page, theme, "accounts=default");
        await threadsList(page).getByRole("button", { name: "New Thread" }).click();
        const create = page.getByRole("dialog", { name: "New Thread" });
        const start = create.getByRole("button", { name: "Start Thread" });
        const createOptions = create.getByRole("radiogroup", { name: "Account" });
        await expect(createOptions.getByRole("radio", { name: "Machine Policy · Studio Subscription" })).toBeChecked();
        await expectFullyInViewport(start, "Start Thread");
        await capture(page, `${prefix}-create-default`);

        await open(page, theme, "accounts=choices");
        await threadsList(page).getByRole("button", { name: "New Thread" }).click();
        for (const [name, reason] of [
          ["Field Subscription", "needs sign-in"], ["Remote Subscription", "can't run in this agent's environment"],
          ["Metered Account", "would spend API credits"], ["Review Subscription", "is at a usage limit"],
        ]) {
          const option = createOptions.getByRole("radio", { name });
          await expect(option).toHaveAttribute("aria-disabled", "true");
          await expect(option).toHaveAccessibleDescription(`This account ${reason}.`);
        }
        await expectNoHorizontalOverflow(create, "New Thread with account reasons");
        await expectFullyInViewport(start, "Start Thread");
        await capture(page, `${prefix}-create-choices`);

        await open(page, theme, "accounts=stress");
        await threadsList(page).getByRole("button", { name: "New Thread" }).click();
        await createOptions.getByRole("radio", { name: /DesignResearchAndEngineering/ }).check();
        await captureAccountList(page, create, start, `${prefix}-create-stress`, 10);
        await start.click();
        await expect(page.locator("body")).toHaveAttribute("data-created-account", "acct:0000000000000002");

        await open(page, theme, "accounts=default&limits=enabled", path);
        await openChange();
        const change = page.getByRole("dialog", { name: "Change Account" });
        const changeButton = change.getByRole("button", { name: "Use Account" });
        const fresh = change.getByRole("checkbox", { name: "Start a Fresh Conversation" });
        await expect(fresh).not.toBeChecked();
        await expect(fresh).toHaveAccessibleDescription(/can't carry the conversation over/);
        await expectFullyInViewport(changeButton, "Use Account");
        await capture(page, `${prefix}-change-default`);

        await open(page, theme, "accounts=stress&limits=enabled", path);
        const panel = page.locator("#right-panel");
        const toggle = page.getByRole("button", { name: "Side Panel", exact: true });
        const details = panel.getByRole("tabpanel", { name: "Details" });
        const revealAccount = async () => {
          await toggle.click();
          await panel.getByRole("tab", { name: "Details" }).click();
          await details.getByRole("button", { name: "Show Account" }).click();
        };
        await revealAccount();
        await expect(details).toContainText("DesignResearchAndEngineering");
        await panel.getByRole("button", { name: "Close Panel" }).click();
        await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
        await expectFullyInViewport(page.locator(".composer"), "Thread composer");
        await expectPageNoHorizontalOverflow(page);
        await openChange();
        const changeOptions = change.getByRole("radiogroup", { name: "Account" });
        await expect(changeOptions.getByRole("radio", { name: /DesignResearchAndEngineering/ })).toHaveAttribute("aria-disabled", "true");
        await changeOptions.getByRole("radio", { name: "Studio Subscription" }).check();
        await captureAccountList(page, change, changeButton, `${prefix}-change-stress`, 9);
        await changeButton.click();
        await page.getByRole("button", { name: "Save Changes" }).click();
        await page.getByRole("button", { name: "Confirm and Save" }).click();
        await expect(page.locator("body")).toHaveAttribute("data-changed-account", "acct:0000000000000001");
        await revealAccount();
        await expect(details).toContainText("Studio Subscription");
        await panel.getByRole("button", { name: "Close Panel" }).click();
        await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
        await expect(page.locator(".assistant-launched-toggle")).toHaveText("2 Sessions · 1 Needs You");
      });
    });
  }
}

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

    test("an open thread shows its transcript, composer, launched counts and the waiting approval", async ({ page }) => {
      await open(page, theme, "", "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA");
      const head = page.locator(".assistant-thread-head");
      // One bar across the thread pane, as on the session page (#4776); the facts head the column.
      const bar = page.locator(".assistant-thread-bar");
      await expect(bar.getByRole("heading", { level: 2, name: "Triage Open Issues" })).toBeVisible();
      await expect(head).not.toContainText("Full access.");
      // The backing session's transcript and composer.
      await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      await expect(page.locator(".composer")).toBeVisible();
      // The header counts the launched sessions (#4776); only the one waiting on the person is a card
      // here, with its approval inline. The running one is in the closed Launched Sessions panel.
      await expect(bar.locator(".assistant-launched-toggle")).toHaveText("2 Sessions · 1 Needs You");
      const cards = page.getByRole("region", { name: "Waiting for You" }).locator(".assistant-work-card");
      await expect(cards).toHaveCount(1);
      await expect(head).not.toContainText("Fix the Flaky Upload Test");
      const waiting = cards.filter({ hasText: "Bump the Vite Group" });
      await expect(waiting).toContainText("Run pnpm install --frozen-lockfile");
      await expect(waiting.getByRole("button", { name: "Approve Once" })).toBeVisible();
      await expect(waiting.getByRole("button", { name: "Deny" })).toBeVisible();
      await expect(waiting.getByRole("button", { name: "Open Session" })).toBeVisible();
      await capture(page, `assistants-thread-${theme}-desktop`);

      // Approve Once answers the exact request with its once-only option, and the counts follow.
      await waiting.getByRole("button", { name: "Approve Once" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-approved", "sess-deps:req-1:allow");
      await expect(page.getByRole("button", { name: "Approve Once" })).toHaveCount(0);
      await expect(bar.locator(".assistant-launched-toggle")).toHaveText("2 Sessions");
    });

    test("a thread change arrives as an event, and one that lands during a list read survives it", async ({ page }) => {
      await open(page, theme, "", "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA");
      const counts = page.locator(".assistant-launched-toggle");
      await expect(counts).toHaveText("2 Sessions · 1 Needs You");
      // The launched sessions arrive as summaries, without their requests' options: the card reads
      // the detail and still offers the inline approval.
      const cards = page.getByRole("region", { name: "Waiting for You" }).locator(".assistant-work-card");
      await expect(cards.filter({ hasText: "Bump the Vite Group" }).getByRole("button", { name: "Approve Once" })).toBeVisible();

      // Mid-turn the assistant launches more work while its own status stays put. The control plane
      // republishes the thread, and the counts follow from that event alone: well inside the 15s poll.
      await page.evaluate(() => (window as unknown as { assistantsLaunch: () => void }).assistantsLaunch());
      await expect(counts).toHaveText("3 Sessions · 1 Needs You", { timeout: 2_000 });
      await counts.click();
      await expect(page.locator("#right-panel .launched-sessions")).toContainText("Write the Changelog");
      await counts.click();

      // A rename starts a list read; hold that read, publish another change to the thread while it
      // is in flight, then let it land. The read began before the change, so the change must stay.
      await page.evaluate(() => (window as unknown as { assistantsHoldNextList: () => void }).assistantsHoldNextList());
      await page.locator(".assistant-thread-bar").getByRole("button", { name: "Thread Actions" }).click();
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
      await expect(page.locator(".assistant-thread-bar").getByRole("heading", { level: 2 })).toHaveText("Triage Last Night's CI");
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
      await expect(page.getByRole("region", { name: "Waiting for You" }).locator(".assistant-work-title")).toHaveCount(1);
      await page.locator(".assistant-launched-toggle").click();
      const titles = page.locator("#right-panel .launched-sessions .assistant-work-title");
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
      await page.locator(".assistant-thread-bar").getByRole("button", { name: "Thread Actions" }).click();
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
      const head = page.locator(".assistant-thread-bar");
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
      const head = page.locator(".assistant-thread-bar");
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

    test("New Thread preselects the default harness, and rename and archive act on the thread", async ({ page }) => {
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
      await expect(page.locator(".assistant-thread-bar").getByRole("heading", { level: 2, name: "Plan the Next Release" })).toBeVisible();
      await expect(threadRow(page, "Plan the Next Release")).toHaveAttribute("aria-current", "true");
      await expect(threadRow(page, "Plan the Next Release").locator(".row-sub")).toContainText("Codex");

      await page.locator(".assistant-thread-bar").getByRole("button", { name: "Thread Actions" }).click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const rename = page.getByRole("dialog", { name: "Rename Thread" });
      await rename.getByRole("textbox", { name: "Title" }).fill("Plan Release 0.31");
      await rename.getByRole("button", { name: "Rename" }).click();
      await expect(threadRow(page, "Plan Release 0.31")).toBeVisible();

      await page.locator(".assistant-thread-bar").getByRole("button", { name: "Thread Actions" }).click();
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
      await expect(page.locator(".assistant-thread-head")).not.toContainText("Full access.");
      await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
      await expect(page.getByRole("region", { name: "Waiting for You" }).getByRole("button", { name: "Approve Once" })).toBeVisible();
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

/** Threads named at the 120-character limit: the list pane never scrolls sideways, each title ends in
 * an ellipsis inside its row, and New Thread stays whole at the pane's trailing edge, from a desktop
 * through the compact tier's 280px pane to a phone. The open thread's header keeps its width too. */
const TRIAGE_PATH = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const LONG_TITLE_VIEWPORTS = [
  { width: 1440, height: 900, phone: false },
  { width: 1000, height: 800, phone: false },
  { width: 900, height: 800, phone: false },
  { width: 390, height: 844, phone: true },
];

async function expectTitleEllipsized(title: Locator, container: Locator, what: string) {
  const fit = await title.evaluate((element) => ({
    cut: element.scrollWidth > element.clientWidth,
    ellipsis: getComputedStyle(element).textOverflow === "ellipsis",
  }));
  expect(fit, `${what} is cut with an ellipsis`).toEqual({ cut: true, ellipsis: true });
  await expectWithinWidth(title, container, what);
}

for (const viewport of LONG_TITLE_VIEWPORTS) {
  test.describe(`long thread titles at ${viewport.width}×${viewport.height}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: "dark",
      ...(viewport.phone ? { hasTouch: true, isMobile: true } : {}),
    });

    test("the list never scrolls sideways, titles end in an ellipsis and New Thread stays whole", async ({ page }) => {
      await open(page, "dark", "threads=long");
      const pane = threadsList(page);
      await expect(pane.locator("[data-thread-id]")).toHaveCount(12);
      await expectNoHorizontalOverflow(pane, "The Assistants list");
      const newThread = pane.getByRole("button", { name: "New Thread" });
      await expectFullyInViewport(newThread, "New Thread");
      await expectWithinWidth(newThread, pane, "New Thread");
      for (const row of await pane.locator("[data-thread-id]").all()) {
        await expectWithinWidth(row, pane, "A thread row");
        await expectWithinWidth(row.locator(".status"), pane, "A thread's status");
      }
      await expectTitleEllipsized(pane.locator(".row-title").first(), pane, "The first thread's title");
      await expectPageNoHorizontalOverflow(page);
    });

    test("the open thread's header keeps a long title to its width", async ({ page }) => {
      await open(page, "dark", "threads=long", TRIAGE_PATH);
      if (viewport.phone) {
        // A phone's detail bar carries the title, Back and the thread's actions.
        const bar = page.locator(".detail-bar");
        await expect(bar.locator(".detail-bar-title")).toContainText("Triage every open issue");
        await expectFullyInViewport(page.getByRole("button", { name: "Back to Assistants" }), "Back to Assistants");
        await expectFullyInViewport(bar.getByRole("button", { name: "Thread Actions" }), "Thread Actions");
      } else {
        const head = page.locator(".assistant-thread-bar");
        const title = head.getByRole("heading", { level: 2 });
        await expect(title).toHaveAttribute("title", /^Triage every open issue/);
        // The bar never scrolls sideways; its title gives way first.
        await expectNoHorizontalOverflow(head, "The thread's bar");
        await expectTitleEllipsized(title, head, "The thread's title");
        await expectFullyInViewport(head.getByRole("button", { name: "Thread Actions" }), "Thread Actions");
        await expectNoHorizontalOverflow(threadsList(page), "The Assistants list");
      }
      await expect(page.locator(".composer")).toBeInViewport();
      await expectPageNoHorizontalOverflow(page);
    });
  });
}

test.describe("long thread titles evidence", () => {
  test.use({ timezoneId: "UTC", locale: "en-US" });

  for (const [width, height, theme] of [[1000, 800, "dark"], [390, 844, "dark"], [390, 844, "light"]] as const) {
    test(`captures the list at ${width}px in the ${theme} theme`, async ({ page }) => {
      test.skip(!process.env.WOLLIPOG_EVIDENCE_DIR, "evidence capture only");
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height });
      // A fixed clock, so each row's "5m ago" never changes between runs.
      await page.clock.setFixedTime(Date.UTC(2026, 10, 17, 17, 0));
      await open(page, theme, "threads=long");
      await expect(threadsList(page).locator("[data-thread-id]")).toHaveCount(12);
      await capture(page, `assistants-list-${width}-${theme}`);
    });
  }
});
