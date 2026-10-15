import { devices, expect, test, type Page } from "@playwright/test";
import { expectTextFits } from "./text-fit";

test.use({ reducedMotion: "reduce" });

async function makeDirty(page: Page) {
  const limit = page.getByRole("spinbutton", { name: "Maximum Concurrent Children" });
  await limit.fill("8");
  await expect(page.locator(".save-bar")).toContainText("Unsaved changes");
}

/** Whether the element is wholly inside the viewport. */
async function inView(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
}

for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
  test(`Orchestrator settings are responsive and keyboard operable at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/settings-rows-e2e.html?theme=dark&section=orchestrator");
    await expect(page.locator("#settings-panel-heading")).toHaveText("Orchestrator");
    for (const group of ["Children", "Execution Permissions", "Decision Delegation"]) {
      await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
    }
    await expect(page.locator(".settings-panel-scope")).toHaveText("Wollipog Defaults");
    await expect(page.getByText("Secrets, sign-in, permission grants, governance changes, budgets and guardrails always stay with you.")).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Maximum Concurrent Children" })).toHaveValue("4");
    await expect(page.getByRole("radiogroup", { name: "Strict Project Isolation" })
      .getByRole("radio", { name: "Off" })).toBeChecked();
    await expect(page.locator(".save-bar")).toHaveCount(0);

    const childHarness = page.getByRole("button", { name: /Child Harness: Automatic/ });
    await childHarness.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox", { name: "Child Harness" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(childHarness).toBeFocused();

    const childModel = page.getByRole("button", { name: /Child Model: Automatic/ });
    await childModel.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox", { name: "Child Model" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(childModel).toBeFocused();

    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(horizontalOverflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`orchestrator-settings-${viewport.width}.png`), fullPage: true });

    await childHarness.click();
    await page.getByRole("option", { name: /Codex App Server · Native/ }).click();
    await page.getByRole("button", { name: /Child Model: Automatic/ }).click();
    await page.getByRole("option", { name: /GPT-5.6 Sol/ }).click();
    await page.getByRole("button", { name: /Child Effort: Automatic/ }).click();
    await page.getByRole("option", { name: /High/ }).click();
    await expect(page.getByRole("button", { name: /Child Harness: Codex App Server · Native/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Child Model: GPT-5.6 Sol/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Child Effort: High/ })).toBeVisible();

    // A draft saves from the bar, which then goes away, and the head says whose defaults these are.
    await page.locator(".save-bar").getByRole("button", { name: "Save Defaults" }).click();
    await expect(page.locator(".save-bar")).toHaveCount(0);
    await expect(page.locator(".settings-panel-scope")).toHaveText("Your Defaults");
  });
}

test("at 1440px the section fits in 1,200px with every disclosure closed, and the save bar stays in view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings-rows-e2e.html?theme=dark&section=orchestrator");
  await expect(page.getByRole("heading", { name: "Decision Delegation", exact: true })).toBeVisible();
  await expect(page.locator("details.disclosure[open]")).toHaveCount(0);
  const height = await page.locator(".settings-panel").evaluate((element) => element.getBoundingClientRect().height);
  expect(height, "the section was about 1,850px before #3026").toBeLessThanOrEqual(1200);

  await makeDirty(page);
  const scroller = page.locator(".main-body");
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  expect(await inView(page, ".save-bar"), "in view at the top of the section").toBe(true);
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await inView(page, ".save-bar"), "in view at the bottom of the section").toBe(true);
  // It floats 16px above the panel's bottom edge, over the content rather than after it.
  const gap = await page.locator(".save-bar").evaluate((element) =>
    window.innerHeight - element.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(15);
});

test.describe("on a phone", () => {
  const phone = devices["Pixel 7"];
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: phone.hasTouch, isMobile: phone.isMobile, userAgent: phone.userAgent });

  test("at 390px the save bar's buttons share its full width and every control is 44px", async ({ page }) => {
    await page.goto("/settings-rows-e2e.html?theme=dark&section=orchestrator");
    await expect(page.getByRole("heading", { name: "Children", exact: true })).toBeVisible();
    await makeDirty(page);
    expect(await inView(page, ".save-bar")).toBe(true);
    const bar = await page.locator(".save-bar").boundingBox();
    const buttons = await page.locator(".save-bar > .btn").evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect()).map(({ left, right, top, height }) => ({ left, right, top, height })));
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.top, "the two buttons share one row under the message").toBeCloseTo(buttons[1]!.top, 0);
    const span = buttons[1]!.right - buttons[0]!.left;
    expect(span, "together they fill the bar's width").toBeGreaterThan((bar?.width ?? 0) - 40);
    for (const button of buttons) expect(button.height).toBeGreaterThanOrEqual(44);

    // A segmented control's target is its track (§10.2), whose pills sit inset inside it.
    const small = await page.locator(".settings-panel").evaluate((panel) =>
      [...panel.querySelectorAll<HTMLElement>("button:not([role='radio']), input, summary, a, .seg")]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({ name: element.getAttribute("aria-label") ?? element.textContent?.trim(), height: element.getBoundingClientRect().height }))
        .filter((control) => control.height < 44));
    expect(small, "every control clears the 44px touch target").toEqual([]);
  });
});

test("an invalid number blocks Save with a count, and a failed save keeps the draft with Try Again", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings-rows-e2e.html?theme=dark&section=orchestrator&orchestrator=save-fails");
  const limit = page.getByRole("spinbutton", { name: "Maximum Concurrent Children" });
  const save = page.locator(".save-bar").getByRole("button", { name: "Save Defaults" });
  const fill = (locator: typeof save) => locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  // The primary's own fill while Save can save, and the unavailable fill it must take instead.
  await limit.fill("7");
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
  const saveable = await fill(save);
  const unavailable = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--bg-elev-2)";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  expect(unavailable).not.toBe(saveable);

  await limit.fill("65");
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter a whole number from 0 to 64.")).toBeVisible();
  await expect(page.locator(".save-bar-message")).toHaveText("Fix 1 setting to save");
  // With focus still in the invalid field, at desktop width, Save is refused and drawn as refused.
  await expect(limit).toBeFocused();
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect.poll(() => fill(save), { message: "Save is painted unavailable, not as the primary" }).toBe(unavailable);
  // Playwright will not click an aria-disabled button, so the press is dispatched: it must not save.
  await save.dispatchEvent("click");
  await expect(page.locator(".save-bar-message")).toHaveText("Fix 1 setting to save");
  await expect(page.locator(".save-bar.is-error")).toHaveCount(0);

  await limit.fill("12");
  await page.getByRole("button", { name: "Save Defaults" }).click();
  await expect(page.locator(".save-bar.is-error")).toContainText("Wollipog couldn't store your defaults.");
  await expect(page.getByRole("button", { name: "Try Again" })).toBeVisible();
  await expect(limit).toHaveValue("12");
});

test("with no machine reporting models and efforts, the warning leads Children", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings-rows-e2e.html?theme=light&section=orchestrator&orchestrator=unavailable");
  const notice = page.locator(".settings-group-head + .notice.t-warning");
  await expect(notice).toContainText("No connected machine reports which models and efforts child agents can use.");
  await expect(notice.getByRole("link", { name: "Open Connections" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Child Model:/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: /^Child Effort:/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".form-error")).toHaveCount(0);
});

test("Orchestrator settings retain a retired model and mark it at Child Model", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/settings-rows-e2e.html?theme=light&section=orchestrator&defaults=agent-repair");
  const model = page.getByRole("button", { name: /Child Model: retired-model \(Unavailable\)/i });
  await expect(model).toBeVisible();
  await expect(model).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Choose another model.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("orchestrator-settings-drift.png"), fullPage: true });
});

test("leaving with unsaved changes asks first, and Keep Editing keeps the draft", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings-rows-e2e.html?theme=dark&section=orchestrator");
  await makeDirty(page);
  await page.locator(".settings-nav").getByRole("link", { name: "Appearance" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard Changes" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep Editing" })).toBeFocused();
  await dialog.getByRole("button", { name: "Keep Editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#settings-panel-heading")).toHaveText("Orchestrator");
  await expect(page.getByRole("spinbutton", { name: "Maximum Concurrent Children" })).toHaveValue("8");

  await page.locator(".settings-nav").getByRole("link", { name: "Appearance" }).click();
  await page.getByRole("dialog", { name: "Discard Changes" }).getByRole("button", { name: "Discard Changes" }).click();
  await expect(page.locator("#settings-panel-heading")).toHaveText("Appearance");
});

test("browser Back and Forward with unsaved changes ask first, and Keep Editing loses no entry (#3218)", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings-rows-e2e.html?theme=dark&route=/settings/appearance");
  const nav = page.locator(".settings-nav");
  const heading = page.locator("#settings-panel-heading");
  const limit = page.getByRole("spinbutton", { name: "Maximum Concurrent Children" });
  const dialog = page.getByRole("dialog", { name: "Discard Changes" });
  const route = () => new URL(page.url()).searchParams.get("route");
  const entries = () => page.evaluate(() => window.history.length);
  // Same-document moves: wait for the address, not for a load that never comes.
  const back = () => page.goBack({ waitUntil: "commit" });
  const forward = () => page.goForward({ waitUntil: "commit" });

  // Appearance, Orchestrator, Behavior; then Back to Orchestrator, so it has an entry on each side.
  await nav.getByRole("link", { name: "Orchestrator" }).click();
  await expect(heading).toHaveText("Orchestrator");
  await nav.getByRole("link", { name: "Behavior" }).click();
  await expect(heading).toHaveText("Behavior");
  await back();
  await expect(heading).toHaveText("Orchestrator", { timeout: 5_000 });
  await expect(limit).toHaveValue("4");
  const length = await entries();
  await makeDirty(page);

  for (const [direction, move] of [["back", back], ["forward", forward]] as const) {
    await move();
    await expect(dialog, `${direction} asks first`).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Keep Editing" })).toBeFocused();
    await expect.poll(route, { message: "the editor's entry is current while it asks" }).toBe("/settings/orchestrator");
    await page.screenshot({ path: testInfo.outputPath(`orchestrator-${direction}-asks.png`) });
    await dialog.getByRole("button", { name: "Keep Editing" }).click();
    await expect(dialog).toBeHidden();
    await expect(heading).toHaveText("Orchestrator");
    await expect(limit, "the draft is kept").toHaveValue("8");
    expect(route()).toBe("/settings/orchestrator");
    expect(await entries(), "no entry is added or dropped").toBe(length);
  }

  // Discard Changes completes Back, exactly once.
  await back();
  await dialog.getByRole("button", { name: "Discard Changes" }).click();
  await expect(heading).toHaveText("Appearance");
  await expect.poll(route).toBe("/settings/appearance");
  // Every forward entry is still there: Orchestrator with its saved defaults, then Behavior.
  await forward();
  await expect(heading).toHaveText("Orchestrator");
  await expect(limit).toHaveValue("4");
  await forward();
  await expect(heading).toHaveText("Behavior");
  expect(await entries()).toBe(length);

  // Discard Changes completes Forward, exactly once: one Back from Behavior reaches the editor again.
  await back();
  await expect(heading).toHaveText("Orchestrator");
  await makeDirty(page);
  await forward();
  await dialog.getByRole("button", { name: "Discard Changes" }).click();
  await expect(heading).toHaveText("Behavior");
  await back();
  await expect(heading).toHaveText("Orchestrator");
  await expect(limit).toHaveValue("4");
  await expect(dialog).toBeHidden();
});

// #2413: as three equal pills in the panel's 260px value column, "Questions and Approvals" drew over
// its neighbour at every width. Each option is measured in the listbox and, once chosen, in the trigger.
for (const theme of ["dark", "light"]) {
  for (const width of [390, 1100, 1440]) {
    test(`every Descendant Requests option fits its own box at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/settings-rows-e2e.html?theme=${theme}&section=orchestrator`);
      await expect(page.getByRole("heading", { name: "Decision Delegation", exact: true })).toBeVisible();
      const trigger = page.getByRole("button", { name: /^Descendant Requests:/ });
      for (const label of ["Human", "Questions", "Questions and Approvals"]) {
        await trigger.click();
        const listbox = page.getByRole("listbox", { name: "Descendant Requests" });
        await expect(listbox).toBeVisible();
        const options = listbox.getByRole("option");
        await expect(options).toHaveCount(3);
        for (const option of await options.all()) {
          await expectTextFits(option, `${await option.getAttribute("aria-labelledby")} at ${width}px in ${theme}`);
        }
        await listbox.getByRole("option", { name: label, exact: true }).click();
        await expect(listbox).toBeHidden();
        await expect(trigger).toHaveAccessibleName(`Descendant Requests: ${label}`);
        await expect(trigger.locator(".ui-select-value")).toHaveText(label);
        await expectTextFits(trigger, `the ${label} trigger at ${width}px in ${theme}`);
      }
    });
  }
}
