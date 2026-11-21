import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const threadPath = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const archivedPath = "/assistants/~dABoAHIAXwByAGUAdABpAHIAZQBkAA/settings";
const evidence = process.env.ASSISTANT_THREAD_SETTINGS_EVIDENCE_DIR;

async function open(page: Page, path = threadPath + "/settings", query = "limits=enabled") {
  await page.goto(`/assistants-e2e.html?${query}&recorded-thread-model&path=${encodeURIComponent(path)}`);
  const dialog = page.getByRole("dialog", { name: "Thread Settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function measureTargets(dialog: Locator, phone: boolean) {
  const targets = dialog.locator("button:visible, a[href]:visible, input:visible");
  const metrics = await targets.evaluateAll((nodes) => {
    const color = (value: string) => {
      const scale = value.startsWith("color(") ? 1 : 255;
      const match = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return { channels: match.slice(0, 3).map((channel) => channel / scale), alpha: match[3] ?? 1 };
    };
    const luminance = (channels: number[]) => channels.reduce((sum, c, index) =>
      sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!, 0);
    return nodes.map((node) => {
      const style = getComputedStyle(node);
      const layers: ReturnType<typeof color>[] = [];
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const layer = color(getComputedStyle(parent).backgroundColor);
        layers.unshift(layer);
        if (layer.alpha === 1) break;
      }
      const background = layers.reduce((base, layer) => base.map((channel, index) =>
        (layer.channels[index] ?? 0) * layer.alpha + channel * (1 - layer.alpha)), [1, 1, 1]);
      const foreground = color(style.color);
      const text = background.map((channel, index) =>
        (foreground.channels[index] ?? 0) * foreground.alpha + channel * (1 - foreground.alpha));
      const shades = [luminance(background), luminance(text)].sort((a, b) => b - a);
      return { label: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "",
        font: parseFloat(style.fontSize), contrast: (shades[0]! + 0.05) / (shades[1]! + 0.05),
        disabled: node.matches(":disabled, [aria-disabled=true]"),
        text: Boolean(node.textContent?.trim() || node instanceof HTMLInputElement && node.value) };
    });
  });
  const boxes = await Promise.all((await targets.all()).map((target) => target.boundingBox()));
  let min = Infinity;
  let gap = Infinity;
  let contrast = Infinity;
  const fontSizes = await dialog.locator(".settings-group-title, .setting-row-title, .setting-row-desc, .field-helper, .modal-body p")
    .evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)));
  for (const fontSize of fontSizes) expect(fontSize).toBeGreaterThanOrEqual(12);
  for (const [index, metric] of metrics.entries()) {
    const box = boxes[index]!;
    min = Math.min(min, box.width, box.height);
    expect(Math.min(box.width, box.height), metric.label).toBeGreaterThanOrEqual(phone ? 44 : 24);
    if (metric.text) {
      expect(metric.font, metric.label).toBeGreaterThanOrEqual(12);
      if (!metric.disabled) {
        contrast = Math.min(contrast, metric.contrast);
        expect(metric.contrast, metric.label).toBeGreaterThanOrEqual(4.5);
      }
    }
    if (!phone) continue;
    for (const [otherIndex, adjacent] of boxes.entries()) {
      if (otherIndex <= index) continue;
      if (!adjacent) continue;
      const dx = Math.max(box.x - adjacent.x - adjacent.width, adjacent.x - box.x - box.width);
      const dy = Math.max(box.y - adjacent.y - adjacent.height, adjacent.y - box.y - box.height);
      const distance = Math.hypot(Math.max(0, dx), Math.max(0, dy));
      gap = Math.min(gap, distance);
      expect(distance, `${metric.label} and ${metrics[otherIndex]!.label}`).toBeGreaterThanOrEqual(7.99);
    }
  }
  return { min, gap, contrast };
}

