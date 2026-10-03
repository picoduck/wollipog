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
import { assertNoDomNode } from "../dom-test-assertions.js";

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

function codex(serviceTiers?: { id: string; name: string }[]): AgentDefinition {
  return {
    id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
    authStatus: "authenticated", available: true,
    capabilities: {
      models: [{ id: "gpt", displayName: "GPT", ...(serviceTiers ? { serviceTiers } : {}) }],
      effortLevels: ["high"], permissionModes: ["default"], slashCommands: [],
      supportsImages: true, supportsApprovals: true,
    },
  } as AgentDefinition;
}

async function mount(agent: AgentDefinition | AgentDefinition[], sourceServiceTier?: string, refusal?: string | null,
  options: { onCreate?: () => Promise<void>; machineName?: string } = {}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const created: Array<{ agentId: string; config: unknown }> = [];
  await act(async () => root.render(
    <ConversationHandoffDialog
      agents={Array.isArray(agent) ? agent : [agent]}
      sourceDriver="codex-app-server"
      sourceAgentId="codex"
      sourceServiceTier={sourceServiceTier}
      machineName={options.machineName}
      turn={1}
      refusal={refusal}
      onClose={() => {}}
      onCreate={async (agentId, config) => { created.push({ agentId, config }); await options.onCreate?.(); }}
    />,
  ));
  const button = (name: RegExp) => [...container.querySelectorAll("button")]
    .find((element) => name.test(element.getAttribute("aria-label") ?? element.textContent ?? "")) as HTMLButtonElement | undefined;
  return {
    container, created, button,
    tierTrigger: () => button(/^Service Tier:/),
    create: () => [...container.querySelectorAll("button")].find((element) => element.textContent === "Create Handoff") as HTMLButtonElement,
    footerReason: () => container.querySelector(".modal-foot .handoff-reason")?.textContent ?? null,
    options: () => [...container.querySelectorAll("[role=option]")] as HTMLElement[],
    text: () => container.textContent ?? "",
    unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); },
  };
}

test("a destination with no tier catalog still offers a way out of a carried tier", async () => {
  // The ordinary Codex-to-Claude handoff: Claude advertises no tiers at all.
  const fixture = await mount(claude(), "flex");
  try {
    assert.equal(fixture.create().disabled, true, "the unsupported tier blocks creation");
    const trigger = fixture.tierTrigger();
    assert.ok(trigger, "the control must exist, or the refusal has no remedy and Create is stuck");
    // No raw provider id: the carried "flex" tier shows by its display name.
    assert.equal(trigger.getAttribute("aria-label"), "Service Tier: Flex");
    assert.doesNotMatch(fixture.text(), /flex/);
    // The field error: aria-invalid, the message under the field, and aria-describedby pointing at it.
    assert.equal(trigger.getAttribute("aria-invalid"), "true");
    const errorId = trigger.getAttribute("aria-describedby");
    assert.ok(errorId, "the trigger is described by its error");
    const error = fixture.container.querySelector(`#${errorId}`);
    assert.ok(error?.classList.contains("field-error"), "the shared field error recipe (#2150)");
    assert.equal(error?.textContent, "Claude Code doesn't offer the Flex tier. Choose another tier.");
    assert.equal(error?.closest(".field"), trigger.closest(".field"), "the error sits under its own field");
    assert.equal(fixture.footerReason(), "Choose a supported service tier.");
    assert.match(fixture.create().getAttribute("aria-describedby") ?? "", /handoff-reason/);

    await act(async () => { trigger.click(); });
    assert.deepEqual(fixture.options().map((option) => option.textContent), ["Default", "Flex"]);
    const standard = fixture.options().find((element) => element.textContent === "Default")!;
    await act(async () => { standard.click(); });

    // Choosing a supported tier clears all three and enables Create Handoff. With no catalog there
    // is nothing left to choose, so the control itself goes, as it did before (#875).
    assert.equal(fixture.tierTrigger(), undefined);
    assertNoDomNode(fixture.container.querySelector("[aria-invalid]"), "no field stays invalid");
    assertNoDomNode(fixture.container.querySelector(".field-error"), "the field error is gone");
    assert.equal(fixture.footerReason(), null);
    assert.equal(fixture.create().disabled, false, "choosing Default resolves the refusal");
  } finally {
    await fixture.unmount();
  }
});

