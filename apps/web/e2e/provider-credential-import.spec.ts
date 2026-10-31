import { expect, test, type Page } from "@playwright/test";

/** #3719: Add Account can copy an existing Codex API-key sign-in into a new managed profile. */
const DESIGN_WORKSTATION = "machine=native-t14s";

async function openAddAccount(page: Page, query: string) {
  await page.goto(`/machine-management-e2e.html?${query}&${DESIGN_WORKSTATION}`);
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Provider Accounts/ }) });
  await section.getByRole("button", { name: "Add Account…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Account" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("an Owner copies a Codex API-key sign-in into a new profile after confirming its source", async ({ page }) => {
  const dialog = await openAddAccount(page, "credentialImport");
  await expect(dialog).toContainText("Copying an existing Claude sign-in isn't available");
  await dialog.getByRole("radio", { name: "Codex" }).click();
  await dialog.getByRole("radio", { name: "Copy Existing Sign-In" }).click();
  const sources = dialog.getByRole("radiogroup", { name: "Copy From" });
  await expect(sources.getByRole("radio")).toHaveCount(3);
  await expect(sources.getByRole("radio", { name: "This Machine's Codex Sign-In" })).toBeChecked();
  await sources.getByRole("radio", { name: "Codex Team" }).check();
  await dialog.getByLabel("Account Label").fill("Codex Copy");
  await dialog.getByRole("button", { name: "Copy Sign-In" }).click();
  const confirmation = page.getByRole("dialog", { name: "Copy Sign-In" });
  await expect(confirmation).toContainText("Only the API key is copied from Codex Team into the new profile Codex Copy on Design Workstation");
  await confirmation.getByRole("button", { name: "Copy Sign-In" }).click();
  await expect(page.getByText("Sign-in copied to the new profile.")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".row-title", { hasText: "Codex Copy" })).toBeVisible();
});

test("a ChatGPT sign-in is refused in the dialog with the reason", async ({ page }) => {
  const dialog = await openAddAccount(page, "credentialImport");
  await dialog.getByRole("radio", { name: "Codex" }).click();
  await dialog.getByRole("radio", { name: "Copy Existing Sign-In" }).click();
  await dialog.getByLabel("Account Label").fill("ChatGPT");
  await dialog.getByRole("button", { name: "Copy Sign-In" }).click();
  await page.getByRole("dialog", { name: "Copy Sign-In" }).getByRole("button", { name: "Copy Sign-In" }).click();
  const notice = dialog.locator('.notice[role="alert"]');
  await expect(notice).toContainText("Couldn't Copy the Sign-In");
  await expect(notice).toContainText("A ChatGPT sign-in, or one kept in the keyring, can't be shared safely");
});

test("a Windows machine explains why it can't copy an existing sign-in", async ({ page }) => {
  const windows = await openAddAccount(page, "windows");
  await windows.getByRole("radio", { name: "Codex" }).click();
  await expect(windows).toContainText("isn't available on Windows machines");
  await expect(windows.getByRole("radio", { name: "Copy Existing Sign-In" })).toHaveCount(0);
});

/**
 * UI evidence (#3719): with CAPTURE_DIR set, Add Account for Codex (Copy Existing Sign-In when it
 * is offered) and its confirmation, on desktop and phone, in dark and light. Runs against both the
 * base and the change, so it asserts nothing the base lacks.
 */
test("capture Add Account evidence", async ({ page }) => {
  const directory = process.env.CAPTURE_DIR;
  test.skip(!directory, "set CAPTURE_DIR to capture UI evidence");
  for (const [viewport, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    for (const theme of ["dark", "light"] as const) {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const dialog = await openAddAccount(page, "credentialImport");
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${directory}/add-account-claude-${viewport}-${theme}.png` });
      await dialog.getByRole("radio", { name: "Codex" }).click();
      const copy = dialog.getByRole("radio", { name: "Copy Existing Sign-In" });
      if (await copy.count()) await copy.click();
      await dialog.getByLabel("Account Label").fill("Codex Copy");
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${directory}/add-account-codex-${viewport}-${theme}.png` });
      if (await copy.count()) {
        await dialog.getByRole("button", { name: "Copy Sign-In" }).click();
        await expect(page.getByRole("dialog", { name: "Copy Sign-In" })).toBeVisible();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${directory}/copy-confirmation-${viewport}-${theme}.png` });
      }
    }
  }
});

/**
 * UI evidence (#3719), with CAPTURE_DIR set: where copying isn't offered (a Windows machine, a
 * Linux runner inside WSL or a container, a runner below v260) and a refusal after Copy Sign-In.
 */
test("capture unavailable and refused evidence", async ({ page }) => {
  const directory = process.env.CAPTURE_DIR;
  test.skip(!directory, "set CAPTURE_DIR to capture UI evidence");
  const unavailable = [
    ["windows", "windows", /isn't available on Windows machines/],
    ["wsl-or-container", "credentialImport=unsupported", /runs inside WSL or a container/],
    ["older-runner", "credentialImport&outdated", /Update this machine's runner/],
  ] as const;
  for (const [viewport, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    for (const theme of ["dark", "light"] as const) {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const [name, query, reason] of unavailable) {
        const dialog = await openAddAccount(page, query);
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await dialog.getByRole("radio", { name: "Codex" }).click();
        await expect(dialog).toContainText(reason);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${directory}/unavailable-${name}-${viewport}-${theme}.png` });
      }
      const dialog = await openAddAccount(page, "credentialImport");
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await dialog.getByRole("radio", { name: "Codex" }).click();
      await dialog.getByRole("radio", { name: "Copy Existing Sign-In" }).click();
      await dialog.getByLabel("Account Label").fill("ChatGPT");
      await dialog.getByRole("button", { name: "Copy Sign-In" }).click();
      await page.getByRole("dialog", { name: "Copy Sign-In" }).getByRole("button", { name: "Copy Sign-In" }).click();
      const notice = dialog.locator('.notice[role="alert"]');
      await expect(notice).toContainText("Couldn't Copy the Sign-In");
      await notice.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${directory}/refused-oauth-${viewport}-${theme}.png` });
    }
  }
});
