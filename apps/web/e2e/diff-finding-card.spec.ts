import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A finding in the diff (#2851; docs/design-system.md §2.10, §8.1, §8.4, §8.5, §10.2): the editor is
 * one neutral card whose only focus ring is the textarea's, its Severity and Required share a row
 * and Cancel and Add Finding the next one in a 400px panel, it leaves the code column's indent under
 * 480px, and on a phone Add Finding stays above the keyboard with no session composer on screen. A
 * resolved finding is one quiet line. While the card is written on a coarse pointer, Review's foot
 * (the commit bar or a selection bar) gives its height to the scroller and returns intact (#2907).
 * The harnesses are the real side panel over the file-section fixture with findings held in memory
 * (`diff-sections-main.tsx`, the full shell's `reviewDiff=1`).
 */

const CHECKOUT = "apps/shop/src/features/checkout/components/payment/CheckoutPage.tsx";

async function open(page: Page, query: string, viewport = { width: 1100, height: 860 }) {
  await page.setViewportSize(viewport);
  await page.goto(`/diff-sections-e2e.html?findings=1&${query}`);
  await expect(page.locator(".dfile").first()).toBeVisible();
}

const checkoutFile = (scope: Page | Locator) => scope.locator(`.dfile[data-path="${CHECKOUT}"]`);

/**
 * Open the editor under the checkout file's new line 21 and return the card: with a mouse through
 * the line's hover "+", on touch through its line menu's Add Finding… (#2849).
 */
async function openEditor(page: Page, { touch = false }: { touch?: boolean } = {}): Promise<Locator> {
  const file = checkoutFile(page);
  if (touch) {
    const number = file.getByRole("button", { name: "Line 21 Actions", exact: true });
    await number.scrollIntoViewIfNeeded();
    await number.tap();
    await page.getByRole("menuitem", { name: "Add Finding…" }).tap();
  } else {
    const add = file.getByRole("button", { name: "Add Finding on Line 21", exact: true });
    await add.scrollIntoViewIfNeeded();
    await add.hover();
    await add.click();
  }
  const card = page.locator(".dedit");
  await expect(card).toBeVisible();
  return card;
}

const box = async (locator: Locator) => (await locator.boundingBox())!;

/** The panel's content box: the diff spans it, inside the panel's 1px leading edge. */
async function panelBox(page: Page) {
  return page.locator("#right-panel").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + element.clientLeft, width: element.clientWidth, y: rect.y, height: rect.height };
  });
}

/** A custom property resolved to the colour the browser paints, for comparing computed styles. */
function resolvedColor(page: Page, token: string, property: "color" | "borderTopColor" = "color") {
  return page.evaluate(([name, prop]) => {
    const probe = document.createElement("span");
    probe.style.setProperty(prop === "color" ? "color" : "border-top-color", `var(${name})`);
    probe.style.borderTopStyle = "solid";
    document.querySelector("#right-panel")!.append(probe);
    const value = getComputedStyle(probe)[prop as "color"];
    probe.remove();
    return value;
  }, [token, property] as const);
}

test("the editor card has a --border-strong edge and only the textarea draws a focus ring", async ({ page }) => {
  await open(page, "width=400");
  const card = await openEditor(page);
  const textarea = card.locator("textarea");
  await expect(textarea).toBeFocused();
  const cardStyle = () => card.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      border: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
      width: style.borderTopWidth,
      outline: style.outlineStyle,
      shadow: style.boxShadow,
    };
  });
  const focused = await cardStyle();
  const strong = await resolvedColor(page, "--border-strong", "borderTopColor");
  expect(focused.border).toEqual([strong, strong, strong, strong]);
  expect(focused.width).toBe("1px");
  expect(focused.outline).toBe("none");
  const ring = await textarea.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
  });
  const focus = await resolvedColor(page, "--focus");
  expect(ring).toEqual({ outline: "solid", width: "1px", color: focus });

  // Nothing about the card changes with focus inside it, and nothing else in it draws a ring.
  await page.locator(".rpanel-head").click({ position: { x: 4, y: 4 } });
  await expect(textarea).not.toBeFocused();
  expect(await cardStyle()).toEqual(focused);
  await textarea.focus();
  const ringed = await card.evaluate((element) => [...element.querySelectorAll("*")]
    .filter((node) => getComputedStyle(node).outlineStyle !== "none")
    .map((node) => node.localName));
  expect(ringed).toEqual(["textarea"]);
});

