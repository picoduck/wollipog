import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ hasTouch: true });

const transcriptPosition = (page: Page) => page.locator(".detail-scroll").evaluate((reader) => {
  const box = reader.getBoundingClientRect();
  const rows = [...reader.querySelectorAll<HTMLElement>("[data-virtual-row]")];
  const state = reader.getAttribute("data-follow-tail-state");
  const row = state === "following"
    ? rows.findLast((item) => item.getBoundingClientRect().top < box.bottom - 1)
    : rows.find((item) => item.getBoundingClientRect().bottom > box.top + 1);
  return { state, row: row?.getAttribute("data-virtual-key"),
    offset: state === "following" ? null : Math.round((row?.getBoundingClientRect().top ?? box.top) - box.top) };
});

async function expectHeaderVisible(card: Locator) {
  await expect.poll(() => card.locator(".request-card-head").evaluate((head) => {
    const cardBox = head.closest(".question-card")!.getBoundingClientRect();
    const box = head.getBoundingClientRect();
    const toggle = head.querySelector(".question-reading-toggle")!;
    const control = toggle.getBoundingClientRect();
    const hit = document.elementFromPoint(control.left + control.width / 2, control.top + control.height / 2);
    return box.top >= cardBox.top - 0.5 && box.bottom <= cardBox.bottom + 0.5 &&
      (hit === toggle || toggle.contains(hit));
  }), { message: "the entire collapsed header stays visible and its toggle is clickable" }).toBe(true);
}

for (const viewport of [{ width: 1280, height: 600 }, { width: 1280, height: 430 }]) {
  for (const activation of ["focused click", "nonfocusing click", "touch"] as const) {
    test(`header collapse after scrolling preserves the answer and transcript at ${viewport.width}×${viewport.height} with ${activation} (#2928)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/agent-questions-e2e.html?set=long-text&more=1&after=40");
      const card = page.locator(".request-dock .question-card");
      const toggle = card.locator(".question-reading-toggle");
      const title = card.locator(".question-text");
      const question = await title.textContent();
      await card.getByRole("radio", { name: /^Hold/ }).check();
      await title.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
      // The synthetic after=40 history hydrates after the first question render. Wait for its tail
      // before comparing reading positions, including on slower browser engines.
      await expect(page.getByText("Later reply 20: the agent explains what it did and why.", { exact: true })).toBeInViewport();
      const before = await transcriptPosition(page);
      if (activation === "nonfocusing click") {
        // Exercise the browser branch that clicks a button without giving it focus.
        await toggle.evaluate((element) => element.addEventListener("mousedown", (event) => event.preventDefault()));
      }
      if (activation === "focused click") await toggle.focus();
      if (activation === "touch") await toggle.tap();
      else await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      // The dock enters reading mode after the question toggles; wait for its scrollable layout.
      await expect.poll(() => card.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      })).toBeGreaterThan(0);
      if (activation === "touch") await toggle.tap();
      else await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expectHeaderVisible(card);
      if (activation === "nonfocusing click") await expect(title).toBeFocused();
      if (activation === "focused click") await expect(toggle).toBeFocused();
      await expect(card.getByRole("radio", { name: /^Hold/ })).toBeChecked();
      expect(await title.textContent()).toBe(question);
      await expect(page.locator(".detail-main")).toHaveCSS("visibility", "visible");
      await expect.poll(() => transcriptPosition(page)).toEqual(before);
      expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
    });
  }
}

test("nonfocusing header collapse also reveals the header after inline expansion (#2928)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 430 });
  await page.goto("/agent-questions-e2e.html?set=long-text&more=1&after=40");
  const card = page.locator(".request-dock .question-card");
  await card.getByRole("button", { name: "Show Full Question" }).click();
  const toggle = card.locator(".question-reading-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const title = card.locator(".question-text");
  await title.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
  await toggle.evaluate((element) => element.addEventListener("mousedown", (event) => event.preventDefault()));
  await card.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expectHeaderVisible(card);
  await expect(title).toBeFocused();
});

test("touch header collapse returns a focused draft to the mobile strip (#2928, #3308)", async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto("/agent-questions-e2e.html?set=long-text&more=1&after=40");
  const expand = page.getByRole("button", { name: "Expand Request", exact: true });
  await expand.tap();
  const card = page.locator(".request-dock .question-card");
  await card.getByRole("radio", { name: "Something Else…" }).check();
  const field = card.locator(".question-input");
  await field.fill("Keep this answer draft");
  await card.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await card.getByRole("button", { name: "Collapse Question", exact: true }).tap();
  await expect(expand).toBeVisible();
  await expect(expand).toBeFocused();
  await expect(card).toBeHidden();
  await expand.tap();
  await expect(field).toHaveValue("Keep this answer draft");
  await expect(card.getByRole("button", { name: "Collapse Question", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
});
