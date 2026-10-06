import { expect, test, type Locator, type Page } from "@playwright/test";

for (const action of ["submit", "dismiss"] as const) {
  for (const result of ["resolve", "reject"] as const) {
    for (const transition of ["replace", "clear and remount"] as const) {
      test(`late Interactive Form ${action} ${result} cannot disturb a question after ${transition}`, async ({ page }) => {
        await page.setViewportSize(transition === "replace" ? { width: 1280, height: 800 } : { width: 390, height: 844 });
        await page.goto(`/agent-questions-e2e.html?hold=1${result === "reject" ? "&failure=1" : ""}`);
        if (action === "submit") await page.getByRole("radio", { name: /TypeScript/ }).click();
        await page.getByRole("button", { name: action === "submit" ? "Submit Answers" : "Dismiss", exact: true }).click();
        const form = page.getByRole("region", { name: "Agent Questions" });
        await expect(form).toHaveAttribute("aria-busy", "true");
        if (transition === "clear and remount") {
          await page.evaluate(() => window.clearAgentQuestion());
          await expect(form).toHaveCount(0);
        }
        await page.evaluate(() => window.replaceAgentQuestion());
        const fresh = page.getByRole("radio", { name: /Another Fresh Answer/ });
        await fresh.click();
        await expect(fresh).toBeFocused();
        await page.evaluate(() => window.releaseAgentQuestion());
        await expect(fresh).toBeChecked();
        await expect(fresh).toBeFocused();
        await expect(form).toHaveAttribute("aria-busy", "false");
        await expect(page.getByRole("alert")).toHaveCount(0);
        await page.getByRole("button", { name: "Submit Answers", exact: true }).click();
        if (result === "resolve") await expect(page.getByRole("status").filter({ hasText: "Question Answered" })).toHaveCount(1);
        else await expect(page.getByRole("alert")).toContainText("Couldn't send your answers. Try again.");
        expect(await page.evaluate(() => window.agentQuestionCalls.map(({ requestId, action, answers }) => ({ requestId, action, answers })))).toEqual([
          { requestId: "ask-1", action, answers: action === "submit" ? { language: "TypeScript" } : {} },
          { requestId: "ask-2", action: "submit", answers: { replacement: "Another Fresh Answer" } },
        ]);
      });
    }
  }
}

const geometry = (locator: Locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    height: rect.height,
  };
});

test("late composer answers cannot erase a question received after external clearing", async ({ page }) => {
  await page.goto("/agent-questions-e2e.html?style=composer&hold=1");
  const response = page.locator(".composer-answer-input");
  await response.fill("1");
  await response.press("Enter");
  await expect(response).toBeDisabled();
  await page.evaluate(() => window.clearAgentQuestion());
  await expect(response).toHaveCount(0);
  await page.evaluate(() => window.replaceAgentQuestion());
  await expect(response).toBeEnabled();
  await response.fill("2");
  await page.evaluate(() => window.releaseAgentQuestion());
  await expect(response).toHaveValue("2");
  await response.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Question Answered");
  expect(await page.evaluate(() => window.agentQuestionCalls.map(({ requestId, answers }) => ({ requestId, answers })))).toEqual([
    { requestId: "ask-1", answers: { language: "TypeScript" } },
    { requestId: "ask-2", answers: { replacement: "Another Fresh Answer" } },
  ]);
});

async function expectInsideViewport(locator: Locator, page: Page) {
  const box = await geometry(locator);
  const viewport = page.viewportSize()!;
  expect(box.top).toBeGreaterThanOrEqual(-0.5);
  expect(box.left).toBeGreaterThanOrEqual(-0.5);
  expect(box.right).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box.bottom).toBeLessThanOrEqual(viewport.height + 0.5);
}

const signedEvidenceUrl = "https://evidence.example/private/mobile-capture.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=temporary-access-key&X-Amz-Signature=very-long-private-signature#full-resolution";