test("in a 400px panel Severity and Required share a row and Cancel and Add Finding the next", async ({ page }) => {
  await open(page, "width=400");
  const card = await openEditor(page);
  const panel = await panelBox(page);
  const outer = await box(card);
  expect(Math.round(outer.x - panel.x), "12px from the panel's edge under 480px").toBe(12);
  expect(Math.round(panel.x + panel.width - (outer.x + outer.width))).toBe(12);

  const severity = await box(card.getByRole("radiogroup", { name: "Severity" }));
  const required = await box(card.locator(".review-required-toggle"));
  const centre = (rect: { y: number; height: number }) => rect.y + rect.height / 2;
  expect(Math.abs(centre(severity) - centre(required)), "one row").toBeLessThan(2);
  expect(required.x).toBeGreaterThan(severity.x + severity.width);

  const helper = await box(card.getByText("Required findings must be resolved before publishing."));
  expect(helper.y).toBeGreaterThanOrEqual(Math.max(severity.y + severity.height, required.y + required.height));
  const cancel = await box(card.getByRole("button", { name: "Cancel" }));
  const add = await box(card.getByRole("button", { name: "Add Finding" }));
  expect(Math.abs(cancel.y - add.y), "the actions share a row").toBeLessThan(1);
  expect(cancel.y, "under the helper").toBeGreaterThan(helper.y + helper.height);
  expect(add.x, "Add Finding last").toBeGreaterThan(cancel.x + cancel.width);
  const padding = await card.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingRight));
  expect(Math.round(outer.x + outer.width - 1 - padding - (add.x + add.width)), "right-aligned").toBe(0);
});

test("in a 320px panel the card is indented 12px and its actions still share a row", async ({ page }) => {
  await open(page, "width=320");
  const card = await openEditor(page);
  const panel = await panelBox(page);
  const outer = await box(card);
  expect(Math.round(outer.x - panel.x)).toBe(12);
  expect(Math.round(panel.x + panel.width - (outer.x + outer.width))).toBe(12);
  const cancel = await box(card.getByRole("button", { name: "Cancel" }));
  const add = await box(card.getByRole("button", { name: "Add Finding" }));
  expect(Math.abs(cancel.y - add.y)).toBeLessThan(1);
  for (const control of [card.getByRole("radiogroup", { name: "Severity" }), card.locator(".review-required-toggle")]) {
    const rect = await box(control);
    expect(rect.x + rect.width, "nothing overflows the card").toBeLessThanOrEqual(outer.x + outer.width);
  }
});

test("wider than 480px the card aligns with the code column, 96px in", async ({ page }) => {
  await open(page, "width=640");
  const card = await openEditor(page);
  const panel = await panelBox(page);
  expect(Math.round((await box(card)).x - panel.x)).toBe(96);
});

test("an empty Add Finding shows the field error; a written one becomes an open inline finding", async ({ page }) => {
  await open(page, "width=400");
  const card = await openEditor(page);
  await card.getByRole("button", { name: "Add Finding" }).click();
  const textarea = card.getByRole("textbox", { name: "Finding" });
  await expect(textarea).toHaveAttribute("aria-invalid", "true");
  await expect(card.locator(".field-error")).toHaveText("Describe the issue before adding it.");
  await expect(textarea).toHaveAccessibleDescription("Describe the issue before adding it.");
  const red = await resolvedColor(page, "--red", "borderTopColor");
  await expect(textarea).toHaveCSS("border-top-color", red);

  await textarea.fill("The total ignores the quantity when a discount applies.");
  await expect(textarea).not.toHaveAttribute("aria-invalid", "true");
  await card.getByRole("button", { name: "Add Finding" }).click();
  await expect(page.locator(".dedit")).toHaveCount(0);
  const created = page.locator(".dfinding", { hasText: "The total ignores the quantity" });
  await expect(created).toBeVisible();
  await expect(created).not.toContainText("usr_");
});

test("a resolved finding is one quiet line that opens, and Reopen restores the open card", async ({ page }) => {
  await open(page, "width=400");
  const line = page.locator(".dfinding.is-settled");
  await line.scrollIntoViewIfNeeded();
  await expect(line).toHaveCount(1);
  const toggle = line.locator(".dfinding-toggle");
  await expect(toggle).toHaveText("Resolved: Pass the shopper's locale, so the total matches the receipt.");
  const lineHeight = Math.round((await box(line)).height);
  expect(lineHeight, "one row").toBeLessThanOrEqual(32);
  await expect(toggle.locator(".dfinding-summary")).toHaveCSS("white-space", "nowrap");
  const dim = await resolvedColor(page, "--text-dim");
  await expect(toggle).toHaveCSS("color", dim);
  await expect(line).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");

  await toggle.click();
  await expect(line.locator(".dfinding-body")).toBeVisible();
  expect((await box(line)).height).toBeGreaterThan(lineHeight * 2);
  await line.getByRole("button", { name: "Reopen" }).click();
  await expect(page.locator(".dfinding.is-settled")).toHaveCount(0);
  const reopened = page.locator(".dfinding", { hasText: "Pass the shopper's locale" });
  await expect(reopened.getByRole("button", { name: "Resolve" })).toBeVisible();
  // An open finding keeps the editor's card recipe.
  await expect(reopened).toHaveCSS("border-top-color", await resolvedColor(page, "--border-strong", "borderTopColor"));
  for (const card of await page.locator(".dfinding").all()) await expect(card).not.toContainText("usr_");
});

