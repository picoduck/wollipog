import { expect, test, type Page } from "@playwright/test";

const fixtureUrl = "/command-inbox-projects-e2e.html?scenario=conversation-steering";

async function openSteeringSession(page: Page) {
  await page.goto(fixtureUrl);
  await page.evaluate(() => localStorage.clear());
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".detail-head")).toBeVisible();
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(73);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSupportsSteering("session-alpha", true);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "running",
      activeTurnId: "turn-active",
      queueHeld: false,
    });
  });
  await expect(page.locator(".composer-input")).toBeEnabled();
}

function receipt(page: Page, submissionId: string) {
  return page.locator(`.steering-receipt[data-submission-id="${submissionId}"]`);
}

async function reopenSteeringSession(page: Page) {
  await page.getByRole("button", { name: "Back to Inbox" }).click();
  await page.getByRole("tab", { name: /No Project/ }).click();
  await page.getByRole("button", { name: /No Project Session/ }).click();
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".detail-head")).toBeVisible();
  await expect(page.locator(".composer-input")).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  await openSteeringSession(page);
});

test("Ctrl+Enter steers without an optimistic echo while Enter, Shift+Enter, IME, and slash selection keep their contracts", async ({ page }) => {
  const composer = page.locator(".composer-input");

  await composer.fill("ordinary queue submission");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "ordinary queue submission",
    images: [],
  }]);
  await expect(composer).toHaveValue("");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(0);

  await composer.fill("first line");
  await page.keyboard.press("Shift+Enter");
  await expect(composer).toHaveValue("first line\n");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(0);

  await composer.fill("IME steering guard");
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, ctrlKey: true, isComposing: true });
  await expect(composer).toHaveValue("IME steering guard");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(0);

  await composer.fill("Steer this active turn");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
  const submissionId = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests()[0]!.submissionId);
  await expect(receipt(page, submissionId)).toContainText("Steering…");
  await expect(receipt(page, submissionId).getByText("Steer this active turn", { exact: true })).toBeVisible();
  await expect(page.locator(".timeline").getByText("Steer this active turn", { exact: true })).toHaveCount(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "accepted",
    reason: "accepted",
    emitCanonicalEvent: true,
  }));
  await expect(composer).toHaveValue("");
  await expect(receipt(page, submissionId)).toHaveCount(0);
  await expect(page.locator(".timeline").getByText("Steer this active turn", { exact: true })).toHaveCount(1);

  await composer.fill("/rev");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/review ");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);

  await composer.fill("/rev");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests()[1]?.text)).toBe("/rev");
});

test("ordinary Send and steering are mutually exclusive in both directions", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextPrompt());
  await composer.fill("One ordinary queued prompt");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);

  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredPrompt());
  await expect(composer).toHaveValue("");
});

test("Stop Turn preempts a deferred ordinary Send without losing its settlement", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextPrompt();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextCancelTurn();
  });
  await composer.fill("Ordinary send interrupted by Stop Turn");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);

  await page.keyboard.press("Shift+Escape");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(1);
  await expect(page.getByRole("button", { name: "Stopping Turn" })).toBeDisabled();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredPrompt());
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Stopping Turn" })).toBeDisabled();
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredCancelTurn();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleInterrupted("session-alpha");
  });
  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible();
});

test("Stop Turn preempts a deferred direct Steer", async ({ page }) => {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextCancelTurn();
  });
  await page.locator(".composer-input").fill("Direct steer interrupted by Stop Turn");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);

  await page.keyboard.press("Shift+Escape");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(1);
  await expect(page.getByRole("button", { name: "Stopping Turn" })).toBeDisabled();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "accepted",
    reason: "accepted",
    emitCanonicalEvent: true,
  }));
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredCancelTurn();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleInterrupted("session-alpha");
  });
  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible();
});

