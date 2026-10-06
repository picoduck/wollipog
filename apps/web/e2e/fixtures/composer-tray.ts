import { expect, type Page } from "@playwright/test";
import { DECODABLE_PNG_BASE64 } from "./prompt-image.js";

/** The line reference's fingerprint; its first twelve characters are what the dialog shows. */
export const TRAY_REFERENCE_FINGERPRINT = "3f9a2c71d04e".padEnd(64, "0");

/** The tray's line reference, src/session.ts:18-21, as a draft attachment. */
export const TRAY_REFERENCE = {
  artifactId: "workspace:lines", mimeType: "application/vnd.wollipog.workspace-reference+json", sizeBytes: 0,
  sha256: TRAY_REFERENCE_FINGERPRINT, referenceVersion: 1, kind: "lines", path: "src/session.ts",
  rootFingerprint: "b".repeat(64), targetFingerprint: TRAY_REFERENCE_FINGERPRINT, startLine: 18, endLine: 21,
} as const;

/** The tray's image, as a draft attachment. */
export const TRAY_IMAGE = { mimeType: "image/png", data: DECODABLE_PNG_BASE64 } as const;

/**
 * Opens Alpha Session in the project inbox harness with a line reference (src/session.ts:18-21)
 * between two images, left in the session's draft, as the composer's attachment tray shows it (#2177).
 * `referenceOnly` leaves the reference alone in the draft.
 */
export async function openSessionWithTray(page: Page, { referenceOnly = false } = {}) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(async ({ image, reference, referenceOnly }) => {
    await window.__WOLLIPOG_PROJECT_INBOX_E2E__.seedComposerDraft("session-alpha", "",
      (referenceOnly ? [reference] : [image, reference, image]) as never);
  }, { image: TRAY_IMAGE, reference: TRAY_REFERENCE, referenceOnly });
  // A session already open read its draft before the seed; a reload reads the stored one.
  await page.reload();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], [], { supportsImages: true }));
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-attachments")).toBeVisible();
}
