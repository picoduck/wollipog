import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The Projects frame (#2957; docs/design-system.md §4.2, §5.2, §6, §6.2, §10.2, §12, §13.2), in the
 * real Shell: the shared master-detail whose panes scroll on their own, two-line project rows, the
 * Sessions Tabs filter with plain counts, one state per situation, and list and detail as two
 * routes on a phone. `?projects=` picks the fixture (command-inbox-projects-main.tsx).
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
const scrollTo = (locator: Locator, top: number) => locator.evaluate((element, value) => { element.scrollTop = value; }, top);
const scrollTop = (locator: Locator) => locator.evaluate((element) => element.scrollTop);
const listBody = (page: Page) => page.locator(".master-detail-list-body");
const detail = (page: Page) => page.locator(".master-detail-detail");
const row = (page: Page, name: string) => listBody(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

test.describe("at desktop widths", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the list pane is 320px, or 280px in the compact tier, flush, with a hairline divider", async ({ page }) => {
    await open(page, projectPath("alpha"), "nine");
    const pane = page.locator(".master-detail-list");
    const measure = () => pane.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: element.getBoundingClientRect().width, divider: style.borderRightWidth, background: style.backgroundColor, radius: style.borderTopLeftRadius };
    });
    expect(await measure()).toEqual({ width: 320, divider: "1px", background: "rgba(0, 0, 0, 0)", radius: "0px" });
    await page.setViewportSize({ width: 1000, height: 800 });
    expect((await measure()).width).toBe(280);
  });

  test("scrolling the detail does not move the list, and choosing another project shows its title at the top", async ({ page }) => {
    await open(page, projectPath("alpha"), "many");
    const list = listBody(page);
    const pane = detail(page);
    await expect(pane.getByRole("heading", { level: 2, name: "Alpha" })).toBeVisible();
    const overflow = await pane.evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(overflow, "Alpha's detail is taller than the viewport").toBeGreaterThan(300);

    await scrollTo(list, 400);
    await scrollTo(pane, 300);
    expect(await scrollTop(list), "scrolling the detail leaves the list where it was").toBe(400);
    expect(await scrollTop(pane)).toBe(300);
    expect(await page.locator(".main-body").evaluate((element) => element.scrollHeight - element.clientHeight),
      "the page itself never scrolls").toBe(0);

    const choose = async (name: string, listTop: number) => {
      await row(page, name).click();
      const title = pane.getByRole("heading", { level: 2, name, exact: true });
      await expect(title).toBeVisible();
      expect(await scrollTop(pane), `${name}: the detail starts at its top`).toBe(0);
      const [titleBox, paneBox] = [await title.boundingBox(), await pane.boundingBox()];
      expect(titleBox!.y - paneBox!.y, `${name}: its title is at the top of the detail`).toBeLessThan(40);
      expect(await scrollTop(list), `${name}: the list keeps its place`).toBe(listTop);
      await expect(row(page, name)).toHaveAttribute("aria-current", "true");
    };
    // A row on screen at the list's position, so choosing it scrolls nothing.
    await choose("Team Project 12", 400);
    expect(await routePath(page)).toBe(projectPath("team-project-12"));
    // And back to the tall detail from the list's top, after scrolling the one now open.
    await scrollTo(list, 0);
    await scrollTo(pane, 300);
    await choose("Alpha", 0);
  });

  test("the filter reads All 9, Shown 8 and Hidden 1, and Hidden lists only the hidden project", async ({ page }) => {
    await open(page, "/projects", "nine");
    const filter = page.getByRole("radiogroup", { name: "Sessions Tabs" });
    await expect(filter.getByRole("radio")).toHaveText(["All 9", "Shown 8", "Hidden 1"]);
    await expect(filter.locator(".seg-count")).toHaveText(["9", "8", "1"]);
    await expect(listBody(page).getByRole("button")).toHaveCount(9);
    await filter.getByRole("radio", { name: "Hidden 1" }).click();
    await expect(listBody(page).getByRole("button")).toHaveCount(1);
    await expect(row(page, "Secret")).toBeVisible();
    await filter.getByRole("radio", { name: "Shown 8" }).click();
    await expect(listBody(page).getByRole("button")).toHaveCount(8);
    await expect(row(page, "Secret")).toHaveCount(0);
  });

  test("a row is 56px in the UI font, names its default location's machine and ends with its session count", async ({ page }) => {
    await open(page, "/projects", "nine");
    const facts = (name: string) => row(page, name).evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      font: getComputedStyle(element.querySelector(".row-title")!).fontFamily,
      ui: getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim(),
      title: element.querySelector(".row-title")!.textContent,
      sub: element.querySelector(".row-sub")!.textContent,
      count: element.querySelector(".row-trail [aria-hidden]")!.textContent,
      badge: element.querySelector(".status")?.textContent ?? null,
    }));
    const billing = await facts("Billing Service");
    expect(billing).toMatchObject({ height: 56, title: "Billing Service", sub: "Build Machine", count: "7", badge: null });
    expect(billing.font, "the name uses the UI font").toBe(billing.ui);
    // Every location offline: one status after the name. Without locations, the sub-line says so.
    expect(await facts("Docs Site")).toMatchObject({ sub: "Studio Workstation", badge: "Runner Offline" });
    expect(await facts("Edge Proxy")).toMatchObject({ sub: "No locations yet", badge: null });
    expect(await facts("Secret")).toMatchObject({ sub: "Hidden tab · Studio Workstation" });
  });

  test("the search matches machines, and a search with no match is one inline row with Clear Search", async ({ page }) => {
    await open(page, "/projects", "nine");
    const search = page.getByRole("searchbox", { name: "Search Projects" });
    await expect(search).toHaveAttribute("placeholder", "Search projects");
    // Alpha has a location on Studio Workstation beside its default on Build Machine.
    await search.fill("studio");
    await expect(listBody(page).getByRole("button")).toHaveText([/^Alpha/, /^Docs Site/, /^Secret/]);
    await expect(page.getByRole("radiogroup", { name: "Sessions Tabs" }).getByRole("radio")).toHaveText(["All 3", "Shown 2", "Hidden 1"]);

    await search.fill("zzz");
    const noMatch = listBody(page).locator(".state");
    await expect(noMatch).toHaveCount(1);
    await expect(noMatch).toContainText("No projects match “zzz”.");
    await expect(page.getByText("Select a Project")).toHaveCount(0);
    await noMatch.getByRole("button", { name: "Clear Search", exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(listBody(page).getByRole("button")).toHaveCount(9);
  });

  test("a search with no match leaves an open project in the detail", async ({ page }) => {
    await open(page, projectPath("alpha"), "nine");
    await page.getByRole("searchbox", { name: "Search Projects" }).fill("zzz");
    await expect(listBody(page)).toContainText("No projects match “zzz”.");
    await expect(detail(page).getByRole("heading", { level: 2, name: "Alpha" })).toBeVisible();
  });

  test("with no projects, one No Projects Yet state spans the content and the header has no New Project", async ({ page }) => {
    await open(page, "/projects", "empty");
    await expect(page.locator(".master-detail")).toHaveCount(0);
    const state = page.locator(".master-detail-state");
    await expect(state.getByRole("heading", { level: 2 })).toHaveText("No Projects Yet");
    await expect(state).toContainText("A project is a repository on one or more of your machines. Sessions start inside a project.");
    await expect(page.locator(".page-header").getByRole("button", { name: "New Project" })).toHaveCount(0);
    await expect(state.getByRole("button", { name: "Connect a Machine", exact: true })).toBeVisible();
    await state.getByRole("button", { name: "New Project", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New Project" })).toBeVisible();
  });

  test("an older server shows the Projects Need an Update notice", async ({ page }) => {
    await open(page, "/projects", "unsupported");
    const notice = page.locator(".master-detail-state .notice");
    await expect(notice).toHaveClass(/\bt-warning\b/);
    await expect(notice.getByRole("heading", { level: 2 })).toHaveText("Projects Need an Update");
    await expect(notice).toContainText("Update Wollipog to manage projects and locations. Your sessions aren’t affected.");
    await expect(page.getByText("Project Management Unavailable")).toHaveCount(0);
    await expect(page.locator(".master-detail")).toHaveCount(0);
  });

  test("loading shows skeleton rows at the row's height and the detail skeleton", async ({ page }) => {
    await open(page, "/projects", "loading");
    const skeletonRows = page.locator(".master-detail-list .project-row-skeleton");
    await expect(skeletonRows).toHaveCount(5);
    expect(await skeletonRows.first().evaluate((element) => element.getBoundingClientRect().height)).toBe(56);
    await expect(detail(page).locator(".detail-skeleton")).toBeVisible();
    await expect(page.locator(".page-header").getByRole("button", { name: "New Project" })).toBeDisabled();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("rows are 64px on touch, and the app bar's + is New Project", async ({ page }) => {
    await open(page, "/projects", "nine");
    expect(await row(page, "Alpha").evaluate((element) => element.getBoundingClientRect().height)).toBe(64);
    const plus = page.locator(".page-header").getByRole("button", { name: "New Project", exact: true });
    const box = await plus.boundingBox();
    expect([box!.width, box!.height]).toEqual([44, 44]);
    await expect(detail(page)).toBeHidden();
  });

  test("a project opens its own route with Back, and ‹ or the browser's Back returns to the list where it was", async ({ page }) => {
    await open(page, "/projects", "many");
    const list = listBody(page);
    await scrollTo(list, 600);
    for (const back of ["bar", "browser"] as const) {
      // A row on screen at the list's position, so tapping it scrolls nothing.
      await row(page, "Team Project 14").tap();
      expect(await routePath(page)).toBe(projectPath("team-project-14"));
      const bar = page.locator(".detail-bar");
      await expect(bar.getByRole("heading", { level: 1 })).toHaveText("Team Project 14");
      await expect(list).toBeHidden();
      await expect(page.locator("#page-title")).toBeFocused();
      expect(await page.locator(".main-body").evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
      if (back === "bar") await bar.getByRole("button", { name: "Back to Projects", exact: true }).tap();
      else await page.goBack();
      await expect(page.locator(".detail-bar")).toHaveCount(0);
      expect(await routePath(page)).toBe("/projects");
      await expect(list).toBeVisible();
      expect(await scrollTop(list), `${back}: the list is where it was`).toBe(600);
      await expect(page.locator(".master-detail-list .is-selected"), "a phone list shows no selected row").toHaveCount(0);
    }
  });
});
