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
      await expect(cards.nth(0)).toContainText("Fix the Flaky Upload Test");
      await expect(cards.nth(0).locator(".status")).toHaveText("Running");
      const waiting = cards.nth(1);
      await expect(waiting).toContainText("Run pnpm install --frozen-lockfile");
      await expect(waiting.getByRole("button", { name: "Approve Once" })).toBeVisible();
      await expect(waiting.getByRole("button", { name: "Deny" })).toBeVisible();
      await expect(waiting.getByRole("button", { name: "Open Session" })).toBeVisible();
      await capture(page, `assistants-thread-${theme}-desktop`);

      // Live: the running session finishes and its card follows.
      await page.evaluate(() => (window as unknown as { assistantsAdvance: () => void }).assistantsAdvance());
      await expect(cards.nth(0).locator(".status")).not.toHaveText("Running");

      // Approve Once answers the exact request with its once-only option.
      await waiting.getByRole("button", { name: "Approve Once" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-approved", "sess-deps:req-1:allow");
      await expect(waiting.getByRole("button", { name: "Approve Once" })).toHaveCount(0);

      // A card opens its session.
      await cards.nth(0).getByRole("button", { name: /Fix the Flaky Upload Test/ }).click();
      await expect(page).toHaveURL(/path=%2Fsessions%2F(~|%7E)/);
    });

    test("work launched mid-turn appears without a status change, and a rename outlasts an older list read", async ({ page }) => {
      const open_ = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
      await open(page, theme, "", open_);
      const cards = page.getByRole("region", { name: "Launched Work" }).locator(".assistant-work-card");
      await expect(cards).toHaveCount(2);
      // The launched sessions arrive as summaries, without their requests' options: the card reads
      // the detail and still offers the inline approval.
      await expect(cards.nth(1).getByRole("button", { name: "Approve Once" })).toBeVisible();

      // The backing session keeps its status while the assistant launches more work. The page's own
      // first refresh settles first, so only the launch's activity can bring the new card.
      await page.waitForTimeout(2_500);
      await page.evaluate(() => (window as unknown as { assistantsLaunch: () => void }).assistantsLaunch());
      await expect(cards).toHaveCount(3, { timeout: 5_000 });
      await expect(cards.nth(2)).toContainText("Write the Changelog");

      // A list read that began before a rename must not put the old title back.
      await page.evaluate(() => {
        const fixture = window as unknown as { assistantsHoldNextList: () => void; assistantsActivity: () => void };
        fixture.assistantsHoldNextList();
        fixture.assistantsActivity();
      });
      await expect(page.locator("body")).toHaveAttribute("data-list-held", "true", { timeout: 5_000 });
      await page.locator(".assistant-thread-head").getByRole("button", { name: "Thread Actions" }).click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const rename = page.getByRole("dialog", { name: "Rename Thread" });
      await rename.getByRole("textbox", { name: "Title" }).fill("Triage Last Night's CI");
      await rename.getByRole("button", { name: "Rename" }).click();
      await expect(threadRow(page, "Triage Last Night's CI")).toBeVisible();
      await page.evaluate(() => (window as unknown as { assistantsReleaseList: () => void }).assistantsReleaseList());
      await page.waitForTimeout(500);
      await expect(threadRow(page, "Triage Last Night's CI")).toBeVisible();
      await expect(page.locator(".assistant-thread-head").getByRole("heading", { level: 2 })).toHaveText("Triage Last Night's CI");
    });

    test("work launched while the thread streams appears even when the list answers slower than the stream", async ({ page }) => {
      await open(page, theme, "", "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA");
      const cards = page.getByRole("region", { name: "Launched Work" }).locator(".assistant-work-card");
      await expect(cards).toHaveCount(2);
      await page.waitForTimeout(2_500);
      // Each list read now takes two seconds while the backing session reports activity every 100ms
      // for ten seconds: refreshes must wait for the read in flight rather than discard it.
      await page.evaluate(() => {
        const fixture = window as unknown as {
          assistantsSlowLists: (ms: number) => void; assistantsLaunch: () => void; assistantsActivity: () => void;
        };
        fixture.assistantsSlowLists(2_000);
        fixture.assistantsLaunch();
        const timer = window.setInterval(fixture.assistantsActivity, 100);
        window.setTimeout(() => window.clearInterval(timer), 10_000);
      });
      await expect(cards).toHaveCount(3, { timeout: 8_000 });
      await expect(cards.nth(2)).toContainText("Write the Changelog");
    });

    test("New Thread preselects the Orchestrator harness, and rename and archive act on the thread", async ({ page }) => {
      await open(page, theme);
      await page.getByRole("button", { name: "New Thread" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New Thread" });
      await expect(dialog.getByRole("radio", { name: /Claude Code/ })).toBeChecked();
      await capture(page, `assistants-new-thread-${theme}-desktop`);
      await dialog.getByRole("radio", { name: /Codex/ }).check();
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
      await capture(page, `assistants-unavailable-${theme}-mobile`);
    });
  });
}