for (const { width, height, phone } of [{ width: 1440, height: 900, phone: false }, { width: 390, height: 844, phone: true }]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`Thread Settings at ${width}×${height} in ${theme}`, () => {
      test.use({ viewport: { width, height }, hasTouch: phone, isMobile: phone, colorScheme: theme, reducedMotion: "reduce" });
      test.beforeEach(async ({ page }) => {
        await page.clock.setFixedTime(new Date("2026-11-19T18:00:00Z"));
      });

      async function capture(dialog: Locator, state: string, claim: string) {
        const page = dialog.page();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectPageNoHorizontalOverflow(page);
        await expectNoHorizontalOverflow(dialog, "Thread Settings");
        const save = dialog.getByRole("button", { name: /^(Save Changes|Confirm and Save)$/ });
        await expectFullyInViewport(save);
        const { min, gap, contrast } = await measureTargets(dialog, phone);
        if (!evidence) return;
        const metrics = `-target${Math.floor(min)}csspx${phone ? `-gap${Math.round(gap)}csspx` : ""}`;
        const id = `thread-settings-${width}x${height}-${theme}-${state}${metrics}`;
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, id + ".png"), animations: "disabled" });
        writeFileSync(join(evidence, id + ".json"), JSON.stringify({ id, width, height, theme, claim, min,
          gap: phone ? gap : null, contrast: Number.isFinite(contrast) ? contrast : null }, null, 2));
      }

      test("keeps every budget preset, a cents input, and the spend meter together", async ({ page }) => {
        const dialog = await open(page);
        const group = dialog.getByRole("group", { name: "Budget Presets" });
        const meter = dialog.getByRole("meter", { name: "Budget" });
        const names = ["$25", "$50", "$100", "$250", "Custom…", "No Limit"];
        await expect(group.getByRole("button")).toHaveText(names);
        for (const [index, name] of names.entries()) {
          const chip = group.getByRole("button", { name, exact: true });
          await chip.click();
          await expect(chip).toHaveAttribute("aria-pressed", "true");
          await expect(group.getByRole("button")).toHaveText(names);
          if (name === "Custom…") {
            await dialog.getByRole("textbox", { name: "Custom Budget (USD)" }).fill("37.42");
            await expect(meter).toHaveAttribute("aria-valuemax", "37.42");
          }
          if (name === "No Limit") {
            await expect(meter).toHaveCount(0);
            await expect(dialog.getByText("$8.13 spent · No Budget", { exact: true })).toBeVisible();
          } else {
            await expect(meter).toHaveAttribute("aria-valuenow", "8.13");
            await expect(meter).toHaveAttribute("aria-valuemax", name === "Custom…" ? "37.42" : name.slice(1));
            await expectFullyInViewport(meter);
          }
          await capture(dialog, ["budget-25", "budget-50", "budget-100", "budget-250", "budget-custom-cents", "budget-no-limit"][index]!,
            `All six budget presets stay present with ${name} selected. ${name === "No Limit"
              ? "$8.13 spent and No Budget are visible." : `The spend meter shows $8.13 of ${name === "Custom…" ? "$37.42" : name}.`}`);
        }
        await expect(page.locator("body")).not.toHaveAttribute("data-thread-limits", /.+/);
        await group.getByRole("button", { name: "Custom…" }).click();
        const custom = dialog.getByRole("textbox", { name: "Custom Budget (USD)" });
        await custom.fill("37.421");
        await dialog.getByRole("button", { name: "Save Changes" }).click();
        await expect(dialog.getByRole("alert")).toContainText("whole cents");
        await custom.fill("37.42");
        await dialog.getByRole("button", { name: "Save Changes" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator("body")).toHaveAttribute("data-thread-limits", '{"costUsd":37.42,"launchedSessions":10}');
      });

      test("shows the stepper and preserves its configured value through pause and resume", async ({ page }) => {
        let dialog = await open(page);
        const stepper = dialog.getByRole("group", { name: "Session Launches" });
        const count = stepper.getByRole("textbox", { name: "Session Launch Limit" });
        const pause = dialog.getByRole("switch", { name: "Pause New Launches" });
        await stepper.getByRole("button", { name: "No Limit" }).click();
        await expect(count).toHaveValue("");
        await count.fill("10");
        await stepper.getByRole("button", { name: "Decrease Session Launch Limit" }).click();
        await expect(count).toHaveValue("9");
        await stepper.getByRole("button", { name: "Increase Session Launch Limit" }).click();
        await expect(count).toHaveValue("10");
        await stepper.getByRole("button", { name: "Increase Session Launch Limit" }).click();
        await expect(count).toHaveValue("11");
        await expect(pause).not.toBeChecked();
        await pause.scrollIntoViewIfNeeded();
        await expectFullyInViewport(stepper);
        await capture(dialog, "launches-stepper-pause-off", "The Session Launches stepper shows 11, No Limit is present, and Pause New Launches is off.");
        await pause.click();
        await expect(pause).toBeChecked();
        await expect(count).toHaveValue("11");
        await capture(dialog, "launches-pause-on", "Pause New Launches is on and the Session Launches stepper still shows 11.");
        await dialog.getByRole("button", { name: "Save Changes" }).click();
        await expect(page.locator("body")).toHaveAttribute("data-thread-limits", '{"costUsd":25,"launchedSessions":11,"launchPaused":true}');
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole("status").filter({ hasText: "paused new launches" })).toBeVisible();
        await page.getByRole("button", { name: "Thread Actions" }).click();
        await page.getByRole("menuitem", { name: "Thread Settings" }).click();
        dialog = page.getByRole("dialog", { name: "Thread Settings" });
        await expect(pause).toBeChecked();
        await expect(count).toHaveValue("11");
        await pause.click();
        await dialog.getByRole("button", { name: "Save Changes" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator("body")).toHaveAttribute("data-thread-limits", '{"costUsd":25,"launchedSessions":11,"launchPaused":false}');
        await expect(page.getByRole("status").filter({ hasText: "paused new launches" })).toHaveCount(0);
      });

      test("keeps a long account within two phone lines and confirms an account restart once", async ({ page }) => {
        const dialog = await open(page, undefined, "limits=enabled&accounts=stress&harness-change=ready");
        const conversation = dialog.getByRole("region", { name: "Conversation" });
        const account = conversation.getByText(/DesignResearchAndEngineeringSubscription/);
        await expect(conversation.getByRole("button", { name: "Change… Harness" }))
          .toHaveAccessibleDescription(/Claude Code · .*Opus.*4\.6 · High/);
        await expect(conversation.getByRole("button", { name: "Change… Harness" })).toBeEnabled();
        await expect(account).toBeVisible();
        const lines = await account.evaluate((element) => element.clientHeight / parseFloat(getComputedStyle(element).lineHeight));
        if (phone) {
          expect(lines).toBeGreaterThan(1);
          expect(lines).toBeLessThanOrEqual(2.05);
          const bar = dialog.locator(".modal-head");
          await expectFullyInViewport(bar.getByRole("button", { name: "Save Changes" }));
          await expectFullyInViewport(bar.getByRole("button", { name: "Cancel", exact: true }));
          expect((await dialog.boundingBox())!.height).toBeCloseTo(height, 1);
        }
        await capture(dialog, "conversation-long-account", phone
          ? "Conversation shows harness, model and effort and a long account alias wrapping to two lines. Cancel and Save Changes are in the full-height sheet bar."
          : "Conversation shows harness, model and effort and a long account alias without horizontal overflow.");
        await conversation.getByRole("button", { name: "Change… Account" }).click();
        const picker = page.getByRole("dialog", { name: "Change Account" });
        await picker.getByRole("radio", { name: "Studio Subscription", exact: true }).check();
        await picker.getByRole("button", { name: "Use Account" }).click();
        await expect(page.locator("body")).not.toHaveAttribute("data-changed-account", /.+/);
        await dialog.getByRole("button", { name: "Save Changes" }).click();
        const confirmation = page.getByRole("dialog", { name: "Confirm Conversation Change" });
        await expect(dialog).toHaveCount(0);
        await expect(confirmation).toContainText("The Assistant will restart on the selected account.");
        await expect(confirmation).toContainText("Studio Subscription");
        await expect(confirmation).toContainText("try to resume the current provider conversation");
        await capture(confirmation, "confirm-account-restart", "The confirmation names the selected Studio Subscription account and the attempt to resume the provider conversation.");
        await confirmation.getByRole("button", { name: "Confirm and Save" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator("body")).toHaveAttribute("data-changed-account", /acct:/);
      });

      test("confirms the new harness and fresh conversation together", async ({ page }) => {
        const dialog = await open(page, undefined, "limits=enabled&harness-change=ready");
        await dialog.getByRole("button", { name: "Change… Harness" }).click();
        const picker = page.getByRole("dialog", { name: "Change Harness", exact: true });
        await picker.getByRole("radio", { name: /Codex App Server/ }).check();
        await picker.getByRole("radio", { name: "Engineering Shared Subscription With a Long Account Display Name 1", exact: true }).check();
        await picker.getByRole("button", { name: "Use Harness" }).click();
        await dialog.getByRole("button", { name: "Save Changes" }).click();
        const confirmation = page.getByRole("dialog", { name: "Confirm Conversation Change" });
        await expect(dialog).toHaveCount(0);
        await expect(confirmation).toContainText("The Assistant will restart on Codex App Server");
        await expect(confirmation).toContainText("The provider conversation starts fresh. Earlier messages stay readable.");
        await expect(confirmation).toContainText("Engineering Shared Subscription With a Long Account Display Name 1");
        await capture(confirmation, "confirm-harness-restart", "One confirmation names Codex App Server and the selected account, and says a fresh provider conversation starts with earlier messages still readable.");
      });

      test("shows delegated and Ask Me summaries and saves edits from the shared editor", async ({ page }) => {
        const dialog = await open(page, undefined, "limits=enabled&delegation=settings");
        const decisions = dialog.getByRole("region", { name: "Decisions" });
        await expect(decisions).toContainText("Delegate All · Expires in 6 days");
        await decisions.scrollIntoViewIfNeeded();
        await expectFullyInViewport(decisions.getByRole("button", { name: "Manage… Decision Delegation" }));
        await capture(dialog, "decisions-delegate-all", "Decisions shows Delegate All · Expires in 6 days with a Manage… action.");
        await decisions.getByRole("button", { name: "Manage… Decision Delegation" }).click();
        const editor = page.getByRole("dialog", { name: "Decision Delegation" });
        await editor.getByRole("radio", { name: "Ask Me" }).click();
        await editor.getByRole("button", { name: "Use Delegation Settings" }).click();
        await expect(editor).toHaveCount(0);
        await expect(decisions).toContainText("Ask Me");
        await expect(page.locator("body")).not.toHaveAttribute("data-delegation-grant", /.+/);
        await capture(dialog, "decisions-ask-me", "Decisions shows Ask Me with a Manage… action. The edit is staged until Save Changes.");
        const defaults = dialog.getByRole("link", { name: "Settings › Assistant" });
        expect(await defaults.evaluate((link) => ({
          before: link.previousSibling?.textContent,
          after: link.nextSibling?.textContent,
          horizontalPadding: getComputedStyle(link).paddingInline,
        }))).toEqual({ before: " ", after: ".", horizontalPadding: "0px" });
        await expect(defaults.locator("..")).toHaveText("For new-thread defaults, go to Settings › Assistant.");
        if (phone) {
          await defaults.scrollIntoViewIfNeeded();
          await expectFullyInViewport(defaults.locator(".."));
          await capture(dialog, "defaults-helper", "The dialog is scrolled to the fully visible new-thread defaults sentence with an inline Settings › Assistant link.");
        }
        await dialog.getByRole("button", { name: "Save Changes" }).click();
        await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", "null");
      });

      for (const [state, path, limits, notice] of [
        ["archived-read-only", archivedPath, "enabled", "Archived threads are read-only."],
        ["older-fixed-limits", threadPath + "/settings", "old", "This control plane uses fixed thread limits."],
      ] as const) {
        test(`keeps ${state} readable with editing disabled`, async ({ page }) => {
          const dialog = await open(page, path, `limits=${limits}`);
          await expect(dialog.getByRole("status").filter({ hasText: notice })).toBeVisible();
          await expect(dialog.getByRole("button", { name: "$25", exact: true })).toHaveAttribute("aria-pressed", "true");
          await expect(dialog.getByRole("switch", { name: "Pause New Launches" })).toBeDisabled();
          const launchCount = dialog.getByRole("textbox", { name: "Session Launch Limit" });
          await expect(launchCount).toBeDisabled();
          await expect(launchCount).toHaveCSS("cursor", "not-allowed");
          expect(await launchCount.evaluate((input) => {
            const sample = document.createElement("span");
            sample.style.color = "var(--text-faint)";
            input.parentElement!.append(sample);
            const matches = getComputedStyle(input).color === getComputedStyle(sample).color;
            sample.remove();
            return matches;
          })).toBe(true);
          await expect(dialog.getByRole("button", { name: "Change… Account" })).toBeDisabled();
          await expect(dialog.getByRole("button", { name: "Save Changes" })).toBeDisabled();
          await capture(dialog, state, `${notice} The $25 budget is displayed and the edit controls are disabled.`);
        });
      }
    });
  }
}

