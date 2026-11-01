import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

const TOKEN_A = `${"a".repeat(20)}-ABC_${"x".repeat(18)}`;
const TOKEN_B = `${"b".repeat(20)}-DEF_${"y".repeat(18)}`;

/** The rail's instance tile (docs/design-system.md §4.1, #1970). */
const tile = (page: Page, name: string) => page.getByRole("button", { name: `Switch Instance: ${name}`, exact: true });

/** A row of Connections › Instances (#3002), by the name its title carries whole as a tooltip. */
const row = (page: Page, name: string) => page.locator(".instance-row").filter({ has: page.getByTitle(name, { exact: true }) });

/** The page header's one primary, Add Remote Instance… (#3002). */
const addButton = (page: Page) => page.locator(".page-header").getByRole("button", { name: "Add Remote Instance…" });

/** Chooses an item from a row's More Actions menu. */
async function rowAction(page: Page, name: string, item: string) {
  await row(page, name).getByRole("button", { name: `More Actions for ${name}` }).click();
  await page.getByRole("menu", { name: `More Actions for ${name}` }).getByRole("menuitem", { name: item }).click();
}

async function addInstance(page: Page, name: string, link: string) {
  await addButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Add Remote Instance" });
  await dialog.getByLabel("Instance Name").fill(name);
  await dialog.getByLabel("Pairing Link", { exact: true }).fill(link);
  await expect(dialog.getByRole("checkbox", { name: "Switch After Adding" })).toBeChecked();
  await dialog.getByRole("button", { name: "Add Instance" }).click();
  await expect(dialog).toBeHidden();
  await expect(tile(page, name)).toBeVisible();
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

/** Where the flyout sits against the rail and the tile it opened from. */
async function flyoutGeometry(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".app-rail");
    const monogram = document.querySelector<HTMLElement>(".rail-instance .instance-monogram.tile");
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Switch Instance"]');
    if (!rail || !monogram || !menu) throw new Error("missing rail instance geometry");
    const railRect = rail.getBoundingClientRect();
    const tileRect = monogram.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    return {
      railRight: railRect.right,
      tileTop: tileRect.top,
      menuTop: menuRect.top,
      menuLeft: menuRect.left,
      menuRight: menuRect.right,
      menuBottom: menuRect.bottom,
      menuWidth: menuRect.width,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/remote-instances-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/remote-instances-e2e.html");
  await expect(row(page, "This Machine")).toBeVisible();
});

test("the current instance is a monogram tile at the top of the rail, with no fill that reads as current", async ({ page }) => {
  const trigger = tile(page, "This Machine");
  await expect(trigger).toBeVisible();
  await expect(page.locator(".rail-brand")).toHaveCount(0);
  await expect(trigger.locator(".instance-monogram")).toHaveText("TM");
  const look = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".app-rail")!;
    const button = document.querySelector<HTMLElement>(".rail-instance .instance-tile-trigger")!;
    const monogram = button.querySelector<HTMLElement>(".instance-monogram.tile")!;
    const first = rail.querySelector<HTMLElement>(".rail-destinations .rail-item")!;
    const buttonStyle = getComputedStyle(button);
    const monogramStyle = getComputedStyle(monogram);
    return {
      aboveDestinations: button.getBoundingClientRect().bottom <= first.getBoundingClientRect().top,
      buttonBackground: buttonStyle.backgroundColor,
      buttonBorder: buttonStyle.borderTopWidth,
      size: [monogram.getBoundingClientRect().width, monogram.getBoundingClientRect().height],
      fontSize: monogramStyle.fontSize,
      fontWeight: monogramStyle.fontWeight,
    };
  });
  expect(look.aboveDestinations).toBe(true);
  expect(look.buttonBackground).toBe("rgba(0, 0, 0, 0)");
  expect(look.buttonBorder).toBe("0px");
  expect(look.size).toEqual([32, 32]);
  expect(look.fontSize).toBe("12px");
  expect(look.fontWeight).toBe("600");

  // Its tooltip gives the name and the status, in sentence case.
  await trigger.hover();
  await expect(page.locator(".rail-tooltip")).toContainText("This Machine");
  await expect(page.locator(".rail-tooltip-detail")).toHaveText("Online");
});

