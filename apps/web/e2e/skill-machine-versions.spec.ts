import { expect, test } from "@playwright/test";
test.use({ video: "on" });
const old = { id: "v0", digest: "b".repeat(64), files: [{ path: "SKILL.md", encoding: "utf8", content: "Original instructions" }] };
const latest = { id: "v1", digest: "a".repeat(64), files: [{ path: "SKILL.md", encoding: "utf8", content: "Updated instructions" }] };
for (const width of [1280, 320]) for (const theme of ["dark", "light"]) {
  test(`machine-wide pin and track latest at ${width} in ${theme}`, async ({ page }, info) => {
    let policy: { versionId: string | null; revision: string } | null = null;
    let writes = 0;
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: { versions: [old, latest], nextCursor: null } }));
    await page.route("**/api/skills/skill-1/machines/runner-1/version*", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        expect(body).toEqual({ versionId: writes === 0 ? "v0" : null, expectedRevision: policy?.revision ?? null, expectedLatestVersionId: "v1" });
        policy = { versionId: body.versionId, revision: `rev${++writes}` };
        await route.fulfill({ json: { policy } });
      } else await route.fulfill({ json: { policy, currentVersion: policy?.versionId ? old : latest, proposedVersion: route.request().url().includes("versionId=v0") ? old : latest, expectedLatestVersionId: "v1" } });
    });
    await page.goto("/skills-removals-e2e.html");
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await page.getByRole("button", { name: /code-review/i }).click();
    await page.getByRole("button", { name: "Machine Versions", exact: true }).click();
    await page.getByRole("button", { name: /^Version Policy:/ }).click();
    await page.getByRole("option", { name: /Pin v0/ }).click();
    await page.getByRole("button", { name: "Preview Version Policy" }).click();
    await expect(page.getByRole("heading", { name: "Version Policy Preview" })).toBeVisible();
    await page.getByText("SKILL.md", { exact: true }).click();
    await expect(page.getByText("Original instructions", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Version Policy" })).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`pins-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("checkbox", { name: "Accept Files and Machine-Wide Version Policy" }).check();
    await page.getByRole("button", { name: "Save Version Policy" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Version policy saved" })).toBeVisible();
    await page.getByRole("button", { name: /^Version Policy:/ }).click();
    await page.getByRole("option", { name: "Track Latest", exact: true }).click();
    await page.getByRole("button", { name: "Preview Version Policy" }).click();
    await expect(page.getByText("Current policy: pinned to v0.")).toBeVisible();
    await page.getByRole("checkbox", { name: "Accept Files and Machine-Wide Version Policy" }).check();
    await page.getByRole("button", { name: "Save Version Policy" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Version policy saved" })).toBeVisible();
    expect(writes).toBe(2);
  });
}
test("a stale machine policy requires a fresh preview", async ({ page }) => {
  await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: { versions: [old], nextCursor: null } }));
  await page.route("**/api/skills/skill-1/machines/runner-1/version*", (route) => route.request().method() === "PUT" ? route.fulfill({ status: 409, json: { error: "The library or machine version policy changed. Preview again." } }) : route.fulfill({ json: { policy: null, currentVersion: latest, proposedVersion: latest, expectedLatestVersionId: "v1" } }));
  await page.goto("/skills-removals-e2e.html");
  await page.getByRole("button", { name: /code-review/i }).click();
  await page.getByRole("button", { name: "Machine Versions", exact: true }).click();
  await page.getByRole("button", { name: "Preview Version Policy" }).click();
  await page.getByRole("checkbox", { name: "Accept Files and Machine-Wide Version Policy" }).check();
  await page.getByRole("button", { name: "Save Version Policy" }).click();
  await expect(page.getByRole("alert")).toContainText("Preview again");
  await expect(page.getByRole("button", { name: "Save Version Policy" })).toBeDisabled();
});
