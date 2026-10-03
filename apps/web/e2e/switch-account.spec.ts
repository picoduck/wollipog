import { expect, test, type Page } from "@playwright/test";

/** Switch Account (#2149): the session's account leads the list, usage is a meter per window, and
 * one Show Emails control in the Accounts head reveals every row. */
async function openSwitchAccount(page: Page, accounts: "default" | "removed" | "none" | "auth" | "reasons", width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  const url = `/command-inbox-projects-e2e.html?scenario=switch-account&accounts=${accounts}`;
  await page.goto(url); await page.evaluate(() => { localStorage.clear(); localStorage.setItem("wollipog.hide-account-emails", "true"); }); await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("button", { name: "More Actions", exact: true }).first().click();
  await page.getByRole("menuitem", { name: /Switch Account…/ }).click();
  const dialog = page.getByRole("dialog", { name: "Switch Account" });
  await expect(dialog).toBeVisible();
  // The card (or the phone sheet) eases in; measure it where it comes to rest.
  await page.waitForFunction(() => !document.getAnimations().some((animation) =>
    animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity));
  return dialog;
}

/** Each row's title, without the "Current" chip that shares its line. */
async function rowTitles(page: Page): Promise<string[]> {
  return page.locator(".account-rows .choice-row-title").evaluateAll((titles) =>
    titles.map((title) => title.firstChild?.textContent ?? ""));
}

test("the current account leads, each account shows its usage meters, and Show Emails reveals every row", async ({ page }) => {
  const dialog = await openSwitchAccount(page, "default");
  await expect(dialog).toContainText("Continue this conversation with another Codex account on runner-1.");
  await expect(dialog.locator(".switch-account-rule"))
    .toHaveText("A turn that is running finishes on the current account. Queued messages go to the new one.");
  await expect.poll(() => rowTitles(page)).toEqual(["Hidden Account", "Hidden Account 1", "Hidden Account 2", "Hidden Account 3"]);
  const rows = dialog.locator(".account-rows .choice-row");
  await expect(rows.nth(0).locator(".choice-row-status")).toHaveText("Current");
  await expect(rows.nth(0)).toHaveClass(/is-disabled/);
  await expect(rows.nth(1).locator(".account-usage-text")).toHaveText(["5-Hour · 78% left", "Weekly · 39% left"]);
  await expect(rows.nth(2).locator(".meter")).toHaveClass([/t-warning/, /^meter$/]);
  await expect(rows.nth(2).locator(".account-usage-stale")).toHaveText("Last Known");
  await expect(rows.nth(3).locator(".choice-row-reason")).toHaveText("Signed out on runner-1.");
  await expect(dialog.getByRole("radio").nth(1)).toBeChecked();
  expect(await dialog.innerHTML()).not.toContain("@example.");

  const meter = await rows.nth(1).locator(".meter").first().evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    fill: getComputedStyle(element.firstElementChild!).width,
    width: element.getBoundingClientRect().width,
  }));
  expect(meter.height).toBe(6);
  expect(Number.parseFloat(meter.fill) / meter.width).toBeCloseTo(0.78, 2);

  await dialog.getByRole("button", { name: "Show Emails" }).click();
  await expect.poll(() => rowTitles(page))
    .toEqual(["current.me@example.com", "work.me@example.com", "spare.me@example.org", "old.me@example.net"]);
  await dialog.getByRole("button", { name: "Hide Emails" }).click();
  await expect.poll(() => rowTitles(page)).toEqual(["Hidden Account", "Hidden Account 1", "Hidden Account 2", "Hidden Account 3"]);
});

