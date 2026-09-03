import { expect, test, type Page } from "@playwright/test";

async function openSession(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-input")).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  await openSession(page);
});

test("the typed command menu groups, ranks, selects, and dispatches provider commands", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    {
      name: "Review",
      source: "builtin",
      description: "Review the current changes",
      argumentHint: "[focus]",
    },
    { name: "deploy", source: "plugin", description: "Deploy this workspace" },
  ], ["plan"]));

  const composer = page.locator(".composer-input");
  await composer.fill("/");
  const listbox = page.getByRole("listbox", { name: "Slash Commands" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByText("App Commands", { exact: true })).toBeVisible();
  await expect(listbox.getByText("Harness Commands", { exact: true })).toBeVisible();
  await expect(listbox.getByText("Built-In", { exact: true })).toBeVisible();
  await expect(listbox.getByText("Plugin", { exact: true })).toBeVisible();

  await composer.fill("/rev");
  const review = page.getByRole("option", { name: /\/review/ });
  await expect(review).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".slash-detail")).toContainText("Review the current changes");
  await expect(page.locator(".slash-detail-argument")).toContainText("[focus]");
  await page.keyboard.press("Home");
  await expect.poll(() => composer.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBe(0);
  await page.keyboard.press("End");
  await expect.poll(() => composer.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBe(4);
  await page.keyboard.press("Tab");
  await expect(composer).toHaveValue("/review ");
  await expect.poll(() => composer.evaluate((element) =>
    (element as HTMLTextAreaElement).selectionStart)).toBe(8);

  await composer.fill("/review focus on tests");
  await expect(composer).toHaveValue("/review focus on tests");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "focus on tests",
    images: [],
    slashCommand: "Review",
  }]);

  await composer.fill("/dep");
  await page.getByRole("option", { name: /\/deploy/ }).click();
  await expect(composer).toHaveValue("/deploy ");
});

test("authorized provider commands use durable dispatch and preserve attachments", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([{
    name: "deploy",
    source: "plugin",
    description: "Deploy this workspace",
    invocation: {
      id: "provider-command-deploy",
      catalogRevision: "catalog-revision-7",
      executionMode: "structured",
    },
  }], [], { supportsImages: true }));

  const composer = page.locator(".composer-input");
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();

  await composer.fill("/deploy production");
  await expect(page.getByText(
    "Attached images will not be sent with this command. They will remain for your next prompt.",
  )).toBeVisible();
  await page.keyboard.press("Enter");

  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionCommandRequests()))
    .toEqual([{
      sessionId: "session-alpha",
      request: {
        submissionId: expect.stringMatching(/^web_/),
        providerCommandId: "provider-command-deploy",
        catalogRevision: "catalog-revision-7",
        argumentText: "production",
      },
    }]);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([]);
  await expect(page.getByRole("region", { name: "Provider Command Receipts" })).toContainText("/deploy production");
  await expect(page.getByRole("region", { name: "Provider Command Receipts" })).toContainText("Sent");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();
});

test("a pending composer config survives a durable command and applies to the next ordinary prompt", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([{
    name: "deploy",
    source: "plugin",
    invocation: {
      id: "provider-command-config-boundary",
      catalogRevision: "catalog-revision-config-boundary",
      executionMode: "structured",
    },
  }], ["on-request"]));

  await page.getByRole("button", { name: "Approve for Me" }).click();
  await page.getByRole("menuitemradio", { name: "Ask for Approval" }).click();
  await expect(page.getByRole("button", { name: "Ask for Approval" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Ask for Approval" })).toHaveAttribute("aria-expanded", "false");

  const composer = page.locator(".composer-input");
  await composer.fill("/deploy production");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionCommandRequests()))
    .toEqual([{
      sessionId: "session-alpha",
      request: {
        submissionId: expect.stringMatching(/^web_/),
        providerCommandId: "provider-command-config-boundary",
        catalogRevision: "catalog-revision-config-boundary",
        argumentText: "production",
      },
    }]);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([]);

  await composer.fill("continue with the selected approval mode");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()))
    .toEqual([{
      sessionId: "session-alpha",
      text: "continue with the selected approval mode",
      images: [],
      config: { permissionMode: "on-request" },
    }]);
});