test("320 px Interactive Form safely formats rich text and keeps resolved questions compact", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/agent-questions-e2e.html?set=rich-single");

  const bar = page.getByRole("region", { name: "Agent Questions" });
  await expect(bar.locator(".question-text strong")).toHaveText("one");
  await expect(bar.locator(".question-text code")).toHaveText("staging");
  await expect(bar.locator(".question-text li")).toHaveCount(2);
  const evidence = bar.getByRole("link", { name: "evidence.example/mobile-capture.png" });
  await expect(evidence).toHaveAttribute("href", signedEvidenceUrl);
  await expect(bar.locator("img, video")).toHaveCount(0);
  expect(await bar.innerText()).not.toContain("X-Amz-Signature");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  await page.getByRole("radio", { name: "Staging" }).click();
  await page.getByRole("button", { name: "Submit Answers" }).click();
  await expect(page.getByRole("status")).toHaveText("Question Answered");
  const history = page.locator(".tl-question");
  await expect(history.locator(".tl-step-title")).toHaveText("Target");
  await expect(history.locator(".tl-step-detail")).toHaveText("Answer: Staging");
  await expect(history.locator(".tl-step-status")).toHaveText("Answered");
  expect((await geometry(history)).height).toBeLessThan(80);
  expect(await history.innerText()).not.toContain("X-Amz-Signature");
  await history.locator("summary").click();
  await expect(history.locator(".tl-question-body")).toBeVisible();
  await expect(history.locator("li.chosen")).toHaveText("Staging (Chosen)");
  await expect(history.getByRole("link", { name: "evidence.example/mobile-capture.png" })).toHaveAttribute("href", signedEvidenceUrl);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("390 px Composer Answer Mode formats multi-question text and discloses the complete outcome", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?set=rich&style=composer");

  const composer = page.locator(".composer-answer");
  await expect(composer.locator(".composer-answer-question strong")).toHaveText("one");
  await expect(composer.locator(".composer-answer-question li")).toHaveCount(2);
  await expect(composer.getByRole("link", { name: "evidence.example/mobile-capture.png" })).toHaveAttribute("href", signedEvidenceUrl);
  expect(await composer.innerText()).not.toContain("X-Amz-Signature");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const input = page.locator(".composer-answer-input");
  await input.fill("1");
  await input.press("Enter");
  await expect(page.getByText("Answering Question 2 of 2")).toBeVisible();
  await input.fill("1, 2");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Question Answered");
  const history = page.locator(".tl-question");
  await expect(history.locator(".tl-step-title")).toHaveText("Target, Checks");
  await expect(history.locator(".tl-step-detail")).toHaveText("Answers: Staging · Unit Tests, Browser Tests");
  expect((await geometry(history)).height).toBeLessThan(80);
  await history.locator("summary").click();
  await expect(history.locator(".tl-question-item")).toHaveCount(2);
  await expect(history.locator("li.chosen")).toHaveText(["Staging (Chosen)", "Unit Tests (Chosen)", "Browser Tests (Chosen)"]);
  await expect(history.getByRole("link", { name: "evidence.example/mobile-capture.png" })).toHaveCount(2);
  await expect(history.locator("img, video")).toHaveCount(0);
  expect(await history.innerText()).not.toContain("X-Amz-Signature");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("desktop questions select and submit the exact current answers", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/agent-questions-e2e.html");

  const card = page.getByRole("region", { name: "Agent Questions" });
  await expect(card.locator(".request-card-head")).toContainText("Question");
  await expect(card.locator(".request-card-head")).toContainText("Claude Code");
  const submit = page.getByRole("button", { name: "Submit Answers" });
  await expect(submit).toBeEnabled();
  await expect(card.locator(".field-error")).toHaveCount(0);
  await submit.click();
  await expect(card.locator(".field-error")).toHaveText("Choose an option.");
  await expect(page.getByRole("radio", { name: /TypeScript/ })).toBeFocused();
  expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
  await page.getByRole("radio", { name: /TypeScript/ }).click();
  await expect(card.locator(".field-error")).toHaveCount(0);
  await submit.click();

  await expect(page.getByRole("status")).toHaveText("Question Answered");
  const calls = await page.evaluate(() => window.agentQuestionCalls);
  expect(calls).toEqual([{
    sessionId: "agent-question-session",
    requestId: "ask-1",
    answers: { language: "TypeScript" },
    action: "submit",
  }]);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`restart recovery stays explicit and dismissible on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-questions-e2e.html?recovery=1");

    await expect(page.locator(".request-card-kind")).toHaveText("Recovery Required");
    await expect(page.getByText(/original answer channel is no longer available/)).toBeVisible();
    await expect(page.getByRole("radio", { name: /TypeScript/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Submit Answers" })).toHaveCount(0);
    await expect(page.locator(".request-card-foot .btn.primary")).toHaveText("Dismiss and Continue");
    await expectInsideViewport(page.getByRole("button", { name: "Dismiss and Continue" }), page);
    await page.getByRole("button", { name: "Dismiss and Continue" }).click();

    await expect(page.getByRole("status")).toHaveText("Question Answered");
    expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([{
      sessionId: "agent-question-session",
      requestId: "ask-1",
      answers: {},
      action: "dismiss",
    }]);
  });

  test(`resumable restart recovery submits its preserved form on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-questions-e2e.html?recovery=1&resume=1");

    await expect(page.locator(".request-card-kind")).toHaveText("Recovery Required");
    await expect(page.getByText(/resume the existing agent conversation and deliver these answers once/)).toBeVisible();
    await expect(page.getByText(/Prior tool calls will not be replayed/)).toBeVisible();
    const choice = page.getByRole("radio", { name: /TypeScript/ });
    await expect(choice).toBeEnabled();
    await expectInsideViewport(choice, page);
    await choice.click();
    await page.getByRole("button", { name: "Submit Answers" }).click();

    await expect(page.getByRole("status")).toHaveText("Question Answered");
    expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([{
      sessionId: "agent-question-session",
      requestId: "ask-1",
      answers: { language: "TypeScript" },
      action: "submit",
    }]);
  });
}

test("desktop Composer Response submits a multi-question flow using only the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/agent-questions-e2e.html?set=forms&style=composer");

  const response = page.locator(".composer-answer-input");
  await expect(page.getByText("Answering Question 1 of 5")).toBeVisible();
  await response.fill("2");
  await response.press("Enter");
  await response.fill("1, Browser Tests");
  await response.press("Enter");
  await response.fill("itHub");
  await response.press("Home");
  await response.press("Shift+G");
  await response.press("End");
  await response.pressSequentially("!");
  await expect(response).toHaveValue("GitHub!");
  await response.press("Enter");
  await expect(response).toHaveAttribute("type", "password");
  await response.fill("s3cret");
  await response.press("Enter");
  await response.fill("3");
  await response.press("Enter");

  await expect(page.getByRole("status")).toHaveText("Question Answered");
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({
    target: "Production",
    checks: ["Unit Tests", "Browser Tests"],
    note: "GitHub!",
    token: "s3cret",
    retries: "3",
  });
});

test("Interactive Form preserves and recovers bounded multi-select choices", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/agent-questions-e2e.html?set=forms");

  const card = page.getByRole("region", { name: "Agent Questions" });
  const next = page.getByRole("button", { name: "Next", exact: true });
  const note = card.locator(".question-step-note");
  await expect(note).toContainText("Question 1 of 5");
  await page.getByRole("radio", { name: /Staging/ }).click();
  await next.click();

  await expect(note).toContainText("Question 2 of 5");
  const unit = page.getByRole("checkbox", { name: /Unit Tests/ });
  const browser = page.getByRole("checkbox", { name: /Browser Tests/ });
  const smoke = page.getByRole("checkbox", { name: /Smoke Test/ });
  await unit.click();
  await browser.click();
  await smoke.click();
  await expect(unit).toBeChecked();
  await expect(browser).toBeChecked();
  await expect(smoke).toBeChecked();
  await expect(card.locator(".field-error")).toHaveCount(0);
  await next.click();
  await expect(note).toContainText("Question 2 of 5");
  await expect(card.locator(".field-error")).toHaveText("Select at most 2 options.");

  await unit.click();
  await expect(unit).not.toBeChecked();
  await expect(card.locator(".field-error")).toHaveCount(0);
  await next.click();
  await expect(note).toContainText("Question 3 of 5");
  await next.click();
  await page.locator('.question-input[type="password"]').fill("s3cret");
  await next.click();
  await page.locator('.question-input[type="number"]').fill("3");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator('.question-input[type="password"]')).toHaveValue("s3cret");
  await next.click();
  await expect(page.locator('.question-input[type="number"]')).toHaveValue("3");
  await page.getByRole("button", { name: "Submit Answers" }).click();

  await expect(page.getByRole("status")).toHaveText("Question Answered");
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({
    target: "Staging",
    checks: ["Browser Tests", "Smoke Test"],
    token: "s3cret",
    retries: "3",
  });
});

test("mobile Composer Response preserves invalid input, focus, and replacement boundaries", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?style=composer");
  const response = page.locator(".composer-answer-input");
  await response.fill(" ");
  await response.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Enter a response");
  await expect(response).toHaveValue(" ");
  await expect(response).toBeFocused();

  await page.evaluate(() => window.replaceAgentQuestion());
  const replacement = page.locator(".composer-answer-input");
  await expect(replacement).toHaveValue("");
  await replacement.fill("1");
  await replacement.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Question Answered");
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({ replacement: "Fresh Answer" });
});

