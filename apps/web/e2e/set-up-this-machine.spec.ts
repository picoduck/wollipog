import { expect, test, type Locator, type Page } from "@playwright/test";

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
  exitRunner: () => page.evaluate(() => window.__WOLLIPOG_SET_UP_MACHINE_E2E__.exitRunner()),
});

/** Mirrors `RUNNER_CONNECT_WAIT_MS` and `LOCAL_RUNNER_STATUS_POLL_MS` in SetUpThisMachineDialog.tsx. */
const CONNECT_WAIT_MS = 60_000;
const STATUS_POLL_MS = 2_000;

/** The wait for a started runner is bounded (#3524), on desktop and on a phone. */
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`a runner that started but never finishes connecting at ${viewport.width}px`, () => {
    test.use({ viewport });

    async function startedAndWaiting(page: Page) {
      await page.clock.install();
      const dialog = await open(page);
      await fixture(page).finishConnect("started");
      await expect(dialog.getByRole("heading", { name: "Connection Check" })).toBeVisible();
      await expect(dialog.locator(".modal-foot")).toContainText("Waiting for the runner…");
      await expect(dialog.getByRole("button", { name: "Install Manually Instead" })).toHaveCount(0);
      return dialog;
    }

    async function expectStoppedWaiting(dialog: Locator) {
      await expect(dialog.getByRole("heading", { name: "Connection Check" })).toHaveCount(0);
      await expect(dialog.locator(".modal-foot")).not.toContainText("Waiting for the runner");
      await expect(dialog.locator(".modal-foot .spinner")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Done" })).toBeEnabled();
      await expect(dialog.getByRole("button", { name: "Install Manually Instead" })).toBeVisible();
    }

    test("a runner that is not online says it hasn't connected, then moves to Ready when it connects", async ({ page }) => {
      const dialog = await startedAndWaiting(page);
      await page.clock.runFor(CONNECT_WAIT_MS);
      const notice = dialog.locator(".notice.t-warning");
      await expect(notice.locator(".notice-title")).toHaveText("This Machine Hasn't Connected");
      await expect(notice).toContainText("The bundled runner started, but it hasn't connected to Wollipog.");
      await expect(notice.getByRole("button", { name: "Reconnect This Machine" })).toBeVisible();
      await expectStoppedWaiting(dialog);

      await fixture(page).setRunner("ready");
      await expect(dialog.getByText("This Machine Is Ready")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Install Manually Instead" })).toHaveCount(0);
    });

    test("a runner still discovering its agents offers Rediscover", async ({ page }) => {
      const dialog = await startedAndWaiting(page);
      await fixture(page).setRunner("discovering");
      await page.clock.runFor(CONNECT_WAIT_MS);
      const notice = dialog.locator(".notice.t-warning");
      await expect(notice.locator(".notice-title")).toHaveText("This Machine Hasn't Reported Its Agents");
      await expect(notice).toContainText("The bundled runner connected, but it hasn't reported its agents yet.");
      await expect(notice.getByRole("button", { name: "Rediscover" })).toBeVisible();
      await expectStoppedWaiting(dialog);
    });

    test("a runner process that exits while waiting says the runner isn't running", async ({ page }) => {
      const dialog = await startedAndWaiting(page);
      await fixture(page).exitRunner();
      await page.clock.runFor(STATUS_POLL_MS);
      const notice = dialog.locator(".notice.t-warning");
      await expect(notice.locator(".notice-title")).toHaveText("This Machine Isn't Connected");
      await expect(notice).toContainText("The bundled runner isn't running.");
      await expectStoppedWaiting(dialog);
    });
  });
}

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
