import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { AssistantOwnerConfirmation, AssistantThread } from "@wollipog/protocol";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

/**
 * The Inbox's Assistant Approvals (#4665): one compact block above the Sessions list, a line for each
 * thread with requests waiting (its title, how many, the earliest expiry, and Review, which opens the
 * thread to answer them). However many requests wait, the block keeps a small bounded height and the
 * sessions stay in view. Set `ASSISTANT_CONFIRMATION_EVIDENCE_DIR` to capture it for UI evidence.
 */
const EVIDENCE_DIR = process.env.ASSISTANT_CONFIRMATION_EVIDENCE_DIR;
/** A fixed clock, so captured expiries and ages never change between runs. */
const FIXED_NOW = Date.UTC(2026, 10, 17, 17, 0);

function confirmation(threadId: string, index: number, overrides: Partial<AssistantOwnerConfirmation> = {}): AssistantOwnerConfirmation {
  return {
    id: `aoc_${threadId}_${index}`,
    threadId,
    operation: "session_archive",
    title: "Archive Session",
    summary: "Stops the session if it is running, then archives it and its side chat. Its transcript is kept, and it can be unarchived later.",
    target: { kind: "session", id: `session-${index}`, label: `Prototype ${index}` },
    impact: [{ label: "Status", value: "Idle" }],
    arguments: [{ label: "sessionId", value: `session-${index}` }],
    status: "pending",
    createdAt: FIXED_NOW - 60_000 + index,
    expiresAt: FIXED_NOW + (59 - index) * 60_000,
    resolvedAt: null,
    ...overrides,
  };
}

function thread(id: string, title: string, sessionId: string, count: number): AssistantThread {
  return {
    id, assistant: "wollipog", title, harness: "codex", sessionId,
    status: count ? "needs_you" : "done", access: { level: "full_access", destructive: "ask" },
    connectionId: "asst_fixture", launchedSessionIds: [], confirmations: Array.from({ length: count }, (_unused, index) => confirmation(id, index)),
    lastActivityAt: FIXED_NOW, createdAt: FIXED_NOW - 3_600_000, archivedAt: null,
  };
}

const CLEANUP = "Clean Up Last Week's Prototype Sessions Before the Release Branch Is Cut";
const RELEASE = "Ship the Release Notes";

/** Serves the Thread API with `threads`; Approve Once and Deny settle the request they name. */
async function serveThreads(page: Page, threads: AssistantThread[]) {
  let current = threads;
  const answers: string[] = [];
  await page.route("**/api/assistant-threads", (route) => route.fulfill({ json: { threads: current } }));
  await page.route("**/api/assistant-threads/*/confirmations/*/*", (route) => {
    const [threadId, , confirmationId, intent] = route.request().url().split("/").slice(-4).map(decodeURIComponent);
    answers.push(`${confirmationId}:${intent}`);
    const asked = current.find((candidate) => candidate.id === threadId)!.confirmations!.find((candidate) => candidate.id === confirmationId)!;
    const settled: AssistantOwnerConfirmation = intent === "approve"
      ? { ...asked, status: "executed", resolvedAt: Date.now(), outcome: { receiptStatus: "succeeded" } }
      : { ...asked, status: "denied", resolvedAt: Date.now(), outcome: { reason: "The owner denied it." } };
    current = current.map((candidate) => candidate.id !== threadId ? candidate
      : { ...candidate, confirmations: candidate.confirmations!.filter((item) => item.id !== confirmationId) });
    return route.fulfill({ json: { confirmation: settled, thread: current.find((candidate) => candidate.id === threadId) } });
  });
  return { answers };
}

async function openInbox(page: Page) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto("/command-inbox-projects-e2e.html?fullShell=1&history=1");
}

const approvals = (page: Page) => page.getByRole("region", { name: "Assistant Approvals" });
const threadRow = (page: Page, title: string) => approvals(page).getByRole("listitem").filter({ hasText: title });
const sessionsPane = (page: Page) => page.getByRole("region", { name: "Sessions" });