test("Composer Response keeps its draft and focus after a submission error", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?style=composer&failure=1");
  const response = page.locator(".composer-answer-input");
  await response.fill("2");
  await response.press("Enter");
  await expect(page.getByRole("alert")).toContainText("runner rejected this answer");
  await expect(response).toHaveValue("2");
  await expect(response).toBeFocused();
  expect(await page.evaluate(() => window.agentQuestionCalls[0])).toEqual({
    sessionId: "agent-question-session",
    requestId: "ask-1",
    answers: { language: "Python" },
    action: "submit",
  });
});

test("offline Composer Response preserves its draft boundary and recovers after reconnect", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/agent-questions-e2e.html?style=composer&offline=1");
  const response = page.locator(".composer-answer-input");
  await expect(response).toHaveAttribute("aria-disabled", "true");
  await expect(response).toHaveAttribute("readonly", "");
  await expect(page.locator(".composer-answer-help")).toContainText("Responses are unavailable until the runner reconnects");
  await page.evaluate(() => window.setAgentQuestionOnline(true));
  await expect(response).not.toHaveAttribute("aria-disabled", "true");
  await expect(response).not.toHaveAttribute("readonly", "");
  await response.fill("1");
  await response.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Question Answered");
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({ language: "TypeScript" });
});

async function answerLongSet(page: Page) {
  const next = page.getByRole("button", { name: "Next", exact: true });
  await page.getByRole("radio", { name: /Canary/ }).click();
  await next.click();
  await page.getByRole("checkbox", { name: /Unit Tests/ }).click();
  await page.getByRole("checkbox", { name: /Browser Tests/ }).click();
  await next.click();
  await page.getByRole("radio", { name: /Overnight/ }).click();
}

for (const viewport of [
  { name: "mobile portrait", width: 390, height: 844 },
  { name: "mobile landscape", width: 844, height: 390 },
]) {
  test(`a long question set takes one step at a time on the dock, whose body scrolls inside its cap, in ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-questions-e2e.html?set=long");

    await expect(page.locator(".request-dock").getByRole("region", { name: "Agent Questions" })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(5);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    // The dock never takes more than half of the reading column (§13.2), whatever the card holds.
    const slot = await geometry(page.locator(".chat-reading > .session-notice-slot"));
    const reading = await geometry(page.locator(".chat-reading"));
    expect(slot.height).toBeLessThanOrEqual(reading.height * 0.5 + 1);
    // The dock is in view; a card taller than it scrolls inside it (in landscape, the whole card does).
    await expectInsideViewport(page.locator(".request-dock"), page);

    await answerLongSet(page);
    const submit = page.getByRole("button", { name: "Submit Answers" });
    await submit.scrollIntoViewIfNeeded();
    await expectInsideViewport(submit, page);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await submit.click();
    await expect(page.getByRole("status")).toHaveText("Question Answered");
    expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({
      strategy: "Canary",
      checks: ["Unit Tests", "Browser Tests"],
      window: "Overnight",
    });
  });
}

/**
 * The question's visible text: whether any line of it is cut by the title's bottom edge, and whether
 * the title scrolls on its own. A clamped question ends on a whole line (#2683).
 */
const questionText = (card: Locator) => card.locator(".question-text").evaluate((title) => {
  const edge = title.getBoundingClientRect().bottom;
  const walker = title.ownerDocument.createTreeWalker(title, NodeFilter.SHOW_TEXT);
  let cut = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const range = title.ownerDocument.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.height > 0 && rect.top < edge - 0.5 && rect.bottom > edge + 0.5) cut = true;
    }
  }
  return { cut, overflowY: getComputedStyle(title).overflowY, hidden: title.scrollHeight > title.clientHeight + 1 };
});
const showFullQuestion = (card: Locator) => card.getByRole("button", { name: "Show Full Question" });

test("a question taller than the capped card ends on a whole line, and Show Full Question shows it whole with its answers and footer in reach (#2683)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?set=long-text");
  const bar = page.getByRole("region", { name: "Agent Questions" });
  await expectInsideViewport(bar, page);
  // Clamped, the question never scrolls on its own and no line is cut through.
  expect(await questionText(bar)).toEqual({ cut: false, overflowY: "hidden", hidden: true });
  await showFullQuestion(bar).click();
  const showLess = bar.getByRole("button", { name: "Show Less" });
  await expect(showLess).toHaveAttribute("aria-expanded", "true");
  expect(await questionText(bar)).toEqual({ cut: false, overflowY: "visible", hidden: false });
  // The card scrolls the whole question under its footer, inside the dock's cap.
  const submit = bar.getByRole("button", { name: "Submit Answers" });
  const dismiss = bar.getByRole("button", { name: "Dismiss", exact: true });
  for (const control of [submit, dismiss]) {
    await expectInsideViewport(control, page);
    expect((await geometry(control)).bottom).toBeLessThanOrEqual((await geometry(bar)).bottom);
  }
  const [slot, reading] = [await geometry(page.locator(".chat-reading > .session-notice-slot")), await geometry(page.locator(".chat-reading"))];
  expect(slot.height).toBeLessThanOrEqual(reading.height * 0.5 + 1);
  const proceed = page.getByRole("radio", { name: "Proceed" });
  await proceed.scrollIntoViewIfNeeded();
  await expectInsideViewport(proceed, page);
  await proceed.click();
  await expectInsideViewport(submit, page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await submit.click();
  await expect(page.getByRole("status").filter({ hasText: "Question Answered" })).toHaveCount(1);
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({ plan: "Proceed" });
});

test("at 390×844 a paragraph question behind +1 More Request expands and collapses without losing its choice (#2683)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?set=paragraph&more=1");
  const card = dockedCard(page);
  await expect(page.locator(".request-dock-more")).toContainText("+1 More Request");
  expect(await questionText(card)).toEqual({ cut: false, overflowY: "hidden", hidden: true });
  const toggle = showFullQuestion(card);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-controls", await card.locator(".question-text").getAttribute("id") ?? "");
  // The answers keep room under the clamped question: the first is in view without scrolling.
  await expectInsideViewport(card.getByRole("radio", { name: /I Approved It/ }), page);
  await card.getByRole("radio", { name: /Hold It/ }).click();

  await toggle.click();
  expect(await questionText(card)).toEqual({ cut: false, overflowY: "visible", hidden: false });
  await expect(card.locator(".question-text")).toContainText("Did you approve it, or should it wait?");
  for (const name of ["Submit Answers", "Dismiss"]) await expectInsideViewport(card.getByRole("button", { name, exact: true }), page);

  await card.getByRole("button", { name: "Show Less" }).click();
  await expect(showFullQuestion(card)).toHaveAttribute("aria-expanded", "false");
  expect(await questionText(card)).toEqual({ cut: false, overflowY: "hidden", hidden: true });
  await expect(card.getByRole("radio", { name: /Hold It/ })).toBeChecked();
  await card.getByRole("button", { name: "Submit Answers" }).click();
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({ scope: "Hold It" });
});

test("in a short phone column the card scrolls as a whole rather than leaving its answers no room (#2683)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/agent-questions-e2e.html?set=paragraph&more=1");
  const card = dockedCard(page);
  expect(await questionText(card)).toEqual({ cut: false, overflowY: "hidden", hidden: true });
  await expect(showFullQuestion(card)).toBeVisible();
  // Every answer is reachable, and the footer stays at the card's bottom edge.
  const body = await geometry(card.locator(".request-card-body"));
  expect(body.height).toBeGreaterThan(100);
  const change = card.getByRole("radio", { name: /Change the Scope/ });
  await change.scrollIntoViewIfNeeded();
  await expectInsideViewport(change, page);
  await change.click();
  const submit = card.getByRole("button", { name: "Submit Answers" });
  await expectInsideViewport(submit, page);
  expect((await geometry(submit)).bottom).toBeLessThanOrEqual((await geometry(card)).bottom);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await submit.click();
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({ scope: "Change the Scope" });
});

/** The scrolling card's edges (#2698): which hairlines are drawn, and how far the card scrolls. */
const cardEdges = (card: Locator) => card.evaluate((element) => {
  const drawn = (style: CSSStyleDeclaration, side: "Top" | "Bottom") =>
    style.content !== "none" && style[`border${side}Style`] === "solid" && style[`border${side}Width`] === "1px";
  const foot = element.querySelector(".request-card-foot")!;
  return {
    above: drawn(getComputedStyle(element, "::before"), "Bottom"),
    below: drawn(getComputedStyle(foot, "::before"), "Top"),
    range: element.scrollHeight - element.clientHeight,
  };
});

for (const theme of ["dark", "light"] as const) {
  test(`a card scrolling under its footer draws a hairline at each edge it can still scroll past (#2698, ${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto(`/agent-questions-e2e.html?set=paragraph&more=1&theme=${theme}`);
    const card = dockedCard(page);
    // At the start the answers are under the footer: the line above it says so.
    const start = await cardEdges(card);
    expect(start).toMatchObject({ above: false, below: true });
    expect(start.range).toBeGreaterThan(100);
    // Midway both edges have content past them; the lines take no room.
    await card.evaluate((element) => { element.scrollTop = 60; });
    await expect.poll(() => cardEdges(card)).toEqual({ above: true, below: true, range: start.range });
    // At the end nothing is left below.
    await card.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => cardEdges(card)).toEqual({ above: true, below: false, range: start.range });
    // Expanded, the rest of the question and the answers are below again.
    await card.evaluate((element) => { element.scrollTop = 0; });
    await card.getByRole("button", { name: "Show Full Question" }).click();
    await expect.poll(async () => (await cardEdges(card)).below).toBe(true);
  });
}

