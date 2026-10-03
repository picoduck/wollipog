import { devices, expect, test, type Page } from "@playwright/test";
import { openSessionWithTray, TRAY_REFERENCE_FINGERPRINT } from "./fixtures/composer-tray.js";

test("workspace paths and exact diff lines become inspectable prompt attachments", async ({ page }) => {
  await page.goto("/workspace-references-e2e.html?state=after&theme=dark");
  await expect(page.getByRole("listbox", { name: "Workspace Paths" })).toBeVisible();
  await page.getByRole("option", { name: /src\/session\.ts/ }).click();
  await expect(page.getByRole("button", { name: /Inspect Reference src\/session\.ts$/ })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Worktree Line 19 for Prompt" }).check();
  await page.getByRole("checkbox", { name: "Select Worktree Line 20 for Prompt" }).check();
  await page.getByRole("button", { name: "Attach Selected (2)" }).click();
  await expect(page.getByRole("button", { name: /Inspect Reference src\/session\.ts:19-20 · Worktree/ })).toBeVisible();
});

test("@ rows show an icon, the name before its folder, and the match underlined, without emoji", async ({ page }) => {
  await page.goto("/workspace-references-e2e.html?state=after&theme=dark");
  const listbox = page.getByRole("listbox", { name: "Workspace Paths" });
  await expect(listbox).toBeVisible();
  await expect(listbox).not.toContainText(/📁|📄/u);

  const nested = page.getByRole("option", { name: "apps/web/src/components/session/index.ts" });
  await expect(nested.locator("svg")).toHaveCount(1);
  await expect(nested.locator(".picker-name")).toHaveText("index.ts");
  await expect(nested.locator(".picker-path")).toHaveText("apps/web/src/components/session");
  await expect(nested.locator(".picker-path mark")).toHaveText("session");
  const [name, folder] = await Promise.all([nested.locator(".picker-name").boundingBox(), nested.locator(".picker-path").boundingBox()]);
  expect(name!.x).toBeLessThan(folder!.x);

  // A long folder keeps its end and loses its start.
  await page.setViewportSize({ width: 600, height: 900 });
  const long = page.getByRole("option", { name: /session-index\.ts$/ });
  const path = long.locator(".picker-path");
  await expect(path).toHaveCSS("direction", "rtl");
  await expect(path).toHaveCSS("text-overflow", "ellipsis");
  // The text overflows its box on the left, and its end lines up with the box's right edge.
  const [box, text] = await Promise.all([path.boundingBox(), path.locator("bdi").boundingBox()]);
  expect(text!.x).toBeLessThan(box!.x);
  expect(Math.abs(text!.x + text!.width - (box!.x + box!.width))).toBeLessThanOrEqual(1);
  await expect(long.locator(".picker-name mark")).toHaveText("session");
});

test("the @ picker's states each say one plain thing", async ({ page }) => {
  const open = async (state: string) => {
    await page.goto(`/workspace-references-e2e.html?state=after&theme=dark&picker=${state}`);
    await expect(page.locator(".picker")).toBeVisible();
  };

  await open("noquery");
  await expect(page.locator(".picker-empty")).toHaveText("Type a file or folder name.Searches wollipog on Studio Mac.");
  await expect(page.getByRole("option")).toHaveCount(0);

  await open("busy");
  await expect(page.getByRole("status")).toHaveText("Searching the workspace…");

  await open("offline");
  const offline = page.getByRole("alert");
  await expect(offline).toHaveText("Studio Mac is offline. Try again when it reconnects.");
  await expect(offline.locator("svg")).toHaveCount(1);

  await open("error");
  await expect(page.getByRole("alert")).toHaveText("Couldn't search the workspace. Try again.");
  await expect(page.locator(".picker")).not.toContainText("ECONNRESET");

  await open("none");
  await expect(page.getByRole("status")).toHaveText("No files or folders match “zzzz”.");

  await open("truncated");
  await expect(page.locator(".picker-foot .picker-note")).toHaveText("More matches exist. Keep typing to narrow them.");
  await expect(page.getByRole("option")).toHaveCount(4);
});

/** The row naming the reference's content hash (WorkspaceReferenceDialog's REFERENCE_HASH_LABEL). */
const HASH_LABEL = "Fingerprint";
const chip = (page: Page) => page.getByRole("button", { name: "Inspect Reference src/session.ts:18-21" });
const fileReference = (page: Page) => page.getByRole("dialog", { name: "File Reference" });

test.describe("the File Reference dialog (#2177)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("has its facts and two actions but no Done; × and Escape close it and return focus to the chip", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openSessionWithTray(page);
    await chip(page).click();
    const dialog = fileReference(page);
    await expect(dialog).toBeVisible();

    await expect(dialog.locator("dt")).toHaveText(["Path", "Lines", HASH_LABEL]);
    await expect(dialog.locator("dd")).toHaveText(["src/session.ts", "18–21", TRAY_REFERENCE_FINGERPRINT.slice(0, 12)]);
    await expect(dialog.getByText("Before sending, Wollipog checks that these lines haven't changed on runner-1."))
      .toBeVisible();
    const footer = dialog.locator(".modal-foot");
    await expect(footer.getByRole("button")).toHaveText(["Remove from Message", "Open in Files"]);
    await expect(dialog.getByRole("button", { name: "Done" })).toHaveCount(0);
    await expect(dialog.locator(".btn.primary")).toHaveCount(0);

    // Copy copies the twelve characters shown, with the copy button's confirmation (#1955).
    const copy = dialog.getByRole("button", { name: `Copy ${HASH_LABEL}` });
    await copy.click();
    await expect(copy).toHaveClass(/copy-status-copied/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TRAY_REFERENCE_FINGERPRINT.slice(0, 12));
    await dialog.getByRole("button", { name: "Copy Path" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("src/session.ts");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(chip(page)).toBeFocused();

    await chip(page).click();
    await fileReference(page).getByRole("button", { name: "Close" }).click();
    await expect(fileReference(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
  });

  test("Remove from Message removes the reference, closes the dialog and keeps focus in the composer", async ({ page }) => {
    await openSessionWithTray(page);
    await chip(page).click();
    await fileReference(page).getByRole("button", { name: "Remove from Message" }).click();
    await expect(fileReference(page)).toHaveCount(0);
    await expect(page.locator(".composer-attachments .ref-chip")).toHaveCount(0);
    await expect(page.locator(".composer-attachments .attach-thumb")).toHaveCount(2);
    await expect(page.locator(".composer-input")).toBeFocused();
  });

  test("Open in Files opens the file in the right panel", async ({ page }) => {
    await openSessionWithTray(page);
    await chip(page).click();
    await fileReference(page).getByRole("button", { name: "Open in Files" }).click();
    await expect(fileReference(page)).toHaveCount(0);
    const panel = page.locator("#right-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Files", { exact: true })).toBeVisible();
    // The reference stays attached: opening it is not removing it.
    await expect(chip(page)).toBeVisible();
  });
});

test("at 390×844 the File Reference dialog is a bottom sheet with both footer actions in view (#2177)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSessionWithTray(page);
  await chip(page).click();
  const dialog = fileReference(page);
  await expect(dialog).toBeVisible();
  // Docked to the bottom edge, full width.
  await expect.poll(async () => {
    const box = (await dialog.boundingBox())!;
    return [Math.round(box.y + box.height), Math.round(box.width)];
  }).toEqual([844, 390]);
  for (const name of ["Remove from Message", "Open in Files"]) {
    await expect(dialog.locator(".modal-foot").getByRole("button", { name })).toBeInViewport({ ratio: 1 });
  }
});