test("a deferred ordinary Send reservation stays suppressed across a session remount", async ({ page }) => {
  const submittedText = "Reserved ordinary send content";
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextPrompt());
  await page.locator(".composer-input").fill(submittedText);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);

  await reopenSteeringSession(page);
  const reopenedComposer = page.locator(".composer-input");
  await expect(reopenedComposer).toHaveValue("");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredPrompt());
  await expect(reopenedComposer).toHaveValue("");
  await reopenSteeringSession(page);
  await expect(page.locator(".composer-input")).toHaveValue("");
});

test("a deferred Stop Turn does not leave a remounted session inherited-stuck", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextCancelTurn());
  await page.keyboard.press("Shift+Escape");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(1);
  await expect(page.getByRole("button", { name: "Stopping Turn" })).toBeDisabled();

  await reopenSteeringSession(page);
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredCancelTurn());
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(1);
});

test("a completed earlier steer does not clear a newer composer edit", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());
  await composer.fill("Original steering content");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);

  await composer.fill("Newer draft that must survive");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "accepted",
    reason: "accepted",
    emitCanonicalEvent: true,
  }));
  await expect(composer).toHaveValue("Newer draft that must survive");
  await expect(page.locator(".timeline").getByText("Original steering content", { exact: true })).toHaveCount(1);
});

test("a deferred accepted steer stays reserved and cleared across session remounts", async ({ page }) => {
  const submittedText = "Reserved steering content";
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());
  await page.locator(".composer-input").fill(submittedText);
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);

  await reopenSteeringSession(page);
  const reopenedComposer = page.locator(".composer-input");
  await expect(reopenedComposer).toHaveValue("");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "accepted",
    reason: "accepted",
    emitCanonicalEvent: true,
  }));
  await expect(reopenedComposer).toHaveValue("");
  await expect(page.locator(".timeline").getByText(submittedText, { exact: true })).toHaveCount(1);

  await reopenSteeringSession(page);
  await expect(page.locator(".composer-input")).toHaveValue("");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
});

test("a deferred rejected steer restores its reserved draft after a session remount", async ({ page }) => {
  const submittedText = "Restore this rejected reserved draft";
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());
  await page.locator(".composer-input").fill(submittedText);
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);

  await reopenSteeringSession(page);
  const reopenedComposer = page.locator(".composer-input");
  await expect(reopenedComposer).toHaveValue("");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "rejected",
    reason: "provider_rejected",
    emitCanonicalEvent: false,
  }));
  await expect(reopenedComposer).toHaveValue(submittedText);
  await expect(page.locator(".timeline").getByText(submittedText, { exact: true })).toHaveCount(0);
});

test("an accepted steer settles cleanly across an in-place expanded-to-preview transition", async ({ page }) => {
  const submittedText = "Settle while this detail stays mounted";
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());
  await page.locator(".composer-input").fill(submittedText);
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);

  await page.getByRole("button", { name: "Back to Inbox" }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  await expect(expand).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "accepted",
    reason: "accepted",
    emitCanonicalEvent: true,
  }));

  await expand.click();
  const composer = page.locator(".composer-input");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();

  await composer.fill("Ordinary send after in-place settlement");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
  await expect(composer).toHaveValue("");

  await composer.fill("Steer after in-place settlement");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(2);
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();
});

test("a steering transport failure restores editing without stale draft recovery", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextSteeringRequest());
  await composer.fill("Draft retained after transport failure");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("Simulated steering transport failure", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Draft retained after transport failure");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);

  await composer.fill("");
  await reopenSteeringSession(page);
  const reopenedComposer = page.locator(".composer-input");
  await expect(reopenedComposer).toHaveValue("");

  await reopenedComposer.fill("Steering works after transport failure");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(2);
  await expect(reopenedComposer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();
});

