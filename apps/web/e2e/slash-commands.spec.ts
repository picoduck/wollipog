import { expect, test, type Page } from "@playwright/test";
import { DECODABLE_PNG_BASE64 } from "./fixtures/prompt-image.js";

/** A provider command's receipt row in the transcript, found by the command it shows. */
function commandReceipt(page: Page, command: string) {
  return page.locator('.detail-scroll [data-testid^="provider-command-"]', { hasText: command });
}

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
  // Groups name the source; rows carry no source badge.
  await expect(listbox.getByRole("group", { name: "Wollipog" })).toBeVisible();
  await expect(listbox.getByRole("group", { name: "Codex" })).toBeVisible();
  await expect(listbox.getByText("Built-In", { exact: true })).toHaveCount(0);
  await expect(listbox.getByText("Plugin", { exact: true })).toHaveCount(0);
  // App commands show the token you type, not an action name.
  await expect(page.getByRole("option", { name: "/rename-session" })).toBeVisible();
  await expect(listbox.getByText("Rename Session", { exact: true })).toHaveCount(0);

  await composer.fill("/rev");
  const review = page.getByRole("option", { name: /\/review/ });
  await expect(review).toHaveAttribute("aria-selected", "true");
  // The argument hint follows the token and the description follows both, on the row itself.
  await expect(review.locator(".picker-token")).toHaveText("/review [focus]");
  await expect(review.locator(".picker-desc")).toHaveText("Review the current changes");
  await expect(page.locator(".slash-detail")).toHaveCount(0);
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
  await composer.evaluate((element, png) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, DECODABLE_PNG_BASE64);
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();

  await composer.fill("/deploy production");
  // The note is an info entry of the notice slot (#2156), not a notice inside the card.
  const note = page.locator(".session-notice-slot").getByRole("status", { name: "Images Kept for Next Message" });
  await expect(note).toContainText("/deploy doesn't send images. They stay here for your next message.");
  await expect(page.locator(".composer-box .notice")).toHaveCount(0);
  await note.getByRole("button", { name: "Dismiss" }).click();
  await expect(note).toHaveCount(0);
  await composer.fill("/deploy production now");
  await expect(note).toHaveCount(0);
  await composer.fill("/deploy production");
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
  // The receipt is a row of the transcript under the command it describes (#2171).
  await expect(commandReceipt(page, "/deploy production")).toContainText("Sending to");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();
});