test.describe("on a phone with a coarse pointer (#2177)", () => {
  test.use({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce",
    userAgent: devices["Pixel 7"].userAgent,
  });

  test("Remove from Message on the only attachment returns focus to the composer it revealed", async ({ page }) => {
    // With nothing else attached and a one-line draft, removing the reference would collapse the idle
    // phone composer and hide the textarea the dialog returns focus to.
    await openSessionWithTray(page, { referenceOnly: true });
    await chip(page).tap();
    await fileReference(page).getByRole("button", { name: "Remove from Message" }).tap();
    await expect(fileReference(page)).toHaveCount(0);
    await expect(page.locator(".composer-attachments")).toHaveCount(0);
    await expect(page.locator(".composer-input")).toBeVisible();
    await expect(page.locator(".composer-input")).toBeFocused();
  });

  test("a tap on the end of the path inspects the reference; the remove's hit area stays off the text", async ({ page }) => {
    await openSessionWithTray(page);
    const suffix = page.locator(".composer-attachments .ref-chip-suffix");
    const box = (await suffix.boundingBox())!;
    // Every pixel of the text, to its last, belongs to the open half.
    const owner = ({ x, y }: { x: number; y: number }) =>
      document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label");
    expect(await page.evaluate(owner, { x: box.x + box.width - 1, y: box.y + box.height / 2 }))
      .toBe("Inspect Reference src/session.ts:18-21");
    // A tap on the line range inspects. (A tap within a pixel or two of the edge is the browser's touch
    // adjustment to call between two neighbouring targets, as it is for any two buttons.)
    await page.touchscreen.tap(box.x + box.width - 6, box.y + box.height / 2);
    await expect(fileReference(page)).toBeVisible();
    await expect(page.locator(".composer-attachments .ref-chip")).toHaveCount(1);
  });
});
