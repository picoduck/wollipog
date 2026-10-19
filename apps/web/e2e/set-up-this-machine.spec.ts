import { expect, test, type Page } from "@playwright/test";

/**
 * Set Up This Machine (#2993) in the web build with the desktop bridge mocked
 * (`set-up-this-machine-main.tsx`).
 */

async function open(page: Page) {
  await page.goto("/set-up-this-machine-e2e.html");
  await page.locator(".connections-empty").getByRole("button", { name: "Set Up This Machine" }).click();
  const dialog = page.getByRole("dialog", { name: "Set Up This Machine" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const fixture = (page: Page) => ({
  finishConnect: (outcome: "started" | "not-running" | { error: string }) =>
    page.evaluate((value) => window.__WOLLIPOG_SET_UP_MACHINE_E2E__.finishConnect(value), outcome),
  setRunner: (scenario: "discovering" | "ready" | "needs-attention" | "offline") =>
    page.evaluate((value) => window.__WOLLIPOG_SET_UP_MACHINE_E2E__.setRunner(value), scenario),
});

test("the setup runs from its footer primary to the agents as rows, with one primary throughout", async ({ page }) => {
  const dialog = await open(page);
  const primary = dialog.locator(".btn.primary");
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText("Set Up This Machine");
  await expect(primary).toHaveAttribute("aria-busy", "true");
  await expect(dialog.locator(".set-up-machine-checklist svg")).toHaveCount(3);

  await fixture(page).finishConnect("started");
  await expect(dialog.getByRole("heading", { name: "Connection Check" })).toBeVisible();
  await expect(primary).toHaveText("Done");
  await expect(primary).toBeDisabled();

  await fixture(page).setRunner("ready");
  await expect(dialog.getByText("This Machine Is Ready")).toBeVisible();
  const rows = dialog.getByRole("list", { name: "Agents on This Machine" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Ready");
  await expect(primary).toHaveText("Done");
  await expect(primary).toBeEnabled();
  await expect(dialog.getByRole("region", { name: "Recommended Skills" })).toBeVisible();
  await primary.click();
  await expect(dialog).toHaveCount(0);
});

test("Install Manually Instead opens Install Manually above this dialog on desktop, and Cancel comes back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = await open(page);
  await fixture(page).finishConnect({ error: "The desktop bridge refused the request." });
  await dialog.getByRole("button", { name: "Install Manually Instead" }).click();
  const manual = page.getByRole("dialog", { name: "Install Manually" });
  await expect(manual).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".modal-backdrop.stacked")).toHaveCount(1);
  await manual.getByRole("button", { name: "Cancel" }).click();
  await expect(manual).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test.describe("on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Install Manually Instead pushes onto the sheet with Back, which returns to this dialog", async ({ page }) => {
    const dialog = await open(page);
    await fixture(page).finishConnect({ error: "The desktop bridge refused the request." });
    const instead = dialog.getByRole("button", { name: "Install Manually Instead" });
    // A phone sheet's footer holds two buttons, so the tertiary is a row at the body's end (§7.5).
    await expect(dialog.locator(".modal-body").getByRole("button", { name: "Install Manually Instead" })).toBeVisible();
    await instead.click();
    const manual = page.getByRole("dialog", { name: "Install Manually" });
    await expect(manual).toBeVisible();
    await expect(page.locator(".modal")).toHaveCount(1);
    await expect(dialog).toBeHidden();
    await manual.getByRole("button", { name: "Back to Set Up This Machine" }).click();
    await expect(manual).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".set-up-machine-checklist")).toBeVisible();
  });
});
