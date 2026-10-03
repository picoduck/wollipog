import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #1966: one session notice above the composer. A session that is quarantined, has a failed
 * worktree setup and a failed account switch shows only the quarantine, with the other two behind
 * "+2 More", on the composer's own edges, and leaves the transcript most of the chat column.
 */

const box = (locator: Locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
});

async function openSession(page: Page, width: number, height: number, hideAccountEmails = false) {
  await page.setViewportSize({ width, height });
  const url = "/command-inbox-projects-e2e.html?scenario=session-notices";
  await page.goto(url);
  await page.evaluate((hide) => {
    localStorage.clear();
    if (hide) localStorage.setItem("wollipog.hide-account-emails", "true");
  }, hideAccountEmails);
  await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-notice-slot")).toBeVisible();
}

for (const [width, height] of [[1440, 900], [834, 1112], [390, 844]] as const) {
  test(`one notice, on the composer's edges, at ${width}px`, async ({ page }) => {
    await openSession(page, width, height);
    const slot = page.locator(".session-notice-slot");
    await expect(slot.locator(".notice")).toHaveCount(1);
    await expect(page.locator('[aria-label="Conversation Quarantined"]')).toBeVisible();
    await expect(page.locator('[aria-label="Worktree Setup Failed"]')).toHaveCount(0);
    await expect(page.locator('[aria-label="Account Switch Failed"]')).toHaveCount(0);
    await expect(slot.getByRole("button", { name: "+2 More" })).toBeVisible();

    const slotBox = await box(slot);
    const composerBox = await box(page.locator(".composer-box"));
    expect(Math.abs(slotBox.left - composerBox.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(slotBox.right - composerBox.right)).toBeLessThanOrEqual(1);
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(width);
  });
}

test("at 390px the slot stays under 180px and the transcript keeps half the chat column", async ({ page }) => {
  await openSession(page, 390, 844);
  const slot = page.locator(".session-notice-slot");
  const slotBox = await box(slot);
  expect(slotBox.height).toBeLessThanOrEqual(180);
  const chat = await box(page.locator(".detail-chat"));
  const transcript = await box(page.locator(".detail-main"));
  expect(transcript.height).toBeGreaterThanOrEqual(chat.height / 2);

  // The actions form one row: the resolving action fills it, Show Details keeps its own width.
  const recover = await box(slot.getByRole("button", { name: "Recover Session" }));
  const details = await box(slot.getByRole("button", { name: "Show Details" }));
  const row = await box(slot.locator(".notice-actions"));
  expect(Math.abs(recover.top - details.top)).toBeLessThanOrEqual(1);
  expect(recover.left).toBeCloseTo(row.left, 0);
  expect(details.right).toBeCloseTo(row.right, 0);
  expect(details.right - details.left).toBeLessThan(120);
  // "+2 More" is in the title row, above the body.
  const more = await box(slot.getByRole("button", { name: "+2 More" }));
  const body = await box(slot.locator(".notice-body"));
  expect(more.bottom).toBeLessThanOrEqual(body.top + 1);
});

for (const hide of [false, true]) {
  test(`+2 More lists the others and shows the chosen one with account hiding ${hide ? "on" : "off"}`, async ({ page }) => {
    await openSession(page, 1440, 900, hide);
    const slot = page.locator(".session-notice-slot");
    await slot.getByRole("button", { name: "+2 More" }).click();
    const menu = page.getByRole("menu", { name: "Session Notices" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Worktree Setup Failed", "Account Switch Failed"]);
    await menu.getByRole("menuitem", { name: "Account Switch Failed" }).click();
    const notice = page.locator('[aria-label="Account Switch Failed"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(hide
      ? "Wollipog couldn’t continue with the selected account."
      : "Wollipog couldn’t continue with work@example.com.");
    if (hide) await expect(notice).not.toContainText("work@example.com");
    await expect(notice.locator(".pid")).toHaveCount(0);
    await expect(notice.getByRole("button", { name: "Switch Account…" })).toBeVisible();
    await expect(slot.getByRole("button", { name: "+2 More" })).toBeFocused();
    await expect(slot.locator(".notice")).toHaveCount(1);
  });
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`an invalid setup configuration shows in the slot, not under the session bar, at ${width}px (#2036)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const url = "/command-inbox-projects-e2e.html?scenario=invalid-setup-config";
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();
    const slot = page.locator(".session-notice-slot");
    await expect(slot.locator('[aria-label="Invalid Worktree Setup Configuration"]')).toBeVisible();
    await expect(page.locator(".notice")).toHaveCount(1);
    await expect(slot.getByRole("button", { name: "+1 More" })).toBeVisible();
    await expect(slot.locator("code")).toHaveCount(0);
    await slot.getByRole("button", { name: "Show Details" }).click();
    await expect(slot.locator(".code-well code")).toHaveText(".wollipog.json.version must be 1");
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(width);
  });
}

/** #2156: a failed send, then an unsupported file dropped on the card. */
async function failSendThenDropBmp(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], [], { supportsImages: true }));
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  const edit = page.getByRole("button", { name: /^Edit Message:/ });
  if (await edit.isVisible()) await edit.click();
  const composer = page.locator(".composer-input");
  await composer.fill("Look at this screenshot");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextPrompt());
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".session-notice-slot")).toBeVisible();
  await page.locator(".composer-box").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([66, 77])], "scan.bmp", { type: "image/bmp" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  return composer;
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`a failed send and an unsupported file are one notice and +1 More at ${width}px (#2156)`, async ({ page }) => {
    const composer = await failSendThenDropBmp(page, width, height);
    const slot = page.locator(".session-notice-slot");
    await expect(slot.getByRole("button", { name: "+1 More" })).toBeVisible();
    await expect(slot.locator(".notice")).toHaveCount(1);
    // Nothing else between the slot and the card, and nothing inside the card.
    await expect(page.locator(".composer .notice")).toHaveCount(1);
    const sent = slot.getByRole("alert", { name: "Message Not Sent" });
    await expect(sent.locator(".notice-body")).toHaveText(/^Couldn't send your message\. .+ stopped responding\. Your draft is kept\.$/);
    await expect(sent.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(sent.getByRole("button", { name: "Dismiss" })).toBeVisible();
    await expect(composer).toHaveValue("Look at this screenshot");

    await slot.getByRole("button", { name: "+1 More" }).click();
    await expect(page.getByRole("menu", { name: "Session Notices" }).getByRole("menuitem")).toHaveText(["Image Not Supported"]);
    await page.keyboard.press("Escape");
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(width);
  });
}

test("Retry sends the kept draft once, and Dismiss and typing clear the composer's notices (#2156)", async ({ page }) => {
  const composer = await failSendThenDropBmp(page, 1440, 900);
  const slot = page.locator(".session-notice-slot");
  await slot.getByRole("alert", { name: "Message Not Sent" }).getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().map((request) => request.text)))
    .toEqual(["Look at this screenshot", "Look at this screenshot"]);
  // The accepted send clears every composer entry.
  await expect(slot).toHaveCount(0);

  await composer.fill("Another one");
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextPrompt());
  await page.getByRole("button", { name: "Send" }).click();
  const sent = slot.getByRole("alert", { name: "Message Not Sent" });
  await sent.getByRole("button", { name: "Dismiss" }).click();
  await expect(slot).toHaveCount(0);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextPrompt());
  await page.getByRole("button", { name: "Send" }).click();
  await expect(sent).toBeVisible();
  await composer.press("End");
  await composer.pressSequentially(" again");
  await expect(slot).toHaveCount(0);
});
