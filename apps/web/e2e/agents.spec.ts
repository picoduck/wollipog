import { expect, test } from "@playwright/test";
test.use({ video: "on" });

/** The app's opaque route segment: UTF-16LE, base64url, no padding (navigation.ts encodeOpaque). */
const opaque = (value: string) => Buffer.from(value, "utf16le").toString("base64url");
const FIXTURE_SESSION = "agents-fixture";
const attentionPath = (requestId?: string) =>
  `/sessions/~${opaque(FIXTURE_SESSION)}/attention${requestId === undefined ? "" : `/~${opaque(requestId)}`}`;

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
    // The list and the board say WHAT is pending on the card itself (#896): one pill per kind with
    // its count, and no disclosure to open. The exact request is reached through the session.
    const pill = origin.locator(".status.t-warning").first();
    await pill.scrollIntoViewIfNeeded();
    await expect(pill).toHaveAttribute("aria-label", "Attention: Approval Required, 2 Requests");
    // A phone list card has one line for sender and signals, so it shows the top kind and "+N".
    await expect(pill.locator(".status-count")).toHaveText(surface === "inbox" && viewport.name === "mobile" ? "+1" : "2");
    await expect(origin.getByText("2 Requests", { exact: true })).toHaveCount(0);
    await expect(origin.locator(".attention-requests")).toHaveCount(0);
    await page.screenshot({ path: `.agents/tmp/attention-navigation/${surface}-${viewport.name}-${theme}-pills.png`, fullPage: true });
    // The route accepts exactly one query parameter; the fixture remembers the theme from the
    // first load in session storage, so the deep link carries only the epoch.
    await page.goto(`${attentionPath("permission-b")}?epoch=0`);
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
    await expect(page.getByRole("button", { name: "Audit Storage · Approval Required", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

async function serveFixtureUnderSessionRoutes(page: import("@playwright/test").Page): Promise<void> {
  const fixture = await page.request.get("/agents-e2e.html");
  const fixtureHtml = await fixture.text();
  await page.route("**/sessions/**", (route) => route.fulfill({ contentType: "text/html", body: fixtureHtml }));
}

test("aggregate attention links focus the full request list without choosing a request", async ({ page }) => {
  await serveFixtureUnderSessionRoutes(page);
  await page.goto(`${attentionPath()}?epoch=0`);
  await expect(page).toHaveURL(/\/attention\?epoch=0$/);
  await expect(page.getByRole("region", { name: "Worker Attention", exact: true })).toBeFocused();
  await expect(page.getByRole("region", { name: "Selected Worker Request", exact: true })).toHaveCount(0);
});

test("attention links cannot alias reused requests after reprocessing and primary requests keep one form", async ({ page }) => {
  await serveFixtureUnderSessionRoutes(page);
  await page.goto(`${attentionPath("permission-a")}?epoch=0`);
  await expect(page.getByRole("region", { name: "Selected Worker Request", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open Request in Session", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reprocess Session", exact: true }).click();
  await expect(page.getByText("This attention link belongs to an earlier session version. No request was selected.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Request in Session", exact: true })).toHaveCount(0);
});

test("a worker's question is answered on its Agents panel card, never on the dock, with one form (#2205)", async ({ page }) => {
  await page.goto("/agents-e2e.html?primary-question=1");
  await expect(page.locator(".request-dock")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Parser/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Audit Storage · Answer Required", exact: true }).click();
  await expect(page.getByRole("region", { name: "Selected Worker Request", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Open Request in Session", exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: /Parser/ }).click();
  await expect(page.getByRole("button", { name: "Submit Answers", exact: true })).toHaveCount(1);
  await expect(page.getByRole("radio", { name: /Parser/ })).toBeChecked();
});

test("a worker's long question expanded on its Agents panel card keeps its answers and footer in reach (#2683)", async ({ page }) => {
  await page.goto("/agents-e2e.html?primary-question=1&long-question=1");
  await page.getByRole("button", { name: "Audit Storage · Answer Required", exact: true }).click();
  const card = page.getByRole("region", { name: "Selected Worker Request", exact: true }).getByRole("region", { name: "Agent Questions" });
  await card.getByRole("button", { name: "Show Full Question" }).click();
  await expect(card.getByRole("button", { name: "Show Less" })).toHaveAttribute("aria-expanded", "true");
  const bounds = (locator: typeof card) => locator.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
  // The capped card scrolls the whole question and its body under its footer; nothing is squeezed away.
  expect((await bounds(card.locator(".request-card-body"))).height).toBeGreaterThan(20);
  const parser = card.getByRole("radio", { name: /Parser/ });
  await parser.scrollIntoViewIfNeeded();
  await parser.click();
  await expect(parser).toBeChecked();
  const [cardBox, submitBox] = [await bounds(card), await bounds(card.getByRole("button", { name: "Submit Answers", exact: true }))];
  expect(submitBox.bottom).toBeLessThanOrEqual(cardBox.bottom + 0.5);
  expect(submitBox.top).toBeGreaterThanOrEqual(cardBox.top);
});

test("a selected child request promoted to primary moves focus to its canonical response form", async ({ page }) => {
  await page.goto("/agents-e2e.html?primary-question=1");
  await page.getByRole("button", { name: "Inspect Parser · Approval Required", exact: true }).click();
  await expect(page.getByRole("region", { name: "Selected Worker Request", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Resolve Primary Request", exact: true }).click();
  await expect(page.locator('[data-session-request-id="permission-b"]')).toBeFocused();
  await expect(page.getByRole("button", { name: "Open Request in Session", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(1);
});

test("an active-tail conflict on initial registry load retries against the current generation", async ({ page }) => {
  await page.goto("/agents-e2e.html?registry-retry=initial");
  await expect(page.getByText("Durable First", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __registryCalls?: number }).__registryCalls)).toBe(2);
  await expect(page.getByRole("button", { name: "Retry Recorded Workers", exact: true })).toHaveCount(0);
});

test("a Load More generation conflict preserves verified pages and retries the cursor", async ({ page }) => {
  await page.goto("/agents-e2e.html?registry-retry=load-more");
  await expect(page.getByText("Durable First", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load More Recorded Workers", exact: true }).click();
  await expect(page.getByText("Recorded worker inventory changed while loading. Retrying…", { exact: true })).toBeVisible();
  await expect(page.getByText("Durable First", { exact: true })).toBeVisible();
  await expect(page.getByText("Durable Second", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __registryCalls?: number }).__registryCalls)).toBe(3);
});

test("exhausted automatic registry retries retain a manual recovery action", async ({ page }) => {
  await page.goto("/agents-e2e.html?registry-retry=exhaust");
  const retry = page.getByRole("button", { name: "Retry Recorded Workers", exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByText("Durable First", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __registryCalls?: number }).__registryCalls)).toBe(4);
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
    await page.getByRole("button", { name: "Inspect Parser · Approval Required", exact: true }).click();
    await expect(page.getByRole("region", { name: "Selected Worker Request" })).toBeFocused();
    await expect(page.getByText("The parser tests are ready to run.")).toBeVisible();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByRole("button", { name: "Inspect Parser · Approval Required", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Worker Attention", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Audit Storage · Approval Required", exact: true })).toBeVisible();
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
