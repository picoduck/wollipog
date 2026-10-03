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

const attachAction = (page: Page) => page.getByRole("menuitem", { name: "Attach Image…", exact: true });

async function openPlusMenu(page: Page) {
  await page.getByRole("button", { name: "Attach and Settings" }).click();
  await expect(page.getByRole("menu", { name: "Attach and Settings" })).toBeVisible();
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
  await expect(action).toHaveAccessibleName("Attach Image…");

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
  await expect(page.locator('.composer .notice.t-danger[role="alert"]')).toHaveCount(0);
});

test("a text-only model explains itself instead of opening a picker", async ({ page }) => {
  await openSession(page, false);
  await openPlusMenu(page);

  const action = attachAction(page);
  await expect(action).toBeDisabled();
  await expect(page.getByText(/^.+ can't read images\. Choose another model in Model Settings to attach them\.$/))
    .toBeVisible();

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

  // Availability changing under an already-open panel is exactly when a stale enabled action does
  // damage. The row says why in the composer's own words.
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));

  const action = attachAction(page);
  await expect(action).toBeDisabled();
  const reason = await page.locator(".composer-input").getAttribute("placeholder");
  expect(reason).toBeTruthy();
  await expect(action).toHaveAccessibleDescription(reason!);

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
  // One notice for the pick, the first thing that kept a file out, in words rather than MIME types.
  await expect(error).toHaveAccessibleName("Image Not Supported");
  await expect(error.locator(".notice-body")).toHaveText("GIF images aren't supported. Attach a PNG, JPEG or WebP image.");
  // The valid selection and the typed draft both survive a partly-invalid pick.
  await expect(thumbnails(page)).toHaveCount(1);
  await expect(composer).toHaveValue("look at these");
});

test("the combined-payload ceiling stops the pick without dropping what already fit", async ({ page }) => {
  await openSession(page);
  // 4 x 6 MiB is under the per-image and count limits but base64-expands past the 28 MiB total.
  const chunk = Buffer.alloc(6 * 1024 * 1024);
  await pickImages(page, Array.from({ length: 4 }, (_, i) => file(`bulk-${i}.png`, "image/png", chunk)));

  await expect(page.getByRole("alert")).toContainText("These images are too large to send together. Remove one to add another.");
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

  await expect(page.getByRole("alert")).toContainText("“corrupt.png” couldn't be read. Try saving it as PNG or JPEG.");
  // The readable half of the pick still lands.
  await expect(thumbnails(page)).toHaveCount(1);
});

