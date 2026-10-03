import { chromium, expect } from "@playwright/test";
import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";

// Opt-in review recording, kept separate from regression tests. All data is synthetic.
const output = resolve(process.argv[2] ?? "/tmp/issue2486-artifact-evidence");
const origin = process.env.ARTIFACT_EVIDENCE_ORIGIN ?? "http://127.0.0.1:4176";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, recordVideo: { dir: output, size: { width, height: 900 } } });
      const page = await context.newPage();
      await page.addInitScript(() => {
        document.addEventListener("mousemove", (event) => {
          let pointer = document.getElementById("capture-pointer");
          if (!pointer) {
            pointer = document.createElement("div"); pointer.id = "capture-pointer";
            pointer.setAttribute("aria-hidden", "true");
            pointer.style.cssText = "position:fixed;width:12px;height:12px;border:2px solid #ffbf47;border-radius:50%;background:#2228;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 1px #222";
            document.body.append(pointer);
          }
          pointer.style.left = `${event.clientX + 8}px`; pointer.style.top = `${event.clientY + 8}px`;
        });
      });
      await page.goto(`${origin}/artifact-uploads-e2e.html?theme=${theme}`);
      const discovery = page.getByRole("note", { name: "Private Artifact Uploads" });
      await expect(discovery).toBeVisible();
      await page.screenshot({ path: `${output}/discovery-${theme}-${width}.png`, fullPage: true });
      await page.waitForTimeout(7000);
      const link = page.getByRole("link", { name: "Artifact Upload Settings" });
      await link.hover(); await page.waitForTimeout(1500); await link.click();
      const picker = page.getByRole("button", { name: /^Artifact Uploads:/ });
      await expect(picker).toHaveAccessibleName("Artifact Uploads: Manual");
      await picker.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/manual-${theme}-${width}.png`, fullPage: true });
      await page.waitForTimeout(12000);
      for (const [label, key] of [["Use Wollipog Automatically", "automatic"], ["Use External Hosting", "external"]]) {
        await picker.hover(); await page.waitForTimeout(1500); await picker.click();
        const option = page.getByRole("option", { name: label, exact: true });
        await expect(option).toBeVisible(); await option.hover(); await page.waitForTimeout(2000); await option.click();
        await expect(picker).toHaveAccessibleName(`Artifact Uploads: ${label}`);
        await page.screenshot({ path: `${output}/${key}-${theme}-${width}.png`, fullPage: true });
        await page.waitForTimeout(3000);
      }
      await page.goto(`${origin}/artifact-uploads-e2e.html?theme=${theme}`);
      await expect(discovery).toBeVisible(); await page.waitForTimeout(2500);
      const dismiss = page.getByRole("button", { name: "Dismiss Artifact Upload Notice" });
      await dismiss.hover(); await page.waitForTimeout(1500); await dismiss.click();
      await expect(discovery).toHaveCount(0); await page.waitForTimeout(4000);
      const video = page.video(); await context.close();
      await rename(await video.path(), `${output}/artifact-preferences-${theme}-${width}.webm`);
      console.log(`Captured ${theme} ${width}px`);
    }
  }
} finally { await browser.close(); }
