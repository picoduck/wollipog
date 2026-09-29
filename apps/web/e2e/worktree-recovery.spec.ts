import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The Worktree Missing notice (#1976) in the recovery-notice harness: a real SessionDetail whose
 * session lost its worktree, with a retained Not Sent prompt. Evidence captures are a separate
 * local script; these tests measure and drive the notice at normal speed.
 */

async function openRecovery(page: Page, width: number, height: number, extra = "") {
  await page.setViewportSize({ width, height });
  await page.goto(`/recovery-notice-e2e.html?mode=expanded&height=${height - 40}&width=${width}&worktree-recovery=1&settled=1${extra}`);
  const notice = page.getByRole("region", { name: "Worktree Missing" });
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("pending-prompt-prompt-worktree-recovery")
    .getByText("Not Sent", { exact: true })).toBeVisible();
  return notice;
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

async function noHorizontalOverflow(page: Page, width: number) {
  expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(width);
}

const SENTENCE = /^The worktree for fix\/missing-worktree is gone, so messages marked Not Sent wait until this session has a worktree\.$/u;

for (const pointer of ["fine", "coarse"] as const) {
  const control = pointer === "fine" ? 32 : 44;
  test.describe(`at 1440px with a ${pointer} pointer`, () => {
    test.use({ hasTouch: pointer === "coarse" });

    test(`both paths put ${control}px fields and an unstretched button in one row`, async ({ page }) => {
      const notice = await openRecovery(page, 1440, 900);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(pointer === "coarse");
      await expect(notice.locator(".notice-body > p").first()).toHaveText(SENTENCE);
      await expect(notice.locator("legend")).toHaveCount(0);

      const create = notice.getByRole("button", { name: "Create Replacement" });
      const baseRef = notice.getByLabel("Base Ref");
      const branch = notice.getByLabel("Branch");
      const fields = [await box(baseRef), await box(branch)];
      const button = await box(create);
      for (const bounds of [...fields, button]) expect(bounds.height).toBe(control);
      // Aligned to the field bottoms, in one row, and sized to its label rather than stretched.
      for (const bounds of fields) expect(bounds.y + bounds.height).toBe(button.y + button.height);
      expect(button.x).toBeGreaterThan(fields[1]!.x + fields[1]!.width);
      expect(button.width).toBeLessThan(fields[0]!.width);
      await expect(notice.getByRole("radiogroup", { name: "Recovery Method" })).toHaveCSS("height", `${control}px`);

      await notice.getByRole("radio", { name: "Use Existing" }).click();
      const picker = notice.getByRole("button", { name: /^Worktree: / });
      const use = notice.getByRole("button", { name: "Use Worktree" });
      const pickerBox = await box(picker);
      const useBox = await box(use);
      expect(pickerBox.height).toBe(control);
      expect(useBox.height).toBe(control);
      expect(pickerBox.y + pickerBox.height).toBe(useBox.y + useBox.height);
      // The picker spans both field columns: full field width, not one of two.
      expect(pickerBox.width).toBeGreaterThan(fields[0]!.width + fields[1]!.width);
      expect(useBox.width).toBeLessThan(pickerBox.width / 2);
      // Every control is in the UI font.
      const uiFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      for (const locator of [picker, use]) {
        expect(await locator.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(uiFont);
      }
      await notice.getByRole("radio", { name: "Create New" }).click();
      expect(await baseRef.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(uiFont);
    });
  });
}

test("desktop Use Existing switches the session to the chosen worktree and enables Retry", async ({ page }) => {
  const notice = await openRecovery(page, 1440, 900);
  const retry = page.getByRole("button", { name: "Retry Message" });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAccessibleDescription(/Recover the selected worktree before retrying this message\./u);
  await expect(notice.getByRole("button", { name: "Create Replacement" })).toHaveAccessibleDescription(SENTENCE);
  await expect(page.locator(".composer-input")).toBeDisabled();

  // Typed values survive a switch to the other path and back, and a session broadcast.
  await notice.getByLabel("Branch").fill("fix/my-restored-work");
  await notice.getByLabel("Base Ref").fill("origin/release");
  await notice.getByRole("radio", { name: "Use Existing" }).click();
  await page.evaluate(() => {
    (window as typeof window & { emitWorktreeRecoveryUpdate?: () => void }).emitWorktreeRecoveryUpdate?.();
  });
  await notice.getByRole("radio", { name: "Create New" }).click();
  await expect(notice.getByLabel("Branch")).toHaveValue("fix/my-restored-work");
  await expect(notice.getByLabel("Base Ref")).toHaveValue("origin/release");

  await notice.getByRole("radio", { name: "Use Existing" }).click();
  await notice.getByRole("button", { name: "Worktree: fix/recovered-worktree" }).click();
  await page.getByRole("option", { name: "fix/recovered-worktree" }).click();
  await notice.getByRole("button", { name: "Use Worktree" }).click();
  await expect(notice).toHaveCount(0);
  await expect(retry).toBeEnabled();
  await expect(page.locator(".composer-input")).toBeEnabled();
});

test("the worktree list opens above the notice when the space below is shorter than the list", async ({ page }) => {
  const notice = await openRecovery(page, 1440, 900, "&extra-worktrees=8");
  await notice.getByRole("radio", { name: "Use Existing" }).click();
  const trigger = notice.getByRole("button", { name: /^Worktree: / });
  await trigger.click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  const triggerBox = await box(trigger);
  const listBox = await box(list);
  const spaceBelow = 900 - (triggerBox.y + triggerBox.height);
  expect(spaceBelow, "the notice sits at the bottom, over the composer").toBeLessThan(listBox.height);
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(triggerBox.y);
});

const phaseMs = 1500;

test("desktop replacement creation shows an accent meter with its phase and step, and survives a reload", async ({ page }) => {
  const notice = await openRecovery(page, 1440, 900, `&create-progress=complete&phase-ms=${phaseMs}&setup-step=1`);
  const progress = notice.getByRole("status", { name: "Replacement Worktree Progress" });
  const create = notice.getByRole("button", { name: "Create Replacement" });
  const width = (await box(create)).width;
  await create.click();
  await expect(create).toHaveAttribute("aria-busy", "true");
  await expect(create).toHaveText("Create Replacement");
  expect((await box(create)).width, "the busy button keeps its width").toBeCloseTo(width, 0);
  await expect(progress).toHaveText("Fetching Remote, Step 1 of 4");
  const meter = progress.getByRole("progressbar");
  await expect(meter).toHaveAttribute("aria-valuenow", "1");
  const fill = await meter.locator("span").evaluate((element) => getComputedStyle(element).backgroundColor);
  const accent = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(fill).toBe(accent);
  await expect(progress).toHaveText("Creating Worktree, Step 2 of 4");

  await page.reload();
  await expect(notice).toBeVisible();
  await expect(progress).toHaveText(/Creating Worktree, Step 2 of 4|Running Setup \(pnpm install\), Step 3 of 4/u);
  await expect(create).toHaveAttribute("aria-disabled", "true");
  await expect(progress).toHaveText("Running Setup (pnpm install), Step 3 of 4");
  await expect(progress.locator("code")).toHaveText("pnpm install");

  await expect(notice).toHaveCount(0, { timeout: phaseMs * 4 });
  await expect(page.getByRole("button", { name: "Retry Message" })).toBeEnabled();
});

test("a failed create names the phase, keeps the output behind Show Output, and offers Try Again", async ({ page }) => {
  const notice = await openRecovery(page, 1440, 900, `&create-progress=fail&phase-ms=${phaseMs}`);
  await notice.getByRole("button", { name: "Create Replacement" }).click();
  const failure = notice.getByRole("alert");
  await expect(failure).toHaveText("Creating the worktree stopped at step 3, Running Setup.", { timeout: phaseMs * 5 });
  await expect(notice).not.toContainText("exited with code 1");
  await notice.getByRole("button", { name: "Show Output" }).click();
  await expect(notice.locator(".worktree-missing-output")).toHaveText("Setup step \"pnpm install\" exited with code 1.");
  const retry = notice.getByRole("button", { name: "Try Again" });
  await expect(retry).toBeEnabled();
  await expect(retry).toHaveAccessibleDescription(/Creating the worktree stopped at step 3, Running Setup\./u);
  await expect(page.getByTestId("pending-prompt-prompt-worktree-recovery")
    .getByText("Not Sent", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Message" })).toBeDisabled();
});

test("offline, the reason names the machine and describes both actions", async ({ page }) => {
  const notice = await openRecovery(page, 1440, 900, "&offline=1&machine=Build%20Box");
  const reason = "Build Box is offline, so the worktree can't be recovered until it reconnects.";
  await expect(notice.getByText(reason)).toBeVisible();
  const create = notice.getByRole("button", { name: "Create Replacement" });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription(new RegExp(`${reason.replace(/\./gu, "\\.")}$`, "u"));
  await notice.getByRole("radio", { name: "Use Existing" }).click();
  const use = notice.getByRole("button", { name: "Use Worktree" });
  await expect(use).toBeDisabled();
  await expect(use).toHaveAccessibleDescription(new RegExp(`${reason.replace(/\./gu, "\\.")}$`, "u"));
});

test.describe("on a 390px phone", () => {
  test("the notice is at most 180px with one Recover Worktree… button, and Use Existing completes from the sheet", async ({ page }) => {
    const notice = await openRecovery(page, 390, 844);
    expect((await box(notice)).height).toBeLessThanOrEqual(180);
    await expect(notice.locator("input, [role=radiogroup]")).toHaveCount(0);
    const recover = notice.getByRole("button", { name: "Recover Worktree…" });
    await expect(notice.locator(".notice-actions .btn.primary")).toHaveCount(1);
    await noHorizontalOverflow(page, 390);

    await recover.click();
    const sheet = page.getByRole("dialog", { name: "Recover Worktree" });
    await expect(sheet).toBeVisible();
    // A bottom sheet: full width and docked to the bottom once it has slid in.
    await expect.poll(async () => {
      const bounds = await box(sheet);
      return [bounds.x, bounds.width, Math.round(bounds.y + bounds.height)];
    }).toEqual([0, 390, 844]);
    await expect(sheet.getByLabel("Branch")).toHaveCSS("height", "44px");
    const cancel = sheet.getByRole("button", { name: "Cancel" });
    const primary = sheet.getByRole("button", { name: "Create Replacement" });
    const [cancelBox, primaryBox] = [await box(cancel), await box(primary)];
    expect(cancelBox.height).toBe(48);
    expect(primaryBox.height).toBe(48);
    expect(Math.abs(cancelBox.width - primaryBox.width)).toBeLessThanOrEqual(1);

    await sheet.getByRole("radio", { name: "Use Existing" }).click();
    const list = sheet.getByRole("radiogroup", { name: "Worktree" });
    await expect(list).toHaveClass(/choice-list/u);
    const rows = list.locator(".choice-row");
    await expect(rows).toHaveCount(2);
    const listBox = await box(list);
    for (const row of await rows.all()) {
      const rowBox = await box(row);
      expect(rowBox.height).toBe(44);
      expect(rowBox.width).toBe(listBox.width);
    }
    await list.getByRole("radio", { name: "fix/recovered-worktree" }).check();
    await sheet.getByRole("button", { name: "Use Worktree" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry Message" })).toBeEnabled();
  });

  test("Create New completes from the sheet and clears the notice", async ({ page }) => {
    const notice = await openRecovery(page, 390, 844);
    await notice.getByRole("button", { name: "Recover Worktree…" }).click();
    const sheet = page.getByRole("dialog", { name: "Recover Worktree" });
    await sheet.getByLabel("Branch").fill("fix/phone-replacement");
    await sheet.getByRole("button", { name: "Create Replacement" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(notice).toHaveCount(0);
  });

  test("creation progress shows in the notice without overflow, and a failure reads Try Again…", async ({ page }) => {
    const notice = await openRecovery(page, 390, 844, `&create-progress=fail&phase-ms=${phaseMs}`);
    await notice.getByRole("button", { name: "Recover Worktree…" }).click();
    const sheet = page.getByRole("dialog", { name: "Recover Worktree" });
    await sheet.getByRole("button", { name: "Create Replacement" }).click();
    const progress = sheet.getByRole("status", { name: "Replacement Worktree Progress" });
    await expect(progress).toHaveText("Fetching Remote, Step 1 of 4");
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(notice.getByRole("status", { name: "Replacement Worktree Progress" })).toBeVisible();
    await noHorizontalOverflow(page, 390);
    await expect(notice.getByRole("button", { name: "Try Again…" })).toBeVisible({ timeout: phaseMs * 5 });
    await expect(notice).toContainText("Creating the worktree stopped at step 3, Running Setup.");
    await expect(notice.getByRole("button", { name: "Show Output" })).toHaveCount(0);
  });
});

test.describe("on a 390px touch phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the notice stays at most 180px with a 44px Recover Worktree… button that fills its row", async ({ page }) => {
    const notice = await openRecovery(page, 390, 844);
    expect((await box(notice)).height).toBeLessThanOrEqual(180);
    const recover = await box(notice.getByRole("button", { name: "Recover Worktree…" }));
    const details = await box(notice.getByRole("button", { name: "Show Details" }));
    const actions = await box(notice.locator(".notice-actions"));
    expect(recover.height).toBe(44);
    expect(recover.x).toBe(actions.x);
    expect(recover.width).toBeGreaterThan(actions.width - details.width - 16);
    await noHorizontalOverflow(page, 390);
  });
});