test("steering gates fail closed across protocol, provider, active-turn, held-queue, and per-entry eligibility", async ({ page }) => {
  const composer = page.locator(".composer-input");
  const requests = () => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(72));
  await composer.fill("old runner");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText(/requires protocol v73/i)).toBeVisible();
  await expect.poll(requests).toBe(0);

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(73);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSupportsSteering("session-alpha", false);
  });
  await composer.fill("unsupported provider");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("The active provider has not verified conversation steering support.", { exact: true })).toBeVisible();
  await expect.poll(requests).toBe(0);

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSupportsSteering("session-alpha", true);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { status: "idle", activeTurnId: undefined });
  });
  await composer.fill("no active turn");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("Wait for an active provider turn before steering.", { exact: true })).toBeVisible();
  await expect.poll(requests).toBe(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    status: "running",
    activeTurnId: "turn-active",
    queueHeld: true,
    queued: [
      { id: "queue-ineligible", text: "Workflow-owned", steerable: false, steerDisabledReason: "Workflow-owned prompts cannot be steered." },
      { id: "queue-legacy", text: "Missing projection" },
      { id: "queue-eligible", text: "Eligible prompt", steerable: true },
    ],
  }));
  await composer.fill("held queue");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("Send a normal prompt to resume the held queue before steering.", { exact: true })).toBeVisible();
  await expect.poll(requests).toBe(0);
  await expect(page.getByTestId("queued-prompt-queue-ineligible").getByRole("button", { name: "Steer Queued Message" })).toBeDisabled();
  await expect(page.getByTestId("queued-prompt-queue-legacy").getByRole("button", { name: "Steer Queued Message" })).toBeDisabled();
  await expect(page.getByTestId("queued-prompt-queue-eligible").getByRole("button", { name: "Steer Queued Message" })).toBeDisabled();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { queueHeld: false }));
  await expect(page.getByTestId("queued-prompt-queue-ineligible").getByRole("button", { name: "Steer Queued Message" }))
    .toHaveAttribute("title", "Workflow-owned prompts cannot be steered.");
  await expect(page.getByTestId("queued-prompt-queue-legacy").getByRole("button", { name: "Steer Queued Message" }))
    .toHaveAttribute("title", "This queued message is not eligible for steering.");
  await expect(page.getByTestId("queued-prompt-queue-eligible").getByRole("button", { name: "Steer Queued Message" })).toBeEnabled();
});

test("a pending Stop Turn blocks direct steering and queued promotion", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      queued: [{ id: "queue-during-stop", text: "Do not promote during stop", steerable: true }],
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextCancelTurn();
  });

  await page.keyboard.press("Shift+Escape");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(1);
  await expect(page.getByRole("button", { name: "Stopping Turn" })).toBeDisabled();

  await composer.fill("Do not steer during stop");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(0);
  await expect(page.getByTestId("queued-prompt-queue-during-stop").getByRole("button", { name: "Steer Queued Message" }))
    .toBeDisabled();

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredCancelTurn();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleInterrupted("session-alpha");
  });
  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible();
});

test("queued promotion uses stable queue identity and reconciles one canonical accepted message", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    queued: [{ id: "queue-promote-stable", text: "Promote this exact prompt", steerable: true }],
  }));
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());

  const queued = page.getByTestId("queued-prompt-queue-promote-stable");
  await queued.getByRole("button", { name: "Steer Queued Message" }).click();
  await expect(queued).toContainText("Steering…");
  await expect(queued.getByRole("button", { name: "Steer Queued Message" })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests()[0]?.promotePromptId))
    .toBe("queue-promote-stable");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "accepted",
    reason: "accepted",
    emitCanonicalEvent: true,
  }));
  await expect(queued).toHaveCount(0);
  await expect(page.getByText("Promote this exact prompt", { exact: true })).toHaveCount(1);
});

