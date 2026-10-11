import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForSessionPreview } from "./session-readiness.js";

/**
 * Side Chat (#2863; docs/design-system.md §4.9): a 40px context line with a Title Case badge, the
 * main composer's card with Send inset at its trailing edge on the input's line however tall the
 * input grows, and on a phone, only Side Chat's composer on screen while its field has focus.
 */
async function openSideChat(page: Page, width: number, height: number, state = "conversation") {
  await page.setViewportSize({ width, height });
  await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&machineName=Studio%20Workstation&sideChat=${state}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const open = page.getByRole("button", { name: "Open Session", exact: true });
  await waitForSessionPreview(page);
  if (await open.isVisible()) await open.click();
  await expect(page.locator(".composer-input")).toBeAttached();
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  await panel(page).locator(".rpanel-switcher").click();
  await page.getByRole("menuitemradio", { name: "Side Chat" }).click();
  await expect(panel(page).locator(".sc-panel, .state").first()).toBeVisible();
}

const panel = (page: Page) => page.locator("#right-panel");

async function box(locator: Locator) {
  const measured = await locator.boundingBox();
  expect(measured).not.toBeNull();
  return measured!;
}

/** Send inside the card, beside the field: inside its edges, level with the field's last line. */
async function expectSendInCard(page: Page, size: number) {
  const card = await box(panel(page).locator(".sc-composer"));
  const field = await box(panel(page).locator(".sc-composer textarea"));
  const send = await box(panel(page).getByRole("button", { name: "Send", exact: true }));
  expect(send.width).toBe(size);
  expect(send.height).toBe(size);
  expect(send.x).toBeGreaterThan(field.x + field.width - 1);
  expect(send.x + send.width).toBeLessThanOrEqual(card.x + card.width);
  expect(send.y).toBeGreaterThanOrEqual(card.y);
  expect(send.y + send.height).toBeLessThanOrEqual(card.y + card.height);
  // On the same line: Send's band and the field's bottom line overlap.
  expect(send.y).toBeLessThan(field.y + field.height);
  expect(send.y + send.height).toBeGreaterThan(field.y + field.height - 22);
}

