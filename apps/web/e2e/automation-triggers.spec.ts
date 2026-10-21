import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { dialogMotionSettled } from "./dialog-motion.js";
import { verticalHitAreas } from "./hit-area.js";

/**
 * An automation's Triggers (#2972; docs/design-system.md §5.2, §7.1–§7.5, §8.4, §9.1, §11.7, §13.2)
 * in a real browser: two-line rows with Copy URL and ⋯, the New Webhook Trigger dialog (a bottom
 * sheet with 44px targets on a phone), the created state with the one-time secret, How to Call, and
 * Rotate Secret and Revoke Trigger replacing a phone's ⋯ sheet. `AutomationDetail.dom.test.tsx`
 * covers the requests and the secret's lifetime against a fake DOM. With `WOLLIPOG_EVIDENCE_DIR`
 * set, each state is also captured as UI evidence.
 */

async function open(page: Page, theme: string) {
  await page.goto(`/automations-e2e.html?theme=${theme}`);
  await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
  await expect(page.locator(".detail-bar-title")).toHaveText(/Nightly Dependency Sweep/);
}

const triggers = (page: Page) => page.locator('section[aria-labelledby="automation-triggers"]');
const row = (page: Page, triggerId: string) => triggers(page).locator(`[data-trigger-id="${triggerId}"]`);

async function capture(page: Page, name: string, fullPage = false) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  // Let a dialog's entrance and any transition settle into a representative frame.
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage });
}

async function openNewWebhookTrigger(page: Page): Promise<Locator> {
  await triggers(page).getByRole("button", { name: "Add Trigger" }).click();
  await page.getByRole("menuitem", { name: "Webhook Trigger…" }).click();
  const dialog = page.getByRole("dialog", { name: "New Webhook Trigger" });
  await expect(dialog).toBeVisible();
  await dialogMotionSettled(page);
  return dialog;
}