test("Codex prompts and skills are grouped by source and $name dispatches the same skill as /name", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    {
      name: "summarize",
      source: "user",
      description: "Summarize the branch for review",
      argumentHint: "[focus]",
      invocation: { id: "codex-prompt-summarize", catalogRevision: "codex-catalog-1", executionMode: "passthrough" },
    },
    {
      name: "review",
      source: "skill",
      description: "Review a pull request with a second model",
      invocation: { id: "codex-skill-review", catalogRevision: "codex-catalog-1", executionMode: "passthrough" },
    },
  ], []));

  const composer = page.locator(".composer-input");
  await composer.fill("/");
  const listbox = page.getByRole("listbox", { name: "Slash Commands" });
  await expect(listbox.getByRole("group", { name: "Codex" }).getByRole("option", { name: /\/summarize/ })).toBeVisible();
  await expect(listbox.getByRole("group", { name: "Skills" }).getByRole("option", { name: /\/review/ })).toBeVisible();

  await composer.fill("$");
  await expect(listbox).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(listbox.getByRole("group", { name: "Skills" }).getByRole("option", { name: /\$review/ })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(composer).toHaveValue("$review ");
  await composer.fill("$review pr 42");
  await page.keyboard.press("Enter");
  await composer.fill("/review pr 43");
  // Enter is ignored until the previous submission releases the composer, which follows the
  // provider receipt by its draft bookkeeping; Send enables at exactly that point.
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionCommandRequests()
    .map(({ request }) => [request.providerCommandId, request.argumentText])))
    .toEqual([["codex-skill-review", "pr 42"], ["codex-skill-review", "pr 43"]]);
  await expect(commandReceipt(page, "$review pr 42")).toBeVisible();

  // A rotated catalog that adds a same-named prompt must not respell the outstanding skill receipt.
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "review", source: "user", invocation: { id: "codex-prompt-review", catalogRevision: "codex-catalog-2", executionMode: "passthrough" } },
    { name: "review", source: "skill", invocation: { id: "codex-skill-review-2", catalogRevision: "codex-catalog-2", executionMode: "passthrough" } },
  ], []));
  await expect(commandReceipt(page, "$review pr 42")).toBeVisible();

  // The reverse: a prompt receipt stays /name when a later catalog keeps only the same-named skill.
  await composer.fill("/user:review notes");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(commandReceipt(page, "/review notes")).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "review", source: "skill", invocation: { id: "codex-skill-review-3", catalogRevision: "codex-catalog-3", executionMode: "passthrough" } },
  ], []));
  await expect(commandReceipt(page, "/review notes")).toBeVisible();
  await expect(commandReceipt(page, "$review pr 42")).toBeVisible();

  await composer.fill("$HOME stays text");
  await expect(listbox).toBeHidden();
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
  // The response never came back, so the machine stopped responding; Retry or Enter reuses the ID.
  const notSent = page.locator(".session-notice-slot").getByRole("alert", { name: "Message Not Sent" });
  await expect(notSent.locator(".notice-body")).toHaveText(/^Couldn't send your message\. .+ stopped responding\. Your draft is kept\.$/);
  await expect(notSent.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(composer).toHaveValue("/review storage");
  await expect(commandReceipt(page, "/review storage")).toContainText("Sending to");

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
  await composer.evaluate((element, png) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, DECODABLE_PNG_BASE64);
  await composer.fill("/deploy production");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionCommandRequests().length)).toBe(1);
  await composer.fill("newer draft while command is in flight");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredSessionCommandResponse());
  await expect(composer).toHaveValue("newer draft while command is in flight");
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const draft = await window.__WOLLIPOG_PROJECT_INBOX_E2E__.composerDraft("session-alpha");
    return draft && { text: draft.text, images: draft.images };
  })).toEqual({
    text: "newer draft while command is in flight",
    images: [{ mimeType: "image/png", data: DECODABLE_PNG_BASE64 }],
  });

  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-input")).toHaveValue("newer draft while command is in flight");
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();
});

test("forbid attachment metadata blocks provider dispatch and preserves the draft", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "deploy", source: "plugin", description: "Deploy this workspace" },
  ], [], { supportsImages: true, attachmentPolicy: "forbid" }));
  const composer = page.locator(".composer-input");
  await composer.evaluate((element, png) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, DECODABLE_PNG_BASE64);
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();

  await composer.fill("/deploy production");
  await page.keyboard.press("Enter");

  await expect(page.locator('.session-notice-slot .notice.t-danger[role="alert"] .notice-body')).toHaveText("/deploy can't run with attachments. Remove them to run it.");
  await expect(composer).toHaveValue("/deploy production");
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();
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

