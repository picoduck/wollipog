import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

const TOKEN_A = `${"a".repeat(20)}-ABC_${"x".repeat(18)}`;
const TOKEN_B = `${"b".repeat(20)}-DEF_${"y".repeat(18)}`;

/** The rail's instance tile (docs/design-system.md §4.1, #1970). */
const tile = (page: Page, name: string) => page.getByRole("button", { name: `Switch Instance: ${name}`, exact: true });

async function addInstance(page: Page, name: string, link: string) {
  await page.locator(".instances-page").getByRole("button", { name: "Add Remote Instance" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Remote Instance" });
  await dialog.getByLabel("Instance Name").fill(name);
  await dialog.getByLabel("Pairing Link").fill(link);
  await dialog.getByRole("button", { name: "Add and Switch" }).click();
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
  await expect(page.getByText("1 Instance")).toBeVisible();
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

  const studio = page.getByRole("article").filter({ hasText: "Studio" });
  await studio.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Instance" });
  await edit.getByLabel("Instance Name").fill("Home Studio");
  await edit.getByRole("button", { name: "Save Changes" }).click();
  await expect(tile(page, "Home Studio").locator(".instance-monogram")).toHaveText("HS");

  const renamed = page.getByRole("article").filter({ hasText: "Home Studio" });
  await renamed.getByRole("button", { name: "Re-Pair" }).click();
  const repair = page.getByRole("dialog", { name: "Re-Pair Instance" });
  await repair.getByLabel("Pairing Link").fill(`http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await repair.getByRole("button", { name: "Re-Pair" }).click();
  await expect(repair).toBeHidden();

  await page.goto("/remote-instances-e2e.html");
  await expect(tile(page, "Home Studio")).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem("wollipog.e2e.instance-registry"));
  expect(stored).not.toContain(TOKEN_A);
  expect(stored).not.toContain(TOKEN_B);

  await page.getByRole("article").filter({ hasText: "Laptop" }).getByRole("button", { name: "Remove" }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove Instance" });
  await confirmation.getByRole("button", { name: "Remove Instance" }).click();
  await expect(page.getByRole("article").filter({ hasText: "Laptop" })).toHaveCount(0);
  await expect(page.getByText("2 Instances")).toBeVisible();
});

test("shows deterministic validation and authentication recovery", async ({ page }) => {
  await page.locator(".instances-page").getByRole("button", { name: "Add Remote Instance" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Remote Instance" });
  await dialog.getByLabel("Instance Name").fill("Broken");
  await dialog.getByLabel("Pairing Link").fill("http://192.168.1.10:4317/#pair=short");
  await dialog.getByRole("button", { name: "Add and Switch" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await addInstance(page, "Studio", `http://100.64.10.11:4317/#pair=${TOKEN_A}`);
  await tile(page, "Studio").click();
  await page.getByRole("menuitemradio", { name: /This Machine/ }).click();
  await page.evaluate(() => window.__WOLLIPOG_INSTANCE_E2E__.failNextOpen(
    "remote-1",
    "authentication-required",
    "The pairing token was rejected.",
  ));
  await page.getByRole("article").filter({ hasText: "Studio" }).getByRole("button", { name: "Switch" }).click();
  const studio = page.getByRole("article").filter({ hasText: "Studio" });
  // Instances share the machine vocabulary (docs/design-system.md §11.2).
  await expect(studio.getByText("Sign-In Required", { exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Re-Pair" })).toBeVisible();
  // The tile and its menu say the same thing, as text and not only as a colour.
  await expect(tile(page, "Studio").locator(".instance-tile-dot")).toHaveClass(/t-warning/);
  await tile(page, "Studio").click();
  await expect(page.getByRole("menuitemradio", { name: /Studio/ }).locator(".status")).toHaveText("Sign-In Required");
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
  await page.getByRole("article").filter({ hasText: "Studio" }).getByRole("button", { name: "Switch" }).click();
  await expect(page.getByRole("article").filter({ hasText: "Studio" }).getByText("Offline", { exact: true })).toBeVisible();
  const dot = tile(page, "Studio").locator(".instance-tile-dot");
  await expect(dot).toHaveClass(/hollow/);
  await expect(dot).toHaveClass(/t-neutral/);

  await page.getByRole("article").filter({ hasText: "This Machine" }).getByRole("button", { name: "Switch" }).click();
  await tile(page, "This Machine").click();
  const row = page.getByRole("menuitemradio", { name: /Studio/ });
  await expect(row.locator(".status")).toHaveText("Offline");
  await expect(row.locator(".status")).toHaveClass(/hollow/);
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
  await expect(page.locator(".rail-tooltip-detail")).toHaveText("Reconnecting…");
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