/** Severity and Required share a row: the same offsetTop, inside the card, with 44px touch targets. */
async function expectOneOptionsRow(card: Locator) {
  const measured = await card.evaluate((element) => {
    const group = element.querySelector<HTMLElement>('[role="radiogroup"]')!;
    const required = element.querySelector<HTMLElement>(".review-required-toggle")!;
    const right = element.getBoundingClientRect().right;
    return {
      tops: [group.offsetTop, required.offsetTop],
      inside: required.getBoundingClientRect().right <= right,
      radios: [...group.querySelectorAll<HTMLElement>('[role="radio"]')].map((radio) => {
        const rect = radio.getBoundingClientRect();
        // The coarse-pointer hit area extends 4px above and below each option (`::after`).
        return { width: Math.round(rect.width), height: Math.round(rect.height) + 8 };
      }),
    };
  });
  expect(measured.tops[0], "Severity and Required share one row").toBe(measured.tops[1]);
  expect(measured.inside).toBe(true);
  for (const radio of measured.radios) {
    expect(radio.width).toBeGreaterThanOrEqual(44);
    expect(radio.height).toBeGreaterThanOrEqual(44);
  }
}

/**
 * The full shell at 390×844 on Review, with Commit Message holding `message` and the editor open
 * and focused under the checkout file's new line 21 through its line menu.
 */
async function openPhoneEditor(page: Page, message = "Fix the checkout total") {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&reviewReady=1&reviewDiff=1&findings=1&fullShell=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  const panel = page.locator("#right-panel");
  await panel.locator(".rpanel-switcher").tap();
  await page.getByRole("menuitemradio", { name: "Review" }).tap();
  await expect(panel.locator(".dfile").first()).toBeVisible();
  await panel.getByLabel("Commit Message").fill(message);

  const number = checkoutFile(panel).getByRole("button", { name: "Line 21 Actions", exact: true });
  await number.scrollIntoViewIfNeeded();
  await number.tap();
  await page.getByRole("menuitem", { name: "Add Finding…" }).tap();
  const card = panel.locator(".dedit");
  await expect(card.locator("textarea")).toBeFocused();
  return { panel, card };
}

test.describe("on a phone with a coarse pointer", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("in a 360px panel Severity and Required still share a row with 44px targets", async ({ page }) => {
    await open(page, "width=360");
    await expectOneOptionsRow(await openEditor(page, { touch: true }));
  });

  test("with the textarea focused and the keyboard open, Add Finding is above it and no composer is rendered", async ({ page }) => {
    const { panel, card } = await openPhoneEditor(page);
    await expectOneOptionsRow(card);
    // Where the keyboard covers the layout viewport, the sheet ends at its top edge (#2843).
    await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-inset", "300px"));
    const keyboardTop = 844 - 300;
    const submit = card.getByRole("button", { name: "Add Finding" });
    await expect(submit).toBeInViewport();
    const rect = await box(submit);
    expect(rect.y + rect.height, "Add Finding is above the keyboard").toBeLessThanOrEqual(keyboardTop);
    const sheet = await box(panel);
    expect(rect.y).toBeGreaterThanOrEqual(sheet.y);
    expect(rect.height, "a 44px touch target").toBeGreaterThanOrEqual(36);
    // The panel sheet hides the session composer: it has no box and leaves the accessibility tree.
    await expect(page.locator(".composer")).toBeHidden();
    const fieldsOutside = await page.evaluate(() => [...document.querySelectorAll("textarea, [contenteditable='true']")]
      .filter((element) => !element.closest("#right-panel") && element.getClientRects().length > 0).length);
    expect(fieldsOutside, "no text field outside the sheet is laid out").toBe(0);
    // The commit bar gives the foot's height to the scroller while the finding is written (#2907), so
    // the whole card fits between the file's sticky header and the keyboard.
    await expect(panel.locator(".rpanel-foot")).toBeHidden();
    await expect(panel.locator(".commit-bar")).toBeHidden();
    const head = await box(checkoutFile(panel).locator(".dfile-head"));
    const outer = await box(card);
    expect(outer.y, "the card's top, with the textarea's first line, is below the sticky header")
      .toBeGreaterThanOrEqual(head.y + head.height);
    expect(outer.y + outer.height, "the card's foot is above the keyboard").toBeLessThanOrEqual(keyboardTop);
  });
});

