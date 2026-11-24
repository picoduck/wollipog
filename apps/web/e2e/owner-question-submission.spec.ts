import { expect, test } from "@playwright/test";
import { installInboxFixture } from "./inbox-production-fixture.js";
import type { WorkflowDecisionView } from "@wollipog/protocol";

test.describe("phone draft lifetime", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const viewport of [{ width: 390, height: 844 }, { width: 412, height: 915 }]) {
    for (const update of ["round-trip", "rerender"] as const) {
      test(`phone Something Else survives ${update} at ${viewport.width}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const bodies: unknown[] = [];
        await page.route("**/api/sessions/*/answer", (route) => {
          bodies.push(route.request().postDataJSON());
          return route.fulfill({ json: { id: "session-questions", status: "running", pendingApproval: null } });
        });
        await page.goto("/agent-questions-e2e.html?set=owner-question&wire=1&composer=1");
        await page.getByRole("button", { name: "Expand Request", exact: true }).click();
        await page.getByRole("radio", { name: /Something Else/ }).click();
        const composer = page.locator(".composer-answer");
        await composer.getByRole("textbox").fill("Keep my phone answer.");
        if (update === "round-trip") {
          await composer.getByRole("button", { name: "Exit Answer Mode", exact: true }).click();
          await page.getByRole("button", { name: "Expand Request", exact: true }).click();
          await page.locator(".request-card").getByRole("button", { name: /Keep my phone answer/ }).click();
        } else {
          await page.evaluate(() => window.rerenderAgentQuestion());
          await page.evaluate(() => window.setAgentQuestionOnline(false));
          await expect(composer.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
          await page.evaluate(() => window.setAgentQuestionOnline(true));
        }
        await expect(composer.getByRole("textbox")).toHaveValue("Keep my phone answer.");
        await composer.getByRole("button", { name: "Next", exact: true }).click();
        await composer.getByRole("button", { name: "Submit Answers", exact: true }).click();
        await expect.poll(() => bodies).toEqual([{ requestId: "ask-1", occurrenceId: "occurrence:ask-1",
          answers: { owner_question_answer: "Keep my phone answer." }, action: "submit" }]);
      });
    }
  }
});

for (const surface of ["card", "composer", "card-to-composer"] as const) {
  test.describe(surface, () => {
  test.use({ hasTouch: surface === "card-to-composer", isMobile: surface === "card-to-composer" });
  for (const answer of ["option", "text", "both", "dismiss"] as const) {
    test(`Owner Question ${surface} preserves ${answer} on the wire`, async ({ page }) => {
      await page.setViewportSize({ width: surface === "card-to-composer" ? 390 : 1280, height: 844 });
      const bodies: unknown[] = [];
      await page.route("**/api/sessions/*/answer", async (route) => {
        bodies.push(route.request().postDataJSON());
        await route.fulfill({ json: { id: "session-questions", status: "running", pendingApproval: null } });
      });
      await page.goto(`/agent-questions-e2e.html?set=owner-question&wire=1&style=${surface === "composer" ? "composer" : "interactive"}${surface === "card-to-composer" ? "&composer=1" : ""}`);
      let card = page.locator(surface === "composer" ? ".composer-answer" : ".request-card");
      if (surface === "card-to-composer") {
        await page.getByRole("button", { name: "Expand Request", exact: true }).click();
      }
      if (answer === "dismiss") {
        await card.getByRole("button", { name: "Dismiss", exact: true }).click();
      } else {
        if (answer === "text") {
          await card.getByRole("radio", { name: /Something Else/ }).click();
          if (surface === "card-to-composer") card = page.locator(".composer-answer");
          await card.getByRole("textbox").fill("Retry twice, then report.");
        } else {
          await card.getByRole("radio", { name: /^Stop and Report/ }).click();
        }
        await card.getByRole("button", { name: "Next", exact: true }).click();
        if (answer === "both") {
          await card.getByRole("textbox").fill("Keep the logs.");
        }
        await card.getByRole("button", { name: "Submit Answers", exact: true }).click();
      }
      await expect.poll(() => bodies).toEqual([{
        requestId: "ask-1", occurrenceId: "occurrence:ask-1",
        action: answer === "dismiss" ? "dismiss" : "submit",
        answers: answer === "dismiss" ? {} : {
          owner_question_answer: answer === "text" ? "Retry twice, then report." : "Stop and Report",
          ...(answer === "both" ? { owner_question_note: "Keep the logs." } : {}),
        },
      }]);
    });
  }
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 412, height: 915 }]) {
test.describe(`Inbox at ${viewport.width}`, () => {
test.use({ viewport, hasTouch: viewport.width < 500, isMobile: viewport.width < 500 });
for (const answer of ["option", "text", "both", "dismiss"] as const) {
  test(`Inbox Owner Question preserves ${answer} on the wire`, async ({ page }) => {
    const fixture = await installInboxFixture(page);
    await page.goto("/index.html");
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    const decision = {
      requestId: "owner", occurrenceId: "workflow_owner", sessionId: "synthetic-1",
      controllingSessionId: "synthetic-1", category: "owner_decision", resourceKey: "owner",
      resourceDigest: "synthetic", authority: "human", policyRevision: 1, status: "pending", createdAt: Date.now(),
      resourceSnapshot: { category: "owner_decision", kind: "question", question: "Which approach should we use?",
        options: [{ optionId: "stop", label: "Stop and Report" }, { optionId: "retry", label: "Retry" }] },
    } satisfies WorkflowDecisionView;
    fixture.updateSession("synthetic-1", { title: "Owner Question Regression", status: "running",
      pendingApproval: { requestId: "workflow_owner", occurrenceId: "workflow_owner", kind: "workflow_decision",
        title: "Owner Question", options: [], async: true, workflowDecision: decision },
      attention: { version: 1, revision: 1, meaningfulAt: Date.now(), result: null,
        humanActions: [{ requestId: "workflow_owner", rank: 3, requestedAt: Date.now() }] },
    });
    const bodies: unknown[] = [];
    const answeredSession = await page.evaluate(async () => (await (await fetch("/api/sessions/synthetic-1")).json()).session);
    await page.route("**/api/sessions/synthetic-1/answer", async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...answeredSession, pendingApproval: null, status: "running" } });
    });
    const row = page.locator(".inbox-row-shell", { hasText: "Owner Question Regression" });
    await row.click();
    if (viewport.width > 500) {
      await page.getByRole("grid").focus();
      await page.keyboard.press("Enter");
    }
    const expand = page.getByRole("button", { name: "Expand Request", exact: true });
    if (viewport.width < 500) await expand.click();
    const card = page.locator(".request-card");
    const open = card.getByRole("button", { name: "Answer", exact: true });
    if (await open.isVisible()) await open.click();
    const composer = page.locator(".composer-answer");
    if (answer === "dismiss") {
      await (await composer.isVisible() ? composer : card).getByRole("button", { name: "Dismiss", exact: true }).click();
    } else {
      let form = await composer.isVisible() ? composer : card;
      if (answer === "text") {
        await form.getByRole("radio", { name: /Something Else/ }).click();
        if (viewport.width < 500) form = composer;
        await form.getByRole("textbox").fill("Use bounded retries.");
      } else await form.getByRole("radio", { name: /^Stop and Report/ }).click();
      await form.getByRole("button", { name: "Next", exact: true }).click();
      if (answer === "both") await form.getByRole("textbox").fill("Keep the logs.");
      await form.getByRole("button", { name: "Submit Answers", exact: true }).click();
    }
    await expect.poll(() => bodies).toEqual([{
      requestId: "workflow_owner", occurrenceId: "workflow_owner", action: answer === "dismiss" ? "dismiss" : "submit",
      answers: answer === "dismiss" ? {} : { owner_question_answer: answer === "text" ? "Use bounded retries." : "Stop and Report",
        ...(answer === "both" ? { owner_question_note: "Keep the logs." } : {}) },
    }]);
  });
}
});
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`an empty submit error stays visible with the answer preserved at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/sessions/*/answer", (route) => route.fulfill({ status: 400,
      json: { error: "Choose an option or type an answer before submitting." } }));
    await page.goto("/agent-questions-e2e.html?set=owner-question&wire=1&style=composer&before=2&after=0");
    const card = page.locator(".composer-answer");
    await card.getByRole("radio", { name: /^Stop and Report/ }).click();
    await card.getByRole("button", { name: "Next", exact: true }).click();
    await card.getByRole("textbox").fill("Keep the logs.");
    await card.getByRole("button", { name: "Submit Answers", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("Couldn't send your answers.");
    await card.getByText("Show Details", { exact: true }).click();
    await expect(card).toContainText("Choose an option or type an answer before submitting.");
    await expect(card.getByRole("textbox")).toHaveValue("Keep the logs.");
    await expect(card.getByRole("button", { name: "Submit Answers", exact: true })).toBeInViewport({ ratio: 1 });
    if (process.env.WOLLIPOG_CAPTURE_OWNER_ANSWER) await page.screenshot({ path: testInfo.outputPath(`owner-answer-error-${viewport.width}.png`) });
  });
}

test.describe("Campaign Status answer", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const width of [390, 412]) {
    test(`Campaign Status phone Something Else at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const bodies: unknown[] = [];
      await page.route("**/api/sessions/*/answer", (route) => {
        bodies.push(route.request().postDataJSON());
        return route.fulfill({ json: { id: "s_root", pendingApproval: null } });
      });
      await page.goto("/campaign-status-e2e.html?scenario=campaign&owners=after&ownerQuestion=1");
      await page.getByRole("button", { name: "Expand All", exact: true }).click();
      await page.getByRole("button", { name: "Open Request: Which credential design should the provider bridge use?", exact: true }).click();
      const card = page.locator(".request-card");
      await card.getByRole("radio", { name: /Something Else/ }).click();
      await card.getByRole("textbox").fill("Keep my campaign answer.");
      await card.getByRole("button", { name: "Next", exact: true }).click();
      await card.getByRole("button", { name: "Submit Answers", exact: true }).click();
      await expect.poll(() => bodies).toEqual([{ requestId: "workflow_owner_1", occurrenceId: "workflow_owner_1",
        answers: { owner_question_answer: "Keep my campaign answer." }, action: "submit" }]);
    });
  }
});
