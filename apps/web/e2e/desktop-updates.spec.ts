import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1975 (and #1682's browser coverage): the desktop update toast in both install modes, the held-update
 * confirmation, and the two link-error toasts, through the real FeedbackProvider with a fake desktop
 * runtime (docs/design-system.md §7.4, §7.5, §13.1).
 *
 * These are desktop features, so the phone width runs only here, in the harness: it checks that the
 * shared primitives still hold there — the dialog becomes a bottom sheet, and the toast clears the
 * bottom edge.
 */

const FAILED_LINK = "https://github.com/picoduck/wollipog/pull/2040/files#diff-4f8c2d1e9b7a6035c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4";
const BLOCKED_LINK = "file:///Users/avery/Projects/wollipog/docs/design-system.md";
const LONG_LINK = `https://example.com/report?filters=${Array.from({ length: 200 }, (_, index) => `session-${index}`).join(",")}`;

test("Settings opts into prereleases, retains the choice on reload, and clears it when returning to stable", async ({ page }) => {
  await page.goto("/desktop-updates-e2e.html?state=channels");
  const channel = page.getByRole("switch", { name: "Pre-Release Updates", exact: true });
  await expect(channel).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Check for Updates", exact: true }).click();
  await expect(page.getByText("Wollipog 0.29.1 Is Up to Date", { exact: true })).toBeVisible();
  await channel.click();
  await expect(channel).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Check for Updates", exact: true }).click();
  await expect(page.getByText("Wollipog 0.30.0-rc.1 Is Available", { exact: true })).toBeVisible();
  await page.reload();
  await expect(channel).toHaveAttribute("aria-checked", "true");
  await channel.click();
  await expect(channel).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Install and Restart", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Check for Updates", exact: true }).click();
  await expect(page.getByText("Wollipog 0.29.1 Is Up to Date", { exact: true })).toBeVisible();
});

/** Every line of `text` is inside the toast and the viewport: it wraps, and nothing is cut off. */
async function expectFullyVisible(toast: Locator, text: Locator) {
  const fit = await text.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const card = element.closest(".toast")!.getBoundingClientRect();
    return {
      spill: element.scrollWidth - element.clientWidth,
      left: box.left - card.left,
      right: card.right - box.right,
      top: box.top,
      bottom: window.innerHeight - box.bottom,
    };
  });
  expect(fit.spill, "the text wraps instead of spilling sideways").toBeLessThanOrEqual(0);
  expectGeometry(fit.left, "the text starts inside the toast").toBeGreaterThanOrEqual(0);
  expectGeometry(fit.right, "the text ends inside the toast").toBeGreaterThanOrEqual(0);
  expectGeometry(fit.top, "the text is below the top of the window").toBeGreaterThanOrEqual(0);
  expectGeometry(fit.bottom, "the text is above the bottom of the window").toBeGreaterThanOrEqual(0);
  await expect(toast).toBeInViewport({ ratio: 1 });
}

/** Tab from the page into the toast reaches its controls in reading order, ending on the close. */
async function expectKeyboardOrder(page: Page, toast: Locator, names: string[]) {
  await page.locator("body").focus();
  for (const name of names) {
    await page.keyboard.press("Tab");
    await expect(toast.getByRole(name === "What's New" ? "link" : "button", { name, exact: true })).toBeFocused();
  }
}

/** On desktop the stack is bottom right (§13.1); on a phone it spans the width above the bottom edge. */
async function expectPlacement(page: Page, phone: boolean) {
  const region = await page.locator(".toast-region").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom, width: box.width };
  });
  if (phone) {
    expectGeometry(Math.abs(region.left - 8), "8px from the left edge").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(region.right - 8), "8px from the right edge").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(region.bottom - 8), "8px above the bottom edge").toBeLessThanOrEqual(0.61);
  } else {
    expectGeometry(Math.abs(region.right - 16), "16px from the right edge").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(region.bottom - 16), "16px above the bottom edge").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(region.width - 360), "the 360px toast column").toBeLessThanOrEqual(0.61);
  }
}

