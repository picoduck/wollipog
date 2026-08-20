import { expect, test } from "@playwright/test";

const recoveryGeometry = (notice: HTMLElement) => {
  const message = notice.firstElementChild as HTMLElement;
  const button = notice.querySelector("button");
  const noticeRect = notice.getBoundingClientRect();
  const messageRect = message.getBoundingClientRect();
  const buttonRect = button?.getBoundingClientRect() ?? null;
  return {
    notice: { left: noticeRect.left, right: noticeRect.right, width: noticeRect.width },
    message: { left: messageRect.left, right: messageRect.right, bottom: messageRect.bottom, width: messageRect.width },
    button: buttonRect && {
      left: buttonRect.left,
      right: buttonRect.right,
      top: buttonRect.top,
      width: buttonRect.width,
      height: buttonRect.height,
      clientWidth: button!.clientWidth,
      scrollWidth: button!.scrollWidth,
      clientHeight: button!.clientHeight,
      scrollHeight: button!.scrollHeight,
      whiteSpace: getComputedStyle(button!).whiteSpace,
    },
  };
};

const setOffline = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setRunnerStatus("offline"));

test.beforeEach(async ({ page }) => {
  await page.goto("/machine-management-e2e.html");
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
});

test("offline recovery stays stacked and usable in a narrow card on a desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setOffline(page);
  await page.locator(".runner-grid").evaluate((grid) => { (grid as HTMLElement).style.width = "260px"; });

  const card = page.locator(".runner-card");
  await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(280);
  expect(await page.evaluate(() => window.innerWidth)).toBe(1280);

  const repair = page.getByRole("button", { name: "Repair Credentials", exact: true });
  await expect(repair).toHaveText("Repair Credentials");
  const geometry = await page.locator(".connection-recovery").evaluate(recoveryGeometry);
  expect(geometry.button).not.toBeNull();
  expect(geometry.button!.top).toBeGreaterThanOrEqual(geometry.message.bottom + 11);
  expect(Math.abs(geometry.button!.left - geometry.message.left)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.button!.width - geometry.message.width)).toBeLessThanOrEqual(0.5);
  expect(geometry.button!.right).toBeLessThanOrEqual(geometry.notice.right + 0.5);
  expect(geometry.button!.height).toBeGreaterThanOrEqual(44);
  expect(geometry.button!.whiteSpace).toBe("nowrap");
  expect(geometry.button!.scrollWidth).toBeLessThanOrEqual(geometry.button!.clientWidth);
  expect(geometry.button!.scrollHeight).toBeLessThanOrEqual(geometry.button!.clientHeight);

  await repair.click();
  await expect(page.getByRole("dialog", { name: "Repair Runner Connection" })).toBeVisible();
});

test("offline recovery stays stacked and usable on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await setOffline(page);

  const repair = page.getByRole("button", { name: "Repair Credentials", exact: true });
  await expect(repair).toBeVisible();
  const geometry = await page.locator(".connection-recovery").evaluate(recoveryGeometry);
  expect(geometry.button).not.toBeNull();
  expect(geometry.button!.top).toBeGreaterThanOrEqual(geometry.message.bottom + 11);
  expect(Math.abs(geometry.button!.left - geometry.message.left)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.button!.width - geometry.message.width)).toBeLessThanOrEqual(0.5);
  expect(geometry.button!.height).toBeGreaterThanOrEqual(44);
  expect(geometry.button!.whiteSpace).toBe("nowrap");
  expect(geometry.button!.scrollWidth).toBeLessThanOrEqual(geometry.button!.clientWidth);
  expect(geometry.notice.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.notice.right).toBeLessThanOrEqual(320.5);
});

test("non-admin recovery guidance wraps inside a narrow mobile card", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/machine-management-e2e.html?role=viewer");
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await setOffline(page);

  await expect(page.getByRole("button", { name: "Repair Credentials", exact: true })).toHaveCount(0);
  const guidance = page.getByText("Ask an organization owner or admin to repair this connection.", { exact: true });
  await expect(guidance).toBeVisible();
  const geometry = await guidance.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const notice = element.parentElement!.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      lineHeight: Number.parseFloat(style.lineHeight),
      noticeLeft: notice.left,
      noticeRight: notice.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(geometry.lineHeight);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.noticeLeft - 0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.noticeRight + 0.5);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

});
test("Machine settings rename the Machine and register a Workspace without creating a Project", async ({ page }) => {
  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(dialog.getByText("Misko-T14s-G6", { exact: true })).toBeVisible();

  const name = dialog.getByLabel("Machine Name");
  await name.fill("Primary Development Machine");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("heading", { name: "Primary Development Machine", exact: true })).toBeVisible();
  const renamedDialog = page.getByRole("dialog", { name: "Manage Primary Development Machine" });

  await renamedDialog.getByRole("button", { name: "Add Workspace" }).last().click();
  await renamedDialog.getByRole("button", { name: "repo" }).click();
  await renamedDialog.getByRole("button", { name: "Use This Folder" }).click();
  await expect(renamedDialog.getByLabel("Workspace Name")).toHaveValue("repo");
  await renamedDialog.getByRole("button", { name: "Add Workspace" }).last().click();

  await expect(renamedDialog.getByText("C:\\Users\\misko\\repo", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.lastRegisteredWorkspace()))
    .toEqual({ name: "repo", path: "C:\\Users\\misko\\repo" });
});

test("Machine settings expose deletion with an explicit history warning", async ({ page }) => {
  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const deleteMachine = dialog.getByRole("button", { name: "Delete Machine" });
  await expect(deleteMachine).toBeDisabled();
  await expect(deleteMachine).toHaveAttribute("title", "Stop this native runner before deleting the Machine");
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setRunnerStatus("offline"));
  await expect(deleteMachine).toBeEnabled();
  await deleteMachine.click();

  const confirmation = page.getByRole("dialog", { name: "Delete Design Workstation?" });
  await expect(confirmation).toContainText("permanently deletes the Machine, its sessions, and its multi-agent runs");
  await confirmation.getByRole("button", { name: "Delete Machine" }).click();
  await expect(page.getByText("No Machines Connected")).toBeVisible();
});

test("SSH config import keeps the selected Host and auto-populates an editable Machine Name", async ({ page }) => {
  await page.getByRole("button", { name: "Connect via SSH" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect via SSH" });
  const hosts = dialog.getByLabel("Import From ~/.ssh/config");

  await hosts.selectOption("golf-sim");
  await expect(hosts).toHaveValue("golf-sim");
  await expect(dialog.getByLabel("Machine Name")).toHaveValue("golf-sim");
  await expect(dialog.getByLabel("SSH Target")).toHaveValue("golf-sim");
  await expect(dialog.getByLabel("SSH Port")).toHaveValue("2222");

  await dialog.getByLabel("Machine Name").fill("Golf Simulator");
  await hosts.selectOption("build-box");
  await expect(hosts).toHaveValue("build-box");
  await expect(dialog.getByLabel("Machine Name")).toHaveValue("Golf Simulator");
  await expect(dialog.getByLabel("SSH Target")).toHaveValue("build-box");

  await dialog.getByRole("button", { name: "Connect Machine" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.lastAddBoxRequest()))
    .toMatchObject({
      displayName: "Golf Simulator",
      sshTarget: "build-box",
      sshPort: 22,
    });
});
