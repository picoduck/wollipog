import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A project's location rows (#2961; docs/design-system.md §5.2, §9.1, §11.3, §12.1, §15.1–§15.3),
 * in the real Shell with `?projects=locations` (command-inbox-projects-main.tsx): Alpha's default
 * has a long name and is on the offline machine; its other folders show each setup status.
 */
const shell = (path: string) =>
  `/command-inbox-projects-e2e.html?fullShell=1&history=1&path=${encodeURIComponent(path)}&projects=locations`;
const projectPath = (id: string) => `/projects/~${Buffer.from(id, "utf16le").toString("base64url")}`;
const LONG_NAME = "Customer Billing Reconciliation Workspace";

async function open(page: Page, projectId = "alpha") {
  await page.goto(shell(projectPath(projectId)));
  await page.evaluate(() => localStorage.clear());
  await page.goto(shell(projectPath(projectId)));
  await expect(page.locator("#page-title")).toBeVisible();
}

const locations = (page: Page) => page.locator(".project-locations");
const locationRow = (page: Page, name: string) => locations(page).locator(".project-location")
  .filter({ has: page.locator(".project-location-name", { hasText: new RegExp(`^${name}$`) }) });

/** The row's box, and the box of everything in it that should sit on its one line of actions. */
async function rowGeometry(row: Locator) {
  return row.locator(":scope > .row").evaluate((element) => {
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    };
    const name = element.querySelector(".project-location-name")!;
    return {
      row: box(element),
      trailing: [...element.querySelectorAll(":scope > button, :scope > .overflow-menu > button, :scope > .project-location-count")].map(box),
      name: box(name),
      nameMin: parseFloat(getComputedStyle(name).minWidth),
      nameTruncated: name.scrollWidth > name.clientWidth,
      line1: [...element.querySelectorAll(".row-line > *")].map(box),
      machine: box(element.querySelector(".project-location-machine")!),
      path: box(element.querySelector(".project-location-path")!),
    };
  });
}

for (const width of [1440, 1100]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test("every location is one 56px row whose actions never wrap", async ({ page }) => {
      await open(page);
      const rows = locations(page).locator(".project-location");
      await expect(rows).toHaveCount(6);
      const alpha = locationRow(page, "alpha");
      await expect(alpha.locator(".project-location-meta > span")).toHaveText(["Build Machine", "/repos/alpha", "Setup file ready"]);
      await expect(alpha.locator(".project-location-count")).toHaveText("3 Sessions");
      await expect(alpha.getByRole("button", { name: "New Session Here" })).toBeVisible();
      await expect(alpha.getByRole("button", { name: "alpha Actions" })).toBeVisible();
      for (let index = 0; index < 6; index += 1) {
        const geometry = await rowGeometry(rows.nth(index));
        expect(geometry.row.height, `row ${index} is 56px`).toBe(56);
        const centers = geometry.trailing.map((box) => box.top + box.height / 2);
        for (const center of centers) {
          expect(Math.abs(center - (geometry.row.top + geometry.row.height / 2)), `row ${index}'s actions share one line`).toBeLessThanOrEqual(1);
        }
        for (const box of geometry.trailing) expect(box.right).toBeLessThanOrEqual(geometry.row.right);
      }
      // The long-named default on the offline machine: Default, its status, and no New Session Here.
      const billing = locationRow(page, LONG_NAME);
      await expect(billing.locator(".project-location-default")).toHaveText("Default");
      await expect(billing.locator(".row-line .status")).toHaveText("Runner Offline");
      await expect(billing.getByRole("button", { name: "New Session Here" })).toHaveCount(0);
      const geometry = await rowGeometry(billing);
      expect(geometry.name.width).toBeGreaterThanOrEqual(geometry.nameMin - 0.5);
    });
  });
}