test("recovered queued-edit attachments become self-contained ordinary draft images", async ({ page }) => {
  await page.evaluate(() => {
    const image = {
      artifactId: "artifact-recovered-image",
      mimeType: "image/png",
      sizeBytes: 68,
      sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
    };
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(99);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      queued: [{
        id: "queue-recovered",
        text: "Changed elsewhere",
        hasImages: true,
        liveQueueObserved: true,
        editable: true,
        editRevision: "newer-revision",
      }],
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.seedQueuedEditRecovery("session-alpha", {
      edit: {
        promptId: "queue-recovered",
        text: "Original queued content",
        images: [],
        editRevision: "original-revision",
        displacedDraft: { text: "Ordinary draft", images: [] },
      },
      draft: { text: "Keep this recovered message", images: [image] },
      error: "The queued message changed before this edit was confirmed.",
    });
  });

  await reopenSteeringSession(page);
  await expect(page.getByText("Recovered Queued Message", { exact: true })).toBeVisible();
  await expect(page.locator(".composer-input")).toHaveValue("Keep this recovered message");
  await expect(page.locator(".image-thumb img")).toBeVisible();

  await page.getByRole("button", { name: "Use as New Message" }).click();
  await expect(page.getByText("Recovered Queued Message", { exact: true })).toHaveCount(0);
  await expect(page.locator(".composer-input")).toHaveValue("Keep this recovered message");
  await expect(page.locator(".image-thumb img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect.poll(() => page.evaluate(async () =>
    (await window.__WOLLIPOG_PROJECT_INBOX_E2E__.composerDraft("session-alpha"))?.images,
  )).toEqual([{
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  }]);
});

test("an oversized recovered attachment set stays recoverable and reports the limit", async ({ page }) => {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(99);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      queued: [{
        id: "queue-recovered-oversized",
        text: "Changed elsewhere",
        hasImages: true,
        liveQueueObserved: true,
        editable: true,
        editRevision: "newer-revision",
      }],
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.seedQueuedEditRecovery("session-alpha", {
      edit: {
        promptId: "queue-recovered-oversized",
        text: "Original queued content",
        images: [],
        editRevision: "original-revision",
        displacedDraft: { text: "Ordinary draft", images: [] },
      },
      draft: {
        text: "Keep this oversized recovered message",
        images: Array.from({ length: 7 }, (_, index) => ({
          artifactId: `artifact-recovered-image-${index}`,
          mimeType: "image/png",
          sizeBytes: 68,
          sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
        })),
      },
      error: "The queued message changed before this edit was confirmed.",
    });
  });

  await reopenSteeringSession(page);
  await expect(page.getByText("Recovered Queued Message", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Use as New Message" }).click();

  await expect(page.getByText("Recovered Queued Message", { exact: true })).toBeVisible();
  await expect(page.locator(".composer-input")).toHaveValue("Keep this oversized recovered message");
  await expect(page.locator(".composer-error")).toContainText("at most 6 images may be attached");
});

test("a definite direct rejection preserves the draft and never creates a transcript bubble", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());
  await composer.fill("Keep this rejected steer as a draft");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
  const submissionId = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests()[0]!.submissionId);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "rejected",
    reason: "provider_rejected",
    emitCanonicalEvent: false,
  }));
  await expect(composer).toHaveValue("Keep this rejected steer as a draft");
  await expect(receipt(page, submissionId)).toContainText("Rejected");
  await expect(page.locator(".timeline").getByText("Keep this rejected steer as a draft", { exact: true })).toHaveCount(0);
});

