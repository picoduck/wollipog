import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectNumberFieldsWhole, numberFields } from "./number-field-fit.js";

/**
 * Settings › Behavior › Session Titles (#3025) in a real browser: the endpoint dialog's Delete API Key
 * confirmation stacks over it on desktop and takes the sheet over, with Back, on a phone; on a phone
 * both setup dialogs are sheets with touch-sized fields and two equal footer buttons.
 *
 * `SESSION_TITLES_EVIDENCE=1` also saves a screenshot of every state the issue lists, at 1440px and
 * 390px in both themes, into the test's output folder.
 */

const PAGE = "/session-titles-e2e.html";
const EVIDENCE = process.env.SESSION_TITLES_EVIDENCE === "1";

const group = (page: Page) => page.locator("section.settings-group").filter({ has: page.getByRole("heading", { name: "Session Titles" }) });
const endpointDialog = (page: Page) => page.getByRole("dialog", { name: "Custom Endpoint for Titles" });
const agentDialog = (page: Page) => page.getByRole("dialog", { name: "Agent for Titles" });

async function openSavedEndpoint(page: Page, query = "source=endpoint-key"): Promise<Locator> {
  await page.goto(`${PAGE}?${query}`);
  await group(page).getByRole("button", { name: /^Edit…/ }).click();
  const dialog = endpointDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The placeholder of each field that does not fit its content box. */
async function cutPlaceholders(dialog: Locator): Promise<string[]> {
  return dialog.locator("input[placeholder]").evaluateAll((inputs) => inputs.flatMap((input) => {
    const field = input as HTMLInputElement;
    const style = getComputedStyle(field);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const room = field.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    return context.measureText(field.placeholder).width > room ? [field.placeholder] : [];
  }));
}

async function capture(page: Page, name: string, testInfo: { outputPath: (name: string) => string }) {
  if (!EVIDENCE) return;
  await dialogMotionSettled(page);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Delete… stacks the Delete API Key confirmation over the endpoint dialog", async ({ page }) => {
    const dialog = await openSavedEndpoint(page);
    await expect(dialog.getByText("A key is saved on Studio Workstation.")).toBeVisible();
    const remove = dialog.getByRole("button", { name: "Delete…" });
    await remove.click();
    const confirmation = page.getByRole("dialog", { name: "Delete API Key" });
    await expect(confirmation).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.locator(".modal")).toHaveCount(2);
    await expect(page.locator(".modal-backdrop.stacked")).toHaveCount(1);
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(confirmation.locator(".modal-foot .btn.danger")).toHaveText("Delete API Key");
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect(remove).toBeFocused();
  });

  test("Test Connection sits at the footer's far left once an endpoint is saved", async ({ page }) => {
    const dialog = await openSavedEndpoint(page, "source=endpoint");
    const foot = dialog.locator(".modal-foot");
    await expect(foot.locator(".modal-tertiary").getByRole("button", { name: "Test Connection" })).toBeVisible();
    await expect(foot.locator(":scope > .btn").first()).toHaveText("Cancel");
    await expect(foot.locator(":scope > .btn").last()).toHaveText("Save");
    await expect(foot.locator(":scope > .btn").last()).toHaveClass(/primary/);
    await foot.getByRole("button", { name: "Test Connection" }).click();
    await expect(dialog.getByText("The endpoint answered.")).toBeVisible();
  });

  test("the 96px Timeout shows the longest timeout whole, with ms inside it", async ({ page }) => {
    const dialog = await openSavedEndpoint(page, "source=endpoint");
    const timeout = dialog.getByLabel("Timeout");
    await dialogMotionSettled(page);
    expect((await timeout.locator("..").boundingBox())?.width).toBe(96);
    await timeout.fill("30000");
    await expect(timeout.locator("xpath=following-sibling::*[1]")).toHaveText("ms");
    // The shared unit field (#3185) with no rules of the dialog's own, measured in a wide face.
    await expectNumberFieldsWhole(page, dialog, "30000 whole beside ms at 13px");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Delete… replaces the endpoint sheet with the confirmation, and Back returns to it", async ({ page }) => {
    const dialog = await openSavedEndpoint(page);
    await dialog.getByRole("button", { name: "Delete…" }).click();
    const confirmation = page.getByRole("dialog", { name: "Delete API Key" });
    await expect(confirmation).toBeVisible();
    await expect(page.locator(".modal")).toHaveCount(1);
    await expect(page.locator(".modal-backdrop")).toHaveCount(1);
    await expect(dialog).toBeHidden();
    const back = confirmation.getByRole("button", { name: "Back to Custom Endpoint for Titles" });
    await expect(back).toBeVisible();
    await back.click();
    await expect(confirmation).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("A key is saved on Studio Workstation.")).toBeVisible();
  });

  for (const which of ["agent", "endpoint"] as const) {
    test(`the ${which} dialog is a sheet with 44px fields, two equal 48px footer buttons and whole placeholders`, async ({ page }) => {
      await page.goto(PAGE);
      const trigger = group(page).getByRole("button", { name: /^Title Source:/ });
      await trigger.click();
      await page.getByRole("option", { name: which === "agent" ? /^Agent/ : /^Custom Endpoint/ }).click();
      const dialog = which === "agent" ? agentDialog(page) : endpointDialog(page);
      await expect(dialog).toBeVisible();
      await dialogMotionSettled(page);

      const sheet = await page.locator(".modal").boundingBox();
      expect(sheet?.width).toBe(390);
      expect(Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0))).toBe(844);

      const heights = await dialog.locator(".modal-body input, .modal-body .field button[aria-haspopup]")
        .evaluateAll((controls) => controls.map((control) => Math.round(control.getBoundingClientRect().height)));
      expect(heights.length).toBeGreaterThan(0);
      for (const height of heights) expect(height).toBe(44);

      const buttons = await dialog.locator(".modal-foot > .btn").evaluateAll((items) =>
        items.map((item) => { const box = item.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; }));
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toEqual(buttons[1]);
      expect(buttons[0]![1]).toBe(48);

      // A placeholder is whole when its text fits the field's content box.
      expect(await cutPlaceholders(dialog)).toEqual([]);
      if (which === "endpoint") {
        await dialog.getByLabel("Timeout").fill("30000");
        await expectNumberFieldsWhole(page, dialog, "30000 whole beside ms in the sheet");
      }
    });
  }
});

