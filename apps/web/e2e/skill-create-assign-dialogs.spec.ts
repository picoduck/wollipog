import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #1964: what only a browser can show about New Skill and Add Assignment — a description that grows
 * and scrolls, a paste cut at the limit, full-width selects whose lists are at least as wide, the
 * folder picker, and both dialogs as phone sheets.
 */

/** Let the dialog's entrance (a phone sheet slides up) finish before measuring it. */
async function settled(page: Page) {
  await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === "running"));
}

async function openNewSkill(page: Page): Promise<Locator> {
  await page.goto("/skills-removals-e2e.html?dialogs=1");
  await page.getByRole("button", { name: "New Skill", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New Skill" });
  await expect(dialog).toBeVisible();
  await settled(page);
  return dialog;
}

async function openAddAssignment(page: Page): Promise<Locator> {
  await page.goto("/skills-removals-e2e.html?dialogs=1");
  await page.locator(".skill-row", { hasText: "code-review" }).click();
  const direct = page.getByRole("button", { name: "Add Assignment…", exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.locator(".detail-bar").getByRole("button", { name: "More Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add Assignment…", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Add Assignment" });
  await expect(dialog).toBeVisible();
  await settled(page);
  return dialog;
}

/** Rows of text the textarea shows: its content box over its line height. */
function visibleRows(field: Locator): Promise<number> {
  return field.evaluate((element) => {
    const style = getComputedStyle(element);
    const content = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return Math.round(content / parseFloat(style.lineHeight));
  });
}

test("the description grows from 3 to 12 rows and then scrolls, and Enter inserts a line break", async ({ page }) => {
  const dialog = await openNewSkill(page);
  const description = dialog.getByLabel("Description", { exact: true });
  expect(await visibleRows(description)).toBe(3);
  await description.fill(Array.from({ length: 6 }, (_, index) => `Line ${index + 1}`).join("\n"));
  expect(await visibleRows(description)).toBe(6);
  await description.fill(Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n"));
  expect(await visibleRows(description)).toBe(12);
  expect(await description.evaluate((element) => element.scrollHeight > element.clientHeight
    && getComputedStyle(element).overflowY === "auto")).toBe(true);
  await description.fill("");
  expect(await visibleRows(description)).toBe(3);

  await description.pressSequentially("First");
  await description.press("Enter");
  await description.pressSequentially("Second");
  await expect(description).toHaveValue("First\nSecond");
  await expect(dialog).toBeVisible();
});

test("the description is measured again when its width changes, so rewrapped text still grows", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const dialog = await openNewSkill(page);
  const description = dialog.getByLabel("Description", { exact: true });
  await description.fill("Reviews a pull request for correctness before style. ".repeat(9).trim());
  const wide = await visibleRows(description);
  expect(wide).toBeGreaterThan(3);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(() => visibleRows(description)).toBeGreaterThan(wide);
  expect(await description.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
});

test("the Write editor grows again after Upload Folder and back, and still refits on resize", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 1000 });
  const dialog = await openNewSkill(page);
  const editor = () => dialog.getByRole("textbox", { name: "Instructions" });
  await editor().fill(Array.from({ length: 10 }, (_, index) => `Step ${index + 1}`).join("\n"));
  expect(await visibleRows(editor())).toBe(10);
  await dialog.getByRole("radio", { name: "Upload Folder", exact: true }).click();
  await dialog.getByRole("radio", { name: "Write", exact: true }).click();
  await expect(editor()).toHaveValue(/^Step 1\n[\s\S]*Step 10$/);
  expect(await visibleRows(editor()), "the remounted editor is fitted to its text").toBe(10);

  await editor().fill("Read the whole diff before commenting, then every caller of what changed. ".repeat(6).trim());
  const wide = await visibleRows(editor());
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect.poll(() => visibleRows(editor()), { message: "the remounted editor is still observed" }).toBeGreaterThan(wide);
});

test("a 1,100-character paste leaves exactly 1,024 characters, and the counter turns amber at 924", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const dialog = await openNewSkill(page);
  const description = dialog.getByLabel("Description", { exact: true });
  const counter = dialog.locator(".field-counter");
  const color = () => counter.evaluate((element) => getComputedStyle(element).color);
  await description.fill("x".repeat(923));
  await expect(counter).toHaveText("923 / 1,024");
  const faint = await color();
  await description.fill("x".repeat(924));
  await expect(counter).toHaveText("924 / 1,024");
  const amber = await color();
  expect(amber).not.toBe(faint);
  expect(amber).toBe(await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--amber-on-tint)";
    document.querySelector(".modal")!.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }));

  await description.fill("");
  await page.evaluate((text) => navigator.clipboard.writeText(text), "y".repeat(1100));
  await description.focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(description).toHaveValue("y".repeat(1024));
  await expect(counter).toHaveText("1,024 / 1,024");
});

test("an invalid name is marked red under Name, and Create Skill moves focus to it", async ({ page }) => {
  const dialog = await openNewSkill(page);
  const name = dialog.getByLabel("Name", { exact: true });
  await name.fill("Code Review");
  await dialog.getByRole("button", { name: "Create Skill", exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription("Start with a lowercase letter or digit.");
  // Focused, the edge is the focus colour; once focus moves on, it is red.
  await dialog.getByLabel("Description", { exact: true }).focus();
  await settled(page);
  const [border, red] = await name.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--red)";
    element.parentElement!.append(probe);
    const value = [getComputedStyle(element).borderTopColor, getComputedStyle(probe).color];
    probe.remove();
    return value;
  });
  expect(border).toBe(red);
});