test("the Inbox sums up a thread's requests in one line, and Review opens the thread to answer them", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const served = await serveThreads(page, [thread("thr_cleanup", CLEANUP, "session-alpha", 1)]);
  await openInbox(page);
  const row = threadRow(page, CLEANUP);
  await expect(row).toContainText("1 Approval");
  await expect(row).toContainText(/Expires /);
  // The Inbox only points at the requests; they are answered in their thread, where each is whole.
  await expect(approvals(page).getByRole("button", { name: "Approve Once" })).toHaveCount(0);
  await row.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(/path=%2Fassistants%2F(~|%7E)/);
  const request = page.getByRole("list", { name: "Pending Requests" }).getByRole("listitem", { name: "Archive Session" });
  await expect(request).toBeVisible();
  await expect(request.locator("dl[aria-label='Arguments']")).toContainText("session-0");
  await request.getByRole("button", { name: "Approve Once", exact: true }).click();
  await expect(page.getByText("Archive Session ran once.", { exact: true })).toBeVisible();
  expect(served.answers).toEqual(["aoc_thr_cleanup_0:approve"]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`at ${viewport.width}px eight requests from two threads take one small block, and the sessions stay in view`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await serveThreads(page, [thread("thr_cleanup", CLEANUP, "session-alpha", 6), thread("thr_release", RELEASE, "session-secret", 2)]);
    await openInbox(page);
    const block = approvals(page);
    await expect(block.getByRole("button", { name: "Review", exact: true }).first()).toBeVisible();
    // The layout first, whatever the block draws inside it.
    const [blockBox, paneBox] = await Promise.all([block.boundingBox(), sessionsPane(page).boundingBox()]);
    expect(blockBox!.height, "the approvals take at most a quarter of the Sessions pane").toBeLessThanOrEqual(paneBox!.height * 0.25);
    await expectFullyInViewport(sessionsPane(page).locator(".inbox-row").first(), "The first session row");
    await expectNoHorizontalOverflow(block, "The approvals");
    await expectPageNoHorizontalOverflow(page);
    // One line for each thread, with how many requests it has waiting.
    await expect(block.getByRole("listitem")).toHaveCount(2);
    await expect(threadRow(page, CLEANUP)).toContainText("6 Approvals");
    await expect(threadRow(page, RELEASE)).toContainText("2 Approvals");
    // A long thread title ends in an ellipsis; its count and Review stay whole.
    const title = threadRow(page, CLEANUP).getByText(CLEANUP, { exact: true });
    expect(await title.evaluate((element) => getComputedStyle(element).textOverflow)).toBe("ellipsis");
    await expectFullyInViewport(threadRow(page, CLEANUP).getByRole("button", { name: "Review", exact: true }), "Review");
    // Review opens the thread it names.
    await threadRow(page, RELEASE).getByRole("button", { name: "Review", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`path=${encodeURIComponent("/assistants/")}`));
    await page.getByRole("button", { name: "Show All", exact: true }).click();
    await expect(page.getByRole("list", { name: "Pending Requests" }).getByRole("listitem")).toHaveCount(2);
    if (viewport.width > 760) await expect(page.locator(".assistant-thread-bar").getByRole("heading", { level: 2 })).toHaveText(RELEASE);
    else await expect(page.locator(".detail-bar-title")).toHaveText(RELEASE);
  });
}

test("beside the preview, in the narrowest 280px Sessions list, the lines wrap without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The fixture instance's scoped keys (instance-storage.ts): the preview on the right, the list at its minimum.
  await page.addInitScript(() => {
    localStorage.setItem("wollipog.instance.v1:17:project-inbox-e2e31:wollipog.sessions.previewLayout", "right");
    localStorage.setItem("wollipog.instance.v1:17:project-inbox-e2e27:wollipog.sessions.listWidth", "280");
  });
  await serveThreads(page, [thread("thr_cleanup", CLEANUP, "session-alpha", 6), thread("thr_release", RELEASE, "session-secret", 2)]);
  await openInbox(page);
  const block = approvals(page);
  await expect(block.getByRole("listitem")).toHaveCount(2);
  const [blockBox, paneBox] = await Promise.all([block.boundingBox(), sessionsPane(page).boundingBox()]);
  expect(paneBox!.width, "the list is at its minimum width").toBeLessThanOrEqual(281);
  expect(blockBox!.height, "the approvals take at most a quarter of the Sessions pane").toBeLessThanOrEqual(paneBox!.height * 0.25);
  await expectNoHorizontalOverflow(block, "The approvals");
  for (const row of await block.getByRole("listitem").all()) {
    await expectFullyInViewport(row.getByRole("button", { name: "Review", exact: true }), "Review");
    await expect(row).toContainText(/\d Approvals?/);
    // The title over its count, expiry and Review: two rows at most, never a third.
    expect((await row.boundingBox())!.height, "a thread's line wraps at most once").toBeLessThanOrEqual(56);
  }
  await expectFullyInViewport(sessionsPane(page).locator(".inbox-row").first(), "The first session row");
});

test("past three threads the block names the first three, and +N More opens the Assistants section", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveThreads(page, Array.from({ length: 5 }, (_unused, index) => thread(`thr_${index}`, `Thread ${index + 1}`, "session-alpha", 1)));
  await openInbox(page);
  await expect(approvals(page).getByRole("listitem")).toHaveCount(3);
  await approvals(page).getByRole("button", { name: "+2 More", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`path=${encodeURIComponent("/assistants")}(&|$)`));
  await expect(page.getByRole("complementary", { name: "Assistants" })).toBeVisible();
});

test("a control plane without the Thread API shows no approvals", async ({ page }) => {
  await page.route("**/api/assistant-threads", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.goto("/command-inbox-projects-e2e.html?fullShell=1");
  await expect(sessionsPane(page)).toBeVisible();
  await expect(approvals(page)).toHaveCount(0);
});

test.describe("evidence", () => {
  test.use({ timezoneId: "UTC", locale: "en-US" });

  test("captures the approvals in both themes at desktop and phone widths", async ({ page }) => {
    test.skip(!EVIDENCE_DIR, "evidence capture only");
    mkdirSync(EVIDENCE_DIR!, { recursive: true });
    await serveThreads(page, [thread("thr_cleanup", CLEANUP, "session-alpha", 6)]);
    for (const scheme of ["dark", "light"] as const) {
      for (const width of [1440, 390]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: width > 760 ? 900 : 844 });
        await openInbox(page);
        await page.evaluate((theme) => localStorage.setItem("wollipog.theme", theme), scheme);
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await expect(approvals(page)).toBeVisible();
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(EVIDENCE_DIR!, `session-list-${width}-${scheme}.png`) });
      }
    }
  });
});
