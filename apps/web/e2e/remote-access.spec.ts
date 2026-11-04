import { seedDelegatedUiEvidence } from "./fixtures/delegated-ui-evidence-seed.js";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteAccessFixture } from "../../control-plane/src/remote-access-test-fixture.js";
import { viewPath } from "../src/navigation.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SHOTS = "test-results/remote-access";
const capture = process.env.CAPTURE_REMOTE_ACCESS === "1";
test.use({ video: { mode: capture ? "on" : "off", size: { width: 1440, height: 900 } } });
let fixture: Awaited<ReturnType<typeof remoteAccessFixture>>;
const hold = (page: Page, ms: number) => capture ? page.waitForTimeout(ms) : Promise.resolve();

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const built = spawnSync("pnpm", ["--filter", "@wollipog/web", "build"], { cwd: ROOT, encoding: "utf8", timeout: 90_000 });
  if (built.status !== 0) throw new Error(`web build failed: ${built.stderr.slice(-2000)} ${built.stdout.slice(-2000)}`);
  fixture = await remoteAccessFixture({ webDist: resolve(ROOT, "apps/web/dist") });
  await fixture.launch(true);
});
test.afterAll(async () => { await fixture?.close(); });

async function openNetwork(page: Page, theme = "dark") {
  await page.addInitScript((value) => localStorage.setItem("wollipog.theme", value), theme);
  await page.goto(`${fixture.base}/settings/network#pair=${fixture.owner}`);
  await expect(page.getByRole("button", { name: /Set Up Remote Access/u })).toBeVisible();
}

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}: guided HTTPS setup supplies a ready address and a pairing action`, async ({ page }) => {
      test.setTimeout(60_000);
      await fixture.api("/api/remote-access", "DELETE");
      await page.setViewportSize({ width, height: 900 });
      await openNetwork(page, theme);
      await page.screenshot({ path: `${SHOTS}/${theme}-${width}-before.png` });
      await hold(page, 2000);
      await page.getByRole("button", { name: /Set Up Remote Access/u }).click();
      const dialog = page.getByRole("dialog", { name: "Set Up Remote Access" });
      await expect(dialog.getByRole("radio", { name: "Tailscale", exact: true })).toBeChecked();
      await expect(page.locator(".modal")).toHaveCSS("opacity", "1");
      await page.screenshot({ path: `${SHOTS}/${theme}-${width}-choose.png` });
      await hold(page, 2000);
      await dialog.getByRole("radio", { name: "Use an Existing HTTPS Address", exact: true }).check();
      await dialog.getByLabel("HTTPS Address", { exact: true }).fill(fixture.origin);
      await hold(page, 1500);
      await dialog.getByRole("button", { name: "Set Up Remote Access", exact: true }).click();
      await expect(dialog.getByText("Secure Dashboard Ready", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("link", { name: "Open Dashboard" })).toHaveAttribute("href", fixture.origin);
      await expect(dialog.getByRole("button", { name: "Pair a Device", exact: true })).toBeEnabled();
      await page.screenshot({ path: `${SHOTS}/${theme}-${width}-ready.png` });
      await hold(page, 4000);
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.getByText(fixture.origin, { exact: true })).toBeVisible();
    });
  }
}

test("authorization is an explicit resumable step with a safe external link", async ({ page }) => {
  await fixture.api("/api/remote-access", "DELETE");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNetwork(page);
  let attempts = 0;
  await page.route("**/api/remote-access", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts++;
    await route.fulfill({ json: { canConfigure: true, provider: "tailscale", origin: attempts === 1 ? null : fixture.origin,
      phase: attempts === 1 ? "needs_authorization" : "ready", canDisable: true, verifiedAt: attempts === 1 ? null : Date.now(),
      message: attempts === 1 ? "Authorize HTTPS in Tailscale, then choose Retry Setup." : "Your secure dashboard is ready.",
      ...(attempts === 1 ? { authorizationUrl: "https://login.tailscale.com/f/synthetic-consent" } : {}),
    } });
  });
  await page.getByRole("button", { name: /Set Up Remote Access/u }).click();
  const dialog = page.getByRole("dialog", { name: "Set Up Remote Access" });
  await hold(page, 2000);
  await dialog.getByRole("button", { name: "Set Up Remote Access", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "Authorize HTTPS" })).toHaveAttribute("href", "https://login.tailscale.com/f/synthetic-consent");
  await page.screenshot({ path: `${SHOTS}/authorization.png` });
  await hold(page, 4000);
  await dialog.getByRole("button", { name: "Retry Setup" }).click();
  await expect(dialog.getByText("Secure Dashboard Ready", { exact: true })).toBeVisible();
  await hold(page, 4000);
});

test("a fresh phone follows the generated HTTPS pairing link, connects live, and reviews an artifact", async ({ page, browser }) => {
  test.setTimeout(60_000);
  await fixture.api("/api/remote-access", "DELETE");
  await fixture.api("/api/remote-access", "POST", { provider: "https", origin: fixture.origin });
  const seeded = seedDelegatedUiEvidence(fixture.database, fixture.root, "human", { live: true });
  const id = seeded.childId;
  const occurrenceId = seeded.occurrenceId;
  // Keep the host page on the local origin: only it can create the other device's pairing.
  await page.goto(`${fixture.base}/settings/network#pair=${fixture.owner}`);
  await expect(page.getByRole("button", { name: /Pair a Device/u })).toBeVisible();
  await page.getByRole("button", { name: /Pair a Device/u }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Device Name").fill("Test Phone");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/devices") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create Pairing Link", exact: true }).click();
  const pairing = await (await created).json() as { token: string; pairing: { publicOrigin: string } };
  expect(pairing.pairing.publicOrigin).toBe(fixture.origin);
  await expect(page.locator(".pair-qr svg")).toBeVisible();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
  try {
    const remote = await phone.newPage();
    await remote.goto(`${pairing.pairing.publicOrigin}${viewPath({ name: "session", id })}#pair=${pairing.token}`);
    await expect(remote.getByText("Evidence Child", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    expect(await remote.evaluate(() => window.isSecureContext && Boolean(crypto.subtle))).toBe(true);
    expect(remote.url()).not.toContain("#pair=");
    // Open the human request directly from the session's request notification.
    const review = remote.getByRole("button", { name: /Review|Request/u });
    if (await review.count()) await review.first().click();
    if (!await remote.locator(".ev-tile").count()) {
      const toggle = remote.getByRole("button", { name: "Side Panel", exact: true }).first();
      if (await toggle.count() && await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
      const requests = remote.locator('.session-tools [data-tool="requests"]');
      if (await requests.count()) await requests.click();
      const row = remote.locator(".request-panel-row").first();
      if (await row.count()) await row.click();
    }
    await expect(remote.locator(".ev-tile img")).toBeVisible();
    await remote.locator('.ev-tile input[type="checkbox"]').check();
    await expect(remote.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
    await remote.screenshot({ path: `${SHOTS}/phone-evidence.png` });
    await remote.getByRole("button", { name: "Approve", exact: true }).click();
    const decision = await fixture.api(`/api/sessions/${id}/workflow-decisions/${occurrenceId}`);
    expect((await decision.json()).status).toBe("approved");
  } finally { await phone.close(); }
});