test("Upload Folder picks a folder through Choose Folder…, never a native file control, and lists its files", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-skill-"));
  const folder = join(root, "code-review");
  mkdirSync(join(folder, "scripts"), { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "---\nname: code-review\ndescription: Reviews code.\n---\n\nReview.\n");
  writeFileSync(join(folder, "scripts", "check.sh"), "#!/bin/sh\necho check\n");
  const dialog = await openNewSkill(page);
  await dialog.getByRole("radio", { name: "Upload Folder", exact: true }).click();
  await expect(dialog.getByText("Choose Files")).toHaveCount(0);
  await expect(dialog.locator('input[type="file"]')).toBeHidden();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose Folder…", exact: true }).click();
  await (await chooser).setFiles(folder);
  const files = dialog.getByRole("list", { name: "Files to Upload" }).getByRole("listitem");
  await expect(files).toHaveText(["SKILL.mdRemove", "scripts/check.shScriptRemove"]);
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("code-review");
  await dialog.getByRole("button", { name: "Remove scripts/check.sh", exact: true }).click();
  await expect(files).toHaveText(["SKILL.mdRemove"]);
});

test("a dropped folder's files are listed like a chosen one", async ({ page }) => {
  const dialog = await openNewSkill(page);
  await dialog.getByRole("radio", { name: "Upload Folder", exact: true }).click();
  const dropzone = dialog.locator(".skill-dropzone");
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["---\nname: dropped\n---\nBody\n"], "SKILL.md", { type: "text/markdown" }));
    data.items.add(new File(["notes"], "notes.md", { type: "text/markdown" }));
    return data;
  });
  await dropzone.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(dropzone).toHaveClass(/is-dragging/);
  await dropzone.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(dropzone).not.toHaveClass(/is-dragging/);
  await expect(dialog.getByRole("list", { name: "Files to Upload" }).getByRole("listitem"))
    .toHaveText(["SKILL.mdRemove", "notes.mdRemove"]);
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("dropped");
});

test("selects fill their field and open lists at least as wide as their trigger", async ({ page }) => {
  const dialog = await openAddAssignment(page);
  for (const name of [/^Machine:/, /^Agents:/]) {
    const trigger = dialog.getByRole("button", { name });
    const [triggerWidth, fieldWidth] = await trigger.evaluate((element) =>
      [(element as HTMLElement).offsetWidth, (element.closest(".field") as HTMLElement).offsetWidth]);
    expect(triggerWidth).toBe(fieldWidth);
    await trigger.click();
    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();
    expect(await list.evaluate((element) => (element as HTMLElement).offsetWidth)).toBeGreaterThanOrEqual(triggerWidth);
    await page.keyboard.press("Escape");
  }
  await dialog.getByRole("button", { name: /^Agents:/ }).click();
  await expect(page.getByRole("group", { name: "Agent Types" }).getByRole("option"))
    .toHaveText([/^Claude Code/, /^Codex \(Command Line\)/, /^Codex \(App Server\)/, /^Pi/]);
  await expect(dialog).not.toContainText(/Native|Non-Interactive|Pi RPC/);
});

// #2285: an option's name is its label alone, and its description and any disabled reason are its
// accessible description, as the browser computes them.
test("each agent option is named by its label and described by its second lines", async ({ page }) => {
  const dialog = await openAddAssignment(page);
  await dialog.getByRole("button", { name: /^Agents:/ }).click();
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options.first()).toBeVisible();
  if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/select-option-names-agents.png` });
  const rows = await options.evaluateAll((elements) => elements.map((element) => ({
    label: element.querySelector(".ui-select-option-body > span")?.textContent ?? "",
    lines: [...element.querySelectorAll(".ui-select-option-desc, .ui-select-option-reason")]
      .map((line) => line.textContent ?? "").join(" "),
  })));
  expect(rows.some((row) => row.lines !== ""), "some option has a second line").toBe(true);
  for (const [index, row] of rows.entries()) {
    await expect(options.nth(index)).toHaveAccessibleName(row.label);
    await expect(options.nth(index)).toHaveAccessibleDescription(row.lines);
  }
});

for (const open of [openNewSkill, openAddAssignment]) {
  test(`at 390px ${open === openNewSkill ? "New Skill" : "Add Assignment"} is a bottom sheet with equal 48px Cancel and primary buttons`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await open(page);
    const sheet = page.locator(".modal-backdrop .modal").last();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
    const buttons = dialog.locator(".modal-foot button");
    await expect(buttons).toHaveCount(2);
    const [cancel, primary] = await buttons.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { name: element.textContent?.trim(), width: Math.round(rect.width), height: Math.round(rect.height) };
    }));
    expect(cancel!.name).toBe("Cancel");
    expect(cancel!.height).toBe(48);
    expect(primary!.height).toBe(48);
    expect(primary!.width).toBe(cancel!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
