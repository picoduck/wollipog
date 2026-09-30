import { test, type Page } from "@playwright/test";

// Local evidence capture for #2044; never committed.
const OUT = process.env.EVIDENCE_DIR ?? "/tmp/evidence-2044/after";

/** A native `title` tooltip is not painted into a screenshot, so draw its text, read from the DOM. */
async function showTitle(page: Page, name: string) {
  await page.getByRole("checkbox", { name }).evaluate((input) => {
    const rect = input.getBoundingClientRect();
    const tip = document.createElement("div");
    tip.textContent = `title: ${input.getAttribute("title") ?? "(none)"} · described by: ${
      (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent).join(" ") || "(none)"}`;
    Object.assign(tip.style, {
      position: "absolute", left: `${rect.left + window.scrollX}px`, top: `${rect.bottom + window.scrollY + 6}px`,
      maxWidth: "340px", padding: "4px 8px", font: "12px Arial", background: "#ffffe1", color: "#000",
      border: "1px solid #767676", zIndex: "9999", whiteSpace: "normal",
    });
    document.body.append(tip);
  });
}

test.describe("coarse 390", () => {
  test.use({ viewport: { width: 390, height: 1100 }, hasTouch: true });
  for (const theme of ["dark", "light"] as const) {
    test(`checkbox wrapped label ${theme}`, async ({ page }) => {
      await page.goto(`/choice-rows-e2e.html?theme=${theme}`);
      await page.locator('[data-group="checks"]').screenshot({ path: `${OUT}/checkbox-wrap-390-coarse-${theme}.png` });
    });
  }
});

for (const width of [1440, 390] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`diff and findings ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const layout of ["unified", "split"] as const) {
        await page.goto(`/diff-discard-e2e.html?pane=unstaged&references=1&layout=${layout}&theme=${theme}`);
        await page.getByRole("checkbox", { name: "Select Added Line 19" }).check();
        await page.locator(".diff-hunk-lines, .diff").evaluateAll((els) => els.forEach((el) => { el.scrollLeft = 0; }));
        await page.locator(".diff-hunk").first().screenshot({ path: `${OUT}/diff-${layout}-${width}-${theme}.png` });
      }
      await page.goto(`/diff-discard-e2e.html?pane=unstaged&refused=1&theme=${theme}`);
      await showTitle(page, "Select Added Line 19");
      await page.screenshot({ path: `${OUT}/diff-refused-${width}-${theme}.png`, clip: { x: 0, y: 0, width, height: 420 } });
      await page.goto(`/forge-review-e2e.html?theme=${theme}`);
      const list = page.locator(".review-findings-list");
      await list.waitFor();
      await page.getByRole("checkbox", { name: "Select Remote Discussion" }).check();
      await list.screenshot({ path: `${OUT}/findings-${width}-${theme}.png` });
    });
  }
}
