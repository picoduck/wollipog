import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The remote instance banner (#3005; docs/design-system.md §13.3): the instance's name and when it
 * last connected, never its address, with Retry or Re-Pair… and Open Instances at the top right on
 * desktop widths. Copy and actions are DOM tested (RemoteInstanceBanner.dom.test.tsx); this is the
 * layout and the in-place Re-Pair Instance dialog in the instance harness.
 */

const TOKEN = `${"a".repeat(20)}-ABC_${"x".repeat(18)}`;
const ORIGIN = "http://100.64.10.11:4317";

async function addStudio(page: Page) {
  await page.locator(".page-header").getByRole("button", { name: "Add Remote Instance…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Remote Instance" });
  await dialog.getByLabel("Instance Name").fill("Studio");
  await dialog.getByLabel("Pairing Link", { exact: true }).fill(`${ORIGIN}/#pair=${TOKEN}`);
  await dialog.getByRole("button", { name: "Add Instance" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Switch Instance: Studio", exact: true })).toBeVisible();
}

async function capture(page: Page, name: string) {
  if (!process.env.EVIDENCE_DIR) return;
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/${name}.png` });
}

/** The banner's actions sit together at the top right, clear of the sentence, with nothing overflowing. */
async function assertActionsTopRight(banner: Locator, first: string) {
  const [body, action, last, content] = await Promise.all([
    banner.locator(".notice-body").boundingBox(),
    banner.getByRole("button", { name: first }).boundingBox(),
    banner.getByRole("button", { name: "Open Instances" }).boundingBox(),
    banner.locator(".notice-content").boundingBox(),
  ]);
  expect(Math.abs(action!.y - content!.y), "the actions stay at the top").toBeLessThan(1);
  expect(Math.abs(last!.x + last!.width - content!.x - content!.width), "Open Instances ends the row at the right").toBeLessThan(1);
  expect(body!.x + body!.width, "sentence and actions do not overlap").toBeLessThanOrEqual(action!.x);
  expect(await banner.evaluate((element) => element.scrollWidth <= element.clientWidth), "no horizontal overflow").toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 940]) {
    test(`both remote banners at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/remote-instances-e2e.html");
      await page.evaluate(() => localStorage.clear());
      // The harness rewrites its address as instances switch, so it is opened again rather than reloaded.
      await page.goto("/remote-instances-e2e.html");
      // The harness has no theme provider; the scheme is the root attribute the provider would set.
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await expect(page.locator(".instance-row").filter({ has: page.getByTitle("This Machine", { exact: true }) })).toBeVisible();
      await addStudio(page);

      await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.setConnection("reconnecting"));
      const banner = page.locator(".notice.page-banner");
      await expect(banner).toHaveCount(1);
      // The harness's last connection is a fixed date, so its age is whatever today makes it.
      await expect(banner.locator(".notice-body")).toHaveText(/^Can't reach Studio\. Last connected \d+[smhd] ago\.$/u);
      await expect(banner).not.toContainText("100.64.10.11");
      await expect(banner.getByRole("button")).toHaveText(["Retry", "Open Instances"]);
      await assertActionsTopRight(banner, "Retry");
      await capture(page, `remote-unreachable-${width}-${theme}`);

      await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.setConnection("sign-in-required"));
      await expect(banner).toHaveCount(1);
      await expect(banner.locator(".notice-body")).toHaveText("Studio needs a new pairing before it can reconnect.");
      await expect(banner.getByRole("button")).toHaveText(["Re-Pair…", "Open Instances"]);
      await assertActionsTopRight(banner, "Re-Pair…");
      await capture(page, `remote-pairing-required-${width}-${theme}`);

      // Re-Pair… opens the Re-Pair Instance dialog for Studio where the person is.
      await banner.getByRole("button", { name: "Re-Pair…" }).click();
      const dialog = page.getByRole("dialog", { name: "Re-Pair Instance" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Server Address" })).toHaveValue(ORIGIN);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(banner.getByRole("button", { name: "Re-Pair…" })).toBeFocused();
    });
  }
}
