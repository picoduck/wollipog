import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

// A busy account can be waited for, runner-side, and a waiting session says so (#3240).
const cases = [
  {
    name: "wait-offered",
    query: "lease-refusal=busy&lease-wait-capable",
    title: "Account in Use",
    actions: ["Wait for Account", "Switch Account…"],
  },
  {
    name: "wait-offered-cause",
    query: "lease-refusal=busy&lease-cause=holder_alive&lease-wait-capable",
    title: "Account in Use",
    actions: ["Wait for Account", "Switch Account…"],
  },
  {
    name: "wait-offered-machine-home",
    query: "lease-refusal=busy&lease-refusal-account=none&lease-wait-capable",
    title: "Account in Use",
    actions: ["Wait for Account", "Open Machine Accounts"],
  },
  {
    name: "waiting",
    query: "lease-wait=holder_alive",
    title: "Waiting for Account",
    actions: ["Stop Waiting"],
  },
] as const;

for (const width of [390, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`a busy account can be waited for at ${width}px in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const item of cases) {
      await page.goto(`/session-usage-e2e.html?driver=claude-code&width=${width}&height=844&${item.query}`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const notice = page.getByRole("status", { name: item.title });
      await expect(notice).toBeVisible();
      expect((await notice.boundingBox())!.width).toBeLessThanOrEqual(width);
      // Phones keep one action row: nothing may overflow the notice.
      expect(await notice.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      await expect(notice.locator(".notice-actions button")).toHaveText([...item.actions]);
      for (const name of item.actions) await expect(notice.getByRole("button", { name })).toBeEnabled();
      if (item.name === "waiting") {
        await expect(notice).toContainText("Another Wollipog runner is using Work Account. This session starts as soon as it's free.");
      }
      if (evidenceDir) {
        await page.screenshot({ path: join(evidenceDir, `${item.name}-${width}-${theme}.png`), fullPage: true });
      }
    }
  });
}