test.describe("at 834px", () => {
  test.use({ viewport: { width: 834, height: 1000 } });

  test("New Session Here moves into ⋯, the path takes its own line, and the name keeps seven characters", async ({ page }) => {
    await open(page);
    const alpha = locationRow(page, "alpha");
    await expect(alpha.getByRole("button", { name: "New Session Here" })).toHaveCount(0);
    await expect(alpha.locator(".project-location-count")).toHaveCount(0);
    await expect(alpha.locator(".project-location-meta > span")).toHaveText(["Build Machine", "Setup file ready", "/repos/alpha"]);
    const alphaGeometry = await rowGeometry(alpha);
    expect(alphaGeometry.path.top, "the path wraps under the machine").toBeGreaterThanOrEqual(alphaGeometry.machine.bottom - 0.5);
    expect(alphaGeometry.row.height, "the row grows past 56px").toBeGreaterThan(56);

    const billing = locationRow(page, LONG_NAME);
    const geometry = await rowGeometry(billing);
    expect(geometry.nameMin, "seven characters of the UI font").toBeGreaterThan(30);
    expect(geometry.name.width).toBeGreaterThanOrEqual(geometry.nameMin - 0.5);
    expect(geometry.nameTruncated, "the long name gives way, not its badges").toBe(true);
    for (const box of geometry.line1) expect(box.right, "Default and the status stay inside the row").toBeLessThanOrEqual(geometry.row.right);
    await expect(billing.locator(".row-line .status")).toHaveText("Runner Offline");

    await alpha.getByRole("button", { name: "alpha Actions" }).click();
    const menu = page.getByRole("menu", { name: "alpha Actions" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "New Session Here", "Reveal in File Manager", "Copy Path", "Make Default", "Remove Location…",
    ]);
    await menu.getByRole("menuitem", { name: "New Session Here" }).click();
    await expect(page.getByRole("dialog", { name: "New Session" })).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("⋯ is a bottom sheet without Reveal in File Manager, and rows are at least 64px", async ({ page }) => {
    await open(page);
    const alpha = locationRow(page, "alpha");
    const geometry = await rowGeometry(alpha);
    expect(geometry.row.height).toBeGreaterThanOrEqual(64);
    await alpha.getByRole("button", { name: "alpha Actions" }).click();
    const menu = page.getByRole("menu", { name: "alpha Actions" });
    await expect(menu.getByRole("menuitem")).toHaveText(["New Session Here", "Copy Path", "Make Default", "Remove Location…"]);
    const box = await menu.boundingBox();
    expect(box!.y + box!.height, "docked to the bottom").toBeGreaterThan(844 - 2);
  });
});

test.describe("setup and No Locations", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("setup reads each status; Create Starter Setup File confirms and the row reads Setup file ready", async ({ page }) => {
    await open(page);
    const setup = (name: string) => locationRow(page, name).locator(".project-location-setup");
    await expect(setup("alpha")).toHaveText("Setup file ready");
    await expect(setup("alpha-docs")).toHaveText("No setup file");
    await expect(setup("alpha-api")).toHaveText("Setup file has an error");
    await expect(setup("alpha-tools")).toHaveText("Checking setup…");
    await expect(setup("legacy")).toHaveText("Update Wollipog on Old Laptop to check setup");
    await expect(setup(LONG_NAME)).toHaveCount(0);
    const notice = locationRow(page, "alpha-api").locator(".notice.t-danger");
    await expect(notice).toContainText("The setup file can't be used: setup.commands[0] must be a string");
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice).toContainText("at .wollipog.json:4:7");

    await locationRow(page, "alpha-docs").getByRole("button", { name: "alpha-docs Actions" }).click();
    await page.getByRole("menuitem", { name: "Create Starter Setup File" }).click();
    await expect(page.getByText("Setup file created for alpha-docs.")).toBeVisible();
    await expect(setup("alpha-docs")).toHaveText("Setup file ready");
  });

  test("No Locations is one inline row with Add Location…, and the section head has none", async ({ page }) => {
    await open(page, "edge-proxy");
    const section = page.locator(".project-detail > section").filter({ has: page.getByRole("heading", { name: "Locations" }) });
    await expect(section.locator(".section-head").getByRole("button")).toHaveCount(0);
    const row = section.locator(".surface > .row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Add the folder on one of your machines where this project's sessions run.");
    await expect(row.getByRole("button")).toHaveText(["Add Location…"]);
    await row.getByRole("button", { name: "Add Location…" }).click();
    await expect(page.getByRole("dialog", { name: /^Add Location/ })).toBeVisible();
  });
});
