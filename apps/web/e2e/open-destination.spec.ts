import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test("the desktop session header renders a cohesive labeled split button and usable destination menu", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("/open-destination-e2e.html");

  const main = page.getByRole("button", { name: "Open in VS Code" });
  const choose = page.getByRole("button", { name: "Choose Destination" });
  await expect(main).toHaveText("Open");
  const geometry = await page.locator(".editor-select").evaluate((element) => {
    const mainBox = element.querySelector(".editor-main")!.getBoundingClientRect();
    const caretBox = element.querySelector(".editor-caret")!.getBoundingClientRect();
    return {
      mainRight: mainBox.right,
      caretLeft: caretBox.left,
      mainTop: mainBox.top,
      caretTop: caretBox.top,
      mainBottom: mainBox.bottom,
      caretBottom: caretBox.bottom,
    };
  });
  expect(Math.abs(geometry.mainRight - geometry.caretLeft)).toBeLessThanOrEqual(1.1);
  expect(Math.abs(geometry.mainTop - geometry.caretTop)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.mainBottom - geometry.caretBottom)).toBeLessThanOrEqual(0.5);

  await choose.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
  await expect(menu.getByRole("menuitemradio", { name: "Future Editor" })
    .locator('[data-destination-icon="generic-editor"]')).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "File Manager" })
    .locator('[data-destination-icon="file-manager"]')).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(8);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(992);

  await menu.getByRole("menuitemradio", { name: "Cursor" }).click();
  await expect.poll(() => page.evaluate(() => window.hostActions)).toEqual([
    { kind: "open_editor", editorId: "cursor" },
  ]);
  await expect(page.getByRole("button", { name: "Open in Cursor" })).toHaveText("Open");
});

test("the compact mobile presentation stays on one line and inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/open-destination-e2e.html?mobile=1");

  const metrics = await page.locator(".topbar").evaluate((element) => {
    const group = element.querySelector(".editor-select")!.getBoundingClientRect();
    const main = element.querySelector(".editor-main")!.getBoundingClientRect();
    const caret = element.querySelector(".editor-caret")!.getBoundingClientRect();
    const header = element.getBoundingClientRect();
    const label = element.querySelector(".editor-main-label")!;
    return {
      headerLeft: header.left,
      headerRight: header.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      groupLeft: group.left,
      groupRight: group.right,
      groupWidth: group.width,
      mainWidth: main.width,
      caretWidth: caret.width,
      labelDisplay: getComputedStyle(label).display,
    };
  });
  expect(metrics.labelDisplay).toBe("none");
  expect(metrics.groupWidth).toBeLessThanOrEqual(64);
  expect(metrics.mainWidth).toBeGreaterThanOrEqual(34);
  expect(metrics.caretWidth).toBeGreaterThanOrEqual(28);
  expect(metrics.groupLeft).toBeGreaterThanOrEqual(metrics.headerLeft);
  expect(metrics.groupRight).toBeLessThanOrEqual(metrics.headerRight);
  expect(metrics.scrollWidth).toBe(metrics.clientWidth);

  await page.getByRole("button", { name: "Choose Destination" }).click();
  const menuBox = await page.getByRole("menu").boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(8);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(312);

  await page.goto("/open-destination-e2e.html?mobile=1&offline=1");
  await page.getByRole("button", { name: "Open Unavailable: Runner Offline" }).dispatchEvent("click");
  const offlineNote = page.getByRole("status");
  await expect(offlineNote).toHaveText("Runner is offline.");
  await expect(offlineNote).toHaveCSS("pointer-events", "none");
  const offlineMetrics = await page.locator(".topbar").evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    rightmostControl: element.querySelector(".topbar-actions:last-child")!.getBoundingClientRect().right,
    viewportWidth: window.innerWidth,
  }));
  expect(offlineMetrics.scrollWidth).toBe(offlineMetrics.clientWidth);
  expect(offlineMetrics.rightmostControl).toBeLessThanOrEqual(offlineMetrics.viewportWidth);

  await page.goto("/open-destination-e2e.html?mobile=1&fail=1");
  await page.getByRole("button", { name: "Open in VS Code" }).click();
  const failureNote = page.getByRole("status");
  const failureBox = await failureNote.boundingBox();
  expect(failureBox).not.toBeNull();
  await expect(failureNote).toHaveCSS("pointer-events", "none");
  expect(failureBox!.x).toBeGreaterThanOrEqual(8);
  expect(failureBox!.x + failureBox!.width).toBeLessThanOrEqual(312);
});
