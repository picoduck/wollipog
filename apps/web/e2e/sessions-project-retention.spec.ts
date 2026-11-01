import { expect, test, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";

const path = (page: Page) => new URL(page.url()).searchParams.get("path") ?? "/";
const selectedGroup = (page: Page) => page.locator('.sessions-group-picker, .tabs-bar .tab[aria-selected="true"]');

async function selectBilling(page: Page) {
  await page.goto("/sessions-board-e2e.html?groups=1&full-shell=1&path=%2F");
  await expect(page.locator(".inbox-row-title").first()).toBeVisible();
  if (await page.locator(".sessions-group-picker").isVisible()) {
    await page.locator(".sessions-group-picker").click();
    await page.getByRole("menuitemradio", { name: /^Billing, 2/ }).click();
  } else {
    await page.getByRole("tab", { name: /^Billing 2/ }).click();
  }
  await expect(selectedGroup(page)).toContainText("Billing");
}

async function expandBilling(page: Page) {
  const row = page.locator(".inbox-row-shell", { hasText: "Billing Session" }).locator(".inbox-row");
  await row.click();
  if (!path(page).startsWith("/sessions/")) await page.getByRole("grid", { name: "Sessions", exact: true }).press("F2");
  await expect(page.getByRole("button", { name: "Back to Sessions", exact: true })).toBeVisible();
}

for (const width of [390, 1440]) {
  test.describe(`${width}px project selection (#3971)`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("refresh and expand/close/refresh keep the project in the URL", async ({ page }) => {
      await selectBilling(page);
      const projectPath = path(page);
      await page.reload();
      await expect(selectedGroup(page)).toContainText("Billing");
      await expandBilling(page);
      const historyLength = await page.evaluate(() => history.length);
      await page.getByRole("button", { name: "Back to Sessions", exact: true }).click();
      await expect(selectedGroup(page)).toContainText("Billing");
      await expect.poll(() => path(page)).toBe(projectPath);
      expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
      await page.goBack();
      await expect(page.getByRole("button", { name: "Back to Sessions", exact: true })).toBeVisible();
      await page.goForward();
      await expect(selectedGroup(page)).toContainText("Billing");
      await page.reload();
      await expect(selectedGroup(page)).toContainText("Billing");
    });

    test("List/Board and browser history keep the selected project", async ({ page }) => {
      await selectBilling(page);
      const projectPath = path(page);
      if (width < 760) {
        await page.locator(".sessions-app-bar").getByRole("button", { name: "More Actions" }).click();
        await page.getByRole("menuitemradio", { name: "Board", exact: true }).click();
      } else {
        // The desktop shortcut can navigate without an explicit tab.
        await page.getByRole("grid", { name: "Sessions", exact: true }).press("b");
      }
      await expect.poll(() => path(page)).toBe(projectPath.replace("/", "/board"));
      await expect(selectedGroup(page)).toContainText("Billing");
      await page.reload();
      await expect(selectedGroup(page)).toContainText("Billing");
      await page.goBack();
      await expect.poll(() => path(page)).toBe(projectPath);
      await expect(selectedGroup(page)).toContainText("Billing");
      await page.goForward();
      await expect.poll(() => path(page)).toBe(projectPath.replace("/", "/board"));
    });

    test("archiving from expanded detail and returning keeps the project", async ({ page }) => {
      await selectBilling(page);
      await expandBilling(page);
      await page.getByRole("button", { name: "More Actions", exact: true }).last().click();
      await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
      // Archive may advance to the next session; close it if detail remains open.
      if (await page.getByRole("button", { name: "Back to Sessions", exact: true }).isVisible()) {
        await page.getByRole("button", { name: "Back to Sessions", exact: true }).click();
      }
      await expect(selectedGroup(page)).toContainText("Billing");
      await expect(page.locator(".inbox-row-title")).toHaveText(["Move the billing buckets to terraform"]);
      await page.reload();
      await expect(selectedGroup(page)).toContainText("Billing");
    });

    test("Archive closes detail opened outside the remembered project", async ({ page }) => {
      await selectBilling(page);
      await page.evaluate((sessionPath) => {
        const url = new URL(location.href);
        url.searchParams.set("path", sessionPath);
        history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, viewPath({ name: "session", id: "s-group-8" }));
      await expect(page.getByRole("heading", { name: "Marketing Site Session", exact: true })).toBeVisible();
      if (width === 1440) {
        await page.getByRole("button", { name: "Back to Sessions", exact: true }).focus();
        const openedPath = path(page);
        await page.keyboard.press("j");
        expect(path(page)).toBe(openedPath);
        await page.keyboard.press("k");
        expect(path(page)).toBe(openedPath);
      }
      await page.getByRole("button", { name: "More Actions", exact: true }).last().click();
      await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
      await expect(selectedGroup(page)).toContainText("Billing");
      await expect(page.getByRole("button", { name: "Back to Sessions", exact: true })).toHaveCount(0);
    });

    test("archiving an expanded session elsewhere keeps the originating project", async ({ page }) => {
      await selectBilling(page);
      await expandBilling(page);
      await page.evaluate(() => window.__updateSession("s-group-5", { archived: true }));
      await page.getByRole("button", { name: "Back to Sessions", exact: true }).click();
      await expect(selectedGroup(page)).toContainText("Billing");
      await expect(page.locator(".inbox-row-title")).toHaveText(["Move the billing buckets to terraform"]);
      await page.reload();
      await expect(selectedGroup(page)).toContainText("Billing");
    });
  });
}
