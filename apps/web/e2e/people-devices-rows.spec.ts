import { devices, expect, test, type Page } from "@playwright/test";

/**
 * People and Devices as two-line rows (#2997): the page frame, row heights on fine and coarse
 * pointers, and the phone's Device Details sheet handing over to its Revoke Device confirmation.
 */

const FIXTURE = "/people-devices-e2e.html";

async function open(page: Page, query = "extra&suspended&role=admin") {
  await page.goto(`${FIXTURE}?${query}`);
  await expect(page.getByRole("region", { name: "Paired Devices" }).getByText("Pat's Phone")).toBeVisible();
}

const rowBoxes = (page: Page) => page.locator("#connections-people-panel .access-row").evaluateAll((rows) =>
  rows.map((row) => ({
    height: Math.round(row.getBoundingClientRect().height),
    // A button that spans the row's width is a full-width action; the stretched open target is not
    // a full-width button, because its box is only the title's.
    wideButtons: [...row.querySelectorAll("button")]
      .filter((button) => button.getBoundingClientRect().width >= row.getBoundingClientRect().width - 2).length,
  })));

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the tab has no in-page heading or identity chip, starts 24px under the tab row and is at most 960px", async ({ page }) => {
    await open(page);
    const panel = page.locator("#connections-people-panel");
    await expect(panel.locator(".access-context, .access-page-intro")).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: "People & Devices" })).toHaveCount(0);
    const geometry = await page.evaluate(() => {
      const header = document.querySelector(".page-header")!.getBoundingClientRect();
      const head = document.querySelector("#connections-people-panel .section-head")!.getBoundingClientRect();
      const sections = document.querySelector("#connections-people-panel .access-sections")!.getBoundingClientRect();
      const title = document.getElementById("page-title")!.getBoundingClientRect();
      return { gap: Math.round(head.top - header.bottom), width: Math.round(sections.width), left: Math.round(sections.left - title.left) };
    });
    expect(geometry.gap).toBe(24);
    expect(geometry.width).toBeLessThanOrEqual(960);
    expect(geometry.left, "left-aligned with the page title").toBe(0);
  });

  test("every row is 56px with one trailing action, and no role is capitalized by CSS", async ({ page }) => {
    await open(page, "extra&suspended");
    for (const row of await rowBoxes(page)) {
      expect(row.height).toBe(56);
      expect(row.wideButtons).toBe(0);
    }
    const trailing = await page.locator("#connections-people-panel .access-row-trail").evaluateAll((slots) =>
      slots.map((slot) => slot.querySelectorAll("button").length));
    expect(trailing.every((count) => count <= 1)).toBe(true);
    // Right edges aligned across the three sections.
    const rights = await page.locator("#connections-people-panel .access-row-trail .btn").evaluateAll((actions) =>
      [...new Set(actions.map((action) => Math.round(action.getBoundingClientRect().right)))]);
    expect(rights).toHaveLength(1);
    const transforms = await page.locator("#connections-people-panel .access-row-meta *").evaluateAll((nodes) =>
      [...new Set(nodes.map((node) => getComputedStyle(node).textTransform))]);
    expect(transforms).toEqual(["none"]);
  });

  test("the whole row is its one open target, while its own controls keep their clicks", async ({ page }) => {
    await open(page, "extra");
    const row = page.getByRole("region", { name: "Paired Devices" }).locator(".access-row").first();
    const box = (await row.boundingBox())!;
    // Line 2's empty middle, away from the title and the trailing Revoke….
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.75);
    await expect(page.getByRole("dialog", { name: "Pat's Phone" })).toBeVisible();
    await page.getByRole("dialog", { name: "Pat's Phone" }).getByRole("button", { name: "Done" }).click();
    // The reveal beside a masked name reveals rather than opening the row.
    await row.getByRole("button", { name: "Show Person Name" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row).toContainText("pat@example.org");
    await row.getByRole("button", { name: "Revoke…" }).click();
    await expect(page.getByRole("dialog", { name: "Revoke Device" })).toBeVisible();
  });

  test("arriving on the tab draws no focus ring on the page title", async ({ page }) => {
    await page.goto(`${FIXTURE}?extra`);
    await page.getByRole("tab", { name: "Machines" }).click();
    await page.getByRole("tab", { name: "People and Devices" }).click();
    await expect(page.locator("#people-heading")).toBeVisible();
    const title = page.locator("#page-title");
    expect(await title.evaluate((node) => getComputedStyle(node).outlineStyle === "none" || getComputedStyle(node).outlineWidth === "0px")).toBe(true);
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

  test("at 390px every row is 64px with a chevron, an owner row has its lock, and no full-width button renders in a row", async ({ page }) => {
    await open(page);
    for (const row of await rowBoxes(page)) {
      expect(row.height).toBe(64);
      expect(row.wideButtons).toBe(0);
    }
    await expect(page.locator("#connections-people-panel .access-row-trail .btn")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Only owners can change an owner" })).toBeVisible();
  });

  test("Revoke Device… replaces the Device Details sheet with its confirmation, and Back returns", async ({ page }) => {
    await open(page);
    await page.getByRole("region", { name: "Paired Devices" }).locator(".access-row-open").first().click();
    const details = page.getByRole("dialog", { name: "Pat's Phone" });
    await expect(details).toBeVisible();
    await details.getByRole("button", { name: "Revoke Device…" }).click();
    const confirmation = page.getByRole("dialog", { name: "Revoke Device" });
    await expect(confirmation).toBeVisible();
    await expect(details).toBeHidden();
    const back = confirmation.getByRole("button", { name: "Back to Pat's Phone" });
    await back.click();
    await expect(confirmation).toHaveCount(0);
    await expect(details).toBeVisible();
  });
});
