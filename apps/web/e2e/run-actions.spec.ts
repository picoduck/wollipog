import { expect, test, type Page } from "@playwright/test";

/**
 * A comparison run's Follow Up… dialog (#2976; docs/design-system.md §7.3, §7.5) in a real browser:
 * with an empty message, Send is disabled and its reason, "Write a message to send.", shows in the
 * footer beside it at 1440px and in the phone sheet's footer at 390px, inside the viewport with
 * both buttons whole.
 */

async function openFollowUp(page: Page) {
  await page.goto("/run-compare-e2e.html?run=running");
  await expect(page.getByRole("heading", { level: 1, name: "Index session search across machines" })).toBeVisible();
  await page.getByRole("button", { name: "Follow Up…" }).click();
  const dialog = page.getByRole("dialog", { name: "Follow Up" });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("an empty message disables Send and the footer says why", async ({ page }) => {
      const dialog = await openFollowUp(page);
      await expect(dialog.getByRole("textbox", { name: "Message" })).toBeFocused();
      const send = dialog.getByRole("button", { name: "Send to 2 Agents" });
      await expect(send).toBeDisabled();
      const reason = dialog.locator(".modal-foot > .run-follow-up-reason");
      await expect(reason).toHaveText("Write a message to send.");
      await expect(reason).toBeInViewport({ ratio: 1 });
      await expect(send).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 });
      // The reason sits beside the buttons on desktop and on its own row above them on a phone.
      const [reasonBox, sendBox] = await Promise.all([reason.boundingBox(), send.boundingBox()]);
      if (viewport.width < 760) expect(reasonBox!.y + reasonBox!.height).toBeLessThanOrEqual(sendBox!.y + 1);
      else expect(reasonBox!.x + reasonBox!.width).toBeLessThanOrEqual(sendBox!.x);

      await dialog.getByRole("textbox", { name: "Message" }).fill("Also rank exact path matches first.");
      await expect(reason).toHaveCount(0);
      await expect(send).toBeEnabled();
    });
  });
}
