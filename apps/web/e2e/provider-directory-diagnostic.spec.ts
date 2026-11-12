import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

for (const width of [390, 1280]) for (const theme of ["dark", "light"]) {
  test(`directory failure preserves the draft and keyboard dismissal at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/machine-management-e2e.html?profiles&providerSetup=installed&machine=native-t14s&theme=${theme}` +
      "&accounts=add-codex&directoryFailure=profiles_root:group_or_other_write");
    const dialog = page.getByRole("dialog", { name: "Add Account", exact: true });
    const label = dialog.getByLabel("Account Label");
    await expect(label).toBeFocused();
    await label.fill("Remote Work Draft");
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `before-${width}-${theme}.png`), animations: "disabled" });
    await label.press("Enter");
    const failure = dialog.getByRole("alert");
    await expect(failure).toContainText("the provider profiles directory allows other users to write to it");
    await expect(failure).toContainText("remote Machine, not the control-plane host");
    await expect(dialog.getByRole("radio", { name: "Codex", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(label).toHaveValue("Remote Work Draft");
    await expect(page.locator(".signin")).toHaveCount(0);
    await expect(failure).not.toContainText("/fixture/secret");
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `failure-compact-${width}-${theme}.png`), animations: "disabled" });
    const inspection = dialog.getByText("Local Linux Inspection", { exact: true });
    await inspection.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByText("wollipog profile-root inspect --component profiles_root", { exact: true })).toBeVisible();
    await expect(dialog.getByText("wollipog profile-root repair --component profiles_root", { exact: true })).toBeVisible();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await cancel.focus();
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `failure-${width}-${theme}.png`), animations: "disabled" });
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Remote Work Draft");
  });
}

for (const [variant, expected] of [
  ["manager_root:symlink", "Wollipog's main directory is a symbolic link"],
  ["profile_home:not_directory", "the account directory is not a directory"],
  ["profile_home:wrong_owner", "the account directory belongs to a different OS user"],
  ["profiles_root:unavailable", "the provider profiles directory could not be inspected"],
  ["profiles_root:may_have_changed", "Do not retry automatically."],
  ["absent", "Provider sign-in could not be started."],
  ["profiles_root:future_reason", "Provider sign-in could not be started."],
  ["os_home:unsupported_acl", "the OS user's home directory has access permissions that could not be verified"],
]) test(`start failure ${variant} is safe before provider launch`, async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?profiles&providerSetup=installed&machine=native-t14s&accounts=add-claude&directoryFailure=${variant}`);
  const dialog = page.getByRole("dialog", { name: "Add Account", exact: true });
  await dialog.getByLabel("Account Label").fill("Draft");
  await dialog.getByRole("button", { name: "Start Sign-In", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(expected);
  await expect(dialog.getByRole("alert")).not.toContainText("Private peer exception");
  await expect(page.locator(".signin")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("keyboard dismissal restores focus to Add Separate Sign-In after a start refusal", async ({ page }) => {
  await page.goto("/machine-management-e2e.html?profiles&providerSetup=installed&machine=native-t14s&directoryFailure=profiles_root:unavailable");
  const trigger = page.getByRole("button", { name: "Add Separate Sign-In…", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Add Account", exact: true });
  await dialog.getByLabel("Account Label").fill("Draft");
  await dialog.getByLabel("Account Label").press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("could not be inspected");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const [refusal, expected] of [["offline", "This Machine is offline"], ["publication", "control plane cannot record account access"]]) {
  test(`control-plane ${refusal} refusal gives the right recovery guidance`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/machine-management-e2e.html?profiles&providerSetup=installed&machine=native-t14s&accounts=add-codex&startRefusal=${refusal}`);
    const dialog = page.getByRole("dialog", { name: "Add Account", exact: true });
    await dialog.getByLabel("Account Label").fill("Remote Work Draft");
    await dialog.getByLabel("Account Label").press("Enter");
    await expect(dialog.getByRole("alert")).toContainText(expected!);
    await expect(dialog.getByRole("alert")).not.toContainText("private storage exception");
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `admission-${refusal}.png`), animations: "disabled" });
  });
}