test("a carried tier is named as the source's catalog names it", async () => {
  const fixture = await mount([codex([{ id: "flex", name: "Flex Processing" }]), claude([{ id: "priority", name: "Priority" }])], "flex");
  try {
    assert.equal(fixture.tierTrigger()!.getAttribute("aria-label"), "Service Tier: Flex Processing");
    await act(async () => { fixture.tierTrigger()!.click(); });
    assert.deepEqual(fixture.options().map((option) => option.textContent), ["Default", "Priority", "Flex Processing"]);
    await act(async () => { fixture.options().find((option) => option.textContent === "Priority")!.click(); });
    assert.equal(fixture.create().disabled, false);
  } finally {
    await fixture.unmount();
  }
});

test("the body is one sentence and a collapsed What Carries Over listing four facts", async () => {
  const fixture = await mount(claude());
  try {
    const dialog = fixture.container.querySelector("[role=dialog]")!;
    const description = fixture.container.querySelector(`#${dialog.getAttribute("aria-describedby")}`);
    assert.equal(description?.textContent,
      "Start a fresh conversation with another agent, using this session's files and dialogue up to Turn 1.");
    const disclosure = fixture.container.querySelector("details.disclosure") as HTMLDetailsElement;
    assert.ok(disclosure);
    assert.equal(disclosure.open, false, "collapsed by default");
    assert.equal(disclosure.querySelector("summary")?.textContent, "What Carries Over");
    const facts = [...disclosure.querySelectorAll("dl.facts dt")].map((term) => term.textContent);
    assert.deepEqual(facts, ["Files", "Conversation", "Left Out", "This Session"]);
    assert.deepEqual([...disclosure.querySelectorAll("dl.facts dd")].map((value) => value.textContent), [
      "The checkpoint after Turn 1.",
      "Visible user and agent messages, up to 24,000 characters.",
      "Tool output, reasoning, questions and approvals.",
      "Unchanged.",
    ]);
    // No other prose in the body before the fields.
    assert.equal(fixture.container.querySelectorAll(".handoff-dialog-body > p").length, 0);
  } finally {
    await fixture.unmount();
  }
});

