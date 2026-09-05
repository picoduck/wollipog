import { expect, test, type Locator, type Page } from "@playwright/test";

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

async function expectInsideViewport(locator: Locator, page: Page) {
  const box = await geometry(locator);
  const viewport = page.viewportSize()!;
  expect(box.top).toBeGreaterThanOrEqual(-0.5);
  expect(box.left).toBeGreaterThanOrEqual(-0.5);
  expect(box.right).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box.bottom).toBeLessThanOrEqual(viewport.height + 0.5);
}

async function answerLongSet(page: Page) {
  await page.getByRole("radio", { name: /Canary/ }).click();
  await page.getByRole("checkbox", { name: /Unit Tests/ }).click();
  await page.getByRole("checkbox", { name: /Browser Tests/ }).click();
  await page.getByRole("radio", { name: /Overnight/ }).click();
}

test("desktop questions select and submit the exact current answers", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/agent-questions-e2e.html");

  const submit = page.getByRole("button", { name: "Submit" });
  await expect(submit).toBeDisabled();
  await page.getByRole("radio", { name: /TypeScript/ }).click();
  await expect(submit).toBeEnabled();
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

    await expect(page.getByText("Agent Question Recovery Required")).toBeVisible();
    await expect(page.getByText(/original answer channel is no longer available/)).toBeVisible();
    await expect(page.getByRole("radio", { name: /TypeScript/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Submit" })).toHaveCount(0);
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

    await expect(page.getByText("Agent Question Recovery Required")).toBeVisible();
    await expect(page.getByText(/resume the existing agent conversation and deliver these answers once/)).toBeVisible();
    await expect(page.getByText(/Prior tool calls will not be replayed/)).toBeVisible();
    const choice = page.getByRole("radio", { name: /TypeScript/ });
    await expect(choice).toBeEnabled();
    await expectInsideViewport(choice, page);
    await choice.click();
    await page.getByRole("button", { name: "Submit" }).click();

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

  const submit = page.getByRole("button", { name: "Submit" });
  const unit = page.getByRole("checkbox", { name: /Unit Tests/ });
  const browser = page.getByRole("checkbox", { name: /Browser Tests/ });
  const smoke = page.getByRole("checkbox", { name: /Smoke Test/ });
  await page.getByRole("radio", { name: /Staging/ }).click();
  await page.locator('.question-input[type="password"]').fill("s3cret");
  await page.locator('.question-input[type="number"]').fill("3");

  await unit.click();
  await expect(unit).toBeChecked();
  await expect(submit).toBeDisabled();
  await browser.click();
  await expect(browser).toBeChecked();
  await expect(submit).toBeEnabled();

  await smoke.click();
  await expect(unit).toBeChecked();
  await expect(browser).toBeChecked();
  await expect(smoke).toBeChecked();
  await expect(submit).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveText("Select at most 2 options.");

  await unit.click();
  await expect(unit).not.toBeChecked();
  await expect(browser).toBeChecked();
  await expect(smoke).toBeChecked();
  await expect(submit).toBeEnabled();
  await submit.click();

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
  await response.fill("not offered");
  await response.press("Enter");
  await expect(page.getByRole("alert")).toContainText("displayed number or unambiguous option label");
  await expect(response).toHaveValue("not offered");
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
  await expect(response).toBeDisabled();
  await expect(page.locator(".composer-answer-help")).toContainText("Responses are unavailable until the runner reconnects");
  await page.evaluate(() => window.setAgentQuestionOnline(true));
  await expect(response).toBeEnabled();
  await response.fill("1");
  await response.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Question Answered");
  expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({ language: "TypeScript" });
});

for (const viewport of [
  { name: "mobile portrait", width: 390, height: 844 },
  { name: "mobile landscape", width: 844, height: 390 },
]) {
  test(`an over-height question set uses one natural page scroller in ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-questions-e2e.html?set=long");

    const bar = page.getByRole("region", { name: "Agent Questions" });
    const list = page.locator(".question-list");
    const submit = page.getByRole("button", { name: "Submit" });
    const dismiss = page.getByRole("button", { name: "Dismiss" });
    await expectInsideViewport(submit, page);
    await expectInsideViewport(dismiss, page);

    const overflow = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
    expect(overflow.scrollTop).toBe(0);
    expect(overflow.overflowY).toBe("visible");
    expect((await geometry(bar)).height).toBeGreaterThan(viewport.height);

    await page.getByRole("radio", { name: /Overnight/ }).scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(page.getByRole("radio", { name: /Overnight/ })).toBeInViewport();
    expect(await list.evaluate((element) => element.scrollTop)).toBe(0);

    await answerLongSet(page);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("status")).toHaveText("Question Answered");
    expect(await page.evaluate(() => window.agentQuestionCalls[0]?.answers)).toEqual({
      strategy: "Canary",
      checks: ["Unit Tests", "Browser Tests"],
      window: "Overnight",
    });
  });
}

test("a long history-loading fallback remains reachable inside the fixed session column", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?set=long&slot=1");

  const bar = page.getByRole("region", { name: "Agent Questions" });
  const list = page.locator(".question-list");
  const submit = page.getByRole("button", { name: "Submit" });
  await expectInsideViewport(bar, page);
  await expectInsideViewport(submit, page);
  await expect(list).toHaveCSS("overflow-y", "auto");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole("radio", { name: /Overnight/ }).scrollIntoViewIfNeeded();
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await answerLongSet(page);
  await expect(submit).toBeEnabled();
  await expectInsideViewport(submit, page);
});

test("a replacement request cannot submit retained selections", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html");

  await page.getByRole("radio", { name: /TypeScript/ }).click();
  await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
  await page.evaluate(() => window.replaceAgentQuestion());

  const submit = page.getByRole("button", { name: "Submit" });
  await expect(page.getByText("This is a new request. Choose its answer.")).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  await page.getByRole("radio", { name: /^Fresh Answer / }).click();
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
  await page.getByRole("button", { name: "Submit" }).click();

  const bar = page.getByRole("region", { name: "Agent Questions" });
  await expect(bar).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  await expectInsideViewport(page.getByRole("button", { name: "Submitting…" }), page);
  await page.evaluate(() => window.releaseAgentQuestion());
  await expect(page.getByRole("status")).toHaveText("Question Answered");

  await page.goto("/agent-questions-e2e.html?failure=1");
  await page.getByRole("radio", { name: /TypeScript/ }).click();
  await page.getByRole("button", { name: "Submit" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The runner rejected this answer. Try again.");
  await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
  await expectInsideViewport(alert, page);
  await expectInsideViewport(page.getByRole("button", { name: "Submit" }), page);
});

test("offline questions explain the state and can be dismissed after reconnecting", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/agent-questions-e2e.html?set=long&offline=1");

  await expect(page.getByText(/Runner Offline/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit" })).toBeDisabled();
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  await expect(dismiss).toBeDisabled();
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

  const availability = page.locator(".question-availability");
  await expect(availability).toHaveAttribute("role", "status");
  await expect(availability).toHaveText("");
  await expect(availability).not.toHaveCSS("display", "none");

  await page.evaluate(() => window.setAgentQuestionOnline(false));
  await expect(availability).toHaveText("Responses are unavailable until the runner reconnects.");

  const firstRadio = page.getByRole("radio", { name: /Canary/ });
  const secondRadio = page.getByRole("radio", { name: /Blue-Green/ });
  await expect(firstRadio).toHaveAttribute("aria-disabled", "true");
  await expect(firstRadio).toHaveAttribute("tabindex", "0");
  await expect(secondRadio).toHaveAttribute("tabindex", "-1");
  await expect(page.getByRole("radiogroup", { name: /Choose the release strategy/ }))
    .toHaveAccessibleDescription(/Responses are unavailable until the runner reconnects/);
  await expect(page.getByRole("group", { name: /Select every validation/ }))
    .toHaveAccessibleDescription(/Responses are unavailable until the runner reconnects/);
  await expect(firstRadio).toHaveCSS("cursor", "not-allowed");
  await expect(firstRadio).toHaveCSS("opacity", "0.6");

  await firstRadio.focus();
  await firstRadio.press("ArrowDown");
  await expect(secondRadio).toBeFocused();
  await expect(secondRadio).toHaveAttribute("aria-checked", "false");
  await firstRadio.focus();
  await expect(firstRadio).toBeFocused();
  await firstRadio.press("Space");
  await expect(firstRadio).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("checkbox", { name: /Unit Tests/ })).toHaveAttribute("tabindex", "0");
});
