import { expect, test, type Page } from "@playwright/test";

const TOKEN_A = `${"a".repeat(20)}-ABC_${"x".repeat(18)}`;
const TOKEN_B = `${"b".repeat(20)}-DEF_${"y".repeat(18)}`;

async function addInstance(page: Page, name: string, link: string) {
  await page.getByRole("button", { name: "Add Remote Instance" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Remote Instance" });
  await dialog.getByLabel("Instance Name").fill(name);
  await dialog.getByLabel("Pairing Link").fill(link);
  await dialog.getByRole("button", { name: "Add and Switch" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: new RegExp(`Switch Instance, Current ${name}`) })).toBeVisible();
}

async function expectMenuContentFits(page: Page) {
  const geometry = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Switch Instance"]');
    const manage = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
      .find((item) => item.textContent?.includes("Manage Instances"));
    if (!menu || !manage) throw new Error("missing instance menu content geometry");
    const style = getComputedStyle(menu);
    const contentBottom = menu.getBoundingClientRect().bottom
      - Number.parseFloat(style.borderBottomWidth)
      - Number.parseFloat(style.paddingBottom);
    return {
      clientHeight: menu.clientHeight,
      scrollHeight: menu.scrollHeight,
      manageBottom: manage.getBoundingClientRect().bottom,
      contentBottom,
    };
  });
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
  expect(geometry.manageBottom).toBeLessThanOrEqual(geometry.contentBottom + 1);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/remote-instances-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/remote-instances-e2e.html");
  await expect(page.getByText("1 Instance")).toBeVisible();
});

test("compact selector stays adjacent to its Rail trigger across viewport changes", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /Switch Instance, Current This Machine/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Switch Instance" });
  await expect(menu).toBeVisible();
  await expectMenuContentFits(page);

  const expectAnchored = async () => {
    const geometry = await page.evaluate(() => {
      const triggerElement = document.querySelector<HTMLElement>(
        '.rail-instance [aria-label^="Switch Instance, Current"]',
      );
      const menuElement = document.querySelector<HTMLElement>('[role="menu"][aria-label="Switch Instance"]');
      if (!triggerElement || !menuElement) throw new Error("missing Rail instance selector geometry");
      const triggerRect = triggerElement.getBoundingClientRect();
      const menuRect = menuElement.getBoundingClientRect();
      return {
        gap: triggerRect.top - menuRect.bottom,
        menuTop: menuRect.top,
        menuLeft: menuRect.left,
        triggerLeft: triggerRect.left,
        menuRight: menuRect.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(geometry.gap).toBeGreaterThanOrEqual(5);
    expect(geometry.gap).toBeLessThanOrEqual(7);
    expect(geometry.menuTop).toBeGreaterThanOrEqual(8);
    expect(Math.abs(geometry.menuLeft - geometry.triggerLeft)).toBeLessThanOrEqual(1);
    expect(geometry.menuRight).toBeLessThanOrEqual(geometry.viewportWidth - 8);
  };

  await expectAnchored();
  await page.setViewportSize({ width: 1024, height: 620 });
  await expect.poll(async () => {
    const boxes = await Promise.all([trigger.boundingBox(), menu.boundingBox()]);
    return boxes[0] && boxes[1] ? Math.round(boxes[0].y - (boxes[1].y + boxes[1].height)) : null;
  }).toBe(6);
  await expectAnchored();

  // A 125% desktop scale exposes fewer CSS pixels for the same physical window. Exercise both
  // that narrower layout and the matching device-pixel ratio instead of changing DPR alone.
  await page.setViewportSize({ width: 819, height: 496 });
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 819,
    height: 496,
    deviceScaleFactor: 1.25,
    mobile: false,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect.poll(() => page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scale: window.devicePixelRatio,
  }))).toEqual({ width: 819, height: 496, scale: 1.25 });
  await expect.poll(async () => {
    const boxes = await Promise.all([trigger.boundingBox(), menu.boundingBox()]);
    return boxes[0] && boxes[1] ? Math.round(boxes[0].y - (boxes[1].y + boxes[1].height)) : null;
  }).toBe(6);
  await expectAnchored();

  await page.keyboard.press("Escape");
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await page.getByRole("button", { name: /Switch Instance, Current Studio/ }).click();
  await expectMenuContentFits(page);
});

test("pairs, switches, edits, re-pairs, persists, and removes remote instances", async ({ page }) => {
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await addInstance(page, "Laptop", `https://laptop.example/#pair=${TOKEN_B}`);

  await page.getByRole("button", { name: /Switch Instance, Current Laptop/ }).click();
  await page.getByRole("menuitemradio", { name: /Studio/ }).click();
  await expect(page.getByRole("button", { name: /Switch Instance, Current Studio/ })).toBeVisible();

  const studio = page.getByRole("article").filter({ hasText: "Studio" });
  await studio.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Instance" });
  await edit.getByLabel("Instance Name").fill("Home Studio");
  await edit.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("button", { name: /Switch Instance, Current Home Studio/ })).toBeVisible();

  const renamed = page.getByRole("article").filter({ hasText: "Home Studio" });
  await renamed.getByRole("button", { name: "Re-Pair" }).click();
  const repair = page.getByRole("dialog", { name: "Re-Pair Instance" });
  await repair.getByLabel("Pairing Link").fill(`http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await repair.getByRole("button", { name: "Re-Pair" }).click();
  await expect(repair).toBeHidden();

  await page.goto("/remote-instances-e2e.html");
  await expect(page.getByRole("button", { name: /Switch Instance, Current Home Studio/ })).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem("wollipog.e2e.instance-registry"));
  expect(stored).not.toContain(TOKEN_A);
  expect(stored).not.toContain(TOKEN_B);

  await page.getByRole("article").filter({ hasText: "Laptop" }).getByRole("button", { name: "Remove" }).click();
  const confirmation = page.getByRole("dialog", { name: /Remove .*Laptop/ });
  await confirmation.getByRole("button", { name: "Remove Instance" }).click();
  await expect(page.getByRole("article").filter({ hasText: "Laptop" })).toHaveCount(0);
  await expect(page.getByText("2 Instances")).toBeVisible();
});

test("shows deterministic validation and authentication recovery", async ({ page }) => {
  await page.getByRole("button", { name: "Add Remote Instance" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Remote Instance" });
  await dialog.getByLabel("Instance Name").fill("Broken");
  await dialog.getByLabel("Pairing Link").fill("http://192.168.1.10:4317/#pair=short");
  await dialog.getByRole("button", { name: "Add and Switch" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await page.getByRole("button", { name: /Switch Instance, Current Studio/ }).click();
  await page.getByRole("menuitemradio", { name: /This Machine/ }).click();
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.failNextOpen(
    "remote-1",
    "authentication-required",
    "The pairing token was rejected.",
  ));
  await page.getByRole("article").filter({ hasText: "Studio" }).getByRole("button", { name: "Switch" }).click();
  const studio = page.getByRole("article").filter({ hasText: "Studio" });
  await expect(studio.getByText("Authentication Required", { exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Re-Pair" })).toBeVisible();
});
