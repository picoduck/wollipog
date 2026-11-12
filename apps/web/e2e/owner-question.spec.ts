import { expect, test, type Page } from "@playwright/test";
import { installInboxFixture } from "./inbox-production-fixture.js";
import type { WorkflowDecisionView } from "@wollipog/protocol";

/** An Owner Question (#4270): a Full Control root's design question for its campaign's owner, asked
 * in the composer like any agent question rather than as an approval. */
const QUESTION = "Should the follow-up issue for the provider bridge keep retrying a failed credential lease, or stop and report it?";

async function openOwnerQuestion(page: Page) {
  await page.goto("/agent-questions-e2e.html?set=owner-question&style=composer");
  const card = page.locator(".composer-answer");
  await expect(card).toBeVisible();
  return card;
}

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
  test(`campaign handoffs appear in the Inbox as Needs Your Input (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await installInboxFixture(page);
    await page.goto("/index.html");
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    const decision: WorkflowDecisionView = {
      requestId: "campaign_handoffs_synthetic", occurrenceId: "workflow_handoffs", sessionId: "synthetic-1",
      controllingSessionId: "synthetic-1", category: "owner_decision", resourceKey: "campaign_handoffs:owner",
      resourceDigest: "synthetic", authority: "human", policyRevision: 3, status: "pending", createdAt: Date.now(),
      resourceSnapshot: { category: "owner_decision", kind: "question", options: [],
        question: "This campaign handed work to you. What should happen next?",
        material: "picoduck/wollipog#4541: Owner Handoff. Reason: A design decision is outside campaign authority. Next action: Choose the supported delivery path. Your answer grants no action authority." },
    };
    fixture.updateSession("synthetic-1", {
      title: "Owner Handoffs — Campaign #4541", fullControlCampaignStatus: "waiting_human",
      pendingApproval: { requestId: decision.occurrenceId, occurrenceId: decision.occurrenceId, title: "Owner Question",
        kind: "workflow_decision", async: true, options: [], workflowDecision: decision },
      attention: { version: 1, revision: 1, meaningfulAt: Date.now(), result: null,
        humanActions: [{ requestId: decision.occurrenceId, rank: 3, requestedAt: Date.now() }] },
    });
    const row = page.locator(".inbox-row-shell", { hasText: "Owner Handoffs — Campaign #4541" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Needs Your Input", { exact: true })).toBeVisible();
    if (process.env.WOLLIPOG_CAPTURE_HANDOFFS) await page.screenshot({ path: `/tmp/4541-inbox-${viewport.name}.png`, fullPage: true });
  });

  test(`campaign handoffs ask for input without approval (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/agent-questions-e2e.html?set=owner-question&style=composer&handoffs=true");
    const card = page.locator(".composer-answer");
    await expect(card).toBeVisible();
    await expect(card.locator(".answer-title")).toHaveText("This campaign handed work to you. What should happen next?");
    await expect(page.getByLabel("Attention: Needs Your Input", { exact: true })).toBeVisible();
    await expect(card.locator(".answer-context")).toContainText("Owner Handoff (human)");
    await expect(card.locator(".answer-context")).toContainText("External Review (external)");
    await expect(card.locator(".answer-context")).toContainText("Your answer grants no action authority.");
    await expect(card.locator("input.composer-answer-input")).toBeEditable();
    await expect(page.getByText("Approval Required")).toHaveCount(0);
    if (process.env.WOLLIPOG_CAPTURE_HANDOFFS) await page.screenshot({ path: `/tmp/4541-handoffs-${viewport.name}.png`, fullPage: true });
  });

  test(`an Owner Question is a composer question card with Markdown background and a Needs Your Input badge (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const card = await openOwnerQuestion(page);
    await expect(card.locator(".answer-title")).toHaveText(QUESTION);

    // The suggested options, the recommended one marked, then Something Else, with a free-text field.
    const options = card.getByRole("radio");
    await expect(options).toHaveCount(3);
    await expect(card.getByRole("radio", { name: /^Retry with Backoff \(Recommended\)/u })).toBeVisible();
    await expect(card.getByRole("radio", { name: /^Stop and Report/u })).toBeVisible();
    await expect(card.getByRole("radio", { name: /^Something Else…/u })).toBeVisible();
    const field = card.locator("input.composer-answer-input");
    await expect(field).toBeVisible();
    await expect(field).toBeEditable();
    await expect(field).toHaveAccessibleName(QUESTION);

    // The background is Markdown: its links are real links, its list a list, not a monospace block.
    const background = card.locator(".answer-context");
    await expect(background.getByRole("link", { name: "design note", exact: true }))
      .toHaveAttribute("href", "https://github.com/picoduck/wollipog/blob/main/docs/campaign-authority.md");
    await expect(background.getByRole("link", { name: "#4244", exact: true }))
      .toHaveAttribute("href", "https://github.com/picoduck/wollipog/issues/4244");
    await expect(background.getByRole("listitem")).toHaveCount(2);
    await expect(background.locator("code, pre, .code-well")).toHaveCount(0);

    // The badge asks for input, never for an approval, and names itself as it reads.
    const status = page.getByRole("group", { name: "Session Status" });
    await expect(status.getByText("Needs Your Input", { exact: true })).toBeVisible();
    await expect(status.getByLabel("Attention: Needs Your Input", { exact: true })).toBeVisible();
    await expect(page.getByText("Approval Required")).toHaveCount(0);
    await expect(page.getByText("Do Not Proceed")).toHaveCount(0);

    // Title Case controls whose accessible names match what they show.
    for (const name of ["Next", "Show Context", "Exit Answer Mode"]) {
      await expect(card.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(card.getByRole("button", { name: "Next", exact: true })).toHaveText("Next");
    await expect(card.getByRole("button", { name: "Show Context", exact: true })).toContainText("Show Context");

    // The question, its answer field and its send control fit together, without scrolling the question away.
    for (const locator of [card.locator(".answer-title"), field, card.getByRole("button", { name: "Next", exact: true })]) {
      await expect(locator).toBeInViewport({ ratio: 1 });
    }
    await field.focus();
    await expect(card.locator(".answer-title")).toBeInViewport();
    await expect(card.getByRole("button", { name: "Next", exact: true })).toBeInViewport({ ratio: 1 });
  });
}

test("the owner answers an Owner Question in their own words, then adds an optional note", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const card = await openOwnerQuestion(page);
  const field = card.locator("input.composer-answer-input");
  await field.fill("Retry twice, then stop and tell me.");
  await card.getByRole("button", { name: "Next", exact: true }).click();
  await expect(card.locator(".answer-title")).toHaveText("Anything to add for the Orchestrator?");
  await card.locator("input.composer-answer-input").fill("Log every retry.");
  await card.getByRole("button", { name: "Submit Answers", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Question Answered" })).toHaveCount(1);
  expect(await page.evaluate(() => window.agentQuestionCalls.map(({ requestId, action, answers }) => ({ requestId, action, answers })))).toEqual([
    { requestId: "ask-1", action: "submit",
      answers: { owner_question_answer: "Retry twice, then stop and tell me.", owner_question_note: "Log every retry." } },
  ]);
  await expect(page.getByRole("group", { name: "Session Status" }).getByText("Needs Your Input")).toHaveCount(0);
});