test("durable receipts render every disposition and uncertain recovery actions", async ({ page }) => {
  await page.evaluate(() => {
    const base = { turnId: "turn-active", source: "direct" as const, hasImages: false, createdAt: 10 };
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      steeringAttempts: [
        { ...base, submissionId: "receipt-pending", text: "Pending content", state: "pending", updatedAt: 11 },
        { ...base, submissionId: "receipt-accepted", text: "Accepted content", state: "accepted", reason: "accepted", updatedAt: 12 },
        { ...base, submissionId: "receipt-converted", text: "Converted content", state: "converted_to_queue", reason: "stale_turn", queuedPromptId: "queue-converted", updatedAt: 13 },
        { ...base, submissionId: "receipt-rejected", text: "Rejected content", state: "rejected", reason: "provider_rejected", updatedAt: 14 },
        { ...base, submissionId: "receipt-uncertain-queue", text: "Uncertain queue content", state: "uncertain", reason: "transport_uncertain", updatedAt: 15 },
        { ...base, submissionId: "receipt-uncertain-dismiss", text: "Uncertain dismiss content", state: "uncertain", reason: "transport_uncertain", updatedAt: 16 },
      ],
    });
  });

  await expect(receipt(page, "receipt-pending")).toContainText("Steering…");
  await expect(receipt(page, "receipt-accepted")).toContainText("Accepted");
  await expect(receipt(page, "receipt-converted")).toContainText("Converted to Queue");
  await expect(receipt(page, "receipt-rejected")).toContainText("Rejected");
  await expect(receipt(page, "receipt-uncertain-queue")).toContainText("Delivery Uncertain");

  await receipt(page, "receipt-uncertain-queue").getByRole("button", { name: "Queue Again" }).click();
  await expect(receipt(page, "receipt-uncertain-queue")).toContainText("Queued Again");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringResolutionRequests()[0]))
    .toMatchObject({ submissionId: "receipt-uncertain-queue", action: "queue_again" });

  await receipt(page, "receipt-uncertain-dismiss").getByRole("button", { name: "Dismiss" }).click();
  await expect(receipt(page, "receipt-uncertain-dismiss")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringResolutionRequests()[1]))
    .toMatchObject({ submissionId: "receipt-uncertain-dismiss", action: "dismiss" });
});

test("concurrent uncertainty resolutions retain independent pending UI", async ({ page }) => {
  await page.evaluate(() => {
    const base = { turnId: "turn-active", source: "direct" as const, createdAt: 10 };
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      steeringAttempts: [
        { ...base, submissionId: "resolve-queue", text: "Queue this", state: "uncertain", reason: "transport_uncertain", updatedAt: 11 },
        { ...base, submissionId: "resolve-dismiss", text: "Dismiss this", state: "uncertain", reason: "transport_uncertain", updatedAt: 12 },
      ],
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResolutions(2);
  });

  const queueReceipt = receipt(page, "resolve-queue");
  const dismissReceipt = receipt(page, "resolve-dismiss");
  await queueReceipt.getByRole("button", { name: "Queue Again" }).click();
  await dismissReceipt.getByRole("button", { name: "Dismiss" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringResolutionRequests().length)).toBe(2);
  await expect(queueReceipt).toHaveAttribute("data-status", "uncertain");
  await expect(queueReceipt.locator(".steering-receipt-actions")).toHaveAttribute("aria-busy", "true");
  await expect(queueReceipt.getByRole("button", { name: "Queue Again" })).toBeDisabled();
  await expect(queueReceipt).toContainText("Queue Again is pending.");
  await expect(dismissReceipt.locator(".steering-receipt-actions")).toHaveAttribute("aria-busy", "true");
  await expect(dismissReceipt.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  await expect(dismissReceipt).toContainText("Dismiss is pending.");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResolution("resolve-queue"));
  await expect(queueReceipt).toContainText("Queued Again");
  await expect(dismissReceipt.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  await expect(dismissReceipt).toContainText("Dismiss is pending.");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResolution("resolve-dismiss"));
  await expect(dismissReceipt).toHaveCount(0);
});

