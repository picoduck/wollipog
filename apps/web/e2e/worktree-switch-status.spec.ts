import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

// While the runner relaunches a session in the worktree it switched to, the session reads Switching
// Worktree instead of Awaiting Prompt or Starting, and says which worktree (#3810).
const cases = [
  { phase: "pending", description: "The session is about to relaunch in worktree fix/issue-3810-switching-worktree-status." },
  { phase: "relaunching", description: "The session is relaunching in worktree fix/issue-3810-switching-worktree-status." },
] as const;

for (const width of [390, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`a switching session shows Switching Worktree at ${width}px in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const item of cases) {
      await page.goto(`/session-usage-e2e.html?driver=claude-code&width=${width}&height=844&worktree-switch=${item.phase}`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const status = page.getByRole("button", { name: "Session Status: Switching Worktree", exact: true });
      await expect(status).toBeVisible();
      await expect(status).toContainText("Switching Worktree");
      expect((await status.boundingBox())!.width).toBeLessThanOrEqual(width);
      await status.click();
      const popover = page.getByRole("dialog", { name: "Session Status" });
      await expect(popover).toBeVisible();
      await expect(popover).toContainText(item.description);
      // Capture the settled popover, not a frame of its opening transition.
      await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === "running" &&
        animation.effect?.getComputedTiming().iterations !== Infinity));
      if (evidenceDir) {
        await page.screenshot({ path: join(evidenceDir, `worktree-switch-${item.phase}-${width}-${theme}.png`), fullPage: true });
      }
      await page.keyboard.press("Escape");
    }
  });
}