test("the six-image cap holds and the same file can be chosen again after removal", async ({ page }) => {
  await openSession(page);
  await pickImages(page, Array.from({ length: 7 }, (_, i) => file(`shot-${i}.png`, "image/png")));
  await expect(thumbnails(page)).toHaveCount(6);
  await expect(page.getByRole("alert")).toContainText("You can attach up to 6 images. Remove one to add another.");

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

  await page.getByRole("button", { name: "Back to Sessions" }).click();
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

/** Start dragging two PNGs over the card, as a desktop drag from the file manager does. */
async function dragTwoImagesOver(page: Page) {
  await page.locator(".composer-box").evaluate((element) => {
    const transfer = new DataTransfer();
    for (const name of ["one.png", "two.png"]) {
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" }));
    }
    (window as unknown as { __dragTransfer: DataTransfer }).__dragTransfer = transfer;
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
}

async function dropDraggedImages(page: Page) {
  await page.locator(".composer-box").evaluate((element) => {
    const transfer = (window as unknown as { __dragTransfer: DataTransfer }).__dragTransfer;
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
}

test("dragging files keeps the draft and its attachments in view and only the bar says what a drop does (#2156)", async ({ page }) => {
  await openSession(page);
  const composer = page.locator(".composer-input");
  await composer.fill("compare these");
  await pickImages(page, [file("before.png", "image/png")]);
  await expect(thumbnails(page)).toHaveCount(1);

  await dragTwoImagesOver(page);
  const card = page.locator(".composer-box");
  await expect(card).toHaveClass(/\bis-drop\b/);
  await expect(card).not.toHaveClass(/\bis-refused\b/);
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue("compare these");
  await expect(thumbnails(page)).toHaveCount(1);
  await expect(page.locator(".composer-drop-label")).toHaveText("Drop to attach 2 images");
  await expect(page.locator(".cbar-left")).toBeHidden();
  expect(await card.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("dashed");
  await expect(page.locator(".composer-dropzone")).toHaveCount(0);

  await dropDraggedImages(page);
  await expect(card).not.toHaveClass(/\bis-drop\b/);
  await expect(thumbnails(page)).toHaveCount(3);
  await expect(composer).toHaveValue("compare these");
});

test("a model that can't read images refuses the drop in the bar and attaches nothing (#2156)", async ({ page }) => {
  await openSession(page, false);
  await page.locator(".composer-input").fill("keep this");
  await dragTwoImagesOver(page);
  const card = page.locator(".composer-box");
  await expect(card).toHaveClass(/\bis-refused\b/);
  const sentence = /^.+ can't read images\. Choose another model in Model Settings to attach them\.$/;
  await expect(page.locator(".composer-drop-label")).toHaveText(sentence);
  await expect(page.locator(".composer-drop-label svg")).toBeVisible();
  const dropSentence = await page.locator(".composer-drop-label").textContent();

  await dropDraggedImages(page);
  await expect(thumbnails(page)).toHaveCount(0);
  await expect(page.locator(".composer-input")).toHaveValue("keep this");
  // The same sentence in the notice, the drop target and the + menu row.
  const dropped = page.locator(".session-notice-slot").getByRole("alert", { name: "Images Not Supported" });
  await expect(dropped.locator(".notice-body")).toHaveText(dropSentence!);
  await openPlusMenu(page);
  await expect(page.getByRole("menu", { name: "Attach and Settings" })
    .getByText(dropSentence!, { exact: true })).toBeVisible();
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

test("the Attach and Settings icon stays centered independently of font metrics", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSession(page);
  const trigger = page.getByRole("button", { name: "Attach and Settings" });

  const expectCentered = async (state: string) => {
    const geometry = await trigger.evaluate((element) => {
      const button = element.getBoundingClientRect();
      const icon = element.querySelector("svg")?.getBoundingClientRect();
      if (!icon) throw new Error("Attach and Settings must render a font-independent SVG icon");
      return {
        button: { width: button.width, height: button.height },
        icon: { width: icon.width, height: icon.height },
        centerDeltaX: Math.abs((button.left + button.width / 2) - (icon.left + icon.width / 2)),
        centerDeltaY: Math.abs((button.top + button.height / 2) - (icon.top + icon.height / 2)),
        text: element.textContent?.trim() ?? "",
      };
    });
    // The composer bar recipe (#2174): a --composer-ctl square, 32px under a mouse.
    expect(geometry.button, `${state}: keep the square trigger geometry`).toEqual({ width: 32, height: 32 });
    expect(geometry.icon, `${state}: preserve the shared icon geometry`).toEqual({ width: 16, height: 16 });
    expect(geometry.text, `${state}: do not fall back to a font glyph`).toBe("");
    expect(geometry.centerDeltaX, `${state}: horizontal center`).toBeLessThanOrEqual(0.5);
    expect(geometry.centerDeltaY, `${state}: vertical center`).toBeLessThanOrEqual(0.5);
  };

  for (const viewport of [
    { name: "desktop", width: 1280 },
    { name: "phone", width: 390 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: 800 });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        document.documentElement.style.colorScheme = value;
      }, theme);
      await expectCentered(`${viewport.name} ${theme} normal`);
      await trigger.hover();
      await expectCentered(`${viewport.name} ${theme} hover`);
      await trigger.focus();
      await expectCentered(`${viewport.name} ${theme} focus-visible`);
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expectCentered(`${viewport.name} ${theme} open`);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
  }

  // A paused composer keeps + openable, so Guardrails can still be read and changed (#2175).
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  await expect(page.locator(".composer-input")).toBeDisabled();
  await expect(trigger).toBeEnabled();
  await expectCentered("paused");
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
