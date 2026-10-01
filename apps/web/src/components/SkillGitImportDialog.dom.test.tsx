import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { SkillGitPreview, SkillGitSource } from "../skills.js";
import { SkillGitImportDialog, type SkillGitUpdateCheck } from "./SkillGitImportDialog.js";

/**
 * Import from Git (#1983): the async and focus contracts the e2e spec cannot time. The server reads
 * one source at a time (a second discovery is refused with 429), so a newer preview waits for the
 * one still running; focus that a step change removes lands back inside the dialog; and a recorded
 * folder reaches the server exactly as recorded.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  // A desktop with a mouse: the dialog opens with focus on its first field.
  value: (query: string) => ({ matches: query === "(pointer: fine)", media: query, addEventListener() {}, removeEventListener() {} }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
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
/** Past the dialog's focus fallback, which runs on the next animation frame. */
const nextFrame = () => act(async () => { await new Promise((resolve) => domWindow.requestAnimationFrame(() => resolve(undefined))); });

const candidate = (name: string) => ({
  name, path: `skills/${name}`, commit: "4f1c9b2e7a3d".padEnd(40, "0"), digest: "d", executablePaths: [],
  files: [{ path: "SKILL.md", encoding: "utf8" as const, content: `---\nname: ${name}\n---\nBody.` }], previousFiles: [],
  source: { url: "https://github.com/example/skills.git", ref: "HEAD", subdirectory: "" }, disposition: "new" as const, assignmentCount: 0,
});

/** A fake server whose previews resolve when the test says, refusing overlap the way the real one does. */
function server() {
  const requests: SkillGitSource[] = [];
  const discarded: string[] = [];
  const pending: Array<{ resolve: (preview: SkillGitPreview) => void }> = [];
  let running = 0;
  let refused = 0;
  const client = {
    ...api,
    previewGitSkills: (source: SkillGitSource) => {
      requests.push(source);
      if (running > 0) { refused++; return Promise.reject(new ApiError("Another import is in progress. Finish or cancel a preview first.", 429)); }
      running++;
      return new Promise<SkillGitPreview>((resolve) => {
        pending.push({ resolve: (preview) => { running--; resolve(preview); } });
      });
    },
    discardGitSkillPreview: async (id: string) => { discarded.push(id); },
    importGitSkill: async () => ({}) as never,
  } as ApiClient;
  return {
    client, requests, discarded, pending,
    get refused() { return refused; },
    async answer(index: number, id: string, names: string[]) {
      await act(async () => { pending[index]!.resolve({ previewId: id, candidates: names.map(candidate) }); });
      await settle();
    },
  };
}

async function mount(client: ApiClient, check?: SkillGitUpdateCheck) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ApiProvider client={client}>
      <SkillGitImportDialog check={check} onClose={() => undefined} onImported={async () => undefined} />
    </ApiProvider>);
  });
  await settle();
  return async () => { await act(async () => root.unmount()); host.remove(); };
}

/** Type into a controlled field the way happy-dom lets React see it. Focusing a field that already
 * has focus fires no focusin, so this does not hide a missed initial focus. */
async function setValue(field: HTMLInputElement, value: string) {
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    field.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

async function submit() {
  await act(async () => {
    document.querySelector("form")!.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name);
  assert.ok(found, `a button named ${name}`);
  return found;
}

const repository = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')!;

test("Enter again while Find Skills runs sends no second preview", async () => {
  const fake = server();
  const unmount = await mount(fake.client);
  await setValue(repository(), "example/skills");
  await submit();
  await submit();
  assert.equal(fake.requests.length, 1, "one discovery at a time");
  await fake.answer(0, "first", ["code-review"]);
  assert.equal(fake.refused, 0);
  assert.ok(document.querySelector(".choice-row"), "the preview is shown");
  await unmount();
});

test("Change Source during a preview, then Find Skills, waits for the first to settle and shows the second", async () => {
  const fake = server();
  const unmount = await mount(fake.client, { skillName: "code-review",
    source: { url: "https://github.com/example/skills.git", ref: "HEAD", subdirectory: "skills/code-review" } });
  assert.equal(fake.requests.length, 1, "opened from a skill, it reads the recorded source at once");
  await act(async () => button("Change Source").click());
  await settle();
  await act(async () => button("Find Skills").click());
  await settle();
  assert.equal(fake.requests.length, 1, "the second waits rather than being refused");
  await fake.answer(0, "superseded", ["code-review"]);
  assert.deepEqual(fake.discarded, ["superseded"], "the superseded preview is discarded on the server");
  assert.equal(fake.requests.length, 2);
  await fake.answer(1, "current", ["code-review", "lint-rules"]);
  assert.equal(fake.refused, 0);
  assert.equal(document.querySelectorAll(".choice-row").length, 2);
  assert.equal(document.querySelector('[role="alert"]'), null, "no failure is shown");
  await unmount();
});

test("submitting from the field the dialog focused on open keeps focus inside the dialog", async () => {
  const fake = server();
  const unmount = await mount(fake.client);
  const field = repository();
  assert.ok(document.activeElement === field, "the dialog opens on Repository");
  await setValue(field, "example/skills");
  await submit();
  await fake.answer(0, "first", ["code-review"]);
  await nextFrame();
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.ok(dialog.contains(document.activeElement), `focus is inside the dialog, not on ${document.activeElement?.tagName}`);
  await unmount();
});

test("a recorded folder and branch reach the server exactly as recorded", async () => {
  const fake = server();
  const unmount = await mount(fake.client, { skillName: "code-review",
    source: { url: "https://github.com/example/skills.git", ref: "stable", subdirectory: " skills/code-review" } });
  assert.deepEqual(fake.requests, [{ url: "https://github.com/example/skills.git", ref: "stable", subdirectory: " skills/code-review" }]);
  await fake.answer(0, "first", ["code-review"]);
  await unmount();
});
