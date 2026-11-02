import { devices, expect, test, type Page } from "@playwright/test";

/**
 * Your own name (#3001): a new install's owner, still called "Owner", is asked for a name in People
 * and renames themselves from their own row. The rename reaches this dashboard as an in-place
 * directory change (#2606), so no pairing or offline banner appears and nothing reconnects.
 */

const FIXTURE = "/people-devices-e2e.html";

interface FixtureControl {
  identityRequests(): number;
  socketsOpened(): number;
}

const fixture = (page: Page) => page.evaluate(() => {
  const control = (window as unknown as { __WOLLIPOG_PEOPLE_DEVICES_E2E__: FixtureControl }).__WOLLIPOG_PEOPLE_DEVICES_E2E__;
  return { identityRequests: control.identityRequests(), socketsOpened: control.socketsOpened() };
});

async function open(page: Page) {
  await page.goto(`${FIXTURE}?defaultName`);
  await expect(page.getByRole("region", { name: "Paired Devices" }).getByText("Pat's Phone")).toBeVisible();
}

const people = (page: Page) => page.getByRole("region", { name: "People" });
const ownRow = (page: Page) => people(page).locator(".access-row").filter({ hasText: "You" });
/** The pairing and offline banners are both page banners (§13.3). */
const banners = (page: Page) => page.locator(".page-banner");

async function expectRenamedInPlace(page: Page, before: { socketsOpened: number; identityRequests: number }, name: string) {
  await expect(ownRow(page).locator(".row-title")).toHaveText(name);
  await expect(people(page).getByText("Set Your Name", { exact: true })).toHaveCount(0);
  await expect(ownRow(page)).not.toContainText("Default name");
  // The directory change was read in place: identity again, on the same socket, under no banner.
  await expect.poll(async () => (await fixture(page)).identityRequests).toBeGreaterThan(before.identityRequests);
  await page.waitForTimeout(500);
  expect((await fixture(page)).socketsOpened, "nothing reconnected").toBe(before.socketsOpened);
  await expect(banners(page)).toHaveCount(0);
  await expect(page.getByText(/Reconnecting|pair this device/i)).toHaveCount(0);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Set Your Name… renames you in place, with no pairing or offline banner", async ({ page }) => {
    await open(page);
    const notice = people(page).locator(".notice");
    await expect(notice).toContainText("Set Your Name");
    await expect(notice).toContainText("People in your organization see you as “Owner”. Add your name so they know who you are.");
    await expect(ownRow(page)).toContainText("Default name");
    const before = await fixture(page);

    await notice.getByRole("button", { name: "Set Your Name…" }).click();
    const dialog = page.getByRole("dialog", { name: "Your Name" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await expect(dialog).toContainText("You can't change your own access level.");
    await dialog.getByRole("textbox", { name: "Name" }).fill("Misko");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toHaveCount(0);
    await expectRenamedInPlace(page, before, "Misko");
  });

  test("Edit Name… on your own row saves the default unchanged, which still ends the prompt", async ({ page }) => {
    await open(page);
    const before = await fixture(page);
    await ownRow(page).getByRole("button", { name: "Edit Name…" }).click();
    const dialog = page.getByRole("dialog", { name: "Your Name" });
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toHaveCount(0);
    await expectRenamedInPlace(page, before, "Owner");
  });

  test("Not Now hides the notice on this device, across a reload", async ({ page }) => {
    await open(page);
    await people(page).locator(".notice").getByRole("button", { name: "Not Now" }).click();
    await expect(people(page).locator(".notice")).toHaveCount(0);
    await open(page);
    await expect(people(page).locator(".notice")).toHaveCount(0);
    await expect(ownRow(page)).toContainText("Default name");
  });
});

test.describe("phone", () => {
  const phone = devices["iPhone 13"];
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: phone.hasTouch,
    isMobile: phone.isMobile,
    userAgent: phone.userAgent,
    deviceScaleFactor: phone.deviceScaleFactor,
  });

  test("your own row opens Your Name from its body, and every row keeps its 64px height", async ({ page }) => {
    await open(page);
    const heights = await people(page).locator(".access-row").evaluateAll((rows) =>
      rows.map((row) => Math.round(row.getBoundingClientRect().height)));
    expect(heights.every((height) => height === 64)).toBe(true);
    await expect(ownRow(page).locator(".access-row-trail .btn")).toHaveCount(0);
    const before = await fixture(page);
    await ownRow(page).locator(".access-row-open").click();
    const dialog = page.getByRole("dialog", { name: "Your Name" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("Misko");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toHaveCount(0);
    await expectRenamedInPlace(page, before, "Misko");
  });
});
