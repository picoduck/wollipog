import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { viewPath } from "../navigation.js";
import { RecommendedSkillsNotice } from "./RecommendedSkillsNotice.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const builtIn = { release: "0.28.0", heldUpdate: null };
type FakeSkill = { id: string; name: string; builtIn?: typeof builtIn; recommendation?: { dismissed: boolean }; assignmentCount: number };
const recommended = (id: string, name: string): FakeSkill =>
  ({ id, name, builtIn, recommendation: { dismissed: false }, assignmentCount: 0 });

const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); };

async function mount(client: ApiClient) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const opened: string[] = [];
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <RecommendedSkillsNotice onOpen={(skillId) => { opened.push(skillId); }} />
      </ApiProvider>,
    );
  });
  await act(settle);
  // A boolean, so a failing assertion never tries to diff a DOM node.
  const shown = () => container.querySelector('[aria-label="Recommended Skills"]') !== null;
  return {
    container, opened, shown,
    names: () => [...container.querySelectorAll(".recommended-skills-notice-list a")].map((link) => link.textContent),
    button: (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label),
    async click(target: HTMLElement | undefined) {
      assert.ok(target);
      await act(async () => { target.click(); });
      await act(settle);
    },
    async revisit() {
      await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
      await act(settle);
    },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

/** The per-user state the control plane keeps: library entries plus this user's dismissals. */
function backend(skills: FakeSkill[]) {
  const dismissed = new Set<string>();
  const calls: Array<{ id: string; dismissed: boolean }> = [];
  let failing = new Set<string>();
  const client = {
    ...api,
    listSkills: async () => ({
      skills: skills.map((skill) => skill.recommendation
        ? { ...skill, recommendation: { dismissed: dismissed.has(skill.id) } }
        : { ...skill }),
    }),
    setSkillRecommendationDismissed: async (id: string, value: boolean) => {
      calls.push({ id, dismissed: value });
      if (failing.has(id)) throw new Error("network error");
      if (value) dismissed.add(id); else dismissed.delete(id);
      return { skill: skills.find((skill) => skill.id === id) };
    },
  } as unknown as ApiClient;
  return { client, dismissed, calls, skills, failOn(ids: string[]) { failing = new Set(ids); } };
}

test("the notice lists built-in skills neither assigned nor dismissed, links each to the Skills view, and offers no assignment", async () => {
  const server = backend([
    recommended("a", "orchestrate-issues"),
    recommended("b", "using-wollipog"),
    { ...recommended("c", "assigned"), assignmentCount: 1 },
    recommended("d", "dismissed"),
    { id: "e", name: "mine", assignmentCount: 0 },
    // A built-in listed without a recommendation, as for a principal the control plane does not recommend to.
    { id: "f", name: "no-recommendation", builtIn, assignmentCount: 0 },
  ]);
  server.dismissed.add("d");
  const view = await mount(server.client);
  assert.equal(view.shown(), true);
  assert.deepEqual(view.names(), ["orchestrate-issues", "using-wollipog"]);
  const link = view.container.querySelector<HTMLAnchorElement>(".recommended-skills-notice-list a")!;
  assert.equal(link.getAttribute("href"), viewPath({ name: "skills", id: "a" }));
  assert.equal(link.getAttribute("title"), "Open in Skills");
  await view.click(link);
  assert.deepEqual(view.opened, ["a"]);
  assert.ok(view.button("Dismiss orchestrate-issues"));
  assert.ok(view.button("Dismiss All"));
  assert.equal([...view.container.querySelectorAll("button")].some((button) => /Assign/.test(button.textContent ?? "")), false,
    "viewers see only actions they can perform");
  await view.unmount();
});

test("the notice is hidden when every built-in skill is assigned or dismissed, and when the library cannot be read", async () => {
  const server = backend([
    { ...recommended("a", "orchestrate-issues"), assignmentCount: 2 },
    recommended("b", "using-wollipog"),
  ]);
  server.dismissed.add("b");
  const none = await mount(server.client);
  assert.equal(none.shown(), false);
  await none.unmount();

  const failing = await mount({ ...api, listSkills: async () => { throw new Error("forbidden"); } } as unknown as ApiClient);
  assert.equal(failing.shown(), false);
  await failing.unmount();
});

test("dismissing one skill writes its per-user dismissal and hides the notice once none remain", async () => {
  const server = backend([recommended("a", "orchestrate-issues"), recommended("b", "using-wollipog")]);
  const view = await mount(server.client);
  await view.click(view.button("Dismiss using-wollipog"));
  assert.deepEqual(server.calls, [{ id: "b", dismissed: true }]);
  assert.deepEqual(view.names(), ["orchestrate-issues"]);
  await view.click(view.button("Dismiss orchestrate-issues"));
  assert.equal(view.shown(), false);
  assert.deepEqual([...server.dismissed].sort(), ["a", "b"]);
  await view.unmount();
});

test("a partial Dismiss All failure keeps only the undismissed skills listed, and a retry finishes", async () => {
  const server = backend([recommended("a", "orchestrate-issues"), recommended("b", "using-wollipog")]);
  const view = await mount(server.client);
  server.failOn(["a"]);
  await view.click(view.button("Dismiss All"));
  assert.deepEqual(server.calls.map((call) => call.id).sort(), ["a", "b"]);
  assert.deepEqual([...server.dismissed], ["b"]);
  assert.deepEqual(view.names(), ["orchestrate-issues"], "the notice matches what the server recorded");
  assert.equal(view.container.querySelector('[role="alert"]')?.textContent, "Could not dismiss orchestrate-issues. Try again.");
  // Revisiting reads the same state back from the server.
  await view.revisit();
  assert.deepEqual(view.names(), ["orchestrate-issues"]);

  server.failOn([]);
  await view.click(view.button("Dismiss All"));
  assert.equal(view.shown(), false);
  await view.unmount();
});

test("after Dismiss All, a built-in skill added by a later release appears on its own", async () => {
  const server = backend([recommended("a", "orchestrate-issues"), recommended("b", "using-wollipog")]);
  const view = await mount(server.client);
  await view.click(view.button("Dismiss All"));
  assert.equal(view.shown(), false);
  server.skills.push(recommended("c", "new-built-in"));
  await view.revisit();
  assert.deepEqual(view.names(), ["new-built-in"]);
  await view.unmount();
});

test("a listing that started before a dismissal cannot bring the dismissed skill back", async () => {
  const server = backend([recommended("a", "orchestrate-issues"), recommended("b", "using-wollipog")]);
  let releaseListing!: () => void;
  let stale: Promise<unknown> | null = null;
  const listSkills = server.client.listSkills;
  const client = {
    ...server.client,
    listSkills: () => {
      if (!stale) return listSkills();
      const snapshot = listSkills();
      return new Promise((resolve) => { releaseListing = () => resolve(snapshot); });
    },
  } as unknown as ApiClient;
  const view = await mount(client);
  stale = Promise.resolve();
  await view.revisit();
  await view.click(view.button("Dismiss using-wollipog"));
  await act(async () => { releaseListing(); });
  await act(settle);
  assert.deepEqual(view.names(), ["orchestrate-issues"]);
  await view.unmount();
});
