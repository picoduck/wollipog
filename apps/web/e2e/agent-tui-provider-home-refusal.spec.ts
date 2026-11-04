import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

// An Agent TUI its provider account's lease refused shows the session's state for the refusal, not a
// Terminal Error in the runner's words (#3338).
const cases = [
  {
    name: "busy",
    query: "lease=busy",
    text: "Another runner, provider, helper, or lease publication is using Work Account, so the Agent TUI didn't open. " +
      "Try again once it's free, or switch the session to another account.",
  },
  {
    name: "profile-not-granted",
    query: "lease=profile_not_granted",
    text: "The provider profile of Work Account isn't granted to this control plane. " +
      "An Owner or Admin can grant it with Recover Existing Profile.",
  },
  {
    name: "busy-machine-home",
    query: "lease=busy&lease-account=none",
    text: "Another runner, provider, helper, or lease publication is using this Machine's Claude sign-in, so the Agent TUI didn't open. " +
      "Try again once it's free.",
  },
] as const;

for (const width of [390, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`a refused Agent TUI explains its account at ${width}px in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const item of cases) {
      await page.goto(`/shell-dock-e2e.html?tui=refused&theme=${theme}&${item.query}`);
      const dock = page.getByRole("region", { name: "Terminal" });
      await expect(dock.getByRole("tab")).not.toHaveCount(0);
      await dock.getByRole("button", { name: "New Tab" }).click();
      await page.getByRole("menu", { name: "New Tab" }).getByRole("menuitem", { name: "New Agent TUI" }).click();
      const notice = dock.getByRole("status").filter({ hasText: "Agent TUI didn't open" }).or(
        dock.getByRole("status").filter({ hasText: "isn't granted" }));
      await expect(notice).toHaveText(item.text);
      await expect(dock.getByRole("alert")).toHaveCount(0);
      await expect(dock).not.toContainText("Terminal Error");
      await expect(dock).not.toContainText("provider-HOME lease refused");
      await expect(dock.getByRole("tab", { name: /Agent TUI/ })).toHaveCount(0);
      expect(await notice.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      if (evidenceDir) {
        await page.screenshot({ path: join(evidenceDir, `agent-tui-refusal-${item.name}-${width}-${theme}.png`), fullPage: true });
      }
      await notice.getByRole("button", { name: "Dismiss Error" }).click();
      await expect(notice).toHaveCount(0);
    }
  });
}
