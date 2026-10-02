import { expect, test, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";

/**
 * An archive whose stop failed, or is still running, is not reported as a success (#2333): the
 * failed stop is a warning that stays until dismissed, the pending one an info toast, and both keep
 * Undo. The tone is drawn in CSS, so check it where the stylesheet applies.
 */

async function archiveFromSessions(page: Page, archiveStop: "failed" | "pending") {
  await page.goto(`/command-inbox-projects-e2e.html?archiveStop=${archiveStop}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/command-inbox-projects-e2e.html?archiveStop=${archiveStop}`);
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Archive and Stop All Sessions" }).click();
  await page.getByRole("dialog", { name: "Archive and Stop Sessions" }).getByRole("button", { name: "Archive and Stop" }).click();
}

async function archiveFromProjects(page: Page, archiveStop: "failed" | "pending") {
  const path = encodeURIComponent(viewPath({ name: "projects", id: "alpha" }));
  const url = `/command-inbox-projects-e2e.html?archiveStop=${archiveStop}&fullShell=1&path=${path}`;
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await page.getByRole("button", { name: "Archive and Stop Sessions" }).click();
  await page.getByRole("dialog", { name: "Archive and Stop Sessions" }).getByRole("button", { name: "Archive and Stop" }).click();
}

async function expectToast(page: Page, message: RegExp, tone: "t-warning" | "t-info", icon: string) {
  const toast = page.locator(".toast").filter({ hasText: message });
  await expect(toast).toHaveCount(1);
  await expect(toast).toHaveClass(new RegExp(`\\b${tone}\\b`));
  await expect(toast).not.toHaveClass(/\bt-success\b/);
  expect(await toast.locator(".toast-icon svg").evaluate((svg, name) => svg.classList.contains(name), icon)).toBe(true);
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  // The tone reaches the paint: the toast's icon takes the tone's colour, not the success green.
  const colours = await toast.evaluate((element) => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const read = (variable: string) => {
      probe.style.color = `var(${variable})`;
      return getComputedStyle(probe).color;
    };
    const result = {
      icon: getComputedStyle(element.querySelector(".toast-icon")!).color,
      warning: read("--amber"),
      info: read("--blue"),
      success: read("--green"),
    };
    probe.remove();
    return result;
  });
  expect(colours.icon).toBe(tone === "t-warning" ? colours.warning : colours.info);
  expect(colours.icon).not.toBe(colours.success);
}

const FAILED = /^The stop failed for 1 session in Alpha, so it may still be running\. Use Retry Stop to try again\./;
const PENDING = /^Archiving from Alpha\. 1 session is still stopping\./;

test("a Project archive from Sessions whose stop failed is a warning with Undo", async ({ page }) => {
  await archiveFromSessions(page, "failed");
  await expectToast(page, FAILED, "t-warning", "lucide-triangle-alert");
});

test("a Project archive from Sessions whose stop is still running is info with Undo", async ({ page }) => {
  await archiveFromSessions(page, "pending");
  await expectToast(page, PENDING, "t-info", "lucide-info");
});

test("a Project archive from Projects whose stop failed is a warning with Undo", async ({ page }) => {
  await archiveFromProjects(page, "failed");
  await expectToast(page, FAILED, "t-warning", "lucide-triangle-alert");
});

test("a Project archive from Projects whose stop is still running is info with Undo", async ({ page }) => {
  await archiveFromProjects(page, "pending");
  await expectToast(page, PENDING, "t-info", "lucide-info");
});
