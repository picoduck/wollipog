import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

/**
 * The automation card disclosure (#793), across the two widths the acceptance criteria call out.
 * `AutomationsView.dom.test.tsx` covers the component logic (default state, independent expansion,
 * polling, deletion, keyboard) against a fake DOM; this is the one thing that cannot be automated
 * there — real layout, real CSS, real touch-target geometry.
 */

async function open(page: Page) {
  await page.goto("/automations-e2e.html?theme=dark");
  await expect(page.getByRole("button", { name: /Nightly Dependency Sweep/ })).toBeVisible();
}

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1280, height: 900 } },
  { label: "mobile", viewport: { width: 375, height: 812 } },
]) {
  test.describe(`${label} width`, () => {
    test.use({ viewport });

    test("cards start collapsed, showing only name, summary, state, and the toggle", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toContainText("Enabled");
      // The header carries the action summary, not the automation's prompt.
      await expect(toggle).toContainText("Create agent-1 session on runner-1");
      await expect(page.getByText("Schedule", { exact: true })).toHaveCount(0);
      // Exact names throughout: the toggle's own accessible name ends in "Enabled" or "Paused",
      // which a substring match on "Enable"/"Pause" would pick up instead of the action button.
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    });

    test("activating the toggle expands the card and reveals its details and actions", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const bodyId = await toggle.getAttribute("aria-controls");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const body = page.locator(`#${bodyId}`);
      await expect(body).toBeVisible();
      await expect(body.getByText("Schedule", { exact: true })).toBeVisible();
      await expect(body.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await expect(body.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(`#${bodyId}`)).toHaveCount(0);
    });

    test("multiple cards expand independently", async ({ page }) => {
      await open(page);
      const first = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const second = page.getByRole("button", { name: /Weekly Digest/ });
      await first.click();
      await second.click();
      await expect(first).toHaveAttribute("aria-expanded", "true");
      await expect(second).toHaveAttribute("aria-expanded", "true");
      // Both bodies visible at once, and each shows its own management actions (Pause vs. Enable).
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible();

      await first.click();
      await expect(first).toHaveAttribute("aria-expanded", "false");
      await expect(second).toHaveAttribute("aria-expanded", "true");
    });

    test("Enter and Space both activate the disclosure from the keyboard", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    test("toggling keeps focus on the control and does not scroll the page", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      await toggle.focus();
      const scrollBefore = await page.evaluate(() => window.scrollY);

      // Collapsing unmounts the body; the control itself is never unmounted, so focus must stay on
      // it rather than falling back to <body> and stranding a keyboard user at the top of the page.
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toBeFocused();
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    });

    test("the toggle meets its minimum target size and stays inside the viewport", async ({ page }) => {
      await open(page);
      const toggle = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const box = await toggle.boundingBox();
      expect(box).not.toBeNull();
      // 44px is the comfortable touch target the mobile stylesheet guarantees; on desktop the
      // pointer target only has to clear the WCAG 2.2 minimum.
      expect(box!.height).toBeGreaterThanOrEqual(label === "mobile" ? 44 : 24);
      // A long automation name must wrap rather than push the header out of the viewport.
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    });
  });
}

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1280, height: 900 } },
  { label: "mobile", viewport: { width: 375, height: 812 } },
]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${label} ${theme} inherited alternate workflow pins`, () => {
      test.use({ viewport });
      test("shows the edited primary identity in inherited alternate selectors", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}&workflow-machine-switch&orchestrator-bound&inherited-alternate-pins`);
        await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await expect(page.getByRole("button", { name: "Alternate Agent-1 Agent: Claude Code" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Alternate Orchestrator Agent: Claude Code" })).toBeVisible();
        const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-inherited-pins-before-${label}-${theme}.png`), fullPage: true,
        });

        await page.getByRole("button", { name: "Agent-1 Agent: Claude Code", exact: true }).click();
        await page.getByRole("option", { name: "Codex App Server" }).click();
        await page.getByRole("button", { name: "Orchestrator Agent: Claude Code", exact: true }).click();
        await page.getByRole("option", { name: "Codex App Server" }).click();
        await expect(page.getByRole("button", { name: "Alternate Agent-1 Agent: Codex App Server" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Alternate Orchestrator Agent: Codex App Server" })).toBeVisible();
        await expect(page.getByText(/This saved alternate (role|orchestrator) installation is unavailable or unbound/)).toHaveCount(0);
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-inherited-pins-after-${label}-${theme}.png`), fullPage: true,
        });
      });
    });

    test.describe(`${label} ${theme} workflow orchestrator installation`, () => {
      test.use({ viewport });
      test("shows a card warning when the saved orchestrator has no installation binding", async ({ page }) => {
        const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
        const card = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
        await page.goto(`/automations-e2e.html?theme=${theme}&workflow-machine-switch&orchestrator-bound`);
        await card.click();
        await expect(page.getByText(/Saved Agent Harness installation unavailable or unbound/)).toHaveCount(0);
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-orchestrator-before-${label}-${theme}.png`), fullPage: true,
        });
        await page.goto(`/automations-e2e.html?theme=${theme}&workflow-machine-switch&orchestrator-unbound`);
        await card.click();
        await expect(page.getByText(/Saved Agent Harness installation unavailable or unbound/)).toBeVisible();
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-orchestrator-after-${label}-${theme}.png`), fullPage: true,
        });
      });
    });

    test.describe(`${label} ${theme} alternate installation`, () => {
      test.use({ viewport });
      test("shows a card warning when an alternate's saved installation disappears", async ({ page }) => {
        const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
        const card = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
        await page.goto(`/automations-e2e.html?theme=${theme}&alternate-installation=available`);
        await card.click();
        await expect(page.getByText(/Saved Agent Harness installation unavailable or unbound/)).toHaveCount(0);
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-alternate-before-${label}-${theme}.png`), fullPage: true,
        });
        await page.goto(`/automations-e2e.html?theme=${theme}&alternate-installation=unavailable`);
        await card.click();
        await expect(page.getByText(/Saved Agent Harness installation unavailable or unbound/)).toBeVisible();
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-alternate-after-${label}-${theme}.png`), fullPage: true,
        });
      });
    });
  }
}

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1280, height: 900 } },
  { label: "mobile", viewport: { width: 375, height: 812 } },
]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${label} ${theme} workflow Machine switch`, () => {
      test.use({ viewport });
      test("shows the new Machine's configured role instead of the old installation", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}&workflow-machine-switch`);
        await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-machine-before-${label}-${theme}.png`), fullPage: true,
        });
        await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption("runner-2");
        await expect(page.getByRole("button", { name: "Agent-1 Agent: Configured Agent" })).toBeVisible();
        await expect(page.getByText(/This saved role installation is unavailable or unbound/)).toHaveCount(0);
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-machine-after-${label}-${theme}.png`), fullPage: true,
        });
      });
    });
  }
}