test("a lost command response retries with the same durable submission ID", async ({ page }) => {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([{
      name: "review",
      source: "builtin",
      invocation: {
        id: "provider-command-review",
        catalogRevision: "catalog-revision-retry",
        executionMode: "passthrough",
      },
    }]);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextSessionCommandResponse();
  });
  const composer = page.locator(".composer-input");
  await composer.fill("/review storage");
  await page.keyboard.press("Enter");
  await expect(page.locator(".composer-error")).toContainText("Simulated lost provider command response");
  await expect(composer).toHaveValue("/review storage");
  await expect(page.getByRole("region", { name: "Provider Command Receipts" })).toContainText("Sent");

  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionCommandRequests().map((entry) => entry.request.submissionId)
  )).toEqual([expect.stringMatching(/^web_/), expect.stringMatching(/^web_/)]);
  const ids = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionCommandRequests().map((entry) => entry.request.submissionId));
  expect(new Set(ids).size).toBe(1);
});

test("an edit made during command delivery survives attachment preservation and reload", async ({ page }) => {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([{
      name: "deploy",
      source: "plugin",
      invocation: {
        id: "provider-command-deploy-edit",
        catalogRevision: "catalog-revision-edit",
        executionMode: "structured",
      },
    }], [], { supportsImages: true });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextSessionCommandResponse();
  });
  const composer = page.locator(".composer-input");
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await composer.fill("/deploy production");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionCommandRequests().length)).toBe(1);
  await composer.fill("newer draft while command is in flight");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSessionCommandResponse());
  await expect(composer).toHaveValue("newer draft while command is in flight");
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const draft = await window.__WOLLIPOG_PROJECT_INBOX_E2E__.composerDraft("session-alpha");
    return draft && { text: draft.text, images: draft.images };
  })).toEqual({
    text: "newer draft while command is in flight",
    images: [{ mimeType: "image/png", data: "iVBORw==" }],
  });

  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-input")).toHaveValue("newer draft while command is in flight");
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();
});

test("forbid attachment metadata blocks provider dispatch and preserves the draft", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "deploy", source: "plugin", description: "Deploy this workspace" },
  ], [], { supportsImages: true, attachmentPolicy: "forbid" }));
  const composer = page.locator(".composer-input");
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();

  await composer.fill("/deploy production");
  await page.keyboard.press("Enter");

  await expect(page.locator(".composer-error")).toHaveText("/deploy cannot run with attachments.");
  await expect(composer).toHaveValue("/deploy production");
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(0);
});

test("app and provider collisions remain explicit across draft text and capability changes", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "plan", source: "builtin", description: "Provider-owned planning command" },
  ], ["plan"]));

  const composer = page.locator(".composer-input");
  await composer.fill("/plan");
  await expect(page.getByRole("option", { name: /^\/plan\b/ })).toBeVisible();
  const providerPlan = page.getByRole("option", { name: /\/provider:plan/ });
  await expect(providerPlan).toBeVisible();
  await providerPlan.click();
  await expect(composer).toHaveValue("/provider:plan ");

  await composer.fill("/provider:plan provider arguments");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()[0])).toEqual({
    sessionId: "session-alpha",
    text: "provider arguments",
    images: [],
    slashCommand: "plan",
  });
  await expect(composer).toHaveValue("");

  await composer.fill("/plan on");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha")?.permissionMode
  )).toBe("plan");
  await expect(composer).toHaveValue("");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
});

test("invalid app-command arguments remain literal prompts regardless of availability", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], []));
  const composer = page.locator(".composer-input");
  await composer.fill("/plan out the refactor in three stages");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");

  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "/plan out the refactor in three stages",
    images: [],
  }]);
  await expect(composer).toHaveValue("");
  await composer.fill("/stop the deploy pipeline");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()[1])).toEqual({
    sessionId: "session-alpha",
    text: "/stop the deploy pipeline",
    images: [],
  });
  await expect(composer).toHaveValue("");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["plan"]));
  await composer.fill("/plan keep this literal too");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()[2]?.text))
    .toBe("/plan keep this literal too");
  await expect(composer).toHaveValue("");
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha")?.permissionMode
  )).not.toBe("plan");
});

test("programmatic clear and history recall cannot open or hijack the slash menu", async ({ page }) => {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
      { name: "review", source: "builtin", description: "Review the current changes" },
    ]);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage("session-alpha", "/review");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage("session-alpha", "hello newest");
  });
  const composer = page.locator(".composer-input");
  await composer.fill("hello");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("");

  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue("hello newest");
  await page.keyboard.press("ArrowUp");
  await expect(composer).toHaveValue("/review");
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().at(-1))).toMatchObject({
    text: "",
    slashCommand: "review",
  });
});

