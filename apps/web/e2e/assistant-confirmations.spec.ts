import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { AssistantOwnerConfirmation, AssistantThread } from "@wollipog/protocol";
import { dialogMotionSettled } from "./dialog-motion.js";

/** Set to a directory to capture the request for UI evidence (#4665). */
const EVIDENCE_DIR = process.env.ASSISTANT_CONFIRMATION_EVIDENCE_DIR;

function confirmation(overrides: Partial<AssistantOwnerConfirmation> = {}): AssistantOwnerConfirmation {
  const now = Date.now();
  return {
    id: "aoc_fixture",
    threadId: "thr_fixture",
    operation: "session_archive",
    title: "Archive Session",
    target: { kind: "session", id: "session-alpha", label: "Slack Prototype" },
    impact: [
      { label: "Status", value: "idle" },
      { label: "Worktree Path", value: "/home/dev/wollipog/.worktrees/slack-prototype" },
      { label: "Runner ID", value: "misko-x399" },
    ],
    arguments: [{ label: "sessionId", value: "session-alpha" }],
    status: "pending",
    createdAt: now - 60_000,
    expiresAt: now + 59 * 60_000,
    resolvedAt: null,
    ...overrides,
  };
}

function thread(confirmations: AssistantOwnerConfirmation[]): AssistantThread {
  const now = Date.now();
  return {
    id: "thr_fixture", assistant: "wollipog", title: "Ship the Slack Adapter Spike", harness: "codex", sessionId: "session-thread",
    status: confirmations.length ? "needs_you" : "done", access: { level: "full_access", destructive: "ask" },
    connectionId: "asst_fixture", launchedSessionIds: [], confirmations, lastActivityAt: now, createdAt: now - 3_600_000, archivedAt: null,
  };
}

async function serveThreads(page: Page) {
  let pending = [confirmation()];
  const answers: string[] = [];
  await page.route("**/api/assistant-threads", (route) => route.fulfill({ json: { threads: [thread(pending)] } }));
  await page.route("**/api/assistant-threads/*/confirmations/*/*", (route) => {
    const intent = route.request().url().split("/").pop()!;
    answers.push(intent);
    const settled = confirmation(intent === "approve"
      ? { status: "executed", resolvedAt: Date.now(), outcome: { receiptStatus: "succeeded" } }
      : { status: "denied", resolvedAt: Date.now(), outcome: { reason: "The owner denied it." } });
    pending = [];
    return route.fulfill({ json: { confirmation: settled, thread: thread([]) } });
  });
  return { answers };
}

const row = (page: Page) => page.getByRole("region", { name: "Assistant Approvals" }).getByRole("listitem", { name: "Archive Session" });
async function review(page: Page) {
  await row(page).getByRole("button", { name: "Review", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Archive Session" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the Inbox lists a thread's owner confirmation, and Review shows its exact target, impact and arguments before Approve Once runs it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const served = await serveThreads(page);
  await page.goto("/command-inbox-projects-e2e.html?fullShell=1");
  await expect(row(page)).toContainText("Approval Needed");
  await expect(row(page)).toContainText("Ship the Slack Adapter Spike");
  // The compact row leaves the session list its room.
  await expect(page.getByRole("region", { name: "Sessions" }).getByText("Secret Session", { exact: true })).toBeVisible();
  const dialog = await review(page);
  await expect(dialog).toContainText("Approval Needed · Ship the Slack Adapter Spike");
  await expect(dialog.getByRole("definition").filter({ hasText: "Slack Prototype (session-alpha)" })).toBeVisible();
  const args = dialog.locator("dl[aria-label='Arguments']");
  await expect(args).toContainText("sessionId");
  await expect(args).toContainText("session-alpha");
  // Title Case controls.
  for (const name of ["Open Session", "Deny", "Approve Once"]) await expect(dialog.getByRole("button", { name, exact: true })).toBeVisible();
  expect(served.answers).toEqual([]);
  await dialog.getByRole("button", { name: "Approve Once", exact: true }).click();
  await expect(page.getByText("Archive Session ran once.", { exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Assistant Approvals" })).toHaveCount(0);
  expect(served.answers).toEqual(["approve"]);
});

test("Deny refuses the request and removes it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const served = await serveThreads(page);
  await page.goto("/command-inbox-projects-e2e.html?fullShell=1");
  await (await review(page)).getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByText("Archive Session was denied. Nothing ran.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Assistant Approvals" })).toHaveCount(0);
  expect(served.answers).toEqual(["deny"]);
});

test("a control plane without the Thread API shows no approvals", async ({ page }) => {
  await page.route("**/api/assistant-threads", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.goto("/command-inbox-projects-e2e.html?fullShell=1");
  await expect(page.getByRole("region", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Assistant Approvals" })).toHaveCount(0);
});

test("captures the request in both themes at desktop and phone widths", async ({ page }) => {
  test.skip(!EVIDENCE_DIR, "evidence capture only");
  mkdirSync(EVIDENCE_DIR!, { recursive: true });
  await serveThreads(page);
  for (const scheme of ["dark", "light"] as const) {
    for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/command-inbox-projects-e2e.html?fullShell=1");
      await page.evaluate((theme) => localStorage.setItem("wollipog.theme", theme), scheme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await expect(row(page)).toBeVisible();
      await page.screenshot({ path: join(EVIDENCE_DIR!, `inbox-row-${viewport.name}-${scheme}.png`) });
      await review(page);
      await dialogMotionSettled(page);
      await page.screenshot({ path: join(EVIDENCE_DIR!, `inbox-dialog-${viewport.name}-${scheme}.png`) });
    }
  }
});