test("the menu flies out beside the rail, top-aligned with the tile, across viewport changes", async ({ page }) => {
  await tile(page, "This Machine").click();
  const menu = page.getByRole("menu", { name: "Switch Instance" });
  await expect(menu).toBeVisible();
  await dialogMotionSettled(page);
  await expectMenuContentFits(page);

  const expectBesideRail = async () => {
    const geometry = await flyoutGeometry(page);
    // The shared menu opens 4px from what it anchors to (docs/design-system.md §2.9, §9.1), and
    // here that is the rail's edge, so it covers no rail item.
    expect(geometry.menuLeft - geometry.railRight).toBeGreaterThanOrEqual(3);
    expect(geometry.menuLeft - geometry.railRight).toBeLessThanOrEqual(5);
    expect(Math.abs(geometry.menuTop - geometry.tileTop)).toBeLessThanOrEqual(1);
    expect(geometry.menuWidth).toBe(300);
    expect(geometry.menuRight).toBeLessThanOrEqual(geometry.viewportWidth - 8);
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.viewportHeight - 8);
  };

  await expectBesideRail();
  await page.setViewportSize({ width: 1024, height: 620 });
  await expect.poll(async () => (await flyoutGeometry(page)).menuTop - (await flyoutGeometry(page)).tileTop).toBeLessThanOrEqual(1);
  await expectBesideRail();

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
  await expectBesideRail();

  await page.keyboard.press("Escape");
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await tile(page, "Studio").click();
  await dialogMotionSettled(page);
  await expectMenuContentFits(page);
  await expectBesideRail();
});

