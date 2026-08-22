import { devices, expect, test, type Page } from "@playwright/test";

/**
 * The composer's Attach Image action, end to end.
 *
 * #129's finding was that every image ingress the app had — clipboard paste and drag-and-drop —
 * is a desktop affordance. A phone has neither, so an image-capable session was unreachable from
 * the device that most often holds the photo. What the unit tests cover is `addFiles`, which was
 * already correct; what they cannot see is whether anything in the UI can *reach* it. These drive
 * the native chooser Playwright intercepts as a `filechooser` event — the same object the browser
 * would hand the operating system.
 */

const phone = devices["Pixel 7"];

/** A four-byte PNG signature: enough for the MIME-and-size gate, which never decodes pixels. */
const PNG = Buffer.from([137, 80, 78, 71]);

type PickedFile = { name: string; mimeType: string; buffer: Buffer };

function file(name: string, mimeType: string, buffer: Buffer = PNG): PickedFile {
  return { name, mimeType, buffer };
}

async function openSession(page: Page, supportsImages = true) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(
    (images) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], [], { supportsImages: images }),
    supportsImages,
  );
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-input")).toBeEnabled();
}

const attachAction = (page: Page) => page.getByRole("button", { name: "Attach Image", exact: true });

async function openPlusMenu(page: Page) {
  await page.getByRole("button", { name: "Add and Modes" }).click();
  await expect(page.getByRole("dialog", { name: "Session Attachments, Modes, and Guardrails" })).toBeVisible();
}

/** Tap Attach Image and hand the intercepted chooser the files a device picker would return. */
async function pickImages(page: Page, files: PickedFile[]) {
  await openPlusMenu(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), attachAction(page).click()]);
  await chooser.setFiles(files);
  return chooser;
}

const thumbnails = (page: Page) => page.getByRole("button", { name: "Remove Image" });

test("the action opens a native multi-select chooser scoped to the session's image types", async ({ page }) => {
  await openSession(page);
  await openPlusMenu(page);

  const action = attachAction(page);
  await expect(action).toBeEnabled();
  await expect(action).toHaveAccessibleName("Attach Image");

  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), action.click()]);
  expect(chooser.isMultiple()).toBe(true);

  const input = page.locator(".composer-attach-input");
  // The Codex app-server driver drops GIF, so the chooser must not offer it either.
  await expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
  // `capture` would force the camera and hide the photo library and file browser.
  expect(await input.getAttribute("capture")).toBeNull();

  await chooser.setFiles([file("one.png", "image/png")]);
  await expect(thumbnails(page)).toHaveCount(1);
});

test("cancelling the chooser leaves the draft and attachments untouched", async ({ page }) => {
  await openSession(page);
  const composer = page.locator(".composer-input");
  await composer.fill("keep this draft");
  await pickImages(page, [file("kept.png", "image/png")]);
  await expect(thumbnails(page)).toHaveCount(1);

  // No `filechooser` listener: Playwright dismisses the dialog, which is precisely a user cancel.
  await openPlusMenu(page);
  await attachAction(page).click();

  await expect(composer).toHaveValue("keep this draft");
  await expect(thumbnails(page)).toHaveCount(1);
  await expect(page.locator(".composer-error")).toHaveCount(0);
});

test("a text-only model explains itself instead of opening a picker", async ({ page }) => {
  await openSession(page, false);
  await openPlusMenu(page);

  const action = attachAction(page);
  await expect(action).toBeDisabled();
  await expect(page.getByText("The selected model does not support image input.")).toBeVisible();

  let opened = false;
  page.on("filechooser", () => { opened = true; });
  await action.click({ force: true });
  await expect(thumbnails(page)).toHaveCount(0);
  expect(opened).toBe(false);
});

test("the action follows composer availability while the menu is already open", async ({ page }) => {
  await openSession(page);
  await openPlusMenu(page);
  await expect(attachAction(page)).toBeEnabled();

  // The trigger is gated on `canPrompt`, so the only way into this state is availability changing
  // under an already-open panel — which is exactly when a stale enabled action does damage.
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));

  const action = attachAction(page);
  await expect(action).toBeDisabled();
  await expect(page.getByText("This session cannot accept a prompt right now.")).toBeVisible();

  let opened = false;
  page.on("filechooser", () => { opened = true; });
  await action.click({ force: true });
  await expect(thumbnails(page)).toHaveCount(0);
  expect(opened).toBe(false);
});

test("a selection made after availability is lost never reaches the composer", async ({ page }) => {
  await openSession(page);
  await openPlusMenu(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), attachAction(page).click()]);

  // The chooser is already up when the runner drops. Disabling the button cannot help here — only
  // the change handler's own gate can, and a re-render has already installed it by now.
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  await expect(page.locator(".composer-input")).toBeDisabled();

  await chooser.setFiles([file("late.png", "image/png")]);
  await expect(thumbnails(page)).toHaveCount(0);
});

