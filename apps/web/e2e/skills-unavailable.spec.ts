import { expect, test, type Page } from "@playwright/test";

/**
 * #1695: container and cloud targets mount only the workspace, so the Machine's managed skills are
 * absent there. The session says so, the New Session dialog stops claiming otherwise, and host
 * sessions are unchanged.
 */

const UNAVAILABLE = /Managed skills from this Machine are unavailable on container and cloud targets/u;

async function openSession(page: Page, target: "host" | "container" | "cloud") {
  await page.goto(`/skills-unavailable-e2e.html?target=${target}`);
  await expect(page.getByRole("heading", { name: /Skills on a/u }).first()).toBeVisible();
}

for (const target of ["container", "cloud"] as const) {
  test(`a ${target} session shows its assigned skills as unavailable`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await openSession(page, target);
    const notice = page.getByRole("status", { name: "Skills Unavailable on This Target" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(UNAVAILABLE);
    await expect(notice).toContainText("2 Assigned Skills: release-notes, review-pr");
    const frame = await page.locator("#frame").boundingBox();
    const box = await notice.boundingBox();
    expect(box && frame && box.x >= frame.x && box.x + box.width <= frame.x + frame.width).toBe(true);
    await page.screenshot({ path: `test-results/skills-unavailable/session-${target}.png` });
  });
}

test("a host session neither requests skills nor shows the notice", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openSession(page, "host");
  await expect(page.getByRole("status", { name: "Skills Unavailable on This Target" })).toHaveCount(0);
  expect(await page.evaluate(() => document.body.dataset.runnerSkillsRequests)).toBeUndefined();
  await page.screenshot({ path: "test-results/skills-unavailable/session-host.png" });
});

test("a phone-width container session keeps the notice inside the pane", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/skills-unavailable-e2e.html?target=container&width=390&height=780");
  const notice = page.getByRole("status", { name: "Skills Unavailable on This Target" });
  await expect(notice).toBeVisible();
  const box = await notice.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  await page.screenshot({ path: "test-results/skills-unavailable/session-container-phone.png" });
});

test("the New Session dialog says skills are unavailable only for a container target", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/new-session-choices-e2e.html?containerTargets=1");
  await expect(page.getByRole("heading", { name: "New Session" })).toBeVisible();
  await expect(page.getByText(UNAVAILABLE)).toHaveCount(0);
  await page.screenshot({ path: "test-results/skills-unavailable/new-session-host.png", fullPage: true });

  await page.getByRole("button", { name: /Execution Target/u }).click();
  await page.getByRole("option", { name: /Offline Container/u }).click();
  await expect(page.getByText(UNAVAILABLE).first()).toBeVisible();
  await page.screenshot({ path: "test-results/skills-unavailable/new-session-container.png", fullPage: true });
});
