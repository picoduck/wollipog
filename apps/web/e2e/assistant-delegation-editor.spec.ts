import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const evidence = process.env.ASSISTANT_DELEGATION_EDITOR_EVIDENCE_DIR;
const thread = viewPath({ name: "assistants", threadId: "thr_triage" });
const now = new Date("2026-11-19T16:00:00Z");
const categories = ["owner_question", "pr_merge", "ci_rerun", "release_tag", "release_publish", "merged_branch_deletion",
  "follow_up_issue_publication", "issue_closure", "ui_evidence_approval", "review_round_extension"];
const editorName = "Decision Delegation";
const layoutTargets = "button, label.checkbox, input:not([type=checkbox])";

test.use({ timezoneId: "UTC", locale: "en-US" });

async function openEditor(page: Page) {
  await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: editorName, exact: true }).click();
  return page.getByRole("dialog", { name: editorName });
}

async function alignTop(locator: Locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "start" }));
}

test("upgrading capabilities does not widen a saved Delegate All grant", async ({ page }) => {
  await page.clock.setFixedTime(now);
  await page.goto(`/assistants-e2e.html?delegation=stress&evidence=available&saved-narrow&path=${encodeURIComponent(thread)}`);
  const dialog = await openEditor(page);
  await expect(dialog.getByRole("radio", { name: "Delegate All" })).toBeChecked();
  await expect(dialog).toContainText("1 of 11 categories included.");
  await dialog.getByRole("radio", { name: "1 Hour", exact: true }).click();
  await dialog.getByRole("button", { name: "Save Delegation" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
    categories: ["pr_merge"], selectionMode: "all", projects: "all", campaigns: "all", expiresAt: now.getTime() + 3600_000,
  }));
});

test("a control plane can offer CI reruns before it supports release grants", async ({ page }) => {
  await page.goto(`/assistants-e2e.html?delegation=release-old&saved-release&path=${encodeURIComponent(thread)}`);
  const dialog = await openEditor(page);
  const group = dialog.getByRole("checkbox", { name: "CI and Releases", exact: true });
  const rerun = dialog.getByRole("checkbox", { name: "Rerun CI", exact: true });
  const tag = dialog.getByRole("checkbox", { name: "Tag Releases", exact: true });
  await expect(rerun).toBeEnabled();
  await expect(tag).toBeChecked();
  await expect(tag).toHaveAccessibleDescription(/Update the control plane/);
  await expect(dialog.getByRole("checkbox", { name: "Publish Releases", exact: true })).toBeDisabled();
  await expect(group).toBeChecked({ indeterminate: true });
  await expect(group).toHaveAccessibleDescription("1 of 3");
  await group.click();
  await expect(rerun).toBeChecked();
  await expect(group).toHaveAccessibleDescription("2 of 3");
  await expect(group).toBeChecked({ indeterminate: true });
  await dialog.getByRole("button", { name: "Save Delegation" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
    categories: ["release_tag", "ci_rerun"], selectionMode: "choose", projects: "all", campaigns: "all", expiresAt: null,
  }));
});

