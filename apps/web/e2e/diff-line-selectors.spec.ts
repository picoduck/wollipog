import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2044: the diff's per-line selectors are the shared Checkbox, drawn with the same 16px marker as
 * the prompt-line box beside them, and a refused line still says why through its tooltip and its
 * accessible description.
 */

for (const layout of ["unified", "split"] as const) {
  test(`line selectors are the shared 16px marker with Title Case names (${layout})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/diff-discard-e2e.html?pane=unstaged&references=1&layout=${layout}`);
    const added = page.getByRole("checkbox", { name: "Select Added Line 19" });
    const removed = page.getByRole("checkbox", { name: "Select Removed Line 19" });
    const reference = page.getByRole("checkbox", { name: "Select Worktree Line 19 for Prompt" });
    for (const box of [added, removed, reference]) {
      await expect(box).toBeEnabled();
      const size = await box.evaluate((input) => {
        const rect = input.getBoundingClientRect();
        return { width: rect.width, height: rect.height, mark: input.parentElement!.classList.contains("checkbox-mark") };
      });
      expect(size).toEqual({ width: 16, height: 16, mark: true });
    }
    await added.check();
    await expect(added).toBeChecked();
    await expect(page.getByRole("button", { name: "Stage Selected (1)" })).toBeEnabled();
  });
}

for (const query of ["pane=unstaged", "pane=unstaged&references=1", "pane=unstaged&layout=split"]) {
  test(`a row with boxes is as tall as one without, and each box is centred on its line (${query})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/diff-discard-e2e.html?${query}`);
    const rows = await page.locator(".diff-line, .diff-split-cell").evaluateAll((elements) => elements.map((row) => {
      const text = row.querySelector(".diff-text")!.getBoundingClientRect();
      return {
        height: row.getBoundingClientRect().height,
        boxes: [...row.querySelectorAll(".diff-line-select input")].map((input) => {
          const box = input.getBoundingClientRect();
          return box.top + box.height / 2 - (text.top + text.height / 2);
        }),
      };
    }));
    // Not vacuous: some rows carry a box and the context row carries none, or the reference box only.
    expect(rows.some((row) => row.boxes.length > 0)).toBe(true);
    expect(new Set(rows.map((row) => row.height)).size, "every row is one line tall").toBe(1);
    for (const offset of rows.flatMap((row) => row.boxes)) expect(Math.abs(offset)).toBeLessThanOrEqual(0.5);
  });
}

/** The §8.4 marker paint (fill and edge) a Checkbox takes enabled and disabled, resolved in this theme. */
async function markerPaint(page: Page) {
  return page.evaluate(() => {
    const resolve = (fill: string, edge: string) => {
      const probe = document.createElement("div");
      probe.style.background = fill;
      probe.style.border = `1px solid ${edge}`;
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const paint = { background: style.backgroundColor, border: style.borderTopColor };
      probe.remove();
      return paint;
    };
    return {
      enabled: resolve("var(--field-bg)", "var(--control-outline)"),
      disabled: resolve("var(--bg-elev-3)", "var(--text-faint)"),
    };
  });
}

const paintOf = (box: Locator) => box.evaluate((input) => {
  const style = getComputedStyle(input);
  return { background: style.backgroundColor, border: style.borderTopColor };
});

for (const layout of ["unified", "split"] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`a refused line selector is disabled, reads as disabled, and says why (${layout}, ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const reason = "Viewers can read this session's changes but cannot stage them.";
      await page.goto(`/diff-discard-e2e.html?pane=unstaged&refused=1&layout=${layout}&theme=${theme}`);
      const paint = await markerPaint(page);
      expect(paint.disabled, "the two looks differ in this theme").not.toEqual(paint.enabled);
      for (const name of ["Select Added Line 19", "Select Removed Line 19"]) {
        const box = page.getByRole("checkbox", { name });
        await expect(box).toBeDisabled();
        expect(await paintOf(box), `${name} takes the disabled marker paint`).toEqual(paint.disabled);
        await expect(box).toHaveAttribute("title", reason);
        await expect(box).toHaveAccessibleDescription(reason);
      }

      // Without the refusal, both changed lines stay selectable and look it: a removed line is
      // stageable, so its box is enabled exactly like the added line's.
      await page.goto(`/diff-discard-e2e.html?pane=unstaged&layout=${layout}&theme=${theme}`);
      for (const name of ["Select Added Line 19", "Select Removed Line 19"]) {
        const box = page.getByRole("checkbox", { name });
        await expect(box).toBeEnabled();
        expect(await paintOf(box), `${name} takes the enabled marker paint`).toEqual(paint.enabled);
      }
    });
  }
}