test("description-only fuzzy text is an unknown command, never rewritten into one", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("/no");
  // Nothing is offered for it, and Enter refuses it rather than guessing or sending it (#2176).
  await expect(page.locator(".picker-empty .picker-empty-text > span").first())
    .toHaveText("“/no” isn't a recognized command.");
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator(".session-notice-slot .notice.t-warning .notice-body"))
    .toHaveText("“/no” isn't a recognized command, so nothing was sent.");
  await expect(composer).toHaveValue("/no");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(0);
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
  // A row of the transcript (#2171) in plain words: no slash command, no raw provider text.
  await expect(page.locator(".detail-scroll").getByRole("region", { name: "Rename Session Status" })).toBeVisible();
  await expect(receipt).not.toContainText("/rename-session");
  await expect(receipt).toContainText("Renaming session…");
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
  await expect(receipt).toContainText("Couldn't rename this session.");
  await expect(receipt).not.toContainText("Session naming failed during thread start");
  await expect(announcement).toHaveText("Rename failed. Couldn't rename this session.");
  await receipt.getByRole("button", { name: "Show Details" }).click();
  await expect(receipt).toContainText("Session naming failed during thread start");
  await receipt.getByRole("button", { name: "Hide Details" }).click();
  await expect(composer).not.toHaveAttribute("aria-busy", "true");
  await expect(composer).toHaveValue("Draft I care about");

  await composer.fill("/stop");
  await page.keyboard.press("Enter");
  const composerError = page.locator('.session-notice-slot .notice.t-warning[role="alert"]');
  await expect(composerError).toContainText("There's no turn to stop right now.");
  // The receipt is in the transcript, so the composer's own error never shares its space.
  const [errorBox, receiptBox] = await Promise.all([composerError.boundingBox(), receipt.boundingBox()]);
  expect(errorBox).not.toBeNull();
  expect(receiptBox).not.toBeNull();
  expect(receiptBox!.y + receiptBox!.height).toBeLessThanOrEqual(errorBox!.y);
  await composer.fill("Draft I care about");
  // A changed draft is a new message, so the composer's notices about the old one clear (#2156).
  await expect(composerError).toHaveCount(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  const retry = receipt.getByRole("button", { name: "Retry Rename" });
  await composer.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(5, 5));
  await page.keyboard.press("Shift+Tab");
  await expect(receipt.getByRole("button", { name: "Show Details" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(retry).toBeFocused();
  await retry.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests())).toEqual([
    "session-alpha",
    "session-alpha",
  ]);
  await expect(receipt).toContainText("Renaming session…");
  await expect(receipt).toBeFocused();
  await expect(composerError).toHaveCount(0);
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
  await composer.evaluate((element, png) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, DECODABLE_PNG_BASE64);
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();
  await composer.fill("/rename-session");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.retitleRequests().length))
    .toBe(3);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    title: "Retitled Again",
  }));
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();
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
  const moreActions = page.locator(".session-bar")
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

test("phone rename retry reveals the idle composer before restoring keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const composer = page.locator(".composer-input");
  const preview = page.locator(".composer-idle-preview");
  await expect(preview).toBeVisible();
  await preview.click();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.fill("/rename-session");
  await page.getByRole("button", { name: "Send" }).click();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    error: "Session naming timed out. Try again.",
  }));

  const receipt = page.getByRole("region", { name: "Rename Session Status" });
  const retry = receipt.getByRole("button", { name: "Retry Rename" });
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(receipt.getByRole("button", { name: "Show Details" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(retry).toBeFocused();
  await retry.press("Enter");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.settleDeferredRetitle({
    title: "Retitled on a Phone",
  }));

  await expect(receipt).toHaveCount(0);
  await expect(page.locator(".composer-box")).not.toHaveClass(/idle-collapsed/);
  await expect(composer).toBeFocused();
});

test("wrapped composer errors stay in the composer while status receipts stay in the transcript at responsive widths", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const composer = page.locator(".composer-input");
  await page.locator(".composer-idle-preview").click();
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
  await composer.evaluate((element, png) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, DECODABLE_PNG_BASE64);
  await expect(page.getByRole("button", { name: "Remove Attached Image 1" })).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands(
    [], [], { supportsImages: false },
  ));
  await composer.fill("Draft with an unsupported image");
  await page.getByRole("button", { name: "Send" }).click();

  const composerError = page.locator(".composer").getByRole("alert");
  await expect(composerError.locator(".notice-body")).toHaveText(
    /^.+ can't read images\. Choose another model in Model Settings to attach them\.$/,
  );
  await expect.poll(() => composerError.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  const expectSeparated = async () => {
    const [errorBox, receiptBox] = await Promise.all([composerError.boundingBox(), receipt.boundingBox()]);
    expect(errorBox).not.toBeNull();
    expect(receiptBox).not.toBeNull();
    expect(receiptBox!.y + receiptBox!.height).toBeLessThanOrEqual(errorBox!.y);
  };
  await expectSeparated();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectSeparated();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextRetitle());
  await composer.fill("/rename-session");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(composerError).toHaveCount(0);
  // The running rename is a row of the transcript, never a card above the composer (#2171).
  await expect(page.locator(".detail-scroll").getByRole("region", { name: "Rename Session Status" }))
    .toContainText("Renaming session…");
  await expect(page.locator(".composer .tl-receipt")).toHaveCount(0);
  const [composerBox, receiptBox] = await Promise.all([
    page.locator(".composer").boundingBox(),
    receipt.boundingBox(),
  ]);
  expect(composerBox).not.toBeNull();
  expect(receiptBox).not.toBeNull();
  expect(receiptBox!.y + receiptBox!.height).toBeLessThanOrEqual(composerBox!.y);
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
  await expect(receipt).toContainText("Couldn't rename this session.");
  await receipt.getByRole("button", { name: "Show Details" }).click();
  await expect(receipt).toContainText("Session naming was superseded by a newer rename.");
  await expect(composer).toHaveValue("");
});