test("rows use the shared menu sizes, and the keyboard moves between them and back to the tile", async ({ page }) => {
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await addInstance(page, "Build Farm in the Northern Datacenter Rack Seven", `https://build-farm-north-rack-7.internal.example/#pair=${TOKEN_B}`);
  const trigger = tile(page, "Build Farm in the Northern Datacenter Rack Seven");
  await expect(trigger.locator(".instance-monogram")).toHaveText("BF");
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Switch Instance" });
  await expect(menu).toBeVisible();
  await dialogMotionSettled(page);

  const rows = await menu.evaluate((element) => [...element.querySelectorAll<HTMLElement>(".menu-item, .menu-label")].map((row) => {
    const text = row.querySelector<HTMLElement>(".menu-text");
    const desc = row.querySelector<HTMLElement>(".menu-desc");
    return {
      role: row.getAttribute("role"),
      label: text?.textContent ?? row.textContent,
      height: row.getBoundingClientRect().height,
      fontSize: getComputedStyle(text ?? row).fontSize,
      checked: row.getAttribute("aria-checked"),
      check: Boolean(row.querySelector(".menu-check")),
      desc: desc?.textContent ?? null,
      descClipped: desc ? desc.scrollWidth > desc.clientWidth && getComputedStyle(desc).textOverflow === "ellipsis" : false,
      icon: row.querySelector(".menu-icon")?.innerHTML.includes("<svg") ?? false,
    };
  }));
  expect(rows.map((row) => [row.role, row.label])).toEqual([
    ["menuitemradio", "This Machine"],
    ["presentation", "Remote"],
    ["menuitemradio", "Studio"],
    ["menuitemradio", "Build Farm in the Northern Datacenter Rack Seven"],
    ["menuitem", "Add Remote Instance…"],
    ["menuitem", "Manage Instances"],
  ]);
  const [local, , studio, farm, add, manage] = rows;
  expect(local!.desc).toBe("On this machine");
  expect(studio!.desc).toBe("http://100.64.10.11:4317");
  expect(farm!.descClipped).toBe(true);
  for (const row of [local!, studio!, farm!]) {
    expect(row.height).toBeGreaterThanOrEqual(44);
    expect(row.fontSize).toBe("13px");
  }
  expect([local!.checked, studio!.checked, farm!.checked]).toEqual(["false", "false", "true"]);
  expect([local!.check, studio!.check, farm!.check]).toEqual([false, false, true]);
  for (const row of [add!, manage!]) {
    expect(row.height).toBe(32);
    expect(row.icon).toBe(true);
  }

  // The menu opens on the current instance; arrow keys move between rows; Escape closes the menu
  // and returns focus to the tile.
  await expect(menu.getByRole("menuitemradio", { name: /Build Farm/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitemradio", { name: "Studio" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitemradio", { name: "This Machine" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Manage Instances" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Add Remote Instance… opens the existing add dialog.
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Add Remote Instance…" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add Remote Instance" });
  await expect(addDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(addDialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("pairs, switches, edits, re-pairs, persists, and removes remote instances", async ({ page }) => {
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await addInstance(page, "Laptop", `https://laptop.example/#pair=${TOKEN_B}`);
  await expect(tile(page, "Laptop").locator(".instance-monogram")).toHaveText("L");

  await tile(page, "Laptop").click();
  await page.getByRole("menuitemradio", { name: /Studio/ }).click();
  await expect(tile(page, "Studio").locator(".instance-monogram")).toHaveText("S");

  await rowAction(page, "Studio", "Edit…");
  const edit = page.getByRole("dialog", { name: "Edit Instance" });
  await edit.getByLabel("Instance Name").fill("Home Studio");
  await edit.getByRole("button", { name: "Save Changes" }).click();
  await expect(tile(page, "Home Studio").locator(".instance-monogram")).toHaveText("HS");

  const renamed = row(page, "Home Studio");
  await rowAction(page, "Home Studio", "Re-Pair…");
  const repair = page.getByRole("dialog", { name: "Re-Pair Instance" });
  await expect(repair.getByLabel("Server Address")).toHaveValue("http://100.64.10.11:4317");
  await expect(repair.getByLabel("Server Address")).toHaveAttribute("readonly", "");
  // A link for another address is refused under the link, before anything is sent.
  const repairLink = repair.getByLabel("Pairing Link", { exact: true });
  await repairLink.fill(`https://laptop.example/#pair=${TOKEN_A}`);
  await repair.getByRole("button", { name: "Re-Pair" }).click();
  await expect(repairLink).toHaveAttribute("aria-invalid", "true");
  await expect(repairLink).toBeFocused();
  await expect(repair.locator(".field-error")).toHaveText(
    "This link is for a different address than Home Studio. Create the link on Home Studio.",
  );
  await repairLink.fill(`http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await repair.getByRole("button", { name: "Re-Pair" }).click();
  await expect(repair).toBeHidden();

  // A changed address needs a fresh link for that address.
  await rowAction(page, "Home Studio", "Edit…");
  await edit.getByLabel("Server Address").fill("https://studio.example");
  const newLink = edit.getByLabel("Pairing Link for the New Address");
  await newLink.fill(`https://laptop.example/#pair=${TOKEN_A}`);
  await edit.getByRole("button", { name: "Save Changes" }).click();
  await expect(newLink).toHaveAttribute("aria-invalid", "true");
  await expect(edit.locator(".field-error")).toContainText("This link is for a different address than https://studio.example.");
  await newLink.fill(`https://studio.example/#pair=${TOKEN_A}`);
  await edit.getByRole("button", { name: "Save Changes" }).click();
  await expect(edit).toBeHidden();
  await expect(renamed).toContainText("https://studio.example");

  await page.goto("/remote-instances-e2e.html");
  await expect(tile(page, "Home Studio")).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem("wollipog.e2e.instance-registry"));
  expect(stored).not.toContain(TOKEN_A);
  expect(stored).not.toContain(TOKEN_B);

  await rowAction(page, "Laptop", "Remove…");
  const confirmation = page.getByRole("dialog", { name: "Remove Instance" });
  await expect(confirmation).toContainText("“Laptop” and its saved credential are removed from this app. Nothing on Laptop is deleted.");
  await confirmation.getByRole("button", { name: "Remove Instance" }).click();
  await expect(row(page, "Laptop")).toHaveCount(0);
  await expect(page.locator(".instance-row")).toHaveCount(2);
  await expect(addButton(page)).toBeFocused();
});

test("shows deterministic validation and authentication recovery", async ({ page }) => {
  await addButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Add Remote Instance" });
  await dialog.getByLabel("Instance Name").fill("Broken");
  const link = dialog.getByLabel("Pairing Link", { exact: true });
  await link.fill("http://192.168.1.10:4317/#pair=short");
  await dialog.getByRole("button", { name: "Add Instance" }).click();
  // Each error sits under its field, never in a form-level error (§8.5).
  await expect(link).toHaveAttribute("aria-invalid", "true");
  await expect(link).toBeFocused();
  await expect(dialog.locator(".field-error")).toHaveText(
    "Use an https:// address. http:// works only for this computer or a Tailscale address.",
  );
  await link.fill("https://studio.example/");
  await expect(dialog.locator(".field-error")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add Instance" }).click();
  await expect(dialog.locator(".field-error")).toHaveText("This isn't a Wollipog pairing link. Copy the whole link, including #pair=.");
  await expect(dialog.locator(".form-error")).toHaveCount(0);
  // Address and Code replaces the link, and its error goes with it.
  await dialog.getByRole("radio", { name: "Address and Code" }).click();
  await expect(dialog.getByLabel("Pairing Link", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Server Address")).toBeVisible();
  await expect(dialog.getByLabel("Pairing Code")).toBeVisible();
  await expect(dialog.locator(".field-error")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add Instance" }).click();
  await expect(dialog.getByLabel("Server Address")).toBeFocused();
  await expect(dialog.locator(".field-error")).toHaveText(["Enter the server address.", "Enter the pairing code."]);

  // A refusal after submit is a titled danger notice, its raw words behind Show Details.
  await dialog.getByLabel("Server Address").fill("https://studio.example");
  await dialog.getByLabel("Pairing Code").fill(TOKEN_A);
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.failNextMutation("Could not connect to the remote Wollipog instance."));
  await dialog.getByRole("button", { name: "Add Instance" }).click();
  const failure = dialog.locator(".notice.t-danger");
  await expect(failure.locator(".notice-title")).toHaveText("Couldn't Add the Instance");
  await expect(failure).toContainText("This app couldn't reach that address.");
  await expect(failure).not.toContainText("Could not connect");
  await failure.getByRole("button", { name: "Show Details" }).click();
  await expect(failure).toContainText("Could not connect to the remote Wollipog instance.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Unchecked, Switch After Adding saves the instance and stays where it is.
  await addButton(page).click();
  await dialog.getByLabel("Instance Name").fill("Laptop");
  await dialog.getByLabel("Pairing Link", { exact: true }).fill(`https://laptop.example/#pair=${TOKEN_B}`);
  await dialog.getByRole("checkbox", { name: "Switch After Adding" }).uncheck();
  await dialog.getByRole("button", { name: "Add Instance" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "Laptop")).toBeVisible();
  await expect(tile(page, "This Machine")).toBeVisible();

  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await tile(page, "Studio").click();
  await page.getByRole("menuitemradio", { name: /This Machine/ }).click();
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.failNextOpen(
    "remote-2",
    "authentication-required",
    "The pairing token was rejected.",
  ));
  await row(page, "Studio").getByRole("button", { name: "Switch" }).click();
  const studio = row(page, "Studio");
  // A rejected pairing is Pairing Required, which names its fix (§11.2, #3002), and Re-Pair… is the slot.
  await expect(studio.locator(".status")).toHaveText("Pairing Required");
  await expect(studio.locator(".row-sub")).toContainText("No longer accepts the saved pairing.");
  await expect(studio).not.toContainText("pairing token");
  await expect(studio.getByRole("button", { name: "Re-Pair…" })).toBeVisible();
  // The tile, its tooltip and its menu say the same thing, as text and not only as a colour.
  await expect(tile(page, "Studio").locator(".instance-tile-dot")).toHaveClass(/t-warning/);
  await tile(page, "Studio").hover();
  await expect(page.locator(".rail-tooltip-detail")).toHaveText("Pairing required");
  await tile(page, "Studio").click();
  await expect(page.getByRole("menuitemradio", { name: /Studio/ }).locator(".status")).toHaveText("Pairing Required");
  await expect(page.locator("body")).not.toContainText("Sign-In Required");
});

test("an offline remote says Offline in its row", async ({ page }) => {
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await tile(page, "Studio").click();
  await page.getByRole("menuitemradio", { name: /This Machine/ }).click();
  await expect(tile(page, "This Machine")).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.failNextOpen(
    "remote-1",
    "unreachable",
    "Can't reach Studio.",
  ));
  await row(page, "Studio").getByRole("button", { name: "Switch" }).click();
  await expect(row(page, "Studio").locator(".status")).toHaveText("Offline");
  await expect(row(page, "Studio").locator(".row-sub")).toContainText("Didn't answer.");
  await expect(row(page, "Studio").getByRole("button", { name: "Retry" })).toBeVisible();
  const dot = tile(page, "Studio").locator(".instance-tile-dot");
  await expect(dot).toHaveClass(/hollow/);
  await expect(dot).toHaveClass(/t-neutral/);

  await row(page, "This Machine").getByRole("button", { name: "Switch" }).click();
  await tile(page, "This Machine").click();
  const menuRow = page.getByRole("menuitemradio", { name: /Studio/ });
  await expect(menuRow.locator(".status")).toHaveText("Offline");
  await expect(menuRow.locator(".status")).toHaveClass(/hollow/);
});

test("with the active instance offline, the banner shows and the tile's dot is hollow and neutral", async ({ page }) => {
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  const dot = tile(page, "Studio").locator(".instance-tile-dot");
  await expect(dot).toHaveClass(/t-success/);
  const green = await dot.evaluate((element) => getComputedStyle(element).backgroundColor);

  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.setConnection("reconnecting"));
  await expect(page.getByRole("status").filter({ hasText: "Can't reach Studio" })).toBeVisible();
  await expect(dot).toHaveClass(/t-neutral/);
  await expect(dot).toHaveClass(/hollow/);
  const shown = await dot.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, ring: style.boxShadow };
  });
  expect(shown.background).not.toBe(green);
  expect(shown.ring).not.toContain(green);
  await tile(page, "Studio").hover();
  await expect(page.locator(".rail-tooltip-detail")).toHaveText("Offline");
});

test("the active row says what the banner says, for This Machine and a remote, in the badge's tone", async ({ page }) => {
  const dotStyle = (name: string) => row(page, name).locator(".instance-tile-dot").evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, ring: style.boxShadow };
  });

  // This Machine: the instance manager records no status for it when its socket drops (#2102).
  const local = row(page, "This Machine");
  await expect(local.locator(".status")).toHaveText("Online");
  await expect(local.locator(".instance-tile-dot")).toHaveClass(/t-success/);
  await expect(local.locator(".instance-row-current")).toHaveText("Current");
  const green = (await dotStyle("This Machine")).background;
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.setConnection("reconnecting"));
  await expect(page.getByRole("status").filter({ hasText: "Can't reach Wollipog" })).toBeVisible();
  await expect(local.locator(".status")).toHaveText("Offline");
  await expect(local.locator(".instance-tile-dot")).toHaveClass(/t-neutral/);
  await expect(local.locator(".instance-tile-dot")).toHaveClass(/hollow/);
  await expect(local.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(local).not.toContainText("Online");
  const hollow = await dotStyle("This Machine");
  expect(hollow.background).not.toBe(green);
  expect(hollow.ring).toContain("inset");
  expect(hollow.ring).not.toContain(green);
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.setConnection(null));

  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  const studio = row(page, "Studio");
  await expect(studio.locator(".status")).toHaveText("Online");
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.setConnection("reconnecting"));
  await expect(page.getByRole("status").filter({ hasText: "Can't reach Studio" })).toBeVisible();
  await expect(studio.locator(".status")).toHaveText("Offline");
  await expect(studio.locator(".instance-tile-dot")).toHaveClass(/hollow/);
  await expect(studio.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.setConnection("sign-in-required"));
  await expect(studio.locator(".status")).toHaveText("Pairing Required");
  await expect(studio.locator(".instance-tile-dot")).toHaveClass(/t-warning/);
  await expect(studio.locator(".instance-tile-dot")).not.toHaveClass(/hollow/);
  await expect(studio.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(studio.getByRole("button", { name: "Re-Pair…" })).toBeVisible();
  const amber = await dotStyle("Studio");
  expect(amber.background).not.toBe(green);
  expect(amber.background).not.toBe(hollow.background);
  // The inactive This Machine row keeps its own status: the banner speaks only for Studio.
  await expect(local.locator(".status")).not.toHaveText("Pairing Required");
});

