import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

/**
 * The automation page (#2968), opened from the list's cards or directly by its route, at the
 * widths and themes its acceptance criteria name. `AutomationDetail.dom.test.tsx` and
 * `AutomationsView.dom.test.tsx` cover the component logic against a fake DOM; this is what cannot
 * be automated there: real layout, real CSS, real touch-target geometry. With
 * `WOLLIPOG_EVIDENCE_DIR` set, each state is also captured as UI evidence.
 */

const NIGHTLY = "Nightly Dependency Sweep and Long-Running Audit Report";

/** `/automations/~<id>`: the id as UTF-16LE base64url, as `encodeResourceId` writes it. */
function automationRoute(id: string): string {
  return `/automations/~${Buffer.from(id, "utf16le").toString("base64url")}`;
}

async function open(page: Page) {
  await page.goto("/automations-e2e.html?theme=dark");
  await expect(page.getByRole("button", { name: /Nightly Dependency Sweep/ })).toBeVisible();
}

async function openPage(page: Page, id: string, theme: string, scenario = "") {
  await page.goto(`/automations-e2e.html?theme=${theme}&route=${encodeURIComponent(automationRoute(id))}${scenario}`);
  await expect(page.locator(".automation-detail .glance")).toBeVisible();
}

async function capture(page: Page, name: string) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
}

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1280, height: 900 } },
  { label: "mobile", viewport: { width: 375, height: 812 } },
]) {
  test.describe(`${label} width list`, () => {
    test.use({ viewport });

    test("a row shows its name, schedule, next run and target, and opens the automation's page", async ({ page }) => {
      await open(page);
      const card = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      await expect(card).not.toHaveAttribute("aria-expanded");
      // The schedule is in the automation's own zone; its next run is in the browser's, from its clock.
      await expect(card).toContainText(label === "mobile" ? /Next \w+, \d{1,2}:\d{2} [AP]M/ : "Every day at 2:00 AM");
      await expect(card).not.toContainText("agent-1");
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      await card.click();
      await expect(page.getByRole("heading", { level: 1, name: NIGHTLY })).toBeVisible();
      await page.getByRole("button", { name: "Back to Automations", exact: true }).click();
      await expect(page.getByRole("button", { name: /Weekly Digest/ })).toBeVisible();
    });

    test("the card's heading meets its minimum target size and stays inside the viewport", async ({ page }) => {
      await open(page);
      const card = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(label === "mobile" ? 44 : 24);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    });
  });
}

