import { devices, expect, test, type Page } from "@playwright/test";

const OWNER = "owner@example.com";
const NEXT_OWNER = "next.owner@example.net";
const MEMBER = "pat@example.org";
const EMAILS = [OWNER, NEXT_OWNER, MEMBER] as const;

async function expectNoEmailLeak(page: Page): Promise<void> {
  const markup = await page.locator("body").evaluate((body) => body.outerHTML);
  for (const email of EMAILS) expect(markup).not.toContain(email);
}

for (const formFactor of ["desktop", "phone"] as const) {
  test.describe(formFactor, () => {
    const phone = devices["Pixel 7"];
    test.use(formFactor === "phone" ? {
      viewport: phone.viewport,
      hasTouch: phone.hasTouch,
      isMobile: phone.isMobile,
      userAgent: phone.userAgent,
      deviceScaleFactor: phone.deviceScaleFactor,
      screen: phone.screen,
    } : { viewport: { width: 1280, height: 900 } });

  test(`People & Devices masks names across rendered ${formFactor} surfaces until reveal (#1667)`, async ({ page }) => {
    await page.goto("/people-devices-e2e.html");
    await expect(page.getByRole("heading", { name: "People & Devices" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Paired Devices" })).toBeVisible();
    await expectNoEmailLeak(page);

    const context = page.locator(".access-context");
    const people = page.getByRole("region", { name: "People" });
    const devices = page.getByRole("region", { name: "Paired Devices" });
    const contextReveal = context.getByRole("button", { name: "Show Your Name" });
    await expect(contextReveal).toHaveAttribute("title", "Show Your Name");
    await contextReveal.click();
    await expect(context).toContainText(OWNER);
    await expect(people).not.toContainText(OWNER);
    await context.getByRole("button", { name: "Hide Your Name" }).click();
    await expectNoEmailLeak(page);

    const memberRow = people.locator(".access-row").last();
    const personReveal = memberRow.getByRole("button", { name: "Show Person Name" });
    await expect(personReveal).toHaveAttribute("title", "Show Person Name");
    await personReveal.click();
    await expect(memberRow).toContainText(MEMBER);
    await expect(devices).not.toContainText(MEMBER);
    await memberRow.getByRole("button", { name: "Hide Person Name" }).click();
    await expectNoEmailLeak(page);

    const deviceReveal = devices.getByRole("button", { name: "Show Person Name" });
    await expect(deviceReveal).toHaveAttribute("title", "Show Person Name");
    await deviceReveal.click();
    await expect(devices).toContainText(MEMBER);
    await devices.getByRole("button", { name: "Hide Person Name" }).click();
    await expectNoEmailLeak(page);

    await memberRow.getByRole("button", { name: "Manage", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Manage Person" });
    await expect(dialog).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Name" }).click();
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(MEMBER);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await memberRow.getByRole("button", { name: "Manage", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Manage Person" });
    await expect(dialog.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Pair Device" }).click();
    dialog = page.getByRole("dialog", { name: "Who is this device for?" });
    await expect(dialog.getByRole("radiogroup", { name: "Person" }).getByRole("radio")).toHaveCount(2);
    await expect(dialog.getByRole("radio", { name: /Hidden Name 1/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Hidden Name 2/ })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Names" }).click();
    await expect(dialog).toContainText(OWNER);
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("radio", { name: /pat@example\.org/ }).check();
    await dialog.getByRole("button", { name: "Continue" }).click();
    dialog = page.getByRole("dialog", { name: "Name the device" });
    await expect(dialog.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Name" }).click();
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Hide Person Name" }).click();
    await expectNoEmailLeak(page);
    await dialog.getByRole("textbox", { name: "Device Name" }).fill("Pat's Tablet");
    await dialog.getByRole("button", { name: "Create Pairing" }).click();
    dialog = page.getByRole("dialog", { name: "Device Ready to Pair" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Show Person Name" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Name" }).click();
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Pair Device" }).click();
    dialog = page.getByRole("dialog", { name: "Who is this device for?" });
    await expect(dialog.getByRole("button", { name: "Show Person Names" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const teamRow = page.getByRole("region", { name: "Teams" }).locator(".access-row").first();
    await teamRow.getByRole("button", { name: "Manage" }).click();
    dialog = page.getByRole("dialog", { name: "Manage Support" });
    await expect(dialog.getByRole("checkbox", { name: /Hidden Name 1/ })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Hidden Name 2/ })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Names" }).click();
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Create Team" }).click();
    dialog = page.getByRole("dialog", { name: "Create a Team" });
    await expect(dialog.getByRole("checkbox", { name: /Hidden Name 1/ })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Hidden Name 2/ })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Show Person Names" }).click();
    await expect(dialog).toContainText(OWNER);
    await expect(dialog).toContainText(MEMBER);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Create Team" }).click();
    dialog = page.getByRole("dialog", { name: "Create a Team" });
    await expect(dialog.getByRole("button", { name: "Show Person Names" })).toBeVisible();
    await expectNoEmailLeak(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await context.getByRole("button", { name: "Show Your Name" }).click();
    await expect(context).toContainText(OWNER);
    await page.evaluate((target) => {
      const leaks: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.textContent?.includes(target)) leaks.push("added text");
          }
          if (record.type === "characterData" && record.target.textContent?.includes(target)) leaks.push("changed text");
          if (record.type === "attributes" && record.target instanceof Element && record.attributeName
            && record.target.getAttribute(record.attributeName)?.includes(target)) leaks.push(record.attributeName);
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      (window as typeof window & { takeIdentifierLeaks?: () => string[] }).takeIdentifierLeaks = () => {
        observer.disconnect();
        return leaks;
      };
    }, NEXT_OWNER);
    await page.getByRole("button", { name: "Change Identity" }).click();
    await expect(context.getByRole("button", { name: "Show Your Name" })).toBeVisible();
    await expectNoEmailLeak(page);
    expect(await page.evaluate(() => (window as typeof window & { takeIdentifierLeaks?: () => string[] })
      .takeIdentifierLeaks?.())).toEqual([]);
    await context.getByRole("button", { name: "Show Your Name" }).click();
    await expect(context).toContainText(NEXT_OWNER);
    await page.getByRole("tab", { name: "Machines" }).click();
    await page.getByRole("tab", { name: "People & Devices" }).click();
    await expect(context.getByRole("button", { name: "Show Your Name" })).toBeVisible();
    await expectNoEmailLeak(page);
  });
  });
}
