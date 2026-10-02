import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2365: only a field's label takes label styling. `.field > span` used to dim every direct span of
 * a `.field` at (0,1,1), which out-ranked the single-class tone rules, so a field error read as dim
 * label text instead of red and a muted note took the label's 12px/500 instead of its own look.
 * These read the computed style of the REAL New Session and New Multi-Agent Run dialogs.
 */

type Look = { color: string; size: string; weight: string };

/** A token's computed colour, read the way the browser paints it. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((property) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

function look(locator: Locator): Promise<Look> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, size: style.fontSize, weight: style.fontWeight };
  });
}

/** The `.field` whose label (its first span, or a `.new-session-field-label`) reads `label`. */
function field(page: Page, label: string): Locator {
  return page.locator(".modal .field").filter({
    has: page.locator(":scope > span:first-child, :scope > .new-session-field-label").getByText(label, { exact: true }),
  });
}

async function open(page: Page, query: string, heading: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/new-session-choices-e2e.html?${query}`);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

/**
 * Every class this rule must leave alone, appended as the LAST child of every `.field` in the dialog
 * and once outside any field, beside the dialog's form. Each must look the same in both places, so
 * a field the states above do not reach is covered too. A bare later span keeps the dim rule.
 */
async function sweep(page: Page) {
  return page.locator(".modal").evaluate((modal) => {
    const classes = ["form-error", "muted", "muted agent-meta", "project-location-reason"];
    const read = (element: Element) => {
      const style = getComputedStyle(element);
      return { color: style.color, size: style.fontSize, weight: style.fontWeight };
    };
    // Beside the outermost field, so it inherits the same type as a span inside one.
    const outside = document.createElement("div");
    const outer = [...modal.querySelectorAll(".field")].find((field) => !field.parentElement!.closest(".field"))!;
    outer.after(outside);
    const reference = new Map(classes.map((name) => {
      const span = document.createElement("span");
      span.className = name;
      span.textContent = "note";
      outside.append(span);
      return [name, read(span)] as const;
    }));
    const fields = [...modal.querySelectorAll(".field")];
    const mismatches: string[] = [];
    const bare: ReturnType<typeof read>[] = [];
    for (const [index, field] of fields.entries()) {
      for (const name of classes) {
        const span = document.createElement("span");
        span.className = name;
        span.textContent = "note";
        field.append(span);
        const inside = read(span);
        const expected = reference.get(name)!;
        if (JSON.stringify(inside) !== JSON.stringify(expected)) {
          mismatches.push(`field ${index} span.${name.replace(" ", ".")}: ${JSON.stringify(inside)} != ${JSON.stringify(expected)}`);
        }
        span.remove();
      }
      const span = document.createElement("span");
      span.textContent = "bare";
      field.append(span);
      bare.push(read(span));
      span.remove();
    }
    outside.remove();
    return { fields: fields.length, mismatches, bare, reference: Object.fromEntries(reference) };
  });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test("New Session: a field error is red and its notes keep their own look, under a --type-label label", async ({ page }) => {
      await open(page, `theme=${theme}&defaults=error`, "New Session");
      const [red, faint, text, dim] = await Promise.all(
        ["--red", "--text-faint", "--text", "--text-dim"].map((name) => token(page, name)),
      );
      expect(new Set([red, faint, text, dim]).size, "the four tones are distinct").toBe(4);

      const role = field(page, "Session Role");
      const error = role.locator(":scope > span.form-error");
      await expect(error).toHaveText(/Could not load saved permission defaults/);
      expect(await look(error), "Session Role's field error").toEqual({ color: red, size: "12.5px", weight: "400" });

      // The Agent field's meta line asks for 12.5px; the Mode note keeps the dialog's own size.
      const meta = field(page, "Agent").locator(":scope > span.muted.agent-meta");
      await expect(meta).toBeVisible();
      expect(await look(meta), "Agent meta line").toEqual({ color: faint, size: "12.5px", weight: "400" });
      const modeNote = field(page, "Mode").locator(":scope > span.muted").first();
      await expect(modeNote).toHaveText(/Runs (directly in the workspace directory|in an isolated git worktree)/);
      expect((await look(modeNote)).color, "Mode note").toBe(faint);
      expect((await look(modeNote)).weight, "Mode note").toBe("400");

      // The labels keep §8.1's --type-label (12/16, 500) in --text: a bare first span and a
      // `.new-session-field-label`.
      for (const label of [role.locator(":scope > span:first-child"), page.locator(".new-session-field-label", { hasText: /^Agent$/ })]) {
        const style = await label.evaluate((element) => {
          const computed = getComputedStyle(element);
          return { color: computed.color, size: computed.fontSize, lineHeight: computed.lineHeight, weight: computed.fontWeight };
        });
        expect(style, "field label").toEqual({ color: text, size: "12px", lineHeight: "16px", weight: "500" });
      }

      const result = await sweep(page);
      expect(result.fields, "New Session renders fields to sweep").toBeGreaterThan(4);
      expect(result.mismatches, "a classed later span looks the same inside and outside a field").toEqual([]);
      expect(result.reference["form-error"]?.color).toBe(red);
      expect(result.reference.muted?.color).toBe(faint);
      for (const bare of result.bare) expect(bare, "a bare later span keeps the dim rule").toEqual({ color: dim, size: "12px", weight: "500" });
    });

    test("New Session: Session Role's muted notes are --text-faint", async ({ page }) => {
      for (const [defaults, copy] of [
        ["pending", /Loading saved permission defaults/],
        ["orchestrator", /Orchestrator is your saved Agent Harness default/],
      ] as const) {
        await open(page, `theme=${theme}&defaults=${defaults}`, "New Session");
        const note = field(page, "Session Role").locator(":scope > span.muted");
        await expect(note).toHaveText(copy);
        const style = await look(note);
        expect(style.color, `${defaults}: muted note`).toBe(await token(page, "--text-faint"));
        expect(style.weight, `${defaults}: muted note`).toBe("400");
      }
    });

    test("New Multi-Agent Run: Project notes are --text-faint and Location reasons keep 11px at 400", async ({ page }) => {
      await open(page, `theme=${theme}&dialog=run`, "New Multi-Agent Run");
      const [faint, dim] = await Promise.all(["--text-faint", "--text-dim"].map((name) => token(page, name)));

      const projectNote = field(page, "Project").locator(":scope > span.muted");
      await expect(projectNote).toHaveText(/Choose a Project/);
      expect((await look(projectNote)).color).toBe(faint);
      expect((await look(projectNote)).weight).toBe("400");

      const projectSelect = page.getByLabel("Project", { exact: true });
      const location = field(page, "Project Location");
      for (const [name, copy] of [
        ["No Locations Yet", /This Project has no Locations/],
        ["Offline Location", /No Locations are currently available/],
      ] as const) {
        await projectSelect.selectOption({ label: name });
        const reason = location.locator(":scope > span.project-location-reason");
        await expect(reason).toHaveText(copy);
        expect(await look(reason), `${name}: Location reason`).toEqual({ color: dim, size: "11px", weight: "400" });
      }

      await projectSelect.selectOption({ label: "Two Locations" });
      const choose = location.locator(":scope > span.muted");
      await expect(choose).toHaveText(/Choose the exact Location/);
      expect((await look(choose)).color).toBe(faint);
      expect((await look(choose)).weight).toBe("400");

      const result = await sweep(page);
      expect(result.fields, "New Multi-Agent Run renders fields to sweep").toBeGreaterThan(2);
      expect(result.mismatches, "a classed later span looks the same inside and outside a field").toEqual([]);
    });
  });
}