test("Model and Effort share a row, and Service Tier and Permissions share the next", async () => {
  const fixture = await mount(claude([{ id: "priority", name: "Priority" }]));
  try {
    const rows = [...fixture.container.querySelectorAll(".handoff-dialog-body > .field-row")]
      .map((row) => [...row.querySelectorAll(".ui-select-trigger")].map((trigger) => trigger.getAttribute("aria-label")!.split(":")[0]));
    assert.deepEqual(rows, [["Model", "Effort"], ["Service Tier", "Permissions"]]);
  } finally {
    await fixture.unmount();
  }
  const noTier = await mount(claude());
  try {
    // Without a tier control Permissions spans the row, so its right edge still meets Effort's.
    const permissions = noTier.button(/^Permissions:/)!.closest(".field")!;
    assert.ok(permissions.classList.contains("handoff-field-wide"));
  } finally {
    await noTier.unmount();
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

test("agents that can't take the hand-off are listed disabled with their reason", async () => {
  const unauthenticated = { ...claude(), id: "claude-work", name: "Claude Work", authStatus: "unauthenticated" as const };
  const fixture = await mount([codex(), unauthenticated, claude()], undefined, null, { machineName: "Studio Mac" });
  try {
    assert.equal(fixture.button(/^Agent:/)!.getAttribute("aria-label"), "Agent: Claude Code", "the first available agent is chosen");
    await act(async () => { fixture.button(/^Agent:/)!.click(); });
    const rows = fixture.options().map((option) => ({
      text: option.textContent, disabled: option.getAttribute("aria-disabled") === "true",
    }));
    assert.deepEqual(rows, [
      { text: "Claude Code", disabled: false },
      { text: "CodexAlready this session's agent.", disabled: true },
      { text: "Claude WorkSign in on Studio Mac first.", disabled: true },
    ]);
  } finally {
    await fixture.unmount();
  }
});

test("installations blocked by the Machine selection are listed but cannot be chosen", async () => {
  for (const blocked of [
    { ...claude(), installation: { id: "local", path: "/local/claude", via: "path" as const, selection: "other" as const } },
    { ...claude(), harnessSelectionBlocked: true },
  ]) {
    const fixture = await mount(blocked);
    try {
      assert.equal(fixture.create().disabled, true);
      assert.equal(fixture.footerReason(), "No agent can take this hand-off.");
      await act(async () => { fixture.button(/^Agent:/)!.click(); });
      const [option] = fixture.options();
      assert.equal(option?.getAttribute("aria-disabled"), "true");
      assert.match(option?.textContent ?? "", /Another installation is selected in Machine Settings\./);
      await act(async () => { option!.click(); });
      await act(async () => { fixture.create().click(); });
      assert.deepEqual(fixture.created, []);
    } finally {
      await fixture.unmount();
    }
  }
});

test("an agent that signs out while chosen asks for another agent rather than claiming none can", async () => {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const other = { ...claude(), id: "claude-work", name: "Claude Work" };
  const render = (agents: AgentDefinition[]) => root.render(
    <ConversationHandoffDialog agents={agents} sourceDriver="codex-app-server" turn={1}
      onClose={() => {}} onCreate={async () => {}} />,
  );
  const reason = () => container.querySelector(".modal-foot .handoff-reason")?.textContent ?? null;
  try {
    await act(async () => render([claude(), other]));
    assert.equal(reason(), null);
    await act(async () => render([{ ...claude(), authStatus: "unauthenticated" }, other]));
    assert.equal(reason(), "Choose an agent.");
    await act(async () => render([{ ...claude(), authStatus: "unauthenticated" }]));
    assert.equal(reason(), "No agent can take this hand-off.");
  } finally {
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});

test("Create Handoff keeps its label and shows a spinner while creating", async () => {
  let finish!: () => void;
  const fixture = await mount(claude(), undefined, null, { onCreate: () => new Promise<void>((resolve) => { finish = resolve; }) });
  try {
    await act(async () => { fixture.create().click(); });
    const create = fixture.create();
    assert.equal(create.textContent, "Create Handoff", "the label stays");
    assert.equal(create.getAttribute("aria-busy"), "true");
    assert.equal(create.getAttribute("data-busy-spinner"), "prepended");
    assert.ok(create.querySelector(".spinner"), "the inline spinner shows (#1949)");
    assert.match(fixture.text(), /Creating the handoff…/, "and the progress is announced");
    await act(async () => { create.click(); });
    assert.equal(fixture.created.length, 1, "a busy press is refused");
    await act(async () => { finish(); });
    assert.equal(fixture.create().getAttribute("aria-busy"), null);
  } finally {
    await fixture.unmount();
  }
});

test("a person refused Fork while the dialog is open cannot create the handoff, and is told why (#1864)", async () => {
  const reason = "Your Viewer role is read-only.";
  const refused = await mount(claude(), undefined, reason);
  try {
    const create = refused.create();
    assert.equal(create.disabled, true);
    const describedBy = create.getAttribute("aria-describedby");
    assert.ok(describedBy, "the refusal describes Create Handoff");
    assert.equal(refused.container.querySelector(`#${describedBy}`)?.textContent, reason);
    await act(async () => { create.click(); });
    assert.deepEqual(refused.created, []);
  } finally {
    await refused.unmount();
  }
  for (const refusal of [null, undefined]) {
    const allowed = await mount(claude(), undefined, refusal);
    try {
      assert.equal(allowed.create().disabled, false);
      assert.equal(allowed.create().getAttribute("aria-describedby"), null);
    } finally {
      await allowed.unmount();
    }
  }
});

test("a refusal that arrives after a failed attempt is still stated beside the error (#1864)", async () => {
  const reason = "Your Viewer role is read-only.";
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const render = (refusal: string | null) => root.render(
    <ConversationHandoffDialog
      agents={[claude()]}
      sourceDriver="codex-app-server"
      turn={1}
      refusal={refusal}
      onClose={() => {}}
      onCreate={async () => { throw new Error("The runner is offline."); }}
    />,
  );
  const create = () => [...container.querySelectorAll("button")]
    .find((element) => element.textContent === "Create Handoff") as HTMLButtonElement;
  try {
    await act(async () => render(null));
    await act(async () => { create().click(); });
    assert.match(container.textContent ?? "", /The runner is offline\./u);
    await act(async () => render(reason));
    assert.equal(create().disabled, true);
    const described = container.querySelector(`#${create().getAttribute("aria-describedby")}`);
    assert.equal(described?.textContent, reason, "the refusal is stated even after an earlier error");
  } finally {
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});
