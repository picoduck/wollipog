import { expect, test, type Page } from "@playwright/test";
import { choosePageAction } from "./page-actions";

/**
 * #2987: Connect via SSH leads with SSH Target, folds its requirements into What This Needs, keeps
 * Port 96px beside Workspace Folder (stacked under it below 480px), puts a port error under Port and
 * a refused request in one notice above the footer.
 */

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto("/machine-management-e2e.html");
  // The machine's row: a phone shows the list alone, without its detail (#2985).
  await expect(page.getByRole("complementary", { name: "Machines" }).getByText("Design Workstation")).toBeVisible();
  await choosePageAction(page, "Connect via SSH…", "Add Machine");
  const dialog = page.getByRole("dialog", { name: "Connect via SSH" });
  await expect(dialog.getByRole("button", { name: /^Choose from SSH Config:/ })).toBeVisible();
  // Measure the settled dialog, not its scale-in or the sheet's slide-up.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  return dialog;
}

for (const width of [1440, 390]) {
  test(`at ${width}px Port is 96px ${width === 390 ? "under Workspace Folder" : "beside Workspace Folder"}, and SSH Target shows without scrolling`, async ({ page }) => {
    const dialog = await open(page, width);
    const geometry = await dialog.evaluate((element) => {
      const body = element.querySelector(".modal-body")!;
      const box = (selector: string) => {
        const rect = element.querySelector(selector)!.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const label = (text: string) => [...element.querySelectorAll("label")].find((item) => item.textContent === text)!;
      const control = (text: string) => document.getElementById(label(text).htmlFor)!;
      const rect = (node: Element) => {
        const value = node.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
      };
      return {
        bodyRect: rect(body),
        bodyScrollTop: body.scrollTop,
        bodyOverflowX: body.scrollWidth - body.clientWidth,
        description: box(".modal-desc"),
        needs: box("details.disclosure"),
        target: rect(control("SSH Target")),
        workspace: rect(control("Workspace Folder (Optional)").closest(".field")!),
        port: rect(control("Port")),
        portField: rect(control("Port").closest(".field")!),
        footerButtons: [...element.querySelectorAll(".modal-foot > .btn")].map((button) => rect(button)),
      };
    });
    expect(geometry.bodyOverflowX, "no horizontal overflow").toBeLessThanOrEqual(0);
    expect(geometry.port.width, "Port is the 96px field").toBeCloseTo(96, 0);
    expect(geometry.portField.width).toBeCloseTo(96, 0);
    if (width === 390) {
      expect(geometry.portField.top, "Port stacks under Workspace Folder").toBeGreaterThanOrEqual(geometry.workspace.bottom);
      expect(Math.abs(geometry.workspace.right - geometry.bodyRect.right) - 20, "Workspace Folder takes the row").toBeLessThanOrEqual(1);
      for (const button of geometry.footerButtons) expect(button.height, "phone footer buttons are 48px").toBeGreaterThanOrEqual(48);
    } else {
      expect(Math.abs(geometry.portField.top - geometry.workspace.top), "side by side").toBeLessThan(1);
      expect(geometry.portField.left).toBeGreaterThan(geometry.workspace.right);
    }
    // The description, the closed disclosure and SSH Target are on screen before any scrolling.
    expect(geometry.bodyScrollTop).toBe(0);
    const viewport = page.viewportSize()!;
    for (const part of [geometry.description, geometry.needs, geometry.target]) {
      expect(part.top).toBeGreaterThanOrEqual(0);
      expect(part.bottom).toBeLessThanOrEqual(Math.min(viewport.height, geometry.bodyRect.bottom));
    }
    await expect(dialog.locator("details.disclosure")).not.toHaveAttribute("open");
  });
}

test("a port error sits under Port and a refused request is one notice above the footer", async ({ page }) => {
  const dialog = await open(page, 1440);
  await expect(dialog.getByLabel("SSH Target")).toBeFocused();
  const port = dialog.getByLabel("Port", { exact: true });
  await port.fill("70000");
  await port.blur();
  await expect(port).toHaveAttribute("aria-invalid", "true");
  await expect(port).toHaveAccessibleDescription("Use 1 to 65535.");
  await expect(dialog.locator(".modal-foot")).toHaveText(/^\s*Cancel\s*Connect Machine\s*$/);

  await dialog.getByRole("button", { name: "Connect Machine" }).click();
  await expect(dialog.getByLabel("SSH Target")).toBeFocused();
  await expect(dialog.getByLabel("SSH Target")).toHaveAccessibleDescription("Enter an SSH target, such as user@host.");

  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAddBoxOutcome({ kind: "refuse", message: "Failed to fetch", status: 0 }));
  await dialog.getByLabel("SSH Target").fill("me@devbox");
  await port.fill("2222");
  await dialog.getByRole("button", { name: "Connect Machine" }).click();
  const notice = dialog.locator(".notice.t-danger");
  await expect(notice).toHaveCount(1);
  await expect(notice.locator(".notice-body")).toHaveText("Wollipog couldn't be reached. Check the connection, then try again.");
  await notice.getByRole("button", { name: "Show Details" }).click();
  await expect(notice.locator("code")).toHaveText("Failed to fetch");
  const order = await dialog.evaluate((element) => {
    const notice = element.querySelector(".notice")!.getBoundingClientRect();
    const footer = element.querySelector(".modal-foot")!.getBoundingClientRect();
    return { noticeBottom: notice.bottom, footerTop: footer.top };
  });
  expect(order.noticeBottom).toBeLessThanOrEqual(order.footerTop);
  await expect(dialog.locator(".modal-foot")).toHaveText(/^\s*Cancel\s*Connect Machine\s*$/);
});
