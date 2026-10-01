import { expect, test } from "@playwright/test";

/** #1981: a skill's page lists only its own link removals, under the machine that reported them; the
 * machine's whole history and its unmanaged skills are in Connections (machine-skills.spec.ts). */

async function openSkill(page: import("@playwright/test").Page, width: number, query = "") {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/skills-removals-e2e.html${query}`);
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  const machine = page.locator("table.skill-deployment").getByRole("rowgroup", { name: "Build Machine", exact: true });
  await expect(machine).toBeVisible();
  return machine;
}

test("a skill lists only its own link removals, and never another skill's", async ({ page }) => {
  const machine = await openSkill(page, 1280);
  await expect(machine).toContainText("Removed ~/.claude/skills/code-review: The canonical location it routes through is conflicted.");
  const deployment = page.getByRole("region", { name: "Deployment", exact: true });
  await expect(deployment).not.toContainText("retired-skill-with-a-long-name");
  await expect(deployment).not.toContainText("conflicted-canonical-skill");
  await expect(page.getByRole("heading", { name: "Recent Link Removals" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Unmanaged Skills" })).toHaveCount(0);
});

test("the Deployment section has no horizontal overflow on a phone", async ({ page }) => {
  await openSkill(page, 320);
  const geometry = await page.locator(".page").evaluate((view) => ({
    viewRight: view.getBoundingClientRect().right,
    tableRight: view.querySelector("table.skill-deployment")!.getBoundingClientRect().right,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(geometry.tableRight).toBeLessThanOrEqual(geometry.viewRight + 0.5);
  expect(geometry.documentWidth).toBe(geometry.viewportWidth);
});

test("a healthy long-running manual sync remains visibly in progress", async ({ page }) => {
  const machine = await openSkill(page, 1280);
  const sync = machine.getByRole("button", { name: "Sync Now", exact: true });
  await sync.click();
  await expect(sync).toHaveAttribute("aria-busy", "true");
  await page.waitForTimeout(350);
  await expect(sync).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(sync).not.toHaveAttribute("aria-busy", "true", { timeout: 2_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("account-scoped outcomes identify the credential home without exposing opaque ids or paths", async ({ page }) => {
  const machine = await openSkill(page, 1280, "?accountScopes=1");
  const claude = machine.locator("tr.skill-deployment-agent", { hasText: "Claude" });
  await expect(claude.locator(".cell-status")).toHaveText("Error");
  await expect(claude).toContainText("Personal Account: A local directory blocks this link.");
  await expect(machine).toContainText("Removed ~/.claude/skills/code-review (Work Account):");
  await expect(machine).not.toContainText("acct-work");
  await expect(machine).not.toContainText("acct-personal");
  await expect(machine).not.toContainText("/credential-home/");
});
