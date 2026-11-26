import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { motionSettled } from "./dialog-motion.js";
import { expectNoHorizontalOverflow } from "./layout-invariants.js";

test.use({ reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`Antigravity explains managed-worktree Auto Mode at ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date("2026-11-21T15:30:00Z"));
    const open = (state: string) => page.goto(`/transcript-states-e2e.html?scenario=antigravity&agState=${state}`);
    const evidence = process.env.WOLLIPOG_EVIDENCE_DIR;
    async function capture(state: string) {
      if (evidence) await page.screenshot({ path: join(evidence, `antigravity-worktree-auto-${state}-${size}.png`) });
    }
    const mode = page.getByRole("button", { name: /^Permission Mode:/ });
    const composer = page.locator(".composer-box");
    async function revealComposerControls() {
      if (viewport.width < 760) await composer.click();
      await expect(mode).toBeInViewport();
    }

    if (evidence) {
      await open("worktree-auto-before");
      await expect(page.getByText("Auto Mode Unavailable", { exact: true })).toBeInViewport();
      await revealComposerControls();
      await expect(mode).toHaveAccessibleName(/^Permission Mode: Default/);
      await capture("before");
    }

    await open("worktree-auto");
    const notice = page.locator(".notice").filter({ hasText: "Worktree Auto Mode" });
    await expect(notice.getByText(/remote Git operations and compound shell commands, still need approval/)).toBeInViewport();
    await expectNoHorizontalOverflow(notice, "Worktree Auto Mode notice");
    await expect(page.getByRole("button", { name: "Copy Command" })).toHaveCount(0);
    await revealComposerControls();
    await expect(mode).toHaveAccessibleName("Permission Mode: Auto Mode");
    await expect(notice).toBeInViewport();
    await capture("after");

    await mode.click();
    const menu = page.getByRole("menu", { name: "Permission Mode" });
    await motionSettled(menu);
    await expect(menu.locator('[aria-checked="true"]')).toContainText("Auto Mode");
    await expect(menu.getByText(/^Wollipog approves routine worktree actions/)).toBeInViewport();
    await expectNoHorizontalOverflow(menu, "Permission Mode menu");
    await capture("menu");
  });
}
