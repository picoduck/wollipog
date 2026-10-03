import { expect, test, type Page } from "@playwright/test";

const fixtureUrl = "/command-inbox-projects-e2e.html?scenario=conversation-steering";

async function openSteeringSession(page: Page) {
  await page.goto(fixtureUrl);
  await page.evaluate(() => localStorage.clear());
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-bar")).toBeVisible();
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

/** A steering receipt: a row of the transcript under the message it describes (#2171). */
function receipt(page: Page, submissionId: string) {
  return page.locator(`.detail-scroll .tl-receipt-row[data-submission-id="${submissionId}"]`);
}

async function reopenSteeringSession(page: Page) {
  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await page.getByRole("tab", { name: /No Project/ }).click();
  await page.getByRole("button", { name: /No Project Session/ }).click();
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect(page.locator(".composer-input")).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  await openSteeringSession(page);
});

/** The composer's queue tray (#2178). */
function tray(page: Page) {
  return page.getByRole("region", { name: "Queued Messages" });
}

test("a steering reason every row shares is said once in the tray header, with no Steer or ⓘ on a row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const reason = "Wollipog has not confirmed an active provider turn.";
  await page.evaluate((reason) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    queued: [
      { id: "coordinate-queue", text: "Keep this message and attachment", hasImages: true,
        steerable: false, steerDisabledReason: reason },
      { id: "coordinate-queue-2", text: "And this one", steerable: false, steerDisabledReason: reason },
    ],
  }), reason);
  await expect(tray(page).locator(".queue-count")).toHaveText("2 Queued");
  await expect(tray(page).locator(".queue-note")).toHaveText([reason]);
  await expect(tray(page).getByRole("button", { name: "Steer Queued Message" })).toHaveCount(0);
  await expect(tray(page)).not.toContainText("ⓘ");
  await expect(tray(page).locator(".queue-rows .status")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("steering-explanation.png") });
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    queued: [{ id: "coordinate-queue", text: "Keep this message and attachment", hasImages: true,
      steerable: true }],
  }));
  await expect(tray(page).locator(".queue-note")).toHaveCount(0);
  const row = page.getByTestId("queued-prompt-coordinate-queue");
  await expect(row.getByRole("button", { name: "Steer Queued Message" })).toBeEnabled();
  await expect(row).toContainText("Keep this message and attachment");
});

test("on a phone each queued row keeps 250px for its text and one 44px actions button that opens every action", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    queued: [
      { id: "queue-eligible", text: "Run the integration suite after the migration lands", steerable: true,
        liveQueueObserved: true, editable: true, editRevision: "r1" },
      { id: "queue-ineligible", text: "Workflow-owned follow-up", steerable: false,
        steerDisabledReason: "Workflow-owned prompts cannot be steered.", liveQueueObserved: true },
      { id: "queue-steering", text: "Already on its way", steeringState: "promoting" },
    ],
  }));
  await expect(tray(page).locator(".queue-count")).toHaveText("3 Queued");
  for (const id of ["queue-eligible", "queue-ineligible", "queue-steering"]) {
    const row = page.getByTestId(`queued-prompt-${id}`);
    const buttons = row.getByRole("button");
    await expect(buttons).toHaveCount(1);
    await expect(buttons).toHaveAccessibleName("Queued Message Actions");
    const button = await buttons.boundingBox();
    expect(button?.width).toBe(44);
    expect(button?.height).toBe(44);
    const text = await row.locator(".queue-text").boundingBox();
    expect(text?.width ?? 0).toBeGreaterThanOrEqual(250);
  }
  await expect(page.getByTestId("queued-prompt-queue-steering").locator(".status")).toHaveText("Steering…");

  await page.getByTestId("queued-prompt-queue-ineligible").getByRole("button", { name: "Queued Message Actions" }).click();
  const sheet = page.getByRole("menu", { name: "Queued Message Actions" });
  await expect(sheet).toBeVisible();
  const items = sheet.getByRole("menuitem");
  await expect(items.locator(".menu-text")).toHaveText(["Steer into This Turn", "Edit Message", "Cancel Message"]);
  const steer = items.filter({ hasText: "Steer into This Turn" });
  await expect(steer).toHaveAttribute("aria-disabled", "true");
  await expect(steer.locator(".menu-desc")).toHaveText("Workflow-owned prompts cannot be steered.");
  await expect(items.filter({ hasText: "Edit Message" }).locator(".menu-desc")).not.toHaveText("");
  await page.screenshot({ path: test.info().outputPath("phone-queue-actions.png") });
  // An unavailable item stays reachable so its reason is heard, and choosing it does nothing.
  await steer.dispatchEvent("click");
  await expect(sheet).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  await page.getByTestId("queued-prompt-queue-eligible").getByRole("button", { name: "Queued Message Actions" }).click();
  await expect(sheet.getByRole("menuitem", { name: "Steer into This Turn" })).not.toHaveAttribute("aria-disabled", "true");
  await sheet.getByRole("menuitem", { name: "Steer into This Turn" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests()[0]?.promotePromptId))
    .toBe("queue-eligible");
});

