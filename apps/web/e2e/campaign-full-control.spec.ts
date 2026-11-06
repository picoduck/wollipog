import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Campaign Status's Full Control section (#2940): Full Control launches with no preflight panel, so
 * after launch this section shows the boundary, what still comes to the person, the capabilities the
 * launch recorded and where evidence goes. `CAMPAIGN_FULL_CONTROL_EVIDENCE_DIR` saves captures.
 */

const evidence = process.env.CAMPAIGN_FULL_CONTROL_EVIDENCE_DIR;
const viewports = [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }] as const;
const themes = ["dark", "light"] as const;

async function open(page: Page, query: string, viewport: (typeof viewports)[number], theme: string): Promise<Locator> {
  await page.setViewportSize(viewport);
  await page.goto(`/campaign-status-e2e.html?scenario=campaign&${query}&theme=${theme}`);
  const section = page.getByRole("region", { name: "Full Control", exact: true });
  await expect(section).toBeVisible();
  return section;
}

/** The facts of the first `dl.facts` directly under a (sub)section headed `title`. */
function fact(section: Locator, title: string, term: string): Locator {
  const host = title === "Full Control" ? section
    : section.locator("section").filter({ has: section.page().getByRole("heading", { name: title, exact: true }) }).last();
  return host.locator(":scope > dl.facts > div").filter({ has: section.page().getByRole("term").getByText(term, { exact: true }) }).locator("dd");
}

async function noOverflow(section: Locator) {
  const size = await section.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
}

async function capture(page: Page, anchor: Locator, name: string) {
  if (!evidence) return;
  await page.mouse.move(0, 0);
  await anchor.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
  // Running badges pulse forever; only finite transitions can settle.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished)));
  await page.screenshot({ path: `${evidence}/${name}.png` });
}

