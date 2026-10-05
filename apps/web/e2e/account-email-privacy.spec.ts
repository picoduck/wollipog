import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_PRIVACY_EVIDENCE_DIR ?? "test-results/account-email-privacy";
mkdirSync(evidenceDir, { recursive: true });

const KEY = "wollipog.hide-account-emails";
async function settleTheme(page: Page, theme: string) {
  await page.evaluate(async value => {
    document.documentElement.dataset.theme = value;
    // Style changes create transitions at the next rendered frame, after the dialog has opened.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  }, theme);
}

async function pickerContrast(page: Page) {
  return page.getByRole("dialog", { name: "Switch Account" }).evaluate(dialog => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    type Color = [number, number, number, number];
    const color = (value: string): Color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const rgba = [...context.getImageData(0, 0, 1, 1).data];
      return [rgba[0]!, rgba[1]!, rgba[2]!, rgba[3]! / 255];
    };
    const over = (front: Color, back: Color): Color => [
      ...front.slice(0, 3).map((channel, index) => channel * front[3] + back[index]! * (1 - front[3])), 1,
    ] as Color;
    const luminance = (rgba: Color) => rgba.slice(0, 3).map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    return [...dialog.querySelectorAll<HTMLElement>('.choice-row:has(input:checked) .account-usage-text, button.primary')].map(element => {
      const ancestors: Element[] = [];
      for (let parent: Element | null = element; parent; parent = parent.parentElement) ancestors.unshift(parent);
      const background = ancestors.reduce((back, node) => over(color(getComputedStyle(node).backgroundColor), back), [255, 255, 255, 1] as Color);
      const foreground = over(color(getComputedStyle(element).color), background);
      const light = luminance(foreground), dark = luminance(background);
      return { kind: element.matches("button") ? "button" : "selected usage label", contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
    });
  });
}

async function openPicker(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html?scenario=switch-account&accounts=default");
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("button", { name: "More Actions", exact: true }).first().click();
  await page.getByRole("menuitem", { name: /Switch Account…/ }).click();
  const dialog = page.getByRole("dialog", { name: "Switch Account" });
  await expect(dialog).toBeVisible();
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity));
  return dialog;
}
for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`${width}px ${theme}: Settings controls open account surfaces and keeps the saved choice after reload`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/settings-rows-e2e.html?section=behavior&theme=${theme}`);
      const privacy = page.getByRole("switch", { name: "Hide Account Emails" });
      await expect(privacy).toHaveAttribute("aria-checked", "false");
      expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBeNull();
      const accountsPage = await context.newPage();
      await accountsPage.setViewportSize({ width, height: 1000 });
      await accountsPage.addInitScript(theme => document.documentElement.dataset.theme = theme, theme);
      const picker = await openPicker(accountsPage);
      await settleTheme(accountsPage, theme);
      const contrast = await pickerContrast(accountsPage);
      expect(contrast).toHaveLength(3);
      for (const item of contrast) expect(item.contrast, item.kind).toBeGreaterThanOrEqual(4.5);
      console.log(JSON.stringify({ width, theme, settledPickerContrast: contrast }));
      await expect(picker).toContainText("current.me@example.com");
      await expect(picker.getByRole("button", { name: /(?:Show|Hide) Emails/ })).toHaveCount(0);
      await accountsPage.screenshot({ path: join(evidenceDir, `picker-${width}-${theme}-off.png`) });
      await privacy.focus();
      await page.keyboard.press("Space");
      await expect(privacy).toHaveAttribute("aria-checked", "true");
      await expect(picker).not.toContainText("@example.");
      expect(await picker.innerHTML()).not.toContain("@example.");
      const reveal = picker.getByRole("button", { name: "Show Emails" });
      await reveal.focus();
      await accountsPage.keyboard.press("Enter");
      await expect(picker).toContainText("work.me@example.com");
      await expect(picker.getByRole("button", { name: "Hide Emails" })).toBeFocused();
      // Changing the persisted mode twice clears this tab's temporary grant.
      await privacy.click();
      await privacy.click();
      await expect(reveal).toBeVisible();
      expect(await picker.innerHTML()).not.toContain("@example.");
      await accountsPage.screenshot({ path: join(evidenceDir, `picker-${width}-${theme}-on.png`) });
      await page.screenshot({ path: join(evidenceDir, `settings-${width}-${theme}-on.png`) });
      await page.reload();
      await expect(privacy).toHaveAttribute("aria-checked", "true");
      await accountsPage.reload();
      const reopened = await openPicker(accountsPage);
      expect(await reopened.innerHTML()).not.toContain("@example.");
      await privacy.click();
      await expect(reopened).toContainText("work.me@example.com");
      await expect(reopened.getByRole("button", { name: /(?:Show|Hide) Emails/ })).toHaveCount(0);
      await accountsPage.close();
    });
  }
}

for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
test(`${width}px ${theme}: Usage and authentication recovery show emails by default and update while open`, async ({ page, context }) => {
  await page.goto(`/settings-rows-e2e.html?section=behavior&theme=${theme}`);
  const privacy = page.getByRole("switch", { name: "Hide Account Emails" });
  const usage = await context.newPage();
  await usage.setViewportSize({ width, height: 1000 });
  await usage.goto("/usage-view-e2e.html?subscriptions=1");
  await usage.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  const account = usage.locator(".subscription-source").filter({ hasText: "Codex App Server on build-box" }).locator(".subscription-account");
  await expect(account).toContainText("codex@example.com");
  await expect(account.getByRole("button")).toHaveCount(0);
  const auth = await context.newPage();
  await auth.setViewportSize({ width, height: 1000 });
  await auth.goto("/authentication-recovery-e2e.html");
  // The request is on the Request Card docked above the composer (#2179); no panel to open.
  await auth.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  const recovery = auth.getByRole("group", { name: "Account Recovery" });
  await expect(recovery).toContainText("morgan.lee@example.com");
  await expect(recovery.getByRole("button", { name: "Show Current Account Email" })).toHaveCount(0);
  await account.screenshot({ path: join(evidenceDir, `usage-${width}-${theme}-off.png`) });
  await recovery.screenshot({ path: join(evidenceDir, `recovery-${width}-${theme}-off.png`) });
  await privacy.click();
  await expect(account).toContainText("Email Hidden");
  expect(await account.innerHTML()).not.toContain("codex@example.com");
  await expect(recovery.getByRole("button", { name: "Show Current Account Email" })).toBeVisible();
  expect(await recovery.innerHTML()).not.toContain("morgan.lee@example.com");
  await account.screenshot({ path: join(evidenceDir, `usage-${width}-${theme}-on.png`) });
  await recovery.screenshot({ path: join(evidenceDir, `recovery-${width}-${theme}-on.png`) });
  await privacy.click();
  await expect(account).toContainText("codex@example.com");
  await expect(recovery).toContainText("morgan.lee@example.com");
  await usage.close(); await auth.close();
});

}

for (const width of [390, 1440]) {
  test(`${width}px: provider management hides a reopened disclosure and an already-open confirmation`, async ({ page, context }) => {
    await page.goto("/settings-rows-e2e.html?section=behavior");
    const privacy = page.getByRole("switch", { name: "Hide Account Emails" });
    const management = await context.newPage();
    await management.setViewportSize({ width, height: 1000 });
    await management.goto("/machine-management-e2e.html?emailLabels=1");
    await management.getByText("Accounts", { exact: true }).click();
    const row = management.locator(".agent-row").filter({ hasText: "work@example.com" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "Show Account Email" })).toHaveCount(0);
    await management.screenshot({ path: join(evidenceDir, `management-${width}-off.png`) });
    await privacy.click();
    const maskedRow = management.locator(".agent-row").filter({ hasText: "Email Hidden" });
    const show = maskedRow.getByRole("button", { name: "Show Account Email" });
    await show.focus(); await management.keyboard.press("Enter");
    await expect(row).toBeVisible();
    await management.getByText("Accounts", { exact: true }).click();
    await management.getByText("Accounts", { exact: true }).click();
    await expect(show).toBeVisible();
    expect(await maskedRow.innerHTML()).not.toContain("work@example.com");
    await management.screenshot({ path: join(evidenceDir, `management-${width}-on.png`) });
    await maskedRow.getByRole("button", { name: "Remove", exact: true }).click();
    const confirm = management.getByRole("dialog", { name: "Remove Account" });
    await expect(confirm).toBeVisible();
    expect(await confirm.innerHTML()).not.toContain("work@example.com");
    await privacy.click();
    await expect(confirm).toContainText("work@example.com");
    await privacy.click();
    expect(await confirm.innerHTML()).not.toContain("work@example.com");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(management.getByText("Work", { exact: true })).toHaveCount(0);
    await expect(management.getByText("Personal", { exact: true })).toBeVisible();
    await management.close();
  });
}

for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
  test(`${width}px ${theme}: the pinned session account follows the setting without rewriting conversation content`, async ({ page, context }) => {
    await page.goto(`/settings-rows-e2e.html?section=behavior&theme=${theme}`);
    const privacy = page.getByRole("switch", { name: "Hide Account Emails" });
    const session = await context.newPage();
    await session.setViewportSize({ width, height: 1000 });
    await session.goto("/command-inbox-projects-e2e.html?fullShell=1&scenario=pinned-summary&psActivity=1");
    await session.getByRole("button", { name: /Alpha Session/ }).first().click();
    const expand = session.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();
    await session.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    let summary = session.locator('aside.ps[aria-label="Pinned Summary"]');
    if (width < 768) {
      await session.getByRole("button", { name: "Pinned Summary", exact: true }).click();
      summary = session.getByRole("dialog", { name: "Pinned Summary" });
    }
    await expect(summary).toContainText("pat.example@example.com");
    await summary.screenshot({ path: join(evidenceDir, `summary-${width}-${theme}-off.png`) });
    const conversation = await session.locator(".md").allTextContents();
    await privacy.click();
    await expect(summary).toContainText("Email Hidden");
    expect(await summary.innerHTML()).not.toContain("pat.example@example.com");
    expect(await session.locator(".md").allTextContents()).toEqual(conversation);
    await summary.screenshot({ path: join(evidenceDir, `summary-${width}-${theme}-on.png`) });
    await privacy.click();
    await expect(summary).toContainText("pat.example@example.com");
    await session.close();
  });
}

for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
  test(`${width}px ${theme}: New Session account choices are visible by default and a selection clears the reveal`, async ({ page, context }) => {
    await page.goto("/settings-rows-e2e.html?section=behavior");
    const privacy = page.getByRole("switch", { name: "Hide Account Emails" });
    const creation = await context.newPage();
    await creation.setViewportSize({ width, height: 1000 });
    await creation.goto("/new-session-choices-e2e.html?emailAccounts=1");
    await creation.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const account = creation.getByRole("button", { name: /Account:/ });
    await expect(account).toHaveAccessibleName(/work\.me@example\.com/);
    await expect(creation.getByRole("button", { name: "Show Emails" })).toHaveCount(0);
    await creation.getByRole("dialog").screenshot({ path: join(evidenceDir, `new-session-${width}-${theme}-off.png`) });
    await privacy.click();
    await expect(account).toHaveAccessibleName(/Hidden Account/);
    await creation.getByRole("dialog").screenshot({ path: join(evidenceDir, `new-session-${width}-${theme}-on.png`) });
    await creation.getByRole("button", { name: "Show Emails" }).click();
    await account.click();
    await creation.getByRole("option", { name: /work\.me@example\.org/ }).click();
    await expect(account).toHaveAccessibleName(/Hidden Account/);
    await expect(creation.getByRole("button", { name: "Show Emails" })).toBeVisible();
    await privacy.click();
    await expect(account).toHaveAccessibleName(/work\.me@example\.org/);
    await creation.close();
  });
}

test("default account settings follow privacy and changing their selection resets a reveal", async ({ page, context }) => {
  await page.goto("/settings-rows-e2e.html?section=behavior");
  const privacy = page.getByRole("switch", { name: "Hide Account Emails" });
  const management = await context.newPage();
  await management.goto("/machine-management-e2e.html?emailLabels=1");
  await management.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = management.getByRole("dialog", { name: "Manage Design Workstation" });
  const defaults = dialog.locator("section.machine-settings-section").filter({ hasText: "Default Provider Accounts" });
  const claude = dialog.getByRole("button", { name: /Default Claude Account:/ });
  await claude.click();
  await management.getByRole("option", { name: /work@example\.com/ }).click();
  await expect(claude).toHaveAccessibleName(/work@example\.com/);
  await expect(defaults.getByRole("button", { name: "Show Emails" })).toHaveCount(0);
  await privacy.click();
  await expect(claude).toHaveAccessibleName(/Hidden Account/);
  await defaults.getByRole("button", { name: "Show Emails" }).click();
  await expect(claude).toHaveAccessibleName(/work@example\.com/);
  await claude.click();
  await management.getByRole("option", { name: /Personal/ }).click();
  await expect(defaults.getByRole("button", { name: "Show Emails" })).toBeVisible();
  await claude.click();
  await expect(management.getByRole("option", { name: /Hidden Account/ })).toBeVisible();
  expect(await management.getByRole("listbox").innerHTML()).not.toContain("work@example.com");
  await management.close();
});

test("a Switch Account candidate selection preserves the keyboard reveal until the surface reopens", async ({ page, context }) => {
  await page.goto("/settings-rows-e2e.html?section=behavior");
  await page.getByRole("switch", { name: "Hide Account Emails" }).click();
  const accounts = await context.newPage();
  const picker = await openPicker(accounts);
  await picker.getByRole("button", { name: "Show Emails" }).click();
  const candidate = picker.getByRole("radio").nth(2);
  await candidate.focus();
  await accounts.keyboard.press("Space");
  await expect(candidate).toBeChecked();
  await expect(picker).toContainText("spare.me@example.org");
  await expect(picker.getByRole("button", { name: "Hide Emails" })).toBeVisible();
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  const reopened = await openPicker(accounts);
  expect(await reopened.innerHTML()).not.toContain("@example.");
  await accounts.close();
});