test("description-only fuzzy text sends literally instead of rewriting the command", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("/no");
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()[0]?.text))
    .toBe("/no");
});

test("rename-session arguments remain literal prompt text", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("/rename-session keep this literal");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()[0]?.text))
    .toBe("/rename-session keep this literal");
});

test("rename-session moves into a retryable status receipt without disturbing the next draft", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.fill("/rename-session");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests())).toEqual([
    "session-alpha",
  ]);
  const receipt = page.getByRole("region", { name: "Rename Session Status" });
  const announcement = page.locator('.composer > [role="status"]');
  await expect(receipt).toContainText("/rename-session");
  await expect(receipt).toContainText("Renaming Session…");
  await expect(announcement).toHaveText("Renaming Session.");
  await expect(announcement).toHaveAttribute("aria-live", "polite");
  await expect(composer).toHaveAttribute("aria-busy", "true");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await composer.fill("/rename-session");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests())).toEqual([
    "session-alpha",
  ]);
  await composer.fill("Draft I care about");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    error: "Session naming failed during thread start. Verify the selected Agent Harness and try again.",
  }));
  await expect(receipt).toContainText("Rename Failed");
  await expect(receipt).toContainText("Session naming failed during thread start");
  await expect(announcement).toContainText("Rename failed. Session naming failed during thread start");
  await expect(composer).not.toHaveAttribute("aria-busy", "true");
  await expect(composer).toHaveValue("Draft I care about");

  await composer.fill("/stop");
  await page.keyboard.press("Enter");
  const composerError = page.locator(".composer-error");
  await expect(composerError).toContainText("There is no active turn to stop.");
  const [errorBox, receiptBox] = await Promise.all([composerError.boundingBox(), receipt.boundingBox()]);
  expect(errorBox).not.toBeNull();
  expect(receiptBox).not.toBeNull();
  expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(receiptBox!.y);
  await composer.fill("Draft I care about");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  const retry = receipt.getByRole("button", { name: "Retry Rename" });
  await composer.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(5, 5));
  await page.keyboard.press("Shift+Tab");
  await expect(retry).toBeFocused();
  await retry.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests())).toEqual([
    "session-alpha",
    "session-alpha",
  ]);
  await expect(receipt).toContainText("Renaming Session…");
  await expect(receipt).toBeFocused();
  await expect(composerError).toContainText("There is no active turn to stop.");
  await expect(composer).toHaveValue("Draft I care about");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    title: "Retitled Session",
  }));
  await expect(receipt).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect.poll(() => composer.evaluate((element) => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }))).toEqual({ start: 5, end: 5 });
  await expect(page.getByText("Session renamed.", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Draft I care about");
  await expect.poll(() => page.evaluate(async () =>
    (await window.__WOLLIPOG_PROJECT_INBOX_E2E__.composerDraft("session-alpha"))?.text,
  )).toBe("Draft I care about");
  await expect(page.getByText("Retitled Session", { exact: true })).toBeVisible();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands(
    [], [], { supportsImages: true },
  ));
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();
  await composer.fill("/rename-session");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests().length))
    .toBe(3);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    title: "Retitled Again",
  }));
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();
  await expect(page.getByText("Retitled Again", { exact: true })).toBeVisible();
});

test("rename-session retry preserves deliberate focus movement and keeps failure retryable", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.fill("/rename-session");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests().length))
    .toBe(1);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    error: "Session naming failed during thread start. Verify the selected Agent Harness and try again.",
  }));

  const receipt = page.getByRole("region", { name: "Rename Session Status" });
  const retry = receipt.getByRole("button", { name: "Retry Rename" });
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await retry.click();
  await expect(receipt).toBeFocused();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    error: "Session naming timed out. Try again.",
  }));
  await expect(receipt).toBeFocused();
  await expect(retry).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await retry.press("Enter");
  const moreActions = page.locator(".session-detail > .detail-head")
    .getByRole("button", { name: "More Actions" });
  await moreActions.focus();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    title: "Retitled Without Stolen Focus",
  }));
  await expect(receipt).toHaveCount(0);
  await expect(moreActions).toBeFocused();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.fill("/rename-session");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests().length))
    .toBe(4);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    error: "Session naming timed out. Try again.",
  }));
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await retry.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch" });
  await retry.dispatchEvent("click", { detail: 0 });
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests().length))
    .toBe(5);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    title: "Retitled From Pointer Retry",
  }));
  await expect(receipt).toHaveCount(0);
  await expect(composer).not.toBeFocused();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
});

