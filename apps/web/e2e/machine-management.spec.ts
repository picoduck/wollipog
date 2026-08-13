import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/machine-management-e2e.html");
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
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