test("a failed delivery shows its reason in the notice slot and keeps its badge and Dismiss on the row", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    queued: [
      { id: "queue-failed", text: "Ship the release notes today", steerable: false,
        durableDeliveryState: "failed", durableDeliveryError: "The machine restarted before it took the message." },
      { id: "queue-next", text: "Then tag the build", steerable: true, liveQueueObserved: true },
    ],
  }));
  const notice = page.getByRole("alert", { name: "Message Not Delivered" });
  await expect(notice).toContainText(
    "\u201cShip the release notes today\u201d wasn't delivered. The machine restarted before it took the message.",
  );
  await expect(notice.getByRole("button", { name: "Dismiss Failed Message" })).toBeEnabled();
  const row = page.getByTestId("queued-prompt-queue-failed");
  await expect(row.locator(".status")).toHaveText("Delivery Failed");
  await expect(row).not.toContainText("The machine restarted");
  await expect(row.getByRole("button", { name: "Dismiss Failed Message" })).toBeEnabled();
  await expect(page.getByTestId("queued-prompt-queue-next").locator(".status")).toHaveCount(0);
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
  // Ctrl+Enter is ignored until the ordinary send releases the composer, which follows its
  // provider receipt by its draft bookkeeping; Send enables at exactly that point.
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests().length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
  const submissionId = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringRequests()[0]!.submissionId);
  await expect(receipt(page, submissionId)).toContainText("Sending");
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
  // The settled steer holds the composer through the same bookkeeping.
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
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
  // The deferred send resumes at once, so the stopped turn, still the newest, keeps no footer yet.
  await expect(page.getByText("Interrupted", { exact: true })).toHaveCount(0);
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
  await expect(page.locator(".tl-turn-stopped").last()).toContainText("Stopped at");
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

  await page.getByRole("button", { name: "Back to Sessions" }).click();
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
  // A request that never got an answer reads in plain words, with Retry (#2156).
  const notSent = page.locator(".session-notice-slot").getByRole("alert", { name: "Message Not Sent" });
  await expect(notSent.locator(".notice-body")).toHaveText(/^Couldn't send your message\. .+ stopped responding\. Your draft is kept\.$/);
  await expect(notSent.getByRole("button", { name: "Retry" })).toBeVisible();
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
  await expect(page.getByText(/needs a newer runner for conversation steering\. Update and restart the runner\./)).toBeVisible();
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
  await expect(page.getByRole("alert", { name: "Message Not Sent" }).locator(".notice-body")).toHaveText(
    "Wait for the active turn to settle or resolve the visible control-plane decision before steering.",
  );
  await expect.poll(requests).toBe(0);
  // A held queue is said once, in the tray's header, and no row offers Steer (#2178).
  await expect(tray(page).locator(".queue-head .status")).toHaveText("Held");
  await expect(tray(page).locator(".queue-rows .status")).toHaveCount(0);
  await expect(tray(page).getByRole("button", { name: "Steer Queued Message" })).toHaveCount(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { queueHeld: false }));
  await expect(tray(page).locator(".queue-head .status")).toHaveCount(0);
  // Rows that differ: only the eligible one offers Steer.
  await expect(page.getByTestId("queued-prompt-queue-ineligible").getByRole("button", { name: "Steer Queued Message" }))
    .toHaveCount(0);
  await expect(page.getByTestId("queued-prompt-queue-legacy").getByRole("button", { name: "Steer Queued Message" }))
    .toHaveCount(0);
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
    .toHaveCount(0);
  await expect(tray(page).locator(".queue-note")).toHaveText(["Wait for the current stop request to settle before steering."]);

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredCancelTurn();
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleInterrupted("session-alpha");
  });
  // The promoted prompt resumes at once, so the stopped turn, still the newest, keeps no footer yet.
  await expect(page.getByText("Interrupted", { exact: true })).toHaveCount(0);
});