test("wrapped composer errors stay in flow beside status receipts at responsive widths", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.fill("/rename-session");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests().length))
    .toBe(1);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    error: "Session naming failed during thread start. Verify the selected Agent Harness and try again.",
  }));

  const receipt = page.getByRole("region", { name: "Rename Session Status" });
  await expect(receipt.getByRole("button", { name: "Retry Rename" })).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands(
    [], [], { supportsImages: true },
  ));
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await expect(page.getByRole("button", { name: "Remove Image" })).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands(
    [], [], { supportsImages: false },
  ));
  await composer.fill("Draft with an unsupported image");
  await page.getByRole("button", { name: "Send" }).click();

  const composerError = page.locator(".composer").getByRole("alert");
  await expect(composerError).toHaveText(
    "The selected model does not support image input. Remove the attachment or choose an image-capable model.",
  );
  await expect.poll(() => composerError.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  const expectSeparated = async () => {
    const [errorBox, receiptBox] = await Promise.all([composerError.boundingBox(), receipt.boundingBox()]);
    expect(errorBox).not.toBeNull();
    expect(receiptBox).not.toBeNull();
    expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(receiptBox!.y);
  };
  await expectSeparated();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectSeparated();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.fill("/rename-session");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(composerError).toHaveCount(0);
  const [composerBox, receiptBox, composerInset] = await Promise.all([
    page.locator(".composer").boundingBox(),
    receipt.boundingBox(),
    page.locator(".composer").evaluate((element) => {
      const style = getComputedStyle(element);
      return Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
    }),
  ]);
  expect(composerBox).not.toBeNull();
  expect(receiptBox).not.toBeNull();
  expect(receiptBox!.y - composerBox!.y).toBeCloseTo(composerInset, 1);
});

test("a stale semantic rename reports its fence without replacing a newer title", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.fill("/rename-session");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests().length))
    .toBe(1);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
    title: "Newer Manual Title",
    titleSource: "user",
  }));
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    error: "Session naming was superseded by a newer rename.",
  }));

  await expect(page.getByText("Newer Manual Title", { exact: true })).toBeVisible();
  const receipt = page.getByRole("region", { name: "Rename Session Status" });
  await expect(receipt).toContainText("Rename Failed");
  await expect(receipt).toContainText("Session naming was superseded by a newer rename.");
  await expect(composer).toHaveValue("");
});

test("unknown commands and absolute paths stay plaintext while command triggers require leading context", async ({ page }) => {
  const composer = page.locator(".composer-input");

  await composer.fill("/unknown literal input");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()[0]?.text))
    .toBe("/unknown literal input");
  await expect(composer).toHaveValue("");

  await composer.fill("/etc/hosts");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests()[1]?.text))
    .toBe("/etc/hosts");
  await expect(composer).toHaveValue("");

  await composer.fill("First line\n/rev");
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toHaveCount(0);

  await composer.fill(" \n/rev");
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue(" \n/review ");

  await composer.fill("First /rev");
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toHaveCount(0);
});

test("IME owns menu keys and unavailable commands explain without dispatching", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("/stop");
  const stop = page.getByRole("option", { name: /\/stop/ });
  await expect(stop).toHaveAttribute("aria-disabled", "true");
  await expect(stop).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".slash-detail-disabled")).toHaveText("There is no active turn to stop.");
  const activeDescendant = await composer.getAttribute("aria-activedescendant");

  await stop.dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator(".composer-error")).toHaveText("There is no active turn to stop.");

  for (const key of ["ArrowDown", "Escape", "Enter"]) {
    await composer.dispatchEvent("keydown", { key, code: key, keyCode: 229, isComposing: true });
  }
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toBeVisible();
  await expect(composer).toHaveAttribute("aria-activedescendant", activeDescendant!);
  await expect(composer).toHaveValue("/stop");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(0);

  await page.keyboard.press("Enter");
  await expect(page.locator(".composer-error")).toHaveText("There is no active turn to stop.");
  await expect(composer).toHaveValue("/stop");
});