test("a removed current account reads Removed Account with no meters, and Switch Account stays available", async ({ page }) => {
  const dialog = await openSwitchAccount(page, "removed");
  await expect.poll(() => rowTitles(page)).toEqual(["Removed Account", "Hidden Account 1", "Hidden Account 2", "Hidden Account 3"]);
  const current = dialog.locator(".account-rows .choice-row").first();
  await expect(current.locator(".choice-row-desc"))
    .toHaveText("Removed from runner-1. This session keeps its sign-in until you switch.");
  await expect(current.locator(".meter")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Switch Account", exact: true })).toBeEnabled();
});

test("the endpoint's reasons tell a used-up window from a missing usage reading (#2276)", async ({ page }) => {
  const dialog = await openSwitchAccount(page, "reasons");
  await expect.poll(() => rowTitles(page)).toEqual(["Hidden Account", "Hidden Account 1", "Hidden Account 2", "Hidden Account 3"]);
  const rows = dialog.locator(".account-rows .choice-row");
  await expect(rows.nth(1)).not.toHaveClass(/is-disabled/);
  await expect(rows.nth(2).locator(".choice-row-reason")).toHaveText("The 5-Hour window is used up and resets in 2 hours.");
  await expect(rows.nth(3).locator(".choice-row-reason")).toHaveText("No current usage reading is available.");
  for (const index of [2, 3]) await expect(rows.nth(index)).toHaveClass(/is-disabled/);
  await expect(dialog.getByRole("radio").nth(1)).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Switch Account", exact: true })).toBeEnabled();
});

test("a session blocked on authentication is not promised that queued messages move", async ({ page }) => {
  const dialog = await openSwitchAccount(page, "auth");
  await expect(dialog.locator(".switch-account-rule")).toHaveText("A turn that is running finishes on the current account.");
});

test("with no other account, the dialog sends the person to Connections", async ({ page }) => {
  const dialog = await openSwitchAccount(page, "none");
  await expect(dialog.locator(".state-title")).toHaveText("No Other Accounts");
  await expect(dialog).toContainText("Sign in to another Codex account on runner-1, then switch here.");
  await expect(dialog.locator(".modal-foot button")).toHaveText(["Done"]);
  await dialog.getByRole("button", { name: "Open Connections" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Fixture View: runners")).toBeVisible();
});

test("the primary keeps its label and width while switching", async ({ page }) => {
  const dialog = await openSwitchAccount(page, "default");
  const primary = dialog.getByRole("button", { name: "Switch Account", exact: true });
  await expect(primary).toBeEnabled();
  const before = await primary.evaluate((element) => (element as HTMLElement).offsetWidth);
  await primary.click();
  await expect(primary).toHaveAttribute("aria-busy", "true");
  await expect(primary).toHaveText("Switch Account");
  expect(await primary.evaluate((element) => (element as HTMLElement).offsetWidth)).toBe(before);
  await page.evaluate(() => (window as unknown as { __settleSwitchAccount: () => void }).__settleSwitchAccount());
  await expect(dialog).toHaveCount(0);
});

test.describe("on a phone with a coarse pointer", () => {
  test.use({ hasTouch: true });

  test("Show Emails has a 44px hit area and nothing overflows", async ({ page }) => {
    const dialog = await openSwitchAccount(page, "default", 390, 844);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const toggle = dialog.getByRole("button", { name: "Show Emails" });
    const hit = await toggle.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const owns = (px: number, py: number) => document.elementFromPoint(px, py)?.closest("button") === button;
      // 1px inside a 44px square centred on the button.
      const half = Math.max(21, box.width / 2 - 1);
      return {
        edges: [owns(x, y - 21), owns(x, y + 21), owns(x - half, y), owns(x + half, y)],
        at: document.elementFromPoint(x, y)?.outerHTML.slice(0, 120),
      };
    });
    expect(hit.edges, hit.at).toEqual([true, true, true, true]);
    const overflow = await dialog.evaluate((element) => [...element.querySelectorAll<HTMLElement>(".choice-row, .account-usage-window")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1).length);
    expect(overflow).toBe(0);
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(390);
  });

  test("the endpoint's longer reasons wrap inside their rows", async ({ page }) => {
    const dialog = await openSwitchAccount(page, "reasons", 390, 844);
    await expect(dialog.locator(".choice-row-reason")).toHaveCount(2);
    const overflow = await dialog.evaluate((element) => [...element.querySelectorAll<HTMLElement>(".choice-row, .choice-row-reason")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1).length);
    expect(overflow).toBe(0);
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(390);
  });
});
