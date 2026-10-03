import { expect, type Page } from "@playwright/test";
import { DECODABLE_PNG_BASE64 } from "./prompt-image.js";

/** The line reference's fingerprint; its first twelve characters are what the dialog shows. */
export const TRAY_REFERENCE_FINGERPRINT = "3f9a2c71d04e".padEnd(64, "0");

/**
 * Opens Alpha Session in the project inbox harness with a line reference (src/session.ts:18-21)
 * between two images, left in the session's draft, as the composer's attachment tray shows it (#2177).
 */
export async function openSessionWithTray(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(async ({ png, fingerprint }) => {
    await window.__WOLLIPOG_PROJECT_INBOX_E2E__.seedComposerDraft("session-alpha", "", [
      { mimeType: "image/png", data: png },
      {
        artifactId: "workspace:lines", mimeType: "application/vnd.wollipog.workspace-reference+json", sizeBytes: 0,
        sha256: fingerprint, referenceVersion: 1, kind: "lines", path: "src/session.ts",
        rootFingerprint: "b".repeat(64), targetFingerprint: fingerprint, startLine: 18, endLine: 21,
      } as never,
      { mimeType: "image/png", data: png },
    ]);
  }, { png: DECODABLE_PNG_BASE64, fingerprint: TRAY_REFERENCE_FINGERPRINT });
  // A session already open read its draft before the seed; a reload reads the stored one.
  await page.reload();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], [], { supportsImages: true }));
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-attachments")).toBeVisible();
}