test("a card whose body scrolls on its own, or that is not capped, draws no edge lines (#2698)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?set=paragraph&more=1");
  const card = dockedCard(page);
  await expect(card).toBeVisible();
  expect(await card.evaluate((element) => element.hasAttribute("data-card-scrolls"))).toBe(false);
  expect(await cardEdges(card)).toMatchObject({ above: false, below: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agent-questions-e2e.html?set=short");
  expect(await cardEdges(dockedCard(page))).toEqual({ above: false, below: false, range: 0 });
});

test("in forced colors the edge lines are still drawn (#2698)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/agent-questions-e2e.html?set=paragraph&more=1");
  const card = dockedCard(page);
  await card.evaluate((element) => { element.scrollTop = 60; });
  await expect.poll(() => cardEdges(card)).toMatchObject({ above: true, below: true });
  const colors = await card.evaluate((element) => [
    getComputedStyle(element, "::before").borderBottomColor,
    getComputedStyle(element.querySelector(".request-card-foot")!, "::before").borderTopColor,
    getComputedStyle(element).backgroundColor,
  ]);
  expect(colors[0]).not.toBe(colors[2]);
  expect(colors[1]).not.toBe(colors[2]);
});

test("on a 1440px desktop a question that fits has no toggle, and a paragraph fits whole (#2683)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const set of ["short", "paragraph"]) {
    await page.goto(`/agent-questions-e2e.html?set=${set}`);
    const card = dockedCard(page);
    await expect(card).toBeVisible();
    expect(await questionText(card)).toEqual({ cut: false, overflowY: "hidden", hidden: false });
    await expect(card.locator(".question-text-toggle")).toHaveCount(0);
    expect(await card.evaluate((element) => element.hasAttribute("data-card-scrolls"))).toBe(false);
  }
});

test("an option label with a long unbroken identifier wraps inside the card at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/agent-questions-e2e.html?set=long-label");
  const card = page.getByRole("region", { name: "Agent Questions" });
  await expect(card.locator(".choice-row").first()).toBeVisible();
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("a replacement request cannot submit retained selections", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html");

  await page.getByRole("radio", { name: /TypeScript/ }).click();
  await page.evaluate(() => window.replaceAgentQuestion());

  const submit = page.getByRole("button", { name: "Submit Answers" });
  await expect(page.getByText("This is a new request. Choose its answer.")).toBeVisible();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  await submit.click();
  await expect(page.locator(".field-error")).toHaveText("Choose an option.");
  expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
  await page.getByRole("radio", { name: /^Fresh Answer/ }).click();
  await submit.click();

  const calls = await page.evaluate(() => window.agentQuestionCalls);
  expect(calls).toEqual([{
    sessionId: "agent-question-session",
    requestId: "ask-2",
    answers: { replacement: "Fresh Answer" },
    action: "submit",
  }]);
});

