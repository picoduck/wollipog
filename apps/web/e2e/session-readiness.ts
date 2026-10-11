import { expect, type Page } from "@playwright/test";

/** A desktop selection first loads its preview; phones open the full session directly. */
export async function waitForSessionPreview(page: Page) {
  await expect(page.locator(".inbox-preview-skeleton")).toBeHidden();
}
