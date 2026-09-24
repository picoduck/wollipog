import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { RunnerSkillsResponse } from "../skills.js";
import {
  assignedSkillNamesForAgent,
  managedSkillsAvailableForTarget,
  SessionSkillsUnavailableNotice,
} from "./SkillsUnavailableNotice.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const desired: RunnerSkillsResponse["desired"] = [
  { name: "review", versionDigest: "a", targets: [{ agentId: "claude", invocation: "agent" }] },
  { name: "deploy", versionDigest: "b", targets: [{ agentId: "claude", invocation: "manual" }, { agentId: "codex", invocation: "agent" }] },
  { name: "codex-only", versionDigest: "c", targets: [{ agentId: "codex", invocation: "agent" }] },
];

test("only container and cloud targets lose managed skills", () => {
  assert.equal(managedSkillsAvailableForTarget(undefined), true);
  assert.equal(managedSkillsAvailableForTarget("host"), true);
  assert.equal(managedSkillsAvailableForTarget("container"), false);
  assert.equal(managedSkillsAvailableForTarget("cloud"), false);
});

test("assigned skill names follow the session agent", () => {
  assert.deepEqual(assignedSkillNamesForAgent(desired, "claude"), ["deploy", "review"]);
  assert.deepEqual(assignedSkillNamesForAgent(desired, "pi"), []);
  assert.deepEqual(assignedSkillNamesForAgent(desired, undefined), ["codex-only", "deploy", "review"]);
});

async function render(adapter: "host" | "container" | "cloud" | undefined, response: RunnerSkillsResponse | Error) {
  const calls: string[] = [];
  const client = {
    ...api,
    runnerSkills: async (runnerId: string) => {
      calls.push(runnerId);
      if (response instanceof Error) throw response;
      return response;
    },
  } as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <SessionSkillsUnavailableNotice runnerId="runner-1" agentId="claude" adapter={adapter} />
    </ApiProvider>,
  ));
  const text = container.textContent ?? "";
  const label = container.querySelector("aside")?.getAttribute("aria-label") ?? null;
  await act(async () => root.unmount());
  container.remove();
  return { calls, text, label };
}

for (const adapter of ["container", "cloud"] as const) {
  test(`a ${adapter} session lists the Machine's assigned skills as unavailable`, async () => {
    const result = await render(adapter, { desired, reported: null });
    assert.deepEqual(result.calls, ["runner-1"]);
    assert.equal(result.label, "Skills Unavailable on This Target");
    assert.match(result.text, /Managed skills from this Machine are unavailable on container and cloud targets/u);
    assert.match(result.text, /2 Assigned Skills: deploy, review/u);
  });
}

test("host sessions never fetch skills or render the notice", async () => {
  for (const adapter of ["host", undefined] as const) {
    const result = await render(adapter, { desired, reported: null });
    assert.deepEqual(result.calls, []);
    assert.equal(result.label, null);
  }
});

test("no notice without assigned skills or when the Machine's skills cannot be read", async () => {
  assert.equal((await render("container", { desired: [], reported: null })).label, null);
  assert.equal((await render("container", new Error("forbidden"))).label, null);
});
