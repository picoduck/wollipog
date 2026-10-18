import { expect, test, type Page } from "@playwright/test";
import { openProjectActions } from "./session-groups.js";

/**
 * A project's Memory Sharing as one setting row saved by the project's save bar, with each machine's
 * support as a row and the details behind About (#2963).
 */
const CONSENT = "A conversation keeps its history when it switches accounts, and that history may already contain memories.";

async function chooseMemorySharing(page: Page, label: string) {
  await page.getByRole("region", { name: "Memory Sharing" }).getByRole("button", { name: /^Memory Sharing:/ }).click();
  await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
}

const savedSharing = (page: Page) => page.evaluate(() =>
  window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().projects.find((project) => project.id === "alpha")!.memorySharing);

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`project memory consent, persistence and unavailable runners ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/command-inbox-projects-e2e.html");
    await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { memorySharing: "separate" });
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setProjectMemoryClaudeVersion("2.1.284");
    }, theme);
    await openProjectActions(page, /Alpha/, "Alpha");
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    const section = page.getByRole("region", { name: "Memory Sharing" });
    const trigger = section.getByRole("button", { name: /^Memory Sharing:/ });
    const machine = section.locator(".project-memory-machine .row-sub");
    const about = section.locator("details.disclosure");
    const bar = page.locator(".project-detail > .save-bar");
    await expect(section).toContainText("Whether this project's Claude accounts on the same machine share saved memory.");
    await expect(trigger).toHaveAccessibleName("Memory Sharing: Keep Separate");
    await expect(machine).toHaveText(["Supported"]);
    await expect(section.getByRole("button", { name: "Save Memory Policy" })).toHaveCount(0);
    await expect(section).not.toContainText("Saved Choice:");
    await expect(bar).toHaveCount(0);

    // About is closed until opened, and holds the provider and timing details.
    await expect(about).not.toHaveAttribute("open", "");
    await expect(section.getByText("Codex keeps its own account memory")).toBeHidden();
    await about.locator("summary").click();
    await expect(section.getByText("Codex keeps its own account memory")).toBeVisible();
    await expect(about).toContainText("Turning sharing off keeps the shared memory");
    await about.locator("summary").click();

    // Each machine state is its sentence.
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setProjectMemoryClaudeVersion("2.1.283"));
    await expect(machine).toHaveText(["Install Claude Code 2.1.284 or newer, then refresh agents"]);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setProjectMemoryClaudeVersion("2.1.284"));
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
    await expect(machine).toHaveText(["Offline. The saved choice applies when it reconnects."]);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online"));
    await expect(machine).toHaveText(["Supported"]);

    // Share shows the consent notice and the save bar; Discard takes both away.
    await chooseMemorySharing(page, "Share Project Memory");
    await expect(section.getByText(CONSENT)).toBeVisible();
    await expect(bar).toContainText("Unsaved changes");
    await bar.getByRole("button", { name: "Discard" }).click();
    await expect(trigger).toHaveAccessibleName("Memory Sharing: Keep Separate");
    await expect(section.getByText(CONSENT)).toHaveCount(0);
    await expect(bar).toHaveCount(0);

    // A failed save keeps the choice and its notice; Try Again saves it.
    await chooseMemorySharing(page, "Share Project Memory");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextProjectUpdate());
    await bar.getByRole("button", { name: "Save" }).click();
    await expect(bar).toContainText("Couldn't save the changes. Nothing was changed.");
    await expect(trigger).toHaveAccessibleName("Memory Sharing: Share Project Memory");
    await expect(section.getByText(CONSENT)).toBeVisible();
    expect(await savedSharing(page)).toBe("separate");
    await bar.getByRole("button", { name: "Try Again" }).click();
    await expect(bar).toHaveCount(0);
    await expect(section.getByText(CONSENT)).toHaveCount(0);
    expect(await savedSharing(page)).toBe("shared");

    await page.reload();
    await openProjectActions(page, /Alpha/, "Alpha");
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    await expect(trigger).toHaveAccessibleName("Memory Sharing: Share Project Memory");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(194));
    await expect(machine).toHaveText(["Update Wollipog on this machine to use it"]);
    await chooseMemorySharing(page, "Keep Account Memories Separate");
    await expect(section.getByText(CONSENT)).toHaveCount(0);
    await bar.getByRole("button", { name: "Save" }).click();
    await expect(bar).toHaveCount(0);
    expect(await savedSharing(page)).toBe("separate");

    // An older server has no policy to show.
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { memorySharing: undefined }));
    await expect(section.locator(".notice.t-warning")).toContainText("Memory Sharing Needs an Update");
    await expect(section.locator(".notice.t-warning")).toContainText("Update Wollipog to choose how accounts share memory.");
    await expect(trigger).toHaveCount(0);
  });
}
