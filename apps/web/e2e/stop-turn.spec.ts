import { expect, test, type Page } from "@playwright/test";

async function openSession(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".detail-head")).toBeVisible();
}

test("composer Stop Turn is stable, idempotent, recall-safe, and distinct from Stop Session", async ({ page }) => {
  await openSession(page);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    status: "running",
    activeTurnId: "turn-1",
    queued: [{ id: "queued-1", text: "Preserve this queued prompt" }],
  }));

  const composer = page.locator(".composer-input");
  const stop = page.getByRole("button", { name: "Stop Turn" });
  await expect(stop).toBeVisible();
  await expect(stop).toHaveAttribute("title", "Stop Turn (Shift+Esc)");
  const stopBox = await stop.boundingBox();
  expect(stopBox?.width).toBe(32);
  expect(stopBox?.height).toBe(32);

  await composer.fill("A queued follow-up");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeVisible();
  const sendBox = await send.boundingBox();
  expect(sendBox).toEqual(stopBox);

  await composer.fill("");
  await stop.click();
  const stopping = page.getByRole("button", { name: "Stopping Turn" });
  await expect(stopping).toBeDisabled();
  await page.keyboard.press("Shift+Escape");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(1);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleInterrupted("session-alpha"));
  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible();
  await expect(page.getByText("Held", { exact: true })).toHaveAttribute(
    "title",
    "Held after stopping the active turn; send another prompt to resume",
  );
  await composer.focus();
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue("Preserve this queued prompt");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    status: "running",
    activeTurnId: "turn-2",
  }));
  await composer.fill("/stop");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(2);
  await expect(composer).toHaveValue("");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleInterrupted("session-alpha"));
  await composer.fill("/stop");
  await page.keyboard.press("Enter");
  await expect(page.locator(".composer-error").getByText("There is no active turn to stop.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(2);

  await composer.fill("");
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { status: "running", activeTurnId: "turn-3" });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextCancelTurn();
  });
  await page.getByRole("button", { name: "Stop Turn" }).click();
  await expect(page.getByText("Simulated stop failure", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();
  await page.getByRole("button", { name: "Stop Turn" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(4);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleInterrupted("session-alpha"));

  // Stop Session lives in the session bar's ⋯ menu now; the confirmation dialog is unchanged.
  await page.getByRole("button", { name: "More Actions" }).click();
  const stopSession = page.getByRole("menuitem", { name: "Stop Session" });
  await expect(stopSession).toHaveAttribute("title", "Terminate the agent process and discard queued messages");
  await stopSession.click();
  const confirmation = page.getByRole("dialog", { name: "Stop this session?" });
  await expect(confirmation).toContainText("terminates the agent process and discards every queued message");
  await expect(confirmation.getByRole("button", { name: "Stop Session" })).toBeVisible();

  // Cancelling must return keyboard focus to the durable ⋯ trigger — the menu item that
  // launched the confirmation unmounted with the menu (regression coverage).
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  const moreActions = page.getByRole("button", { name: "More Actions" });
  await expect(moreActions).toBeFocused();

  // ACCEPTING must also land back on the trigger: the action's busy state disables it while
  // the mutation runs, so restoration is reclaimed after busy clears (regression coverage).
  await moreActions.click();
  await page.getByRole("menuitem", { name: "Stop Session" }).click();
  await confirmation.getByRole("button", { name: "Stop Session" }).click();
  await expect(confirmation).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha")?.status,
  )).toBe("stopped");
  await expect(moreActions).toBeFocused();
});

