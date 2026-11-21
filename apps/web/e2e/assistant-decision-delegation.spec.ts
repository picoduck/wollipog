import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectWithinWidth } from "./layout-invariants.js";

const evidence = process.env.ASSISTANT_DELEGATION_EVIDENCE_DIR;
const thread = viewPath({ name: "assistants", threadId: "thr_triage" });

async function openDecisions(page: Page) {
  const panel = page.locator("#right-panel");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  await panel.getByRole("tab", { name: /^Decisions/ }).click();
  return panel.getByRole("tabpanel", { name: /^Decisions/ });
}
async function closeDecisions(page: Page) {
  await page.locator("#right-panel").getByRole("button", { name: "Close Panel" }).click();
}

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
  await page.keyboard.press("Escape");
  const decisions = await openDecisions(page);
  await expect(decisions).toContainText("This control plane does not support delegated decision history.");
  await expect(page.locator("body")).not.toHaveAttribute("data-assistant-decision-history-requested");
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
    const details = await openDecisions(page);
    await expect(details).toContainText("Active");
    await page.clock.fastForward(61_000);
    await expect(details).toContainText("Expired");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "thread-grant-expired");
  });
  test(`a thread's grant and decision history stay usable on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openAssistantFixture(page, thread);
    await threadAction(page, "Decision Delegation");
    const settings = page.getByRole("dialog", { name: "Decision Delegation" });
    const save = settings.getByRole("button", { name: "Save Grant" });
    await expect(settings.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(settings.getByRole("checkbox", { name: /ui evidence approval/i })).toHaveCount(0);
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
    await expect(await openDecisions(page)).toContainText("Active");
    await closeDecisions(page);
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
    await expect(await openDecisions(page)).toContainText("Not Delegated");
    await capture(page, "thread-grant-revoked");
    const history = page.locator("#right-panel").getByRole("tabpanel", { name: /^Decisions/ });
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

  test(`release grants are opt-in and older peers show both disabled categories on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openAssistantFixture(page, thread);
    await threadAction(page, "Decision Delegation");
    const dialog = page.getByRole("dialog", { name: "Decision Delegation" });
    const tag = dialog.getByRole("checkbox", { name: "Release Tag", exact: true });
    const publish = dialog.getByRole("checkbox", { name: "Release Publication", exact: true });
    await expect(tag).not.toBeChecked();
    await expect(publish).not.toBeChecked();
    await tag.check();
    await publish.check();
    await expectFullyInViewport(tag, "Release Tag");
    await expectFullyInViewport(publish, "Release Publication");
    await expectNoHorizontalOverflow(dialog, "Release Decision Grant");
    await capture(page, "release-decision-grant");

    await page.goto(`/assistants-e2e.html?delegation=release-old&path=${encodeURIComponent(thread)}`);
    await threadAction(page, "Decision Delegation");
    await expect(tag).toBeDisabled();
    await expect(publish).toBeDisabled();
    await expect(dialog.getByRole("checkbox", { name: "CI Rerun", exact: true })).toBeEnabled();
    const explanation = dialog.getByText("Update the control plane to grant release decisions.");
    await explanation.scrollIntoViewIfNeeded();
    await expectFullyInViewport(explanation, "Capability Explanation");
    await expectNoHorizontalOverflow(dialog, "Release Decision Grant");
    await capture(page, "release-decision-unavailable");
  });

  for (const action of ["tag", "publish"] as const) {
    test(`release ${action} shows the exact decision and reachable actions on ${layout}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const path = viewPath({ name: "session", id: "sess-release-decision" });
      await page.goto(`/assistants-e2e.html?delegation=stress&release-decision=${action}&path=${encodeURIComponent(path)}`);
      const target = page.getByLabel("Release Target");
      const card = page.locator(".request-card").filter({ has: target });
      const tag = target.getByText("v0.38.0", { exact: true });
      const commit = target.getByRole("link", { name: "2d99e227b73fcad015264f7fe04674953df724b1" });
      const approve = card.getByRole("button", { name: "Approve", exact: true });
      const deny = card.getByRole("button", { name: "Deny", exact: true });
      await expect(commit).toHaveAttribute("href", /\/commit\/2d99e227b73fcad015264f7fe04674953df724b1$/u);
      await approve.click({ trial: true });
      await deny.click({ trial: true });
      await target.getByText("engineering/release-validation", { exact: true }).scrollIntoViewIfNeeded();
      await expectFullyInViewport(tag, "Release Tag");
      await expectFullyInViewport(approve, "Approve");
      await expectFullyInViewport(deny, "Deny");
      await expectNoHorizontalOverflow(card, "Release Approval Card");
      await expectPageNoHorizontalOverflow(page);
      const payloadDigest = target.getByText("a".repeat(64), { exact: true });
      await expect(payloadDigest).toBeVisible();
      if (action === "tag") {
        await capture(page, "release-tag-request");
        return;
      }

      await card.getByRole("button", { name: "Expand Decision", exact: true }).click();
      await expect(card.getByRole("button", { name: "Collapse Decision", exact: true })).toBeVisible();
      await expect(target.getByText("#54921", { exact: true })).toBeVisible();
      const notesToggle = target.getByText("Show Release Notes", { exact: true });
      const assetsToggle = target.getByText("Show Assets (6)", { exact: true });
      await payloadDigest.scrollIntoViewIfNeeded();
      await expectFullyInViewport(notesToggle, "Release Notes Summary");
      await expectFullyInViewport(assetsToggle, "Release Assets Summary");
      await expectFullyInViewport(payloadDigest, "Payload Digest");
      await expectNoHorizontalOverflow(payloadDigest, "Payload Digest");
      await expectWithinWidth(payloadDigest, card, "Payload Digest");
      await expectFullyInViewport(approve, "Approve");
      await expectFullyInViewport(deny, "Deny");
      await capture(page, "release-publish-request");

      await notesToggle.click();
      const notes = target.locator("pre");
      await expect(notes).toContainText("Installation instructions and signed checksums");
      await notesToggle.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await expectFullyInViewport(notesToggle, "Expanded Release Notes Summary");
      await expectWithinWidth(notes, card, "Release Notes");
      await expectNoHorizontalOverflow(notes, "Release Notes");
      await expectFullyInViewport(approve, "Approve With Notes Open");
      await capture(page, "release-publish-notes");

      await notesToggle.click();
      await assetsToggle.click();
      await expect(target.getByRole("listitem")).toHaveCount(6);
      const firstAsset = target.getByRole("listitem").filter({ hasText: /standalone-with-signed-runner-and-bundled-sidecar/u });
      const assetDigest = firstAsset.getByText(`sha256:${"a".repeat(64)}`, { exact: true });
      await assetsToggle.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await expectFullyInViewport(assetsToggle, "Expanded Release Assets Summary");
      await expectFullyInViewport(firstAsset, "Long Release Asset");
      await expectNoHorizontalOverflow(assetDigest, "Release Asset Digest");
      await expectWithinWidth(assetDigest, card, "Release Asset Digest");
      await expectNoHorizontalOverflow(card, "Expanded Release Payload");
      await expectFullyInViewport(approve, "Approve With Assets Open");
      await capture(page, "release-publish-assets");
      await payloadDigest.scrollIntoViewIfNeeded();
      await expectFullyInViewport(payloadDigest, "Payload Digest With Assets Open");
    });
  }

  test(`release decisions show the approving thread in Inbox and Campaign Status on ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const expectReleaseEntry = async (scope: Locator) => {
      const entry = scope.getByRole("listitem").filter({ hasText: "Release Publication" });
      await expect(entry).toContainText("engineering/release-validation · v0.38.0");
      await expect(entry).toContainText("Approved by Assistant thread");
      const attribution = entry.getByRole("button", { name: "Triage Open Issues", exact: true });
      await entry.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expectFullyInViewport(attribution, "Release Publication Thread Attribution");
      await expect(scope.getByRole("listitem").filter({ hasText: "Release Tag" })).toContainText("Approved by Assistant thread");
      await expect(scope).not.toContainText("release_publish:");
      await expectNoHorizontalOverflow(scope);
    };
    await page.goto("/assistants-e2e.html?delegation=stress&release-history&path=%2F");
    await page.getByRole("button", { name: "More Actions", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Delegated Decisions", exact: true }).click();
    await expectReleaseEntry(page.getByRole("dialog", { name: "Delegated Decisions" }));
    await capture(page, "release-inbox-history");

    await page.goto("/campaign-status-e2e.html?scenario=campaign&delegation=stress&release-history");
    await page.getByRole("navigation", { name: "Campaign Sections" }).getByRole("button", { name: /^Go to Section/ }).click();
    await page.getByRole("menu", { name: "Go to Section" }).getByRole("menuitem", { name: /^Delegated Decisions/ }).click();
    await expectReleaseEntry(page.locator('[data-campaign-section="Delegated Decisions"]'));
    await capture(page, "release-campaign-history");
  });

  if (layout === "phone") test("the CI rerun approval wraps long names and keeps actions reachable on phone", async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/assistants-e2e.html?delegation=stress&ci-rerun=long&path=%2F");
    await page.getByRole("button", { name: /Investigate the CI Failure/ }).click();
    const target = page.getByLabel("CI Rerun Target");
    const card = page.locator(".request-card").filter({ has: target });
    const repository = target.getByText("some-organization-name/an-unusually-long-repository-name", { exact: true });
    const jobName = "Build, Typecheck and Bundle the Desktop Sidecar for Linux arm64";
    const job = target.getByRole("link", { name: `${jobName} (#98765432198765)`, exact: true });
    const run = target.getByRole("link", { name: "#98765432109", exact: true });
    const commit = target.getByRole("link", { name: /Head Commit/ });
    const attempt = target.getByText("12", { exact: true });
    const approve = card.getByRole("button", { name: "Approve", exact: true });
    const deny = card.getByRole("button", { name: "Deny", exact: true });
    await expect(job).toHaveText(jobName);
    await expect(job).toHaveAttribute("title", "Job #98765432198765");
    await expect(run).toHaveCSS("white-space", "nowrap");
    await expect(run).toHaveAttribute("title", "#98765432109");
    await expect(run).toHaveAttribute("href", /\/actions\/runs\/98765432109$/u);
    // Wider fonts can make the number longer than its column. Keep it in the cell and mark the cut.
    await expect(run).toHaveCSS("overflow-x", "hidden");
    await expect(run).toHaveCSS("text-overflow", "ellipsis");
    await expectWithinWidth(run, run.locator(".."), "Workflow Run ID");
    await expect(commit).toHaveCSS("white-space", "nowrap");

    const facts = [
      [repository, "Long Repository Name"],
      [run, "Workflow Run ID"],
      [attempt, "Attempt Number"],
      [commit, "Head Commit"],
      [target.getByText("Job and Dependents", { exact: true }), "Job and Dependents"],
      [job, "Long Job Name"],
    ] as const;
    for (const viewportHeight of [height, 724]) {
      await page.setViewportSize({ width, height: viewportHeight });
      // The dock can scroll when long names wrap. Every fact must be readable in compact mode.
      for (const [fact, label] of facts) {
        await fact.scrollIntoViewIfNeeded();
        await expectFullyInViewport(fact, label);
      }
      await approve.click({ trial: true });
      await deny.click({ trial: true });
      await expectNoHorizontalOverflow(card, "CI Rerun Approval Card");
      await expectPageNoHorizontalOverflow(page);
      if (viewportHeight === height) {
        await expectFullyInViewport(page.getByText("Start the Conversation", { exact: true }), "Session Content");
        await expectFullyInViewport(page.getByRole("button", { name: "Browse Files", exact: true }), "Browse Files");
        await capture(page, "ci-rerun-request-long-values");
      }
    }
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
    await page.getByRole("navigation", { name: "Campaign Sections" }).getByRole("button", { name: /^Go to Section/ }).click();
    await page.getByRole("menu", { name: "Go to Section" }).getByRole("menuitem", { name: /^Delegated Decisions/ }).click();
    const section = page.locator('[data-campaign-section="Delegated Decisions"]');
    await expect(section.getByText("The required checks passed and the review covered the current head.")).toBeVisible();
    await expect(section.getByRole("listitem")).toHaveCount(5);
    await expectCiRerunHistory(section);
    await expectNoHorizontalOverflow(page.locator(".campaign-status"), "Campaign Status");
    await expectPageNoHorizontalOverflow(page);
    await capture(page, "campaign-history");
  });
}