test("busy and submission-error states stay visible and recoverable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?hold=1");
  await page.getByRole("radio", { name: /TypeScript/ }).click();
  const submit = page.getByRole("button", { name: "Submit Answers" });
  await submit.click();

  const bar = page.getByRole("region", { name: "Agent Questions" });
  await expect(bar).toHaveAttribute("aria-busy", "true");
  // The label stays; BusyButton shows the spinner and refuses another press.
  await expect(submit).toHaveAttribute("aria-busy", "true");
  await expect(submit).toBeDisabled();
  await expect(page.getByText(/Submitting…|Dismissing…/)).toHaveCount(0);
  await expectInsideViewport(submit, page);
  await page.evaluate(() => window.releaseAgentQuestion());
  await expect(page.getByRole("status")).toHaveText("Question Answered");

  await page.goto("/agent-questions-e2e.html?failure=1");
  await page.getByRole("radio", { name: /TypeScript/ }).click();
  await page.getByRole("button", { name: "Submit Answers" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Couldn't send your answers. Try again.");
  await alert.getByRole("button", { name: "Show Details" }).click();
  await expect(alert).toContainText("The runner rejected this answer. Try again.");
  await expect(page.getByRole("radio", { name: /TypeScript/ })).toBeChecked();
  const tryAgain = page.getByRole("button", { name: "Try Again" });
  await expect(tryAgain).toBeEnabled();
  await expectInsideViewport(alert, page);
  await expectInsideViewport(tryAgain, page);
  const [alertBox, footBox] = [await geometry(alert), await geometry(page.locator(".request-card-foot"))];
  expect(alertBox.bottom).toBeLessThanOrEqual(footBox.top);
  await tryAgain.click();
  expect(await page.evaluate(() => window.agentQuestionCalls.length)).toBe(2);
});

test("offline questions explain the state and can be dismissed after reconnecting", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/agent-questions-e2e.html?set=long&offline=1");

  await expect(page.locator(".request-card-reasons")).toHaveText("Responses are unavailable until the runner reconnects.");
  // Reading on is still possible; answering is not.
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled();
  await next.click();
  await next.click();
  await expect(page.getByRole("button", { name: "Submit Answers" })).toBeDisabled();
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  await expect(dismiss).toBeDisabled();
  await dismiss.scrollIntoViewIfNeeded();
  await expectInsideViewport(dismiss, page);

  await page.evaluate(() => window.setAgentQuestionOnline(true));
  await expect(dismiss).toBeEnabled();
  await dismiss.click();
  await expect(page.getByRole("status")).toHaveText("Question Answered");
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({});
});

test("an online question becoming offline remains keyboard-discoverable without accepting responses", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?set=long");

  const card = page.getByRole("region", { name: "Agent Questions" });
  const status = card.locator('[role="status"][aria-atomic="true"]');
  await expect(status).toHaveText("");
  // Empty, the live line takes no room: it cancels the card's gap.
  expect((await geometry(status)).height).toBe(0);

  await page.evaluate(() => window.setAgentQuestionOnline(false));
  await expect(status).toHaveText("Responses are unavailable until the runner reconnects.");
  await expect(page.getByText("Responses are unavailable until the runner reconnects.", { exact: true })).toBeVisible();

  const firstRadio = page.getByRole("radio", { name: /Canary/ });
  const secondRadio = page.getByRole("radio", { name: /Blue-Green/ });
  await expect(firstRadio).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("radiogroup", { name: /Choose the release strategy/ }))
    .toHaveAccessibleDescription(/Responses are unavailable until the runner reconnects/);
  await expect(firstRadio.locator("xpath=ancestor::label[1]")).toHaveCSS("cursor", "not-allowed");

  await firstRadio.focus();
  await firstRadio.press("ArrowDown");
  await expect(secondRadio).toBeFocused();
  await expect(secondRadio).not.toBeChecked();
  await firstRadio.focus();
  await firstRadio.press("Space");
  await expect(firstRadio).not.toBeChecked();
  await firstRadio.press("1");
  await expect(firstRadio).not.toBeChecked();
});

test("every question row reads its outcome and answer without arrows or emoji (#2188)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?set=gallery");
  const rows = page.locator(".tl-question");
  await expect(rows).toHaveCount(7);
  await expect(rows.locator(".tl-step-status")).toHaveText([
    "Answered", "Answered", "Answered", "Answered", "Answered", "Dismissed", "Answered by Policy",
  ]);
  // The question still waiting is its marker, without a status (#2205).
  await expect(page.locator(".ask-marker .ask-marker-title")).toHaveText("Checks");
  await expect(page.locator(".ask-marker .ask-marker-jump")).toHaveCount(0);
  await expect(rows.nth(0).locator(".tl-step-detail")).toHaveText("Answer: Destination 1 (Production)");
  await expect(rows.nth(1).locator(".tl-step-detail")).toHaveText("Answer: Unit Tests, Smoke Test");
  await expect(rows.nth(2).locator(".tl-step-detail")).toHaveText(
    "Answer: “Ship after the Friday freeze, and page the on-call reviewer first.”");
  await expect(rows.nth(3).locator(".tl-step-detail")).toHaveText("Answer not shown");
  await expect(rows.nth(4).locator(".tl-step-title")).toHaveText("Destination, Checks, Note");
  await expect(rows.nth(5).locator(".tl-step-detail")).toHaveCount(0);
  await expect(rows.nth(6).locator(".tl-step-detail")).toHaveText("Answer: Proceed · Policy: Review Sharing and Retries");
  expect(await page.locator("#question-frame").innerText()).not.toMatch(/[→❓]/u);
  for (const row of await rows.all()) {
    const height = (await row.locator("summary").boundingBox())!.height;
    expect(height).toBeGreaterThanOrEqual(28);
    expect(height).toBeLessThan(76);
  }
  // A phone wraps an answer to at most two lines, so a policy's name after its answer stays readable.
  const policyDetail = rows.nth(6).locator(".tl-step-detail");
  const lineHeight = await policyDetail.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
  const detailHeight = (await policyDetail.boundingBox())!.height;
  expect(detailHeight).toBeGreaterThan(lineHeight * 1.5);
  expect(detailHeight).toBeLessThanOrEqual(lineHeight * 2 + 1);

  await rows.nth(1).locator("summary").click();
  await expect(rows.nth(1).locator("li.chosen")).toHaveText(["Unit Tests (Chosen)", "Smoke Test (Chosen)"]);
  await expect(rows.nth(1).getByText("Which checks should run before the release is promoted?")).toHaveCount(1);
  await expect(rows.nth(1).locator(".tl-question-resolution")).toHaveText(/^Answered by you at /);
  await rows.nth(3).locator("summary").click();
  await expect(rows.nth(3).locator(".tl-question-withheld")).toHaveText("Answer not shown");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