test.describe("with a mouse", () => {
  test("at 1440px the context line is one 40px row with a Title Case badge, and Send sits in the card (#2863)", async ({ page }) => {
    await openSideChat(page, 1440, 900);
    const context = panel(page).locator(".sc-context");
    expect((await box(context)).height).toBe(40);
    await expect(context.locator(".status")).toHaveText("Awaiting Prompt");
    await expect(context).toContainText("Separate Worktree");
    await expect(context.getByRole("link", { name: "Open Session" })).toBeVisible();
    await expectSendInCard(page, 32);
    // The textarea has no resize grip.
    expect(await panel(page).locator(".sc-composer textarea").evaluate((element) => getComputedStyle(element).resize)).toBe("none");
  });

  test("while the side chat replies Stop Turn holds Send's seat, and an ended chat has one sentence and one button (#2863)", async ({ page }) => {
    await openSideChat(page, 1440, 900, "replying");
    await expect(panel(page).locator(".sc-context .status")).toHaveText("Running");
    await expect(panel(page).getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    await panel(page).getByRole("button", { name: "Stop Turn" }).click();
    await expect(panel(page).getByRole("button", { name: "Send", exact: true })).toBeVisible();

    await page.evaluate(() => (window as unknown as { __WOLLIPOG_SIDE_CHAT_E2E__: { set(state: string): void } })
      .__WOLLIPOG_SIDE_CHAT_E2E__.set("ended"));
    await expect(panel(page).locator(".sc-ended-text")).toHaveText("This side chat was stopped. Its transcript stays here and in Sessions.");
    await expect(panel(page).locator("textarea")).toHaveCount(0);
    await expect(panel(page).locator(".btn.primary, .icon-btn.primary")).toHaveCount(1);
    const text = await box(panel(page).locator(".sc-ended-text"));
    const action = await box(panel(page).getByRole("button", { name: "Start New Side Chat" }));
    expect(Math.abs((text.y + text.height / 2) - (action.y + action.height / 2))).toBeLessThan(12);
    // CI's fonts run wider than a dev machine's: with wider glyphs the two still share one row.
    await page.addStyleTag({ content: "#right-panel .sc-ended { letter-spacing: 1px; } #right-panel .sc-ended .btn { padding-inline: 32px; }" });
    const wideText = await box(panel(page).locator(".sc-ended-text"));
    const wideAction = await box(panel(page).getByRole("button", { name: "Start New Side Chat" }));
    expect(wideAction.x).toBeGreaterThan(wideText.x + wideText.width - 1);
    expect(Math.abs((wideText.y + wideText.height / 2) - (wideAction.y + wideAction.height / 2))).toBeLessThan(12);
  });
});

test.describe("on a phone with a coarse pointer", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("at 390px Send is 44px and stays in the card on the input's line from one to eight lines (#2863)", async ({ page }) => {
    await openSideChat(page, 390, 844);
    const field = panel(page).locator(".sc-composer textarea");
    await field.fill("One line");
    await expectSendInCard(page, 44);
    await field.fill(Array.from({ length: 8 }, (_, line) => `Line ${line + 1}`).join("\n"));
    await expectSendInCard(page, 44);
    const grown = await box(field);
    expect(grown.height).toBeGreaterThanOrEqual(8 * 22 - 1);
    await field.fill(Array.from({ length: 12 }, (_, line) => `Line ${line + 1}`).join("\n"));
    expect((await box(field)).height).toBe(grown.height);
  });

  test("with the side-chat field focused no pixel of the session composer is on screen, and Send clears the keyboard (#2863)", async ({ page }) => {
    await openSideChat(page, 390, 844);
    const field = panel(page).locator(".sc-composer textarea");
    await field.focus();
    await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-inset", "300px"));
    await expect(page.locator(".composer")).toBeHidden();
    // Every point of the visible screen hits Side Chat's sheet, never the session's composer.
    const covered = await page.evaluate(() => {
      const hits: string[] = [];
      for (let y = 1; y < window.innerHeight; y += 8) {
        for (let x = 1; x < window.innerWidth; x += 8) {
          for (const element of document.elementsFromPoint(x, y)) {
            if (element.closest(".composer")) hits.push(`${x},${y}`);
          }
        }
      }
      return hits;
    });
    expect(covered).toEqual([]);
    const send = await box(panel(page).getByRole("button", { name: "Send", exact: true }));
    expect(send.y + send.height).toBeLessThanOrEqual(844 - 300);
    await test.info().attach("side-chat-phone-keyboard", {
      body: await page.screenshot(), contentType: "image/png",
    });
  });

  test("the About sheet lists what is shared without the keyboard-only Open fact, and nothing is clipped (#2863)", async ({ page }) => {
    await openSideChat(page, 390, 844);
    await panel(page).getByRole("button", { name: "About Side Chat" }).click();
    const sheet = page.getByRole("dialog", { name: "About Side Chat" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("dt")).toHaveText(["Shared", "Not Shared", "Comes Back", "Send"]);
    // The sheet slides up from below; measure it once it has settled.
    await expect.poll(async () => (await sheet.boundingBox())!.y + (await sheet.boundingBox())!.height).toBeLessThanOrEqual(844);
    const fits = await sheet.evaluate((element) => {
      const scroller = [element, ...element.querySelectorAll<HTMLElement>("*")]
        .find((candidate) => candidate.scrollHeight > candidate.clientHeight + 1 && getComputedStyle(candidate).overflowY !== "visible");
      const box = element.getBoundingClientRect();
      return { clipped: scroller?.className ?? null, bottom: box.bottom, viewport: window.innerHeight };
    });
    expect(fits.clipped).toBeNull();
    expect(fits.bottom).toBeLessThanOrEqual(fits.viewport);
  });

  test("ended at 390px stacks the sentence over a full-width 44px button (#2863)", async ({ page }) => {
    await openSideChat(page, 390, 844, "ended");
    const ended = await box(panel(page).locator(".sc-ended"));
    const action = await box(panel(page).getByRole("button", { name: "Start New Side Chat" }));
    const text = await box(panel(page).locator(".sc-ended-text"));
    expect(action.height).toBe(44);
    expect(Math.round(action.width)).toBe(Math.round(ended.width));
    expect(action.y).toBeGreaterThanOrEqual(text.y + text.height);
    // Stacked, the sentence sits directly over its button: no stretched gap between them.
    expect(action.y - (text.y + text.height)).toBeLessThanOrEqual(8);
  });
});