for (const width of [1440, 940]) {
  test(`at ${width}px the tab is one surface of 56px rows; a long name and address stay on one line`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    const long = "Build Farm in the Northern Datacenter Rack Seven Beside the North Door";
    expect(long).toHaveLength(70);
    await addInstance(page, long, `https://build-farm-north-rack-7-beside-the-loading-dock.internal.example/#pair=${TOKEN_B}`);
    await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
    await expect(page.locator(".instance-list")).toHaveCount(1);
    await expect(page.locator(".instance-row")).toHaveCount(3);
    const heights = await page.locator(".instance-row").evaluateAll((rows) => rows.map((element) => element.getBoundingClientRect().height));
    expect(heights).toEqual([56, 56, 56]);

    const geometry = await row(page, long).evaluate((element) => {
      const title = element.querySelector<HTMLElement>(".row-title")!;
      const address = element.querySelector<HTMLElement>(".instance-row-address")!;
      const badge = element.querySelector<HTMLElement>(".status");
      const actions = element.querySelector<HTMLElement>(".instance-row-actions")!;
      const rect = element.getBoundingClientRect();
      const lineHeight = (node: HTMLElement) => Number.parseFloat(getComputedStyle(node).lineHeight);
      const clipped = (node: HTMLElement) => {
        const style = getComputedStyle(node);
        return style.whiteSpace === "nowrap" && style.textOverflow === "ellipsis" && style.overflow === "hidden";
      };
      return {
        titleClipped: clipped(title),
        titleOneLine: title.getBoundingClientRect().height <= lineHeight(title) + 1,
        addressClipped: clipped(address),
        addressOneLine: address.getBoundingClientRect().height <= lineHeight(address) + 1,
        badgeAfterTitle: badge ? badge.getBoundingClientRect().left >= title.getBoundingClientRect().right : true,
        actionsRight: rect.right - actions.getBoundingClientRect().right,
        actionsInRow: actions.getBoundingClientRect().bottom <= rect.bottom,
      };
    });
    expect(geometry).toMatchObject({ titleClipped: true, titleOneLine: true, addressClipped: true, addressOneLine: true });
    expect(geometry.badgeAfterTitle).toBe(true);
    expect(geometry.actionsInRow).toBe(true);
    expect(geometry.actionsRight).toBeLessThanOrEqual(16);
    // The slot and ⋯ end at the same edges on every row, whatever the name's length; This Machine,
    // which has no menu, keeps its room.
    const rightOf = async (locator: ReturnType<Page["locator"]>) => locator.evaluate((element) => Math.round(element.getBoundingClientRect().right));
    expect(await rightOf(row(page, long).getByRole("button", { name: `More Actions for ${long}` })))
      .toBe(await rightOf(row(page, "Studio").getByRole("button", { name: "More Actions for Studio" })));
    expect(await rightOf(row(page, long).getByRole("button", { name: "Switch" })))
      .toBe(await rightOf(row(page, "This Machine").getByRole("button", { name: "Switch" })));
    await expect(page.locator(".instance-row .btn.primary")).toHaveCount(0);
    // A name that outgrows the row is cut to one line, its badge and actions still in place.
    await page.setViewportSize({ width: 760 + 1, height: 600 });
    const cut = await row(page, long).evaluate((element) => {
      const title = element.querySelector<HTMLElement>(".row-title")!;
      return { truncated: title.scrollWidth > title.clientWidth, height: element.getBoundingClientRect().height };
    });
    expect(cut).toEqual({ truncated: true, height: 56 });
  });
}