test("configured trigger controls and content-free delivery provenance are visible", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();

  await expect(page.getByText("Accepts Prompt · Parameters issue, priority", { exact: true })).toBeVisible();
  await page.getByText("Execution History (1)", { exact: true }).click();
  await expect(page.getByText(/Delivered Fields: Prompt · Parameters issue, priority/)).toBeVisible();
  await expect(page.getByText(/Prompt Digest 95a911a82fc5…/)).toBeVisible();

  await page.getByRole("button", { name: "Add Webhook", exact: true }).click();
  await page.getByRole("checkbox", { name: "Accept Delivery Fields" }).check();
  await expect(page.getByRole("checkbox", { name: "Delivered Prompt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Missing References" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Parameter Names" })).toBeVisible();
});

test("outbound subscription state, privacy defaults, pause reason, and journal are visible", async ({ page }) => {
  await open(page);
  const outbound = page.locator(".outbound-event-subscription");
  await expect(page.getByRole("heading", { name: "Outbound Events" })).toBeVisible();
  await expect(outbound.getByText("Paused", { exact: true })).toBeVisible();
  await expect(outbound.getByText("Session Name Excluded", { exact: true })).toBeVisible();
  await expect(outbound.getByText("Question Title Excluded", { exact: true })).toBeVisible();
  await expect(outbound.getByText("Paused after 6 bounded delivery attempts", { exact: true })).toBeVisible();
  await outbound.getByText("Delivery Journal (2)", { exact: true }).click();
  await expect(outbound.getByText("Session Created · Failed", { exact: true })).toBeVisible();
  await expect(outbound.getByText("Checks Failed · Retrying", { exact: true })).toBeVisible();
  await expect(outbound.getByText("HTTP 503", { exact: true })).toHaveCount(2);
  await expect(outbound.getByText(/Next Retry/)).toBeVisible();
});

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1280, height: 900 } },
  { label: "mobile", viewport: { width: 375, height: 812 } },
]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${label} ${theme} saved installation`, () => {
      test.use({ viewport });
      test("shows an actionable unavailable choice", async ({ page }) => {
        const openEditor = async (saved: boolean) => {
          await page.goto(`/automations-e2e.html?theme=${theme}${saved ? "&saved-installation" : ""}`);
          await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
          await page.getByRole("button", { name: "Edit", exact: true }).click();
        };
        await openEditor(false);
        const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
        if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `automation-before-${label}-${theme}.png`), fullPage: true });
        await openEditor(true);
        await expect(page.getByText(/saved Agent Harness installation is unavailable or unbound/i)).toBeVisible();
        await expect(page.getByRole("button", { name: "Use Current Installation" })).toBeEnabled();
        if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `automation-after-${label}-${theme}.png`), fullPage: true });
      });
    });
  }
}
