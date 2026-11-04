import { expect, test, type Page } from "@playwright/test";

/**
 * The Projects Overview (#2958; docs/design-system.md §6.1, §6.2, §11.4), in the real Shell: the
 * default detail beside the list on desktop and compact widths, and its own route on a phone.
 * `?projects=` picks the fixture (command-inbox-projects-main.tsx): `attention` has an offline
 * project, one with no locations and two named Docs Site; `healthy` has nothing to fix; `two` is
 * small enough for Get Started.
 */
const shell = (path: string, projects: string) =>
  `/command-inbox-projects-e2e.html?fullShell=1&history=1&path=${encodeURIComponent(path)}&projects=${projects}`;
const projectPath = (id: string) => `/projects/~${Buffer.from(id, "utf16le").toString("base64url")}`;

async function open(page: Page, path: string, projects: string) {
  await page.goto(shell(path, projects));
  await page.evaluate(() => localStorage.clear());
  await page.goto(shell(path, projects));
  await expect(page.locator("#page-title")).toBeVisible();
}

const routePath = (page: Page) => page.evaluate(() => new URL(window.location.href).searchParams.get("path"));
const overview = (page: Page) => page.locator(".master-detail-detail > .projects-overview");
const section = (page: Page, title: string) => overview(page).locator("section").filter({
  has: page.locator(".section-title", { hasText: new RegExp(`^${title}`) }),
});

for (const width of [1440, 834]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("with no selection the detail is the overview, each problem one row with its action", async ({ page }) => {
      await open(page, "/projects", "attention");
      await expect(overview(page).getByRole("heading", { level: 2 })).toHaveText("Projects Overview");
      await expect(overview(page).locator(".projects-overview-summary"))
        .toHaveText("10 projects on 2 machines, with 51 sessions. 3 are running now.");
      await expect(page.getByText("Select a Project")).toHaveCount(0);
      const attention = section(page, "Needs Attention");
      await expect(attention.locator(".projects-overview-count")).toHaveText("4");
      const rows = attention.locator(".surface > .row");
      await expect(rows.locator(".row-title")).toHaveText(["Docs Site", "Secret", "Edge Proxy", "2 Projects Named Docs Site"]);
      await expect(rows.nth(0).locator(".status")).toHaveText("Runner Offline");
      await expect(rows.nth(0).locator(".row-sub")).toHaveText("Studio Workstation is offline, so this project can't start sessions.");
      await expect(rows.nth(2).locator(".row-sub")).toHaveText("No locations yet, so it can't start sessions.");
      await expect(rows.locator("button")).toHaveText(["Open", "Open", "Add Location…", "Rename…"]);
      // Two-line rows at the row height, with the action inside the row.
      for (const index of [0, 1, 2, 3]) {
        expect(await rows.nth(index).evaluate((element) => element.getBoundingClientRect().height)).toBe(56);
      }
      await expect(section(page, "Most Active").locator(".surface > .row")).toHaveCount(5);
      await expect(section(page, "Get Started")).toHaveCount(0);
    });

    test("Add Location… opens Add Location for that project, and Rename… opens the first Docs Site with Name focused", async ({ page }) => {
      await open(page, "/projects", "attention");
      await section(page, "Needs Attention").getByRole("button", { name: "Add Location to Edge Proxy" }).click();
      await expect(page.getByRole("dialog", { name: "Add Location to Edge Proxy" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await section(page, "Needs Attention").getByRole("button", { name: "Rename Docs Site" }).click();
      expect(await routePath(page)).toBe(projectPath("docs-site"));
      const name = page.getByRole("textbox", { name: "Name", exact: true });
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("Docs Site");
    });

    test("Most Active opens its project, and a search that matches nothing leaves the overview", async ({ page }) => {
      await open(page, "/projects", "attention");
      const active = section(page, "Most Active").locator(".surface > .row");
      await expect(active.locator(".row-title")).toHaveText(["Field App", "Docs Site", "Infra", "Billing Service", "Growth Experiments"]);
      await expect(active.nth(3).locator(".row-trail")).toHaveText("7 sessions, 2 running");
      await page.getByRole("searchbox", { name: "Search Projects" }).fill("zzz");
      await expect(page.locator(".master-detail-list-body")).toContainText("No projects match “zzz”.");
      await expect(overview(page).locator(".projects-overview-summary")).toContainText("10 projects");
      await active.nth(0).click();
      expect(await routePath(page)).toBe(projectPath("field-app"));
      await expect(page.locator(".master-detail-detail").getByRole("heading", { level: 2, name: "Field App" })).toBeVisible();
    });

    test("with nothing to fix the section is one green-dot line, and two projects show Get Started", async ({ page }) => {
      await open(page, "/projects", "healthy");
      const attention = section(page, "Needs Attention");
      await expect(attention.locator(".projects-overview-ok")).toHaveText("Every project can start sessions.");
      await expect(attention.locator(".surface")).toHaveCount(0);
      await expect(section(page, "Get Started")).toHaveCount(0);

      await open(page, "/projects", "two");
      const start = section(page, "Get Started");
      await expect(start.getByRole("button")).toHaveText(["New Project", "Connect a Machine"]);
      await start.getByRole("button", { name: "New Project", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "New Project" })).toBeVisible();
    });
  });
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the list's first row opens /projects/overview under its detail bar, and Back returns to the list", async ({ page }) => {
    await open(page, "/projects", "attention");
    const list = page.locator(".master-detail-list-body");
    const first = list.locator(":scope > .row").first();
    await expect(first).toHaveClass(/\bproject-list-overview\b/);
    await expect(first.locator(".row-title")).toHaveText("Projects Overview");
    await expect(first.locator(".count-badge")).toHaveText("4");
    await expect(first).toHaveAccessibleDescription("4 items need attention");
    await expect(page.locator(".master-detail-detail")).toBeHidden();

    await first.tap();
    expect(await routePath(page)).toBe("/projects/overview");
    const bar = page.locator(".detail-bar");
    await expect(bar.getByRole("heading", { level: 1 })).toHaveText("Projects Overview");
    await expect(list).toBeHidden();
    await expect(overview(page)).toBeVisible();
    await expect(overview(page).locator(".projects-overview-title")).toHaveCount(0);
    await expect(section(page, "Needs Attention").locator(".surface > .row")).toHaveCount(4);

    await bar.getByRole("button", { name: "Back to Projects", exact: true }).tap();
    expect(await routePath(page)).toBe("/projects");
    await expect(page.locator(".detail-bar")).toHaveCount(0);
    await expect(list).toBeVisible();
  });

  test("a deep link to /projects/overview opens the overview, and the browser's Back leaves it", async ({ page }) => {
    await open(page, "/projects", "two");
    await page.locator(".master-detail-list-body .project-list-overview").tap();
    await expect(page.locator(".detail-bar h1")).toHaveText("Projects Overview");
    await expect(section(page, "Get Started").getByRole("button")).toHaveText(["New Project", "Connect a Machine"]);
    await page.goBack();
    expect(await routePath(page)).toBe("/projects");
    await expect(page.locator(".master-detail-list-body")).toBeVisible();

    await open(page, "/projects/overview", "healthy");
    await expect(page.locator(".detail-bar h1")).toHaveText("Projects Overview");
    await expect(section(page, "Needs Attention").locator(".projects-overview-ok")).toHaveText("Every project can start sessions.");
  });
});