test("Switch keeps its label and width with a spinner while the row reads Connecting", async ({ page }) => {
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await tile(page, "Studio").click();
  await page.getByRole("menuitemradio", { name: /This Machine/ }).click();
  await expect(tile(page, "This Machine")).toBeVisible();
  const studio = row(page, "Studio");
  const switchButton = studio.getByRole("button", { name: "Switch" });
  const idle = await switchButton.evaluate((element) => element.getBoundingClientRect().width);
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.holdNextOpen("remote-1"));
  await switchButton.click();
  await expect(studio.locator(".status")).toHaveText("Connecting");
  await expect(switchButton).toHaveAttribute("aria-busy", "true");
  await expect(switchButton.locator(".spinner")).toBeVisible();
  await expect(switchButton).toHaveText("Switch");
  expect(await switchButton.evaluate((element) => element.getBoundingClientRect().width)).toBe(idle);
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.releaseOpen());
  await expect(studio.locator(".instance-row-current")).toHaveText("Current");
  await expect(studio.locator(".status")).toHaveText("Online");
});

test("Copy Address copies the full origin and confirms", async ({ page }) => {
  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await page.evaluate(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } },
    });
  });
  await rowAction(page, "Studio", "Copy Address");
  await expect(page.getByText("Copied the address.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(["http://100.64.10.11:4317"]);
  await expect(row(page, "Studio").getByRole("button", { name: "More Actions for Studio" })).toBeFocused();
});