test("an editable older server pauses with zero and resumes the remembered limit", async ({ page }) => {
  const dialog = await open(page, undefined, "limits=legacy-pause");
  const pause = dialog.getByRole("switch", { name: "Pause New Launches" });
  await dialog.getByRole("textbox", { name: "Session Launch Limit" }).fill("4");
  await pause.click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-thread-limits", '{"costUsd":25,"launchedSessions":0}');
  await page.getByRole("button", { name: "Thread Actions" }).click();
  await page.getByRole("menuitem", { name: "Thread Settings" }).click();
  await expect(pause).toBeChecked();
  await expect(dialog.getByRole("textbox", { name: "Session Launch Limit" })).toHaveValue("4");
  await pause.click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-thread-limits", '{"costUsd":25,"launchedSessions":4}');
});

test("an older server that advertises account changes can save one while spending stays read-only", async ({ page }) => {
  const dialog = await open(page, undefined, "limits=old&accounts=stress");
  await expect(dialog.getByRole("textbox", { name: "Session Launch Limit" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Change… Account" }).click();
  const picker = page.getByRole("dialog", { name: "Change Account" });
  await picker.getByRole("radio", { name: "Studio Subscription", exact: true }).check();
  await picker.getByRole("button", { name: "Use Account" }).click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await page.getByRole("button", { name: "Confirm and Save" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-changed-account", /acct:/);
  await expect(page.locator("body")).not.toHaveAttribute("data-thread-limits", /.+/);
});
