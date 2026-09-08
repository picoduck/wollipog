import { expect, test } from "@playwright/test";
test.use({ video: "on" });

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) for (const surface of ["inbox", "board"]) for (const theme of ["dark", "light"]) {
  test(`exact attention navigation from ${surface} on ${viewport.name} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await page.request.get("/agents-e2e.html");
    const fixtureHtml = await fixture.text();
    await page.route("**/sessions/**", (route) => route.fulfill({ contentType: "text/html", body: fixtureHtml }));
    await page.goto(`/agents-e2e.html?navigation=1&theme=${theme}`);
    const origin = surface === "inbox" ? page.getByRole("grid", { name: "Fixture Inbox" }) : page.locator(".board");
    const summary = origin.getByText("2 Requests", { exact: true });
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.agents/tmp/attention-navigation/${surface}-${viewport.name}-${theme}-collapsed.png`, fullPage: true });
    await summary.focus();
    await summary.press("Enter");
    await expect(origin.getByRole("button", { name: "Request 2 · Child Approval Required", exact: true })).toBeVisible();
    await page.screenshot({ path: `.agents/tmp/attention-navigation/${surface}-${viewport.name}-${theme}-picker.png`, fullPage: true });
    await origin.getByRole("button", { name: "Request 2 · Child Approval Required", exact: true }).press("Enter");
    await expect(page).toHaveURL(/\/attention\/.*epoch=0$/);
    const selected = page.getByRole("region", { name: "Selected Worker Request", exact: true });
    await expect(selected).toBeFocused();
    await expect(selected.getByText("Run Parser Tests?", { exact: true })).toBeVisible();
    await expect(page.getByText("The parser tests are ready to run.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(selected).toBeFocused();
    await expect(selected.getByText("Run Parser Tests?", { exact: true })).toBeVisible();
    await page.screenshot({ path: `.agents/tmp/attention-navigation/${surface}-${viewport.name}-${theme}-target.png`, fullPage: true });
    await selected.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(selected).toHaveCount(0);
    await expect(page.getByText("The linked request is no longer pending. No replacement request was selected.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Audit Storage · Child Approval Required", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("aggregate attention links focus the full request list without choosing a request", async ({ page }) => {
  await page.goto("/agents-e2e.html?navigation=1");
  const inbox = page.getByRole("grid", { name: "Fixture Inbox" });
  await inbox.getByText("2 Requests", { exact: true }).click();
  await inbox.getByRole("button", { name: "View All Requests", exact: true }).click();
  await expect(page).toHaveURL(/\/attention\?epoch=0$/);
  await expect(page.getByRole("region", { name: "Worker Attention", exact: true })).toBeFocused();
  await expect(page.getByRole("region", { name: "Selected Worker Request", exact: true })).toHaveCount(0);
});

test("attention links cannot alias reused requests after reprocessing and primary requests keep one form", async ({ page }) => {
  await page.goto("/agents-e2e.html?navigation=1");
  const inbox = page.getByRole("grid", { name: "Fixture Inbox" });
  await inbox.getByText("2 Requests", { exact: true }).click();
  await inbox.getByRole("button", { name: "Request 1 · Child Approval Required", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Request in Session", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Reprocess Session", exact: true }).click();
  await expect(page.getByText("This attention link belongs to an earlier session version. No request was selected.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Request in Session", exact: true })).toHaveCount(0);
});

test("the session and Agents panel never mount two response forms for the same question", async ({ page }) => {
  await page.goto("/agents-e2e.html?primary-question=1");
  await page.getByRole("radio", { name: /Parser/ }).click();
  await page.getByRole("button", { name: "Audit Storage · Child Answer Required", exact: true }).click();
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toHaveCount(1);
  await expect(page.getByRole("radio", { name: /Parser/ })).toBeChecked();
  await page.getByRole("button", { name: "Open Request in Session", exact: true }).click();
  await expect(page.locator('[data-session-request-id="permission-a"]')).toBeFocused();
});

test("a selected child request promoted to primary moves focus to its canonical response form", async ({ page }) => {
  await page.goto("/agents-e2e.html?primary-question=1");
  await page.getByRole("button", { name: "Inspect Parser · Child Approval Required", exact: true }).click();
  await expect(page.getByRole("region", { name: "Selected Worker Request", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Resolve Primary Request", exact: true }).click();
  await expect(page.locator('[data-session-request-id="permission-b"]')).toBeFocused();
  await expect(page.getByRole("button", { name: "Open Request in Session", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(1);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) for (const theme of ["dark", "light"]) {
  test(`agents preserve exact selection and requests on ${viewport.name} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/agents-e2e.html?theme=${theme}`);
    const roster = page.getByRole("list", { name: "Agents", exact: true });
    await expect(roster.getByRole("listitem")).toHaveCount(3);
    await page.getByRole("button", { name: "Inspect Parser · Child Approval Required", exact: true }).click();
    await expect(page.getByRole("region", { name: "Selected Worker Request" })).toBeFocused();
    await expect(page.getByText("The parser tests are ready to run.")).toBeVisible();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByRole("button", { name: "Inspect Parser · Child Approval Required", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Worker Attention", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Audit Storage · Child Approval Required", exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "History (1)", exact: true }).click();
    await expect(roster.getByText("Review Documentation", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "Active (3)", exact: true }).click();
    await roster.getByRole("button", { name: /Background Monitor/ }).click();
    await expect(page.getByText("Managed Background Job", { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.agents/tmp/wave2-evidence/agents-${viewport.name}-${theme}.png`, fullPage: true });
    await page.getByRole("button", { name: "Disconnect Runner", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Active (0)", exact: true })).toBeVisible();
  });
}
