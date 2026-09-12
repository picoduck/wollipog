import { expect, test } from "@playwright/test";
import { installSkillMatrixFixture } from "./skill-matrix.fixture.js";
test("direct assignment errors are visible inside the open dialog", async ({ page }) => {
  await page.route("**/api/skill-assignments", route => route.fulfill({ status: 409, json: { error: "Assignment ownership rejected" } }));
  await page.goto("/skills-removals-e2e.html");
  await page.getByRole("button", { name: /code-review/i }).click();
  await page.getByRole("button", { name: "Add Assignment", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Add Assignment", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Assignment ownership rejected");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Add Assignment", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
});
test("version picker explains when no compatible machines exist", async ({ page }) => {
  await page.goto("/skills-removals-e2e.html?legacySkills=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  await page.getByRole("button", { name: "Machine Versions", exact: true }).click();
  await expect(page.getByText(/No compatible machines are available/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview Version Policy" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save Version Policy" })).toBeDisabled();
});
test("capable Windows machines offer WSL agents for direct assignment", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.goto("/skills-removals-e2e.html?matrix=1&wslSkills=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  const matrix = page.getByRole("region", { name: "Machine × Agents", exact: true });
  await expect(matrix.getByRole("row", { name: /^WSL Codex / }).first())
    .toHaveAccessibleName(/^WSL Codex Not Assigned Not Reported/);
  await page.getByRole("button", { name: "Add Assignment", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Machine:/ }).click();
  await page.getByRole("option", { name: "Build Machine", exact: true }).click();
  await dialog.getByRole("button", { name: /^Agents:/ }).click();
  await expect(page.getByRole("option", { name: "WSL Codex", exact: true })).toBeVisible();
});
test("unsupported WSL reconciliation detail is visible in the assignment matrix", async ({ page }) => {
  const detail = "this agent's WSL distribution name is invalid or unsafe";
  await installSkillMatrixFixture(page, { wslUnsupportedDetail: detail });
  await page.goto("/skills-removals-e2e.html?matrix=1&wslSkills=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  const row = page.getByRole("region", { name: "Machine × Agents", exact: true })
    .getByRole("row", { name: /^WSL Codex / }).first();
  await expect(row).toHaveAccessibleName(/^WSL Codex Agent Invocable Unsupported/);
  await expect(row).toContainText(detail);
});
for (const width of [1280, 320]) for (const theme of ["dark", "light"]) {
  test(`matrix shows targeting, reports and pins at ${width} in ${theme}`, async ({ page }, info) => {
    await installSkillMatrixFixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills-removals-e2e.html?matrix=1");
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.getByRole("button", { name: /code-review/i }).click();
    const matrix = page.getByRole("region", { name: "Machine × Agents", exact: true });
    await expect(matrix).toContainText("Pinned · v0");
    await expect(matrix).toContainText("Track Latest");
    await expect(matrix).toContainText("Other Machine · Offline");
    await expect(matrix.getByRole("row", { name: /^Claude / }).first()).toHaveAccessibleName("Claude Manual Only Linked");
    await expect(matrix.getByRole("row", { name: /^Codex / }).first()).toHaveAccessibleName(/^Codex Not Assigned Linked \(Not Targeted\)/);
    await expect(matrix.getByRole("row", { name: /^WSL Codex / }).first()).toHaveAccessibleName(/^WSL Codex Unavailable Not Reported/);
    await matrix.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`matrix-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (width === 320) {
      await expect(matrix.locator("td").first()).toHaveCSS("padding", "4px 0px");
      await expect(matrix.locator("td").first()).toHaveCSS("border-top-width", "0px");
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      expect(nodes.some(node => !node.ignored && node.role?.value === "columnheader" && node.name?.value === "DESIRED INVOCATION")).toBe(true);
      expect(nodes.some(node => !node.ignored && node.role?.value === "rowheader" && node.name?.value === "Claude")).toBe(true);
      expect(nodes.some(node => !node.ignored && node.role?.value === "cell" && node.name?.value === "Manual Only")).toBe(true);
      await cdp.detach();
    }
    await matrix.getByRole("button", { name: "Manage Machine Version", exact: true }).first().click();
    await expect(page.getByRole("button", { name: /^Version Policy: Pin v0/ })).toBeVisible();
    await page.getByRole("button", { name: "Preview Version Policy" }).click();
    await expect(page.getByText("Proposed policy: pin v0.")).toBeVisible();
    await page.getByRole("button", { name: /^Version Policy:/ }).click();
    await page.getByRole("option", { name: "Track Latest", exact: true }).click();
    await page.getByRole("button", { name: "Preview Version Policy" }).click();
    await page.getByRole("checkbox", { name: "Accept Files and Machine-Wide Version Policy" }).check();
    await page.getByRole("button", { name: "Save Version Policy" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Version policy saved" })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(matrix).not.toContainText("Pinned · v0");
  });
}
test("failed reads do not show unassigned or tracking defaults", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.route("**/api/runners/*/skills", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.route("**/api/skills/skill-1/machines/*/version-policy", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.goto("/skills-removals-e2e.html?matrix=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  const matrix = page.getByRole("region", { name: "Machine × Agents", exact: true });
  await expect(matrix.getByRole("row", { name: /^Claude / }).first()).toHaveAccessibleName(/^Claude Unknown Unknown/);
  await expect(matrix).toContainText("Version policy: Unavailable");
  await expect(matrix).toContainText("Reported: Unknown.");
  await expect(matrix).not.toContainText("Reported: Never.");
  await expect(page.getByRole("region", { name: "Deployment", exact: true })).not.toContainText("No assignment targets this machine yet.");
  await matrix.getByRole("button", { name: "Manage Machine Version", exact: true }).first().click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Current version policy could not be loaded");
  await expect(page.getByRole("button", { name: "Preview Version Policy" })).toBeDisabled();
});
test("manual sync preserves unknown desired state until authoritative refresh", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.route("**/api/runners/*/skills", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.goto("/skills-removals-e2e.html?matrix=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  const matrix = page.getByRole("region", { name: "Machine × Agents", exact: true });
  await expect(matrix).toContainText("Skills status could not be loaded");
  let started!: () => void; const refreshing = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/runners/*/skills", async route => { started(); await held; await route.fulfill({ status: 503, json: { error: "Unavailable" } }); });
  try {
    await page.getByRole("button", { name: "Sync Now", exact: true }).first().click();
    await refreshing;
    await expect(matrix.getByRole("row", { name: /^Claude / }).first()).toHaveAccessibleName(/^Claude Unknown Unknown/);
    await expect(matrix).not.toContainText("Not Assigned");
  } finally { release(); }
});
test("older control planes use the authorized preview to initialize the saved pin", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.route("**/api/skills/skill-1/machines/*/version-policy", route => route.fulfill({ status: 404, json: { error: "Route not found" } }));
  await page.goto("/skills-removals-e2e.html?matrix=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  await page.getByRole("button", { name: "Machine Versions", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Version Policy: Pin v0/ })).toBeEnabled();
  await page.getByRole("button", { name: "Preview Version Policy" }).click();
  await expect(page.getByText("Current policy: pinned to v0.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Version Policy" })).toBeDisabled();
});
test("late policy response cannot overwrite a newly selected machine", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.goto("/skills-removals-e2e.html?matrix=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/skills/skill-1/machines/runner-1/version-policy", async route => { await held; await route.fulfill({ json: { policy: { versionId: "v0", revision: "r1" } } }); });
  await page.getByRole("button", { name: "Machine Versions", exact: true }).click();
  await page.getByRole("button", { name: /^Machine:/ }).click();
  await page.getByRole("option", { name: "Other Machine", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Version Policy: Track Latest/ })).toBeEnabled();
  release();
  await page.getByRole("button", { name: "Preview Version Policy" }).click();
  await expect(page.getByText("Current policy: track latest.")).toBeVisible();
  await expect(page.getByText("Proposed policy: track latest, including future library updates.")).toBeVisible();
});
