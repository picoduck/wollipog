import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const evidence = process.env.ASSISTANT_DELEGATION_EVIDENCE_DIR;
const thread = viewPath({ name: "assistants", threadId: "thr_triage" });

async function openAssistantFixture(page: Page, path: string, supported = true) {
  await page.goto(`/assistants-e2e.html?delegation=${supported ? "stress" : "old"}&path=${encodeURIComponent(path)}`);
}

for (const theme of ["light", "dark"] as const) {
  for (const [layout, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
    test(`Assistant evidence approval in ${theme} on ${layout}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      const scenario = (state: string) => page.goto(
        `/assistants-e2e.html?theme=${theme}&delegation=stress&evidence=${state}&path=${encodeURIComponent(thread)}`,
      );
      const screenshot = async (state: string) => {
        if (!evidence) return;
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `assistant-evidence-${state}-${theme}-${layout}.png`), animations: "disabled" });
      };
      const dialog = page.getByRole("dialog", { name: "Decision Delegation" });
      const approval = dialog.getByRole("checkbox", { name: "UI Evidence Approval", exact: true });
      const denial = dialog.getByRole("checkbox", { name: "UI Evidence Denial", exact: true });
      const save = dialog.getByRole("button", { name: "Save Grant" });
      const openGrant = async (state: string) => {
        await scenario(state);
        await threadAction(page, "Decision Delegation");
        await expectNoHorizontalOverflow(dialog, "Decision Delegation");
        await expectFullyInViewport(save, "Save Grant");
        await expect(denial).toBeEnabled();
      };

      await openGrant("legacy");
      await expect(approval).toHaveCount(0);
      await screenshot("before");
      await openGrant("unavailable");
      await expect(approval).toBeDisabled();
      await expect(approval).toHaveAccessibleDescription(/Update this Machine’s runner/);
      await approval.scrollIntoViewIfNeeded();
      await screenshot("unavailable");
      await openGrant("available");
      await expect(approval).toBeEnabled();
      await expect(approval).not.toBeChecked();
      await expect(approval).not.toHaveAccessibleDescription(/provider may retain/);
      await approval.focus();
      await approval.scrollIntoViewIfNeeded();
      await screenshot("available-default");
      await approval.check();
      await expect(approval).toHaveAccessibleDescription(/Claude Code.*claude-opus-5-5.*provider may retain/);
      await dialog.getByRole("button", { name: "Project Scope: All Projects" }).click();
      await page.getByRole("option", { name: "Selected Projects" }).click();
      await dialog.getByRole("checkbox", { name: /Release Validation and Engineering/ }).check();
      await expect(dialog).toContainText("Showing 1–5 of 36 projects");
      await approval.scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(dialog, "Grant with provider disclosure and scoped projects");
      await expectFullyInViewport(save, "Save Grant after selecting a project");
      await screenshot("available");
      await save.click();
      await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
        categories: ["ui_evidence_review"], projects: ["project_0"], campaigns: "all", expiresAt: null,
        evidenceDisclosureDigest: "a".repeat(64),
      }));
      await scenario("refused");
      await page.getByRole("button", { name: /Worked.*1 Failed/ }).click();
      await page.getByLabel("Resolve UI Evidence · Failed", { exact: true }).click();
      const message = page.getByText(/UI evidence approval requires current review receipts/);
      await expect(message).toBeVisible();
      await expectPageNoHorizontalOverflow(page);
      await screenshot("refused");
      if (theme === "dark" && layout === "phone") {
        await scenario("refused-stress");
        await page.getByRole("button", { name: /Worked.*1 Failed/ }).click();
        await page.getByLabel("Resolve UI Evidence · Failed", { exact: true }).click();
        await expect(message).toContainText("settings-desktop-dark-preview-01");
        await expect(message).toContainText("settings-desktop-dark-preview-16");
        const output = page.locator("pre.tl-step-output").filter({ hasText: "settings-desktop-dark-preview-16" });
        await expectNoHorizontalOverflow(output, "Long missing-receipt refusal");
        await expectPageNoHorizontalOverflow(page);
        await output.scrollIntoViewIfNeeded();
        await screenshot("refused-stress");
        const scrolled = await output.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        });
        expect(scrolled).toBeGreaterThan(0);
        await screenshot("refused-stress-scrolled");
      }
    });
  }
}

async function threadAction(page: Page, name: string) {
  await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function expectCiRerunHistory(scope: Locator) {
  const subject = scope.getByText("engineering/release-validation · Run 44699507825 · Attempt 2 · Build and Bundle", { exact: true });
  await subject.scrollIntoViewIfNeeded();
  await expectFullyInViewport(subject, "CI Rerun Subject");
  await expect(scope).not.toContainText("ci_rerun:");
}

test("a control plane without delegation support offers no grant or history actions", async ({ page }) => {
  await openAssistantFixture(page, thread, false);
  await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Decision Delegation" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delegated Decisions" })).toHaveCount(0);
});

for (const [layout, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
  const capture = async (page: Page, view: string) => {
    if (!evidence) return;
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `${view}-${layout}.png`), animations: "disabled" });
  };
  test(`a grant that expires is shown as expired on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.clock.install({ time: new Date("2026-11-19T16:00:00Z") });
    await page.goto(`/assistants-e2e.html?delegation=expires&path=${encodeURIComponent(thread)}`);
    const details = page.getByLabel("Thread Details");
    await expect(details).toContainText("Decision Delegation Set");
    await page.clock.fastForward(61_000);
    await expect(details).toContainText("Decision Delegation Expired");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "thread-grant-expired");
  });
  test(`a thread's grant and decision history stay usable on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openAssistantFixture(page, thread);
    await threadAction(page, "Decision Delegation");
    const settings = page.getByRole("dialog", { name: "Decision Delegation" });
    const save = settings.getByRole("button", { name: "Save Grant" });
    const details = page.getByLabel("Thread Details");
    await expect(details).toContainText("Decision Delegation Off");
    await expect(settings.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(settings.getByRole("checkbox", { name: /release|ui evidence approval/i })).toHaveCount(0);
    const ciRerun = settings.getByRole("checkbox", { name: "CI Rerun", exact: true });
    await expect(ciRerun).toBeEnabled();
    await ciRerun.check();
    await expectFullyInViewport(ciRerun, "CI Rerun");
    await capture(page, "ci-rerun-grant");
    await settings.getByRole("checkbox", { name: "Owner Questions", exact: true }).check();
    await settings.getByRole("checkbox", { name: "Pull Request Merge", exact: true }).check();
    await settings.getByRole("button", { name: "Project Scope: All Projects" }).click();
    await expect(page.getByRole("option", { name: "Selected Projects" })).toBeVisible();
    await capture(page, "thread-project-picker");
    await page.getByRole("option", { name: "Selected Projects" }).click();
    await settings.getByRole("checkbox", { name: /Release Validation and Engineering/ }).check();
    await expect(settings).toContainText("Showing 1–5 of 36 projects");
    await expectNoHorizontalOverflow(settings, "Decision Delegation");
    await expectFullyInViewport(save, "Save Grant");
    await capture(page, "thread-project-scope");
    await settings.getByRole("button", { name: "Campaign Scope: All Campaigns" }).click();
    await page.getByRole("option", { name: "Selected Campaigns" }).click();
    await settings.getByRole("checkbox", { name: "Release Campaign 0", exact: true }).check();
    const expiry = settings.getByLabel("Expires at (Optional)");
    await expiry.scrollIntoViewIfNeeded();
    await expectFullyInViewport(expiry, "Expiration");
    await expect(settings).toContainText("Showing 1–5 of 36 campaigns");
    await expectNoHorizontalOverflow(settings, "Decision Delegation");
    await expectFullyInViewport(save, "Save Grant");
    await capture(page, "thread-campaign-scope");
    await save.click();
    await expect(settings).toHaveCount(0);
    await expect(details).toContainText("Decision Delegation Set");
    await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
      categories: ["ci_rerun", "owner_question", "pr_merge"], projects: ["project_0"], campaigns: ["campaign_0"], expiresAt: null,
    }));
    await threadAction(page, "Decision Delegation");
    const revoke = settings.getByRole("button", { name: "Revoke Grant" });
    await expiry.scrollIntoViewIfNeeded();
    await expectFullyInViewport(revoke, "Revoke Grant");
    await expectFullyInViewport(expiry, "Expiration on an existing grant");
    await capture(page, "thread-existing-grant");
    await revoke.click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", "null");
    await expect(details).toContainText("Decision Delegation Off");
    await capture(page, "thread-grant-revoked");
    await threadAction(page, "Delegated Decisions");
    const history = page.getByRole("dialog", { name: "Delegated Decisions" });
    await expect(history).toContainText("under your delegation.");
    await expect(history).toContainText("Triage Open Issues");
    await expect(history.getByRole("listitem")).toHaveCount(5);
    await expectCiRerunHistory(history);
    await expectNoHorizontalOverflow(history, "Thread Decision History");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "thread-history");
  });

  test(`CI rerun category explains an unavailable capability on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`/assistants-e2e.html?delegation=ci-old&path=${encodeURIComponent(thread)}`);
    await threadAction(page, "Decision Delegation");
    const settings = page.getByRole("dialog", { name: "Decision Delegation" });
    await expect(settings.getByRole("checkbox", { name: "CI Rerun", exact: true })).toBeDisabled();
    const explanation = settings.getByText("Update the control plane to grant CI rerun decisions.");
    await explanation.scrollIntoViewIfNeeded();
    await expectFullyInViewport(explanation, "Capability Explanation");
    await expectNoHorizontalOverflow(settings, "Decision Delegation");
    await capture(page, "ci-rerun-unavailable");
  });

  test(`the CI rerun approval shows its exact job and commit on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/assistants-e2e.html?delegation=stress&ci-rerun&path=%2F");
    if (layout === "phone") await page.getByRole("button", { name: /Investigate the CI Failure/ }).click();
    await expect(page.getByText("CI Rerun Approval Required", { exact: true })).toBeVisible();
    const target = page.getByLabel("CI Rerun Target");
    await expectFullyInViewport(target, "CI Rerun Target");
    for (const label of ["Repository", "Workflow Run", "Job and Dependents", "Head Commit", "Attempt"]) {
      await expectFullyInViewport(target.getByText(label, { exact: true }), label);
    }
    await expect(target.getByRole("link", { name: "#44699507825" })).toHaveAttribute("href", /\/actions\/runs\/44699507825$/u);
    const job = target.getByRole("link", { name: "Build and Bundle (#136164180219)", exact: true });
    await expect(job).toHaveText("Build and Bundle");
    await expect(job).toHaveAttribute("href", /\/job\/136164180219$/u);
    await expect(job).toHaveAttribute("title", "Job #136164180219");
    const head = target.getByRole("link", { name: /Head Commit 2d99e227b73fcad015264f7fe04674953df724b1/ });
    await expect(head).toHaveText("2d99e227b7");
    await expect(head).toHaveAttribute("title", "2d99e227b73fcad015264f7fe04674953df724b1");
    await expect(target.getByText("2", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(target, "CI Rerun Target");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "ci-rerun-request");
  });

  if (layout === "phone") test("the CI rerun approval wraps long names and keeps actions reachable on phone", async ({ page }) => {
    await page.setViewportSize({ width, height: 724 });
    await page.goto("/assistants-e2e.html?delegation=stress&ci-rerun=long&path=%2F");
    await page.getByRole("button", { name: /Investigate the CI Failure/ }).click();
    const target = page.getByLabel("CI Rerun Target");
    const card = page.locator(".request-card").filter({ has: target });
    const repository = target.getByText("some-organization-name/an-unusually-long-repository-name", { exact: true });
    const jobName = "Build, Typecheck and Bundle the Desktop Sidecar for Linux arm64";
    const job = target.getByRole("link", { name: `${jobName} (#98765432198765)`, exact: true });
    const approve = card.getByRole("button", { name: "Approve", exact: true });
    const deny = card.getByRole("button", { name: "Deny", exact: true });
    await approve.click({ trial: true });
    await deny.click({ trial: true });
    // Expand to read every fact at once in the compact, scrollable dock.
    await card.getByRole("button", { name: "Expand Decision", exact: true }).click();
    await expect(card.getByRole("button", { name: "Collapse Decision", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expectFullyInViewport(target, "CI Rerun Target");
    await expectFullyInViewport(repository, "Long Repository Name");
    await expect(job).toHaveText(jobName);
    await expectFullyInViewport(job, "Long Job Name");
    await expect(job).toHaveAttribute("title", "Job #98765432198765");
    await expectFullyInViewport(target.getByText("Job and Dependents", { exact: true }), "Job and Dependents");
    const run = target.getByRole("link", { name: "#98765432109", exact: true });
    await expect(run).toHaveCSS("white-space", "nowrap");
    await expect(run).toHaveAttribute("title", "#98765432109");
    expect(await run.evaluate((link) => link.scrollWidth <= link.clientWidth)).toBe(true);
    await expect(target.getByRole("link", { name: /Head Commit/ })).toHaveCSS("white-space", "nowrap");
    await approve.click({ trial: true });
    await deny.click({ trial: true });
    await expectNoHorizontalOverflow(card, "CI Rerun Approval Card");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "ci-rerun-request-long-values");
  });

  test(`Inbox and Campaign Status show bounded delegated decisions on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openAssistantFixture(page, "/");
    await page.getByRole("button", { name: "More Actions", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Delegated Decisions", exact: true }).click();
    const history = page.getByRole("dialog", { name: "Delegated Decisions" });
    await expect(history).toContainText("The required checks passed and the review covered the current head.");
    await expect(history.getByRole("button", { name: "Triage Open Issues" }).first()).toBeVisible();
    await expectNoHorizontalOverflow(history, "Inbox Decision History");
    await expectFullyInViewport(history.getByRole("button", { name: "Close", exact: true }).last(), "Close");
    await expectCiRerunHistory(history);
    await capture(page, "inbox-history");
    await history.getByRole("button", { name: "Older Decisions" }).click();
    await expect(history.getByRole("listitem")).toHaveCount(5);
    await expect(history).toContainText("picoduck/wollipog#120");
    await history.getByRole("button", { name: "Newer Decisions" }).click();
    await expect(history.getByRole("listitem")).toHaveCount(5);
    await expect(history).toContainText("picoduck/wollipog#126");

    await page.goto("/campaign-status-e2e.html?scenario=campaign&delegation=stress");
    await page.getByRole("navigation", { name: "Campaign Sections" }).getByRole("button", { name: /Delegated Decisions/ }).click();
    const section = page.locator('[data-campaign-section="Delegated Decisions"]');
    await expect(section.getByText("The required checks passed and the review covered the current head.")).toBeVisible();
    await expect(section.getByRole("listitem")).toHaveCount(5);
    await expectCiRerunHistory(section);
    await expectNoHorizontalOverflow(page.locator(".campaign-status"), "Campaign Status");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "campaign-history");
  });
}
