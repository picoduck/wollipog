import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Reviewable captures of the machine's Agents section and Agent Details (#2990) at desktop and
 * phone sizes in both themes. Runs only with WOLLIPOG_EVIDENCE_DIR set. Behaviour is asserted in
 * machine-management.spec.ts and MachineAgentsSection.dom.test.tsx. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;

const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;
const THEMES = ["dark", "light"] as const;
type Scenario = "agent-states" | "no-agents-ready" | "batch-wrapper";

test.skip(!evidenceDir, "set WOLLIPOG_EVIDENCE_DIR to capture evidence");

async function open(page: Page, theme: (typeof THEMES)[number], scenario: Scenario): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => {
    localStorage.setItem("wollipog.theme", value);
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  }, theme);
  await page.goto("/machine-management-e2e.html?machine=native-t14s");
  await expect(page.locator("article.machine-detail")).toBeVisible();
  await page.evaluate((value) => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario(value), scenario);
  // The fixture has no appearance bootstrap; set the theme on the document it renders into.
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

const agentRow = (page: Page, name: string) => page.locator("article.machine-detail button.row")
  .filter({ has: page.locator(".row-title", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });

async function capture(page: Page, name: string): Promise<void> {
  // Sheets slide in and lists settle; capture the still state.
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(evidenceDir!, `${name}.png`), fullPage: true });
}

for (const size of SIZES) {
  for (const theme of THEMES) {
    const suffix = `${size.name}-${theme}`;
    test.describe(`${size.width}px ${theme}`, () => {
      test.use({ viewport: { width: size.width, height: size.height } });

      test("agent rows and the not-installed disclosure", async ({ page }) => {
        await open(page, theme, "agent-states");
        await expect(agentRow(page, "Gemini CLI")).toBeVisible();
        await agentRow(page, "Claude Code (v2.1.4)").scrollIntoViewIfNeeded();
        await capture(page, `agent-rows-${suffix}`);
      });

      test("no agents ready", async ({ page }) => {
        await open(page, theme, "no-agents-ready");
        await expect(page.locator("article.machine-detail .state")).toContainText("No Agents Ready");
        await page.locator("article.machine-detail .state").scrollIntoViewIfNeeded();
        await capture(page, `no-agents-ready-${suffix}`);
      });

      for (const [slug, name, notInstalled] of [
        ["ready", "Claude Code (v2.1.4)", false],
        ["sign-in-required", "Codex App Server (v0.155.1)", false],
        ["update-required", "Codex App Server (v0.140.0)", false],
        ["approval-required", "Gemini CLI", false],
        ["not-installed", "Claude Code (WSL: Ubuntu)", true],
      ] as const) {
        test(`Agent Details: ${slug}`, async ({ page }) => {
          await open(page, theme, "agent-states");
          if (notInstalled) await page.locator("article.machine-detail details.disclosure > summary").filter({ hasText: "Not Installed" }).click();
          await agentRow(page, name).click();
          await expect(page.getByRole("dialog", { name })).toBeVisible();
          await capture(page, `agent-details-${slug}-${suffix}`);
        });
      }

      test("Agent Details: reference-only Windows launch", async ({ page }) => {
        await open(page, theme, "batch-wrapper");
        await agentRow(page, "Codex App Server").click();
        const details = page.getByRole("dialog", { name: "Codex App Server" });
        await details.getByText("Executable", { exact: true }).scrollIntoViewIfNeeded();
        await capture(page, `agent-details-reference-only-${suffix}`);
      });

      test("Approve Launch confirmation", async ({ page }) => {
        await open(page, theme, "agent-states");
        await agentRow(page, "Gemini CLI").click();
        await page.getByRole("dialog", { name: "Gemini CLI" }).getByRole("button", { name: "Approve Launch…" }).click();
        await expect(page.getByRole("button", { name: "Approve Launch", exact: true })).toBeVisible();
        await capture(page, `approve-launch-${suffix}`);
      });

      test("Revoke Approval confirmation", async ({ page }) => {
        await open(page, theme, "agent-states");
        await agentRow(page, "Goose").click();
        await page.getByRole("dialog", { name: "Goose" }).getByRole("button", { name: "Revoke Approval…" }).click();
        await expect(page.getByRole("button", { name: "Revoke Approval", exact: true })).toBeVisible();
        await capture(page, `revoke-approval-${suffix}`);
      });
    });
  }
}
