import { expect, test, type Page } from "@playwright/test";

/**
 * Access as text with Change…, chosen inside Change Access beside its impact (#2960;
 * docs/design-system.md §7, §8.2, §8.4, §13.2). `?projects=access` is a control plane that manages
 * access (command-inbox-projects-main.tsx): Alpha and Beta are shared with Builders, and Beta's
 * location is private to the signed-in owner; Gamma is Organization-Wide.
 */
const shell = (path: string, extra = "") =>
  `/command-inbox-projects-e2e.html?fullShell=1&history=1&path=${encodeURIComponent(path)}&projects=access${extra}`;
const projectPath = (id: string) => `/projects/~${Buffer.from(id, "utf16le").toString("base64url")}`;

async function open(page: Page, id: string, extra = "") {
  await page.goto(shell(projectPath(id), extra));
  await page.evaluate(() => localStorage.clear());
  await page.goto(shell(projectPath(id), extra));
  await expect(projectReadout(page)).toBeVisible();
}

// The project's own readout; each location row has one too.
const projectReadout = (page: Page) => page.locator(".access-scope-readout:not(.project-location-row .access-scope-readout)");
const dialogNamed = (page: Page, name: string) => page.getByRole("dialog", { name });

test.describe("at desktop widths", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Change… opens on the saved access, and each choice shows its impact before Change Access applies it", async ({ page }) => {
    await open(page, "alpha");
    await expect(projectReadout(page).locator(".setting-row-title")).toHaveText("Team: Builders");
    await expect(projectReadout(page).locator(".setting-row-desc")).toHaveText("Everyone on Builders (3 people) can see and use it.");
    await expect(page.locator(".master-detail-detail [aria-haspopup=listbox]")).toHaveCount(0);

    await projectReadout(page).getByRole("button", { name: "Change… Team: Builders" }).click();
    const dialog = dialogNamed(page, "Change Project Access");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Team: Builders/ })).toBeChecked();
    const apply = dialog.getByRole("button", { name: "Change Access" });
    await expect(apply).toBeDisabled();
    await expect(dialog.locator(".access-change-reason")).toHaveText("Choose a different access level.");

    await dialog.getByRole("radio", { name: /Private to Me/ }).check();
    await expect(dialog.locator(".notice.t-warning .notice-title")).toHaveText("5 Sessions Become Private to You");
    await expect(apply).toBeEnabled();
    await dialog.getByRole("radio", { name: /Team: Ghosts/ }).check();
    await expect(dialog.locator(".notice.t-warning .notice-title")).toHaveText("Ghosts Has No Members");
    await dialog.getByRole("radio", { name: /Organization-Wide/ }).check();
    await expect(dialog.locator(".access-change-sentence")).toHaveText("Everyone in your organization will see this project, and its 5 sessions keep their current access.");
    await expect(dialog.locator(".notice")).toHaveCount(0);

    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(projectReadout(page).locator(".setting-row-title")).toHaveText("Organization-Wide");
  });

  test("a project blocked by a private location offers Change Location Access…, and the project change goes through after it", async ({ page }) => {
    await open(page, "beta");
    await projectReadout(page).getByRole("button", { name: /^Change…/ }).click();
    const dialog = dialogNamed(page, "Change Project Access");
    await dialog.getByRole("radio", { name: /Organization-Wide/ }).check();
    const refusal = dialog.locator(".notice.t-danger");
    await expect(refusal.locator(".notice-title")).toHaveText("Can't Change Access");
    await expect(refusal.locator(".notice-body")).toHaveText(
      "A location in this project is more private than this choice. Change that location's access first, or choose a more private option.");
    await expect(dialog.getByRole("button", { name: "Change Access" })).toBeDisabled();

    await refusal.getByRole("button", { name: "Change Location Access…" }).click();
    const location = dialogNamed(page, "Change Location Access");
    await expect(location.locator(".modal-desc")).toHaveText("Laptop Checkout");
    await expect(location.getByRole("radio", { name: /Organization-Wide/ })).toBeChecked();
    await location.getByRole("button", { name: "Change Access" }).click();
    await expect(location).toHaveCount(0);

    await expect(dialog.locator(".access-change-sentence")).toHaveText("Everyone in your organization will see this project, and its 3 sessions keep their current access.");
    await dialog.getByRole("button", { name: "Change Access" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".access-scope-readout .setting-row-title")).toHaveText(["Organization-Wide", "Organization-Wide"]);
  });

  test("narrowing an organization-wide project to a team names the team and how many keep access", async ({ page }) => {
    await open(page, "gamma");
    await projectReadout(page).getByRole("button", { name: "Change… Organization-Wide" }).click();
    const dialog = dialogNamed(page, "Change Project Access");
    await dialog.getByRole("radio", { name: /Team: Builders/ }).check();
    const warning = dialog.locator(".notice.t-warning");
    await expect(warning.locator(".notice-title")).toHaveText("Only Builders Keeps Access");
    await expect(warning.locator(".notice-body")).toHaveText(
      "Everyone on Builders (3 people) keeps access. 4 sessions, 1 of them active, are narrowed to the team.");
  });

  test("while the preview loads the dialog says it is checking, with Change Access off", async ({ page }) => {
    await open(page, "alpha", "&accessPreview=hold");
    await projectReadout(page).getByRole("button", { name: /^Change…/ }).click();
    const dialog = dialogNamed(page, "Change Project Access");
    await dialog.getByRole("radio", { name: /Private to Me/ }).check();
    await expect(dialog.locator(".access-change-checking")).toHaveText("Checking which sessions this affects…");
    await expect(dialog.locator(".access-change-checking .spinner")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Change Access" })).toBeDisabled();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Change Access is a bottom sheet with two equal 48px buttons and 48px choice rows", async ({ page }) => {
    await open(page, "alpha");
    await projectReadout(page).getByRole("button", { name: /^Change…/ }).click();
    const dialog = dialogNamed(page, "Change Project Access");
    await dialog.getByRole("radio", { name: /Private to Me/ }).check();
    await expect(dialog.locator(".notice.t-warning")).toBeVisible();

    const sheet = await page.locator(".modal").first().boundingBox();
    expect(sheet!.x).toBe(0);
    expect(sheet!.width).toBe(390);
    expect(Math.round(sheet!.y + sheet!.height), "the sheet is anchored to the bottom").toBe(844);

    const buttons = dialog.locator(".modal-foot > .btn");
    await expect(buttons).toHaveText(["Cancel", "Change Access"]);
    const [cancel, primary] = [await buttons.nth(0).boundingBox(), await buttons.nth(1).boundingBox()];
    expect(cancel!.height).toBe(48);
    expect(primary!.height).toBe(48);
    expect(Math.abs(cancel!.width - primary!.width)).toBeLessThan(1);

    const rows = await dialog.locator(".choice-row").evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height));
    expect(rows.length).toBe(4);
    for (const height of rows) expect(height).toBeGreaterThanOrEqual(48);
  });
});
