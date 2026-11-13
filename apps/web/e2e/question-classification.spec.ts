import { expect, test } from "@playwright/test";
import { viewPath } from "../src/navigation.js";

test("Decline on the session card removes the held question", async ({ page }) => {
  await page.goto(`/command-inbox-projects-e2e.html?scenario=question-classification&fullShell=1&path=${encodeURIComponent(viewPath({ name: "session", id: "session-alpha" }))}`);
  const group = page.getByRole("group", { name: "Question Classification" });
  await group.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(group).toHaveCount(0);
  await expect(page.locator(".request-card")).toHaveCount(0);
});

for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`held question opened from Campaign Status (${device})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&screen=ask");
    await page.getByRole("button", { name: /^Open Request:/ }).click();
    const card = page.locator(".request-card").filter({ has: page.getByRole("group", { name: "Question Classification" }) });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "Shared Configuration", exact: true })).toBeDisabled();
    await page.mouse.move(viewport.width - 100, 300);
    await page.mouse.wheel(0, -10000);
    await page.screenshot({ path: testInfo.outputPath(`campaign-card-${device}-before.png`) });
    await card.getByRole("button", { name: "Let the Orchestrator Answer", exact: true }).click();
    await expect(page.getByText("The Orchestrator is handling this request.", { exact: true })).toBeVisible();
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.screenshot({ path: testInfo.outputPath(`campaign-card-${device}-after.png`) });
  });
  for (const surface of ["inbox", "session"] as const) {
    test(`held question on ${surface} (${device})`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(`/command-inbox-projects-e2e.html?scenario=question-classification&fullShell=1&sessionShell=1${surface === "session" ? `&path=${encodeURIComponent(viewPath({ name: "session", id: "session-alpha" }))}` : ""}`);
      const card = page.locator(".request-card").filter({ has: page.getByRole("group", { name: "Question Classification" }) }).first();
      if (surface === "inbox" && device === "phone") {
        const row = page.getByText("Provider Configuration", { exact: true }).first();
        await row.click();
      }
      await expect(card).toBeVisible();
      const expand = card.getByRole("button", { name: "Expand Decision", exact: true });
      if (await expand.count()) await expand.click();
      await expect(card.getByRole("button", { name: "Shared Configuration", exact: true })).toBeDisabled();
      await expect(card).toContainText("The campaign owner must classify this question first");
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, -10000);
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      await page.screenshot({ path: testInfo.outputPath(`${surface}-${device}-before.png`) });
      await card.getByRole("button", { name: "Let the Orchestrator Answer", exact: true }).click();
      await expect(page.getByText("The Orchestrator is handling this request.", { exact: true }).first()).toBeVisible();
      await page.mouse.click(20, 100);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-${device}-after.png`) });
    });
  }
}