test("rejected selections report accessibly and keep the valid ones", async ({ page }) => {
  await openSession(page);
  const composer = page.locator(".composer-input");
  await composer.fill("look at these");

  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
  await pickImages(page, [
    file("good.png", "image/png"),
    file("animated.gif", "image/gif"),
    file("huge.png", "image/png", oversized),
  ]);

  const error = page.getByRole("alert");
  await expect(error).toBeVisible();
  await expect(error).toContainText(/Unsupported image type image\/gif|exceeds the 8 MiB limit/);
  // The valid selection and the typed draft both survive a partly-invalid pick.
  await expect(thumbnails(page)).toHaveCount(1);
  await expect(composer).toHaveValue("look at these");
});

test("the combined-payload ceiling stops the pick without dropping what already fit", async ({ page }) => {
  await openSession(page);
  // 4 x 6 MiB is under the per-image and count limits but base64-expands past the 28 MiB total.
  const chunk = Buffer.alloc(6 * 1024 * 1024);
  await pickImages(page, Array.from({ length: 4 }, (_, i) => file(`bulk-${i}.png`, "image/png", chunk)));

  await expect(page.getByRole("alert")).toContainText("Combined image payload exceeds the 28 MiB limit.");
  const attached = await thumbnails(page).count();
  expect(attached).toBeGreaterThan(0);
  expect(attached).toBeLessThan(4);
});

test("a file the browser cannot read reports instead of attaching silently", async ({ page }) => {
  await page.addInitScript(() => {
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob: Blob) {
      if ((blob as File).name === "corrupt.png") {
        setTimeout(() => this.dispatchEvent(new Event("error")), 0);
        return;
      }
      return read.call(this, blob);
    };
  });
  await openSession(page);
  await pickImages(page, [file("corrupt.png", "image/png"), file("fine.png", "image/png")]);

  await expect(page.getByRole("alert")).toContainText("An image could not be read.");
  // The readable half of the pick still lands.
  await expect(thumbnails(page)).toHaveCount(1);
});

test("the six-image cap holds and the same file can be chosen again after removal", async ({ page }) => {
  await openSession(page);
  await pickImages(page, Array.from({ length: 7 }, (_, i) => file(`shot-${i}.png`, "image/png")));
  await expect(thumbnails(page)).toHaveCount(6);
  await expect(page.getByRole("alert")).toContainText("At most 6 images may be attached.");

  await thumbnails(page).first().click();
  await expect(thumbnails(page)).toHaveCount(5);

  // Re-picking an identical file only fires `change` if the input was cleared after the last pick.
  await pickImages(page, [file("shot-0.png", "image/png")]);
  await expect(thumbnails(page)).toHaveCount(6);
});

test("picked images survive navigation and remount, then send through the prompt path", async ({ page }) => {
  await openSession(page);
  await pickImages(page, [file("evidence.png", "image/png")]);
  await expect(thumbnails(page)).toHaveCount(1);
  await page.locator(".composer-input").fill("what is wrong here?");

  await page.getByRole("button", { name: "Back to Inbox" }).click();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(thumbnails(page)).toHaveCount(1);

  const composer = page.locator(".composer-input");
  await expect(composer).toHaveValue("what is wrong here?");
  await composer.press("Enter");

  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "what is wrong here?",
    images: [{ mimeType: "image/png", data: PNG.toString("base64") }],
  }]);
});

test("drag-and-drop still attaches on platforms that support it", async ({ page }) => {
  await openSession(page);
  await page.locator(".composer-box").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(thumbnails(page)).toHaveCount(1);
});

test("paste still attaches on platforms that support it", async ({ page }) => {
  await openSession(page);
  await page.locator(".composer-input").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(thumbnails(page)).toHaveCount(1);
});

test("a picked image can be removed with the keyboard", async ({ page }) => {
  await openSession(page);
  await pickImages(page, [file("remove-me.png", "image/png")]);
  await expect(thumbnails(page)).toHaveCount(1);

  await thumbnails(page).first().focus();
  await page.keyboard.press("Enter");
  await expect(thumbnails(page)).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({
    viewport: phone.viewport,
    hasTouch: phone.hasTouch,
    isMobile: phone.isMobile,
    userAgent: phone.userAgent,
    deviceScaleFactor: phone.deviceScaleFactor,
    screen: phone.screen,
    reducedMotion: "reduce",
  });

  test("the action is one tap inside the plus menu and meets the touch-target floor", async ({ page }) => {
    await openSession(page);
    await openPlusMenu(page);

    const action = attachAction(page);
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    expect(box, "the action must be laid out to be tappable").not.toBeNull();
    // The app's mobile control-size convention, shared with .menu-item and the detail actions.
    expect(box!.height).toBeGreaterThanOrEqual(44);

    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), action.tap()]);
    await chooser.setFiles([file("from-phone.png", "image/png")]);
    await expect(thumbnails(page)).toHaveCount(1);
    // The preview's remove control is reachable by touch and by keyboard.
    await thumbnails(page).first().tap();
    await expect(thumbnails(page)).toHaveCount(0);
  });
});
