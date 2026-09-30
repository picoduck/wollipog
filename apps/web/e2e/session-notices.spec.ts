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

async function openSession(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  const url = "/command-inbox-projects-e2e.html?scenario=session-notices";
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
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

test("+2 More lists the others and shows the chosen one", async ({ page }) => {
  await openSession(page, 1440, 900);
  const slot = page.locator(".session-notice-slot");
  await slot.getByRole("button", { name: "+2 More" }).click();
  const menu = page.getByRole("menu", { name: "Session Notices" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Worktree Setup Failed", "Account Switch Failed"]);
  await menu.getByRole("menuitem", { name: "Account Switch Failed" }).click();
  const notice = page.locator('[aria-label="Account Switch Failed"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Wollipog couldn’t continue with the selected account.");
  await expect(notice.locator(".pid")).toHaveCount(0);
  await expect(notice.getByRole("button", { name: "Switch Account…" })).toBeVisible();
  await expect(slot.getByRole("button", { name: "+2 More" })).toBeFocused();
  await expect(slot.locator(".notice")).toHaveCount(1);
});

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