test("queued promotion uses stable queue identity and reconciles one canonical accepted message", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    queued: [{ id: "queue-promote-stable", text: "Promote this exact prompt", steerable: true }],
  }));
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSteeringResult());

  const queued = page.getByTestId("queued-prompt-queue-promote-stable");
  await queued.getByRole("button", { name: "Steer Queued Message" }).click();
  await expect(queued.locator(".status")).toHaveText("Steering…");
  await expect(queued.getByRole("button", { name: "Steer Queued Message" })).toHaveCount(0);
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
  await expect(page.locator(".attach-thumb img")).toBeVisible();

  await page.getByRole("button", { name: "Use as New Message" }).click();
  await expect(page.getByText("Recovered Queued Message", { exact: true })).toHaveCount(0);
  await expect(page.locator(".composer-input")).toHaveValue("Keep this recovered message");
  await expect(page.locator(".attach-thumb img")).toHaveAttribute("src", /^data:image\/png;base64,/);
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
  await expect(page.locator('.session-notice-slot .notice.t-danger[role="alert"]')).toContainText("at most 6 images may be attached");
});

/** One editable queued message on a runner that can edit queued messages. */
async function seedEditableQueue(page: Page) {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(99);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      queued: [
        { id: "queue-edit", text: "Run the integration suite after the migration lands", steerable: true,
          liveQueueObserved: true, editable: true, editRevision: "r1" },
        { id: "queue-other", text: "Then summarize the failures", steerable: true,
          liveQueueObserved: true, editable: true, editRevision: "r2" },
      ],
    });
  });
}

/** A recovered edit whose queued message changed elsewhere, so it can't be retried. */
async function seedStaleRecoveredEdit(page: Page) {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(99);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      queued: [{ id: "queue-recovered", text: "Changed elsewhere", liveQueueObserved: true, editable: true,
        editRevision: "newer-revision" }],
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.seedQueuedEditRecovery("session-alpha", {
      edit: {
        promptId: "queue-recovered",
        text: "Original queued content",
        images: [],
        editRevision: "original-revision",
        displacedDraft: { text: "Ordinary draft", images: [] },
      },
      draft: { text: "Keep this recovered message", images: [] },
    });
  });
}

/** The visible height of a control and the height its coarse-pointer `::after` reaches (§2.8). */
async function hitArea(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const after = getComputedStyle(element, "::after");
    return {
      visual: box.height,
      hit: box.height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom),
    };
  });
}