test("unknown commands and leading paths are refused, escapes and later slashes are text, and triggers require leading context", async ({ page }) => {
  const composer = page.locator(".composer-input");
  const notice = page.locator(".session-notice-slot .notice.t-warning .notice-body");
  const prompts = () => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().map((request) => request.text));

  await composer.fill("/unknown literal input");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(notice).toHaveText("“/unknown” isn't a recognized command, so nothing was sent.");
  await expect(composer).toHaveValue("/unknown literal input");

  await composer.fill("/etc/hosts");
  await expect(notice, "editing the draft clears the notice").toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(notice).toHaveText("“/etc/hosts” isn't a recognized command, so nothing was sent.");
  expect(await prompts()).toEqual([]);

  // `//` and `\/` mark a leading slash as text and are removed; a slash later in a message is text.
  for (const [typed, sent] of [
    ["//unknown literal input", "/unknown literal input"],
    ["\\/etc/hosts", "/etc/hosts"],
    ["see /tmp/out.log", "see /tmp/out.log"],
  ] as const) {
    await composer.fill(typed);
    await page.keyboard.press("Enter");
    await expect.poll(prompts).toContain(sent);
    await expect(composer).toHaveValue("");
  }
  expect(await prompts()).toEqual(["/unknown literal input", "/etc/hosts", "see /tmp/out.log"]);

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
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "status", source: "builtin", description: "Show the session status" },
  ]));
  const composer = page.locator(".composer-input");
  await composer.fill("/st");
  const stop = page.getByRole("option", { name: /\/stop/ });
  const status = page.getByRole("option", { name: /\/status/ });
  // The reason is a visible second line without arrowing onto the row, and the row is never active.
  await expect(stop).toHaveAttribute("aria-disabled", "true");
  await expect(stop.locator(".picker-reason")).toHaveText("There's no turn to stop right now.");
  await expect(stop).toHaveAttribute("aria-selected", "false");
  await expect(status).toHaveAttribute("aria-selected", "true");
  for (const key of ["ArrowDown", "ArrowUp"]) {
    await page.keyboard.press(key);
    await expect(status, `${key} skips the disabled row`).toHaveAttribute("aria-selected", "true");
  }
  // Playwright refuses to click an aria-disabled element without force; a person can still try.
  await stop.click({ force: true });
  await expect(composer).toHaveValue("/st");
  await expect(page.locator('.composer > .notice.t-danger[role="alert"]')).toHaveCount(0);

  await composer.fill("/stop");
  await expect(stop).toHaveAttribute("aria-selected", "false");
  await expect(composer).not.toHaveAttribute("aria-activedescendant");

  for (const key of ["ArrowDown", "Escape", "Enter"]) {
    await composer.dispatchEvent("keydown", { key, code: key, keyCode: 229, isComposing: true });
  }
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toBeVisible();
  await expect(composer).toHaveValue("/stop");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(0);

  // Enter never chooses the unavailable row; the command typed in full is refused with its reason,
  // and Send as Text is offered (#2176).
  await page.keyboard.press("Enter");
  const notice = page.locator('.session-notice-slot .notice.t-warning[role="alert"]');
  await expect(notice.locator(".notice-body"))
    .toHaveText("“/stop” can't run here, so nothing was sent. There's no turn to stop right now.");
  await expect(notice.getByRole("button", { name: "Send as Text" })).toBeVisible();
  await expect(composer).toHaveValue("/stop");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(0);
});

