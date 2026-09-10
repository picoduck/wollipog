/**
 * The handoff dialog carries the source session's service tier (#875). The interesting cases are
 * the ones where the destination cannot honour it: the user must always retain a way to resolve the
 * refusal, including when the destination advertises no tier catalog at all — which is every Claude
 * model, and therefore the ordinary Codex-to-Claude handoff.
 */

import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentDefinition } from "@wollipog/protocol";
import { ConversationHandoffDialog } from "./ConversationHandoffDialog.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function claude(serviceTiers?: { id: string; name: string }[]): AgentDefinition {
  return {
    id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code",
    authStatus: "authenticated", available: true,
    capabilities: {
      models: [{ id: "opus", displayName: "Opus", ...(serviceTiers ? { serviceTiers } : {}) }],
      effortLevels: ["high"], permissionModes: ["default"], slashCommands: [],
      supportsImages: true, supportsApprovals: true,
    },
  } as AgentDefinition;
}

async function mount(agent: AgentDefinition, sourceServiceTier?: string) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const created: Array<{ agentId: string; config: unknown }> = [];
  await act(async () => root.render(
    <ConversationHandoffDialog
      agents={[agent]}
      sourceDriver="codex-app-server"
      sourceServiceTier={sourceServiceTier}
      turn={1}
      onClose={() => {}}
      onCreate={async (agentId, config) => { created.push({ agentId, config }); }}
    />,
  ));
  const button = (name: RegExp) => [...container.querySelectorAll("button")]
    .find((element) => name.test(element.getAttribute("aria-label") ?? element.textContent ?? "")) as HTMLButtonElement | undefined;
  return {
    container, created, button,
    tierTrigger: () => button(/^Service Tier:/),
    create: () => [...container.querySelectorAll("button")].find((element) => element.textContent === "Create Handoff") as HTMLButtonElement,
    text: () => container.textContent ?? "",
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("a destination with no tier catalog still offers a way out of a carried tier", async () => {
  // The ordinary Codex-to-Claude handoff: Claude advertises no tiers at all.
  const fixture = await mount(claude(), "flex");
  try {
    assert.match(fixture.text(), /does not support this service tier/);
    assert.equal(fixture.create().disabled, true, "the unsupported tier blocks creation");
    const trigger = fixture.tierTrigger();
    assert.ok(trigger, "the control must exist, or the refusal has no remedy and Create is stuck");
    assert.match(trigger.getAttribute("aria-label") ?? "", /Service Tier: flex/);

    await act(async () => { trigger.click(); });
    const standard = [...fixture.container.querySelectorAll("[role=option]")]
      .find((element) => element.textContent === "Default") as HTMLElement;
    assert.ok(standard, "Default is always selectable");
    await act(async () => { standard.click(); });

    assert.doesNotMatch(fixture.text(), /does not support this service tier/);
    assert.equal(fixture.create().disabled, false, "choosing Default resolves the refusal");
  } finally {
    await fixture.unmount();
  }
});

test("a carried default tier displays as Default rather than an empty control", async () => {
  const fixture = await mount(claude([{ id: "priority", name: "Priority" }]), "default");
  try {
    const trigger = fixture.tierTrigger();
    assert.ok(trigger);
    assert.match(trigger.getAttribute("aria-label") ?? "", /Service Tier: Default/,
      "the standard tier is a real selection, not a placeholder");
    assert.equal(fixture.create().disabled, false);
  } finally {
    await fixture.unmount();
  }
});

test("a supported carried tier is preselected and submitted unchanged", async () => {
  const fixture = await mount(claude([{ id: "priority", name: "Priority" }]), "priority");
  try {
    assert.match(fixture.tierTrigger()!.getAttribute("aria-label") ?? "", /Service Tier: Priority/);
    assert.equal(fixture.create().disabled, false);
    await act(async () => { fixture.create().click(); });
    assert.deepEqual(fixture.created.map((entry) => entry.config), [{ model: "opus", serviceTier: "priority" }]);
  } finally {
    await fixture.unmount();
  }
});

test("no carried tier and no catalog leaves the dialog exactly as it was", async () => {
  const fixture = await mount(claude());
  try {
    assert.equal(fixture.tierTrigger(), undefined, "nothing to choose and nothing to clear");
    assert.equal(fixture.create().disabled, false);
  } finally {
    await fixture.unmount();
  }
});
