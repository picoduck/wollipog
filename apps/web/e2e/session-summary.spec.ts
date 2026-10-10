import { expect, test } from "@playwright/test";

test("paged summaries retain the Inbox and hydrate an opened Session", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?sessionSummaries=1&sessionShell=1");
  await page.getByRole("tab", { name: /^All \d/ }).click();
  await expect(page.getByRole("row", { name: /Alpha Session/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /No Project Session/ })).toBeVisible();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  await expect(page.locator(".session-bar .session-project-button")).toHaveText("Alpha");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionDetailLookups())).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Back to Sessions" })).toBeVisible();
  const before = await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionDetailLookups());
  const detail = page.locator(".session-bar .session-project-button");
  await detail.evaluate((element) => element.setAttribute("data-reconnect-mounted","true"));
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.reconnectSessionSummaries());
  await expect(detail).toHaveAttribute("data-reconnect-mounted","true");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionDetailLookups())).toBeGreaterThan(before);
  await expect(detail).toHaveAttribute("data-reconnect-mounted","true");
});

test("summary Board cards hydrate permission and sign-in controls", async ({ page }) => {
  await page.goto("/sessions-board-e2e.html?cards&sessionSummaries=1&path=%2Fboard");
  const approval=page.locator('.board .card[data-session-id="s-permission"]');
  await expect(approval.getByRole("button",{ name: "Approve",exact: true })).toBeVisible();
  await expect(approval.getByRole("button",{ name: "Deny",exact: true })).toBeVisible();
  const signIn=page.locator('.board .card[data-session-id="s-sign-in"]');
  await signIn.getByRole("button",{ name: "Sign In",exact: true }).click();
  await expect(page.getByRole("menu",{ name: "Sign In" }).getByRole("menuitem").first()).toBeVisible();
});
