import { expect, test } from "@playwright/test";
import { installSkillMatrixFixture } from "./skill-matrix.fixture.js";
test("direct assignment errors are visible inside the open dialog", async ({ page }) => {
  await page.route("**/api/skill-assignments", route => route.fulfill({ status: 409, json: { error: "Assignment ownership rejected" } }));
  await page.goto("/skills-removals-e2e.html");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  await page.getByRole("button", { name: "Add Assignment…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Add Assignment", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Assignment ownership rejected");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Add Assignment…", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
});
test("version picker explains when no compatible machines exist", async ({ page }) => {
  await page.goto("/skills-removals-e2e.html?legacySkills=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  await page.locator(".skill-detail-head, .detail-bar").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Machine Version…", exact: true }).click();
  await expect(page.getByText(/No compatible machines are available/)).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Version" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Version", exact: true })).toBeDisabled();
});
/** The Deployment table's row group for a machine (#1981). */
const machineGroup = (page: import("@playwright/test").Page, name: string) =>
  page.locator("table.skill-deployment").getByRole("rowgroup", { name, exact: true });
/** An agent's row: name, invocation, assigned by and status, read without the narrow cell labels. */
const agentCells = (page: import("@playwright/test").Page, machine: string, agent: string) =>
  machineGroup(page, machine).locator("tr.skill-deployment-agent")
    .filter({ has: page.locator(".skill-deployment-agent-name", { hasText: new RegExp(`^${agent}$`) }) })
    .evaluate((row) => [...row.children].map((cell) => [...cell.childNodes]
      .filter((node) => !(node as Element).classList?.contains("cell-label") && !(node as Element).classList?.contains("cell-note"))
      .map((node) => node.textContent).join("")));