for (const { label, viewport } of [
  { label: "1440", viewport: { width: 1440, height: 900 } },
  { label: "834", viewport: { width: 834, height: 1112 } },
  { label: "390", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  const phone = label === "390";
  test.describe(`${label}px ${theme} automation page`, () => {
    test.use({ viewport });

    test("an enabled automation that has run: one badge, the glance, its sentence and its rules", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openPage(page, "automation-nightly-sweep", theme);
      const bar = page.locator(".automation-detail .detail-bar");
      await expect(bar.getByRole("heading", { level: 1 })).toHaveText(NIGHTLY);
      if (phone) {
        await expect(bar.locator(".status")).toHaveCount(0);
        await expect(page.locator(".automation-status .status")).toHaveText("Enabled");
        await expect(bar.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
        await expect(bar.locator(".detail-bar-action.icon-only")).toHaveAccessibleName("Edit");
      } else {
        await expect(bar.locator(".status")).toHaveText("Enabled");
        await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
        await expect(bar.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      }
      const glance = page.locator(".glance");
      await expect(glance.locator("dt")).toHaveText(["Next Run", "Last Run", "Schedule"]);
      await expect(glance).toContainText("Every day at 2:00 AM");
      await expect(page.locator(".automation-sentence")).toHaveText("Starts Agent in Home on runner-1.");
      const labels = page.locator(".automation-detail dl.facts dt");
      await expect(labels).toHaveCount(6);
      expect(await labels.first().evaluate((element) => getComputedStyle(element).textTransform)).toBe("none");
      // Under 760px the glance stacks as three lines, each label beside its value.
      const rows = await glance.locator("dt").evaluateAll((terms) => terms.map((term) => {
        const value = term.nextElementSibling!.getBoundingClientRect();
        const box = term.getBoundingClientRect();
        return { top: box.top, valueTop: value.top, left: box.left, valueLeft: value.left };
      }));
      if (phone) {
        expect(rows[1]!.top).toBeGreaterThan(rows[0]!.top);
        expect(rows[2]!.top).toBeGreaterThan(rows[1]!.top);
        for (const row of rows) expect(row.valueLeft).toBeGreaterThan(row.left);
      } else {
        expect(Math.abs(rows[1]!.top - rows[0]!.top)).toBeLessThan(2);
      }
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(viewport.width);
      await capture(page, `automation-page-ran-${label}-${theme}`);
      expect(errors).toEqual([]);
    });

    test("a paused automation that never ran", async ({ page }) => {
      await openPage(page, "automation-weekly-digest", theme);
      await expect(page.locator(phone ? ".automation-status .status" : ".detail-bar .status")).toHaveText("Paused");
      await expect(page.locator(".glance dd").nth(0)).toHaveText("Paused");
      await expect(page.locator(".glance dd").nth(1)).toHaveText("Not yet");
      await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
      await capture(page, `automation-page-never-ran-${label}-${theme}`);
    });

    test("needs attention: a failed run and a waiting target are one danger notice with +1 More", async ({ page }) => {
      await openPage(page, "automation-nightly-sweep", theme, "&failed-run&waiting-target");
      const notices = page.locator(".automation-notice-slot .notice");
      await expect(notices).toHaveCount(1);
      await expect(notices.locator(".notice-title")).toHaveText("Last Run Failed");
      await expect(notices).toHaveClass(/t-danger/);
      await expect(notices.getByRole("button", { name: "+1 More" })).toBeVisible();
      await expect(page.locator('.automation-detail [role="alert"]')).toHaveCount(1);
      await expect(page.locator(phone ? ".automation-status .status" : ".detail-bar .status")).toHaveText("Last Run Failed");
      await capture(page, `automation-page-needs-attention-${label}-${theme}`);
      await notices.getByRole("button", { name: "+1 More" }).click();
      await page.getByRole("menuitem", { name: "Waiting for runner-1" }).click();
      await expect(page.locator(".automation-notice-slot .notice")).toHaveClass(/t-warning/);
    });

    test("Delete Automation… is last in ⋯ and confirms by name; a phone's confirmation replaces the sheet", async ({ page }) => {
      await openPage(page, "automation-nightly-sweep", theme);
      await page.locator(".detail-bar").getByRole("button", { name: "More Actions" }).click();
      const items = page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem");
      await expect(items.last()).toHaveText("Delete Automation…");
      await items.last().click();
      const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: "Delete Automation" });
      await expect(dialog).toContainText(`“${NIGHTLY}” stops running and is removed, with its 2 triggers. Its run history is kept.`);
      if (phone) {
        await expect(page.getByRole("menu", { name: "More Actions" })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "Back to More Actions" })).toBeVisible();
      }
      await capture(page, `automation-delete-${label}-${theme}`);
      if (phone) {
        await dialog.getByRole("button", { name: "Back to More Actions" }).click();
        await expect(page.getByRole("menu", { name: "More Actions" })).toBeVisible();
      }
    });
  });
}

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1280, height: 900 } },
  { label: "mobile", viewport: { width: 375, height: 812 } },
]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${label} ${theme} target health`, () => {
    test.use({ viewport });
    test("shows an unresolved target in the list and its error as the page's notice", async ({ page }) => {
      await page.goto(`/automations-e2e.html?theme=${theme}&waiting-target`);
      const unhealthy = page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      await expect(unhealthy).toContainText("Target Unavailable");
      // The badge sits on the row's first line, beside the name, at every width (#2969).
      const line = await unhealthy.evaluate((element) => {
        const title = element.querySelector(".row-title")!.getBoundingClientRect();
        const badge = element.querySelector(".status")!.getBoundingClientRect();
        return { titleMiddle: title.top + title.height / 2, badgeTop: badge.top, badgeBottom: badge.bottom };
      });
      expect(line.badgeTop).toBeLessThan(line.titleMiddle);
      expect(line.badgeBottom).toBeGreaterThan(line.titleMiddle);
      await unhealthy.click();
      const notice = page.locator(".automation-notice-slot .notice");
      await expect(notice.locator(".notice-title")).toHaveText("Waiting for runner-1");
      await expect(notice).toContainText("None of this automation's machines can run it now.");
      await capture(page, `automation-target-${label}-${theme}`);
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
        await expect(page.getByRole("button", { name: "Other Auditor Agent: Claude Code" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Other Orchestrator Agent: Claude Code" })).toBeVisible();
        const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-inherited-pins-before-${label}-${theme}.png`), fullPage: true,
        });

        await page.getByRole("button", { name: "Auditor Agent: Claude Code", exact: true }).click();
        await page.getByRole("option", { name: "Codex App Server" }).click();
        await page.getByRole("button", { name: "Orchestrator Agent: Claude Code", exact: true }).click();
        await page.getByRole("option", { name: "Codex App Server" }).click();
        await expect(page.getByRole("button", { name: "Other Auditor Agent: Codex App Server" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Other Orchestrator Agent: Codex App Server" })).toBeVisible();
        await expect(page.getByText(/The saved installation of (this role's|the Orchestrator's) agent isn't available on the other machine\./)).toHaveCount(0);
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
        await expect(page.getByText(/This automation's agent installation isn't available\. Edit the automation to choose another installation\./)).toHaveCount(0);
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-orchestrator-before-${label}-${theme}.png`), fullPage: true,
        });
        await page.goto(`/automations-e2e.html?theme=${theme}&workflow-machine-switch&orchestrator-unbound`);
        await card.click();
        await expect(page.getByText(/This automation's agent installation isn't available\. Edit the automation to choose another installation\./)).toBeVisible();
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
        await expect(page.getByText(/This automation's agent installation isn't available\. Edit the automation to choose another installation\./)).toHaveCount(0);
        if (evidenceDir) await page.screenshot({
          path: join(evidenceDir, `automation-alternate-before-${label}-${theme}.png`), fullPage: true,
        });
        await page.goto(`/automations-e2e.html?theme=${theme}&alternate-installation=unavailable`);
        await card.click();
        await expect(page.getByText(/This automation's agent installation isn't available\. Edit the automation to choose another installation\./)).toBeVisible();
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
        await page.getByRole("button", { name: "Machine: runner-1", exact: true }).click();
        await page.getByRole("option", { name: "runner-2" }).click();
        await expect(page.getByRole("button", { name: "Auditor Agent: Configured Agent" })).toBeVisible();
        await expect(page.getByText(/The saved installation of this role's agent isn't available\./)).toHaveCount(0);
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

  await expect(page.getByText("Accepts prompt text and issue, priority", { exact: true })).toBeVisible();
  // Run Details names what a signed delivery brought, never its content or its prompt digest (#2970).
  await page.locator('tr[data-execution-id="axe_issue_1099"] .actions-cell button[aria-haspopup="menu"]').click();
  await page.getByRole("menuitem", { name: "Run Details…" }).click();
  const details = page.locator('[role="dialog"].automation-run-details');
  await expect(details.locator(".facts")).toContainText("Prompt text, Named values (issue, priority)");
  await expect(details).not.toContainText("95a911a82fc5");
  await details.getByRole("button", { name: "Done" }).click();

  await page.locator(".detail-bar").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Add Webhook Trigger…" }).click();
  const dialog = page.getByRole("dialog", { name: "New Webhook Trigger" });
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
  await dialog.getByRole("switch", { name: "Let Callers Add Details" }).click();
  await expect(dialog.getByRole("checkbox", { name: "Prompt Text" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "If a Referenced Value Is Missing" })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Named Values" })).toBeVisible();
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
        await expect(page.getByText(/The saved installation of this agent isn't available\. This automation waits until you choose an available installation\./)).toBeVisible();
        await expect(page.getByRole("button", { name: "Use Current Installation" })).toBeEnabled();
        if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `automation-after-${label}-${theme}.png`), fullPage: true });
      });
    });
  }
}

/* Every installation and target sentence of #3220 where it renders, in a real browser. */
for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1280, height: 900 } },
  { label: "mobile", viewport: { width: 375, height: 812 } },
]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${label} ${theme} installation and target wording`, () => {
      test.use({ viewport });
      const capture = async (page: Page, name: string) => {
        const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
        if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `${name}-${label}-${theme}.png`), fullPage: true });
      };
      const card = (page: Page) => page.getByRole("button", { name: /Nightly Dependency Sweep/ });
      const saveError = (page: Page, text: string) => page.locator(".field-error").filter({ hasText: text });

      test("names both waiting reasons in the page's notice and the expired run", async ({ page }) => {
        for (const [variant, reason] of [
          ["", "None of this automation's machines can run it now. " +
            "Check that the machine is online and up to date and still has the workspace and project."],
          ["=installation", "This automation's agent installation isn't available on any of its machines. " +
            "Choose an installation in Machine Settings, or edit the automation to choose another machine."],
        ] as const) {
          await page.goto(`/automations-e2e.html?theme=${theme}&waiting-target${variant}&expired-run`);
          await card(page).click();
          await expect(page.locator(".automation-notice-slot .notice-body")).toHaveText(reason);
          await page.locator('tr[data-execution-id="axe_expired"] .actions-cell button[aria-haspopup="menu"]').click();
          await page.getByRole("menuitem", { name: "Run Details…" }).click();
          const details = page.locator('[role="dialog"].automation-run-details');
          await expect(details.locator(".notice-body")).toHaveText(reason);
          await capture(page, `automation-wording-waiting${variant ? "-installation" : ""}-run-details`);
          await details.getByRole("button", { name: "Done" }).click();
          await capture(page, `automation-wording-waiting${variant ? "-installation" : ""}`);
        }
      });

      test("names the machine a create-session rebind needs when its installation disappears", async ({ page }) => {
        for (const alternate of [false, true]) {
          await page.goto(`/automations-e2e.html?theme=${theme}&rediscover&${alternate
            ? "alternate-installation=unavailable" : "saved-installation"}`);
          await card(page).click();
          await expect(page.getByText(
            "This automation's agent installation isn't available. Edit the automation to choose another installation.",
            { exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          await expect(page.getByText(alternate
            ? "The saved installation of this agent isn't available on the other machine."
            : "The saved installation of this agent isn't available. This automation waits until you choose an available installation.",
          )).toBeVisible();
          await capture(page, `automation-wording-${alternate ? "alternate" : "primary"}-warning`);
          await page.getByRole("button", { name: "Use Current Installation" }).click();
          await page.evaluate(() => (window as unknown as { automationsRediscover: () => void }).automationsRediscover());
          await page.getByRole("button", { name: "Save Changes" }).click();
          await expect(saveError(page, alternate
            ? "Choose an available installation of this agent on the other machine."
            : "Choose an available installation of this agent on this machine.")).toBeVisible();
          await capture(page, `automation-wording-${alternate ? "alternate" : "primary"}-save-error`);
        }
      });

      test("names unavailable workflow pins and the machine a role rebind needs", async ({ page }) => {
        for (const alternate of [false, true]) {
          await page.goto(`/automations-e2e.html?theme=${theme}&workflow-machine-switch&orchestrator-bound` +
            "&inherited-alternate-pins&unavailable-pins&rediscover");
          await card(page).click();
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          const warning = (text: string) => page.locator(".notice.t-warning").filter({ hasText: text });
          for (const text of [
            "The saved installation of this role's agent isn't available.Use",
            "The saved installation of the Orchestrator's agent isn't available.Use",
            "The saved installation of this role's agent isn't available on the other machine.",
            "The saved installation of the Orchestrator's agent isn't available on the other machine.",
          ]) await expect(warning(text)).toBeVisible();
          if (!alternate) await capture(page, "automation-wording-workflow-warnings");
          await warning(alternate
            ? "The saved installation of this role's agent isn't available on the other machine."
            : "The saved installation of this role's agent isn't available.Use",
          ).getByRole("button", { name: "Use Current Installation" }).click();
          await page.evaluate(() => (window as unknown as { automationsRediscover: () => void }).automationsRediscover());
          await page.getByRole("button", { name: "Save Changes" }).click();
          await expect(saveError(page, `Choose an available installation of the agent for Auditor on ${
            alternate ? "the other" : "this"} machine.`)).toBeVisible();
          await capture(page, `automation-wording-workflow-${alternate ? "alternate" : "primary"}-save-error`);
        }
      });
    });
  }
}