test("in the labelled rail the tile's row shows the name and status, and the rail fits a 940×600 window", async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 600 });
  await addInstance(page, "Build Farm in the Northern Datacenter Rack Seven", `https://build-farm-north-rack-7.internal.example/#pair=${TOKEN_B}`);

  const fits = async () => page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".app-rail")!;
    const controls = [...rail.querySelectorAll<HTMLElement>(".instance-tile-trigger, .rail-item, .rail-foot button")];
    return {
      count: controls.length,
      tileHeight: rail.querySelector<HTMLElement>(".instance-tile-trigger")!.getBoundingClientRect().height,
      bottom: Math.max(...controls.map((control) => control.getBoundingClientRect().bottom)),
      railScroll: rail.scrollHeight - rail.clientHeight,
      viewportHeight: window.innerHeight,
    };
  });
  // The tile takes the brand's square and the old foot trigger is gone, so the 64px rail keeps
  // every control, #1968's foot button included, inside the desktop app's minimum window.
  const narrow = await fits();
  expect(narrow.bottom).toBeLessThanOrEqual(narrow.viewportHeight);
  expect(narrow.railScroll).toBeLessThanOrEqual(0);

  // Settings is the shell's own item: its gear, and in the 64px rail no visible name, inside the rail.
  const settings = page.locator(".rail-settings").getByRole("button", { name: "Settings" });
  const settingsLook = () => settings.evaluate((element) => {
    const icon = element.querySelector("svg")?.getBoundingClientRect();
    const label = element.querySelector<HTMLElement>(".rail-item-label");
    const rail = element.closest(".app-rail")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      icon: icon ? icon.width > 0 && icon.height > 0 : false,
      label: label && getComputedStyle(label).display !== "none" ? label.textContent : null,
      text: [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim(),
      insideRail: box.left >= rail.left && box.right <= rail.right && box.bottom <= window.innerHeight,
    };
  });
  expect(await settingsLook()).toEqual({ icon: true, label: null, text: "", insideRail: true });

  await page.getByRole("button", { name: "Expand Navigation" }).click();
  await expect(page.locator(".app-rail.labelled")).toBeVisible();
  const trigger = tile(page, "Build Farm in the Northern Datacenter Rack Seven");
  await expect(trigger.locator(".instance-tile-name")).toHaveText("Build Farm in the Northern Datacenter Rack Seven");
  await expect(trigger.locator(".instance-tile-status")).toHaveText("Online");
  await expect(trigger).not.toHaveAttribute("data-rail-tip");
  const row = await page.evaluate(() => {
    const monogram = document.querySelector<HTMLElement>(".rail-instance .instance-monogram.tile")!.getBoundingClientRect();
    const icon = document.querySelector<HTMLElement>(".rail-destinations .rail-item svg")!.getBoundingClientRect();
    const name = document.querySelector<HTMLElement>(".rail-instance .instance-tile-name")!;
    const rail = document.querySelector<HTMLElement>(".app-rail")!.getBoundingClientRect();
    return {
      monogramCenter: monogram.left + monogram.width / 2,
      iconCenter: icon.left + icon.width / 2,
      nameClipped: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === "ellipsis",
      nameRight: name.getBoundingClientRect().right,
      railRight: rail.right,
    };
  });
  expect(Math.abs(row.monogramCenter - row.iconCenter)).toBeLessThanOrEqual(1);
  expect(row.nameClipped).toBe(true);
  expect(row.nameRight).toBeLessThanOrEqual(row.railRight);
  const labelled = await fits();
  expect(labelled.count).toBe(narrow.count);
  expect(labelled.tileHeight, "the labelled row spends no more height than the tile").toBe(narrow.tileHeight);
  expect(labelled.railScroll).toBeLessThanOrEqual(0);
  expect(await settingsLook()).toEqual({ icon: true, label: "Settings", text: "", insideRail: true });
  expect(labelled.bottom).toBeLessThanOrEqual(labelled.viewportHeight);

  // The flyout opens beside the wider rail.
  await trigger.click();
  await dialogMotionSettled(page);
  const geometry = await flyoutGeometry(page);
  expect(geometry.railRight).toBeGreaterThan(200);
  expect(geometry.menuLeft - geometry.railRight).toBeGreaterThanOrEqual(3);
  expect(geometry.menuLeft - geometry.railRight).toBeLessThanOrEqual(5);
  expect(Math.abs(geometry.menuTop - geometry.tileTop)).toBeLessThanOrEqual(1);
});

test.describe("on a coarse pointer", () => {
  test.use({ hasTouch: true, viewport: { width: 940, height: 900 } });

  test("the labelled tile's monogram stays centred where the rail's icons are", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.getByRole("button", { name: "Expand Navigation" }).click();
    await expect(page.locator(".app-rail.labelled")).toBeVisible();
    const centres = await page.evaluate(() => {
      const monogram = document.querySelector<HTMLElement>(".rail-instance .instance-monogram.tile")!.getBoundingClientRect();
      const icon = document.querySelector<HTMLElement>(".rail-destinations .rail-item svg")!.getBoundingClientRect();
      const item = document.querySelector<HTMLElement>(".rail-destinations .rail-item")!.getBoundingClientRect();
      return { monogram: monogram.left + monogram.width / 2, icon: icon.left + icon.width / 2, itemHeight: item.height };
    });
    expect(centres.itemHeight).toBe(48);
    expect(Math.abs(centres.monogram - centres.icon)).toBeLessThanOrEqual(1);
  });
});
