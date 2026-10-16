import { expect, test, type Page } from "@playwright/test";

const PAGE = "/command-inbox-projects-e2e.html?scenario=human-follow-up";
const resultTitle = "Findings Ready for Assessment";
const resultRow = (page: Page) => page.locator(".inbox-row-shell", { hasText: resultTitle });
const grid = (page: Page) => page.getByRole("grid", { name: "Sessions", exact: true });
const requests = (page: Page) => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.reviewRequests());
const acknowledged = (page: Page) => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
  .find((session) => session.id === "session-review")!.attention!.acknowledgedRevision);

async function open(page: Page, reader = false) {
  await page.goto(PAGE);
  await expect(grid(page)).toBeVisible();
  await resultRow(page).click();
  if (reader) {
    await grid(page).press("Enter");
    await expect(page.locator(".chat-reading")).toBeVisible();
    await page.locator(".detail-scroll").focus();
  }
}

test("the reader menu keeps the exact result it opened with", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, true);
  await page.getByRole("button", { name: "More Actions", exact: true }).click();
  const mark = page.getByRole("menuitem", { name: /^Mark Reviewed/ });
  await expect(mark).toBeVisible();
  await page.evaluate(() => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    const facts = fixture.model().sessions.find((session) => session.id === "session-review")!.attention!;
    fixture.replaceSessionSnapshot("session-review", { attention: { ...facts,
      result: { revision: "result-2", at: Date.now(), owner: "human" } } });
  });
  await mark.click();
  await expect(page.getByText("A newer result is waiting for review.", { exact: true })).toBeVisible();
  expect(await acknowledged(page)).toBeNull();
  expect(await requests(page)).toEqual([{ sessionId: "session-review", revision: "result-1" }]);
  await expect(page.getByRole("button", { name: "More Actions", exact: true })).toBeFocused();
});

for (const reader of [false, true]) {
  test(`the shortcut reference advertises M for ${reader ? "Session Reading" : "Sessions List"}`, async ({ page }) => {
    const path = reader ? `/sessions/~${Buffer.from("session-review", "utf16le").toString("base64url")}` : "/inbox";
    await page.goto(`${PAGE}&fullShell=1&path=${encodeURIComponent(path)}`);
    const focus = reader ? page.locator(".detail-scroll") : grid(page);
    await expect(focus).toBeVisible();
    await focus.focus();
    await page.keyboard.press("Shift+Slash");
    const reference = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
    await expect(reference).toBeVisible();
    await reference.getByRole("searchbox", { name: "Filter Shortcuts" }).fill("Mark Reviewed");
    // Shared label/key pairs are intentionally listed once, in the current scope's group.
    await expect(reference.locator(".shortcut-row dt")).toHaveText(["Mark Reviewed"]);
    await expect(reference.locator(".shortcut-row kbd")).toHaveText(["M"]);
    await expect(reference.locator(".shortcut-group h3")).toHaveText(`${reader ? "Session Reading" : "Sessions List"} Current Page`);
  });
}

for (const reader of [false, true]) {
  test(`M reviews the exact ${reader ? "current" : "selected"} result and preserves focus`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, reader);
    const focus = reader ? page.locator(".detail-scroll") : grid(page);
    await focus.focus();
    await page.keyboard.press("m");
    await expect.poll(() => acknowledged(page)).toBe("result-1");
    expect(await requests(page)).toEqual([{ sessionId: "session-review", revision: "result-1" }]);
    await expect(focus).toBeFocused();
    if (!reader) {
      await expect(resultRow(page)).toHaveAttribute("aria-selected", "true");
      const apply = page.getByRole("button", { name: "Apply", exact: true });
      if (await apply.isVisible()) await apply.click();
      await expect(resultRow(page)).toHaveAttribute("aria-selected", "true");
      await expect(focus).toBeFocused();
      await expect.poll(() => page.locator(".inbox-row-title").allTextContents()).toEqual([
        "Choose the Release Target", "Investigating in the Background", "Previously Reviewed Explanation", resultTitle,
      ]);
    }
    // Already reviewed and missing results both leave the API untouched.
    await page.keyboard.press("m");
    if (!reader) {
      await page.locator(".inbox-row-shell", { hasText: "Previously Reviewed Explanation" }).click();
      await page.keyboard.press("m");
      await page.locator(".inbox-row-shell", { hasText: "Choose the Release Target" }).click();
      await page.keyboard.press("m");
      expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.approvalRequests())).toEqual([]);
    }
    expect(await requests(page)).toHaveLength(1);
  });

  test(`M leaves a newer ${reader ? "current" : "selected"} result outstanding`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, reader);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deferNextReview());
    await page.keyboard.press("m");
    await expect.poll(() => requests(page)).toHaveLength(1);
    await page.evaluate(() => {
      const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
      const facts = fixture.model().sessions.find((session) => session.id === "session-review")!.attention!;
      fixture.replaceSessionSnapshot("session-review", { attention: { ...facts,
        result: { revision: "result-2", at: Date.now(), owner: "human" } } });
      fixture.settleDeferredReview();
    });
    await expect(page.getByText("A newer result is waiting for review.", { exact: true })).toBeVisible();
    expect(await acknowledged(page)).toBeNull();
    await page.keyboard.press("m");
    await expect.poll(() => acknowledged(page)).toBe("result-2");
    expect(await requests(page)).toEqual([
      { sessionId: "session-review", revision: "result-1" },
      { sessionId: "session-review", revision: "result-2" },
    ]);
  });

  test(`M respects typing, modifiers, and menus in ${reader ? "the reader" : "the list"}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, reader);
    const focus = reader ? page.locator(".detail-scroll") : grid(page);
    for (const key of ["Shift+m", "Control+m", "Alt+m", "Meta+m"]) await focus.press(key);
    const typing = page.locator(reader ? ".composer-input" : ".inbox-search input");
    await typing.fill("m");
    await typing.press("m");
    await expect(typing).toHaveValue("mm");
    await typing.fill("");
    await focus.focus();
    if (reader) await page.getByRole("button", { name: "More Actions", exact: true }).click();
    else await resultRow(page).click({ button: "right" });
    const mark = page.getByRole("menuitem", { name: /^Mark Reviewed/ });
    await expect(mark.locator("kbd")).toHaveText("M");
    await expect(mark).toHaveAttribute("aria-keyshortcuts", "M");
    await page.keyboard.press("m");
    expect(await requests(page)).toEqual([]);
    await mark.click();
    await expect.poll(() => acknowledged(page)).toBe("result-1");
  });
}