test("with seven commands the footer stays in view and the seventh row is reachable by scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "review", source: "builtin", description: "Review the current changes", argumentHint: "[focus]" },
    { name: "compact", source: "builtin", description: "Summarize the conversation so far" },
    { name: "init", source: "builtin", description: "Write an AGENTS.md for this project" },
    { name: "summarize", source: "user", description: "Summarize the branch for review" },
    { name: "zebra", source: "project", description: "The last command in the list" },
  ], ["plan"]));
  const composer = page.locator(".composer-input");
  await composer.fill("/");
  const listbox = page.getByRole("listbox", { name: "Slash Commands" });
  const options = listbox.getByRole("option");
  await expect(options).toHaveCount(7);
  const foot = page.locator(".picker-foot");
  await expect(foot).toBeVisible();
  await expect(foot.locator(".shortcut-hint-label")).toHaveText(["Move", "Run or Insert", "Complete", "Close"]);

  const list = page.locator(".picker-list");
  const listBox = (await list.boundingBox())!;
  expect(listBox.height).toBeLessThanOrEqual(320);
  // ArrowUp from the first row wraps to the seventh, which the list scrolls into its own view.
  await page.keyboard.press("ArrowUp");
  const seventh = options.nth(6);
  await expect(seventh).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-activedescendant", (await seventh.getAttribute("id"))!);
  await expect.poll(async () => {
    const [row, view] = await Promise.all([seventh.boundingBox(), list.boundingBox()]);
    return row!.y >= view!.y - 1 && row!.y + row!.height <= view!.y + view!.height + 1;
  }).toBe(true);
  const [footBox, finalList] = await Promise.all([foot.boundingBox(), list.boundingBox()]);
  expect(footBox!.y).toBeGreaterThanOrEqual(finalList!.y + finalList!.height - 1);
  // The picker sits above the composer, inside the viewport.
  const [pickerBox, composerBox] = await Promise.all([page.locator(".picker").boundingBox(), composer.boundingBox()]);
  expect(pickerBox!.y).toBeGreaterThanOrEqual(0);
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(composerBox!.y);
});

test("a slash query that matches nothing keeps the picker open until Escape or a space", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("/zzzz");
  await expect(page.locator(".picker")).toBeVisible();
  // The empty listbox stays in the DOM for aria-controls, but takes no room above the row.
  await expect(page.getByRole("listbox", { name: "Slash Commands", includeHidden: true })).toBeAttached();
  await expect(page.locator(".picker-empty .picker-empty-text > span").first())
    .toHaveText("“/zzzz” isn't a recognized command.");
  await expect(composer).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".picker")).toHaveCount(0);
  await expect(composer).toHaveValue("/zzzz");

  // Dismissal holds for that exact text; a new query opens the row again.
  await composer.fill("/zzz");
  await expect(page.locator(".picker-empty")).toBeVisible();
  await page.keyboard.type(" ");
  await expect(page.locator(".picker")).toHaveCount(0);
  await expect(composer).toHaveValue("/zzz ");
});

/** A catalog with the close matches the unknown-command tests reach for (#2176). */
async function setUnknownCommandCatalog(page: Page) {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "compact", source: "builtin", description: "Summarize the conversation so far" },
    { name: "review", source: "builtin", description: "Review the current changes", argumentHint: "[focus]" },
    { name: "deploy", source: "plugin", description: "Deploy this workspace" },
  ], ["plan"]));
}

const promptTexts = (page: Page) => page.evaluate(() =>
  window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().map((request) => request.text));

/** Submitting an unknown command alone, at either width: nothing starts, the draft stays, and the
 * notice offers the close match, which replaces the token. */
async function expectUnknownCommandRefused(page: Page) {
  await setUnknownCommandCatalog(page);
  const composer = page.locator(".composer-input");
  const idlePreview = page.locator(".composer-idle-preview");
  if (await idlePreview.isVisible()) await idlePreview.click();
  await composer.fill("/compat");
  await page.getByRole("button", { name: "Send" }).click();
  const notice = page.locator('.session-notice-slot .notice.t-warning[role="alert"]');
  await expect(notice.locator(".notice-title")).toHaveText("Unknown Command");
  await expect(notice.locator(".notice-body"))
    .toHaveText("“/compat” isn't a recognized command, so nothing was sent. Did you mean /compact?");
  await expect(composer).toHaveValue("/compat");
  // Nothing was sent or queued.
  expect(await promptTexts(page)).toEqual([]);
  await expect(notice.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await notice.getByRole("button", { name: "Use /compact" }).click();
  await expect(composer).toHaveValue("/compact ");
  await expect(composer).toBeFocused();
  await expect(notice).toHaveCount(0);
  expect(await promptTexts(page)).toEqual([]);
}

test("submitting an unknown command alone starts no turn, keeps the draft and offers Use /compact", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectUnknownCommandRefused(page);
});

