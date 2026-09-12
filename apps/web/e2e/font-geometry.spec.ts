import { expect, test } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";

test("pinWidestFace fails actionably when no candidate face resolves", async ({ page }) => {
  await page.setContent('<div id="scope">Font probe</div>');

  await expect(pinWidestFace(page, page.locator("#scope"), {
    candidates: [{ family: "Definitely Absent Face 8f3c1", installPackage: "fonts-wide-test" }],
  })).rejects.toThrow(/no verified wide face to measure: install fonts-wide-test/);
});