/** The diff scroller's position, to show the commit bar's collapse and return never move the diff. */
const diffScrollTop = (panel: Locator) => panel.locator(".rpanel-scroll").evaluate((element) => element.scrollTop);

/**
 * The keyboard stand-in, pinned: the app republishes `--keyboard-inset` from the visual viewport
 * (`mobile-viewport.ts`), so an inline value can be cleared mid-test; a rule marked important holds
 * until it is removed, which is the keyboard closing.
 */
async function openKeyboard(page: Page) {
  const style = await page.addStyleTag({ content: ":root { --keyboard-inset: 300px !important; }" });
  return { top: 844 - 300, close: () => style.evaluate((element) => element.remove()) };
}

test.describe("the commit bar while a finding is written (#2907)", () => {
  test.describe("on a coarse pointer", () => {
    test.use({ hasTouch: true, isMobile: true });

    test("blurring the textarea brings the commit bar back with its message, and nothing moves", async ({ page }) => {
      const { panel, card } = await openPhoneEditor(page, "Fix the checkout total");
      const textarea = card.locator("textarea");
      const keyboard = await openKeyboard(page);
      await expect(panel.locator(".commit-bar")).toBeHidden();
      await expect(card.getByRole("button", { name: "Add Finding" })).toBeInViewport();
      const scrolled = await diffScrollTop(panel);

      // The keyboard goes with the blur; the commit bar comes back as it was.
      await textarea.evaluate((element: HTMLTextAreaElement) => element.blur());
      await keyboard.close();
      await expect(panel.locator(".commit-bar")).toBeVisible();
      await expect(panel.getByLabel("Commit Message")).toHaveValue("Fix the checkout total");
      expect(await page.evaluate(() => document.activeElement === document.body), "focus moved nowhere").toBe(true);
      expect(await diffScrollTop(panel), "the diff kept its position").toBe(scrolled);

      // Writing again takes the bar away again, and the diff still doesn't move.
      await textarea.evaluate((element: HTMLTextAreaElement) => element.focus({ preventScroll: true }));
      await expect(panel.locator(".commit-bar")).toBeHidden();
      await expect(textarea).toBeFocused();
      expect(await diffScrollTop(panel)).toBe(scrolled);
    });

    test("the findings selection bar in the foot follows the same rule", async ({ page }) => {
      await open(page, "width=360");
      const panel = page.locator("#right-panel");
      const select = panel.getByRole("checkbox", { name: /^Select Finding on / }).first();
      await select.scrollIntoViewIfNeeded();
      await select.tap();
      const bar = panel.locator(".finding-selection-bar");
      await expect(bar).toContainText("1 finding selected");
      // A checkbox summons no keyboard, so its focus leaves the bar where it is.
      await expect(bar).toBeVisible();

      const card = await openEditor(page, { touch: true });
      await expect(card.locator("textarea")).toBeFocused();
      await expect(bar).toBeHidden();
      await card.locator("textarea").evaluate((element: HTMLTextAreaElement) => element.blur());
      await expect(bar).toBeVisible();
      await expect(bar).toContainText("1 finding selected");
    });

    test("focusing Commit Message keeps the commit bar above the keyboard", async ({ page }) => {
      const { panel, card } = await openPhoneEditor(page);
      const message = panel.getByLabel("Commit Message");
      await card.locator("textarea").evaluate((element: HTMLTextAreaElement) => element.blur());
      await message.focus();
      const keyboard = await openKeyboard(page);
      await expect(panel.locator(".commit-bar")).toBeVisible();
      await expect(message).toBeFocused();
      const field = await box(message);
      expect(field.y + field.height, "Commit Message is above the keyboard").toBeLessThanOrEqual(keyboard.top);
    });
  });

  test("on a fine pointer the commit bar stays while the textarea has focus", async ({ page }) => {
    await open(page, "width=400");
    const card = await openEditor(page);
    await expect(card.locator("textarea")).toBeFocused();
    const panel = page.locator("#right-panel");
    await expect(panel.locator(".commit-bar")).toBeVisible();
    const foot = await box(panel.locator(".rpanel-foot"));
    expect(foot.height).toBeGreaterThan(0);
  });
});