for (const { width, height, phone } of [
  { width: 1440, height: 900, phone: false },
  { width: 390, height: 844, phone: true },
]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${width}px ${theme}`, () => {
      test.use({ viewport: { width, height }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });

      test("the update toast offers Install and Restart, with What's New, and holds the install as a confirmation", async ({ page }) => {
        await page.goto(`/desktop-updates-e2e.html?state=in-place&theme=${theme}`);
        const toast = page.locator(".toast");
        await expect(toast).toHaveCount(1);
        await expect(toast).toHaveClass(/t-info/);
        await expect(toast.locator(".toast-message")).toHaveText("Wollipog 0.29.0 is ready to install.");
        await expect(toast.locator(".toast-detail")).toHaveText("Restarting takes a few seconds. You can also install it later from Settings.");
        await expect(toast.getByRole("link", { name: "What's New" })).toHaveAttribute("href", "https://github.com/picoduck/wollipog/releases/tag/v0.29.0");
        await expect(toast.getByRole("button")).toHaveText(["Install and Restart", ""]);
        await expectFullyVisible(toast, toast.locator(".toast-message"));
        await expectFullyVisible(toast, toast.locator(".toast-detail"));
        await expectPlacement(page, phone);
        await expectKeyboardOrder(page, toast, ["What's New", "Install and Restart", "Dismiss Notification"]);

        await toast.getByRole("button", { name: "Install and Restart" }).click();
        const dialog = page.getByRole("dialog", { name: "Restart to Install Update" });
        await expect(dialog).toBeVisible();
        await dialogMotionSettled(page);
        await expect(page.locator(".toast.t-danger")).toHaveCount(0);
        await expect(dialog.locator(".confirmation-message")).toHaveText(
          "Installing Wollipog 0.29.0 restarts the app, which stops 2 sessions that are still working. You can install later from Settings.",
        );
        await expect(dialog.locator(".confirmation-rows .row-title")).toHaveText([
          "Fix the half-cent rounding bug in invoice totals before the quarterly close",
          "Review the migration plan",
        ]);
        await expect(dialog.getByRole("button", { name: "Install Later" })).toBeFocused();

        const buttons = await dialog.locator(".modal-foot > button").evaluateAll((items) => items.map((item) => {
          const box = item.getBoundingClientRect();
          return { text: item.textContent, className: item.className, width: box.width };
        }));
        expect(buttons.map(({ text, className }) => [text, className])).toEqual([
          ["Install Later", "btn"],
          ["Restart Anyway", "btn danger"],
        ]);
        const sheet = await page.locator(".modal").filter({ has: dialog }).evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { width: box.width, left: box.left, bottom: window.innerHeight - box.bottom, css: getComputedStyle(element).width };
        });
        if (phone) {
          // A bottom sheet (§7.5): the full width, on the bottom edge, with two equal buttons.
          expectGeometry(Math.abs(sheet.width - width), "the sheet spans the width").toBeLessThanOrEqual(0.61);
          expectGeometry(Math.abs(sheet.bottom), "the sheet sits on the bottom edge").toBeLessThanOrEqual(0.61);
          expectGeometry(Math.abs(buttons[0]!.width - buttons[1]!.width), "the two buttons are equal width").toBeLessThanOrEqual(0.61);
        } else {
          expect(sheet.css, "the 400px confirmation size").toBe("400px");
        }

        await dialog.getByRole("button", { name: "Restart Anyway" }).click();
        await expect(page.getByTestId("installs")).toHaveText("unconfirmed,confirmed");
        const restart = dialog.getByRole("button", { name: "Restart Anyway" });
        await expect(restart).toHaveAttribute("aria-busy", "true");
        await expect(restart).toHaveText("Restart Anyway");
      });

      test("the release-page toast offers Open Release Page and nothing that restarts", async ({ page }) => {
        await page.goto(`/desktop-updates-e2e.html?state=release-page&theme=${theme}`);
        const toast = page.locator(".toast");
        await expect(toast).toHaveCount(1);
        await expect(toast).toHaveClass(/t-info/);
        await expect(toast.locator(".toast-message")).toHaveText("Wollipog 0.29.0 is available.");
        await expect(toast.locator(".toast-detail")).toHaveText("You can also open it later from Settings.");
        await expect(toast.getByRole("button")).toHaveText(["Open Release Page", ""]);
        await expectFullyVisible(toast, toast.locator(".toast-message"));
        await expectPlacement(page, phone);
        await expectKeyboardOrder(page, toast, ["What's New", "Open Release Page", "Dismiss Notification"]);
        await toast.getByRole("button", { name: "Open Release Page" }).click();
        await expect(page.getByTestId("opened")).toHaveText("https://github.com/picoduck/wollipog/releases/tag/v0.29.0");
        await expect(page.getByTestId("installs")).toHaveText("");
      });

      for (const { state, message, tone, url } of [
        { state: "link-failure", message: "Couldn't open the link in your browser.", tone: /t-danger/, url: FAILED_LINK },
        { state: "link-policy", message: "Wollipog only opens web links in your browser.", tone: /t-warning/, url: BLOCKED_LINK },
      ]) {
        test(`the ${state} toast shows the whole URL in mono, with Copy Link and no Retry`, async ({ page }) => {
          await page.goto(`/desktop-updates-e2e.html?state=${state}&theme=${theme}`);
          const toast = page.locator(".toast");
          await expect(toast).toHaveCount(1);
          await expect(toast).toHaveClass(tone);
          await expect(toast.locator(".toast-message")).toHaveText(message);
          const detail = toast.locator(".toast-detail.mono");
          await expect(detail).toHaveText(url);
          expect(await detail.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/monospace/);
          await expect(toast).not.toContainText(/os error|blocked|system browser could not/);
          await expect(toast.getByRole("button")).toHaveText(["Copy Link", ""]);
          await expectFullyVisible(toast, toast.locator(".toast-message"));
          await expectFullyVisible(toast, detail);
          await expectPlacement(page, phone);
          await expectKeyboardOrder(page, toast, ["Copy Link", "Dismiss Notification"]);

          await toast.getByRole("button", { name: "Copy Link" }).click();
          await expect(page.getByTestId("copied")).toHaveText(url);
        });
      }

      test("a URL several kilobytes long scrolls inside the toast, which stays on screen", async ({ page }) => {
        await page.goto(`/desktop-updates-e2e.html?state=link-long&theme=${theme}`);
        const toast = page.locator(".toast");
        await expect(toast).toHaveCount(1);
        await expect(toast).toBeInViewport({ ratio: 1 });
        const detail = toast.locator(".toast-detail.mono");
        await expect(detail).toHaveText(LONG_LINK);
        const box = await detail.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }));
        expect(box.client, "eight lines at most").toBeLessThanOrEqual(8 * 16);
        expect(box.scroll, "the rest of the URL scrolls, rather than being cut off").toBeGreaterThan(box.client);
        await toast.getByRole("button", { name: "Copy Link" }).click();
        await expect(page.getByTestId("copied")).toHaveText(LONG_LINK);
      });
    });
  }
}

/**
 * Settings › About (#3028) in the same harness: every update state as one status block, the browser's
 * About, Copy Version Info, and Install and Restart held for running work.
 */
const ABOUT_STATES: ReadonlyArray<{ update: string; title: string; description: string | RegExp | null; actions: string[] }> = [
  { update: "unchecked", title: "Not Checked Yet", description: null, actions: ["Check for Updates"] },
  { update: "checking", title: "Not Checked Yet", description: null, actions: ["Check for Updates"] },
  { update: "current", title: "Wollipog 0.27.0 Is Up to Date", description: /^Checked .+ on the stable channel\.$/u, actions: ["Check Again"] },
  { update: "available", title: "Wollipog 0.28.0 Is Available", description: "Installing restarts Wollipog.", actions: ["Check Again", "Install and Restart"] },
  {
    update: "release-page",
    title: "Wollipog 0.28.0 Is Available",
    description: "This app was installed from a .deb package. Install the new package from the release page.",
    actions: ["Check Again", "Open Release Page"],
  },
  { update: "installing", title: "Installing Wollipog 0.28.0", description: "Downloading and verifying. Wollipog restarts when it's installed.", actions: [] },
  { update: "disabled", title: "Update Checks Are Off", description: "This installation turns update checks off.", actions: ["Show Details"] },
  { update: "failed", title: "Couldn't Check for Updates", description: "Wollipog couldn't reach the release server. Check the connection, then try again.", actions: ["Show Details", "Retry"] },
];

/** No visible text names the protocol, the old "Control Plane" or an environment variable (§17.2). */
async function expectNoSystemWords(page: Page) {
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/Protocol/u);
  expect(text).not.toMatch(/Control Plane/iu);
  expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/u);
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`Settings › About, ${theme}`, () => {
    for (const expected of ABOUT_STATES) {
      test(`the ${expected.update} state shows its title, description and actions`, async ({ page }) => {
        await page.goto(`/desktop-updates-e2e.html?state=about&update=${expected.update}&theme=${theme}`);
        await expect(page.locator(".about-identity-version")).toHaveText("Version 0.27.0");
        await expect(page.locator(".setting-row-value-text")).toHaveText(["0.27.0", "0.26.0"]);
        const block = page.locator(".update-block");
        await expect(block.locator(".update-block-title")).toHaveText(expected.title);
        const description = block.locator(".update-block-desc");
        if (expected.description === null) await expect(description).toHaveCount(0);
        else await expect(description).toHaveText(expected.description);
        await expect(block.getByRole("button")).toHaveText(expected.actions);
        await expect(block.locator(".update-block-text button")).toHaveCount(0);
        await expectNoSystemWords(page);
        if (expected.update === "checking") {
          const check = block.getByRole("button", { name: "Check for Updates", exact: true });
          await expect(check).toHaveAttribute("aria-busy", "true");
        }
        // On desktop the actions sit beside the text, after it; the last one is the primary when
        // there is one.
        if (expected.actions.length) {
          const [text, actions] = await Promise.all([block.locator(".update-block-text").boundingBox(), block.locator(".update-block-actions").boundingBox()]);
          expect(actions!.x, "the actions follow the text").toBeGreaterThanOrEqual(text!.x + text!.width);
        }
      });
    }

    test("Install and Restart in an available update is the last button, and the only primary", async ({ page }) => {
      await page.goto(`/desktop-updates-e2e.html?state=about&update=available&theme=${theme}`);
      const block = page.locator(".update-block");
      await expect(block.locator(".btn.primary")).toHaveText(["Install and Restart"]);
      await expect(block.getByRole("button").last()).toHaveText("Install and Restart");
      await block.getByRole("button", { name: "Install and Restart" }).click();
      await block.getByRole("button", { name: "Check Again" }).click();
      await expect(page.getByTestId("actions")).toHaveText("install,check");
    });

    test("the failed and turned-off states keep their details behind Show Details", async ({ page }) => {
      await page.goto(`/desktop-updates-e2e.html?state=about&update=failed&theme=${theme}`);
      const block = page.locator(".update-block");
      await expect(block).not.toContainText("error sending request");
      await block.getByRole("button", { name: "Show Details" }).click();
      await expect(block.locator(".update-block-details")).toContainText("error sending request for url");
      await block.getByRole("button", { name: "Retry" }).click();
      await expect(page.getByTestId("actions")).toHaveText("check");

      await page.goto(`/desktop-updates-e2e.html?state=about&update=disabled&theme=${theme}`);
      await expect(page.locator("main")).not.toContainText("WOLLIPOG_DISABLE_UPDATE_CHECK");
      await page.locator(".update-block").getByRole("button", { name: "Show Details" }).click();
      await expect(page.locator(".update-block-details")).toContainText("WOLLIPOG_DISABLE_UPDATE_CHECK");
    });

    test("Copy Version Info copies both versions, the protocol number and the server address", async ({ page }) => {
      await page.goto(`/desktop-updates-e2e.html?state=about&update=current&theme=${theme}`);
      await page.getByRole("button", { name: "Copy Version Info" }).click();
      const copied = await page.getByTestId("copied").textContent();
      expect(copied).toContain("Wollipog Desktop App: 0.27.0");
      expect(copied).toContain("Wollipog Server: 0.26.0");
      expect(copied).toMatch(/Protocol: \d+/u);
      // The harness's server is at another origin than the page, as in a split deployment.
      expect(copied).toContain("Server Address: https://wollipog-server.example.test:4317");
      expect(copied).not.toContain(new URL(page.url()).origin);
      await expect(page.getByText("The Wollipog server at https://wollipog-server.example.test:4317.", { exact: true })).toBeVisible();
      await expect(page.locator(".settings-group-action .btn")).toHaveClass(/copy-status-copied/);
    });

    test("in a browser About has the foot line, and no Updates group or licenses row", async ({ page }) => {
      await page.goto(`/desktop-updates-e2e.html?state=about&theme=${theme}`);
      await expect(page.locator(".about-identity-version")).toHaveText("Version 0.26.0");
      // Versions keeps its title and head action; only Updates is left out.
      await expect(page.locator(".settings-group-title")).toHaveText(["Versions"]);
      await expect(page.getByRole("button", { name: "Copy Version Info" })).toBeVisible();
      await expect(page.getByText("This window updates when its Wollipog server is upgraded.", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Updates" })).toHaveCount(0);
      await expect(page.locator(".update-block")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("Open-Source Licenses");
      await expect(page.locator(".setting-row-title")).toHaveText(["Server"]);
      await expectNoSystemWords(page);
    });

    test("Install and Restart with work running opens the shared Restart to Install Update confirmation", async ({ page }) => {
      await page.goto(`/desktop-updates-e2e.html?state=about-held&theme=${theme}`);
      const block = page.locator(".update-block");
      await expect(block.locator(".update-block-title")).toHaveText("Wollipog 0.29.0 Is Available");
      await block.getByRole("button", { name: "Install and Restart" }).click();
      const dialog = page.getByRole("dialog", { name: "Restart to Install Update" });
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("installs")).toHaveText("unconfirmed");
      await dialog.getByRole("button", { name: "Install Later" }).click();
      await expect(dialog).toHaveCount(0);
      // Install Later leaves the update on offer, as it was.
      await expect(block.getByRole("button", { name: "Install and Restart" })).toBeVisible();
      await expect(page.getByTestId("installs")).toHaveText("unconfirmed");
    });

    test.describe("390px with touch", () => {
      test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

      test("a title with no sentence under it is centred on the tile", async ({ page }) => {
        await page.goto(`/desktop-updates-e2e.html?state=about&update=unchecked&theme=${theme}`);
        const block = page.locator(".update-block");
        await expect(block.locator(".update-block-desc")).toHaveCount(0);
        const [tile, title] = await Promise.all([block.locator(".update-block-tile").boundingBox(), block.locator(".update-block-title").boundingBox()]);
        expectGeometry(Math.abs((title!.y + title!.height / 2) - (tile!.y + tile!.height / 2)), "the title's middle is the tile's middle")
          .toBeLessThanOrEqual(1);
      });

      for (const update of ["available", "release-page", "failed"]) {
        test(`the ${update} state's actions sit under the text at full width, primary last, each 44px`, async ({ page }) => {
          await page.goto(`/desktop-updates-e2e.html?state=about&update=${update}&theme=${theme}`);
          const block = page.locator(".update-block");
          await expect(block.locator(".update-block-title")).toBeVisible();
          const geometry = await block.evaluate((element) => {
            const box = (node: Element | null) => node!.getBoundingClientRect();
            const style = getComputedStyle(element);
            const inner = box(element);
            return {
              left: inner.left + Number.parseFloat(style.paddingLeft),
              right: inner.right - Number.parseFloat(style.paddingRight),
              textBottom: box(element.querySelector(".update-block-text")).bottom,
              buttons: [...element.querySelectorAll(".update-block-actions > button")].map((button) => {
                const rect = button.getBoundingClientRect();
                return { top: rect.top, left: rect.left, right: rect.right, height: rect.height, primary: button.classList.contains("primary") };
              }),
            };
          });
          expect(geometry.buttons.length).toBeGreaterThan(0);
          expectGeometry(geometry.buttons[0]!.top - geometry.textBottom, "the actions start under the text").toBeGreaterThanOrEqual(0);
          for (const [index, button] of geometry.buttons.entries()) {
            expectGeometry(Math.abs(button.height - 44), `button ${index + 1} is 44px tall`).toBeLessThanOrEqual(0.61);
            expectGeometry(Math.abs(button.left - geometry.left), `button ${index + 1} starts at the block's text edge`).toBeLessThanOrEqual(0.61);
            expectGeometry(Math.abs(button.right - geometry.right), `button ${index + 1} ends at the block's edge`).toBeLessThanOrEqual(0.61);
            if (index > 0) {
              expectGeometry(button.top - geometry.buttons[index - 1]!.top, `button ${index + 1} is under the one before it`).toBeGreaterThan(0);
            }
          }
          if (update !== "failed") expect(geometry.buttons.at(-1)!.primary, "the primary is last").toBe(true);
          await expectNoSystemWords(page);
        });
      }
    });
  });
}