test("editing a queued message is a 40px strip in the card, a check in the Send seat and the selected row (#2194)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedEditableQueue(page);
  await page.locator(".composer-input").fill("Unsent local draft");
  await page.getByTestId("queued-prompt-queue-edit").getByRole("button", { name: "Edit Queued Message" }).click();
  await expect(page.locator(".composer-input")).toHaveValue("Run the integration suite after the migration lands");

  const strip = page.locator(".composer-box > .composer-mode");
  await expect(strip).toBeVisible();
  await expect(strip.locator(".composer-mode-title")).toHaveText("Editing Queued Message");
  await expect(strip.locator("kbd")).toHaveText("Enter");
  expect((await strip.boundingBox())?.height).toBe(40);
  await expect(page.locator(".composer > .composer-mode, .queued-edit-banner")).toHaveCount(0);

  const save = page.getByRole("button", { name: "Save Queued Message", exact: true });
  await expect(save.locator("svg.lucide-check")).toHaveCount(1);
  await expect(save).toHaveAttribute("title", "Save queued message (Enter)");
  await expect(save).toHaveClass(/\bprimary\b/);

  const edited = page.getByTestId("queued-prompt-queue-edit");
  await expect(edited).toHaveAttribute("aria-current", "true");
  await expect(tray(page).locator('[aria-current="true"]')).toHaveCount(1);
  const fills = await edited.evaluate((row) => {
    const probe = document.createElement("div");
    probe.style.background = "var(--surface-selected)";
    row.append(probe);
    const selected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { row: getComputedStyle(row).backgroundColor, selected, bar: getComputedStyle(row, "::before").width };
  });
  expect(fills.row).toBe(fills.selected);
  expect(fills.bar).toBe("2px");
  await page.screenshot({ path: test.info().outputPath("queued-edit-desktop.png") });

  // Escape with no picker open cancels the edit and restores the displaced draft, like Cancel Edit.
  await page.locator(".composer-input").press("Escape");
  await expect(strip).toHaveCount(0);
  await expect(page.locator(".composer-input")).toHaveValue("Unsent local draft");
  await expect(tray(page).locator('[aria-current="true"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true }).locator("svg.lucide-arrow-up")).toHaveCount(1);
});

test("a recovered edit that can't be retried says why in the strip, and Save is described by it (#2194)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedStaleRecoveredEdit(page);
  await reopenSteeringSession(page);
  const strip = page.locator(".composer-box > .composer-mode.is-recovered");
  await expect(strip.locator(".composer-mode-title")).toHaveText("Recovered Queued Message");
  const reason = strip.locator(".composer-mode-reason");
  await expect(reason).toHaveText(
    "This queued message changed elsewhere. The recovered edit cannot overwrite its newer revision.");
  await expect(strip.locator("kbd")).toHaveCount(0);
  const save = page.getByRole("button", { name: "Save Queued Message", exact: true });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAccessibleDescription(
    "This queued message changed elsewhere. The recovered edit cannot overwrite its newer revision.");
  await expect(strip.getByRole("button", { name: "Use as New Message" })).toBeEnabled();
  await expect(strip.getByRole("button", { name: "Dismiss Recovery" })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("queued-edit-recovered-desktop.png") });
});