test("Use /review replaces only the unknown token and keeps the rest of the message", async ({ page }) => {
  await setUnknownCommandCatalog(page);
  const composer = page.locator(".composer-input");
  await composer.fill("/reveiw please check the diff");
  await page.keyboard.press("Enter");
  const notice = page.locator(".session-notice-slot .notice.t-warning");
  await expect(notice.locator(".notice-body"))
    .toHaveText("“/reveiw” isn't a recognized command, so nothing was sent. Did you mean /review?");
  expect(await promptTexts(page)).toEqual([]);
  await notice.getByRole("button", { name: "Use /review" }).click();
  await expect(composer).toHaveValue("/review please check the diff");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "please check the diff",
    images: [],
    slashCommand: "review",
  }]);
});

test("the picker keeps an unknown command open with Send as Text and Close Matches, none active", async ({ page }) => {
  await setUnknownCommandCatalog(page);
  const composer = page.locator(".composer-input");
  await composer.fill("/reveiw");
  const picker = page.locator(".picker");
  await expect(picker.locator(".picker-empty-text > span").first()).toHaveText("“/reveiw” isn't a recognized command.");
  await expect(picker.locator(".picker-empty-detail")).toHaveText("Enter won't send it. Choose a close match, or send it as text.");
  await expect(picker.getByRole("button", { name: "Send as Text" })).toHaveAttribute("title", /exactly as typed/);
  const matches = page.getByRole("group", { name: "Close Matches" });
  const review = matches.getByRole("option", { name: /\/review/ });
  await expect(review).toHaveAttribute("aria-selected", "false");
  await expect(composer).not.toHaveAttribute("aria-activedescendant");

  // Enter with no match active raises the notice instead of sending, and the picker gives way to it.
  await page.keyboard.press("Enter");
  await expect(page.locator(".session-notice-slot .notice.t-warning .notice-body"))
    .toHaveText("“/reveiw” isn't a recognized command, so nothing was sent. Did you mean /review?");
  await expect(picker).toHaveCount(0);
  await expect(composer).toHaveValue("/reveiw");
  expect(await promptTexts(page)).toEqual([]);

  // The arrows reach the matches, and Enter then inserts the one reached.
  await composer.fill("/reivew");
  await expect(review).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowDown");
  await expect(review).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-activedescendant", (await review.getAttribute("id"))!);
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/review ");
  expect(await promptTexts(page)).toEqual([]);
});

test("Send as Text, from the picker row or the notice, sends the literal text once and clears the draft", async ({ page }) => {
  await setUnknownCommandCatalog(page);
  const composer = page.locator(".composer-input");
  await composer.fill("/reveiw");
  await page.locator(".picker").getByRole("button", { name: "Send as Text" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "/reveiw",
    images: [],
  }]);
  await expect(composer).toHaveValue("");

  // With no close match the sentence ends after "nothing was sent." and only Send as Text remains.
  await composer.fill("/zzzz");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  const notice = page.locator(".session-notice-slot .notice.t-warning");
  await expect(notice.locator(".notice-body")).toHaveText("“/zzzz” isn't a recognized command, so nothing was sent.");
  await expect(notice.locator(".notice-actions").getByRole("button")).toHaveText(["Send as Text"]);
  await notice.getByRole("button", { name: "Send as Text" }).click();
  await expect.poll(() => promptTexts(page)).toEqual(["/reveiw", "/zzzz"]);
  await expect(composer).toHaveValue("");
  await expect(notice).toHaveCount(0);

  // Dismiss hides the notice and keeps the draft.
  await composer.fill("/zzzz again");
  await page.keyboard.press("Enter");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await expect(composer).toHaveValue("/zzzz again");
  expect(await promptTexts(page)).toEqual(["/reveiw", "/zzzz"]);
});