for (const viewport of viewports) {
  for (const theme of themes) {
    test(`${viewport.name} ${theme}: Human Required rules qualify readiness and the launch's capabilities and evidence are shown`, async ({ page }) => {
      const section = await open(page, "fullControl=rules&scope=grant", viewport, theme);
      await expect(section.locator(":scope > p.section-note")).toHaveText(
        "The Orchestrator runs this campaign end to end, except the decisions listed under Human Required.");
      await expect(fact(section, "Full Control", "Maximum Issues")).toHaveText("21 Derived");
      await expect(fact(section, "Full Control", "Operations")).toHaveText(/^Implementation Questions, PR Merge, .*Policy Asks$/);
      await expect(fact(section, "Full Control", "Related Follow-Ups")).toHaveText("Allowed");
      await expect(fact(section, "Full Control", "Closure Reasons")).toHaveText("Completed");
      await expect(fact(section, "Full Control", "Authorized Limits")).toHaveText("No cost or tool-call limit, 3 concurrent workers, 20 accepted follow-ups");
      // The objective is long: truncated, with Show All whose name matches its label.
      const objective = fact(section, "Full Control", "Objective");
      const toggle = objective.getByRole("button", { name: "Show All of the Objective", exact: true });
      await expect(toggle).toHaveText("Show All");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(objective).not.toContainText("deliver an issue in slices");
      await capture(page, section, `full-control-rules-${viewport.name}-${theme}`);
      await toggle.click();
      await expect(objective).toContainText("deliver an issue in slices");
      await expect(objective.getByRole("button", { name: "Show Less of the Objective", exact: true })).toHaveAttribute("aria-expanded", "true");
      await expect(fact(section, "Human Required", "Human Required Governance Rules"))
        .toHaveText("Asks from rules you marked Human Required still come to you under Full Control.");
      // Capabilities: verified ones are counted, the rest listed with their state.
      await expect(section).toContainText("As recorded when Full Control was launched");
      await expect(section).toContainText("4 verified; the rest are listed here.");
      await expect(fact(section, "Capabilities", "Controlled Cross-Model Review")).toHaveText(/^Informational This runner does not offer/);
      await expect(fact(section, "Capabilities", "Execution Isolation")).toHaveText(/^Informational /);
      await expect(fact(section, "Capabilities", "Video Evidence Review")).toHaveText(/^Orchestrator Decides /);
      await expect(fact(section, "Capabilities", "Externally Stored Evidence")).toHaveText(/^Orchestrator Decides /);
      await capture(page, section.getByRole("heading", { name: "Human Required", exact: true }), `full-control-rules-capabilities-${viewport.name}-${theme}`);
      await expect(fact(section, "Evidence", "Destination")).toHaveText("Private Session Artifacts");
      await expect(fact(section, "Evidence", "Screenshot Reviewer")).toHaveText("Claude Code · claude-opus-5-5");
      await expect(fact(section, "Evidence", "Provider Retention")).toHaveText(/^Screenshot evidence images are sent to the Orchestrator's selected provider/);
      await expect(fact(section, "Evidence", "Screenshot Review")).toHaveText("Available");
      await expect(fact(section, "Evidence", "Video Review")).toHaveText(/^Unavailable.*no current live proof certifies/);
      await capture(page, section.getByRole("heading", { name: "Evidence", exact: true }), `full-control-rules-evidence-${viewport.name}-${theme}`);
      // Beside it, the Scope Grant doesn't repeat Maximum Issues or the operations.
      const grant = page.getByRole("region", { name: "Scope Grant", exact: true });
      await expect(grant).toBeVisible();
      await expect(grant.getByRole("term").getByText("Maximum Issues", { exact: true })).toHaveCount(0);
      await expect(grant.getByRole("term").getByText("Operations", { exact: true })).toHaveCount(0);
      await expect(grant.getByRole("term").getByText("Withheld by Your Message", { exact: true })).toHaveCount(1);
      await noOverflow(section);
    });

    test(`${viewport.name} ${theme}: with no Human Required rule and full capabilities the section claims end to end`, async ({ page }) => {
      const section = await open(page, "fullControl=ready", viewport, theme);
      await expect(section.locator(":scope > p.section-note")).toHaveText("The Orchestrator runs this campaign end to end.");
      await expect(section).toContainText("None. Nothing in this campaign comes to you.");
      await expect(section.getByRole("heading", { name: "Limited Capabilities", exact: true })).toHaveCount(0);
      await expect(fact(section, "Full Control", "Objective").getByRole("button")).toHaveCount(0);
      await capture(page, section, `full-control-ready-${viewport.name}-${theme}`);
      await noOverflow(section);
    });

    test(`${viewport.name} ${theme}: a campaign authorized before the launch record reads Not Recorded`, async ({ page }) => {
      const section = await open(page, "fullControl=old", viewport, theme);
      await expect(fact(section, "Capabilities", "Recorded")).toHaveText("Not RecordedThis campaign was authorized before Wollipog recorded its capabilities.");
      await expect(fact(section, "Evidence", "Destination")).toHaveText("Not Recorded");
      await expect(fact(section, "Evidence", "Screenshot Reviewer")).toHaveText("Not Recorded");
      await expect(fact(section, "Evidence", "Screenshot Review")).toHaveText("Available");
      await capture(page, section.getByRole("heading", { name: "Capabilities", exact: true }), `full-control-old-${viewport.name}-${theme}`);
      await noOverflow(section);
    });

    test(`${viewport.name} ${theme}: an Orchestrator that can't view images qualifies readiness with its reason`, async ({ page }) => {
      const section = await open(page, "fullControl=degraded", viewport, theme);
      await expect(section.locator(":scope > p.section-note")).toHaveText(
        "The Orchestrator runs this campaign, but some capabilities it needs are limited, so it may not finish unattended.");
      await expect(fact(section, "Limited Capabilities", "Screenshot Evidence Review")).toHaveText(/does not accept image input/);
      await expect(fact(section, "Capabilities", "Screenshot Evidence Review")).toHaveText(/^Orchestrator Decides /);
      await expect(section).toContainText("As recorded when Full Control was enabled");
      await expect(fact(section, "Evidence", "Screenshot Reviewer")).toHaveText("None. The Orchestrator reviews no images.");
      await expect(fact(section, "Evidence", "Screenshot Review")).toHaveText(/does not accept image input/);
      await expect(section.getByRole("term").getByText("Provider Retention", { exact: true })).toHaveCount(0);
      await capture(page, section, `full-control-degraded-${viewport.name}-${theme}`);
      await noOverflow(section);
    });
  }
}