test("rejected receipts stay compact on mobile and clear durably without touching actionable work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const base = { turnId: "turn-active", source: "direct" as const, createdAt: 10 };
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      queued: [{ id: "queued-stays", text: "Keep this queued prompt" }],
      steeringAttempts: [
        ...Array.from({ length: 8 }, (_, index) => ({
          ...base,
          submissionId: `rejected-mobile-${index}`,
          text: `Rejected mobile ${index}`,
          state: "rejected" as const,
          reason: "no_active_provider_turn" as const,
          updatedAt: 20 + index,
        })),
        { ...base, submissionId: "pending-stays", text: "Pending stays", state: "pending" as const, updatedAt: 30 },
        { ...base, submissionId: "uncertain-stays", text: "Uncertain stays", state: "uncertain" as const, reason: "transport_uncertain" as const, updatedAt: 31 },
      ],
    });
  });

  const group = page.locator(".steering-terminal-receipts");
  await expect(group).toBeVisible();
  await expect(group.getByRole("button", { name: /Rejected Receipts/ })).toHaveAttribute("aria-expanded", "false");
  await expect(group).toContainText("8 Rejected Receipts");
  expect((await group.boundingBox())!.height).toBeLessThanOrEqual(48);
  await expect(receipt(page, "pending-stays")).toBeVisible();
  await expect(receipt(page, "uncertain-stays")).toBeVisible();
  await expect(page.getByTestId("queued-prompt-queued-stays")).toBeVisible();

  await group.getByRole("button", { name: "Clear All" }).click();
  await expect(group).toHaveCount(0);
  await expect(receipt(page, "pending-stays")).toBeVisible();
  await expect(receipt(page, "uncertain-stays")).toBeVisible();
  await expect(page.getByTestId("queued-prompt-queued-stays")).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringResolutionRequests()
      .filter((request) => request.action === "dismiss" && request.submissionId.startsWith("rejected-mobile-"))
      .length
  )).toBe(8);

  await page.evaluate(() => {
    const base = { turnId: "turn-active", source: "direct" as const, createdAt: 10 };
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      queued: [{ id: "queued-stays", text: "Keep this queued prompt" }],
      steeringAttempts: Array.from({ length: 8 }, (_, index) => ({
        ...base,
        submissionId: `rejected-mobile-${index}`,
        text: `Rejected mobile ${index}`,
        state: "rejected" as const,
        reason: "no_active_provider_turn" as const,
        resolution: { action: "dismiss" as const, state: "applied" as const },
        updatedAt: 40 + index,
      })),
    });
  });
  await expect(page.locator(".steering-terminal-receipts")).toHaveCount(0);
  await expect(page.getByTestId("queued-prompt-queued-stays")).toBeVisible();
});

test("desktop rejected receipt grouping retains individual dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    const base = { turnId: "turn-active", source: "direct" as const, createdAt: 10 };
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      steeringAttempts: [
        { ...base, submissionId: "desktop-rejected-a", text: "Rejected A", state: "rejected", reason: "provider_rejected", updatedAt: 11 },
        { ...base, submissionId: "desktop-rejected-b", text: "Rejected B", state: "rejected", reason: "provider_rejected", updatedAt: 12 },
      ],
    });
  });

  const group = page.locator(".steering-terminal-receipts");
  await group.getByRole("button", { name: /Rejected Receipts/ }).click();
  await expect(receipt(page, "desktop-rejected-a")).toBeVisible();
  await receipt(page, "desktop-rejected-a").getByRole("button", { name: "Dismiss" }).click();
  await expect(receipt(page, "desktop-rejected-a")).toHaveCount(0);
  await expect(receipt(page, "desktop-rejected-b")).toBeVisible();
});

test("authoritative snapshot replacement restores uncertainty and canonical acceptance without resubmission or duplication", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());
  await composer.fill("Survive reconnect");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
  const submissionId = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests()[0]!.submissionId);

  await page.evaluate(({ submissionId }) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
    steeringAttempts: [{
      submissionId,
      turnId: "turn-active",
      source: "direct",
      text: "Survive reconnect",
      state: "uncertain",
      reason: "transport_uncertain",
      createdAt: 20,
      updatedAt: 21,
    }],
  }), { submissionId });
  await expect(receipt(page, submissionId)).toContainText("Delivery Uncertain");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResult({
    state: "uncertain",
    reason: "transport_uncertain",
    emitCanonicalEvent: false,
  }));

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitSteeringReceipt("session-alpha", {
      submissionId: "accepted-after-reconnect",
      turnId: "turn-active",
      source: "direct",
      text: "Canonical after reconnect",
      state: "accepted",
      reason: "accepted",
      createdAt: 30,
      updatedAt: 31,
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitCanonicalSteeredMessage(
      "session-alpha",
      "Canonical after reconnect",
      "turn-active",
      "accepted-after-reconnect",
    );
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSnapshot();
  });
  await expect(receipt(page, "accepted-after-reconnect")).toHaveCount(0);
  await expect(page.getByText("Canonical after reconnect", { exact: true })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
});