async function openRowMenu(page: Page, triggerId: string, name: string): Promise<Locator> {
  await row(page, triggerId).getByRole("button", { name: `${name} Actions` }).click();
  const menu = page.getByRole("menu", { name: `${name} Actions` });
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("rows are 56px, say their kind and use in words, and keep Rotate and Revoke in ⋯", async ({ page }) => {
    await open(page, "dark");
    for (const height of await triggers(page).locator(".row").evaluateAll((rows) => rows.map((element) => element.getBoundingClientRect().height))) {
      expect(height).toBe(56);
    }
    await expect(row(page, "atr_issue_intake").locator(".automation-trigger-meta")).toHaveText(
      /^WebhookLast called Today, .+12 callsAccepts prompt text and issue, priority$/);
    await expect(row(page, "atr_release_command").locator(".automation-trigger-meta")).toHaveText("Chat-OpsNever called");
    await expect(row(page, "atr_issue_intake").getByRole("button", { name: "Copy URL" })).toBeVisible();
    await expect(triggers(page)).not.toContainText("Key Generation");
    await expect(triggers(page)).not.toContainText("application/vnd");
    const menu = await openRowMenu(page, "atr_issue_intake", "Issue Intake");
    await expect(menu.getByRole("menuitem")).toHaveText(["Copy URL", "How to Call…", "Rotate Secret…", "Revoke Trigger…"]);
    await expect(menu.locator("> *").last()).toHaveText("Revoke Trigger…");
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a row whose facts wrap grows to hold them, and the next row starts below it", async ({ page }) => {
    await page.goto("/automations-e2e.html?theme=dark&long-trigger-values");
    await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
    const rows = await triggers(page).locator("[data-trigger-id]").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      const body = element.querySelector(".row-body")!.getBoundingClientRect();
      const meta = element.querySelector(".automation-trigger-meta")!;
      return {
        id: (element as HTMLElement).dataset.triggerId,
        top: box.top,
        bottom: box.bottom,
        bodyInside: body.top >= box.top - 0.5 && body.bottom <= box.bottom + 0.5,
        metaLines: Math.round(meta.getBoundingClientRect().height / parseFloat(getComputedStyle(meta).lineHeight)),
      };
    }));
    expect(rows[0]!.metaLines, "sixteen named values take several lines").toBeGreaterThan(3);
    for (const row of rows) expect(row, `${row.id} holds its title and facts`).toMatchObject({ bodyInside: true });
    expect(rows[1]!.top, "the next row starts where the grown row ends").toBeGreaterThanOrEqual(rows[0]!.bottom - 0.5);
  });

  test("New Webhook Trigger is a bottom sheet with 44px targets, Copy URL lives in ⋯, and both confirmations replace the ⋯ sheet", async ({ page }) => {
    await open(page, "dark");
    await expect(row(page, "atr_issue_intake").getByRole("button", { name: "Copy URL" })).toHaveCount(0);
    // No meta fact is clipped: a fact that does not fit moves to the next line whole, inside the row.
    const facts = await triggers(page).locator(".automation-trigger-meta > span").evaluateAll((spans) => spans.map((span) => {
      const meta = span.parentElement!.getBoundingClientRect();
      const box = span.getBoundingClientRect();
      return {
        text: span.textContent,
        clipped: span.scrollWidth > span.clientWidth + 1 || getComputedStyle(span).textOverflow === "ellipsis",
        inside: box.left >= meta.left - 0.5 && box.right <= meta.right + 0.5 && box.bottom <= meta.bottom + 0.5,
        lines: Math.round(box.height / parseFloat(getComputedStyle(span).lineHeight)),
      };
    }));
    expect(facts.map((fact) => fact.text)).toContain("Accepts prompt text and issue, priority");
    for (const fact of facts) {
      expect(fact, `${fact.text} is whole`).toMatchObject({ clipped: false, inside: true, lines: 1 });
    }
    const metaLines = await row(page, "atr_issue_intake").locator(".automation-trigger-meta").evaluate((meta) =>
      Math.round(meta.getBoundingClientRect().height / parseFloat(getComputedStyle(meta).lineHeight)));
    expect(metaLines, "the facts wrap onto a second line rather than clip").toBeGreaterThan(1);

    const sheet = await openNewWebhookTrigger(page);
    const box = await sheet.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, width: rect.width, bottom: Math.round(rect.bottom) };
    });
    expect(box).toEqual({ left: 0, width: 390, bottom: 844 });
    await sheet.getByRole("switch", { name: "Let Callers Add Details" }).click();
    const targets = [
      sheet.getByRole("textbox", { name: "Name", exact: true }),
      sheet.getByRole("switch", { name: "Let Callers Add Details" }),
      sheet.locator("label.checkbox").filter({ hasText: "Prompt Text" }),
      sheet.getByRole("textbox", { name: "Named Values" }),
      sheet.getByRole("button", { name: /^If a Referenced Value Is Missing/ }),
      sheet.getByRole("button", { name: "Cancel" }),
      sheet.getByRole("button", { name: "Create Trigger" }),
    ];
    for (const target of targets) {
      const height = await target.evaluate((element) => element.getBoundingClientRect().height);
      expect(height, await target.evaluate((element) => element.textContent || element.getAttribute("aria-label") || element.id))
        .toBeGreaterThanOrEqual(44);
    }
    // How to Call is an inline §5.5 disclosure: 36px to look, like a small button, and a 44px target
    // from the 4px it borrows above and below.
    const [howToCall] = await verticalHitAreas(sheet.getByRole("button", { name: "How to Call" }));
    expect(howToCall.bottom - howToCall.top, "drawn at --control-h-sm").toBeCloseTo(36, 0);
    expect(howToCall.hitBottom - howToCall.hitTop, "a 44px target").toBeGreaterThanOrEqual(44);
    // The borrowed 4px above and below covers no other control in the sheet, closed or open.
    const trigger = sheet.getByRole("button", { name: "How to Call" });
    for (const expanded of ["false", "true"]) {
      if ((await trigger.getAttribute("aria-expanded")) !== expanded) await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", expanded);
      const overlaps = await trigger.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const bands = [[box.top - 4, box.top], [box.bottom, box.bottom + 4]] as const;
        const controls = element.closest('[role="dialog"]')!.querySelectorAll(
          'button, input, textarea, select, a[href], label, [role="switch"], [tabindex]:not([tabindex="-1"])');
        return [...controls].filter((control) => control !== element && !control.contains(element)).filter((control) => {
          const rect = control.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0 || rect.right <= box.left || rect.left >= box.right) return false;
          return bands.some(([top, bottom]) => rect.bottom > top && rect.top < bottom);
        }).map((control) => control.getAttribute("aria-label") || control.textContent?.trim() || control.tagName);
      });
      expect(overlaps, `How to Call's borrowed band with the disclosure ${expanded === "true" ? "open" : "closed"}`).toEqual([]);
    }
    await sheet.getByRole("button", { name: "Cancel" }).click();

    for (const [item, title, sentence] of [
      ["Rotate Secret…", "Rotate Secret", "“Issue Intake” gets a new signing secret."],
      ["Revoke Trigger…", "Revoke Trigger", "“Issue Intake” stops accepting requests"],
    ] as const) {
      const menu = await openRowMenu(page, "atr_issue_intake", "Issue Intake");
      await expect(menu.getByRole("menuitem", { name: "Copy URL" })).toBeVisible();
      await menu.getByRole("menuitem", { name: item }).click();
      const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: title });
      await expect(confirmation).toContainText(sentence);
      await expect(menu).toHaveCount(0);
      await confirmation.getByRole("button", { name: "Back to More Actions" }).click();
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  });
});