test("timed turn updates preserve composer focus, selection, scroll, IME ownership, and shortcut isolation", async ({ page }) => {
  await openSession(page);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    status: "running",
    activeTurnId: "turn-focus",
  }));

  const composer = page.locator(".composer-input");
  const draft = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  await composer.fill(draft);
  const initial = await composer.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    const targetWindow = window as typeof window & {
      __issue14Composer?: HTMLTextAreaElement;
      __issue14Diagnostics?: unknown[];
    };
    targetWindow.__issue14Composer = input;
    targetWindow.__issue14Diagnostics = [];
    window.addEventListener("wollipog:composer-focus", (event) => {
      targetWindow.__issue14Diagnostics!.push((event as CustomEvent).detail);
    });
    input.focus();
    input.setSelectionRange(3, 14, "backward");
    input.scrollTop = 35;
    input.dispatchEvent(new Event("select", { bubbles: true }));
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "候" }));
    const reader = document.querySelector<HTMLElement>(".detail-scroll")!;
    return { scrollTop: input.scrollTop, readerScrollTop: reader.scrollTop };
  });

  await page.evaluate(() => {
    for (let revision = 2; revision <= 8; revision += 1) {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
        status: "running",
        activeTurnId: "turn-focus",
        updatedAt: revision,
        tokensOut: revision * 10,
      });
    }
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await composer.evaluate((element) => {
    for (const init of [
      { key: " " },
      { key: " ", shiftKey: true },
      { key: "g" },
      { key: "G", shiftKey: true },
      { key: "r" },
      { key: "h" },
      { key: "/" },
      { key: "ArrowUp" },
      { key: "ArrowDown" },
    ]) {
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    }
  });
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    status: "idle",
    activeTurnId: undefined,
    updatedAt: 9,
  }));
  await composer.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "候" }));
  });

  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".detail-scroll")!.focus();
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(composer).toBeFocused();

  const final = await composer.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    const targetWindow = window as typeof window & {
      __issue14Composer?: HTMLTextAreaElement;
      __issue14Diagnostics?: unknown[];
    };
    return {
      sameNode: targetWindow.__issue14Composer === input,
      focused: document.activeElement === input,
      selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
      scrollTop: input.scrollTop,
      readerScrollTop: document.querySelector<HTMLElement>(".detail-scroll")!.scrollTop,
      diagnostics: targetWindow.__issue14Diagnostics,
    };
  });

  expect(final.sameNode).toBe(true);
  expect(final.focused).toBe(true);
  expect(final.selection).toEqual([3, 14, "backward"]);
  expect(final.scrollTop).toBe(initial.scrollTop);
  expect(final.readerScrollTop).toBe(initial.readerScrollTop);
  expect(JSON.stringify(final.diagnostics)).not.toContain("line 0");
});


test("an acknowledged stop that does not settle becomes retryable", async ({ page }) => {
  await openSession(page);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    status: "running",
    activeTurnId: "turn-timeout",
  }));

  await page.getByRole("button", { name: "Stop Turn" }).click();
  await expect(page.getByRole("button", { name: "Stopping Turn" })).toBeDisabled();
  await expect(page.getByText(
    "The turn is still active. Try stopping it again or use Stop Session.",
    { exact: true },
  )).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();
});

test("queued history reconciles by turn id and does not suppress a later optimistic send", async ({ page }) => {
  await openSession(page);
  const composer = page.locator(".composer-input");

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage("session-alpha", "Prompt A", "turn-a");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "running",
      activeTurnId: "turn-current",
      queued: [{ id: "turn-b", text: "Prompt B" }],
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage("session-alpha", "Prompt B", "turn-b");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "idle",
      activeTurnId: undefined,
      queued: [],
    });
  });

  await composer.focus();
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue("Prompt B");
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue("Prompt A");

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "running",
      activeTurnId: "turn-c",
      queued: [{ id: "queued-undelivered", text: "Retained Queue Preview" }],
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "idle",
      activeTurnId: undefined,
      queued: [],
    });
  });
  await composer.fill("Fresh optimistic prompt");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Fresh optimistic prompt", { exact: true })).toBeVisible();
});

test("a policy pause does not expose Stop Turn or app-owned stop", async ({ page }) => {
  await openSession(page);
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage("session-alpha", "Budget-gated prompt", "turn-policy");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "input_required",
      activeTurnId: "turn-policy",
      pendingApproval: {
        kind: "cost_budget",
        requestId: "budget-1",
        title: "Cost Budget Reached",
        options: [],
      },
    });
  });

  await expect(page.getByRole("button", { name: "Stop Turn" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  // The merged Working row must survive the approval wait: input_required keeps the active
  // turn's progress and waiting reason on screen (regression coverage).
  const workingRow = page.getByRole("region", { name: "Active Turn Progress" });
  await expect(workingRow).toBeVisible();
  await expect(workingRow).toContainText("Waiting for Approval");
});