test.describe("on a coarse pointer", () => {
  test.use({ hasTouch: true });

  test("the queued-edit strip stays 40px at 390px and Cancel Edit has a 44px hit area (#2194)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedEditableQueue(page);
    await page.getByTestId("queued-prompt-queue-edit").getByRole("button", { name: "Queued Message Actions" }).click();
    await page.getByRole("menu", { name: "Queued Message Actions" }).getByRole("menuitem", { name: "Edit Message" }).click();
    const strip = page.locator(".composer-box > .composer-mode");
    await expect(strip.locator(".composer-mode-title")).toHaveText("Editing Queued Message");
    expect((await strip.boundingBox())?.height).toBe(40);
    // Keycaps are for a keyboard: a touch pointer hides the save hint.
    await expect(strip.locator(".shortcut-hint")).toBeHidden();
    expect(await hitArea(page, "Cancel Edit")).toEqual({ visual: 36, hit: 46 });
    await expect(page.getByTestId("queued-prompt-queue-edit")).toHaveAttribute("aria-current", "true");
    await page.screenshot({ path: test.info().outputPath("queued-edit-phone.png") });

    await page.getByRole("button", { name: "Cancel Edit", exact: true }).click();
    await expect(strip).toHaveCount(0);
  });

  /**
   * Every visible control in the composer column with the area it answers to: its border box, grown
   * by a `::after` hit area, which is placed from the padding edge, so the border is added back.
   */
  async function composerTouchAreas(page: Page) {
    return page.locator(".composer button").evaluateAll((buttons) => buttons
      .filter((button) => (button as HTMLElement).offsetParent !== null)
      .map((button) => {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const after = getComputedStyle(button, "::after");
        const grow = (inset: string, border: string) =>
          after.content === "none" ? 0 : Math.max(0, -(Number.parseFloat(inset) || 0) - Number.parseFloat(border));
        return {
          name: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
          inStrip: button.closest(".composer-mode") !== null,
          top: box.top - grow(after.top, style.borderTopWidth),
          bottom: box.bottom + grow(after.bottom, style.borderBottomWidth),
          left: box.left - grow(after.left, style.borderLeftWidth),
          right: box.right + grow(after.right, style.borderRightWidth),
        };
      }));
  }

  /** The strip's actions each answer to at least 44px, and to no area another control answers to. */
  async function expectStripTouchAreasOwnTheirTaps(page: Page) {
    const areas = await composerTouchAreas(page);
    const strip = areas.filter((area) => area.inStrip);
    expect(strip.length).toBeGreaterThan(0);
    for (const action of strip) {
      expect(action.bottom - action.top, `${action.name} keeps a 44px touch area`).toBeGreaterThanOrEqual(44);
      for (const other of areas) {
        if (other === action) continue;
        const overlap = Math.min(action.bottom, other.bottom) - Math.max(action.top, other.top) > 0.01 &&
          Math.min(action.right, other.right) - Math.max(action.left, other.left) > 0.01;
        expect(overlap, `${action.name}'s touch area overlaps ${other.name}'s`).toBe(false);
      }
    }
  }

  // The tray docks on the card above the strip, and a pending question's Respond can sit just below
  // it. A tap meant for either must never cancel the edit (§2.8).
  for (const width of [1000, 390]) {
    test(`at ${width}px the strip's touch areas stay clear of the queued row above and Respond below (#2194)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await seedEditableQueue(page);
      if (width <= 760) {
        await page.getByTestId("queued-prompt-queue-edit").getByRole("button", { name: "Queued Message Actions" }).click();
        await page.getByRole("menu", { name: "Queued Message Actions" }).getByRole("menuitem", { name: "Edit Message" })
          .click();
      } else {
        await page.getByTestId("queued-prompt-queue-edit").getByRole("button", { name: "Edit Queued Message" }).click();
      }
      await expect(page.locator(".composer-box > .composer-mode")).toBeVisible();
      await expectStripTouchAreasOwnTheirTaps(page);

      await page.evaluate(() => {
        localStorage.setItem("wollipog.question-response-style", "composer");
        window.dispatchEvent(new Event("wollipog:question-response-style-change"));
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
          pendingApproval: {
            requestId: "question:steering:1",
            kind: "question",
            title: "Choose a release target",
            options: [],
            questions: [{
              id: "target",
              question: "Which environment should receive the release?",
              options: [{ label: "Staging" }, { label: "Production" }],
            }],
          },
        });
      });
      await expect(page.getByRole("button", { name: "Respond", exact: true })).toBeVisible();
      await expect(page.locator(".composer-box > .composer-mode")).toBeVisible();
      await expectStripTouchAreasOwnTheirTaps(page);
    });
  }

  test("a recovered edit's Use as New Message and Dismiss Recovery each have a 44px hit area at 390px (#2194)", async ({ page }) => {
    await seedStaleRecoveredEdit(page);
    await reopenSteeringSession(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const strip = page.locator(".composer-box > .composer-mode.is-recovered");
    await expect(strip.locator(".composer-mode-reason")).toBeVisible();
    for (const name of ["Use as New Message", "Dismiss Recovery"]) {
      expect(await hitArea(page, name)).toEqual({ visual: 36, hit: 46 });
    }
    // The strip's content stays inside the card on a phone.
    const [card, actions] = await Promise.all([
      page.locator(".composer-box").boundingBox(),
      strip.locator(".composer-mode-actions").boundingBox(),
    ]);
    expect((actions?.x ?? 0) + (actions?.width ?? 0)).toBeLessThanOrEqual((card?.x ?? 0) + (card?.width ?? 0));
    // Side by side, under the sentence, or on the strip's first row: no action shares a tap.
    await expectStripTouchAreasOwnTheirTaps(page);
    await page.screenshot({ path: test.info().outputPath("queued-edit-recovered-phone.png") });
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(strip.locator(".composer-mode-actions")).toBeVisible();
    await expectStripTouchAreasOwnTheirTaps(page);
  });
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
  await expect(receipt(page, submissionId)).toContainText("Not Accepted");
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

  await expect(receipt(page, "receipt-pending")).toContainText("Sending");
  await expect(receipt(page, "receipt-accepted")).toContainText("Steered the Current Turn");
  await expect(receipt(page, "receipt-converted")).toContainText("Queued");
  await expect(receipt(page, "receipt-converted")).toContainText("The turn ended before this could steer it.");
  await expect(receipt(page, "receipt-rejected")).toContainText("Not Accepted");
  await expect(receipt(page, "receipt-rejected")).toContainText("The agent didn't accept this message.");
  // Receipts are rows of the transcript, so the composer column holds none of them.
  await expect(page.locator(".composer .tl-receipt-row")).toHaveCount(0);
  await expect(page.locator(".detail-scroll")).not.toContainText("Direct Steering");
  await expect(receipt(page, "receipt-uncertain-queue")).toContainText("Delivery Uncertain");

  await receipt(page, "receipt-uncertain-queue").getByRole("button", { name: "Queue Again" }).click();
  await expect(receipt(page, "receipt-uncertain-queue")).toContainText("Waiting for the next turn.");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringResolutionRequests()[0]))
    .toMatchObject({ submissionId: "receipt-uncertain-queue", action: "queue_again" });

  await receipt(page, "receipt-uncertain-dismiss").getByRole("button", { name: "Dismiss" }).click();
  await expect(receipt(page, "receipt-uncertain-dismiss")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringResolutionRequests()[1]))
    .toMatchObject({ submissionId: "receipt-uncertain-dismiss", action: "dismiss" });
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`completed Queue Again receipts reconcile and dismiss safely at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      const base = {
        turnId: "turn-original", source: "direct" as const, state: "uncertain" as const,
        reason: "transport_uncertain" as const, createdAt: 10,
      };
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
        queued: [
          { id: "queue-delivered", text: "Repeated prompt text" },
          { id: "queue-manual", text: "Keep this queued prompt" },
        ],
        steeringAttempts: [
          { ...base, submissionId: "queue-again-delivered", text: "Repeated prompt text", updatedAt: 11,
            resolution: { action: "queue_again", state: "applied", queuedPromptId: "queue-delivered" } },
          { ...base, submissionId: "queue-again-manual", text: "Keep this queued prompt", updatedAt: 12,
            resolution: { action: "queue_again", state: "applied", queuedPromptId: "queue-manual" } },
        ],
      });
    });

    const completedGroup = page.locator('[data-terminal-status="queued_again"]');
    await expect(completedGroup).toBeVisible();
    await expect(completedGroup).toContainText("2 messages");
    expect((await completedGroup.boundingBox())!.height).toBeLessThanOrEqual(48);
    await completedGroup.getByRole("button", { name: "Show All" }).click();
    const delivered = receipt(page, "queue-again-delivered");
    const manual = receipt(page, "queue-again-manual");
    await expect(delivered).toContainText("Waiting for the next turn.");
    await expect(delivered).not.toContainText("couldn't confirm");
    await expect(manual.getByRole("button", { name: "Dismiss" })).toBeVisible();
    await expect(manual.getByRole("button", { name: "Queue Again" })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`queue-again-settled-${viewport.width}.png`) });

    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage(
      "session-alpha", "Repeated prompt text", "queue-other",
    ));
    await expect(delivered).toBeVisible();
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage(
      "session-alpha", "Canonical delivered prompt", "queue-delivered",
    ));
    await expect(delivered).toHaveCount(0);

    await manual.getByRole("button", { name: "Dismiss" }).click();
    await expect(manual).toHaveCount(0);
    await expect(page.getByTestId("queued-prompt-queue-manual")).toContainText("Keep this queued prompt");
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.steeringResolutionRequests().at(-1)
    )).toMatchObject({ submissionId: "queue-again-manual", action: "dismiss" });
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSnapshot());
    await expect(manual).toHaveCount(0);
    await expect(page.getByTestId("queued-prompt-queue-manual")).toBeVisible();
  });
}

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
  await expect(queueReceipt.locator(".tl-receipt-buttons")).toHaveAttribute("aria-busy", "true");
  await expect(queueReceipt.getByRole("button", { name: "Queue Again" })).toBeDisabled();
  await expect(queueReceipt).toContainText("Queue Again is pending.");
  await expect(dismissReceipt.locator(".tl-receipt-buttons")).toHaveAttribute("aria-busy", "true");
  await expect(dismissReceipt.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  await expect(dismissReceipt).toContainText("Dismiss is pending.");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSteeringResolution("resolve-queue"));
  await expect(queueReceipt).toContainText("Waiting for the next turn.");
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
  await expect(group.getByRole("button", { name: "Show All" })).toHaveAttribute("aria-expanded", "false");
  await expect(group).toContainText("Not Accepted");
  await expect(group).toContainText("8 messages");
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
  await group.getByRole("button", { name: "Show All" }).click();
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