test("capable Windows machines offer WSL agents for direct assignment", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.goto("/skills-removals-e2e.html?matrix=1&wslSkills=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  expect(await agentCells(page, "Build Machine", "WSL Codex")).toEqual(["WSL Codex", "Not Assigned", "—", ""]);
  await page.getByRole("button", { name: "Add Assignment…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Machine:/ }).click();
  await page.getByRole("option", { name: /^Build Machine\b/ }).click();
  await dialog.getByRole("button", { name: /^Agents:/ }).click();
  await expect(page.getByRole("option", { name: "WSL Codex Codex (Command Line)", exact: true })).toBeVisible();
});
test("an unsupported WSL link is an Error with the machine's reason", async ({ page }) => {
  const detail = "this agent's WSL distribution name is invalid or unsafe";
  await installSkillMatrixFixture(page, { wslUnsupportedDetail: detail });
  await page.goto("/skills-removals-e2e.html?matrix=1&wslSkills=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  expect(await agentCells(page, "Build Machine", "WSL Codex")).toEqual(["WSL Codex", "Agent Invocable", "—", "Error"]);
  await expect(machineGroup(page, "Build Machine").locator("tr.skill-deployment-agent", { hasText: "WSL Codex" })).toContainText(detail);
});
for (const width of [1280, 320]) for (const theme of ["dark", "light"]) {
  test(`Deployment shows each agent's status once, version pins and offline machines at ${width} in ${theme}`, async ({ page }, info) => {
    await installSkillMatrixFixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills-removals-e2e.html?matrix=1");
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
    const deployment = page.getByRole("region", { name: "Deployment", exact: true });
    await expect(deployment.getByRole("heading", { name: "Machine × Agents" })).toHaveCount(0);
    await expect(deployment).toContainText("What each machine reports.");
    const build = machineGroup(page, "Build Machine");
    const other = machineGroup(page, "Other Machine");
    await expect(build).toContainText("Pinned to v1");
    await expect(other).toContainText("Track Latest");
    await expect(build.locator(".skill-deployment-machine")).toContainText("2 of 2 Linked");
    // An offline machine updates when it is back, with no Sync Now to press.
    await expect(other.locator(".skill-deployment-machine .status")).toHaveText("Offline");
    await expect(other).toContainText("Updates when back online");
    await expect(other.getByRole("button", { name: "Sync Now" })).toHaveCount(0);
    await expect(build.getByRole("button", { name: "Sync Now", exact: true })).toBeVisible();
    expect(await agentCells(page, "Build Machine", "Claude")).toEqual(["Claude", "Manual Only", "—", "Linked"]);
    expect(await agentCells(page, "Build Machine", "Codex")).toEqual(["Codex", "Not Assigned", "—", "Linked"]);
    await expect(build.locator("tr.skill-deployment-agent", { hasText: "Codex" }).first()).toContainText(/Not assigned\. A link from before/);
    // A WSL agent on a Linux machine can't receive managed skills: it folds into one row.
    await expect(build.getByRole("button", { name: "1 Agent Can't Receive Managed Skills" })).toHaveAttribute("aria-expanded", "false");
    await build.getByRole("button", { name: "1 Agent Can't Receive Managed Skills" }).click();
    expect(await agentCells(page, "Build Machine", "WSL Codex")).toEqual(["WSL Codex", "—", "—", ""]);
    await deployment.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`deployment-${width}-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (width === 320) {
      // The §14 narrow table: each agent row is a padded two-line flex row and its cells carry no
      // padding or rules of their own; the machine's actions take their own line.
      const agentRow = build.locator("tr.skill-deployment-agent").first();
      await expect(agentRow).toHaveCSS("display", "flex");
      await expect(agentRow.locator("td").first()).toHaveCSS("padding", "0px");
      await expect(agentRow.locator("td").first()).toHaveCSS("border-top-width", "0px");
      const lines = await build.locator(".skill-deployment-machine").evaluate((row) => {
        const name = row.querySelector(".skill-deployment-machine-name")!.getBoundingClientRect();
        const actions = row.querySelector(".skill-deployment-actions")!.getBoundingClientRect();
        return { nameBottom: name.bottom, actionsTop: actions.top };
      });
      expect(lines.actionsTop).toBeGreaterThanOrEqual(lines.nameBottom);
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      expect(nodes.some(node => !node.ignored && node.role?.value === "columnheader" && node.name?.value === "Assigned By")).toBe(true);
      expect(nodes.some(node => !node.ignored && node.role?.value === "rowheader" && node.name?.value === "Claude")).toBe(true);
      expect(nodes.some(node => !node.ignored && node.role?.value === "cell" && node.name?.value === "Manual Only")).toBe(true);
      await cdp.detach();
    }
    await build.getByRole("button", { name: "Manage Version…", exact: true }).click();
    const choices = page.getByRole("dialog", { name: "Machine Version" }).getByRole("radiogroup", { name: "Version" });
    await expect(choices.getByRole("radio", { name: /^Pin to v1/ })).toBeChecked();
    await expect(page.getByRole("button", { name: "Save Version", exact: true })).toBeDisabled();
    await choices.getByText("Track Latest", { exact: true }).click();
    await page.locator(".modal-foot").getByRole("checkbox", { name: /^Switch \d+ agents? to the latest version$/ }).check();
    await page.getByRole("button", { name: "Save Version", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Build Machine tracks the latest version now." })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(build).not.toContainText("Pinned to v1");
    await expect(build).toContainText("Track Latest");
  });
}
test("failed reads do not show unassigned or tracking defaults", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.route("**/api/runners/*/skills", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.route("**/api/skills/skill-1/machines/*/version-policy", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.goto("/skills-removals-e2e.html?matrix=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  const build = machineGroup(page, "Build Machine");
  await expect(build.getByRole("alert")).toContainText("Skills status could not be loaded");
  await expect(build.locator("tr.skill-deployment-agent")).toHaveCount(0);
  await expect(build).toContainText("Version Unavailable");
  await expect(build).not.toContainText("Not Assigned");
  await expect(build).not.toContainText("Track Latest");
  await expect(page.getByRole("region", { name: "Deployment", exact: true })).not.toContainText("Not Deployed Anywhere");
  await build.getByRole("button", { name: "Manage Version…", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("The machine's current version couldn't be loaded");
  await expect(page.getByRole("dialog").getByRole("radiogroup", { name: "Version" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Version", exact: true })).toBeDisabled();
});
test("manual sync preserves unknown desired state until authoritative refresh", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.route("**/api/runners/*/skills", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.goto("/skills-removals-e2e.html?matrix=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  const build = machineGroup(page, "Build Machine");
  await expect(build).toContainText("Skills status could not be loaded");
  let started!: () => void; const refreshing = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/runners/*/skills", async route => { started(); await held; await route.fulfill({ status: 503, json: { error: "Unavailable" } }); });
  try {
    await build.getByRole("button", { name: "Sync Now", exact: true }).click();
    await refreshing;
    await expect(build.locator("tr.skill-deployment-agent")).toHaveCount(0);
    await expect(build).not.toContainText("Not Assigned");
  } finally { release(); }
});
test("older control planes use the authorized preview to initialize the saved pin", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.route("**/api/skills/skill-1/machines/*/version-policy", route => route.fulfill({ status: 404, json: { error: "Route not found" } }));
  await page.goto("/skills-removals-e2e.html?matrix=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  await page.locator(".skill-detail-head, .detail-bar").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Machine Version…", exact: true }).click();
  const choices = page.getByRole("dialog", { name: "Machine Version" }).getByRole("radiogroup", { name: "Version" });
  await expect(choices.getByRole("radio", { name: /^Pin to v1/ })).toBeChecked();
  await expect(choices.getByRole("radio", { name: /^Pin to v1/ })).toBeEnabled();
  // The pin already in force changes nothing: nothing to read, consent to or save (#1984).
  await expect(page.getByRole("dialog").getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Version", exact: true })).toBeDisabled();
  await expect(page.locator(".modal-foot")).toContainText("Choose a different version to save.");
});
test("late policy response cannot overwrite a newly selected machine", async ({ page }) => {
  await installSkillMatrixFixture(page);
  await page.goto("/skills-removals-e2e.html?matrix=1");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/skills/skill-1/machines/runner-1/version-policy", async route => { await held; await route.fulfill({ json: { policy: { versionId: "v0", revision: "r1" } } }); });
  await page.locator(".skill-detail-head, .detail-bar").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Machine Version…", exact: true }).click();
  await page.getByRole("button", { name: /^Machine:/ }).click();
  await page.getByRole("option", { name: "Other Machine", exact: true }).click();
  const choices = page.getByRole("dialog", { name: "Machine Version" }).getByRole("radiogroup", { name: "Version" });
  await expect(choices.getByRole("radio", { name: /^Track Latest/ })).toBeChecked();
  release();
  // The first machine's pin, answered late, marks nothing on the machine now chosen.
  await page.waitForTimeout(300);
  await expect(choices.getByRole("radio", { name: /^Track Latest/ })).toBeChecked();
  await expect(choices.locator(".choice-row-title")).toHaveText(["Track LatestCurrent", "Pin to v2", "Pin to v1"]);
});
