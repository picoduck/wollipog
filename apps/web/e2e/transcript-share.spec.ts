import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * #2148: Share Transcript is one dialog anatomy (docs/design-system.md §7.2–§7.5, §10.2, §5.2): an
 * expiry segmented control on the footer's control height, link rows with relative times and an
 * inline status badge, and a Revoke Link confirmation that names the link.
 */

// A fixed local wall clock (it keeps running), so the rows' relative times are the same on any date.
const NOW = new Date(2026, 8, 30, 14, 26);

async function open(page: Page, query = ""): Promise<Locator> {
  await page.clock.install({ time: NOW });
  await page.goto(`/transcript-share-e2e.html${query}`);
  const dialog = page.getByRole("dialog", { name: "Share Transcript" });
  await expect(dialog).toBeVisible();
  await dialogMotionSettled(page);
  return dialog;
}

const height = (locator: Locator) => locator.evaluate((element) => element.getBoundingClientRect().height);
const rows = (dialog: Locator) => dialog.locator(".share-links .surface > .row[data-share-id]");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the expiry control and every footer button share one height, and the expiry is a radiogroup", async ({ page }) => {
    const dialog = await open(page);
    await expect(dialog).toHaveAccessibleDescription("Anyone with the link can read this conversation until it expires or you revoke it.");
    await expect(dialog.locator(".notice")).toHaveCount(0);
    const group = dialog.getByRole("radiogroup", { name: "Link Expires" });
    await expect(group.getByRole("radio")).toHaveText(["1 Hour", "1 Day", "7 Days", "30 Days"]);
    await expect(group.getByRole("radio", { name: "1 Day" })).toHaveAttribute("aria-checked", "true");

    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const create = dialog.getByRole("button", { name: "Create Link" });
    const heights = { group: await height(group), cancel: await height(cancel), create: await height(create) };
    expect(heights.group).toBe(heights.cancel);
    expect(heights.create).toBe(heights.cancel);
    await expect(dialog.locator(".modal-foot button")).toHaveText(["Cancel", "Create Link"]);

    // Arrow keys move and select (§10.2).
    await group.getByRole("radio", { name: "1 Day" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "7 Days" })).toBeFocused();
    await expect(group.getByRole("radio", { name: "7 Days" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(group.getByRole("radio", { name: "1 Hour" })).toHaveAttribute("aria-checked", "true");

    // Links: a section title over one surface of two-line rows with relative times and badges.
    const title = dialog.locator(".share-links .section-title");
    await expect(title).toHaveText("Links3");
    expect(await title.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)))
      .toBeLessThanOrEqual(await dialog.locator(".modal-title").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)));
    await expect(rows(dialog).locator(".row-title")).toHaveText(["Expires in 7 days", "Revoked", "Expired on Sep 21"]);
    await expect(rows(dialog).locator(".status.inline")).toHaveText(["Active", "Revoked", "Expired"]);
    await expect(rows(dialog).locator(".row-sub")).toHaveText(["Created today at 12:26 PM", "Created Sep 27 at 2:26 PM", "Created Sep 20 at 2:26 PM"]);
    for (const text of await rows(dialog).allTextContents()) expect(text).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    for (const row of await rows(dialog).all()) expect(await height(row)).toBe(56);
    // Only the active link can be revoked.
    await expect(rows(dialog).getByRole("button")).toHaveCount(1);
    await expect(rows(dialog).getByRole("button")).toHaveText("Revoke…");
    expect(await height(rows(dialog).getByRole("button"))).toBe(28);
  });

  test("Create Link shows the new link with Copy Link, a single Done, and the new row first", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const dialog = await open(page, "?delay=400");
    await dialog.getByRole("button", { name: "Create Link" }).click();
    await expect(dialog.getByRole("button", { name: "Create Link" })).toHaveAttribute("aria-busy", "true");
    const link = dialog.getByRole("textbox", { name: "New Link" });
    await expect(link).toHaveValue(/^https:\/\/studio\.tailnet\.ts\.net\/#share=/);
    await expect(link).toHaveAttribute("readonly", "");
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await expect(dialog.locator(".modal-foot button")).toHaveText(["Done"]);
    const copy = dialog.getByRole("button", { name: "Copy Link" });
    await expect(copy).toBeFocused();
    expect(await height(copy)).toBe(await height(link));
    expect(await height(dialog.getByRole("button", { name: "Done" }))).toBe(await height(link));
    await expect(rows(dialog).first().locator(".row-title")).toHaveText("Expires in 1 day");
    await expect(rows(dialog).first().locator(".status.inline")).toHaveText("Active");

    await copy.click();
    await expect(page.locator(".toast")).toContainText("Link copied.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await link.inputValue());

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share" })).toBeFocused();
  });

  test("on a loopback address the dialog explains why and offers only Done", async ({ page }) => {
    const dialog = await open(page, "?state=unavailable");
    const notice = dialog.locator(".notice.t-warning");
    await expect(notice).toContainText("Sharing Needs a Reachable Address");
    await expect(notice).toContainText("Open Wollipog from an address other people can reach, such as your LAN or Tailscale URL, then create the link.");
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Create Link" })).toHaveCount(0);
    await expect(dialog.locator(".modal-foot button")).toHaveText(["Done"]);
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice).toContainText(/Wollipog is open at http:\/\/127\.0\.0\.1:\d+, which other people can't reach\./);
  });

  test("Revoke… opens Revoke Link over the dialog, Cancel returns focus, and confirming revokes the row", async ({ page }) => {
    const dialog = await open(page, "?delay=300");
    const revoke = rows(dialog).first().getByRole("button", { name: /^Revoke Link That Expires Oct 7 at \d{1,2}:26 PM$/ });
    await revoke.click();
    const confirmation = page.getByRole("dialog", { name: "Revoke Link" });
    await expect(confirmation).toBeVisible();
    await dialogMotionSettled(page);
    await expect(confirmation).toContainText(/The link that expires Oct 7 at \d{1,2}:26 PM stops working right away\. Anyone who has it loses access\./);
    // Stacked on the dialog under one dim (§7.1).
    await expect(dialog).toBeVisible();
    const dims = await page.locator(".modal-backdrop").evaluateAll((backdrops) =>
      backdrops.filter((backdrop) => getComputedStyle(backdrop).backgroundColor !== "rgba(0, 0, 0, 0)").length);
    expect(dims).toBe(1);
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(revoke).toBeFocused();

    await revoke.click();
    await page.getByRole("dialog", { name: "Revoke Link" }).getByRole("button", { name: "Revoke Link" }).click();
    await expect(page.locator(".toast")).toContainText("Link revoked.");
    await expect(rows(dialog).first().locator(".row-title")).toHaveText("Revoked");
    await expect(rows(dialog).first().locator(".status.inline")).toHaveText("Revoked");
    await expect(rows(dialog).getByRole("button")).toHaveCount(0);
    // Revoke… is gone, so focus goes to the Links title rather than the page.
    await expect(dialog.locator(".share-links .section-title")).toBeFocused();
  });

  test("links load behind skeleton rows, and an empty list says so", async ({ page }) => {
    let dialog = await open(page, "?state=loading");
    const skeleton = dialog.locator('.share-links [data-loading="links"]');
    await expect(skeleton.locator(".row")).toHaveCount(3);
    for (const row of await skeleton.locator(".row").all()) expect(await height(row)).toBe(56);
    await expect(dialog.locator(".share-links-empty")).toHaveCount(0);

    dialog = await open(page, "?state=empty");
    await expect(dialog.locator(".share-links-empty")).toHaveText("No links yet.");
    await expect(dialog.locator(".share-links .section-title")).toHaveText("Links");

    dialog = await open(page, "?state=load-error");
    await expect(dialog.locator(".share-links .notice.t-danger")).toContainText("Couldn't Load Links");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Revoke… stays 28px, and Revoke Link replaces the sheet's content with Back", async ({ page }) => {
    const dialog = await open(page);
    const revoke = rows(dialog).first().getByRole("button");
    expect(await height(revoke)).toBe(28);
    // The rows and the footer fit the sheet without a horizontal scroll.
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await revoke.click();
    const confirmation = page.getByRole("dialog", { name: "Revoke Link" });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Back to Share Transcript" })).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog", { name: "Share Transcript" })).toBeVisible();
    await expect(revoke).toBeFocused();
  });
});
