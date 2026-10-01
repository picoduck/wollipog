import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { SKILL_DESCRIPTION_MAX_CHARS, skillMarkdownFromFields, type SkillFile } from "@wollipog/protocol";
import { NewSkillDialog } from "./NewSkillDialog.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
};

type Created = { name: string; description: string; files: SkillFile[] };

async function mount(props: { error?: string | null; onCreate?: (input: Created) => Promise<void> } = {}) {
  const created: Created[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (error: string | null) => root.render(
    <NewSkillDialog busy={false} error={error} onClose={() => undefined}
      onCreate={props.onCreate ?? (async (input) => { created.push(input); })} />,
  );
  await act(async () => render(props.error ?? null));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  return {
    dialog,
    created,
    rerender: (error: string | null) => act(async () => render(error)),
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

/** Type into a controlled field the way happy-dom lets React see it. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    field.focus();
    const proto = field instanceof domWindow.HTMLTextAreaElement ? domWindow.HTMLTextAreaElement.prototype : domWindow.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    field.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name);
  assert.ok(found, `a button named ${name}`);
  return found;
}

const labelled = (dialog: HTMLElement, text: string) => {
  const label = [...dialog.querySelectorAll("label")].find((candidate) => candidate.textContent === text)!;
  return document.getElementById(label.htmlFor) as HTMLInputElement & HTMLTextAreaElement;
};
const describedBy = (field: Element) => (field.getAttribute("aria-describedby") ?? "").split(" ")
  .map((id) => document.getElementById(id)?.textContent ?? `missing #${id}`);

test("New Skill asks for a name, a 1,024-character description with a counter, and written or uploaded instructions", async () => {
  const view = await mount();
  try {
    const { dialog } = view;
    assert.equal(dialog.querySelector("h2")?.textContent, "New Skill");
    assert.ok(dialog.closest(".modal")?.classList.contains("lg") === false, "a 560px form dialog, not the 800px size");
    const fieldLabels = [...dialog.querySelectorAll(".field-head > :first-child")].map((label) => label.textContent);
    assert.deepEqual(fieldLabels, ["Name", "Description", "Instructions"]);
    assert.deepEqual([...dialog.querySelectorAll('[role="radio"]')].map((option) => option.textContent), ["Write", "Upload Folder"]);
    assert.deepEqual([...dialog.querySelectorAll(".modal-foot button")].map((option) => option.textContent?.trim()), ["Cancel", "Create Skill"]);

    const description = labelled(dialog, "Description");
    assert.equal(description.tagName, "TEXTAREA");
    assert.equal(description.getAttribute("rows"), "3");
    assert.equal(description.getAttribute("maxlength"), String(SKILL_DESCRIPTION_MAX_CHARS));
    assert.deepEqual(describedBy(description), [
      "Agents read this to decide when the skill applies. Say what it does and when to use it.",
      "0 / 1,024",
    ]);
    const counter = dialog.querySelector(".field-counter")!;
    assert.equal(counter.getAttribute("aria-live"), null, "the counter is not a live region");
    assert.equal(counter.getAttribute("role"), null);

    await type(description, "x".repeat(SKILL_DESCRIPTION_MAX_CHARS - 101));
    assert.equal(counter.textContent, "923 / 1,024");
    assert.equal(counter.classList.contains("is-near-limit"), false);
    await type(description, "x".repeat(SKILL_DESCRIPTION_MAX_CHARS - 100));
    assert.equal(counter.textContent, "924 / 1,024");
    assert.equal(counter.classList.contains("is-near-limit"), true, "amber with 100 characters left");
    // UTF-16 units, the unit the server limits: an emoji is two.
    await type(description, "🎉");
    assert.equal(counter.textContent, "2 / 1,024");
  } finally {
    await view.unmount();
  }
});

test("an invalid name shows its error under Name, marks the field invalid and takes focus on Create Skill", async () => {
  const view = await mount();
  try {
    const { dialog, created } = view;
    const name = labelled(dialog, "Name");
    assert.equal(name.getAttribute("aria-invalid"), null);
    assert.match(describedBy(name)[0]!, /^Lowercase letters, digits, dots, dashes or underscores/);

    await type(name, "Code Review");
    await act(async () => button(dialog, "Create Skill").click());
    await settle();
    assert.equal(created.length, 0);
    assert.equal(name.getAttribute("aria-invalid"), "true");
    assert.deepEqual(describedBy(name), ["Start with a lowercase letter or digit."], "the error replaces the helper");
    assert.ok(name.parentElement!.querySelector(".field-error .field-error-icon"), "the error carries its icon");
    assert.equal(document.activeElement, name, "focus moves to the field");
    assert.equal(dialog.querySelectorAll(".notice").length, 0, "a field error is not a notice");

    await type(name, "code review");
    assert.deepEqual(describedBy(name), ["Use lowercase letters, digits, dots, dashes or underscores."]);
    await type(name, "code-review");
    assert.equal(name.getAttribute("aria-invalid"), null, "the error clears once the value is valid");
  } finally {
    await view.unmount();
  }
});

test("a name is validated on blur once edited, not before", async () => {
  const view = await mount();
  try {
    const name = labelled(view.dialog, "Name");
    await act(async () => { name.focus(); name.blur(); });
    assert.equal(name.getAttribute("aria-invalid"), null, "leaving an untouched field shows nothing");
    await type(name, ".hidden");
    await act(async () => name.blur());
    assert.equal(name.getAttribute("aria-invalid"), "true");
  } finally {
    await view.unmount();
  }
});

test("Create Skill builds SKILL.md from the name, the description and the written body", async () => {
  const view = await mount();
  try {
    const { dialog, created } = view;
    const description = "Use when: asked to review.\nSay \"why\", not just 'what'.";
    await type(labelled(dialog, "Name"), " code-review ");
    await type(labelled(dialog, "Description"), `  ${description}\n`);
    const body = [...dialog.querySelectorAll("textarea")].at(-1)!;
    assert.equal(body.getAttribute("aria-labelledby") && document.getElementById(body.getAttribute("aria-labelledby")!)?.textContent, "Instructions");
    assert.equal(body.getAttribute("rows"), "6");
    await type(body, "# Review\n\nRead the diff.");
    await act(async () => button(dialog, "Create Skill").click());
    await settle();
    assert.deepEqual(created, [{
      name: "code-review",
      description,
      files: [{ path: "SKILL.md", encoding: "utf8", content: skillMarkdownFromFields({ name: "code-review", description, body: "# Review\n\nRead the diff." }) }],
    }]);
  } finally {
    await view.unmount();
  }
});

test("Upload Folder is a dropzone with Choose Folder… and a list of files to remove", async () => {
  const view = await mount();
  try {
    const { dialog, created } = view;
    await act(async () => button(dialog, "Upload Folder").click());
    const choose = button(dialog, "Choose Folder…");
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    assert.equal(input.hidden, true, "the native file control is never shown");
    assert.equal(input.hasAttribute("webkitdirectory"), true);
    assert.match(dialog.querySelector(".skill-dropzone")?.textContent ?? "", /Drop a skill folder here or/);

    const file = (path: string, text: string) => {
      const value = new domWindow.File([text], path.split("/").at(-1)!);
      Object.defineProperty(value, "webkitRelativePath", { value: path });
      return value;
    };
    const picked = [file("review/SKILL.md", "---\nname: code-review\n---\nReview."), file("review/scripts/run.sh", "echo hi"), file("review/notes.md", "n")];
    Object.defineProperty(input, "files", { configurable: true, value: picked });
    await act(async () => { input.dispatchEvent(new domWindow.Event("change", { bubbles: true }) as unknown as Event); });
    await settle();

    const rows = () => [...dialog.querySelectorAll(".skill-upload-file")].map((row) => row.textContent);
    assert.deepEqual(rows(), ["SKILL.mdRemove", "notes.mdRemove", "scripts/run.shScriptRemove"]);
    assert.equal(labelled(dialog, "Name").value, "code-review", "an empty Name takes the folder's SKILL.md name");

    await act(async () => button(dialog, "Remove notes.md").click());
    await settle();
    assert.deepEqual(rows(), ["SKILL.mdRemove", "scripts/run.shScriptRemove"]);
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Remove scripts/run.sh", "focus stays in the list");

    await act(async () => button(dialog, "Remove SKILL.md").click());
    await act(async () => button(dialog, "Create Skill").click());
    await settle();
    assert.equal(created.length, 0);
    const errors = [...dialog.querySelectorAll(".skill-dropzone ~ .field-error")].map((error) => error.textContent);
    assert.deepEqual(errors, ["SKILL.md must exist at the top level of the skill."], "upload errors sit under the dropzone");
    assert.equal(document.activeElement, choose);
    assert.deepEqual(describedBy(choose), errors);

    // Back to Write keeps the folder, and Write's own body is what Create Skill would send.
    await act(async () => button(dialog, "Write").click());
    assertNoDomNode(dialog.querySelector(".skill-dropzone"), "Write shows no dropzone");
    await act(async () => button(dialog, "Upload Folder").click());
    assert.deepEqual(rows(), ["scripts/run.shScriptRemove"]);
  } finally {
    await view.unmount();
  }
});

test("a server error is a danger notice at the end of the body, above the footer", async () => {
  const view = await mount({ error: "HTTP 409: a skill named code-review already exists" });
  try {
    const { dialog } = view;
    const body = dialog.querySelector(".form")!;
    const notice = body.lastElementChild!;
    assert.equal(notice.getAttribute("role"), "alert");
    assert.match(notice.className, /notice/);
    assert.match(notice.textContent ?? "", /Couldn't Create the Skill.*already exists/);
    await view.rerender(null);
    assertNoDomNode(dialog.querySelector('.form [role="alert"]'), "the notice leaves with the error");
  } finally {
    await view.unmount();
  }
});
