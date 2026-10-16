import { expect, test, type Locator } from "@playwright/test";

test.use({ hasTouch: true });

async function scrollToEnd(card: Locator) {
  // Reading mode changes the dock's height after the question's expanded state commits.
  await expect.poll(() => card.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  })).toBeGreaterThan(0);
}

async function expectHeaderReachable(card: Locator) {
  await expect.poll(() => card.locator(".request-card-head").evaluate((head) => {
    const dock = head.closest(".request-dock")!.getBoundingClientRect();
    const box = head.getBoundingClientRect();
    const controls = [...head.querySelectorAll<HTMLButtonElement>("button")];
    return box.top >= dock.top && box.bottom <= dock.bottom && controls.every((control) => {
      const rect = control.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === control || control.contains(hit);
    });
  }), { message: "the full header and all its controls are clear of the footer" }).toBe(true);
}

for (const viewport of [
  { width: 1280, height: 430 },
  { width: 1280, height: 600 },
  { width: 1440, height: 900 },
]) {
  for (const activation of ["pointer", "touch"] as const) {
    test(`open More Requests keeps header controls usable at ${viewport.width}×${viewport.height} with ${activation} (#2942)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/agent-questions-e2e.html?set=long-text&more=1&after=40");
      await expect(page.getByText("Later reply 20: the agent explains what it did and why.", { exact: true })).toBeInViewport();
      const card = page.locator(".request-dock .question-card");
      const toggle = card.locator(".question-reading-toggle");
      const title = card.locator(".question-text");
      const question = await title.textContent();
      await card.getByRole("radio", { name: /^Hold/ }).check();
      const more = page.locator(".request-dock-more .disclosure-trigger");
      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      if (activation === "pointer") {
        await title.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
        await toggle.evaluate((element) => element.addEventListener("mousedown", (event) => event.preventDefault()));
      }
      if (activation === "touch") await toggle.tap();
      else await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await scrollToEnd(card);
      if (activation === "touch") await toggle.tap();
      else await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expectHeaderReachable(card);
      await expect(more).toHaveAttribute("aria-expanded", "true");
      await expect(card.getByRole("radio", { name: /^Hold/ })).toBeChecked();
      expect(await title.textContent()).toBe(question);
      if (activation === "pointer") await expect(title).toBeFocused();
      // The user can expand again without closing the waiting list or scrolling to recover it.
      if (activation === "touch") await toggle.tap();
      else await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
    });
  }
}

for (const viewport of [{ width: 1280, height: 430 }]) {
  test(`wheel scrolling reaches the footer with More Requests open at ${viewport.width}×${viewport.height} (#2942)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/agent-questions-e2e.html?set=long-text&more=1&after=40");
    const dock = page.locator(".request-dock");
    const card = dock.locator(".question-card");
    await page.locator(".request-dock-more .disclosure-trigger").click();
    await expect(dock).toHaveAttribute("data-more-open", "");
    await expectHeaderReachable(card);
    const box = (await dock.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 15);
    await page.mouse.wheel(0, 700);
    await expect.poll(() => dock.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(card.getByRole("button", { name: "Submit Answers" })).toBeInViewport();
    await page.mouse.wheel(0, -700);
    await expectHeaderReachable(card);
    expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
  });

  test(`keyboard can reach header and footer with More Requests open at ${viewport.width}×${viewport.height} (#2942)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/agent-questions-e2e.html?set=long-text&more=1&after=40");
    const card = page.locator(".request-dock .question-card");
    const more = page.locator(".request-dock-more .disclosure-trigger");
    await more.click();
    const toggle = card.locator(".question-reading-toggle");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await scrollToEnd(card);
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expectHeaderReachable(card);
    await expect(toggle).toBeFocused();
    // Tabbing through the collapsed card scrolls its answers and footer into the dock.
    const submit = card.getByRole("button", { name: "Submit Answers" });
    for (let count = 0; count < 15 && !(await submit.evaluate((element) => element === document.activeElement)); count++) {
      await page.keyboard.press("Tab");
    }
    await expect(submit).toBeFocused();
    await expect(submit).toBeInViewport();
    expect(await submit.evaluate((control) => {
      const box = control.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === control || control.contains(hit);
    })).toBe(true);
    for (let count = 0; count < 15 && !(await toggle.evaluate((element) => element === document.activeElement)); count++) {
      await page.keyboard.press("Shift+Tab");
    }
    await expect(toggle).toBeFocused();
    await expectHeaderReachable(card);
    await expect(more).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
  });
}

for (const viewport of [{ width: 667, height: 375 }, { width: 390, height: 500 }]) {
  for (const keyboardSignal of [false, true]) {
    test(`touch collapse with More Requests preserves the draft at ${viewport.width}×${viewport.height}, keyboard signal ${keyboardSignal} (#2942, #3308)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/agent-questions-e2e.html?set=long-text&more=1&after=40");
      const expand = page.getByRole("button", { name: "Expand Request", exact: true });
      await expand.tap();
      const card = page.locator(".request-dock .question-card");
      const more = page.locator(".request-dock-more .disclosure-trigger");
      await more.tap();
      await card.getByRole("radio", { name: "Something Else…" }).check();
      const field = card.locator(".question-input");
      await field.fill("Preserve the open-list draft");
      if (keyboardSignal) await page.evaluate(() => window.setAgentQuestionKeyboard(true));
      await scrollToEnd(card);
      await card.getByRole("button", { name: "Collapse Question", exact: true }).tap();
      await expect(expand).toBeFocused();
      await expect(card).toBeHidden();
      await expand.tap();
      await expect(field).toHaveValue("Preserve the open-list draft");
      await expect(more).toHaveAttribute("aria-expanded", "true");
      await field.scrollIntoViewIfNeeded();
      await expect(field).toBeInViewport();
      await expect(card.getByRole("button", { name: "Submit Answers" })).toBeInViewport();
      expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
    });
  }
}
