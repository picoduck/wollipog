import { expect, test } from "@playwright/test";

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

test("a refused line selector is disabled, and its reason is its tooltip and description", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/diff-discard-e2e.html?pane=unstaged&refused=1");
  const reason = "Viewers can read this session's changes but cannot stage them.";
  for (const name of ["Select Added Line 19", "Select Removed Line 19"]) {
    const box = page.getByRole("checkbox", { name });
    await expect(box).toBeDisabled();
    await expect(box).toHaveAttribute("title", reason);
    await expect(box).toHaveAccessibleDescription(reason);
  }
});