for (const { label, viewport } of [
  { label: "1440", viewport: { width: 1440, height: 900 } },
  { label: "390", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${label} ${theme} states`, () => {
    test.use({ viewport });

    test("Trigger List", async ({ page }) => {
      await open(page, theme);
      await triggers(page).scrollIntoViewIfNeeded();
      await expect(triggers(page).locator("[data-trigger-id]")).toHaveCount(2);
      await capture(page, `triggers-list-${label}-${theme}`);
    });

    test("New Webhook Trigger With Details", async ({ page }) => {
      await open(page, theme);
      const dialog = await openNewWebhookTrigger(page);
      await dialog.getByRole("switch", { name: "Let Callers Add Details" }).click();
      await dialog.locator("label.checkbox").filter({ hasText: "Prompt Text" }).click();
      await dialog.getByRole("textbox", { name: "Named Values" }).fill("issue, run_id");
      await capture(page, `triggers-new-details-${label}-${theme}`);
    });

    test("Created With the Secret", async ({ page }) => {
      await open(page, theme);
      const dialog = await openNewWebhookTrigger(page);
      await dialog.getByRole("button", { name: "Create Trigger" }).click();
      const created = page.getByRole("dialog", { name: "Webhook Trigger Created" });
      await expect(created.locator(".notice-title")).toHaveText("Copy the Signing Secret Now");
      await expect(created.locator(".notice .code-well.one-line code")).toHaveText(/^wollipogwhsec_/);
      await expect(created.getByRole("button", { name: "Copy Secret" })).toBeFocused();
      await capture(page, `triggers-created-${label}-${theme}`);
      await created.getByRole("button", { name: "Done" }).click();
      await expect(created).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("wollipogwhsec_");
    });

    test("How to Call", async ({ page }) => {
      await open(page, theme);
      const menu = await openRowMenu(page, "atr_issue_intake", "Issue Intake");
      await menu.getByRole("menuitem", { name: "How to Call…" }).click();
      const dialog = page.getByRole("dialog", { name: "How to Call" });
      await expect(dialog).toContainText("POST /hooks/v1/automation-triggers/atr_issue_intake");
      await dialogMotionSettled(page);
      await capture(page, `triggers-how-to-call-${label}-${theme}`);
    });

    for (const [item, title] of [["Rotate Secret…", "Rotate Secret"], ["Revoke Trigger…", "Revoke Trigger"]] as const) {
      test(`${title} Confirmation`, async ({ page }) => {
        await open(page, theme);
        const menu = await openRowMenu(page, "atr_issue_intake", "Issue Intake");
        await menu.getByRole("menuitem", { name: item }).click();
        const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: title });
        await expect(confirmation).toContainText("“Issue Intake”");
        await dialogMotionSettled(page);
        await capture(page, `triggers-${title.toLowerCase().replace(" ", "-")}-${label}-${theme}`);
      });
    }
  });
}
