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
  }]);
});

for (const viewport of [
  { name: "mobile portrait", width: 390, height: 844 },
  { name: "mobile landscape", width: 844, height: 390 },
]) {
  test(`an over-height question set scrolls with fixed response actions in ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/agent-questions-e2e.html?set=long");

    const bar = page.getByRole("region", { name: "Agent Questions" });
    const list = page.locator(".question-list");
    const submit = page.getByRole("button", { name: "Submit" });
    const dismiss = page.getByRole("button", { name: "Dismiss" });
    await expectInsideViewport(bar, page);
    await expectInsideViewport(submit, page);
    await expectInsideViewport(dismiss, page);

    const overflow = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
    expect(overflow.scrollTop).toBe(0);

    const actionsBefore = await geometry(page.locator(".approval-actions"));
    await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole("radio", { name: /Overnight/ })).toBeInViewport();
    const actionsAfter = await geometry(page.locator(".approval-actions"));
    expect(actionsAfter.top).toBeCloseTo(actionsBefore.top, 1);
    expect(actionsAfter.bottom).toBeCloseTo(actionsBefore.bottom, 1);

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

  await firstRadio.focus();
  await expect(firstRadio).toBeFocused();
  await firstRadio.press("Space");
  await expect(firstRadio).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("checkbox", { name: /Unit Tests/ })).toHaveAttribute("tabindex", "0");
});