test("a Claude Code runner without the init-time catalog still sends an unknown token as text", async ({ page }) => {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { driver: "claude-code" });
    // An older runner reports only Claude Code's disk commands.
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([{ name: "deploy", source: "project" }]);
  });
  const composer = page.locator(".composer-input");
  await composer.fill("/compact");
  await expect(page.locator(".picker-empty")).toHaveText("No commands match “/compact”.");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "/compact",
    images: [],
  }]);

  // A runner that forwards the init-time catalog reports built-ins, and the rule turns on (#1224).
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
    { name: "deploy", source: "project" },
    { name: "compact", source: "builtin" },
  ]));
  await composer.fill("/zzz");
  await expect(page.locator(".picker-empty-text > span").first()).toHaveText("“/zzz” isn't a recognized command.");
  await composer.fill("/compat");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.locator(".session-notice-slot .notice.t-warning .notice-body"))
    .toHaveText("“/compat” isn't a recognized command, so nothing was sent. Did you mean /compact?");
  expect(await promptTexts(page)).toEqual(["/compact"]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("submitting an unknown command alone starts no turn, keeps the draft and offers Use /compact", async ({ page }) => {
    await expectUnknownCommandRefused(page);
  });

  test("the unknown-command notice's actions are 44px targets under its sentence", async ({ page }) => {
    await setUnknownCommandCatalog(page);
    const composer = page.locator(".composer-input");
    const idlePreview = page.locator(".composer-idle-preview");
    if (await idlePreview.isVisible()) await idlePreview.tap();
    await composer.fill("/reveiw please check the diff");
    await page.getByRole("button", { name: "Send" }).tap();
    const notice = page.locator(".session-notice-slot .notice.t-warning");
    const body = notice.locator(".notice-body");
    await expect(body).toBeVisible();
    const bodyBox = (await body.boundingBox())!;
    for (const name of ["Use /review", "Send as Text"]) {
      const button = notice.getByRole("button", { name });
      const box = (await button.boundingBox())!;
      expect(box.y, `${name} sits under the sentence`).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height - 1);
      const hit = await button.evaluate((element) => {
        const after = getComputedStyle(element, "::after");
        const rect = element.getBoundingClientRect();
        return after.position === "absolute"
          ? rect.height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom)
          : rect.height;
      });
      expect(hit, `${name} is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    await notice.getByRole("button", { name: "Use /review" }).tap();
    await expect(composer).toHaveValue("/review please check the diff");
  });

  test("both pickers open above the composer inside the viewport, with 44px rows and no footer keys", async ({ page }) => {
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([
      { name: "review", source: "builtin", description: "Review the current changes with a long description that has to truncate", argumentHint: "[focus]" },
    ], ["plan"]));
    const composer = page.locator(".composer-input");
    const expectAnchored = async () => {
      const picker = page.locator(".picker");
      await expect(picker).toBeVisible();
      const [pickerBox, composerBox] = await Promise.all([picker.boundingBox(), composer.boundingBox()]);
      expect(pickerBox!.y).toBeGreaterThanOrEqual(0);
      expect(pickerBox!.x).toBeGreaterThanOrEqual(0);
      expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(390);
      expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(composerBox!.y);
      for (const option of await page.getByRole("option").all()) {
        expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await expect(page.locator(".picker-keys")).toBeHidden();
      await expect(page.locator(".picker-foot")).toBeHidden();
    };

    // The idle phone composer is a one-line capsule; a tap opens it.
    const idlePreview = page.locator(".composer-idle-preview");
    if (await idlePreview.isVisible()) await idlePreview.tap();
    await composer.focus();
    await composer.fill("/");
    await expect(page.getByRole("option", { name: /\/review/ })).toBeVisible();
    await expectAnchored();

    await composer.fill("");
    await composer.pressSequentially("Review @src");
    await expect(page.getByRole("option", { name: /src\/session\.ts/ })).toBeVisible();
    await expectAnchored();
  });
});