test("a narrow window's 16px fields still show the longest timeout whole", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openSavedEndpoint(page, "source=endpoint");
  await dialog.getByLabel("Timeout").fill("30000");
  await dialogMotionSettled(page);
  // 16px digits beside a unit take the shared 120px field (§8.3).
  expect((await numberFields(dialog).boundingBox())?.width).toBe(120);
  await expectNumberFieldsWhole(page, dialog, "30000 whole beside ms at 16px");
});

test("a dropped connection is a plain load-failure notice with Retry", async ({ page }) => {
  await page.goto(`${PAGE}?fail=load`);
  const notice = group(page).getByRole("alert");
  await expect(notice).toContainText("Couldn't load session title settings. Check the connection, then try again.");
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText(/Failed to fetch|Load Failed/)).toHaveCount(0);
});

test.describe("evidence", () => {
  test.skip(!EVIDENCE, "set SESSION_TITLES_EVIDENCE=1 to capture the issue's UI evidence");

  for (const theme of ["dark", "light"] as const) {
    for (const width of [1440, 390] as const) {
      test(`every Session Titles state at ${width}px in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const at = (query: string) => page.goto(`${PAGE}?theme=${theme}&${query}`);
        const shot = async (name: string, locator?: Locator) => {
          if (locator) await locator.scrollIntoViewIfNeeded();
          await capture(page, `${name}-${width}-${theme}`, testInfo);
        };
        for (const source of ["first", "agent", "endpoint", "follow", "unavailable"]) {
          await at(`source=${source}`);
          await expect(group(page).getByRole("button", { name: /^Title Source:/ })).not.toHaveAttribute("aria-disabled", "true");
          await shot(`group-${source}`, group(page));
        }
        await at("viewer&source=agent");
        await expect(group(page).getByText("Only an organization owner or admin can change this.")).toBeVisible();
        await shot("group-viewer", group(page));
        await at("fail=load");
        await expect(group(page).getByRole("alert")).toBeVisible();
        await shot("group-load-failure", group(page));

        await at("source=agent");
        await group(page).getByRole("button", { name: /^Edit…/ }).click();
        await expect(agentDialog(page)).toBeVisible();
        await shot("agent-dialog");

        await at("source=first");
        await group(page).getByRole("button", { name: /^Title Source:/ }).click();
        await page.getByRole("option", { name: /^Custom Endpoint/ }).click();
        const dialog = endpointDialog(page);
        await expect(dialog).toBeVisible();
        await shot("endpoint-dialog-new");
        await dialog.getByLabel("Endpoint URL").fill("not a url");
        await dialog.getByLabel("Timeout").fill("10");
        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByText("Enter a full URL, starting with https://.")).toBeVisible();
        await shot("endpoint-dialog-errors");

        await at("source=endpoint-key&fail=save");
        await group(page).getByRole("button", { name: /^Edit…/ }).click();
        await expect(endpointDialog(page)).toBeVisible();
        await shot("endpoint-dialog-saved-key");
        await endpointDialog(page).getByLabel("Endpoint URL").fill("https://titles.example.com/v1/chat/completions");
        await endpointDialog(page).getByRole("button", { name: "Save" }).click();
        await expect(endpointDialog(page).getByRole("alert")).toBeVisible();
        await shot("endpoint-dialog-save-failure");
        await endpointDialog(page).getByRole("button", { name: "Delete…" }).click();
        await expect(page.getByRole("dialog", { name: "Delete API Key" })).toBeVisible();
        await shot("delete-key-confirmation");
      });
    }
  }
});