for (const width of [1440, 390]) {
  test(`question and governance rows name who answered relative to the viewer at ${width}px (#2527)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/agent-questions-e2e.html?set=resolvers");
    const timeline = page.getByRole("list", { name: "Resolver Rows" });
    const questions = timeline.locator(".tl-question");
    await expect(questions).toHaveCount(3);
    for (const row of await questions.all()) await row.locator("summary").click();
    await expect(questions.locator(".tl-question-resolution")).toHaveText([
      /^Answered by you at /,
      /^Answered by Grace Hopper at /,
      /^Answered by another member at /,
    ]);

    // Approvals are routine work and fold into the turn's work group; expand any such group.
    for (const group of await timeline.getByRole("button", { name: /^Worked/ }).all()) await group.click();
    const decisions = timeline.locator("details.tl-decision");
    await expect(decisions.locator(".tl-decision-outcome")).toHaveText(["Allowed", "Rejected", "Allowed"]);
    await expect(decisions.locator(".tl-decision-by")).toHaveText([
      "by You", "by Grace Hopper", "by Another Member",
    ]);
    for (const decision of await decisions.all()) await decision.locator("summary").click();
    await expect(decisions.locator(".facts dd:nth-of-type(1)")).toHaveText([
      "You", "Grace Hopper", "Another Member",
    ]);

    expect(await page.locator("#question-frame").innerText()).not.toMatch(/user-|device-/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("a single-member installation keeps reading every answer and decision as its own (#2527)", async ({ page }) => {
  await page.goto("/agent-questions-e2e.html?set=resolvers&viewer=solo");
  const timeline = page.getByRole("list", { name: "Resolver Rows" });
  const questions = timeline.locator(".tl-question");
  for (const row of await questions.all()) await row.locator("summary").click();
  await expect(questions.locator(".tl-question-resolution")).toHaveText([
    /^Answered by you at /, /^Answered by you at /, /^Answered by you at /,
  ]);
  for (const group of await timeline.getByRole("button", { name: /^Worked/ }).all()) await group.click();
  await expect(timeline.locator(".tl-decision-by")).toHaveText(["by You", "by You", "by You"]);
});

for (const width of [1280, 390]) {
  for (const style of ["interactive", "composer"]) {
    test(`universal custom responses on ${width}px ${style} preserve each question (#1595)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/agent-questions-e2e.html?set=forms&style=${style}`);
      if (style === "interactive") {
        const input = page.locator(".question-input");
        const next = page.getByRole("button", { name: "Next", exact: true });
        await expect(input).toHaveCount(0);
        await page.getByRole("radio", { name: "Something Else…" }).click();
        await input.fill("Canary");
        await next.click();
        await page.getByRole("checkbox", { name: "Something Else…" }).click();
        await input.fill("Unit Tests");
        await next.click();
        await next.click();
        await input.fill("abc");
        await next.click();
        await input.fill("3");
        await page.getByRole("button", { name: "Submit Answers", exact: true }).click();
      } else {
        const input = page.locator('.composer-answer-input');
        await page.getByRole("button", { name: "Other Response", exact: true }).click();
        await expect(input).toBeFocused();
        await expect(page.getByRole("textbox", { name: "Other Response to Question 1", exact: true })).toBeFocused();
        await input.fill("Canary");
        await input.press("Enter");
        await page.getByRole("button", { name: "Other Response", exact: true }).click();
        await input.fill("Unit Tests");
        await input.press("Enter");
        await input.press("Enter");
        await input.fill("abc");
        await input.press("Enter");
        await input.fill("3");
        await input.press("Enter");
      }
      await expect(page.getByRole("status")).toHaveText("Question Answered");
      expect(await page.evaluate(() => window.agentQuestionCalls[0])).toMatchObject({
        requestId: "ask-1", action: "submit", answers: { target: "Canary", checks: "Unit Tests", token: "abc", retries: "3" },
      });
    });
  }
}

for (const theme of ["dark", "light"] as const) {
  test(`on a fine pointer number keys pick, Enter advances and keycaps show (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/agent-questions-e2e.html?set=long&keys=1&theme=${theme}`);
    const card = page.getByRole("region", { name: "Agent Questions" });
    await expect(card.locator(".choice-row-meta kbd")).toHaveText(["1", "2", "3", "4", "5"]);
    await expect(card.locator(".choice-row-meta kbd").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Next", exact: true }).locator("kbd")).toHaveText("Enter");

    await card.locator(".question-text").focus();
    await page.keyboard.press("2");
    await expect(page.getByRole("radio", { name: /Blue-Green/ })).toBeChecked();
    await page.keyboard.press("Enter");
    await expect(card.locator(".question-step-note")).toContainText("Question 2 of 3");
    await page.keyboard.press("1");
    await page.keyboard.press("3");
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(2);
    await page.keyboard.press("Enter");
    await page.keyboard.press("5");
    await expect(page.getByRole("radio", { name: "Something Else…" })).toBeChecked();
    await expect(page.locator(".question-input")).toBeFocused();
    await page.keyboard.type("At dawn");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("Question Answered");
    expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({
      strategy: "Blue-Green",
      checks: ["Unit Tests", "Accessibility Audit"],
      window: "At dawn",
    });
  });
}

test("Ctrl+Enter submits from the first step", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agent-questions-e2e.html?set=rich&keys=1");
  await page.getByRole("radio", { name: "Production" }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("checkbox", { name: /Unit Tests/ }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".question-step-note")).toContainText("Question 1 of 2");
  await page.getByRole("radio", { name: "Production" }).press("Control+Enter");
  await expect(page.getByRole("status")).toHaveText("Question Answered");
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({
    target: "Production",
    checks: ["Unit Tests"],
  });
});

test.describe("on a coarse pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("rows and footer buttons are 44px targets, keycaps are hidden and descriptions are one line", async ({ page }) => {
    await page.goto("/agent-questions-e2e.html?set=long&keys=1");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const card = page.getByRole("region", { name: "Agent Questions" });
    for (const kbd of await card.locator("kbd").all()) await expect(kbd).toBeHidden();
    for (const box of await card.locator(".choice-row").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))) {
      expect(box).toBeGreaterThanOrEqual(44);
    }
    const descriptions = card.locator(".choice-row-desc");
    const lineHeight = await descriptions.first().evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    for (const height of await descriptions.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))) {
      expect(height).toBeLessThanOrEqual(lineHeight + 1);
    }
    await page.getByRole("radio", { name: /Canary/ }).tap();
    const chosen = card.locator(".choice-row", { has: page.getByRole("radio", { name: /Canary/ }) }).locator(".choice-row-desc");
    expect((await geometry(chosen)).height).toBeGreaterThan(lineHeight * 1.5);
    await page.getByRole("button", { name: "Next", exact: true }).tap();
    for (const name of ["Dismiss", "Back", "Next"]) {
      const target = page.getByRole("button", { name, exact: true });
      expect((await geometry(target)).height).toBeGreaterThanOrEqual(44);
      // Primary text never gives way to secondary text at phone widths.
      expect(await target.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
  });
});