async function expectEditorLayout(dialog: Locator, width: number) {
  await expectNoHorizontalOverflow(dialog, editorName);
  await expectPageNoHorizontalOverflow(dialog.page());
  const controls = await dialog.locator(layoutTargets).evaluateAll((elements) => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const { x, y, width, height } = rect;
    const style = getComputedStyle(element);
    const node = element.matches("label") ? element.querySelector("input")! : element;
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const foreground = rgb(style.color);
    const overlays: number[][] = [];
    let backgrounds: number[][] = [[255, 255, 255]];
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const gradientColors = ancestorStyle.backgroundImage.match(/rgba?\([^)]+\)/g);
      if (gradientColors) {
        backgrounds = gradientColors.map(rgb);
        break;
      }
      const color = rgb(ancestorStyle.backgroundColor);
      const alpha = color[3] ?? 1;
      if (alpha === 1) {
        backgrounds = [color];
        break;
      }
      if (alpha > 0) overlays.unshift(color);
    }
    const luminance = (channels: number[]) => [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
      const sRGB = channels[index]! / 255;
      return sum + weight * (sRGB <= 0.04045 ? sRGB / 12.92 : ((sRGB + 0.055) / 1.055) ** 2.4);
    }, 0);
    const color = luminance(foreground);
    const contrasts = backgrounds.map((background) => {
      const composite = overlays.reduce((under, over) => {
        const alpha = over[3] ?? 1;
        return under.map((channel, index) => channel * (1 - alpha) + over[index]! * alpha);
      }, background.slice(0, 3));
      const luminanceBehind = luminance(composite);
      return (Math.max(color, luminanceBehind) + 0.05) / (Math.min(color, luminanceBehind) + 0.05);
    });
    return [{ label: element.textContent?.trim() || element.getAttribute("aria-label") || element.tagName,
      x, y, width, height, font: Number.parseFloat(style.fontSize), enabled: !node.matches(":disabled,[aria-disabled=true]"),
      region: element.closest(".modal-head, .modal-body, .modal-foot")?.className,
      contrast: Math.min(...contrasts) }];
  }));
  const minimum = width === 390 ? 44 : 24;
  for (const control of controls) {
    expect(control.width, control.label).toBeGreaterThanOrEqual(minimum - 0.01);
    expect(control.height, control.label).toBeGreaterThanOrEqual(minimum - 0.01);
    expect(control.font, control.label).toBeGreaterThanOrEqual(12);
    if (control.enabled) expect(control.contrast, control.label).toBeGreaterThanOrEqual(4.5);
  }
  if (width !== 390) return;
  for (const [index, a] of controls.entries()) {
    for (const b of controls.slice(index + 1)) {
      // A clipped control in the scrolling body can have a box behind the fixed header or footer.
      if (a.region !== b.region) continue;
      const horizontalGap = Math.max(a.x - b.x - b.width, b.x - a.x - a.width);
      const verticalGap = Math.max(a.y - b.y - b.height, b.y - a.y - a.height);
      expect(Math.max(horizontalGap, verticalGap), `${a.label} / ${b.label}`).toBeGreaterThanOrEqual(7.99);
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const suffix = `${width}x${height}-${theme}`;
    test.describe(suffix, () => {
      test.use({ hasTouch: width === 390 });
      const screenshot = async (page: Page, state: string) => {
        if (!evidence) return;
        mkdirSync(evidence, { recursive: true });
        const sizes = width === 390 ? "-target44csspx-gap8csspx" : "-target24csspx";
        await page.screenshot({ path: join(evidence, `delegation-${suffix}-${state}${sizes}.png`), animations: "disabled" });
      };
      const start = async (page: Page, params = "delegation=stress&evidence=available&long-scopes") => {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.clock.setFixedTime(now);
        await page.goto(`/assistants-e2e.html?theme=${theme}&${params}&path=${encodeURIComponent(thread)}`);
        return openEditor(page);
      };

      test(`Delegate All uses explicit categories and requires disclosure on ${suffix}`, async ({ page }) => {
        const dialog = await start(page);
        const details = page.getByLabel("Thread Details");
        const save = dialog.getByRole("button", { name: "Save Delegation" });
        const all = dialog.getByRole("radio", { name: "Delegate All" });
        const ask = dialog.getByRole("radio", { name: "Ask Me" });
        const consent = dialog.getByRole("checkbox", { name: "I accept the provider disclosure." });
        const expiresAt = now.getTime() + 7 * 24 * 3600_000;
        const grant = { categories, selectionMode: "all", projects: "all", campaigns: "all", expiresAt };
        const saved = page.locator("body");
        await expect(ask).toBeChecked();
        await expect(dialog.getByText("Decisions stay with you.")).toBeVisible();
        await expect(details).toContainText("Decision Delegation Off");
        await expectFullyInViewport(save, "Save Delegation");
        await expectEditorLayout(dialog, width);
        await screenshot(page, "ask-me");

        await all.click();
        await expect(dialog).toContainText("10 of 11 categories included.");
        await expect(dialog).toContainText("Excluded until you accept the provider disclosure.");
        await expect(dialog).toContainText(/Claude Code.*provider may retain/);
        await expectEditorLayout(dialog, width);
        await screenshot(page, "all-before-disclosure");
        await save.click();
        await expect(saved).toHaveAttribute("data-delegation-grant", JSON.stringify(grant));
        await openEditor(page);
        await expect(all).toBeChecked();
        const status = dialog.getByRole("status").filter({ hasText: "Active Delegation" });
        await expect(status).toContainText("Delegate All · Expires in 7 days");
        await expectFullyInViewport(save, "Save Delegation");
        await expectEditorLayout(dialog, width);
        await screenshot(page, "active-grant");

        await consent.check();
        await expect(dialog).toContainText("11 of 11 categories included.");
        await expect(dialog).toContainText("Included. You accepted the provider disclosure.");
        await expectEditorLayout(dialog, width);
        await screenshot(page, "all-after-disclosure");
        await save.click();
        const persisted = JSON.parse((await saved.getAttribute("data-delegation-grant"))!);
        expect(persisted).toEqual({ ...grant, categories: expect.arrayContaining([...categories, "ui_evidence_review"]),
          evidenceDisclosureDigest: "a".repeat(64) });
        expect(persisted.categories).toHaveLength(11);

        await openEditor(page);
        await expect(dialog).toContainText("11 of 11 categories included.");
        const revoke = dialog.getByRole("button", { name: "Revoke Delegation" });
        await expectFullyInViewport(revoke, "Revoke Delegation");
        await revoke.click();
        const confirmation = page.getByRole("dialog", { name: "Revoke Delegation" });
        await expect(confirmation).toContainText("This thread will lose permission");
        await expect(saved).not.toHaveAttribute("data-delegation-grant", "null");
        await expectEditorLayout(confirmation, width);
        await screenshot(page, "revoke-confirmation");
        await confirmation.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toBeVisible();
        await revoke.click();
        await confirmation.getByRole("button", { name: "Revoke Delegation" }).click();
        await expect(saved).toHaveAttribute("data-delegation-grant", "null");
        await expect(details).toContainText("Decision Delegation Off");

        await openEditor(page);
        await all.click();
        await save.click();
        await openEditor(page);
        await ask.click();
        await save.click();
        await expect(saved).toHaveAttribute("data-delegation-grant", "null");
      });

      test(`Choose, expiry and scoped lists work on ${suffix}`, async ({ page }) => {
        const dialog = await start(page);
        const save = dialog.getByRole("button", { name: "Save Delegation" });
        await dialog.getByRole("radio", { name: "Choose" }).click();
        const groupNames = ["Pull Requests", "CI and Releases", "Issues", "Cleanup", "Questions", "UI Evidence"];
        for (const name of groupNames) await expect(dialog.getByRole("group", { name, exact: true })).toBeVisible();
        const pullRequests = dialog.getByRole("checkbox", { name: "Pull Requests", exact: true });
        const merge = dialog.getByRole("checkbox", { name: "Merge Pull Requests" });
        const extend = dialog.getByRole("checkbox", { name: "Extend Review Rounds" });
        await merge.check();
        await expect(pullRequests).toBeChecked({ indeterminate: true });
        await expect(pullRequests).toHaveAccessibleDescription("1 of 2");
        await expectEditorLayout(dialog, width);
        await screenshot(page, "choose-mixed");
        const evidenceGroup = dialog.getByRole("group", { name: "UI Evidence", exact: true });
        if (width === 390) {
          await alignTop(dialog.getByRole("group", { name: "Cleanup", exact: true }));
          await expectFullyInViewport(evidenceGroup, "UI Evidence Group");
          await screenshot(page, "choose-remaining-groups");
        }
        const approve = evidenceGroup.getByRole("checkbox", { name: "Approve UI Evidence" });
        const sendBack = evidenceGroup.getByRole("checkbox", { name: "Send Back UI Evidence" });
        await expect(sendBack).toBeEnabled();
        await expect(approve).toBeEnabled();
        await expect(approve).not.toBeChecked();
        await pullRequests.click();
        await expect(merge).toBeChecked();
        await expect(extend).toBeChecked();
        await expect(pullRequests).toHaveAccessibleDescription("2 of 2");
        await pullRequests.click();
        await expect(merge).not.toBeChecked();
        await expect(extend).not.toBeChecked();
        await merge.check();

        const expiry = dialog.getByRole("group", { name: "Expiry", exact: true });
        await alignTop(expiry);
        await expect(expiry.getByRole("radio", { name: "7 Days" })).toBeChecked();
        await expect(expiry).toContainText(/Delegation ends on Nov 26, 2026.*4:00 PM/);
        await expectFullyInViewport(save, "Save Delegation");
        await screenshot(page, "expiry-seven-days");
        for (const [preset, help] of [
          ["1 Hour", /Nov 19, 2026.*5:00 PM/], ["Today", /midnight at the end of Nov 19/],
          ["30 Days", /Dec 19, 2026.*4:00 PM/], ["Never", /until you revoke it/],
        ] as const) {
          await expiry.getByRole("radio", { name: preset, exact: true }).click();
          await expect(expiry).toContainText(help);
        }
        await expiry.getByRole("radio", { name: "Custom…" }).click();
        await expect(expiry).toContainText("Choose when delegation ends in your device’s local time.");
        await expiry.getByLabel("Ends At").fill("2026-12-05T12:30");
        await expect(expiry).toContainText(/Delegation ends on Dec 5, 2026.*12:30 PM/);
        await expectEditorLayout(dialog, width);
        await screenshot(page, "expiry-custom");

        for (const [scope, name, first] of [["Projects", "Project", "Release Validation"], ["Campaigns", "Campaign", "Long-Running Queue Checks"]] as const) {
          const picker = dialog.getByRole("group", { name: scope, exact: true });
          await picker.getByRole("radio", { name: `Selected ${scope}` }).click();
          await expect(picker).toContainText(`Showing 1–5 of 36 ${scope.toLowerCase()}.`);
          const items = picker.getByRole("checkbox", { name: new RegExp(first) });
          await expect(items).toHaveCount(5);
          await items.first().check();
          const filter = picker.getByLabel(`Filter ${scope}`);
          await filter.fill(`${name} 35`);
          await expect(items).toHaveCount(1);
          await filter.clear();
          await expect(items.first()).toBeChecked();
          await alignTop(picker);
          await expectFullyInViewport(save, "Save Delegation");
          await expectFullyInViewport(items.last().locator("xpath=../.."), "Last Long Scope Row");
          await expectEditorLayout(dialog, width);
          await screenshot(page, `selected-${scope.toLowerCase()}-stress`);
        }
        await save.click();
        await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
          categories: ["pr_merge"], selectionMode: "choose", projects: ["project_0"], campaigns: ["campaign_0"],
          expiresAt: Date.parse("2026-12-05T12:30:00Z"),
        }));

        await openEditor(page);
        await approve.check();
        const approvalRow = dialog.locator(".delegation-category").filter({
          has: page.getByRole("checkbox", { name: "Approve UI Evidence", exact: true }),
        });
        await expect(approve).toHaveAccessibleDescription(/Claude Code.*claude-opus-5-5.*provider may retain/);
        const consent = approvalRow.getByRole("checkbox", { name: "I accept the provider disclosure." });
        await expect(consent).not.toBeChecked();
        await alignTop(approvalRow);
        await expectFullyInViewport(approvalRow, "Approve UI Evidence Row and Disclosure");
        await expectFullyInViewport(save, "Save Delegation");
        await expectEditorLayout(dialog, width);
        await screenshot(page, "choose-evidence-checked");
      });

      test(`Unavailable categories keep their own reasons on ${suffix}`, async ({ page }) => {
        let dialog = await start(page, "delegation=stress&evidence=unavailable");
        await dialog.getByRole("radio", { name: "Choose" }).click();
        const approval = dialog.getByRole("checkbox", { name: "Approve UI Evidence" });
        await expect(approval).toBeDisabled();
        await expect(approval).toHaveAccessibleDescription(/Update this Machine’s runner/);
        await alignTop(dialog.getByRole("group", { name: "UI Evidence" }));
        await expectEditorLayout(dialog, width);
        await screenshot(page, "unavailable");
        dialog = await start(page, "delegation=ci-old&evidence=legacy");
        await dialog.getByRole("radio", { name: "Choose" }).click();
        const ci = dialog.getByRole("group", { name: "CI and Releases", exact: true });
        for (const name of ["Rerun CI", "Tag Releases", "Publish Releases"]) {
          const row = ci.getByRole("checkbox", { name, exact: true });
          await expect(row).toBeDisabled();
          await expect(row).toHaveAccessibleDescription(/Update the control plane/);
        }
        await alignTop(ci);
        await expectFullyInViewport(ci, "CI and Releases Group");
        await expectEditorLayout(dialog, width);
        await screenshot(page, "older-control-plane");
        await dialog.getByRole("radio", { name: "Delegate All" }).click();
        await expect(dialog).toContainText("7 of 11 categories included.");
        await dialog.getByRole("button", { name: "Save Delegation" }).click();
        await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", JSON.stringify({
          categories: categories.filter((category) => !["ci_rerun", "release_tag", "release_publish"].includes(category)),
          selectionMode: "all", projects: "all", campaigns: "all", expiresAt: now.getTime() + 7 * 24 * 3600_000,
        }));
      });
    });
  }
}