// #2205: the question waits on the request dock; its transcript row is a marker, and the two link
// both ways.
const reader = (page: Page) => page.getByRole("region", { name: "Session Activity" });
const dockedCard = (page: Page) => page.locator(".request-dock").getByRole("region", { name: "Agent Questions" });
const strip = (page: Page) => page.locator(".request-dock .dock-strip");
const marker = (page: Page) => page.locator(".ask-marker");

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`a pending question's row is its marker until answered, then the answered row in the same place, at ${viewport.name} (#2205)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/agent-questions-e2e.html");
    await expect(dockedCard(page)).toBeVisible();
    await expect(reader(page).getByRole("region", { name: "Agent Questions" })).toHaveCount(0);
    await expect(marker(page).locator(".ask-marker-kind")).toHaveText("Question");
    await expect(marker(page).locator(".ask-marker-title")).toHaveText("Language");
    const jump = marker(page).getByRole("button", { name: "Jump to Question", exact: true });
    await expect(jump).toBeVisible();
    if (viewport.width <= 760) await expect(jump.locator(".ask-marker-jump-label")).toBeHidden();
    else await expect(jump).toHaveText("Jump to Question");
    // The live card stays the only amber surface: the marker is a neutral row.
    expect(await marker(page).evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    const row = page.locator("[data-virtual-row]").filter({ has: marker(page) });
    const key = await row.getAttribute("data-virtual-key");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    await page.getByRole("radio", { name: /TypeScript/ }).click();
    await page.getByRole("button", { name: "Submit Answers", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Question Answered");
    await expect(marker(page)).toHaveCount(0);
    await expect(page.locator(".request-dock")).toHaveCount(0);
    await expect(page.locator(`[data-virtual-key="${key}"] .tl-question .tl-step-detail`)).toHaveText("Answer: TypeScript");
  });

  test(`Jump to Question from far up the transcript restores the dock from its strip and focuses its heading at ${viewport.name} (#2205)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/agent-questions-e2e.html?after=60");
    await expect(dockedCard(page)).toBeVisible();
    await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "following");
    await reader(page).hover();
    for (let wheel = 0; wheel < 12 && !(await marker(page).isVisible()); wheel += 1) await page.mouse.wheel(0, -1200);
    await expect(marker(page)).toBeVisible();
    await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "paused");
    await expect(strip(page)).toBeVisible();
    await expect(dockedCard(page)).toBeHidden();

    await marker(page).getByRole("button", { name: "Jump to Question", exact: true }).click();
    await expect(dockedCard(page).getByRole("heading", { name: "Which language should the example use?" })).toBeFocused();
    await expect(strip(page)).toHaveCount(0);
  });

  test(`Show Where Asked puts the marker in the upper third, selected until the next scroll, with the dock as a strip, at ${viewport.name} (#2205)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/agent-questions-e2e.html?after=60");
    const show = dockedCard(page).getByRole("button", { name: "Show Where Asked", exact: true });
    await expect(show).toBeVisible();
    if (viewport.width <= 760) await expect(show.locator(".question-where-asked-label")).toBeHidden();
    else await expect(show).toHaveText("Show Where Asked");
    await show.click();

    await expect(reader(page)).toHaveAttribute("data-follow-tail-state", "paused");
    await expect(strip(page)).toBeVisible();
    await expect(dockedCard(page)).toBeHidden();
    await expect(marker(page)).toHaveAttribute("data-selected", "");
    await expect.poll(async () => {
      const [box, area] = [await geometry(marker(page)), await geometry(reader(page))];
      return box.top >= area.top && box.bottom <= area.top + area.height / 3;
    }).toBe(true);
    // The selected wash (§5.2), not the card's amber.
    expect(await marker(page).evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

    // The reader's next scroll ends the selection.
    await reader(page).hover();
    await page.mouse.wheel(0, -40);
    await expect(marker(page)).not.toHaveAttribute("data-selected", "");

    // The strip restores the card and moves focus to its heading.
    await strip(page).locator(".dock-strip-title").click();
    await expect(dockedCard(page).getByRole("heading", { name: "Which language should the example use?" })).toBeFocused();
  });
}

test("Show Where Asked is disabled with its reason when the question's place isn't in the transcript (#2205)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agent-questions-e2e.html?unloaded=1");
  const show = dockedCard(page).getByRole("button", { name: "Show Where Asked", exact: true });
  await expect(show).toBeDisabled();
  const reason = dockedCard(page).locator(".request-card-reasons").getByText("This question's place in the transcript isn't loaded.");
  await expect(reason).toBeVisible();
  expect(await show.getAttribute("aria-describedby")).toBe(await reason.getAttribute("id"));
});

test.describe("on a phone with the software keyboard open", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("a long question keeps its one-line title and Show Full Question gives way (#2683)", async ({ page }) => {
    await page.goto("/agent-questions-e2e.html?set=paragraph&keyboard=1");
    const card = dockedCard(page);
    await expect(card).toBeVisible();
    const title = card.locator(".question-text");
    const lineHeight = await title.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    expect((await geometry(title)).height).toBeLessThanOrEqual(lineHeight + 1);
    await expect(card.locator(".question-text-toggle")).toBeHidden();
  });

  test("the dock is at most 40% and the card keeps only the question, its answer, Back and the primary (#2205)", async ({ page }) => {
    await page.goto("/agent-questions-e2e.html?set=notes&keyboard=1");
    const card = dockedCard(page);
    await expect(card).toBeVisible();
    const [slot, reading] = [await geometry(page.locator(".chat-reading > .session-notice-slot")), await geometry(page.locator(".chat-reading"))];
    expect(slot.height).toBeLessThanOrEqual(reading.height * 0.4 + 1);
    await expect(card.locator(".request-card-head")).toBeHidden();
    await expect(card.getByRole("button", { name: "Show Where Asked" })).toBeHidden();
    await expect(card.getByRole("button", { name: "Dismiss" })).toBeHidden();
    await expect(card.locator(".question-step-note")).toBeHidden();
    const title = card.locator(".question-text");
    const lineHeight = await title.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    expect((await geometry(title)).height).toBeLessThanOrEqual(lineHeight + 1);

    await card.locator(".question-input").fill("Shipped the dock.");
    await card.getByRole("button", { name: "Next", exact: true }).click();
    await expect(card.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Submit Answers", exact: true })).toBeVisible();

    // The second text field, below the body's fold, scrolls into view within the body alone.
    const body = card.locator(".request-card-body");
    const field = card.locator(".question-input");
    const scrollPositions = () => page.evaluate(() => ({
      page: window.scrollY,
      reader: document.querySelector<HTMLElement>(".detail-scroll")!.scrollTop,
    }));
    const before = await scrollPositions();
    expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
    expect((await geometry(field)).bottom).toBeGreaterThan((await geometry(body)).bottom);
    await field.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
    await expect(field).toBeFocused();
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const [fieldBox, bodyBox] = [await geometry(field), await geometry(body)];
    expect(fieldBox.top).toBeGreaterThanOrEqual(bodyBox.top - 0.5);
    expect(fieldBox.bottom).toBeLessThanOrEqual(bodyBox.bottom + 0.5);
    expect(await scrollPositions()).toEqual(before);
  });

  test("in a 390×500 keyboard-sized viewport the card keeps its frame and footer, and a focused field shows above the footer (#2205)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto("/agent-questions-e2e.html?set=notes&keyboard=1");
    const card = dockedCard(page);
    await expect(card).toBeVisible();
    const dock = page.locator(".request-dock");
    const [slot, reading] = [await geometry(page.locator(".chat-reading > .session-notice-slot")), await geometry(page.locator(".chat-reading"))];
    expect(slot.height).toBeLessThanOrEqual(reading.height * 0.4 + 1);
    const before = await page.evaluate(() => ({ page: window.scrollY, reader: document.querySelector<HTMLElement>(".detail-scroll")!.scrollTop }));
    // On each step: the card's top edge is in the dock, the focused field shows whole above the
    // footer, and the footer's primary is in the dock.
    const expectFrameFieldAndFooter = async (primary: string) => {
      // The title keeps its one line; it may scroll under the card's edge, never collapse.
      const title = card.locator(".question-text");
      const lineHeight = await title.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
      expect((await geometry(title)).height).toBeGreaterThanOrEqual(lineHeight - 1);
      const field = card.locator(".question-input");
      await field.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
      await expect(field).toBeFocused();
      const dockBox = await geometry(dock);
      const within = (box: { top: number; bottom: number }) => {
        expect(box.top).toBeGreaterThanOrEqual(dockBox.top - 0.5);
        expect(box.bottom).toBeLessThanOrEqual(dockBox.bottom + 0.5);
      };
      const [cardBox, fieldBox, footBox] = [await geometry(card), await geometry(field), await geometry(card.locator(".request-card-foot"))];
      expect(cardBox.top).toBeGreaterThanOrEqual(dockBox.top - 0.5);
      within(fieldBox);
      expect(fieldBox.bottom).toBeLessThanOrEqual(footBox.top + 0.5);
      within(await geometry(card.getByRole("button", { name: primary, exact: true })));
      expect(await dock.evaluate((element) => element.scrollTop)).toBe(0);
    };
    await expectFrameFieldAndFooter("Next");
    await card.locator(".question-input").fill("Shipped the dock.");
    await card.getByRole("button", { name: "Next", exact: true }).click();
    await expectFrameFieldAndFooter("Submit Answers");
    await expect(card.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({ page: window.scrollY, reader: document.querySelector<HTMLElement>(".detail-scroll")!.scrollTop }))).toEqual(before);
  });

  test("a choice reached from the keyboard in a narrow short column shows above the card's footer (#2205 review)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 540 });
    await page.goto("/agent-questions-e2e.html?set=long");
    const card = dockedCard(page);
    await expect(card).toBeVisible();
    const reading = await geometry(page.locator(".chat-reading"));
    expect(reading.height).toBeGreaterThanOrEqual(300);
    expect(reading.height).toBeLessThanOrEqual(480);
    const radios = card.getByRole("radio");
    await radios.first().focus();
    for (let index = 0; index < 5; index += 1) {
      if (index > 0) await page.keyboard.press("ArrowDown");
      const focused = radios.nth(index);
      await expect(focused).toBeFocused();
      // The focused choice's marker is in view between the card's edge and its footer (a chosen
      // row shows its whole description, which can be taller than that space; its top comes first).
      const [markerBox, cardBox, footBox] = [await geometry(focused), await geometry(card), await geometry(card.locator(".request-card-foot"))];
      expect(markerBox.top).toBeGreaterThanOrEqual(cardBox.top - 0.5);
      expect(markerBox.bottom).toBeLessThanOrEqual(footBox.top + 0.5);
    }
  });

  test("a focused field compacts the card where the keyboard resizes the layout viewport instead (#2205)", async ({ page }) => {
    // No `keyboard=1`: browsers that resize the layout viewport publish no visual-viewport gap, so
    // the focused field is the signal, as for the dock's 40% cap.
    await page.goto("/agent-questions-e2e.html?set=notes");
    const card = dockedCard(page);
    await expect(card.locator(".request-card-head")).toBeVisible();
    await card.locator(".question-input").focus();
    await expect(card.locator(".request-card-head")).toBeHidden();
    await expect(card.getByRole("button", { name: "Dismiss" })).toBeHidden();
    const title = card.locator(".question-text");
    const lineHeight = await title.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    expect((await geometry(title)).height).toBeLessThanOrEqual(lineHeight + 1);
    const [slot, reading] = [await geometry(page.locator(".chat-reading > .session-notice-slot")), await geometry(page.locator(".chat-reading"))];
    expect(slot.height).toBeLessThanOrEqual(reading.height * 0.4 + 1);
    await card.locator(".question-input").blur();
    await expect(card.locator(".request-card-head")).toBeVisible();
  });

  test("a row or Next tapped while typing in the docked card takes the tap, though the dock regrows on blur (#2205)", async ({ page }) => {
    await page.goto("/agent-questions-e2e.html");
    const card = dockedCard(page);
    await card.getByRole("radio", { name: "Something Else…" }).tap();
    await card.locator(".question-input").fill("Rust");
    await expect(card.locator(".question-input")).toBeFocused();
    const typescript = card.getByRole("radio", { name: /TypeScript/ });
    await typescript.tap();
    await expect(typescript).toBeChecked();
    await expect(card.locator(".question-input")).toHaveCount(0);

    await page.goto("/agent-questions-e2e.html?set=notes");
    await dockedCard(page).locator(".question-input").fill("Shipped the dock.");
    await dockedCard(page).getByRole("button", { name: "Next", exact: true }).tap();
    await expect(dockedCard(page).locator(".question-step-note")).toContainText("Question 2 of 2");
  });

  test("Show Where Asked and Jump to Question are icon buttons named as on desktop, with 44px targets (#2205)", async ({ page }) => {
    await page.goto("/agent-questions-e2e.html");
    const targets = [
      dockedCard(page).getByRole("button", { name: "Show Where Asked", exact: true }),
      marker(page).getByRole("button", { name: "Jump to Question", exact: true }),
    ];
    for (const button of targets) {
      await expect(button).toBeVisible();
      await expect(button.locator("span")).toBeHidden();
      const hit = await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const after = getComputedStyle(element, "::after");
        return {
          width: rect.width - parseFloat(after.left) - parseFloat(after.right),
          height: rect.height - parseFloat(after.top) - parseFloat(after.bottom),
        };
      });
      expect(hit.width).toBeGreaterThanOrEqual(44);
      expect(hit.height).toBeGreaterThanOrEqual(44);
    }
  });
});
